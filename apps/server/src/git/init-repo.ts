import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IDENTITY = ["-c", "user.name=Wooky", "-c", "user.email=wooky@localhost"];

/** Make `dir` a git repository with one empty commit, so checkpoints and worktrees have a HEAD. */
export async function initRepo(dir: string): Promise<void> {
  if (existsSync(join(dir, ".git"))) return;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  await execFileAsync("git", ["init", "-q"], { cwd: dir, env, windowsHide: true });
  await execFileAsync(
    "git",
    [...IDENTITY, "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "Start"],
    { cwd: dir, env, windowsHide: true },
  );
}
