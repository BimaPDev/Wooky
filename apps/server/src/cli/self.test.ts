import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WOOKY_DEFAULT_PORT } from "@wooky/contracts";
import type { CommandResult, SelfCommandRunner } from "../process/self-service.ts";
import {
  buildInstallerUrl,
  buildSchtasksEndArgs,
  buildSchtasksInstallArgs,
  buildSchtasksRunArgs,
  buildSchtasksStatusArgs,
  buildSchtasksUninstallArgs,
  buildServicePathEnv,
  LAUNCHD_LABEL,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsTaskXml,
  resolveSelfPaths,
  resolveServicePort,
  runSelfCli,
  selectVersionsToPrune,
  SYSTEMD_UNIT_NAME,
  validateRepo,
  verifyInstallerResponseUrl,
  WINDOWS_TASK_NAME,
} from "./self.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function captureIo() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => {
    out += String(chunk);
  });
  stderr.on("data", (chunk) => {
    err += String(chunk);
  });
  return {
    io: { stdout, stderr },
    out: () => out,
    err: () => err,
  };
}

function fakeRunner(
  syncHandler?: (file: string, args: readonly string[]) => CommandResult,
  inheritHandler?: (
    file: string,
    args: readonly string[],
    env?: NodeJS.ProcessEnv,
  ) => Promise<number>,
) {
  const calls: Array<{
    kind: "sync" | "inherit";
    file: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  }> = [];
  const runner: SelfCommandRunner = {
    runSync(file, args, options) {
      calls.push({ kind: "sync", file, args: [...args], env: options?.env });
      return syncHandler?.(file, args) ?? { status: 0, stdout: "", stderr: "" };
    },
    async runInherit(file, args, options) {
      calls.push({ kind: "inherit", file, args: [...args], env: options?.env });
      return (await inheritHandler?.(file, args, options?.env)) ?? 0;
    },
  };
  return { runner, calls };
}

describe("resolveSelfPaths", () => {
  it("resolves macOS paths", () => {
    const paths = resolveSelfPaths({ platform: "darwin", homeDir: "/Users/ada", env: {} });
    expect(paths).toEqual({
      platform: "darwin",
      wookyHome: "/Users/ada/.wooky",
      appDir: "/Users/ada/.wooky/app",
      runtimeDir: "/Users/ada/.wooky/runtime",
      binDir: "/Users/ada/.local/bin",
      launcherPath: "/Users/ada/.local/bin/wooky",
      logsDir: "/Users/ada/.wooky/logs",
      serviceFile: `/Users/ada/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    });
  });

  it("resolves Linux paths and respects XDG_CONFIG_HOME and WOOKY_PREFIX", () => {
    const paths = resolveSelfPaths({
      platform: "linux",
      homeDir: "/home/wooky",
      env: {
        XDG_CONFIG_HOME: "/home/wooky/.xdg",
        WOOKY_PREFIX: "/opt/wooky-app",
        WOOKY_HOME: "/srv/wooky-data",
      },
    });
    expect(paths).toEqual({
      platform: "linux",
      wookyHome: "/srv/wooky-data",
      appDir: "/opt/wooky-app",
      runtimeDir: "/srv/wooky-data/runtime",
      binDir: "/home/wooky/.local/bin",
      launcherPath: "/home/wooky/.local/bin/wooky",
      logsDir: "/srv/wooky-data/logs",
      serviceFile: `/home/wooky/.xdg/systemd/user/${SYSTEMD_UNIT_NAME}`,
    });
  });

  it("resolves Windows paths under LOCALAPPDATA", () => {
    const paths = resolveSelfPaths({
      platform: "win32",
      homeDir: "C:\\Users\\ada",
      env: { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" },
    });
    expect(paths).toEqual({
      platform: "win32",
      wookyHome: "C:\\Users\\ada\\.wooky",
      appDir: "C:\\Users\\ada\\AppData\\Local\\Wooky\\app",
      runtimeDir: "C:\\Users\\ada\\AppData\\Local\\Wooky\\runtime",
      binDir: "C:\\Users\\ada\\AppData\\Local\\Wooky\\bin",
      launcherPath: "C:\\Users\\ada\\AppData\\Local\\Wooky\\bin\\wooky.cmd",
      logsDir: "C:\\Users\\ada\\.wooky\\logs",
      serviceFile: null,
    });
  });
});

describe("resolveServicePort", () => {
  it("falls back from flag to env to settings.json to WOOKY_DEFAULT_PORT", () => {
    expect(
      resolveServicePort({
        env: {},
        wookyHome: "/tmp/h",
        readSettingsFile: () => null,
      }),
    ).toBe(WOOKY_DEFAULT_PORT);

    expect(
      resolveServicePort({
        env: {},
        wookyHome: "/tmp/h",
        readSettingsFile: () => JSON.stringify({ hosting: { port: 5123 } }),
      }),
    ).toBe(5123);

    expect(
      resolveServicePort({
        env: { WOOKY_PORT: "6000" },
        wookyHome: "/tmp/h",
        readSettingsFile: () => JSON.stringify({ hosting: { port: 5123 } }),
      }),
    ).toBe(6000);

    expect(
      resolveServicePort({
        portFlag: "7000",
        env: { WOOKY_PORT: "6000" },
        wookyHome: "/tmp/h",
        readSettingsFile: () => JSON.stringify({ hosting: { port: 5123 } }),
      }),
    ).toBe(7000);
  });

  it("ignores corrupt settings.json and rejects invalid explicit ports", () => {
    expect(
      resolveServicePort({
        env: {},
        wookyHome: "/tmp/h",
        readSettingsFile: () => "{not json",
      }),
    ).toBe(WOOKY_DEFAULT_PORT);

    expect(() =>
      resolveServicePort({
        portFlag: "0",
        env: {},
        wookyHome: "/tmp/h",
      }),
    ).toThrow(/Invalid port/);
  });
});

describe("service config rendering", () => {
  it("renders a valid macOS launchd plist with XML escaping", () => {
    const binDir = "/Users/a&b/.local/bin";
    const nodeDir = "/Users/a&b/.wooky/runtime/node/bin";
    const pathEnv = buildServicePathEnv(binDir, nodeDir);
    const plist = renderLaunchdPlist({
      launcherPath: "/Users/a&b/.local/bin/wooky",
      wookyHome: "/Users/a&b/.wooky",
      logsDir: "/Users/a&b/.wooky/logs",
      wookyNode: "/Users/a&b/.wooky/runtime/node/bin/node",
      pathEnv,
    });
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/Users/a&amp;b/.local/bin/wooky</string>");
    expect(plist).not.toContain("--port");
    expect(plist).toContain("<key>WOOKY_NODE</key>");
    expect(plist).toContain(
      "<string>/Users/a&amp;b/.local/bin:/Users/a&amp;b/.wooky/runtime/node/bin:/usr/local/bin:/usr/bin:/bin</string>",
    );
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(plist).toContain("<string>/Users/a&amp;b/.wooky/logs/server.out.log</string>");
    expect(plist).toContain("<string>/Users/a&amp;b/.wooky/logs/server.err.log</string>");
  });

  it("renders a Linux systemd user unit with quoted paths", () => {
    const binDir = "/home/my user/.local/bin";
    const nodeDir = "/home/my user/.wooky/runtime/node/bin";
    const unit = renderSystemdUnit({
      launcherPath: "/home/my user/.local/bin/wooky",
      wookyHome: "/home/my user/.wooky",
      logsDir: "/home/my user/.wooky/logs",
      binDir,
      nodeDir,
      wookyNode: "/home/my user/.wooky/runtime/node/bin/node",
    });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain('ExecStart="/home/my user/.local/bin/wooky"');
    expect(unit).not.toContain("--port");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain('Environment="WOOKY_HOME=/home/my user/.wooky"');
    expect(unit).toContain('Environment="WOOKY_NODE=/home/my user/.wooky/runtime/node/bin/node"');
    expect(unit).toContain(`${binDir}:${nodeDir}:/usr/local/bin:/usr/bin:/bin`);
    expect(unit).toContain('StandardOutput=append:"/home/my user/.wooky/logs/server.out.log"');
    expect(unit).toContain("WantedBy=default.target");
  });

  it("renders Windows Task XML and schtasks.exe argv arrays", () => {
    const xml = renderWindowsTaskXml({
      launcherPath: "C:\\Users\\ada\\AppData\\Local\\Wooky\\bin\\wooky.cmd",
      wookyHome: "C:\\Users\\ada\\.wooky",
      userId: "HOST\\ada",
    });
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<Principals>");
    expect(xml).toContain("<UserId>HOST\\ada</UserId>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<Count>999</Count>");
    expect(xml).toContain("<Hidden>true</Hidden>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).not.toContain("--port");
    expect(xml).toContain(
      "<Command>C:\\Users\\ada\\AppData\\Local\\Wooky\\bin\\wooky.cmd</Command>",
    );

    expect(buildSchtasksInstallArgs({ xmlPath: "C:\\tmp\\task.xml" })).toEqual([
      "/Create",
      "/TN",
      WINDOWS_TASK_NAME,
      "/XML",
      "C:\\tmp\\task.xml",
      "/F",
    ]);
    expect(buildSchtasksRunArgs()).toEqual(["/Run", "/TN", WINDOWS_TASK_NAME]);
    expect(buildSchtasksEndArgs()).toEqual(["/End", "/TN", WINDOWS_TASK_NAME]);
    expect(buildSchtasksUninstallArgs()).toEqual(["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
    expect(buildSchtasksStatusArgs()).toEqual([
      "/Query",
      "/TN",
      WINDOWS_TASK_NAME,
      "/FO",
      "LIST",
      "/V",
    ]);
  });
});

describe("selectVersionsToPrune", () => {
  it("keeps current plus the two newest previous versions", () => {
    const prune = selectVersionsToPrune(
      [
        { name: "current", mtimeMs: 9999 },
        { name: ".staging", mtimeMs: 9998 },
        { name: "0.1.0", mtimeMs: 100 },
        { name: "0.2.0", mtimeMs: 200 },
        { name: "0.3.0", mtimeMs: 300 },
        { name: "0.4.0", mtimeMs: 400 },
        { name: "0.5.0", mtimeMs: 500 },
      ],
      "0.5.0",
    );
    expect(prune).toEqual(["0.2.0", "0.1.0"]);
  });

  it("never prunes current even when rolled back to an older version", () => {
    const prune = selectVersionsToPrune(
      [
        { name: "0.1.0", mtimeMs: 100 },
        { name: "0.2.0", mtimeMs: 200 },
        { name: "0.3.0", mtimeMs: 300 },
        { name: "0.4.0", mtimeMs: 400 },
      ],
      "0.1.0",
    );
    expect(prune).toEqual(["0.2.0"]);
  });
});

describe("update URL validation", () => {
  it("builds and verifies official GitHub installer URLs", () => {
    expect(validateRepo("BimaPDev/Wooky")).toBe("BimaPDev/Wooky");
    expect(() => validateRepo("../bad")).toThrow(/Invalid WOOKY_REPO/);
    expect(() => validateRepo("https://evil.com/a/b")).toThrow(/Invalid WOOKY_REPO/);

    const posixUrl = buildInstallerUrl("BimaPDev/Wooky", undefined, "darwin");
    expect(posixUrl).toBe("https://github.com/BimaPDev/Wooky/releases/latest/download/install.sh");
    const winUrl = buildInstallerUrl("BimaPDev/Wooky", "0.2.0", "win32");
    expect(winUrl).toBe("https://github.com/BimaPDev/Wooky/releases/download/v0.2.0/install.ps1");

    expect(() =>
      verifyInstallerResponseUrl(
        posixUrl,
        "https://objects.githubusercontent.com/github-production-release-asset/install.sh",
        "BimaPDev/Wooky",
      ),
    ).not.toThrow();

    expect(() =>
      verifyInstallerResponseUrl(
        posixUrl,
        "http://objects.githubusercontent.com/install.sh",
        "BimaPDev/Wooky",
      ),
    ).toThrow(/insecure redirect/);

    expect(() =>
      verifyInstallerResponseUrl(posixUrl, "https://evil.example/install.sh", "BimaPDev/Wooky"),
    ).toThrow(/untrusted host/);

    expect(() =>
      verifyInstallerResponseUrl(
        posixUrl,
        "https://github.com/OtherOrg/OtherRepo/releases/download/v1.0.0/install.sh",
        "BimaPDev/Wooky",
      ),
    ).toThrow(/left repository/);
  });
});

// launchd/systemd emulation joins POSIX paths onto the real temp home, which is a drive path on Windows.
const onWindows = process.platform === "win32";

describe("runSelfCli commands", () => {
  it.skipIf(onWindows)("prints launchd files and commands with --dry-run on macOS", async () => {
    const home = makeTempDir("wooky-self-dry-mac-");
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "wooky"),
      '#!/bin/sh\nexport WOOKY_NODE="/opt/node24/bin/node"\n',
      "utf8",
    );
    const { runner } = fakeRunner();
    const io = captureIo();
    const code = await runSelfCli(
      ["service", "install", "--dry-run"],
      { WOOKY_NODE: "/opt/node24/bin/node" },
      {
        platform: "darwin",
        homeDir: home,
        uid: 501,
        runner,
        io: io.io,
      },
    );
    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("Dry run: macOS launchd service install");
    expect(out).toContain(join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`));
    expect(out).toContain("/opt/node24/bin/node");
    expect(out).toContain(`${binDir}:/opt/node24/bin`);
    expect(out).toContain("launchctl bootout gui/501/dev.wooky.server");
    expect(out).toContain("launchctl bootstrap gui/501");
    expect(existsSync(join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`))).toBe(false);
  });

  it.skipIf(onWindows)("prints systemd files and commands with --dry-run on Linux", async () => {
    const home = makeTempDir("wooky-self-dry-linux-");
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "wooky"), '#!/bin/sh\nexport WOOKY_NODE="/usr/bin/node"\n', "utf8");
    const { runner } = fakeRunner();
    const io = captureIo();
    const code = await runSelfCli(
      ["service", "install", "--dry-run"],
      {},
      {
        platform: "linux",
        homeDir: home,
        username: "wooky",
        runner,
        io: io.io,
      },
    );
    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("Dry run: Linux systemd user service install");
    expect(out).toContain(`systemd/user/${SYSTEMD_UNIT_NAME}`);
    expect(out).toContain("systemctl --user daemon-reload");
    expect(out).toContain(`systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`);
    expect(out).toContain("loginctl enable-linger wooky");
    expect(out).toContain(`${binDir}:/usr/bin`);
    expect(out).toContain("WOOKY_NODE=/usr/bin/node");
  });

  it("prints schtasks files and commands with --dry-run on Windows", async () => {
    const home = makeTempDir("wooky-self-dry-win-");
    const { runner } = fakeRunner();
    const io = captureIo();
    const code = await runSelfCli(
      ["service", "install", "--dry-run"],
      {},
      {
        platform: "win32",
        homeDir: home,
        runner,
        io: io.io,
      },
    );
    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("Dry run: Windows Scheduled Task service install");
    expect(out).toContain("wooky-task.xml");
    expect(out).toContain("schtasks.exe /Create /TN Wooky");
    expect(out).toContain("schtasks.exe /Run /TN Wooky");
  });

  it.skipIf(onWindows)("installs, inspects, and uninstalls a macOS launchd service", async () => {
    const home = makeTempDir("wooky-self-mac-");
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "wooky"),
      '#!/bin/sh\nexport WOOKY_NODE="/usr/local/bin/node"\n',
      "utf8",
    );
    const { runner, calls } = fakeRunner((file, args) => {
      if (file === "launchctl" && args[0] === "print") {
        return { status: 0, stdout: "state = running\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const io1 = captureIo();
    const installCode = await runSelfCli(
      ["service", "install"],
      { WOOKY_NODE: "/usr/local/bin/node", PATH: "/usr/bin:/bin" },
      {
        platform: "darwin",
        homeDir: home,
        uid: 501,
        runner,
        io: io1.io,
      },
    );
    expect(installCode).toBe(0);
    const plistPath = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    expect(existsSync(plistPath)).toBe(true);
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain(`${binDir}:/usr/local/bin`);
    expect(plist).not.toContain("--port");
    const bootstrapCall = calls.find((c) => c.file === "launchctl" && c.args[0] === "bootstrap");
    expect(bootstrapCall?.env?.PATH?.startsWith(`${binDir}:/usr/local/bin:`)).toBe(true);
    expect(
      calls.some(
        (c) => c.file === "launchctl" && c.args[0] === "bootstrap" && c.args[1] === "gui/501",
      ),
    ).toBe(true);

    const io2 = captureIo();
    const statusCode = await runSelfCli(
      ["service", "status"],
      {},
      {
        platform: "darwin",
        homeDir: home,
        uid: 501,
        runner,
        io: io2.io,
      },
    );
    expect(statusCode).toBe(0);
    expect(io2.out()).toContain("running");

    const io3 = captureIo();
    const removeCode = await runSelfCli(
      ["service", "uninstall"],
      {},
      {
        platform: "darwin",
        homeDir: home,
        uid: 501,
        runner,
        io: io3.io,
      },
    );
    expect(removeCode).toBe(0);
    expect(existsSync(plistPath)).toBe(false);
  });

  it.skipIf(onWindows)(
    "installs a Linux systemd user unit and notes when loginctl needs privileges",
    async () => {
      const home = makeTempDir("wooky-self-linux-");
      const { runner, calls } = fakeRunner((file) => {
        if (file === "loginctl") {
          return { status: 1, stdout: "", stderr: "Access denied" };
        }
        return { status: 0, stdout: "active\n", stderr: "" };
      });
      const io = captureIo();
      const code = await runSelfCli(
        ["service", "install"],
        {},
        {
          platform: "linux",
          homeDir: home,
          username: "wooky",
          runner,
          io: io.io,
        },
      );
      expect(code).toBe(0);
      expect(io.out()).toContain("sudo loginctl enable-linger wooky");
      expect(calls.map((c) => [c.file, ...c.args])).toEqual([
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME],
        ["loginctl", "enable-linger", "wooky"],
      ]);
    },
  );

  it("downloads and executes the installer on update with WOOKY_YES=1", async () => {
    const home = makeTempDir("wooky-self-update-");
    let capturedScriptPath = "";
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const { runner } = fakeRunner(undefined, async (_file, args, env) => {
      capturedScriptPath = args[0] ?? "";
      capturedEnv = env;
      expect(existsSync(capturedScriptPath)).toBe(true);
      expect(readFileSync(capturedScriptPath, "utf8")).toContain("#!/bin/sh");
      return 0;
    });
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      return {
        ok: true,
        status: 200,
        url,
        text: async () => "#!/bin/sh\necho updated\n",
      } as Response;
    };
    const io = captureIo();
    const code = await runSelfCli(
      ["update", "--version", "0.2.0"],
      {
        WOOKY_BUNDLE_URL: "file:///tmp/wooky.tgz",
        WOOKY_SUMS_URL: "file:///tmp/SHA256SUMS",
        WOOKY_ALLOW_LOCAL_BUNDLE: "1",
      },
      {
        platform: "linux",
        homeDir: home,
        runner,
        fetchImpl,
        io: io.io,
      },
    );
    expect(code).toBe(0);
    expect(capturedEnv?.WOOKY_YES).toBe("1");
    expect(capturedEnv?.WOOKY_VERSION).toBe("0.2.0");
    expect(capturedEnv?.WOOKY_BUNDLE_URL).toBeUndefined();
    expect(capturedEnv?.WOOKY_SUMS_URL).toBeUndefined();
    expect(capturedEnv?.WOOKY_ALLOW_LOCAL_BUNDLE).toBeUndefined();
    expect(existsSync(capturedScriptPath)).toBe(false);
  });

  it.skipIf(onWindows)(
    "uninstalls app and launcher while preserving WOOKY_HOME unless --purge",
    async () => {
      const home = makeTempDir("wooky-self-uninstall-");
      const wookyHome = join(home, ".wooky");
      const appDir = join(wookyHome, "app", "0.1.0");
      const runtimeDir = join(wookyHome, "runtime", "node");
      const binDir = join(home, ".local", "bin");
      const launcher = join(binDir, "wooky");
      const dbFile = join(wookyHome, "state.sqlite");
      mkdirSync(appDir, { recursive: true });
      mkdirSync(runtimeDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(launcher, "#!/bin/sh\n", "utf8");
      writeFileSync(dbFile, "data", "utf8");

      const { runner } = fakeRunner();
      const io1 = captureIo();
      const code1 = await runSelfCli(
        ["uninstall"],
        {},
        {
          platform: "linux",
          homeDir: home,
          runner,
          io: io1.io,
        },
      );
      expect(code1).toBe(0);
      expect(existsSync(join(wookyHome, "app"))).toBe(false);
      expect(existsSync(join(wookyHome, "runtime"))).toBe(false);
      expect(existsSync(launcher)).toBe(false);
      expect(existsSync(dbFile)).toBe(true);

      const io2 = captureIo();
      const code2 = await runSelfCli(
        ["uninstall", "--purge"],
        {},
        {
          platform: "linux",
          homeDir: home,
          runner,
          io: io2.io,
        },
      );
      expect(code2).toBe(0);
      expect(existsSync(wookyHome)).toBe(false);
    },
  );
  it("uninstalls the Windows task, launcher and app, keeping WOOKY_HOME unless --purge", async () => {
    const home = makeTempDir("wooky-self-uninstall-win-");
    const localAppData = join(home, "AppData", "Local");
    const wookyHome = join(home, ".wooky");
    const appDir = join(localAppData, "Wooky", "app");
    const runtimeDir = join(localAppData, "Wooky", "runtime");
    const binDir = join(localAppData, "Wooky", "bin");
    const launcher = join(binDir, "wooky.cmd");
    const dbFile = join(wookyHome, "state.sqlite");
    for (const dir of [appDir, runtimeDir, binDir, wookyHome]) mkdirSync(dir, { recursive: true });
    writeFileSync(launcher, "@echo off\r\n", "utf8");
    writeFileSync(dbFile, "data", "utf8");
    // On a POSIX host the win32 path rules are emulated, so the real files below are only
    // addressed (and checked) when this runs on Windows. The calls and messages are checked everywhere.
    const live = onWindows;

    const { runner, calls } = fakeRunner();
    const io1 = captureIo();
    const code1 = await runSelfCli(
      ["uninstall"],
      { LOCALAPPDATA: localAppData },
      { platform: "win32", homeDir: home, runner, io: io1.io },
    );
    expect(code1).toBe(0);
    expect(calls.map((call) => [call.file, call.args[0]])).toEqual([
      ["schtasks.exe", "/End"],
      ["schtasks.exe", "/Delete"],
    ]);
    expect(io1.out()).toContain("Kept data directory");
    expect(io1.out()).toContain("Pass --purge to remove it.");
    expect(!live || !existsSync(appDir)).toBe(true);
    expect(!live || !existsSync(runtimeDir)).toBe(true);
    expect(!live || !existsSync(launcher)).toBe(true);
    expect(!live || existsSync(dbFile)).toBe(true);

    const io2 = captureIo();
    const code2 = await runSelfCli(
      ["uninstall", "--purge"],
      { LOCALAPPDATA: localAppData },
      { platform: "win32", homeDir: home, runner, io: io2.io },
    );
    expect(code2).toBe(0);
    expect(io2.out()).toContain("Uninstalled Wooky and removed");
    expect(!live || !existsSync(wookyHome)).toBe(true);
  });
});
