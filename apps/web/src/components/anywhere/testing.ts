import type { RpcMethod, RpcParams } from "@wooky/contracts";
import { vi } from "vitest";
import { createFixtureBackend } from "../../dev/fixture.ts";
import { resetAnywhereHistoryFixture } from "../../dev/fixture-anywhere-history.ts";
import { useAnywhereHistory } from "../../state/anywhere-history.ts";
import { setBackend, type Backend } from "../../state/backend.ts";

/** The fixture backend behind a spy, so tests can see which RPCs the UI made. */
type Call = (method: string, params: unknown) => Promise<unknown>;

export function installFixtureBackend(): { call: ReturnType<typeof vi.fn<Call>> } {
  resetAnywhereHistoryFixture();
  const fixture = createFixtureBackend();
  const call = vi.fn<Call>((method, params) =>
    fixture.call(method as RpcMethod, params as RpcParams<RpcMethod>),
  );
  setBackend({ call } as unknown as Backend);
  return { call };
}

export function resetAnywhereHistory() {
  useAnywhereHistory.setState({
    syncStatus: null,
    localDevice: null,
    replicas: {},
    replicaView: null,
    historyProjectId: null,
    snapshotTick: 0,
    claimFailures: {},
    toast: null,
  });
}

export const callsTo = (call: { mock: { calls: unknown[][] } }, method: string) =>
  call.mock.calls.filter((entry) => entry[0] === method).map((entry) => entry[1] as unknown);
