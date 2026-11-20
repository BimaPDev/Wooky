import type { Project, ReadModel, ReplicaSlice, Thread } from "@wooky/contracts";

const trimSeparators = (value: string) => value.replace(/[\\/]+$/, "");

/**
 * The local project for a peer's project. `settings.sync.projectMap` says which folder on this
 * device holds it; without an entry the same project id is used when it exists here.
 */
export function resolveLocalProject(
  peerProjectId: string,
  projects: Readonly<Record<string, Project>>,
  projectMap: Readonly<Record<string, Readonly<Record<string, string>>>>,
  localDeviceId: string | null,
): Project | null {
  const path = localDeviceId ? projectMap[peerProjectId]?.[localDeviceId] : undefined;
  if (path) {
    const match = Object.values(projects).find(
      (project) => trimSeparators(project.root) === trimSeparators(path),
    );
    if (match) return match;
  }
  return projects[peerProjectId] ?? null;
}

/** The server's refusal says the agent there is busy; only then is a forced move offered. */
export function isBusyReason(reason: string): boolean {
  return /\b(?:busy|still working|turn is (?:already )?running)\b/i.test(reason);
}

export type ClaimView =
  | { kind: "ready" }
  | { kind: "pending" }
  | { kind: "failed"; reason: string; canForce: boolean }
  | { kind: "done"; threadId: string };

/** Where a "continue on this device" request stands, from the model and the last failure. */
export function claimView(input: {
  ownerDeviceId: string;
  ownerThreadId: string;
  model: Pick<ReadModel, "threads" | "pendingClaims">;
  failure: string | undefined;
}): ClaimView {
  const { ownerDeviceId, ownerThreadId, model, failure } = input;
  const imported = Object.values(model.threads).find(
    (thread) =>
      thread.movedFrom?.deviceId === ownerDeviceId && thread.movedFrom.threadId === ownerThreadId,
  );
  if (imported) return { kind: "done", threadId: imported.id };
  const pending = Object.values(model.pendingClaims).some(
    (claim) => claim.ownerDeviceId === ownerDeviceId && claim.ownerThreadId === ownerThreadId,
  );
  if (pending) return { kind: "pending" };
  if (failure) return { kind: "failed", reason: failure, canForce: isBusyReason(failure) };
  return { kind: "ready" };
}

/** Newest first. */
export function peerThreads(slice: ReplicaSlice | undefined): Thread[] {
  return Object.values(slice?.threads ?? {}).toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}
