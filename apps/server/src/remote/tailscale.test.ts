import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findTailscale: vi.fn<() => string | null>(() => null),
  runArgv: vi.fn<
    () => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>
  >(async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false })),
}));
vi.mock("../process/tailscale-cli.ts", () => ({
  findTailscale: mocks.findTailscale,
  runArgv: mocks.runArgv,
}));

import { createTailscale, parseTailscaleStatus } from "./tailscale.ts";

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

describe("tailscale serve errors on the wire", () => {
  it("reports serveError from status() whether or not the CLI is present", async () => {
    const tailscale = createTailscale();
    tailscale.reportServeError("serve listener failed");
    expect(await tailscale.status()).toMatchObject({
      installed: false,
      serveError: "serve listener failed",
    });

    mocks.findTailscale.mockReturnValue("/usr/bin/tailscale");
    expect(await tailscale.status()).toMatchObject({ serveError: "serve listener failed" });
  });
});
