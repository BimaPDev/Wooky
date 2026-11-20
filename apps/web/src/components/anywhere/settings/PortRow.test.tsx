/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PortRow } from "./AnywhereSettings.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

async function show(override: number | null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(<PortRow port={4317} override={override} onCommit={() => {}} />),
  );
  return host.textContent ?? "";
}

describe("PortRow", () => {
  it("says when an explicit --port is in effect, and which port the server really uses", async () => {
    const text = await show(5555);
    expect(text).toContain("started with an explicit port");
    expect(text).toContain("listening on 5555");
  });

  it("says nothing extra when the setting rules", async () => {
    expect(await show(null)).not.toContain("explicit port");
  });
});
