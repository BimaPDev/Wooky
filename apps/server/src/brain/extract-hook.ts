import type { BrainSettings, ReadModel, Thread } from "@wooky/contracts";
import { fleetRows } from "@wooky/domain";
import { runExtraction, type ExtractDeps, type ExtractInput } from "./extract.ts";

export const EXTRACT_TIMEOUT_MS = 90_000;
/** After one extraction for a project starts, the next waits this long. */
export const EXTRACT_COOLDOWN_MS = 60_000;
/** Jobs that may wait behind the running one; beyond this the oldest waiting job is dropped. */
export const EXTRACT_QUEUE_MAX = 3;
/** A turn this small has nothing durable in it. */
const TRIVIAL_CHARS = 200;
const TRIVIAL_ANSWER_CHARS = 120;
const COOLDOWN_TRACKED_MAX = 200;

export interface Extractor {
  /** Schedules extraction and returns at once. Never throws and never waits on the model. */
  onTurnFinished(input: ExtractInput): void;
  onFleetRunFinished(input: ExtractInput): void;
  /** Resolves when nothing is running or waiting. */
  idle(): Promise<void>;
  /**
   * For shutdown: stops, aborts what is running, then waits up to `ms` for it to settle. False
   * means something is still running; it keeps its slot until it settles.
   */
  drain(ms: number): Promise<boolean>;
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

interface Job {
  input: ExtractInput;
  /** Resolves the thread's slot. */
  settle: () => void;
}

/**
 * Runs the pipeline in the background. One extraction at a time across every thread, with a
 * small queue (the oldest waiting job is dropped past it), one job per thread (a second finish
 * while its thread has one is dropped) and a cooldown per project. A failure is logged and never
 * reaches the turn. A timeout frees the line but not the thread's slot: that stays until the
 * work actually settles.
 */
export function createExtractor(options: {
  deps: ExtractDeps;
  settings: () => Pick<BrainSettings, "extractProject" | "extractGlobal">;
  /** False for a project with no repo of its own (the hidden "No project"). */
  projectBrain?: (projectId: string) => boolean;
  /** Why no model can be used right now, or null. Checked before any brain is read. */
  unavailable?: () => string | null;
  timeoutMs?: number;
  cooldownMs?: number;
  queueMax?: number;
  now?: () => number;
  log?: (message: string) => void;
}): Extractor {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const cooldownMs = options.cooldownMs ?? EXTRACT_COOLDOWN_MS;
  const queueMax = options.queueMax ?? EXTRACT_QUEUE_MAX;
  const now = options.now ?? Date.now;
  const running = new Map<string, Promise<void>>();
  const queue: Job[] = [];
  const lastStart = new Map<string, number>();
  const controllers = new Set<AbortController>();
  let busy = false;
  let stopped = false;
  let skipLogged: string | null = null;

  async function execute(input: ExtractInput, freeLine: () => void): Promise<void> {
    await Promise.resolve();
    const controller = new AbortController();
    if (stopped) return;
    controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed out">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timed out");
      }, timeoutMs);
    });
    try {
      const flags = options.settings();
      const switches = {
        project: flags.extractProject && (options.projectBrain?.(input.projectId) ?? true),
        global: flags.extractGlobal,
      };
      const work = runExtraction(options.deps, input, switches, controller.signal).then(
        (report) => ({ report }),
        (error: unknown) => ({ error }),
      );
      const first = await Promise.race([work, timedOut]);
      if (first === "timed out") {
        log(`brain: extraction for ${input.threadId} failed (timed out)`);
        freeLine();
        const late = await work;
        if ("error" in late && !controller.signal.aborted) throw late.error;
      } else if ("error" in first) {
        throw first.error;
      } else if (first.report.written.length + first.report.proposed.length > 0) {
        log(
          `brain: extraction wrote ${first.report.written.length} and proposed ${first.report.proposed.length} memories for ${input.threadId}`,
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

  function pump(): void {
    if (busy || stopped) return;
    const job = queue.shift();
    if (job === undefined) return;
    busy = true;
    let freed = false;
    const freeLine = () => {
      if (freed) return;
      freed = true;
      busy = false;
      pump();
    };
    execute(job.input, freeLine)
      .catch(() => {})
      .finally(() => {
        freeLine();
        job.settle();
      });
  }

  function schedule(input: ExtractInput): void {
    try {
      if (stopped) return;
      const flags = options.settings();
      if (!flags.extractProject && !flags.extractGlobal) return;
      const unavailable = options.unavailable?.() ?? null;
      if (unavailable !== null) {
        if (skipLogged !== unavailable) log(`brain: extraction skipped (${unavailable})`);
        skipLogged = unavailable;
        return;
      }
      skipLogged = null;
      if (isTrivialTurn(input) || running.has(input.threadId)) return;
      const at = now();
      const last = lastStart.get(input.projectId);
      if (last !== undefined && at - last < cooldownMs) return;
      lastStart.delete(input.projectId);
      lastStart.set(input.projectId, at);
      if (lastStart.size > COOLDOWN_TRACKED_MAX) {
        const oldest = lastStart.keys().next().value;
        if (oldest !== undefined) lastStart.delete(oldest);
      }
      let settle: () => void = () => {};
      const slot = new Promise<void>((resolve) => {
        settle = resolve;
      });
      running.set(input.threadId, slot);
      void slot.then(() => {
        if (running.get(input.threadId) === slot) running.delete(input.threadId);
      });
      queue.push({ input, settle });
      pump();
      while (queue.length > queueMax) {
        const dropped = queue.shift();
        if (dropped === undefined) break;
        log(
          `brain: extraction queue full; dropped the oldest waiting job (${dropped.input.threadId})`,
        );
        dropped.settle();
      }
    } catch (error) {
      log(
        `brain: could not schedule extraction (${error instanceof Error ? error.message : "error"})`,
      );
    }
  }

  const api: Extractor = {
    onTurnFinished: schedule,
    onFleetRunFinished: schedule,
    stop() {
      stopped = true;
      for (const controller of controllers) controller.abort();
      for (const job of queue.splice(0)) job.settle();
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running.values()]);
    },
    async drain(ms) {
      api.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      });
      try {
        return await Promise.race([api.idle().then(() => true as const), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
  return api;
}

/* ------------------------- from the read model to an input ------------------------- */

function assistantText(model: ReadModel, threadId: string, turnId: string): string {
  const turn = model.turns[threadId]?.find((candidate) => candidate.id === turnId);
  const last = (turn?.items ?? []).findLast(
    (item) => item.kind === "message" && item.role === "assistant",
  );
  return last?.kind === "message" ? last.text : "";
}

/** Names one worker report, so a report is extracted once however often its run is revisited. */
const reportKey = (worker: Thread) =>
  worker.report === undefined ? null : `${worker.id}:${worker.report.turnId}`;

/**
 * What to extract from a thread's finished turn, or null. A worker's turn is part of its
 * coordinator's run, so it yields nothing on its own. A coordinator yields a fleet-run input once
 * its turn completed, its follow-up queue is empty and no worker is still working or waiting; it
 * carries only the worker reports not in `seenReports`, and when none is new the turn is
 * extracted on its own.
 */
export function inputForFinishedTurn(
  model: ReadModel,
  threadId: string,
  turnId: string,
  seenReports: ReadonlySet<string> = new Set(),
): { kind: "turn" | "fleet"; input: ExtractInput; reportKeys: string[] } | null {
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
  const solo = () => ({
    kind: "turn" as const,
    input: { ...base, changedFiles: turn.changedFiles },
    reportKeys: [],
  });
  const workers = Object.values(model.threads).filter((child) => child.parentThreadId === threadId);
  if (thread.role !== "coordinator" || workers.length === 0) return solo();
  if (thread.queue.length > 0) return null;
  const rows = new Map(fleetRows(model).map((row) => [row.threadId, row.status]));
  const status = (id: string) => rows.get(id) ?? "done";
  if (
    workers.some((worker) => status(worker.id) === "working" || status(worker.id) === "waiting")
  ) {
    return null;
  }
  const fresh = workers.filter((worker) => {
    const key = reportKey(worker);
    return key !== null && !seenReports.has(key);
  });
  if (fresh.length === 0) return solo();
  const files = new Set(turn.changedFiles);
  for (const worker of fresh) {
    for (const file of model.turns[worker.id]?.at(-1)?.changedFiles ?? []) files.add(file);
  }
  return {
    kind: "fleet",
    input: {
      ...base,
      fleetRunId: threadId,
      changedFiles: [...files],
      workerReports: fresh.map((worker) => ({
        title: worker.title,
        status: status(worker.id),
        summary: worker.report?.summary ?? "",
      })),
    },
    reportKeys: fresh.flatMap((worker) => reportKey(worker) ?? []),
  };
}

const HANDLED_MAX = 500;

/**
 * The callback the effect runner calls after a turn's finish is recorded. It remembers which
 * turns and worker reports it has handed on, so a run is extracted once and a later one only
 * sees its new reports.
 */
export function createFinishHook(options: {
  extractor: Extractor;
  model: () => ReadModel;
  log?: (message: string) => void;
}): (finished: { threadId: string; turnId: string }) => void {
  const seenTurns = new Set<string>();
  const seenReports = new Set<string>();
  const remember = (set: Set<string>, key: string) => {
    set.add(key);
    if (set.size > HANDLED_MAX) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  };
  return ({ threadId, turnId }) => {
    try {
      const turnKey = `${threadId}:${turnId}`;
      if (seenTurns.has(turnKey)) return;
      const found = inputForFinishedTurn(options.model(), threadId, turnId, seenReports);
      if (found === null) return;
      remember(seenTurns, turnKey);
      for (const key of found.reportKeys) remember(seenReports, key);
      if (found.kind === "fleet") options.extractor.onFleetRunFinished(found.input);
      else options.extractor.onTurnFinished(found.input);
    } catch (error) {
      options.log?.(
        `brain: extraction hook failed (${error instanceof Error ? error.message : "error"})`,
      );
    }
  };
}
