import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeGitSshCommand, shadowGitEnv, userRepoGitEnv } from "./env.ts";

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

describe("userRepoGitEnv", () => {
  it("drops every GIT_ variable whatever its case, and keeps unrelated ones", () => {
    setEnv("GIT_EXEC_PATH", "/evil");
    setEnv("GIT_TEMPLATE_DIR", "/evil/templates");
    setEnv("GIT_CEILING_DIRECTORIES", "/");
    setEnv("GIT_CONFIG_KEY_0", "core.sshCommand");
    setEnv("Git_Dir", "/elsewhere");
    setEnv("git_work_tree", "/elsewhere");
    setEnv("WOOKY_GIT_ENV_KEEP", "yes");
    setEnv("PATH", process.env.PATH ?? "/usr/bin");
    const env = userRepoGitEnv();
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
    const env = userRepoGitEnv({ GIT_AUTHOR_NAME: "Wooky" });
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i /keys/id -o BatchMode=yes");
    expect(env.GIT_ASKPASS).toBe("/bin/askpass");
    expect(env.GIT_EDITOR).toBe("false");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_AUTHOR_NAME).toBe("Wooky");
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "GIT_TERMINAL_PROMPT")).toEqual([
      "GIT_TERMINAL_PROMPT",
    ]);
  });

  it("does not invent GIT_SSH_COMMAND, so core.sshCommand and GIT_SSH keep working", () => {
    delete process.env.GIT_SSH_COMMAND;
    setEnv("GIT_SSH", "/usr/bin/plink");
    const env = userRepoGitEnv();
    expect(env.GIT_SSH).toBe("/usr/bin/plink");
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
  });

  it("does not repeat BatchMode when the user already set it", () => {
    setEnv("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -i /k");
    expect(userRepoGitEnv().GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes -i /k");
  });
});

describe("ssh never prompts", () => {
  beforeEach(() => {
    for (const key of ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"]) {
      if (!touched.has(key)) touched.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  it("always turns SSH_ASKPASS off, in either profile", () => {
    setEnv("SSH_ASKPASS_REQUIRE", "force");
    setEnv("Ssh_Askpass_Require", "prefer");
    for (const env of [userRepoGitEnv(), shadowGitEnv()]) {
      const entries = Object.entries(env).filter(
        ([key]) => key.toUpperCase() === "SSH_ASKPASS_REQUIRE",
      );
      expect(entries).toEqual([["SSH_ASKPASS_REQUIRE", "never"]]);
    }
  });

  it("leaves a non-OpenSSH GIT_SSH_COMMAND untouched", () => {
    setEnv("GIT_SSH_COMMAND", "plink -batch -i /k.ppk");
    expect(userRepoGitEnv().GIT_SSH_COMMAND).toBe("plink -batch -i /k.ppk");
    setEnv("GIT_SSH_COMMAND", "C:\\Tools\\TortoisePlink.exe -batch");
    expect(userRepoGitEnv().GIT_SSH_COMMAND).toBe("C:\\Tools\\TortoisePlink.exe -batch");
    setEnv("GIT_SSH_COMMAND", "/opt/wrap-ssh.sh -v");
    expect(userRepoGitEnv().GIT_SSH_COMMAND).toBe("/opt/wrap-ssh.sh -v");
  });

  it("leaves ssh alone when GIT_SSH_VARIANT says it is not OpenSSH", () => {
    setEnv("GIT_SSH_VARIANT", "plink");
    setEnv("GIT_SSH_COMMAND", "ssh -batch");
    expect(userRepoGitEnv().GIT_SSH_COMMAND).toBe("ssh -batch");
  });

  it("adds BatchMode to a quoted OpenSSH path, ssh.exe included", () => {
    expect(composeGitSshCommand('"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -i k')).toBe(
      '"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -i k -o BatchMode=yes',
    );
    expect(composeGitSshCommand("/usr/bin/ssh -p 22")).toBe("/usr/bin/ssh -p 22 -o BatchMode=yes");
  });

  it("picks up core.sshCommand, with BatchMode, as GIT_SSH_COMMAND", () => {
    const env = userRepoGitEnv(undefined, { coreSshCommand: "ssh -i /keys/work" });
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i /keys/work -o BatchMode=yes");
  });

  it("lets GIT_SSH_COMMAND win over core.sshCommand, as git does", () => {
    setEnv("GIT_SSH_COMMAND", "ssh -i /env");
    const env = userRepoGitEnv(undefined, { coreSshCommand: "ssh -i /config" });
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i /env -o BatchMode=yes");
  });

  it("leaves GIT_SSH alone, and otherwise pins a non-interactive ssh", () => {
    setEnv("GIT_SSH", "/usr/bin/plink");
    expect(userRepoGitEnv(undefined, {}).GIT_SSH_COMMAND).toBeUndefined();
    delete process.env.GIT_SSH;
    expect(userRepoGitEnv(undefined, {}).GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
  });
});

const REPO_REDIRECTING = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TRACE",
  "GIT_TRACE_PACKET",
  "GIT_TRACE2_EVENT",
];

/** Mixed case, the way a Windows shell may spell it. */
function mixed(name: string): string {
  return name.replace(/(?<=_)[A-Z]+/g, (word) => word[0] + word.slice(1).toLowerCase());
}

function namesOf(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).map((key) => key.toUpperCase());
}

describe("userRepoGitEnv profile", () => {
  it("keeps the user's transport, identity, user config, LFS, HTTP and curl settings", () => {
    const keep = {
      GIT_SSH: "/usr/bin/plink",
      GIT_SSH_VARIANT: "putty",
      GIT_PROXY_COMMAND: "/bin/proxy",
      Git_Author_Name: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      git_committer_name: "Ada",
      GIT_COMMITTER_EMAIL: "ada@example.com",
      GIT_CONFIG_GLOBAL: "/home/ada/.gitconfig-work",
      Git_Lfs_Skip_Smudge: "1",
      GIT_HTTP_PROXY_AUTHMETHOD: "basic",
      GIT_CURL_VERBOSE: "0",
      Git_Ssl_Cainfo: "/ca.pem",
    };
    for (const [key, value] of Object.entries(keep)) setEnv(key, value);
    const env = userRepoGitEnv();
    for (const [key, value] of Object.entries(keep)) expect(env[key]).toBe(value);
  });

  it("strips every repo-redirecting variable, in any case", () => {
    for (const name of REPO_REDIRECTING) setEnv(mixed(name), "/elsewhere");
    for (const name of REPO_REDIRECTING) setEnv(name.toLowerCase(), "/elsewhere");
    const names = namesOf(userRepoGitEnv());
    for (const name of REPO_REDIRECTING) expect(names).not.toContain(name);
  });
});

describe("shadowGitEnv profile", () => {
  it("strips every GIT_ variable, transport and identity included, whatever its case", () => {
    const inherited = [
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_ASKPASS",
      "GIT_PROXY_COMMAND",
      "GIT_SSL_NO_VERIFY",
      "GIT_AUTHOR_NAME",
      "GIT_CONFIG_GLOBAL",
      "GIT_LFS_SKIP_SMUDGE",
      ...REPO_REDIRECTING,
    ];
    for (const name of inherited) setEnv(mixed(name), "x");
    setEnv("WOOKY_GIT_ENV_KEEP", "yes");
    const env = shadowGitEnv({ GIT_DIR: "/shadow/.git" });
    const names = namesOf(env);
    for (const name of inherited.filter((n) => n !== "GIT_DIR")) expect(names).not.toContain(name);
    expect(env.WOOKY_GIT_ENV_KEEP).toBe("yes");
    // What Wooky sets itself, and the explicit extras, still arrive.
    expect(env.GIT_DIR).toBe("/shadow/.git");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_EDITOR).toBe("false");
  });
});
