import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import {
  PATH_CAPTURE_END,
  PATH_CAPTURE_START,
  buildFishPathCaptureScript,
  buildPosixPathCaptureScript,
  captureLoginShellPath,
  extractPathFromCapture,
  hydrateLoginShellPath,
  mergeLoginShellPath,
  type KillProcess,
  type SpawnShell,
} from "./shell-env.ts";

function fakeShellChild(pid = 42) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdout,
    stderr,
  }) as unknown as ChildProcess;
  return { child, stdout, stderr };
}

describe("extractPathFromCapture", () => {
  it("parses PATH between markers with rc noise", () => {
    const output = [
      "Loading nvm...",
      PATH_CAPTURE_START,
      "/nvm/bin:/brew/bin",
      PATH_CAPTURE_END,
      "done",
    ].join("\n");
    expect(extractPathFromCapture(output)).toBe("/nvm/bin:/brew/bin");
  });

  it("ignores a marker substring on an earlier line", () => {
    const output = [
      `loading ${PATH_CAPTURE_START}`,
      PATH_CAPTURE_START,
      "/only/this",
      PATH_CAPTURE_END,
    ].join("\n");
    expect(extractPathFromCapture(output)).toBe("/only/this");
  });

  it("parses after an ANSI loading line", () => {
    const output = [
      "\u001B[1mLoading\u001B[0m plugins",
      PATH_CAPTURE_START,
      "/brew/bin",
      PATH_CAPTURE_END,
    ].join("\n");
    expect(extractPathFromCapture(output)).toBe("/brew/bin");
  });

  it("strips ANSI around the path line", () => {
    const output = [PATH_CAPTURE_START, "\u001B[32m/shell/bin\u001B[0m", PATH_CAPTURE_END].join(
      "\n",
    );
    expect(extractPathFromCapture(output)).toBe("/shell/bin");
  });

  it("uses the last complete start/end pair", () => {
    const output = [
      PATH_CAPTURE_START,
      "/first",
      PATH_CAPTURE_END,
      "retrying",
      PATH_CAPTURE_START,
      "/last",
      PATH_CAPTURE_END,
    ].join("\n");
    expect(extractPathFromCapture(output)).toBe("/last");
  });

  it("parses the marker pair after 300 KiB of rc noise", () => {
    const noise = "x".repeat(300 * 1024);
    const output = [noise, PATH_CAPTURE_START, "/tail/bin", PATH_CAPTURE_END].join("\n");
    expect(extractPathFromCapture(output)).toBe("/tail/bin");
  });

  it("parses the marker pair after 100 KiB of rc noise", () => {
    const noise = "n".repeat(100 * 1024);
    const output = [noise, PATH_CAPTURE_START, "/ok", PATH_CAPTURE_END].join("\n");
    expect(extractPathFromCapture(output)).toBe("/ok");
  });
});

describe("mergeLoginShellPath", () => {
  it("prepends shell entries, dedupes, and records added dirs", () => {
    const { path, added } = mergeLoginShellPath(
      "/nvm/bin:/brew/bin:/nvm/bin",
      "/usr/bin:/brew/bin",
      "/home/test",
    );
    expect(path).toBe("/nvm/bin:/brew/bin:/usr/bin");
    expect(added).toEqual(["/nvm/bin"]);
  });

  it("drops non-absolute PATH entries after tilde expansion", () => {
    const home = "/home/user";
    const { path, added } = mergeLoginShellPath("/usr/bin:.:~/bin::rel/dir", "/bin", home);
    expect(path).toBe("/usr/bin:/home/user/bin:/bin");
    expect(added).toEqual(["/usr/bin", "/home/user/bin"]);
  });
});

describe("captureLoginShellPath", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out with code null and signal SIGKILL", async () => {
    const { child } = fakeShellChild(77);
    const spawnShell = vi.fn<SpawnShell>(() => child);
    const killProcess = vi.fn<KillProcess>();

    const promise = captureLoginShellPath(
      "/bin/zsh",
      { PATH: "/usr/bin", HOME: "/h" },
      {
        spawnShell,
        killProcess,
      },
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(killProcess).toHaveBeenCalledWith(-77, "SIGKILL");
    child.emit("close", null, "SIGKILL");

    await expect(promise).rejects.toMatchObject({ code: null, signal: "SIGKILL" });
  });

  it("accepts stdout when the shell exits non-zero", async () => {
    const { child, stdout } = fakeShellChild(88);
    const spawnShell = vi.fn<SpawnShell>(() => child);
    const killProcess = vi.fn<KillProcess>();

    const promise = captureLoginShellPath(
      "/bin/zsh",
      { PATH: "/usr/bin", HOME: "/h" },
      {
        spawnShell,
        killProcess,
      },
    );

    stdout.write([PATH_CAPTURE_START, "/ok/bin", PATH_CAPTURE_END].join("\n"));
    child.emit("close", 1, null);

    await expect(promise).resolves.toBe("/ok/bin");
    expect(killProcess).toHaveBeenCalledWith(-88, "SIGKILL");
  });

  it("settles on a complete marker pair before close and kills the process group", async () => {
    const { child, stdout } = fakeShellChild(66);
    const spawnShell = vi.fn<SpawnShell>(() => child);
    const killProcess = vi.fn<KillProcess>();

    const promise = captureLoginShellPath(
      "/bin/zsh",
      { PATH: "/usr/bin", HOME: "/h" },
      {
        spawnShell,
        killProcess,
      },
    );

    stdout.write("sleep 25 &\n");
    stdout.write([PATH_CAPTURE_START, "/fast/bin", PATH_CAPTURE_END].join("\n"));

    await expect(promise).resolves.toBe("/fast/bin");
    expect(killProcess).toHaveBeenCalledWith(-66, "SIGKILL");
  });

  it("parses PATH when marker pair follows more than 256 KiB of stdout noise", async () => {
    const { child, stdout } = fakeShellChild(31);
    const spawnShell = vi.fn<SpawnShell>(() => child);
    const killProcess = vi.fn<KillProcess>();
    const noise = "z".repeat(300 * 1024);

    const promise = captureLoginShellPath(
      "/bin/zsh",
      { PATH: "/usr/bin", HOME: "/h" },
      { spawnShell, killProcess },
    );

    stdout.write(`${noise}\n`);
    stdout.write([PATH_CAPTURE_START, "/after/noise", PATH_CAPTURE_END].join("\n"));
    child.emit("close", 0, null);

    await expect(promise).resolves.toBe("/after/noise");
  });
});

describe("hydrateLoginShellPath", () => {
  function mockSpawn(stdoutText: string, pid = 42) {
    const { child, stdout } = fakeShellChild(pid);
    const spawnShell = vi.fn<SpawnShell>((_file, _args, options) => {
      expect(options.detached).toBe(true);
      expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
      queueMicrotask(() => {
        stdout.write(stdoutText);
        child.emit("close", 0, null);
      });
      return child;
    });
    return { spawnShell, child };
  }

  it("uses bash -ilc on linux when SHELL is unset", async () => {
    const text = [PATH_CAPTURE_START, "/shell/bin", PATH_CAPTURE_END].join("\n");
    const { spawnShell } = mockSpawn(text);
    const env = { PATH: "/usr/bin", HOME: "/home/x" };

    await hydrateLoginShellPath({
      platform: "linux",
      env,
      spawnShell,
    });

    expect(spawnShell).toHaveBeenCalledWith(
      "/bin/bash",
      ["-ilc", buildPosixPathCaptureScript()],
      expect.objectContaining({ detached: true, stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(env.PATH).toBe("/shell/bin:/usr/bin");
  });

  it("uses zsh -ilc on darwin when SHELL is unset", async () => {
    const text = [PATH_CAPTURE_START, "/shell/bin", PATH_CAPTURE_END].join("\n");
    const { spawnShell } = mockSpawn(text);
    const env = { PATH: "/usr/bin", HOME: "/home/x" };

    await hydrateLoginShellPath({
      platform: "darwin",
      env,
      spawnShell,
    });

    expect(spawnShell).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", buildPosixPathCaptureScript()],
      expect.anything(),
    );
  });

  it("uses fish -l -c with fish syntax", async () => {
    const text = [PATH_CAPTURE_START, "/fish/bin", PATH_CAPTURE_END].join("\n");
    const { spawnShell } = mockSpawn(text);
    const env = { PATH: "/usr/bin", HOME: "/home/x", SHELL: "/opt/homebrew/bin/fish" };

    await hydrateLoginShellPath({
      platform: "darwin",
      env,
      spawnShell,
    });

    expect(spawnShell).toHaveBeenCalledWith(
      "/opt/homebrew/bin/fish",
      ["-l", "-c", buildFishPathCaptureScript()],
      expect.anything(),
    );
    expect(env.PATH).toBe("/fish/bin:/usr/bin");
  });

  it("sets HOME from userInfo only when missing", async () => {
    const text = [PATH_CAPTURE_START, "/bin", PATH_CAPTURE_END].join("\n");
    const { spawnShell } = mockSpawn(text);
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

    await hydrateLoginShellPath({ platform: "linux", env, spawnShell });
    expect(env.HOME).toBeTruthy();

    const envWithHome: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/custom" };
    const { spawnShell: spawn2 } = mockSpawn(text);
    await hydrateLoginShellPath({ platform: "linux", env: envWithHome, spawnShell: spawn2 });
    expect(envWithHome.HOME).toBe("/custom");
  });

  it("returns failed when kill throws EPERM on timeout", async () => {
    vi.useFakeTimers();
    const { child } = fakeShellChild(44);
    const spawnShell = vi.fn<SpawnShell>(() => child);
    const eperm = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    const killProcess = vi.fn<KillProcess>(() => {
      throw eperm;
    });
    const env = { PATH: "/usr/bin", HOME: "/h", SHELL: "/bin/zsh" };

    const promise = hydrateLoginShellPath({
      platform: "darwin",
      env,
      spawnShell,
      killProcess,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result).toEqual({ source: "failed", added: [] });
    expect(env.PATH).toBe("/usr/bin");
    vi.useRealTimers();
  });

  it("makes only one capture attempt", async () => {
    vi.useFakeTimers();
    const { child } = fakeShellChild();
    const spawnShell = vi.fn<SpawnShell>(() => child);
    const killProcess = vi.fn<KillProcess>();
    const env = { PATH: "/usr/bin", HOME: "/h", SHELL: "/bin/zsh" };

    const promise = hydrateLoginShellPath({
      platform: "darwin",
      env,
      spawnShell,
      killProcess,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    child.emit("close", null, "SIGKILL");
    const result = await promise;

    expect(spawnShell).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ source: "failed", added: [] });
    expect(env.PATH).toBe("/usr/bin");
    vi.useRealTimers();
  });

  it("kills the spawned process group on timeout", async () => {
    vi.useFakeTimers();
    const { child } = fakeShellChild(901);
    const spawnShell = vi.fn<SpawnShell>(() => child);
    const killProcess = vi.fn<KillProcess>();
    const env = { PATH: "/usr/bin", HOME: "/h", SHELL: "/bin/zsh" };

    const promise = hydrateLoginShellPath({
      platform: "darwin",
      env,
      spawnShell,
      killProcess,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(killProcess).toHaveBeenCalledWith(-901, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await promise;
    vi.useRealTimers();
  });

  it("registers stdin ignore and detached spawn", async () => {
    const text = [PATH_CAPTURE_START, "/bin", PATH_CAPTURE_END].join("\n");
    const { spawnShell } = mockSpawn(text);
    await hydrateLoginShellPath({
      platform: "linux",
      env: { PATH: "/usr/bin", HOME: "/h" },
      spawnShell,
    });
    expect(spawnShell.mock.calls[0]?.[2]?.stdio[0]).toBe("ignore");
  });

  it("cleanup on SIGTERM during hydration kills the shell group", async () => {
    const { child, stdout } = fakeShellChild(55);
    let registeredKill: (() => void) | undefined;
    const killProcess = vi.fn<KillProcess>();
    const spawnShell = vi.fn<SpawnShell>(() => {
      queueMicrotask(() => stdout.write("stall\n"));
      return child;
    });

    const onActiveShell = vi.fn<(kill: (() => void) | undefined) => void>((kill) => {
      registeredKill = kill;
    });

    const promise = hydrateLoginShellPath({
      platform: "darwin",
      env: { PATH: "/usr/bin", HOME: "/h", SHELL: "/bin/zsh" },
      spawnShell,
      killProcess,
      onActiveShell,
    });

    await vi.waitFor(() => expect(registeredKill).toBeTypeOf("function"));
    if (!registeredKill) throw new Error("expected active shell kill");
    registeredKill();
    expect(killProcess).toHaveBeenCalledWith(-55, "SIGKILL");

    stdout.write([PATH_CAPTURE_START, "/x", PATH_CAPTURE_END].join("\n"));
    child.emit("close", 0, null);
    await promise;
    expect(onActiveShell).toHaveBeenLastCalledWith(undefined);
  });

  it("skips on win32", async () => {
    const spawnShell = vi.fn<SpawnShell>();
    const env = { PATH: "/usr/bin" };
    const result = await hydrateLoginShellPath({ platform: "win32", env, spawnShell });
    expect(result).toEqual({ source: "skipped", added: [] });
    expect(spawnShell).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("skips when WOOKY_SKIP_SHELL_ENV is set", async () => {
    const spawnShell = vi.fn<SpawnShell>();
    const env = { PATH: "/usr/bin", WOOKY_SKIP_SHELL_ENV: "1" };
    const result = await hydrateLoginShellPath({ platform: "darwin", env, spawnShell });
    expect(result).toEqual({ source: "skipped", added: [] });
    expect(spawnShell).not.toHaveBeenCalled();
  });
});
