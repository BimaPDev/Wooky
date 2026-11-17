import type { ApprovalRequest, ProviderEvent, UserInputRequest } from "@age/contracts";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnInput } from "../types.ts";
import { createClaudeAdapter } from "./adapter.ts";
import { setPlanUserHomeForTests } from "./interaction.ts";
import {
  assistant,
  init,
  resultSuccess,
  text,
  toolResult,
  toolUse,
  type SDKMessage,
} from "./fixtures.ts";

type Params = Parameters<typeof query>[0];
type Script = (params: Params) => AsyncGenerator<SDKMessage, void>;

function fakeQuery(script: Script) {
  const calls: Params[] = [];
  const close = vi.fn<() => void>();
  const fake = ((params: Params) => {
    calls.push(params);
    return Object.assign(script(params), { close });
  }) as unknown as typeof query;
  return { fake, calls, close };
}

function turnInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    threadId: "th1",
    turnId: "t1",
    cwd: "/work",
    prompt: "do it",
    model: "default",
    runtimeMode: "approve",
    resumeSessionId: null,
    resumeAt: null,
    interactionMode: "default",
    requestUserInput: async () => null,
    handoffContext: null,
    signal: new AbortController().signal,
    requestApproval: async () => "allow",
    ...overrides,
  };
}

async function collect(
  iterable: AsyncIterable<ProviderEvent>,
  onEvent?: (event: ProviderEvent) => void,
) {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

function expectOneDoneLast(events: ProviderEvent[]) {
  expect(events.filter((event) => event.type === "done")).toHaveLength(1);
  expect(events.at(-1)?.type).toBe("done");
}

const simple: Script = async function* () {
  yield init();
  yield assistant("m1", [text("hi")]);
  yield resultSuccess();
};

describe("runTurn options", () => {
  it("passes cwd, resume, partial streaming and omits the default model", async () => {
    const { fake, calls, close } = fakeQuery(simple);
    const adapter = createClaudeAdapter({ query: fake });
    const events = await collect(adapter.runTurn(turnInput({ resumeSessionId: "sess-9" })));
    const options = calls[0]?.options as Options;
    expect(options).toMatchObject({
      cwd: "/work",
      resume: "sess-9",
      includePartialMessages: true,
    });
    expect(options).not.toHaveProperty("model");
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed", error: null });
    expect(close).toHaveBeenCalled();
  });

  it("passes an explicit model and the configured binary", async () => {
    const { fake, calls } = fakeQuery(simple);
    const adapter = createClaudeAdapter({ query: fake, claudeBin: "/opt/claude" });
    await collect(adapter.runTurn(turnInput({ model: "opus" })));
    expect(calls[0]?.options).toMatchObject({
      model: "opus",
      pathToClaudeCodeExecutable: "/opt/claude",
    });
  });

  it("prefixes the handoff context into the prompt", async () => {
    const { fake, calls } = fakeQuery(simple);
    const adapter = createClaudeAdapter({ query: fake });
    await collect(adapter.runTurn(turnInput({ handoffContext: "User: hi\n\nAssistant: hello" })));
    const prompt = calls[0]?.prompt as string;
    expect(prompt.startsWith("Earlier conversation in this thread, from another agent:")).toBe(
      true,
    );
    expect(prompt).toContain("User: hi\n\nAssistant: hello");
    expect(prompt.endsWith("do it")).toBe(true);
  });

  it("sends the bare prompt when there is no handoff", async () => {
    const { fake, calls } = fakeQuery(simple);
    await collect(createClaudeAdapter({ query: fake }).runTurn(turnInput()));
    expect(calls[0]?.prompt).toBe("do it");
  });
});

describe("permission modes", () => {
  it("full bypasses permissions and never asks", async () => {
    const requestApproval = vi.fn<TurnInput["requestApproval"]>(async () => "allow");
    const { fake, calls } = fakeQuery(simple);
    await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({ runtimeMode: "full", requestApproval }),
      ),
    );
    const options = calls[0]?.options as Options;
    expect(options).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("auto-edits accepts edits itself and still asks for a command", async () => {
    const requestApproval = vi.fn<TurnInput["requestApproval"]>(async () => "allow");
    const results: unknown[] = [];
    const { fake, calls } = fakeQuery(async function* (params) {
      yield init();
      const context = { signal: new AbortController().signal, requestId: "r" };
      // acceptEdits makes the SDK approve edits itself, so only other tools reach the callback.
      const asked: [string, Record<string, unknown>][] = [
        ["Bash", { command: "pnpm test" }],
        ["Edit", { file_path: "/work/a.ts", old_string: "a", new_string: "b" }],
      ].filter(([tool]) => params.options?.permissionMode !== "acceptEdits" || tool !== "Edit") as [
        string,
        Record<string, unknown>,
      ][];
      for (const [tool, toolInput] of asked) {
        results.push(
          await params.options?.canUseTool?.(tool, toolInput, { ...context, toolUseID: tool }),
        );
      }
      yield resultSuccess();
    });
    await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({ runtimeMode: "auto-edits", requestApproval }),
      ),
    );
    expect(calls[0]?.options).toMatchObject({ permissionMode: "acceptEdits" });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]?.[0]).toMatchObject({
      tool: "command",
      detail: "pnpm test",
    });
    expect(results).toEqual([{ behavior: "allow", updatedInput: { command: "pnpm test" } }]);
  });

  async function askPermission(
    decision: "allow" | "deny",
    tool: string,
    toolInput: Record<string, unknown>,
  ) {
    const requests: ApprovalRequest[] = [];
    let result: unknown;
    const { fake, calls } = fakeQuery(async function* (params) {
      yield init();
      result = await params.options?.canUseTool?.(tool, toolInput, {
        signal: new AbortController().signal,
        toolUseID: "tu1",
        requestId: "r1",
      });
      yield resultSuccess();
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({
          requestApproval: async (request) => {
            requests.push(request);
            return decision;
          },
        }),
      ),
    );
    return { requests, result, events, options: calls[0]?.options as Options };
  }

  it("approve mode uses default permissions and round-trips an allow", async () => {
    const input = { file_path: "/work/src/a.ts", old_string: "one", new_string: "two" };
    const { requests, result, options, events } = await askPermission("allow", "Edit", input);
    expect(options.permissionMode).toBe("default");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: "t1:tu1",
      tool: "edit",
      title: "Edit src/a.ts",
      detail: "src/a.ts",
    });
    expect(requests[0]?.diff).toBe("--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-one\n+two");
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
    expectOneDoneLast(events);
  });

  it("maps a deny to a short message for the agent", async () => {
    const { requests, result } = await askPermission("deny", "Bash", { command: "rm -rf build" });
    expect(requests[0]).toMatchObject({
      tool: "command",
      title: "rm -rf build",
      detail: "rm -rf build",
    });
    expect(requests[0]?.diff).toBeUndefined();
    expect(result).toEqual({ behavior: "deny", message: "The user declined this action." });
  });

  it("builds a diff for Write and MultiEdit and caps it at 8 KB", async () => {
    const write = await askPermission("allow", "Write", {
      file_path: "/work/n.ts",
      content: "a\nb",
    });
    expect(write.requests[0]?.diff).toBe("--- a/n.ts\n+++ b/n.ts\n@@\n+a\n+b");

    const multi = await askPermission("allow", "MultiEdit", {
      file_path: "/work/m.ts",
      edits: [
        { old_string: "x", new_string: "y" },
        { old_string: "p", new_string: "q" },
      ],
    });
    expect(multi.requests[0]?.diff).toBe("--- a/m.ts\n+++ b/m.ts\n@@\n-x\n+y\n@@\n-p\n+q");

    const big = await askPermission("allow", "Write", {
      file_path: "/work/big.txt",
      content: "line\n".repeat(5000),
    });
    const diff = big.requests[0]?.diff ?? "";
    expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(8192);
    expect(diff.endsWith("… diff truncated")).toBe(true);
  });

  it("fails closed when the approval request cannot be built", async () => {
    const requestApproval = vi.fn<TurnInput["requestApproval"]>(async () => "allow");
    let result: unknown;
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      result = await params.options?.canUseTool?.(
        "Mystery",
        { size: 10n },
        { signal: new AbortController().signal, toolUseID: "tu1", requestId: "r1" },
      );
      yield resultSuccess();
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(turnInput({ requestApproval })),
    );
    expect(result).toEqual({ behavior: "deny", message: "The user declined this action." });
    expect(requestApproval).not.toHaveBeenCalled();
    expectOneDoneLast(events);
  });

  it("treats a failing approval as declined", async () => {
    let result: unknown;
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      result = await params.options?.canUseTool?.(
        "Bash",
        { command: "ls" },
        {
          signal: new AbortController().signal,
          toolUseID: "tu1",
          requestId: "r1",
        },
      );
      yield resultSuccess();
    });
    await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({
          requestApproval: async () => {
            throw new Error("no ui");
          },
        }),
      ),
    );
    expect(result).toMatchObject({ behavior: "deny" });
  });
});

describe("abort and failure", () => {
  it("abort mid-stream yields done interrupted, once and last", async () => {
    const controller = new AbortController();
    const { fake, close } = fakeQuery(async function* (params) {
      yield init();
      await new Promise<void>((resolve) =>
        params.options?.abortController?.signal.addEventListener("abort", () => resolve()),
      );
      throw new Error("aborted by sdk");
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(turnInput({ signal: controller.signal })),
      (event) => {
        if (event.type === "session") controller.abort();
      },
    );
    expect(events.at(-1)).toEqual({ type: "done", status: "interrupted", error: null });
    expectOneDoneLast(events);
    expect(close).toHaveBeenCalled();
  });

  it("abort still ends the turn when the SDK never responds", async () => {
    const controller = new AbortController();
    const { fake, close } = fakeQuery(async function* () {
      yield init();
      await new Promise<never>(() => undefined);
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(turnInput({ signal: controller.signal })),
      (event) => {
        if (event.type === "session") controller.abort();
      },
    );
    expect(events.at(-1)).toEqual({ type: "done", status: "interrupted", error: null });
    expectOneDoneLast(events);
    expect(close).toHaveBeenCalled();
  });

  it("an already aborted signal interrupts without waiting", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fake, calls } = fakeQuery(async function* () {
      await new Promise<never>(() => undefined);
      yield init();
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(turnInput({ signal: controller.signal })),
    );
    expect(events).toEqual([{ type: "done", status: "interrupted", error: null }]);
    expect(calls).toHaveLength(0);
  });

  it("removes every abort listener it added once the turn is over", async () => {
    const signal = new AbortController().signal;
    const live = new Set<unknown>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<AbortSignal["addEventListener"]>) => {
      live.add(args[1]);
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => {
      live.delete(args[1]);
      remove(...args);
    };
    const { fake } = fakeQuery(simple);
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(turnInput({ signal })),
    );
    expect(events.at(-1)).toMatchObject({ status: "completed" });
    expect(live.size).toBe(0);
  });

  it("an iterator that throws yields done failed", async () => {
    const { fake } = fakeQuery(async function* () {
      yield init();
      yield assistant("m1", [text("partial")]);
      throw new Error("process exited with code 1");
    });
    const events = await collect(createClaudeAdapter({ query: fake }).runTurn(turnInput()));
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "failed",
      error: "process exited with code 1",
      nativeRef: expect.any(String),
    });
    expectOneDoneLast(events);
  });

  it("query throwing synchronously yields done failed", async () => {
    const fake = (() => {
      throw new Error("cannot start");
    }) as unknown as typeof query;
    const events = await collect(createClaudeAdapter({ query: fake }).runTurn(turnInput()));
    expect(events).toEqual([{ type: "done", status: "failed", error: "cannot start" }]);
  });

  it("a stream that ends without a result fails", async () => {
    const { fake } = fakeQuery(async function* () {
      yield init();
    });
    const events = await collect(createClaudeAdapter({ query: fake }).runTurn(turnInput()));
    expect(events.at(-1)).toMatchObject({ type: "done", status: "failed" });
    expectOneDoneLast(events);
  });

  it("a stream that ends without a result reports the last stderr line", async () => {
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      params.options?.stderr?.("starting\nError: credit balance too low\n\n");
    });
    const events = await collect(createClaudeAdapter({ query: fake }).runTurn(turnInput()));
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "failed",
      error: "Error: credit balance too low",
    });
  });
});

describe("probe", () => {
  it("reports a missing binary in one sentence", async () => {
    const status = await createClaudeAdapter({
      claudeBin: "/nonexistent/age-test/claude",
    }).probe();
    expect(status).toMatchObject({
      kind: "claude",
      installed: false,
      authenticated: null,
      version: null,
    });
    expect(status.problem).toMatch(/not found/i);
    expect(status.models.map((model) => model.id)).toContain("default");
  });

  it("still reports installed when --version exits non-zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "age-claude-probe-"));
    const bin = join(dir, "claude");
    await writeFile(bin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const status = await createClaudeAdapter({ claudeBin: bin }).probe();
    expect(status).toMatchObject({ installed: true, version: null });
    expect(status.problem).toMatch(/installed/i);
    expect(status.problem).not.toMatch(/not found/i);
  });

  it("reads the version from a working executable", async () => {
    const status = await createClaudeAdapter({ claudeBin: process.execPath }).probe();
    expect(status.installed).toBe(true);
    expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(status.problem).toBeNull();
  });
});

const context = (signal = new AbortController().signal) => ({
  signal,
  toolUseID: "tu1",
  requestId: "r1",
});

describe("nativeRef", () => {
  it("is the last top-level chain entry uuid when a tool result follows", async () => {
    const assistantMsg = assistant("m1", [toolUse("tu1", "Read", { file_path: "a" })]);
    const userMsg = toolResult("tu1", "ok");
    const { fake } = fakeQuery(async function* () {
      yield init();
      yield assistantMsg;
      yield userMsg;
      yield resultSuccess();
    });
    const events = await collect(createClaudeAdapter({ query: fake }).runTurn(turnInput()));
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      error: null,
      nativeRef: userMsg.uuid,
    });
  });

  it("is the last top-level assistant message uuid of the turn", async () => {
    const first = assistant("m1", [text("one")]);
    const last = assistant("m2", [text("two")]);
    const sub = assistant("m3", [text("sub")], { parent: "tu9" });
    const { fake } = fakeQuery(async function* () {
      yield init();
      yield first;
      yield last;
      yield sub;
      yield resultSuccess();
    });
    const events = await collect(createClaudeAdapter({ query: fake }).runTurn(turnInput()));
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      error: null,
      nativeRef: last.uuid,
    });
  });

  it("is omitted when the turn produced no assistant message", async () => {
    const { fake } = fakeQuery(async function* () {
      yield init();
      yield resultSuccess();
    });
    const events = await collect(createClaudeAdapter({ query: fake }).runTurn(turnInput()));
    expect(events.at(-1)).toEqual({ type: "done", status: "completed", error: null });
  });
});

describe("resumeAt", () => {
  it("advertises support", () => {
    expect(createClaudeAdapter({ query: fakeQuery(simple).fake }).supportsResumeAt).toBe(true);
  });

  it("resumes the session at the kept message in a fork", async () => {
    const { fake, calls } = fakeQuery(simple);
    await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({ resumeSessionId: "sess-9", resumeAt: "uuid-kept" }),
      ),
    );
    expect(calls[0]?.options).toMatchObject({
      resume: "sess-9",
      resumeSessionAt: "uuid-kept",
      forkSession: true,
    });
  });

  it("a null resumeAt continues the session in place", async () => {
    const { fake, calls } = fakeQuery(simple);
    await collect(
      createClaudeAdapter({ query: fake }).runTurn(turnInput({ resumeSessionId: "sess-9" })),
    );
    const options = calls[0]?.options as Options;
    expect(options.resume).toBe("sess-9");
    expect(options).not.toHaveProperty("resumeSessionAt");
    expect(options).not.toHaveProperty("forkSession");
  });

  it("ignores resumeAt when there is no session to resume", async () => {
    const { fake, calls } = fakeQuery(simple);
    await collect(
      createClaudeAdapter({ query: fake }).runTurn(turnInput({ resumeAt: "uuid-kept" })),
    );
    expect(calls[0]?.options).not.toHaveProperty("resumeSessionAt");
  });
});

describe("AskUserQuestion", () => {
  const askInput = {
    questions: [
      {
        question: "Which library?",
        header: "Library",
        options: [
          { label: "date-fns", description: "Small" },
          { label: "dayjs", description: "Tiny" },
        ],
        multiSelect: false,
      },
      {
        question: "Which targets?",
        header: "Targets",
        options: [
          { label: "web", description: "Browser" },
          { label: "node", description: "Server" },
        ],
        multiSelect: true,
      },
    ],
  };

  async function ask(
    runtimeMode: TurnInput["runtimeMode"],
    answer: Awaited<ReturnType<TurnInput["requestUserInput"]>>,
    toolInput = askInput,
  ) {
    const requests: UserInputRequest[] = [];
    const requestApproval = vi.fn<TurnInput["requestApproval"]>(async () => "allow");
    let result: unknown;
    const { fake, calls } = fakeQuery(async function* (params) {
      yield init();
      result = await params.options?.canUseTool?.("AskUserQuestion", toolInput, context());
      yield resultSuccess();
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({
          runtimeMode,
          requestApproval,
          requestUserInput: async (request) => {
            requests.push(request);
            return answer;
          },
        }),
      ),
    );
    return { requests, result, events, requestApproval, options: calls[0]?.options as Options };
  }

  it("keeps single-select labels that contain comma-space unquoted in answers", async () => {
    const ambiguous = {
      questions: [
        {
          question: "Which?",
          header: "Which",
          options: [{ label: "a, b" }, { label: "only" }],
        },
      ],
    };
    const { result } = await ask("approve", { "Which?": ["a, b"] }, ambiguous as typeof askInput);
    expect(result).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Which?": "a, b" } },
    });
  });

  it("maps the tool's questions and returns the answers as updatedInput", async () => {
    const { requests, result, requestApproval } = await ask("approve", {
      "Which library?": ["dayjs"],
      "Which targets?": ["web", "node"],
    });
    expect(requests).toEqual([
      {
        requestId: "t1:tu1",
        questions: [
          {
            id: "Which library?",
            header: "Library",
            question: "Which library?",
            options: [
              { label: "date-fns", description: "Small" },
              { label: "dayjs", description: "Tiny" },
            ],
            multiSelect: false,
            allowCustom: true,
          },
          expect.objectContaining({ id: "Which targets?", multiSelect: true, allowCustom: true }),
        ],
      },
    ]);
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        ...askInput,
        answers: { "Which library?": "dayjs", "Which targets?": "web, node" },
      },
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("denies the tool when the user dismisses the question", async () => {
    const { result } = await ask("approve", null);
    expect(result).toMatchObject({ behavior: "deny" });
    expect((result as { message: string }).message).toMatch(/dismissed/i);
  });

  it("works in full mode, where every other tool is allowed without asking", async () => {
    const { result, options, requests, requestApproval } = await ask("full", {
      "Which library?": ["date-fns"],
    });
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.canUseTool).toBeTypeOf("function");
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Which library?": "date-fns" } },
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("full mode still allows other tools straight through", async () => {
    let result: unknown;
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      result = await params.options?.canUseTool?.("Bash", { command: "ls" }, context());
      yield resultSuccess();
    });
    const requestApproval = vi.fn<TurnInput["requestApproval"]>(async () => "deny");
    await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({ runtimeMode: "full", requestApproval }),
      ),
    );
    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("an abort while the question is open interrupts the turn", async () => {
    const abort = new AbortController();
    let result: unknown;
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      result = await params.options?.canUseTool?.(
        "AskUserQuestion",
        askInput,
        context(abort.signal),
      );
      yield resultSuccess();
    });
    await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({
          signal: abort.signal,
          requestUserInput: () => {
            abort.abort();
            return new Promise(() => undefined);
          },
        }),
      ),
    );
    expect(result).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("denies a malformed question instead of asking", async () => {
    let result: unknown;
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      result = await params.options?.canUseTool?.("AskUserQuestion", { questions: [] }, context());
      yield resultSuccess();
    });
    const requestUserInput = vi.fn<TurnInput["requestUserInput"]>(async () => null);
    await collect(createClaudeAdapter({ query: fake }).runTurn(turnInput({ requestUserInput })));
    expect(result).toMatchObject({ behavior: "deny" });
    expect(requestUserInput).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  setPlanUserHomeForTests(undefined);
});

describe("plan mode", () => {
  const plan = "## Plan\n\n1. Add the field\n2. Update the tests";

  async function exitPlan(toolInput: Record<string, unknown>) {
    let result: unknown;
    const { fake, calls } = fakeQuery(async function* (params) {
      yield init();
      yield assistant("m1", [toolUse("tu1", "ExitPlanMode", toolInput)]);
      result = await params.options?.canUseTool?.("ExitPlanMode", toolInput, context());
      yield resultSuccess();
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(turnInput({ interactionMode: "plan" })),
    );
    return { result, events, options: calls[0]?.options as Options };
  }

  it("runs with the SDK's plan permission mode and a permission callback", async () => {
    const { options } = await exitPlan({ plan });
    expect(options.permissionMode).toBe("plan");
    expect(options.canUseTool).toBeTypeOf("function");
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
  });

  it("turns ExitPlanMode into a plan event and ends the call calmly", async () => {
    const { result, events } = await exitPlan({ plan });
    expect(events.find((event) => event.type === "plan")).toEqual({
      type: "plan",
      itemId: "t1:tu1",
      markdown: plan,
    });
    expect(result).toEqual({
      behavior: "deny",
      message: "The user will review the plan.",
      interrupt: true,
    });
    expectOneDoneLast(events);
    expect(events.at(-1)).toMatchObject({ status: "completed" });
  });

  it("reads the plan from a tracked plan file when ExitPlanMode has no plan arg", async () => {
    const dir = await mkdtemp(join(tmpdir(), "age-plan-"));
    const planPath = join(dir, ".claude", "plans", "task.md");
    const filePlan = "## From file\n\nStep one";
    await mkdir(join(dir, ".claude", "plans"), { recursive: true });
    await writeFile(planPath, filePlan);

    let result: unknown;
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      yield assistant("m1", [toolUse("tw", "Write", { file_path: planPath, content: filePlan })]);
      yield assistant("m2", [toolUse("tu1", "ExitPlanMode", {})]);
      result = await params.options?.canUseTool?.("ExitPlanMode", {}, context());
      yield resultSuccess();
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({ interactionMode: "plan", cwd: dir }),
      ),
    );
    expect(events.find((event) => event.type === "plan")).toEqual({
      type: "plan",
      itemId: "t1:tu1",
      markdown: filePlan,
    });
    expect(result).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("reads a plan file from the default ~/.claude/plans location", async () => {
    const dir = await mkdtemp(join(tmpdir(), "age-plan-home-"));
    const fakeHome = await mkdtemp(join(tmpdir(), "age-fake-home-"));
    setPlanUserHomeForTests(fakeHome);
    const planPath = join(fakeHome, ".claude", "plans", "task.md");
    const filePlan = "## Home plan";
    await mkdir(join(fakeHome, ".claude", "plans"), { recursive: true });
    await writeFile(planPath, filePlan);

    let result: unknown;
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      yield assistant("m1", [toolUse("tw", "Write", { file_path: planPath, content: filePlan })]);
      yield assistant("m2", [toolUse("tu1", "ExitPlanMode", {})]);
      result = await params.options?.canUseTool?.("ExitPlanMode", {}, context());
      yield resultSuccess();
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({ interactionMode: "plan", cwd: dir }),
      ),
    );
    expect(events.find((event) => event.type === "plan")).toMatchObject({ markdown: filePlan });
    expect(result).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("reads a plan from a custom plansDirectory setting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "age-plan-settings-"));
    const customDir = join(dir, "my-plans");
    await mkdir(join(dir, ".claude"), { recursive: true });
    await mkdir(customDir, { recursive: true });
    await writeFile(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ plansDirectory: "my-plans" }),
    );
    const planPath = join(customDir, "task.md");
    const filePlan = "## Custom dir";
    await writeFile(planPath, filePlan);

    let result: unknown;
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      yield assistant("m1", [toolUse("tw", "Write", { file_path: planPath, content: filePlan })]);
      yield assistant("m2", [toolUse("tu1", "ExitPlanMode", {})]);
      result = await params.options?.canUseTool?.("ExitPlanMode", {}, context());
      yield resultSuccess();
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({ interactionMode: "plan", cwd: dir }),
      ),
    );
    expect(events.find((event) => event.type === "plan")).toMatchObject({ markdown: filePlan });
    expect(result).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("denies with a specific message when the plan file is outside allowed roots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "age-plan-deny-outside-"));
    const outside = join(dir, "rogue.md");
    await writeFile(outside, "## rogue");

    let result: unknown;
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      yield assistant("m1", [toolUse("tw", "Write", { file_path: outside, content: "## rogue" })]);
      yield assistant("m2", [toolUse("tu1", "ExitPlanMode", {})]);
      result = await params.options?.canUseTool?.("ExitPlanMode", {}, context());
      yield resultSuccess();
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({ interactionMode: "plan", cwd: dir }),
      ),
    );
    expect(events.some((event) => event.type === "plan")).toBe(false);
    expect((result as { message: string }).message).toMatch(/outside an allowed plans directory/i);
  });

  it("denies with a specific message when the plan file is too large", async () => {
    const dir = await mkdtemp(join(tmpdir(), "age-plan-deny-large-"));
    const planPath = join(dir, ".claude", "plans", "big.md");
    await mkdir(join(dir, ".claude", "plans"), { recursive: true });
    await writeFile(planPath, "x".repeat((1 << 20) + 1));

    let result: unknown;
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      yield assistant("m1", [toolUse("tw", "Write", { file_path: planPath, content: "big" })]);
      yield assistant("m2", [toolUse("tu1", "ExitPlanMode", {})]);
      result = await params.options?.canUseTool?.("ExitPlanMode", {}, context());
      yield resultSuccess();
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({ interactionMode: "plan", cwd: dir }),
      ),
    );
    expect(events.some((event) => event.type === "plan")).toBe(false);
    expect((result as { message: string }).message).toMatch(/too large/i);
  });

  it("emits no plan event when the plan text is missing", async () => {
    const { result, events } = await exitPlan({});
    expect(events.some((event) => event.type === "plan")).toBe(false);
    expect(result).toMatchObject({ behavior: "deny" });
    expect((result as { message: string }).message).toMatch(/plan file/i);
    expect((result as { message: string }).message).not.toMatch(/plan content as a parameter/i);
  });

  it("still completes when ExitPlanMode interrupts the turn", async () => {
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      yield assistant("m1", [toolUse("tu1", "ExitPlanMode", { plan: "## Plan\n\nok" })]);
      await params.options?.canUseTool?.("ExitPlanMode", { plan: "## Plan\n\nok" }, context());
      yield resultSuccess({ terminal_reason: "aborted_tools" });
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(turnInput({ interactionMode: "plan" })),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
  });

  it("flushes a side-channel plan event before done", async () => {
    const sideChannelPlan = "## Side\n\nchannel";
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      yield assistant("m1", [toolUse("tu1", "ExitPlanMode", { plan: sideChannelPlan })]);
      await params.options?.canUseTool?.("ExitPlanMode", { plan: sideChannelPlan }, context());
      yield resultSuccess();
    });
    const events = await collect(
      createClaudeAdapter({ query: fake }).runTurn(turnInput({ interactionMode: "plan" })),
    );
    const doneIndex = events.findIndex((event) => event.type === "done");
    const planIndex = events.findIndex((event) => event.type === "plan");
    expect(planIndex).toBeGreaterThan(-1);
    expect(planIndex).toBeLessThan(doneIndex);
  });

  it("plan mode in full runtime still asks before running commands", async () => {
    let result: unknown;
    const { fake } = fakeQuery(async function* (params) {
      yield init();
      result = await params.options?.canUseTool?.("Bash", { command: "rm -rf x" }, context());
      yield resultSuccess();
    });
    const requestApproval = vi.fn<TurnInput["requestApproval"]>(async () => "deny");
    await collect(
      createClaudeAdapter({ query: fake }).runTurn(
        turnInput({ interactionMode: "plan", runtimeMode: "full", requestApproval }),
      ),
    );
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ behavior: "deny" });
  });

  it("default mode keeps the runtime-mode permission mode", async () => {
    const { fake, calls } = fakeQuery(simple);
    await collect(
      createClaudeAdapter({ query: fake }).runTurn(turnInput({ runtimeMode: "auto-edits" })),
    );
    expect(calls[0]?.options?.permissionMode).toBe("acceptEdits");
  });
});

describe("capabilities", () => {
  it("reports rewind, questions, plan mode and queue, installed or not", async () => {
    const missing = await createClaudeAdapter({
      claudeBin: "/nonexistent/age-test/claude",
    }).probe();
    const present = await createClaudeAdapter({ claudeBin: process.execPath }).probe();
    for (const status of [missing, present]) {
      expect(status.capabilities).toEqual({
        rewind: true,
        questions: true,
        planMode: true,
        queue: true,
      });
    }
  });
});
