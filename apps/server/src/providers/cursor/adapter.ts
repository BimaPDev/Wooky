import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderEvent, ProviderStatus } from "@age/contracts";
import type { ProviderAdapter, TurnInput } from "../types.ts";
import { createNdjsonSplitter } from "./ndjson.ts";
import { parseAuthFromStatus, parseModelsFromList } from "./probe.ts";
import { CursorTranslator } from "./translate.ts";

const PROBE_TIMEOUT_MS = 5_000;
const MODELS_CACHE_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 3_000;
const STDERR_TAIL_MAX = 4 * 1024;

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
  const cursorBin = options.cursorBin ?? process.env.AGE_CURSOR_BIN ?? "cursor-agent";
  const cursorArgsPrefix = options.cursorArgsPrefix ?? [];

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

      let version: string | null = null;
      try {
        const { stdout, code } = await runProbe(cursorBin, cursorArgsPrefix, ["--version"]);
        if (code !== 0) {
          return {
            ...base,
            problem: "Cursor Agent is not installed.",
          };
        }
        version = stdout.trim().split("\n")[0]?.trim() ?? null;
      } catch {
        return {
          ...base,
          problem: "Cursor Agent is not installed.",
        };
      }

      let authenticated: boolean | null = null;
      try {
        const { stdout } = await runProbe(cursorBin, cursorArgsPrefix, ["status"]);
        authenticated = parseAuthFromStatus(stdout);
      } catch {
        authenticated = null;
      }

      const models = await listModels(cursorBin, cursorArgsPrefix);

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
      return runCursorTurn(cursorBin, cursorArgsPrefix, input);
    },
  };
}

async function listModels(
  cursorBin: string,
  prefix: string[],
): Promise<Array<{ id: string; label: string }>> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.at < MODELS_CACHE_MS) {
    return modelsCache.models;
  }
  try {
    const { stdout, code } = await runProbe(cursorBin, prefix, ["--list-models"]);
    if (code === 0) {
      const parsed = parseModelsFromList(stdout);
      if (parsed.length > 0) {
        modelsCache = { at: now, models: parsed };
        return parsed;
      }
    }
  } catch {
    // fall through
  }
  return [{ id: "auto", label: "Auto" }];
}

function runProbe(
  cursorBin: string,
  prefix: string[],
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cursorBin, [...prefix, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, PROBE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
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

  let prompt = input.prompt;
  if (input.handoffContext) {
    prompt = `Earlier conversation in this thread, from another agent:\n\n${input.handoffContext}\n\n---\n\n${prompt}`;
  }

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

  const child = spawn(cursorBin, argv, {
    cwd: input.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const translator = new CursorTranslator(input.turnId, input.cwd);
  const splitter = createNdjsonSplitter();
  let stderr = "";
  let exitCode: number | null = null;
  let aborted = false;
  let doneYielded = false;

  const killOnAbort = () => {
    aborted = true;
    if (child.pid) {
      child.kill("SIGTERM");
      const pid = child.pid;
      setTimeout(() => {
        try {
          process.kill(pid, 0);
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, KILL_GRACE_MS);
    }
  };

  if (input.signal.aborted) {
    killOnAbort();
  } else {
    input.signal.addEventListener("abort", killOnAbort, { once: true });
  }

  const lineQueue: string[] = [];
  let resolveLine: (() => void) | null = null;
  const waitLine = () =>
    new Promise<void>((resolve) => {
      if (lineQueue.length > 0) resolve();
      else resolveLine = resolve;
    });

  child.stdout.on("data", (chunk: Buffer) => {
    const lines = splitter.push(chunk.toString());
    lineQueue.push(...lines);
    resolveLine?.();
    resolveLine = null;
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > STDERR_TAIL_MAX * 2) {
      stderr = stderr.slice(-STDERR_TAIL_MAX * 2);
    }
  });

  const closePromise = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(1));
  });

  for (;;) {
    if (lineQueue.length === 0) {
      if (exitCode !== null) break;
      await Promise.race([waitLine(), closePromise.then((c) => ((exitCode = c), undefined))]);
      if (lineQueue.length === 0 && exitCode !== null) break;
      if (lineQueue.length === 0 && input.signal.aborted) break;
      continue;
    }

    const line = lineQueue.shift();
    if (line === undefined) continue;
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    for (const event of translator.translate(parsed)) {
      if (event.type === "done") doneYielded = true;
      yield event;
    }
  }

  const tail = splitter.flush();
  if (tail?.trim()) {
    try {
      const parsed = JSON.parse(tail) as Record<string, unknown>;
      for (const event of translator.translate(parsed)) {
        if (event.type === "done") doneYielded = true;
        yield event;
      }
    } catch {
      // ignore partial JSON
    }
  }

  if (exitCode === null) exitCode = await closePromise;

  if (!doneYielded) {
    const stderrTail = stderr.length > 0 ? stderr.slice(-STDERR_TAIL_MAX) : null;
    for (const event of translator.finish(exitCode, stderrTail, aborted)) {
      yield event;
    }
  }
}
