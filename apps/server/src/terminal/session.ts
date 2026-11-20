import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TerminalInfo, TerminalPush } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { isTreeAlive, killTree, killTreeSync } from "../process/kill-tree.ts";
import { appendToRing, holdIncompleteEscape, splitOutputFrames } from "./frames.ts";
import {
  loadNodePty,
  logPtyFallback,
  spawnPty,
  terminalEnv,
  type PtyLoader,
  type PtyModule,
} from "./pty.ts";
import { defaultCwd, resolveShellCommand, type ShellCommand } from "./shell.ts";

export interface TerminalSubscriber {
  send(message: TerminalPush): void;
  bufferedAmount(): number;
}

export interface TerminalOpenInput {
  cwd?: string;
  cols?: number;
  rows?: number;
  projectId?: string | null;
  scriptId?: string | null;
  title?: string;
  /** When set, spawn this argv instead of an interactive login shell. */
  commandArgv?: { file: string; args: string[] };
}

export type TerminalOpenResult = TerminalInfo & {
  lineEnding: ShellCommand["lineEnding"];
};

export interface TerminalManager {
  open(input: TerminalOpenInput, subscriber: TerminalSubscriber): Promise<TerminalOpenResult>;
  attach(sessionId: string, subscriber: TerminalSubscriber): TerminalInfo;
  detach(sessionId: string, subscriber: TerminalSubscriber): void;
  detachSubscriber(subscriber: TerminalSubscriber): void;
  list(): TerminalInfo[];
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  close(sessionId: string): void;
  closeAll(): void;
}

export interface TerminalManagerOptions {
  loadPty?: PtyLoader;
  resolveShell?: typeof resolveShellCommand;
  now?: () => string;
}

const MAX_SESSIONS = 16;
const COALESCE_MS = 8;
const PAUSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Kill a running session after this long with zero subscribers. Settings can come later. */
export const TERMINAL_DETACHED_KILL_MS = 24 * 60 * 60 * 1000;
/** Drop an exited session from list/attach after this long. */
export const TERMINAL_EXITED_DROP_MS = 10 * 60 * 1000;

interface SessionBackend {
  pid: number | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(sync: boolean): void;
}

interface Session {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  lineEnding: ShellCommand["lineEnding"];
  pty: boolean;
  createdAt: string;
  exited: boolean;
  closing: boolean;
  projectId: string | null;
  scriptId: string | null;
  backend: SessionBackend;
  subscribers: Set<TerminalSubscriber>;
  ring: Buffer;
  pending: string;
  coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  drainTimer: ReturnType<typeof setTimeout> | undefined;
  detachedTimer: ReturnType<typeof setTimeout> | undefined;
  exitedTimer: ReturnType<typeof setTimeout> | undefined;
  paused: boolean;
}

function childStillRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function stopPipe(child: ChildProcessWithoutNullStreams, sync = false) {
  const pid = child.pid;
  if (pid === undefined || !childStillRunning(child)) return;
  if (sync) killTreeSync(pid, "SIGKILL", { mode: "tree" });
  else void killTree(pid, "SIGKILL", { mode: "tree" });
}

function stopPty(pid: number | undefined, killPty: () => void, sync: boolean, exited: boolean) {
  if (!exited && pid !== undefined && isTreeAlive(pid)) {
    if (sync) killTreeSync(pid, "SIGKILL", { mode: "tree" });
    else void killTree(pid, "SIGKILL", { mode: "tree" });
  }
  try {
    killPty();
  } catch {
    // already gone
  }
}

function appendRing(session: Session, chunk: string) {
  session.ring = appendToRing(session.ring, chunk);
}

function toInfo(session: Session): TerminalInfo {
  return {
    sessionId: session.id,
    title: session.title,
    cwd: session.cwd,
    shell: session.shell,
    pty: session.pty,
    createdAt: session.createdAt,
    exited: session.exited,
    projectId: session.projectId,
    scriptId: session.scriptId,
  };
}

function toOpenResult(session: Session): TerminalOpenResult {
  return { ...toInfo(session), lineEnding: session.lineEnding };
}

function subscriberOverBudget(subscribers: Set<TerminalSubscriber>): boolean {
  for (const subscriber of subscribers) {
    if (subscriber.bufferedAmount() > PAUSE_BYTES) return true;
  }
  return false;
}

/** Local interactive shells owned by the server. Kill only PIDs we spawned. */
export function createTerminalManager(options: TerminalManagerOptions = {}): TerminalManager {
  const sessions = new Map<string, Session>();
  const resolveShell = options.resolveShell ?? resolveShellCommand;
  const now = options.now ?? (() => new Date().toISOString());
  const loadPty = options.loadPty ?? loadNodePty;
  let ptyLoad: Promise<PtyModule | null> | undefined;

  function ensurePty(): Promise<PtyModule | null> {
    ptyLoad ??= loadPty()
      .then((mod) => mod)
      .catch((reason: unknown) => {
        logPtyFallback(reason);
        return null;
      });
    return ptyLoad;
  }

  function requireSession(sessionId: string): Session {
    const session = sessions.get(sessionId);
    if (!session)
      throw new ServiceError("not_found", `Terminal session "${sessionId}" is not open.`);
    return session;
  }

  function broadcast(session: Session, message: TerminalPush) {
    for (const subscriber of session.subscribers) subscriber.send(message);
  }

  function scheduleDrain(session: Session) {
    if (session.drainTimer) return;
    const timer = setTimeout(() => {
      session.drainTimer = undefined;
      if (session.exited) return;
      if (subscriberOverBudget(session.subscribers)) {
        scheduleDrain(session);
        return;
      }
      session.paused = false;
      session.backend.resume();
    }, 16);
    timer.unref();
    session.drainTimer = timer;
  }

  function applyFlowControl(session: Session) {
    if (session.exited || session.subscribers.size === 0) return;
    if (!subscriberOverBudget(session.subscribers)) return;
    if (session.paused) {
      scheduleDrain(session);
      return;
    }
    session.paused = true;
    session.backend.pause();
    scheduleDrain(session);
  }

  function clearTimer(slot: "coalesceTimer" | "drainTimer" | "detachedTimer" | "exitedTimer") {
    return (session: Session) => {
      const timer = session[slot];
      if (!timer) return;
      clearTimeout(timer);
      session[slot] = undefined;
    };
  }

  const clearCoalesce = clearTimer("coalesceTimer");
  const clearDrain = clearTimer("drainTimer");
  const clearDetached = clearTimer("detachedTimer");
  const clearExited = clearTimer("exitedTimer");

  function dropSession(session: Session) {
    clearCoalesce(session);
    clearDrain(session);
    clearDetached(session);
    clearExited(session);
    sessions.delete(session.id);
  }

  function detachedCount() {
    let count = 0;
    for (const session of sessions.values()) {
      if (!session.exited && session.subscribers.size === 0) count += 1;
    }
    return count;
  }

  function reapExited() {
    for (const session of [...sessions.values()]) {
      if (session.exited) dropSession(session);
    }
  }

  function scheduleDetachedKill(session: Session) {
    clearDetached(session);
    if (session.exited || session.subscribers.size > 0) return;
    const timer = setTimeout(() => {
      session.detachedTimer = undefined;
      if (session.exited || session.subscribers.size > 0) return;
      session.backend.kill(false);
    }, TERMINAL_DETACHED_KILL_MS);
    timer.unref();
    session.detachedTimer = timer;
  }

  function scheduleExitedDrop(session: Session) {
    clearExited(session);
    const timer = setTimeout(() => {
      session.exitedTimer = undefined;
      dropSession(session);
    }, TERMINAL_EXITED_DROP_MS);
    timer.unref();
    session.exitedTimer = timer;
  }

  function flushPending(session: Session, drainHeld = false) {
    clearCoalesce(session);
    const pending = session.pending;
    if (!pending) return;
    const { ready, held } = drainHeld
      ? { ready: pending, held: "" }
      : holdIncompleteEscape(pending);
    session.pending = held;
    if (!ready) return;
    for (const data of splitOutputFrames(ready)) {
      broadcast(session, { push: "terminal", sessionId: session.id, kind: "data", data });
    }
    applyFlowControl(session);
  }

  function onOutput(session: Session, chunk: string) {
    appendRing(session, chunk);
    if (session.subscribers.size === 0) return;
    session.pending += chunk;
    if (session.coalesceTimer) return;
    const timer = setTimeout(() => flushPending(session), COALESCE_MS);
    timer.unref();
    session.coalesceTimer = timer;
  }

  function finish(session: Session, code: number, data: string) {
    if (session.exited) return;
    flushPending(session, true);
    session.exited = true;
    clearDrain(session);
    clearDetached(session);
    broadcast(session, { push: "terminal", sessionId: session.id, kind: "exit", code, data });
    if (session.closing) {
      dropSession(session);
      return;
    }
    scheduleExitedDrop(session);
  }

  function pipeBackend(
    child: ChildProcessWithoutNullStreams,
    onChunk: (chunk: string) => void,
    onError: (message: string) => void,
    onClose: (code: number, signal: NodeJS.Signals | null) => void,
  ): SessionBackend {
    const pushData = (chunk: Buffer | string) => {
      onChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    child.stdout.on("data", pushData);
    child.stderr.on("data", pushData);
    child.on("error", (error) => {
      onError(error.message || "Failed to start the shell.");
    });
    child.on("close", (code, signal) => {
      onClose(code ?? (signal ? 1 : 0), signal);
    });
    return {
      pid: child.pid,
      write(data) {
        if (child.killed || child.stdin.destroyed) {
          throw new ServiceError("conflict", "The shell is no longer accepting input.");
        }
        child.stdin.write(data);
      },
      resize() {},
      pause() {
        child.stdout.pause();
        child.stderr.pause();
      },
      resume() {
        child.stdout.resume();
        child.stderr.resume();
      },
      kill(sync) {
        stopPipe(child, sync);
      },
    };
  }

  function startPipe(
    shell: ShellCommand,
    cwd: string,
    env: NodeJS.ProcessEnv,
    bind: (backend: SessionBackend) => Session,
  ): Session {
    // wooky-allow child-process: terminal sessions are user-facing shells the server owns.
    const child = spawn(shell.file, shell.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const bound: { session?: Session } = {};
    const backend = pipeBackend(
      child,
      (chunk) => {
        if (bound.session) onOutput(bound.session, chunk);
      },
      (message) => {
        if (!bound.session) return;
        broadcast(bound.session, {
          push: "terminal",
          sessionId: bound.session.id,
          kind: "error",
          data: message,
        });
        dropSession(bound.session);
      },
      (code, signal) => {
        if (!bound.session || !sessions.has(bound.session.id)) return;
        finish(
          bound.session,
          code,
          signal
            ? `\r\n[process exited via ${signal}]\r\n`
            : `\r\n[process exited with code ${code}]\r\n`,
        );
      },
    );
    bound.session = bind(backend);
    onOutput(bound.session, `Wooky terminal · ${shell.label}\r\n${cwd}\r\n\r\n`);
    return bound.session;
  }

  async function startPty(
    pty: PtyModule,
    shell: ShellCommand,
    cwd: string,
    cols: number,
    rows: number,
    env: NodeJS.ProcessEnv,
    bind: (backend: SessionBackend) => Session,
  ): Promise<Session> {
    const proc = spawnPty(pty, shell.file, shell.args, { cwd, cols, rows, env });
    const bound: { session?: Session } = {};
    const backend: SessionBackend = {
      pid: proc.pid,
      write(data) {
        proc.write(data);
      },
      resize(nextCols, nextRows) {
        proc.resize(nextCols, nextRows);
      },
      pause() {
        proc.pause();
      },
      resume() {
        proc.resume();
      },
      kill(sync) {
        stopPty(proc.pid, () => proc.kill(), sync, bound.session?.exited === true);
      },
    };
    proc.onData((chunk) => {
      if (bound.session) onOutput(bound.session, chunk);
    });
    proc.onExit(({ exitCode, signal }) => {
      if (!bound.session || !sessions.has(bound.session.id)) return;
      const code = exitCode || (signal ? 1 : 0);
      finish(
        bound.session,
        code,
        signal
          ? `\r\n[process exited via ${signal}]\r\n`
          : `\r\n[process exited with code ${code}]\r\n`,
      );
    });
    bound.session = bind(backend);
    return bound.session;
  }

  function createSession(
    backend: SessionBackend,
    input: {
      shell: ShellCommand;
      cwd: string;
      pty: boolean;
      projectId: string | null;
      scriptId: string | null;
      title?: string;
    },
    subscriber: TerminalSubscriber,
  ): Session {
    const id = `term_${randomUUID()}`;
    const session: Session = {
      id,
      title: input.title?.trim() || input.shell.label,
      cwd: input.cwd,
      shell: input.shell.label,
      lineEnding: input.shell.lineEnding,
      pty: input.pty,
      createdAt: now(),
      exited: false,
      closing: false,
      projectId: input.projectId,
      scriptId: input.scriptId,
      backend,
      subscribers: new Set([subscriber]),
      ring: Buffer.alloc(0),
      pending: "",
      coalesceTimer: undefined,
      drainTimer: undefined,
      detachedTimer: undefined,
      exitedTimer: undefined,
      paused: false,
    };
    sessions.set(id, session);
    return session;
  }

  async function open(
    input: TerminalOpenInput,
    subscriber: TerminalSubscriber,
  ): Promise<TerminalOpenResult> {
    if (sessions.size >= MAX_SESSIONS) reapExited();
    if (sessions.size >= MAX_SESSIONS) {
      throw new ServiceError(
        "conflict",
        `At most ${MAX_SESSIONS} terminal sessions (${detachedCount()} detached).`,
      );
    }
    const resolved = resolveShell();
    const shell: ShellCommand = input.commandArgv
      ? {
          ...resolved,
          file: input.commandArgv.file,
          args: input.commandArgv.args,
        }
      : resolved;
    const cwd = defaultCwd(input.cwd);
    const cols = input.cols ?? DEFAULT_COLS;
    const rows = input.rows ?? DEFAULT_ROWS;
    const env = terminalEnv();
    const projectId = input.projectId ?? null;
    const scriptId = input.scriptId ?? null;
    const pty = await ensurePty();
    const bind = (usePty: boolean) => (backend: SessionBackend) =>
      createSession(
        backend,
        { shell: resolved, cwd, pty: usePty, projectId, scriptId, title: input.title },
        subscriber,
      );

    if (!pty) {
      return toOpenResult(startPipe(shell, cwd, env, bind(false)));
    }
    try {
      return toOpenResult(await startPty(pty, shell, cwd, cols, rows, env, bind(true)));
    } catch (reason) {
      logPtyFallback(reason);
      return toOpenResult(startPipe(shell, cwd, env, bind(false)));
    }
  }

  function attach(sessionId: string, subscriber: TerminalSubscriber): TerminalInfo {
    const session = requireSession(sessionId);
    clearDetached(session);
    session.subscribers.add(subscriber);
    const replay = session.ring.toString("utf8");
    subscriber.send({
      push: "terminal",
      sessionId: session.id,
      kind: "replay",
      data: replay,
    });
    return toInfo(session);
  }

  function detach(sessionId: string, subscriber: TerminalSubscriber) {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.subscribers.delete(subscriber);
    if (!session.exited && session.subscribers.size === 0) scheduleDetachedKill(session);
  }

  function detachSubscriber(subscriber: TerminalSubscriber) {
    for (const session of [...sessions.values()]) {
      if (!session.subscribers.delete(subscriber)) continue;
      if (!session.exited && session.subscribers.size === 0) scheduleDetachedKill(session);
    }
  }

  function list(): TerminalInfo[] {
    return [...sessions.values()].map(toInfo);
  }

  function write(sessionId: string, data: string) {
    const session = requireSession(sessionId);
    if (session.exited) {
      throw new ServiceError("conflict", "The shell is no longer accepting input.");
    }
    session.backend.write(data);
  }

  function resize(sessionId: string, cols: number, rows: number) {
    const session = sessions.get(sessionId);
    if (!session || session.exited) return;
    session.backend.resize(cols, rows);
  }

  function close(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.exited) {
      dropSession(session);
      return;
    }
    session.closing = true;
    session.backend.kill(false);
  }

  function closeAll() {
    const sync = process.platform === "win32";
    for (const session of [...sessions.values()]) {
      const exited = session.exited;
      dropSession(session);
      if (!exited) session.backend.kill(sync);
    }
  }

  return { open, attach, detach, detachSubscriber, list, write, resize, close, closeAll };
}
