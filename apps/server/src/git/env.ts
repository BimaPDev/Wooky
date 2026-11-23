/** Environment variables git hooks leak into a child; they must never reach our plumbing calls. */
export const INHERITED_GIT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
] as const;

const BATCH_SSH = "ssh -o BatchMode=yes";

export function composeGitSshCommand(existing: string | undefined): string {
  const trimmed = existing?.trim() ?? "";
  if (trimmed.length === 0) return BATCH_SSH;
  return `${trimmed} ${BATCH_SSH}`;
}

/** Env for argv-only git/gh children: no inherited git state, no prompts, batch SSH. */
export function gitChildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of INHERITED_GIT_VARS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) delete env[key];
  }
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_EDITOR = "false";
  env.GIT_PAGER = "cat";
  env.GIT_SSH_COMMAND = composeGitSshCommand(env.GIT_SSH_COMMAND);
  return { ...env, ...extra };
}

export function ghChildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...gitChildEnv(extra),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
}
