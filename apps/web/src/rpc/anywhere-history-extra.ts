import { ReplicaModel } from "@wooky/contracts";
import { backend } from "../state/backend.ts";

// TODO(A3): replace with contracts once merged. `sync.replicas {}` → ReplicaModel is not an
// RpcMethod on main yet, so this calls it by name and validates the reply here.
export async function fetchReplicas(): Promise<ReplicaModel> {
  const raw = await (backend() as { call(method: string, params: unknown): Promise<unknown> }).call(
    "sync.replicas",
    {},
  );
  return ReplicaModel.parse(raw);
}
