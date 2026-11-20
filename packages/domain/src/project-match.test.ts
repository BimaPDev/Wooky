import { describe, expect, it } from "vitest";
import {
  folderBasename,
  normalizeRemoteUrl,
  suggestLocalProject,
  withLocalMapping,
} from "./project-match.ts";

describe("normalizeRemoteUrl", () => {
  it("makes every spelling of a remote the same, and drops credentials, scheme, port and .git", () => {
    const same = [
      "https://github.com/Acme/Billing.git",
      "https://deploy:s3cret@GitHub.com/acme/billing/",
      "http://user@github.com:8443/acme/billing.git",
      "ssh://git@github.com:22/acme/billing.git",
      "git@github.com:acme/billing.git",
      "github.com:acme/billing",
      "github.com/acme/billing",
    ];
    for (const raw of same)
      expect(`${raw} → ${normalizeRemoteUrl(raw)}`).toBe(`${raw} → github.com/acme/billing`);
  });

  it("keeps different repositories apart", () => {
    expect(normalizeRemoteUrl("git@github.com:acme/billing")).not.toBe(
      normalizeRemoteUrl("git@github.com:acme/orders"),
    );
    expect(normalizeRemoteUrl("git@gitlab.com:acme/billing")).not.toBe(
      normalizeRemoteUrl("git@github.com:acme/billing"),
    );
  });

  it("refuses anything that is not a remote address", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "   ",
      "/local/path/repo",
      "C:\\repo",
      "has space/x",
      "file:///tmp/repo",
      "https://host-only",
      `https://example.com/${"a".repeat(600)}`,
      "https://exa\u0000mple.com/x",
    ]) {
      expect(`${String(raw)} → ${normalizeRemoteUrl(raw as string | null | undefined)}`).toBe(
        `${String(raw)} → null`,
      );
    }
  });
});

describe("folderBasename", () => {
  it("is only the last segment, whatever the separator", () => {
    expect(folderBasename("/Users/me/code/app")).toBe("app");
    expect(folderBasename("C:\\Users\\me\\app\\")).toBe("app");
    expect(folderBasename("")).toBe("");
    expect(folderBasename("x".repeat(1000))).toHaveLength(255);
  });
});

describe("suggestLocalProject", () => {
  const locals = [
    { id: "a", name: "api", root: "/w/api", remote: "github.com/acme/billing" },
    { id: "b", name: "site", root: "/w/site", remote: null },
    { id: "c", name: "tool", root: "/w/tool", remote: "github.com/acme/tool" },
  ];

  it("prefers the same remote over the same folder name", () => {
    expect(
      suggestLocalProject(
        { folder: "site", remote: "https://github.com/Acme/billing.git" },
        locals,
      ),
    ).toEqual({ projectId: "a", by: "remote" });
  });

  it("falls back to the folder name, ignoring case", () => {
    expect(suggestLocalProject({ folder: "SITE", remote: null }, locals)).toEqual({
      projectId: "b",
      by: "folder",
    });
  });

  it("suggests nothing when nothing matches or two projects tie", () => {
    expect(suggestLocalProject({ folder: "other", remote: null }, locals)).toBeNull();
    const twins = [
      { id: "a", name: "x", root: "/a/app", remote: null },
      { id: "b", name: "y", root: "/b/app", remote: null },
    ];
    expect(suggestLocalProject({ folder: "app", remote: null }, twins)).toBeNull();
  });

  it("does not offer a project that is already mapped to something else", () => {
    expect(
      suggestLocalProject({ folder: "site", remote: null }, locals, new Set(["b"])),
    ).toBeNull();
  });
});

describe("withLocalMapping", () => {
  const same = (a: string, b: string) => a === b;

  it("keys the map by the peer's project id and this device", () => {
    expect(withLocalMapping({}, "proj_peer", "me", "/w/api", same)).toEqual({
      proj_peer: { me: "/w/api" },
    });
  });

  it("moves a folder from one peer project to another, leaving other devices alone", () => {
    const before = { old: { me: "/w/api", peer: "/p/api" }, keep: { me: "/w/site" } };
    expect(withLocalMapping(before, "next", "me", "/w/api", same)).toEqual({
      old: { peer: "/p/api" },
      keep: { me: "/w/site" },
      next: { me: "/w/api" },
    });
  });

  it("clears this device's entry with null and drops an empty row", () => {
    expect(withLocalMapping({ a: { me: "/w/api" } }, "a", "me", null, same)).toEqual({});
    expect(withLocalMapping({ a: { me: "/w/api", peer: "/p" } }, "a", "me", null, same)).toEqual({
      a: { peer: "/p" },
    });
  });
});
