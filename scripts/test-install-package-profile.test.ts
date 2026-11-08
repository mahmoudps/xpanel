import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installConfiguration, installPlan, profileFor, SUPPORTED_OS } from '../packages/os/src/index.ts'
import type { InstallAction } from '../packages/os/src/index.ts'
import { renderNamedZonesConfig } from '../apps/agent/src/services/dns.ts'

const rootDir = resolve(import.meta.dirname, '..')
const tempParent = resolve(tmpdir())
const tempPrefix = 'xpanel-install-package-profile-'
const tempRoots: string[] = []
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort()

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    if (dirname(root) !== tempParent || !basename(root).startsWith(tempPrefix)) {
      throw new Error('Refusing cleanup outside the owned install-package fixture')
    }
    rmSync(root, { recursive: true, force: true })
  }
})

const packageInputs = (actions: readonly InstallAction[]): string[] => actions.flatMap(action => {
  if (action.kind !== 'exec') return []
  const install = action.argv.indexOf('install')
  return install < 0 ? [] : action.argv.slice(install + 1).filter(value => !value.startsWith('-'))
})

const repositoryInputs = (actions: readonly InstallAction[]): string[] => actions.flatMap(action => {
  if (action.kind !== 'exec') return []
  return action.argv.some(value => value.endsWith('/add-apt-repository'))
    || (action.argv.includes('config-manager') && action.argv.includes('--set-enabled'))
    ? action.argv.slice(-1)
    : []
})

const lineValues = (stdout: string, label: string): string[] => {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(`${label}:`))
  expect(lines, `Expected one ${label} record`).toHaveLength(1)
  const line = lines[0]
  if (line === undefined) throw new Error(`Missing ${label} record`)
  return line.slice(label.length + 1).trim().split(/\s+/).filter(Boolean)
}

// The current bootstrap compiles native helpers and preserves its existing PostgreSQL
// PHP extension and distro FPM prerequisites. These exact extras are not profile roles.
const bootstrapExtras = (family: 'debian' | 'rhel', php: string): string[] => family === 'debian'
  ? ['curl', 'gcc', 'libc6-dev', `php${php}-pgsql`]
  : ['gcc', 'glibc-devel', 'php-fpm']

const cases = SUPPORTED_OS.flatMap(os => os.versions.flatMap(versionId => ['8.3', '7.4'].flatMap(php =>
  [false, true].map(withServices => ({ id: os.id, name: os.name, versionId, php, withServices })),
)))

describe('Apache module check of the installer', () => {
  it('finds mpm-itk in a long module list under pipefail, and refuses a list without it', () => {
    const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8')
    const start = source.indexOf('  local apachectl=apache2ctl modules')
    const block = source.slice(start, source.indexOf('\n}\n', start))
    // The match comes first and a long list follows: an early-exiting reader would break the writer's pipe.
    const httpd = (withItk: boolean) => `httpd() { [[ "$1" == -t ]] && return 0; ${withItk ? "echo ' mpm_itk_module (shared)'" : ':'}; for _ in $(seq 1 12000); do echo ' status_module (shared)'; done; }`
    const script = (withItk: boolean) => `die() { echo "DIE $*"; exit 1; }\n${httpd(withItk)}\ncheck() {\n${block}\n}\nOS_FAMILY=rhel APACHE_MPM=itk check && echo PASS\n`
    const ok = spawnSync(bash, ['-euo', 'pipefail', '-c', script(true)], { encoding: 'utf8', timeout: 10_000 })
    expect(ok.stdout.trim(), ok.stderr).toBe('PASS')
    const missing = spawnSync(bash, ['-euo', 'pipefail', '-c', script(false)], { encoding: 'utf8', timeout: 10_000 })
    expect(missing.stdout.trim()).toBe('DIE Apache did not load mpm-itk.')
  })

  it('reads mpm-itk from the module list, as real hosts print it, whatever "Server MPM" says', () => {
    const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8')
    const start = source.indexOf('  local apachectl=apache2ctl modules')
    const block = source.slice(start, source.indexOf('\n}\n', start))
    // Stage and the EL guests: itk is a module on top of prefork, so -V still names prefork.
    const version = 'Server version: Apache/2.4.62 (AlmaLinux)\nServer MPM:     prefork\n  threaded:     no\n    forked:     yes (variable process count)'
    const host = (modules: string[]) => `httpd() { case "$1" in -t) return 0 ;; -V) printf '%s\n' '${version.replaceAll('\n', "' '")}' ;; -M) printf '%s\n' 'Loaded Modules:' ' core_module (static)' ${modules.map(item => `' ${item}'`).join(' ')} ' status_module (shared)' ;; esac; }`
    const run = (modules: string[]) => spawnSync(bash, ['-euo', 'pipefail', '-c', `die() { echo "DIE $*"; exit 1; }\n${host(modules)}\ncheck() {\n${block}\n}\nOS_FAMILY=rhel APACHE_MPM=itk check && echo PASS\n`], { encoding: 'utf8', timeout: 10_000 })
    for (const order of [['mpm_prefork_module (shared)', 'mpm_itk_module (shared)'], ['mpm_itk_module (shared)', 'mpm_prefork_module (shared)']]) expect(run(order).stdout.trim(), order.join()).toBe('PASS')
    expect(run(['mpm_prefork_module (shared)']).stdout.trim()).toBe('DIE Apache did not load mpm-itk.')
  })
})

describe('statistics engines the EL repositories lack', () => {
  const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8')
  const functions = readFileSync(join(rootDir, 'scripts/el-source-builds.sh'), 'utf8')
  const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const tarball = (root: string, files: Record<string, string>): string => {
    const tree = join(root, 'tree'), archive = join(root, 'orig.tar.gz')
    for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(tree, 'orig', name)), { recursive: true }); writeFileSync(join(tree, 'orig', name), text, { mode: 0o755 }) }
    expect(spawnSync('tar', ['-czf', archive, '-C', tree, 'orig']).status).toBe(0)
    return archive
  }
  const scratch = () => { const root = mkdtempSync(join(tempParent, tempPrefix)); tempRoots.push(root); return root }
  // The build, the installer's root-only steps and the network are doubles; digest, unpacking and source edits are real.
  const run = (root: string, call: string, env: string) => spawnSync(bash, ['-euo', 'pipefail', '-c', `die() { echo "DIE $*"; exit 1; }
curl() { cp -- "$ARCHIVE" "$7"; }
install() { if [[ "$1" == -d ]]; then mkdir -p -- "\${@: -1}"; else cp -- "\${@: -2:1}" "\${@: -1}"; fi; }
chown() { :; }
${functions}
${env}
${call} && echo DONE`], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ROOT: root } })

  describe('Webalizer', () => {
    const preserve = 'memcpy(&hist[0], &hist[1], sizeof(hist[0])*i);\nmemcpy(&hist[0],&hist[1],sizeof(hist[0])*i);\n'
    const configure = '#!/bin/bash\nprintf \'%s\\n\' "$*" "$CFLAGS" > "$ROOT/configured"\n'
    const version = (output: string) => `make() { printf '#!/bin/bash\\necho "${output}"\\nexit 1\\n' > webalizer; chmod +x webalizer; }`
    const setup = (major: number, output = 'Webalizer V2.23-08 (Linux 6.1 x86_64) locale', digest?: string) => {
      const root = scratch(), archive = tarball(root, { configure, 'preserve.c': preserve })
      return { root, result: run(root, 'install_el_webalizer', `ARCHIVE=${archive}; OS_MAJOR=${major}; EL_WEBALIZER_SHA256=${digest ?? sha256(archive)}; EL_WEBALIZER_BINARY=${root}/webalizer-installed; ${version(output)}`) }
    }

    it.each([[9, false], [10, true]])('builds EL %i without DNS and with the history fix', (major, permissive) => {
      const { root, result } = setup(major)
      expect(result.stdout.trim(), result.stderr).toBe('DONE')
      const [args, cflags] = readFileSync(join(root, 'configured'), 'utf8').trim().split('\n')
      expect(args).toBe('--disable-dns')
      expect(cflags).toContain('-std=gnu89')
      expect(cflags!.includes('-fpermissive')).toBe(permissive)
      expect(existsSync(join(root, 'webalizer-installed'))).toBe(true)
    })

    it('applies the history fix to both call sites before it configures', () => {
      const root = scratch(), archive = tarball(root, { configure: '#!/bin/bash\ncp preserve.c "$ROOT/preserve.seen"\n', 'preserve.c': preserve })
      const result = run(root, 'install_el_webalizer', `ARCHIVE=${archive}; OS_MAJOR=9; EL_WEBALIZER_SHA256=${sha256(archive)}; EL_WEBALIZER_BINARY=${root}/installed; ${version('Webalizer V2.23-08')}`)
      expect(result.stdout.trim(), result.stderr).toBe('DONE')
      expect(readFileSync(join(root, 'preserve.seen'), 'utf8')).toBe('memmove(&hist[0], &hist[1], sizeof(hist[0])*i);\nmemmove(&hist[0],&hist[1],sizeof(hist[0])*i);\n')
    })

    it('refuses a source whose digest differs before anything is unpacked or built', () => {
      const { root, result } = setup(9, undefined, 'a'.repeat(64))
      // sha256sum reports the mismatch on its own line first.
      expect(result.stdout.trim().split('\n').at(-1)).toBe('DIE Webalizer could not be fetched, verified or built.')
      expect(existsSync(join(root, 'configured'))).toBe(false)
      expect(existsSync(join(root, 'webalizer-installed'))).toBe(false)
    })

    it('refuses a binary that does not report the pinned release', () => {
      expect(setup(9, '').result.stdout.trim()).toBe('DIE Webalizer was built but does not run.')
      expect(setup(9, 'Webalizer V2.21-02').result.stdout.trim()).toBe('DIE Webalizer was built but does not run.')
    })
  })

  describe('AWStats', () => {
    const script = '#!/usr/bin/perl\nopen( DNSFILE, "$filetoload" )\nopen( DNSFILE, ">$filetosave" )\n'
    const setup = (text = script, check = 0, digest?: string) => {
      const root = scratch(), archive = tarball(root, { 'wwwroot/cgi-bin/awstats.pl': text, 'wwwroot/cgi-bin/lib/x.pm': '1;\n', 'wwwroot/cgi-bin/plugins/geoip2_country.pm': '1;\n', 'docs/index.html': '' })
      const target = join(root, 'share/wwwroot/cgi-bin')
      return { target, result: run(root, 'install_el_awstats', `ARCHIVE=${archive}; EL_AWSTATS_SHA256=${digest ?? sha256(archive)}; EL_AWSTATS_DIR=${target}; perl() { [[ "$1" == -c ]] && return ${check}; }`) }
    }

    it('installs only the program tree, with the CVE fix and the writer untouched', () => {
      const { target, result } = setup()
      expect(result.stdout.trim(), result.stderr).toBe('DONE')
      expect(readFileSync(join(target, 'awstats.pl'), 'utf8')).toBe('#!/usr/bin/perl\nopen( DNSFILE, "<", "$filetoload" )\nopen( DNSFILE, ">$filetosave" )\n')
      expect(existsSync(join(target, 'plugins/geoip2_country.pm'))).toBe(true)
      expect(existsSync(join(target, '../docs'))).toBe(false)
    })

    it('refuses a changed source, a source the fix no longer fits and a program whose modules do not load', () => {
      const changed = setup(undefined, 0, 'a'.repeat(64))
      expect(changed.result.stdout.trim().split('\n').at(-1)).toBe('DIE AWStats could not be fetched or verified.')
      expect(existsSync(changed.target)).toBe(false)
      expect(setup('#!/usr/bin/perl\n').result.stdout.trim()).toBe('DIE AWStats could not be fetched or verified.')
      expect(setup(script, 1).result.stdout.trim()).toBe('DIE AWStats was installed but its Perl modules do not load.')
    })
  })

  describe('Dovecot search index plugin', () => {
    const plugin = '/src/.libs/lib21_fts_xapian_plugin.so'
    const configure = '#!/bin/bash\nprintf \'%s\\n\' "$*" "$CFLAGS" "$CXXFLAGS" > "$ROOT/configured"\n'
    const setup = (build = `mkdir -p src/.libs; echo plugin > .${plugin}`, digest?: string) => {
      const root = scratch(), archive = tarball(root, { 'configure.ac': 'AC_INIT\n', configure })
      return { root, result: run(root, 'install_el_fts_xapian', `ARCHIVE=${archive}; EL_FTS_SHA256=${digest ?? sha256(archive)}; EL_FTS_MODULE=${root}/module.so; autoreconf() { touch "$ROOT/autoreconf-$1"; }; make() { ${build}; }`) }
    }

    it('generates configure, builds against the installed Dovecot and installs only the plugin', () => {
      const { root, result } = setup()
      expect(result.stdout.trim(), result.stderr).toBe('DONE')
      expect(existsSync(join(root, 'autoreconf--i'))).toBe(true)
      const [args, cflags, cxxflags] = readFileSync(join(root, 'configured'), 'utf8').trim().split('\n')
      expect(args).toBe('--with-dovecot=/usr/lib64/dovecot')
      expect(cflags).toContain('-fstack-protector-strong')
      expect(cxxflags).toBe(cflags)
      expect(readFileSync(join(root, 'module.so'), 'utf8')).toBe('plugin\n')
    })

    it('refuses a source whose digest differs before anything is unpacked or built', () => {
      const { root, result } = setup(undefined, 'a'.repeat(64))
      expect(result.stdout.trim().split('\n').at(-1)).toBe('DIE The Dovecot search index plugin could not be fetched, verified or built.')
      expect(existsSync(join(root, 'configured'))).toBe(false)
      expect(existsSync(join(root, 'module.so'))).toBe(false)
    })

    it('installs nothing when the build fails', () => {
      const { root, result } = setup('return 1')
      expect(result.stdout.trim().split('\n').at(-1)).toBe('DIE The Dovecot search index plugin could not be fetched, verified or built.')
      expect(existsSync(join(root, 'module.so'))).toBe(false)
    })
  })

  it('pins exact releases over HTTPS and builds only what EL repositories lack', () => {
    expect(functions).toMatch(/EL_WEBALIZER_URL="https:\/\/deb\.debian\.org\/debian\/pool\/main\/w\/webalizer\/webalizer_2\.23\.08\.orig\.tar\.gz"/)
    expect(functions).toMatch(/EL_WEBALIZER_SHA256="edaddb5aa41cc4a081a1500e3fa96615d4b41bc12086bcedf9938018ce79ed8d"/)
    expect(functions).toMatch(/EL_AWSTATS_URL="https:\/\/deb\.debian\.org\/debian\/pool\/main\/a\/awstats\/awstats_8\.0\.orig\.tar\.gz"/)
    expect(functions).toMatch(/EL_AWSTATS_SHA256="3ef76ff96c5398477dd8a11134e266e538a487067f6906a3ac8a38bfd11c11e0"/)
    expect(functions).toMatch(/EL_FTS_URL="https:\/\/deb\.debian\.org\/debian\/pool\/main\/d\/dovecot-fts-xapian\/dovecot-fts-xapian_1\.9\.3\.orig\.tar\.gz"/)
    expect(functions).toMatch(/EL_FTS_SHA256="b2ab1623d45d19f3086e8044957b1572d65659849ccc19bd6b276dac07f98df7"/)
    expect(functions).toContain('--proto =https')
    expect(source).toContain('if [[ "$OS_FAMILY" == "rhel" && "$WITH_MAIL" -eq 1 ]]; then\n  echo "[2a/6] Building the Dovecot search index plugin from its pinned upstream release..."\n  install_el_fts_xapian\n  record_el_source_build fts-xapian dovecot\nfi\n')
    const flow = source.slice(source.indexOf('Building the statistics engines EL repositories lack') - 60, source.indexOf('[2/6] Ensuring every bootable kernel'))
    expect(flow).toContain('if [[ "$OS_FAMILY" == "rhel" ]]; then')
    expect(flow).toContain('if [[ "$OS_MAJOR" -ge 10 ]]; then\n    install_el_awstats\n    record_el_source_build awstats')
    expect(flow).toContain('  install_el_webalizer\n  record_el_source_build webalizer\n')
    expect(source).toContain('  install_el_mpm_itk\n  record_el_source_build mpm-itk httpd\n')
  })
})

describe('log directory of the installer', () => {
  it('lets each account traverse /var/log/xpanel to its own PHP-FPM log directory without listing it', () => {
    const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8')
    const lines = source.split('\n').filter(line => /^install -d .*\/var\/log\/xpanel(\s|$)/.test(line))
    expect(lines).toEqual(['install -d -o xpanel -g xpanel -m 2751 /var/log/xpanel'])
  })
})

describe('empty DNS catalog of the installer', () => {
  it('writes the exact empty catalog the agent accepts as its reviewed bootstrap', () => {
    const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8')
    const start = source.indexOf('render_empty_named_catalog() {')
    const run = spawnSync(bash, ['-euo', 'pipefail', '-c', `${source.slice(start, source.indexOf('\n}\n', start) + 3)}\nrender_empty_named_catalog\n`], { encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toBe(renderNamedZonesConfig([]))
  })
})

describe('default certificate of the installer', () => {
  it('creates the self-signed pair the default site names once and keeps an existing pair', () => {
    const root = mkdtempSync(join(tempParent, tempPrefix))
    tempRoots.push(root)
    const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8')
    const start = source.indexOf('DEFAULT_TLS_DIR=/etc/xpanel/ssl/default')
    const functions = source.slice(start, source.indexOf('\n}\n', start) + 3)
      .replace('DEFAULT_TLS_DIR=/etc/xpanel/ssl/default', `DEFAULT_TLS_DIR=${root.replaceAll('\\', '/')}/default`)
    const stubs = 'die() { echo "DIE $*"; exit 1; }\ninstall() { mkdir -p "${@: -1}"; }\n'
    // MSYS_NO_PATHCONV keeps Git Bash on Windows from rewriting the /CN= subject into a path; a developer's
    // OPENSSL_CONF may name a configuration that does not exist, while installs run with the packaged one.
    const env: NodeJS.ProcessEnv = { ...process.env, MSYS_NO_PATHCONV: '1' }
    delete env.OPENSSL_CONF
    const run = () => spawnSync(bash, ['-euo', 'pipefail', '-c', `${stubs}${functions}\nensure_default_certificate\n`], { encoding: 'utf8', timeout: 30_000, env })
    const first = run()
    expect(first.status, first.stdout + first.stderr).toBe(0)
    const cert = readFileSync(join(root, 'default', 'fullchain.pem'), 'utf8')
    expect(cert).toContain('BEGIN CERTIFICATE')
    expect(readFileSync(join(root, 'default', 'privkey.pem'), 'utf8')).toContain('PRIVATE KEY')
    expect(run().status).toBe(0)
    expect(readFileSync(join(root, 'default', 'fullchain.pem'), 'utf8')).toBe(cert)
  })
})

describe('local mail directories of the installer', () => {
  it('leaves the Postfix private directory in Postfix layout, so its daemons can bind there', () => {
    const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8')
    const body = source.slice(source.indexOf('install_local_mail() {'), source.indexOf('\n}\n', source.indexOf('install_local_mail() {')))
    const lines = body.split('\n').filter(line => line.includes('/var/spool/postfix/private') && line.trim().startsWith('install '))
    expect(lines.map(line => line.trim())).toEqual(['install -d -o postfix -g root -m 0700 /var/spool/postfix/private'])
  })
})

describe('SELinux settings of the EL installer', () => {
  it('labels the management ports even when the base policy already names one, and types the OpenDKIM socket directory', () => {
    const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8')
    const functions = source.slice(source.indexOf('selinux_http_port() {'), source.indexOf('OS_FILE_SOURCE=""'))
    // Stubs record every call; port 2083 is already radsec_port_t in the EL base policy, so its -a fails.
    const stubs = [
      'die() { echo "DIE $*"; exit 1; }',
      'semanage() { echo "semanage $*"; if [[ "$1 $2" == "port -a" && "$*" == *" 2083" ]]; then return 1; fi; if [[ "$1 $2" == "fcontext -a" ]]; then return 1; fi; }',
      'setsebool() { echo "setsebool $*"; }', 'install() { echo "install $*"; }', 'restorecon() { echo "restorecon $*"; }',
      'semodule() { echo "semodule $*"; }', 'write_config() { echo "write_config $1"; "$2" | sed "s/^/  /"; }',
      'systemd-tmpfiles() { echo "systemd-tmpfiles $*"; }',
      'export -f semanage setsebool', `INSTALL_SOURCE_ROOT=${rootDir}`,
      'WITH_MAIL=1', 'WITH_DNS=1',
    ].join('\n')
    const run = spawnSync(bash, ['-euo', 'pipefail', '-c', `${stubs}\n${functions}\nconfigure_selinux\n`], { encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    const calls = run.stdout.trim().split('\n')
    expect(calls).toContain('semanage port -m -t http_port_t -p tcp 2083')
    for (const port of ['2087', '2096']) expect(calls).toContain(`semanage port -a -t http_port_t -p tcp ${port}`)
    expect(calls).toContain('setsebool -P httpd_can_network_connect 1')
    expect(calls).toContain("semanage fcontext -m -t httpd_log_t /var/log/xpanel(/.*)?")
    expect(calls).toContain('restorecon -R /var/log/xpanel')
    expect(calls).toContain('setsebool -P httpd_enable_homedirs 1')
    expect(calls.some(call => call.startsWith('semanage fcontext -m -t httpd_sys_rw_content_t /home/'))).toBe(true)
    expect(calls).toContain('semanage fcontext -a -e /var/lib/pdns /var/lib/powerdns')
    expect(calls).toContain('  d /run/xpanel-account-probe 0711 root root -')
    expect(calls).toContain('  (allow httpd_t unconfined_service_t (unix_stream_socket (connectto)))')
    expect(calls.indexOf('systemd-tmpfiles --create /etc/tmpfiles.d/xpanel-account-probe.conf')).toBeLessThan(calls.indexOf('restorecon -R /run/xpanel-account-probe'))
    expect(calls).toContain("semanage fcontext -m -t dkim_milter_data_t /var/spool/postfix/opendkim(/.*)?")
    expect(calls.indexOf('install -d -o opendkim -g postfix -m 0750 /var/spool/postfix/opendkim')).toBeLessThan(calls.indexOf('restorecon -R /var/spool/postfix/opendkim'))
    expect(calls).toContain('  (allow dkim_milter_t postfix_spool_t (dir (search getattr)))')
    expect(calls.indexOf('write_config /etc/xpanel/xpanel_opendkim.cil')).toBeLessThan(calls.indexOf('semodule -i /etc/xpanel/xpanel_opendkim.cil'))
  })
})

describe('OS profile configuration hand-over to the installer', () => {
  it.each(['ubuntu 22.04', 'almalinux 9.6'])('%s: lists files, exec argv and systemd steps of installConfiguration in plan order', release => {
    const [id, versionId] = release.split(' ')
    const root = mkdtempSync(join(tempParent, tempPrefix))
    tempRoots.push(root)
    const osRelease = `ID=${id}\nVERSION_ID="${versionId}"\nNAME="${id}"\n`
    writeFileSync(join(root, 'os-release'), osRelease)
    mkdirSync(join(root, 'out'))
    const run = spawnSync(process.execPath, [join(rootDir, 'scripts/install-os-configuration.mjs'), join(root, 'out'), join(root, 'os-release'), 'itk', '8.3', '1', '1', '1', '1', '0'], { encoding: 'utf8', timeout: 20_000 })
    expect(run.status, run.stderr).toBe(0)
    const options = { engine: 'apache' as const, apacheMpm: 'itk' as const, phpVersions: ['8.3'], withMail: true, withDns: true, withFtp: true, withMariaDb: true, withModSecurity: false }
    const profile = profileFor(osRelease)
    const { actions, files } = installConfiguration(profile, options)
    expect(installPlan(profile, options).slice(-actions.length)).toEqual(actions)
    const steps = run.stdout.trimEnd().split('\n').map(line => line.split('\t'))
    expect(steps).toEqual([
      ...files.map((file, n) => ['file', String(n), file.path, file.mode.toString(8).padStart(4, '0'), file.group]),
      ...actions.map((action, n) => action.kind === 'exec' ? ['exec', String(n), action.creates ?? '-'] : ['systemd', action.verb, action.unit]),
    ])
    files.forEach((file, n) => expect(readFileSync(join(root, 'out', `file-${n}`), 'utf8')).toBe(file.content))
    actions.forEach((action, n) => {
      if (action.kind === 'exec') expect(readFileSync(join(root, 'out', `exec-${n}`), 'utf8')).toBe(action.argv.map(arg => `${arg}\0`).join(''))
    })
  })
})

describe('kernel quota format detection in the installer', () => {
  it('lists all normal bootable kernels and finds quota_v2/quota_tree built in or as modules', () => {
    const root = mkdtempSync(join(tempParent, tempPrefix))
    tempRoots.push(root)
    const kernels: Record<string, Record<string, string>> = {
      'modular': { 'modules.dep': 'kernel/fs/quota/quota_v2.ko.zst: kernel/fs/quota/quota_tree.ko.zst\nkernel/fs/quota/quota_tree.ko.zst:\n' },
      'builtin': { 'modules.dep': '', 'modules.builtin': 'kernel/fs/quota/quota_v2.ko\nkernel/fs/quota/quota_tree.ko\n' },
      'rhs-only': { 'modules.dep': 'kernel/fs/ext4/ext4.ko.xz: kernel/fs/quota/quota_v2.ko.xz\nkernel/fs/quota/quota_tree.ko.xz:\n' },
      'rhs-both': { 'modules.dep': 'kernel/drivers/x.ko: kernel/fs/quota/quota_v2.ko\nkernel/drivers/y.ko: kernel/fs/quota/quota_tree.ko\n' },
      'no-colon': { 'modules.dep': 'kernel/fs/quota/quota_v2.ko\nkernel/fs/quota/quota_tree.ko:\n' },
      'virtual': { 'modules.dep': 'kernel/fs/ext4/ext4.ko.zst:\nkernel/fs/quota/quota_tree.ko.zst:\n' },
    }
    mkdirSync(join(root, 'boot'))
    for (const name of [...Object.keys(kernels), '0-rescue-abc']) writeFileSync(join(root, 'boot', `vmlinuz-${name}`), '')
    for (const [release, files] of Object.entries(kernels)) {
      mkdirSync(join(root, 'modules', release), { recursive: true })
      for (const [name, content] of Object.entries(files)) writeFileSync(join(root, 'modules', release, name), content)
    }
    const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8')
    const functions = source.slice(source.indexOf('kernel_lacks_quota_format() {'), source.indexOf('# Every bootable kernel gets the modules'))
    const fixture = root.replaceAll('\\', '/')
    const script = 'OS_FAMILY=rhel\ndie() { echo "$*" >&2; exit 1; }; assert_root_file() { if [[ "$1" == */modules.builtin ]]; then echo "guarded $1" >&2; fi; }\n'
      + functions.replaceAll('/lib/modules/', `${fixture}/modules/`).replaceAll('/boot/vmlinuz-', `${fixture}/boot/vmlinuz-`)
      + 'inventory="$(bootable_kernel_releases)" || exit 1\nwhile read -r release; do if kernel_lacks_quota_format "$release"; then echo "lacks $release"; else echo "has $release"; fi; done <<< "$inventory"\n'
    const run = spawnSync(bash, ['-euo', 'pipefail'], { input: script, encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout.trim().split('\n').sort()).toEqual(['has builtin', 'has modular', 'lacks no-colon', 'lacks rhs-both', 'lacks rhs-only', 'lacks virtual'])
    expect(run.stderr.trim().split('\n')).toHaveLength(1)
    expect(run.stderr.trim()).toMatch(/^guarded .*\/modules\/builtin\/modules\.builtin$/)
  })
  for (const scenario of ['read-error', 'guard-refusal', 'wrong-release-link', 'dangling-link', 'fifo'] as const) {
    const unixSpecial = !['read-error', 'guard-refusal'].includes(scenario)
    it.skipIf(unixSpecial && process.platform === 'win32')(`refuses an uncertain built-in index (${scenario})`, () => {
      const root = mkdtempSync(join(tempParent, tempPrefix)); tempRoots.push(root)
      const release = join(root, 'modules', 'target'), other = join(root, 'modules', 'other')
      mkdirSync(release, { recursive: true }); mkdirSync(other)
      const builtin = join(release, 'modules.builtin'), quota = 'kernel/fs/quota/quota_v2.ko\nkernel/fs/quota/quota_tree.ko\n'
      writeFileSync(join(release, 'modules.dep'), quota)
      if (scenario === 'wrong-release-link' || scenario === 'dangling-link') {
        if (scenario === 'wrong-release-link') writeFileSync(join(other, 'modules.builtin'), quota)
        symlinkSync('../other/modules.builtin', builtin)
      } else if (scenario === 'fifo') {
        expect(spawnSync('mkfifo', [builtin]).status).toBe(0)
      } else writeFileSync(builtin, '')
      const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8')
      const functions = source.slice(source.indexOf('kernel_lacks_quota_format() {'), source.indexOf('bootable_kernel_releases() {'))
      const fileGuard = source.slice(source.indexOf('assert_root_file() {'), source.indexOf('assert_pinned_runtime() {'))
      // Exercise the real regular/non-symlink check with synthetic root ownership and a real canonical fixture path.
      const script = 'die() { echo "$*" >&2; exit 1; }; assert_root_owned_path() { :; }\n'
        + 'stat() { if [[ $2 == %u ]]; then echo 0; else echo 644; fi; }\n' + fileGuard
        + (scenario === 'guard-refusal' ? 'stat() { if [[ $2 == %u && $4 == */modules.builtin ]]; then echo 1000; elif [[ $2 == %u ]]; then echo 0; else echo 644; fi; }\n' : '')
        + (scenario === 'read-error' ? 'cat() { command cat "$@"; return 5; }\n' : '')
        + functions.replaceAll('/lib/modules/', `${root.replaceAll('\\', '/')}/modules/`)
        + 'if kernel_lacks_quota_format target; then echo lacks; else echo has; fi\n'
      const run = spawnSync(bash, ['-euo', 'pipefail'], { input: script, encoding: 'utf8', timeout: 10_000 })
      expect(run.error).toBeUndefined()
      expect(run.status).toBe(1); expect(run.stdout).toBe('')
      expect(run.stderr).toContain(scenario === 'read-error' ? 'could not be read' : scenario === 'guard-refusal' ? 'not root-owned' : 'missing or symbolic')
    })
  }
  it.each(['empty', 'missing-index', 'ubuntu-rescue'])('fails closed for an unobservable boot inventory: %s', scenario => {
    const root = mkdtempSync(join(tempParent, tempPrefix)); tempRoots.push(root)
    mkdirSync(join(root, 'boot'))
    if (scenario !== 'empty') writeFileSync(join(root, 'boot', `vmlinuz-${scenario === 'ubuntu-rescue' ? '0-rescue-abc' : '6.8.0'}`), '')
    const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8'), fixture = root.replaceAll('\\', '/')
    const functions = source.slice(source.indexOf('kernel_lacks_quota_format() {'), source.indexOf('# Every bootable kernel gets the modules'))
    const script = 'OS_FAMILY=debian\ndie() { echo "$*" >&2; exit 1; }; assert_root_file() { :; }\n'
      + functions.replaceAll('/lib/modules/', `${fixture}/modules/`).replaceAll('/boot/vmlinuz-', `${fixture}/boot/vmlinuz-`)
      + 'inventory="$(bootable_kernel_releases)" || exit 1\necho "UNEXPECTED_ACCEPTANCE"\n'
    const run = spawnSync(bash, ['-euo', 'pipefail'], { input: script, encoding: 'utf8', timeout: 10_000 })
    expect(run.error).toBeUndefined()
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/No supported bootable kernel|bootable kernel has no observable/)
    expect(run.stdout).not.toContain('UNEXPECTED_ACCEPTANCE')
  })
  it.skipIf(process.platform === 'win32')('refuses a release directory aliased to another kernel tree', () => {
    const root = mkdtempSync(join(tempParent, tempPrefix)); tempRoots.push(root)
    mkdirSync(join(root, 'boot')); mkdirSync(join(root, 'modules', 'other'), { recursive: true })
    writeFileSync(join(root, 'boot', 'vmlinuz-6.8.0'), '')
    writeFileSync(join(root, 'modules', 'other', 'modules.dep'), '')
    symlinkSync('other', join(root, 'modules', '6.8.0'))
    const source = readFileSync(join(rootDir, 'scripts/install.sh'), 'utf8')
    const functions = source.slice(source.indexOf('kernel_lacks_quota_format() {'), source.indexOf('# Every bootable kernel gets the modules'))
    const program = 'OS_FAMILY=debian\ndie() { echo "$*" >&2; exit 1; }; assert_root_file() { :; }\n'
      + functions.replaceAll('/lib/modules/', `${root}/modules/`).replaceAll('/boot/vmlinuz-', `${root}/boot/vmlinuz-`)
      + 'bootable_kernel_releases\n'
    const run = spawnSync(bash, ['-euo', 'pipefail'], { input: program, encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stderr).toBe(1)
    expect(run.stderr).toContain('bootable kernel has no observable regular module index')
    expect(run.stdout).toBe('')
  })
})

describe('bootstrap package and repository parity with the declared OS profiles', () => {
  it.each(cases)('$id $versionId PHP $php optional services=$withServices', ({ id, name, versionId, php, withServices }) => {
    if (!existsSync(bash)) throw new Error('Bash is required for the bootstrap dry-run contract')
    const root = mkdtempSync(join(tempParent, tempPrefix))
    tempRoots.push(root)
    const release = `ID=${id}\nVERSION_ID=${versionId}\nNAME="${name}"\nPRETTY_NAME="${name} ${versionId}"\n`
    const osReleasePath = join(root, 'os-release')
    writeFileSync(osReleasePath, release)
    const profile = profileFor(release)
    // EL has no packaged itk. Explicit prefork is used for this pure package-plan
    // comparison only; the live installer's mandatory itk isolation gate is retained.
    const apacheMpm = profile.family === 'debian' ? 'itk' : 'prefork'
    const actions = installPlan(profile, {
      engine: 'apache', apacheMpm, phpVersions: [php],
      withMail: withServices, withDns: withServices, withFtp: withServices,
      withMariaDb: withServices, withModSecurity: withServices,
    })
    const args = [
      'scripts/install.sh', '--dry-run', `--os-release=${osReleasePath.replaceAll('\\', '/')}`,
      `--php=${php}`, `--apache-mpm=${apacheMpm}`,
      ...(withServices ? ['--with-mail', '--with-dns', '--with-ftp', '--with-mariadb', '--with-modsecurity'] : []),
    ]
    const run = spawnSync(bash, args, { cwd: rootDir, encoding: 'utf8', timeout: 10_000 })
    expect(run.error).toBeUndefined()
    expect(run.status, run.stderr).toBe(0)
    const actualPackages = [
      ...lineValues(run.stdout, 'Bootstrap Packages'),
      ...lineValues(run.stdout, 'Repository Packages'),
      ...lineValues(run.stdout, 'Package List      '),
    ]
    expect(sorted(actualPackages)).toEqual(sorted([
      ...packageInputs(actions), ...bootstrapExtras(profile.family, php),
    ]))
    // Zstandard backup archives need zstd(1) on every supported OS.
    expect(lineValues(run.stdout, 'Bootstrap Packages')).toContain('zstd')
    expect(profile.bootstrapPackages).toContain('zstd')
    // Web Disk (lighttpd mod_webdav) and calendars and contacts (the Radicale library) on every supported OS.
    const davPackages = profile.family === 'debian' ? ['lighttpd', 'lighttpd-mod-webdav', 'python3-radicale'] : ['lighttpd', 'lighttpd-mod_webdav', 'python3-radicale3']
    expect(lineValues(run.stdout, 'Package List      ')).toEqual(expect.arrayContaining(davPackages))
    expect([...profile.packages.webdav, ...profile.packages.caldav]).toEqual(davPackages)
    // The Compiler Access re-apply hook on EL runs through the dnf 4 post-transaction-actions plugin (EL 9 and 10 ship no dnf 5).
    if (profile.family === 'rhel') {
      expect(lineValues(run.stdout, 'Bootstrap Packages')).toContain('python3-dnf-plugin-post-transaction-actions')
      expect(profile.bootstrapPackages).toContain('python3-dnf-plugin-post-transaction-actions')
    }
    expect(sorted(lineValues(run.stdout, 'Repository Sources'))).toEqual(sorted(repositoryInputs(actions)))
    if (profile.family === 'rhel') {
      expect(run.stdout).toContain('Production preflight rejects this engine/MPM plan; Apache itk is required.')
    }
  })
})
