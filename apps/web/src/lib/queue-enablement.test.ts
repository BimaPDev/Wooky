import { describe, expect, it } from "vitest";
import { canPromoteQueuedPrompt } from "./queue-enablement.ts";

describe("canPromoteQueuedPrompt", () => {
  it("allows promote only when idle", () => {
    expect(canPromoteQueuedPrompt("idle")).toBe(true);
    expect(canPromoteQueuedPrompt("running")).toBe(false);
    expect(canPromoteQueuedPrompt("waiting")).toBe(false);
    expect(canPromoteQueuedPrompt("error")).toBe(false);
  });
});
