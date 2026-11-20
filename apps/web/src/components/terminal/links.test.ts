/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vitest";
import { findHttpLinks, openExternalUrl, shouldOpenTerminalLink } from "./links.ts";

describe("findHttpLinks", () => {
  it("finds http and https URLs", () => {
    expect(findHttpLinks("see http://localhost:5173 and https://example.com/a")).toEqual([
      { text: "http://localhost:5173", start: 4, end: 25 },
      { text: "https://example.com/a", start: 30, end: 51 },
    ]);
  });

  it("trims trailing punctuation", () => {
    expect(findHttpLinks("go to https://example.com.")).toEqual([
      { text: "https://example.com", start: 6, end: 25 },
    ]);
  });
});

describe("shouldOpenTerminalLink", () => {
  it("opens on Cmd or Ctrl", () => {
    expect(shouldOpenTerminalLink({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(shouldOpenTerminalLink({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(shouldOpenTerminalLink({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});

describe("openExternalUrl", () => {
  it("opens http and https addresses", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openExternalUrl("https://example.com/docs")).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");
  });

  it("refuses other schemes without opening anything, logging once", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(openExternalUrl("javascript:alert(1)")).toBe(false);
    expect(openExternalUrl("javascript:alert(1)")).toBe(false);
    expect(openExternalUrl("data:text/html,<script></script>")).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("keeps a preview on this machine", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(openExternalUrl("http://localhost:5173", { localOnly: true })).toBe(true);
    expect(openExternalUrl("http://127.0.0.1:5173", { localOnly: true })).toBe(true);
    expect(openExternalUrl("http://[::1]:5173", { localOnly: true })).toBe(true);
    expect(openExternalUrl("http://evil.example:5173", { localOnly: true })).toBe(false);
    expect(openExternalUrl("not a url", { localOnly: true })).toBe(false);
    expect(open).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
