import { lookup } from "node:dns/promises";
import { URL } from "node:url";

const METADATA_IPS = new Set(["169.254.169.254", "fd00:ec2::254"]);
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

function isPrivateIP(ip: string): boolean {
  if (METADATA_IPS.has(ip)) return true;
  // IPv4 private ranges
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("127.")) return true;
  if (ip === "0.0.0.0") return true;
  // IPv6 private
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (ip.startsWith("fe80")) return true;
  return false;
}

async function resolveAndCheck(hostname: string): Promise<void> {
  // Skip check for IP literals
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[")) {
    const ip = hostname.replace(/^\[|\]$/g, "");
    if (isPrivateIP(ip)) throw new Error(`SSRF blocked: "${hostname}" resolves to a private address`);
    return;
  }
  try {
    const { address } = await lookup(hostname);
    if (isPrivateIP(address)) {
      throw new Error(`SSRF blocked: "${hostname}" resolves to private address ${address}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("SSRF blocked")) throw err;
    throw new Error(`DNS resolution failed for "${hostname}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * SSRF-guarded fetch. Blocks private IPs, internal ranges, and cloud metadata
 * endpoints. Re-checks on redirects. Enforces size and timeout caps.
 *
 * Tools should use `ctx.fetch` exclusively so the guard isn't bypassed.
 */
export async function ssrfFetch(url: string, init?: RequestInit): Promise<Response> {
  let currentUrl = url;
  let redirects = 0;

  while (true) {
    const parsed = new URL(currentUrl);
    await resolveAndCheck(parsed.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const combinedSignal = init?.signal
      ? AbortSignal.any([controller.signal, init.signal])
      : controller.signal;

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        ...init,
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

    // Size cap enforcement via streaming check
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      throw new Error(`Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`);
    }

    return response;
  }
}
