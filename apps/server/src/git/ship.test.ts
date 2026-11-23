import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { openEventStore } from "../store/event-store.ts";
import { tempDir, waitForEvent } from "../testing.ts";
import { killTree } from "../process/kill-tree.ts";
import { userRepoGitEnv } from "./env.ts";
import { createGhClient } from "./gh.ts";
import { createShipService } from "./ship.ts";
import { createGitService } from "./service.ts";
import { cleanupTestRepos, makeRepo } from "./test-repo.ts";

const exec = promisify(execFile);
const bases: string[] = [];
const noGh = createGhClient({ resolveGh: () => null });

afterEach(async () => {
  await cleanupTestRepos();
  while (bases.length > 0) {
    const base = bases.pop();
    if (base) await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await exec("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function bareOrigin(mainRoot: string): Promise<{ bare: string; url: string }> {
  const base = await mkdtemp(join(tmpdir(), "wooky-ship-origin-"));
  bases.push(base);
  const bare = join(base, "origin.git");
  await runGit(mainRoot, "init", "--bare", bare);
  const url = bare;
  await runGit(mainRoot, "remote", "add", "origin", url);
  await runGit(mainRoot, "push", "-u", "origin", "main");
  return { bare, url };
}

function seedThread(
  store: ReturnType<typeof openEventStore>,
  root: string,
  thread: Partial<Thread> & Pick<Thread, "id">,
) {
  store.appendInternal([
    {
      type: "project.added",
      commandId: null,
      project: {
        id: "p1",
        name: "demo",
        root,
        createdAt: "2026-01-01T00:00:00.000Z",
        settings: { scripts: [], sharedPaths: [], prompts: [] },
      },
    },
    {
      type: "thread.created",
      commandId: null,
      thread: {
        id: thread.id,
        projectId: "p1",
        title: "Ship test",
        provider: "demo",
        model: "demo",
        runtimeMode: "full",
        status: thread.status ?? "idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        isolate: thread.isolate ?? false,
        worktree: thread.worktree ?? null,
        pullRequest: thread.pullRequest ?? null,
        ownerDeviceId: null,
        movedTo: null,
        movedFrom: null,
        providerSessionId: null,
        queue: [],
      },
    },
  ]);
}

async function fakeGh(logPath: string, authed: boolean) {
  const script = join(tmpdir(), `wooky-fake-gh-${Date.now()}.mjs`);
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
const log = process.env.WOOKY_FAKE_GH_LOG;
const authed = process.env.WOOKY_FAKE_GH_AUTH === "1";
const argv = JSON.stringify(process.argv.slice(2));
appendFileSync(log, argv + "\\n");
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") process.exit(authed ? 0 : 1);
if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ defaultBranchRef: { name: "master" } }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  console.log("https://github.com/example/repo/pull/9");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const num = args[2] === "--json" ? 9 : Number(args[2]);
  console.log(JSON.stringify({
    url: "https://github.com/example/repo/pull/" + (Number.isFinite(num) ? num : 9),
    number: Number.isFinite(num) ? num : 9,
    state: "OPEN",
    headRefName: "feature",
    mergedAt: null,
  }));
  process.exit(0);
}
process.exit(0);
`,
    "utf8",
  );
  return {
    gh: createGhClient({
      resolveGh: () => ({ command: process.execPath, prefixArgs: [script] }),
    }),
    logPath,
    env: { WOOKY_FAKE_GH_LOG: logPath, WOOKY_FAKE_GH_AUTH: authed ? "1" : "0" },
    script,
  };
}

describe("ship service", () => {
  it("commits, pushes upstream, and reports clean sync status", async () => {
    const root = await makeRepo();
    await bareOrigin(root);
    const home = await tempDir("ship");
    const store = openEventStore(home, () => "2026-01-01T00:00:00.000Z");
    seedThread(store, root, { id: "t-ship" });
    const git = createGitService();
    const ship = createShipService({ store, git, gh: noGh });

    await writeFile(join(root, "delta.txt"), "change\n");
    const commit = await ship.commit({ threadId: "t-ship", message: "Ship it" });
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);

    await ship.push({ threadId: "t-ship", setUpstream: true });
    const status = await ship.status({ threadId: "t-ship" });
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.hasRemote).toBe(true);
    store.close();
  });

  it("disables interactive git prompts, editors, and pagers in child env", () => {
    const env = userRepoGitEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.GIT_EDITOR).toBe("false");
    expect(env.GIT_PAGER).toBe("cat");
  });

  it.skipIf(process.platform === "win32")(
    "pushes through core.sshCommand with BatchMode and no askpass",
    async () => {
      const root = await makeRepo();
      const home = await tempDir("ship-ssh");
      const log = join(home, "ssh.log");
      const ssh = join(home, "ssh");
      await writeFile(
        ssh,
        `#!/bin/sh\necho "$SSH_ASKPASS_REQUIRE $*" >> "${log}"\nexit 1\n`,
        "utf8",
      );
      await chmod(ssh, 0o755);
      await runGit(root, "remote", "add", "origin", "ssh://git@example.invalid/repo.git");
      await runGit(root, "config", "core.sshCommand", `${ssh} -i /keys/work`);
      const kept = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"].map(
        (key) => [key, process.env[key]] as const,
      );
      for (const [key] of kept) delete process.env[key];
      const store = openEventStore(home, () => "2026-01-01T00:00:00.000Z");
      try {
        seedThread(store, root, { id: "t-ssh" });
        const ship = createShipService({ store, git: createGitService(), gh: noGh });
        await expect(ship.push({ threadId: "t-ssh", setUpstream: true })).rejects.toBeInstanceOf(
          ServiceError,
        );
        const line = (await readFile(log, "utf8")).split("\n")[0] ?? "";
        expect(line).toContain("never");
        expect(line).toContain("-i /keys/work");
        expect(line).toContain("-o BatchMode=yes");
      } finally {
        store.close();
        for (const [key, value] of kept) if (value !== undefined) process.env[key] = value;
      }
    },
  );

  it("refuses commit with no changes, on detached HEAD, and while a turn runs", async () => {
    const root = await makeRepo();
    const home = await tempDir("ship-refuse");
    const store = openEventStore(home, () => "2026-01-01T00:00:00.000Z");
    seedThread(store, root, { id: "t1" });
    const ship = createShipService({ store, git: createGitService(), gh: noGh });

    await expect(ship.commit({ threadId: "t1", message: "empty" })).rejects.toMatchObject({
      code: "bad_request",
    });

    await runGit(root, "checkout", "--detach");
    await writeFile(join(root, "orphan.txt"), "x\n");
    await expect(ship.commit({ threadId: "t1", message: "detached" })).rejects.toMatchObject({
      code: "bad_request",
    });

    await runGit(root, "checkout", "main");
    store.appendInternal([
      {
        type: "turn.started",
        commandId: null,
        threadId: "t1",
        turnId: "turn-busy",
        prompt: "work",
        provider: "demo",
        model: "demo",
        checkpointBefore: null,
      },
    ]);
    await writeFile(join(root, "busy.txt"), "y\n");
    await expect(ship.commit({ threadId: "t1", message: "busy" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(ship.push({ threadId: "t1", setUpstream: true })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(ship.prCreate({ threadId: "t1", title: "x", body: "" })).rejects.toMatchObject({
      code: "conflict",
    });
    store.close();
  });

  it("fails push to an unreachable remote without hanging", async () => {
    const root = await makeRepo();
    await runGit(root, "remote", "add", "origin", "https://127.0.0.1:9/nope.git");
    const home = await tempDir("ship-push");
    const store = openEventStore(home, () => "2026-01-01");
    seedThread(store, root, { id: "t-push" });
    const ship = createShipService({ store, git: createGitService(), gh: noGh });
    const started = Date.now();
    await expect(ship.push({ threadId: "t-push", setUpstream: true })).rejects.toBeInstanceOf(
      ServiceError,
    );
    expect(Date.now() - started).toBeLessThan(115_000);
    store.close();
  });

  it("maps a push timeout to ServiceError", async () => {
    const root = await makeRepo();
    await bareOrigin(root);
    const hang = join(await mkdtemp(join(tmpdir(), "wooky-hang-git-")), "hang.mjs");
    await writeFile(
      hang,
      `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "push") {
  setInterval(() => {}, 10_000);
} else {
  const r = spawnSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 0);
}
`,
    );
    const home = await tempDir("ship-timeout");
    const store = openEventStore(home, () => "2026-01-01");
    seedThread(store, root, { id: "t-timeout" });
    await writeFile(join(root, "t.txt"), "x\n");
    const ship = createShipService({
      store,
      git: createGitService(),
      gh: noGh,
      gitBin: process.execPath,
      gitPrefixArgs: [hang],
      pushTimeoutMs: 1500,
    });
    await ship.commit({ threadId: "t-timeout", message: "prep" });
    await expect(ship.push({ threadId: "t-timeout", setUpstream: true })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("timed out after 2s"),
    });
    store.close();
    await rm(hang, { force: true });
  });

  it("rejects a timed-out git run even when the tree kill never settles", async () => {
    const root = await makeRepo();
    await bareOrigin(root);
    const hang = join(await mkdtemp(join(tmpdir(), "wooky-hang-kill-")), "hang.mjs");
    await writeFile(
      hang,
      `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "push") {
  setInterval(() => {}, 10_000);
} else {
  const r = spawnSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 0);
}
`,
    );
    const home = await tempDir("ship-kill-hang");
    const store = openEventStore(home, () => "2026-01-01");
    seedThread(store, root, { id: "t-kill" });
    await writeFile(join(root, "k.txt"), "x\n");
    const stuck: Array<ReturnType<typeof killTree>> = [];
    const ship = createShipService({
      store,
      git: createGitService(),
      gh: noGh,
      gitBin: process.execPath,
      gitPrefixArgs: [hang],
      pushTimeoutMs: 300,
      killWaitMs: 50,
      // Really kill the child so nothing leaks, but never report that it finished.
      killTree: (pid, signal, options) => {
        stuck.push(killTree(pid, signal, options));
        return new Promise<void>(() => {});
      },
    });
    await ship.commit({ threadId: "t-kill", message: "prep" });
    await expect(ship.push({ threadId: "t-kill", setUpstream: true })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("timed out"),
    });
    await Promise.all(stuck);
    store.close();
    await rm(hang, { force: true });
  });

  it("redacts credentials from push errors", async () => {
    const root = await makeRepo();
    await runGit(
      root,
      "remote",
      "add",
      "origin",
      "https://x-access-token:ghs_abc@127.0.0.1:1/r.git",
    );
    const home = await tempDir("ship-redact");
    const store = openEventStore(home, () => "2026-01-01");
    seedThread(store, root, { id: "t-redact" });
    const ship = createShipService({ store, git: createGitService(), gh: noGh });
    await expect(ship.push({ threadId: "t-redact", setUpstream: true })).rejects.toSatisfy(
      (error: unknown) => {
        if (!(error instanceof ServiceError)) return false;
        expect(error.message).not.toContain("ghs_abc");
        expect(error.message).not.toContain("x-access-token");
        return true;
      },
    );
    store.close();
  });

  it("pushes a branch literally named --force without force-push", async () => {
    const root = await makeRepo();
    const { bare } = await bareOrigin(root);
    const home = await tempDir("ship-force-name");
    const store = openEventStore(home, () => "2026-01-01");
    seedThread(store, root, { id: "t-force" });
    const ship = createShipService({ store, git: createGitService(), gh: noGh });
    const head = await runGit(root, "rev-parse", "HEAD");
    await runGit(root, "update-ref", "refs/heads/--force", head);
    await runGit(root, "symbolic-ref", "HEAD", "refs/heads/--force");
    await writeFile(join(root, "force.txt"), "x\n");
    await ship.commit({ threadId: "t-force", message: "on force branch" });
    await ship.push({ threadId: "t-force", setUpstream: true });
    const heads = await runGit(bare, "show-ref", "--heads");
    expect(heads).toContain("refs/heads/--force");
    store.close();
  });

  it("commits in an isolated worktree without touching the project root", async () => {
    const root = await makeRepo();
    const gitSvc = createGitService();
    const worktree = await gitSvc.createWorktree(root, "t-iso");
    const home = await tempDir("ship-iso");
    const store = openEventStore(home, () => "2026-01-01");
    seedThread(store, root, { id: "t-iso", isolate: true, worktree });
    const rootBefore = await runGit(root, "rev-parse", "HEAD");
    await writeFile(join(worktree.path, "isolated.txt"), "only here\n");
    const ship = createShipService({ store, git: gitSvc, gh: noGh });
    await ship.commit({ threadId: "t-iso", message: "Worktree only" });
    const rootAfter = await runGit(root, "rev-parse", "HEAD");
    expect(rootAfter).toBe(rootBefore);
    const wtDirty = await runGit(worktree.path, "status", "--porcelain");
    expect(wtDirty).toBe("");
    store.close();
  });

  it("creates a pull request, records argv, and emits thread.prLinked", async () => {
    const root = await makeRepo();
    await bareOrigin(root);
    const home = await tempDir("ship-pr");
    const store = openEventStore(home, () => "2026-01-01T00:00:00.000Z");
    seedThread(store, root, { id: "t-pr" });
    const logPath = join(await mkdtemp(join(tmpdir(), "wooky-gh-log-")), "argv.log");
    const fake = await fakeGh(logPath, true);
    const prev = { ...process.env };
    Object.assign(process.env, fake.env);
    const ship = createShipService({
      store,
      git: createGitService(),
      gh: fake.gh,
    });
    try {
      await writeFile(join(root, "pr.txt"), "body\n");
      await ship.commit({ threadId: "t-pr", message: "For PR" });
      await ship.push({ threadId: "t-pr", setUpstream: true });
      const created = await ship.prCreate({
        threadId: "t-pr",
        title: "My PR",
        body: "Summary text",
        draft: true,
      });
      expect(created.number).toBe(9);
      const event = await waitForEvent(store, "thread.prLinked");
      expect(event.pullRequest?.number).toBe(9);
      const log = await readFile(logPath, "utf8");
      expect(log).toContain('"pr","create"');
      expect(log).toContain('"pr","view"');
      expect(log).toContain("--base=master");
      expect(log).toContain("--head=main");
      expect(log).toContain("--title=My PR");
    } finally {
      process.env = prev;
      await rm(fake.script, { force: true });
    }
    store.close();
  });

  it("reports gh unauthenticated without creating a PR", async () => {
    const root = await makeRepo();
    const home = await tempDir("ship-unauth");
    const store = openEventStore(home, () => "2026-01-01");
    seedThread(store, root, { id: "t-unauth" });
    const fake = await fakeGh(join(tmpdir(), `unauth-${Date.now()}.log`), false);
    const ship = createShipService({
      store,
      git: createGitService(),
      gh: fake.gh,
    });
    const status = await ship.status({ threadId: "t-unauth" });
    expect(status.ghAvailable).toBe(true);
    expect(status.ghAuthed).toBe(false);
    await expect(
      ship.prCreate({ threadId: "t-unauth", title: "x", body: "" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    store.close();
  });
});
