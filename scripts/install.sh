#!/usr/bin/env bash
# xPanel Bootstrap Installer & Dry-Run Verifier
# Distribution package plans (live installation qualification is still required):
#   - Ubuntu 22.04 LTS (jammy) & Ubuntu 24.04 LTS (noble) via apt-get
#   - CentOS Stream 9/10, AlmaLinux 9, Rocky Linux 9 via dnf
set -euo pipefail

DRY_RUN=0
OS_RELEASE_FILE="${XPANEL_OS_RELEASE:-/etc/os-release}"
ENGINE="apache"
PHP_VERSION="8.3"
APACHE_MPM=""
WITH_MAIL=0
WITH_DNS=0
WITH_FTP=0
WITH_MARIADB=0
WITH_MODSECURITY=0
INSTALL_ROOT="/opt/xpanel"
INSTALL_JOURNAL="/var/lib/xpanel/install-journal.json"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PINNED_NODE_VERSION="$(tr -d '\r\n' < "$SCRIPT_DIR/../.node-version")"
NODE_BIN="${XPANEL_NODE_BIN:-/usr/bin/node}"
AGENT_GID="ALLOCATED_AT_INSTALL"
BACKUP_STAMP="$(date -u +%Y%m%dT%H%M%SZ).$$"

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    --os-release=*)
      OS_RELEASE_FILE="${arg#*=}"
      ;;
    --engine=*)
      ENGINE="${arg#*=}"
      ;;
    --php=*)
      PHP_VERSION="${arg#*=}"
      ;;
    --apache-mpm=*)
      APACHE_MPM="${arg#*=}"
      ;;
    --with-mail)
      WITH_MAIL=1
      ;;
    --without-mail)
      WITH_MAIL=0
      ;;
    --with-dns)
      WITH_DNS=1
      ;;
    --without-dns)
      WITH_DNS=0
      ;;
    --with-ftp)
      WITH_FTP=1
      ;;
    --without-ftp)
      WITH_FTP=0
      ;;
    --with-mariadb)
      WITH_MARIADB=1
      ;;
    --without-mariadb)
      WITH_MARIADB=0
      ;;
    --with-modsecurity)
      WITH_MODSECURITY=1
      ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--os-release=/etc/os-release] [--engine=apache|openlitespeed] [--php=8.3] [--apache-mpm=itk|prefork] [--with-mail] [--with-dns] [--with-ftp] [--with-mariadb] [--with-modsecurity]"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$OS_RELEASE_FILE" ]]; then
  echo "ERROR: OS release file not found at $OS_RELEASE_FILE" >&2
  exit 1
fi

if [[ ! "$PINNED_NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: .node-version must contain one exact stable Node version." >&2
  exit 1
fi

# Parse os-release safely without executing arbitrary shell code
OS_ID=""
OS_VERSION_ID=""
OS_PRETTY_NAME=""
OS_CODENAME=""
while IFS='=' read -r k v; do
  v="${v%\"}"
  v="${v#\"}"
  case "$k" in
    ID) OS_ID="$v" ;;
    VERSION_ID) OS_VERSION_ID="$v" ;;
    PRETTY_NAME) OS_PRETTY_NAME="$v" ;;
    VERSION_CODENAME) OS_CODENAME="$v" ;;
  esac
done < <(grep -E '^(ID|VERSION_ID|PRETTY_NAME|VERSION_CODENAME)=' "$OS_RELEASE_FILE" || true)

OS_FAMILY=""
PKG_MGR=""
OS_MAJOR="${OS_VERSION_ID%%.*}"

case "$OS_ID" in
  ubuntu)
    if [[ "$OS_VERSION_ID" != "22.04" && "$OS_VERSION_ID" != "24.04" ]]; then
      echo "ERROR: Unsupported Ubuntu version '$OS_VERSION_ID' (supported: 22.04, 24.04)" >&2
      exit 1
    fi
    OS_FAMILY="debian"
    PKG_MGR="apt-get"
    [[ -z "$APACHE_MPM" ]] && APACHE_MPM="itk"
    ;;
  centos|almalinux|rocky)
    if [[ "$OS_MAJOR" != "9" && "$OS_MAJOR" != "10" ]]; then
      echo "ERROR: Unsupported Enterprise Linux version '$OS_VERSION_ID' for '$OS_ID' (supported: 9, 10)" >&2
      exit 1
    fi
    OS_FAMILY="rhel"
    PKG_MGR="dnf"
    [[ -z "$APACHE_MPM" ]] && APACHE_MPM="prefork"
    ;;
  *)
    echo "ERROR: Unsupported distribution ID='$OS_ID' VERSION_ID='$OS_VERSION_ID'" >&2
    exit 1
    ;;
esac

PHP_COMPACT="${PHP_VERSION//./}"
if [[ "$OS_FAMILY" == "debian" ]]; then
  PACKAGES=(
    nginx
    apache2
    libapache2-mpm-itk
    apache2-suexec-custom
    libapache2-mod-fcgid
    postgresql
    redis-server
    openssh-server
    nftables
    quota
    certbot
    "php${PHP_VERSION}-fpm"
    "php${PHP_VERSION}-cli"
    "php${PHP_VERSION}-common"
    "php${PHP_VERSION}-mysql"
    "php${PHP_VERSION}-pgsql"
    "php${PHP_VERSION}-gd"
    "php${PHP_VERSION}-mbstring"
    "php${PHP_VERSION}-xml"
    "php${PHP_VERSION}-intl"
    "php${PHP_VERSION}-bcmath"
    "php${PHP_VERSION}-soap"
    "php${PHP_VERSION}-opcache"
    "php${PHP_VERSION}-zip"
  )
  [[ "$WITH_MARIADB" -eq 1 ]] && PACKAGES+=(mariadb-server)
  [[ "$WITH_MAIL" -eq 1 ]] && PACKAGES+=(postfix dovecot-imapd dovecot-pop3d dovecot-lmtpd dovecot-sieve)
  [[ "$WITH_DNS" -eq 1 ]] && PACKAGES+=(pdns-server pdns-backend-pgsql)
  [[ "$WITH_FTP" -eq 1 ]] && PACKAGES+=(pure-ftpd)
  [[ "$WITH_MODSECURITY" -eq 1 ]] && PACKAGES+=(libapache2-mod-security2 modsecurity-crs)
else
  REDIS_PKG="redis"
  if [[ "$OS_MAJOR" -ge 10 ]]; then
    REDIS_PKG="valkey"
  fi
  PACKAGES=(
    nginx
    httpd
    mod_ssl
    mod_fcgid
    php-fpm
    "php${PHP_COMPACT}-php-fpm"
    "php${PHP_COMPACT}-php-cli"
    "php${PHP_COMPACT}-php-common"
    "php${PHP_COMPACT}-php-mysqlnd"
    "php${PHP_COMPACT}-php-pdo"
    "php${PHP_COMPACT}-php-gd"
    "php${PHP_COMPACT}-php-mbstring"
    "php${PHP_COMPACT}-php-xml"
    "php${PHP_COMPACT}-php-intl"
    "php${PHP_COMPACT}-php-bcmath"
    "php${PHP_COMPACT}-php-soap"
    "php${PHP_COMPACT}-php-opcache"
    "php${PHP_COMPACT}-php-pecl-zip"
    postgresql-server
    "$REDIS_PKG"
    openssh-server
    nftables
    quota
    certbot
  )
  [[ "$WITH_MARIADB" -eq 1 ]] && PACKAGES+=(mariadb-server)
  [[ "$WITH_MAIL" -eq 1 ]] && PACKAGES+=(postfix dovecot dovecot-pigeonhole)
  [[ "$WITH_DNS" -eq 1 ]] && PACKAGES+=(pdns pdns-backend-postgresql)
  [[ "$WITH_FTP" -eq 1 ]] && PACKAGES+=(pure-ftpd)
  [[ "$WITH_MODSECURITY" -eq 1 ]] && PACKAGES+=(mod_security mod_security_crs)
fi

if [[ "$OS_FAMILY" == "rhel" && "$APACHE_MPM" == "itk" ]]; then
  PACKAGES+=(httpd-itk)
fi

XPANEL_DIRS=(
  "/var/lib/xpanel/state"
  "/var/lib/xpanel/generations"
  "/var/log/xpanel"
  "/etc/xpanel/userdata"
  "/etc/xpanel"
  "/run/xpanel"
  "/opt/xpanel/bin"
)

SYSCTL_CONF="/etc/sysctl.d/99-xpanel-symlink-protection.conf"
JAILSHELL_BIN="/opt/xpanel/bin/jailshell"
JAILSHELL_LINK="/usr/local/bin/xpanel-jailshell"
SLICE_UNIT="/etc/systemd/system/xpanel.slice"
AGENT_UNIT="/etc/systemd/system/xpanel-agent.service"
API_UNIT="/etc/systemd/system/xpanel-api.service"
RUNTIME_ENV="/etc/xpanel/runtime.env"
API_ENV="/etc/xpanel/api.env"
TMPFILES_CONF="/etc/tmpfiles.d/xpanel.conf"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

assert_root_owned_path() {
  local path="$1" mode
  while true; do
    [[ -d "$path" && ! -L "$path" ]] || die "Trusted directory is missing or symbolic: $path"
    [[ "$(stat -c %u -- "$path")" == 0 ]] || die "Trusted directory is not root-owned: $path"
    mode="$(stat -c %a -- "$path")"
    (( (8#$mode & 0022) == 0 )) || die "Trusted directory is writable by a non-root identity: $path"
    [[ "$path" != "/" ]] || break
    path="$(dirname -- "$path")"
  done
}

assert_root_file() {
  local path="$1" mode
  [[ -f "$path" && ! -L "$path" ]] || die "Trusted regular file is missing or symbolic: $path"
  [[ "$(stat -c %u -- "$path")" == 0 ]] || die "Trusted file is not root-owned: $path"
  mode="$(stat -c %a -- "$path")"
  (( (8#$mode & 06022) == 0 )) || die "Trusted file is writable by a non-root identity or has set-ID bits: $path"
  assert_root_owned_path "$(dirname -- "$path")"
}

assert_pinned_runtime() {
  [[ "$NODE_BIN" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "XPANEL_NODE_BIN must be an absolute executable path safe for systemd."
  assert_root_file "$NODE_BIN"
  [[ -x "$NODE_BIN" ]] || die "The pinned Node executable is not executable."
  [[ "$("$NODE_BIN" --version)" == "v$PINNED_NODE_VERSION" ]] || die "Install the verified Node $PINNED_NODE_VERSION runtime before provisioning."
  for file in .node-version package.json apps/api/src/main.ts apps/agent/src/main.ts; do
    assert_root_file "$INSTALL_ROOT/$file"
  done
  [[ "$(tr -d '\r\n' < "$INSTALL_ROOT/.node-version")" == "$PINNED_NODE_VERSION" ]] || die "Installer and installed artifact runtime pins differ."
  [[ -d "$INSTALL_ROOT/node_modules" ]] || die "Install the artifact's locked workspace dependencies before provisioning."
}

assert_cgroup_and_quota_preflight() {
  [[ -f /sys/fs/cgroup/cgroup.controllers ]] || die "cgroup v2 unified hierarchy (/sys/fs/cgroup/cgroup.controllers) is required."
  local controllers controller
  controllers="$(< /sys/fs/cgroup/cgroup.controllers)"
  for controller in cpu memory io pids; do
    [[ " $controllers " == *" $controller "* ]] || die "Missing required cgroup v2 controller: $controller"
  done
}

record_install_phase() {
  local phase="$1" status="$2"
  if [[ -d /var/lib/xpanel ]]; then
    "$NODE_BIN" --input-type=module - "$INSTALL_JOURNAL" "$phase" "$status" "$OS_ID" "$OS_VERSION_ID" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const [journalPath, phase, status, osId, osVersionId] = process.argv.slice(2)
const now = new Date().toISOString()
let state = { schemaVersion: 1, startedAt: now, updatedAt: now, osId, osVersionId, completedPhases: [], lastFailedPhase: null, entries: [] }
if (existsSync(journalPath)) {
  try { state = JSON.parse(readFileSync(journalPath, 'utf8')) } catch {}
}
state.updatedAt = now
state.entries.push({ phase, status, at: now })
if (status === 'completed' && !state.completedPhases.includes(phase)) state.completedPhases.push(phase)
if (status === 'failed') state.lastFailedPhase = phase
writeFileSync(journalPath, JSON.stringify(state, null, 2) + '\n', { mode: 0o640 })
NODE
  fi
}

backup_config() {
  local target="$1"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ ! -e "$target.bak.$BACKUP_STAMP" && ! -L "$target.bak.$BACKUP_STAMP" ]] || die "Backup target already exists."
    cp -a -- "$target" "$target.bak.$BACKUP_STAMP"
  fi
}

write_config() {
  local target="$1" renderer="$2" mode="${3:-0644}" group="${4:-root}" temporary
  assert_root_owned_path "$(dirname -- "$target")"
  if [[ -e "$target" || -L "$target" ]]; then assert_root_file "$target"; fi
  backup_config "$target"
  temporary="$(mktemp "$target.tmp.XXXXXXXX")"
  if ! "$renderer" > "$temporary"; then rm -f -- "$temporary"; die "Cannot render $target"; fi
  chown "root:$group" "$temporary"
  chmod "$mode" "$temporary"
  mv -fT -- "$temporary" "$target"
}

provision_credential() {
  local target="$1"
  assert_root_owned_path "$(dirname -- "$target")"
  if [[ -e "$target" || -L "$target" ]]; then
    assert_root_file "$target"
    [[ "$(stat -c %g -- "$target")" == "$(getent group xpanel | cut -d: -f3)" ]] || die "Credential has an unexpected reader group: $target"
    "$NODE_BIN" --input-type=module - "$target" <<'NODE'
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs'
const fd = openSync(process.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW)
try {
  const st = fstatSync(fd)
  if (!st.isFile() || st.uid !== 0 || (st.mode & 0o7777) !== 0o640 || st.size > 65 || !/^[a-f0-9]{64}\n?$/.test(readFileSync(fd, 'utf8'))) throw new Error('Invalid shared credential: root:xpanel mode 0640 is required for the API reader')
} finally { closeSync(fd) }
NODE
    return
  fi
  # The protected parent is not writable by API or tenant identities. Noclobber preserves existing credentials.
  (umask 0077; set -o noclobber; "$NODE_BIN" --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex") + "\n")' > "$target")
  chown root:xpanel "$target"
  chmod 0640 "$target"
}

render_runtime_env() {
  cat <<EOF
XPANEL_AGENT_GID=$AGENT_GID
XPANEL_DB_PATH=/var/lib/xpanel/control.db
XPANEL_STATE_DIR=/var/lib/xpanel/state
XPANEL_AGENT_SOCKET=/run/xpanel/agent.sock
XPANEL_AGENT_TOKEN_FILE=/etc/xpanel/agent.token
EOF
}

render_api_env() {
  cat <<'EOF'
# Configure the exact HTTPS browser origins before allowing cookie WebSocket upgrades.
XPANEL_ALLOWED_ORIGINS=
# Forwarded client addresses are ignored unless the immediate proxy is listed here.
XPANEL_TRUSTED_PROXIES=
XPANEL_HOST=127.0.0.1
XPANEL_PORT=2087
XPANEL_SERVER_SECRET_FILE=/etc/xpanel/server.secret
EOF
}

render_tmpfiles_conf() {
  printf 'd /run/xpanel 0750 root xpanel-agent -\n'
}

assert_service_groups() {
  local group gid members username _password uid user_gid _rest member
  local -a declared_members=()
  for group in xpanel xpanel-agent; do
    gid="$(getent group "$group" | cut -d: -f3)"
    [[ "$gid" =~ ^[1-9][0-9]*$ ]] || die "Service group must have a non-root numeric GID: $group"
    members="$(getent group "$group" | cut -d: -f4)"
    IFS=',' read -r -a declared_members <<< "$members"
    for member in "${declared_members[@]}"; do
      [[ -z "$member" || "$member" == xpanel || "$member" == root ]] || die "Unexpected member in private service group: $group"
    done
    while IFS=: read -r username _password uid user_gid _rest; do
      if [[ "$user_gid" == "$gid" && "$username" != xpanel && "$uid" != 0 ]]; then
        die "A tenant or other identity uses the private service group: $group"
      fi
    done < <(getent passwd)
  done
}

render_sysctl_conf() {
  cat <<'EOF'
# Generated by xPanel: kernel symlink, hardlink, FIFO, and ptrace isolation.
fs.protected_symlinks = 1
fs.protected_hardlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
kernel.yama.ptrace_scope = 2
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
EOF
}

render_jailshell() {
  cat <<'EOF'
#!/bin/sh
# Generated by xPanel: isolated jailed shell wrapper for account logins.
set -eu
umask 0027
if [ "$(id -u)" -lt 20000 ] || [ "$(id -u)" -gt 60000 ]; then
  echo "xPanel jailshell: account UID must be in 20000..60000" >&2
  exit 1
fi
case "${HOME:-}" in
  /home/*|/home[0-9]*/*) ;;
  *) echo "xPanel jailshell: invalid HOME" >&2; exit 1 ;;
esac
if [ -L "$HOME" ]; then
  echo "xPanel jailshell: account root is a symlink; refusing login" >&2
  exit 1
fi
export TMPDIR="$HOME/tmp"
export TMP="$HOME/tmp"
export TEMP="$HOME/tmp"
export PATH="/usr/local/bin:/usr/bin:/bin"
cd "$HOME"
exec /bin/bash --norc --noprofile --restricted "$@"
EOF
}

render_xpanel_slice() {
  cat <<'EOF'
# Generated by xPanel: parent cgroup v2 slice for all tenant account slices (xpanel-<uid>.slice)
[Unit]
Description=xPanel Multi-Tenant Account Hierarchy Slice
Documentation=man:systemd.resource-control(5)
Before=slices.target

[Slice]
CPUAccounting=yes
MemoryAccounting=yes
IOAccounting=yes
TasksAccounting=yes
EOF
}

render_agent_service() {
  # systemd owns RuntimeDirectory using User=/Group= before service commands.
  # Keep IPC as the primary group; setgid data directories retain the API group.
  cat <<EOF
[Unit]
Description=xPanel Privileged Host Reconciler & Isolation Agent
After=network-online.target systemd-sysctl.service systemd-tmpfiles-setup.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=xpanel-agent
SupplementaryGroups=xpanel
RuntimeDirectory=xpanel
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=no
WorkingDirectory=/opt/xpanel
Environment=NODE_ENV=production
EnvironmentFile=/etc/xpanel/runtime.env
Environment=XPANEL_GENERATIONS_DIR=/var/lib/xpanel/generations
Environment=XPANEL_LOG_DIR=/var/log/xpanel
Environment=XPANEL_RUN_DIR=/run/xpanel
ExecStartPre=/usr/bin/test -f /var/lib/xpanel/control.db
ExecStart=$NODE_BIN --max-old-space-size=64 /opt/xpanel/apps/agent/src/main.ts
Restart=always
RestartSec=2
UMask=0007

[Install]
WantedBy=multi-user.target
EOF
}

render_api_service() {
  cat <<EOF
[Unit]
Description=xPanel Control Plane API & Web Panel (:2087)
After=network-online.target xpanel-agent.service
Requires=xpanel-agent.service

[Service]
Type=simple
User=xpanel
Group=xpanel
SupplementaryGroups=xpanel-agent
WorkingDirectory=/opt/xpanel
Environment=NODE_ENV=production
EnvironmentFile=/etc/xpanel/runtime.env
EnvironmentFile=/etc/xpanel/api.env
ExecStart=$NODE_BIN --max-old-space-size=96 /opt/xpanel/apps/api/src/main.ts
Restart=always
RestartSec=2
UMask=0007
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/xpanel /var/log/xpanel
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "=== xPanel Installer Dry-Run ==="
  echo "Rendering only; package availability, services and host permissions are not certified."
  echo "Detected OS       : ${OS_PRETTY_NAME:-$OS_ID $OS_VERSION_ID} (id=${OS_ID}, version=${OS_VERSION_ID}, family=${OS_FAMILY})"
  echo "Package Manager   : ${PKG_MGR}"
  echo "Required Node     : ${PINNED_NODE_VERSION} (preinstalled, checksum-verified artifact runtime)"
  echo "Web Engine        : ${ENGINE} (Apache MPM=${APACHE_MPM})"
  if [[ "$ENGINE" != apache || "$APACHE_MPM" != itk ]]; then
    echo "Production preflight rejects this engine/MPM plan; Apache itk is required."
  fi
  echo "PHP Version       : ${PHP_VERSION}"
  echo "Package List      : ${PACKAGES[*]}"
  echo ""
  echo "--- Directory Layout ---"
  echo "chmod 0711 root:root /home"
  for dir in "${XPANEL_DIRS[@]}"; do
    echo "mkdir -p $dir"
  done
  echo "root:xpanel-agent 0750 /run/xpanel"
  echo "xpanel:xpanel 2770 /var/lib/xpanel; shared control.db mode 0660 for API and agent only"
  echo "root:xpanel 0750 /etc/xpanel; preserve-or-create agent.token and server.secret at 0640 (values never printed)"
  echo "--- Runtime Environment ($RUNTIME_ENV) ---"
  render_runtime_env
  echo "--- API Environment ($API_ENV; existing operator settings preserved) ---"
  render_api_env
  echo ""
  echo "--- Kernel Symlink & Hardlink Protection ($SYSCTL_CONF) ---"
  render_sysctl_conf
  echo ""
  echo "--- Jailed Shell Wrapper ($JAILSHELL_BIN -> $JAILSHELL_LINK) ---"
  echo "install -m 0755 root:root $JAILSHELL_BIN"
  echo ""
  echo "--- Systemd cgroup v2 Slice Hierarchy ($SLICE_UNIT & xpanel-<uid>.slice) ---"
  render_xpanel_slice
  echo ""
  echo "--- Systemd Service Units ($AGENT_UNIT, $API_UNIT) ---"
  render_agent_service
  echo ""
  render_api_service
  echo "=== Dry-Run Complete (no host files mutated) ==="
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: xPanel installer must be run as root (or pass --dry-run)." >&2
  exit 1
fi

[[ "$(uname -s)" == "Linux" ]] || die "Provisioning requires Linux; dry-run is portable."
[[ "$ENGINE" == "apache" && "$APACHE_MPM" == "itk" ]] || die "This provisioner requires Apache itk; no shared-identity fallback is permitted."
command -v runuser > /dev/null || die "runuser is required for unprivileged schema initialization."
command -v systemctl > /dev/null || die "systemd is required for service provisioning."
[[ -d /run/systemd/system ]] || die "A running systemd instance is required for provisioning."
assert_pinned_runtime
assert_cgroup_and_quota_preflight
if systemctl is-active --quiet xpanel-api.service || systemctl is-active --quiet xpanel-agent.service; then
  die "Stop the existing xPanel services before changing provisioning; no live reconfiguration is attempted."
fi
if [[ -e /var/lib/xpanel/control.db || -L /var/lib/xpanel/control.db ]]; then
  [[ -f /var/lib/xpanel/control.db && ! -L /var/lib/xpanel/control.db ]] || die "control.db must be a regular file."
  [[ "$(stat -c %U:%G:%a /var/lib/xpanel/control.db)" == "xpanel:xpanel:660" ]] || die "Existing control.db ownership/mode requires an explicit reviewed repair."
fi
for directory in /home /var/lib/xpanel "${XPANEL_DIRS[@]}"; do
  [[ ! -L "$directory" ]] || die "Managed directory is symbolic: $directory"
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" ]] || die "Managed directory path is not a directory: $directory"
    stat -c 'Provisioning metadata before change: %n uid=%u gid=%g mode=%a' -- "$directory"
  fi
done

echo "[1/6] Creating xPanel directories and locking down /home to 0711 (root:root)..."
getent group xpanel > /dev/null || groupadd --system xpanel
getent group xpanel-agent > /dev/null || groupadd --system xpanel-agent
if ! id xpanel > /dev/null 2>&1; then
  useradd --system --gid xpanel --groups xpanel-agent --home-dir /var/lib/xpanel --shell /usr/sbin/nologin xpanel
fi
[[ "$(id -gn xpanel)" == "xpanel" && "$(id -u xpanel)" -ne 0 ]] || die "Existing xpanel identity has incompatible privileges."
[[ "$(getent passwd xpanel | cut -d: -f6)" == /var/lib/xpanel ]] || die "The xpanel service identity has an unexpected home directory."
case "$(getent passwd xpanel | cut -d: -f7)" in
  /sbin/nologin|/usr/sbin/nologin) ;;
  *) die "The xpanel service identity must have a non-login shell." ;;
esac
assert_service_groups
usermod -a -G xpanel-agent xpanel
AGENT_GID="$(getent group xpanel-agent | cut -d: -f3)"
[[ "$AGENT_GID" =~ ^[1-9][0-9]*$ ]] || die "Dedicated agent group must have a positive numeric GID."
mkdir -p /home
chown root:root /home
chmod 0711 /home

install -d -o xpanel -g xpanel -m 2770 /var/lib/xpanel
install -d -o xpanel -g xpanel -m 2750 /var/lib/xpanel/state /var/lib/xpanel/generations /var/log/xpanel
install -d -o root -g xpanel -m 0750 /etc/xpanel
install -d -o root -g root -m 0750 /etc/xpanel/userdata
install -d -o root -g xpanel-agent -m 0750 /run/xpanel
install -d -o root -g root -m 0755 /opt/xpanel/bin
provision_credential /etc/xpanel/agent.token
provision_credential /etc/xpanel/server.secret
write_config "$RUNTIME_ENV" render_runtime_env 0640 xpanel
if [[ ! -e "$API_ENV" && ! -L "$API_ENV" ]]; then
  write_config "$API_ENV" render_api_env 0640 xpanel
else
  assert_root_file "$API_ENV"
  [[ "$(stat -c %G -- "$API_ENV")" == xpanel && "$(stat -c %a -- "$API_ENV")" =~ ^(600|640)$ ]] || die "Existing api.env must be root:xpanel with mode 0600 or 0640."
fi

echo "[2/6] Installing packages via ${PKG_MGR}..."
if [[ "$OS_FAMILY" == "debian" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  export NEEDRESTART_MODE=l
  apt-get update -y
  apt-get install -y --no-install-recommends software-properties-common ca-certificates curl gnupg
  add-apt-repository -y -n universe
  add-apt-repository -y -n ppa:ondrej/php
  apt-get update -y
  apt-get install -y --no-install-recommends "${PACKAGES[@]}"
else
  dnf install -y --setopt=install_weak_deps=False dnf-plugins-core
  dnf config-manager --set-enabled crb
  if [[ "$OS_ID" == "centos" ]]; then
    dnf install -y "https://dl.fedoraproject.org/pub/epel/epel-release-latest-${OS_MAJOR}.noarch.rpm"
  else
    dnf install -y epel-release
  fi
  dnf install -y "https://rpms.remirepo.net/enterprise/remi-release-${OS_MAJOR}.rpm"
  dnf install -y --setopt=install_weak_deps=False "${PACKAGES[@]}"
fi

echo "[3/6] Installing xpanel-jailshell at ${JAILSHELL_BIN}..."
write_config "$JAILSHELL_BIN" render_jailshell 0755
backup_config "$JAILSHELL_LINK"
assert_root_owned_path "$(dirname -- "$JAILSHELL_LINK")"
ln -sfnT "$JAILSHELL_BIN" "$JAILSHELL_LINK"
if ! grep -qxF "$JAILSHELL_BIN" /etc/shells 2>/dev/null; then
  if [[ -e /etc/shells || -L /etc/shells ]]; then assert_root_file /etc/shells; fi
  backup_config /etc/shells
  echo "$JAILSHELL_BIN" >> /etc/shells
fi

echo "[4/6] Applying kernel symlink & hardlink protection (${SYSCTL_CONF})..."
write_config "$SYSCTL_CONF" render_sysctl_conf
sysctl -p "$SYSCTL_CONF"

echo "[5/6] Writing systemd slice and service units..."
write_config "$SLICE_UNIT" render_xpanel_slice
write_config "$AGENT_UNIT" render_agent_service
write_config "$API_UNIT" render_api_service
write_config "$TMPFILES_CONF" render_tmpfiles_conf

# Initialize the database under the API identity before the root daemon opens it.
# SQLite WAL/SHM sidecars inherit the database's group-readable/writable mode.
(umask 0007; runuser -u xpanel -- env XPANEL_DB_PATH=/var/lib/xpanel/control.db XPANEL_STATE_DIR=/var/lib/xpanel/state "$NODE_BIN" /opt/xpanel/apps/api/src/main.ts status > /dev/null)
chmod 0660 /var/lib/xpanel/control.db

echo "[6/6] Reloading systemd daemon and enabling services..."
systemctl daemon-reload
systemctl enable xpanel.slice xpanel-agent.service xpanel-api.service
echo "xPanel installation complete."
echo "Services are enabled but not started. Provision the root identity locally via reset-password --password-stdin, configure HTTPS origins, then enroll root MFA before administrative use."
echo "Live installation, reboot, tenant isolation and restore qualification remain required."
