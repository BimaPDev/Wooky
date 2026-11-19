import type { UserQuestion } from "@wooky/contracts";
import { describe, expect, it } from "vitest";
import { buildQuestionAnswers, labelsForQuestion, questionSummary } from "./question-answers.ts";

const questions: UserQuestion[] = [
  {
    id: "q1",
    header: "Approach",
    question: "Which approach?",
    options: [
      { label: "A", description: "First" },
      { label: "B", description: "Second" },
    ],
    multiSelect: false,
    allowCustom: false,
  },
  {
    id: "q2",
    question: "Extras",
    options: [{ label: "Tests", description: "Add tests" }],
    multiSelect: true,
    allowCustom: true,
  },
];

describe("buildQuestionAnswers", () => {
  it("returns null when any question is unanswered", () => {
    expect(
      buildQuestionAnswers(questions, {
        q1: { selected: ["A"], other: "" },
        q2: { selected: [], other: "" },
      }),
    ).toBeNull();
  });

  it("includes custom other text when allowed", () => {
    const answers = buildQuestionAnswers(questions, {
      q1: { selected: ["B"], other: "" },
      q2: { selected: ["Tests"], other: "Docs" },
    });
    expect(answers).toEqual({ q1: ["B"], q2: ["Tests", "Docs"] });
  });
});

describe("labelsForQuestion", () => {
  it("appends trimmed other only when allowCustom", () => {
    const extras = questions.find((q) => q.id === "q2");
    expect(extras).toBeDefined();
    if (!extras) return;
    expect(labelsForQuestion(extras, { selected: [], other: "  x  " })).toEqual(["x"]);
  });
});

describe("questionSummary", () => {
  it("joins answered labels", () => {
    expect(questionSummary(questions, { q1: ["A"], q2: ["Tests"] })).toBe(
      "Approach: A · Extras: Tests",
    );
  });
});
