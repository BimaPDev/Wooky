/**
 * @vitest-environment happy-dom
 */
import type { Turn } from "@wooky/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../state/store.ts";
import { installFixtureBackend } from "./anywhere/testing.ts";
import { ThreadView } from "./ThreadView.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const at = "2026-01-01T00:00:00.000Z";

const planTurn: Turn = {
  id: "turn1",
  threadId: "t1",
  prompt: "plan this",
  provider: "demo",
  model: "demo",
  status: "completed",
  startedAt: at,
  endedAt: at,
  checkpointBefore: null,
  checkpointAfter: null,
  changedFiles: [],
  usage: null,
  error: null,
  items: [
    { kind: "reasoning", id: "r1", text: "Thinking it over." },
    {
      kind: "plan",
      id: "p1",
      markdown: "# Plan\n\nAdd a line to the demo file",
      status: "proposed",
    },
    { kind: "message", id: "m1", role: "assistant", text: "Proposed a plan." },
  ],
};

describe("ThreadView finished plan turn", () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    installFixtureBackend();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  it("keeps the proposed plan visible without expanding the turn summary", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<ThreadView threadId="t1" peerTurns={[planTurn]} />);
    });
    expect(host.textContent).toContain("Add a line to the demo file");
    // The reasoning step stays behind the summary.
    expect(host.textContent).not.toContain("Thinking it over.");
  });
});
