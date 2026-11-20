#!/bin/sh
# Wooky one-command installer (macOS & Linux, POSIX sh compatible).
# Usage:
#   curl -fsSL https://github.com/BimaPDev/Wooky/releases/latest/download/install.sh | bash
# Set WOOKY_INSTALL_LIB=1 to source helper functions without running main.
set -eu

# ── Pure helpers (sourced by install/test/install.test.ts) ───────────────────

detect_os() {
  _os_raw="${1:-$(uname -s 2>/dev/null || echo unknown)}"
  case "$_os_raw" in
    Darwin|darwin) printf '%s\n' "darwin" ;;
    Linux|linux)   printf '%s\n' "linux" ;;
    *)
      printf 'Unsupported operating system: %s (Wooky supports macOS and Linux here; use install.ps1 on Windows).\n' "$_os_raw" >&2
      return 1
      ;;
  esac
}

detect_arch() {
  _arch_raw="${1:-$(uname -m 2>/dev/null || echo unknown)}"
  case "$_arch_raw" in
    x86_64|amd64|x64)   printf '%s\n' "x64" ;;
    arm64|aarch64)      printf '%s\n' "arm64" ;;
    *)
      printf 'Unsupported CPU architecture: %s (Wooky supports x64 and arm64).\n' "$_arch_raw" >&2
      return 1
      ;;
  esac
}

node_version_ok() {
  _ver="${1:-}"
  _ver="${_ver#v}"
  _major="${_ver%%.*}"
  case "$_major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$_major" -ge 24 ]
}

parse_sha256sum() {
  _target="$1"
  _sums_file="$2"
  if [ ! -f "$_sums_file" ]; then
    return 1
  fi
  _found=""
  while IFS= read -r _line || [ -n "$_line" ]; do
    # Strip trailing CR if file has CRLF
    _line="${_line%"$(printf '\r')"}"
    case "$_line" in
      ''|'#'*) continue ;;
    esac
    _hash=""
    _name=""
    # Split on first whitespace
    _hash="${_line%%[[:space:]]*}"
    _rest="${_line#"$_hash"}"
    # Trim leading whitespace
    _rest="$(printf '%s' "$_rest" | sed 's/^[[:space:]]*//')"
    # Strip optional leading * (binary mode) or ./
    _name="${_rest#\*}"
    _name="${_name#./}"
    if [ "$_name" = "$_target" ]; then
      _found="$(printf '%s' "$_hash" | tr 'A-F' 'a-f')"
      break
    fi
  done < "$_sums_file"

  case "$_found" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  if [ "${#_found}" -ne 64 ]; then
    return 1
  fi
  printf '%s\n' "$_found"
}

extract_latest_node24_version() {
  _json_file="$1"
  if [ ! -f "$_json_file" ]; then
    return 1
  fi
  _node_ver="$(
    tr '{}' '\n\n' < "$_json_file" \
      | grep '"version"[[:space:]]*:[[:space:]]*"v24\.' \
      | head -n 1 \
      | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
  )"
  if ! node_version_ok "$_node_ver"; then
    return 1
  fi
  printf '%s\n' "$_node_ver"
}

path_hint_line() {
  _bin_dir="$1"
  _shell_path="${2:-${SHELL:-/bin/sh}}"
  _shell_name="$(basename "$_shell_path")"
  case "$_shell_name" in
    fish)
      printf 'fish_add_path "%s"\n' "$_bin_dir"
      ;;
    *)
      printf 'export PATH="%s:$PATH"\n' "$_bin_dir"
      ;;
  esac
}

shell_rc_file() {
  _shell_path="${1:-${SHELL:-/bin/sh}}"
  _home_dir="${2:-${HOME:-}}"
  _shell_name="$(basename "$_shell_path")"
  case "$_shell_name" in
    zsh)  printf '%s/.zshrc\n' "$_home_dir" ;;
    bash)
      if [ -f "$_home_dir/.bashrc" ] || [ ! -f "$_home_dir/.bash_profile" ]; then
        printf '%s/.bashrc\n' "$_home_dir"
      else
        printf '%s/.bash_profile\n' "$_home_dir"
      fi
      ;;
    fish) printf '%s/.config/fish/config.fish\n' "$_home_dir" ;;
    *)    printf '%s/.profile\n' "$_home_dir" ;;
  esac
}

default_service_enabled() {
  _os="$1"
  if [ "$_os" != "linux" ]; then
    printf '0\n'
    return 0
  fi
  if [ -f /.dockerenv ] || [ -f /run/.containerenv ] || [ -n "${container:-}" ]; then
    printf '1\n'
    return 0
  fi
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    printf '1\n'
    return 0
  fi
  printf '0\n'
}

prune_old_versions() {
  _prefix_dir="$1"
  _current_ver="$2"
  _keep="${3:-2}"
  if [ ! -d "$_prefix_dir" ]; then
    return 0
  fi
  _kept=0
  # ls -1t lists newest mtime first (POSIX standard); read loop avoids zsh word-splitting differences.
  ls -1t "$_prefix_dir" 2>/dev/null | while IFS= read -r _entry; do
    case "$_entry" in
      ''|current|.*|"$_current_ver") continue ;;
    esac
    _full="$_prefix_dir/$_entry"
    if [ -L "$_full" ] || [ ! -d "$_full" ]; then
      continue
    fi
    if [ "$_kept" -lt "$_keep" ]; then
      _kept=$((_kept + 1))
    else
      rm -rf "$_full"
    fi
  done
}

# ── Output helpers ───────────────────────────────────────────────────────────

init_colors() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET="$(printf '\033[0m')"
    C_BOLD="$(printf '\033[1m')"
    C_DIM="$(printf '\033[2m')"
    C_GREEN="$(printf '\033[32m')"
    C_AMBER="$(printf '\033[33m')"
    C_RED="$(printf '\033[31m')"
  else
    C_RESET=""
    C_BOLD=""
    C_DIM=""
    C_GREEN=""
    C_AMBER=""
    C_RED=""
  fi
}

step_ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
step_warn() { printf '%s!%s %s\n' "$C_AMBER" "$C_RESET" "$*"; }
step_err()  { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
step_info() { printf '%s•%s %s\n' "$C_DIM" "$C_RESET" "$*"; }

# ── Runtime helpers ──────────────────────────────────────────────────────────

compute_sha256() {
  _file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$_file" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$_file" | awk '{print tolower($1)}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$_file" | awk '{print tolower($NF)}'
  else
    step_err "No SHA-256 tool found (need sha256sum, shasum, or openssl)."
    return 1
  fi
}

curl_https() {
  curl -q --proto '=https' --tlsv1.2 -fsSL "$@"
}

download_file() {
  _url="$1"
  _dest="$2"
  case "$_url" in
    file://*)
      if [ "${WOOKY_ALLOW_LOCAL_BUNDLE:-0}" != "1" ]; then
        step_err "Local bundle URLs require WOOKY_ALLOW_LOCAL_BUNDLE=1."
        return 1
      fi
      _local_path="${_url#file://}"
      if [ ! -f "$_local_path" ]; then
        step_err "Local file not found: $_local_path"
        return 1
      fi
      cp "$_local_path" "$_dest"
      ;;
    *)
      curl_https "$_url" -o "$_dest"
      ;;
  esac
}

fix_node_pty_spawn_helpers() {
  _root="$1"
  if [ ! -d "$_root/node_modules/node-pty" ]; then
    return 0
  fi
  find "$_root/node_modules/node-pty" -type f \( \
    -path '*/prebuilds/*/spawn-helper' -o -path '*/build/Release/spawn-helper' \
  \) 2>/dev/null | while IFS= read -r _helper; do
    [ -n "$_helper" ] && chmod +x "$_helper" 2>/dev/null || true
  done
}

node_has_sqlite() {
  _node_bin="$1"
  if [ ! -x "$_node_bin" ] && ! command -v "$_node_bin" >/dev/null 2>&1; then
    return 1
  fi
  _ver="$("$_node_bin" -v 2>/dev/null || true)"
  if ! node_version_ok "$_ver"; then
    return 1
  fi
  "$_node_bin" -e 'import("node:sqlite").then(() => process.exit(0), () => process.exit(1))' >/dev/null 2>&1
}

ensure_node() {
  _os="$1"
  _arch="$2"
  _runtime_dir="$3"
  _tmp_dir="$4"

  _sys_node="$(command -v node 2>/dev/null || true)"
  if [ -n "$_sys_node" ] && node_has_sqlite "$_sys_node"; then
    NODE_BIN="$_sys_node"
    NODE_MANAGED=0
    step_ok "Using system Node $("$NODE_BIN" -v) ($NODE_BIN)"
    return 0
  fi

  _managed_node="$_runtime_dir/bin/node"
  if [ -x "$_managed_node" ] && node_has_sqlite "$_managed_node"; then
    NODE_BIN="$_managed_node"
    NODE_MANAGED=1
    step_ok "Using Wooky Node runtime $("$NODE_BIN" -v) ($NODE_BIN)"
    return 0
  fi

  step_info "Installing Node 24 runtime into $_runtime_dir..."
  _index_json="$_tmp_dir/node-index.json"
  download_file "https://nodejs.org/dist/index.json" "$_index_json"
  _node_ver="$(extract_latest_node24_version "$_index_json")" || {
    step_err "Could not find a Node 24 release in nodejs.org/dist/index.json."
    return 1
  }

  _tarball="node-${_node_ver}-${_os}-${_arch}.tar.gz"
  _sums_file="$_tmp_dir/node-SHASUMS256.txt"
  _archive="$_tmp_dir/$_tarball"
  download_file "https://nodejs.org/dist/${_node_ver}/SHASUMS256.txt" "$_sums_file"
  download_file "https://nodejs.org/dist/${_node_ver}/${_tarball}" "$_archive"

  _expected="$(parse_sha256sum "$_tarball" "$_sums_file")" || {
    step_err "Missing SHA-256 entry for $_tarball in SHASUMS256.txt."
    return 1
  }
  _actual="$(compute_sha256 "$_archive")"
  if [ "$_expected" != "$_actual" ]; then
    step_err "SHA-256 mismatch for $_tarball (expected $_expected, got $_actual)."
    return 1
  fi

  _stage="$_runtime_dir.staging.$$"
  rm -rf "$_stage"
  mkdir -p "$_stage"
  tar -xzf "$_archive" -C "$_stage" --strip-components=1
  mkdir -p "$(dirname "$_runtime_dir")"
  rm -rf "$_runtime_dir"
  mv "$_stage" "$_runtime_dir"

  if ! node_has_sqlite "$_managed_node"; then
    step_err "Downloaded Node runtime at $_managed_node does not support node:sqlite."
    return 1
  fi

  NODE_BIN="$_managed_node"
  NODE_MANAGED=1
  step_ok "Installed Node $("$NODE_BIN" -v) into $_runtime_dir (SHA-256 verified)"
}

resolve_release_tag() {
  _repo="$1"
  _ver="$2"
  if [ "$_ver" = "latest" ] || [ -z "$_ver" ]; then
    _effective="$(curl_https -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${_repo}/releases/latest")" || {
      step_err "Failed to query latest release for ${_repo}."
      return 1
    }
    case "$_effective" in
      */releases/tag/*)
        printf '%s\n' "${_effective##*/releases/tag/}"
        return 0
        ;;
      *)
        step_err "No published release found for ${_repo} (resolved to $_effective)."
        return 1
        ;;
    esac
  fi
  printf 'v%s\n' "${_ver#v}"
}

confirm_prompt() {
  _question="$1"
  if [ "${WOOKY_YES:-0}" = "1" ]; then
    return 0
  fi
  if [ -t 1 ] && [ -r /dev/tty ]; then
    printf '%s [y/N] ' "$_question" >/dev/tty
    IFS= read -r _ans </dev/tty || _ans=""
    case "$_ans" in
      y|Y|yes|YES) return 0 ;;
    esac
  fi
  return 1
}

install_agents() {
  _list="$1"
  _wooky_home="$2"
  _bin_dir="$3"
  _node_bin_dir="$4"
  _installed_any=0

  _remaining="$_list,"
  while [ -n "$_remaining" ]; do
    _raw="${_remaining%%,*}"
    _remaining="${_remaining#*,}"
    _agent="$(printf '%s' "$_raw" | tr 'A-Z' 'a-z' | tr -d '[:space:]')"
    [ -z "$_agent" ] && continue
    case "$_agent" in
      claude)
        step_info "Installing Claude Code..."
        if curl_https https://claude.ai/install.sh | bash; then
          step_ok "Installed Claude Code (sign in on this machine with: claude)"
          _installed_any=1
        else
          step_warn "Claude Code installer returned an error."
        fi
        ;;
      codex)
        step_info "Installing Codex CLI..."
        _tools_prefix="$_wooky_home/tools"
        mkdir -p "$_tools_prefix"
        if PATH="$_node_bin_dir:$PATH" npm install -g --prefix "$_tools_prefix" --no-audit --no-fund @openai/codex; then
          if [ -x "$_tools_prefix/bin/codex" ]; then
            ln -sfn "$_tools_prefix/bin/codex" "$_bin_dir/codex"
          fi
          step_ok "Installed Codex CLI (sign in on this machine with: codex login)"
          _installed_any=1
        else
          step_warn "Codex CLI installation failed."
        fi
        ;;
      opencode)
        step_info "Installing OpenCode..."
        if curl_https https://opencode.ai/install | bash; then
          step_ok "Installed OpenCode (sign in on this machine with: opencode)"
          _installed_any=1
        else
          step_warn "OpenCode installer returned an error."
        fi
        ;;
      *)
        step_warn "Unknown agent '$_agent' in WOOKY_AGENTS (supported: claude, codex, opencode)."
        ;;
    esac
  done

  if [ "$_installed_any" = "1" ]; then
    step_info "Each agent CLI needs its own sign-in on this machine; Wooky never stores credentials."
  fi
}

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options (all also configurable via environment variables):
  --version <ver>   Version to install (default: latest; env: WOOKY_VERSION)
  --repo <o/r>      GitHub repository (default: BimaPDev/Wooky; env: WOOKY_REPO)
  --prefix <dir>    App directory (default: ~/.wooky/app; env: WOOKY_PREFIX)
  --service         Install and start background service (env: WOOKY_SERVICE=1)
  --no-service      Skip background service setup (env: WOOKY_SERVICE=0)
  --host            Print pairing code if supported (env: WOOKY_HOST=1)
  --agents <list>   Comma-separated agents: claude,codex,opencode (env: WOOKY_AGENTS)
  -y, --yes         Non-interactive confirmation (env: WOOKY_YES=1)
  -h, --help        Show this help
EOF
}

parse_cli_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        shift; WOOKY_VERSION="${1:?missing value for --version}" ;;
      --version=*)
        WOOKY_VERSION="${1#*=}" ;;
      --repo)
        shift; WOOKY_REPO="${1:?missing value for --repo}" ;;
      --repo=*)
        WOOKY_REPO="${1#*=}" ;;
      --prefix)
        shift; WOOKY_PREFIX="${1:?missing value for --prefix}" ;;
      --prefix=*)
        WOOKY_PREFIX="${1#*=}" ;;
      --service)
        WOOKY_SERVICE=1 ;;
      --no-service)
        WOOKY_SERVICE=0 ;;
      --host)
        WOOKY_HOST=1 ;;
      --agents)
        shift; WOOKY_AGENTS="${1:?missing value for --agents}" ;;
      --agents=*)
        WOOKY_AGENTS="${1#*=}" ;;
      -y|--yes)
        WOOKY_YES=1 ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        step_err "Unknown option: $1"
        usage >&2
        exit 1
        ;;
    esac
    shift
  done
}

main() {
  init_colors
  parse_cli_args "$@"

  WOOKY_REPO="${WOOKY_REPO:-BimaPDev/Wooky}"
  WOOKY_VERSION="${WOOKY_VERSION:-latest}"
  WOOKY_HOME="${WOOKY_HOME:-${HOME}/.wooky}"
  WOOKY_PREFIX="${WOOKY_PREFIX:-${WOOKY_HOME}/app}"
  WOOKY_BIN_DIR="${WOOKY_BIN_DIR:-${HOME}/.local/bin}"
  WOOKY_RUNTIME_DIR="${WOOKY_RUNTIME_DIR:-${WOOKY_HOME}/runtime/node}"
  WOOKY_HOST="${WOOKY_HOST:-0}"
  WOOKY_AGENTS="${WOOKY_AGENTS:-}"
  WOOKY_YES="${WOOKY_YES:-0}"
  WOOKY_PORT="${WOOKY_PORT:-4317}"

  if ! command -v curl >/dev/null 2>&1 && [ -z "${WOOKY_BUNDLE_URL:-}" ]; then
    step_err "curl is required to install Wooky."
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    step_err "tar is required to install Wooky."
    exit 1
  fi

  # 1. Detect platform
  OS="$(detect_os)"
  ARCH="$(detect_arch)"
  step_ok "Detected platform ${OS}/${ARCH}"

  if [ -z "${WOOKY_SERVICE+x}" ]; then
    WOOKY_SERVICE="$(default_service_enabled "$OS")"
  fi

  TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t wooky-install)"
  trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

  # 2. Ensure Node 24 with node:sqlite
  NODE_BIN=""
  NODE_MANAGED=0
  ensure_node "$OS" "$ARCH" "$WOOKY_RUNTIME_DIR" "$TMP_DIR"
  NODE_BIN_DIR="$(dirname "$NODE_BIN")"

  # 3. Download, verify, and unpack Wooky release bundle
  if [ -n "${WOOKY_BUNDLE_URL:-}" ]; then
    BUNDLE_URL="$WOOKY_BUNDLE_URL"
    ASSET_NAME="$(basename "${BUNDLE_URL%%\?*}")"
    if [ -n "${WOOKY_SUMS_URL:-}" ]; then
      SUMS_URL="$WOOKY_SUMS_URL"
    else
      SUMS_URL="$(dirname "$BUNDLE_URL")/SHA256SUMS"
    fi
    if [ "$WOOKY_VERSION" = "latest" ]; then
      case "$ASSET_NAME" in
        wooky-*.tgz)
          RESOLVED_VERSION="${ASSET_NAME#wooky-}"
          RESOLVED_VERSION="${RESOLVED_VERSION%.tgz}"
          ;;
        *)
          RESOLVED_VERSION="local"
          ;;
      esac
    else
      RESOLVED_VERSION="${WOOKY_VERSION#v}"
    fi
  else
    RELEASE_TAG="$(resolve_release_tag "$WOOKY_REPO" "$WOOKY_VERSION")"
    RESOLVED_VERSION="${RELEASE_TAG#v}"
    ASSET_NAME="wooky-${RESOLVED_VERSION}.tgz"
    BUNDLE_URL="https://github.com/${WOOKY_REPO}/releases/download/${RELEASE_TAG}/${ASSET_NAME}"
    SUMS_URL="https://github.com/${WOOKY_REPO}/releases/download/${RELEASE_TAG}/SHA256SUMS"
  fi

  step_info "Downloading Wooky ${RESOLVED_VERSION} (${ASSET_NAME})..."
  BUNDLE_FILE="$TMP_DIR/$ASSET_NAME"
  SUMS_FILE="$TMP_DIR/SHA256SUMS"
  download_file "$BUNDLE_URL" "$BUNDLE_FILE"
  download_file "$SUMS_URL" "$SUMS_FILE"

  EXPECTED_HASH="$(parse_sha256sum "$ASSET_NAME" "$SUMS_FILE")" || {
    step_err "No SHA-256 entry for ${ASSET_NAME} in SHA256SUMS."
    exit 1
  }
  ACTUAL_HASH="$(compute_sha256 "$BUNDLE_FILE")"
  if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
    step_err "SHA-256 mismatch for ${ASSET_NAME} (expected ${EXPECTED_HASH}, got ${ACTUAL_HASH})."
    exit 1
  fi
  step_ok "Verified ${ASSET_NAME} (SHA-256)"

  VERSION_DIR="${WOOKY_PREFIX}/${RESOLVED_VERSION}"
  STAGE_DIR="${WOOKY_PREFIX}/.staging-${RESOLVED_VERSION}-$$"
  mkdir -p "$WOOKY_PREFIX"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  tar -xzf "$BUNDLE_FILE" -C "$STAGE_DIR"
  chmod +x "$STAGE_DIR/bin/wooky" 2>/dev/null || true

  if [ -f "$STAGE_DIR/package.json" ] && PATH="$NODE_BIN_DIR:$PATH" command -v npm >/dev/null 2>&1; then
    step_info "Installing native runtime dependencies..."
    if ! (cd "$STAGE_DIR" && PATH="$NODE_BIN_DIR:$PATH" npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1); then
      step_warn "Optional native module build failed (missing C++ build tools); terminal will use pipe mode."
    fi
    fix_node_pty_spawn_helpers "$STAGE_DIR"
  fi

  rm -rf "$VERSION_DIR"
  mv "$STAGE_DIR" "$VERSION_DIR"

  # Replace current symlink cleanly (ln -sfn works on BSD/macOS and GNU/Linux even when target is a dir).
  ln -sfn "$VERSION_DIR" "${WOOKY_PREFIX}/current"
  prune_old_versions "$WOOKY_PREFIX" "$RESOLVED_VERSION" 2
  step_ok "Installed Wooky ${RESOLVED_VERSION} into ${VERSION_DIR}"

  # 4. Install launcher into ~/.local/bin
  mkdir -p "$WOOKY_BIN_DIR"
  LAUNCHER="${WOOKY_BIN_DIR}/wooky"
  {
    printf '%s\n' '#!/bin/sh'
    printf '%s\n' 'set -eu'
    printf 'WOOKY_PREFIX="${WOOKY_PREFIX:-%s}"\n' "$WOOKY_PREFIX"
    printf 'export WOOKY_NODE="${WOOKY_NODE:-%s}"\n' "$NODE_BIN"
    printf '%s\n' 'exec "$WOOKY_PREFIX/current/bin/wooky" "$@"'
  } > "$LAUNCHER"
  chmod +x "$LAUNCHER"
  step_ok "Installed launcher at ${LAUNCHER}"

  case ":${PATH}:" in
    *":${WOOKY_BIN_DIR}:"*)
      ;;
    *)
      HINT_LINE="$(path_hint_line "$WOOKY_BIN_DIR" "${SHELL:-}")"
      RC_FILE="$(shell_rc_file "${SHELL:-}" "$HOME")"
      step_warn "${WOOKY_BIN_DIR} is not on your PATH."
      step_info "Add this line to ${RC_FILE}:"
      printf '    %s\n' "$HINT_LINE"
      if confirm_prompt "Append this line to ${RC_FILE}?"; then
        mkdir -p "$(dirname "$RC_FILE")"
        _rc_updated=0
        if [ ! -f "$RC_FILE" ] || ! grep -Fq "$HINT_LINE" "$RC_FILE"; then
          printf '\n# Added by Wooky installer\n%s\n' "$HINT_LINE" >> "$RC_FILE"
          _rc_updated=1
        fi
        if [ "$_rc_updated" = "1" ]; then
          step_ok "Updated ${RC_FILE}"
        fi
      fi
      ;;
  esac

  # 5. Optional background service
  if [ "$WOOKY_SERVICE" = "1" ]; then
    step_info "Configuring background service..."
    if PATH="${WOOKY_BIN_DIR}:${NODE_BIN_DIR}:${PATH}" WOOKY_HOME="$WOOKY_HOME" WOOKY_PREFIX="$WOOKY_PREFIX" WOOKY_BIN_DIR="$WOOKY_BIN_DIR" WOOKY_NODE="$NODE_BIN" "$LAUNCHER" service install; then
      step_ok "Background service installed and started"
    else
      step_warn "Background service setup failed; you can still run 'wooky' directly."
    fi
  fi

  # 6. Optional host pairing code
  if [ "$WOOKY_HOST" = "1" ]; then
    if "$LAUNCHER" --help 2>&1 | grep -q "pair"; then
      step_info "Printing host pairing code..."
      WOOKY_HOME="$WOOKY_HOME" "$LAUNCHER" pair --print || step_warn "wooky pair --print exited with an error."
    else
      step_info "Skipping 'wooky pair --print' (not available in this build yet)."
    fi
  fi

  # 7. Optional agent CLIs
  if [ -n "$WOOKY_AGENTS" ]; then
    install_agents "$WOOKY_AGENTS" "$WOOKY_HOME" "$WOOKY_BIN_DIR" "$NODE_BIN_DIR"
  fi

  # 8. Summary
  printf '\n%sWooky %s is ready.%s\n' "$C_BOLD" "$RESOLVED_VERSION" "$C_RESET"
  printf '  URL:        http://127.0.0.1:%s\n' "$WOOKY_PORT"
  printf '  Install:    %s/current\n' "$WOOKY_PREFIX"
  printf '  Launcher:   %s\n' "$LAUNCHER"
  printf '  Next steps:\n'
  if [ "$WOOKY_SERVICE" = "1" ]; then
    printf '    wooky service status   # check the background server\n'
  else
    printf '    wooky                  # start the server\n'
    printf '    wooky service install  # run automatically at login\n'
  fi
  printf '    wooky update           # upgrade to the latest release\n'
  printf '    wooky uninstall        # remove Wooky\n'
}

if [ "${WOOKY_INSTALL_LIB:-0}" != "1" ]; then
  main "$@"
fi
