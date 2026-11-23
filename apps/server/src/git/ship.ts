import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingEvent, PullRequest, RpcParams, RpcResult, Thread } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { killTree as defaultKillTree } from "../process/kill-tree.ts";
import type { EventStore } from "../store/event-store.ts";
import { userRepoGitEnv, type SshResolution } from "./env.ts";
import { createGhClient, type GhClient, type GhPrViewJson } from "./gh.ts";
import { redactCliError } from "./redact.ts";
import type { GitService } from "./types.ts";

const PUSH_TIMEOUT_MS = 120_000;
const DEFAULT_PR_POLL_MS = 5 * 60_000;
const PR_POLL_CAP = 25;
/** How long a timed-out git run waits for the tree kill before it gives up on it and rejects. */
const KILL_WAIT_MS = 5_000;

type GitRunResult = { stdout: string; stderr: string; code: number | null };

export interface ShipService {
  status(params: RpcParams<"git.status">): Promise<RpcResult<"git.status">>;
  commit(params: RpcParams<"git.commit">): Promise<RpcResult<"git.commit">>;
  push(params: RpcParams<"git.push">): Promise<RpcResult<"git.push">>;
  prCreate(params: RpcParams<"git.pr.create">): Promise<RpcResult<"git.pr.create">>;
  prStatus(params: RpcParams<"git.pr.status">): Promise<RpcResult<"git.pr.status">>;
  startPolling(): () => void;
}

export function createShipService(deps: {
  store: EventStore;
  git: GitService;
  gitBin?: string;
  gitPrefixArgs?: readonly string[];
  gh?: GhClient;
  pollMs?: number;
  pushTimeoutMs?: number;
  /** Test seams for a kill that never settles. */
  killTree?: typeof defaultKillTree;
  killWaitMs?: number;
}): ShipService {
  const { store, git } = deps;
  const gitBin = deps.gitBin ?? "git";
  const gitPrefixArgs = deps.gitPrefixArgs ?? [];
  const pushTimeout = deps.pushTimeoutMs ?? PUSH_TIMEOUT_MS;
  const gh = deps.gh ?? createGhClient();
  const pollMs = deps.pollMs ?? DEFAULT_PR_POLL_MS;
  const killTree = deps.killTree ?? defaultKillTree;
  const killWaitMs = deps.killWaitMs ?? KILL_WAIT_MS;
  let pollStopped = false;

  function failGit(args: string[], stderr: string, stdout: string, fallback?: string): never {
    const detail = redactCliError((stderr || stdout).trim());
    throw new ServiceError("unavailable", detail || fallback || `git ${args.join(" ")} failed`);
  }

  async function runGit(
    args: string[],
    opts: { cwd: string; allowFail?: boolean; timeoutMs?: number; ssh?: SshResolution },
  ): Promise<GitRunResult> {
    const limit = opts.timeoutMs ?? 60_000;
    const timeoutSec = Math.round(limit / 1000);
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      let timedOut = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const child = spawn(gitBin, [...gitPrefixArgs, ...args], {
        cwd: opts.cwd,
        env: userRepoGitEnv(undefined, opts.ssh),
        windowsHide: true,
        ...(process.platform !== "win32" ? { detached: true } : {}),
      });
      const pid = child.pid;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error) => {
        if (timedOut) return;
        finish(() =>
          reject(
            new ServiceError(
              "unavailable",
              redactCliError(error instanceof Error ? error.message : "Could not run git"),
            ),
          ),
        );
      });
      child.on("close", (code) => {
        if (timedOut) return;
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8");
        finish(() => {
          if (code !== 0 && !opts.allowFail) {
            failGit(args, stderr, stdout);
            return;
          }
          resolvePromise({ stdout, stderr, code });
        });
      });
      if (child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end();
      }
      const timer = setTimeout(() => {
        timedOut = true;
        const rejectTimeout = () =>
          finish(() =>
            reject(
              new ServiceError(
                "unavailable",
                `git ${args.join(" ")} timed out after ${timeoutSec}s`,
              ),
            ),
          );
        if (pid !== undefined) {
          // taskkill can hang; the caller (PR polling holds a single in-flight slot) must not.
          let waitTimer: ReturnType<typeof setTimeout> | undefined;
          const gaveUp = new Promise<void>((resolveWait) => {
            waitTimer = setTimeout(resolveWait, killWaitMs);
          });
          void Promise.race([
            killTree(pid, "SIGKILL", { mode: "group" }).catch(() => {}),
            gaveUp,
          ]).finally(() => {
            clearTimeout(waitTimer);
            rejectTimeout();
          });
        } else {
          rejectTimeout();
        }
      }, limit);
    });
  }

  function threadBusy(thread: Thread): boolean {
    return thread.status === "running" || thread.status === "waiting";
  }

  function assertIdle(thread: Thread, action: "committing" | "pushing" | "opening a pull request") {
    if (threadBusy(thread)) {
      throw new ServiceError("conflict", `Stop the running turn before ${action}.`);
    }
  }

  function resolveCwd(threadId: string): { thread: Thread; cwd: string } {
    const thread = store.model.threads[threadId];
    if (!thread) throw new ServiceError("not_found", `No thread with id ${threadId}.`);
    const project = store.model.projects[thread.projectId];
    if (!project) throw new ServiceError("not_found", `No project with id ${thread.projectId}.`);
    if (thread.isolate && !thread.worktree) {
      throw new ServiceError(
        "bad_request",
        "This isolated thread has no worktree yet. Start a turn first.",
      );
    }
    const cwd = thread.worktree?.path ?? project.root;
    return { thread, cwd };
  }

  async function readBranch(cwd: string): Promise<string> {
    const head = await runGit(["symbolic-ref", "-q", "HEAD"], { cwd, allowFail: true });
    if (head.code !== 0) return "";
    const branch = await runGit(["branch", "--show-current"], { cwd, allowFail: true });
    return branch.stdout.trim();
  }

  async function readUpstream(cwd: string): Promise<string | null> {
    const res = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd,
      allowFail: true,
    });
    if (res.code !== 0) return null;
    const name = res.stdout.trim();
    return name.length > 0 ? name : null;
  }

  async function readAheadBehind(
    cwd: string,
    hasUpstream: boolean,
  ): Promise<{ ahead: number; behind: number }> {
    if (!hasUpstream) return { ahead: 0, behind: 0 };
    const res = await runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"], {
      cwd,
      allowFail: true,
    });
    if (res.code !== 0) return { ahead: 0, behind: 0 };
    const parts = res.stdout.trim().split(/\s+/);
    const behind = Number.parseInt(parts[0] ?? "0", 10) || 0;
    const ahead = Number.parseInt(parts[1] ?? "0", 10) || 0;
    return { ahead, behind };
  }

  async function readDirty(cwd: string): Promise<boolean> {
    const res = await runGit(["status", "--porcelain"], { cwd, allowFail: true });
    return res.stdout.trim().length > 0;
  }

  async function hasRemote(cwd: string): Promise<boolean> {
    const res = await runGit(["remote"], { cwd, allowFail: true });
    return res.stdout.trim().length > 0;
  }

  function originHost(url: string): string | null {
    const trimmed = url.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.startsWith("git@")) {
      const host = trimmed.slice(4).split(":")[0];
      return host && host.length > 0 ? host : null;
    }
    try {
      return new URL(trimmed).hostname || null;
    } catch {
      return null;
    }
  }

  async function readOriginHost(cwd: string): Promise<string | null> {
    try {
      const res = await runGit(["remote", "get-url", "origin"], { cwd, allowFail: true });
      if (res.code !== 0) return null;
      return originHost(res.stdout);
    } catch {
      return null;
    }
  }

  function stripUserinfo(url: string): string {
    const trimmed = url.trim();
    if (trimmed.startsWith("git@")) return trimmed;
    try {
      const parsed = new URL(trimmed);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    } catch {
      return redactCliError(trimmed.replace(/^[^@]+@/, ""));
    }
  }

  function emitPrLinked(threadId: string, pullRequest: PullRequest | null, fromPoll = false) {
    if (fromPoll && pollStopped) return;
    const event: PendingEvent = {
      type: "thread.prLinked",
      commandId: null,
      threadId,
      pullRequest,
    };
    store.appendInternal([event]);
  }

  function samePullRequest(a: PullRequest | null | undefined, b: PullRequest): boolean {
    if (!a) return false;
    return a.url === b.url && a.number === b.number && a.state === b.state && a.branch === b.branch;
  }

  async function fetchPr(
    threadId: string,
    number: number,
    cwd: string,
    fromPoll = false,
  ): Promise<PullRequest | null> {
    const view = await gh.run(
      ["pr", "view", String(number), "--json", "url,number,state,headRefName,mergedAt"],
      { cwd, allowFail: true },
    );
    if (view.code !== 0) return store.model.threads[threadId]?.pullRequest ?? null;
    const json = JSON.parse(view.stdout.trim()) as GhPrViewJson;
    const mapped = gh.mapPrView(json);
    const pr: PullRequest = { ...mapped };
    const current = store.model.threads[threadId]?.pullRequest ?? null;
    if (!samePullRequest(current, pr)) emitPrLinked(threadId, pr, fromPoll);
    return pr;
  }

  function failGh(stderr: string, stdout: string, fallback: string): never {
    const detail = redactCliError((stderr || stdout).trim());
    throw new ServiceError("unavailable", detail || fallback);
  }

  return {
    async status({ threadId }) {
      const { cwd } = resolveCwd(threadId);
      if (!(await git.isRepo(cwd))) {
        throw new ServiceError("bad_request", "This folder is not a git repository.");
      }
      const branch = await readBranch(cwd);
      const upstream = await readUpstream(cwd);
      const hasUpstream = upstream !== null;
      const { ahead, behind } = await readAheadBehind(cwd, hasUpstream);
      const dirty = await readDirty(cwd);
      const remote = await hasRemote(cwd);
      const ghAvailable = gh.available();
      const host = ghAvailable ? await readOriginHost(cwd) : null;
      const ghAuthed =
        ghAvailable && host
          ? await gh.authStatus(host)
          : ghAvailable
            ? await gh.authStatus("github.com")
            : false;
      return {
        branch,
        upstream,
        ahead,
        behind,
        dirty,
        hasRemote: remote,
        ghAvailable,
        ghAuthed,
      };
    },

    async commit({ threadId, message }) {
      const { thread, cwd } = resolveCwd(threadId);
      assertIdle(thread, "committing");
      if (!(await git.isRepo(cwd))) {
        throw new ServiceError("bad_request", "This folder is not a git repository.");
      }
      const head = await runGit(["symbolic-ref", "-q", "HEAD"], { cwd, allowFail: true });
      if (head.code !== 0) {
        throw new ServiceError("bad_request", "Cannot commit on a detached HEAD.");
      }
      const dirty = await readDirty(cwd);
      if (!dirty) {
        throw new ServiceError("bad_request", "There is nothing to commit.");
      }
      await runGit(["add", "-A"], { cwd });
      const committed = await runGit(["commit", "-m", message], { cwd, allowFail: true });
      if (committed.code !== 0) {
        failGit(["commit"], committed.stderr, committed.stdout, "Could not create the commit.");
      }
      const sha = (await runGit(["rev-parse", "HEAD"], { cwd })).stdout.trim();
      return { sha };
    },

    async push({ threadId, setUpstream }) {
      const { thread, cwd } = resolveCwd(threadId);
      assertIdle(thread, "pushing");
      if (!(await git.isRepo(cwd))) {
        throw new ServiceError("bad_request", "This folder is not a git repository.");
      }
      if (!(await hasRemote(cwd))) {
        throw new ServiceError("bad_request", "This repository has no remote.");
      }
      const branch = await readBranch(cwd);
      if (branch.length === 0) {
        throw new ServiceError("bad_request", "Cannot push from a detached HEAD.");
      }
      const upstream = await readUpstream(cwd);
      const needsUpstream = setUpstream === true || upstream === null;
      const args = needsUpstream
        ? ["push", "-u", "origin", "--", branch]
        : ["push", "origin", "--", branch];
      // git's own order is GIT_SSH_COMMAND, core.sshCommand, GIT_SSH; the env has to know the
      // middle one to pin a non-interactive ssh without overriding it.
      const configured = (
        await runGit(["config", "--get", "core.sshCommand"], { cwd, allowFail: true })
      ).stdout.trim();
      const pushed = await runGit(args, {
        cwd,
        timeoutMs: pushTimeout,
        allowFail: true,
        ssh: configured ? { coreSshCommand: configured } : {},
      });
      if (pushed.code !== 0) {
        const detail = redactCliError((pushed.stderr || pushed.stdout).trim());
        const hint = "Sign in to git or run `gh auth login`, then try again.";
        throw new ServiceError("unavailable", detail ? `${detail}\n\n${hint}` : hint);
      }
      const remoteUrl = stripUserinfo(
        (await runGit(["remote", "get-url", "origin"], { cwd })).stdout.trim(),
      );
      return { ok: true as const, remoteUrl };
    },

    async prCreate({ threadId, title, body, base, draft }) {
      const { thread, cwd } = resolveCwd(threadId);
      assertIdle(thread, "opening a pull request");
      if (!(await git.isRepo(cwd))) {
        throw new ServiceError("bad_request", "This folder is not a git repository.");
      }
      if (!gh.available()) {
        throw new ServiceError(
          "unavailable",
          "Install the GitHub CLI (`gh`) to open a pull request.",
        );
      }
      const host = (await readOriginHost(cwd)) ?? "github.com";
      const authed = await gh.authStatus(host);
      if (!authed) {
        throw new ServiceError("unavailable", "Sign in with `gh auth login` on this machine.");
      }
      const branch = await readBranch(cwd);
      if (branch.length === 0) {
        throw new ServiceError("bad_request", "Cannot open a pull request from a detached HEAD.");
      }
      const upstream = await readUpstream(cwd);
      if (upstream === null) {
        await this.push({ threadId, setUpstream: true });
      }
      const baseBranch = base ?? (await defaultBaseBranch(cwd, runGit, gh, authed));
      const dir = await mkdtemp(join(tmpdir(), "wooky-pr-"));
      const bodyFile = join(dir, "body.md");
      try {
        await writeFile(bodyFile, body, { encoding: "utf8", mode: 0o600 });
        const createArgs = [
          "pr",
          "create",
          `--title=${title}`,
          "--body-file",
          bodyFile,
          `--base=${baseBranch}`,
          `--head=${branch}`,
        ];
        if (draft) createArgs.push("--draft");
        const created = await gh.run(createArgs, { cwd, allowFail: true });
        if (created.code !== 0) {
          failGh(created.stderr, created.stdout, "Could not create the pull request.");
        }
        const view = await gh.run(
          ["pr", "view", "--json", "url,number,state,headRefName,mergedAt"],
          { cwd },
        );
        const json = JSON.parse(view.stdout.trim()) as GhPrViewJson;
        const mapped = gh.mapPrView(json);
        const pullRequest: PullRequest = { ...mapped };
        emitPrLinked(threadId, pullRequest);
        return { url: pullRequest.url, number: pullRequest.number };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async prStatus({ threadId }) {
      const { cwd } = resolveCwd(threadId);
      const linked = store.model.threads[threadId]?.pullRequest ?? null;
      if (!linked) return null;
      if (!gh.available()) return linked;
      const host = (await readOriginHost(cwd)) ?? "github.com";
      if (!(await gh.authStatus(host))) return linked;
      return fetchPr(threadId, linked.number, cwd);
    },

    startPolling() {
      let inFlight = false;
      let roundRobin = 0;
      pollStopped = false;

      const tick = async () => {
        if (pollStopped || inFlight || !gh.available()) return;
        inFlight = true;
        try {
          const open = Object.values(store.model.threads).filter(
            (thread) => thread.pullRequest?.state === "open",
          );
          if (open.length === 0) return;
          const batch: Thread[] = [];
          for (let i = 0; i < Math.min(PR_POLL_CAP, open.length); i++) {
            const entry = open[(roundRobin + i) % open.length];
            if (entry) batch.push(entry);
          }
          roundRobin = (roundRobin + batch.length) % open.length;

          const authedHosts = new Map<string, boolean>();
          for (const thread of batch) {
            if (pollStopped) return;
            const pr = thread.pullRequest;
            if (!pr) continue;
            let threadCwd: string;
            try {
              threadCwd = resolveCwd(thread.id).cwd;
            } catch {
              continue;
            }
            const host = (await readOriginHost(threadCwd)) ?? "github.com";
            let hostAuthed = authedHosts.get(host);
            if (hostAuthed === undefined) {
              try {
                hostAuthed = await gh.authStatus(host);
              } catch {
                hostAuthed = false;
              }
              authedHosts.set(host, hostAuthed);
            }
            if (!hostAuthed) continue;
            try {
              await fetchPr(thread.id, pr.number, threadCwd, true);
            } catch {
              // Skip a thread when gh is temporarily unavailable.
            }
          }
        } finally {
          inFlight = false;
        }
      };

      const timer = setInterval(() => void tick(), pollMs);
      timer.unref();
      return () => {
        pollStopped = true;
        clearInterval(timer);
      };
    },
  };
}

async function defaultBaseBranch(
  cwd: string,
  runGit: (args: string[], opts: { cwd: string; allowFail?: boolean }) => Promise<GitRunResult>,
  gh: GhClient,
  authed: boolean,
): Promise<string> {
  if (authed && gh.available()) {
    const view = await gh.run(["repo", "view", "--json", "defaultBranchRef"], {
      cwd,
      allowFail: true,
    });
    if (view.code === 0) {
      const json = JSON.parse(view.stdout.trim()) as {
        defaultBranchRef?: { name?: string };
      };
      const name = json.defaultBranchRef?.name;
      if (name && name.length > 0) return name;
    }
  }
  const remoteHead = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], {
    cwd,
    allowFail: true,
  });
  if (remoteHead.code === 0) {
    const short = remoteHead.stdout.trim().replace("refs/remotes/origin/", "");
    if (short.length > 0) return short;
  }
  const main = await runGit(["show-ref", "--verify", "--quiet", "refs/heads/main"], {
    cwd,
    allowFail: true,
  });
  if (main.code === 0) return "main";
  const master = await runGit(["show-ref", "--verify", "--quiet", "refs/heads/master"], {
    cwd,
    allowFail: true,
  });
  if (master.code === 0) return "master";
  const current = await runGit(["branch", "--show-current"], { cwd, allowFail: true });
  const name = current.stdout.trim();
  if (name.length > 0) return name;
  return "main";
}
