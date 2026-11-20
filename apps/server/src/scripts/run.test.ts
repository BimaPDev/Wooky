import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadModel } from "@wooky/contracts";
import { emptyReadModel } from "@wooky/domain";
import { ServiceError } from "../errors.ts";
import {
  createTerminalManager,
  type TerminalManager,
  type TerminalSubscriber,
} from "../terminal/session.ts";
import type { ShellCommand } from "../terminal/shell.ts";
import { cwdForScript, findLiveScriptSession, runProjectScript, scriptArgv } from "./run.ts";

const posix = process.platform !== "win32";
const at = "2026-01-01T00:00:00.000Z";

const posixShell = (): ShellCommand =>
  existsSync("/bin/bash")
    ? { file: "/bin/bash", args: ["--norc", "--noprofile"], label: "bash", lineEnding: "\n" }
    : { file: "/bin/sh", args: [], label: "sh", lineEnding: "\n" };

function collector() {
  const messages: { kind: string; data?: string; code?: number }[] = [];
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
    return messages.map((message) => message.data ?? "").join("");
  }
  function waitUntil(pred: () => boolean): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  }
  return { subscriber, messages, output, waitUntil };
}

const managers: TerminalManager[] = [];
afterEach(() => {
  for (const created of managers.splice(0)) created.closeAll();
});

function pipeManager(resolveShell: () => ShellCommand = posixShell) {
  const created = createTerminalManager({
    loadPty: async () => {
      throw new Error("forced pipe");
    },
    resolveShell,
  });
  managers.push(created);
  return created;
}

function modelWithScript(root = "/work/demo", command = "echo hi"): ReadModel {
  return {
    ...emptyReadModel(),
    projects: {
      p1: {
        id: "p1",
        name: "demo",
        root,
        createdAt: at,
        settings: {
          scripts: [{ id: "hi", name: "Hi", command, runOnWorktreeCreate: false }],
          sharedPaths: [],
          prompts: [],
        },
      },
    },
    threads: {
      t1: {
        id: "t1",
        projectId: "p1",
        title: "New thread",
        provider: "demo",
        model: "demo",
        runtimeMode: "approve",
        worktree: { path: "/work/wt", branch: "wooky/t1" },
        providerSessionId: null,
        ownerDeviceId: null,
        movedTo: null,
        movedFrom: null,
        pullRequest: null,
        queue: [],
        status: "idle",
        createdAt: at,
        updatedAt: at,
        isolate: true,
      },
    },
  };
}

describe("scriptArgv", () => {
  const zsh = { file: "/bin/zsh", args: ["-l"], label: "zsh" };
  const pwsh = { file: "C:\\Program Files\\pwsh.exe", args: ["-NoLogo"], label: "pwsh" };
  const powershell = {
    file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoLogo"],
    label: "powershell",
  };
  const cmd = { file: "cmd.exe", args: [], label: "cmd" };

  it("uses a login shell -c on POSIX", () => {
    expect(scriptArgv(zsh, "echo hi", "darwin")).toEqual({
      file: "/bin/zsh",
      args: ["-l", "-c", "echo hi"],
    });
    expect(scriptArgv(zsh, "echo hi", "linux")).toEqual({
      file: "/bin/zsh",
      args: ["-l", "-c", "echo hi"],
    });
  });

  it("uses -NoLogo -Command on Windows PowerShell", () => {
    expect(scriptArgv(pwsh, "echo hi", "win32")).toEqual({
      file: pwsh.file,
      args: ["-NoLogo", "-Command", "echo hi"],
    });
    expect(scriptArgv(powershell, "echo hi", "win32")).toEqual({
      file: powershell.file,
      args: ["-NoLogo", "-Command", "echo hi"],
    });
  });

  it("uses /d /s /c on Windows cmd", () => {
    expect(scriptArgv(cmd, "echo hi", "win32")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "echo hi"],
    });
  });
});

describe("cwdForScript", () => {
  it("uses the thread worktree when present, else the project root", () => {
    const model = modelWithScript();
    expect(cwdForScript(model, "p1", "t1")).toBe("/work/wt");
    expect(cwdForScript(model, "p1", undefined)).toBe("/work/demo");
  });

  it("rejects an unknown project", () => {
    expect(() => cwdForScript(emptyReadModel(), "p1", undefined)).toThrow(ServiceError);
  });
});

describe("runProjectScript", () => {
  it.skipIf(!posix)("runs echo hi in a PTY and shows the exit code", async () => {
    const terminals = createTerminalManager({ resolveShell: posixShell });
    managers.push(terminals);
    const { subscriber, output, waitUntil, messages } = collector();
    const cwd = process.cwd();
    const opened = await runProjectScript(
      { model: modelWithScript(cwd), terminals, subscriber, resolveShell: posixShell },
      { projectId: "p1", scriptId: "hi" },
    );
    expect(opened.title).toBe("Hi");
    expect(opened.scriptId).toBe("hi");
    await waitUntil(
      () => /\bhi\b/.test(output()) && messages.some((message) => message.kind === "exit"),
    );
    expect(output()).toMatch(/\bhi\b/);
    expect(messages.some((message) => message.kind === "exit" && message.code === 0)).toBe(true);
  });

  it.skipIf(!posix)("returns the live session unless restart is set", async () => {
    const terminals = pipeManager();
    const first = collector();
    const cwd = process.cwd();
    const model = modelWithScript(cwd, "sleep 30");
    const opened = await runProjectScript(
      { model, terminals, subscriber: first.subscriber, resolveShell: posixShell },
      { projectId: "p1", scriptId: "hi" },
    );
    const again = await runProjectScript(
      { model, terminals, subscriber: collector().subscriber, resolveShell: posixShell },
      { projectId: "p1", scriptId: "hi" },
    );
    expect(again.sessionId).toBe(opened.sessionId);
    const restarted = await runProjectScript(
      { model, terminals, subscriber: collector().subscriber, resolveShell: posixShell },
      { projectId: "p1", scriptId: "hi", restart: true },
    );
    expect(restarted.sessionId).not.toBe(opened.sessionId);
    expect(findLiveScriptSession(terminals, "p1", "hi")?.sessionId).toBe(restarted.sessionId);
  });
});
