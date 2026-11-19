import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "@wooky/contracts";
import { ServiceError } from "./errors.ts";
import { initRepo } from "./git/init-repo.ts";
import type { Dispatcher } from "./orchestrator/dispatcher.ts";
import type { EventStore } from "./store/event-store.ts";

export interface ScratchService {
  /** The hidden "No project" project, created on first use. */
  ensure(): Promise<{ projectId: string }>;
}

export const SCRATCH_DIR = "scratch";

/**
 * Threads need a project. "No project" is a git-initialised folder under the state directory,
 * registered once as a project flagged `scratch`. Concurrent calls share one creation.
 */
export function createScratchService(deps: {
  home: string;
  store: Pick<EventStore, "model">;
  dispatcher: Pick<Dispatcher, "dispatch">;
  init?: (dir: string) => Promise<void>;
}): ScratchService {
  const { home, store, dispatcher } = deps;
  const init = deps.init ?? initRepo;
  const find = (): Project | undefined =>
    Object.values(store.model.projects).find((project) => project.scratch === true);
  let inflight: Promise<{ projectId: string }> | null = null;

  const create = async () => {
    const existing = find();
    if (existing) return { projectId: existing.id };
    const root = join(home, SCRATCH_DIR);
    try {
      await mkdir(root, { recursive: true });
      await init(root);
    } catch (error) {
      throw new ServiceError(
        "unavailable",
        `Could not prepare the scratch folder: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    dispatcher.dispatch({
      type: "project.add",
      commandId: `scratch:${randomUUID()}`,
      root,
      name: "No project",
      scratch: true,
    });
    const created = find();
    if (!created) throw new ServiceError("internal", "The scratch project was not created.");
    return { projectId: created.id };
  };

  return {
    ensure() {
      inflight ??= create().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
