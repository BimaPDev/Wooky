import type { RpcError } from "@age/contracts";

/** A failure a client caused or can act on. Transport maps it to an RpcError as is. */
export class ServiceError extends Error {
  constructor(
    readonly code: RpcError["code"],
    message: string,
  ) {
    super(message);
  }
}
