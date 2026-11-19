import type { RpcMethod, RpcParams, RpcResult } from "@wooky/contracts";

/** Everything the UI may ask of the server. Real socket or fixture, same shape. */
export interface Backend {
  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
}

let current: Backend | null = null;

export function setBackend(next: Backend) {
  current = next;
}

export function backend(): Backend {
  if (!current) throw new Error("Wooky backend not initialised");
  return current;
}
