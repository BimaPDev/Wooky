import type { ProviderEvent, TimelineItem } from "@wooky/contracts";
import { ProviderEvent as ProviderEventSchema } from "@wooky/contracts";
import { describe, expect, it } from "vitest";
import {
  assistant,
  blockStart,
  init,
  messageStart,
  rateLimitEvent,
  taskNotification,
  resultError,
  resultSuccess,
  text,
  textDelta,
  thinking,
  thinkingDelta,
  toolResult,
  toolUse,
  type SDKMessage,
} from "./fixtures.ts";
import { createTranslator } from "./translate.ts";
import stringPrompt from "./recorded/resume-after-interrupt-string-prompt.json" with { type: "json" };
import stampedPrompt from "./recorded/resume-after-interrupt-stamped-prompt.json" with { type: "json" };

const CWD = "/work";

function run(
  messages: SDKMessage[],
  finish?: Parameters<ReturnType<typeof createTranslator>["finish"]>[0],
) {
  const translator = createTranslator({ turnId: "t1", cwd: CWD });
  const events = messages.flatMap((message) => translator.push(message));
  if (finish) events.push(...translator.finish(finish));
  for (const event of events) ProviderEventSchema.parse(event);
  return events;
}

function items(events: ProviderEvent[]): TimelineItem[] {
  return events.flatMap((event) => (event.type === "item" ? [event.item] : []));
}

function dones(events: ProviderEvent[]) {
  return events.filter((event) => event.type === "done");
}

function expectOneDoneLast(events: ProviderEvent[]) {
  expect(dones(events)).toHaveLength(1);
  expect(events.at(-1)?.type).toBe("done");
}

describe("session", () => {
  it("emits the session id once", () => {
    const events = run([init(), assistant("m1", [text("hi")]), resultSuccess()]);
    expect(events.filter((event) => event.type === "session")).toEqual([
      { type: "session", sessionId: "session-1" },
    ]);
  });
});

describe("streaming text and thinking", () => {
  const streamed = [
    init(),
    messageStart("m1"),
    blockStart(0, "thinking"),
    thinkingDelta(0, "Let me "),
    thinkingDelta(0, "look."),
    blockStart(1, "text"),
    textDelta(1, "Hello"),
    textDelta(1, " world"),
  ];

  it("creates an item on first delta then streams deltas", () => {
    const events = run(streamed);
    expect(events.slice(1)).toEqual([
      { type: "item", item: { kind: "reasoning", id: "t1:m1:0", text: "" } },
      { type: "delta", itemId: "t1:m1:0", text: "Let me " },
      { type: "delta", itemId: "t1:m1:0", text: "look." },
      { type: "item", item: { kind: "message", id: "t1:m1:1", role: "assistant", text: "" } },
      { type: "delta", itemId: "t1:m1:1", text: "Hello" },
      { type: "delta", itemId: "t1:m1:1", text: " world" },
    ]);
  });

  it("upserts the final text onto the streamed item without duplicating it", () => {
    const events = run([
      ...streamed,
      assistant("m1", [thinking("Let me look.")]),
      assistant("m1", [text("Hello world")]),
    ]);
    const all = items(events);
    expect(new Set(all.map((item) => item.id))).toEqual(new Set(["t1:m1:0", "t1:m1:1"]));
    expect(all.at(-1)).toEqual({
      kind: "message",
      id: "t1:m1:1",
      role: "assistant",
      text: "Hello world",
    });
  });

  it("repairs a missed delta from the final message", () => {
    const events = run([
      init(),
      messageStart("m1"),
      blockStart(0, "text"),
      textDelta(0, "Hel"),
      assistant("m1", [text("Hello")]),
    ]);
    expect(items(events).at(-1)).toMatchObject({ id: "t1:m1:0", text: "Hello" });
  });

  it("upserts the same item when no message_start was seen", () => {
    const events = run([
      init(),
      blockStart(0, "text"),
      textDelta(0, "Hel"),
      assistant("m1", [text("Hello")]),
    ]);
    const all = items(events);
    expect(new Set(all.map((item) => item.id)).size).toBe(1);
    expect(all.at(-1)).toMatchObject({ kind: "message", text: "Hello" });
  });

  it("drops a late delta after the final text closed the block", () => {
    const events = run([
      init(),
      messageStart("m1"),
      blockStart(0, "text"),
      textDelta(0, "Hel"),
      assistant("m1", [text("Hello")]),
      textDelta(0, " late"),
    ]);
    expect(events.filter((event) => event.type === "delta" && event.text === " late")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "item", item: { id: "t1:m1:0", text: "Hello" } });
  });

  it("creates items from final messages when nothing was streamed", () => {
    const events = run([init(), assistant("m2", [thinking("hmm"), text("done")])]);
    expect(items(events)).toEqual([
      { kind: "reasoning", id: "t1:m2:f0", text: "hmm" },
      { kind: "message", id: "t1:m2:f1", role: "assistant", text: "done" },
    ]);
  });

  it("keeps ids distinct across separate API messages in one turn", () => {
    const events = run([
      init(),
      messageStart("m1"),
      blockStart(0, "text"),
      textDelta(0, "a"),
      messageStart("m2"),
      blockStart(0, "text"),
      textDelta(0, "b"),
    ]);
    expect(new Set(items(events).map((item) => item.id))).toEqual(new Set(["t1:m1:0", "t1:m2:0"]));
  });
});

describe("tool lifecycle", () => {
  const cases: {
    name: string;
    input: Record<string, unknown>;
    kind: string;
    title: string;
    files?: string[];
  }[] = [
    {
      name: "Read",
      input: { file_path: "/work/src/app.ts" },
      kind: "read",
      title: "Read src/app.ts",
    },
    { name: "Glob", input: { pattern: "**/*.ts" }, kind: "search", title: "Search **/*.ts" },
    { name: "Grep", input: { pattern: "TODO" }, kind: "search", title: "Search TODO" },
    { name: "LS", input: { path: "/work/src" }, kind: "search", title: "List src" },
    {
      name: "Edit",
      input: { file_path: "/work/src/a.ts", old_string: "a", new_string: "b" },
      kind: "edit",
      title: "Edit src/a.ts",
      files: ["src/a.ts"],
    },
    {
      name: "Write",
      input: { file_path: "/work/new.ts", content: "x" },
      kind: "edit",
      title: "Write new.ts",
      files: ["new.ts"],
    },
    {
      name: "MultiEdit",
      input: { file_path: "/work/m.ts", edits: [] },
      kind: "edit",
      title: "Edit m.ts",
      files: ["m.ts"],
    },
    {
      name: "NotebookEdit",
      input: { notebook_path: "/work/n.ipynb", new_source: "x" },
      kind: "edit",
      title: "Edit n.ipynb",
      files: ["n.ipynb"],
    },
    {
      name: "Bash",
      input: { command: "pnpm test\nsecond line" },
      kind: "command",
      title: "pnpm test",
    },
    {
      name: "WebFetch",
      input: { url: "https://x.dev" },
      kind: "web",
      title: "Fetch https://x.dev",
    },
    { name: "WebSearch", input: { query: "vitest" }, kind: "web", title: "Web search: vitest" },
    { name: "Task", input: { description: "Find usages" }, kind: "task", title: "Find usages" },
    { name: "Agent", input: { description: "Review" }, kind: "task", title: "Review" },
    { name: "TodoWrite", input: { todos: [] }, kind: "other", title: "Update todo list" },
    { name: "mcp__github__create_issue", input: {}, kind: "other", title: "github: create_issue" },
  ];

  it.each(cases)("maps $name to $kind", ({ name, input, kind, title, files }) => {
    const events = run([
      init(),
      assistant("m1", [toolUse("tu1", name, input)]),
      toolResult("tu1", "output"),
    ]);
    const [running, done] = items(events);
    expect(running).toMatchObject({
      kind: "tool",
      id: "t1:tu1",
      tool: kind,
      title,
      name,
      status: "running",
      ...(files ? { files } : {}),
    });
    expect(done).toMatchObject({ id: "t1:tu1", status: "done", output: "output", title });
  });

  it("keeps paths outside the workspace unchanged", () => {
    const events = run([
      init(),
      assistant("m1", [toolUse("tu1", "Read", { file_path: "/etc/hosts" })]),
    ]);
    expect(items(events)[0]).toMatchObject({ title: "Read /etc/hosts" });
  });

  it("truncates long command titles to 120 characters", () => {
    const events = run([
      init(),
      assistant("m1", [toolUse("tu1", "Bash", { command: "x".repeat(300) })]),
    ]);
    const item = items(events)[0];
    expect(item?.kind === "tool" && item.title.length).toBe(120);
  });

  it("marks a failed tool and truncates output under 4 KB with an ellipsis", () => {
    const events = run([
      init(),
      assistant("m1", [toolUse("tu1", "Bash", { command: "boom" })]),
      toolResult("tu1", [{ type: "text", text: "é".repeat(5000) }], true),
    ]);
    const failed = items(events).at(-1);
    expect(failed).toMatchObject({ status: "failed" });
    const output = failed?.kind === "tool" ? (failed.output ?? "") : "";
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4096);
    expect(output.endsWith("…")).toBe(true);
  });

  it("ignores results for unknown tools and repeated tool_use blocks", () => {
    const events = run([
      init(),
      toolResult("ghost", "x"),
      assistant("m1", [toolUse("tu1", "Read", { file_path: "a" })]),
      assistant("m1", [toolUse("tu1", "Read", { file_path: "a" })]),
    ]);
    expect(items(events)).toHaveLength(1);
  });

  it("does not show subagent text but does show subagent tools", () => {
    const events = run([
      init(),
      assistant("s1", [text("inner"), toolUse("tu9", "Read", { file_path: "a" })], {
        parent: "tu0",
      }),
    ]);
    expect(items(events).map((item) => item.kind)).toEqual(["tool"]);
  });
});

describe("nativeRef", () => {
  it("uses the last top-level chain uuid, including a trailing tool result", () => {
    const assistantMsg = assistant("m1", [toolUse("tu1", "Bash", { command: "ls" })]);
    const userMsg = toolResult("tu1", "ok");
    const events = run([init(), assistantMsg, userMsg, resultSuccess()]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "completed",
      nativeRef: userMsg.uuid,
    });
  });
});

describe("result", () => {
  it("emits usage then a single completed done", () => {
    const events = run([init(), assistant("m1", [text("hi")]), resultSuccess()]);
    expect(events.slice(-2)).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 120, outputTokens: 45, cachedInputTokens: 30, costUsd: 0.0123 },
      },
      { type: "done", status: "completed", error: null, nativeRef: expect.any(String) },
    ]);
    expectOneDoneLast(events);
  });

  it.each([
    ["error_during_execution", ["Tool crashed"], "Tool crashed"],
    ["error_max_turns", [], "Claude Code stopped after reaching its turn limit."],
  ] as const)("fails on %s without a failover failure", (subtype, errors, message) => {
    const events = run([init(), resultError(subtype, [...errors])]);
    expect(events.at(-1)).toEqual({ type: "done", status: "failed", error: message });
    expectOneDoneLast(events);
  });

  it("fails error_max_budget_usd as quota", () => {
    const events = run([init(), resultError("error_max_budget_usd")]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "failed",
      error: "Claude Code stopped after reaching its spending limit.",
      failure: { kind: "quota" },
    });
    expectOneDoneLast(events);
  });

  it("attaches quota failure on a usage-limit result after a rejected rate_limit_event", () => {
    const events = run([
      init(),
      rateLimitEvent({
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: 100,
        resetsAt: 1_763_485_200,
      }),
      resultSuccess({ is_error: true, result: "Claude AI usage limit reached|1763485200" }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "failed",
      error: "Claude AI usage limit reached|1763485200",
      failure: { kind: "quota" },
    });
    expectOneDoneLast(events);
  });

  it("settles a still-running tool as done before a successful done", () => {
    const events = run([
      init(),
      assistant("m1", [toolUse("tu1", "Bash", { command: "ls" })]),
      resultSuccess(),
    ]);
    const settled = events.findIndex(
      (event) =>
        event.type === "item" && event.item.kind === "tool" && event.item.status === "done",
    );
    expect(settled).toBeGreaterThan(-1);
    expect(settled).toBeLessThan(events.findIndex((event) => event.type === "done"));
  });

  it("fails a success result flagged is_error and closes running tools", () => {
    const events = run([
      init(),
      assistant("m1", [toolUse("tu1", "Bash", { command: "ls" })]),
      resultSuccess({ is_error: true, result: "API Error: overloaded" }),
    ]);
    expect(items(events).at(-1)).toMatchObject({ id: "t1:tu1", status: "failed" });
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "failed",
      error: "API Error: overloaded",
      nativeRef: expect.any(String),
      failure: { kind: "overloaded", message: "API Error: overloaded" },
    });
  });

  it("explains a sign-in failure", () => {
    const events = run([
      init(),
      assistant("m1", [text("Not logged in")], { error: "authentication_failed" }),
      resultSuccess({ is_error: true, result: "Not logged in" }),
    ]);
    expect(events.at(-1)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("not signed in"),
      failure: { kind: "auth" },
    });
  });

  it("ignores messages after done", () => {
    const translator = createTranslator({ turnId: "t1" });
    translator.push(resultSuccess());
    expect(translator.push(assistant("m1", [text("late")]))).toEqual([]);
    expect(translator.finish({ kind: "aborted" })).toEqual([]);
  });
});

describe("finish", () => {
  it("abort yields done interrupted and closes running tools", () => {
    const events = run(
      [init(), assistant("m1", [toolUse("tu1", "Bash", { command: "sleep 9" })])],
      {
        kind: "aborted",
      },
    );
    expect(items(events).at(-1)).toMatchObject({ id: "t1:tu1", status: "failed" });
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "interrupted",
      error: null,
      nativeRef: expect.any(String),
    });
    expect(events.at(-1)).not.toHaveProperty("failure");
    expectOneDoneLast(events);
  });

  it("an exception yields done failed with its message", () => {
    const events = run([init()], { kind: "error", error: new Error("spawn failed") });
    expect(events.at(-1)).toEqual({ type: "done", status: "failed", error: "spawn failed" });
    expect(events.at(-1)).not.toHaveProperty("failure");
    expectOneDoneLast(events);
  });

  it("a stream that ends without a result fails", () => {
    const events = run([init()], { kind: "ended" });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "failed" });
    expectOneDoneLast(events);
  });

  it("completes when the stream ends after a plan was proposed", () => {
    const planProposed = { value: true };
    const translator = createTranslator({ turnId: "t1", planProposed });
    translator.push(init());
    const events = translator.finish({ kind: "ended" });
    expect(events.at(-1)).toEqual({ type: "done", status: "completed", error: null });
  });

  it("settles running tools as done when a plan was proposed", () => {
    const planProposed = { value: true };
    const translator = createTranslator({ turnId: "t1", planProposed });
    const events = [
      ...translator.push(init()),
      ...translator.push(assistant("m1", [toolUse("tu1", "ExitPlanMode", { plan: "## ok" })])),
      ...translator.finish({ kind: "ended" }),
    ];
    expect(items(events).at(-1)).toMatchObject({ id: "t1:tu1", status: "done" });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
  });

  it("fails an ended stream with stderr after a plan was proposed", () => {
    const planProposed = { value: true };
    const translator = createTranslator({ turnId: "t1", planProposed });
    const events = [
      ...translator.push(init()),
      ...translator.push(assistant("m1", [toolUse("tu1", "ExitPlanMode", { plan: "## ok" })])),
      ...translator.finish({ kind: "ended", stderr: "warn\nfatal: boom\n" }),
    ];
    expect(items(events).at(-1)).toMatchObject({ id: "t1:tu1", status: "done" });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "failed", error: "fatal: boom" });
  });

  it("an ended stream prefers the sign-in sentence, then the last stderr line", () => {
    const stderr = "warming up\nfatal: boom\n\n";
    const plain = run([init()], { kind: "ended", stderr });
    expect(plain.at(-1)).toEqual({ type: "done", status: "failed", error: "fatal: boom" });

    const auth = run([init(), assistant("m1", [text("x")], { error: "authentication_failed" })], {
      kind: "ended",
      stderr,
    });
    expect(auth.at(-1)).toMatchObject({ error: expect.stringContaining("not signed in") });

    const blank = run([init()], { kind: "ended", stderr: "  \n" });
    expect(blank.at(-1)).toMatchObject({ error: "Claude Code stopped before finishing the turn." });
  });

  it("finish after a result adds nothing", () => {
    const events = run([init(), resultSuccess()], { kind: "error", error: "late" });
    expectOneDoneLast(events);
    expect(events.at(-1)).toMatchObject({ status: "completed" });
  });
});

describe("resume with a stale background task", () => {
  // Recorded from the real CLI: a turn interrupted while a background Bash ran, then resumed with
  // "Reply with the single word alive." The CLI first runs a turn for the stopped task's
  // notification and emits a result for it, then runs the user's prompt.
  const PROMPT_UUID = "11111111-2222-4333-8444-555555555555";
  const replay = (messages: unknown[], promptUuid?: string) => {
    const translator = createTranslator({
      turnId: "t1",
      cwd: CWD,
      ...(promptUuid ? { promptUuid } : {}),
    });
    const events = (messages as SDKMessage[]).flatMap((message) => translator.push(message));
    for (const event of events) ProviderEventSchema.parse(event);
    return events;
  };
  const reply = (events: ProviderEvent[]) =>
    items(events)
      .flatMap((item) => (item.kind === "message" ? [item.text] : []))
      .join("");

  it("closes on the prompt's own result when the CLI does not stamp it", () => {
    const events = replay(stringPrompt);
    expectOneDoneLast(events);
    expect(dones(events)[0]).toMatchObject({ status: "completed" });
    expect(reply(events)).toBe("alive");
  });

  it("closes on the result stamped with the prompt uuid", () => {
    const events = replay(stampedPrompt, PROMPT_UUID);
    expectOneDoneLast(events);
    expect(reply(events)).toBe("alive");
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
  });

  it("drops what the notification turn said", () => {
    const events = run([
      taskNotification(),
      init(),
      assistant("stale", [text("No response requested.")]),
      resultSuccess({ result: "No response requested." }),
      init(),
      assistant("m1", [text("alive")]),
      resultSuccess({ result: "alive" }),
    ]);
    expectOneDoneLast(events);
    expect(reply(events)).toBe("alive");
  });

  it("keeps a notification that arrives during the prompt's own turn", () => {
    const events = run([
      init(),
      assistant("m1", [text("working")]),
      taskNotification(),
      resultSuccess(),
    ]);
    expectOneDoneLast(events);
    expect(reply(events)).toBe("working");
  });
});
