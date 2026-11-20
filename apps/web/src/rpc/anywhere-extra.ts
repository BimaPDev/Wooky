// TODO(A1): replace with contracts once remote.join and remote.connectInfo are merged.
import { DeviceInfo, Environment, type RemoteConnection } from "@wooky/contracts";
import { backend } from "../state/backend.ts";

export interface RemoteJoinParams {
  connection: RemoteConnection;
  code: string;
  label?: string;
}

export interface RemoteJoinResult {
  environment: Environment;
  host: DeviceInfo;
}

export interface RemoteConnectInfoResult {
  wsUrl: string;
  token: string;
}

type LooseCall = (method: string, params: unknown) => Promise<unknown>;

function looseCall(): LooseCall {
  return backend().call as unknown as LooseCall;
}

function asRecord(value: unknown, method: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(`Unexpected ${method} result.`);
  return value as Record<string, unknown>;
}

export async function remoteJoin(params: RemoteJoinParams): Promise<RemoteJoinResult> {
  const raw = asRecord(await looseCall()("remote.join", params), "remote.join");
  return { environment: Environment.parse(raw.environment), host: DeviceInfo.parse(raw.host) };
}

export async function remoteConnectInfo(environmentId: string): Promise<RemoteConnectInfoResult> {
  const raw = asRecord(
    await looseCall()("remote.connectInfo", { environmentId }),
    "remote.connectInfo",
  );
  if (typeof raw.wsUrl !== "string" || !raw.wsUrl || typeof raw.token !== "string" || !raw.token)
    throw new Error("Unexpected remote.connectInfo result.");
  return { wsUrl: raw.wsUrl, token: raw.token };
}
