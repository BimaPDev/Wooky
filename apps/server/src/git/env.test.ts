import { afterEach, describe, expect, it } from "vitest";
import { gitChildEnv } from "./env.ts";

const touched = new Map<string, string | undefined>();
function setEnv(key: string, value: string): void {
  if (!touched.has(key)) touched.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of touched) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  touched.clear();
});

describe("gitChildEnv", () => {
  it("drops every GIT_ variable whatever its case, and keeps unrelated ones", () => {
    setEnv("GIT_EXEC_PATH", "/evil");
    setEnv("GIT_TEMPLATE_DIR", "/evil/templates");
    setEnv("GIT_CEILING_DIRECTORIES", "/");
    setEnv("GIT_CONFIG_KEY_0", "core.sshCommand");
    setEnv("Git_Dir", "/elsewhere");
    setEnv("git_work_tree", "/elsewhere");
    setEnv("WOOKY_GIT_ENV_KEEP", "yes");
    setEnv("PATH", process.env.PATH ?? "/usr/bin");
    const env = gitChildEnv();
    const names = Object.keys(env).map((key) => key.toUpperCase());
    for (const gone of [
      "GIT_EXEC_PATH",
      "GIT_TEMPLATE_DIR",
      "GIT_CEILING_DIRECTORIES",
      "GIT_CONFIG_KEY_0",
      "GIT_DIR",
      "GIT_WORK_TREE",
    ]) {
      expect(names).not.toContain(gone);
    }
    expect(env.WOOKY_GIT_ENV_KEEP).toBe("yes");
    expect(env.PATH ?? env.Path).toBeTruthy();
  });

  it("keeps remote transport settings and writes Wooky's own values last", () => {
    setEnv("GIT_SSH_COMMAND", "ssh -i /keys/id");
    setEnv("GIT_ASKPASS", "/bin/askpass");
    setEnv("GIT_EDITOR", "vim");
    setEnv("Git_Terminal_Prompt", "1");
    const env = gitChildEnv({ GIT_AUTHOR_NAME: "Wooky" });
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i /keys/id ssh -o BatchMode=yes");
    expect(env.GIT_ASKPASS).toBe("/bin/askpass");
    expect(env.GIT_EDITOR).toBe("false");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_AUTHOR_NAME).toBe("Wooky");
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "GIT_TERMINAL_PROMPT")).toEqual([
      "GIT_TERMINAL_PROMPT",
    ]);
  });
});
