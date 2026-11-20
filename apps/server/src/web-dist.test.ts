import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findWebDist } from "./web-dist.ts";

describe("findWebDist", () => {
  const src = join("/repo", "apps", "server", "src");

  it("finds the source checkout's built web UI regardless of the cwd", () => {
    const built = join("/repo", "apps", "web", "dist");
    const found = findWebDist(src, (path) => path === join(built, "index.html"));
    expect(found).toBe(join(src, "..", "..", "web", "dist"));
  });

  it("prefers the web UI bundled next to the server in a release", () => {
    const dist = join("/opt", "wooky", "dist");
    const found = findWebDist(dist, (path) => path.endsWith("index.html"));
    expect(found).toBe(join(dist, "..", "web"));
  });

  it("returns null when the web UI was never built", () => {
    expect(findWebDist(src, () => false)).toBeNull();
  });
});
