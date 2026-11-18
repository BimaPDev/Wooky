import { spawn } from "node:child_process";
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
const grandchildPidFile = readFlag("--grandchild-pid-file");

if (pidFile) {
  writeFileSync(pidFile, String(process.pid), "utf8");
}

// Spawn a long-lived grandchild as an ordinary child. It is NOT detached, so
// killing only this server's pid would orphan (not kill) it: proving the group
// kill is what takes it down.
function spawnGrandchild() {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30);"], {
    stdio: "ignore",
  });
  if (grandchildPidFile) {
    writeFileSync(grandchildPidFile, String(grandchild.pid), "utf8");
  }
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
let isResumeTurn = false;
const pendingServerRequests = new Map();

// Usage the app-server reports at the end of a turn. `total` is the cumulative
// thread total and `last` is this turn's own increment, as the real app-server
// reports them. A resumed turn therefore reports a larger total but an
// incremental `last`, so the adapter must not treat the whole total as the turn.
const PENDING_APPROVALS = 8;
const FIRST_TURN_USAGE = { inputTokens: 100, cachedInputTokens: 25, outputTokens: 50 };

function usageReport() {
  if (isResumeTurn && (scenario === "cumulative-usage" || scenario === "usage-during-resume")) {
    return {
      total: { inputTokens: 250, cachedInputTokens: 40, outputTokens: 120 },
      last: { inputTokens: 150, cachedInputTokens: 15, outputTokens: 70 },
    };
  }
  if (isResumeTurn && scenario === "resume-new-thread") {
    // The forked thread starts over, so its cumulative total is below the old one.
    const fresh = { inputTokens: 30, cachedInputTokens: 5, outputTokens: 10 };
    return { total: fresh, last: fresh };
  }
  return { total: FIRST_TURN_USAGE, last: FIRST_TURN_USAGE };
}

function tokenBreakdown(usage) {
  return {
    totalTokens: usage.inputTokens + usage.outputTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: 0,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: 10,
  };
}

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
  const usage = usageReport();
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: currentThreadId,
      turnId: currentTurnId,
      tokenUsage: {
        total: tokenBreakdown(usage.total),
        last: tokenBreakdown(usage.last),
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

  if (msg.method === "account/read") {
    const authProbe = readFlag("--auth-probe") ?? "signed-in";
    if (authProbe === "requires-auth") {
      send({
        id: msg.id,
        result: { account: null, requiresOpenaiAuth: true, userId: null },
      });
      return;
    }
    if (authProbe === "unsupported") {
      send({ id: msg.id, error: { code: -32601, message: "Unknown method: account/read" } });
      return;
    }
    send({
      id: msg.id,
      result: {
        account: { type: "chatgpt", email: "user@example.com" },
        requiresOpenaiAuth: true,
        userId: "user-1",
      },
    });
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
    isResumeTurn = true;
    currentThreadId =
      scenario === "resume-new-thread"
        ? "thr_forked_1"
        : (msg.params?.threadId ?? "thr_resumed_fallback");
    if (scenario === "usage-during-resume") {
      // The app-server reports the loaded thread's running total while resuming,
      // before the client has sent turn/start.
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: currentThreadId,
          tokenUsage: { total: tokenBreakdown(FIRST_TURN_USAGE) },
        },
      });
    }
    if (scenario === "oversized-resume-response") {
      // One line past the client's 16 MiB cap, so the response is dropped.
      send({
        id: msg.id,
        result: { thread: { id: currentThreadId }, padding: "x".repeat(17 * 1024 * 1024) },
      });
      return;
    }
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

    if (scenario === "spawn-grandchild") {
      // Spawn and record the pid before the reasoning notification that tests
      // use as their abort trigger.
      spawnGrandchild();
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

    if (scenario === "spawn-grandchild") {
      // Hang: stay alive (holding the grandchild) until the client stops us.
      return;
    }

    if (scenario === "pending-requests") {
      // Leave several approvals of both kinds plus an unsupported request
      // unanswered, so a teardown that stops early visibly loses declines.
      for (let i = 0; i < PENDING_APPROVALS; i += 1) {
        const isCommand = i % 2 === 0;
        send({
          id: 500 + i,
          method: isCommand
            ? "item/commandExecution/requestApproval"
            : "item/fileChange/requestApproval",
          params: { threadId: currentThreadId, turnId: currentTurnId, itemId: `item_${i}` },
        });
      }
      send({
        id: 500 + PENDING_APPROVALS,
        method: "item/tool/call",
        params: { threadId: currentThreadId, turnId: currentTurnId },
      });
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
