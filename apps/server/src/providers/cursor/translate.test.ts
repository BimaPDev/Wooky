import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderEvent, TimelineItem } from "@age/contracts";
import { describe, expect, it } from "vitest";
import { CursorTranslator } from "./translate.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const REAL_TURN = "turn-real";
const REAL_CWD = "/workspace/probe";

async function lines(name: string): Promise<string[]> {
  const raw = await readFile(join(fixtureDir, name), "utf8");
  return raw.split("\n").filter((l) => l.trim());
}

async function translateFixture(
  name: string,
  turnId = "turn-test",
  cwd = "/workspace",
): Promise<ProviderEvent[]> {
  const t = new CursorTranslator(turnId, cwd);
  const events: ProviderEvent[] = [];
  for (const line of await lines(name)) {
    events.push(...t.translate(JSON.parse(line) as Record<string, unknown>));
  }
  return events;
}

function lastDone(events: ProviderEvent[]) {
  return events.filter((e) => e.type === "done").at(-1);
}

function finalItems(events: ProviderEvent[]): TimelineItem[] {
  const byId = new Map<string, TimelineItem>();
  for (const e of events) {
    if (e.type === "item") byId.set(e.item.id, e.item);
  }
  return [...byId.values()];
}

describe("CursorTranslator", () => {
  it("translates message streaming from simple-message fixture", async () => {
    const events = await translateFixture("simple-message.ndjson");
    expect(events.some((e) => e.type === "session")).toBe(true);
    expect(events.some((e) => e.type === "item" && e.item.kind === "reasoning")).toBe(true);
    expect(events.some((e) => e.type === "item" && e.item.kind === "message")).toBe(true);
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.length).toBeGreaterThan(0);
    const done = lastDone(events);
    expect(done?.status).toBe("completed");
  });

  it("translates tool lifecycle", async () => {
    const events = await translateFixture("tools.ndjson");
    const tools = events.filter((e) => e.type === "item" && e.item.kind === "tool");
    expect(tools.length).toBeGreaterThanOrEqual(4);
    const read = tools.find(
      (e) => e.type === "item" && e.item.kind === "tool" && e.item.title.startsWith("Read"),
    );
    expect(read?.type === "item" && read.item.kind === "tool" && read.item.tool).toBe("read");
    const failed = tools.find(
      (e) => e.type === "item" && e.item.kind === "tool" && e.item.status === "failed",
    );
    expect(failed).toBeDefined();
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });

  it("maps error result to failed done", async () => {
    const events = await translateFixture("error-result.ndjson");
    const done = lastDone(events);
    expect(done?.status).toBe("failed");
    expect(done?.error).toBe("Something went wrong");
  });

  it("ignores unknown event types", async () => {
    const events = await translateFixture("unknown-events.ndjson");
    expect(events.some((e) => e.type === "item" && e.item.kind === "message")).toBe(true);
    expect(lastDone(events)?.status).toBe("completed");
  });

  it("emits exactly one done event", async () => {
    for (const name of [
      "simple-message.ndjson",
      "tools.ndjson",
      "error-result.ndjson",
      "unknown-events.ndjson",
      "real-read-shell.ndjson",
    ]) {
      const cwd = name === "real-read-shell.ndjson" ? REAL_CWD : "/workspace";
      const turnId = name === "real-read-shell.ndjson" ? REAL_TURN : "turn-test";
      const t = new CursorTranslator(turnId, cwd);
      const events: ProviderEvent[] = [];
      for (const line of await lines(name)) {
        events.push(...t.translate(JSON.parse(line) as Record<string, unknown>));
      }
      const dones = events.filter((e) => e.type === "done");
      expect(dones.length, `${name} should emit exactly one done`).toBe(1);
      expect(events.at(-1)?.type).toBe("done");
    }
  });

  it("finish emits done when stream ends without result", () => {
    const t = new CursorTranslator("turn-finish", "/workspace");
    const tail = t.finish(0, null, null, false);
    expect(tail).toHaveLength(1);
    expect(tail).toEqual([{ type: "done", status: "completed", error: null }]);
  });

  it("finish does not report completed when exit code and signal are both null", () => {
    const t = new CursorTranslator("turn-null-exit", "/workspace");
    expect(t.finish(null, null, null, false)).toEqual([
      { type: "done", status: "failed", error: "Process exited unexpectedly" },
    ]);
  });

  it("finish reports failed when the process died on a signal", () => {
    const t = new CursorTranslator("turn-signal", "/workspace");
    expect(t.finish(null, "SIGKILL", null, false)).toEqual([
      { type: "done", status: "failed", error: "Process exited on signal SIGKILL" },
    ]);
  });

  it("appends non-extending stamp-less assistant chunks as deltas", () => {
    const t = new CursorTranslator("turn-segment", "/workspace");
    const events: ProviderEvent[] = [];
    events.push(
      ...t.translate({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
    );
    events.push(
      ...t.translate({
        type: "assistant",
        message: { content: [{ type: "text", text: " world" }] },
      }),
    );
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.type === "delta" && deltas[0].text).toBe(" world");
  });

  it("starts a new message segment when assistant follows reasoning", () => {
    const t = new CursorTranslator("turn-order", "/workspace");
    const events: ProviderEvent[] = [];
    events.push(
      ...t.translate({
        type: "thinking",
        subtype: "delta",
        text: "think",
      }),
    );
    events.push(
      ...t.translate({
        type: "assistant",
        message: { content: [{ type: "text", text: "answer" }] },
      }),
    );
    events.push(
      ...t.translate({
        type: "thinking",
        subtype: "delta",
        text: "more",
      }),
    );
    const itemKinds = events.filter((e) => e.type === "item").map((e) => e.item.kind);
    expect(itemKinds).toEqual(["reasoning", "message", "reasoning"]);
  });

  it("caps tool output previews at 4 KB in UTF-8 bytes on code-point boundaries", () => {
    const turn = "turn-preview";
    const t = new CursorTranslator(turn, "/workspace");
    const big = "€".repeat(2_100);
    const events = t.translate({
      type: "tool_call",
      subtype: "started",
      call_id: "preview-call",
      tool_call: { shellToolCall: { args: { command: "x" } } },
    });
    expect(events).toHaveLength(1);
    const callId = "preview-call";
    const done = t.translate({
      type: "tool_call",
      subtype: "completed",
      call_id: callId,
      tool_call: {
        shellToolCall: {
          result: {
            success: { exitCode: 0, interleavedOutput: big },
          },
        },
      },
    });
    const tool = done.find((e) => e.type === "item" && e.item.kind === "tool");
    expect(
      tool?.type === "item" && tool.item.kind === "tool" && tool.item.output?.endsWith("…"),
    ).toBe(true);
    const bytes = new TextEncoder().encode(
      tool?.type === "item" && tool.item.kind === "tool" ? (tool.item.output ?? "") : "",
    ).length;
    expect(bytes).toBeLessThanOrEqual(4 * 1024);
  });
});

describe("CursorTranslator real-read-shell.ndjson", () => {
  async function realEvents() {
    return translateFixture("real-read-shell.ndjson", REAL_TURN, REAL_CWD);
  }

  it("does not duplicate final assistant text (probe not probeprobe)", async () => {
    const events = await realEvents();
    const messages = finalItems(events).filter((i) => i.kind === "message");
    const last = messages.at(-1);
    expect(last?.kind === "message" && last.text).toBe("probe");
  });

  it("preserves timeline segment order after tool calls", async () => {
    const events = await realEvents();
    const kinds: TimelineItem["kind"][] = [];
    const seen = new Set<string>();
    for (const e of events) {
      if (e.type !== "item") continue;
      if (seen.has(e.item.id)) continue;
      seen.add(e.item.id);
      kinds.push(e.item.kind);
    }
    expect(kinds).toEqual(["reasoning", "message", "tool", "tool", "reasoning", "message"]);
  });

  it("uses interleavedOutput for shell tool preview", async () => {
    const events = await realEvents();
    const shell = finalItems(events).find((i) => i.kind === "tool" && i.title === "echo hi");
    expect(shell?.kind === "tool" && shell.output).toBe("hi\n");
    expect(shell?.kind === "tool" && shell.status).toBe("done");
    expect(shell?.kind === "tool" && shell.output?.startsWith("{")).toBe(false);
  });

  it("uses cwd-relative paths in read tool titles", async () => {
    const events = await realEvents();
    const read = finalItems(events).find((i) => i.kind === "tool" && i.tool === "read");
    expect(read?.kind === "tool" && read.title).toBe("Read package.json");
  });

  it("puts the stream's request_id on done as nativeRef", async () => {
    const events = await realEvents();
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "completed",
      nativeRef: "fddff4f7-a193-4027-bb37-086a2a80a96c",
    });
  });

  it("omits nativeRef when the result carries no request_id", async () => {
    const events = await translateFixture("turn-complete.ndjson", "turn-test", "/workspace");
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", status: "completed" });
    expect(done).not.toHaveProperty("nativeRef");
  });

  it("uses turn-scoped deterministic item ids", async () => {
    const events = await realEvents();
    const ids = finalItems(events).map((i) => i.id);
    expect(ids).toContain(`${REAL_TURN}:reason:1`);
    expect(ids).toContain(`${REAL_TURN}:msg:1`);
    expect(ids).toContain(`${REAL_TURN}:msg:2`);
    expect(ids.some((id) => id.startsWith(`${REAL_TURN}:tool:call-a12108b5`))).toBe(true);
    expect(ids.some((id) => id.includes("\n"))).toBe(false);
  });
});
