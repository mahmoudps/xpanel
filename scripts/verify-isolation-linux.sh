#!/usr/bin/env bash
# Disposable-VM kernel primitives. This does not start Apache/PHP or test live firewall traffic.
set -euo pipefail

if [[ "${XPANEL_TEST_DISPOSABLE_VM:-}" != "I_ACCEPT_DESTRUCTIVE_TESTS_IN_THIS_DISPOSABLE_VM" ]]; then
  echo "BLOCKED: explicit disposable-VM acknowledgement is required; no host state changed." >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" || ! -d /run/systemd/system ]]; then
  echo "BLOCKED: run only inside a disposable native Linux VM booted with systemd." >&2
  exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "BLOCKED: root inside the disposable VM is required; no sudo is invoked." >&2
  exit 2
fi

PROOF_ROOT="/tmp/xpanel-live-proof"
HOME_BASE="${PROOF_ROOT}/home"
ALICE_USER="xpalice"
ALICE_UID=29101
ALICE_HOME="${HOME_BASE}/${ALICE_USER}"
BOB_USER="xpbob"
BOB_UID=29102
BOB_HOME="${HOME_BASE}/${BOB_USER}"
CGROUP_SLICE="/sys/fs/cgroup/xpanel-${ALICE_UID}.slice"

for command_name in getent groupadd useradd userdel groupdel setpriv sysctl nft; do
  command -v "$command_name" >/dev/null || { echo "BLOCKED: missing $command_name" >&2; exit 2; }
done
for fixture_identity in "$ALICE_USER" "$BOB_USER" "$ALICE_UID" "$BOB_UID"; do
  if getent passwd "$fixture_identity" >/dev/null || getent group "$fixture_identity" >/dev/null; then
    echo "BLOCKED: existing identity $fixture_identity must never be deleted by this fixture." >&2
    exit 2
  fi
done
for fixture_path in "$PROOF_ROOT" "$CGROUP_SLICE"; do
  if [[ -e "$fixture_path" || -L "$fixture_path" ]]; then
    echo "BLOCKED: existing path $fixture_path must never be removed by this fixture." >&2
    exit 2
  fi
done
ALICE_CREATED=0
BOB_CREATED=0
ALICE_GROUP_CREATED=0
BOB_GROUP_CREATED=0
PROOF_ROOT_CREATED=0
CGROUP_CREATED=0

cleanup() {
  set +e
  if [[ "$CGROUP_CREATED" == 1 ]]; then
    rmdir "$CGROUP_SLICE" 2>/dev/null || true
  fi
  if [[ "$ALICE_CREATED" == 1 ]]; then
    userdel -f "$ALICE_USER" 2>/dev/null || true
  fi
  if [[ "$ALICE_GROUP_CREATED" == 1 ]]; then
    groupdel "$ALICE_USER" 2>/dev/null || true
  fi
  if [[ "$BOB_CREATED" == 1 ]]; then
    userdel -f "$BOB_USER" 2>/dev/null || true
  fi
  if [[ "$BOB_GROUP_CREATED" == 1 ]]; then
    groupdel "$BOB_USER" 2>/dev/null || true
  fi
  if [[ "$PROOF_ROOT_CREATED" == 1 ]]; then
    rm -rf "$PROOF_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== [1/4] Home Directory (0711/0750) & Kernel Symlink/Hardlink Isolation ==="
mkdir "$PROOF_ROOT"
PROOF_ROOT_CREATED=1
mkdir -p "$HOME_BASE"
chown root:root "$HOME_BASE"
chmod 0711 "$HOME_BASE"

groupadd -g "$ALICE_UID" "$ALICE_USER"
ALICE_GROUP_CREATED=1
useradd -M -d "$ALICE_HOME" -u "$ALICE_UID" -g "$ALICE_UID" -s /usr/sbin/nologin "$ALICE_USER"
ALICE_CREATED=1
mkdir -p "$ALICE_HOME"
chown "${ALICE_UID}:${ALICE_UID}" "$ALICE_HOME"
chmod 0750 "$ALICE_HOME"

groupadd -g "$BOB_UID" "$BOB_USER"
BOB_GROUP_CREATED=1
useradd -M -d "$BOB_HOME" -u "$BOB_UID" -g "$BOB_UID" -s /usr/sbin/nologin "$BOB_USER"
BOB_CREATED=1
mkdir -p "$BOB_HOME"
chown "${BOB_UID}:${BOB_UID}" "$BOB_HOME"
chmod 0750 "$BOB_HOME"

SECRET_FILE="${BOB_HOME}/secret.txt"
echo "TOP_SECRET_BOB_DATABASE_PASSWORD" > "$SECRET_FILE"
chown "${BOB_UID}:${BOB_UID}" "$SECRET_FILE"
chmod 0640 "$SECRET_FILE"

HOME_BASE_MODE="$(stat -c '%a' "$HOME_BASE")"
ALICE_HOME_MODE="$(stat -c '%a' "$ALICE_HOME")"
BOB_HOME_MODE="$(stat -c '%a' "$BOB_HOME")"
SECRET_MODE="$(stat -c '%a' "$SECRET_FILE")"

if [[ "$HOME_BASE_MODE" != "711" ]]; then
  echo "FAIL: expected $HOME_BASE mode 711, got $HOME_BASE_MODE" >&2
  exit 1
fi
if [[ "$ALICE_HOME_MODE" != "750" || "$BOB_HOME_MODE" != "750" ]]; then
  echo "FAIL: expected account homes mode 750, got alice=$ALICE_HOME_MODE bob=$BOB_HOME_MODE" >&2
  exit 1
fi

# Prove xpalice cannot list /tmp/xpanel-live-proof/home (0711 root:root)
set +e
LIST_HOME_BASE_ERR="$(setpriv --reuid="$ALICE_UID" --regid="$ALICE_UID" --clear-groups -- ls -la "$HOME_BASE" 2>&1)"
LIST_HOME_BASE_RC=$?
# Prove xpalice cannot list xpbob's 0750 home directory
LIST_BOB_HOME_ERR="$(setpriv --reuid="$ALICE_UID" --regid="$ALICE_UID" --clear-groups -- ls -la "$BOB_HOME" 2>&1)"
LIST_BOB_HOME_RC=$?
# Prove xpalice cannot read xpbob's 0640 secret file
READ_BOB_SECRET_ERR="$(setpriv --reuid="$ALICE_UID" --regid="$ALICE_UID" --clear-groups -- cat "$SECRET_FILE" 2>&1)"
READ_BOB_SECRET_RC=$?
set -e

if [[ "$LIST_HOME_BASE_RC" -eq 0 ]]; then
  echo "FAIL: xpalice was able to list 0711 home base!" >&2
  exit 1
fi
if [[ "$LIST_BOB_HOME_RC" -eq 0 || "$LIST_BOB_HOME_ERR" == *"TOP_SECRET"* ]]; then
  echo "FAIL: xpalice was able to list xpbob home!" >&2
  exit 1
fi
if [[ "$READ_BOB_SECRET_RC" -eq 0 || "$READ_BOB_SECRET_ERR" == *"TOP_SECRET"* ]]; then
  echo "FAIL: xpalice was able to read xpbob secret file!" >&2
  exit 1
fi
if [[ "$LIST_BOB_HOME_ERR" != *"Permission denied"* || "$READ_BOB_SECRET_ERR" != *"Permission denied"* ]]; then
  echo "FAIL: expected Permission denied (EACCES), got: $READ_BOB_SECRET_ERR" >&2
  exit 1
fi

# Verify kernel symlink and hardlink protection
PROTECTED_SYMLINKS="$(sysctl -n fs.protected_symlinks)"
PROTECTED_HARDLINKS="$(sysctl -n fs.protected_hardlinks)"
if [[ "$PROTECTED_SYMLINKS" != "1" || "$PROTECTED_HARDLINKS" != "1" ]]; then
  echo "FAIL: kernel symlink/hardlink protection not active" >&2
  exit 1
fi

echo "PASS: Home isolation verified (0711 base, 0750 homes, EACCES: Permission denied, protected_symlinks=1, protected_hardlinks=1)"

echo "=== [2/4] Configuration text and setpriv probe identity (no service request) ==="
VHOST_CONF="${PROOF_ROOT}/xpanel-site-xpalice.conf"
cat > "$VHOST_CONF" <<EOF
# Managed by xPanel: xpalice.example.com (account ${ALICE_USER})
<VirtualHost 127.0.0.1:8080>
    ServerName xpalice.example.com
    DocumentRoot "${ALICE_HOME}/public_html"
    AssignUserID ${ALICE_USER} ${ALICE_USER}
    AssignUserId ${ALICE_USER} ${ALICE_USER}
    <Directory "${ALICE_HOME}/public_html">
        AllowOverride All
        Options -Indexes +SymLinksIfOwnerMatch
        Require all granted
    </Directory>
    <FilesMatch "\.php$">
        SetHandler "proxy:unix:/run/xpanel/php-fpm/${ALICE_USER}-8.3.sock|fcgi://localhost"
    </FilesMatch>
</VirtualHost>
EOF

FPM_POOL_CONF="${PROOF_ROOT}/xpalice-fpm-pool.conf"
cat > "$FPM_POOL_CONF" <<EOF
[${ALICE_USER}]
user = ${ALICE_USER}
group = ${ALICE_USER}
listen = /run/xpanel/php-fpm/${ALICE_USER}-8.3.sock
listen.owner = ${ALICE_USER}
listen.group = ${ALICE_USER}
listen.mode = 0660
pm = ondemand
pm.max_children = 8
chdir = ${ALICE_HOME}
php_admin_value[open_basedir] = "${ALICE_HOME}:/tmp"
EOF

grep -q "AssignUserID ${ALICE_USER} ${ALICE_USER}" "$VHOST_CONF"
grep -q "^user = ${ALICE_USER}$" "$FPM_POOL_CONF"
grep -q "^group = ${ALICE_USER}$" "$FPM_POOL_CONF"

WORKER_UID="$(setpriv --reuid="$ALICE_UID" --regid="$ALICE_UID" --clear-groups -- id -u)"
WORKER_GID="$(setpriv --reuid="$ALICE_UID" --regid="$ALICE_UID" --clear-groups -- id -g)"
WORKER_USER="$(setpriv --reuid="$ALICE_UID" --regid="$ALICE_UID" --clear-groups -- id -un)"
if [[ "$WORKER_UID" != "$ALICE_UID" || "$WORKER_GID" != "$ALICE_UID" || "$WORKER_USER" != "$ALICE_USER" ]]; then
  echo "FAIL: worker process identity mismatch: uid=$WORKER_UID gid=$WORKER_GID user=$WORKER_USER" >&2
  exit 1
fi
echo "PASS: setpriv probe identity verified (uid=${WORKER_UID}, gid=${WORKER_GID}, user=${WORKER_USER}); Apache/PHP workload not run"

echo "=== [3/4] cgroup v2 Slice & Plan Resource Limits (memory.max, pids.max, io.max) ==="
if [[ ! -f /sys/fs/cgroup/cgroup.controllers ]]; then
  echo "FAIL: cgroup v2 unified hierarchy not mounted at /sys/fs/cgroup" >&2
  exit 1
fi

CGROUP_CONTROLLERS="$(cat /sys/fs/cgroup/cgroup.subtree_control)"
for ctrl in memory pids io; do
  if [[ " $CGROUP_CONTROLLERS " != *" $ctrl "* ]]; then
    echo "BLOCKED: the disposable VM must provision enabled ${ctrl} controller before the fixture." >&2
    exit 2
  fi
done

mkdir "$CGROUP_SLICE"
CGROUP_CREATED=1

PLAN_MEMORY_BYTES=$((1024 * 1024 * 1024)) # 1024 MiB = 1073741824
PLAN_PIDS_MAX=64
PLAN_RBPS=50000000
PLAN_WBPS=50000000
PLAN_RIOPS=2000
PLAN_WIOPS=2000

echo "$PLAN_MEMORY_BYTES" > "${CGROUP_SLICE}/memory.max"
echo "$PLAN_PIDS_MAX" > "${CGROUP_SLICE}/pids.max"

# Find primary block device major:minor for io.max
BLK_MAJ_MIN=""
for devdir in /sys/block/sd* /sys/block/nvme* /sys/block/vd*; do
  if [[ -f "${devdir}/dev" ]]; then
    CAND="$(cat "${devdir}/dev")"
    if echo "${CAND} rbps=${PLAN_RBPS} wbps=${PLAN_WBPS} riops=${PLAN_RIOPS} wiops=${PLAN_WIOPS}" > "${CGROUP_SLICE}/io.max" 2>/dev/null; then
      BLK_MAJ_MIN="$CAND"
      break
    fi
  fi
done

ACTUAL_MEMORY_MAX="$(cat "${CGROUP_SLICE}/memory.max")"
ACTUAL_PIDS_MAX="$(cat "${CGROUP_SLICE}/pids.max")"
ACTUAL_IO_MAX="$(cat "${CGROUP_SLICE}/io.max")"

if [[ "$ACTUAL_MEMORY_MAX" != "$PLAN_MEMORY_BYTES" ]]; then
  echo "FAIL: cgroup v2 memory.max mismatch: expected $PLAN_MEMORY_BYTES, got $ACTUAL_MEMORY_MAX" >&2
  exit 1
fi
if [[ "$ACTUAL_PIDS_MAX" != "$PLAN_PIDS_MAX" ]]; then
  echo "FAIL: cgroup v2 pids.max mismatch: expected $PLAN_PIDS_MAX, got $ACTUAL_PIDS_MAX" >&2
  exit 1
fi
if [[ -z "$BLK_MAJ_MIN" || "$ACTUAL_IO_MAX" != *"rbps=${PLAN_RBPS}"* || "$ACTUAL_IO_MAX" != *"wbps=${PLAN_WBPS}"* ]]; then
  echo "FAIL: cgroup v2 io.max mismatch: got $ACTUAL_IO_MAX" >&2
  exit 1
fi

echo "PASS: cgroup v2 slice verified (memory.max=${ACTUAL_MEMORY_MAX}, pids.max=${ACTUAL_PIDS_MAX}, io.max='${ACTUAL_IO_MAX}')"

echo "=== [4/4] Firewall configuration syntax (no rules applied or traffic probes) ==="
NFT_CONF="${PROOF_ROOT}/nftables.conf"
cat > "$NFT_CONF" <<'EOF'
#!/usr/sbin/nft -f
table inet xpanel
delete table inet xpanel

table inet xpanel {
  chain input {
    type filter hook input priority filter; policy drop;
    iif "lo" accept
    ct state invalid drop
    ct state established,related accept
    tcp dport { 8080, 8443 } drop comment "xpanel: backend is loopback-only"
    tcp dport 2087 accept comment "xpanel: panel"
    tcp dport 22 accept comment "xpanel: ssh"
    tcp dport 80 accept comment "xpanel: http"
    tcp dport 443 accept comment "xpanel: https"
  }
}
EOF

grep -q 'iif "lo" accept' "$NFT_CONF"
grep -q 'tcp dport { 8080, 8443 } drop comment "xpanel: backend is loopback-only"' "$NFT_CONF"
grep -q 'tcp dport 2087 accept' "$NFT_CONF"
grep -q 'tcp dport 22 accept' "$NFT_CONF"
grep -q 'tcp dport 80 accept' "$NFT_CONF"
grep -q 'tcp dport 443 accept' "$NFT_CONF"

nft -c -f "$NFT_CONF"

echo "PASS: nftables syntax checked; live backend-port traffic isolation not run"

CLEAN_ERR="${READ_BOB_SECRET_ERR//$'\n'/ }"
CLEAN_ERR="${CLEAN_ERR//\"/\'}"
CLEAN_IO="${ACTUAL_IO_MAX//$'\n'/ }"
CLEAN_IO="${CLEAN_IO//\"/\'}"
cat <<EOF
XPANEL_PROOF_JSON={"ok":true,"scope":"kernel-primitives-and-firewall-syntax","homeBaseMode":"${HOME_BASE_MODE}","aliceHomeMode":"${ALICE_HOME_MODE}","bobHomeMode":"${BOB_HOME_MODE}","secretMode":"${SECRET_MODE}","bobSecretReadError":"${CLEAN_ERR}","protectedSymlinks":${PROTECTED_SYMLINKS},"protectedHardlinks":${PROTECTED_HARDLINKS},"workerUid":${WORKER_UID},"workerGid":${WORKER_GID},"workerUser":"${WORKER_USER}","cgroupMemoryMax":${ACTUAL_MEMORY_MAX},"cgroupPidsMax":${ACTUAL_PIDS_MAX},"cgroupIoMax":"${CLEAN_IO}","firewallSyntaxChecked":true,"workloadIsolation":"not_run","backendTrafficIsolation":"not_run"}
EOF
