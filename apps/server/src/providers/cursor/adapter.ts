import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderEvent, ProviderStatus } from "@age/contracts";
import { z } from "zod";
import { resolveCommand } from "../../process/resolve-command.ts";
import type { ProviderAdapter, TurnInput } from "../types.ts";
import { createNdjsonSplitter } from "./ndjson.ts";
import { isAuthFailure, parseAuthFromStatus, parseModelsFromList } from "./probe.ts";
import { CursorTranslator } from "./translate.ts";

const PROBE_TIMEOUT_MS = 5_000;
const MODELS_CACHE_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 3_000;
const STDERR_TAIL_MAX = 4 * 1024;
const STREAM_CLOSE_GRACE_MS = 100;

const streamObjectSchema = z.object({ type: z.string() }).passthrough();

export const CURSOR_FAKE_AGENT_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-cursor-agent.mjs",
);

export interface CursorAdapterOptions {
  cursorBin?: string;
  cursorArgsPrefix?: string[];
}

let modelsCache: {
  at: number;
  models: Array<{ id: string; label: string }>;
} | null = null;

export function createCursorAdapter(options: CursorAdapterOptions = {}): ProviderAdapter {
  const configuredBin = options.cursorBin ?? process.env.AGE_CURSOR_BIN ?? "cursor-agent";
  const configuredPrefix = options.cursorArgsPrefix ?? [];

  const launch = () => {
    const resolved = resolveCommand(configuredBin);
    if (!resolved) return { bin: configuredBin, prefix: configuredPrefix };
    return {
      bin: resolved.command,
      prefix: [...resolved.prefixArgs, ...configuredPrefix],
    };
  };

  return {
    kind: "cursor",

    async probe(): Promise<ProviderStatus> {
      const base: ProviderStatus = {
        kind: "cursor",
        label: "Cursor Agent",
        installed: false,
        authenticated: null,
        version: null,
        models: [{ id: "auto", label: "Auto" }],
        problem: null,
      };

      const { bin: cursorBin, prefix: cursorArgsPrefix } = launch();

      let version: string | null = null;
      try {
        const probe = await runProbe(cursorBin, cursorArgsPrefix, ["--version"]);
        if (probe.timedOut) {
          return {
            ...base,
            installed: true,
            version: null,
            problem: "Cursor Agent did not respond. Try again.",
          };
        }
        if (probe.code !== 0) {
          return {
            ...base,
            problem: "Cursor Agent is not installed.",
          };
        }
        version = probe.stdout.trim().split("\n")[0]?.trim() ?? null;
      } catch (err) {
        const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
        if (missing) {
          return {
            ...base,
            problem: "Cursor Agent is not installed.",
          };
        }
        return {
          ...base,
          installed: true,
          version: null,
          problem: "Cursor Agent did not respond. Try again.",
        };
      }

      let authenticated: boolean | null = null;
      try {
        const { stdout } = await runProbe(cursorBin, cursorArgsPrefix, ["status"]);
        authenticated = parseAuthFromStatus(stdout);
      } catch {
        authenticated = null;
      }

      const listed = await listModels(cursorBin, cursorArgsPrefix);
      if (listed.authFailed) authenticated = false;
      const models = listed.models;

      const problem =
        authenticated === false
          ? "Cursor Agent is not signed in. Run `cursor-agent login`, then refresh."
          : null;

      return {
        kind: "cursor",
        label: "Cursor Agent",
        installed: true,
        authenticated,
        version,
        models,
        problem,
      };
    },

    runTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
      const { bin, prefix } = launch();
      return runCursorTurn(bin, prefix, input);
    },
  };
}

async function listModels(
  cursorBin: string,
  prefix: string[],
): Promise<{ models: Array<{ id: string; label: string }>; authFailed: boolean }> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.at < MODELS_CACHE_MS) {
    return { models: modelsCache.models, authFailed: false };
  }
  try {
    const { stdout, stderr, code } = await runProbe(cursorBin, prefix, ["--list-models"]);
    if (code === 0) {
      const parsed = parseModelsFromList(stdout);
      if (parsed.length > 0) {
        modelsCache = { at: now, models: parsed };
        return { models: parsed, authFailed: false };
      }
    }
    if (isAuthFailure(`${stdout}\n${stderr}`)) return { models: FALLBACK_MODELS, authFailed: true };
  } catch {
    // fall through
  }
  return { models: FALLBACK_MODELS, authFailed: false };
}

const FALLBACK_MODELS = [{ id: "auto", label: "Auto" }];

export type ProbeResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

export function runProbe(
  cursorBin: string,
  prefix: string[],
  args: string[],
): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cursorBin, [...prefix, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, PROBE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

async function* runCursorTurn(
  cursorBin: string,
  prefix: string[],
  input: TurnInput,
): AsyncIterable<ProviderEvent> {
  if (input.runtimeMode === "approve" || input.runtimeMode === "auto-edits") {
    yield {
      type: "item",
      item: {
        kind: "notice",
        id: `notice-${input.turnId}`,
        text: "Cursor runs shell commands only in Full access; in this mode Cursor's own rules decide.",
      },
    };
  }

  const translator = new CursorTranslator(input.turnId, input.cwd);
  let doneYielded = false;

  const yieldDone = function* (events: ProviderEvent[]) {
    for (const event of events) {
      if (event.type === "done") doneYielded = true;
      yield event;
    }
  };

  if (input.signal.aborted) {
    yield* yieldDone(translator.finish(null, null, null, true));
    return;
  }

  let prompt = input.prompt;
  if (input.handoffContext) {
    prompt = `Earlier conversation in this thread, from another agent:\n\n${input.handoffContext}\n\n---\n\n${prompt}`;
  }

  // cursor-agent help lists `prompt` as a trailing positional argument with no `--` sentinel.
  const argv = [
    ...prefix,
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--workspace",
    input.cwd,
    "--model",
    input.model,
    ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
    ...(input.runtimeMode === "full" ? ["--force"] : []),
    prompt,
  ];

  let child: ChildProcess;
  try {
    child = spawn(cursorBin, argv, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // On Windows `detached` opens a new console window; process groups are POSIX-only.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start Cursor Agent";
    yield* yieldDone([{ type: "done", status: "failed", error: message }]);
    return;
  }

  const splitter = createNdjsonSplitter();
  let stderr = "";
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let closed = false;
  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const wakeExit: Array<() => void> = [];
  const waitExit = () =>
    new Promise<void>((resolve) => {
      if (closed) resolve();
      else wakeExit.push(resolve);
    });

  const finishProcess = (code: number | null, signal: string | null) => {
    if (closed) return;
    closed = true;
    exitCode = code;
    exitSignal = signal;
    while (wakeExit.length > 0) wakeExit.pop()?.();
  };

  const killGroup = (signal: NodeJS.Signals) => {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  };

  const killOnAbort = () => {
    aborted = true;
    killGroup("SIGTERM");
    killTimer = setTimeout(() => {
      const pid = child.pid;
      if (!pid) return;
      try {
        process.kill(-pid, 0);
        killGroup("SIGKILL");
      } catch {
        // already gone
      }
    }, KILL_GRACE_MS);
  };

  const onAbort = () => killOnAbort();
  input.signal.addEventListener("abort", onAbort, { once: true });

  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (!childStdout || !childStderr) {
    yield* yieldDone([
      { type: "done", status: "failed", error: "Cursor Agent streams were unavailable" },
    ]);
    return;
  }

  child.on("exit", (code, signal) => {
    finishProcess(code, signal);
    setTimeout(() => {
      childStdout.destroy();
      childStderr.destroy();
    }, STREAM_CLOSE_GRACE_MS);
  });

  child.on("error", (err) => {
    stderr += err.message;
    finishProcess(1, null);
  });

  const lineQueue: string[] = [];
  let resolveLine: (() => void) | null = null;
  const waitLine = () =>
    new Promise<void>((resolve) => {
      if (lineQueue.length > 0) resolve();
      else resolveLine = resolve;
    });

  childStdout.on("data", (chunk: Buffer) => {
    const lines = splitter.push(chunk.toString());
    lineQueue.push(...lines);
    resolveLine?.();
    resolveLine = null;
  });

  childStderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > STDERR_TAIL_MAX * 2) {
      stderr = stderr.slice(-STDERR_TAIL_MAX * 2);
    }
  });

  try {
    for (;;) {
      if (lineQueue.length === 0) {
        if (closed) break;
        await Promise.race([waitLine(), waitExit()]);
        if (lineQueue.length === 0 && closed) break;
        if (lineQueue.length === 0 && input.signal.aborted) break;
        continue;
      }

      const line = lineQueue.shift();
      if (line === undefined) continue;
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const validated = streamObjectSchema.safeParse(parsed);
      if (!validated.success) continue;

      try {
        for (const event of translator.translate(validated.data)) {
          if (event.type === "done") doneYielded = true;
          yield event;
        }
      } catch (err) {
        if (!doneYielded) {
          const message = err instanceof Error ? err.message : "Translation failed";
          doneYielded = true;
          yield { type: "done", status: "failed", error: message };
        }
        return;
      }
    }

    const tail = splitter.flush();
    if (tail?.trim()) {
      try {
        const parsed: unknown = JSON.parse(tail);
        const validated = streamObjectSchema.safeParse(parsed);
        if (validated.success) {
          for (const event of translator.translate(validated.data)) {
            if (event.type === "done") doneYielded = true;
            yield event;
          }
        }
      } catch {
        // ignore partial JSON
      }
    }
  } catch (err) {
    if (!doneYielded) {
      const message = err instanceof Error ? err.message : "Turn failed";
      doneYielded = true;
      yield { type: "done", status: "failed", error: message };
    }
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
    if (!closed) {
      await waitExit();
    }
    if (!doneYielded) {
      const stderrTail = stderr.length > 0 ? stderr.slice(-STDERR_TAIL_MAX) : null;
      for (const event of translator.finish(exitCode, exitSignal, stderrTail, aborted)) {
        yield event;
      }
    }
  }
}
