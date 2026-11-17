import type { QuestionAnswers, UserInputRequest, UserQuestion } from "@age/contracts";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { isInsideWorkspace } from "../paths.ts";

export const ASK_USER_QUESTION = "AskUserQuestion";
export const EXIT_PLAN_MODE = "ExitPlanMode";

const PLAN_READ_MAX_BYTES = 1 << 20;

let planUserHome: string | undefined;

/** Test seam: never read the process user's real home in provider tests. */
export function setPlanUserHomeForTests(home: string | undefined): void {
  planUserHome = home;
}

function userHome(): string {
  return planUserHome ?? homedir();
}

const AskInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().optional(),
        options: z
          .array(z.object({ label: z.string(), description: z.string().optional() }))
          .default([]),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1),
});

/** The tool always adds an "Other" choice, so every question allows a typed answer. */
export function questionRequest(
  requestId: string,
  toolInput: Record<string, unknown>,
): UserInputRequest | null {
  const parsed = AskInput.safeParse(toolInput);
  if (!parsed.success) return null;
  const questions: UserQuestion[] = parsed.data.questions.map((entry) => ({
    id: entry.question,
    ...(entry.header ? { header: entry.header } : {}),
    question: entry.question,
    options: entry.options.map((option) => ({
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    multiSelect: entry.multiSelect === true,
    allowCustom: true,
  }));
  return { requestId, questions };
}

/** Quote labels the way the CLI serializes multi-select answers (pdn in the embedded CLI). */
export function quoteAnswerLabel(label: string): string {
  if (label.includes(", ") || label.includes('"')) return JSON.stringify(label);
  return label;
}

/** The tool reads `answers` as question text to one string; multi-select is comma-joined. */
export function toolAnswers(
  request: UserInputRequest,
  answers: QuestionAnswers,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const question of request.questions) {
    const chosen = answers[question.id];
    if (!chosen?.length) continue;
    if (question.multiSelect) {
      out[question.question] = chosen.map(quoteAnswerLabel).join(", ");
    } else {
      out[question.question] = chosen[0] ?? "";
    }
  }
  return out;
}

export function planMarkdown(toolInput: Record<string, unknown>): string | null {
  const plan = toolInput.plan;
  return typeof plan === "string" && plan.trim() !== "" ? plan : null;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export async function plansDirectoryFromSettings(cwd: string): Promise<string | null> {
  for (const name of ["settings.local.json", "settings.json"] as const) {
    try {
      const text = await readFile(join(cwd, ".claude", name), "utf8");
      const data = JSON.parse(text) as { plansDirectory?: unknown };
      const value = data.plansDirectory;
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    } catch {
      // missing or unreadable settings
    }
  }
  return null;
}

export async function planFileRoots(cwd: string): Promise<string[]> {
  const roots = [resolve(userHome(), ".claude", "plans"), resolve(cwd, ".claude", "plans")];
  const custom = await plansDirectoryFromSettings(cwd);
  if (custom) {
    const abs = resolve(cwd, custom);
    const cwdReal = realpathOrResolved(cwd);
    const inside = isInsideWorkspace(realpathOrResolved(abs), cwdReal);
    if (inside && !isSymlink(abs) && !roots.includes(abs)) roots.push(abs);
  }
  return roots;
}

export type PlanReadFailure =
  | "missing_path"
  | "outside_roots"
  | "symlink_file"
  | "hardlink_file"
  | "symlink_root"
  | "unreadable"
  | "too_large"
  | "empty";

export type PlanReadResult =
  { ok: true; markdown: string } | { ok: false; reason: PlanReadFailure };

export function planDenyMessage(reason: PlanReadFailure): string {
  switch (reason) {
    case "missing_path":
    case "empty":
      return "Write the plan to your plan file, then call ExitPlanMode again.";
    case "outside_roots":
      return "The plan file is outside an allowed plans directory.";
    case "symlink_file":
      return "The plan file must not be a symbolic link.";
    case "hardlink_file":
      return "The plan file must not be a hard link.";
    case "symlink_root":
      return "The plans directory must not be a symbolic link.";
    case "unreadable":
      return "The plan file could not be read.";
    case "too_large":
      return "The plan file is too large (maximum 1 MiB).";
  }
}

export async function validatePlanPath(
  filePath: string,
  cwd: string,
): Promise<{ allowed: true; absolute: string } | { allowed: false; reason: PlanReadFailure }> {
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch {
    return { allowed: false, reason: "unreadable" };
  }
  if (stat.isSymbolicLink()) return { allowed: false, reason: "symlink_file" };
  if (stat.isFile() && stat.nlink > 1) return { allowed: false, reason: "hardlink_file" };

  let fileReal: string;
  try {
    fileReal = realpathSync(absolute);
  } catch {
    return { allowed: false, reason: "unreadable" };
  }

  const roots = await planFileRoots(cwd);
  for (const root of roots) {
    const rootResolved = resolve(root);
    const rootSymlink = isSymlink(rootResolved);
    const rootReal = realpathOrResolved(rootResolved);
    if (!isInsideWorkspace(fileReal, rootReal)) continue;
    if (rootSymlink) return { allowed: false, reason: "symlink_root" };
    return { allowed: true, absolute };
  }
  return { allowed: false, reason: "outside_roots" };
}

export async function readPlanFromFile(filePath: string, cwd: string): Promise<PlanReadResult> {
  const check = await validatePlanPath(filePath, cwd);
  if (!check.allowed) return { ok: false, reason: check.reason };
  try {
    const handle = await open(check.absolute, "r");
    try {
      const buffer = Buffer.alloc(PLAN_READ_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > PLAN_READ_MAX_BYTES) return { ok: false, reason: "too_large" };
      const text = buffer.toString("utf8", 0, bytesRead).trim();
      if (text === "") return { ok: false, reason: "empty" };
      return { ok: true, markdown: text };
    } finally {
      await handle.close();
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

export async function resolvePlanMarkdown(
  toolInput: Record<string, unknown>,
  lastPlanWritePath: string | null,
  cwd: string,
): Promise<PlanReadResult> {
  const inline = planMarkdown(toolInput);
  if (inline) return { ok: true, markdown: inline };
  if (!lastPlanWritePath) return { ok: false, reason: "missing_path" };
  return readPlanFromFile(lastPlanWritePath, cwd);
}
