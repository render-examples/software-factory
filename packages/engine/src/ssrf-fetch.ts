import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { URL } from "node:url";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/**
 * Classify an IP literal as private/internal/reserved and therefore unsafe as
 * an SSRF target. Covers IPv4 + IPv6 including IPv4-mapped IPv6, CGNAT, the
 * full link-local range (cloud metadata lives at 169.254.169.254), and the
 * loopback/unspecified ranges.
 */
function isPrivateIP(rawIp: string): boolean {
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

  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  if (isIP(ip) === 6) return isPrivateIPv6(ip);
  // Unparseable — treat as unsafe.
  return true;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // multicast + reserved (224.0.0.0+)
  return false;
}

function isPrivateIPv6(rawIp: string): boolean {
  const ip = rawIp.toLowerCase();
  if (ip === "::1") return true; // loopback
  if (ip === "::") return true; // unspecified
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique local fc00::/7
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (ip.startsWith("ff")) return true; // multicast
  if (ip === "fd00:ec2::254") return true; // AWS IMDS over IPv6
  return false;
}

/**
 * Resolve a hostname to a concrete, vetted IP address. Returns the safe IP to
 * connect to. Throws if any resolved address is private/internal. Returning the
 * pinned IP (rather than re-resolving at connect time) closes the DNS-rebinding
 * / TOCTOU window.
 */
async function resolveSafeAddress(hostname: string): Promise<{ ip: string; family: number }> {
  // IP literal (strip brackets from `[::1]`).
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) !== 0) {
    if (isPrivateIP(literal)) {
      throw new Error(`SSRF blocked: "${hostname}" is a private address`);
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
  // Every resolved address must be public — a host with a mix of public and
  // private records must not pass.
  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      throw new Error(`SSRF blocked: "${hostname}" resolves to private address ${address}`);
    }
  }
  const chosen = addresses[0];
  return { ip: chosen.address, family: chosen.family };
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
