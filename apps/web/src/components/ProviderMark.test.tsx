/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { USAGE_SERIES_ORDER } from "../lib/usage-merge.ts";
import { UsageProviderMark } from "./ProviderMark.tsx";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("UsageProviderMark", () => {
  it("renders a glyph tile for every usage series and ACP", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const kinds = [...USAGE_SERIES_ORDER, "acp" as const];
    act(() => {
      root?.render(
        <>
          {kinds.map((kind) => (
            <UsageProviderMark key={kind} kind={kind} />
          ))}
        </>,
      );
    });
    const marks = [...host.querySelectorAll(".provider-mark")];
    expect(marks.map((mark) => mark.className)).toEqual(
      kinds.map((kind) => `provider-mark provider-${kind}`),
    );
    for (const mark of marks) {
      expect(mark.querySelector("svg :is(path, circle, rect, ellipse)")).not.toBeNull();
    }
  });
});
