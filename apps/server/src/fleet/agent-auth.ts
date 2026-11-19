import type { ReadModel, Thread } from "@age/contracts";
import { ServiceError } from "../errors.ts";
import type { AgentTokenService } from "./agent-token.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return LOOPBACK.has(remoteAddress.toLowerCase());
}

function isWorker(thread: Thread): boolean {
  return thread.role === "worker" || thread.parentThreadId !== undefined;
}

function callerFromToken(
  model: ReadModel,
  agentToken: string,
  tokens: AgentTokenService,
  parentThreadId?: string,
): string {
  const caller = tokens.verify(agentToken, model);
  if (!caller) throw new ServiceError("bad_request", "Invalid agent token.");
  if (parentThreadId !== undefined && parentThreadId !== caller) {
    throw new ServiceError("bad_request", "parentThreadId does not match the agent token.");
  }
  return caller;
}

/** Resolve the coordinator thread for spawn and list. */
export function resolveAgentCaller(input: {
  model: ReadModel;
  remoteAddress: string | undefined;
  agentToken?: string;
  parentThreadId?: string;
  tokens: AgentTokenService;
}): string {
  const { model, remoteAddress, agentToken, parentThreadId, tokens } = input;
  if (agentToken) {
    const caller = callerFromToken(model, agentToken, tokens, parentThreadId);
    const thread = model.threads[caller];
    if (!thread) throw new ServiceError("not_found", `No thread with id ${caller}.`);
    if (isWorker(thread)) throw new ServiceError("bad_request", "Workers cannot spawn.");
    return caller;
  }
  if (!isLoopbackAddress(remoteAddress)) {
    throw new ServiceError("bad_request", "Agent token is required for remote callers.");
  }
  if (!parentThreadId) throw new ServiceError("bad_request", "parentThreadId is required.");
  const parent = model.threads[parentThreadId];
  if (!parent) throw new ServiceError("not_found", `No thread with id ${parentThreadId}.`);
  if (isWorker(parent)) {
    throw new ServiceError("bad_request", "Workers cannot spawn.");
  }
  return parentThreadId;
}

/** Verify a token when present; loopback human path needs no token. */
export function verifyAgentToken(input: {
  model: ReadModel;
  remoteAddress: string | undefined;
  agentToken?: string;
  tokens: AgentTokenService;
}): void {
  const { model, remoteAddress, agentToken, tokens } = input;
  if (agentToken) {
    if (!tokens.verify(agentToken, model)) {
      throw new ServiceError("bad_request", "Invalid agent token.");
    }
    return;
  }
  if (!isLoopbackAddress(remoteAddress)) {
    throw new ServiceError("bad_request", "Agent token is required for remote callers.");
  }
}
