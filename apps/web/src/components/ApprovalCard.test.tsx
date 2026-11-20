/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callsTo, installFixtureBackend } from "./anywhere/testing.ts";
import { TimelineEntry } from "./Timeline.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((entry) => entry.textContent?.startsWith(label)) as
    HTMLButtonElement | undefined;

function mount(decision: "allow" | "deny" | null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <TimelineEntry
        threadId="t1"
        item={{
          kind: "approval",
          id: "a1",
          requestId: "r1",
          tool: "command",
          title: "rm -rf build",
          detail: "",
          decision,
        }}
      />,
    ),
  );
}

beforeEach(() => {
  installFixtureBackend();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
});

describe("a pending approval", () => {
  it("offers Stop next to Deny, and Stop interrupts the turn instead of answering", async () => {
    const backend = installFixtureBackend();
    mount(null);
    expect(button("Deny")).toBeDefined();
    expect(button("Approve")).toBeDefined();
    await act(async () => button("Stop")?.click());
    const [sent] = callsTo(backend.call, "dispatch") as Record<string, unknown>[];
    expect(sent).toMatchObject({ type: "turn.interrupt", threadId: "t1" });
    expect(callsTo(backend.call, "dispatch")).toHaveLength(1);
  });

  it("shows no actions once it was answered", () => {
    mount("allow");
    expect(button("Stop")).toBeUndefined();
    expect(button("Deny")).toBeUndefined();
  });
});
