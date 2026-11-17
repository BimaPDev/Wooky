import type { ApprovalRequest, ProviderEvent } from "@age/contracts";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TurnInput } from "../types.ts";
import { createClaudeAdapter } from "./adapter.ts";
import { assistant, init, resultSuccess, text, type SDKMessage } from "./fixtures.ts";

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
    expect(events.at(-1)).toEqual({ type: "done", status: "completed", error: null });
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
    expect(options.canUseTool).toBeUndefined();
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
