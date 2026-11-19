import type { Worktree } from "@age/contracts";

type Run = (
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; allowFail?: boolean },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "AGE",
  GIT_AUTHOR_EMAIL: "age@localhost",
  GIT_COMMITTER_NAME: "AGE",
  GIT_COMMITTER_EMAIL: "age@localhost",
} as const;

/** Stage and commit dirty worktree changes on its branch. No-op when there is nothing to commit. */
export async function commitWorktreeChanges(
  run: Run,
  baseEnv: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv,
  worktree: Worktree,
  message: string,
): Promise<void> {
  const { path } = worktree;
  const status = await run(["status", "--porcelain"], { cwd: path, allowFail: true });
  if (status.stdout.trim().length === 0) return;
  await run(["add", "-A"], { cwd: path });
  const committed = await run(
    [
      "-c",
      `user.name=${COMMIT_IDENTITY.GIT_AUTHOR_NAME}`,
      "-c",
      `user.email=${COMMIT_IDENTITY.GIT_AUTHOR_EMAIL}`,
      "commit",
      "-m",
      message,
    ],
    { cwd: path, env: baseEnv(COMMIT_IDENTITY), allowFail: true },
  );
  if (committed.code !== 0) {
    const detail = (committed.stderr || committed.stdout).trim();
    throw new Error(detail || "Could not commit worktree changes.");
  }
}
