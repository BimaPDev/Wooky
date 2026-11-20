import { spawn } from "node:child_process";
import {
  isTreeAlive,
  killTree,
  killTreeSync,
  type KillTreeSignal,
} from "../../process/kill-tree.ts";
import { StringDecoder } from "node:string_decoder";
import type { z } from "zod";
import { type JsonRpcErrorPayload, type JsonRpcId, parseJsonRpcMessage } from "./protocol.ts";

const STDERR_CAP_BYTES = 4096;
const SIGKILL_GRACE_MS = 3_000;
// After the app-server exits, how long its stdout/stderr may stay open (a grandchild
// can inherit them) before we destroy them so the close event still fires.
const STDIO_CLOSE_GRACE_MS = 250;
const GROUP_POLL_MS = 20;
const WIN32_STDIO_KILL_MS = 500;
// Polls allowed after SIGKILL before we stop waiting for an unreaped group member.
const GROUP_POLL_ATTEMPTS = 100;

// One `exit` listener serves every live client, so many concurrent clients never
// trip MaxListenersExceededWarning. It is installed while any client is live.
const liveExitGuards = new Set<() => void>();
function killLiveGroupsOnExit(): void {
  for (const guard of liveExitGuards) guard();
}
function trackExitGuard(guard: () => void): void {
  if (liveExitGuards.size === 0) process.on("exit", killLiveGroupsOnExit);
  liveExitGuards.add(guard);
}
function untrackExitGuard(guard: () => void): void {
  if (!liveExitGuards.delete(guard)) return;
  if (liveExitGuards.size === 0) process.off("exit", killLiveGroupsOnExit);
}
// Largest single JSONL line we will buffer from the app-server's stdout, measured
// in UTF-16 code units. A line longer than this is dropped (we resync at the next
// newline) so a runaway or hostile stream cannot grow the read buffer without bound.
const MAX_LINE_LENGTH = 16 * 1024 * 1024;

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
  /**
   * Result used to answer any server request still pending when the client is
   * torn down (e.g. an approval left unanswered by an interrupted turn). Returning
   * a decline keeps the app-server's JSON-RPC request from dangling. Returning
   * undefined answers the request with a JSON-RPC error instead.
   */
  cancelServerRequest?: (request: JsonRpcServerRequestMessage) => unknown;
  /** Wait between SIGTERM and SIGKILL. Defaults to 3 seconds. */
  killGraceMs?: number;
  /** Wait after exit before destroying stdout/stderr. Defaults to 250 ms. */
  stdioGraceMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function oversizedLineError(): Error {
  return new Error(
    `Dropped an oversized line from the Codex app-server (exceeded ${MAX_LINE_LENGTH} bytes).`,
  );
}

export class JsonRpcClient {
  readonly pid: number | undefined;
  readonly closed: Promise<ProcessExitInfo>;

  private readonly child;
  private readonly pending = new Map<string, PendingCall>();
  private readonly pendingServerRequests = new Map<string, JsonRpcServerRequestMessage>();
  private readonly cancelServerRequest?: (request: JsonRpcServerRequestMessage) => unknown;
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private nextId = 1;
  private readonly killGraceMs: number;
  private readonly stdioGraceMs: number;
  private processAlive = true;
  private closing = false;
  // Polls the group during teardown. Kept ref'd on purpose: if nothing else holds the
  // event loop open, a pending close() must still reach SIGKILL and resolve.
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private watchingGroup = false;
  private exitInfo: ProcessExitInfo | null = null;
  // The group outlives the app-server whenever a grandchild is still running, so
  // its liveness is tracked apart from the child's own exit.
  private groupGone = false;
  private resolveGroupGone: () => void = () => {};
  private readonly groupGonePromise = new Promise<void>((resolve) => {
    this.resolveGroupGone = resolve;
  });
  private interruptPromise: Promise<void> | null = null;
  private teardownPromise: Promise<ProcessExitInfo> | null = null;
  private win32KillRequested = false;

  // Last resort if the Wooky server dies without closing the client: the child
  // is detached, so nothing else would stop its group. Must stay synchronous.
  private readonly exitGuard = (): void => {
    if (this.groupGone || typeof this.pid !== "number") return;
    killTreeSync(this.pid, "SIGKILL", { mode: "group" });
  };

  constructor(options: JsonRpcClientOptions) {
    this.cancelServerRequest = options.cancelServerRequest;
    this.killGraceMs = options.killGraceMs ?? SIGKILL_GRACE_MS;
    this.stdioGraceMs = options.stdioGraceMs ?? STDIO_CLOSE_GRACE_MS;
    const argv = options.args ? [...options.args] : ["app-server"];
    this.child = spawn(options.bin, argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // On POSIX, make the child its own process-group leader so stopping it can
      // signal the whole group (and thus any grandchildren it spawned). Windows
      // has no process groups here, so we fall back to signalling the bare pid.
      detached: process.platform !== "win32",
    });
    this.pid = this.child.pid;
    if (typeof this.pid === "number") {
      trackExitGuard(this.exitGuard);
    } else {
      this.markGroupGone();
    }

    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutRemainder = "";
    // When a single line exceeds MAX_LINE_LENGTH we stop buffering it and discard
    // bytes until the next newline, then resume normally on the line after it.
    let droppingOversizedLine = false;

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
          this.pendingServerRequests.set(idKey(message.id), message);
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
        if (droppingOversizedLine) {
          // This newline terminates the oversized line we already dropped; resume.
          droppingOversizedLine = false;
        } else if (line.length > MAX_LINE_LENGTH) {
          // The line crossed the cap in the same chunk as its newline.
          options.onProtocolError?.(oversizedLineError());
        } else {
          handleLine(line);
        }
        newlineIndex = stdoutRemainder.indexOf("\n");
      }
      if (droppingOversizedLine) {
        // Still inside an oversized line: keep discarding so the buffer cannot grow.
        stdoutRemainder = "";
      } else if (stdoutRemainder.length > MAX_LINE_LENGTH) {
        droppingOversizedLine = true;
        stdoutRemainder = "";
        options.onProtocolError?.(oversizedLineError());
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
      // Only the child is gone. A grandchild may still be running, so the SIGKILL
      // escalation stays armed until the group itself is gone.
      this.refreshGroup();
      // A grandchild holding the inherited pipes would keep close from firing.
      const destroyStdio = setTimeout(() => {
        this.child.stdout.destroy();
        this.child.stderr.destroy();
      }, this.stdioGraceMs);
      destroyStdio.unref();
    });

    this.closed = new Promise<ProcessExitInfo>((resolve) => {
      let spawnError: Error | null = null;
      let settled = false;

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        this.processAlive = false;
        this.refreshGroup();

        const tail = stdoutRemainder + stdoutDecoder.end();
        stdoutRemainder = "";
        if (!droppingOversizedLine && tail.trim().length > 0) {
          for (const part of tail.split("\n")) {
            if (part.length > MAX_LINE_LENGTH) {
              options.onProtocolError?.(oversizedLineError());
            } else {
              handleLine(part);
            }
          }
        }
        droppingOversizedLine = false;

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
    // Set closing synchronously so an approval handler that resolves during the
    // abort defers its reply to teardown, which declines it exactly once.
    this.closing = true;
    // Interrupt once, and only while no teardown has started: later calls (and a
    // close that raced ahead) share the one teardown.
    if (!this.teardownPromise && !this.interruptPromise && activeTurn && this.processAlive) {
      const id = this.nextId;
      this.nextId += 1;
      this.interruptPromise = this.writeFrameAndFlush({
        id,
        method: "turn/interrupt",
        params: { threadId: activeTurn.threadId, turnId: activeTurn.turnId },
      });
    }
    return this.terminate();
  }

  close(): Promise<ProcessExitInfo> {
    return this.terminate();
  }

  private terminate(): Promise<ProcessExitInfo> {
    this.closing = true;
    this.teardownPromise ??= this.runTeardown();
    return this.teardownPromise;
  }

  // Strictly in order, each exactly once: interrupt, decline pending requests,
  // close stdin, SIGTERM the group. Every caller shares this one run.
  private async runTeardown(): Promise<ProcessExitInfo> {
    if (this.interruptPromise) await this.interruptPromise;

    // Answer any approval request left pending, flushed before we close stdin, so
    // the app-server's JSON-RPC request never dangles on interrupt.
    await this.cancelPendingServerRequests();

    if (!this.child.stdin.destroyed) {
      this.child.stdin.end();
    }

    if (process.platform === "win32") {
      await this.win32TeardownKill();
    } else {
      this.signalGroup("SIGTERM");
      this.watchGroup();
    }

    const [info] = await Promise.all([this.closed, this.groupGonePromise]);
    return info;
  }

  private async win32TeardownKill(): Promise<void> {
    this.win32KillRequested = true;
    const waitMs = Math.min(WIN32_STDIO_KILL_MS, this.stdioGraceMs);
    let stdioTimer: ReturnType<typeof setTimeout> | undefined;
    const stdioTimeout = new Promise<void>((resolve) => {
      stdioTimer = setTimeout(resolve, waitMs);
    });
    const stdioClosed = new Promise<void>((resolve) => {
      if (!this.processAlive) resolve();
      else this.child.once("close", () => resolve());
    });
    await Promise.race([stdioClosed, stdioTimeout]);
    if (stdioTimer !== undefined) clearTimeout(stdioTimer);
    void killTree(this.pid as number, "SIGKILL", { mode: "group" });
    let polls = 0;
    while (!this.groupGone && polls < GROUP_POLL_ATTEMPTS) {
      polls += 1;
      if (!this.refreshGroup()) break;
      await new Promise<void>((resolve) => setTimeout(resolve, GROUP_POLL_MS));
    }
    const pid = this.pid;
    if (!this.groupGone && typeof pid === "number") {
      killTreeSync(pid, "SIGKILL", { mode: "group" });
      this.markGroupGone();
    }
  }

  /** Whether anything in the app-server's process group is still running. */
  private refreshGroup(): boolean {
    if (this.groupGone) return false;
    const pid = this.pid;
    if (typeof pid !== "number") {
      this.markGroupGone();
      return false;
    }
    if (process.platform === "win32") {
      if (this.processAlive) return true;
      if (!this.win32KillRequested) {
        this.markGroupGone();
        return false;
      }
      return false;
    }
    if (isTreeAlive(pid)) return true;
    // Once the group is seen empty, never signal it again: the pid may be reused.
    this.markGroupGone();
    return false;
  }

  private markGroupGone(): void {
    if (this.groupGone) return;
    this.groupGone = true;
    this.clearKillTimer();
    untrackExitGuard(this.exitGuard);
    this.resolveGroupGone();
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.pid;
    if (typeof pid !== "number" || !this.refreshGroup()) return;
    this.win32KillRequested = true;
    const treeSignal: KillTreeSignal = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
    void killTree(pid, treeSignal, { mode: "group" });
  }

  // After SIGTERM, poll the group so teardown ends as soon as it is gone, and escalate
  // to SIGKILL only if something is still running when the grace runs out. A
  // grandchild that outlives the app-server by a few ms must not cost the full grace.
  private watchGroup(): void {
    if (this.watchingGroup || !this.refreshGroup()) return;
    this.watchingGroup = true;
    const deadline = performance.now() + this.killGraceMs;
    let killed = false;
    let killedPolls = 0;
    const tick = (): void => {
      this.killTimer = null;
      if (!this.refreshGroup()) return;
      let delay = GROUP_POLL_MS;
      if (!killed) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          killed = true;
          this.signalGroup("SIGKILL");
        } else {
          delay = Math.min(GROUP_POLL_MS, remaining);
        }
      } else {
        killedPolls += 1;
        if (killedPolls > GROUP_POLL_ATTEMPTS) {
          // A SIGKILLed member that is not reaped must not hang teardown forever.
          this.markGroupGone();
          return;
        }
      }
      this.killTimer = setTimeout(tick, delay);
    };
    this.killTimer = setTimeout(tick, Math.min(GROUP_POLL_MS, this.killGraceMs));
  }

  private async cancelPendingServerRequests(): Promise<void> {
    if (this.pendingServerRequests.size === 0) return;
    const requests = [...this.pendingServerRequests.values()];
    this.pendingServerRequests.clear();
    for (const request of requests) {
      const result = this.cancelServerRequest?.(request);
      const body =
        result !== undefined
          ? { result }
          : {
              error: { code: -32603, message: "Request cancelled: Codex app-server is stopping." },
            };
      await this.writeFrameAndFlush({ id: request.id, ...body });
    }
  }

  private answerServerRequest(id: JsonRpcId, body: Record<string, unknown>): void {
    const key = idKey(id);
    // Already answered, cancelled, or dead process: never reply twice.
    if (!this.pendingServerRequests.has(key)) return;
    // During teardown, leave it pending so cancelPendingServerRequests() declines
    // it exactly once (flushed before stdin closes).
    if (this.closing || this.exitInfo) return;
    this.pendingServerRequests.delete(key);
    this.writeFrame({ id, ...body });
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
      this.answerServerRequest(request.id, { result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof UnhandledServerRequestError ? -32601 : -32603;
      this.answerServerRequest(request.id, { error: { code, message } });
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
