import { readFileSync } from "node:fs";
import {
  FLEET_LIMITS,
  ProviderKind,
  RuntimeMode,
  type AgentResult,
  type FleetRow,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
} from "@age/contracts";
import { fleetGuide, formatAgents, usableAgents } from "../fleet/guide.ts";
import { discoverServerUrl } from "../presence.ts";
import { rpcCall } from "./rpc-client.ts";

const USAGE = `Usage: age agents <command>

  providers [--json]
  guide
  spawn --provider <kind> --model <id> [--title <text>] [--runtime-mode approve|auto-edits|full] [--key <idempotency>] [--prompt-file <path>] -- <prompt...>
  list [--json]
  wait [--timeout <seconds>] <threadId>...
  result <threadId> [--json]

providers and guide list usable agents. spawn and list use $AGE_THREAD_ID as the parent thread. The server is $AGE_SERVER_URL, or AGE_HOME/server.json when that process is still running. --timeout is seconds, default ${FLEET_LIMITS.maxAgentsWaitMs / 1000}.`;

const DEFAULT_TIMEOUT_SECONDS = FLEET_LIMITS.maxAgentsWaitMs / 1000;
const RPC_TIMEOUT_MS = 30_000;
const BOOLEAN_FLAGS = new Set(["json", "help"]);

export interface CliIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const defaultIo = (): CliIo => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

export async function runAgentsCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo = defaultIo(),
): Promise<number> {
  try {
    return await run(args, env, io);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function run(args: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help") {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const { flags, positionals } = parseArgs(rest);
  if (flags.has("help")) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  switch (command) {
    case "providers":
      return providers(flags, positionals, env, io);
    case "guide":
      return guide(flags, positionals, env, io);
    case "spawn":
      return spawn(flags, positionals, env, io);
    case "list":
      return list(flags, positionals, env, io);
    case "wait":
      return wait(flags, positionals, env, io);
    case "result":
      return showResult(flags, positionals, env, io);
    default:
      io.stderr.write(`${USAGE}\n`);
      return 1;
  }
}

async function providers(
  flags: Map<string, string | true>,
  positionals: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  rejectUnknown(flags, ["json", "help"]);
  if (positionals.length > 0) throw new Error("Unexpected argument.");
  const agents = await loadUsableAgents(env);
  if (flags.has("json")) {
    io.stdout.write(`${JSON.stringify(agents, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`${formatAgents(agents)}\n`);
  return 0;
}

async function guide(
  flags: Map<string, string | true>,
  positionals: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  rejectUnknown(flags, ["help"]);
  if (positionals.length > 0) throw new Error("Unexpected argument.");
  const agents = await loadUsableAgents(env);
  io.stdout.write(`${fleetGuide(agents)}\n`);
  return 0;
}

async function loadUsableAgents(env: NodeJS.ProcessEnv) {
  const [listed, settings] = await Promise.all([
    call(env, "providers.list", {}),
    call(env, "settings.get", {}),
  ]);
  return usableAgents(listed, settings.disabledProviders);
}

async function spawn(
  flags: Map<string, string | true>,
  positionals: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  rejectUnknown(flags, [
    "provider",
    "model",
    "title",
    "runtime-mode",
    "key",
    "prompt-file",
    "help",
  ]);
  const providerFlag = flagValue(flags, "provider");
  if (!providerFlag) throw new Error("Missing --provider.");
  const provider = ProviderKind.safeParse(providerFlag);
  if (!provider.success) throw new Error(`Provider must be ${ProviderKind.options.join(", ")}.`);
  const model = flagValue(flags, "model");
  if (!model) throw new Error("Missing --model.");
  const runtimeFlag = flagValue(flags, "runtime-mode");
  let runtimeMode: RuntimeMode | undefined;
  if (runtimeFlag !== undefined) {
    const parsed = RuntimeMode.safeParse(runtimeFlag);
    if (!parsed.success) throw new Error("Runtime mode must be approve, auto-edits, or full.");
    runtimeMode = parsed.data;
  }
  const title = flagValue(flags, "title");
  const prompt = await resolvePrompt(flags, positionals, io);
  const key = flagValue(flags, "key");
  const spawned = await call(env, "agents.spawn", {
    parentThreadId: requireParent(env),
    provider: provider.data,
    model,
    prompt,
    ...(title ? { title } : {}),
    ...(runtimeMode ? { runtimeMode } : {}),
    ...(key ? { idempotencyKey: key } : {}),
    ...(env.AGE_AGENT_TOKEN ? { agentToken: env.AGE_AGENT_TOKEN } : {}),
  });
  io.stdout.write(`${spawned.threadId}\n`);
  return 0;
}

async function list(
  flags: Map<string, string | true>,
  positionals: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  rejectUnknown(flags, ["json", "help"]);
  if (positionals.length > 0) throw new Error("Unexpected argument.");
  const rows = await call(env, "agents.list", {
    parentThreadId: requireParent(env),
    ...(env.AGE_AGENT_TOKEN ? { agentToken: env.AGE_AGENT_TOKEN } : {}),
  });
  if (flags.has("json")) {
    io.stdout.write(`${JSON.stringify(rows.map(stableRow), null, 2)}\n`);
    return 0;
  }
  for (const row of rows) {
    io.stdout.write(`${row.threadId} ${row.status} ${row.provider} ${row.model} ${row.title}\n`);
  }
  return 0;
}

async function wait(
  flags: Map<string, string | true>,
  positionals: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  rejectUnknown(flags, ["timeout", "help"]);
  if (positionals.length === 0) throw new Error("wait needs at least one thread id.");
  const seconds = timeoutSeconds(flags);
  const timeoutMs = seconds * 1000;
  const waited = await call(
    env,
    "agents.wait",
    {
      threadIds: positionals,
      timeoutMs,
      ...(env.AGE_AGENT_TOKEN ? { agentToken: env.AGE_AGENT_TOKEN } : {}),
    },
    timeoutMs + RPC_TIMEOUT_MS,
  );
  const pending = new Set(waited.pending);
  for (const id of positionals) {
    io.stdout.write(`${id} ${pending.has(id) ? "pending" : "finished"}\n`);
  }
  return waited.pending.length > 0 ? 2 : 0;
}

async function showResult(
  flags: Map<string, string | true>,
  positionals: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  rejectUnknown(flags, ["json", "help"]);
  const threadId = positionals[0];
  if (!threadId || positionals.length !== 1) throw new Error("result needs one thread id.");
  const report = await call(env, "agents.result", {
    threadId,
    ...(env.AGE_AGENT_TOKEN ? { agentToken: env.AGE_AGENT_TOKEN } : {}),
  });
  if (flags.has("json")) {
    io.stdout.write(`${JSON.stringify(stableResult(report), null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`${report.status}\n${report.summary}\n`);
  if (report.diffStat) {
    const { files, additions, deletions } = report.diffStat;
    io.stdout.write(`${files} files, +${additions} -${deletions}\n`);
  }
  if (report.worktreePath) io.stdout.write(`${report.worktreePath}\n`);
  return 0;
}

function requireParent(env: NodeJS.ProcessEnv): string {
  const id = env.AGE_THREAD_ID?.trim();
  if (!id) throw new Error("AGE_THREAD_ID is not set. Run age agents from an AGE turn.");
  return id;
}

function timeoutSeconds(flags: Map<string, string | true>): number {
  const raw = flagValue(flags, "timeout");
  if (raw === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!/^\d+$/.test(raw)) throw new Error("Timeout must be a whole number of seconds.");
  const seconds = Number(raw);
  if (seconds > DEFAULT_TIMEOUT_SECONDS) {
    throw new Error(`Timeout is at most ${DEFAULT_TIMEOUT_SECONDS} seconds.`);
  }
  return seconds;
}

async function resolvePrompt(
  flags: Map<string, string | true>,
  positionals: string[],
  io: CliIo,
): Promise<string> {
  const file = flagValue(flags, "prompt-file");
  const words = positionals.join(" ");
  if (file !== undefined && words.trim().length > 0) {
    throw new Error("Pass the prompt with arguments or --prompt-file, not both.");
  }
  let text: string;
  if (file === "-") text = await readStdin(io.stdin);
  else if (file !== undefined) text = readFileSync(file, "utf8");
  else if (positionals.length === 1 && positionals[0] === "-") text = await readStdin(io.stdin);
  else text = words;
  const prompt = text.trim();
  if (!prompt) throw new Error("Missing prompt.");
  return prompt;
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function call<M extends RpcMethod>(
  env: NodeJS.ProcessEnv,
  method: M,
  params: RpcParams<M>,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<RpcResult<M>> {
  return rpcCall(discoverServerUrl(env), method, params, timeoutMs);
}

function stableRow(row: FleetRow) {
  return {
    threadId: row.threadId,
    projectId: row.projectId,
    title: row.title,
    provider: row.provider,
    model: row.model,
    role: row.role,
    ...(row.groupId !== undefined ? { groupId: row.groupId } : {}),
    ...(row.parentThreadId !== undefined ? { parentThreadId: row.parentThreadId } : {}),
    status: row.status,
    ...(row.waitingOn !== undefined ? { waitingOn: row.waitingOn } : {}),
    lastActivityAt: row.lastActivityAt,
    ...(row.diffStat !== undefined ? { diffStat: row.diffStat } : {}),
  };
}

function stableResult(report: AgentResult) {
  return {
    status: report.status,
    summary: report.summary,
    ...(report.diffStat !== undefined ? { diffStat: report.diffStat } : {}),
    ...(report.worktreePath !== undefined ? { worktreePath: report.worktreePath } : {}),
  };
}

function flagValue(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (typeof value !== "string") return undefined;
  return value;
}

function rejectUnknown(flags: Map<string, string | true>, allowed: readonly string[]): void {
  for (const key of flags.keys()) {
    if (!allowed.includes(key)) throw new Error(`Unknown flag --${key}.`);
  }
}

function parseArgs(args: string[]): { flags: Map<string, string | true>; positionals: string[] } {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let rest = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (rest) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      rest = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    if (!key) throw new Error("Missing flag name.");
    if (eq !== -1) {
      flags.set(key, body.slice(eq + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(key)) {
      flags.set(key, true);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next === "--" || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }
    flags.set(key, next);
    i += 1;
  }
  return { flags, positionals };
}
