import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "../errors.ts";
import { PICK_FOLDER_TIMEOUT_MS } from "@wooky/contracts";
import { createFolderPicker, type PickerSpawn } from "./folder-picker.ts";

function fakeChild(pid = 41) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return Object.assign(new EventEmitter(), {
    pid,
    stdout,
    stderr,
    kill: () => true,
  });
}

function asProcess(child: ReturnType<typeof fakeChild>): ChildProcess {
  return child as unknown as ChildProcess;
}

function missingProcess(): ChildProcess {
  const child = fakeChild();
  queueMicrotask(() => {
    child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  });
  return asProcess(child);
}

const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "age-pick-"));
  dirs.push(dir);
  return dir;
}

describe("pickFolder", () => {
  it("parses a macOS folder, dropping the trailing slash but keeping /", async () => {
    const dir = await tempDir();
    const seen: Array<{ command: string; args: readonly string[] }> = [];
    const picker = createFolderPicker({
      platform: "darwin",
      spawn: (command, args) => {
        seen.push({ command, args });
        const child = fakeChild();
        queueMicrotask(() => {
          const stdout = seen.length === 1 ? `${dir}/\n` : "/\n";
          child.stdout.write(stdout);
          child.emit("close", 0, null);
        });
        return asProcess(child);
      },
    });

    await expect(picker.pick({})).resolves.toEqual({ path: dir, supported: true });
    expect(seen[0]).toEqual({
      command: "osascript",
      args: ["-e", 'POSIX path of (choose folder with prompt "Add project")'],
    });

    await expect(picker.pick({})).resolves.toEqual({ path: "/", supported: true });
  });

  it("keeps a quoted prompt inside the osascript argument", async () => {
    const dir = await tempDir();
    let script = "";
    const picker = createFolderPicker({
      platform: "darwin",
      spawn: (_command, args) => {
        script = args[1] ?? "";
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.write(`${dir}\n`);
          child.emit("close", 0, null);
        });
        return asProcess(child);
      },
    });

    await expect(picker.pick({}, { title: 'Say "hi"' })).resolves.toEqual({
      path: dir,
      supported: true,
    });
    expect(script).toBe('POSIX path of (choose folder with prompt "Say \\"hi\\"")');
  });

  it("treats osascript cancel (-128) as no path", async () => {
    const picker = createFolderPicker({
      platform: "darwin",
      spawn: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stderr.write("0:88: execution error: User canceled. (-128)\n");
          child.emit("close", 1, null);
        });
        return asProcess(child);
      },
    });

    await expect(picker.pick({})).resolves.toEqual({ path: null, supported: true });
  });

  it("tries zenity, then kdialog, and stops when zenity answers", async () => {
    const dir = await tempDir();
    const commands: string[] = [];
    const picker = createFolderPicker({
      platform: "linux",
      spawn: (command, args) => {
        commands.push(`${command} ${args.join(" ")}`);
        if (command === "zenity") return missingProcess();
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.write(`${dir}\n`);
          child.emit("close", 0, null);
        });
        return asProcess(child);
      },
    });

    await expect(picker.pick({}, { title: "Add project" })).resolves.toEqual({
      path: dir,
      supported: true,
    });
    expect(commands).toEqual([
      "zenity --file-selection --directory --title=Add project",
      "kdialog --title Add project --getexistingdirectory",
    ]);

    commands.length = 0;
    const cancel = createFolderPicker({
      platform: "linux",
      spawn: (command) => {
        commands.push(command);
        const child = fakeChild();
        queueMicrotask(() => child.emit("close", 1, null));
        return asProcess(child);
      },
    });
    await expect(cancel.pick({})).resolves.toEqual({ path: null, supported: true });
    expect(commands).toEqual(["zenity"]);
  });

  it("reports unsupported when neither linux dialog exists", async () => {
    let stats = 0;
    const commands: string[] = [];
    const picker = createFolderPicker({
      platform: "linux",
      stat: async () => {
        stats += 1;
        return { isDirectory: () => true };
      },
      spawn: (command) => {
        commands.push(command);
        return missingProcess();
      },
    });

    await expect(picker.pick({})).resolves.toEqual({ path: null, supported: false });
    expect(commands).toEqual(["zenity", "kdialog"]);
    expect(stats).toBe(0);
  });

  it("shares one promise per connection and conflicts for another", async () => {
    const dir = await tempDir();
    const child = fakeChild(77);
    let spawns = 0;
    const picker = createFolderPicker({
      platform: "darwin",
      spawn: () => {
        spawns += 1;
        return asProcess(child);
      },
    });
    const owner = {};
    const other = {};

    const first = picker.pick(owner);
    const second = picker.pick(owner, { title: "Other" });
    expect(second).toBe(first);
    expect(spawns).toBe(1);
    await expect(picker.pick(other)).rejects.toMatchObject({
      code: "conflict",
      message: "A folder chooser is already open.",
    });
    expect(spawns).toBe(1);

    child.stdout.write(`${dir}/\n`);
    child.emit("close", 0, null);
    await expect(first).resolves.toEqual({ path: dir, supported: true });

    const third = picker.pick(other);
    expect(third).not.toBe(first);
    child.stdout.write(`${dir}\n`);
    child.emit("close", 0, null);
    await expect(third).resolves.toEqual({ path: dir, supported: true });
    expect(spawns).toBe(2);
  });

  it("rejects a path that is not a directory", async () => {
    const dir = await tempDir();
    const file = join(dir, "notes.txt");
    await writeFile(file, "x");
    const picker = createFolderPicker({
      platform: "darwin",
      spawn: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.write(`${file}\n`);
          child.emit("close", 0, null);
        });
        return asProcess(child);
      },
    });

    await expect(picker.pick({})).rejects.toBeInstanceOf(ServiceError);
    await expect(picker.pick({})).rejects.toThrow(`${file} is not a directory.`);
  });

  it("kills the spawned pid when the chooser times out", async () => {
    vi.useFakeTimers();
    const killed: Array<[number, NodeJS.Signals]> = [];
    const picker = createFolderPicker({
      platform: "darwin",
      spawn: () => asProcess(fakeChild(5150)),
      kill: (pid, signal) => {
        killed.push([pid, signal]);
      },
    });

    const pending = picker.pick({});
    const caught = pending.then(
      () => new Error("chooser should time out"),
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(PICK_FOLDER_TIMEOUT_MS);
    await expect(caught).resolves.toBeInstanceOf(ServiceError);
    await expect(caught).resolves.toMatchObject({ message: "The folder chooser timed out." });
    expect(killed).toEqual([[5150, "SIGKILL"]]);
  });

  it("reads a Windows folder dialog and keeps a drive root", async () => {
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const spawn: PickerSpawn = (command, args) => {
      spawned.push({ command, args });
      const child = fakeChild();
      queueMicrotask(() => {
        const stdout = spawned.length === 1 ? "C:\\Users\\me\\proj\\\r\n" : "C:\\\r\n";
        child.stdout.write(stdout);
        child.emit("close", 0, null);
      });
      return asProcess(child);
    };
    const picker = createFolderPicker({
      platform: "win32",
      spawn,
      stat: async () => ({ isDirectory: () => true }),
    });

    await expect(picker.pick({}, { title: "O'Brien" })).resolves.toEqual({
      path: "C:\\Users\\me\\proj",
      supported: true,
    });
    expect(spawned[0]?.command).toBe("powershell");
    expect(spawned[0]?.args.slice(0, 3)).toEqual(["-NoProfile", "-STA", "-EncodedCommand"]);
    const script = Buffer.from(spawned[0]?.args[3] ?? "", "base64").toString("utf16le");
    expect(
      script.startsWith(
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; try {",
      ),
    ).toBe(true);
    expect(script).toContain("} catch { Write-Error $_; exit 1 }");
    expect(script).toContain("FolderBrowserDialog");
    expect(script).toContain("O''Brien");

    await expect(picker.pick({})).resolves.toEqual({ path: "C:\\", supported: true });
  });

  it("decodes a non-ASCII Windows path from buffers split mid-character", async () => {
    const folder = "C:\\Users\\me\\café";
    const bytes = Buffer.from(`${folder}\r\n`, "utf8");
    const splitAt = bytes.indexOf(0xc3) + 1;
    const picker = createFolderPicker({
      platform: "win32",
      stat: async () => ({ isDirectory: () => true }),
      spawn: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.write(bytes.subarray(0, splitAt));
          child.stdout.write(bytes.subarray(splitAt));
          child.emit("close", 0, null);
        });
        return asProcess(child);
      },
    });

    await expect(picker.pick({})).resolves.toEqual({ path: folder, supported: true });
  });

  it("reads stdout that arrives after exit and before close", async () => {
    const dir = await tempDir();
    const child = fakeChild();
    const picker = createFolderPicker({
      platform: "darwin",
      spawn: () => asProcess(child),
    });

    const pending = picker.pick({});
    child.emit("exit", 0, null);
    child.stdout.write(`${dir}/\n`);
    child.emit("close", 0, null);
    await expect(pending).resolves.toEqual({ path: dir, supported: true });
  });

  it("rejects a macOS exit 1 that is not a user cancel", async () => {
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const picker = createFolderPicker({
      platform: "darwin",
      spawn: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stderr.write("osascript: secret syntax error\n");
          child.emit("close", 1, null);
        });
        return asProcess(child);
      },
    });

    await expect(picker.pick({})).rejects.toMatchObject({
      code: "unavailable",
      message: "Could not open the folder chooser.",
    });
    expect(JSON.stringify(logged)).toContain("secret syntax error");
    spy.mockRestore();
  });

  it("keeps spaces in a chosen path and only drops the line break and slashes", async () => {
    const dir = await tempDir();
    const spaced = `${dir} `;
    const seen: string[] = [];
    const picker = createFolderPicker({
      platform: "darwin",
      stat: async (path) => {
        seen.push(path);
        return { isDirectory: () => path === spaced };
      },
      spawn: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.write(`${spaced}/\n`);
          child.emit("close", 0, null);
        });
        return asProcess(child);
      },
    });

    await expect(picker.pick({})).resolves.toEqual({ path: spaced, supported: true });
    expect(seen).toEqual([spaced]);

    const leading = createFolderPicker({
      platform: "darwin",
      spawn: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.write(` ${dir}\n`);
          child.emit("close", 0, null);
        });
        return asProcess(child);
      },
    });
    await expect(leading.pick({})).rejects.toThrow(` ${dir} is not a directory.`);
  });

  it("falls through zenity when it cannot open a display, then gives up", async () => {
    const dir = await tempDir();
    const commands: string[] = [];
    const picker = createFolderPicker({
      platform: "linux",
      spawn: (command) => {
        commands.push(command);
        const child = fakeChild();
        queueMicrotask(() => {
          if (command === "zenity") {
            child.stderr.write("Gtk-WARNING: cannot open display\n");
            child.emit("close", 1, null);
            return;
          }
          child.stdout.write(`${dir}\n`);
          child.emit("close", 0, null);
        });
        return asProcess(child);
      },
    });
    await expect(picker.pick({})).resolves.toEqual({ path: dir, supported: true });
    expect(commands).toEqual(["zenity", "kdialog"]);

    const failed: string[] = [];
    const neither = createFolderPicker({
      platform: "linux",
      spawn: (command) => {
        failed.push(command);
        const child = fakeChild();
        queueMicrotask(() => {
          child.stderr.write(
            command === "zenity" ? "Failed to connect\n" : "cannot open display\n",
          );
          child.emit("close", command === "kdialog" ? 127 : 1, null);
        });
        return asProcess(child);
      },
    });
    await expect(neither.pick({})).resolves.toEqual({ path: null, supported: false });
    expect(failed).toEqual(["zenity", "kdialog"]);
  });

  it("kills only the spawned pid when its connection cancels or the server closes", async () => {
    const killed: number[] = [];
    const child = fakeChild(4242);
    const picker = createFolderPicker({
      platform: "darwin",
      spawn: () => asProcess(child),
      kill: (pid) => {
        killed.push(pid);
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      },
    });
    const owner = {};
    const pending = picker.pick(owner);
    picker.cancel(owner);
    picker.cancel({});
    await expect(pending).resolves.toEqual({ path: null, supported: true });
    expect(killed).toEqual([4242]);

    const again = fakeChild(4343);
    const server = createFolderPicker({
      platform: "darwin",
      spawn: () => asProcess(again),
      kill: (pid) => {
        killed.push(pid);
        queueMicrotask(() => again.emit("close", null, "SIGKILL"));
      },
    });
    const hanging = server.pick(owner);
    server.close();
    await expect(hanging).resolves.toEqual({ path: null, supported: true });
    expect(killed).toEqual([4242, 4343]);
  });
});
