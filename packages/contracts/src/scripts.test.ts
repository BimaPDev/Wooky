import { describe, expect, it } from "vitest";
import { Project, AgeEvent } from "./index.ts";
import {
  ProjectPrompt,
  ProjectScript,
  ProjectSettings,
  SharedPath,
  SharedRelPath,
  StoredProjectSettings,
} from "./scripts.ts";

const at = "2026-01-01T00:00:00.000Z";

describe("shared paths", () => {
  it("accepts relative files and directories", () => {
    expect(SharedRelPath.parse(".env")).toBe(".env");
    expect(SharedRelPath.parse(".env.local")).toBe(".env.local");
    expect(SharedRelPath.parse("node_modules")).toBe("node_modules");
    expect(SharedRelPath.parse(".gitignore")).toBe(".gitignore");
    expect(SharedPath.parse({ path: ".env", mode: "link" })).toEqual({
      path: ".env",
      mode: "link",
    });
  });

  it("rejects absolute paths, '..', and the .git directory", () => {
    expect(SharedRelPath.safeParse("/etc/passwd").success).toBe(false);
    expect(SharedRelPath.safeParse("C:\\Windows").success).toBe(false);
    expect(SharedRelPath.safeParse("../secrets").success).toBe(false);
    expect(SharedRelPath.safeParse("foo/../bar").success).toBe(false);
    expect(SharedRelPath.safeParse(".git").success).toBe(false);
    expect(SharedRelPath.safeParse(".git/config").success).toBe(false);
  });
});

describe("project prompts", () => {
  it("caps name, text, and the list", () => {
    const prompt = ProjectPrompt.parse({ id: "p1", name: "Review", text: "Look at the diff." });
    expect(prompt.name).toBe("Review");
    expect(ProjectPrompt.safeParse({ id: "p1", name: "", text: "x" }).success).toBe(false);
    expect(
      ProjectSettings.safeParse({
        prompts: Array.from({ length: 51 }, (_, i) => ({
          id: `p${i}`,
          name: "N",
          text: "t",
        })),
      }).success,
    ).toBe(false);
  });
});

describe("ProjectSettings defaults", () => {
  it("fills sharedPaths and prompts when settings are present", () => {
    expect(ProjectSettings.parse({})).toEqual({ scripts: [], sharedPaths: [], prompts: [] });
    expect(ProjectSettings.parse({ scripts: [] })).toEqual({
      scripts: [],
      sharedPaths: [],
      prompts: [],
    });
  });

  it("keeps a missing settings object as the legacy default", () => {
    expect(Project.parse({ id: "p1", name: "app", root: "/work", createdAt: at }).settings).toEqual(
      {
        scripts: [],
        sharedPaths: [],
        prompts: [],
      },
    );
  });

  it("decodes an old project.added event", () => {
    const event = AgeEvent.parse({
      seq: 1,
      at,
      commandId: "c1",
      type: "project.added",
      project: { id: "p1", name: "app", root: "/work", createdAt: at },
    });
    expect(event.type).toBe("project.added");
    if (event.type !== "project.added") return;
    expect(event.project.settings).toEqual({ scripts: [], sharedPaths: [], prompts: [] });
  });
});

describe("preview urls", () => {
  it("accepts local http(s) addresses with ${PORT} in the port position", () => {
    expect(ProjectSettings.parse({ defaultPreviewUrl: "http://localhost:${PORT}" })).toMatchObject({
      defaultPreviewUrl: "http://localhost:${PORT}",
    });
    expect(
      ProjectScript.parse({
        id: "s1",
        name: "Serve",
        command: "node serve.mjs",
        previewUrl: "https://127.0.0.1:8080/app",
      }).previewUrl,
    ).toBe("https://127.0.0.1:8080/app");
    expect(
      ProjectScript.parse({
        id: "s1",
        name: "Serve",
        command: "node serve.mjs",
        previewUrl: "http://[::1]:3000",
      }).previewUrl,
    ).toBe("http://[::1]:3000");
  });

  it("rejects remote hosts and other schemes when written", () => {
    expect(ProjectSettings.safeParse({ defaultPreviewUrl: "http://evil.example" }).success).toBe(
      false,
    );
    expect(
      ProjectScript.safeParse({
        id: "s1",
        name: "Serve",
        command: "x",
        previewUrl: "javascript:alert(1)",
      }).success,
    ).toBe(false);
    expect(
      ProjectScript.safeParse({
        id: "s1",
        name: "Serve",
        command: "x",
        previewUrl: "file:///etc/passwd",
      }).success,
    ).toBe(false);
    expect(
      ProjectScript.safeParse({
        id: "s1",
        name: "Serve",
        command: "x",
        previewUrl: "http://${PORT}",
      }).success,
    ).toBe(false);
  });

  it("reads a stored address that fails the check as absent", () => {
    const settings = StoredProjectSettings.parse({
      scripts: [{ id: "s1", name: "Serve", command: "x", previewUrl: "http://evil.example" }],
      defaultPreviewUrl: "javascript:alert(1)",
    });
    expect(settings.scripts[0]?.previewUrl).toBeUndefined();
    expect(settings.defaultPreviewUrl).toBeUndefined();
    const event = AgeEvent.parse({
      seq: 1,
      at,
      commandId: "c1",
      type: "project.configured",
      projectId: "p1",
      settings: { defaultPreviewUrl: "http://evil.example" },
    });
    expect(event.type).toBe("project.configured");
    if (event.type !== "project.configured") return;
    expect(event.settings.defaultPreviewUrl).toBeUndefined();
  });
});
