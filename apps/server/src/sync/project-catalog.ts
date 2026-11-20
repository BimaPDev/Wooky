import { PeerProjectInfo, type SyncPeerProject, type SyncSettings } from "@wooky/contracts";
import {
  folderBasename,
  normalizeRemoteUrl,
  suggestLocalProject,
  type LocalProjectFacts,
} from "@wooky/domain";
import { readProjectGitFacts, type ProjectGitFacts } from "../git/project-info.ts";
import { localProject, sharedProjectId } from "./project-map.ts";
import type { SyncProject } from "./types.ts";

/** Most projects taken from one peer. Peer data is untrusted. */
export const MAX_PEER_PROJECTS = 200;
const FACTS_TTL_MS = 30_000;

/**
 * Clips the free-text fields a peer sent to their caps, and re-normalizes its remote so that
 * credentials in it are dropped here no matter what the peer did. Anything else that does not
 * fit the schema makes the entry invalid, and the entry is dropped.
 */
function tidy(item: unknown): unknown {
  if (typeof item !== "object" || item === null) return item;
  const raw = item as Record<string, unknown>;
  const clip = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : value);
  return {
    ...raw,
    name: clip(raw.name),
    branch: clip(raw.branch),
    remote: typeof raw.remote === "string" ? normalizeRemoteUrl(raw.remote) : null,
  };
}

/**
 * What this device tells peers about its projects, and what peers told it. The catalog is the
 * only place peer-supplied project data is read: each entry is validated and size-capped, and
 * nothing in it is ever treated as a local path.
 */
export function createProjectCatalog(deps: {
  deviceId: string;
  projects(): SyncProject[];
  map(): SyncSettings["projectMap"];
  facts?: (root: string) => Promise<ProjectGitFacts>;
  now?: () => number;
}) {
  const readFacts = deps.facts ?? ((root: string) => readProjectGitFacts(root));
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { root: string; at: number; facts: ProjectGitFacts }>();
  const peers = new Map<string, PeerProjectInfo[]>();

  const live = () => deps.projects().filter((project) => !project.scratch);

  async function refreshLocal(): Promise<void> {
    await Promise.all(
      live().map(async (project) => {
        const hit = cache.get(project.id);
        if (hit && hit.root === project.root && now() - hit.at < FACTS_TTL_MS) return;
        const facts = await readFacts(project.root).catch(() => ({ remote: null, branch: null }));
        cache.set(project.id, { root: project.root, at: now(), facts });
      }),
    );
  }

  /** The projects this device offers, with what is needed to match them elsewhere. */
  async function served(): Promise<PeerProjectInfo[]> {
    await refreshLocal();
    const map = deps.map();
    return live()
      .slice(0, MAX_PEER_PROJECTS)
      .map((project) => {
        const facts = cache.get(project.id)?.facts;
        return {
          id: project.id,
          sharedId: sharedProjectId(project, deps.deviceId, map),
          name: (project.name ?? folderBasename(project.root)).slice(0, 200),
          // The folder's name only. A full path stays on this device.
          folder: folderBasename(project.root),
          remote: facts?.remote ?? null,
          branch: facts?.branch ?? null,
        };
      });
  }

  /** Takes a peer's answer. Returns whether the stored list changed. */
  function accept(deviceId: string, raw: unknown): boolean {
    const list = Array.isArray(raw) ? raw.slice(0, MAX_PEER_PROJECTS) : [];
    const seen = new Set<string>();
    const clean: PeerProjectInfo[] = [];
    for (const item of list) {
      const parsed = PeerProjectInfo.safeParse(tidy(item));
      if (!parsed.success || seen.has(parsed.data.id)) continue;
      seen.add(parsed.data.id);
      clean.push(parsed.data);
    }
    const changed = JSON.stringify(peers.get(deviceId) ?? []) !== JSON.stringify(clean);
    peers.set(deviceId, clean);
    return changed;
  }

  function forget(deviceId: string) {
    peers.delete(deviceId);
  }

  /** A peer's projects as this device sees them: mapped here or not, and a suggestion. */
  function view(deviceId: string): SyncPeerProject[] {
    const infos = peers.get(deviceId) ?? [];
    if (infos.length === 0) return [];
    const map = deps.map();
    const locals: LocalProjectFacts[] = live().map((project) => ({
      id: project.id,
      name: project.name ?? folderBasename(project.root),
      root: project.root,
      remote: cache.get(project.id)?.facts.remote ?? null,
    }));
    const mapped = infos.map(
      (info) => localProject(info.sharedId, live(), deps.deviceId, map)?.id ?? null,
    );
    const taken = new Set(mapped.filter((id): id is string => id !== null));
    return infos.map((info, index) => ({
      ...info,
      mappedTo: mapped[index] ?? null,
      suggestion:
        mapped[index] === null || mapped[index] === undefined
          ? suggestLocalProject(info, locals, taken)
          : null,
    }));
  }

  /** The local project a peer's project (by the peer's own id or its shared id) is mapped to. */
  function localFor(deviceId: string, peerProjectId: string): string | null {
    const info = (peers.get(deviceId) ?? []).find(
      (item) => item.id === peerProjectId || item.sharedId === peerProjectId,
    );
    if (!info) return null;
    return localProject(info.sharedId, live(), deps.deviceId, deps.map())?.id ?? null;
  }

  return { refreshLocal, served, accept, forget, view, localFor };
}
