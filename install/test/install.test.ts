import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const installDir = fileURLToPath(new URL("..", import.meta.url));
const installSh = join(installDir, "install.sh");
const proxmoxSh = join(installDir, "proxmox.sh");

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

function runShHelper(
  snippet: string,
  args: readonly string[] = [],
  env: Record<string, string | undefined> = {},
) {
  return spawnSync("sh", ["-c", `. "$1"; shift; ${snippet}`, "wooky-test", installSh, ...args], {
    encoding: "utf8",
    env: { ...process.env, WOOKY_INSTALL_LIB: "1", ...env },
  });
}

function runProxmoxHelper(snippet: string, args: readonly string[] = [], input?: string) {
  return spawnSync(
    "bash",
    ["-c", `. "$1"; shift; ${snippet}`, "wooky-proxmox-test", proxmoxSh, ...args],
    {
      encoding: "utf8",
      input,
      env: { ...process.env, WOOKY_PROXMOX_LIB: "1" },
    },
  );
}

describe.skipIf(process.platform === "win32")("install/install.sh pure helpers", () => {
  it("detects supported OS values and rejects others", () => {
    expect(runShHelper('detect_os "$1"', ["Darwin"]).stdout.trim()).toBe("darwin");
    expect(runShHelper('detect_os "$1"', ["Linux"]).stdout.trim()).toBe("linux");

    const bad = runShHelper('detect_os "$1"', ["FreeBSD"]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("Unsupported operating system");
  });

  it("detects supported CPU architectures and rejects others", () => {
    expect(runShHelper('detect_arch "$1"', ["x86_64"]).stdout.trim()).toBe("x64");
    expect(runShHelper('detect_arch "$1"', ["amd64"]).stdout.trim()).toBe("x64");
    expect(runShHelper('detect_arch "$1"', ["arm64"]).stdout.trim()).toBe("arm64");
    expect(runShHelper('detect_arch "$1"', ["aarch64"]).stdout.trim()).toBe("arm64");

    const bad = runShHelper('detect_arch "$1"', ["i686"]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("Unsupported CPU architecture");
  });

  it("validates Node semver >= 24", () => {
    expect(runShHelper('node_version_ok "$1"', ["v24.0.0"]).status).toBe(0);
    expect(runShHelper('node_version_ok "$1"', ["v24.18.0"]).status).toBe(0);
    expect(runShHelper('node_version_ok "$1"', ["25.1.0"]).status).toBe(0);

    expect(runShHelper('node_version_ok "$1"', ["v23.9.9"]).status).not.toBe(0);
    expect(runShHelper('node_version_ok "$1"', ["v22.14.0"]).status).not.toBe(0);
    expect(runShHelper('node_version_ok "$1"', [""]).status).not.toBe(0);
    expect(runShHelper('node_version_ok "$1"', ["not-a-version"]).status).not.toBe(0);
  });

  it("parses SHA256SUMS entries across standard formats", () => {
    const dir = makeTempDir("wooky-sums-");
    const sumsPath = join(dir, "SHA256SUMS");
    const hashA = "a".repeat(64);
    const hashB = "B".repeat(64);
    const hashC = "c".repeat(64);
    writeFileSync(
      sumsPath,
      [
        "# comment line",
        `${hashA}  wooky-0.1.0.tgz`,
        `${hashB} *node-v24.18.0-linux-x64.tar.gz`,
        `${hashC}  ./install.sh`,
        "deadbeef  broken.tgz",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(
      runShHelper('parse_sha256sum "$1" "$2"', ["wooky-0.1.0.tgz", sumsPath]).stdout.trim(),
    ).toBe(hashA);
    expect(
      runShHelper('parse_sha256sum "$1" "$2"', [
        "node-v24.18.0-linux-x64.tar.gz",
        sumsPath,
      ]).stdout.trim(),
    ).toBe(hashB.toLowerCase());
    expect(runShHelper('parse_sha256sum "$1" "$2"', ["install.sh", sumsPath]).stdout.trim()).toBe(
      hashC,
    );
    expect(runShHelper('parse_sha256sum "$1" "$2"', ["broken.tgz", sumsPath]).status).not.toBe(0);
    expect(runShHelper('parse_sha256sum "$1" "$2"', ["missing.tgz", sumsPath]).status).not.toBe(0);
  });

  it("extracts the latest Node 24 version from nodejs index.json", () => {
    const dir = makeTempDir("wooky-node-idx-");
    const jsonPath = join(dir, "index.json");
    writeFileSync(
      jsonPath,
      '[{"version":"v25.0.0"},{"version":"v24.18.0","lts":"Krypton"},{"version":"v24.17.0"},{"version":"v22.14.0"}]',
      "utf8",
    );
    expect(runShHelper('extract_latest_node24_version "$1"', [jsonPath]).stdout.trim()).toBe(
      "v24.18.0",
    );
  });

  it("formats PATH hints and shell rc paths per shell", () => {
    expect(
      runShHelper('path_hint_line "$1" "$2"', ["/Users/ada/.local/bin", "/bin/zsh"]).stdout.trim(),
    ).toBe('export PATH="/Users/ada/.local/bin:$PATH"');
    expect(
      runShHelper('path_hint_line "$1" "$2"', [
        "/home/ada/.local/bin",
        "/usr/bin/fish",
      ]).stdout.trim(),
    ).toBe('fish_add_path "/home/ada/.local/bin"');

    expect(runShHelper('shell_rc_file "$1" "$2"', ["/bin/zsh", "/Users/ada"]).stdout.trim()).toBe(
      "/Users/ada/.zshrc",
    );
    expect(runShHelper('shell_rc_file "$1" "$2"', ["/bin/bash", "/home/ada"]).stdout.trim()).toBe(
      "/home/ada/.bashrc",
    );
    expect(
      runShHelper('shell_rc_file "$1" "$2"', ["/usr/bin/fish", "/home/ada"]).stdout.trim(),
    ).toBe("/home/ada/.config/fish/config.fish");
    expect(runShHelper('shell_rc_file "$1" "$2"', ["/bin/sh", "/home/ada"]).stdout.trim()).toBe(
      "/home/ada/.profile",
    );
  });

  it("defaults WOOKY_SERVICE on for headless Linux and containers, off for macOS and desktop Linux", () => {
    expect(
      runShHelper('default_service_enabled "$1"', ["darwin"], {
        DISPLAY: "",
        WAYLAND_DISPLAY: "",
      }).stdout.trim(),
    ).toBe("0");
    expect(
      runShHelper('default_service_enabled "$1"', ["linux"], {
        DISPLAY: "",
        WAYLAND_DISPLAY: "",
        container: "",
      }).stdout.trim(),
    ).toBe("1");
    expect(
      runShHelper('default_service_enabled "$1"', ["linux"], {
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "",
        container: "",
      }).stdout.trim(),
    ).toBe("0");
    expect(
      runShHelper('default_service_enabled "$1"', ["linux"], {
        DISPLAY: ":0",
        container: "lxc",
      }).stdout.trim(),
    ).toBe("1");
  });

  it("prunes old versions while keeping current plus two previous versions", () => {
    const prefix = makeTempDir("wooky-prune-");
    const versions = ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"];
    versions.forEach((v, idx) => {
      const dir = join(prefix, v);
      mkdirSync(dir);
      const t = new Date(1_700_000_000_000 + idx * 10_000);
      utimesSync(dir, t, t);
    });
    const res = runShHelper('prune_old_versions "$1" "$2" 2', [prefix, "0.5.0"]);
    expect(res.status).toBe(0);
    expect(existsSync(join(prefix, "0.5.0"))).toBe(true);
    expect(existsSync(join(prefix, "0.4.0"))).toBe(true);
    expect(existsSync(join(prefix, "0.3.0"))).toBe(true);
    expect(existsSync(join(prefix, "0.2.0"))).toBe(false);
    expect(existsSync(join(prefix, "0.1.0"))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("install/proxmox.sh pure helpers", () => {
  it("normalizes disk sizes and builds net0 specs", () => {
    expect(runProxmoxHelper('normalize_disk_gb "$1"', ["16G"]).stdout.trim()).toBe("16");
    expect(runProxmoxHelper('normalize_disk_gb "$1"', ["32"]).stdout.trim()).toBe("32");
    expect(runProxmoxHelper('normalize_disk_gb "$1"', ["2G"]).status).not.toBe(0);

    expect(
      runProxmoxHelper('build_net0_spec "$1" "$2" "$3"', ["vmbr0", "dhcp", ""]).stdout.trim(),
    ).toBe("name=eth0,bridge=vmbr0,ip=dhcp");
    expect(
      runProxmoxHelper('build_net0_spec "$1" "$2" "$3"', [
        "vmbr0",
        "192.168.1.50/24",
        "192.168.1.1",
      ]).stdout.trim(),
    ).toBe("name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1");
  });

  it("selects the newest Debian 13 template and parses active storage", () => {
    const templates = [
      "system          debian-12-standard_12.7-1_amd64.tar.zst",
      "system          debian-13-standard_13.0-1_amd64.tar.zst",
      "system          debian-13-standard_13.1-2_amd64.tar.zst",
      "system          ubuntu-24.04-standard_24.04-2_amd64.tar.zst",
      "",
    ].join("\n");
    expect(runProxmoxHelper("select_debian13_template", [], templates).stdout.trim()).toBe(
      "debian-13-standard_13.1-2_amd64.tar.zst",
    );

    const storageTable = [
      "Name             Type     Status           Total            Used       Available        %",
      "local-lvm        lvmthin  active       104857600        20971520        83886080   20.00%",
      "offline-nas      nfs      inactive             0               0               0    0.00%",
      "tank             zfspool  active       524288000       104857600       419430400   20.00%",
      "",
    ].join("\n");
    expect(
      runProxmoxHelper("parse_storage_list", [], storageTable).stdout.trim().split("\n"),
    ).toEqual(["local-lvm", "tank"]);
  });
});
