import { appendFileSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.160.0\n");
  process.exit(0);
}

function readFlag(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

const scenario = readFlag("--scenario") ?? "standard";
const logFile = readFlag("--log-file");
const pidFile = readFlag("--pid-file");

if (pidFile) {
  writeFileSync(pidFile, String(process.pid), "utf8");
}

function logIncoming(frame) {
  if (!logFile) return;
  appendFileSync(logFile, `${JSON.stringify(frame)}\n`, "utf8");
}

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

let initialized = false;
let handshakeAcked = false;
let currentThreadId = "thr_fake_1";
const currentTurnId = "turn_fake_1";
const pendingServerRequests = new Map();

// Keep stdin open during hang scenarios until closed or signaled.
process.on("SIGTERM", () => {
  process.exit(0);
});

function finishTurnWithDecision(decision) {
  const accepted = decision === "accept";
  send({
    method: "serverRequest/resolved",
    params: { threadId: currentThreadId, requestId: 500 },
  });

  if (scenario === "file-approval") {
    send({
      method: "item/completed",
      params: {
        threadId: currentThreadId,
        turnId: currentTurnId,
        completedAtMs: 20,
        item: {
          type: "fileChange",
          id: "edit_1",
          status: accepted ? "completed" : "declined",
          changes: [
            {
              path: "src/app.ts",
              kind: { type: "update", move_path: null },
              diff: "@@ -1 +1 @@\n-const oldVal = 1;\n+const newVal = 2;",
            },
          ],
        },
      },
    });
  } else {
    if (accepted) {
      send({
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: currentThreadId,
          turnId: currentTurnId,
          itemId: "cmd_1",
          delta: "all checks green\n",
        },
      });
    }
    send({
      method: "item/completed",
      params: {
        threadId: currentThreadId,
        turnId: currentTurnId,
        completedAtMs: 20,
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "pnpm test",
          cwd: process.cwd(),
          status: accepted ? "completed" : "declined",
          commandActions: [],
          aggregatedOutput: accepted ? "all checks green\n" : null,
          exitCode: accepted ? 0 : null,
          durationMs: 12,
        },
      },
    });
  }

  const replyText = accepted ? "Done running checks." : "Skipped after denial.";
  send({
    method: "item/started",
    params: {
      threadId: currentThreadId,
      turnId: currentTurnId,
      startedAtMs: 25,
      item: { type: "agentMessage", id: "msg_1", text: "" },
    },
  });
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: currentThreadId,
      turnId: currentTurnId,
      itemId: "msg_1",
      delta: replyText.slice(0, 5),
    },
  });
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: currentThreadId,
      turnId: currentTurnId,
      itemId: "msg_1",
      delta: replyText.slice(5),
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId: currentThreadId,
      turnId: currentTurnId,
      completedAtMs: 30,
      item: { type: "agentMessage", id: "msg_1", text: replyText },
    },
  });
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: currentThreadId,
      turnId: currentTurnId,
      tokenUsage: {
        total: {
          totalTokens: 150,
          inputTokens: 100,
          cachedInputTokens: 25,
          cacheWriteInputTokens: 0,
          outputTokens: 50,
          reasoningOutputTokens: 10,
        },
        last: {
          totalTokens: 150,
          inputTokens: 100,
          cachedInputTokens: 25,
          cacheWriteInputTokens: 0,
          outputTokens: 50,
          reasoningOutputTokens: 10,
        },
        modelContextWindow: 500000,
      },
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId: currentThreadId,
      turn: {
        id: currentTurnId,
        status: "completed",
        items: [],
        error: null,
      },
    },
  });
}

function handleClientRequest(msg) {
  if (msg.method === "initialize") {
    if (initialized) {
      send({ id: msg.id, error: { code: -32600, message: "Already initialized" } });
      return;
    }
    initialized = true;
    send({
      id: msg.id,
      result: {
        userAgent: "codex-fake/0.160.0",
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    return;
  }

  if (!initialized || !handshakeAcked) {
    send({ id: msg.id, error: { code: -32600, message: "Not initialized" } });
    return;
  }

  if (msg.method === "thread/start") {
    currentThreadId = "thr_started_1";
    send({
      id: msg.id,
      result: {
        thread: { id: currentThreadId },
      },
    });
    send({
      method: "thread/started",
      params: { thread: { id: currentThreadId } },
    });
    return;
  }

  if (msg.method === "thread/resume") {
    currentThreadId = msg.params?.threadId ?? "thr_resumed_fallback";
    send({
      id: msg.id,
      result: {
        thread: { id: currentThreadId },
      },
    });
    return;
  }

  if (msg.method === "turn/start") {
    send({
      id: msg.id,
      result: {
        turn: { id: currentTurnId, status: "inProgress", items: [], error: null },
      },
    });
    send({
      method: "turn/started",
      params: {
        threadId: currentThreadId,
        turn: { id: currentTurnId, status: "inProgress", items: [], error: null },
      },
    });

    if (scenario === "crash-mid-turn") {
      const padding = "x".repeat(5000);
      process.stderr.write(`${padding}\nFATAL: simulated codex panic in worker\n`);
      process.exit(1);
    }

    send({
      method: "item/started",
      params: {
        threadId: currentThreadId,
        turnId: currentTurnId,
        startedAtMs: 5,
        item: { type: "reasoning", id: "rsn_1", summary: [], content: [] },
      },
    });
    send({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: currentThreadId,
        turnId: currentTurnId,
        itemId: "rsn_1",
        delta: "Checking workspace...",
        summaryIndex: 0,
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: currentThreadId,
        turnId: currentTurnId,
        completedAtMs: 8,
        item: {
          type: "reasoning",
          id: "rsn_1",
          summary: ["Checking workspace..."],
          content: [],
        },
      },
    });

    if (scenario === "hang-mid-turn") {
      return;
    }

    if (scenario === "file-approval") {
      send({
        method: "item/started",
        params: {
          threadId: currentThreadId,
          turnId: currentTurnId,
          startedAtMs: 10,
          item: {
            type: "fileChange",
            id: "edit_1",
            status: "inProgress",
            changes: [
              {
                path: "src/app.ts",
                kind: { type: "update", move_path: null },
                diff: "@@ -1 +1 @@\n-const oldVal = 1;\n+const newVal = 2;",
              },
            ],
          },
        },
      });

      if (msg.params?.approvalPolicy === "never") {
        finishTurnWithDecision("accept");
        return;
      }

      pendingServerRequests.set(500, (result) => {
        finishTurnWithDecision(result?.decision ?? "decline");
      });
      send({
        id: 500,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: currentThreadId,
          turnId: currentTurnId,
          itemId: "edit_1",
          startedAtMs: 12,
          reason: "Update src/app.ts",
          grantRoot: null,
        },
      });
      return;
    }

    send({
      method: "item/started",
      params: {
        threadId: currentThreadId,
        turnId: currentTurnId,
        startedAtMs: 10,
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "pnpm test",
          cwd: process.cwd(),
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    });

    if (msg.params?.approvalPolicy === "never" && scenario !== "force-approval") {
      finishTurnWithDecision("accept");
      return;
    }

    pendingServerRequests.set(500, (result) => {
      finishTurnWithDecision(result?.decision ?? "decline");
    });
    send({
      id: 500,
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command",
        threadId: currentThreadId,
        turnId: currentTurnId,
        itemId: "cmd_1",
        startedAtMs: 12,
        environmentId: null,
        command: "pnpm test",
        cwd: process.cwd(),
        reason: "Run project test suite",
      },
    });
    return;
  }

  if (msg.method === "turn/interrupt") {
    send({ id: msg.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: msg.params?.threadId ?? currentThreadId,
        turn: {
          id: msg.params?.turnId ?? currentTurnId,
          status: "interrupted",
          items: [],
          error: null,
        },
      },
    });
    return;
  }

  send({
    id: msg.id,
    error: { code: -32601, message: `Unknown method: ${String(msg.method)}` },
  });
}

const decoder = new StringDecoder("utf8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let idx = buffer.indexOf("\n");
  while (idx >= 0) {
    const raw = buffer.slice(0, idx).replace(/\r$/, "");
    buffer = buffer.slice(idx + 1);
    if (raw.trim().length > 0) {
      const msg = JSON.parse(raw);
      logIncoming(msg);
      if (typeof msg.method === "string" && msg.id === undefined) {
        if (msg.method === "initialized") handshakeAcked = true;
      } else if (typeof msg.method === "string") {
        handleClientRequest(msg);
      } else if (msg.id !== undefined && pendingServerRequests.has(msg.id)) {
        const resolver = pendingServerRequests.get(msg.id);
        pendingServerRequests.delete(msg.id);
        resolver(msg.result);
      }
    }
    idx = buffer.indexOf("\n");
  }
});
