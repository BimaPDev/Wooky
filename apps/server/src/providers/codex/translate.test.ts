import { describe, expect, it } from "vitest";
import { ProviderEvent } from "@age/contracts";
import { createCodexTranslator } from "./translate.ts";

describe("createCodexTranslator", () => {
  it("maps thread/started to a single deduplicated session event", () => {
    const t = createCodexTranslator();
    const first = t.translateNotification("thread/started", { thread: { id: "thr_1" } });
    const dup = t.bindSession("thr_1");
    expect(first).toEqual([{ type: "session", sessionId: "thr_1" }]);
    expect(dup).toEqual([]);
    for (const ev of first) expect(() => ProviderEvent.parse(ev)).not.toThrow();
  });

  it("maps agentMessage lifecycle and deltas, ignoring userMessage items", () => {
    const t = createCodexTranslator();

    expect(
      t.translateNotification("item/started", {
        item: { type: "userMessage", id: "usr_1", content: [{ type: "text", text: "hi" }] },
      }),
    ).toEqual([]);

    const started = t.translateNotification("item/started", {
      item: { type: "agentMessage", id: "msg_1", text: "" },
    });
    const d1 = t.translateNotification("item/agentMessage/delta", {
      itemId: "msg_1",
      delta: "Hello",
    });
    const d2 = t.translateNotification("item/agentMessage/delta", {
      itemId: "msg_1",
      delta: " world",
    });
    const completed = t.translateNotification("item/completed", {
      item: { type: "agentMessage", id: "msg_1", text: "Hello world" },
    });

    expect(started).toEqual([
      { type: "item", item: { kind: "message", id: "msg_1", role: "assistant", text: "" } },
    ]);
    expect(d1).toEqual([{ type: "delta", itemId: "msg_1", text: "Hello" }]);
    expect(d2).toEqual([{ type: "delta", itemId: "msg_1", text: " world" }]);
    expect(completed).toEqual([
      {
        type: "item",
        item: { kind: "message", id: "msg_1", role: "assistant", text: "Hello world" },
      },
    ]);
  });

  it("synthesizes a message item when deltas arrive before item/started", () => {
    const t = createCodexTranslator();
    const events = t.translateNotification("item/agentMessage/delta", {
      itemId: "msg_orphan",
      delta: "streamed",
    });
    expect(events).toEqual([
      { type: "item", item: { kind: "message", id: "msg_orphan", role: "assistant", text: "" } },
      { type: "delta", itemId: "msg_orphan", text: "streamed" },
    ]);
  });

  it("maps reasoning summary parts, deltas, and completion", () => {
    const t = createCodexTranslator();
    const started = t.translateNotification("item/started", {
      item: { type: "reasoning", id: "rsn_1", summary: [], content: [] },
    });
    const part0 = t.translateNotification("item/reasoning/summaryTextDelta", {
      itemId: "rsn_1",
      delta: "First thought.",
      summaryIndex: 0,
    });
    t.translateNotification("item/reasoning/summaryPartAdded", {
      itemId: "rsn_1",
      summaryIndex: 1,
    });
    const part1 = t.translateNotification("item/reasoning/summaryTextDelta", {
      itemId: "rsn_1",
      delta: "Second thought.",
      summaryIndex: 1,
    });
    const completed = t.translateNotification("item/completed", {
      item: {
        type: "reasoning",
        id: "rsn_1",
        summary: ["First thought.", "Second thought."],
        content: [],
      },
    });

    expect(started).toEqual([{ type: "item", item: { kind: "reasoning", id: "rsn_1", text: "" } }]);
    expect(part0).toEqual([{ type: "delta", itemId: "rsn_1", text: "First thought." }]);
    expect(part1).toEqual([{ type: "delta", itemId: "rsn_1", text: "\n\nSecond thought." }]);
    expect(completed).toEqual([
      {
        type: "item",
        item: { kind: "reasoning", id: "rsn_1", text: "First thought.\n\nSecond thought." },
      },
    ]);
  });

  it("maps commandExecution with title <= 120 chars, output <= 4 KB, and failed on non-zero exit", () => {
    const t = createCodexTranslator();
    const longCommand = `pnpm --filter @age/server vitest run ${"very-long-argument-segment-".repeat(8)}`;
    const hugeOutput = `${"line-of-command-output-0123456789\n".repeat(200)}tail-marker`;

    const started = t.translateNotification("item/started", {
      item: {
        type: "commandExecution",
        id: "cmd_long",
        command: longCommand,
        status: "inProgress",
      },
    });
    expect(started).toHaveLength(1);
    const startItem = started[0];
    if (startItem?.type !== "item" || startItem.item.kind !== "tool") {
      throw new Error("Expected started commandExecution tool item");
    }
    expect(startItem.item.tool).toBe("command");
    expect(startItem.item.title.length).toBeLessThanOrEqual(120);
    expect(startItem.item.status).toBe("running");

    const completedNonZero = t.translateNotification("item/completed", {
      item: {
        type: "commandExecution",
        id: "cmd_long",
        command: longCommand,
        status: "completed",
        exitCode: 2,
        aggregatedOutput: hugeOutput,
      },
    });
    const endItem = completedNonZero[0];
    if (endItem?.type !== "item" || endItem.item.kind !== "tool") {
      throw new Error("Expected completed commandExecution tool item");
    }
    expect(endItem.item.status).toBe("failed");
    expect(endItem.item.output).toBeDefined();
    expect(Buffer.byteLength(endItem.item.output ?? "", "utf8")).toBeLessThanOrEqual(4096);
    expect(endItem.item.output).toContain("tail-marker");
  });

  it("maps fileChange to edit tool with files and exposes cached preview for approvals", () => {
    const t = createCodexTranslator();
    const started = t.translateNotification("item/started", {
      item: {
        type: "fileChange",
        id: "fc_1",
        status: "inProgress",
        changes: [
          { path: "src/a.ts", diff: "@@ -1 +1 @@\n-a\n+b" },
          { path: "src/b.ts", diff: "@@ -1 +1 @@\n-c\n+d" },
        ],
      },
    });

    expect(started).toEqual([
      {
        type: "item",
        item: {
          kind: "tool",
          id: "fc_1",
          tool: "edit",
          title: "Edit src/a.ts, src/b.ts",
          name: "fileChange",
          status: "running",
          files: ["src/a.ts", "src/b.ts"],
          output: "@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-c\n+d",
        },
      },
    ]);

    expect(t.getFileChangeForItem("fc_1")).toEqual({
      files: ["src/a.ts", "src/b.ts"],
      diff: "@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-c\n+d",
    });

    const declined = t.translateNotification("item/completed", {
      item: {
        type: "fileChange",
        id: "fc_1",
        status: "declined",
        changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      },
    });
    expect(declined[0]).toMatchObject({
      type: "item",
      item: { kind: "tool", id: "fc_1", tool: "edit", status: "failed" },
    });
  });

  it("maps mcpToolCall, webSearch, collabAgentToolCall, imageView, and unknown tools to ToolKind", () => {
    const t = createCodexTranslator();

    const mcp = t.translateNotification("item/completed", {
      item: {
        type: "mcpToolCall",
        id: "mcp_1",
        server: "docs",
        tool: "lookup",
        status: "completed",
        result: { content: [{ type: "text", text: "found it" }] },
      },
    });
    expect(mcp).toEqual([
      {
        type: "item",
        item: {
          kind: "tool",
          id: "mcp_1",
          tool: "other",
          title: "docs: lookup",
          name: "mcp:docs/lookup",
          status: "done",
          output: "found it",
        },
      },
    ]);

    const web = t.translateNotification("item/started", {
      item: { type: "webSearch", id: "ws_1", query: "codex app-server protocol" },
    });
    expect(web).toEqual([
      {
        type: "item",
        item: {
          kind: "tool",
          id: "ws_1",
          tool: "web",
          title: "Web search: codex app-server protocol",
          name: "webSearch",
          status: "running",
        },
      },
    ]);

    const collab = t.translateNotification("item/completed", {
      item: {
        type: "collabAgentToolCall",
        id: "col_1",
        tool: "spawn_agent",
        prompt: "Audit adapter",
        status: "completed",
      },
    });
    expect(collab).toEqual([
      {
        type: "item",
        item: {
          kind: "tool",
          id: "col_1",
          tool: "task",
          title: "spawn_agent: Audit adapter",
          name: "spawn_agent",
          status: "done",
        },
      },
    ]);

    const image = t.translateNotification("item/completed", {
      item: { type: "imageView", id: "img_1", path: "docs/arch.png" },
    });
    expect(image).toEqual([
      {
        type: "item",
        item: {
          kind: "tool",
          id: "img_1",
          tool: "read",
          title: "View docs/arch.png",
          name: "imageView",
          status: "done",
          files: ["docs/arch.png"],
        },
      },
    ]);

    const unknown = t.translateNotification("item/started", {
      item: { type: "fuzzyCodeSearch", id: "unk_1", status: "inProgress" },
    });
    expect(unknown).toEqual([
      {
        type: "item",
        item: {
          kind: "tool",
          id: "unk_1",
          tool: "search",
          title: "fuzzyCodeSearch",
          name: "fuzzyCodeSearch",
          status: "running",
        },
      },
    ]);
  });

  it("maps thread/tokenUsage/updated to usage events", () => {
    const t = createCodexTranslator();
    t.beginTurn();
    const events = t.translateNotification("thread/tokenUsage/updated", {
      threadId: "thr_1",
      turnId: "turn_1",
      tokenUsage: {
        total: {
          inputTokens: 1200,
          outputTokens: 340,
          cachedInputTokens: 800,
        },
      },
    });
    expect(events).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 800 },
      },
    ]);
    for (const ev of events) expect(() => ProviderEvent.parse(ev)).not.toThrow();
  });

  describe("usage baselines", () => {
    const usageNotification = (tokenUsage: Record<string, unknown>) =>
      ["thread/tokenUsage/updated", { threadId: "thr_1", tokenUsage }] as const;
    const tokens = (inputTokens: number, outputTokens: number, cachedInputTokens?: number) => ({
      inputTokens,
      outputTokens,
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    });

    it("seeds the baseline from usage seen before turn start and emits nothing for it", () => {
      const t = createCodexTranslator({ usageBaseline: null, resumed: true });
      expect(t.translateNotification(...usageNotification({ total: tokens(100, 50, 25) }))).toEqual(
        [],
      );
      t.beginTurn();
      const events = t.translateNotification(
        ...usageNotification({
          total: tokens(250, 120, 40),
          last: tokens(150, 70, 15),
        }),
      );
      expect(events).toEqual([
        { type: "usage", usage: { inputTokens: 150, outputTokens: 70, cachedInputTokens: 15 } },
      ]);
    });

    it("seeds a resumed turn with no baseline from total minus last", () => {
      const t = createCodexTranslator({ usageBaseline: null, resumed: true });
      t.beginTurn();
      const first = t.translateNotification(
        ...usageNotification({ total: tokens(1000, 400, 300), last: tokens(150, 70, 15) }),
      );
      expect(first).toEqual([
        { type: "usage", usage: { inputTokens: 150, outputTokens: 70, cachedInputTokens: 15 } },
      ]);
      const second = t.translateNotification(
        ...usageNotification({ total: tokens(1100, 450, 310), last: tokens(100, 50, 10) }),
      );
      expect(second).toEqual([
        { type: "usage", usage: { inputTokens: 250, outputTokens: 120, cachedInputTokens: 25 } },
      ]);
      expect(t.getCumulativeUsage()).toEqual(tokens(1100, 450, 310));
    });

    it("clamps total minus last at zero per field when seeding", () => {
      const t = createCodexTranslator({ usageBaseline: null, resumed: true });
      t.beginTurn();
      const events = t.translateNotification(
        ...usageNotification({ total: tokens(100, 50), last: tokens(130, 20) }),
      );
      // Seed = (0, 30); delta = (100, 20).
      expect(events).toEqual([{ type: "usage", usage: { inputTokens: 100, outputTokens: 20 } }]);
    });

    it("seeds a resumed turn from total alone when last is absent", () => {
      const t = createCodexTranslator({ usageBaseline: null, resumed: true });
      t.beginTurn();
      expect(t.translateNotification(...usageNotification({ total: tokens(900, 300) }))).toEqual([
        { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
      ]);
      expect(t.translateNotification(...usageNotification({ total: tokens(960, 330) }))).toEqual([
        { type: "usage", usage: { inputTokens: 60, outputTokens: 30 } },
      ]);
    });

    it("re-baselines to total minus last when the cumulative total drops below the baseline", () => {
      const t = createCodexTranslator({ usageBaseline: tokens(500, 200, 100), resumed: true });
      t.beginTurn();
      const events = t.translateNotification(
        ...usageNotification({ total: tokens(60, 20, 10), last: tokens(60, 20, 10) }),
      );
      expect(events).toEqual([
        { type: "usage", usage: { inputTokens: 60, outputTokens: 20, cachedInputTokens: 10 } },
      ]);
      expect(t.getCumulativeUsage()).toEqual(tokens(60, 20, 10));
    });

    it("carries usage emitted before a mid-turn counter reset into the turn's total", () => {
      const t = createCodexTranslator({ usageBaseline: tokens(900, 90), resumed: true });
      t.beginTurn();
      expect(
        t.translateNotification(
          ...usageNotification({ total: tokens(1000, 100), last: tokens(100, 10) }),
        ),
      ).toEqual([{ type: "usage", usage: { inputTokens: 100, outputTokens: 10 } }]);
      // The counter resets: 100 input was already counted, 50 more arrived after.
      expect(
        t.translateNotification(
          ...usageNotification({ total: tokens(50, 5), last: tokens(50, 5) }),
        ),
      ).toEqual([{ type: "usage", usage: { inputTokens: 150, outputTokens: 15 } }]);
      expect(
        t.translateNotification(
          ...usageNotification({ total: tokens(80, 8), last: tokens(30, 3) }),
        ),
      ).toEqual([{ type: "usage", usage: { inputTokens: 180, outputTokens: 18 } }]);
      expect(t.getCumulativeUsage()).toEqual(tokens(80, 8));
    });

    it("re-baselines to zero when the total drops and no last is present", () => {
      const t = createCodexTranslator({ usageBaseline: tokens(500, 200), resumed: true });
      t.beginTurn();
      const events = t.translateNotification(...usageNotification({ total: tokens(40, 300) }));
      expect(events).toEqual([{ type: "usage", usage: { inputTokens: 40, outputTokens: 300 } }]);
    });

    it("accumulates last-only usage across steps and carries baseline plus the sum forward", () => {
      const t = createCodexTranslator({ usageBaseline: tokens(1000, 400), resumed: true });
      t.beginTurn();
      expect(t.translateNotification(...usageNotification({ last: tokens(10, 5) }))).toEqual([
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
      ]);
      expect(t.translateNotification(...usageNotification({ last: tokens(20, 8) }))).toEqual([
        { type: "usage", usage: { inputTokens: 30, outputTokens: 13 } },
      ]);
      expect(t.getCumulativeUsage()).toEqual(tokens(1030, 413));
    });

    it("does not invent a cumulative total from last-only usage without a baseline", () => {
      const t = createCodexTranslator({ usageBaseline: null, resumed: true });
      t.beginTurn();
      t.translateNotification(...usageNotification({ last: tokens(10, 5) }));
      expect(t.getCumulativeUsage()).toBeNull();
    });

    it("lets the adapter re-baseline for a different thread id unless usage already seeded it", () => {
      const rebased = createCodexTranslator({ usageBaseline: tokens(500, 200), resumed: true });
      rebased.rebaseline(null);
      rebased.beginTurn();
      expect(
        rebased.translateNotification(
          ...usageNotification({ total: tokens(30, 10), last: tokens(30, 10) }),
        ),
      ).toEqual([{ type: "usage", usage: { inputTokens: 30, outputTokens: 10 } }]);

      const seeded = createCodexTranslator({ usageBaseline: tokens(500, 200), resumed: true });
      seeded.translateNotification(...usageNotification({ total: tokens(100, 50) }));
      seeded.rebaseline(null);
      seeded.beginTurn();
      expect(
        seeded.translateNotification(
          ...usageNotification({ total: tokens(130, 60), last: tokens(30, 10) }),
        ),
      ).toEqual([{ type: "usage", usage: { inputTokens: 30, outputTokens: 10 } }]);
    });
  });

  it("maps turn/completed failure with error details and enforces the exactly-one-done invariant", () => {
    const t = createCodexTranslator();
    t.translateNotification("error", {
      error: { message: "Upstream rate limit", additionalDetails: "retry in 30s" },
    });

    const doneEvents = t.translateNotification("turn/completed", {
      turn: {
        id: "turn_1",
        status: "failed",
        error: null,
      },
    });
    expect(doneEvents).toEqual([
      {
        type: "done",
        status: "failed",
        error: "Upstream rate limit: retry in 30s",
      },
    ]);

    expect(
      t.translateNotification("turn/completed", {
        turn: { id: "turn_1", status: "completed", error: null },
      }),
    ).toEqual([]);
    expect(
      t.translateNotification("item/agentMessage/delta", { itemId: "msg_1", delta: "late" }),
    ).toEqual([]);
    expect(t.bindSession("thr_late")).toEqual([]);
    expect(t.finish("interrupted", null)).toEqual([]);
  });
});
