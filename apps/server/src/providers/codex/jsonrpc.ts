import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { z } from "zod";
import { type JsonRpcErrorPayload, type JsonRpcId, parseJsonRpcMessage } from "./protocol.ts";

const STDERR_CAP_BYTES = 4096;
const SIGKILL_GRACE_MS = 3_000;

export class JsonRpcRemoteError extends Error {
  override readonly name = "JsonRpcRemoteError";
  readonly code: number;
  readonly data: unknown;

  constructor(payload: JsonRpcErrorPayload) {
    super(payload.message);
    this.code = payload.code;
    this.data = payload.data;
  }
}

export interface ProcessExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError: Error | null;
}

export interface JsonRpcNotificationMessage {
  method: string;
  params: unknown;
}

export interface JsonRpcServerRequestMessage {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export interface JsonRpcClientOptions {
  bin: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onNotification: (notification: JsonRpcNotificationMessage) => void;
  onServerRequest: (request: JsonRpcServerRequestMessage) => Promise<unknown>;
  onProtocolError?: (error: Error) => void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

export class JsonRpcClient {
  readonly pid: number | undefined;
  readonly closed: Promise<ProcessExitInfo>;

  private readonly child;
  private readonly pending = new Map<string, PendingCall>();
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private nextId = 1;
  private processAlive = true;
  private closing = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private exitInfo: ProcessExitInfo | null = null;

  constructor(options: JsonRpcClientOptions) {
    const argv = options.args ? [...options.args] : ["app-server"];
    this.child = spawn(options.bin, argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.pid = this.child.pid;

    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutRemainder = "";

    const handleLine = (rawLine: string) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim().length === 0) return;

      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch (err) {
        options.onProtocolError?.(
          err instanceof Error ? err : new Error(`Invalid JSON from app-server: ${String(err)}`),
        );
        return;
      }

      let message;
      try {
        message = parseJsonRpcMessage(decoded);
      } catch (err) {
        options.onProtocolError?.(
          err instanceof Error
            ? err
            : new Error(`Invalid JSON-RPC frame from app-server: ${String(err)}`),
        );
        return;
      }

      switch (message.kind) {
        case "response": {
          const key = idKey(message.id);
          const entry = this.pending.get(key);
          if (!entry) return;
          this.pending.delete(key);
          entry.resolve(message.result);
          return;
        }
        case "error": {
          const key = idKey(message.id);
          const entry = this.pending.get(key);
          if (!entry) return;
          this.pending.delete(key);
          entry.reject(new JsonRpcRemoteError(message.error));
          return;
        }
        case "notification": {
          options.onNotification({ method: message.method, params: message.params });
          return;
        }
        case "request": {
          void this.handleServerRequest(message, options.onServerRequest);
          return;
        }
      }
    };

    this.child.stdout.on("data", (chunk: Buffer) => {
      stdoutRemainder += stdoutDecoder.write(chunk);
      let newlineIndex = stdoutRemainder.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutRemainder.slice(0, newlineIndex);
        stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
        handleLine(line);
        newlineIndex = stdoutRemainder.indexOf("\n");
      }
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.appendStderr(chunk);
    });

    this.child.stdin.on("error", () => {
      // Broken pipe during child exit is surfaced via process close/pending rejections.
    });

    this.child.on("exit", () => {
      this.processAlive = false;
      this.clearKillTimer();
    });

    this.closed = new Promise<ProcessExitInfo>((resolve) => {
      let spawnError: Error | null = null;
      let settled = false;

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        this.processAlive = false;
        this.clearKillTimer();

        const tail = stdoutRemainder + stdoutDecoder.end();
        stdoutRemainder = "";
        if (tail.trim().length > 0) {
          for (const part of tail.split("\n")) handleLine(part);
        }

        const info: ProcessExitInfo = { code, signal, spawnError };
        this.exitInfo = info;
        this.rejectAllPending(this.formatExitError(info));
        resolve(info);
      };

      this.child.on("error", (err: Error) => {
        spawnError = err;
        if (this.pid === undefined) finish(null, null);
      });

      this.child.on("close", (code, signal) => {
        finish(code, signal);
      });
    });
  }

  getStderrTail(): string {
    if (this.stderrChunks.length === 0) return "";
    const combined = Buffer.concat(this.stderrChunks, this.stderrBytes);
    const slice =
      combined.byteLength > STDERR_CAP_BYTES
        ? combined.subarray(combined.byteLength - STDERR_CAP_BYTES)
        : combined;
    return slice.toString("utf8").trim();
  }

  request<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    if (this.exitInfo) {
      return Promise.reject(this.formatExitError(this.exitInfo));
    }
    if (this.closing) {
      return Promise.reject(new Error("Codex app-server client is closing."));
    }

    const id = this.nextId;
    this.nextId += 1;
    const key = idKey(id);

    return new Promise<T>((resolve, reject) => {
      this.pending.set(key, {
        resolve: (rawResult) => {
          const parsed = schema.safeParse(rawResult);
          if (!parsed.success) {
            reject(new Error(`Invalid ${method} response: ${parsed.error.message}`));
            return;
          }
          resolve(parsed.data);
        },
        reject,
      });

      const payload = params === undefined ? { id, method } : { id, method, params };
      if (!this.writeFrame(payload)) {
        this.pending.delete(key);
        reject(
          this.exitInfo
            ? this.formatExitError(this.exitInfo)
            : new Error(`Failed to write ${method} to Codex app-server stdin.`),
        );
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.exitInfo || this.closing) return;
    const payload = params === undefined ? { method } : { method, params };
    this.writeFrame(payload);
  }

  async abort(activeTurn: { threadId: string; turnId: string } | null): Promise<ProcessExitInfo> {
    if (!this.exitInfo && activeTurn && this.processAlive) {
      const id = this.nextId;
      this.nextId += 1;
      await this.writeFrameAndFlush({
        id,
        method: "turn/interrupt",
        params: { threadId: activeTurn.threadId, turnId: activeTurn.turnId },
      });
    }
    return this.terminate();
  }

  async close(): Promise<ProcessExitInfo> {
    return this.terminate();
  }

  private async terminate(): Promise<ProcessExitInfo> {
    this.closing = true;
    if (this.exitInfo) return this.exitInfo;

    if (!this.child.stdin.destroyed) {
      this.child.stdin.end();
    }

    this.killSpawnedPid("SIGTERM");
    if (this.processAlive && this.killTimer === null) {
      this.killTimer = setTimeout(() => {
        this.killTimer = null;
        this.killSpawnedPid("SIGKILL");
      }, SIGKILL_GRACE_MS);
    }

    return this.closed;
  }

  private killSpawnedPid(signal: NodeJS.Signals): void {
    if (!this.processAlive || typeof this.pid !== "number") return;
    try {
      process.kill(this.pid, signal);
    } catch {
      this.processAlive = false;
    }
  }

  private clearKillTimer(): void {
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  private writeFrame(frame: Record<string, unknown>): boolean {
    if (!this.processAlive || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return false;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private writeFrameAndFlush(frame: Record<string, unknown>): Promise<void> {
    if (!this.processAlive || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const guard = setTimeout(resolve, 50);
      guard.unref();
      try {
        this.child.stdin.write(`${JSON.stringify(frame)}\n`, () => {
          clearTimeout(guard);
          resolve();
        });
      } catch {
        clearTimeout(guard);
        resolve();
      }
    });
  }

  private async handleServerRequest(
    request: JsonRpcServerRequestMessage,
    handler: (req: JsonRpcServerRequestMessage) => Promise<unknown>,
  ): Promise<void> {
    try {
      const result = await handler(request);
      if (this.closing || this.exitInfo) return;
      this.writeFrame({ id: request.id, result });
    } catch (err) {
      if (this.closing || this.exitInfo) return;
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof UnhandledServerRequestError ? -32601 : -32603;
      this.writeFrame({
        id: request.id,
        error: { code, message },
      });
    }
  }

  private appendStderr(chunk: Buffer): void {
    if (chunk.byteLength >= STDERR_CAP_BYTES) {
      this.stderrChunks.length = 0;
      const tail = chunk.subarray(chunk.byteLength - STDERR_CAP_BYTES);
      this.stderrChunks.push(tail);
      this.stderrBytes = tail.byteLength;
      return;
    }
    this.stderrChunks.push(chunk);
    this.stderrBytes += chunk.byteLength;
    while (this.stderrBytes > STDERR_CAP_BYTES && this.stderrChunks.length > 1) {
      const first = this.stderrChunks[0];
      if (!first) break;
      const overflow = this.stderrBytes - STDERR_CAP_BYTES;
      if (first.byteLength <= overflow) {
        this.stderrChunks.shift();
        this.stderrBytes -= first.byteLength;
      } else {
        this.stderrChunks[0] = first.subarray(overflow);
        this.stderrBytes -= overflow;
      }
    }
  }

  private rejectAllPending(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }

  private formatExitError(info: ProcessExitInfo): Error {
    const stderr = this.getStderrTail();
    if (info.spawnError) {
      const base = `Failed to start Codex app-server: ${info.spawnError.message}`;
      return new Error(stderr ? `${base}\n${stderr}` : base);
    }
    const detail =
      info.signal !== null
        ? `signal ${info.signal}`
        : `code ${info.code !== null ? String(info.code) : "unknown"}`;
    const base = `Codex app-server exited (${detail})`;
    return new Error(stderr ? `${base}: ${stderr}` : base);
  }
}

export class UnhandledServerRequestError extends Error {
  override readonly name = "UnhandledServerRequestError";
}
