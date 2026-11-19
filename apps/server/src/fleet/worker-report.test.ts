import { describe, expect, it } from "vitest";
import { emptyReadModel } from "@wooky/domain";
import { shouldReportWorker, turnSummary } from "./worker-report.ts";

describe("worker report rules", () => {
  it("reports interrupted worker turns", () => {
    expect(
      shouldReportWorker(
        {
          id: "w",
          projectId: "p",
          title: "w",
          provider: "demo",
          model: "demo",
          runtimeMode: "approve",
          worktree: null,
          providerSessionId: null,
          queue: [],
          status: "idle",
          role: "worker",
          parentThreadId: "c",
          createdAt: "t",
          updatedAt: "t",
        },
        "interrupted",
      ),
    ).toBe(true);
  });

  it("uses the turn error for failed reports", () => {
    const model = emptyReadModel();
    expect(turnSummary(model, "w", "u", "failed", "rate limited")).toBe("rate limited");
  });

  it("marks interrupted status in the summary", () => {
    const model = emptyReadModel();
    expect(turnSummary(model, "w", "u", "interrupted", null)).toBe("Turn interrupted.");
  });
});
