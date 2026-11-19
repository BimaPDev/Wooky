import { appendFileSync, writeFileSync } from "node:fs";

export const FAKE_ACP_VERSION = "0.0.1-fake";

const args = process.argv.slice(2);
const scenario = process.env.AGE_FAKE_ACP_SCENARIO ?? "stream";
const logFile = process.env.AGE_FAKE_ACP_LOG ?? "";
const envFile = process.env.AGE_FAKE_ACP_ENV_FILE ?? "";

if (args[0] === "--version") {
  process.stdout.write("opencode 9.9.9\n");
  process.exit(0);
}

if (args[0] === "models") {
  process.stdout.write(
    "opencode/big-pickle\nopencode/deepseek-v4.1-flash-free\n\nnot a model\nopencode/big-pickle\n",
  );
  process.exit(0);
}

if (envFile) {
  writeFileSync(
    envFile,
    JSON.stringify({
      AGE_THREAD_ID: process.env.AGE_THREAD_ID ?? null,
      AGE_SERVER_URL: process.env.AGE_SERVER_URL ?? null,
      MARKER: process.env.AGE_TEST_ENV_MARKER ?? null,
      OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION ?? null,
    }),
  );
}

function log(method, params) {
  if (!logFile) return;
  appendFileSync(logFile, `${JSON.stringify({ method, params })}\n`);
}

log("argv", args);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let nextId = 1;
let cancelled = false;
let onCancel = () => {};
const pending = new Map();

function requestPermission(params) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method: "session/request_permission", params });
  });
}

function update(sessionUpdate) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "sess_fake_1", update: sessionUpdate },
  });
}

const loadSession = scenario !== "no-load";
const authMethods =
  process.env.AGE_FAKE_ACP_AUTH === "1"
    ? [{ id: "login", name: "Login", description: "Sign in" }]
    : [];

function configOptions() {
  if (scenario === "no-model" || scenario === "no-model-method") return undefined;
  return [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "opencode/other",
      options: [{ value: "opencode/big-pickle", name: "Big Pickle" }],
    },
  ];
}

async function runPrompt(id) {
  if (scenario === "crash") {
    process.stderr.write("simulated crash\n");
    process.exit(1);
  }
  if (scenario === "rate-limit") {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "429 too many requests" },
    });
    return;
  }
  if (scenario === "malformed") {
    process.stdout.write("not json\n");
    process.stdout.write("{}\n");
    send({ jsonrpc: "2.0", method: "mystery/note", params: { ok: true } });
    update({ sessionUpdate: "future_widget", extra: true });
  }
  if (scenario === "oversize") {
    process.stdout.write(`${"x".repeat(9_000)}\n`);
  }
  if (scenario === "permission") {
    const kind = process.env.AGE_FAKE_ACP_TOOL_KIND ?? "execute";
    update({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: kind === "edit" ? "Edit hello.txt" : "Run tests",
      kind,
      status: "pending",
      name: kind === "edit" ? "write" : "bash",
    });
    const outcome = await requestPermission({
      sessionId: "sess_fake_1",
      title: kind === "edit" ? "Edit hello.txt" : "Run tests",
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Reject", kind: "reject_once" },
      ],
      toolCall: {
        toolCallId: "call_1",
        title: kind === "edit" ? "Edit hello.txt" : "Run tests",
        kind,
        status: "pending",
      },
    });
    log("permission-result", outcome);
    const allowed = outcome?.outcome?.optionId === "allow";
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: allowed ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: allowed ? "ok" : "denied" } }],
    });
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: allowed ? "done" : "skipped" },
    });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "cancel") {
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "working" },
    });
    if (!cancelled) {
      await new Promise((resolve) => {
        onCancel = resolve;
      });
    }
    send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    return;
  }
  if (scenario === "hang") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1 << 30);
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "stuck" },
    });
    await new Promise(() => {});
  }

  update({
    sessionUpdate: "agent_message_chunk",
    messageId: "m1",
    content: { type: "text", text: "Hello " },
  });
  update({
    sessionUpdate: "agent_message_chunk",
    messageId: "m1",
    content: { type: "text", text: "world" },
  });
  update({
    sessionUpdate: "agent_thought_chunk",
    messageId: "t1",
    content: { type: "text", text: "thinking" },
  });
  update({
    sessionUpdate: "plan",
    entries: [{ content: "Write the file", priority: "high", status: "pending" }],
  });
  update({
    sessionUpdate: "usage_update",
    used: 12,
    size: 1000,
    cost: { amount: 0, currency: "USD" },
  });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  if (message.id !== undefined && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message.result);
    return;
  }
  if (!message.method || message.id === undefined) {
    if (message.method === "session/cancel") {
      cancelled = true;
      log("session/cancel", message.params ?? {});
      onCancel();
    }
    return;
  }
  log(message.method, message.params ?? {});
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession },
      agentInfo: { name: "Fake ACP", version: FAKE_ACP_VERSION },
      authMethods,
    });
    return;
  }
  if (message.method === "session/new" || message.method === "session/load") {
    const options = configOptions();
    reply(message.id, {
      sessionId: "sess_fake_1",
      ...(options ? { configOptions: options } : {}),
    });
    return;
  }
  if (message.method === "session/set_config_option") {
    reply(message.id, { configOptions: configOptions() ?? [] });
    return;
  }
  if (message.method === "session/set_model") {
    if (scenario === "no-model-method") {
      fail(message.id, -32601, "Method not found: session/set_model");
      return;
    }
    reply(message.id, {});
    return;
  }
  if (message.method === "session/prompt") {
    await runPrompt(message.id);
    return;
  }
  fail(message.id, -32601, `Method not found: ${message.method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(message);
  }
});

process.stdin.on("end", () => {
  if (scenario !== "hang") process.exit(0);
});

if (scenario !== "hang") {
  process.on("SIGTERM", () => process.exit(0));
}
