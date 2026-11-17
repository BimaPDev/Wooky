import { describe, expect, it } from "vitest";
import { questionRequest, quoteAnswerLabel, toolAnswers } from "./interaction.ts";

describe("toolAnswers", () => {
  it("quotes labels that contain comma-space the way the CLI encodes them", () => {
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
