import { spawn, type ChildProcess } from "node:child_process";
import { killTree, type KillTreeSignal } from "../../process/kill-tree.ts";
import type { z } from "zod";
import { parseIncoming, type RpcIdValue } from "./protocol.ts";

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

/** Prints ACP protocol noise when `WOOKY_DEBUG=1`. Never includes the child environment. */
export function acpDebug(message: string): void {
  if (process.env.WOOKY_DEBUG === "1") console.info(message);
}
const STDERR_CAP_BYTES = 4 * 1024;

export class AcpRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
  }
}

export class AcpMethodNotFound extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`Method not found: ${method}`);
    this.name = "AcpMethodNotFound";
    this.method = method;
  }
}

export class AcpClosedError extends Error {
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    info: { stderr: string; code: number | null; signal: NodeJS.Signals | null },
  ) {
    super(message);
    this.name = "AcpClosedError";
    this.stderr = info.stderr;
    this.code = info.code;
    this.signal = info.signal;
  }
}

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onNotification: (method: string, params: unknown) => void;
  onRequest: (method: string, params: unknown, id: RpcIdValue) => Promise<unknown>;
  onDebug?: (message: string) => void;
  maxLineBytes?: number;
  killGraceMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError: Error | null;
}

const liveGuards = new Set<() => void>();

function killLiveGroups(): void {
  for (const guard of liveGuards) guard();
}

function trackGuard(guard: () => void): void {
  if (liveGuards.size === 0) process.on("exit", killLiveGroups);
  liveGuards.add(guard);
}

function untrackGuard(guard: () => void): void {
  if (!liveGuards.delete(guard)) return;
  if (liveGuards.size === 0) process.off("exit", killLiveGroups);
}

export class AcpClient {
  readonly pid: number | undefined;
  readonly closed: Promise<ExitInfo>;

  private readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingCall>();
  private readonly onNotification: AcpClientOptions["onNotification"];
  private readonly onRequest: AcpClientOptions["onRequest"];
  private readonly onDebug: (message: string) => void;
  private readonly maxLineBytes: number;
  private readonly killGraceMs: number;
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private nextId = 1;
  private exitInfo: ExitInfo | null = null;
  private spawnError: Error | null = null;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveClosed: (info: ExitInfo) => void = () => undefined;
  private readonly exitGuard: () => void;

  constructor(options: AcpClientOptions) {
    this.onNotification = options.onNotification;
    this.onRequest = options.onRequest;
    this.onDebug = options.onDebug ?? acpDebug;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.killGraceMs = options.killGraceMs ?? 3_000;
    this.closed = new Promise<ExitInfo>((resolve) => {
      this.resolveClosed = resolve;
    });

    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.pid = this.child.pid;
    this.exitGuard = () => {
      if (this.exitInfo || this.pid === undefined) return;
      this.signalGroup("SIGKILL");
    };
    if (this.pid !== undefined) trackGuard(this.exitGuard);

    this.bindStreams();
  }

  request<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    if (this.exitInfo) return Promise.reject(this.closedError());
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(String(id), {
        resolve: (value) => {
          const parsed = schema.safeParse(value);
          if (!parsed.success) {
            reject(new Error(`Invalid ${method} response.`));
            return;
          }
          resolve(parsed.data);
        },
        reject,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** SIGTERM the process group we spawned, then SIGKILL after the grace period. */
  terminate(): void {
    if (this.exitInfo || this.killTimer) return;
    this.signalGroup("SIGTERM");
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (!this.exitInfo) this.signalGroup("SIGKILL");
    }, this.killGraceMs);
  }

  async close(): Promise<ExitInfo> {
    if (!this.exitInfo) this.terminate();
    return this.closed;
  }

  private bindStreams(): void {
    const stdout = this.child.stdout;
    const stderr = this.child.stderr;
    let chunks: Buffer[] = [];
    let size = 0;
    let dropping = false;

    const takeLine = (part: Buffer) => {
      size += part.length;
      if (size > this.maxLineBytes) {
        chunks = [];
        size = 0;
        dropping = true;
        this.onDebug("acp: dropped oversized line");
        return;
      }
      const line = Buffer.concat([...chunks, part]);
      chunks = [];
      size = 0;
      this.handleLine(line);
    };

    stdout?.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (dropping) {
          const newline = chunk.indexOf(0x0a, offset);
          if (newline < 0) return;
          dropping = false;
          offset = newline + 1;
          continue;
        }
        const newline = chunk.indexOf(0x0a, offset);
        if (newline < 0) {
          const part = chunk.subarray(offset);
          size += part.length;
          if (size > this.maxLineBytes) {
            chunks = [];
            size = 0;
            dropping = true;
            this.onDebug("acp: dropped oversized line");
            return;
          }
          chunks.push(part);
          return;
        }
        takeLine(chunk.subarray(offset, newline));
        if (dropping) {
          dropping = false;
        }
        offset = newline + 1;
      }
    });

    stderr?.on("data", (chunk: Buffer) => {
      if (this.stderrBytes >= STDERR_CAP_BYTES) return;
      const room = STDERR_CAP_BYTES - this.stderrBytes;
      const slice = chunk.subarray(0, room);
      this.stderrChunks.push(slice);
      this.stderrBytes += slice.length;
    });

    this.child.on("error", (error) => {
      this.spawnError = error;
      this.finish();
    });
    this.child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.child.stdin?.destroy();
    });
    this.child.on("close", () => {
      this.finish();
    });
  }

  private handleLine(buffer: Buffer): void {
    let text = buffer.toString("utf8");
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (text.trim().length === 0) return;

    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      this.onDebug("acp: dropped invalid message");
      return;
    }

    const message = parseIncoming(decoded);
    if (message.kind === "invalid") {
      this.onDebug("acp: dropped invalid message");
      return;
    }
    if (message.kind === "notification") {
      this.onNotification(message.method, message.params);
      return;
    }
    if (message.kind === "response" || message.kind === "error") {
      this.settle(message);
      return;
    }
    void this.answer(message.id, message.method, message.params);
  }

  private settle(
    message: Extract<ReturnType<typeof parseIncoming>, { kind: "response" | "error" }>,
  ): void {
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    if (message.kind === "error") {
      pending.reject(new AcpRpcError(message.error.code, message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  private async answer(id: RpcIdValue, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onRequest(method, params, id);
      this.send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (error instanceof AcpMethodNotFound) {
        this.onDebug(`acp: ignored request ${method.slice(0, 200)}`);
        this.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method.slice(0, 200)}` },
        });
        return;
      }
      const message = error instanceof Error ? error.message : "Request failed";
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: message.slice(0, 500) },
      });
    }
  }

  private send(message: unknown): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.pid;
    if (pid === undefined) return;
    const treeSignal: KillTreeSignal = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
    void killTree(pid, treeSignal);
  }

  private stderrText(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }

  private closedError(): AcpClosedError {
    const info = this.exitInfo;
    return new AcpClosedError(
      info?.stderr.trim() || this.spawnError?.message || "The agent exited.",
      {
        stderr: info?.stderr ?? "",
        code: info?.code ?? null,
        signal: info?.signal ?? null,
      },
    );
  }

  private finish(): void {
    if (this.exitInfo) return;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    untrackGuard(this.exitGuard);
    const stderr = this.stderrText();
    const info: ExitInfo = {
      code: this.exitCode,
      signal: this.exitSignal,
      stderr,
      spawnError: this.spawnError,
    };
    this.exitInfo = info;
    const error = new AcpClosedError(
      this.spawnError?.message ||
        stderr.trim() ||
        `The agent exited (${this.exitCode ?? this.exitSignal ?? "unknown"}).`,
      { stderr, code: this.exitCode, signal: this.exitSignal },
    );
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.resolveClosed(info);
  }
}
