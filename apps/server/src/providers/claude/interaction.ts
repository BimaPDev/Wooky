import type { QuestionAnswers, UserInputRequest, UserQuestion } from "@age/contracts";
import { homedir } from "node:os";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const ASK_USER_QUESTION = "AskUserQuestion";
export const EXIT_PLAN_MODE = "ExitPlanMode";

const PLAN_READ_MAX_BYTES = 1 << 20;

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
      out[question.question] = quoteAnswerLabel(chosen[0] ?? "");
    }
  }
  return out;
}

export function planMarkdown(toolInput: Record<string, unknown>): string | null {
  const plan = toolInput.plan;
  return typeof plan === "string" && plan.trim() !== "" ? plan : null;
}

export function planFileRoots(cwd: string): string[] {
  const roots = [resolve(homedir(), ".claude", "plans")];
  const project = resolve(cwd, ".claude", "plans");
  if (!roots.includes(project)) roots.push(project);
  return roots;
}

export function isAllowedPlanPath(filePath: string, cwd: string): boolean {
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  const roots = planFileRoots(cwd);
  return roots.some((root) => {
    const base = resolve(root);
    return absolute === base || absolute.startsWith(`${base}/`);
  });
}

export async function readPlanFromFile(filePath: string, cwd: string): Promise<string | null> {
  if (!isAllowedPlanPath(filePath, cwd)) return null;
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  try {
    const handle = await open(absolute, "r");
    try {
      const buffer = Buffer.alloc(PLAN_READ_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead <= PLAN_READ_MAX_BYTES) {
        const text = buffer.toString("utf8", 0, bytesRead).trim();
        return text === "" ? null : text;
      }
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  return null;
}

export async function resolvePlanMarkdown(
  toolInput: Record<string, unknown>,
  lastPlanWritePath: string | null,
  cwd: string,
): Promise<string | null> {
  const inline = planMarkdown(toolInput);
  if (inline) return inline;
  if (!lastPlanWritePath) return null;
  return readPlanFromFile(lastPlanWritePath, cwd);
}
