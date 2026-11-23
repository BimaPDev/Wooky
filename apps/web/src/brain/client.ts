import type {
  BrainEntry,
  BrainKind,
  BrainScope,
  BrainSearchHit,
  BrainSource,
  BrainTier,
  BrainTreeNode,
  MemoryFrontmatterInput,
} from "@wooky/contracts";
import { RpcCallError } from "../rpc/client.ts";
import { backend } from "../state/backend.ts";

/**
 * Typed client for all `brain.*` RPC methods.
 *
 * TODO(B2): Replace the local param and result types below with `RpcParams<...>` and
 * `RpcResult<...>` from `@wooky/contracts` once `feat/brain-rpc` lands in `packages/contracts/src/rpc.ts`.
 */

export interface BrainTransport {
  call(method: string, params: unknown): Promise<unknown>;
}

export interface BrainListParams {
  uri: string;
  includeArchived?: boolean;
}

export interface BrainReadParams {
  uri: string;
  tier: BrainTier;
}

export interface BrainSearchParams {
  query: string;
  scopes: BrainScope[];
  pathPrefix?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface BrainWriteParams {
  uri: string;
  frontmatter: MemoryFrontmatterInput;
  body: string;
  expectedUpdatedAt?: string;
}

export interface BrainWriteResult {
  uri: string;
  updatedAt: string;
  created: boolean;
}

export interface BrainArchiveParams {
  uri: string;
}

export interface BrainRemoveParams {
  uri: string;
}

export interface BrainReindexResult {
  indexed?: number;
  removed?: number;
  truncated?: boolean;
}

export interface BrainInboxProposal {
  id: string;
  targetUri: string;
  summary: string;
  kind: BrainKind;
  tags: string[];
  body: string;
  pinned?: boolean;
  source?: BrainSource;
  createdAt?: string;
}

export interface BrainInboxApproveParams {
  id: string;
}

export interface BrainInboxRejectParams {
  id: string;
}

export interface BrainInboxEditOverrides {
  targetUri: string;
  frontmatter: MemoryFrontmatterInput;
  body: string;
  expectedUpdatedAt?: string;
}

export class BrainInboxSavedRejectFailedError extends Error {
  readonly savedUri: string;
  readonly updatedAt: string;

  constructor(savedUri: string, updatedAt: string, cause?: unknown) {
    super("Your memory was saved but the proposal is still in the inbox. Reject it manually.", {
      cause,
    });
    this.name = "BrainInboxSavedRejectFailedError";
    this.savedUri = savedUri;
    this.updatedAt = updatedAt;
  }
}

export interface BrainClient {
  list(params: BrainListParams): Promise<BrainTreeNode[]>;
  read(params: BrainReadParams): Promise<BrainEntry>;
  search(params: BrainSearchParams): Promise<BrainSearchHit[]>;
  write(params: BrainWriteParams): Promise<BrainWriteResult>;
  archive(params: BrainArchiveParams): Promise<BrainWriteResult>;
  remove(params: BrainRemoveParams): Promise<void>;
  reindex(): Promise<BrainReindexResult>;
  listInbox(): Promise<BrainInboxProposal[]>;
  approveInbox(id: string, edits?: BrainInboxEditOverrides): Promise<void>;
  rejectInbox(id: string): Promise<void>;
}

export function defaultBrainTransport(): BrainTransport {
  return backend() as unknown as BrainTransport;
}

export async function listBrain(
  transport: BrainTransport,
  params: BrainListParams,
): Promise<BrainTreeNode[]> {
  const payload =
    params.includeArchived === undefined
      ? { uri: params.uri }
      : { uri: params.uri, includeArchived: params.includeArchived };
  const result = await transport.call("brain.list", payload);
  return Array.isArray(result) ? (result as BrainTreeNode[]) : [];
}

export async function readBrain(
  transport: BrainTransport,
  params: BrainReadParams,
): Promise<BrainEntry> {
  return (await transport.call("brain.read", params)) as BrainEntry;
}

export async function searchBrain(
  transport: BrainTransport,
  params: BrainSearchParams,
): Promise<BrainSearchHit[]> {
  const result = await transport.call("brain.search", params);
  return Array.isArray(result) ? (result as BrainSearchHit[]) : [];
}

export async function writeBrain(
  transport: BrainTransport,
  params: BrainWriteParams,
): Promise<BrainWriteResult> {
  return (await transport.call("brain.write", params)) as BrainWriteResult;
}

export async function archiveBrain(
  transport: BrainTransport,
  params: BrainArchiveParams,
): Promise<BrainWriteResult> {
  return (await transport.call("brain.archive", params)) as BrainWriteResult;
}

export async function removeBrain(
  transport: BrainTransport,
  params: BrainRemoveParams,
): Promise<void> {
  await transport.call("brain.remove", params);
}

export async function reindexBrain(transport: BrainTransport): Promise<BrainReindexResult> {
  const result = await transport.call("brain.reindex", {});
  return (result as BrainReindexResult | undefined) ?? {};
}

export async function listBrainInbox(transport: BrainTransport): Promise<BrainInboxProposal[]> {
  const result = await transport.call("brain.inbox.list", {});
  return Array.isArray(result) ? (result as BrainInboxProposal[]) : [];
}

/**
 * Approves a pending inbox proposal.
 *
 * TODO(B2): The real fix is `brain.inbox.approve` accepting `{ targetUri, frontmatter, body }`
 * directly so the write and inbox removal are atomic on the server.
 */
export async function approveBrainInbox(
  transport: BrainTransport,
  id: string,
  edits?: BrainInboxEditOverrides,
): Promise<void> {
  if (!edits) {
    await transport.call("brain.inbox.approve", { id } satisfies BrainInboxApproveParams);
    return;
  }
  const written = await writeBrain(transport, {
    uri: edits.targetUri,
    frontmatter: edits.frontmatter,
    body: edits.body,
    ...(edits.expectedUpdatedAt !== undefined
      ? { expectedUpdatedAt: edits.expectedUpdatedAt }
      : {}),
  });
  try {
    await transport.call("brain.inbox.reject", { id } satisfies BrainInboxRejectParams);
  } catch (error) {
    throw new BrainInboxSavedRejectFailedError(written.uri, written.updatedAt, error);
  }
}

export async function rejectBrainInbox(transport: BrainTransport, id: string): Promise<void> {
  await transport.call("brain.inbox.reject", { id } satisfies BrainInboxRejectParams);
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
