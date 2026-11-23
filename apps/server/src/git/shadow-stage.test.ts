import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../testing.ts";
import { createShadowGit, INDEX_CLOCK_MARGIN_MS, type ShadowRepo } from "./shadow.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function dir(prefix: string): Promise<string> {
  const path = await tempDir(prefix);
  dirs.push(path);
  return path;
}

const SCAN = { includeIgnored: false, exclude: [], maxFileBytes: 1e6 };
const posix = process.platform !== "win32";

async function snapshot(shadow: ReturnType<typeof createShadowGit>, repo: ShadowRepo) {
  return shadow.stage(repo, await shadow.scan(repo, SCAN));
}

describe("stage after a restart", () => {
  it("catches a same-size rewrite with a restored mtime made while Wooky was not running", async () => {
    const home = await dir("stage-home");
    const root = await dir("stage-root");
    const file = join(root, "f.txt");
    const fixed = new Date("2025-01-01T00:00:00.000Z");
    await writeFile(file, "aaaa\n");
    await utimes(file, fixed, fixed);
    const repo = { gitDir: join(home, "p.git"), workTree: root };
    const first = createShadowGit({ home });
    await first.ensure(repo);
    // Mirrors Git for Windows, where ctime is not trusted and mtime has 1s resolution.
    await first.run(repo, ["config", "core.trustctime", "false"]);
    await snapshot(first, repo);

    await writeFile(file, "bbbb\n");
    await utimes(file, fixed, fixed);

    // A new instance has no memory of the previous scan, as after a restart.
    const second = createShadowGit({ home });
    const tree = await snapshot(second, repo);
    const content = await second.run(repo, ["cat-file", "-p", `${tree}:f.txt`]);
    expect(content.text).toBe("bbbb\n");
  });

  it.skipIf(!posix)("does not re-hash files that did not change", async () => {
    const home = await dir("stage-home");
    const root = await dir("stage-root");
    await writeFile(join(root, "a.txt"), "a\n");
    await writeFile(join(root, "b.txt"), "b\n");
    // Files touched within the index clock margin of the first scan are re-hashed once by design,
    // and ctime cannot be set, so let the files age past it first.
    await vi.waitFor(
      async () => {
        const { ctimeMs } = await stat(join(root, "b.txt"));
        expect(Date.now() - ctimeMs).toBeGreaterThan(INDEX_CLOCK_MARGIN_MS + 50);
      },
      { interval: 10, timeout: 5000 },
    );
    const repo = { gitDir: join(home, "p.git"), workTree: root };
    const first = createShadowGit({ home });
    await first.ensure(repo);
    await snapshot(first, repo);

    // A git that records the paths update-index is told to evict (and so re-hash).
    const log = join(home, "evicted.log");
    const wrapper = join(home, "git-wrapper.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh\ncase " $* " in\n  *" --force-remove "*) tee -a "${log}" | git "$@" ;;\n  *) exec git "$@" ;;\nesac\n`,
    );
    chmodSync(wrapper, 0o755);
    const restarted = createShadowGit({ home, gitBin: wrapper });
    await snapshot(restarted, repo);
    expect(existsSync(log)).toBe(false);

    await writeFile(join(root, "b.txt"), "changed\n");
    const tree = await snapshot(restarted, repo);
    const evicted = readFileSync(log, "utf8").split("\0").filter(Boolean);
    expect(evicted).toEqual(["b.txt"]);
    expect((await restarted.run(repo, ["cat-file", "-p", `${tree}:b.txt`])).text).toBe("changed\n");
  });
});

describe("a write between a scan and its stage", () => {
  it("is not trusted as clean by the next snapshot", async () => {
    const home = await dir("stage-home");
    const root = await dir("stage-root");
    const file = join(root, "f.txt");
    const other = join(root, "g.txt");
    const fixed = new Date("2025-01-01T00:00:00.000Z");
    await writeFile(file, "aaaa\n");
    await utimes(file, fixed, fixed);
    await writeFile(other, "one\n");
    const repo = { gitDir: join(home, "p.git"), workTree: root };
    const shadow = createShadowGit({ home });
    await shadow.ensure(repo);
    // Mirrors Git for Windows, where ctime is not trusted and mtime has 1s resolution.
    await shadow.run(repo, ["config", "core.trustctime", "false"]);
    await snapshot(shadow, repo);

    // Another file changes, so the stage below writes the index.
    await writeFile(other, "two!\n");
    const scanned = await shadow.scan(repo, SCAN);
    // The write lands after the scan looked at f.txt and before the stage runs.
    await writeFile(file, "bbbb\n");
    await utimes(file, fixed, fixed);
    await shadow.stage(repo, scanned);

    const tree = await snapshot(shadow, repo);
    const content = await shadow.run(repo, ["cat-file", "-p", `${tree}:f.txt`]);
    expect(content.text).toBe("bbbb\n");
  });
});
