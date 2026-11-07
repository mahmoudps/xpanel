import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const rootDir = resolve(import.meta.dirname, '..')
const script = join(rootDir, 'scripts/el-source-builds.sh')
const functions = readFileSync(script, 'utf8')
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const tarball = (root: string, files: Record<string, string>): string => {
  const tree = join(root, 'tree'), archive = join(root, 'orig.tar.gz')
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(tree, 'orig', name)), { recursive: true }); writeFileSync(join(tree, 'orig', name), text, { mode: 0o755 }) }
  expect(spawnSync('tar', ['-czf', archive, '-C', tree, 'orig']).status).toBe(0)
  return archive
}

/** Network, packages, services and root-only steps are doubles; digest, unpacking, the swap and the records are real. */
const rebuild = (module: string, options: { apacheAccepts?: boolean; failedUnit?: boolean; digest?: string; devel?: string; env?: string; files?: Record<string, string>; make?: string } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'xpanel-el-source-builds-')); roots.push(root)
  const archive = tarball(root, { configure: '#!/bin/bash\n', ...options.files })
  writeFileSync(join(root, 'module.so'), 'old module\n')
  const script = `die() { echo "DIE $*"; exit 1; }
curl() { echo "fetch" >> "$ROOT/calls"; cp -- "$ARCHIVE" "$7"; }
install() { if [[ "$1" == -d ]]; then mkdir -p -- "\${@: -1}"; else cp -- "\${@: -2:1}" "\${@: -1}"; fi; }
chown() { :; }
autoreconf() { :; }
rpm() { case "\${@: -1}" in *-devel) echo -n '${options.devel ?? '2.0'}';; *) echo -n '2.0';; esac; }
httpd() { echo "httpd $* $(cat "$ROOT/module.so")" >> "$ROOT/calls"; return ${options.apacheAccepts === false ? 1 : 0}; }
systemctl() { echo "systemctl $*" >> "$ROOT/calls"; [[ "$1" != is-failed ]] || return ${options.failedUnit ? 0 : 1}; }
make() { ${options.make ?? 'mkdir -p .libs src/.libs; echo new module > .libs/mpm_itk.so; echo new module > src/.libs/lib21_fts_xapian_plugin.so'}; }
${functions}
OS_MAJOR=9
EL_SOURCE_BUILD_DIR="$ROOT/records"
EL_MPM_ITK_MODULE="$ROOT/module.so"; EL_MPM_ITK_SHA256=${options.digest ?? sha256(archive)}
EL_FTS_MODULE="$ROOT/module.so"; EL_FTS_SHA256=${options.digest ?? sha256(archive)}
${options.env ?? ''}
rebuild_el_source ${module}
echo DONE`
  const result = spawnSync(bash, ['-euo', 'pipefail', '-c', script], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ROOT: root, ARCHIVE: archive } })
  const read = (name: string) => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : null
  return { root, last: result.stdout.trim().split('\n').at(-1), stderr: result.stderr, read, calls: (read('calls') ?? '').trim().split('\n') }
}

describe('EL source rebuild', { tags: ['unit'] }, () => {
  it('swaps mpm-itk only after Apache accepts it, then records the version and reloads', () => {
    const run = rebuild('mpm-itk')
    expect(run.last, run.stderr).toBe('DONE')
    expect(run.read('module.so')).toBe('new module\n')
    expect(run.read('records/mpm-itk')).toBe('2.0\n')
    expect(run.calls).toEqual(['fetch', 'httpd -t new module', 'systemctl is-failed --quiet httpd', 'systemctl try-reload-or-restart httpd'])
    expect(run.read('module.so.old')).toBeNull()
    expect(run.read('module.so.new')).toBeNull()
  })

  it('starts an Apache that failed on the old module again', () => {
    expect(rebuild('mpm-itk', { failedUnit: true }).calls.at(-1)).toBe('systemctl restart httpd')
  })

  it('puts the running module back when Apache refuses the new one, and touches no service', () => {
    const run = rebuild('mpm-itk', { apacheAccepts: false })
    expect(run.last).toBe('DIE Apache refused the rebuilt mpm-itk; the previous module stays.')
    expect(run.read('module.so')).toBe('old module\n')
    expect(run.read('records/mpm-itk')).toBeNull()
    expect(run.calls.some(call => call.startsWith('systemctl'))).toBe(false)
  })

  it('leaves the module and its record alone when the source digest differs', () => {
    const run = rebuild('mpm-itk', { digest: 'a'.repeat(64) })
    expect(run.last).toBe('DIE Apache mpm-itk could not be fetched, verified or built.')
    expect(run.read('module.so')).toBe('old module\n')
    expect(run.read('records/mpm-itk')).toBeNull()
  })

  it('refuses headers behind the installed package before it fetches anything', () => {
    for (const module of ['mpm-itk', 'fts-xapian']) {
      const run = rebuild(module, { devel: '1.0' })
      expect(run.last).toMatch(/^DIE (httpd|dovecot)-devel does not match the installed (httpd|dovecot)\.$/)
      expect(run.read('calls')).toBeNull()
    }
  })

  it('installs the plugin under its final name in one step and records the Dovecot version', () => {
    const run = rebuild('fts-xapian')
    expect(run.last, run.stderr).toBe('DONE')
    expect(run.read('module.so')).toBe('new module\n')
    expect(run.read('records/fts-xapian')).toBe('2.0\n')
    expect(run.read('module.so.new')).toBeNull()
  })

  it('keeps a working Webalizer when the new one does not run, and removes the failed copy', () => {
    const env = 'EL_WEBALIZER_BINARY="$ROOT/module.so"; EL_WEBALIZER_SHA256=$(sha256sum "$ARCHIVE" | cut -d" " -f1)'
    const files = { 'preserve.c': 'memcpy(&hist[0],\n' }
    const failed = rebuild('webalizer', { env, files, make: "printf '#!/bin/bash\\necho nope\\n' > webalizer; chmod +x webalizer" })
    expect(failed.last).toBe('DIE Webalizer was built but does not run.')
    expect(failed.read('module.so')).toBe('old module\n')
    expect(failed.read('module.so.new')).toBeNull()
    const built = rebuild('webalizer', { env, files, make: "printf '#!/bin/bash\\necho Webalizer V2.23-08\\n' > webalizer; chmod +x webalizer" })
    expect(built.last, built.stderr).toBe('DONE')
    expect(built.read('records/webalizer')).toBe('\n')
  })

  it('replaces the AWStats tree only after the new one loads', () => {
    const env = 'mkdir -p "$ROOT/awstats"; echo old > "$ROOT/awstats/awstats.pl"; EL_AWSTATS_DIR="$ROOT/awstats"; EL_AWSTATS_SHA256=$(sha256sum "$ARCHIVE" | cut -d" " -f1)'
    const files = { 'wwwroot/cgi-bin/awstats.pl': 'open( DNSFILE, "$filetoload" )\n' }
    const failed = rebuild('awstats', { env: `${env}; perl() { return 1; }`, files })
    expect(failed.last).toBe('DIE AWStats was installed but its Perl modules do not load.')
    expect(failed.read('awstats/awstats.pl')).toBe('old\n')
    expect(existsSync(join(failed.root, 'awstats.new'))).toBe(false)
    const built = rebuild('awstats', { env: `${env}; perl() { :; }`, files })
    expect(built.last, built.stderr).toBe('DONE')
    expect(built.read('awstats/awstats.pl')).toContain('"<", "$filetoload"')
    expect(built.read('records/awstats')).toBe('\n')
  })

  it('refuses an unknown module', () => {
    expect(rebuild('kernel').last).toBe('DIE Unknown source build: kernel.')
  })

  it('does nothing when install.sh sources it, and refuses a run without a module', () => {
    const sourced = spawnSync(bash, ['-c', `set -euo pipefail; source '${script}'; declare -F rebuild_el_source; echo SOURCED`], { encoding: 'utf8', timeout: 10_000 })
    expect(sourced.stdout.trim().split('\n')).toEqual(['rebuild_el_source', 'SOURCED'])
    const direct = spawnSync(bash, [script], { encoding: 'utf8', timeout: 10_000 })
    expect(direct.status).toBe(1)
    expect(direct.stderr.trim()).toBe('Unknown source build: none.')
  })
})
