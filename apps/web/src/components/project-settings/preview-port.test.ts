import { describe, expect, it } from "vitest";
import { detectPreviewPort, previewTemplate, resolvePreviewUrl } from "./preview-port.ts";

describe("detectPreviewPort", () => {
  it("reads the first localhost or 127.0.0.1 URL", () => {
    expect(detectPreviewPort("listening on http://localhost:5173\n")).toBe(5173);
    expect(detectPreviewPort("ready at http://127.0.0.1:3000/")).toBe(3000);
    expect(detectPreviewPort("localhost:8080")).toBe(8080);
    expect(detectPreviewPort("no url here")).toBeNull();
  });
});

describe("resolvePreviewUrl", () => {
  it("replaces ${PORT} once a port is known", () => {
    expect(resolvePreviewUrl("http://localhost:${PORT}", null)).toBeNull();
    expect(resolvePreviewUrl("http://localhost:${PORT}", 5173)).toBe("http://localhost:5173");
    expect(resolvePreviewUrl("http://example.test", null)).toBe("http://example.test");
  });

  it("prefers the script preview over the project default", () => {
    expect(previewTemplate("http://localhost:${PORT}", "http://localhost:1")).toBe(
      "http://localhost:${PORT}",
    );
    expect(previewTemplate(undefined, "http://localhost:1")).toBe("http://localhost:1");
  });
});
