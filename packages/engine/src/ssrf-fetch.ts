import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { URL } from "node:url";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/**
 * Classify an IP literal as an unsafe fetch target. Covers IPv4 + IPv6 including
 * IPv4-mapped IPv6, CGNAT, the full link-local range (cloud metadata lives at
 * 169.254.169.254), and the loopback/unspecified ranges.
 *
 * `allowPrivate` selects the trust level:
 *  - `false` (default) — untrusted, model-influenced URLs (tool `ctx.fetch`):
 *    block every private/loopback/reserved range.
 *  - `true` — operator-configured endpoints (e.g. MCP servers): permit loopback
 *    + private LAN (local/docker MCP is legitimate) but STILL block the ranges
 *    that are never a valid destination, above all link-local 169.254/16 (cloud
 *    metadata) and the AWS IMDSv6 address.
 */
function isBlockedIP(rawIp: string, allowPrivate = false): boolean {
  let ip = rawIp.trim().toLowerCase();
  // Normalize IPv4-mapped IPv6 to IPv4. The URL parser canonicalizes these to
  // hex form (::ffff:7f00:1), but DNS/string inputs may use dotted-decimal
  // (::ffff:127.0.0.1) — handle both.
  const mappedDecimal = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDecimal) {
    ip = mappedDecimal[1];
  } else {
    const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      ip = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }

  if (isIP(ip) === 4) return isBlockedIPv4(ip, allowPrivate);
  if (isIP(ip) === 6) return isBlockedIPv6(ip, allowPrivate);
  // Unparseable — treat as unsafe.
  return true;
}

function isBlockedIPv4(ip: string, allowPrivate: boolean): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  // Never a valid destination — blocked even for trusted operator config.
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a >= 224) return true; // multicast + reserved (224.0.0.0+)
  if (allowPrivate) return false; // trusted config may target loopback/LAN (local/docker MCP)
  // Untrusted callers: block all private/reserved ranges.
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  return false;
}

function isBlockedIPv6(rawIp: string, allowPrivate: boolean): boolean {
  const ip = rawIp.toLowerCase();
  // Never a valid destination — blocked even for trusted operator config.
  if (ip === "::") return true; // unspecified
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (ip.startsWith("ff")) return true; // multicast
  if (ip === "fd00:ec2::254") return true; // AWS IMDS over IPv6
  if (allowPrivate) return false; // trusted config may target loopback/ULA
  if (ip === "::1") return true; // loopback
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique local fc00::/7
  return false;
}

/**
 * Resolve a hostname to a concrete, vetted IP address. Returns the safe IP to
 * connect to. Throws if any resolved address is private/internal. Returning the
 * pinned IP (rather than re-resolving at connect time) closes the DNS-rebinding
 * / TOCTOU window.
 */
async function resolveSafeAddress(
  hostname: string,
  allowPrivate = false,
): Promise<{ ip: string; family: number }> {
  // IP literal (strip brackets from `[::1]`).
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) !== 0) {
    if (isBlockedIP(literal, allowPrivate)) {
      throw new Error(`SSRF blocked: "${hostname}" is a disallowed address`);
    }
    return { ip: literal, family: isIP(literal) };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(
      `DNS resolution failed for "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new Error(`DNS resolution failed for "${hostname}": no addresses`);
  }
  // Every resolved address must pass — a host with a mix of allowed and blocked
  // records must not pass.
  for (const { address } of addresses) {
    if (isBlockedIP(address, allowPrivate)) {
      throw new Error(`SSRF blocked: "${hostname}" resolves to disallowed address ${address}`);
    }
  }
  const chosen = addresses[0];
  return { ip: chosen.address, family: chosen.family };
}

export interface SsrfGuardOptions {
  /**
   * Permit loopback + private LAN targets (for operator-configured endpoints
   * like MCP servers). Cloud-metadata/link-local/multicast ranges remain blocked.
   * Default `false`.
   */
  allowPrivateHosts?: boolean;
}

/**
 * Resolve and validate a URL's destination without performing a request. Throws
 * if the scheme is unsupported or any resolved address is disallowed. Used to
 * guard operator-configured HTTP endpoints (MCP) where connection-level IP
 * pinning would break TLS SNI, so the request itself uses the normal hostname.
 */
export async function assertUrlAllowed(url: string, opts?: SsrfGuardOptions): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`SSRF blocked: unsupported protocol "${parsed.protocol}"`);
  }
  await resolveSafeAddress(parsed.hostname, opts?.allowPrivateHosts ?? false);
}

/**
 * SSRF-guarded fetch. Blocks private/internal/reserved IPs and cloud-metadata
 * endpoints, re-validates on every redirect hop, pins the connection to the
 * vetted IP (defeating DNS rebinding), and enforces timeout + streamed size
 * caps.
 *
 * Tools should use `ctx.fetch` exclusively so the guard isn't bypassed.
 */
export async function ssrfFetch(url: string, init?: RequestInit): Promise<Response> {
  let currentUrl = url;
  let redirects = 0;

  while (true) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`SSRF blocked: unsupported protocol "${parsed.protocol}"`);
    }
    const { ip } = await resolveSafeAddress(parsed.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const combinedSignal = init?.signal
      ? AbortSignal.any([controller.signal, init.signal])
      : controller.signal;

    // Pin the connection to the vetted IP via the Host header so the network
    // layer cannot re-resolve to a different (private) address between check
    // and connect. The literal-IP path re-validates the IP above.
    const pinnedUrl = new URL(currentUrl);
    const isLiteral = isIP(parsed.hostname.replace(/^\[|\]$/g, "")) !== 0;
    const headers = new Headers(init?.headers);
    if (!isLiteral) {
      headers.set("host", parsed.host);
      pinnedUrl.hostname = isIP(ip) === 6 ? `[${ip}]` : ip;
    }

    let response: Response;
    try {
      response = await fetch(pinnedUrl, {
        ...init,
        headers,
        signal: combinedSignal,
        redirect: "manual",
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} with no Location header`);
      redirects += 1;
      if (redirects > MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    return enforceSizeCap(response);
  }
}

/**
 * Enforce the response size cap. Checks the Content-Length header first, then
 * streams the body and aborts if it exceeds the cap (chunked/streamed responses
 * have no Content-Length, so the header check alone is insufficient).
 */
function enforceSizeCap(response: Response): Response {
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
    throw new Error(`Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`);
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  let received = 0;
  const capped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        controller.error(new Error(`Response too large: exceeded ${MAX_RESPONSE_BYTES} bytes`));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(capped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
