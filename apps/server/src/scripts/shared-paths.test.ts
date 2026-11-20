import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTestRepos, makeRepo } from "../git/test-repo.ts";
import { applySharedPaths, suggestSharedPaths } from "./shared-paths.ts";

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

  it("refuses a path that escapes via ..", async () => {
    const { source, dest } = await twin();
    const result = await applySharedPaths(source, dest, [{ path: "../outside", mode: "link" }]);
    expect(result.results[0]?.action).toBe("refused");
  });

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
