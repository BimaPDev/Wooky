#!/usr/bin/env bash
# Wooky Proxmox VE LXC helper script (run as root on a Proxmox VE host).
# Usage:
#   bash -c "$(curl -fsSL https://github.com/BimaPDev/Wooky/releases/latest/download/proxmox.sh)"
#
# Non-interactive env vars:
#   CTID, CT_HOSTNAME (default wooky), CORES (2), RAM (4096), DISK (16G),
#   STORAGE, TEMPLATE_STORAGE, BRIDGE (vmbr0), IP_CONFIG (dhcp or CIDR), GATEWAY,
#   TAILSCALE (0/1), WOOKY_REPO (BimaPDev/Wooky), WOOKY_VERSION (latest), WOOKY_AGENTS, WOOKY_YES=1
set -euo pipefail

# ── Pure helpers (sourced in tests when WOOKY_PROXMOX_LIB=1) ─────────────────

normalize_disk_gb() {
  local raw="${1:-16G}"
  raw="${raw%[Gg]}"
  if [[ ! "$raw" =~ ^[0-9]+$ ]] || [ "$raw" -lt 4 ]; then
    printf 'Invalid disk size "%s" (expected integer GB >= 4, e.g. 16 or 16G).\n' "${1:-}" >&2
    return 1
  fi
  printf '%s\n' "$raw"
}

build_net0_spec() {
  local bridge="${1:-vmbr0}"
  local ip_cfg="${2:-dhcp}"
  local gw="${3:-}"
  if [ "$ip_cfg" = "dhcp" ] || [ -z "$ip_cfg" ]; then
    printf 'name=eth0,bridge=%s,ip=dhcp\n' "$bridge"
    return 0
  fi
  if [ -n "$gw" ]; then
    printf 'name=eth0,bridge=%s,ip=%s,gw=%s\n' "$bridge" "$ip_cfg" "$gw"
  else
    printf 'name=eth0,bridge=%s,ip=%s\n' "$bridge" "$ip_cfg"
  fi
}

select_debian13_template() {
  # Reads `pveam available` output from stdin and picks the newest debian-13-standard template.
  awk '$2 ~ /^debian-13-standard_.*_amd64\.tar\./ { print $2 }' | sort -V | tail -n 1
}

parse_storage_list() {
  # Reads `pvesm status -content <type>` output from stdin and prints active storage names.
  awk 'NR > 1 && $3 == "active" { print $1 }'
}

# ── Output helpers ───────────────────────────────────────────────────────────

init_colors() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET=$'\033[0m'
    C_BOLD=$'\033[1m'
    C_DIM=$'\033[2m'
    C_GREEN=$'\033[32m'
    C_AMBER=$'\033[33m'
    C_RED=$'\033[31m'
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

# ── Interactive prompts (whiptail if present, else read) ─────────────────────

is_interactive() {
  if [ "${WOOKY_YES:-0}" = "1" ] || [ "${WOOKY_NONINTERACTIVE:-0}" = "1" ]; then
    return 1
  fi
  [ -t 0 ] && [ -t 1 ]
}

prompt_input() {
  local title="$1"
  local prompt="$2"
  local default="$3"
  local result=""
  if command -v whiptail >/dev/null 2>&1; then
    result="$(whiptail --title "$title" --inputbox "$prompt" 10 60 "$default" 3>&1 1>&2 2>&3)" || {
      step_err "Cancelled by user."
      exit 1
    }
  else
    printf '%s [%s]: ' "$prompt" "$default" >/dev/tty
    IFS= read -r result </dev/tty || result=""
  fi
  printf '%s\n' "${result:-$default}"
}

prompt_yesno() {
  local title="$1"
  local prompt="$2"
  local default_yes="${3:-0}"
  if command -v whiptail >/dev/null 2>&1; then
    if [ "$default_yes" = "1" ]; then
      whiptail --title "$title" --yesno "$prompt" 10 60 && return 0 || return 1
    else
      whiptail --title "$title" --defaultno --yesno "$prompt" 10 60 && return 0 || return 1
    fi
  fi
  local hint="[y/N]"
  [ "$default_yes" = "1" ] && hint="[Y/n]"
  printf '%s %s ' "$prompt" "$hint" >/dev/tty
  local ans=""
  IFS= read -r ans </dev/tty || ans=""
  if [ -z "$ans" ]; then
    [ "$default_yes" = "1" ]
    return
  fi
  case "$ans" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_menu() {
  local title="$1"
  local prompt="$2"
  shift 2
  local items=("$@")
  if [ "${#items[@]}" -eq 1 ]; then
    printf '%s\n' "${items[0]}"
    return 0
  fi
  if command -v whiptail >/dev/null 2>&1; then
    local menu_args=()
    local item
    for item in "${items[@]}"; do
      menu_args+=("$item" "storage")
    done
    local chosen
    chosen="$(whiptail --title "$title" --menu "$prompt" 14 60 6 "${menu_args[@]}" 3>&1 1>&2 2>&3)" || {
      step_err "Cancelled by user."
      exit 1
    }
    printf '%s\n' "$chosen"
    return 0
  fi
  printf '%s (%s) [%s]: ' "$prompt" "${items[*]}" "${items[0]}" >/dev/tty
  local ans=""
  IFS= read -r ans </dev/tty || ans=""
  printf '%s\n' "${ans:-${items[0]}}"
}

# ── Main flow ────────────────────────────────────────────────────────────────

main() {
  init_colors

  if [ "$(id -u)" -ne 0 ]; then
    step_err "This script must run as root on a Proxmox VE host."
    exit 1
  fi
  if ! command -v pveversion >/dev/null 2>&1; then
    step_err "pveversion not found. Run this script on a Proxmox VE host shell."
    exit 1
  fi
  step_ok "Detected Proxmox VE ($(pveversion))"

  local repo="${WOOKY_REPO:-BimaPDev/Wooky}"
  local version="${WOOKY_VERSION:-latest}"
  local agents="${WOOKY_AGENTS:-}"
  local default_ctid
  default_ctid="$(pvesh get /cluster/nextid 2>/dev/null || echo 200)"

  local storages=()
  while IFS= read -r s; do
    [ -n "$s" ] && storages+=("$s")
  done < <(pvesm status -content rootdir | parse_storage_list)
  if [ "${#storages[@]}" -eq 0 ]; then
    step_err "No active rootdir storage found in pvesm status -content rootdir."
    exit 1
  fi

  local tmpl_storages=()
  while IFS= read -r s; do
    [ -n "$s" ] && tmpl_storages+=("$s")
  done < <(pvesm status -content vztmpl | parse_storage_list)
  local template_storage="${TEMPLATE_STORAGE:-${tmpl_storages[0]:-local}}"

  local ctid="${CTID:-$default_ctid}"
  local ct_hostname="${CT_HOSTNAME:-wooky}"
  local cores="${CORES:-2}"
  local ram="${RAM:-4096}"
  local disk="${DISK:-16G}"
  local storage="${STORAGE:-${storages[0]}}"
  local bridge="${BRIDGE:-vmbr0}"
  local ip_config="${IP_CONFIG:-dhcp}"
  local gateway="${GATEWAY:-}"
  local tailscale="${TAILSCALE:-0}"

  if is_interactive; then
    ctid="$(prompt_input "Wooky LXC" "Container ID (CTID):" "$ctid")"
    ct_hostname="$(prompt_input "Wooky LXC" "Container hostname:" "$ct_hostname")"
    cores="$(prompt_input "Wooky LXC" "CPU cores:" "$cores")"
    ram="$(prompt_input "Wooky LXC" "Memory (MB):" "$ram")"
    disk="$(prompt_input "Wooky LXC" "Root disk size (e.g. 16G):" "$disk")"
    if [ -z "${STORAGE:-}" ]; then
      storage="$(prompt_menu "Wooky LXC" "Select rootfs storage:" "${storages[@]}")"
    fi
    bridge="$(prompt_input "Wooky LXC" "Network bridge:" "$bridge")"
    ip_config="$(prompt_input "Wooky LXC" "IPv4 address ('dhcp' or CIDR like 192.168.1.50/24):" "$ip_config")"
    if [ "$ip_config" != "dhcp" ]; then
      gateway="$(prompt_input "Wooky LXC" "IPv4 gateway (e.g. 192.168.1.1):" "$gateway")"
    fi
    if prompt_yesno "Wooky LXC" "Install Tailscale inside the container (passes through /dev/net/tun)?" "$tailscale"; then
      tailscale="1"
    else
      tailscale="0"
    fi
  fi

  local disk_gb
  disk_gb="$(normalize_disk_gb "$disk")"
  local net0_spec
  net0_spec="$(build_net0_spec "$bridge" "$ip_config" "$gateway")"

  # 1. Ensure Debian 13 standard template
  step_info "Updating Proxmox appliance list..."
  pveam update >/dev/null
  local template
  template="$(pveam available --section system | select_debian13_template)"
  if [ -z "$template" ]; then
    step_err "Could not find a debian-13-standard template in pveam available."
    exit 1
  fi
  if ! pveam list "$template_storage" 2>/dev/null | grep -Fq "$template"; then
    step_info "Downloading ${template} to ${template_storage}..."
    pveam download "$template_storage" "$template"
  fi
  step_ok "Template ready: ${template_storage}:vztmpl/${template}"

  # 2. Create unprivileged container with nesting + keyctl
  step_info "Creating unprivileged LXC container ${ctid} (${ct_hostname})..."
  pct create "$ctid" "${template_storage}:vztmpl/${template}" \
    --hostname "$ct_hostname" \
    --cores "$cores" \
    --memory "$ram" \
    --swap 512 \
    --rootfs "${storage}:${disk_gb}" \
    --net0 "$net0_spec" \
    --unprivileged 1 \
    --features "nesting=1,keyctl=1" \
    --onboot 1

  if [ "$tailscale" = "1" ]; then
    local conf_file="/etc/pve/lxc/${ctid}.conf"
    {
      printf 'lxc.cgroup2.devices.allow: c 10:200 rwm\n'
      printf 'lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file\n'
    } >> "$conf_file"
    step_ok "Configured /dev/net/tun passthrough in ${conf_file}"
  fi

  pct start "$ctid"
  step_ok "Started container ${ctid}"

  # Wait for container network
  step_info "Waiting for container network..."
  local tries=0
  while [ "$tries" -lt 30 ]; do
    if pct exec "$ctid" -- sh -c 'ip -4 addr show eth0 | grep -q "inet "' >/dev/null 2>&1; then
      break
    fi
    tries=$((tries + 1))
    sleep 1
  done

  # 3. Install base packages inside the container
  step_info "Installing prerequisites inside container ${ctid}..."
  pct exec "$ctid" -- bash -c 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates git build-essential python3 sudo dbus-user-session'
  step_ok "Installed prerequisites"

  # 4. Optional Tailscale
  if [ "$tailscale" = "1" ]; then
    step_info "Installing Tailscale inside container ${ctid}..."
    pct exec "$ctid" -- bash -c 'curl -fsSL https://tailscale.com/install.sh | sh'
    step_ok "Installed Tailscale (finish setup with: pct exec ${ctid} -- tailscale up)"
  fi

  # 5. Create non-root user `wooky` and run install.sh
  step_info "Creating user 'wooky' and running Wooky installer..."
  pct exec "$ctid" -- bash -c '
    if ! id -u wooky >/dev/null 2>&1; then
      useradd -m -s /bin/bash wooky
    fi
    loginctl enable-linger wooky >/dev/null 2>&1 || true
  '

  local install_url
  if [ "$version" = "latest" ]; then
    install_url="https://github.com/${repo}/releases/latest/download/install.sh"
  else
    local tag="v${version#v}"
    install_url="https://github.com/${repo}/releases/download/${tag}/install.sh"
  fi

  local install_output
  install_output="$(
    pct exec "$ctid" -- su - wooky -c "
      set -eu
      export XDG_RUNTIME_DIR=\"/run/user/\$(id -u)\"
      export DBUS_SESSION_BUS_ADDRESS=\"unix:path=\${XDG_RUNTIME_DIR}/bus\"
      export WOOKY_REPO='${repo}'
      export WOOKY_VERSION='${version}'
      export WOOKY_AGENTS='${agents}'
      export WOOKY_SERVICE=1
      export WOOKY_HOST=1
      export WOOKY_YES=1
      curl -fsSL '${install_url}' | bash
    "
  )"
  printf '%s\n' "$install_output"
  step_ok "Installed Wooky inside container ${ctid}"

  # 6. Summary
  local ct_ip
  ct_ip="$(pct exec "$ctid" -- sh -c "hostname -I | awk '{print \$1}'" 2>/dev/null || echo "<container-ip>")"
  local pair_line
  pair_line="$(printf '%s\n' "$install_output" | grep -Ei 'pair|code' | tail -n 1 || true)"

  printf '\n%sWooky Proxmox LXC %s is ready.%s\n' "$C_BOLD" "$ctid" "$C_RESET"
  printf '  Container ID:  %s (%s)\n' "$ctid" "$ct_hostname"
  printf '  Container IP:  %s\n' "$ct_ip"
  printf '  Wooky URL:     http://%s:4317\n' "$ct_ip"
  if [ -n "$pair_line" ]; then
    printf '  Pairing:       %s\n' "$pair_line"
  else
    printf '  Pairing:       run `pct exec %s -- su - wooky -c "wooky pair --print"` once pairing is enabled\n' "$ctid"
  fi
  if [ "$tailscale" = "1" ]; then
    printf '  Tailscale:     run `pct exec %s -- tailscale up` to join your tailnet\n' "$ctid"
  fi
  printf '  Shell access:  pct enter %s\n' "$ctid"
}

if [ "${WOOKY_PROXMOX_LIB:-0}" != "1" ]; then
  main "$@"
fi
