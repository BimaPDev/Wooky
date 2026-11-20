import { resolve } from "node:path";
import type { SyncSettings } from "@wooky/contracts";
import { localProject } from "../sync/project-map.ts";

const normalize = (path: string) => {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
};

/**
 * The project on this device that a thread's project id (the owner's id for it) stands for.
 *
 * The contract for `projectMap` is key → deviceId → folder path, and the sync engine reads it
 * that way, so a claim does too. A value that names a local project id is also accepted, and a
 * project with the same id as the owner's is the last resort.
 */
export function resolveLocalProjectId(
  projectId: string,
  deviceId: string,
  map: SyncSettings["projectMap"],
  projects: Readonly<Record<string, { id: string; root: string }>>,
): string | null {
  const list = Object.values(projects);
  const entry = map[projectId]?.[deviceId];
  if (entry !== undefined) {
    if (projects[entry]) return entry;
    const byPath = list.find((project) => normalize(project.root) === normalize(entry));
    if (byPath) return byPath.id;
  }
  return localProject(projectId, list, deviceId, map)?.id ?? null;
}

/** Whether any device in the map points a project of this model at `projectId`'s entry. */
export function projectIsMapped(
  projectId: string,
  map: SyncSettings["projectMap"],
  projects: Readonly<Record<string, { id: string; root: string }>>,
): boolean {
  if (projects[projectId]) return true;
  const entries = Object.values(map[projectId] ?? {});
  const roots = new Set(Object.values(projects).map((project) => normalize(project.root)));
  return entries.some((entry) => Boolean(projects[entry]) || roots.has(normalize(entry)));
}
