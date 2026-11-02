import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      'WITH_MAIL=1',
    ].join('\n')
    const run = spawnSync(bash, ['-euo', 'pipefail', '-c', `${stubs}\n${functions}\nconfigure_selinux\n`], { encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    const calls = run.stdout.trim().split('\n')
    expect(calls).toContain('semanage port -m -t http_port_t -p tcp 2083')
    for (const port of ['2087', '2096']) expect(calls).toContain(`semanage port -a -t http_port_t -p tcp ${port}`)
    expect(calls).toContain('setsebool -P httpd_can_network_connect 1')
    expect(calls).toContain("semanage fcontext -m -t httpd_log_t /var/log/xpanel(/.*)?")
    expect(calls).toContain('restorecon -R /var/log/xpanel')
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
  it('lists bootable kernels with a module tree and finds quota_v2/quota_tree built in or as modules', () => {
    const root = mkdtempSync(join(tempParent, tempPrefix))
    tempRoots.push(root)
    const kernels: Record<string, Record<string, string>> = {
      'modular': { 'modules.dep': 'kernel/fs/quota/quota_v2.ko.zst: kernel/fs/quota/quota_tree.ko.zst\nkernel/fs/quota/quota_tree.ko.zst:\n' },
      'builtin': { 'modules.dep': '', 'modules.builtin': 'kernel/fs/quota/quota_v2.ko\nkernel/fs/quota/quota_tree.ko\n' },
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
    const script = functions.replaceAll('/lib/modules/', `${fixture}/modules/`).replaceAll('/boot/vmlinuz-', `${fixture}/boot/vmlinuz-`)
      + 'while read -r release; do if kernel_lacks_quota_format "$release"; then echo "lacks $release"; else echo "has $release"; fi; done < <(bootable_kernel_releases)\n'
    const run = spawnSync(bash, ['-euo', 'pipefail', '-c', script], { encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout.trim().split('\n').sort()).toEqual(['has builtin', 'has modular', 'lacks virtual'])
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
    expect(sorted(lineValues(run.stdout, 'Repository Sources'))).toEqual(sorted(repositoryInputs(actions)))
    if (profile.family === 'rhel') {
      expect(run.stdout).toContain('Production preflight rejects this engine/MPM plan; Apache itk is required.')
    }
  })
})
