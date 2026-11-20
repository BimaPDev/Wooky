import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type FileDiff,
  type Snapshot,
  type SnapshotReason,
  type SyncConflict,
  type SyncPeerState,
  type SyncPush,
  type SyncStatus,
  type RpcParams,
  type ConflictResolution,
} from "@wooky/contracts";
import { z } from "zod";
import { ServiceError } from "../errors.ts";
import {
  ApplyFailed,
  createShadowGit,
  EMPTY_TREE,
  safeRelativePath,
  type ShadowRepo,
} from "../git/shadow.ts";
import { createConflictStore } from "./conflicts.ts";
import { decodeMeta, encodeMeta, toSnapshot, type SnapshotMeta } from "./meta.ts";
import { localProject, sharedProjectId } from "./project-map.ts";
import type { PeerRecord as PeerEntry } from "../remote/peers.ts";
import type { SyncDeps, SyncProject, SyncTimers } from "./types.ts";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const MAX_APPLY_BYTES = 1024 * 1024 * 1024;
const RETENTION_START_MS = 10 * 60_000;
const RETENTION_EVERY_MS = 24 * 60 * 60_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[0-9a-f]{7,64}$/;
const LIST_DEFAULT = 50;
const CHAIN_CAP = 2000;
const MIN_MERGE_GIT: [number, number] = [2, 40];

const TipList = z.array(z.object({ projectId: z.string().min(1), tip: z.string().regex(SHA) }));

const realTimers: SyncTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

type ApplyOutcome = "applied" | "noop" | "queued" | "conflict";
type SnapshotMetaInput = {
  threadId?: string | null;
  turnId?: string | null;
  label?: string | null;
};

interface PeerRuntime {
  state: SyncPeerState;
  lastSyncAt: string | null;
  error: string | null;
}

class NetworkError extends Error {}

export function createSyncEngine(deps: SyncDeps) {
  const git = createShadowGit(deps.gitBin ? { gitBin: deps.gitBin } : {});
  const now = deps.now ?? (() => new Date());
  const timers = deps.timers ?? realTimers;
  const doFetch = deps.fetch ?? fetch;
  const conflicts = createConflictStore(deps.home);
  const listeners = new Set<(push: SyncPush) => void>();
  const peerRuntime = new Map<string, PeerRuntime>();
  const queued = new Set<string>();
  const fingerprints = new Map<string, string>();
  const reportedSkips = new Map<string, string>();
  const locks = new Map<string, Promise<unknown>>();
  const writing = new Map<string, number>();
  const known = new Map<string, { peer: string | null; applied: string | null }>();
  const activeBundles = new Map<string, number>();
  const shared = new AbortController();
  const maxFileBytes = deps.maxFileBytes ?? MAX_FILE_BYTES;
  const maxApplyBytes = deps.maxApplyBytes ?? MAX_APPLY_BYTES;
  const myRef = `refs/wooky/snap/${deps.deviceId}`;
  let mergeSupported: Promise<boolean> | null = null;
  let scanTimer: unknown = null;
  let scanEverySec = 0;
  let retentionStart: unknown = null;
  let retentionTimer: unknown = null;
  let ticking = false;
  let stopped = false;

  const settings = () => deps.settings().sync;
  const filesOn = () => settings().enabled && settings().categories.files;
  const notice = (projectId: string, message: string) => deps.notice?.(projectId, message);
  const emit = (push: SyncPush) => {
    for (const listener of listeners) listener(push);
  };

  function canMerge(): Promise<boolean> {
    mergeSupported ??= git.version().then((v) => {
      if (!v) return false;
      const [major, minor] = v;
      const ok =
        major > MIN_MERGE_GIT[0] || (major === MIN_MERGE_GIT[0] && minor >= MIN_MERGE_GIT[1]);
      if (!ok) {
        notice(
          "",
          `Git ${v.join(".")} is older than ${MIN_MERGE_GIT.join(".")}; every divergent sync will ask you to resolve a conflict.`,
        );
      }
      return ok;
    });
    return mergeSupported;
  }

  function repoFor(project: SyncProject): ShadowRepo {
    if (!SAFE_ID.test(project.id)) {
      throw new ServiceError("bad_request", `Project id "${project.id}" cannot be synced.`);
    }
    return {
      gitDir: join(deps.home, "sync", `${project.id}.git`),
      workTree: resolve(project.root),
    };
  }

  /** The Wooky home is never part of a snapshot when it sits inside the project. */
  function exclusions(project: SyncProject): string[] {
    const rel = relative(resolve(project.root), resolve(deps.home));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
    return [rel.split(sep).join("/")];
  }

  function lock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(projectId) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    locks.set(projectId, tail);
    void tail.then(() => {
      if (locks.get(projectId) === tail) locks.delete(projectId);
    });
    return result;
  }

  function syncProjects(): SyncProject[] {
    return deps.projects().filter((project) => !project.scratch);
  }

  function projectById(id: string): SyncProject {
    const found = deps.projects().find((project) => project.id === id);
    if (!found) throw new ServiceError("not_found", `Project ${id} was not found.`);
    return found;
  }

  function requireFiles() {
    if (!filesOn()) throw new ServiceError("conflict", "File sync is turned off.");
  }

  function assertNoTurn(project: SyncProject, action: string) {
    if (deps.turnRunning(project.id)) {
      throw new ServiceError(
        "conflict",
        `A turn is running in this project. ${action} after it finishes.`,
      );
    }
  }

  /**
   * Raised synchronously, before the first await, by every operation that writes into a
   * project folder. The dispatcher refuses `turn.start` while it is up.
   */
  function beginWrite(projectId: string) {
    writing.set(projectId, (writing.get(projectId) ?? 0) + 1);
  }

  function endWrite(projectId: string) {
    const left = (writing.get(projectId) ?? 1) - 1;
    if (left > 0) return void writing.set(projectId, left);
    writing.delete(projectId);
    deps.onWritingEnd?.(projectId);
  }

  /** Held while a snapshot id is still being traced to its project (restore). */
  let writingAny = 0;
  const isWriting = (projectId: string) => writingAny > 0 || (writing.get(projectId) ?? 0) > 0;

  function scanOptions(project: SyncProject) {
    const own = join(resolve(project.root), ".git", "info", "exclude");
    return {
      includeIgnored: settings().categories.ignoredFiles,
      exclude: exclusions(project),
      maxFileBytes,
      ...(existsSync(own) ? { excludeFrom: own } : {}),
    };
  }

  /** Thrown when the project changed under an apply; the caller retries later. */
  class AbortWrite extends Error {
    constructor(readonly kind: "turn" | "drift") {
      super(kind === "turn" ? "A turn started." : "Files changed while writing.");
    }
  }

  async function syncModeChanged(repo: ShadowRepo): Promise<void> {
    const file = join(repo.gitDir, "wooky-ignored");
    const wanted = settings().categories.ignoredFiles ? "1" : "0";
    const current = await readFile(file, "utf8").catch(() => null);
    if (current === wanted) return;
    await git.dropIndex(repo);
    await writeFile(file, wanted);
  }

  // ── snapshots ────────────────────────────────────────────────────────────────────────

  interface Taken {
    snapshot: Snapshot | null;
    /** The tip after the call: the new commit, or the unchanged previous one. */
    tip: string | null;
    /** Stat fingerprint of the folder as snapshotted. */
    fingerprint: string;
  }

  async function takeSnapshot(
    project: SyncProject,
    reason: SnapshotReason,
    input: SnapshotMetaInput,
    options: { gate?: boolean; ensureTip?: boolean; fresh?: boolean } = {},
  ): Promise<Taken> {
    const repo = repoFor(project);
    if (!existsSync(repo.workTree)) {
      throw new ServiceError("not_found", `The project folder ${repo.workTree} does not exist.`);
    }
    await git.ensure(repo);
    await syncModeChanged(repo);
    // A backup must see the real bytes, so it never trusts the stat cache.
    if (options.fresh) await git.dropIndex(repo);
    const scan = await git.scan(repo, scanOptions(project));
    const skippedPaths = scan.skipped.map((item) => item.path);
    const skipKey = skippedPaths.join("\0");
    if (skipKey !== (reportedSkips.get(project.id) ?? "")) {
      reportedSkips.set(project.id, skipKey);
      for (const item of scan.skipped) {
        notice(
          project.id,
          `Skipped ${item.path}: ${Math.round(item.bytes / 1024 / 1024)} MB is over the ${Math.round(maxFileBytes / 1024 / 1024)} MB sync limit.`,
        );
      }
    }
    const tip = await git.rev(repo, myRef);
    if (options.gate && tip && fingerprints.get(project.id) === scan.fingerprint) {
      return { snapshot: null, tip, fingerprint: scan.fingerprint };
    }
    const tree = await git.stage(repo, scan);
    fingerprints.set(project.id, scan.fingerprint);
    if (tip && tree === (await git.treeOf(repo, tip))) {
      return { snapshot: null, tip, fingerprint: scan.fingerprint };
    }
    if (!tip && tree === EMPTY_TREE && !options.ensureTip) {
      return { snapshot: null, tip: null, fingerprint: scan.fingerprint };
    }

    const head = await git.projectHead(repo.workTree);
    const meta: SnapshotMeta = {
      deviceId: deps.deviceId,
      reason,
      at: now().toISOString(),
      threadId: input.threadId ?? null,
      turnId: input.turnId ?? null,
      label: input.label ?? null,
      head: head?.head ?? null,
      branch: head?.branch ?? null,
      skipped: skippedPaths,
    };
    const id = await git.commit(repo, {
      tree,
      parent: tip,
      message: encodeMeta(meta),
      identity: { name: "Wooky", at: Date.parse(meta.at) / 1000 },
    });
    await git.updateRef(repo, myRef, id, tip);
    const summary = await git.diffStat(repo, tip ?? EMPTY_TREE, id);
    const created = toSnapshot(project.id, { id, parentId: tip, summary }, meta);
    emit({ push: "sync", kind: "snapshot", snapshot: created });
    return { snapshot: created, tip: id, fingerprint: scan.fingerprint };
  }

  async function snapshotAt(project: SyncProject, sha: string): Promise<Snapshot | null> {
    const repo = repoFor(project);
    const [entry] = await git.log(repo, sha, 1);
    if (!entry) return null;
    const meta = decodeMeta(entry.message);
    return meta ? toSnapshot(project.id, entry, meta) : null;
  }

  function snapshot(
    projectId: string,
    reason: SnapshotReason,
    input: SnapshotMetaInput = {},
    options: { gate?: boolean } = {},
  ): Promise<Snapshot | null> {
    const project = projectById(projectId);
    return lock(
      project.id,
      async () => (await takeSnapshot(project, reason, input, options)).snapshot,
    );
  }

  async function createSnapshot(projectId: string, label?: string): Promise<Snapshot> {
    requireFiles();
    const project = projectById(projectId);
    return lock(project.id, async () => {
      const taken = await takeSnapshot(
        project,
        "manual",
        { label: label ?? null },
        { ensureTip: true },
      );
      const found = taken.snapshot ?? (taken.tip ? await snapshotAt(project, taken.tip) : null);
      if (!found) throw new ServiceError("internal", "The snapshot could not be read back.");
      return found;
    });
  }

  /** Returns the project and commit behind a snapshot id, searching every known project. */
  async function locate(snapshotId: string): Promise<{ project: SyncProject; commit: string }> {
    if (!SHA.test(snapshotId)) throw new ServiceError("bad_request", "Not a snapshot id.");
    for (const project of syncProjects()) {
      let repo: ShadowRepo;
      try {
        repo = repoFor(project);
      } catch {
        continue;
      }
      const commit = await git.rev(repo, snapshotId).catch(() => null);
      if (commit) return { project, commit };
    }
    throw new ServiceError("not_found", `Snapshot ${snapshotId} was not found.`);
  }

  async function list(params: RpcParams<"sync.snapshots.list">): Promise<Snapshot[]> {
    if (params.kind && params.kind !== "files") return [];
    const limit = params.limit ?? LIST_DEFAULT;
    const projects = params.projectId
      ? syncProjects().filter((p) => p.id === params.projectId)
      : syncProjects();
    const all: Snapshot[] = [];
    for (const project of projects) {
      let repo: ShadowRepo;
      try {
        repo = repoFor(project);
      } catch {
        continue;
      }
      for (const entry of await git.log(repo, myRef, CHAIN_CAP)) {
        const meta = decodeMeta(entry.message);
        if (!meta) continue;
        if (params.threadId && meta.threadId !== params.threadId) continue;
        all.push(toSnapshot(project.id, entry, meta));
      }
    }
    all.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1));
    let start = 0;
    if (params.before) {
      const at = all.findIndex((item) => item.id === params.before);
      start = at < 0 ? all.length : at + 1;
    }
    return all.slice(start, start + limit);
  }

  async function diff(params: RpcParams<"sync.snapshots.diff">): Promise<FileDiff[]> {
    const { project, commit } = await locate(params.snapshotId);
    const repo = repoFor(project);
    let from: string;
    if (params.against === "working") {
      from = await lock(project.id, async () => {
        return git.stage(repo, await git.scan(repo, scanOptions(project)));
      });
    } else if (params.against) {
      const other = SHA.test(params.against) ? await git.rev(repo, params.against) : null;
      if (!other) throw new ServiceError("not_found", `Snapshot ${params.against} was not found.`);
      from = other;
    } else {
      const [entry] = await git.log(repo, commit, 1);
      from = entry?.parentId ?? EMPTY_TREE;
    }
    return git.diff(repo, from, commit);
  }

  function matchesPaths(path: string, wanted: readonly string[]): boolean {
    return wanted.some((item) => path === item || path.startsWith(`${item}/`));
  }

  /**
   * The one place that writes a tree into a project folder. The caller has already taken the
   * backup. Aborts, without writing, when a turn started or a file changed since the backup.
   */
  async function writeTree(
    project: SyncProject,
    repo: ShadowRepo,
    input: { backup: Taken; mineTree: string; targetTree: string; paths?: readonly string[] },
  ) {
    let changed = await git.changes(repo, input.mineTree, input.targetTree);
    const only = input.paths;
    if (only) changed = changed.filter((change) => matchesPaths(change.path, only));
    if (deps.turnRunning(project.id)) throw new AbortWrite("turn");
    const current = await git.scan(repo, scanOptions(project));
    if (current.fingerprint !== input.backup.fingerprint) throw new AbortWrite("drift");
    // The scan takes a moment; a turn that won the race in the meantime must still win.
    if (deps.turnRunning(project.id)) throw new AbortWrite("turn");
    let report;
    try {
      report = await git.applyChanges(repo, input.targetTree, changed, {
        exclude: exclusions(project),
        mineTree: input.mineTree,
        maxFileBytes,
        maxTotalBytes: maxApplyBytes,
      });
    } catch (error) {
      if (!(error instanceof ApplyFailed)) throw error;
      fingerprints.delete(project.id);
      await git.dropIndex(repo);
      const after = await git.stage(repo, await git.scan(repo, scanOptions(project)));
      throw new ServiceError(
        "unavailable",
        after === input.mineTree
          ? `${error.reason} Restored your previous files.`
          : `${error.reason} Some files may be partly changed; the backup snapshot has your originals.`,
      );
    }
    fingerprints.delete(project.id);
    for (const item of report.skipped) {
      notice(
        project.id,
        item.reason === "local-only"
          ? `Kept your local ${item.path}: it is not in a snapshot, so the incoming copy was not written.`
          : item.reason === "too-large"
            ? `Skipped incoming ${item.path}: it is over the ${Math.round(maxFileBytes / 1024 / 1024)} MB sync limit.`
            : `Skipped incoming ${item.path}: the path is not allowed.`,
      );
    }
    return report;
  }

  function abortAsError(error: unknown, action: string): unknown {
    if (!(error instanceof AbortWrite)) return error;
    return new ServiceError(
      "conflict",
      error.kind === "turn"
        ? `A turn started in this project. ${action} after it finishes.`
        : "Files changed while writing. Nothing was changed; try again.",
    );
  }

  async function restore(params: RpcParams<"sync.snapshots.restore">) {
    // The project is unknown until the snapshot is found, so every project counts as busy
    // from the first synchronous moment.
    writingAny += 1;
    let located: Awaited<ReturnType<typeof locate>>;
    try {
      located = await locate(params.snapshotId);
      assertNoTurn(located.project, "Restore");
      beginWrite(located.project.id);
    } finally {
      writingAny -= 1;
    }
    const { project, commit } = located;
    try {
      const wanted = (params.paths ?? []).map((raw) => {
        const clean = safeRelativePath(raw.replace(/\/+$/, ""));
        if (clean === null) throw new ServiceError("bad_request", `Path "${raw}" is not valid.`);
        return clean;
      });
      return await lock(project.id, async () => {
        const repo = repoFor(project);
        const backup = await takeSnapshot(
          project,
          "before-apply",
          { label: "Before restore" },
          { ensureTip: true, fresh: true },
        );
        if (!backup.tip) throw new ServiceError("internal", "The backup snapshot is missing.");
        const [from, to] = await Promise.all([
          git.treeOf(repo, backup.tip),
          git.treeOf(repo, commit),
        ]);
        try {
          await writeTree(project, repo, {
            backup,
            mineTree: from,
            targetTree: to,
            ...(params.paths ? { paths: wanted } : {}),
          });
        } catch (error) {
          throw abortAsError(error, "Restore");
        }
        await takeSnapshot(project, "revert", { label: `Restored ${commit.slice(0, 8)}` });
        return { backupSnapshotId: backup.tip };
      });
    } finally {
      endWrite(project.id);
    }
  }

  // ── peers: pull and apply ───────────────────────────────────────────────────────────

  function peerStatus(deviceId: string): SyncStatus["peers"][number] {
    const runtime = peerRuntime.get(deviceId);
    return {
      deviceId,
      name: deps.peers.get(deviceId)?.name ?? deviceId,
      state: runtime?.state ?? "idle",
      lastSyncAt: runtime?.lastSyncAt ?? null,
      error: runtime?.error ?? null,
    };
  }

  function status(): SyncStatus {
    return {
      enabled: settings().enabled,
      peers: settings().peers.map(peerStatus),
      conflicts: conflicts.list(),
    };
  }

  function emitStatus() {
    emit({ push: "sync", kind: "status", ...status() });
  }

  function setPeer(deviceId: string, patch: Partial<PeerRuntime>) {
    const current = peerRuntime.get(deviceId) ?? { state: "idle", lastSyncAt: null, error: null };
    const next = { ...current, ...patch };
    peerRuntime.set(deviceId, next);
    if (next.state !== current.state || next.error !== current.error) emitStatus();
  }

  const appliedRef = (peer: string) => `refs/wooky/applied/${peer}`;
  const peerRef = (peer: string) => `refs/wooky/peer/${peer}`;
  const queueKey = (projectId: string, peer: string) => `${projectId}\0${peer}`;

  interface ApplyResult {
    outcome: ApplyOutcome | "retry";
    skipped: Array<{ path: string; reason: string }>;
  }

  async function holdConflict(repo: ShadowRepo, conflict: SyncConflict) {
    for (const sha of [conflict.mine, conflict.theirs, conflict.base]) {
      if (sha) await git.holdRef(repo, sha, true);
    }
  }

  async function releaseConflict(repo: ShadowRepo, conflict: SyncConflict) {
    const still = new Set(
      conflicts
        .list()
        .filter((c) => c.id !== conflict.id)
        .flatMap((c) => [c.mine, c.theirs, c.base]),
    );
    for (const sha of [conflict.mine, conflict.theirs, conflict.base]) {
      if (sha && !still.has(sha)) await git.holdRef(repo, sha, false);
    }
  }

  async function applyFromPeer(project: SyncProject, peer: string): Promise<ApplyResult> {
    if (!SAFE_ID.test(peer)) {
      throw new ServiceError("bad_request", `Device id "${peer}" is not valid.`);
    }
    const key = queueKey(project.id, peer);
    const cached = known.get(key);
    if (cached?.peer && cached.peer === cached.applied && !queued.has(key)) {
      return { outcome: "noop", skipped: [] };
    }
    beginWrite(project.id);
    try {
      return await lock(project.id, () => applyLocked(project, peer, key));
    } finally {
      endWrite(project.id);
    }
  }

  async function applyLocked(
    project: SyncProject,
    peer: string,
    key: string,
  ): Promise<ApplyResult> {
    const result = (outcome: ApplyResult["outcome"], skipped: ApplyResult["skipped"] = []) => ({
      outcome,
      skipped,
    });
    const repo = repoFor(project);
    await git.ensure(repo);
    const theirs = await git.rev(repo, peerRef(peer));
    if (!theirs) return result("noop");
    const applied = await git.rev(repo, appliedRef(peer));
    known.set(key, { peer: theirs, applied });
    if (theirs === applied) {
      queued.delete(key);
      return result("noop");
    }
    if (conflicts.forPeer(project.id, peer)) return result("conflict");
    if (deps.turnRunning(project.id)) {
      queued.add(key);
      return result("queued");
    }
    queued.delete(key);

    const backup = await takeSnapshot(
      project,
      "before-apply",
      { label: `Before applying ${peer}` },
      { ensureTip: true, fresh: true },
    );
    if (!backup.tip) throw new ServiceError("internal", "The backup snapshot is missing.");
    const setApplied = async () => {
      await git.updateRef(repo, appliedRef(peer), theirs);
      known.set(key, { peer: theirs, applied: theirs });
    };
    const [mine, incoming] = await Promise.all([
      git.treeOf(repo, backup.tip),
      git.treeOf(repo, theirs),
    ]);
    if (mine === incoming) {
      await setApplied();
      return result("noop");
    }
    const appliedTree = applied ? await git.treeOf(repo, applied) : null;
    let target: string | null = null;
    let clashing: string[] = [];
    if (appliedTree !== null && appliedTree === mine) {
      target = incoming;
    } else if (await canMerge()) {
      const merge = await git.mergeTree(repo, {
        base: applied ?? (await git.emptyBase(repo)),
        mine: backup.tip,
        theirs,
      });
      if (merge.clean) target = merge.tree;
      else clashing = merge.conflicts;
    }
    if (target === null) {
      if (clashing.length === 0) {
        clashing = (await git.changes(repo, mine, incoming)).map((change) => change.path);
      }
      const conflict: SyncConflict = {
        id: `conflict_${randomUUID()}`,
        projectId: project.id,
        peerDeviceId: peer,
        mine: backup.tip,
        theirs,
        base: applied,
        paths: clashing.slice(0, 1000),
        createdAt: now().toISOString(),
      };
      await holdConflict(repo, conflict);
      conflicts.add(conflict);
      emit({ push: "sync", kind: "conflict", conflict });
      emitStatus();
      return result("conflict");
    }
    let report;
    try {
      report = await writeTree(project, repo, { backup, mineTree: mine, targetTree: target });
    } catch (error) {
      if (!(error instanceof AbortWrite)) throw error;
      if (error.kind === "turn") queued.add(key);
      return result(error.kind === "turn" ? "queued" : "retry");
    }
    await setApplied();
    await takeSnapshot(project, "incoming", { label: `From ${peer}` });
    return result("applied", report.skipped);
  }

  async function resolveConflict(
    params: RpcParams<"sync.conflicts.resolve">,
  ): Promise<{ ok: true }> {
    const conflict = conflicts.get(params.conflictId);
    if (!conflict) throw new ServiceError("not_found", "That conflict was already resolved.");
    const project = projectById(conflict.projectId);
    assertNoTurn(project, "Resolve the conflict");
    beginWrite(project.id);
    try {
      await lock(project.id, async () => {
        const repo = repoFor(project);
        await git.ensure(repo);
        const resolution: ConflictResolution = params.resolution;
        const backup = await takeSnapshot(
          project,
          "before-apply",
          { label: "Before resolving a conflict" },
          { ensureTip: true, fresh: true },
        );
        if (!backup.tip) throw new ServiceError("internal", "The backup snapshot is missing.");
        const [mine, incoming] = await Promise.all([
          git.treeOf(repo, backup.tip),
          git.treeOf(repo, conflict.theirs),
        ]);
        const side = resolution === "theirs" ? incoming : mine;
        let resolved = side;
        let clashing = conflict.paths;
        if (await canMerge()) {
          const merge = await git.mergeTree(repo, {
            base: conflict.base ?? (await git.emptyBase(repo)),
            mine: backup.tip,
            theirs: conflict.theirs,
          });
          clashing = merge.conflicts;
          resolved = merge.clean
            ? merge.tree
            : await git.pickSide(repo, { merged: merge.tree, side, paths: merge.conflicts });
        }
        try {
          await writeTree(project, repo, { backup, mineTree: mine, targetTree: resolved });
        } catch (error) {
          throw abortAsError(error, "Resolve the conflict");
        }
        if (resolution === "both") {
          for (const path of clashing) {
            const safe = safeRelativePath(path);
            if (safe === null) continue;
            const blob = await git.blobAt(repo, conflict.theirs, safe);
            if (!blob) continue;
            const ext = extname(safe);
            const copy = `${safe.slice(0, safe.length - ext.length)}.theirs${ext}`;
            if (!(await git.writeWorkFile(repo, copy, blob, mine))) {
              notice(project.id, `Kept your local ${copy}: it is not in a snapshot.`);
            }
          }
        }
        fingerprints.delete(project.id);
        const key = queueKey(project.id, conflict.peerDeviceId);
        await git.updateRef(repo, appliedRef(conflict.peerDeviceId), conflict.theirs);
        known.set(key, { peer: conflict.theirs, applied: conflict.theirs });
        conflicts.remove(conflict.id);
        await releaseConflict(repo, conflict);
        await takeSnapshot(project, "incoming", { label: `Resolved: ${resolution}` });
      });
    } finally {
      endWrite(project.id);
    }
    emitStatus();
    return { ok: true };
  }

  // ── network ──────────────────────────────────────────────────────────────────────────

  function peerUrl(peer: PeerEntry, path: string): string {
    return new URL(path, peer.baseUrl.endsWith("/") ? peer.baseUrl : `${peer.baseUrl}/`).toString();
  }

  async function request(peer: PeerEntry, path: string, timeoutMs: number): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(peerUrl(peer, path), {
        headers: { authorization: `Bearer ${peer.token}` },
        signal: AbortSignal.any([shared.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      throw new NetworkError(error instanceof Error ? error.message : "Could not reach the peer.");
    }
    if (response.status === 401) throw new Error("The peer rejected this device's token.");
    if (response.status === 403) throw new Error("The peer does not sync with this device.");
    if (!response.ok) throw new Error(`The peer answered ${response.status}.`);
    return response;
  }

  async function download(peer: PeerEntry, path: string, file: string): Promise<void> {
    const response = await request(peer, path, 30 * 60_000);
    if (!response.body || response.status === 204) throw new Error("The peer sent no bundle.");
    let received = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback(received > MAX_BUNDLE_BYTES ? new Error("The bundle is too large.") : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), cap, createWriteStream(file));
  }

  async function fetchTips(peer: PeerEntry) {
    const response = await request(peer, "sync/tips", 15_000);
    return TipList.parse(await response.json());
  }

  async function pullProject(
    peer: PeerEntry,
    project: SyncProject,
    sharedId: string,
    remoteTip: string,
  ): Promise<void> {
    if (!SAFE_ID.test(peer.deviceId)) throw new Error(`Device id "${peer.deviceId}" is not valid.`);
    const repo = repoFor(project);
    await lock(project.id, () => git.ensure(repo));
    const localTip = await git.rev(repo, peerRef(peer.deviceId));
    if (localTip !== remoteTip) {
      const file = join(repo.gitDir, `incoming-${peer.deviceId}.bundle`);
      const source = `refs/wooky/snap/${peer.deviceId}`;
      const attempt = async (have: string | null) => {
        const query = new URLSearchParams({ project: sharedId });
        if (have) query.set("have", have);
        await download(peer, `sync/bundle?${query}`, file);
        await lock(project.id, async () => {
          const heads = await git.bundleHeads(repo, file);
          if (!heads.includes(source)) throw new Error("The bundle is not from that device.");
          await git.bundleVerify(repo, file);
          await git.fetchBundle(repo, file, source, peerRef(peer.deviceId));
        });
      };
      try {
        await attempt(localTip);
      } catch (error) {
        if (!localTip || error instanceof NetworkError) throw error;
        await attempt(null);
      } finally {
        await rm(file, { force: true });
      }
    }
    const key = queueKey(project.id, peer.deviceId);
    known.set(key, {
      peer: await git.rev(repo, peerRef(peer.deviceId)),
      applied: known.get(key)?.applied ?? null,
    });
    await applyFromPeer(project, peer.deviceId);
  }

  async function pullPeer(peer: PeerEntry, only?: string): Promise<void> {
    setPeer(peer.deviceId, { state: "syncing", error: null });
    try {
      const offered = await fetchTips(peer);
      const problems: string[] = [];
      for (const { projectId: sharedId, tip } of offered) {
        const project = localProject(
          sharedId,
          syncProjects(),
          deps.deviceId,
          settings().projectMap,
        );
        if (!project) {
          problems.push(`${sharedId}: project not mapped on this device`);
          continue;
        }
        if (only && project.id !== only) continue;
        try {
          await pullProject(peer, project, sharedId, tip);
        } catch (error) {
          if (error instanceof NetworkError) throw error;
          problems.push(`${project.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      setPeer(peer.deviceId, {
        state: problems.length > 0 ? "error" : "idle",
        error: problems.length > 0 ? problems.join("; ") : null,
        lastSyncAt: now().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPeer(peer.deviceId, {
        state: error instanceof NetworkError ? "offline" : "error",
        error: message,
      });
    }
  }

  async function pullAll(only?: string): Promise<void> {
    for (const id of settings().peers) {
      if (stopped) return;
      const peer = deps.peers.get(id);
      if (!peer) {
        setPeer(id, { state: "offline", error: "This device is not paired." });
        continue;
      }
      await pullPeer(peer, only);
    }
  }

  // ── serving peers ──────────────────────────────────────────────────────────────────

  function servesPeer(deviceId: string): boolean {
    return filesOn() && settings().peers.includes(deviceId);
  }

  async function tips(): Promise<Array<{ projectId: string; tip: string }>> {
    if (!filesOn()) return [];
    const out: Array<{ projectId: string; tip: string }> = [];
    for (const project of syncProjects()) {
      let repo: ShadowRepo;
      try {
        repo = repoFor(project);
      } catch {
        continue;
      }
      const tip = await git.rev(repo, myRef).catch(() => null);
      if (tip) {
        out.push({
          projectId: sharedProjectId(project, deps.deviceId, settings().projectMap),
          tip,
        });
      }
    }
    return out;
  }

  async function openBundle(sharedId: string, have: string | null) {
    if (!filesOn()) return null;
    const project = localProject(sharedId, syncProjects(), deps.deviceId, settings().projectMap);
    if (!project) return null;
    const repo = repoFor(project);
    // Every ref read and the spawn happen under the lock, so retention cannot rewrite the
    // chain underneath them; a registered bundle makes the next gc skip itself.
    return lock(project.id, async () => {
      activeBundles.set(project.id, (activeBundles.get(project.id) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeBundles.set(project.id, (activeBundles.get(project.id) ?? 1) - 1);
      };
      try {
        const tip = await git.rev(repo, myRef);
        if (!tip) return (release(), null);
        const base = have && SHA.test(have) ? await git.rev(repo, have) : null;
        if (base === tip) return (release(), { empty: true as const });
        const stream = git.bundleStream(repo, myRef, base);
        // Git reads the repo until it exits; after that the bytes are in the pipe, safe from gc.
        void stream.done.then(release, release);
        return { empty: false as const, ...stream };
      } catch (error) {
        release();
        throw error;
      }
    });
  }

  // ── triggers ─────────────────────────────────────────────────────────────────────────

  async function tick(): Promise<void> {
    if (!filesOn() || ticking || stopped) return;
    ticking = true;
    try {
      for (const project of syncProjects()) {
        if (!existsSync(project.root)) continue;
        await snapshot(project.id, "interval", {}, { gate: true }).catch((error) =>
          notice(project.id, `Snapshot failed: ${error instanceof Error ? error.message : error}`),
        );
      }
      await pullAll();
    } finally {
      ticking = false;
    }
  }

  async function syncNow(projectId?: string): Promise<{ ok: true }> {
    requireFiles();
    const targets = projectId ? [projectById(projectId)] : syncProjects();
    for (const project of targets) await snapshot(project.id, "manual");
    await pullAll(projectId);
    return { ok: true };
  }

  async function turnFinished(info: { projectId: string; threadId: string; turnId: string }) {
    if (!filesOn() || stopped) return;
    const project = deps.projects().find((candidate) => candidate.id === info.projectId);
    if (!project || project.scratch) return;
    await snapshot(project.id, "turn", { threadId: info.threadId, turnId: info.turnId }).catch(
      (error) =>
        notice(project.id, `Snapshot failed: ${error instanceof Error ? error.message : error}`),
    );
    for (const key of [...queued]) {
      const [queuedProject, peer] = key.split("\0");
      if (queuedProject !== project.id || !peer) continue;
      await applyFromPeer(project, peer).catch((error) =>
        notice(project.id, `Apply failed: ${error instanceof Error ? error.message : error}`),
      );
    }
  }

  // ── retention ────────────────────────────────────────────────────────────────────────

  async function squash(project: SyncProject): Promise<void> {
    const repo = repoFor(project);
    await git.ensure(repo);
    // Holds left by a crash are dropped once no open conflict needs them.
    const needed = new Set(
      conflicts.list().flatMap((c) => [c.mine, c.theirs, c.base].filter((v): v is string => !!v)),
    );
    for (const sha of await git.heldShas(repo)) {
      if (!needed.has(sha)) await git.holdRef(repo, sha, false);
    }
    const chain = await git.log(repo, myRef, 100_000);
    if (chain.length === 0) return;
    const { keepDays, keepMin } = settings().retention;
    const cutoff = now().getTime() - keepDays * 24 * 60 * 60_000;
    const stamp = (entry: (typeof chain)[number]) => {
      const meta = decodeMeta(entry.message);
      return meta ? Date.parse(meta.at) : 0;
    };
    let keepCount = Math.max(chain.filter((entry) => stamp(entry) >= cutoff).length, keepMin);
    const protectedIds = new Set(
      conflicts
        .list()
        .filter((c) => c.projectId === project.id)
        .map((c) => c.mine),
    );
    chain.forEach((entry, index) => {
      if (protectedIds.has(entry.id)) keepCount = Math.max(keepCount, index + 1);
    });
    const old = chain.slice(keepCount);
    if (old.length === 0 || (old.length === 1 && old[0]?.parentId === null)) return;
    const keep = chain.slice(0, keepCount).reverse();
    const newest = old[0];
    if (!newest) return;
    const baseMeta = decodeMeta(newest.message);
    let parent = await git.commit(repo, {
      tree: newest.tree,
      parent: null,
      message: baseMeta
        ? encodeMeta({ ...baseMeta, label: "Earlier history, squashed" })
        : newest.message,
      identity: { name: "Wooky", at: stamp(newest) / 1000 },
    });
    const remap = new Map<string, string>();
    for (const entry of keep) {
      const rewritten = await git.commit(repo, {
        tree: entry.tree,
        parent,
        message: entry.message,
        identity: { name: "Wooky", at: stamp(entry) / 1000 },
      });
      remap.set(entry.id, rewritten);
      parent = rewritten;
    }
    const tip = chain[0]?.id ?? null;
    await git.updateRef(repo, myRef, parent, tip);
    // Hold every open conflict's commits before gc, and release the old ids only once the
    // conflicts point at the rewritten ones.
    const before = conflicts.list().filter((c) => c.projectId === project.id);
    conflicts.remap(remap);
    for (const conflict of conflicts.list().filter((c) => c.projectId === project.id)) {
      await holdConflict(repo, conflict);
    }
    for (const previous of before) {
      const moved = remap.get(previous.mine);
      if (moved && moved !== previous.mine) await git.holdRef(repo, previous.mine, false);
    }
    if ((activeBundles.get(project.id) ?? 0) > 0) {
      notice(project.id, "Skipped history cleanup: a peer is downloading from this device.");
      return;
    }
    await git.gc(repo);
  }

  async function retain(): Promise<void> {
    if (!filesOn() || stopped) return;
    for (const project of syncProjects()) {
      await lock(project.id, () => squash(project)).catch((error) =>
        notice(project.id, `Retention failed: ${error instanceof Error ? error.message : error}`),
      );
    }
  }

  function clearTimers() {
    if (scanTimer !== null) timers.clearInterval(scanTimer);
    if (retentionStart !== null) timers.clearTimeout(retentionStart);
    if (retentionTimer !== null) timers.clearInterval(retentionTimer);
    scanTimer = retentionStart = retentionTimer = null;
    scanEverySec = 0;
  }

  /** Starts or stops the timers to match the current settings. Call after settings change. */
  function refresh() {
    if (stopped) return;
    if (!filesOn()) return clearTimers();
    const every = settings().intervalSec;
    if (scanTimer !== null && scanEverySec !== every) {
      timers.clearInterval(scanTimer);
      scanTimer = null;
    }
    if (scanTimer === null) {
      scanEverySec = every;
      scanTimer = timers.setInterval(() => void tick(), every * 1000);
    }
    if (retentionStart === null && retentionTimer === null) {
      retentionStart = timers.setTimeout(() => {
        retentionStart = null;
        void retain();
        retentionTimer = timers.setInterval(() => void retain(), RETENTION_EVERY_MS);
      }, deps.retentionStartDelayMs ?? RETENTION_START_MS);
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    clearTimers();
    shared.abort();
    await Promise.allSettled([...locks.values()]);
  }

  return {
    refresh,
    stop,
    status,
    now: syncNow,
    snapshot,
    createSnapshot,
    list,
    diff,
    restore,
    resolve: resolveConflict,
    turnFinished,
    isWriting,
    apply: (projectId: string, peer: string) => applyFromPeer(projectById(projectId), peer),
    tick,
    retain,
    tips,
    openBundle,
    servesPeer,
    onPush(listener: (push: SyncPush) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Test and tooling seam. */
    shadow: git,
    repoFor,
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
