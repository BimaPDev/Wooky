/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setBackend, type Backend } from "../../../state/backend.ts";
import { PairingSection } from "./PairingSection.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

async function showCode(result: unknown) {
  setBackend({ call: vi.fn<() => Promise<unknown>>(async () => result) } as unknown as Backend);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<PairingSection />));
  const button = [...host.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes("Show pairing code"),
  );
  await act(async () => button?.click());
  return host;
}

describe("PairingSection", () => {
  it("says hosting must be enabled and shows no code or URL when there is no reachable URL", async () => {
    const view = await showCode({
      code: "ABCD2345",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      url: null,
      reason: "Hosting is off. Turn on hosting under Settings → Anywhere → Host.",
    });
    expect(view.textContent).toContain("Hosting is off");
    expect(view.textContent).not.toContain("ABCD");
    expect(view.querySelector(".anywhere-url")).toBeNull();
  });

  it("shows the code and URL when the host is reachable", async () => {
    const view = await showCode({
      code: "ABCD2345",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      url: "http://192.168.1.5:4317",
      reason: null,
    });
    expect(view.textContent).toContain("ABCD 2345");
    expect(view.textContent).toContain("192.168.1.5");
  });
});
