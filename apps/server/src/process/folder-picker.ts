import { spawn, type ChildProcess } from "node:child_process";
import { stat as statPath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { ServiceError } from "../errors.ts";

/** Past this, kill the chooser child. The dialog stays open until the user answers. */
export const PICK_FOLDER_TIMEOUT_MS = 10 * 60 * 1000;

const MAX_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_TITLE = "Add project";

export interface PickFolderRequest {
  title?: string;
}

export interface PickFolderResult {
  path: string | null;
  supported: boolean;
}

export type PickerSpawn = (command: string, args: readonly string[]) => ChildProcess;

export type PickerKill = (pid: number, signal: NodeJS.Signals) => void;

type StatFn = (path: string) => Promise<{ isDirectory(): boolean }>;

export interface FolderPickerDeps {
  platform?: NodeJS.Platform;
  spawn?: PickerSpawn;
  kill?: PickerKill;
  stat?: StatFn;
  timeoutMs?: number;
}

interface Outcome {
  missing: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function createFolderPicker(deps: FolderPickerDeps = {}) {
  const platform = deps.platform ?? process.platform;
  const spawnProcess = deps.spawn ?? defaultSpawn;
  const kill = deps.kill ?? defaultKill;
  const stat = deps.stat ?? statPath;
  const timeoutMs = deps.timeoutMs ?? PICK_FOLDER_TIMEOUT_MS;
  // One chooser at a time. A second call shares the in-flight promise.
  let pending: Promise<PickFolderResult> | null = null;

  function pick(request: PickFolderRequest = {}): Promise<PickFolderResult> {
    if (pending) return pending;
    const run = choose(request).finally(() => {
      pending = null;
    });
    pending = run;
    return run;
  }

  async function choose(request: PickFolderRequest): Promise<PickFolderResult> {
    const title = folderChooserTitle(request.title);
    if (platform === "darwin") return pickDarwin(title);
    if (platform === "win32") return pickWindows(title);
    return pickLinux(title);
  }

  async function pickDarwin(title: string): Promise<PickFolderResult> {
    const outcome = await runChild(
      spawnProcess,
      kill,
      "osascript",
      ["-e", appleScript(title)],
      timeoutMs,
    );
    if (outcome.missing) return { path: null, supported: false };
    if (outcome.code === 0) return resultFromOutput(outcome.stdout, platform, stat);
    if (isMacCancel(outcome)) return { path: null, supported: true };
    throw new ServiceError(
      "unavailable",
      outcome.stderr.trim() || "Could not open the folder chooser.",
    );
  }

  async function pickWindows(title: string): Promise<PickFolderResult> {
    const outcome = await runChild(spawnProcess, kill, "powershell", windowsArgs(title), timeoutMs);
    if (outcome.missing) return { path: null, supported: false };
    if (outcome.code === 0) return resultFromOutput(outcome.stdout, platform, stat);
    throw new ServiceError(
      "unavailable",
      outcome.stderr.trim() || "Could not open the folder chooser.",
    );
  }

  async function pickLinux(title: string): Promise<PickFolderResult> {
    const zenity = await runChild(
      spawnProcess,
      kill,
      "zenity",
      ["--file-selection", "--directory", `--title=${title}`],
      timeoutMs,
    );
    if (!zenity.missing) return finishLinux(zenity);
    const kdialog = await runChild(
      spawnProcess,
      kill,
      "kdialog",
      ["--title", title, "--getexistingdirectory"],
      timeoutMs,
    );
    if (kdialog.missing) return { path: null, supported: false };
    return finishLinux(kdialog);
  }

  function finishLinux(outcome: Outcome): Promise<PickFolderResult> {
    if (outcome.code === 0) return resultFromOutput(outcome.stdout, platform, stat);
    if (outcome.code === 1 || outcome.code === null)
      return Promise.resolve({ path: null, supported: true });
    return Promise.reject(
      new ServiceError(
        "unavailable",
        outcome.stderr.trim() || "Could not open the folder chooser.",
      ),
    );
  }

  return { pick };
}

const shared = createFolderPicker();

export function pickFolder(request: PickFolderRequest = {}): Promise<PickFolderResult> {
  return shared.pick(request);
}

function defaultSpawn(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function folderChooserTitle(title: string | undefined): string {
  let cleaned = "";
  for (const char of title ?? "") {
    const code = char.charCodeAt(0);
    cleaned += code <= 0x1f || code === 0x7f ? " " : char;
  }
  const clipped = cleaned.trim().slice(0, 80);
  return clipped || DEFAULT_TITLE;
}

function appleScript(title: string): string {
  const prompt = title.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `POSIX path of (choose folder with prompt "${prompt}")`;
}

function windowsArgs(title: string): readonly string[] {
  const description = title.replaceAll("'", "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dialog.Description = '${description}'`,
    "$dialog.ShowNewFolderButton = $true",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
  ].join("; ");
  return ["-NoProfile", "-STA", "-Command", script];
}

function isMacCancel(outcome: Outcome): boolean {
  if (outcome.code === 1 || outcome.code === null) return true;
  return outcome.stderr.includes("User canceled") || outcome.stderr.includes("-128");
}

function normalizePickedPath(raw: string): string {
  const line =
    raw
      .replace(/^\uFEFF/, "")
      .trim()
      .split(/\r?\n/, 1)[0]
      ?.trim() ?? "";
  if (!line) return "";
  if (line === "/" || line === "\\") return line;
  const stripped = line.replace(/[\\/]+$/, "");
  if (stripped === "") return "/";
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped;
}

async function resultFromOutput(
  stdout: string,
  platform: NodeJS.Platform,
  stat: StatFn,
): Promise<PickFolderResult> {
  const path = normalizePickedPath(stdout);
  if (!path) return { path: null, supported: true };
  if (!pathIsAbsolute(platform, path)) {
    throw new ServiceError("bad_request", `${path} is not a directory.`);
  }
  let info: { isDirectory(): boolean };
  try {
    info = await stat(path);
  } catch {
    throw new ServiceError("bad_request", `${path} is not a directory.`);
  }
  if (!info.isDirectory()) throw new ServiceError("bad_request", `${path} is not a directory.`);
  return { path, supported: true };
}

function pathIsAbsolute(platform: NodeJS.Platform, path: string): boolean {
  return platform === "win32" ? win32.isAbsolute(path) : posix.isAbsolute(path);
}

function runChild(
  spawnProcess: PickerSpawn,
  kill: PickerKill,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command, args);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      const pid = child.pid;
      if (typeof pid === "number") {
        try {
          kill(pid, "SIGKILL");
        } catch (error) {
          if (errorCode(error) !== "ESRCH") {
            finish(() => reject(error instanceof Error ? error : new Error(String(error))));
            return;
          }
        }
      }
      finish(() => reject(new ServiceError("unavailable", "The folder chooser timed out.")));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });

    child.once("error", (error: Error) => {
      if (errorCode(error) === "ENOENT") {
        finish(() => resolve({ missing: true, code: null, signal: null, stdout: "", stderr: "" }));
        return;
      }
      finish(() => reject(error));
    });

    child.once("exit", (code, signal) => {
      finish(() => resolve({ missing: false, code, signal, stdout, stderr }));
    });
  });
}

function appendCapped(current: string, chunk: string | Buffer): string {
  const piece = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const next = current + piece;
  if (next.length <= MAX_OUTPUT_CHARS) return next;
  return next.slice(next.length - MAX_OUTPUT_CHARS);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}
