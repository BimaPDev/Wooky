import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@age/contracts";
import { createCursorAdapter, CURSOR_FAKE_AGENT_SCRIPT } from "./adapter.ts";
// @ts-expect-error test fixture is plain ESM without types
import { FAKE_CURSOR_AGENT_VERSION } from "./fixtures/fake-cursor-agent.mjs";

const fakeBin = CURSOR_FAKE_AGENT_SCRIPT;

async function collect(gen: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    cwd: process.cwd(),
    prompt: "test prompt",
    model: "auto",
    runtimeMode: "full" as const,
    resumeSessionId: null,
    handoffContext: null,
    signal: new AbortController().signal,
    requestApproval: async () => "allow" as const,
    ...overrides,
  };
}

describe("createCursorAdapter e2e", () => {
  it("completes a turn via fake binary replay", async () => {
    const adapter = createCursorAdapter({
      cursorBin: process.execPath,
      cursorArgsPrefix: [fakeBin],
    });
    const events = await collect(adapter.runTurn(baseInput()));
    const done = events.filter((e) => e.type === "done").at(-1);
    expect(done?.status).toBe("completed");
    expect(events.some((e) => e.type === "session")).toBe(true);
  });

  it("emits failed with stderr tail on crash", async () => {
    const prev = process.env.AGE_FAKE_CURSOR_MODE;
    process.env.AGE_FAKE_CURSOR_MODE = "crash";
    try {
      const adapter = createCursorAdapter({
        cursorBin: process.execPath,
        cursorArgsPrefix: [fakeBin],
      });
      const events = await collect(adapter.runTurn(baseInput()));
      const done = events.filter((e) => e.type === "done").at(-1);
      expect(done?.status).toBe("failed");
      expect(done?.error).toContain("simulated crash");
    } finally {
      if (prev === undefined) delete process.env.AGE_FAKE_CURSOR_MODE;
      else process.env.AGE_FAKE_CURSOR_MODE = prev;
    }
  });

  async function waitForFile(path: string): Promise<string> {
    for (;;) {
      try {
        return await readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        await new Promise((r) => setImmediate(r));
      }
    }
  }

  it("interrupts a hanging turn and kills the fake process", async () => {
    const work = await mkdtemp(join(tmpdir(), "age-cursor-abort-"));
    const pidFile = join(work, "pid");
    const prevMode = process.env.AGE_FAKE_CURSOR_MODE;
    const prevPid = process.env.AGE_FAKE_CURSOR_PID_FILE;
    process.env.AGE_FAKE_CURSOR_MODE = "hang";
    process.env.AGE_FAKE_CURSOR_PID_FILE = pidFile;

    const ac = new AbortController();
    const adapter = createCursorAdapter({
      cursorBin: process.execPath,
      cursorArgsPrefix: [fakeBin],
    });

    const iter = adapter.runTurn(baseInput({ signal: ac.signal }));
    const donePromise = (async () => {
      const events = await collect(iter);
      return events.filter((e) => e.type === "done").at(-1);
    })();

    await waitForFile(pidFile);
    ac.abort();

    const done = await donePromise;
    expect(done?.status).toBe("interrupted");

    try {
      const pid = Number(await readFile(pidFile, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      await rm(work, { recursive: true, force: true });
      if (prevMode === undefined) delete process.env.AGE_FAKE_CURSOR_MODE;
      else process.env.AGE_FAKE_CURSOR_MODE = prevMode;
      if (prevPid === undefined) delete process.env.AGE_FAKE_CURSOR_PID_FILE;
      else process.env.AGE_FAKE_CURSOR_PID_FILE = prevPid;
    }
  });

  it("passes --force only in full runtime mode", async () => {
    const argvFile = join(await mkdtemp(join(tmpdir(), "age-cursor-argv-")), "argv.json");
    const prev = process.env.AGE_FAKE_CURSOR_LOG_ARGV;
    process.env.AGE_FAKE_CURSOR_LOG_ARGV = argvFile;
    const adapter = createCursorAdapter({
      cursorBin: process.execPath,
      cursorArgsPrefix: [fakeBin],
    });

    await collect(adapter.runTurn(baseInput({ runtimeMode: "full" })));
    const argvFull: string[] = JSON.parse(await readFile(argvFile, "utf8"));
    expect(argvFull).toContain("--force");

    await collect(adapter.runTurn(baseInput({ runtimeMode: "approve", turnId: "turn-2" })));
    const argvApprove: string[] = JSON.parse(await readFile(argvFile, "utf8"));
    expect(argvApprove).not.toContain("--force");

    if (prev === undefined) delete process.env.AGE_FAKE_CURSOR_LOG_ARGV;
    else process.env.AGE_FAKE_CURSOR_LOG_ARGV = prev;
    await rm(dirname(argvFile), { recursive: true, force: true });
  });

  it("passes --resume when resumeSessionId is set", async () => {
    const work = await mkdtemp(join(tmpdir(), "age-cursor-resume-"));
    const argvFile = join(work, "argv.json");
    const prev = process.env.AGE_FAKE_CURSOR_LOG_ARGV;
    process.env.AGE_FAKE_CURSOR_LOG_ARGV = argvFile;

    const adapter = createCursorAdapter({
      cursorBin: process.execPath,
      cursorArgsPrefix: [fakeBin],
    });
    await collect(
      adapter.runTurn(baseInput({ resumeSessionId: "sess-prev", turnId: "turn-resume" })),
    );
    const argv: string[] = JSON.parse(await readFile(argvFile, "utf8"));
    expect(argv).toContain("--resume");
    expect(argv).toContain("sess-prev");

    if (prev === undefined) delete process.env.AGE_FAKE_CURSOR_LOG_ARGV;
    else process.env.AGE_FAKE_CURSOR_LOG_ARGV = prev;
    await rm(work, { recursive: true, force: true });
  });

  it("emits notice in approve mode", async () => {
    const adapter = createCursorAdapter({
      cursorBin: process.execPath,
      cursorArgsPrefix: [fakeBin],
    });
    const events = await collect(
      adapter.runTurn(baseInput({ runtimeMode: "approve", turnId: "turn-notice" })),
    );
    const notice = events.find((e) => e.type === "item" && e.item.kind === "notice");
    expect(notice?.type === "item" && notice.item.kind === "notice" && notice.item.text).toMatch(
      /Full access/,
    );
  });

  it("fake probe returns installed when using execPath", async () => {
    const adapter = createCursorAdapter({
      cursorBin: process.execPath,
      cursorArgsPrefix: [fakeBin],
    });
    const status = await adapter.probe();
    expect(status.installed).toBe(true);
    expect(status.version).toContain(FAKE_CURSOR_AGENT_VERSION);
    expect(status.models.length).toBeGreaterThan(0);
  });
});
