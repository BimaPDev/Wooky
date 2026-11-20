import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceInfo, HostingSettings } from "@wooky/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createPairing } from "./pairing.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function pairingFor(options: {
  hosting: Pick<HostingSettings, "enabled" | "bind" | "tailscaleServe">;
  addresses: string[];
  hostName?: string | null;
}) {
  const home = mkdtempSync(join(tmpdir(), "wooky-pairing-url-"));
  homes.push(home);
  return createPairing({
    home,
    hostInfo: () => ({}) as DeviceInfo,
    listenPort: () => 4317,
    listenAddresses: () => options.addresses,
    hosting: () => options.hosting,
    tailscaleStatus: async () => ({ hostName: options.hostName ?? null }),
    onRevoke: () => {},
  });
}

describe("pairing URL", () => {
  it("offers no URL while hosting is off, even if the machine has a LAN address", async () => {
    const created = await pairingFor({
      hosting: { enabled: false, bind: "all", tailscaleServe: false },
      addresses: ["127.0.0.1"],
    }).create();
    expect(created.url).toBeNull();
    expect(created.reason).toMatch(/hosting is off/i);
  });

  it("offers no URL when hosting is on but loopback-only", async () => {
    const created = await pairingFor({
      hosting: { enabled: true, bind: "loopback", tailscaleServe: false },
      addresses: ["127.0.0.1"],
    }).create();
    expect(created.url).toBeNull();
    expect(created.reason).toMatch(/this machine/i);
  });

  it("advertises only an address the server listens on", async () => {
    const created = await pairingFor({
      hosting: { enabled: true, bind: "all", tailscaleServe: false },
      addresses: ["127.0.0.1", "192.168.7.20"],
    }).create();
    expect(created.url).toBe("http://192.168.7.20:4317");
    expect(created.reason).toBeNull();
  });

  it("uses the tailnet host name when bound to tailscale", async () => {
    const created = await pairingFor({
      hosting: { enabled: true, bind: "tailscale", tailscaleServe: false },
      addresses: ["127.0.0.1", "100.64.0.5"],
      hostName: "mac.tail1234.ts.net",
    }).create();
    expect(created.url).toBe("http://mac.tail1234.ts.net:4317");
  });
});
