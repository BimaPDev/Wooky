import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTestRepos, makeRepo } from "../git/test-repo.ts";
import { applySharedPaths, suggestSharedPaths } from "./shared-paths.ts";

const mkdirHook = vi.hoisted(() => ({
  afterMkdir: null as ((path: string) => void | Promise<void>) | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: unknown[]) => {
      const result = await (actual.mkdir as (...input: unknown[]) => unknown)(...args);
      await mkdirHook.afterMkdir?.(String(args[0]));
      return result;
    },
  } as unknown as typeof actual;
});

const posix = process.platform !== "win32";

async function twin() {
  const root = await mkdtemp(join(tmpdir(), "wooky-shared-"));
  const source = join(root, "src");
  const dest = join(root, "dst");
  await mkdir(source);
  await mkdir(dest);
  return { source, dest };
}

afterEach(async () => {
  mkdirHook.afterMkdir = null;
  await cleanupTestRepos();
});

describe("applySharedPaths", () => {
  it.skipIf(!posix)("links a file on POSIX", async () => {
    const { source, dest } = await twin();
    await writeFile(join(source, ".env"), "SECRET=1\n");
    const result = await applySharedPaths(source, dest, [{ path: ".env", mode: "link" }]);
    expect(result.linked).toEqual([".env"]);
    expect(await readFile(join(dest, ".env"), "utf8")).toBe("SECRET=1\n");
    expect((await lstat(join(dest, ".env"))).isSymbolicLink()).toBe(true);
  });

  it("copies a file", async () => {
    const { source, dest } = await twin();
    await writeFile(join(source, ".env"), "SECRET=1\n");
    const result = await applySharedPaths(source, dest, [{ path: ".env", mode: "copy" }]);
    expect(result.copied).toEqual([".env"]);
    expect(await readFile(join(dest, ".env"), "utf8")).toBe("SECRET=1\n");
    expect((await lstat(join(dest, ".env"))).isSymbolicLink()).toBe(false);
  });

  it.skipIf(!posix)("preserves the file mode on copy", async () => {
    const { source, dest } = await twin();
    const srcFile = join(source, ".env");
    await writeFile(srcFile, "SECRET=1\n");
    await chmod(srcFile, 0o640);
    await applySharedPaths(source, dest, [{ path: ".env", mode: "copy" }]);
    expect((await lstat(join(dest, ".env"))).mode & 0o777).toBe(0o640);
  });

  it("skips a missing source", async () => {
    const { source, dest } = await twin();
    const result = await applySharedPaths(source, dest, [{ path: ".env", mode: "link" }]);
    expect(result.skipped).toEqual([".env"]);
    expect(result.results[0]?.reason).toMatch(/missing/);
  });

  it("never overwrites an existing target", async () => {
    const { source, dest } = await twin();
    await writeFile(join(source, ".env"), "NEW=1\n");
    await writeFile(join(dest, ".env"), "OLD=1\n");
    const result = await applySharedPaths(source, dest, [{ path: ".env", mode: "copy" }]);
    expect(result.skipped).toEqual([".env"]);
    expect(await readFile(join(dest, ".env"), "utf8")).toBe("OLD=1\n");
  });

  it("refuses .git spelled any way and keeps applying the rest", async () => {
    const { source, dest } = await twin();
    await writeFile(join(source, ".env"), "SECRET=1\n");
    const result = await applySharedPaths(source, dest, [
      { path: ".GIT/config", mode: "link" },
      { path: "foo/.git/config", mode: "link" },
      { path: ".git /config", mode: "link" },
      { path: ".env", mode: "link" },
    ]);
    expect(result.results.slice(0, 3).map((item) => item.action)).toEqual([
      "refused",
      "refused",
      "refused",
    ]);
    expect(result.skipped).toEqual([".GIT/config", "foo/.git/config", ".git /config"]);
    expect(result.linked).toEqual([".env"]);
    expect(await readFile(join(dest, ".env"), "utf8")).toBe("SECRET=1\n");
    await expect(lstat(join(dest, ".GIT"))).rejects.toThrow(/ENOENT/);
  });

  it("keeps applying the other entries when one of them fails", async () => {
    const { source, dest } = await twin();
    await mkdir(join(source, "blocker", "child"), { recursive: true });
    await writeFile(join(dest, "blocker"), "not a directory\n");
    await writeFile(join(source, ".env"), "SECRET=1\n");
    const result = await applySharedPaths(source, dest, [
      { path: "blocker/child", mode: "link" },
      { path: ".env", mode: "link" },
    ]);
    expect(result.results[0]?.action).toBe("skipped");
    expect(result.skipped).toEqual(["blocker/child"]);
    expect(result.linked).toEqual([".env"]);
    expect(await readFile(join(dest, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("refuses a path that escapes via ..", async () => {
    const { source, dest } = await twin();
    const result = await applySharedPaths(source, dest, [{ path: "../outside", mode: "link" }]);
    expect(result.results[0]?.action).toBe("refused");
  });

  it.skipIf(!posix)(
    "refuses to write when a parent directory becomes a symlink after the checks",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "wooky-swap-"));
      try {
        for (const mode of ["link", "copy"] as const) {
          const source = join(root, `src-${mode}`);
          const dest = join(root, `dst-${mode}`);
          const outside = join(root, `outside-${mode}`);
          await mkdir(join(source, "sub"), { recursive: true });
          await mkdir(dest);
          await mkdir(outside);
          await writeFile(join(source, "sub", ".env"), "SECRET=1\n");

          // The path handed to mkdir is already realpath'd, so match on the tail.
          const swapped = join(`dst-${mode}`, "sub");
          mkdirHook.afterMkdir = async (path) => {
            mkdirHook.afterMkdir = null;
            if (!path.endsWith(swapped)) return;
            await rm(path, { recursive: true, force: true });
            await symlink(outside, path);
          };

          const result = await applySharedPaths(source, dest, [{ path: "sub/.env", mode }]);
          expect(result.results[0]?.action).toBe("refused");
          expect(result.results[0]?.reason).toMatch(/destination resolves outside the worktree/);
          expect(result.linked).toEqual([]);
          expect(result.copied).toEqual([]);
          await expect(lstat(join(outside, ".env"))).rejects.toThrow(/ENOENT/);
        }
      } finally {
        mkdirHook.afterMkdir = null;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!posix)("refuses a symlink that points outside the project", async () => {
    const { source, dest } = await twin();
    const outside = join(source, "..", "secret");
    await writeFile(outside, "nope\n");
    await symlink(outside, join(source, "link"));
    const result = await applySharedPaths(source, dest, [{ path: "link", mode: "link" }]);
    expect(result.results[0]?.action).toBe("refused");
    await expect(lstat(join(dest, "link"))).rejects.toThrow(/ENOENT/);
  });

  it.runIf(process.platform === "win32")("uses a junction or copy for a directory", async () => {
    const { source, dest } = await twin();
    await mkdir(join(source, "node_modules"));
    await writeFile(join(source, "node_modules", "pkg.txt"), "ok\n");
    const result = await applySharedPaths(source, dest, [{ path: "node_modules", mode: "link" }]);
    expect(result.linked.length + result.copied.length).toBe(1);
    expect(await readFile(join(dest, "node_modules", "pkg.txt"), "utf8")).toBe("ok\n");
  });
});

describe("suggestSharedPaths", () => {
  it("lists gitignored top-level entries", async () => {
    const root = await makeRepo();
    await writeFile(join(root, ".gitignore"), ".env\nnode_modules/\n");
    await writeFile(join(root, ".env"), "X=1\n");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "x"), "x\n");
    const suggested = await suggestSharedPaths(root);
    expect(suggested).toEqual(expect.arrayContaining([".env", "node_modules"]));
  });
});
