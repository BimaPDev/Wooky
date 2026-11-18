import { describe, expect, it } from "vitest";
import { resolveShellCommand } from "./shell.ts";

const existsIn = (...paths: string[]) => {
  const set = new Set(paths);
  return (path: string) => set.has(path);
};

describe("resolveShellCommand", () => {
  it("finds pwsh on a later PATH entry, split on ';' and joined the win32 way", () => {
    const shell = resolveShellCommand(
      "win32",
      { PATH: "C:\\tools;D:\\bin" },
      existsIn("D:\\bin\\pwsh.exe"),
    );
    expect(shell).toEqual({
      file: "D:\\bin\\pwsh.exe",
      args: ["-NoLogo"],
      label: "pwsh",
      lineEnding: "\r\n",
    });
  });

  it("falls back to Windows PowerShell when pwsh is absent", () => {
    const dir = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0";
    const shell = resolveShellCommand("win32", { PATH: dir }, existsIn(`${dir}\\powershell.exe`));
    expect(shell).toEqual({
      file: `${dir}\\powershell.exe`,
      args: ["-NoLogo"],
      label: "powershell",
      lineEnding: "\r\n",
    });
  });

  it("falls back to cmd.exe when no PowerShell is on PATH", () => {
    const shell = resolveShellCommand("win32", { PATH: "C:\\tools;D:\\bin" }, existsIn());
    expect(shell).toEqual({ file: "cmd.exe", args: [], label: "cmd", lineEnding: "\r\n" });
  });

  it("uses $SHELL as a login shell on unix", () => {
    const shell = resolveShellCommand("linux", { SHELL: "/usr/bin/fish" }, existsIn());
    expect(shell).toEqual({ file: "/usr/bin/fish", args: ["-l"], label: "fish", lineEnding: "\n" });
  });

  it("picks the first existing candidate on unix when $SHELL is unset", () => {
    const shell = resolveShellCommand("linux", {}, existsIn("/bin/bash", "/bin/sh"));
    expect(shell).toEqual({ file: "/bin/bash", args: ["-l"], label: "bash", lineEnding: "\n" });
  });
});

describe("shell line ending", () => {
  it("uses CRLF when Windows resolves to cmd.exe", () => {
    const shell = resolveShellCommand("win32", { PATH: "C:\\tools" }, existsIn());
    expect(shell).toMatchObject({ file: "cmd.exe", label: "cmd", lineEnding: "\r\n" });
  });

  it("uses CRLF when Windows resolves to PowerShell", () => {
    const pwsh = resolveShellCommand(
      "win32",
      { PATH: "C:\\tools;D:\\bin" },
      existsIn("D:\\bin\\pwsh.exe"),
    );
    expect(pwsh).toMatchObject({ label: "pwsh", lineEnding: "\r\n" });

    const dir = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0";
    const powershell = resolveShellCommand(
      "win32",
      { PATH: dir },
      existsIn(`${dir}\\powershell.exe`),
    );
    expect(powershell).toMatchObject({ label: "powershell", lineEnding: "\r\n" });
  });

  it("uses LF for a posix shell", () => {
    const shell = resolveShellCommand("linux", { SHELL: "/bin/zsh" }, existsIn());
    expect(shell).toMatchObject({ file: "/bin/zsh", label: "zsh", lineEnding: "\n" });
  });
});
