#!/usr/bin/env bash
# Prepare qualification tools only. This is not the xPanel installer.
set -euo pipefail
umask 0022

LAB_ROOT=/opt/xpanel-lab
LAB_NODE_VERSION="${XPANEL_LAB_NODE_VERSION:?Set the verified .node-version pin}"
LAB_PNPM_VERSION="${XPANEL_LAB_PNPM_VERSION:?Set the verified packageManager pin}"
LAB_HOST_ACK="${XPANEL_LAB_HOST_ACK:?Acknowledge the experimental hostname}"
LAB_STAMP="$(date -u +%Y%m%dT%H%M%SZ).$$"
POLICY_PATH=/usr/sbin/policy-rc.d
POLICY_BACKUP=
POLICY_GUARD_HASH=
POLICY_INSTALLED=0

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

trusted_directory() {
  local path="$1" mode
  [[ -d "$path" && ! -L "$path" && "$(stat -c %u "$path")" == 0 ]] || die "Untrusted lab directory: $path"
  mode="$(stat -c %a "$path")"
  (( (8#$mode & 0022) == 0 )) || die "Group/other writable lab directory: $path"
}

safe_download_target() {
  [[ ! -L "$1" && ( ! -e "$1" || ( -f "$1" && "$(stat -c %u "$1")" == 0 ) ) ]] || die 'An existing download target requires review.'
}

[[ "$(id -u)" == 0 && "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die 'The acknowledged lab must be root Linux x86_64.'
[[ "$(hostname)" == "$LAB_HOST_ACK" ]] || die 'The experimental hostname acknowledgement does not match.'
[[ "$LAB_NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$LAB_PNPM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Exact stable tool versions are required.'
[[ "$(cat /proc/1/comm)" == systemd && "$(stat -fc %T /sys/fs/cgroup)" == cgroup2fs ]] || die 'A booted systemd VM with cgroup v2 is required.'
grep -qw memory /sys/fs/cgroup/cgroup.controllers || die 'The memory controller is unavailable.'
grep -qw pids /sys/fs/cgroup/cgroup.controllers || die 'The pids controller is unavailable.'
[[ ! -e /opt/xpanel && ! -e /var/lib/xpanel ]] || die 'Production panel paths exist; no lab provisioning is permitted.'
trusted_directory /
trusted_directory /opt
for directory in "$LAB_ROOT" "$LAB_ROOT/bin" "$LAB_ROOT/toolchains" "$LAB_ROOT/downloads" "$LAB_ROOT/evidence" "$LAB_ROOT/private"; do
  if [[ -e "$directory" || -L "$directory" ]]; then trusted_directory "$directory"; fi
done

# Refuse an OS mismatch before package or runtime changes. Do not source os-release.
grep -qx 'ID=ubuntu' /etc/os-release || die 'This qualification bootstrap currently targets Ubuntu only.'
grep -Eq '^VERSION_ID="?24\.04"?$' /etc/os-release || die 'This qualification bootstrap currently targets Ubuntu 24.04.'
command -v flock > /dev/null || die 'flock is required to serialize lab provisioning.'
exec 9>/run/lock/xpanel-lab-bootstrap.lock
flock -n 9 || die 'Another lab bootstrap is active.'

install -d -o root -g root -m 0755 "$LAB_ROOT" "$LAB_ROOT/bin" "$LAB_ROOT/toolchains" "$LAB_ROOT/downloads" "$LAB_ROOT/evidence"
install -d -o root -g root -m 0700 "$LAB_ROOT/private"
LAB_PRIVATE="$LAB_ROOT/private/bootstrap-$LAB_STAMP"
install -d -o root -g root -m 0700 "$LAB_PRIVATE"
LAB_PUBLIC="$LAB_ROOT/evidence/bootstrap-$LAB_STAMP.json"

listener_snapshot() { ss -H -lntup | awk '{print $1 " " $5}' | LC_ALL=C sort -u; }
listener_snapshot > "$LAB_PRIVATE/listeners-before.txt"
systemctl list-units --type=service --state=running --no-legend --no-pager > "$LAB_PRIVATE/services-before.txt"
apt-cache policy ca-certificates curl xz-utils coreutils passwd util-linux quota e2fsprogs build-essential nginx apache2 libapache2-mpm-itk php-fpm mariadb-server > "$LAB_PRIVATE/apt-policy-before.txt"

restore_policy() {
  if [[ "$POLICY_INSTALLED" != 1 ]]; then return; fi
  [[ -f "$POLICY_PATH" && ! -L "$POLICY_PATH" ]] || { printf 'ERROR: Temporary autostart policy changed unexpectedly.\n' >&2; return 1; }
  [[ "$(sha256sum "$POLICY_PATH" | cut -d' ' -f1)" == "$POLICY_GUARD_HASH" ]] || { printf 'ERROR: Refusing to overwrite a changed autostart policy.\n' >&2; return 1; }
  if [[ -n "$POLICY_BACKUP" ]]; then
    cp -a -- "$POLICY_BACKUP" "$POLICY_PATH.restore.$LAB_STAMP"
    mv -fT -- "$POLICY_PATH.restore.$LAB_STAMP" "$POLICY_PATH"
  else
    rm -f -- /usr/sbin/policy-rc.d
  fi
  POLICY_INSTALLED=0
}
trap restore_policy EXIT

if [[ -e "$POLICY_PATH" || -L "$POLICY_PATH" ]]; then
  [[ -f "$POLICY_PATH" && ! -L "$POLICY_PATH" && "$(stat -c %u "$POLICY_PATH")" == 0 ]] || die 'Existing package autostart policy requires review.'
  POLICY_BACKUP="$POLICY_PATH.bak.$LAB_STAMP"
  [[ ! -e "$POLICY_BACKUP" ]] || die 'Package-policy backup already exists.'
  cp -a -- "$POLICY_PATH" "$POLICY_BACKUP"
fi
POLICY_TEMP="$(mktemp /usr/sbin/policy-rc.d.xpanel.XXXXXXXX)"
printf '#!/bin/sh\n# Temporary xPanel lab tool preparation: do not start package services.\nexit 101\n' > "$POLICY_TEMP"
chown root:root "$POLICY_TEMP"
chmod 0755 "$POLICY_TEMP"
mv -fT -- "$POLICY_TEMP" "$POLICY_PATH"
POLICY_GUARD_HASH="$(sha256sum "$POLICY_PATH" | cut -d' ' -f1)"
POLICY_INSTALLED=1

# Existing signed Ubuntu repositories only. No PPA, service daemon, firewall or SSH change.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
apt-get -o DPkg::Lock::Timeout=120 update < /dev/null > "$LAB_PRIVATE/apt-update.txt" 2>&1
apt-cache policy ca-certificates curl xz-utils coreutils passwd util-linux quota e2fsprogs build-essential nginx apache2 libapache2-mpm-itk php-fpm mariadb-server > "$LAB_PRIVATE/apt-policy-candidates.txt"
apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends ca-certificates curl xz-utils coreutils passwd util-linux quota e2fsprogs build-essential < /dev/null > "$LAB_PRIVATE/apt-install.txt" 2>&1
restore_policy

NODE_ARCHIVE="node-v$LAB_NODE_VERSION-linux-x64.tar.xz"
NODE_DOWNLOAD="$LAB_ROOT/downloads/$NODE_ARCHIVE"
NODE_CHECKSUMS="$LAB_ROOT/downloads/node-v$LAB_NODE_VERSION-SHASUMS256.txt"
NODE_SOURCE="https://nodejs.org/dist/v$LAB_NODE_VERSION"
safe_download_target "$NODE_CHECKSUMS"
safe_download_target "$NODE_DOWNLOAD"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$NODE_SOURCE/SHASUMS256.txt" -o "$NODE_CHECKSUMS"
NODE_EXPECTED_SHA="$(awk -v name="$NODE_ARCHIVE" '$2 == name {print $1}' "$NODE_CHECKSUMS")"
[[ "$NODE_EXPECTED_SHA" =~ ^[a-f0-9]{64}$ ]] || die 'The official Node checksum entry is missing.'
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$NODE_SOURCE/$NODE_ARCHIVE" -o "$NODE_DOWNLOAD"
[[ "$(sha256sum "$NODE_DOWNLOAD" | cut -d' ' -f1)" == "$NODE_EXPECTED_SHA" ]] || die 'The Node archive checksum does not match the official release.'
NODE_DIRECTORY="$LAB_ROOT/toolchains/node-v$LAB_NODE_VERSION-linux-x64"
if [[ ! -e "$NODE_DIRECTORY" ]]; then
  NODE_STAGE="$(mktemp -d "$LAB_ROOT/toolchains/node-stage.XXXXXXXX")"
  tar -xJf "$NODE_DOWNLOAD" --no-same-owner --no-same-permissions -C "$NODE_STAGE"
  mv -- "$NODE_STAGE/node-v$LAB_NODE_VERSION-linux-x64" "$NODE_DIRECTORY"
  rmdir -- "$NODE_STAGE"
fi
[[ -d "$NODE_DIRECTORY" && ! -L "$NODE_DIRECTORY" && -x "$NODE_DIRECTORY/bin/node" && ! -L "$NODE_DIRECTORY/bin/node" ]] || die 'The Node toolchain directory is invalid.'
trusted_directory "$NODE_DIRECTORY"
trusted_directory "$NODE_DIRECTORY/bin"
NODE_BINARY_SHA="$(tar -xJOf "$NODE_DOWNLOAD" "node-v$LAB_NODE_VERSION-linux-x64/bin/node" | sha256sum | cut -d' ' -f1)"
[[ "$(sha256sum "$NODE_DIRECTORY/bin/node" | cut -d' ' -f1)" == "$NODE_BINARY_SHA" ]] || die 'The installed Node binary differs from the verified archive.'
[[ "$("$NODE_DIRECTORY/bin/node" --version)" == "v$LAB_NODE_VERSION" ]] || die 'The provisioned Node version differs from the pin.'

PNPM_METADATA="$LAB_ROOT/downloads/pnpm-linux-x64-$LAB_PNPM_VERSION.json"
PNPM_ARCHIVE="$LAB_ROOT/downloads/pnpm-linux-x64-$LAB_PNPM_VERSION.tgz"
PNPM_METADATA_SOURCE="https://registry.npmjs.org/@pnpm%2fexe.linux-x64/$LAB_PNPM_VERSION"
safe_download_target "$PNPM_METADATA"
safe_download_target "$PNPM_ARCHIVE"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$PNPM_METADATA_SOURCE" -o "$PNPM_METADATA"
PNPM_TARBALL="$("$NODE_DIRECTORY/bin/node" --input-type=module - "$PNPM_METADATA" "$LAB_PNPM_VERSION" <<'NODE'
import { readFileSync } from 'node:fs'
const metadata = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (metadata.name !== '@pnpm/exe.linux-x64' || metadata.version !== process.argv[3] || metadata.license !== 'MIT' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(metadata.dist?.integrity ?? '')) throw new Error('Unexpected pnpm metadata')
const target = new URL(metadata.dist.tarball)
if (target.protocol !== 'https:' || target.hostname !== 'registry.npmjs.org' || target.username || target.password) throw new Error('Unexpected pnpm release origin')
process.stdout.write(target.href)
NODE
)"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$PNPM_TARBALL" -o "$PNPM_ARCHIVE"
"$NODE_DIRECTORY/bin/node" --input-type=module - "$PNPM_METADATA" "$PNPM_ARCHIVE" <<'NODE'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const metadata = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const actual = 'sha512-' + createHash('sha512').update(readFileSync(process.argv[3])).digest('base64')
if (actual !== metadata.dist.integrity) throw new Error('pnpm release integrity mismatch')
NODE
PNPM_DIRECTORY="$LAB_ROOT/toolchains/pnpm-$LAB_PNPM_VERSION"
if [[ ! -e "$PNPM_DIRECTORY" ]]; then
  PNPM_STAGE="$(mktemp -d "$LAB_ROOT/toolchains/pnpm-stage.XXXXXXXX")"
  tar -xzf "$PNPM_ARCHIVE" --no-same-owner --no-same-permissions --strip-components=1 -C "$PNPM_STAGE"
  chmod 0755 "$PNPM_STAGE"
  mv -- "$PNPM_STAGE" "$PNPM_DIRECTORY"
fi
PNPM_EXECUTABLE="$PNPM_DIRECTORY/pnpm"
[[ -f "$PNPM_EXECUTABLE" && ! -L "$PNPM_EXECUTABLE" && -x "$PNPM_EXECUTABLE" ]] || die 'The verified pnpm native executable is missing.'
trusted_directory "$PNPM_DIRECTORY"
PNPM_BINARY_SHA="$(tar -xzOf "$PNPM_ARCHIVE" package/pnpm | sha256sum | cut -d' ' -f1)"
[[ "$(sha256sum "$PNPM_EXECUTABLE" | cut -d' ' -f1)" == "$PNPM_BINARY_SHA" ]] || die 'The installed pnpm binary differs from the verified archive.'
[[ "$("$PNPM_EXECUTABLE" --version)" == "$LAB_PNPM_VERSION" ]] || die 'The provisioned pnpm version differs from the pin.'

for pair in "node:$NODE_DIRECTORY/bin/node" "pnpm:$PNPM_EXECUTABLE"; do
  name="${pair%%:*}"
  target="${pair#*:}"
  if [[ -e "$LAB_ROOT/bin/$name" || -L "$LAB_ROOT/bin/$name" ]]; then
    [[ -L "$LAB_ROOT/bin/$name" && "$(readlink "$LAB_ROOT/bin/$name")" == "$target" ]] || die 'An unrelated lab executable already exists.'
  else
    ln -s -- "$target" "$LAB_ROOT/bin/$name"
  fi
done

listener_snapshot > "$LAB_PRIVATE/listeners-after.txt"
cmp --silent "$LAB_PRIVATE/listeners-before.txt" "$LAB_PRIVATE/listeners-after.txt" || die 'Listener inventory changed during tool provisioning; inspect the private evidence.'
systemctl list-units --type=service --state=running --no-legend --no-pager > "$LAB_PRIVATE/services-after.txt"
dpkg-query -W -f='${binary:Package}\t${Version}\n' ca-certificates curl xz-utils coreutils passwd util-linux quota e2fsprogs build-essential > "$LAB_PRIVATE/packages-installed.tsv"

"$NODE_DIRECTORY/bin/node" --input-type=module - "$LAB_ROOT" "$LAB_PRIVATE" "$LAB_PUBLIC" "$LAB_NODE_VERSION" "$LAB_PNPM_VERSION" "$NODE_EXPECTED_SHA" "$PNPM_METADATA" "$0" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const [lab, evidence, output, nodeVersion, pnpmVersion, nodeSha, metadataPath, bootstrapPath] = process.argv.slice(2)
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
const listeners = readFileSync(evidence + '/listeners-after.txt', 'utf8').trim().split('\n').filter(Boolean).map((line) => {
  const [protocol, endpoint] = line.split(' ')
  const match = endpoint.match(/:(\d+)$/)
  return { protocol, port: Number(match?.[1]), exposure: endpoint.startsWith('127.') || endpoint.startsWith('[::1]') ? 'loopback' : 'non-loopback' }
})
const packages = readFileSync(evidence + '/packages-installed.tsv', 'utf8').trim().split('\n').map((line) => { const [name, version] = line.split('\t'); return { name, version } })
const candidates = []
let candidateName
for (const line of readFileSync(evidence + '/apt-policy-candidates.txt', 'utf8').split('\n')) {
  if (/^[^\s].*:$/.test(line)) candidateName = line.slice(0, -1)
  const match = line.match(/^\s+Candidate: (.+)$/)
  if (match) candidates.push({ name: candidateName, candidate: match[1] })
}
const report = {
  as_of: new Date().toISOString(), role: 'disposable qualification host',
  operating_system: 'Ubuntu 24.04', kernel: execFileSync('uname', ['-srmo'], { encoding: 'utf8' }).trim(),
  virtualization: execFileSync('systemd-detect-virt', [], { encoding: 'utf8' }).trim(),
  systemd: execFileSync('systemctl', ['--version'], { encoding: 'utf8' }).split('\n')[0],
  cgroup: { type: 'cgroup2fs', controllers: readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8').trim().split(' ') },
  tools: {
    node: { version: nodeVersion, executable: lab + '/bin/node', archive_sha256: nodeSha, source: 'https://nodejs.org/dist/v' + nodeVersion + '/SHASUMS256.txt' },
    pnpm: { version: pnpmVersion, executable: lab + '/bin/pnpm', package: metadata.name, integrity: metadata.dist.integrity, source: 'https://registry.npmjs.org/@pnpm%2fexe.linux-x64/' + pnpmVersion }
  }, packages, distribution_candidates: candidates, listeners, listener_inventory_unchanged: true,
  bootstrap_source_sha256: createHash('sha256').update(readFileSync(bootstrapPath)).digest('hex'),
  policy: { package_autostart: 'temporarily denied; original policy restored', repositories: 'existing signed Ubuntu repositories; no added PPA', ssh_changed: false, firewall_changed: false, panel_installer_run: false, daemons_installed: false },
  version_scope: 'Exact stable project Node/pnpm pins; Ubuntu tools use current signed distribution candidates. No claim that distro PHP/daemon candidates are newest upstream versions.',
  qualification: { status: 'tools-ready', application_source_tested: false, service_execution_proven: false }
}
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o644 })
writeFileSync(lab + '/evidence/bootstrap-latest.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o644 })
process.stdout.write(JSON.stringify({ status: 'tools-ready', node: nodeVersion, pnpm: pnpmVersion, evidence: output, listener_inventory_unchanged: true }) + '\n')
NODE
