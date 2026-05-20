#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
#  connect-vip.sh — Bridge DDEV ↔ Lando/VIP Dev Env networking
#
#  Connects the DDEV web container to the VIP dev-env proxy network
#  and injects an /etc/hosts override so that *.lndo.site hostnames
#  resolve to the proxy instead of 127.0.0.1.
#
#  Usage:
#    ./connect-vip.sh connect [hostname]   Connect to VIP env
#    ./connect-vip.sh disconnect           Tear down the bridge
#    ./connect-vip.sh status               Show current state
#    ./connect-vip.sh crawl <url> [opts]   Connect + run crawler
# ──────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Config ───────────────────────────────────────────────────────
DDEV_PROJECT="playwright-crawler"
DDEV_WEB="ddev-${DDEV_PROJECT}-web"
VIP_PROXY_PATTERN="vip-dev-env-proxy"          # matches container name
VIP_NETWORK="vip-dev-env-proxy_edge"           # the proxy's edge network
HOSTS_MARKER="# ddev-vip-bridge"               # used to identify our entries

# ── Helpers ──────────────────────────────────────────────────────
info()  { echo -e "  ${CYAN}ℹ${RESET}  $*"; }
ok()    { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()  { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
err()   { echo -e "  ${RED}✗${RESET}  $*"; }
header(){ echo -e "\n${BOLD}${CYAN}  ╔══════════════════════════════════════════╗${RESET}";
          echo -e "${BOLD}${CYAN}  ║   🔌  DDEV ↔ VIP Bridge Connector        ║${RESET}";
          echo -e "${BOLD}${CYAN}  ╚══════════════════════════════════════════╝${RESET}\n"; }

# ── Discovery ────────────────────────────────────────────────────
find_vip_proxy() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -i "${VIP_PROXY_PATTERN}" | head -1
}

get_proxy_ip() {
  local container="$1"
  docker inspect "$container" 2>/dev/null \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
nets = d[0]['NetworkSettings']['Networks']
# Prefer the edge network, fall back to any
for name in ['${VIP_NETWORK}', 'lando_bridge_network']:
    if name in nets and nets[name]['IPAddress']:
        print(nets[name]['IPAddress'])
        sys.exit(0)
# Fallback: first network with an IP
for name, v in nets.items():
    if v['IPAddress']:
        print(v['IPAddress'])
        sys.exit(0)
sys.exit(1)
" 2>/dev/null
}

get_proxy_network() {
  local container="$1"
  docker inspect "$container" 2>/dev/null \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
nets = d[0]['NetworkSettings']['Networks']
for name in ['${VIP_NETWORK}', 'lando_bridge_network']:
    if name in nets:
        print(name)
        sys.exit(0)
for name in nets:
    print(name)
    sys.exit(0)
sys.exit(1)
" 2>/dev/null
}

is_connected() {
  docker inspect "$DDEV_WEB" 2>/dev/null \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
nets = d[0]['NetworkSettings']['Networks']
if '${VIP_NETWORK}' in nets:
    print(nets['${VIP_NETWORK}']['IPAddress'])
    sys.exit(0)
sys.exit(1)
" 2>/dev/null
}

# Extract hostname from a URL
hostname_from_url() {
  echo "$1" | python3 -c "from urllib.parse import urlparse; import sys; print(urlparse(sys.stdin.read().strip()).hostname or '')" 2>/dev/null
}

# ── Commands ─────────────────────────────────────────────────────

cmd_connect() {
  local hostname="${1:-}"
  header

  # 1. Check DDEV is running
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${DDEV_WEB}$"; then
    err "DDEV container ${BOLD}${DDEV_WEB}${RESET} is not running."
    echo -e "     Run ${DIM}ddev start${RESET} first."
    exit 1
  fi
  ok "DDEV container ${BOLD}${DDEV_WEB}${RESET} is running"

  # 2. Find VIP proxy
  local proxy_container
  proxy_container=$(find_vip_proxy)
  if [[ -z "$proxy_container" ]]; then
    err "No VIP dev-env proxy container found."
    echo -e "     Make sure your VIP local environment is running."
    exit 1
  fi
  ok "VIP proxy found: ${BOLD}${proxy_container}${RESET}"

  # 3. Get proxy IP and network
  local proxy_ip proxy_network
  proxy_ip=$(get_proxy_ip "$proxy_container")
  proxy_network=$(get_proxy_network "$proxy_container")

  if [[ -z "$proxy_ip" || -z "$proxy_network" ]]; then
    err "Could not determine VIP proxy IP or network."
    exit 1
  fi
  ok "Proxy IP: ${BOLD}${proxy_ip}${RESET} on network ${BOLD}${proxy_network}${RESET}"

  # 4. Connect DDEV to VIP network (idempotent)
  local ddev_ip
  ddev_ip=$(is_connected 2>/dev/null || true)
  if [[ -n "$ddev_ip" ]]; then
    ok "Already connected to ${BOLD}${proxy_network}${RESET} (${ddev_ip})"
  else
    info "Connecting ${BOLD}${DDEV_WEB}${RESET} to ${BOLD}${proxy_network}${RESET}..."
    docker network connect "$proxy_network" "$DDEV_WEB"
    ok "Network bridge established"
  fi

  # 5. Inject /etc/hosts override
  if [[ -n "$hostname" ]]; then
    inject_hosts_entry "$proxy_ip" "$hostname"
  else
    # Auto-detect: grab all *.lndo.site hostnames from the proxy's config
    info "No hostname specified — scanning proxy for *.lndo.site vhosts..."
    local vhosts
    vhosts=$(docker exec "$proxy_container" sh -c 'cat /etc/nginx/conf.d/*.conf 2>/dev/null || cat /etc/traefik/*.yml 2>/dev/null || true' 2>/dev/null \
      | grep -oE '[a-zA-Z0-9._-]+\.lndo\.site' \
      | sort -u 2>/dev/null || true)

    if [[ -z "$vhosts" ]]; then
      warn "Could not auto-detect hostnames. Please provide one:"
      echo -e "     ${DIM}./connect-vip.sh connect my-site.vipdev.lndo.site${RESET}"
      return
    fi

    while IFS= read -r vhost; do
      inject_hosts_entry "$proxy_ip" "$vhost"
    done <<< "$vhosts"
  fi

  echo ""
  ok "${GREEN}${BOLD}Bridge is ready!${RESET} You can now crawl VIP local sites from DDEV."
  echo -e "     ${DIM}ddev exec node crawler.js \"https://<site>.lndo.site/...\" [options]${RESET}"
  echo ""
}

inject_hosts_entry() {
  local ip="$1"
  local host="$2"

  # Check if entry already exists (with correct IP)
  local existing
  existing=$(ddev exec "grep -c '${ip}.*${host}' /etc/hosts 2>/dev/null" 2>/dev/null || echo "0")
  existing=$(echo "$existing" | tr -d '[:space:]')

  if [[ "$existing" != "0" ]]; then
    ok "Hosts entry exists: ${BOLD}${host}${RESET} → ${ip}"
    return
  fi

  # Remove any stale entry for this hostname (different IP)
  ddev exec "sudo sed -i '/${host}.*${HOSTS_MARKER}/d' /etc/hosts" 2>/dev/null || true

  # Add new entry
  ddev exec "echo '${ip} ${host} ${HOSTS_MARKER}' | sudo tee -a /etc/hosts >/dev/null" 2>/dev/null
  ok "Hosts entry added: ${BOLD}${host}${RESET} → ${ip}"
}

cmd_disconnect() {
  header

  # 1. Remove /etc/hosts entries
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${DDEV_WEB}$"; then
    ddev exec "sudo sed -i '/${HOSTS_MARKER}/d' /etc/hosts" 2>/dev/null || true
    ok "Cleaned /etc/hosts entries"
  fi

  # 2. Disconnect from VIP network
  local ddev_ip
  ddev_ip=$(is_connected 2>/dev/null || true)
  if [[ -n "$ddev_ip" ]]; then
    docker network disconnect "$VIP_NETWORK" "$DDEV_WEB" 2>/dev/null || true
    ok "Disconnected from ${BOLD}${VIP_NETWORK}${RESET}"
  else
    info "Not connected to ${VIP_NETWORK} — nothing to do"
  fi

  echo ""
  ok "${GREEN}Bridge torn down.${RESET}"
  echo ""
}

cmd_status() {
  local test_host="${1:-}"
  header

  # DDEV
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${DDEV_WEB}$"; then
    ok "DDEV: ${BOLD}${DDEV_WEB}${RESET} is running"
  else
    err "DDEV: ${BOLD}${DDEV_WEB}${RESET} is NOT running"
  fi

  # VIP proxy
  local proxy_container
  proxy_container=$(find_vip_proxy)
  if [[ -n "$proxy_container" ]]; then
    local proxy_ip
    proxy_ip=$(get_proxy_ip "$proxy_container" 2>/dev/null || echo "unknown")
    ok "VIP proxy: ${BOLD}${proxy_container}${RESET} (${proxy_ip})"
  else
    err "VIP proxy: NOT running"
  fi

  # Network bridge
  local ddev_ip
  ddev_ip=$(is_connected 2>/dev/null || true)
  if [[ -n "$ddev_ip" ]]; then
    ok "Bridge: ${GREEN}CONNECTED${RESET} (DDEV IP on VIP network: ${ddev_ip})"
  else
    warn "Bridge: ${YELLOW}NOT CONNECTED${RESET}"
  fi

  # /etc/hosts entries
  local hosts_entries=""
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${DDEV_WEB}$"; then
    hosts_entries=$(ddev exec "grep '${HOSTS_MARKER}' /etc/hosts 2>/dev/null" 2>/dev/null || true)
    if [[ -n "$hosts_entries" ]]; then
      ok "DNS overrides:"
      echo "$hosts_entries" | while IFS= read -r line; do
        echo -e "     ${DIM}${line}${RESET}"
      done
    else
      warn "No DNS overrides in /etc/hosts"
    fi
  fi

  # Connectivity test
  if [[ -n "$ddev_ip" && -n "$proxy_container" ]]; then
    # Resolve the hostname to test: argument > hosts entry > prompt
    if [[ -z "$test_host" && -n "$hosts_entries" ]]; then
      test_host=$(echo "$hosts_entries" | head -1 | awk '{print $2}' | tr -d '[:space:]')
    fi

    if [[ -z "$test_host" ]]; then
      echo ""
      echo -ne "  ${CYAN}?${RESET}  Enter a hostname to test (e.g. ${DIM}my-site.vipdev.lndo.site${RESET}): "
      read -r test_host
    fi

    if [[ -n "$test_host" ]]; then
      # Strip protocol and path if a full URL was provided
      test_host=$(echo "$test_host" | python3 -c "
from urllib.parse import urlparse
import sys
raw = sys.stdin.read().strip()
parsed = urlparse(raw if '://' in raw else 'https://' + raw)
print(parsed.hostname or raw)
" 2>/dev/null || echo "$test_host")

      echo ""
      info "Testing connectivity to ${BOLD}${test_host}${RESET}..."
      local http_code
      http_code=$(ddev exec "curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 5 'https://${test_host}/' 2>/dev/null" 2>/dev/null || echo "000")
      http_code=$(echo "$http_code" | tr -d '[:space:]')
      if [[ "$http_code" != "000" ]]; then
        ok "Connectivity: ${GREEN}OK${RESET} (HTTP ${http_code})"
      else
        err "Connectivity: ${RED}FAILED${RESET} — DNS may not be overridden yet"
      fi
    else
      warn "Skipping connectivity test (no hostname provided)"
    fi
  fi

  echo ""
}

cmd_crawl() {
  local url="${1:-}"
  if [[ -z "$url" ]]; then
    err "Usage: ./connect-vip.sh crawl <url> [crawler options]"
    exit 1
  fi
  shift

  # Extract hostname and ensure bridge is up
  local hostname
  hostname=$(hostname_from_url "$url")
  if [[ -n "$hostname" && "$hostname" == *".lndo.site"* ]]; then
    cmd_connect "$hostname"
  else
    warn "URL does not look like a *.lndo.site address — connecting anyway"
    cmd_connect "${hostname:-}"
  fi

  echo -e "\n${BOLD}${CYAN}  🕷  Starting crawler...${RESET}\n"
  ddev exec node crawler.js "$url" "$@"
}

# ── Main ─────────────────────────────────────────────────────────
case "${1:-help}" in
  connect)
    shift
    cmd_connect "${1:-}"
    ;;
  disconnect)
    cmd_disconnect
    ;;
  status)
    shift
    cmd_status "${1:-}"
    ;;
  crawl)
    shift
    cmd_crawl "$@"
    ;;
  help|--help|-h|*)
    echo ""
    echo -e "${BOLD}Usage:${RESET}"
    echo -e "  ./connect-vip.sh ${GREEN}connect${RESET} [hostname]        Connect DDEV to VIP dev env"
    echo -e "  ./connect-vip.sh ${GREEN}disconnect${RESET}               Tear down the bridge"
    echo -e "  ./connect-vip.sh ${GREEN}status${RESET} [hostname|url]     Show connection state"
    echo -e "  ./connect-vip.sh ${GREEN}crawl${RESET} <url> [opts]       Connect + run crawler"
    echo ""
    echo -e "${BOLD}Examples:${RESET}"
    echo -e "  ${DIM}# Connect with auto-detected hostname${RESET}"
    echo -e "  ./connect-vip.sh connect"
    echo ""
    echo -e "  ${DIM}# Connect with explicit hostname${RESET}"
    echo -e "  ./connect-vip.sh connect my-site.vipdev.lndo.site"
    echo ""
    echo -e "  ${DIM}# One-liner: connect + crawl${RESET}"
    echo -e "  ./connect-vip.sh crawl \"https://my-site.vipdev.lndo.site/en-ca/insights\" --same-path --max-pages 100"
    echo ""
    echo -e "  ${DIM}# Check status (auto-detects hostname from /etc/hosts, or prompts)${RESET}"
    echo -e "  ./connect-vip.sh status"
    echo ""
    echo -e "  ${DIM}# Check status with explicit hostname or URL${RESET}"
    echo -e "  ./connect-vip.sh status my-site.vipdev.lndo.site"
    echo -e "  ./connect-vip.sh status https://my-site.vipdev.lndo.site/en-ca/insights"
    echo ""
    echo -e "  ${DIM}# Tear down${RESET}"
    echo -e "  ./connect-vip.sh disconnect"
    echo ""
    ;;
esac
