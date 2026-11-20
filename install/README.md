# Wooky Installer

One-command installers for macOS, Linux, Windows, and Proxmox VE.

## Quick start

### macOS & Linux

```sh
curl -fsSL https://github.com/BimaPDev/Wooky/releases/latest/download/install.sh | bash
```

### Windows (PowerShell 5.1 or PowerShell 7+)

```powershell
irm https://github.com/BimaPDev/Wooky/releases/latest/download/install.ps1 | iex
```

### Proxmox VE host shell (root)

```bash
bash -c "$(curl -fsSL https://github.com/BimaPDev/Wooky/releases/latest/download/proxmox.sh)"
```

## Configuration

Every installer option can be passed via environment variables (and `install.sh` also accepts matching CLI flags):

| Variable        | Default                                           | Description                                                                  |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `WOOKY_REPO`    | `BimaPDev/Wooky`                                  | GitHub `owner/repo` hosting release assets                                   |
| `WOOKY_VERSION` | `latest`                                          | Release version to install (e.g. `0.2.0` or `v0.2.0`)                        |
| `WOOKY_PREFIX`  | `~/.wooky/app` (Win: `%LOCALAPPDATA%\Wooky\app`)  | Directory where versioned bundles and the `current` symlink/junction live    |
| `WOOKY_SERVICE` | `1` on headless Linux / containers, `0` elsewhere | Set to `1` to install and start the login/user background service            |
| `WOOKY_HOST`    | `0`                                               | Set to `1` to run `wooky pair --print` when supported by the installed build |
| `WOOKY_AGENTS`  | _(empty)_                                         | Comma-separated CLIs to install (`claude,codex,opencode`)                    |
| `WOOKY_YES`     | `0`                                               | Non-interactive confirmation (e.g. appending the PATH line to your shell rc) |

### Proxmox VE non-interactive variables

Set any of `CTID`, `CT_HOSTNAME` (default `wooky`), `CORES` (`2`), `RAM` (`4096`), `DISK` (`16G`), `STORAGE`, `TEMPLATE_STORAGE`, `BRIDGE` (`vmbr0`), `IP_CONFIG` (`dhcp` or CIDR), `GATEWAY`, `TAILSCALE` (`1` to pass through `/dev/net/tun` and install Tailscale), and `WOOKY_YES=1`.

## Managing Wooky after install

```sh
wooky service install [--port 4317]   # launchd (macOS), systemd --user (Linux), Scheduled Task (Windows)
wooky service status
wooky service uninstall

wooky update [--version 0.2.0]        # re-run the official installer and keep 2 prior versions
wooky uninstall [--purge]             # remove service, app, and launcher (--purge also deletes WOOKY_HOME)
```

### Rollback

Upgrades keep the two previous versions in `$WOOKY_PREFIX`. To roll back on macOS/Linux:

```sh
ln -sfn ~/.wooky/app/<previous-version> ~/.wooky/app/current
```

## Cutting a release

Push a `v*` git tag (for example `git tag v0.1.0 && git push origin v0.1.0`). The `.github/workflows/release.yml` workflow builds the standalone bundle with `pnpm release -- --version 0.1.0`, smoke-tests it, and uploads `wooky-0.1.0.tgz`, `SHA256SUMS`, `install.sh`, `install.ps1`, and `proxmox.sh` to the GitHub Release.
