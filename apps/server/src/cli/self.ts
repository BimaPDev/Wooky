import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { WOOKY_DEFAULT_PORT } from "@wooky/contracts";
import { defaultSelfCommandRunner, type SelfCommandRunner } from "../process/self-service.ts";

export const DEFAULT_WOOKY_REPO = "BimaPDev/Wooky";
export const LAUNCHD_LABEL = "dev.wooky.server";
export const SYSTEMD_UNIT_NAME = "wooky.service";
export const WINDOWS_TASK_NAME = "Wooky";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERSION_PATTERN = /^v?[0-9A-Za-z][0-9A-Za-z._-]*$/;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export const SELF_USAGE = `Usage:
  wooky service <install|uninstall|status> [--port <n>] [--dry-run]
  wooky update [--version <v>] [--repo <owner/repo>]
  wooky uninstall [--purge]`;

export interface SelfPaths {
  platform: NodeJS.Platform;
  wookyHome: string;
  appDir: string;
  runtimeDir: string;
  binDir: string;
  launcherPath: string;
  logsDir: string;
  serviceFile: string | null;
}

export interface SelfIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface SelfDeps {
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  username?: string;
  runner?: SelfCommandRunner;
  fetchImpl?: typeof fetch;
  io?: SelfIo;
}

export interface VersionDirEntry {
  name: string;
  mtimeMs: number;
}

const defaultIo = (): SelfIo => ({
  stdout: process.stdout,
  stderr: process.stderr,
});

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

/** Pure per-platform path resolution for installed files and service descriptors. */
export function resolveSelfPaths(options: {
  platform: NodeJS.Platform;
  homeDir: string;
  env: Record<string, string | undefined>;
}): SelfPaths {
  const { platform, homeDir, env } = options;
  const p = pathApi(platform);
  const wookyHome = p.resolve(homeDir, env.WOOKY_HOME || p.join(homeDir, ".wooky"));
  const logsDir = p.join(wookyHome, "logs");

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || p.join(homeDir, "AppData", "Local");
    const root = p.join(localAppData, "Wooky");
    const appDir = p.resolve(homeDir, env.WOOKY_PREFIX || p.join(root, "app"));
    const runtimeDir = p.join(root, "runtime");
    const binDir = p.resolve(homeDir, env.WOOKY_BIN_DIR || p.join(root, "bin"));
    return {
      platform,
      wookyHome,
      appDir,
      runtimeDir,
      binDir,
      launcherPath: p.join(binDir, "wooky.cmd"),
      logsDir,
      serviceFile: null,
    };
  }

  const appDir = p.resolve(homeDir, env.WOOKY_PREFIX || p.join(wookyHome, "app"));
  const runtimeDir = p.join(wookyHome, "runtime");
  const binDir = p.resolve(homeDir, env.WOOKY_BIN_DIR || p.join(homeDir, ".local", "bin"));
  const launcherPath = p.join(binDir, "wooky");

  if (platform === "darwin") {
    return {
      platform,
      wookyHome,
      appDir,
      runtimeDir,
      binDir,
      launcherPath,
      logsDir,
      serviceFile: p.join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    };
  }

  const xdgConfig = env.XDG_CONFIG_HOME || p.join(homeDir, ".config");
  return {
    platform,
    wookyHome,
    appDir,
    runtimeDir,
    binDir,
    launcherPath,
    logsDir,
    serviceFile: p.join(xdgConfig, "systemd", "user", SYSTEMD_UNIT_NAME),
  };
}

/** Resolve service port: flag > WOOKY_PORT > settings.json `port` > WOOKY_DEFAULT_PORT. */
export function resolveServicePort(options: {
  portFlag?: string;
  env: Record<string, string | undefined>;
  wookyHome: string;
  platform?: NodeJS.Platform;
  readSettingsFile?: (path: string) => string | null;
}): number {
  const fromFlagOrEnv = options.portFlag ?? options.env.WOOKY_PORT;
  if (fromFlagOrEnv !== undefined && fromFlagOrEnv !== "") {
    return parseServicePort(fromFlagOrEnv);
  }
  const p = pathApi(options.platform ?? process.platform);
  const settingsPath = p.join(options.wookyHome, "settings.json");
  const reader =
    options.readSettingsFile ??
    ((filePath: string) => {
      try {
        return readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
    });
  const raw = reader(settingsPath);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "port" in parsed) {
        const candidate = (parsed as { port: unknown }).port;
        if (typeof candidate === "number" && Number.isInteger(candidate)) {
          if (candidate >= 1 && candidate <= 65_535) return candidate;
        }
      }
    } catch {
      // Ignore corrupt settings.json and fall back to default port.
    }
  }
  return WOOKY_DEFAULT_PORT;
}

function parseServicePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new Error(`Invalid port "${raw}". Use a number from 1 to 65535.`);
  }
  return n;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$");
  return `"${escaped}"`;
}

/** Generate a macOS launchd user agent plist. */
export function renderLaunchdPlist(options: {
  label?: string;
  launcherPath: string;
  port: number;
  wookyHome: string;
  logsDir: string;
  pathEnv?: string;
}): string {
  const label = options.label ?? LAUNCHD_LABEL;
  const programArgs = [options.launcherPath, "--port", String(options.port)];
  const envEntries: Array<[string, string]> = [["WOOKY_HOME", options.wookyHome]];
  if (options.pathEnv) envEntries.push(["PATH", options.pathEnv]);

  const argsXml = programArgs.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join("\n");
  const envXml = envEntries
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join("\n");
  const outLog = posix.join(options.logsDir, "server.out.log");
  const errLog = posix.join(options.logsDir, "server.err.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(outLog)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(errLog)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
  </dict>
</plist>
`;
}

/** Generate a Linux systemd --user service unit. */
export function renderSystemdUnit(options: {
  launcherPath: string;
  port: number;
  wookyHome: string;
  logsDir: string;
}): string {
  const execStart = `${systemdQuote(options.launcherPath)} --port ${options.port}`;
  const outLog = posix.join(options.logsDir, "server.out.log");
  const errLog = posix.join(options.logsDir, "server.err.log");
  return `[Unit]
Description=Wooky coding agent workspace server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=3
Environment=${systemdQuote(`WOOKY_HOME=${options.wookyHome}`)}
StandardOutput=append:${outLog}
StandardError=append:${errLog}

[Install]
WantedBy=default.target
`;
}

/** Generate a Windows Task Scheduler 1.2 XML definition (at logon, hidden, restart on failure). */
export function renderWindowsTaskXml(options: {
  launcherPath: string;
  port: number;
  wookyHome: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Wooky coding agent workspace server</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(options.launcherPath)}</Command>
      <Arguments>--port ${options.port} --home ${xmlEscape(`"${options.wookyHome}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function buildSchtasksInstallArgs(options: {
  taskName?: string;
  xmlPath: string;
}): string[] {
  return ["/Create", "/TN", options.taskName ?? WINDOWS_TASK_NAME, "/XML", options.xmlPath, "/F"];
}

export function buildSchtasksRunArgs(taskName = WINDOWS_TASK_NAME): string[] {
  return ["/Run", "/TN", taskName];
}

export function buildSchtasksEndArgs(taskName = WINDOWS_TASK_NAME): string[] {
  return ["/End", "/TN", taskName];
}

export function buildSchtasksUninstallArgs(taskName = WINDOWS_TASK_NAME): string[] {
  return ["/Delete", "/TN", taskName, "/F"];
}

export function buildSchtasksStatusArgs(taskName = WINDOWS_TASK_NAME): string[] {
  return ["/Query", "/TN", taskName, "/FO", "LIST", "/V"];
}

/**
 * Decide which version directories inside `WOOKY_PREFIX` can be removed,
 * keeping `currentVersion` plus the `keepPrevious` most recently modified other versions.
 */
export function selectVersionsToPrune(
  entries: readonly VersionDirEntry[],
  currentVersion: string | null,
  keepPrevious = 2,
): string[] {
  const candidates = entries
    .filter(
      (entry) =>
        entry.name !== "current" && !entry.name.startsWith(".") && entry.name !== currentVersion,
    )
    .toSorted((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return b.name.localeCompare(a.name);
    });
  return candidates.slice(Math.max(0, keepPrevious)).map((entry) => entry.name);
}

export function validateRepo(repo: string): string {
  const trimmed = repo.trim();
  if (!REPO_PATTERN.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`Invalid WOOKY_REPO "${repo}". Expected "owner/repo".`);
  }
  return trimmed;
}

export function buildInstallerUrl(
  repo: string,
  version: string | undefined,
  platform: NodeJS.Platform,
): string {
  const safeRepo = validateRepo(repo);
  const asset = platform === "win32" ? "install.ps1" : "install.sh";
  if (!version || version === "latest") {
    return `https://github.com/${safeRepo}/releases/latest/download/${asset}`;
  }
  const trimmed = version.trim();
  if (!VERSION_PATTERN.test(trimmed)) {
    throw new Error(`Invalid version "${version}".`);
  }
  const tag = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  return `https://github.com/${safeRepo}/releases/download/${tag}/${asset}`;
}

/** Verify the installer URL came from the configured GitHub repository over HTTPS. */
export function verifyInstallerResponseUrl(
  initialUrl: string,
  finalUrl: string,
  repo: string,
): void {
  const safeRepo = validateRepo(repo);
  const initial = new URL(initialUrl);
  if (initial.protocol !== "https:" || initial.hostname !== "github.com") {
    throw new Error(`Refusing non-GitHub installer URL: ${initialUrl}`);
  }
  const expectedPrefix = `/${safeRepo.toLowerCase()}/releases/`;
  if (!initial.pathname.toLowerCase().startsWith(expectedPrefix)) {
    throw new Error(`Installer URL does not belong to ${safeRepo}: ${initialUrl}`);
  }
  const resolved = new URL(finalUrl);
  if (resolved.protocol !== "https:") {
    throw new Error(`Refusing insecure redirect to ${finalUrl}`);
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(resolved.hostname.toLowerCase())) {
    throw new Error(`Refusing installer redirect to untrusted host "${resolved.hostname}".`);
  }
  if (
    resolved.hostname.toLowerCase() === "github.com" &&
    !resolved.pathname.toLowerCase().startsWith(expectedPrefix)
  ) {
    throw new Error(`Installer redirect left repository ${safeRepo}: ${finalUrl}`);
  }
}

export async function runSelfCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: SelfDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo();
  try {
    return await dispatch(args, env, {
      platform: deps.platform ?? process.platform,
      homeDir: deps.homeDir ?? homedir(),
      uid: deps.uid ?? process.getuid?.(),
      username: deps.username ?? safeUsername(env),
      runner: deps.runner ?? defaultSelfCommandRunner,
      fetchImpl: deps.fetchImpl ?? fetch,
      io,
    });
  } catch (error: unknown) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

interface ResolvedDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  uid: number | undefined;
  username: string;
  runner: SelfCommandRunner;
  fetchImpl: typeof fetch;
  io: SelfIo;
}

function safeUsername(env: NodeJS.ProcessEnv): string {
  try {
    return userInfo().username;
  } catch {
    return env.USER || env.USERNAME || "";
  }
}

async function dispatch(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: ResolvedDeps,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    deps.io.stdout.write(`${SELF_USAGE}\n`);
    return 0;
  }
  if (command === "service") return runService(rest, env, deps);
  if (command === "update") return runUpdate(rest, env, deps);
  if (command === "uninstall") return runUninstall(rest, env, deps);
  deps.io.stderr.write(`${SELF_USAGE}\n`);
  return 1;
}

function parseSimpleFlags(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
  boolFlags: ReadonlySet<string>,
): { flags: Map<string, string | true>; positionals: string[] } {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      flags.set("help", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unknown flag ${arg}.`);
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    if (boolFlags.has(key)) {
      if (eq !== -1) throw new Error(`Flag --${key} does not take a value.`);
      flags.set(key, true);
      continue;
    }
    if (valueFlags.has(key)) {
      if (eq !== -1) {
        flags.set(key, body.slice(eq + 1));
        continue;
      }
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`Missing value for --${key}.`);
      }
      flags.set(key, next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown flag --${key}.`);
  }
  return { flags, positionals };
}

function runService(args: string[], env: NodeJS.ProcessEnv, deps: ResolvedDeps): number {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    deps.io.stdout.write(`${SELF_USAGE}\n`);
    return 0;
  }
  const { flags, positionals } = parseSimpleFlags(
    rest,
    new Set(["port"]),
    new Set(["help", "dry-run"]),
  );
  if (flags.has("help")) {
    deps.io.stdout.write(`${SELF_USAGE}\n`);
    return 0;
  }
  if (positionals.length > 0) {
    throw new Error(`Unexpected argument "${positionals[0]}".`);
  }

  const paths = resolveSelfPaths({ platform: deps.platform, homeDir: deps.homeDir, env });
  const portFlag =
    typeof flags.get("port") === "string" ? (flags.get("port") as string) : undefined;

  if (sub === "install") {
    const port = resolveServicePort({
      portFlag,
      env,
      wookyHome: paths.wookyHome,
      platform: deps.platform,
    });
    const dryRun = flags.has("dry-run");
    return installService(paths, port, env, deps, dryRun);
  }
  if (sub === "uninstall") {
    return uninstallService(paths, env, deps);
  }
  if (sub === "status") {
    return statusService(paths, env, deps);
  }
  throw new Error(`Unknown service command "${sub}". Expected install, uninstall, or status.`);
}

function formatArgv(file: string, args: readonly string[]): string {
  const quoted = args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg));
  return [file, ...quoted].join(" ");
}

function installService(
  paths: SelfPaths,
  port: number,
  env: NodeJS.ProcessEnv,
  deps: ResolvedDeps,
  dryRun = false,
): number {
  if (deps.platform === "darwin") {
    if (!paths.serviceFile) throw new Error("Missing launchd plist path.");
    const uid = deps.uid;
    if (!dryRun && uid === undefined) throw new Error("Unable to determine user id for launchctl.");
    const plist = renderLaunchdPlist({
      launcherPath: paths.launcherPath,
      port,
      wookyHome: paths.wookyHome,
      logsDir: paths.logsDir,
      pathEnv: env.PATH,
    });
    const domain = uid !== undefined ? `gui/${uid}` : "gui/<uid>";
    const bootoutArgs = ["bootout", `${domain}/${LAUNCHD_LABEL}`] as const;
    const bootstrapArgs = ["bootstrap", domain, paths.serviceFile] as const;
    if (dryRun) {
      deps.io.stdout.write(
        [
          "Dry run: macOS launchd service install",
          `  write file: ${paths.serviceFile}`,
          `  ${plist.trimEnd()}`,
          `  command: ${formatArgv("launchctl", bootoutArgs)}`,
          `  command: ${formatArgv("launchctl", bootstrapArgs)}`,
          "",
        ].join("\n"),
      );
      return 0;
    }
    mkdirSync(dirname(paths.serviceFile), { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });
    writeFileSync(paths.serviceFile, plist, "utf8");
    deps.runner.runSync("launchctl", bootoutArgs, { env });
    const boot = deps.runner.runSync("launchctl", bootstrapArgs, { env });
    if (boot.status !== 0) {
      throw new Error(
        `launchctl bootstrap failed: ${(boot.stderr || boot.stdout || boot.error?.message || "unknown error").trim()}`,
      );
    }
    deps.io.stdout.write(
      `Installed launchd agent ${paths.serviceFile} (port ${port}).\nLogs: ${paths.logsDir}\n`,
    );
    return 0;
  }

  if (deps.platform === "linux") {
    if (!paths.serviceFile) throw new Error("Missing systemd unit path.");
    const unit = renderSystemdUnit({
      launcherPath: paths.launcherPath,
      port,
      wookyHome: paths.wookyHome,
      logsDir: paths.logsDir,
    });
    const reloadArgs = ["--user", "daemon-reload"] as const;
    const enableArgs = ["--user", "enable", "--now", SYSTEMD_UNIT_NAME] as const;
    const lingerArgs = deps.username
      ? (["enable-linger", deps.username] as const)
      : (["enable-linger", "<user>"] as const);
    if (dryRun) {
      deps.io.stdout.write(
        [
          "Dry run: Linux systemd user service install",
          `  write file: ${paths.serviceFile}`,
          `  ${unit.trimEnd()}`,
          `  command: ${formatArgv("systemctl", reloadArgs)}`,
          `  command: ${formatArgv("systemctl", enableArgs)}`,
          `  command: ${formatArgv("loginctl", lingerArgs)}`,
          "",
        ].join("\n"),
      );
      return 0;
    }
    mkdirSync(dirname(paths.serviceFile), { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });
    writeFileSync(paths.serviceFile, unit, "utf8");
    const reload = deps.runner.runSync("systemctl", reloadArgs, { env });
    if (reload.status !== 0) {
      throw new Error(
        `systemctl --user daemon-reload failed: ${(reload.stderr || reload.stdout || reload.error?.message || "unknown error").trim()}`,
      );
    }
    const enable = deps.runner.runSync("systemctl", enableArgs, { env });
    if (enable.status !== 0) {
      throw new Error(
        `systemctl --user enable --now failed: ${(enable.stderr || enable.stdout || enable.error?.message || "unknown error").trim()}`,
      );
    }
    deps.io.stdout.write(`Installed systemd user unit ${paths.serviceFile} (port ${port}).\n`);
    if (deps.username) {
      const linger = deps.runner.runSync("loginctl", lingerArgs, { env });
      if (linger.status !== 0) {
        deps.io.stdout.write(
          `Note: could not enable linger automatically (may require privileges). To keep Wooky running after logout, run: sudo loginctl enable-linger ${deps.username}\n`,
        );
      }
    }
    return 0;
  }

  if (deps.platform === "win32") {
    const xmlPath = win32.join(paths.wookyHome, "wooky-task.xml");
    const xml = renderWindowsTaskXml({
      launcherPath: paths.launcherPath,
      port,
      wookyHome: paths.wookyHome,
    });
    const createArgs = buildSchtasksInstallArgs({ xmlPath });
    const runArgs = buildSchtasksRunArgs();
    if (dryRun) {
      deps.io.stdout.write(
        [
          "Dry run: Windows Scheduled Task service install",
          `  write file: ${xmlPath}`,
          `  ${xml.trimEnd()}`,
          `  command: ${formatArgv("schtasks.exe", createArgs)}`,
          `  command: ${formatArgv("schtasks.exe", runArgs)}`,
          "",
        ].join("\n"),
      );
      return 0;
    }
    mkdirSync(paths.wookyHome, { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });
    writeFileSync(xmlPath, xml, "utf8");
    const create = deps.runner.runSync("schtasks.exe", createArgs, { env });
    if (create.status !== 0) {
      throw new Error(
        `schtasks.exe /Create failed: ${(create.stderr || create.stdout || create.error?.message || "unknown error").trim()}`,
      );
    }
    deps.runner.runSync("schtasks.exe", runArgs, { env });
    deps.io.stdout.write(
      `Installed Windows Scheduled Task "${WINDOWS_TASK_NAME}" (port ${port}).\n`,
    );
    return 0;
  }

  throw new Error(`Unsupported platform "${deps.platform}" for service install.`);
}

function uninstallService(
  paths: SelfPaths,
  env: NodeJS.ProcessEnv,
  deps: ResolvedDeps,
  quietIfAbsent = false,
): number {
  if (deps.platform === "darwin") {
    if (deps.uid !== undefined) {
      deps.runner.runSync("launchctl", ["bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`], { env });
    }
    const existed = paths.serviceFile ? existsSync(paths.serviceFile) : false;
    if (paths.serviceFile) rmSync(paths.serviceFile, { force: true });
    if (existed || !quietIfAbsent) {
      deps.io.stdout.write(`Removed launchd agent ${LAUNCHD_LABEL}.\n`);
    }
    return 0;
  }

  if (deps.platform === "linux") {
    deps.runner.runSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME], { env });
    const existed = paths.serviceFile ? existsSync(paths.serviceFile) : false;
    if (paths.serviceFile) rmSync(paths.serviceFile, { force: true });
    deps.runner.runSync("systemctl", ["--user", "daemon-reload"], { env });
    if (existed || !quietIfAbsent) {
      deps.io.stdout.write(`Removed systemd user unit ${SYSTEMD_UNIT_NAME}.\n`);
    }
    return 0;
  }

  if (deps.platform === "win32") {
    deps.runner.runSync("schtasks.exe", buildSchtasksEndArgs(), { env });
    const del = deps.runner.runSync("schtasks.exe", buildSchtasksUninstallArgs(), { env });
    rmSync(win32.join(paths.wookyHome, "wooky-task.xml"), { force: true });
    if (del.status === 0 || !quietIfAbsent) {
      deps.io.stdout.write(`Removed Windows Scheduled Task "${WINDOWS_TASK_NAME}".\n`);
    }
    return 0;
  }

  throw new Error(`Unsupported platform "${deps.platform}" for service uninstall.`);
}

function statusService(paths: SelfPaths, env: NodeJS.ProcessEnv, deps: ResolvedDeps): number {
  if (deps.platform === "darwin") {
    const installed = paths.serviceFile ? existsSync(paths.serviceFile) : false;
    if (!installed) {
      deps.io.stdout.write("Service is not installed.\n");
      return 3;
    }
    const uid = deps.uid;
    const res =
      uid !== undefined
        ? deps.runner.runSync("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`], { env })
        : { status: 1, stdout: "", stderr: "" };
    const running = res.status === 0 && /state\s*=\s*running/i.test(res.stdout);
    deps.io.stdout.write(
      `launchd agent ${LAUNCHD_LABEL}: ${running ? "running" : res.status === 0 ? "loaded" : "stopped"} (${paths.serviceFile})\n`,
    );
    return running || res.status === 0 ? 0 : 3;
  }

  if (deps.platform === "linux") {
    const installed = paths.serviceFile ? existsSync(paths.serviceFile) : false;
    if (!installed) {
      deps.io.stdout.write("Service is not installed.\n");
      return 3;
    }
    const active = deps.runner.runSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT_NAME], {
      env,
    });
    const state = (active.stdout || active.stderr || "unknown").trim();
    deps.io.stdout.write(`systemd unit ${SYSTEMD_UNIT_NAME}: ${state} (${paths.serviceFile})\n`);
    return active.status === 0 ? 0 : 3;
  }

  if (deps.platform === "win32") {
    const query = deps.runner.runSync("schtasks.exe", buildSchtasksStatusArgs(), { env });
    if (query.status !== 0) {
      deps.io.stdout.write("Service is not installed.\n");
      return 3;
    }
    deps.io.stdout.write(`${query.stdout.trim()}\n`);
    return 0;
  }

  throw new Error(`Unsupported platform "${deps.platform}" for service status.`);
}

async function runUpdate(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: ResolvedDeps,
): Promise<number> {
  const { flags, positionals } = parseSimpleFlags(
    args,
    new Set(["version", "repo"]),
    new Set(["help"]),
  );
  if (flags.has("help")) {
    deps.io.stdout.write(`${SELF_USAGE}\n`);
    return 0;
  }
  if (positionals.length > 0) {
    throw new Error(`Unexpected argument "${positionals[0]}".`);
  }

  const repo = validateRepo(
    (typeof flags.get("repo") === "string" ? (flags.get("repo") as string) : undefined) ??
      env.WOOKY_REPO ??
      DEFAULT_WOOKY_REPO,
  );
  const version =
    (typeof flags.get("version") === "string" ? (flags.get("version") as string) : undefined) ??
    env.WOOKY_VERSION;
  const url = buildInstallerUrl(repo, version, deps.platform);

  const response = await deps.fetchImpl(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download installer from ${url} (HTTP ${response.status}).`);
  }
  verifyInstallerResponseUrl(url, response.url || url, repo);
  const script = await response.text();
  if (!script.trim()) {
    throw new Error(`Downloaded installer from ${url} was empty.`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "wooky-update-"));
  const filename = deps.platform === "win32" ? "install.ps1" : "install.sh";
  const scriptPath = join(tempDir, filename);
  try {
    writeFileSync(scriptPath, script, "utf8");
    if (deps.platform !== "win32") chmodSync(scriptPath, 0o700);
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      WOOKY_YES: "1",
      WOOKY_REPO: repo,
      ...(version ? { WOOKY_VERSION: version } : {}),
    };
    const [file, argv] =
      deps.platform === "win32"
        ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]]
        : ["/bin/sh", [scriptPath]];
    return await deps.runner.runInherit(file, argv, { env: childEnv });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runUninstall(args: string[], env: NodeJS.ProcessEnv, deps: ResolvedDeps): number {
  const { flags, positionals } = parseSimpleFlags(args, new Set(), new Set(["purge", "help"]));
  if (flags.has("help")) {
    deps.io.stdout.write(`${SELF_USAGE}\n`);
    return 0;
  }
  if (positionals.length > 0) {
    throw new Error(`Unexpected argument "${positionals[0]}".`);
  }

  const purge = flags.has("purge");
  const paths = resolveSelfPaths({ platform: deps.platform, homeDir: deps.homeDir, env });

  try {
    uninstallService(paths, env, deps, true);
  } catch (error: unknown) {
    deps.io.stderr.write(
      `Warning: could not remove service: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  const p = pathApi(deps.platform);
  const safeRemove = (target: string) => {
    const resolvedTarget = p.resolve(target);
    const resolvedHome = p.resolve(deps.homeDir);
    if (resolvedTarget === resolvedHome || resolvedTarget === p.parse(resolvedTarget).root) {
      throw new Error(`Refusing to remove protected path "${resolvedTarget}".`);
    }
    rmSync(resolvedTarget, { recursive: true, force: true });
  };

  safeRemove(paths.appDir);
  safeRemove(paths.runtimeDir);
  rmSync(paths.launcherPath, { force: true });

  if (purge) {
    safeRemove(paths.wookyHome);
    deps.io.stdout.write(`Uninstalled Wooky and removed ${paths.wookyHome}.\n`);
  } else {
    deps.io.stdout.write(
      `Uninstalled Wooky (${paths.appDir}, ${paths.launcherPath}).\nKept data directory ${paths.wookyHome}. Pass --purge to remove it.\n`,
    );
  }
  return 0;
}
