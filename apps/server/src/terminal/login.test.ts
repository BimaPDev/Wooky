import { describe, expect, it } from "vitest";
import { ServiceError } from "../errors.ts";
import {
  appleScriptDoScript,
  escapeAppleScriptString,
  openSignInTerminal,
  type SignInExecFile,
} from "./login.ts";

const PROVIDERS = [
  ["claude", "claude auth login"],
  ["codex", "codex login"],
  ["cursor", "agent login"],
] as const;

function recording(): { calls: { file: string; args: readonly string[] }[]; exec: SignInExecFile } {
  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: SignInExecFile = async (file, args) => {
    calls.push({ file, args: [...args] });
  };
  return { calls, exec };
}

describe("openSignInTerminal", () => {
  it.each(PROVIDERS)("runs %s in Terminal.app on macOS", async (provider, command) => {
    const { calls, exec } = recording();
    const result = await openSignInTerminal(provider, { platform: "darwin", execFile: exec });
    expect(result).toEqual({ opened: true, command });
    expect(calls).toEqual([
      {
        file: "osascript",
        args: [
          "-e",
          `tell application "Terminal" to do script "${command}"`,
          "-e",
          'tell application "Terminal" to activate',
        ],
      },
    ]);
  });

  it.each(PROVIDERS)("runs %s via x-terminal-emulator on Linux", async (provider, command) => {
    const { calls, exec } = recording();
    const result = await openSignInTerminal(provider, {
      platform: "linux",
      execFile: exec,
      env: { SHELL: "/bin/bash" },
      exists: () => false,
    });
    expect(result).toEqual({ opened: true, command });
    expect(calls).toEqual([
      {
        file: "x-terminal-emulator",
        args: ["-e", "/bin/bash", "-ilc", command],
      },
    ]);
  });

  it.each(PROVIDERS)("runs %s via cmd start on Windows", async (provider, command) => {
    const { calls, exec } = recording();
    const result = await openSignInTerminal(provider, { platform: "win32", execFile: exec });
    expect(result).toEqual({ opened: true, command });
    expect(calls).toEqual([
      {
        file: "cmd",
        args: ["/c", "start", "", command],
      },
    ]);
  });

  it("rejects an unknown provider before launching anything", async () => {
    const { calls, exec } = recording();
    await expect(
      openSignInTerminal("demo", { platform: "darwin", execFile: exec }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: 'Unknown provider "demo".',
    });
    await expect(
      openSignInTerminal("rm -rf /", { platform: "linux", execFile: exec }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(calls).toEqual([]);
  });

  it.each([
    ["darwin", "Could not open Terminal."],
    ["win32", "Could not open a command window."],
    ["linux", "Could not open a terminal. x-terminal-emulator was not found."],
  ] as const)("maps a failed %s launch to a service error", async (platform, message) => {
    const exec: SignInExecFile = async () => {
      throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    };
    await expect(openSignInTerminal("cursor", { platform, execFile: exec })).rejects.toMatchObject({
      code: "unavailable",
      message,
    });
  });

  it("maps a non-missing Linux failure to a service error", async () => {
    const exec: SignInExecFile = async () => {
      throw new Error("terminal exited");
    };
    const error = await openSignInTerminal("codex", { platform: "linux", execFile: exec }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({
      code: "unavailable",
      message: "Could not open a terminal.",
    });
  });

  it.each([
    "36:116: execution error: Not authorized to send Apple events to Terminal. (-1743)",
    "osascript failed: -1743",
  ])("maps a macOS Automation denial (%s) to a settings hint", async (stderr) => {
    const exec: SignInExecFile = async () => {
      throw Object.assign(new Error("Command failed: osascript"), { stderr, status: 1 });
    };
    await expect(
      openSignInTerminal("cursor", { platform: "darwin", execFile: exec }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message:
        "Allow Wooky to control Terminal in System Settings → Privacy & Security → Automation, then try again.",
    });
  });

  it("maps other macOS launch failures to the first stderr line, bounded at 200 characters", async () => {
    const line = `x${"y".repeat(240)}`;
    const exec: SignInExecFile = async () => {
      throw Object.assign(new Error("Command failed: osascript"), {
        stderr: `${line}\nignored second line\n`,
        status: 1,
      });
    };
    await expect(
      openSignInTerminal("claude", { platform: "darwin", execFile: exec }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: `Could not open Terminal: ${line.slice(0, 200)}`,
    });
  });

  it.each([
    ["/bin/bash", ["-ilc"]],
    ["/usr/local/bin/zsh", ["-ilc"]],
  ] as const)("runs the fixed command in %s as a login shell", async (shell, flags) => {
    const { calls, exec } = recording();
    await openSignInTerminal("cursor", {
      platform: "linux",
      execFile: exec,
      env: { SHELL: shell },
      exists: () => false,
    });
    expect(calls).toEqual([
      { file: "x-terminal-emulator", args: ["-e", shell, ...flags, "agent login"] },
    ]);
  });

  it("runs the fixed command in fish with separate login and command flags", async () => {
    const { calls, exec } = recording();
    await openSignInTerminal("codex", {
      platform: "linux",
      execFile: exec,
      env: { SHELL: "/usr/bin/fish" },
      exists: () => false,
    });
    expect(calls).toEqual([
      {
        file: "x-terminal-emulator",
        args: ["-e", "/usr/bin/fish", "-l", "-c", "codex login"],
      },
    ]);
  });

  it("falls back to bash, then /bin/sh, when $SHELL is missing or not absolute", async () => {
    const bash = recording();
    await openSignInTerminal("claude", {
      platform: "linux",
      execFile: bash.exec,
      env: { SHELL: "bash" },
      exists: (path) => path === "/bin/bash",
    });
    expect(bash.calls).toEqual([
      {
        file: "x-terminal-emulator",
        args: ["-e", "/bin/bash", "-ilc", "claude auth login"],
      },
    ]);

    const sh = recording();
    await openSignInTerminal("claude", {
      platform: "linux",
      execFile: sh.exec,
      env: {},
      exists: () => false,
    });
    expect(sh.calls).toEqual([
      {
        file: "x-terminal-emulator",
        args: ["-e", "/bin/sh", "-ilc", "claude auth login"],
      },
    ]);
  });
});

describe("escapeAppleScriptString", () => {
  it("escapes backslashes before quotes", () => {
    expect(escapeAppleScriptString(String.raw`a"b\c`)).toBe(String.raw`a\"b\\c`);
    expect(escapeAppleScriptString("claude auth login")).toBe("claude auth login");
  });

  it("places the escaped command inside the do script literal", () => {
    expect(appleScriptDoScript(String.raw`a"b\c`)).toBe(
      String.raw`tell application "Terminal" to do script "a\"b\\c"`,
    );
  });
});
