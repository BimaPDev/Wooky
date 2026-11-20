import { describe, expect, it } from "vitest";
import type { SyncStatus } from "@wooky/contracts";
import { deviceLabel, deviceNames } from "./anywhere-history.ts";

const peer = (deviceId: string, name: string): SyncStatus["peers"][number] => ({
  deviceId,
  name,
  state: "idle",
  lastSyncAt: null,
  error: null,
  projects: [],
});

describe("deviceNames", () => {
  it("uses the label given to each machine, and tells two with the same label apart", () => {
    const status: SyncStatus = {
      enabled: true,
      conflicts: [],
      peers: [
        peer("aaaa1111-0000", "Work Mac"),
        peer("bbbb2222-0000", "Home PC"),
        peer("cccc3333-0000", "Work Mac"),
      ],
    };
    const names = deviceNames(status);
    expect(deviceLabel(names, "bbbb2222-0000")).toBe("Home PC");
    expect(deviceLabel(names, "aaaa1111-0000")).toBe("Work Mac (aaaa)");
    expect(deviceLabel(names, "cccc3333-0000")).toBe("Work Mac (cccc)");
    expect(deviceLabel(names, "unknown")).toBe("another device");
  });
});
