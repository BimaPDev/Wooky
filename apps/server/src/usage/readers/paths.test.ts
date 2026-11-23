import { describe, expect, it } from "vitest";
import {
  antigravityDataDirs,
  claudeConfigDir,
  codexSessionsDir,
  cursorAccountCachePaths,
  cursorIdeDatabasePaths,
  cursorProjectsDir,
  opencodeDataDirs,
  resolveUserHome,
} from "./paths.ts";

describe("usage reader path resolution", () => {
  it("resolves user home from platform env overrides first", () => {
    expect(resolveUserHome({ USERPROFILE: "C:\\Users\\Alice", HOME: "/ignored" }, "win32")).toBe(
      "C:\\Users\\Alice",
    );
    expect(resolveUserHome({ HOMEDRIVE: "D:", HOMEPATH: "\\Users\\Bob" }, "win32")).toBe(
      "D:\\Users\\Bob",
    );
    expect(resolveUserHome({ HOME: "/Users/carol" }, "darwin")).toBe("/Users/carol");
  });

  it("resolves Codex and Claude roots with explicit overrides and Windows home", () => {
    expect(codexSessionsDir({ homeDir: "C:\\Users\\Alice", env: {} }, "win32")).toBe(
      "C:\\Users\\Alice\\.codex\\sessions",
    );
    expect(
      codexSessionsDir({ homeDir: "C:\\Users\\Alice", env: { CODEX_HOME: "D:\\codex" } }, "win32"),
    ).toBe("D:\\codex\\sessions");
    expect(
      claudeConfigDir(
        { homeDir: "C:\\Users\\Alice", env: { CLAUDE_CONFIG_DIR: "D:\\claude" } },
        "win32",
      ),
    ).toBe("D:\\claude");
  });

  it("resolves Cursor projects, cache and IDE database paths including Windows APPDATA", () => {
    const winCtx = {
      homeDir: "C:\\Users\\Alice",
      env: { APPDATA: "D:\\Roaming", WOOKY_HOME: "D:\\wooky" },
    };
    expect(cursorProjectsDir(winCtx, "win32")).toBe("C:\\Users\\Alice\\.cursor\\projects");
    expect(cursorAccountCachePaths(winCtx, "cache.json", "win32")).toEqual([
      "D:\\wooky\\cache.json",
      "C:\\Users\\Alice\\.t3\\userdata\\cache.json",
      "C:\\Users\\Alice\\.wooky\\cache.json",
    ]);
    const idePaths = cursorIdeDatabasePaths(winCtx, "win32");
    expect(idePaths).toContain("D:\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb");
    expect(idePaths).toContain(
      "C:\\Users\\Alice\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb",
    );
  });

  it("resolves OpenCode data directories from explicit overrides, XDG and Windows AppData", () => {
    expect(
      opencodeDataDirs(
        {
          homeDir: "C:\\Users\\Alice",
          env: { OPENCODE_DATA_DIR: "D:\\oc-a, D:\\oc-b", XDG_DATA_HOME: "D:\\xdg" },
        },
        "win32",
      ),
    ).toEqual(["D:\\oc-a", "D:\\oc-b"]);
    expect(
      opencodeDataDirs({ homeDir: "C:\\Users\\Alice", env: { XDG_DATA_HOME: "D:\\xdg" } }, "win32"),
    ).toEqual(["D:\\xdg\\opencode"]);
    expect(
      opencodeDataDirs(
        {
          homeDir: "C:\\Users\\Alice",
          env: { LOCALAPPDATA: "D:\\Local", APPDATA: "D:\\Roaming" },
        },
        "win32",
      ),
    ).toEqual([
      "C:\\Users\\Alice\\.local\\share\\opencode",
      "D:\\Local\\opencode",
      "D:\\Roaming\\opencode",
      "C:\\Users\\Alice\\AppData\\Local\\opencode",
      "C:\\Users\\Alice\\AppData\\Roaming\\opencode",
    ]);
  });

  it("resolves Antigravity data directories with overrides and Windows AppData", () => {
    expect(
      antigravityDataDirs(
        { homeDir: "C:\\Users\\Alice", env: { ANTIGRAVITY_DATA_DIR: "D:\\ag" } },
        "win32",
      ),
    ).toEqual(["D:\\ag"]);
    const dirs = antigravityDataDirs(
      {
        homeDir: "C:\\Users\\Alice",
        env: { APPDATA: "D:\\Roaming", LOCALAPPDATA: "D:\\Local" },
      },
      "win32",
    );
    expect(dirs).toContain("C:\\Users\\Alice\\.gemini\\antigravity");
    expect(dirs).toContain("D:\\Roaming\\antigravity");
    expect(dirs).toContain("D:\\Local\\antigravity");
    expect(dirs).toContain("C:\\Users\\Alice\\AppData\\Roaming\\antigravity");
    expect(dirs).toContain("C:\\Users\\Alice\\AppData\\Local\\antigravity");
  });
});
