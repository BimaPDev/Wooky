import { describe, expect, it } from "vitest";
import { isPublicShell } from "./http.ts";

describe("isPublicShell", () => {
  it("serves the UI shell and its assets without a token", () => {
    for (const path of [
      "/",
      "/index.html",
      "/assets/index-abc123.js",
      "/assets/app.css",
      "/assets/font.woff2",
      "/favicon.ico",
      "/manifest.json",
      "/project/abc",
    ]) {
      expect(isPublicShell("GET", path)).toBe(true);
    }
    expect(isPublicShell("HEAD", "/")).toBe(true);
  });

  it("keeps health, sockets, sync and writes authenticated", () => {
    for (const path of ["/healthz", "/ws", "/sync", "/sync/snapshots"]) {
      expect(isPublicShell("GET", path)).toBe(false);
    }
    expect(isPublicShell("POST", "/")).toBe(false);
    expect(isPublicShell("DELETE", "/assets/app.js")).toBe(false);
    expect(isPublicShell("GET", "/secrets.json")).toBe(false);
    expect(isPublicShell("GET", "/data.db")).toBe(false);
  });
});
