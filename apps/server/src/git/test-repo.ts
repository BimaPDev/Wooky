import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bases: string[] = [];

export async function cleanupTestRepos(): Promise<void> {
  while (bases.length > 0) {
    const base = bases.pop();
    if (base) {
      const { rm } = await import("node:fs/promises");
      await rm(base, { recursive: true, force: true });
    }
  }
}

async function raw(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Fresh repo with one commit on main. Cleans up with {@link cleanupTestRepos} in tests. */
export async function makeRepo(withCommit = true): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "wooky-git-test-"));
  bases.push(base);
  const root = join(base, "repo");
  await mkdir(root);
  await raw(root, "init", "-q", "-b", "main");
  await raw(root, "config", "user.email", "test@example.com");
  await raw(root, "config", "user.name", "Test");
  await raw(root, "config", "commit.gpgsign", "false");
  if (withCommit) {
    await writeFile(join(root, "seed.txt"), "seed\n");
    await raw(root, "add", "-A");
    await raw(root, "commit", "-qm", "init");
  }
  return root;
}
