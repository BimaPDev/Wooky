import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing.ts";
import { createShadowGit } from "./shadow.ts";

const dirs: string[] = [];
const touched = new Map<string, string | undefined>();
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const [key, value] of touched) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  touched.clear();
});

function setEnv(key: string, value: string): void {
  if (!touched.has(key)) touched.set(key, process.env[key]);
  process.env[key] = value;
}

async function dir(prefix: string): Promise<string> {
  const path = await tempDir(prefix);
  dirs.push(path);
  return path;
}

const posix = process.platform !== "win32";

describe("shadow git child", () => {
  it.skipIf(!posix)(
    "sees no ambient GIT_ variable, transport included, and may only use local files",
    async () => {
      const home = await dir("shadow-env-home");
      const out = join(home, "seen.txt");
      const fake = join(home, "fake-git.sh");
      writeFileSync(fake, `#!/bin/sh\nenv > "${out}"\nprintf '%s\\n' "$@" >> "${out}"\n`);
      chmodSync(fake, 0o755);
      for (const name of [
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_ASKPASS",
        "GIT_PROXY_COMMAND",
        "GIT_SSL_NO_VERIFY",
        "GIT_AUTHOR_NAME",
        "GIT_LFS_SKIP_SMUDGE",
      ]) {
        setEnv(name, "ambient");
      }
      setEnv("Git_Ssl_Cainfo", "ambient");
      const shadow = createShadowGit({ home, gitBin: fake });
      await shadow.run(null, ["--version"]);
      const seen = readFileSync(out, "utf8");
      const names = seen
        .split("\n")
        .map((line) => line.split("=")[0]?.toUpperCase() ?? "")
        .filter((name) => name.startsWith("GIT_"));
      expect(names.sort()).toEqual(
        [
          "GIT_ATTR_NOSYSTEM",
          "GIT_CONFIG_GLOBAL",
          "GIT_CONFIG_NOSYSTEM",
          "GIT_EDITOR",
          "GIT_PAGER",
          "GIT_TERMINAL_PROMPT",
        ].sort(),
      );
      expect(seen).not.toContain("ambient");
      expect(seen).toContain("protocol.allow=never");
      expect(seen).toContain("protocol.file.allow=always");
    },
  );

  it("still fetches a local bundle file with protocols locked down", async () => {
    const home = await dir("shadow-bundle-home");
    const rootA = await dir("shadow-bundle-a");
    const rootB = await dir("shadow-bundle-b");
    await writeFile(join(rootA, "note.txt"), "hello\n");
    const shadow = createShadowGit({ home });
    const a = { gitDir: join(home, "a.git"), workTree: rootA };
    const b = { gitDir: join(home, "b.git"), workTree: rootB };
    await shadow.ensure(a);
    await shadow.ensure(b);
    const scan = await shadow.scan(a, { includeIgnored: false, exclude: [], maxFileBytes: 1e6 });
    const tree = await shadow.stage(a, scan);
    const sha = await shadow.commit(a, {
      tree,
      parent: null,
      message: "snap",
      identity: { name: "devA", at: 1_700_000_000 },
    });
    await shadow.updateRef(a, "refs/wooky/snap", sha);
    const file = join(home, "a.bundle");
    const stream = shadow.bundleStream(a, "refs/wooky/snap", null);
    await pipeline(stream.stdout, createWriteStream(file));
    await stream.done;
    await shadow.bundleVerify(b, file);
    await shadow.fetchBundle(b, file, "refs/wooky/snap", "refs/wooky/peer");
    expect(await shadow.rev(b, "refs/wooky/peer")).toBe(sha);
  });
});
