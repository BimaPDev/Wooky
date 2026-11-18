import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TerminalPush } from "@age/contracts";
import { ServiceError } from "../errors.ts";
import { defaultCwd, resolveShellCommand, type ShellCommand } from "./shell.ts";

export type TerminalSink = (message: TerminalPush) => void;

interface Session {
  id: string;
  child: ChildProcessWithoutNullStreams;
  shell: string;
}

export interface TerminalManager {
  open(
    input: { cwd?: string; cols?: number; rows?: number },
    sink: TerminalSink,
  ): { sessionId: string; shell: string; lineEnding: ShellCommand["lineEnding"] };
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  close(sessionId: string): void;
  closeAll(): void;
}

/** Local interactive shells owned by the server. Kill only PIDs we spawned. */
export function createTerminalManager(): TerminalManager {
  const sessions = new Map<string, Session>();

  function open(
    input: { cwd?: string; cols?: number; rows?: number },
    sink: TerminalSink,
  ): { sessionId: string; shell: string; lineEnding: ShellCommand["lineEnding"] } {
    const shell = resolveShellCommand();
    const cwd = defaultCwd(input.cwd);
    // age-allow child-process: terminal sessions are user-facing shells the server owns.
    const child = spawn(shell.file, shell.args, {
      cwd,
      env: {
        ...process.env,
        TERM: process.env.TERM ?? "xterm-256color",
        COLORTERM: process.env.COLORTERM ?? "truecolor",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const id = `term_${randomUUID()}`;
    const session: Session = { id, child, shell: shell.label };
    sessions.set(id, session);

    const pushData = (chunk: Buffer) => {
      sink({ push: "terminal", sessionId: id, kind: "data", data: chunk.toString("utf8") });
    };
    child.stdout.on("data", pushData);
    child.stderr.on("data", pushData);
    child.on("error", (error) => {
      sink({
        push: "terminal",
        sessionId: id,
        kind: "error",
        data: error.message || "Failed to start the shell.",
      });
      sessions.delete(id);
    });
    child.on("close", (code, signal) => {
      if (!sessions.has(id)) return;
      sessions.delete(id);
      sink({
        push: "terminal",
        sessionId: id,
        kind: "exit",
        code: code ?? (signal ? 1 : 0),
        data: signal
          ? `\r\n[process exited via ${signal}]\r\n`
          : `\r\n[process exited with code ${code ?? 0}]\r\n`,
      });
    });

    sink({
      push: "terminal",
      sessionId: id,
      kind: "data",
      data: `Wooky terminal · ${shell.label}\r\n${cwd}\r\n\r\n`,
    });

    return { sessionId: id, shell: shell.label, lineEnding: shell.lineEnding };
  }

  function write(sessionId: string, data: string) {
    const session = sessions.get(sessionId);
    if (!session)
      throw new ServiceError("not_found", `Terminal session "${sessionId}" is not open.`);
    if (session.child.killed || session.child.stdin.destroyed) {
      throw new ServiceError("conflict", "The shell is no longer accepting input.");
    }
    session.child.stdin.write(data);
  }

  function resize(_sessionId: string, _cols: number, _rows: number) {
    // Pipe-backed shells ignore size; kept so clients can call a stable API.
  }

  function close(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    killTree(session.child);
  }

  function closeAll() {
    for (const id of [...sessions.keys()]) close(id);
  }

  return { open, write, resize, close, closeAll };
}

function killTree(child: ChildProcessWithoutNullStreams) {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // age-allow child-process: taskkill targets only the PID we spawned (and its tree).
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1500).unref();
    }
  } catch {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}
