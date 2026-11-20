import {
  callTool,
  listTools,
  serverVersion,
  type McpFlags,
  type ToolContext,
} from "./mcp-tools.ts";

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;
const LATEST_PROTOCOL = "2025-06-18";

const USAGE = `Usage: wooky mcp [--projects <id,id>] [--read-only] [--allow-approvals] [--allow-full]

Speak MCP (JSON-RPC 2.0, one JSON object per line) to a running Wooky server.
The server is $WOOKY_SERVER_URL, or WOOKY_HOME/server.json when that process is still alive.
Stdout is protocol only.

--projects <id,id>   Only these projects. Other project ids are rejected.
--read-only          Expose overview, list, read, and wait.
--allow-approvals    Also expose wooky_approve. Off by default.
--allow-full         Let a task request full runtime. Otherwise the ceiling is approve.`;

export interface McpIo {
  stdin: ReadableStream<Uint8Array> | NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const defaultIo = (): McpIo => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

type RpcId = string | number | null;

interface RpcSuccess {
  jsonrpc: "2.0";
  id: RpcId;
  result: unknown;
}

interface RpcFailure {
  jsonrpc: "2.0";
  id: RpcId;
  error: { code: number; message: string };
}

class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export async function runMcpCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: McpIo = defaultIo(),
): Promise<void> {
  const flags = parseMcpArgs(args);
  if (flags === "help") {
    await writeLine(io.stdout, `${USAGE}\n`);
    return;
  }
  const ctx: ToolContext = { env, flags };
  let buffer = "";
  for await (const chunk of io.stdin) {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    buffer = await drain(buffer, io.stdout, ctx, false);
  }
  await drain(buffer, io.stdout, ctx, true);
}

function parseMcpArgs(args: string[]): McpFlags | "help" {
  let projects: Set<string> | null = null;
  let readOnly = false;
  let allowApprovals = false;
  let allowFull = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--help" || arg === "-h" || arg === "help") return "help";
    if (arg === "--read-only") {
      readOnly = true;
      continue;
    }
    if (arg === "--allow-approvals") {
      allowApprovals = true;
      continue;
    }
    if (arg === "--allow-full") {
      allowFull = true;
      continue;
    }
    const inline = arg.startsWith("--projects=") ? arg.slice("--projects=".length) : undefined;
    if (arg === "--projects" || inline !== undefined) {
      const value = inline !== undefined ? inline : args[i + 1];
      if (inline === undefined) i += 1;
      if (value === undefined || value.startsWith("--")) {
        throw new Error("Missing value for --projects.");
      }
      const ids = value
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      if (ids.length === 0) throw new Error("Pass at least one project id to --projects.");
      projects = new Set(ids);
      continue;
    }
    throw new Error(`Unknown argument ${arg}.`);
  }
  return { projects, readOnly, allowApprovals, allowFull };
}

async function drain(
  buffer: string,
  stdout: NodeJS.WritableStream,
  ctx: ToolContext,
  eof: boolean,
): Promise<string> {
  let rest = buffer;
  const lines: string[] = [];
  while (true) {
    const nl = rest.indexOf("\n");
    if (nl === -1) break;
    lines.push(rest.slice(0, nl).replace(/\r$/, ""));
    rest = rest.slice(nl + 1);
  }
  if (eof && rest.trim().length > 0) {
    lines.push(rest.replace(/\r$/, ""));
    rest = "";
  }
  for (const line of lines) {
    if (line.trim() === "") continue;
    const response = await handleLine(line, ctx);
    if (response) await writeLine(stdout, `${JSON.stringify(response)}\n`);
  }
  return rest;
}

async function handleLine(line: string, ctx: ToolContext): Promise<RpcSuccess | RpcFailure | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return failure(null, -32700, "Parse error");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return failure(null, -32600, "Invalid Request");
  const message = raw as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const hasId = Object.prototype.hasOwnProperty.call(message, "id") && message.id !== undefined;
  if (!hasId) return null;
  const id = isId(message.id) ? message.id : null;
  if (message.jsonrpc !== "2.0" || !isId(message.id) || typeof message.method !== "string") {
    return failure(id, -32600, "Invalid Request");
  }
  try {
    return { jsonrpc: "2.0", id, result: await dispatch(message.method, message.params, ctx) };
  } catch (error) {
    if (error instanceof ProtocolError) return failure(id, error.code, error.message);
    const messageText = error instanceof Error ? error.message : "Internal error";
    return failure(id, -32603, messageText);
  }
}

async function dispatch(method: string, params: unknown, ctx: ToolContext): Promise<unknown> {
  switch (method) {
    case "initialize":
      return initialize(params);
    case "ping":
      return {};
    case "tools/list":
      return { tools: listTools(ctx.flags) };
    case "tools/call":
      return call(params, ctx);
    default:
      throw new ProtocolError(-32601, "Method not found");
  }
}

function initialize(params: unknown): unknown {
  const body = objectParams(params);
  const requested = body.protocolVersion;
  // MCP negotiation: a version this server does not implement is answered with the newest it does.
  const protocolVersion =
    typeof requested === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : LATEST_PROTOCOL;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "wooky", version: serverVersion() },
    instructions:
      "Wooky must already be running. wooky_approve is unavailable unless this process was started with --allow-approvals.",
  };
}

async function call(params: unknown, ctx: ToolContext): Promise<unknown> {
  const body = objectParams(params);
  const name = body.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new ProtocolError(-32602, "Tool name is required.");
  }
  const args = body.arguments === undefined ? {} : body.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ProtocolError(-32602, "Tool arguments must be an object.");
  }
  return callTool(name, args as Record<string, unknown>, ctx);
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(-32600, "Invalid Request");
  }
  return value as Record<string, unknown>;
}

function isId(value: unknown): value is RpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isInteger(value))
  );
}

function failure(id: RpcId, code: number, message: string): RpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(line, (error) => (error ? reject(error) : resolve()));
  });
}
