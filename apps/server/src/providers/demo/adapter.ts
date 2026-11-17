import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderEvent, TimelineItem } from "@age/contracts";
import type { ProviderAdapter, TurnInput } from "../types.ts";

const DEMO_FILE = "AGE_DEMO.md";

/** Scripted, deterministic and free. Used by tests and UI work. */
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
      };
    },
    runTurn: (input) => runDemoTurn(input, stepMs),
  };
}

async function* runDemoTurn(input: TurnInput, stepMs: number): AsyncGenerator<ProviderEvent> {
  const { signal, turnId } = input;
  const interrupted: ProviderEvent = { type: "done", status: "interrupted", error: null };
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

  yield {
    type: "item",
    item: { kind: "reasoning", id: `${turnId}-reasoning`, text: "Looking around the project." },
  };
  if (await step()) return yield interrupted;

  if (input.prompt.toLowerCase().includes("fail")) {
    yield { type: "done", status: "failed", error: "The demo agent was asked to fail." };
    return;
  }

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
  for (const text of ["Done. ", "I added a line ", `to ${DEMO_FILE} `, "and ran echo ok."]) {
    if (await step()) return yield interrupted;
    yield { type: "delta", itemId: messageId, text };
  }

  yield { type: "usage", usage: { inputTokens: input.prompt.length, outputTokens: 12 } };
  yield { type: "done", status: "completed", error: null };
}
