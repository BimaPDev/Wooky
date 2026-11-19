import { execFile } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  openRegularFileSafely,
  planDenyMessage,
  plansDirectoryFromSettings,
  readPlanFromFile,
  resolvePlanMarkdown,
  setPlanFsHooksForTests,
  setPlanUserHomeForTests,
  toolAnswers,
  questionRequest,
  quoteAnswerLabel,
} from "./interaction.ts";

const SENTINEL = "SENTINEL_CREDENTIAL_NOT_A_REAL_SECRET";

const execFileAsync = promisify(execFile);

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  setPlanUserHomeForTests(undefined);
  setPlanFsHooksForTests(undefined);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("toolAnswers", () => {
  it("sends single-select labels with comma-space unquoted", () => {
    const request = questionRequest("r1", {
      questions: [
        {
          question: "Pick one?",
          header: "Pick",
          options: [{ label: "a, b" }, { label: "plain" }],
        },
      ],
    });
    if (!request) throw new Error("expected request");
    expect(toolAnswers(request, { "Pick one?": ["a, b"] })).toEqual({
      "Pick one?": "a, b",
    });
  });

  it("quotes labels that contain comma-space the way the CLI encodes multi-select", () => {
    const request = questionRequest("r1", {
      questions: [
        {
          question: "Pick one?",
          header: "Pick",
          options: [{ label: "a, b" }, { label: "plain" }],
          multiSelect: true,
        },
      ],
    });
    if (!request) throw new Error("expected request");
    expect(toolAnswers(request, { "Pick one?": ["a, b"] })).toEqual({
      "Pick one?": '"a, b"',
    });
  });

  it("quotes each multi-select label before joining", () => {
    const request = questionRequest("r1", {
      questions: [
        {
          question: "Which?",
          header: "Which",
          options: [{ label: "x" }, { label: 'say "hi"' }],
          multiSelect: true,
        },
      ],
    });
    if (!request) throw new Error("expected request");
    expect(toolAnswers(request, { "Which?": ['say "hi"', "x"] })).toEqual({
      "Which?": '"say \\"hi\\"", x',
    });
  });
});

describe("quoteAnswerLabel", () => {
  it("leaves simple labels unchanged", () => {
    expect(quoteAnswerLabel("dayjs")).toBe("dayjs");
  });
});

describe("readPlanFromFile", () => {
  function projectWithPlans(name: string, home?: string) {
    const cwd = tempDir(`wooky-plan-${name}-`);
    if (home) {
      setPlanUserHomeForTests(home);
      mkdirSync(join(home, ".claude", "plans"), { recursive: true });
    }
    mkdirSync(join(cwd, ".claude", "plans"), { recursive: true });
    return cwd;
  }

  it("reads a normal file inside project plans", async () => {
    const cwd = projectWithPlans("ok");
    const planPath = join(cwd, ".claude", "plans", "task.md");
    writeFileSync(planPath, "## Plan\n\nok");
    const result = await readPlanFromFile(planPath, cwd);
    expect(result).toEqual({ ok: true, markdown: "## Plan\n\nok" });
  });

  it("rejects a file symlink under the plans directory", async () => {
    const cwd = projectWithPlans("symlink-file");
    const secret = join(cwd, "secret.md");
    writeFileSync(secret, "stolen");
    const linkPath = join(cwd, ".claude", "plans", "via-link.md");
    symlinkSync(secret, linkPath);
    const result = await readPlanFromFile(linkPath, cwd);
    expect(result).toEqual({ ok: false, reason: "symlink_file" });
  });

  it("rejects a hard link to a plan file", async () => {
    const cwd = projectWithPlans("hardlink");
    const planPath = join(cwd, ".claude", "plans", "task.md");
    writeFileSync(planPath, "plan");
    const hard = join(cwd, ".claude", "plans", "alias.md");
    linkSync(planPath, hard);
    const result = await readPlanFromFile(hard, cwd);
    expect(result).toEqual({ ok: false, reason: "hardlink_file" });
  });

  it("rejects a plans directory that is a symbolic link", async () => {
    const cwd = tempDir("wooky-plan-symlink-root-");
    const outside = tempDir("wooky-plan-outside-");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "task.md"), "outside plan");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    symlinkSync(outside, join(cwd, ".claude", "plans"));
    const result = await readPlanFromFile(join(cwd, ".claude", "plans", "task.md"), cwd);
    expect(result).toEqual({ ok: false, reason: "symlink_root" });
  });

  it("rejects .. and absolute paths outside allowed roots", async () => {
    const cwd = projectWithPlans("outside");
    const outside = join(cwd, "escape.md");
    writeFileSync(outside, "no");
    expect(
      await readPlanFromFile(join(cwd, ".claude", "plans", "..", "..", "escape.md"), cwd),
    ).toEqual({
      ok: false,
      reason: "outside_roots",
    });
    expect(await readPlanFromFile(outside, cwd)).toEqual({ ok: false, reason: "outside_roots" });
  });

  it("rejects a plans-evil sibling directory", async () => {
    const cwd = projectWithPlans("evil-sibling");
    mkdirSync(join(cwd, "plans-evil"), { recursive: true });
    const evil = join(cwd, "plans-evil", "task.md");
    writeFileSync(evil, "evil");
    expect(await readPlanFromFile(evil, cwd)).toEqual({ ok: false, reason: "outside_roots" });
  });

  it("accepts paths when the temp root uses a /var spelling alias", async () => {
    const base = tempDir("wooky-plan-var-");
    const cwd = resolve(base);
    mkdirSync(join(cwd, ".claude", "plans"), { recursive: true });
    const planPath = join(cwd, ".claude", "plans", "task.md");
    writeFileSync(planPath, "var plan");
    const aliasCwd = realpathSync(cwd);
    const aliasPath = join(aliasCwd, ".claude", "plans", "task.md");
    const result = await readPlanFromFile(aliasPath, cwd);
    expect(result).toEqual({ ok: true, markdown: "var plan" });
  });

  it("rejects files larger than 1 MiB", async () => {
    const cwd = projectWithPlans("large");
    const planPath = join(cwd, ".claude", "plans", "big.md");
    writeFileSync(planPath, "x".repeat((1 << 20) + 1));
    expect(await readPlanFromFile(planPath, cwd)).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects a directory at the plan path", async () => {
    const cwd = projectWithPlans("dir-path");
    const dirPath = join(cwd, ".claude", "plans", "not-a-file");
    mkdirSync(dirPath);
    expect(await readPlanFromFile(dirPath, cwd)).toEqual({ ok: false, reason: "not_regular" });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO at the plan path without blocking",
    async () => {
      const cwd = projectWithPlans("fifo");
      const fifoPath = join(cwd, ".claude", "plans", "blocked.md");
      await execFileAsync("mkfifo", [fifoPath]);
      const result = await readPlanFromFile(fifoPath, cwd);
      expect(result).toEqual({ ok: false, reason: "not_regular" });
    },
  );

  it("rejects a symlink swap after validation via hook", async () => {
    const cwd = projectWithPlans("hook-symlink");
    const planPath = join(cwd, ".claude", "plans", "task.md");
    const credPath = join(cwd, "credential.md");
    writeFileSync(planPath, "safe plan");
    writeFileSync(credPath, "CREDENTIAL_LEAK");
    setPlanFsHooksForTests({
      afterValidate: () => {
        unlinkSync(planPath);
        symlinkSync(credPath, planPath);
      },
    });
    const result = await readPlanFromFile(planPath, cwd);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).not.toBe("empty");
    if ("markdown" in result) throw new Error("unexpected markdown");
    expect(String(result)).not.toContain("CREDENTIAL_LEAK");
  });

  it("rejects a hard-link swap after validation via hook", async () => {
    const cwd = projectWithPlans("hook-hardlink");
    const planPath = join(cwd, ".claude", "plans", "task.md");
    const credPath = join(cwd, "credential.md");
    writeFileSync(planPath, "safe plan");
    writeFileSync(credPath, "CREDENTIAL_LEAK");
    setPlanFsHooksForTests({
      afterValidate: () => {
        unlinkSync(planPath);
        linkSync(credPath, planPath);
      },
    });
    const result = await readPlanFromFile(planPath, cwd);
    expect(result).toEqual({ ok: false, reason: "hardlink_file" });
    expect(String(result)).not.toContain("CREDENTIAL_LEAK");
  });

  it("rejects a directory-component swap after validation via hook", async () => {
    const cwd = projectWithPlans("hook-dir-swap");
    const plansDir = join(cwd, ".claude", "plans");
    const plansAlt = join(cwd, ".claude", "plans-alt");
    const planPath = join(plansDir, "task.md");
    mkdirSync(plansAlt, { recursive: true });
    writeFileSync(join(plansAlt, "task.md"), "ALT_PLAN");
    writeFileSync(planPath, "safe plan");
    setPlanFsHooksForTests({
      afterValidate: () => {
        renameSync(plansDir, join(cwd, ".claude", "plans-orig"));
        renameSync(plansAlt, plansDir);
      },
    });
    const result = await readPlanFromFile(planPath, cwd);
    expect(result).toEqual({ ok: false, reason: "changed" });
    if (result.ok) throw new Error("expected rejection");
    expect(String(result)).not.toContain("ALT_PLAN");
  });

  it("rejects a hard-link swap in the beforeOpen gap", async () => {
    const cwd = projectWithPlans("hook-before-open-hardlink");
    const planPath = join(cwd, ".claude", "plans", "task.md");
    const credPath = join(cwd, "credential.md");
    writeFileSync(planPath, "safe plan");
    writeFileSync(credPath, SENTINEL);
    setPlanFsHooksForTests({
      beforeOpen: () => {
        unlinkSync(planPath);
        linkSync(credPath, planPath);
        unlinkSync(credPath);
      },
    });
    const result = await readPlanFromFile(planPath, cwd);
    expect(result).toEqual({ ok: false, reason: "changed" });
    expect(String(result)).not.toContain(SENTINEL);
  });

  it("rejects a directory symlink swap in the beforeOpen gap", async () => {
    const cwd = projectWithPlans("hook-before-open-dir");
    const plansDir = join(cwd, ".claude", "plans");
    const secretDir = join(cwd, "secret-plans");
    const planPath = join(plansDir, "task.md");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "task.md"), SENTINEL);
    writeFileSync(planPath, "safe plan");
    setPlanFsHooksForTests({
      beforeOpen: () => {
        renameSync(plansDir, join(cwd, ".claude", "plans-safe-hold"));
        symlinkSync(secretDir, plansDir);
      },
    });
    const result = await readPlanFromFile(planPath, cwd);
    expect(result).toEqual({ ok: false, reason: "changed" });
    expect(String(result)).not.toContain(SENTINEL);
  });

  it("rejects a plan under project .claude symlinked to an outside directory", async () => {
    const cwd = tempDir("wooky-plan-ancestor-claude-");
    const outside = join(cwd, "outside-plans-root");
    mkdirSync(join(outside, "plans"), { recursive: true });
    writeFileSync(join(outside, "plans", "task.md"), SENTINEL);
    rmSync(join(cwd, ".claude"), { recursive: true, force: true });
    symlinkSync(outside, join(cwd, ".claude"));
    const result = await readPlanFromFile(join(cwd, ".claude", "plans", "task.md"), cwd);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(["symlink_root", "outside_roots"]).toContain(result.reason);
    expect(String(result)).not.toContain(SENTINEL);
  });

  it("rejects a custom plansDirectory reached through a symlinked ancestor", async () => {
    const cwd = tempDir("wooky-plan-custom-ancestor-");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ plansDirectory: "docs/plans" }),
    );
    const outside = join(cwd, "outside-docs");
    mkdirSync(join(outside, "plans"), { recursive: true });
    writeFileSync(join(outside, "plans", "task.md"), SENTINEL);
    symlinkSync(outside, join(cwd, "docs"));
    const planPath = join(cwd, "docs", "plans", "task.md");
    const result = await readPlanFromFile(planPath, cwd);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(["symlink_root", "outside_roots"]).toContain(result.reason);
    expect(String(result)).not.toContain(SENTINEL);
  });
});

describe("openRegularFileSafely", () => {
  it("rejects a hard-link swap in the beforeOpen gap without leaking bytes", async () => {
    const cwd = tempDir("wooky-open-before-hardlink-");
    mkdirSync(join(cwd, ".claude", "plans"), { recursive: true });
    const planPath = join(cwd, ".claude", "plans", "task.md");
    const credPath = join(cwd, "credential.md");
    writeFileSync(planPath, "safe plan");
    writeFileSync(credPath, SENTINEL);
    setPlanFsHooksForTests({
      beforeOpen: () => {
        unlinkSync(planPath);
        linkSync(credPath, planPath);
        unlinkSync(credPath);
      },
    });
    const result = await openRegularFileSafely(planPath, 1 << 20, { kind: "plan", cwd });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected ok");
    expect(result.reason).toBe("changed");
    expect(String(result)).not.toContain(SENTINEL);
  });
});

describe("plansDirectoryFromSettings", () => {
  it("reads plansDirectory from settings.json", async () => {
    const cwd = tempDir("wooky-settings-ok-");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ plansDirectory: "docs/plans" }),
    );
    await expect(plansDirectoryFromSettings(cwd)).resolves.toBe("docs/plans");
  });

  it("ignores settings.json reached through a symlinked ancestor", async () => {
    const cwd = tempDir("wooky-settings-ancestor-");
    const outside = join(cwd, "outside-claude");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "settings.json"), JSON.stringify({ plansDirectory: "owned" }));
    symlinkSync(outside, join(cwd, ".claude"));
    await expect(plansDirectoryFromSettings(cwd)).resolves.toBeNull();
  });

  it("ignores a symlinked settings.json", async () => {
    const cwd = tempDir("wooky-settings-symlink-");
    const outside = join(cwd, "evil-settings.json");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(outside, JSON.stringify({ plansDirectory: "owned" }));
    symlinkSync(outside, join(cwd, ".claude", "settings.json"));
    await expect(plansDirectoryFromSettings(cwd)).resolves.toBeNull();
  });

  it.skipIf(process.platform === "win32")("ignores a FIFO settings.json", async () => {
    const cwd = tempDir("wooky-settings-fifo-");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const fifo = join(cwd, ".claude", "settings.json");
    await execFileAsync("mkfifo", [fifo]);
    await expect(plansDirectoryFromSettings(cwd)).resolves.toBeNull();
  });

  it("ignores settings.json larger than 1 MiB", async () => {
    const cwd = tempDir("wooky-settings-large-");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const big = JSON.stringify({ plansDirectory: "x".repeat(1 << 20) });
    writeFileSync(join(cwd, ".claude", "settings.json"), big);
    await expect(plansDirectoryFromSettings(cwd)).resolves.toBeNull();
  });
});

describe("resolvePlanMarkdown", () => {
  it("reads from a custom plansDirectory in project settings", async () => {
    const cwd = tempDir("wooky-plan-custom-dir-");
    const custom = join(cwd, "docs", "plans");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    mkdirSync(custom, { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ plansDirectory: "docs/plans" }),
    );
    const planPath = join(custom, "task.md");
    writeFileSync(planPath, "custom root");
    const result = await resolvePlanMarkdown({}, planPath, cwd);
    expect(result).toEqual({ ok: true, markdown: "custom root" });
  });

  it("surfaces distinct deny messages", () => {
    expect(planDenyMessage("outside_roots")).toMatch(/outside an allowed plans directory/i);
    expect(planDenyMessage("too_large")).toMatch(/too large/i);
    expect(planDenyMessage("symlink_file")).toMatch(/symbolic link/i);
    expect(planDenyMessage("missing_path")).toMatch(/plan file/i);
  });
});
