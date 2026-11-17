import type { QuestionAnswers, UserInputRequest, UserQuestion } from "@age/contracts";
import { constants as fsConstants, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { isInsideWorkspace } from "../paths.ts";

export const ASK_USER_QUESTION = "AskUserQuestion";
export const EXIT_PLAN_MODE = "ExitPlanMode";

const PLAN_READ_MAX_BYTES = 1 << 20;
const SETTINGS_READ_MAX_BYTES = 1 << 20;

let planUserHome: string | undefined;

/** Test seam: never read the process user's real home in provider tests. */
export function setPlanUserHomeForTests(home: string | undefined): void {
  planUserHome = home;
}

type PlanFsHooks = {
  afterValidate?: () => void | Promise<void>;
  beforeRead?: () => void | Promise<void>;
};

let planFsHooksForTests: PlanFsHooks | undefined;

/** Test seam: deterministic swaps between validation and open/read. Not used in production. */
export function setPlanFsHooksForTests(hooks: PlanFsHooks | undefined): void {
  planFsHooksForTests = hooks;
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

export type OpenRegularFileFailure =
  | "not_found"
  | "outside_roots"
  | "symlink"
  | "hardlink"
  | "not_regular"
  | "too_large"
  | "changed"
  | "unreadable";

export type OpenRegularFileResult =
  { ok: true; data: Uint8Array } | { ok: false; reason: OpenRegularFileFailure };

function openRegularFileFlags(): number | string {
  const O_RDONLY = fsConstants.O_RDONLY ?? 0;
  if (process.platform === "win32") return O_RDONLY;
  const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
  const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
  return O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
}

type OpenRegularFileContainment = { kind: "plan"; cwd: string } | { kind: "settings"; cwd: string };

export async function openRegularFileSafely(
  filePath: string,
  maxBytes: number,
  containment: OpenRegularFileContainment,
): Promise<OpenRegularFileResult> {
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(containment.cwd, filePath);

  let entryStat;
  try {
    entryStat = await lstat(absolute);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "not_found" };
    return { ok: false, reason: "unreadable" };
  }

  if (containment.kind === "settings" && entryStat.isSymbolicLink()) {
    return { ok: false, reason: "symlink" };
  }
  if (containment.kind === "plan" && entryStat.isSymbolicLink()) {
    return { ok: false, reason: "symlink" };
  }
  if (!entryStat.isFile()) {
    return { ok: false, reason: "not_regular" };
  }

  let firstReal: string;
  try {
    firstReal = realpathSync(absolute);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const containmentFailure = await containmentFailureForRealPath(firstReal, containment);
  if (containmentFailure) return { ok: false, reason: containmentFailure };

  let identityBeforeHook: { dev: number | bigint; ino: number | bigint };
  try {
    const st = statSync(absolute);
    identityBeforeHook = { dev: st.dev, ino: st.ino };
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  await planFsHooksForTests?.afterValidate?.();

  let openTarget: string;
  try {
    openTarget = realpathSync(absolute);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (openTarget !== firstReal) return { ok: false, reason: "changed" };

  try {
    const st = statSync(absolute);
    if (st.dev !== identityBeforeHook.dev || st.ino !== identityBeforeHook.ino) {
      if (st.isFile() && st.nlink > 1) return { ok: false, reason: "hardlink" };
      return { ok: false, reason: "changed" };
    }
  } catch {
    return { ok: false, reason: "changed" };
  }

  const flags = openRegularFileFlags();
  let handle;
  try {
    handle = await open(openTarget, flags);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "not_found" };
    if (code === "ELOOP" || code === "EPERM") return { ok: false, reason: "symlink" };
    return { ok: false, reason: "unreadable" };
  }

  try {
    const fdStat = await handle.stat();
    if (!fdStat.isFile()) return { ok: false, reason: "not_regular" };
    if (fdStat.nlink !== 1) return { ok: false, reason: "hardlink" };
    if (fdStat.size > maxBytes) return { ok: false, reason: "too_large" };

    const identity = { dev: fdStat.dev, ino: fdStat.ino };

    await planFsHooksForTests?.beforeRead?.();

    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return { ok: false, reason: "too_large" };

    let afterReal: string;
    try {
      afterReal = realpathSync(absolute);
    } catch {
      return { ok: false, reason: "changed" };
    }
    if (afterReal !== firstReal) return { ok: false, reason: "changed" };

    let afterStat;
    try {
      afterStat = statSync(openTarget);
    } catch {
      return { ok: false, reason: "changed" };
    }
    if (afterStat.dev !== identity.dev || afterStat.ino !== identity.ino) {
      return { ok: false, reason: "changed" };
    }

    return { ok: true, data: buffer.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

async function containmentFailureForRealPath(
  fileReal: string,
  containment: OpenRegularFileContainment,
): Promise<OpenRegularFileFailure | null> {
  if (containment.kind === "settings") {
    const cwdReal = realpathOrResolved(containment.cwd);
    if (!isInsideWorkspace(fileReal, cwdReal)) return "outside_roots";
    return null;
  }

  const roots = await planFileRoots(containment.cwd);
  for (const root of roots) {
    const rootResolved = resolve(root);
    const rootSymlink = isSymlink(rootResolved);
    const rootReal = realpathOrResolved(rootResolved);
    if (!isInsideWorkspace(fileReal, rootReal)) continue;
    if (rootSymlink) return "outside_roots";
    return null;
  }
  return "outside_roots";
}

async function readSettingsJson(cwd: string, name: "settings.local.json" | "settings.json") {
  const path = join(cwd, ".claude", name);
  const opened = await openRegularFileSafely(path, SETTINGS_READ_MAX_BYTES, {
    kind: "settings",
    cwd,
  });
  if (!opened.ok) return null;
  try {
    const text = new TextDecoder().decode(opened.data);
    return JSON.parse(text) as { plansDirectory?: unknown };
  } catch {
    return null;
  }
}

export async function plansDirectoryFromSettings(cwd: string): Promise<string | null> {
  for (const name of ["settings.local.json", "settings.json"] as const) {
    const data = await readSettingsJson(cwd, name);
    if (!data) continue;
    const value = data.plansDirectory;
    if (typeof value === "string" && value.trim() !== "") return value.trim();
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
  | "empty"
  | "not_regular"
  | "changed";

export type PlanReadResult =
  { ok: true; markdown: string } | { ok: false; reason: PlanReadFailure };

function planFailureFromOpen(reason: OpenRegularFileFailure): PlanReadFailure {
  switch (reason) {
    case "not_found":
    case "unreadable":
      return "unreadable";
    case "outside_roots":
      return "outside_roots";
    case "symlink":
      return "symlink_file";
    case "hardlink":
      return "hardlink_file";
    case "not_regular":
      return "not_regular";
    case "too_large":
      return "too_large";
    case "changed":
      return "changed";
  }
}

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
    case "not_regular":
      return "The plan file must be a regular file.";
    case "changed":
      return "The plan file changed while it was being read.";
  }
}

export async function validatePlanPath(
  filePath: string,
  cwd: string,
): Promise<{ allowed: true; absolute: string } | { allowed: false; reason: PlanReadFailure }> {
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);

  try {
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink()) return { allowed: false, reason: "symlink_file" };
    if (entry.isFile() && entry.nlink > 1) return { allowed: false, reason: "hardlink_file" };
  } catch {
    return { allowed: false, reason: "unreadable" };
  }

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

  const opened = await openRegularFileSafely(check.absolute, PLAN_READ_MAX_BYTES, {
    kind: "plan",
    cwd,
  });
  if (!opened.ok) return { ok: false, reason: planFailureFromOpen(opened.reason) };

  const text = new TextDecoder().decode(opened.data).trim();
  if (text === "") return { ok: false, reason: "empty" };
  return { ok: true, markdown: text };
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
