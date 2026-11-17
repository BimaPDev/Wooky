import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  planDenyMessage,
  readPlanFromFile,
  resolvePlanMarkdown,
  setPlanUserHomeForTests,
  toolAnswers,
  questionRequest,
  quoteAnswerLabel,
} from "./interaction.ts";

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  setPlanUserHomeForTests(undefined);
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
    const cwd = tempDir(`age-plan-${name}-`);
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
    const cwd = tempDir("age-plan-symlink-root-");
    const outside = tempDir("age-plan-outside-");
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
    const base = tempDir("age-plan-var-");
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
});

describe("resolvePlanMarkdown", () => {
  it("reads from a custom plansDirectory in project settings", async () => {
    const cwd = tempDir("age-plan-custom-dir-");
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
