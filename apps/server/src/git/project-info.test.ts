import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTestRepos, makeRepo } from "./test-repo.ts";
import { readProjectGitFacts } from "./project-info.ts";

afterEach(cleanupTestRepos);

describe("readProjectGitFacts", () => {
  it("reads the branch and the origin remote with credentials removed", async () => {
    const root = await makeRepo();
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://deploy:s3cret@GitHub.com/Acme/Billing.git"],
      { cwd: root },
    );
    const facts = await readProjectGitFacts(root);
    expect(facts.remote).toBe("github.com/acme/billing");
    expect(JSON.stringify(facts)).not.toContain("s3cret");
    expect(facts.branch).toBe("main");
  });

  it("has no remote for a repository without one, and nothing for a folder that is not a repo", async () => {
    const root = await makeRepo();
    expect((await readProjectGitFacts(root)).remote).toBeNull();
    expect(await readProjectGitFacts("/definitely/not/a/folder")).toEqual({
      remote: null,
      branch: null,
    });
  });
});
