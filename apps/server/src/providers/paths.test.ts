import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isInsideWorkspace, workspaceRelative } from "./paths.ts";

const dir = mkdtempSync(join(tmpdir(), "age-paths-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("workspaceRelative", () => {
  it("relativizes paths inside the workspace", () => {
    expect(workspaceRelative(join(dir, "src/a.ts"), dir)).toBe("src/a.ts");
    expect(workspaceRelative(dir, dir)).toBe(".");
  });

  it("matches symlink-resolved paths reported by agents", () => {
    expect(workspaceRelative(join(realpathSync(dir), "b.ts"), dir)).toBe("b.ts");
  });

  it("keeps outside and relative paths unchanged", () => {
    expect(workspaceRelative("/etc/hosts", dir)).toBe("/etc/hosts");
    expect(workspaceRelative("rel/x.ts", dir)).toBe("rel/x.ts");
  });

  it("treats ..segment names inside the workspace as inside", () => {
    expect(workspaceRelative(join(dir, "..notes.md"), dir)).toBe("..notes.md");
  });
});

describe("isInsideWorkspace", () => {
  it("detects paths inside the workspace across /var spelling aliases", () => {
    const real = realpathSync(dir);
    expect(isInsideWorkspace(join(real, "inner.ts"), dir)).toBe(true);
    expect(isInsideWorkspace("/etc/hosts", dir)).toBe(false);
  });
});
