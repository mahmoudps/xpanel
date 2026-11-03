import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
const fixtureParent = resolve(tmpdir())
const fixtures: string[] = []
const installer = readFileSync(join(root, 'scripts/install.sh'), 'utf8')
const snapshot = readFileSync(join(root, 'scripts/install-kernel-quotas.sh'), 'utf8')
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
const fixtureDigest = (value: string) => createHash('sha256').update(value).digest('hex')

afterEach(() => {
  for (const path of fixtures.splice(0)) {
    if (dirname(path) !== fixtureParent || !basename(path).startsWith('xpanel-kernel-unit-')) throw new Error('Unowned fixture path')
    rmSync(path, { recursive: true, force: true })
  }
})

// These are isolated shell/command fixtures. No package manager, native trust, kernel or privileged path is used.
function runSnapshot(change = '') {
  const path = mkdtempSync(join(fixtureParent, 'xpanel-kernel-unit-')); fixtures.push(path)
  const directory = path.replaceAll('\\', '/')
  writeFileSync(join(path, 'calls.log'), '')
  mkdirSync(join(path, 'cache'))
  const temporary = mkdtempSync(join(path, 'cache/input.')).replaceAll('\\', '/')
  const utcNow = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  mkdirSync(join(path, 'boot'))
  mkdirSync(join(path, 'modules'))
  mkdirSync(join(path, 'modules/6.8.0-90-generic'))
  writeFileSync(join(path, 'boot/vmlinuz-6.8.0-90-generic'), 'unit-image')
  for (const module of ['quota_v2', 'quota_tree']) writeFileSync(join(path, 'modules/6.8.0-90-generic', module + '.ko'), 'unit-module')
  const fixtureSource = snapshot.replaceAll('/var/lib/xpanel-kernel-inputs', '"${FIXTURE}/inputs"')
    .replaceAll('/boot/', '${FIXTURE}/boot/').replaceAll('/lib/modules/', '${FIXTURE}/modules/')
  const script = `set -euo pipefail
OS_ID=ubuntu OS_CODENAME=noble KERNEL_SNAPSHOT=20251215T120000Z
NODE_BIN=seal-kernel SCRIPT_DIR=/unit-source
FIXTURE=${quote(directory)}
VERSION=6.8.0-90.91 REGDB=2024.10.07
EXTRA=linux-modules-extra-6.8.0-90-generic BASE=linux-modules-6.8.0-90-generic
RESUME_PREPARED=0 START_STATE=absent REGDB_STATE=absent REQUIRES_REGDB=1 HIDE_HOOK=0 FAIL_SIMULATION=0
INSTALLED=0
die() { echo "REFUSED: $*" >&2; exit 9; }
assert_root_file() { return 0; }
assert_root_owned_path() { return 0; }
chown() { return 0; }
id() { [[ "$*" == '-u _apt' ]] || return 1; printf '42'; }
date() {
  if [[ "$#" == 2 && "$1" == -u && "$2" == +%Y%m%dT%H%M%SZ ]]; then printf '%s' ${quote(utcNow)}
  else command date "$@"; fi
}
# These three small fixtures carry known bytes. Use their real SHA-256 values from Node.
# A changed payload, binary input, or another command shape goes through the ordinary utility.
sha256sum() {
  if [[ "$#" -eq 2 && "$1" == -- && -f "$2" && ! -L "$2" ]]; then
    local content='' digest=''
    if ! IFS= read -r -d '' content < "$2"; then
      case "$content" in
        unit-image) digest=${fixtureDigest('unit-image')};;
        unit-only) digest=${fixtureDigest('unit-only')};;
        db-fixtur) digest=${fixtureDigest('db-fixtur')};;
      esac
    fi
    if [[ -n "$digest" ]]; then printf '%s  %s\\n' "$digest" "$2"; return; fi
  fi
  command sha256sum "$@"
}
stat() {
  # NTFS does not expose the Linux traversal mode; this test already replaces the ownership port.
  if [[ "$*" == "-c %a $FIXTURE/inputs" ]]; then printf '711'; else command stat "$@"; fi
}
${process.platform === 'win32' ? `# Git Bash on NTFS applies the mode after creating the fixture directory.
mkdir() {
  if [[ "$1" == -m && "$#" -eq 3 ]]; then command mkdir -- "$3" && command chmod "$2" -- "$3"
  else command mkdir "$@"; fi
}` : ''}
install() {
  if [[ "$1" == -d ]]; then mkdir -p -- "\${@: -1}"; chmod 0711 -- "\${@: -1}";
  else cp -- "\${@: -2:1}" "\${@: -1}"; chmod 0600 -- "\${@: -1}"; fi
}
seal-kernel() {
  if [[ "$2" == --plan ]]; then
    [[ -s "$3/simulation.txt" && -s "$3/package-set.tsv" ]] || die no-simulation
    printf 'PLAN %s\\n' "$7" >> "$FIXTURE/calls.log"
    printf '{}' > "$3/admitted-plan.json"
    return
  fi
  local data='' measured
  if IFS= read -r -d '' data < "$2"; then die unexpected-binary-test-fixture; fi
  [[ \${#data} == "$5" && ! -e "$3" && ! -L "$3" ]] || die wrong-signed-size
  printf '%s' "$data" > "$3"
  measured="$(sha256sum -- "$3")" || die unreadable-copy
  [[ "\${measured%% *}" == "$4" ]] || die wrong-signed-digest
}
dpkg() {
  case "$1" in
    --print-architecture) printf 'amd64\\n';;
    --audit)
      if [[ "$START_STATE" == 'iU ' && "$INSTALLED" == 0 ]]; then
        printf 'The following packages have been unpacked but not yet configured.\\nThey must be configured using dpkg --configure or the configure\\nmenu option in dselect for them to work:\\n %s kernel modules\\n' "$EXTRA"
        if [[ "$#" -eq 1 && "\${FOREIGN_AUDIT:-0}" -eq 1 ]]; then printf ' unrelated package\\n'; fi
      fi
      return 0;;
    --compare-versions) [[ "$2" == "$4" ]];;
    --install) die bare-dpkg-cannot-configure-without-required-dependency;;
    *) die unexpected-dpkg;;
  esac
}
dpkg-query() {
  local p="\${@: -1}"
  if [[ "$1" == -S ]]; then printf 'linux-image-6.8.0-90-generic: %s' "$p"; return; fi
  case "$p" in
    linux-image-6.8.0-90-generic|"$BASE") printf 'ii \\t%s\\t%s\\tamd64' "$p" "$VERSION";;
    "$EXTRA")
      if [[ "$INSTALLED" == 1 ]]; then printf 'ii \\t%s\\t%s\\tamd64' "$p" "$VERSION"
      elif [[ "$START_STATE" == absent ]]; then return 1
      else printf '%s\\t%s\\t%s\\tamd64' "$START_STATE" "$p" "\${START_VERSION:-$VERSION}"; fi;;
    wireless-regdb)
      if [[ "$REGDB_STATE" == installed ]]; then printf 'ii \\t%s\\t%s\\tall' "$p" "$REGDB"; else return 1; fi;;
    *) die unexpected-query;;
  esac
}
mktemp() {
  ( set -C; : > "$FIXTURE/cache/issued" ) || die reused-temporary
  printf '%s\\n' ${quote(temporary)}
}
env() { shift; while [[ "$1" == *=* ]]; do shift; done; "$@"; }
apt-cache() {
  local p="\${@: -1}"
  if [[ "$p" == wireless-regdb ]]; then printf '  Candidate: %s\\n' "$REGDB"
  elif [[ "$p" == wireless-regdb=* ]]; then
    printf 'Package: wireless-regdb\\nVersion: %s\\nArchitecture: all\\nSHA256: ${createHash('sha256').update('db-fixtur').digest('hex')}\\nSize: 9\\n' "$REGDB"
  else printf 'Package: %s\\nVersion: %s\\nArchitecture: amd64\\nSHA256: ${createHash('sha256').update('unit-only').digest('hex')}\\nSize: 9\\n' "$EXTRA" "$VERSION"; fi
}
apt-get() {
  local action='' simulate=0 hook='' arg
  { printf 'APT'; printf ' <%s>' "$@"; printf '\\n'; } >> "$FIXTURE/calls.log"
  for arg in "$@"; do
    case "$arg" in
      update|install|download|check) action="$arg";;
      -s|--simulate) simulate=1;;
      DPkg::Pre-Install-Pkgs::=*) hook="\${arg#*=}";;
    esac
  done
  case "$action" in
    update|check) return 0;;
    download)
      if [[ "\${@: -1}" == wireless-regdb=* ]]; then printf db-fixtur > "wireless-regdb_\${REGDB}_all.deb"
      else printf unit-only > matching.deb; fi;;
    install)
      # APT 2.8 removes the local path operands before its initial check for an explicitly requested repair.
      if [[ "$START_STATE" == 'iU ' && " $* " != *" $EXTRA=$VERSION "* ]]; then return 100; fi
      if [[ "$simulate" == 1 ]]; then
        [[ "$FAIL_SIMULATION" == 0 ]] || return 100
        if [[ "$REQUIRES_REGDB" == 1 && "$REGDB_STATE" != installed ]]; then printf 'Inst wireless-regdb (%s local-deb [all])\\n' "$REGDB"; fi
        if [[ "$START_STATE" != 'iU ' ]]; then printf 'Inst %s (%s local-deb [amd64])\\n' "$EXTRA" "$VERSION"; fi
        if [[ "$REQUIRES_REGDB" == 1 && "$REGDB_STATE" != installed ]]; then printf 'Conf wireless-regdb (%s local-deb [all])\\n' "$REGDB"; fi
        printf 'Conf %s (%s local-deb [amd64])\\n' "$EXTRA" "$VERSION"
      else
        # The package manager hook protocol is exercised separately by its real validator tests.
        [[ -n "$hook" && -f "$hook" && -s "\${hook%/*}/admitted-plan.json" ]] || die missing-plan-hook
        grep -F -- '--apply-plan' "$hook" >/dev/null || die wrong-plan-hook
        if [[ "$HIDE_HOOK" == 0 ]]; then printf '{}' > "\${hook%/*}/apply-plan.json"; fi
        if [[ "$START_STATE" == 'iU ' && "\${HIDE_REUNPACK:-0}" == 0 ]]; then
          printf '{}' > "\${hook%/*}/target-reunpack-intent.json"
          printf '{}' > "\${hook%/*}/target-reunpack-result.json"
        fi
        if [[ "$REQUIRES_REGDB" == 1 && "$REGDB_STATE" != installed ]]; then
          [[ " $* " == *'/dependency-wireless-regdb.deb '* ]] || die missing-required-dependency
          REGDB_STATE=installed
        fi
        INSTALLED=1
      fi;;
    *) die unexpected-apt;;
  esac
}
dpkg-deb() {
  if [[ "$1" == -f ]]; then
    if [[ "$3" == Pre-Depends && -n "\${EXTRA_PREDEP:-}" ]]; then printf '%s' "$EXTRA_PREDEP"; fi
    if [[ "$3" == Depends ]]; then printf '%s (= %s)' "$BASE" "$VERSION"; if [[ "$REQUIRES_REGDB" == 1 ]]; then printf ', wireless-regdb'; fi; fi
  elif [[ "\${@: -1}" == */dependency-wireless-regdb.deb ]]; then printf 'wireless-regdb\\n%s\\nall\\n' "$REGDB"
  else printf '%s\\n%s\\namd64\\n' "$EXTRA" "$VERSION"; fi
}
kernel_lacks_quota_format() { return 1; }
modinfo() { printf '%s/modules/6.8.0-90-generic/%s.ko' "$FIXTURE" "\${@: -1}"; }
uname() { printf other-unit-kernel; }
${fixtureSource}
${change}
install_kernel_quota_snapshot_package 6.8.0-90-generic
`
  const result = spawnSync(bash, ['-s'], { input: script, encoding: 'utf8', timeout: 10_000 })
  return { result, path, calls: readFileSync(join(path, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) }
}

describe('an explicitly selected signed Ubuntu kernel snapshot', () => {
  it('installs the sealed kernel and its missing required dependency in the admitted APT transaction', () => {
    const { result, path, calls } = runSnapshot()
    expect(result.status, result.stderr).toBe(0)
    const downloads = calls.filter(call => call.includes('<download>'))
    expect(downloads).toHaveLength(2)
    expect(downloads[0]).toContain('<linux-modules-extra-6.8.0-90-generic=6.8.0-90.91>')
    expect(downloads[1]).toContain('<wireless-regdb=2024.10.07>')
    expect(downloads.every(call => call.includes('<Acquire::AllowInsecureRepositories=false>') && call.includes('<APT::Get::AllowUnauthenticated=false>'))).toBe(true)
    const actions = calls.filter(call => call.includes('<install>'))
    expect(actions).toHaveLength(2)
    for (const action of actions) {
      expect(action).toContain('<--no-remove>')
      expect(action).toContain('<--no-install-recommends>')
      expect(action).toContain('<--reinstall>')
      expect(action).not.toContain('ConfigurePending=false')
      expect(action).toContain('/authenticated.deb>')
      expect(action).toContain('/dependency-wireless-regdb.deb>')
      expect(action).toContain('<linux-modules-extra-6.8.0-90-generic=6.8.0-90.91>')
      expect(action).toContain('<wireless-regdb=2024.10.07>')
      expect(action).not.toMatch(/--force|--ignore|--fix-broken/)
    }
    expect(actions[0]).toContain('<-s>')
    expect(actions[0]).toContain('<-qq>')
    expect(actions[1]).toContain('DPkg::Pre-Install-Pkgs::=')
    expect(actions[1]).toContain('::Version=3')
    expect(calls.indexOf(actions[0]!)).toBeLessThan(calls.indexOf('PLAN fresh'))
    expect(calls.indexOf('PLAN fresh')).toBeLessThan(calls.indexOf(actions[1]!))
    expect(calls.at(-1)).toContain('<check>')
    const retained = /Kernel snapshot inputs retained at (.+)/.exec(result.stdout)![1]!
    const nativeRetained = process.platform === 'win32' ? retained.replace(/^\/([a-z])\//i, (_, drive: string) => `${drive.toUpperCase()}:/`) : retained
    expect(nativeRetained.toLowerCase()).toContain(path.replaceAll('\\', '/').toLowerCase())
    const config = readFileSync(join(nativeRetained, 'ubuntu.sources'), 'utf8')
    expect(config).toContain('URIs: https://snapshot.ubuntu.com/ubuntu/20251215T120000Z\n')
    expect(config).toContain('Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n')
    expect(config).toContain('Suites: noble-updates\n')
    expect(config).not.toMatch(/Trusted:|Allow-Insecure|ppa:|mirror\./i)
    const normal = readFileSync(join(nativeRetained, 'normal.sources'), 'utf8')
    expect(normal).toContain('https://archive.ubuntu.com/ubuntu')
    expect(normal).toContain('https://security.ubuntu.com/ubuntu')
    expect(normal).not.toMatch(/Trusted:|Check-Valid-Until: no|Allow-Insecure/i)
    const startup = readFileSync(join(nativeRetained, 'apt.conf'), 'utf8')
    expect(startup).toContain('Dir::Etc::parts ')
    expect(startup).toContain('Dir::Etc::main ')
    expect(startup).toContain('Dir::Cache::pkgcache ')
    expect(startup).toContain('Dir::Cache::srcpkgcache ')
  })

  it.each([
    'KERNEL_SNAPSHOT=20251315T120000Z', 'KERNEL_SNAPSHOT=29991215T120000Z',
    'KERNEL_SNAPSHOT=20220215T120000Z', 'OS_CODENAME=untrusted',
    'dpkg() { printf arm64; }', 'dpkg-query() { printf un; }', 'id() { printf 0; }', 'sha256sum() { return 42; }',
  ])('refuses unsupported snapshot/image input before APT: %s', change => {
    const { result, calls } = runSnapshot(change)
    expect(result.stderr).not.toMatch(/syntax error|unexpected EOF/)
    expect(result.status).not.toBe(0)
    expect(calls).toEqual([])
  })

  it.each([
    "dpkg-deb() { printf 'linux-modules-extra-other\\n6.8.0-90.91\\namd64\\n'; }",
    "dpkg-deb() { printf 'linux-modules-extra-6.8.0-90-generic\\n6.8.0-91.92\\namd64\\n'; }",
    "dpkg-deb() { printf 'linux-modules-extra-6.8.0-90-generic\\n6.8.0-90.91\\narm64\\n'; }",
  ])('refuses a mismatched downloaded package before installation: %s', change => {
    const { result, calls } = runSnapshot(change)
    expect(result.stderr).not.toMatch(/syntax error|unexpected EOF/)
    expect(result.status).not.toBe(0)
    expect(calls.some(call => call.includes('<install>'))).toBe(false)
  })

  it('refuses corrupt bytes even when control metadata repeats the expected package identity', () => {
    const { result, calls } = runSnapshot("apt-cache() { printf 'SHA256: " + '0'.repeat(64) + "\\nSize: 9\\n'; }")
    expect(result.stderr).not.toMatch(/syntax error|unexpected EOF/)
    expect(result.status).not.toBe(0)
    expect(calls.some(call => call.includes('<install>'))).toBe(false)
  })

  it('reacquires the exact iU archive and requires the hook re-unpack before accepting APT configuration', () => {
    const { result, calls } = runSnapshot("START_STATE='iU ' RESUME_PREPARED=1")
    expect(result.status, result.stderr).toBe(0)
    expect(calls.filter(call => call.includes('<download>'))).toHaveLength(2)
    expect(calls).toContain('PLAN resume')
    const installs = calls.filter(call => call.includes('<install>'))
    expect(installs).toHaveLength(2)
    const operands = '<linux-modules-extra-6.8.0-90-generic=6.8.0-90.91> <wireless-regdb=2024.10.07>'
    expect(installs.every(call => call.endsWith(operands) && !call.includes('<--reinstall>') && !call.includes('ConfigurePending=false'))).toBe(true)
    expect(calls.at(-1)).toContain('<check>')
  })

  it('refuses an unmet pre-dependency before issuing the re-unpack or submitting a transaction', () => {
    const { result, calls } = runSnapshot("START_STATE='iU ' RESUME_PREPARED=1 EXTRA_PREDEP=wireless-regdb")
    expect(result.status, result.stderr).not.toBe(0)
    expect(calls.some(call => call.includes('<install>'))).toBe(false)
  })

  it('requires the specific re-unpack originals as well as the locked APT observation', () => {
    const { result, calls } = runSnapshot("START_STATE='iU ' RESUME_PREPARED=1 HIDE_REUNPACK=1")
    expect(result.status, result.stderr).not.toBe(0)
    expect(result.stderr).toContain('re-unpack was not confirmed')
    expect(calls.some(call => call.includes('<check>'))).toBe(false)
  })

  it('preserves an already configured dependency', () => {
    const { result, calls } = runSnapshot('REGDB_STATE=installed')
    expect(result.status, result.stderr).toBe(0)
    expect(calls.filter(call => call.includes('<download>'))).toHaveLength(1)
    expect(calls.every(call => !call.includes('/dependency-wireless-regdb.deb>'))).toBe(true)
  })

  it.each([
    "START_STATE='iU '", "START_STATE='iU ' RESUME_PREPARED=1 START_VERSION=6.8.0-91.92",
    "START_STATE='iU ' RESUME_PREPARED=1 FOREIGN_AUDIT=1", "START_STATE='iF ' RESUME_PREPARED=1",
  ])('refuses partial state beyond the exact admitted package before acquisition: %s', change => {
    const { result, calls } = runSnapshot(change)
    expect(result.status, result.stderr).not.toBe(0)
    expect(calls).toEqual([])
  })

  it('stops before the real APT call when the dependency solver refuses the simulated transaction', () => {
    const { result, calls } = runSnapshot('FAIL_SIMULATION=1')
    expect(result.status, result.stderr).not.toBe(0)
    expect(calls.some(call => call.includes('<-s>') && call.includes('<install>'))).toBe(true)
    expect(calls.some(call => call.includes('<-y>') && call.includes('<install>'))).toBe(false)
  })

  it('requires the locked hook observation before accepting the completed package call', () => {
    const { result, calls } = runSnapshot('HIDE_HOOK=1')
    expect(result.status, result.stderr).not.toBe(0)
    expect(result.stderr).toContain('locked APT plan was not observed')
    expect(calls.some(call => call.includes('<check>'))).toBe(false)
  })

  it('does not equate package presence with observed quota modules', () => {
    const { result } = runSnapshot('kernel_lacks_quota_format() { return 0; }')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('did not supply both quota formats')
  })

  it('does not interpret a failed empty dpkg audit as healthy', () => {
    const { result, calls } = runSnapshot('dpkg() { if [[ "$1" == --print-architecture ]]; then printf amd64; else return 42; fi; }')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('health could not be observed')
    expect(calls).toEqual([])
  })
  it('creates snapshot control files without a writable exposure even under a permissive caller umask', () => {
    const { result } = runSnapshot(`umask 000
# This case exercises the creation modes of the historical snapshot controls.
# The normal repository acquisition is exercised by the missing-dependency cases.
REGDB_STATE=installed
chmod() {
  local path mode modes
  local -a controls=()
  for path in "$@"; do
    case "$path" in
      */apt.conf|*/ubuntu.sources|*/empty.conf) controls+=("$path");;
    esac
  done
  if (( \${#controls[@]} )); then
    modes="$(command stat -c %a -- "\${controls[@]}")" || die unobservable-control-file
    while IFS= read -r mode; do (( (8#$mode & 0022) == 0 )) || die exposed-control-file; done <<< "$modes"
  fi
  command chmod "$@"
}`)
    expect(result.status, result.stderr).toBe(0)
  })
})

describe('the installer selects historical recovery from package state', () => {
  const entry = installer.slice(installer.indexOf('ensure_kernel_quota_format() {'), installer.indexOf('assert_bootable_kernel_quota_format() {'))
  function preflight(state: string, resumed: boolean, snapshotSelected: boolean, queryExit = 0, formatsPresent = true) {
    const path = mkdtempSync(join(fixtureParent, 'xpanel-kernel-unit-'))
    fixtures.push(path)
    writeFileSync(join(path, 'install-kernel-quotas.sh'), 'install_kernel_quota_snapshot_package() { echo "snapshot $1"; }\n')
    const script = `set -euo pipefail
OS_FAMILY=debian OS_ID=ubuntu RESUME_PREPARED=${resumed ? 1 : 0} KERNEL_SNAPSHOT=${snapshotSelected ? '20251215T120000Z' : "''"}
SCRIPT_DIR=${quote(path.replaceAll('\\', '/'))}
die() { echo "$*" >&2; exit 9; }
assert_root_file() { return 0; }
bootable_kernel_releases() { echo 6.8.0-90-generic; }
dpkg-query() {
  if [[ "$3" == 'linux-image-virtual*' ]]; then return 0; fi
  printf '%s' ${quote(state)}
  return ${queryExit}
}
kernel_lacks_quota_format() { return ${formatsPresent ? 1 : 0}; }
apt-cache() { echo 'apt-policy' >&2; echo '  Candidate: 6.8.0-90.91'; }
apt-get() { echo "apt-normal $*"; }
assert_bootable_kernel_quota_format() { echo bootable-checked; }
${entry}
ensure_kernel_quota_format
`
    return spawnSync(bash, ['-s'], { input: script, encoding: 'utf8', timeout: 10_000 })
  }

  it.each([true, false])('resumes iU from the sealed snapshot even when module files are present=%s and APT would report its status-only candidate', present => {
    const result = preflight('iU ', true, true, 0, present)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual(['snapshot 6.8.0-90-generic', 'bootable-checked'])
    expect(result.stderr).not.toContain('apt-policy')
  })

  it.each([
    ['iU ', false, true, 0], ['iU ', true, false, 0], ['iF ', true, true, 0],
    ['iUR', true, true, 0], ['hU ', true, true, 0], ['bad', true, true, 0], ['', true, true, 2],
  ] as const)('refuses unadmitted or unknown state %s before package effects', (state, resumed, snapshotSelected, exit) => {
    const result = preflight(state, resumed, snapshotSelected, exit)
    expect(result.status, result.stderr).toBe(9)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('apt-policy')
  })

  it('preserves ordinary fresh installation for a current APT candidate and skips an already healthy package', () => {
    const fresh = preflight('', false, false, 1, false)
    expect(fresh.status, fresh.stderr).toBe(0)
    expect(fresh.stdout).toContain('apt-normal install -y --no-install-recommends linux-modules-extra-6.8.0-90-generic')
    const healthy = preflight('ii ', false, false)
    expect(healthy.status, healthy.stderr).toBe(0)
    expect(healthy.stdout.trim()).toBe('bootable-checked')
  })
})

describe('OS kernel prerequisites precede fresh product publication', () => {
  const section = installer.slice(installer.indexOf('prepared_release=""'), installer.indexOf('INSTALL_SOURCE_ROOT="$(printf'))
  function preflight(mode: number, verified: boolean, ready: boolean, changed = false) {
    const script = `set -euo pipefail
NEW_INSTALL_ARGS=() RESUME_PREPARED=${mode} WITH_DNS=0 WITH_MARIADB=0 OS_FAMILY=debian NODE_BIN=bootstrap SCRIPT_DIR=/unexecuted
die() { echo "$*" >&2; exit 9; }
bootstrap() { printf '%s\\n' "$2"; ${changed ? '[[ ! -e "$DRIFT" ]] || printf drift;' : ''} ${verified ? 'return 0' : 'return 8'}; }
apt-get() { printf 'apt %s\\n' "$1"; }
ensure_kernel_quota_format() { printf 'kernel-check\\n'; ${changed ? ': > "$DRIFT";' : ''} ${ready ? 'return 0' : 'return 7'}; }
${section}
printf 'PREPARED=%s\\n' "$prepared_release"
`
    const directory = mkdtempSync(join(fixtureParent, 'xpanel-kernel-unit-')); fixtures.push(directory)
    return spawnSync(bash, ['-s'], { input: script, encoding: 'utf8', timeout: 10_000, env: { ...process.env, DRIFT: join(directory, 'changed').replaceAll('\\', '/') } })
  }
  it('never publishes product preparation after an unavailable kernel prerequisite', () => {
    const result = preflight(0, true, false)
    expect(result.status).toBe(7)
    expect(result.stdout).toContain('kernel-check')
    expect(result.stdout).not.toContain('PREPARED=prepare')
  })
  it('does not run APT after archive verification refuses', () => {
    const result = preflight(0, false, true)
    expect(result.status).toBe(8)
    expect(result.stdout).not.toContain('apt update')
    expect(result.stdout).not.toContain('kernel-check')
  })
  it('prepares only after kernel checks and keeps exact continuation separate from fresh preparation', () => {
    const fresh = preflight(0, true, true), resume = preflight(1, true, true)
    expect(fresh.status, fresh.stderr).toBe(0)
    expect(fresh.stdout).toContain('PREPARED=prepare')
    expect(fresh.stdout.indexOf('kernel-check')).toBeLessThan(fresh.stdout.indexOf('PREPARED=prepare'))
    expect(resume.status, resume.stderr).toBe(0)
    expect(resume.stdout).toContain('PREPARED=resume')
  })
  it('re-admits after APT and refuses changed preparation before product effects', () => {
    const result = preflight(1, true, true, true)
    expect(result.status, result.stderr).toBe(9)
    expect(result.stderr).toContain('identity changed during OS prerequisite')
    expect(result.stdout).not.toContain('PREPARED=')
  })
})
