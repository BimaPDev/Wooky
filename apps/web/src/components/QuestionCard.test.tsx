/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { QuestionCard } from "./QuestionCard.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

async function mount(question: { header?: string }) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <QuestionCard
        threadId="t1"
        item={{
          kind: "question",
          id: "q1",
          requestId: "r1",
          answers: null,
          questions: [
            {
              id: "confirm",
              question: "Continue?",
              options: [{ label: "Yes" }, { label: "No" }],
              multiSelect: false,
              allowCustom: true,
              ...question,
            },
          ],
        }}
      />,
    );
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("QuestionCard", () => {
  it("shows the question once when it has no separate header", async () => {
    await mount({});
    expect(host?.textContent?.match(/Continue\?/g)).toHaveLength(1);
  });

  it("shows the header and the question when they differ", async () => {
    await mount({ header: "Deploy" });
    expect(host?.textContent).toContain("Deploy");
    expect(host?.textContent).toContain("Continue?");
  });
});
