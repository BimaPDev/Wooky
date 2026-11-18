import { describe, expect, it, vi } from "vitest";
import {
  PATH_CAPTURE_END,
  PATH_CAPTURE_START,
  buildFishPathCaptureScript,
  buildPosixPathCaptureScript,
  extractPathFromCapture,
  hydrateLoginShellPath,
  mergeLoginShellPath,
  type ExecFileAsync,
} from "./shell-env.ts";

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
});

describe("mergeLoginShellPath", () => {
  it("prepends shell entries, dedupes, and records added dirs", () => {
    const { path, added } = mergeLoginShellPath(
      "/nvm/bin:/brew/bin:/nvm/bin",
      "/usr/bin:/brew/bin",
    );
    expect(path).toBe("/nvm/bin:/brew/bin:/usr/bin");
    expect(added).toEqual(["/nvm/bin"]);
  });
});

describe("hydrateLoginShellPath", () => {
  it("uses zsh -ilc with the posix capture script", async () => {
    const exec = vi.fn<ExecFileAsync>(async () => ({
      stdout: [PATH_CAPTURE_START, "/shell/bin", PATH_CAPTURE_END].join("\n"),
      stderr: "",
    }));
    const env = { PATH: "/usr/bin" };

    await hydrateLoginShellPath({
      platform: "linux",
      env,
      execFile: exec,
    });

    expect(exec).toHaveBeenCalledWith(
      "/bin/bash",
      ["-ilc", buildPosixPathCaptureScript()],
      expect.objectContaining({ killSignal: "SIGKILL", timeout: 5_000 }),
    );
    expect(env.PATH).toBe("/shell/bin:/usr/bin");
  });

  it("uses fish -l -c with fish syntax", async () => {
    const exec = vi.fn<ExecFileAsync>(async () => ({
      stdout: [PATH_CAPTURE_START, "/fish/bin", PATH_CAPTURE_END].join("\n"),
      stderr: "",
    }));
    const env = { PATH: "/usr/bin", SHELL: "/opt/homebrew/bin/fish" };

    await hydrateLoginShellPath({
      platform: "darwin",
      env,
      execFile: exec,
    });

    expect(exec).toHaveBeenCalledWith(
      "/opt/homebrew/bin/fish",
      ["-l", "-c", buildFishPathCaptureScript()],
      expect.anything(),
    );
    expect(env.PATH).toBe("/fish/bin:/usr/bin");
  });

  it("sets HOME from userInfo only when missing", async () => {
    const exec = vi.fn<ExecFileAsync>(async () => ({
      stdout: [PATH_CAPTURE_START, "/bin", PATH_CAPTURE_END].join("\n"),
      stderr: "",
    }));
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

    await hydrateLoginShellPath({ platform: "linux", env, execFile: exec });
    expect(env.HOME).toBeTruthy();

    const envWithHome: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/custom" };
    await hydrateLoginShellPath({ platform: "linux", env: envWithHome, execFile: exec });
    expect(envWithHome.HOME).toBe("/custom");
  });

  it("retries after a timeout then succeeds", async () => {
    const timeoutErr = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const exec = vi
      .fn<ExecFileAsync>()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce({
        stdout: [PATH_CAPTURE_START, "/retry/bin", PATH_CAPTURE_END].join("\n"),
        stderr: "",
      });
    const env = { PATH: "/usr/bin", SHELL: "/bin/zsh" };

    const result = await hydrateLoginShellPath({ platform: "darwin", env, execFile: exec });

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1]?.[2]?.timeout).toBe(20_000);
    expect(result).toEqual({ source: "shell", added: ["/retry/bin"] });
    expect(env.PATH).toBe("/retry/bin:/usr/bin");
  });

  it("keeps env when both attempts time out", async () => {
    const timeoutErr = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const exec = vi.fn<ExecFileAsync>().mockRejectedValue(timeoutErr);
    const env = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    const log = vi.fn<(line: string) => void>();

    const result = await hydrateLoginShellPath({
      platform: "darwin",
      env,
      execFile: exec,
      log,
    });

    expect(exec).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ source: "failed", added: [] });
    expect(env.PATH).toBe("/usr/bin");
    expect(log).toHaveBeenCalledOnce();
  });

  it("skips on win32", async () => {
    const exec = vi.fn<ExecFileAsync>();
    const env = { PATH: "/usr/bin" };
    const result = await hydrateLoginShellPath({ platform: "win32", env, execFile: exec });
    expect(result).toEqual({ source: "skipped", added: [] });
    expect(exec).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("skips when AGE_SKIP_SHELL_ENV is set", async () => {
    const exec = vi.fn<ExecFileAsync>();
    const env = { PATH: "/usr/bin", AGE_SKIP_SHELL_ENV: "1" };
    const result = await hydrateLoginShellPath({ platform: "darwin", env, execFile: exec });
    expect(result).toEqual({ source: "skipped", added: [] });
    expect(exec).not.toHaveBeenCalled();
  });
});
