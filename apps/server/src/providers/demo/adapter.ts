import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderEvent, TimelineItem } from "@wooky/contracts";
import type { ProviderAdapter, RewindInput, TurnInput } from "../types.ts";

const DEMO_FILE = "WOOKY_DEMO.md";

/**
 * Scripted, deterministic and free. Used by tests and UI work.
 *
 * Trigger words in the prompt:
 * - "/ask" asks one question, then echoes the answer.
 * - "fail" (any case) ends the turn as failed.
 * Plan mode proposes a plan and does not edit files; it wins over the trigger words.
 * Every done event carries nativeRef `demo:<turnId>`. rewind() returns a session id
 * that names the kept nativeRef and how many turns were dropped.
 */
export function createDemoAdapter({ stepMs = 120 }: { stepMs?: number } = {}): ProviderAdapter {
  return {
    kind: "demo",
    async probe() {
      return {
        kind: "demo",
        label: "Demo",
        installed: true,
        authenticated: true,
        version: null,
        models: [{ id: "demo", label: "Demo" }],
        problem: null,
        capabilities: { rewind: true, questions: true, planMode: true, queue: true },
      };
    },
    async rewind(input: RewindInput) {
      const kept = input.keepNativeRef ?? "none";
      return { sessionId: `demo:${input.threadId}:kept:${kept}:drop:${input.dropTurns}` };
    },
    runTurn: (input) => runDemoTurn(input, stepMs),
  };
}

async function* runDemoTurn(input: TurnInput, stepMs: number): AsyncGenerator<ProviderEvent> {
  const { signal, turnId } = input;
  const nativeRef = `demo:${turnId}`;
  const interrupted: ProviderEvent = {
    type: "done",
    status: "interrupted",
    error: null,
    nativeRef,
  };
  const step = async () => {
    if (stepMs > 0 && !signal.aborted) await delay(stepMs, undefined, { signal }).catch(() => {});
    return signal.aborted;
  };
  const tool = (
    id: string,
    fields: Omit<Extract<TimelineItem, { kind: "tool" }>, "kind" | "id">,
  ): ProviderEvent => ({ type: "item", item: { kind: "tool", id: `${turnId}-${id}`, ...fields } });

  yield { type: "session", sessionId: input.resumeSessionId ?? `demo-${input.threadId}` };
  if (await step()) return yield interrupted;

  if (input.interactionMode === "plan") {
    yield {
      type: "plan",
      itemId: `${turnId}-plan`,
      markdown: "# Plan\n\n1. Add a line to WOOKY_DEMO.md\n",
    };
    yield {
      type: "item",
      item: {
        kind: "message",
        id: `${turnId}-answer`,
        role: "assistant",
        text: "Proposed a plan.",
      },
    };
    yield { type: "usage", usage: { inputTokens: input.prompt.length, outputTokens: 8 } };
    yield { type: "done", status: "completed", error: null, nativeRef };
    return;
  }

  if (input.prompt.toLowerCase().includes("fail")) {
    yield { type: "done", status: "failed", error: "The demo agent was asked to fail.", nativeRef };
    return;
  }

  let echo = "";
  if (input.prompt.includes("/ask")) {
    const answers = await input.requestUserInput({
      requestId: `${turnId}-ask`,
      questions: [
        {
          id: "confirm",
          question: "Continue?",
          options: [{ label: "Yes" }, { label: "No" }],
          multiSelect: false,
          allowCustom: true,
        },
      ],
    });
    if (signal.aborted) return yield interrupted;
    echo = answers
      ? ` You answered ${Object.values(answers).flat().join(", ")}.`
      : " The question was dismissed.";
  }

  yield {
    type: "item",
    item: { kind: "reasoning", id: `${turnId}-reasoning`, text: "Looking around the project." },
  };
  if (await step()) return yield interrupted;

  const read = { tool: "read", title: "Read package.json", name: "Read" } as const;
  yield tool("read", { ...read, status: "running", files: ["package.json"] });
  if (await step()) return yield interrupted;
  yield tool("read", { ...read, status: "done", files: ["package.json"], output: "{ … }" });
  if (await step()) return yield interrupted;

  const line = `- ${input.prompt.split("\n")[0]?.slice(0, 80) ?? ""}\n`;
  const edit = { tool: "edit", title: `Edit ${DEMO_FILE}`, name: "Edit" } as const;
  const editAllowed =
    input.runtimeMode !== "approve" ||
    (await input.requestApproval({
      requestId: `${turnId}-edit`,
      tool: "edit",
      title: `Edit ${DEMO_FILE}`,
      detail: "Append one line.",
      diff: `--- a/${DEMO_FILE}\n+++ b/${DEMO_FILE}\n@@ -0,0 +1 @@\n+${line}`,
    })) === "allow";
  if (signal.aborted) return yield interrupted;
  if (editAllowed) {
    yield tool("edit", { ...edit, files: [DEMO_FILE], status: "running" });
    try {
      await appendFile(join(input.cwd, DEMO_FILE), line);
      yield tool("edit", { ...edit, files: [DEMO_FILE], status: "done" });
    } catch (error) {
      yield tool("edit", { ...edit, files: [DEMO_FILE], status: "failed", output: String(error) });
    }
  } else {
    yield tool("edit", { ...edit, files: [DEMO_FILE], status: "failed", output: "Denied." });
  }
  if (await step()) return yield interrupted;

  const command = { tool: "command", title: "echo ok", name: "Bash" } as const;
  const commandAllowed =
    input.runtimeMode === "full" ||
    (await input.requestApproval({
      requestId: `${turnId}-command`,
      tool: "command",
      title: "echo ok",
      detail: "Run a shell command.",
    })) === "allow";
  if (signal.aborted) return yield interrupted;
  yield tool("command", {
    ...command,
    status: commandAllowed ? "done" : "failed",
    output: commandAllowed ? "ok" : "Denied.",
  });
  if (await step()) return yield interrupted;

  const messageId = `${turnId}-answer`;
  yield { type: "item", item: { kind: "message", id: messageId, role: "assistant", text: "" } };
  for (const text of ["Done. ", "I added a line ", `to ${DEMO_FILE} `, `and ran echo ok.${echo}`]) {
    if (await step()) return yield interrupted;
    yield { type: "delta", itemId: messageId, text };
  }

  yield { type: "usage", usage: { inputTokens: input.prompt.length, outputTokens: 12 } };
  yield { type: "done", status: "completed", error: null, nativeRef };
}
