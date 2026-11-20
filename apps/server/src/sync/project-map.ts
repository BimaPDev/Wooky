import { resolve } from "node:path";
import type { SyncSettings } from "@wooky/contracts";
import type { SyncProject } from "./types.ts";

const normalize = (path: string) => {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
};

/**
 * Projects have different ids on different devices. A project's shared id is the
 * projectMap key whose entry for this device points at its folder, or its own id when no
 * entry does.
 */
export function sharedProjectId(
  project: SyncProject,
  deviceId: string,
  map: SyncSettings["projectMap"],
): string {
  const root = normalize(project.root);
  for (const [key, devices] of Object.entries(map)) {
    const path = devices[deviceId];
    if (path !== undefined && normalize(path) === root) return key;
  }
  return project.id;
}

/** The local project behind a shared id, or null when this device has not mapped it. */
export function localProject(
  shared: string,
  projects: readonly SyncProject[],
  deviceId: string,
  map: SyncSettings["projectMap"],
): SyncProject | null {
  for (const project of projects) {
    if (sharedProjectId(project, deviceId, map) === shared) return project;
  }
  return null;
}
