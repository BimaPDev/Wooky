/**
 * Env for argv-only git/gh children: no prompts, no editor, no pager, no locale surprises.
 * Two profiles, because the two kinds of child trust the user's environment differently:
 *
 * - `userRepoGitEnv` runs git in the user's own repositories (ship, checkpoints, project
 *   info). The user's transport, identity, config file and LFS/HTTP/curl settings are theirs
 *   and stay. Anything that could point git at another repository, exec path, template,
 *   system config or inline config is dropped.
 * - `shadowGitEnv` runs git in Wooky's private shadow repository and drops every `GIT_*`.
 *
 * Windows env names are case-insensitive, so `Git_Dir` counts as `GIT_DIR`.
 */

/** Exact `GIT_*` names a user repo child inherits. Everything else starting `GIT_` is dropped. */
const USER_REPO_KEEP = new Set([
  // Remote transport and authentication.
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  // User-level config (credential helpers, signing).
  "GIT_CONFIG_GLOBAL",
]);

/** Prefixes kept for the same reason: transport, identity, LFS, HTTP and curl settings. */
const USER_REPO_KEEP_PREFIXES = [
  "GIT_SSL_",
  "GIT_HTTP_",
  "GIT_CURL_",
  "GIT_LFS_",
  "GIT_AUTHOR_",
  "GIT_COMMITTER_",
];

function keptForUserRepo(name: string): boolean {
  return USER_REPO_KEEP.has(name) || USER_REPO_KEEP_PREFIXES.some((p) => name.startsWith(p));
}

/** Appends `-o BatchMode=yes` to the user's own ssh command so it can never wait for input. */
export function composeGitSshCommand(existing: string): string {
  const trimmed = existing.trim();
  if (/\bBatchMode=/i.test(trimmed)) return trimmed;
  return `${trimmed} -o BatchMode=yes`;
}

function baseEnv(keep: (name: string) => boolean, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  let sshCommand: string | undefined;
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (name === "LC_ALL" || name === "GCM_INTERACTIVE") continue;
    if (name === "GIT_SSH_COMMAND" && keep(name)) {
      sshCommand = value;
      continue;
    }
    if (name.startsWith("GIT_") && !keep(name)) continue;
    env[key] = value;
  }
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_EDITOR = "false";
  env.GIT_PAGER = "cat";
  // Only the user's own ssh command is touched. Setting GIT_SSH_COMMAND from nothing would
  // override their core.sshCommand and GIT_SSH (plink); without a tty ssh cannot prompt anyway,
  // and GIT_TERMINAL_PROMPT=0 covers https.
  if (sshCommand?.trim()) env.GIT_SSH_COMMAND = composeGitSshCommand(sshCommand);
  return { ...env, ...extra };
}

export function userRepoGitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return baseEnv(keptForUserRepo, extra);
}

/** For Wooky's own shadow repository: no inherited `GIT_*` at all, transport included. */
export function shadowGitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return baseEnv(() => false, extra);
}

export function ghChildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...userRepoGitEnv(extra),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
}
