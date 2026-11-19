import { spawn, type ChildProcess } from "node:child_process";
import { stat as statPath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { PICK_FOLDER_TIMEOUT_MS } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TITLE = "Add project";
const CHOOSER_FAILED = "Could not open the folder chooser.";

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

interface Running {
  outcome: Promise<Outcome>;
  cancel(): void;
}

interface ActivePick {
  key: object;
  result: Promise<PickFolderResult>;
  abort(): void;
}

export interface FolderPicker {
  /** One dialog per key. A different key, while one is open, is a conflict. */
  pick(key: object, request?: PickFolderRequest): Promise<PickFolderResult>;
  /** Kill the child spawned for this key, if it is the one that is open. */
  cancel(key: object): void;
  /** Kill whichever child is open. Used when the server itself is closing. */
  close(): void;
}

export function createFolderPicker(deps: FolderPickerDeps = {}): FolderPicker {
  const platform = deps.platform ?? process.platform;
  const spawnProcess = deps.spawn ?? defaultSpawn;
  const kill = deps.kill ?? defaultKill;
  const stat = deps.stat ?? statPath;
  const timeoutMs = deps.timeoutMs ?? PICK_FOLDER_TIMEOUT_MS;
  let active: ActivePick | null = null;

  function pick(key: object, request: PickFolderRequest = {}): Promise<PickFolderResult> {
    if (active) {
      if (active.key === key) return active.result;
      return Promise.reject(new ServiceError("conflict", "A folder chooser is already open."));
    }
    let abort = () => {};
    const result = run(request, (fn) => {
      abort = fn;
    }).finally(() => {
      if (active?.result === result) active = null;
    });
    active = {
      key,
      result,
      abort() {
        abort();
      },
    };
    return result;
  }

  function cancel(key: object) {
    if (active?.key === key) active.abort();
  }

  function close() {
    active?.abort();
  }

  async function run(
    request: PickFolderRequest,
    registerAbort: (fn: () => void) => void,
  ): Promise<PickFolderResult> {
    const title = folderChooserTitle(request.title);
    if (platform === "darwin")
      return finishDarwin(await oneChild("osascript", ["-e", appleScript(title)], registerAbort));
    if (platform === "win32")
      return finishWindows(await oneChild("powershell", windowsArgs(title), registerAbort));
    return pickLinux(title, registerAbort);
  }

  function oneChild(
    command: string,
    args: readonly string[],
    registerAbort: (fn: () => void) => void,
  ): Promise<Outcome> {
    const running = runChild(spawnProcess, kill, command, args, timeoutMs);
    registerAbort(running.cancel);
    return running.outcome;
  }

  async function finishDarwin(outcome: Outcome): Promise<PickFolderResult> {
    if (outcome.missing) return { path: null, supported: false };
    if (outcome.code === 0) return resultFromOutput(outcome.stdout, platform, stat);
    if (isMacCancel(outcome)) return { path: null, supported: true };
    throw chooserFailed(outcome.stderr);
  }

  async function finishWindows(outcome: Outcome): Promise<PickFolderResult> {
    if (outcome.missing) return { path: null, supported: false };
    if (outcome.code === 0) return resultFromOutput(outcome.stdout, platform, stat);
    if (outcome.code === null) return { path: null, supported: true };
    throw chooserFailed(outcome.stderr);
  }

  async function pickLinux(
    title: string,
    registerAbort: (fn: () => void) => void,
  ): Promise<PickFolderResult> {
    const zenity = await oneChild(
      "zenity",
      ["--file-selection", "--directory", `--title=${title}`],
      registerAbort,
    );
    if (!shouldFallThrough(zenity)) return finishLinux(zenity);
    const kdialog = await oneChild(
      "kdialog",
      ["--title", title, "--getexistingdirectory"],
      registerAbort,
    );
    if (shouldFallThrough(kdialog)) return { path: null, supported: false };
    return finishLinux(kdialog);
  }

  function finishLinux(outcome: Outcome): Promise<PickFolderResult> {
    if (outcome.code === 0) return resultFromOutput(outcome.stdout, platform, stat);
    if (outcome.code === 1 || outcome.code === null)
      return Promise.resolve({ path: null, supported: true });
    return Promise.reject(chooserFailed(outcome.stderr));
  }

  return { pick, cancel, close };
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
  const body = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dialog.Description = '${description}'`,
    "$dialog.ShowNewFolderButton = $true",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
  ].join("; ");
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; try { ${body} } catch { Write-Error $_; exit 1 }`;
  return [
    "-NoProfile",
    "-STA",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

/** Exit 1 is a cancel only when osascript says the person dismissed the dialog. */
function isMacCancel(outcome: Outcome): boolean {
  if (outcome.code === null) return true;
  if (outcome.code !== 1) return false;
  return outcome.stderr.includes("User canceled") || outcome.stderr.includes("-128");
}

function shouldFallThrough(outcome: Outcome): boolean {
  if (outcome.missing || outcome.code === 127) return true;
  if (outcome.code !== 1) return false;
  if (normalizePickedPath(outcome.stdout) !== "") return false;
  return isLaunchFailure(outcome.stderr);
}

function isLaunchFailure(stderr: string): boolean {
  return (
    stderr.includes("cannot open display") ||
    stderr.includes("Failed to") ||
    stderr.includes("Gtk-")
  );
}

/** Drop the trailing line break and trailing slashes. Spaces in the path stay. */
function normalizePickedPath(raw: string): string {
  let path = raw;
  if (path.endsWith("\r\n")) path = path.slice(0, -2);
  else if (path.endsWith("\n") || path.endsWith("\r")) path = path.slice(0, -1);
  if (path === "") return "";
  if (path === "/" || path === "\\") return path;
  const stripped = path.replace(/[\\/]+$/, "");
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

function chooserFailed(detail: unknown): ServiceError {
  console.error("Folder chooser failed", detail);
  return new ServiceError("unavailable", CHOOSER_FAILED);
}

function runChild(
  spawnProcess: PickerSpawn,
  kill: PickerKill,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Running {
  let child: ChildProcess | undefined;
  let pid: number | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const outcome = new Promise<Outcome>((resolve, reject) => {
    try {
      child = spawnProcess(command, args);
    } catch (error) {
      reject(chooserFailed(error));
      return;
    }
    if (typeof child.pid === "number") pid = child.pid;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutBytes = { n: 0 };
    const stderrBytes = { n: 0 };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    timer = setTimeout(() => {
      cancelChild();
      finish(() => reject(new ServiceError("unavailable", "The folder chooser timed out.")));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      pushChunk(stdoutChunks, stdoutBytes, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      pushChunk(stderrChunks, stderrBytes, chunk);
    });

    child.once("error", (error: Error) => {
      if (errorCode(error) === "ENOENT") {
        finish(() => resolve(emptyOutcome(true)));
        return;
      }
      finish(() => reject(chooserFailed(error)));
    });

    // `close` fires after stdio is flushed. `exit` can run before the last bytes arrive.
    child.once("close", (code, signal) => {
      finish(() =>
        resolve({
          missing: false,
          code,
          signal,
          stdout: decodeChunks(stdoutChunks),
          stderr: decodeChunks(stderrChunks),
        }),
      );
    });
  });

  function cancelChild() {
    if (typeof pid !== "number") return;
    try {
      kill(pid, "SIGKILL");
    } catch (error) {
      if (errorCode(error) !== "ESRCH") console.error("Folder chooser failed", error);
    }
  }

  return { outcome, cancel: cancelChild };
}

function emptyOutcome(missing: boolean): Outcome {
  return { missing, code: null, signal: null, stdout: "", stderr: "" };
}

function pushChunk(chunks: Buffer[], bytes: { n: number }, chunk: Buffer | string) {
  if (bytes.n >= MAX_OUTPUT_BYTES) return;
  const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  const room = MAX_OUTPUT_BYTES - bytes.n;
  const slice = buf.length > room ? buf.subarray(0, room) : buf;
  chunks.push(slice);
  bytes.n += slice.length;
}

function decodeChunks(chunks: Buffer[]): string {
  if (chunks.length === 0) return "";
  return Buffer.concat(chunks).toString("utf8");
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}
