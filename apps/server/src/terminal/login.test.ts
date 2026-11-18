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
    const result = await openSignInTerminal(provider, { platform: "linux", execFile: exec });
    expect(result).toEqual({ opened: true, command });
    expect(calls).toEqual([
      {
        file: "x-terminal-emulator",
        args: ["-e", "/bin/sh", "-lc", command],
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
