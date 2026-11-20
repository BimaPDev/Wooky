/**
 * @vitest-environment happy-dom
 */
import { emptyReadModel } from "@wooky/domain";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../state/store.ts";
import {
  ComposerMenuPanel,
  filterPromptPresets,
  insertPromptText,
  promptIdFromPick,
  promptPickId,
  useComposerMenu,
} from "./ComposerMenu.tsx";
import { composerTrigger } from "../lib/composer-trigger.ts";

const at = "2026-01-01T00:00:00.000Z";

function Harness({
  text,
  caret,
  onPick,
}: {
  text: string;
  caret: number;
  onPick: (pick: string) => void;
}) {
  const menu = useComposerMenu(null, text, caret);
  if (!menu.trigger) return <p>no trigger</p>;
  return (
    <ComposerMenuPanel
      trigger={menu.trigger}
      slashItems={menu.slashItems}
      mentionItems={menu.mentionItems}
      mentionQuery={menu.mentionQuery}
      entriesQuery={menu.entriesQuery}
      searchUnavailable={menu.searchUnavailable}
      activeIndex={0}
      listId="menu"
      onPick={onPick}
    />
  );
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function render(ui: ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(ui);
  });
  return host;
}

beforeEach(() => {
  useStore.setState({
    model: {
      ...emptyReadModel(),
      projects: {
        p1: {
          id: "p1",
          name: "demo",
          root: "/work/demo",
          createdAt: at,
          settings: {
            scripts: [],
            sharedPaths: [],
            prompts: [{ id: "review", name: "Review the diff", text: "Do the thing." }],
          },
        },
      },
    },
    selectedThreadId: null,
    newThread: null,
    draftPrefs: { ...useStore.getState().draftPrefs, projectId: "p1" },
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  host = undefined;
  document.body.replaceChildren();
});

describe("prompt presets in the / menu", () => {
  it("filters presets by the query", () => {
    const presets = [
      { id: "review", name: "Review the diff", text: "Do the thing." },
      { id: "plan", name: "Plan a feature", text: "Plan it." },
    ];
    expect(filterPromptPresets(presets, "rev").map((preset) => preset.id)).toEqual(["review"]);
    expect(filterPromptPresets(presets, "")).toHaveLength(2);
  });

  it("lists a preset under Prompts and picks it by id", () => {
    const picks: string[] = [];
    render(<Harness text="/rev" caret={4} onPick={(pick) => picks.push(pick)} />);
    const panel = host as HTMLElement;
    expect(panel.textContent).toContain("Prompts");
    expect(panel.textContent).toContain("Review the diff");
    const option = [...panel.querySelectorAll("[role=option]")].find((candidate) =>
      candidate.textContent?.includes("Review the diff"),
    );
    if (!(option instanceof HTMLElement)) throw new Error("missing prompt option");
    act(() => {
      option.click();
    });
    expect(picks).toEqual([promptPickId("review")]);
    expect(promptIdFromPick(promptPickId("review"))).toBe("review");
  });

  it("inserts the preset text over the typed query", () => {
    const trigger = composerTrigger("/rev now", 4);
    if (!trigger) throw new Error("expected a slash trigger");
    const next = insertPromptText("/rev now", trigger, "Do the thing.");
    expect(next.text).toBe("Do the thing. now");
    expect(next.caret).toBe("Do the thing.".length);
  });
});
