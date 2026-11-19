import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCommand } from "./resolve-command.ts";

describe("resolveCommand", () => {
  it("returns null for empty input", () => {
    expect(resolveCommand("")).toBeNull();
  });

  it("resolves an absolute executable path", () => {
    const root = join(tmpdir(), `wooky-resolve-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const exe = join(root, process.platform === "win32" ? "tool.exe" : "tool");
    writeFileSync(exe, "");
    expect(resolveCommand(exe)).toEqual({
      command: realpathSync(exe),
      prefixArgs: [],
    });
  });

  it("unwraps a Windows .cmd that points at an .exe", () => {
    if (process.platform !== "win32") return;
    const root = join(tmpdir(), `wooky-resolve-cmd-${Date.now()}`);
    mkdirSync(join(root, "bin"), { recursive: true });
    const exe = join(root, "bin", "tool.exe");
    writeFileSync(exe, "");
    const cmd = join(root, "tool.cmd");
    writeFileSync(cmd, `@ECHO off\r\n"%~dp0bin\\tool.exe" %*\r\n`);
    expect(resolveCommand(cmd)).toEqual({ command: exe, prefixArgs: [] });
  });

  it("unwraps cursor-agent style versions/node.exe layout", () => {
    if (process.platform !== "win32") return;
    const root = join(tmpdir(), `wooky-resolve-agent-${Date.now()}`);
    const ver = join(root, "versions", "2026.01.01-abc");
    mkdirSync(ver, { recursive: true });
    const node = join(ver, "node.exe");
    const index = join(ver, "index.js");
    writeFileSync(node, "");
    writeFileSync(index, "");
    const cmd = join(root, "agent.cmd");
    writeFileSync(cmd, "@echo off\r\nrem wrapper\r\n");
    expect(resolveCommand(cmd)).toEqual({ command: node, prefixArgs: [index] });
  });

  it("unwraps npm-style node + .js shims", () => {
    if (process.platform !== "win32") return;
    const root = join(tmpdir(), `wooky-resolve-npm-${Date.now()}`);
    const binDir = join(root, "node_modules", "pkg", "bin");
    mkdirSync(binDir, { recursive: true });
    const script = join(binDir, "tool.js");
    const node = join(root, "node.exe");
    writeFileSync(script, "");
    writeFileSync(node, "");
    const cmd = join(root, "tool.cmd");
    writeFileSync(
      cmd,
      `@ECHO off\r\n"%~dp0node.exe" "%~dp0node_modules\\pkg\\bin\\tool.js" %*\r\n`,
    );
    expect(resolveCommand(cmd)).toEqual({ command: node, prefixArgs: [script] });
  });
});
