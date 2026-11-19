import { delimiter, dirname } from "node:path";
import type { ThreadRole } from "@wooky/contracts";

interface AgentRuntime {
  serverUrl: string;
  /** Absolute path of the `wooky` shim on PATH. */
  wookyBin: string;
  issueToken?: (threadId: string) => string;
}

let runtime: AgentRuntime | null = null;

export function setAgentRuntime(next: AgentRuntime | null): void {
  runtime = next;
}

export function setAgentTokenIssuer(issue: ((threadId: string) => string) | null): void {
  if (!runtime) return;
  runtime = { ...runtime, ...(issue ? { issueToken: issue } : { issueToken: undefined }) };
}

export function currentAgentRuntime(): AgentRuntime | null {
  return runtime;
}

/**
 * Environment a provider child needs to call `wooky agents` back into this server.
 * `PATH` is prefixed with the directory that contains `wookyBin`.
 */
export function agentEnv(input: {
  threadId: string;
  serverUrl: string;
  wookyBin: string;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = input.env ?? process.env;
  const current = env.PATH ?? env.Path ?? "";
  const binDir = dirname(input.wookyBin);
  const path = current.length > 0 ? `${binDir}${delimiter}${current}` : binDir;
  const issued =
    currentAgentRuntime()?.issueToken?.(input.threadId) ??
    (env.WOOKY_AGENT_TOKEN as string | undefined);
  return {
    WOOKY_THREAD_ID: input.threadId,
    WOOKY_SERVER_URL: input.serverUrl,
    PATH: path,
    ...(issued ? { WOOKY_AGENT_TOKEN: issued } : {}),
  };
}

/** Merge {@link agentEnv} when the server has published its URL and shim. */
export function fleetChildEnv(
  threadId: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const current = currentAgentRuntime();
  if (!current) return base;
  return {
    ...base,
    ...agentEnv({
      threadId,
      serverUrl: current.serverUrl,
      wookyBin: current.wookyBin,
      env: base,
    }),
  };
}

export function coordinatorInstructions(): string {
  return [
    "You can delegate subtasks to other agents with the wooky CLI. Workers run in their own git worktrees and cannot spawn further workers.",
    "Run `wooky agents guide` for the full playbook (workflow, brief writing, commands, limits) and the live list of usable agents and models.",
  ].join("\n");
}

export function workerNote(): string {
  return "You are a worker in this fleet. You cannot spawn other agents.";
}

/** Solo and coordinator threads can spawn. A worker cannot. Absent role means solo. */
export function instructionsForRole(role: ThreadRole | undefined): string {
  return role === "worker" ? workerNote() : coordinatorInstructions();
}

/**
 * Instructions for the first prompt of a session. A resumed session already
 * has them. Callers that wrap a handoff should apply that wrap after this.
 */
export function prefixSessionPrompt(
  prompt: string,
  input: { resumeSessionId: string | null; role?: ThreadRole },
): string {
  if (input.resumeSessionId) return prompt;
  return `${instructionsForRole(input.role)}\n\n${prompt}`;
}
