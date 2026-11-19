/**
 * @vitest-environment happy-dom
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip.tsx";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let clock = Date.parse("2026-01-01T00:00:00Z");

function renderTooltip(ui: ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(ui);
  });
  const button = host.querySelector("button");
  const anchor = button?.parentElement;
  if (!button || !anchor) throw new Error("tooltip trigger did not render");
  return { button, anchor };
}

function tip() {
  return document.querySelector("[role='tooltip']");
}

function enter(anchor: Element) {
  act(() => {
    anchor.dispatchEvent(new Event("pointerenter"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  clock += 60_000;
  vi.setSystemTime(clock);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  host = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("Tooltip", () => {
  it("appears after the hover delay and does not repeat the accessible name", () => {
    const { button, anchor } = renderTooltip(
      <Tooltip label="Add project">
        <button type="button" aria-label="Add project">
          +
        </button>
      </Tooltip>,
    );

    enter(anchor);
    expect(tip()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(tip()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const shown = tip();
    expect(shown?.textContent).toBe("Add project");
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(shown?.getAttribute("aria-hidden")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Add project");
  });

  it("describes the trigger when the tooltip adds something the name does not say", () => {
    const { button } = renderTooltip(
      <Tooltip label="Agent board">
        <button type="button" aria-label="Open agent board">
          +
        </button>
      </Tooltip>,
    );
    const anchor = button.parentElement;
    if (!anchor) throw new Error("missing anchor");
    enter(anchor);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const shown = tip();
    expect(shown?.textContent).toBe("Agent board");
    expect(button.getAttribute("aria-describedby")).toBe(shown?.id);
    expect(shown?.getAttribute("aria-hidden")).toBeNull();
  });

  it("appears immediately on keyboard focus", () => {
    const { button } = renderTooltip(
      <Tooltip label="New thread">
        <button type="button" aria-label="New thread">
          +
        </button>
      </Tooltip>,
    );
    act(() => {
      button.focus();
    });
    expect(tip()?.textContent).toBe("New thread");
  });

  it("hides on Escape and on pointer leave", () => {
    const { anchor } = renderTooltip(
      <Tooltip label="Hide sidebar">
        <button type="button" aria-label="Hide sidebar">
          +
        </button>
      </Tooltip>,
    );

    enter(anchor);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(tip()).not.toBeNull();

    act(() => {
      anchor.dispatchEvent(new Event("pointerleave"));
    });
    expect(tip()).toBeNull();

    enter(anchor);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(tip()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(tip()).toBeNull();
  });

  it("opens immediately when another tooltip closed moments ago", () => {
    renderTooltip(
      <>
        <Tooltip label="Add project">
          <button type="button" aria-label="Add project">
            +
          </button>
        </Tooltip>
        <Tooltip label="New thread">
          <button type="button" aria-label="New thread">
            +
          </button>
        </Tooltip>
      </>,
    );
    const anchors = host?.querySelectorAll(".tooltip-anchor");
    const first = anchors?.[0];
    const second = anchors?.[1];
    if (!first || !second) throw new Error("missing anchors");

    enter(first);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(tip()?.textContent).toBe("Add project");

    act(() => {
      first.dispatchEvent(new Event("pointerleave"));
    });
    expect(tip()).toBeNull();

    enter(second);
    expect(tip()?.textContent).toBe("New thread");
  });
});
