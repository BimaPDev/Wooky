import { delimiter, dirname } from "node:path";
import { FLEET_LIMITS, type ThreadRole } from "@age/contracts";

interface AgentRuntime {
  serverUrl: string;
  /** Absolute path of the `age` shim on PATH. */
  ageBin: string;
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
 * Environment a provider child needs to call `age agents` back into this server.
 * `PATH` is prefixed with the directory that contains `ageBin`.
 */
export function agentEnv(input: {
  threadId: string;
  serverUrl: string;
  ageBin: string;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = input.env ?? process.env;
  const current = env.PATH ?? env.Path ?? "";
  const binDir = dirname(input.ageBin);
  const path = current.length > 0 ? `${binDir}${delimiter}${current}` : binDir;
  const issued =
    currentAgentRuntime()?.issueToken?.(input.threadId) ??
    (env.AGE_AGENT_TOKEN as string | undefined);
  return {
    AGE_THREAD_ID: input.threadId,
    AGE_SERVER_URL: input.serverUrl,
    PATH: path,
    ...(issued ? { AGE_AGENT_TOKEN: issued } : {}),
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
      ageBin: current.ageBin,
      env: base,
    }),
  };
}

export function coordinatorInstructions(): string {
  const workers = FLEET_LIMITS.maxLiveWorkers;
  return [
    "You can delegate subtasks to other agents with the age CLI. Workers run in their own git worktrees.",
    "",
    "age agents spawn --provider <provider> --model <model> [--title <text>] [--runtime-mode approve|auto-edits|full] -- <prompt>",
    "Starts a worker and prints its thread id. --prompt-file <path> reads the prompt from a file; - reads stdin.",
    "",
    "age agents list [--json]",
    "Lists your workers: id, status, provider, model, and title.",
    "",
    "age agents wait <threadId...> [--timeout <seconds>]",
    "Waits until each id is done or failed. Exit 0 means all finished; exit 2 means the timeout elapsed. The default is 600 seconds.",
    "",
    "age agents result <threadId> [--json]",
    "Prints the worker's status, summary, diff stat, and worktree path.",
    "",
    "When a worker finishes, its result arrives here automatically as a follow-up message. Prefer splitting independent subtasks and spawning them together.",
    `At most ${workers} workers may be live (working, waiting, or idle). A worker cannot spawn further workers.`,
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
