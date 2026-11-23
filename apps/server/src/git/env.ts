/**
 * `GIT_*` variables that only describe how to reach a remote or authenticate to it. Every
 * other `GIT_*` variable can redirect git to another repository, exec path, template or
 * config, so it is dropped; these are user-owned transport settings that pushes rely on.
 */
const TRANSPORT_VARS = new Set([
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_CERT",
  "GIT_SSL_KEY",
  "GIT_SSL_NO_VERIFY",
  "GIT_SSL_VERSION",
]);

const BATCH_SSH = "ssh -o BatchMode=yes";

export function composeGitSshCommand(existing: string | undefined): string {
  const trimmed = existing?.trim() ?? "";
  if (trimmed.length === 0) return BATCH_SSH;
  return `${trimmed} ${BATCH_SSH}`;
}

/**
 * Env for argv-only git/gh children: no inherited git state, no prompts, batch SSH.
 * Every variable whose upper-cased name starts with `GIT_` is dropped (Windows env names are
 * case-insensitive, so `Git_Dir` counts) unless it is a transport setting, and the few
 * Wooky sets itself are written afterwards.
 */
export function gitChildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  let sshCommand: string | undefined;
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (name === "GIT_SSH_COMMAND") {
      sshCommand = value;
      continue;
    }
    if (name === "LC_ALL" || name === "GCM_INTERACTIVE") continue;
    if (name.startsWith("GIT_") && !TRANSPORT_VARS.has(name)) continue;
    env[key] = value;
  }
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_EDITOR = "false";
  env.GIT_PAGER = "cat";
  env.GIT_SSH_COMMAND = composeGitSshCommand(sshCommand);
  return { ...env, ...extra };
}

export function ghChildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...gitChildEnv(extra),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
}
