/**
 * @vitest-environment happy-dom
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTooltipForTests, Tooltip } from "./Tooltip.tsx";

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
  resetTooltipForTests();
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
  resetTooltipForTests();
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

  it("leaves Escape for other listeners to dismiss the layer underneath", () => {
    const { button, anchor } = renderTooltip(
      <Tooltip label="Close">
        <button type="button" aria-label="Close">
          ×
        </button>
      </Tooltip>,
    );
    enter(anchor);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(tip()).not.toBeNull();

    let documentSaw = false;
    let windowSaw = false;
    const onDocument = () => {
      documentSaw = true;
    };
    const onWindow = () => {
      windowSaw = true;
    };
    document.addEventListener("keydown", onDocument);
    window.addEventListener("keydown", onWindow);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      button.dispatchEvent(event);
    });
    document.removeEventListener("keydown", onDocument);
    window.removeEventListener("keydown", onWindow);

    expect(tip()).toBeNull();
    expect(event.defaultPrevented).toBe(false);
    expect(documentSaw).toBe(true);
    expect(windowSaw).toBe(true);
  });

  it("hides the popover when the tooltip closes and when the trigger unmounts", () => {
    const proto = HTMLElement.prototype;
    const previousShow = Object.getOwnPropertyDescriptor(proto, "showPopover");
    const previousHide = Object.getOwnPropertyDescriptor(proto, "hidePopover");
    const previousMatches = proto.matches;
    const show = vi.fn<(this: HTMLElement) => void>(function showPopover(this: HTMLElement) {
      this.toggleAttribute("data-popover-open", true);
    });
    const hide = vi.fn<(this: HTMLElement) => void>(function hidePopover(this: HTMLElement) {
      this.toggleAttribute("data-popover-open", false);
    });
    Object.defineProperty(proto, "showPopover", { configurable: true, value: show });
    Object.defineProperty(proto, "hidePopover", { configurable: true, value: hide });
    proto.matches = function matches(this: HTMLElement, selectors: string) {
      if (selectors === ":popover-open") return this.hasAttribute("data-popover-open");
      return previousMatches.call(this, selectors);
    } as typeof proto.matches;

    try {
      const { anchor } = renderTooltip(
        <Tooltip label="Copy path">
          <button type="button" aria-label="Copy path">
            +
          </button>
        </Tooltip>,
      );
      enter(anchor);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(show).toHaveBeenCalled();

      act(() => {
        anchor.dispatchEvent(new Event("pointerleave"));
      });
      expect(hide).toHaveBeenCalled();

      hide.mockClear();
      enter(anchor);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      act(() => {
        root?.unmount();
      });
      root = undefined;
      expect(hide).toHaveBeenCalled();
    } finally {
      proto.matches = previousMatches;
      if (previousShow) Object.defineProperty(proto, "showPopover", previousShow);
      else Reflect.deleteProperty(proto, "showPopover");
      if (previousHide) Object.defineProperty(proto, "hidePopover", previousHide);
      else Reflect.deleteProperty(proto, "hidePopover");
    }
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
