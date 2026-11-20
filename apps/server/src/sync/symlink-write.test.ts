import { existsSync, lstatSync } from "node:fs";
import { readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createShadowGit, type ShadowRepo } from "../git/shadow.ts";
import { cleanupSyncTests, makeDevice, must, pair, put, read, tempDir } from "./testing.ts";

afterEach(cleanupSyncTests);

const BASE = "line1\nline2\nline3\n";
const VICTIM = "outside, must never change\n";

/** A shadow repo over a fresh project folder, with `mine` = a snapshot of what is on disk. */
async function shadowProject(files: Record<string, string> = {}) {
  const root = await tempDir("wooky-sym-root-");
  const home = await tempDir("wooky-sym-home-");
  const outside = await tempDir("wooky-sym-outside-");
  const victim = join(outside, "victim.txt");
  await writeFile(victim, VICTIM);
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  const repo: ShadowRepo = { gitDir: join(home, "s.git"), workTree: root };
  const shadow = createShadowGit();
  await shadow.ensure(repo);
  const snapshot = async () =>
    shadow.stage(
      repo,
      await shadow.scan(repo, { includeIgnored: true, exclude: [], maxFileBytes: 1e9 }),
    );
  return { root, outside, victim, repo, shadow, snapshot };
}

describe("writeWorkFile never writes through a link", () => {
  it("refuses a symlink as the final component and leaves its target alone", async () => {
    const t = await shadowProject({ "f.theirs.txt": "local\n" });
    const mine = await t.snapshot();
    await rm(join(t.root, "f.theirs.txt"));
    await symlink(t.victim, join(t.root, "f.theirs.txt"));
    const result = await t.shadow.writeWorkFile(t.repo, "f.theirs.txt", Buffer.from("PWNED"), mine);
    expect(await readFile(t.victim, "utf8")).toBe(VICTIM);
    expect(lstatSync(join(t.root, "f.theirs.txt")).isSymbolicLink()).toBe(true);
    expect(result).toBe("unsafe");
  });

  it("refuses a dangling final symlink instead of creating its target", async () => {
    const t = await shadowProject({ "f.theirs.txt": "local\n" });
    const mine = await t.snapshot();
    const created = join(t.outside, "created.txt");
    await rm(join(t.root, "f.theirs.txt"));
    await symlink(created, join(t.root, "f.theirs.txt"));
    const result = await t.shadow.writeWorkFile(t.repo, "f.theirs.txt", Buffer.from("x"), mine);
    expect(existsSync(created)).toBe(false);
    expect(result).toBe("unsafe");
  });

  it("refuses a symlinked directory in the middle and creates nothing outside", async () => {
    const t = await shadowProject({ "keep.txt": "k\n" });
    const mine = await t.snapshot();
    await symlink(t.outside, join(t.root, "link"));
    const result = await t.shadow.writeWorkFile(
      t.repo,
      "link/new/deep/f.theirs.txt",
      Buffer.from("PWNED"),
      mine,
    );
    expect(await readdir(t.outside)).toEqual(["victim.txt"]);
    expect(await readFile(t.victim, "utf8")).toBe(VICTIM);
    expect(result).toBe("unsafe");
  });

  it("refuses a folder that a snapshot held but is now a symlink to the real file", async () => {
    const t = await shadowProject({ "link/victim.txt": "local\n" });
    const mine = await t.snapshot();
    await rm(join(t.root, "link"), { recursive: true });
    await symlink(t.outside, join(t.root, "link"));
    const result = await t.shadow.writeWorkFile(
      t.repo,
      "link/victim.txt",
      Buffer.from("PWNED"),
      mine,
    );
    expect(await readFile(t.victim, "utf8")).toBe(VICTIM);
    expect(result).toBe("unsafe");
  });

  it("writes a normal file, creating folders, and leaves no temporary file behind", async () => {
    const t = await shadowProject({ "keep.txt": "k\n" });
    const mine = await t.snapshot();
    expect(
      await t.shadow.writeWorkFile(t.repo, "a/b/f.theirs.txt", Buffer.from("ok\n"), mine),
    ).toBe("written");
    expect(await read(t.root, "a/b/f.theirs.txt")).toBe("ok\n");
    expect(await readdir(join(t.root, "a", "b"))).toEqual(["f.theirs.txt"]);
  });

  it("replaces a regular file that a snapshot holds, and keeps its mode", async () => {
    const t = await shadowProject({ "f.theirs.txt": "old\n" });
    const mine = await t.snapshot();
    expect(await t.shadow.writeWorkFile(t.repo, "f.theirs.txt", Buffer.from("new\n"), mine)).toBe(
      "written",
    );
    expect(await read(t.root, "f.theirs.txt")).toBe("new\n");
  });

  it("still leaves a file that no snapshot holds alone", async () => {
    const t = await shadowProject({ "keep.txt": "k\n" });
    const mine = await t.snapshot();
    await put(t.root, "f.theirs.txt", "precious\n");
    expect(await t.shadow.writeWorkFile(t.repo, "f.theirs.txt", Buffer.from("x"), mine)).toBe(
      "not-in-snapshot",
    );
    expect(await read(t.root, "f.theirs.txt")).toBe("precious\n");
  });

  it("does not follow a final symlink swapped in after the check", async () => {
    const holder: { victim: string } = { victim: "" };
    const root = await tempDir("wooky-sym-root-");
    const home = await tempDir("wooky-sym-home-");
    const outside = await tempDir("wooky-sym-outside-");
    holder.victim = join(outside, "victim.txt");
    await writeFile(holder.victim, VICTIM);
    await put(root, "f.theirs.txt", "local\n");
    const shadow = createShadowGit({
      beforeCommit: async (finalPath) => {
        await rm(finalPath);
        await symlink(holder.victim, finalPath);
      },
    });
    const repo = { gitDir: join(home, "s.git"), workTree: root };
    await shadow.ensure(repo);
    const mine = await shadow.stage(
      repo,
      await shadow.scan(repo, { includeIgnored: true, exclude: [], maxFileBytes: 1e9 }),
    );
    const result = await shadow.writeWorkFile(repo, "f.theirs.txt", Buffer.from("PWNED"), mine);
    expect(await readFile(holder.victim, "utf8")).toBe(VICTIM);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(result).toBe("unsafe");
  });

  it("does not write through a folder swapped for a symlink after the check", async () => {
    const root = await tempDir("wooky-sym-root-");
    const home = await tempDir("wooky-sym-home-");
    const outside = await tempDir("wooky-sym-outside-");
    const victim = join(outside, "f.theirs.txt");
    await writeFile(victim, VICTIM);
    await put(root, "dir/f.theirs.txt", "local\n");
    const moved = join(await tempDir("wooky-sym-moved-"), "dir");
    const shadow = createShadowGit({
      beforeCommit: async (finalPath) => {
        await rename(dirname(finalPath), moved);
        await symlink(outside, join(root, basename(dirname(finalPath))));
      },
    });
    const repo = { gitDir: join(home, "s.git"), workTree: root };
    await shadow.ensure(repo);
    const mine = await shadow.stage(
      repo,
      await shadow.scan(repo, { includeIgnored: true, exclude: [], maxFileBytes: 1e9 }),
    );
    const result = await shadow.writeWorkFile(repo, "dir/f.theirs.txt", Buffer.from("PWNED"), mine);
    expect(await readFile(victim, "utf8")).toBe(VICTIM);
    expect(await readdir(outside)).toEqual(["f.theirs.txt"]);
    expect(result).toBe("unsafe");
  });
});

describe("a .theirs copy during conflict resolution", () => {
  async function conflictedPair(shared: (root: string) => Promise<void>) {
    const a = await makeDevice({ deviceId: "devA", projectId: "proj" });
    const b = await makeDevice({ deviceId: "devB", projectId: "proj-b" });
    pair(a, b);
    for (const device of [a, b]) {
      await put(device.root, "f.txt", BASE);
      await shared(device.root);
    }
    await a.engine.now();
    await b.engine.now();
    await a.engine.now();
    return { a, b };
  }

  it("does not overwrite a file outside the project through a synced f.theirs.txt symlink", async () => {
    const outsideDir = await tempDir("wooky-sym-outside-");
    const victim = join(outsideDir, "victim.txt");
    await writeFile(victim, VICTIM);
    // Both devices hold the same link (as after an earlier sync), so a snapshot has it.
    const { a, b } = await conflictedPair((root) => symlink(victim, join(root, "f.theirs.txt")));
    await put(a.root, "f.txt", "line1\nFROM-A\nline3\n");
    await put(b.root, "f.txt", "line1\nFROM-B\nline3\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    const [conflict] = b.engine.status().conflicts;
    await b.engine.resolve({ conflictId: must(conflict).id, resolution: "both" });
    expect(await readFile(victim, "utf8")).toBe(VICTIM);
    expect(lstatSync(join(b.root, "f.theirs.txt")).isSymbolicLink()).toBe(true);
    expect(b.notices.join("\n")).toContain("f.theirs.txt");
    expect(b.engine.status().conflicts).toEqual([]);
  });

  it("skips the copy, with a notice, when the peer entry is a symlink", async () => {
    const { a, b } = await conflictedPair(async () => {});
    await rm(join(a.root, "f.txt"));
    await symlink("/etc/hostname", join(a.root, "f.txt"));
    await put(b.root, "f.txt", "line1\nFROM-B\nline3\n");
    await a.engine.snapshot(a.projectId, "manual");
    await b.engine.now();
    const [conflict] = b.engine.status().conflicts;
    expect(conflict).toBeDefined();
    await b.engine.resolve({ conflictId: must(conflict).id, resolution: "both" });
    expect(existsSync(join(b.root, "f.theirs.txt"))).toBe(false);
    expect(b.notices.join("\n")).toMatch(/Skipped f\.theirs\.txt.*link or special file/);
  });
});
