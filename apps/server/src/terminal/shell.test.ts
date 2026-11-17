import { describe, expect, it } from "vitest";
import { resolveShellCommand } from "./shell.ts";

describe("resolveShellCommand", () => {
  it("picks a Windows shell without shell:true", () => {
    const shell = resolveShellCommand("win32");
    expect(shell.file.toLowerCase()).toMatch(/powershell\.exe|pwsh\.exe|cmd\.exe$/);
    expect(shell.args).not.toContain("-Command");
  });

  it("picks a unix login shell", () => {
    const shell = resolveShellCommand("linux");
    expect(shell.file).toMatch(/sh|bash|zsh/);
  });
});
