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
  mkdirSync(join(path, 'cache'))
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
VERSION=6.8.0-90.91
INSTALLED=0
die() { echo "REFUSED: $*" >&2; exit 9; }
assert_root_file() { return 0; }
assert_root_owned_path() { return 0; }
chown() { return 0; }
id() { [[ "$*" == '-u _apt' ]] || return 1; printf '42'; }
stat() {
  # NTFS does not expose the Linux traversal mode; this test already replaces the ownership port.
  if [[ "$*" == "-c %a $FIXTURE/inputs" ]]; then printf '711'; else command stat "$@"; fi
}
install() {
  if [[ "$1" == -d ]]; then mkdir -p -- "\${@: -1}"; chmod 0711 -- "\${@: -1}";
  else cp -- "\${@: -2:1}" "\${@: -1}"; chmod 0600 -- "\${@: -1}"; fi
}
seal-kernel() {
  [[ "$(stat -c %s -- "$2")" == "$5" ]] || die wrong-signed-size
  cp -- "$2" "$3"; chmod 0600 -- "$3"
  printf '%s  %s\\n' "$4" "$3" | sha256sum --check --status || die wrong-signed-digest
}
dpkg() {
  case "$1" in
    --print-architecture) printf 'amd64\\n';;
    --audit) return 0;;
    --install) printf 'DPKG'; printf ' <%s>' "$@"; printf '\\n'; INSTALLED=1;;
    *) die unexpected-dpkg;;
  esac
}
dpkg-query() {
  local package="\${@: -1}"
  if [[ "$1" == -S ]]; then printf 'linux-image-6.8.0-90-generic: %s' "$package";
  elif [[ "$2" == '-f=\${db:Status-Abbrev}' ]]; then printf 'un ';
  else printf 'ii \\t%s\\t%s\\tamd64' "$package" "$VERSION"; fi
}
mktemp() { command mktemp -d "$FIXTURE/cache/input.XXXXXXXX"; }
env() { shift; while [[ "$1" == *=* ]]; do shift; done; "$@"; }
apt-cache() { printf 'SHA256: ${createHash('sha256').update('unit-only').digest('hex')}\\nSize: 9\\n'; }
apt-get() {
  printf 'APT'; printf ' <%s>' "$@"; printf '\\n'
  for argument in "$@"; do if [[ "$argument" == download ]]; then printf unit-only > matching.deb; fi; done
}
dpkg-deb() { printf 'linux-modules-extra-6.8.0-90-generic\\n%s\\namd64\\n' "$VERSION"; }
kernel_lacks_quota_format() { return 1; }
modinfo() { printf '%s/modules/6.8.0-90-generic/%s.ko' "$FIXTURE" "\${@: -1}"; }
uname() { printf other-unit-kernel; }
${fixtureSource}
${change}
install_kernel_quota_snapshot_package 6.8.0-90-generic
`
  return { result: spawnSync(bash, ['-s'], { input: script, encoding: 'utf8', timeout: 10_000 }), path }
}

describe('an explicitly selected signed Ubuntu kernel snapshot', () => {
  it('downloads matching modules from one signed suite and installs only that sealed package', () => {
    const { result, path } = runSnapshot()
    expect(result.status, result.stderr).toBe(0)
    const calls = result.stdout.split('\n').filter(line => line.startsWith('APT'))
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('<update>')
    expect(calls[0]).toContain('<Acquire::AllowInsecureRepositories=false>')
    expect(calls[0]).toContain('<Acquire::AllowDowngradeToInsecureRepositories=false>')
    expect(calls[0]).toContain('<APT::Get::AllowUnauthenticated=false>')
    expect(calls[0]).toContain('<Dir::Etc::sourceparts=->')
    expect(calls[0]).toContain('<APT::Update::Error-Mode=any>')
    expect(calls[1]).toContain('<download> <linux-modules-extra-6.8.0-90-generic=6.8.0-90.91>')
    expect(calls.every(call => !call.includes('<install>'))).toBe(true)
    const installs = result.stdout.split('\n').filter(line => line.startsWith('DPKG'))
    expect(installs).toHaveLength(1)
    expect(installs[0]).toContain('<--install> <-->')
    expect(installs[0]).toContain('/authenticated.deb>')
    expect(installs[0]).not.toMatch(/--force|--ignore|--recursive/)
    const retained = /Kernel snapshot inputs retained at (.+)/.exec(result.stdout)![1]!
    const nativeRetained = process.platform === 'win32' ? retained.replace(/^\/([a-z])\//i, (_, drive: string) => `${drive.toUpperCase()}:/`) : retained
    expect(nativeRetained.toLowerCase()).toContain(path.replaceAll('\\', '/').toLowerCase())
    const config = readFileSync(join(nativeRetained, 'ubuntu.sources'), 'utf8')
    expect(config).toContain('URIs: https://snapshot.ubuntu.com/ubuntu/20251215T120000Z\n')
    expect(config).toContain('Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n')
    expect(config).toContain('Suites: noble-updates\n')
    expect(config).not.toMatch(/Trusted:|Allow-Insecure|ppa:|mirror\./i)
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
    const { result } = runSnapshot(change)
    expect(result.stderr).not.toMatch(/syntax error|unexpected EOF/)
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('APT')
  })

  it.each([
    "dpkg-deb() { printf 'linux-modules-extra-other\\n6.8.0-90.91\\namd64\\n'; }",
    "dpkg-deb() { printf 'linux-modules-extra-6.8.0-90-generic\\n6.8.0-91.92\\namd64\\n'; }",
    "dpkg-deb() { printf 'linux-modules-extra-6.8.0-90-generic\\n6.8.0-90.91\\narm64\\n'; }",
  ])('refuses a mismatched downloaded package before installation: %s', change => {
    const { result } = runSnapshot(change)
    expect(result.stderr).not.toMatch(/syntax error|unexpected EOF/)
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('DPKG')
  })

  it('refuses corrupt bytes even when control metadata repeats the expected package identity', () => {
    const { result } = runSnapshot("apt-cache() { printf 'SHA256: " + '0'.repeat(64) + "\\nSize: 9\\n'; }")
    expect(result.stderr).not.toMatch(/syntax error|unexpected EOF/)
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('DPKG')
  })

  it('does not equate package presence with observed quota modules', () => {
    const { result } = runSnapshot('kernel_lacks_quota_format() { return 0; }')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('did not supply both quota formats')
  })

  it('does not interpret a failed empty dpkg audit as healthy', () => {
    const { result } = runSnapshot('dpkg() { if [[ "$1" == --print-architecture ]]; then printf amd64; else return 42; fi; }')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('health could not be observed')
    expect(result.stdout).not.toContain('APT')
  })
  it('creates snapshot control files without a writable exposure even under a permissive caller umask', () => {
    const { result } = runSnapshot(`umask 000
chmod() {
  local path mode
  for path in "$@"; do
    case "$path" in
      */apt.conf|*/ubuntu.sources|*/empty.conf)
        mode="$(stat -c %a -- "$path")"
        (( (8#$mode & 0022) == 0 )) || die exposed-control-file
        ;;
    esac
  done
  command chmod "$@"
}`)
    expect(result.status, result.stderr).toBe(0)
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
