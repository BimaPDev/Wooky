import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalPush } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import {
  createTerminalManager,
  TERMINAL_DETACHED_KILL_MS,
  TERMINAL_EXITED_DROP_MS,
  type TerminalSubscriber,
} from "./session.ts";
import type { ShellCommand } from "./shell.ts";

const posix = process.platform !== "win32";

function posixShell(): ShellCommand {
  if (existsSync("/bin/bash")) {
    return { file: "/bin/bash", args: ["--norc", "--noprofile"], label: "bash", lineEnding: "\n" };
  }
  return { file: "/bin/sh", args: [], label: "sh", lineEnding: "\n" };
}

function cmdShell(): ShellCommand {
  return { file: "cmd.exe", args: ["/d", "/q"], label: "cmd", lineEnding: "\r\n" };
}

function collector() {
  const messages: TerminalPush[] = [];
  const waiters: { pred: () => boolean; resolve: () => void }[] = [];
  const subscriber: TerminalSubscriber = {
    send(message) {
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.pred()) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    bufferedAmount: () => 0,
  };
  function output() {
    return messages
      .filter((message) => message.kind === "data" || message.kind === "replay")
      .map((message) => message.data ?? "")
      .join("");
  }
  function waitUntil(pred: () => boolean): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  }
  return { subscriber, messages, output, waitUntil };
}

const managers: ReturnType<typeof createTerminalManager>[] = [];

afterEach(() => {
  for (const created of managers.splice(0)) created.closeAll();
});

function openManager(options?: Parameters<typeof createTerminalManager>[0]) {
  const created = createTerminalManager(options);
  managers.push(created);
  return created;
}

function pipeManager() {
  return openManager({
    loadPty: async () => {
      throw new Error("forced pipe");
    },
    resolveShell: posix ? posixShell : cmdShell,
  });
}

describe("terminal sessions", () => {
  it.skipIf(!posix)("opens a real PTY, writes echo hi, and sees hi in the data", async () => {
    const terminals = openManager({ resolveShell: posixShell });
    const { subscriber, output, waitUntil } = collector();
    const opened = await terminals.open({}, subscriber);
    expect(opened.pty).toBe(true);
    expect(opened.exited).toBe(false);
    terminals.write(opened.sessionId, opened.pty ? "echo hi\r" : `echo hi${opened.lineEnding}`);
    await waitUntil(() => /\bhi\b/.test(output()));
    expect(output()).toMatch(/\bhi\b/);
  });

  it.skipIf(!posix)("resize changes tput cols on POSIX", async () => {
    const terminals = openManager({ resolveShell: posixShell });
    const { subscriber, output, waitUntil } = collector();
    const opened = await terminals.open({ cols: 80, rows: 24 }, subscriber);
    expect(opened.pty).toBe(true);
    terminals.write(opened.sessionId, "echo COLS=$(tput cols)\r");
    await waitUntil(() => output().includes("COLS=80"));
    terminals.resize(opened.sessionId, 120, 24);
    terminals.write(opened.sessionId, "echo COLS=$(tput cols)\r");
    await waitUntil(() => output().includes("COLS=120"));
  });

  it.skipIf(!posix)(
    "detaching a subscriber and attaching another replays earlier output",
    async () => {
      const terminals = openManager({ resolveShell: posixShell });
      const first = collector();
      const opened = await terminals.open({}, first.subscriber);
      terminals.write(opened.sessionId, "echo replay-marker\r");
      await first.waitUntil(() => first.output().includes("replay-marker"));
      terminals.detach(opened.sessionId, first.subscriber);

      const second = collector();
      const info = terminals.attach(opened.sessionId, second.subscriber);
      expect(info.sessionId).toBe(opened.sessionId);
      expect(second.messages[0]?.kind).toBe("replay");
      expect(second.messages[0]?.data).toContain("replay-marker");
    },
  );

  it.skipIf(!posix)("close pushes exit and the process is gone", async () => {
    const terminals = openManager({ resolveShell: posixShell });
    const { subscriber, messages, output, waitUntil } = collector();
    const opened = await terminals.open({}, subscriber);
    terminals.write(opened.sessionId, "echo PID=$$\r");
    await waitUntil(() => /PID=\d+/.test(output()));
    const pid = Number(/PID=(\d+)/.exec(output())?.[1]);
    expect(pid).toBeGreaterThan(0);
    terminals.close(opened.sessionId);
    await waitUntil(() => messages.some((message) => message.kind === "exit"));
    const exit = messages.find((message) => message.kind === "exit");
    expect(exit?.kind).toBe("exit");
    expect(typeof exit?.code).toBe("number");
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it("caps the server at 16 sessions", async () => {
    const terminals = openManager({
      loadPty: async () => {
        throw new Error("forced pipe");
      },
      resolveShell: posix ? posixShell : cmdShell,
    });
    for (let i = 0; i < 16; i += 1) {
      await terminals.open({}, collector().subscriber);
    }
    await expect(terminals.open({}, collector().subscriber)).rejects.toBeInstanceOf(ServiceError);
    await expect(terminals.open({}, collector().subscriber)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("0 detached"),
    });
  });

  it("reaps exited sessions at the cap before refusing a live 16th", async () => {
    const terminals = pipeManager();
    for (let i = 0; i < 15; i += 1) {
      await terminals.open({}, collector().subscriber);
    }
    const exiting = collector();
    const last = await terminals.open({}, exiting.subscriber);
    terminals.write(last.sessionId, `exit${last.lineEnding}`);
    await exiting.waitUntil(() => exiting.messages.some((message) => message.kind === "exit"));
    expect(terminals.list()).toHaveLength(16);
    const extra = await terminals.open({}, collector().subscriber);
    expect(extra.sessionId).not.toBe(last.sessionId);
    expect(terminals.list().some((session) => session.sessionId === last.sessionId)).toBe(false);
    expect(terminals.list()).toHaveLength(16);
  });

  it("frees a slot as soon as a session starts closing", async () => {
    const terminals = pipeManager();
    const ids: string[] = [];
    for (let i = 0; i < 16; i += 1) {
      const opened = await terminals.open({}, collector().subscriber);
      ids.push(opened.sessionId);
    }
    await expect(terminals.open({}, collector().subscriber)).rejects.toBeInstanceOf(ServiceError);
    const [firstId = ""] = ids;
    terminals.close(firstId);
    const extra = await terminals.open({}, collector().subscriber);
    expect(extra.sessionId).not.toBe(firstId);
    expect(terminals.list().map((session) => session.sessionId)).not.toContain(firstId);
    expect(terminals.list()).toHaveLength(16);
  });

  it("names how many of the 16 live sessions are detached", async () => {
    const terminals = pipeManager();
    const opened: { sessionId: string; subscriber: TerminalSubscriber }[] = [];
    for (let i = 0; i < 16; i += 1) {
      const { subscriber } = collector();
      const info = await terminals.open({}, subscriber);
      opened.push({ sessionId: info.sessionId, subscriber });
    }
    for (const item of opened.slice(0, 3)) {
      terminals.detach(item.sessionId, item.subscriber);
    }
    await expect(terminals.open({}, collector().subscriber)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("3 detached"),
    });
  });

  it.skipIf(!posix)("does not leak WOOKY_AGENT_TOKEN into a spawned shell", async () => {
    const previous = process.env.WOOKY_AGENT_TOKEN;
    process.env.WOOKY_AGENT_TOKEN = "secret-token-xyz";
    try {
      const terminals = openManager({ resolveShell: posixShell });
      const { subscriber, output, waitUntil } = collector();
      const opened = await terminals.open({}, subscriber);
      terminals.write(opened.sessionId, opened.pty ? "printenv\r" : `printenv${opened.lineEnding}`);
      await waitUntil(() => /TERM=/.test(output()));
      expect(output()).not.toContain("secret-token-xyz");
      expect(output()).not.toMatch(/WOOKY_AGENT_TOKEN=/);
    } finally {
      if (previous === undefined) delete process.env.WOOKY_AGENT_TOKEN;
      else process.env.WOOKY_AGENT_TOKEN = previous;
    }
  });

  it.skipIf(!posix)("kills a pipe-mode process tree on close", async () => {
    const terminals = pipeManager();
    const { subscriber, messages, output, waitUntil } = collector();
    const opened = await terminals.open({}, subscriber);
    expect(opened.pty).toBe(false);
    terminals.write(opened.sessionId, posix ? `echo PID=$$\n` : `echo PID=%PID%\r\n`);
    await waitUntil(() => /PID=\d+/.test(output()));
    const pid = Number(/PID=(\d+)/.exec(output())?.[1]);
    expect(pid).toBeGreaterThan(0);
    terminals.close(opened.sessionId);
    await waitUntil(() => messages.some((message) => message.kind === "exit"));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it("falls back to pipe mode when the PTY loader throws", async () => {
    const terminals = openManager({
      loadPty: async () => {
        throw new Error("no native module");
      },
      resolveShell: posix ? posixShell : cmdShell,
    });
    const { subscriber, output, waitUntil } = collector();
    const opened = await terminals.open({}, subscriber);
    expect(opened.pty).toBe(false);
    terminals.write(opened.sessionId, `echo hi${opened.lineEnding}`);
    await waitUntil(() => output().includes("hi"));
  });

  it.runIf(process.platform === "win32")("echo hi through cmd.exe", async () => {
    const terminals = openManager({ resolveShell: cmdShell });
    const { subscriber, output, waitUntil } = collector();
    const opened = await terminals.open({}, subscriber);
    terminals.write(opened.sessionId, "echo hi\r\n");
    await waitUntil(() => output().includes("hi"));
    expect(output()).toContain("hi");
  });
});

describe("detached session policy", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills a running zero-subscriber session after 24h and drops it 10 minutes after exit", async () => {
    const terminals = pipeManager();
    const first = collector();
    const opened = await terminals.open({}, first.subscriber);
    terminals.detach(opened.sessionId, first.subscriber);
    expect(terminals.list()).toEqual([expect.objectContaining({ exited: false })]);
    vi.advanceTimersByTime(TERMINAL_DETACHED_KILL_MS - 1);
    expect(terminals.list()[0]?.exited).toBe(false);
    vi.advanceTimersByTime(1);
    const second = collector();
    const info = terminals.attach(opened.sessionId, second.subscriber);
    if (!info.exited) {
      await second.waitUntil(() => second.messages.some((message) => message.kind === "exit"));
    }
    expect(terminals.list()[0]?.exited).toBe(true);
    vi.advanceTimersByTime(TERMINAL_EXITED_DROP_MS - 1);
    expect(terminals.list()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(terminals.list()).toEqual([]);
    expect(() => terminals.attach(opened.sessionId, collector().subscriber)).toThrow(ServiceError);
  });

  it("clears detached and exited timers on closeAll", async () => {
    const terminals = pipeManager();
    const { subscriber } = collector();
    const opened = await terminals.open({}, subscriber);
    terminals.detach(opened.sessionId, subscriber);
    terminals.closeAll();
    expect(terminals.list()).toEqual([]);
    vi.advanceTimersByTime(TERMINAL_DETACHED_KILL_MS + TERMINAL_EXITED_DROP_MS);
    expect(terminals.list()).toEqual([]);
  });
});

describe("terminal list", () => {
  it("returns TerminalInfo for live sessions", async () => {
    const terminals = openManager({
      loadPty: async () => {
        throw new Error("forced pipe");
      },
      resolveShell: posix ? posixShell : cmdShell,
    });
    const opened = await terminals.open(
      { cwd: process.cwd(), projectId: "p1", title: "dev" },
      collector().subscriber,
    );
    expect(terminals.list()).toEqual([
      {
        sessionId: opened.sessionId,
        title: "dev",
        cwd: opened.cwd,
        shell: opened.shell,
        pty: false,
        createdAt: opened.createdAt,
        exited: false,
        projectId: "p1",
        scriptId: null,
      },
    ]);
  });
});
