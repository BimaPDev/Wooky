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
    expect(shell).toEqual({ file: "D:\\bin\\pwsh.exe", args: ["-NoLogo"], label: "pwsh" });
  });

  it("falls back to Windows PowerShell when pwsh is absent", () => {
    const dir = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0";
    const shell = resolveShellCommand("win32", { PATH: dir }, existsIn(`${dir}\\powershell.exe`));
    expect(shell).toEqual({
      file: `${dir}\\powershell.exe`,
      args: ["-NoLogo"],
      label: "powershell",
    });
  });

  it("falls back to cmd.exe when no PowerShell is on PATH", () => {
    const shell = resolveShellCommand("win32", { PATH: "C:\\tools;D:\\bin" }, existsIn());
    expect(shell).toEqual({ file: "cmd.exe", args: [], label: "cmd" });
  });

  it("uses $SHELL as a login shell on unix", () => {
    const shell = resolveShellCommand("linux", { SHELL: "/usr/bin/fish" }, existsIn());
    expect(shell).toEqual({ file: "/usr/bin/fish", args: ["-l"], label: "fish" });
  });

  it("picks the first existing candidate on unix when $SHELL is unset", () => {
    const shell = resolveShellCommand("linux", {}, existsIn("/bin/bash", "/bin/sh"));
    expect(shell).toEqual({ file: "/bin/bash", args: ["-l"], label: "bash" });
  });
});
