import { describe, it, expect } from "vitest";
import { ssrfFetch } from "../src/ssrf-fetch.js";

describe("ssrfFetch — private/reserved address blocking (S2)", () => {
  const blocked: Array<[string, string]> = [
    ["loopback v4", "http://127.0.0.1/"],
    ["private 10/8", "http://10.0.0.1/"],
    ["private 172.16/12", "http://172.16.5.4/"],
    ["private 192.168/16", "http://192.168.1.1/"],
    ["link-local / cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["carrier-grade NAT 100.64/10", "http://100.64.0.1/"],
    ["unspecified 0.0.0.0", "http://0.0.0.0/"],
    ["loopback v6", "http://[::1]/"],
    ["ipv4-mapped ipv6 loopback", "http://[::ffff:127.0.0.1]/"],
  ];

  for (const [label, url] of blocked) {
    it(`blocks ${label}`, async () => {
      await expect(ssrfFetch(url)).rejects.toThrow(/SSRF blocked|private/i);
    });
  }

  it("rejects unsupported protocols", async () => {
    await expect(ssrfFetch("file:///etc/passwd")).rejects.toThrow(/unsupported protocol/i);
  });
});
