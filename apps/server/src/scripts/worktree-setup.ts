import type { PendingEvent, ProjectSettings, ReadModel, Worktree } from "@wooky/contracts";
import type { EventStore } from "../store/event-store.ts";
import type { TerminalManager, TerminalSubscriber } from "../terminal/session.ts";
import { resolveShellCommand } from "../terminal/shell.ts";
import { scriptArgv, setupScriptTitle } from "./run.ts";
import { applySharedPaths, type ApplySharedPathsResult } from "./shared-paths.ts";

export const silentTerminalSink: TerminalSubscriber = {
  send() {},
  bufferedAmount() {
    return 0;
  },
};

export interface WorktreeSetupInput {
  threadId: string;
  projectRoot: string;
  worktree: Worktree;
  store: EventStore;
  terminals: TerminalManager;
  newId: (prefix: string) => string;
  platform?: NodeJS.Platform;
}

/**
 * Apply shared paths, then start setup commands in their own terminals.
 * The agent's first turn does not wait for those commands to exit — they are
 * spawned and left running (or to finish) in parallel.
 */
export async function setupWorktree(input: WorktreeSetupInput): Promise<ApplySharedPathsResult> {
  const model: ReadModel = input.store.model;
  const thread = model.threads[input.threadId];
  const project = thread ? model.projects[thread.projectId] : undefined;
  const settings: ProjectSettings = project?.settings ?? {
    scripts: [],
    sharedPaths: [],
    prompts: [],
  };
  const shared = settings.sharedPaths ?? [];
  const applied = await applySharedPaths(
    input.projectRoot,
    input.worktree.path,
    shared,
    input.platform,
  );

  const toRun: { name: string; command: string; scriptId: string | null }[] = [];
  if (settings.worktreeSetup) {
    toRun.push({ name: "Setup", command: settings.worktreeSetup, scriptId: null });
  }
  for (const script of settings.scripts ?? []) {
    if (script.runOnWorktreeCreate) {
      toRun.push({ name: script.name, command: script.command, scriptId: script.id });
    }
  }

  const platform = input.platform ?? process.platform;
  const shell = resolveShellCommand(platform);
  for (const job of toRun) {
    try {
      await input.terminals.open(
        {
          cwd: input.worktree.path,
          projectId: project?.id ?? null,
          scriptId: job.scriptId,
          // The bare setup command is already called "Setup"; only scripts take the prefix.
          title: job.scriptId ? setupScriptTitle(job) : job.name,
          commandArgv: scriptArgv(shell, job.command, platform),
        },
        silentTerminalSink,
      );
    } catch (error) {
      console.error(`Could not start worktree setup "${job.name}"`, error);
    }
  }

  const notice = formatSetupNotice(
    applied,
    toRun.map((job) => job.name),
  );
  recordSetupNotice(input, notice);
  return applied;
}

export function formatSetupNotice(
  applied: ApplySharedPathsResult,
  running: readonly string[],
): string {
  const bits: string[] = [];
  if (applied.linked.length) bits.push(`linked ${applied.linked.join(", ")}`);
  if (applied.copied.length) bits.push(`copied ${applied.copied.join(", ")}`);
  if (applied.skipped.length) bits.push(`skipped ${applied.skipped.join(", ")}`);
  if (running.length) bits.push(`running ${running.join(", ")}`);
  return bits.length > 0 ? `Setting up worktree: ${bits.join("; ")}` : "Setting up worktree";
}

/**
 * Setup runs when the worktree is bound, which is before the thread has any turn. A notice with
 * no turn has nowhere to live, so it waits for the thread's first turn.
 */
const heldNotices = new Map<string, string[]>();

function setupNoticeEvent(input: WorktreeSetupInput, turnId: string, text: string): PendingEvent {
  return {
    type: "turn.itemUpserted",
    commandId: null,
    threadId: input.threadId,
    turnId,
    item: { kind: "notice", id: input.newId("notice"), text },
  };
}

function recordSetupNotice(input: WorktreeSetupInput, text: string) {
  const turns = input.store.model.turns[input.threadId] ?? [];
  const turn = turns.find((item) => item.status === "running") ?? turns.at(-1);
  if (turn) {
    input.store.appendInternal([setupNoticeEvent(input, turn.id, text)]);
    return;
  }
  const held = heldNotices.get(input.threadId) ?? [];
  held.push(text);
  heldNotices.set(input.threadId, held);
  const unsubscribe = input.store.subscribe((events) => {
    const started = events.find(
      (event) => event.type === "turn.started" && event.threadId === input.threadId,
    );
    if (!started || started.type !== "turn.started") return;
    unsubscribe();
    const pending = heldNotices.get(input.threadId) ?? [];
    heldNotices.delete(input.threadId);
    if (pending.length > 0) {
      input.store.appendInternal(
        pending.map((heldText) => setupNoticeEvent(input, started.turnId, heldText)),
      );
    }
  });
}
