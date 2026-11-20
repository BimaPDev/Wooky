import type { PeerProjectInfo, SyncSettings } from "@wooky/contracts";

const hasControl = (text: string) => [...text].some((char) => char.charCodeAt(0) < 32);

/**
 * A git remote reduced to what identifies the repository: no scheme, no credentials, no port,
 * no `.git`, lower case. `https://user:pw@GitHub.com/Me/App.git` and `git@github.com:me/app`
 * both become `github.com/me/app`. Returns null for anything that is not a remote address.
 * The result is only ever compared with another normalized remote; it is never fetched.
 */
export function normalizeRemoteUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = raw.trim();
  if (text.length === 0 || text.length > 2000 || /\s/.test(text) || hasControl(text)) return null;
  let host: string;
  let path: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(text);
  if (scheme) {
    text = text.slice(scheme[0].length);
    const slash = text.indexOf("/");
    if (slash < 0) return null;
    let authority = text.slice(0, slash);
    path = text.slice(slash + 1);
    const at = authority.lastIndexOf("@");
    if (at >= 0) authority = authority.slice(at + 1);
    // A port does not identify the repository; ssh and https differ in it.
    host = authority.startsWith("[")
      ? authority.slice(0, authority.indexOf("]") + 1)
      : (authority.split(":")[0] ?? "");
  } else {
    // Already normalized (`host.tld/owner/repo`), or scp-like: [user@]host:path
    const bare = /^([^@/:]+\.[^@/:]+)\/(.+)$/.exec(text);
    const match = bare ?? /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(text);
    if (!match) return null;
    host = match[1] ?? "";
    path = match[2] ?? "";
    // A single letter is a Windows drive, not a host.
    if (host.length < 2) return null;
  }
  path = (path.split(/[?#]/)[0] ?? "").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  host = host.toLowerCase();
  if (!host || !path) return null;
  const result = `${host}/${path.toLowerCase()}`;
  return result.length > 500 ? null : result;
}

/** The last segment of a folder path, with either kind of separator. Never returns a path. */
export function folderBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  return (parts.at(-1) ?? "").slice(0, 255);
}

export interface LocalProjectFacts {
  id: string;
  name: string;
  root: string;
  remote: string | null;
}

export type ProjectSuggestion = { projectId: string; by: "remote" | "folder" };

/**
 * Which local project a peer's project most likely is: the same normalized remote, else the
 * same folder name. `taken` lists local projects already mapped to some other peer project;
 * they are not offered. Ambiguous matches (two local projects tie) suggest nothing, because a
 * wrong one-click suggestion is worse than none.
 */
export function suggestLocalProject(
  peer: Pick<PeerProjectInfo, "folder" | "remote">,
  locals: readonly LocalProjectFacts[],
  taken: ReadonlySet<string> = new Set(),
): ProjectSuggestion | null {
  const free = locals.filter((local) => !taken.has(local.id));
  const remote = normalizeRemoteUrl(peer.remote);
  if (remote) {
    const hits = free.filter((local) => normalizeRemoteUrl(local.remote) === remote);
    if (hits.length === 1 && hits[0]) return { projectId: hits[0].id, by: "remote" };
    if (hits.length > 1) return null;
  }
  const folder = peer.folder.toLowerCase();
  if (folder) {
    const hits = free.filter((local) => folderBasename(local.root).toLowerCase() === folder);
    if (hits.length === 1 && hits[0]) return { projectId: hits[0].id, by: "folder" };
  }
  return null;
}

/**
 * `projectMap` with `sharedId` pointing at `root` on `deviceId`. A folder belongs to one shared
 * project, so any other entry of this device for the same folder is removed. A null root clears
 * this device's entry.
 */
export function withLocalMapping(
  map: SyncSettings["projectMap"],
  sharedId: string,
  deviceId: string,
  root: string | null,
  sameFolder: (a: string, b: string) => boolean,
): SyncSettings["projectMap"] {
  const next: SyncSettings["projectMap"] = {};
  for (const [key, devices] of Object.entries(map)) {
    const row = { ...devices };
    const mine = row[deviceId];
    if (key !== sharedId && root !== null && mine !== undefined && sameFolder(mine, root)) {
      delete row[deviceId];
    }
    if (Object.keys(row).length > 0) next[key] = row;
  }
  const row = { ...next[sharedId] };
  if (root === null) delete row[deviceId];
  else row[deviceId] = root;
  if (Object.keys(row).length > 0) next[sharedId] = row;
  else delete next[sharedId];
  return next;
}
