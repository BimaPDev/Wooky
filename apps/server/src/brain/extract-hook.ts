import type { BrainSettings, ReadModel } from "@wooky/contracts";
import { fleetRows } from "@wooky/domain";
import { runExtraction, type ExtractDeps, type ExtractInput } from "./extract.ts";

export const EXTRACT_TIMEOUT_MS = 90_000;
/** A turn this small has nothing durable in it. */
const TRIVIAL_CHARS = 200;
const TRIVIAL_ANSWER_CHARS = 120;

export interface Extractor {
  /** Schedules extraction and returns at once. Never throws and never waits on the model. */
  onTurnFinished(input: ExtractInput): void;
  onFleetRunFinished(input: ExtractInput): void;
  /** Resolves when nothing is running. For tests. */
  idle(): Promise<void>;
  /** Aborts what is running and ignores later finishes. For shutdown. */
  stop(): void;
}

export function isTrivialTurn(input: ExtractInput): boolean {
  if (input.outcome !== "completed") return true;
  const reports = (input.workerReports ?? []).reduce(
    (sum, report) => sum + report.summary.length,
    0,
  );
  const size = input.prompt.length + input.finalMessage.length + reports;
  if (size < TRIVIAL_CHARS) return true;
  return (
    input.finalMessage.trim().length < TRIVIAL_ANSWER_CHARS &&
    input.changedFiles.length === 0 &&
    reports === 0
  );
}

/**
 * Runs the pipeline in the background, one extraction per thread at a time (a second finish
 * while one runs is dropped, not queued), bounded by a timeout. A failure is logged and never
 * reaches the turn.
 */
export function createExtractor(options: {
  deps: ExtractDeps;
  settings: () => Pick<BrainSettings, "extractProject" | "extractGlobal">;
  /** False for a project with no repo of its own (the hidden "No project"). */
  projectBrain?: (projectId: string) => boolean;
  timeoutMs?: number;
  log?: (message: string) => void;
}): Extractor {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const running = new Map<string, Promise<void>>();
  const controllers = new Set<AbortController>();
  let stopped = false;

  async function run(input: ExtractInput): Promise<void> {
    await Promise.resolve();
    const controller = new AbortController();
    if (stopped) return;
    controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timed out"));
      }, timeoutMs);
    });
    timedOut.catch(() => {});
    try {
      const flags = options.settings();
      const switches = {
        project: flags.extractProject && (options.projectBrain?.(input.projectId) ?? true),
        global: flags.extractGlobal,
      };
      const report = await Promise.race([
        runExtraction(options.deps, input, switches, controller.signal),
        timedOut,
      ]);
      if (report.written.length + report.proposed.length > 0) {
        log(
          `brain: extraction wrote ${report.written.length} and proposed ${report.proposed.length} memories for ${input.threadId}`,
        );
      }
    } catch (error) {
      log(
        `brain: extraction for ${input.threadId} failed (${error instanceof Error ? error.message : "error"})`,
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      controllers.delete(controller);
    }
  }

  function schedule(input: ExtractInput): void {
    try {
      if (stopped) return;
      const flags = options.settings();
      if (!flags.extractProject && !flags.extractGlobal) return;
      if (isTrivialTurn(input) || running.has(input.threadId)) return;
      const work = run(input).finally(() => {
        if (running.get(input.threadId) === work) running.delete(input.threadId);
      });
      running.set(input.threadId, work);
    } catch (error) {
      log(
        `brain: could not schedule extraction (${error instanceof Error ? error.message : "error"})`,
      );
    }
  }

  return {
    onTurnFinished: schedule,
    onFleetRunFinished: schedule,
    stop() {
      stopped = true;
      for (const controller of controllers) controller.abort();
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running.values()]);
    },
  };
}

/* ------------------------- from the read model to an input ------------------------- */

function assistantText(model: ReadModel, threadId: string, turnId: string): string {
  const turn = model.turns[threadId]?.find((candidate) => candidate.id === turnId);
  const last = (turn?.items ?? []).findLast(
    (item) => item.kind === "message" && item.role === "assistant",
  );
  return last?.kind === "message" ? last.text : "";
}

/**
 * What to extract from a thread's finished turn, or null. A worker's turn is part of its
 * coordinator's run, so it yields nothing on its own. A coordinator yields a fleet-run input once
 * its turn completed, its follow-up queue is empty and no worker is still working or waiting.
 */
export function inputForFinishedTurn(
  model: ReadModel,
  threadId: string,
  turnId: string,
): { kind: "turn" | "fleet"; input: ExtractInput } | null {
  const thread = model.threads[threadId];
  const turn = model.turns[threadId]?.find((candidate) => candidate.id === turnId);
  if (!thread || !turn || turn.status === "running") return null;
  if (thread.role === "worker" || thread.provider === "demo") return null;
  const base = {
    projectId: thread.projectId,
    threadId,
    turnId,
    agent: thread.provider,
    prompt: turn.prompt,
    finalMessage: assistantText(model, threadId, turnId),
    outcome: turn.status,
  } as const;
  const workers = Object.values(model.threads).filter((child) => child.parentThreadId === threadId);
  if (thread.role !== "coordinator" || workers.length === 0) {
    return { kind: "turn", input: { ...base, changedFiles: turn.changedFiles } };
  }
  if (thread.queue.length > 0) return null;
  const rows = new Map(fleetRows(model).map((row) => [row.threadId, row.status]));
  const status = (id: string) => rows.get(id) ?? "done";
  if (
    workers.some((worker) => status(worker.id) === "working" || status(worker.id) === "waiting")
  ) {
    return null;
  }
  const files = new Set(turn.changedFiles);
  for (const worker of workers) {
    for (const file of model.turns[worker.id]?.at(-1)?.changedFiles ?? []) files.add(file);
  }
  return {
    kind: "fleet",
    input: {
      ...base,
      fleetRunId: threadId,
      changedFiles: [...files],
      workerReports: workers.map((worker) => ({
        title: worker.title,
        status: status(worker.id),
        summary: worker.report?.summary ?? "",
      })),
    },
  };
}

/** The callback the effect runner calls after a turn's finish is recorded. */
export function createFinishHook(options: {
  extractor: Extractor;
  model: () => ReadModel;
  log?: (message: string) => void;
}): (finished: { threadId: string; turnId: string }) => void {
  return ({ threadId, turnId }) => {
    try {
      const found = inputForFinishedTurn(options.model(), threadId, turnId);
      if (found === null) return;
      if (found.kind === "fleet") options.extractor.onFleetRunFinished(found.input);
      else options.extractor.onTurnFinished(found.input);
    } catch (error) {
      options.log?.(
        `brain: extraction hook failed (${error instanceof Error ? error.message : "error"})`,
      );
    }
  };
}
