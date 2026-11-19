import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderSettings, ProviderStatus } from "@wooky/contracts";
import {
  checkBinaryPath,
  claudeExtraArgs,
  resolveLaunch,
  withCustomModels,
  withUserEnv,
} from "./settings.ts";

const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempFile(mode: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "age-bin-"));
  dirs.push(dir);
  const file = join(dir, "tool");
  await writeFile(file, "#!/bin/sh\n");
  await chmod(file, mode);
  return file;
}

function settings(partial: Partial<ProviderSettings>): ProviderSettings {
  return { customModels: [], extraArgs: [], env: {}, ...partial };
}

describe("checkBinaryPath", () => {
  it("rejects a relative path, a missing file and a directory", async () => {
    expect(checkBinaryPath("codex", "Codex")).toMatchObject({ ok: false, problem: /absolute/ });
    expect(checkBinaryPath(join(tmpdir(), "age-no-such-binary"), "Codex")).toMatchObject({
      ok: false,
      problem: /No file/,
    });
    expect(checkBinaryPath(tmpdir(), "Codex")).toMatchObject({ ok: false, problem: /not a file/ });
  });

  it.runIf(posix)("requires the execute bit", async () => {
    expect(checkBinaryPath(await tempFile(0o644), "Codex")).toMatchObject({
      ok: false,
      problem: /not executable/,
    });
    const good = await tempFile(0o755);
    expect(checkBinaryPath(`  ${good} `, "Codex")).toEqual({ ok: true, path: good });
  });
});

describe("resolveLaunch", () => {
  it("uses the fallback with no settings", () => {
    expect(resolveLaunch(undefined, "claude", "Claude Code")).toEqual({
      bin: "claude",
      problem: null,
      extraArgs: [],
      env: {},
    });
  });

  it("uses a valid override and reports an invalid one without switching to it", () => {
    expect(resolveLaunch(settings({ binaryPath: process.execPath }), "x", "Node")).toMatchObject({
      bin: process.execPath,
      problem: null,
    });
    const bad = resolveLaunch(settings({ binaryPath: "relative/tool" }), "claude", "Claude Code");
    expect(bad.bin).toBe("claude");
    expect(bad.problem).toMatch(/absolute/);
  });

  it("carries extra args and env", () => {
    const launch = resolveLaunch(settings({ extraArgs: ["--a"], env: { K: "v" } }), "x", "X");
    expect(launch.extraArgs).toEqual(["--a"]);
    expect(launch.env).toEqual({ K: "v" });
  });
});

describe("withUserEnv", () => {
  it("returns process.env itself when empty, else a merged copy", () => {
    expect(withUserEnv({})).toBe(process.env);
    const merged = withUserEnv({ WOOKY_TEST_ENV_VALUE: "yes" });
    expect(merged).not.toBe(process.env);
    expect(merged.WOOKY_TEST_ENV_VALUE).toBe("yes");
    expect(merged.PATH).toBe(process.env.PATH);
    expect(process.env.WOOKY_TEST_ENV_VALUE).toBeUndefined();
  });
});

describe("claudeExtraArgs", () => {
  it("maps long flags to the SDK's record and drops short flags and bare words", () => {
    expect(
      claudeExtraArgs(["--verbose", "--max-turns", "4", "--name=x=y", "-v", "stray", "--"]),
    ).toEqual({ verbose: null, "max-turns": "4", name: "x=y" });
  });

  it("does not take a following flag as a value", () => {
    expect(claudeExtraArgs(["--a", "--b", "1"])).toEqual({ a: null, b: "1" });
  });
});

describe("withCustomModels", () => {
  const status: ProviderStatus = {
    kind: "codex",
    label: "Codex",
    installed: true,
    authenticated: true,
    version: null,
    models: [{ id: "default", label: "Default" }],
    modelsSource: "static",
    problem: null,
  };

  it("appends custom ids with source custom, deduped against the status and each other", () => {
    const merged = withCustomModels(
      status,
      settings({ customModels: ["mine", "default", "mine"] }),
    );
    expect(merged.models).toEqual([
      { id: "default", label: "Default" },
      { id: "mine", label: "mine", modelsSource: "custom" },
    ]);
    expect(merged.modelsSource).toBe("static");
  });

  it("returns the same status when there is nothing to add", () => {
    expect(withCustomModels(status, undefined)).toBe(status);
    expect(withCustomModels(status, settings({ customModels: ["default"] }))).toBe(status);
  });
});
