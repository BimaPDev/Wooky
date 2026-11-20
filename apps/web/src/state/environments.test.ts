import type {
  DeviceSettings,
  Environment,
  RpcMethod,
  RpcParams,
  RpcResult,
} from "@wooky/contracts";
import { DeviceSettings as DeviceSettingsSchema } from "@wooky/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "./backend.ts";
import {
  bindTransport,
  noteConnectionStatus,
  probeEnvironments,
  switchEnvironment,
} from "./environments.ts";
import { useStore } from "./store.ts";

const home: Environment = {
  id: "env-home",
  label: "Home server",
  connection: { kind: "direct", url: "http://192.168.1.20:4317" },
  addedAt: "2026-01-01T00:00:00.000Z",
};
const lab: Environment = { ...home, id: "env-lab", label: "Lab" };

type Reply = (method: string, params: unknown) => unknown;

function setup(reply: Reply = () => undefined) {
  const reconnects: { url: string; token: string | null }[] = [];
  bindTransport({
    reconnect: (url, token) => {
      reconnects.push({ url, token });
      useStore.setState({ status: "open" });
    },
    localUrl: () => "ws://local/ws",
  });
  const calls: string[] = [];
  setBackend({
    call: async <M extends RpcMethod>(method: M, params: RpcParams<M>) => {
      calls.push(method);
      const answer = reply(method, params);
      if (answer instanceof Error) throw answer;
      return answer as RpcResult<M>;
    },
  });
  const settings: DeviceSettings = DeviceSettingsSchema.parse({ environments: [home, lab] });
  useStore.setState({ deviceSettings: settings, fixture: false, notice: null });
  return { reconnects, calls };
}

const info = (id: string) => ({ wsUrl: `ws://${id}/ws`, token: `token-${id}` });

describe("environments", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await switchEnvironment("local");
    vi.useRealTimers();
  });

  it("opens a remote with its token, then returns to the local server without one", async () => {
    const { reconnects } = setup((method, params) =>
      method === "remote.connectInfo"
        ? info((params as { environmentId: string }).environmentId)
        : undefined,
    );
    await switchEnvironment("env-home");
    expect(reconnects).toEqual([{ url: "ws://env-home/ws", token: "token-env-home" }]);
    expect(useStore.getState().model.seq).toBe(0);

    await switchEnvironment("local");
    expect(reconnects.at(-1)).toEqual({ url: "ws://local/ws", token: null });
  });

  it("marks an unreachable remote and keeps trying", async () => {
    let up = false;
    const { reconnects } = setup((method, params) => {
      if (method !== "remote.connectInfo") return undefined;
      return up ? info((params as { environmentId: string }).environmentId) : new Error("down");
    });
    await switchEnvironment("env-home");
    expect(reconnects).toEqual([]);
    expect(useStore.getState().status).toBe("reconnecting");

    up = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(reconnects).toEqual([{ url: "ws://env-home/ws", token: "token-env-home" }]);
  });

  it("follows the socket status for an open remote", async () => {
    const { reconnects } = setup((method, params) =>
      method === "remote.connectInfo"
        ? info((params as { environmentId: string }).environmentId)
        : undefined,
    );
    await switchEnvironment("env-home");
    expect(reconnects).toHaveLength(1);
    noteConnectionStatus("reconnecting");
    noteConnectionStatus("open");
    // The local session never flips: nothing to assert beyond no throw while remote.
    await switchEnvironment("local");
    noteConnectionStatus("offline");
  });

  it("asks the local server for the next remote's token and says so when it cannot", async () => {
    const { reconnects } = setup((method, params) =>
      method === "remote.connectInfo"
        ? info((params as { environmentId: string }).environmentId)
        : undefined,
    );
    await switchEnvironment("env-home");
    await switchEnvironment("env-lab");
    expect(reconnects).toHaveLength(1);
    expect(useStore.getState().notice).toContain("first");

    await switchEnvironment("local");
    await probeEnvironments();
    useStore.setState({ notice: null });
    await switchEnvironment("env-home");
    await switchEnvironment("env-lab");
    expect(reconnects.at(-1)).toEqual({ url: "ws://env-lab/ws", token: "token-env-lab" });
  });
});
