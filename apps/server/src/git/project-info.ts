import { execFile } from "node:child_process";
import { normalizeRemoteUrl } from "@wooky/domain";
import { userRepoGitEnv } from "./env.ts";

export interface ProjectGitFacts {
  /** The normalized origin remote (no scheme, no credentials), or null. */
  remote: string | null;
  /** The branch HEAD is on, or null when detached or not a git repo. */
  branch: string | null;
}

const TIMEOUT_MS = 5_000;

function git(root: string, args: string[], gitBin: string): Promise<string | null> {
  return new Promise((resolve) => {
    // Plumbing reads only: `config` and `symbolic-ref` run no hook and no configured program.
    execFile(
      gitBin,
      ["-C", root, ...args],
      { env: userRepoGitEnv(), timeout: TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    );
  });
}

/**
 * What a project folder says about its git repository, for matching it with the same project
 * on another device. Never throws: a folder that is not a repo has neither.
 */
export async function readProjectGitFacts(root: string, gitBin = "git"): Promise<ProjectGitFacts> {
  const [url, branch] = await Promise.all([
    git(root, ["config", "--local", "--get", "remote.origin.url"], gitBin),
    git(root, ["symbolic-ref", "-q", "--short", "HEAD"], gitBin),
  ]);
  return {
    remote: normalizeRemoteUrl(url),
    branch: branch ? branch.slice(0, 200) : null,
  };
}
