import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgeEvent, AgeEventOf, AgeEventType, FileDiff, Worktree } from "@age/contracts";
import type { GitService } from "./git/types.ts";
import type { DecideContext } from "./orchestrator/decide.ts";
import type { EventStore } from "./store/event-store.ts";

export function tempDir(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `age-${label}-`));
}

/** Deterministic ids and clock for tests. */
export function testContext(
  capabilities: DecideContext["capabilities"] = () => undefined,
): DecideContext {
  let counter = 0;
  return {
    now: () => "2026-01-01T00:00:00.000Z",
    newId: (prefix) => `${prefix}-${++counter}`,
    capabilities,
  };
}

/** Resolves with the first event (already stored or still to come) of a type that matches. */
export function waitForEvent<T extends AgeEventType>(
  store: EventStore,
  type: T,
  predicate: (event: AgeEventOf<T>) => boolean = () => true,
  afterSeq = 0,
): Promise<AgeEventOf<T>> {
  const matches = (event: AgeEvent): event is AgeEventOf<T> =>
    event.type === type && event.seq > afterSeq && predicate(event as AgeEventOf<T>);
  return new Promise((resolve) => {
    // Subscribe before scanning history so nothing can land in between.
    const unsubscribe = store.subscribe((events) => {
      const found = events.find(matches);
      if (!found) return;
      unsubscribe();
      resolve(found);
    });
    const existing = store.eventsAfter(afterSeq).find(matches);
    if (existing) {
      unsubscribe();
      resolve(existing);
    }
  });
}

/** In-memory git: every directory is a repo; checkpoints and calls are recorded. */
export function createFakeGit(options: { changed?: string[] } = {}) {
  const calls: string[] = [];
  const git: GitService = {
    isRepo: async () => true,
    async createWorktree(projectRoot, threadId): Promise<Worktree> {
      calls.push(`createWorktree ${threadId}`);
      const path = join(projectRoot, ".worktrees", threadId);
      mkdirSync(path, { recursive: true });
      return { path, branch: `age/${threadId}` };
    },
    async removeWorktree(_root, worktree) {
      calls.push(`removeWorktree ${worktree.path}`);
    },
    async captureCheckpoint(_cwd, ref) {
      calls.push(`capture ${ref}`);
      return ref;
    },
    async restoreCheckpoint(_cwd, ref) {
      calls.push(`restore ${ref}`);
    },
    listFiles: async () => [],
    async diff(_cwd, from, to): Promise<FileDiff[]> {
      calls.push(`diff ${from} ${to}`);
      return (options.changed ?? ["AGE_DEMO.md"]).map((path) => ({
        path,
        status: "modified",
        additions: 1,
        deletions: 0,
      }));
    },
  };
  return { git, calls };
}
