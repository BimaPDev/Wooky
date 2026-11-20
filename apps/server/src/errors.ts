import type { RpcError } from "@wooky/contracts";

/**
 * `forbidden` is emitted on the wire for remote callers. The contract enum does
 * not list it; only this server-side code does.
 */
export type ServiceErrorCode = RpcError["code"] | "forbidden";

/** A failure a client caused or can act on. Transport maps it to an RpcError as is. */
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
