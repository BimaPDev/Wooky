import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTailscaleStatus } from "./tailscale.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./tailscale.fixture.json", import.meta.url), "utf8"),
) as unknown;

describe("tailscale status parsing", () => {
  it("reads the MagicDNS name without the trailing dot, the tailnet IPs, and BackendState", () => {
    expect(parseTailscaleStatus(fixture)).toEqual({
      installed: true,
      running: true,
      hostName: "work-mac.tailnet.ts.net",
      ips: ["100.64.0.2", "fd7a:115c:a1e0::32"],
    });
  });

  it("treats any other backend state as not running", () => {
    expect(
      parseTailscaleStatus({
        BackendState: "NeedsLogin",
        Self: { DNSName: "box.ts.net.", TailscaleIPs: [] },
      }),
    ).toMatchObject({ installed: true, running: false, hostName: "box.ts.net", ips: [] });
  });

  it("returns null for a payload that is not an object", () => {
    expect(parseTailscaleStatus(null)).toBeNull();
    expect(parseTailscaleStatus("running")).toBeNull();
  });
});
