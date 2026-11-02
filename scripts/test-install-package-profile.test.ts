import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installPlan, profileFor, SUPPORTED_OS } from '../packages/os/src/index.ts'
import type { InstallAction } from '../packages/os/src/index.ts'

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
