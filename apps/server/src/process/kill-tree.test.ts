import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { isTreeAlive, killTree } from "./kill-tree.ts";

function mockTaskkillChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit("exit", 0));
  return child;
}

describe("killTree", () => {
  it("passes taskkill /pid /t on win32 for SIGTERM", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const fakeSpawn = (command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      return mockTaskkillChild();
    };
    await killTree(42, "SIGTERM", { platform: "win32", spawn: fakeSpawn });
    expect(calls).toEqual([{ command: "taskkill", args: ["/pid", "42", "/t"] }]);
  });

  it("passes taskkill /pid /t /f on win32 for SIGKILL", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const fakeSpawn = (command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      return mockTaskkillChild();
    };
    await killTree(99, "SIGKILL", { platform: "win32", spawn: fakeSpawn });
    expect(calls).toEqual([{ command: "taskkill", args: ["/pid", "99", "/t", "/f"] }]);
  });

  it.skipIf(process.platform === "win32")(
    "kills a detached child and its grandchild on POSIX",
    async () => {
      const script = [
        "const { spawn } = require('node:child_process');",
        "const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });",
        "process.stdout.write(String(gc.pid));",
        "setInterval(()=>{},1e9);",
      ].join("\n");
      const child = spawn(process.execPath, ["-e", script], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = child.pid;
      if (pid === undefined) throw new Error("missing child pid");
      const [chunk] = await once(child.stdout, "data");
      const grandchildPid = Number(chunk.toString("utf8").trim());
      expect(grandchildPid).toBeGreaterThan(0);
      expect(isTreeAlive(pid)).toBe(true);
      expect(() => process.kill(grandchildPid, 0)).not.toThrow();

      await killTree(pid, "SIGKILL");
      await once(child, "exit");
      await new Promise<void>((resolve) => {
        const waitGc = () => {
          try {
            process.kill(grandchildPid, 0);
            setImmediate(waitGc);
          } catch {
            resolve();
          }
        };
        waitGc();
      });
      expect(isTreeAlive(pid)).toBe(false);
    },
    20_000,
  );
});
