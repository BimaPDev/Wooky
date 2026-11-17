import { describe, expect, it } from "vitest";
import { resolveShellCommand } from "./shell.ts";

describe("resolveShellCommand", () => {
  it("picks a Windows shell, spawned directly", () => {
    const shell = resolveShellCommand("win32", { PATH: "C:\\missing;D:\\also-missing" });
    expect(shell.file.toLowerCase()).toMatch(/powershell\.exe|pwsh\.exe|cmd\.exe$/);
    expect(shell.args).not.toContain("-Command");
  });

  it("picks a unix login shell", () => {
    const shell = resolveShellCommand("linux", {});
    expect(shell.file).toMatch(/sh|bash|zsh/);
  });
});
