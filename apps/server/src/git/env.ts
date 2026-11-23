/**
 * Env for argv-only git/gh children: no prompts, no editor, no pager, no locale surprises.
 * Two profiles, because the two kinds of child trust the user's environment differently:
 *
 * - `userRepoGitEnv` runs git in the user's own repositories (ship, checkpoints, project
 *   info). The user's transport, identity, config file and LFS/HTTP/curl settings are theirs
 *   and stay, as do their protocol restrictions and a relocated system config. Anything that
 *   could point git at another repository, exec path, template or inline config is dropped.
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
  // User-level config (credential helpers, signing) and a relocated or disabled system config.
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  // The user's own protocol restrictions. They can only narrow what git will talk to.
  "GIT_ALLOW_PROTOCOL",
  "GIT_PROTOCOL_FROM_USER",
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

/** The program a GIT_SSH_COMMAND string runs: its first word, quoted or not, without directory or `.exe`. */
function sshProgram(command: string): string {
  const text = command.trim();
  const quote = text[0];
  const word =
    quote === '"' || quote === "'"
      ? text.slice(1, Math.max(text.indexOf(quote, 1), 1))
      : (text.split(/\s/)[0] ?? "");
  const base = word.split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

const NON_OPENSSH_VARIANTS = new Set(["plink", "putty", "tortoiseplink"]);

/**
 * Appends `-o BatchMode=yes` to an OpenSSH command so it can never wait for input. Anything else
 * (plink, a wrapper script, a GIT_SSH_VARIANT that is not OpenSSH) is returned as it was: those
 * would reject or misread the option.
 */
export function composeGitSshCommand(existing: string, variant?: string): string {
  const trimmed = existing.trim();
  if (sshProgram(trimmed) !== "ssh") return trimmed;
  if (variant && NON_OPENSSH_VARIANTS.has(variant.trim().toLowerCase())) return trimmed;
  if (/\bBatchMode=/i.test(trimmed)) return trimmed;
  return `${trimmed} -o BatchMode=yes`;
}

/**
 * What the caller found out about ssh in the repo. Passing it makes the env pin an ssh command
 * that cannot prompt; without it GIT_SSH_COMMAND is only touched when the user already set it.
 */
export interface SshResolution {
  /** `git config core.sshCommand` in the repo, when set. */
  coreSshCommand?: string;
}

function baseEnv(
  keep: (name: string) => boolean,
  extra?: NodeJS.ProcessEnv,
  ssh?: SshResolution,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  let sshCommand: string | undefined;
  let variant: string | undefined;
  let hasGitSsh = false;
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (name === "LC_ALL" || name === "GCM_INTERACTIVE" || name === "SSH_ASKPASS_REQUIRE") continue;
    if (name === "GIT_SSH_COMMAND" && keep(name)) {
      sshCommand = value;
      continue;
    }
    if (name === "GIT_SSH_VARIANT" && keep(name)) variant = value;
    if (name === "GIT_SSH" && keep(name) && value?.trim()) hasGitSsh = true;
    if (name.startsWith("GIT_") && !keep(name)) continue;
    env[key] = value;
  }
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_EDITOR = "false";
  env.GIT_PAGER = "cat";
  // ssh would otherwise ask for a passphrase or host key through SSH_ASKPASS (Linux with DISPLAY)
  // or the console a Windows child inherits. Never prompt; fail fast.
  env.SSH_ASKPASS_REQUIRE = "never";
  // Precedence is git's own: GIT_SSH_COMMAND, then core.sshCommand, then GIT_SSH, then ssh.
  const chosen = sshCommand?.trim() ? sshCommand : ssh?.coreSshCommand?.trim();
  if (chosen) env.GIT_SSH_COMMAND = composeGitSshCommand(chosen, variant);
  else if (ssh && !hasGitSsh) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return { ...env, ...extra };
}

export function userRepoGitEnv(extra?: NodeJS.ProcessEnv, ssh?: SshResolution): NodeJS.ProcessEnv {
  return baseEnv(keptForUserRepo, extra, ssh);
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
