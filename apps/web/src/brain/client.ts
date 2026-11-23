import type {
  BrainEntry,
  BrainInboxItem,
  BrainSearchHit,
  BrainTreeNode,
  RpcParams,
  RpcResult,
} from "@wooky/contracts";
import { RpcCallError } from "../rpc/client.ts";
import { backend, type Backend } from "../state/backend.ts";

/** Typed client for all `brain.*` RPC methods, backed by `@wooky/contracts`. */

export type BrainTransport = Pick<Backend, "call">;

export type BrainListParams = Omit<RpcParams<"brain.list">, "agentToken">;
export type BrainReadParams = Omit<RpcParams<"brain.read">, "agentToken">;
export type BrainSearchParams = Omit<RpcParams<"brain.search">, "agentToken">;
export type BrainWriteParams = Omit<RpcParams<"brain.write">, "agentToken">;
export type BrainWriteResult = RpcResult<"brain.write">;
export type BrainArchiveParams = Omit<RpcParams<"brain.archive">, "agentToken">;
export type BrainArchiveResult = RpcResult<"brain.archive">;
export type BrainRemoveParams = Omit<RpcParams<"brain.remove">, "agentToken">;
export type BrainReindexResult = RpcResult<"brain.reindex">;
export type BrainInboxApproveEdits = NonNullable<RpcParams<"brain.inbox.approve">["edits"]>;

export interface BrainClient {
  list(params: BrainListParams): Promise<BrainTreeNode[]>;
  read(params: BrainReadParams): Promise<BrainEntry>;
  search(params: BrainSearchParams): Promise<BrainSearchHit[]>;
  write(params: BrainWriteParams): Promise<BrainWriteResult>;
  archive(params: BrainArchiveParams): Promise<BrainArchiveResult>;
  remove(params: BrainRemoveParams): Promise<void>;
  reindex(): Promise<BrainReindexResult>;
  listInbox(): Promise<BrainInboxItem[]>;
  approveInbox(
    id: string,
    edits?: BrainInboxApproveEdits,
  ): Promise<RpcResult<"brain.inbox.approve">>;
  rejectInbox(id: string): Promise<void>;
}

export function defaultBrainTransport(): BrainTransport {
  return backend();
}

export async function listBrain(
  transport: BrainTransport,
  params: BrainListParams,
): Promise<BrainTreeNode[]> {
  const payload: RpcParams<"brain.list"> =
    params.includeArchived === undefined
      ? { uri: params.uri }
      : { uri: params.uri, includeArchived: params.includeArchived };
  return transport.call("brain.list", payload);
}

export async function readBrain(
  transport: BrainTransport,
  params: BrainReadParams,
): Promise<BrainEntry> {
  return transport.call("brain.read", params);
}

export async function searchBrain(
  transport: BrainTransport,
  params: BrainSearchParams,
): Promise<BrainSearchHit[]> {
  return transport.call("brain.search", params);
}

export async function writeBrain(
  transport: BrainTransport,
  params: BrainWriteParams,
): Promise<BrainWriteResult> {
  return transport.call("brain.write", params);
}

export async function archiveBrain(
  transport: BrainTransport,
  params: BrainArchiveParams,
): Promise<BrainArchiveResult> {
  return transport.call("brain.archive", params);
}

export async function removeBrain(
  transport: BrainTransport,
  params: BrainRemoveParams,
): Promise<void> {
  await transport.call("brain.remove", params);
}

export async function reindexBrain(transport: BrainTransport): Promise<BrainReindexResult> {
  return transport.call("brain.reindex", {});
}

export async function listBrainInbox(transport: BrainTransport): Promise<BrainInboxItem[]> {
  return transport.call("brain.inbox.list", {});
}

export async function approveBrainInbox(
  transport: BrainTransport,
  id: string,
  edits?: BrainInboxApproveEdits,
): Promise<RpcResult<"brain.inbox.approve">> {
  return transport.call("brain.inbox.approve", edits ? { id, edits } : { id });
}

export async function rejectBrainInbox(transport: BrainTransport, id: string): Promise<void> {
  await transport.call("brain.inbox.reject", { id });
}

export function createBrainClient(
  transport: BrainTransport = defaultBrainTransport(),
): BrainClient {
  return {
    list: (params) => listBrain(transport, params),
    read: (params) => readBrain(transport, params),
    search: (params) => searchBrain(transport, params),
    write: (params) => writeBrain(transport, params),
    archive: (params) => archiveBrain(transport, params),
    remove: (params) => removeBrain(transport, params),
    reindex: () => reindexBrain(transport),
    listInbox: () => listBrainInbox(transport),
    approveInbox: (id, edits) => approveBrainInbox(transport, id, edits),
    rejectInbox: (id) => rejectBrainInbox(transport, id),
  };
}

export function isBrainErrorCode(
  error: unknown,
  code: "conflict" | "not_found" | "bad_request" | "forbidden" | "unavailable" | "internal",
): boolean {
  if (error instanceof RpcCallError) return error.code === code;
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code === code;
  }
  return false;
}

const MAX_BRAIN_ERROR_LENGTH = 240;

function capBrainError(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= MAX_BRAIN_ERROR_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_BRAIN_ERROR_LENGTH - 1)}…`;
}

export function brainErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") return capBrainError(error.message);
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return capBrainError(message);
  }
  return fallback;
}
