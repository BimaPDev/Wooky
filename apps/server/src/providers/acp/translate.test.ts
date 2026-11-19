import { describe, expect, it } from "vitest";
import { AcpTranslator } from "./translate.ts";

function translator(notes: string[] = []) {
  return new AcpTranslator("turn-1", (message) => notes.push(message));
}

describe("ACP session updates", () => {
  it("streams message and reasoning chunks", () => {
    const updates = translator();
    const first = updates.push({
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "Hello " },
    });
    const second = updates.push({
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "world" },
    });
    const thought = updates.push({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "hmm" },
    });
    expect(first).toEqual([
      {
        type: "item",
        item: { kind: "message", id: "turn-1:m1", role: "assistant", text: "Hello " },
      },
    ]);
    expect(second).toEqual([{ type: "delta", itemId: "turn-1:m1", text: "world" }]);
    expect(thought[0]).toMatchObject({ type: "item", item: { kind: "reasoning", text: "hmm" } });
  });

  it("maps tool kinds and keeps later updates on the same item", () => {
    const updates = translator();
    const started = updates.push({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Read src/app.ts",
      kind: "read",
      status: "in_progress",
      name: "read",
      locations: [{ path: "src/app.ts" }],
    });
    const finished = updates.push({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "file body" } }],
    });
    expect(started[0]).toMatchObject({
      type: "item",
      item: {
        kind: "tool",
        id: "call_1",
        tool: "read",
        status: "running",
        files: ["src/app.ts"],
      },
    });
    expect(finished[0]).toMatchObject({
      type: "item",
      item: { id: "call_1", status: "done", output: "file body", tool: "read" },
    });

    expect(
      updates.push({
        sessionUpdate: "tool_call",
        toolCallId: "call_2",
        title: "Fetch docs",
        kind: "fetch",
        status: "completed",
      })[0],
    ).toMatchObject({ item: { tool: "web", status: "done" } });
    expect(
      updates.push({
        sessionUpdate: "tool_call",
        toolCallId: "call_3",
        title: "Search",
        kind: "search",
        status: "failed",
      })[0],
    ).toMatchObject({ item: { tool: "search", status: "failed" } });
    expect(
      updates.push({
        sessionUpdate: "tool_call",
        toolCallId: "call_4",
        title: "Delete",
        kind: "delete",
        status: "pending",
      })[0],
    ).toMatchObject({ item: { tool: "edit", status: "running" } });
  });

  it("renders a plan and reports usage", () => {
    const updates = translator();
    expect(
      updates.push({
        sessionUpdate: "plan",
        entries: [
          { content: "Write the file", priority: "high", status: "in_progress" },
          { content: "Stop", priority: "low", status: "pending" },
        ],
      }),
    ).toEqual([
      {
        type: "plan",
        itemId: "turn-1:plan",
        markdown: "- [-] Write the file (high)\n- [ ] Stop (low)",
      },
    ]);
    expect(
      updates.push({
        sessionUpdate: "usage_update",
        used: 12,
        size: 100,
        cost: { amount: 0.5, currency: "USD" },
      }),
    ).toEqual([{ type: "usage", usage: { inputTokens: 12, outputTokens: 0, costUsd: 0.5 } }]);
  });

  it("sends unknown session updates to debug", () => {
    const notes: string[] = [];
    const updates = translator(notes);
    expect(updates.push({ sessionUpdate: "future_widget" })).toEqual([]);
    expect(updates.push({ sessionUpdate: "config_option_update", configOptions: [] })).toEqual([]);
    expect(notes).toEqual(["acp: ignored session update future_widget"]);
  });

  it("keeps tool output under 4 KB", () => {
    const updates = translator();
    const event = updates.push({
      sessionUpdate: "tool_call",
      toolCallId: "call_big",
      title: "Read",
      kind: "read",
      status: "completed",
      rawOutput: "x".repeat(8_000),
    })[0];
    expect(event?.type).toBe("item");
    if (event?.type !== "item" || event.item.kind !== "tool") throw new Error("expected a tool");
    expect(Buffer.byteLength(event.item.output ?? "")).toBeLessThanOrEqual(4_096);
  });
});
