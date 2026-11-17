import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { workspaceRelative } from "./paths.ts";

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
});
