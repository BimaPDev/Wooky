import type { QuestionAnswers, UserInputRequest, UserQuestion } from "@age/contracts";
import { z } from "zod";

export const ASK_USER_QUESTION = "AskUserQuestion";
export const EXIT_PLAN_MODE = "ExitPlanMode";

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

/** The tool reads `answers` as question text to one string; multi-select is comma-joined. */
export function toolAnswers(
  request: UserInputRequest,
  answers: QuestionAnswers,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const question of request.questions) {
    const chosen = answers[question.id];
    if (chosen) out[question.question] = chosen.join(", ");
  }
  return out;
}

/** The CLI puts the plan text on the ExitPlanMode input before asking permission. */
export function planMarkdown(toolInput: Record<string, unknown>): string | null {
  const plan = toolInput.plan;
  return typeof plan === "string" && plan.trim() !== "" ? plan : null;
}
