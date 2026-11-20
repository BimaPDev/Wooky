import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingEvent, PullRequest, RpcParams, RpcResult, Thread } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { killTree } from "../process/kill-tree.ts";
import type { EventStore } from "../store/event-store.ts";
import { createGhClient, type GhClient, type GhPrViewJson } from "./gh.ts";
import type { GitService } from "./types.ts";

const PUSH_TIMEOUT_MS = 120_000;
const PR_POLL_MS = 5 * 60_000;
const GIT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
] as const;

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
  gh?: GhClient;
}): ShipService {
  const { store, git } = deps;
  const gitBin = deps.gitBin ?? "git";
  const gh = deps.gh ?? createGhClient();

  async function runGit(
    args: string[],
    opts: { cwd: string; allowFail?: boolean; timeoutMs?: number },
  ): Promise<GitRunResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
    for (const key of GIT_VARS) delete env[key];
    const limit = opts.timeoutMs ?? 60_000;
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const child = spawn(gitBin, args, {
        cwd: opts.cwd,
        env,
        windowsHide: true,
        ...(process.platform !== "win32" ? { detached: true } : {}),
      });
      const pid = child.pid;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => {
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8");
        finish(() => {
          if (code !== 0 && !opts.allowFail) {
            reject(new Error((stderr || stdout).trim() || `git ${args.join(" ")} failed`));
            return;
          }
          resolvePromise({ stdout, stderr, code });
        });
      });
      const timer = setTimeout(() => {
        if (pid !== undefined) void killTree(pid, "SIGKILL", { mode: "group" });
        finish(() => reject(new Error(`git ${args.join(" ")} timed out after ${limit}ms`)));
      }, limit);
    });
  }

  function threadBusy(thread: Thread): boolean {
    return thread.status === "running" || thread.status === "waiting";
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
    const res = await runGit(["remote", "get-url", "origin"], { cwd, allowFail: true });
    if (res.code !== 0) return null;
    return originHost(res.stdout);
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
      return trimmed.replace(/^[^@]+@/, "");
    }
  }

  function emitPrLinked(threadId: string, pullRequest: PullRequest | null) {
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
    if (!samePullRequest(current, pr)) emitPrLinked(threadId, pr);
    return pr;
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
      if (threadBusy(thread)) {
        throw new ServiceError("conflict", "Stop the running turn before committing.");
      }
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
        const detail = (committed.stderr || committed.stdout).trim();
        throw new ServiceError("unavailable", detail || "Could not create the commit.");
      }
      const sha = (await runGit(["rev-parse", "HEAD"], { cwd })).stdout.trim();
      return { sha };
    },

    async push({ threadId, setUpstream }) {
      const { cwd } = resolveCwd(threadId);
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
      const args = needsUpstream ? ["push", "-u", "origin", branch] : ["push", "origin", branch];
      const pushed = await runGit(args, { cwd, timeoutMs: PUSH_TIMEOUT_MS, allowFail: true });
      if (pushed.code !== 0) {
        const detail = (pushed.stderr || pushed.stdout).trim();
        const hint = "Sign in to git or run `gh auth login`, then try again.";
        throw new ServiceError("unavailable", detail ? `${detail}\n\n${hint}` : hint);
      }
      const remoteUrl = stripUserinfo(
        (await runGit(["remote", "get-url", "origin"], { cwd })).stdout.trim(),
      );
      return { ok: true as const, remoteUrl };
    },

    async prCreate({ threadId, title, body, base, draft }) {
      const { cwd } = resolveCwd(threadId);
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
      if (!(await gh.authStatus(host))) {
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
      const baseBranch = base ?? (await defaultBaseBranch(cwd, runGit));
      const dir = await mkdtemp(join(tmpdir(), "wooky-pr-"));
      const bodyFile = join(dir, "body.md");
      try {
        await writeFile(bodyFile, body, "utf8");
        const createArgs = [
          "pr",
          "create",
          "--title",
          title,
          "--body-file",
          bodyFile,
          "--base",
          baseBranch,
          "--head",
          branch,
        ];
        if (draft) createArgs.push("--draft");
        const created = await gh.run(createArgs, { cwd, allowFail: true });
        if (created.code !== 0) {
          const detail = (created.stderr || created.stdout).trim();
          throw new ServiceError("unavailable", detail || "Could not create the pull request.");
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
      const tick = async () => {
        if (!gh.available()) return;
        const authedHosts = new Map<string, boolean>();
        const threads = Object.values(store.model.threads).filter(
          (thread) => thread.pullRequest?.state === "open",
        );
        for (const thread of threads) {
          const pr = thread.pullRequest;
          if (!pr) continue;
          let cwd: string;
          try {
            cwd = resolveCwd(thread.id).cwd;
          } catch {
            continue;
          }
          const host = (await readOriginHost(cwd)) ?? "github.com";
          let authed = authedHosts.get(host);
          if (authed === undefined) {
            authed = await gh.authStatus(host);
            authedHosts.set(host, authed);
          }
          if (!authed) continue;
          try {
            await fetchPr(thread.id, pr.number, cwd);
          } catch {
            // Skip a thread when gh is temporarily unavailable.
          }
        }
      };
      const timer = setInterval(() => void tick(), PR_POLL_MS);
      return () => clearInterval(timer);
    },
  };
}

async function defaultBaseBranch(
  cwd: string,
  runGit: (args: string[], opts: { cwd: string; allowFail?: boolean }) => Promise<GitRunResult>,
): Promise<string> {
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
