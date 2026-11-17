import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    resumeAt: null,
    interactionMode: "default" as const,
    requestUserInput: async () => null,
    handoffContext: null,
    signal: new AbortController().signal,
    requestApproval: async () => "allow" as const,
    ...overrides,
  };
}

const FAKE_ENV_KEYS = [
  "AGE_FAKE_CURSOR_MODE",
  "AGE_FAKE_CURSOR_PID_FILE",
  "AGE_FAKE_CURSOR_LOG_ARGV",
  "AGE_FAKE_CURSOR_FIXTURE",
  "AGE_FAKE_CURSOR_AUTH",
] as const;

describe("createCursorAdapter e2e", () => {
  afterEach(() => {
    for (const key of FAKE_ENV_KEYS) {
      delete process.env[key];
    }
  });

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

  async function waitForPositivePid(pidFile: string): Promise<number> {
    for (;;) {
      try {
        const pid = Number((await readFile(pidFile, "utf8")).trim());
        if (pid > 0) return pid;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await new Promise((r) => setImmediate(r));
    }
  }

  function processGroupAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("interrupts a hanging turn and kills the fake process group", async () => {
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

    const pid = await waitForPositivePid(pidFile);
    expect(pid).toBeGreaterThan(0);
    ac.abort();

    const done = await donePromise;
    expect(done?.status).toBe("interrupted");
    expect(processGroupAlive(pid)).toBe(false);

    try {
      await rm(work, { recursive: true, force: true });
    } finally {
      if (prevMode === undefined) delete process.env.AGE_FAKE_CURSOR_MODE;
      else process.env.AGE_FAKE_CURSOR_MODE = prevMode;
      if (prevPid === undefined) delete process.env.AGE_FAKE_CURSOR_PID_FILE;
      else process.env.AGE_FAKE_CURSOR_PID_FILE = prevPid;
    }
  });

  it("returns interrupted without spawning when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const adapter = createCursorAdapter({
      cursorBin: process.execPath,
      cursorArgsPrefix: [fakeBin],
    });
    const events = await collect(adapter.runTurn(baseInput({ signal: ac.signal })));
    expect(events.filter((e) => e.type === "done")).toEqual([
      { type: "done", status: "interrupted", error: null },
    ]);
  });

  it("emits exactly one failed done for a stdout null line", async () => {
    const prev = process.env.AGE_FAKE_CURSOR_MODE;
    process.env.AGE_FAKE_CURSOR_MODE = "null-line";
    try {
      const adapter = createCursorAdapter({
        cursorBin: process.execPath,
        cursorArgsPrefix: [fakeBin],
      });
      const events = await collect(adapter.runTurn(baseInput({ turnId: "turn-null-line" })));
      const dones = events.filter((e) => e.type === "done");
      expect(dones).toHaveLength(1);
      expect(dones[0]?.status).toBe("completed");
    } finally {
      if (prev === undefined) delete process.env.AGE_FAKE_CURSOR_MODE;
      else process.env.AGE_FAKE_CURSOR_MODE = prev;
    }
  });

  it("finishes with failed when the child dies on a signal", async () => {
    const work = await mkdtemp(join(tmpdir(), "age-cursor-signal-"));
    const pidFile = join(work, "pid");
    const prevMode = process.env.AGE_FAKE_CURSOR_MODE;
    const prevPid = process.env.AGE_FAKE_CURSOR_PID_FILE;
    process.env.AGE_FAKE_CURSOR_MODE = "hang";
    process.env.AGE_FAKE_CURSOR_PID_FILE = pidFile;

    const adapter = createCursorAdapter({
      cursorBin: process.execPath,
      cursorArgsPrefix: [fakeBin],
    });

    const doneP = collect(adapter.runTurn(baseInput({ turnId: "turn-signal-kill" }))).then((ev) =>
      ev.filter((e) => e.type === "done").at(-1),
    );

    const pid = await waitForPositivePid(pidFile);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }

    const done = await doneP;
    expect(done?.status).toBe("failed");
    expect(done?.error).toMatch(/SIGKILL/);

    await rm(work, { recursive: true, force: true });
    if (prevMode === undefined) delete process.env.AGE_FAKE_CURSOR_MODE;
    else process.env.AGE_FAKE_CURSOR_MODE = prevMode;
    if (prevPid === undefined) delete process.env.AGE_FAKE_CURSOR_PID_FILE;
    else process.env.AGE_FAKE_CURSOR_PID_FILE = prevPid;
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
