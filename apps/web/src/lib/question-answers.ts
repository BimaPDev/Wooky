import type { QuestionAnswers, UserQuestion } from "@wooky/contracts";

export type QuestionDraft = Record<string, { selected: string[]; other: string }>;

export function emptyDraft(questions: readonly UserQuestion[]): QuestionDraft {
  const draft: QuestionDraft = {};
  for (const q of questions) draft[q.id] = { selected: [], other: "" };
  return draft;
}

/** Labels chosen for one question, including free-text Other when set. */
export function labelsForQuestion(
  question: UserQuestion,
  entry: { selected: string[]; other: string },
): string[] {
  const labels = [...entry.selected];
  const other = entry.other.trim();
  if (question.allowCustom && other) labels.push(other);
  return labels;
}

export function buildQuestionAnswers(
  questions: readonly UserQuestion[],
  draft: QuestionDraft,
): QuestionAnswers | null {
  const answers: QuestionAnswers = {};
  for (const question of questions) {
    const entry = draft[question.id] ?? { selected: [], other: "" };
    const labels = labelsForQuestion(question, entry);
    if (labels.length === 0) return null;
    answers[question.id] = labels;
  }
  return answers;
}

export function questionSummary(
  questions: readonly UserQuestion[],
  answers: QuestionAnswers,
  dismissed?: boolean,
): string {
  if (dismissed) return "Question dismissed";
  const parts = questions.map((q) => {
    const picked = answers[q.id]?.join(", ") ?? "";
    const head = q.header ?? q.question;
    return picked ? `${head}: ${picked}` : head;
  });
  return parts.join(" · ");
}
