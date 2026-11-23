import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing.ts";
import { createShadowGit } from "./shadow.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function setup() {
  const home = await tempDir("inert-home");
  homes.push(home);
  const shadow = createShadowGit({ home });
  const dir = join(home, "run", "git-inert");
  return { home, shadow, dir, config: join(dir, "empty.config"), hooks: join(dir, "no-hooks") };
}

const posix = process.platform !== "win32";

describe("inert git files", () => {
  it("creates an empty config and hooks dir under the Wooky home", async () => {
    const { shadow, config, hooks } = await setup();
    expect(await shadow.version()).not.toBeNull();
    expect(readFileSync(config, "utf8")).toBe("");
    expect(readdirSync(hooks)).toEqual([]);
  });

  it.skipIf(!posix)("creates the directory 0700 and the config 0600", async () => {
    const { shadow, dir, config } = await setup();
    await shadow.version();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  it("rebuilds a config that was replaced or filled in", async () => {
    const { shadow, config } = await setup();
    await shadow.version();
    writeFileSync(config, "[include]\n\tpath = /tmp/evil\n");
    expect(await shadow.version()).not.toBeNull();
    expect(readFileSync(config, "utf8")).toBe("");
  });

  it("rebuilds when a hook was planted in the hooks directory", async () => {
    const { shadow, hooks } = await setup();
    await shadow.version();
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\n");
    await shadow.version();
    expect(readdirSync(hooks)).toEqual([]);
  });

  it("rebuilds when the directory was deleted or swapped for a symlink", async () => {
    const { shadow, dir, config, home } = await setup();
    await shadow.version();
    rmSync(dir, { recursive: true });
    await shadow.version();
    expect(existsSync(config)).toBe(true);
    if (!posix) return;
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(dir, { recursive: true });
    symlinkSync(elsewhere, dir, "dir");
    await shadow.version();
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it.skipIf(!posix)("rebuilds when the directory became group or world writable", async () => {
    const { shadow, dir, hooks } = await setup();
    await shadow.version();
    chmodSync(hooks, 0o777);
    await shadow.version();
    expect(statSync(hooks).mode & 0o022).toBe(0);
    chmodSync(dir, 0o775);
    await shadow.version();
    expect(statSync(dir).mode & 0o022).toBe(0);
  });
});
