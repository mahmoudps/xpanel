import { describe, expect, it, vi } from 'vitest'
import type { HostJobCommandStep, HostJobStepResult } from './host-job-contract.ts'
import { buildPhpJobPlan, MANAGED_INI_NAME, parseManagedIni, previewPhpOperation, readPhpManagement, readPhpOperation, renderManagedIni } from './php-manager.ts'
import type { PhpManagerHost } from './php-manager.ts'
import { handlePhpManagerRoute } from './php-manager-routes.ts'

const dpkg = (names: string[]): string => names.map(name => `${name}\t${name.startsWith('php8.3') ? '8.3.6-0ubuntu0.24.04.5' : '8.4.14-1+ubuntu24.04.1+deb.sury.org+1'}\tinstall ok installed`).join('\n') + '\n'
const installed = ['php8.3-cli', 'php8.3-common', 'php8.3-fpm', 'php8.3-mysql', 'php8.3-opcache', 'php8.4-cli', 'php8.4-common', 'php8.4-fpm', 'lsphp83']
const aptInstall = 'Inst php8.2-fpm (8.2.29-1 ondrej:24.04 [amd64])\nInst php8.2-cli (8.2.29-1 ondrej:24.04 [amd64])\nConf php8.2-fpm (8.2.29-1 ondrej:24.04 [amd64])\n'
const aptRemove = 'Remv php8.4-fpm [8.4.14-1]\nRemv php8.4-cli [8.4.14-1]\nRemv php8.4-common [8.4.14-1]\n'

function fakeHost(over: Partial<PhpManagerHost> = {}) {
  const files = new Map<string, string>()
  const dirs = new Map<string, string[]>([
    ['/etc/php/8.3/mods-available', ['opcache.ini', 'mysqli.ini', 'pdo_mysql.ini', 'ctype.ini']],
    ['/etc/php/8.3/fpm/conf.d', ['10-opcache.ini', '20-mysqli.ini', '20-ctype.ini']],
    ['/etc/php/8.4/mods-available', ['opcache.ini']], ['/etc/php/8.4/fpm/conf.d', ['10-opcache.ini']],
  ])
  const staged = new Map<string, string>()
  const run = vi.fn(async (argv: readonly string[]) => {
    if (argv[0] === '/usr/bin/dpkg-query') return { ok: true, code: 0, stdout: dpkg(installed), stderr: '' }
    if (argv.includes('-s') && argv.includes('install')) return { ok: true, code: 0, stdout: aptInstall, stderr: '' }
    if (argv.includes('-s') && argv.includes('remove')) return { ok: true, code: 0, stdout: aptRemove, stderr: '' }
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected' }
  })
  const host: PhpManagerHost = {
    family: 'debian', phpPackages: version => [`php${version}-fpm`, `php${version}-cli`], phpFpmBinary: version => `/usr/sbin/php-fpm${version}`, phpIniFile: version => `/etc/php/${version}/fpm/php.ini`,
    run, readFile: async path => files.get(path) ?? null, listDir: async path => dirs.get(path) ?? null,
    writeStaged: async (path, content) => { staged.set(path, content) }, now: () => new Date('2026-10-29T00:00:00Z'), ...over,
  }
  return { host, files, dirs, staged, run }
}

describe('PHP management observation', () => {
  it('reads installed versions, enabled FPM modules and the managed drop-in with a revision', async () => {
    const { host, files } = fakeHost()
    files.set('/etc/php/8.3/fpm/conf.d/' + MANAGED_INI_NAME, renderManagedIni('8.3', { memory_limit: '256M' }))
    const view = await readPhpManagement(host)
    expect(view).toMatchObject({ state: 'read', family: 'debian', installable: ['7.4', '8.0', '8.1', '8.2'], capabilities: { extensions: true } })
    expect(view.revision).toMatch(/^[0-9a-f]{64}$/)
    const php83 = view.versions.find(item => item.version === '8.3')!
    expect(php83.packages).not.toContain('lsphp83')
    expect(php83.ini).toEqual({ memory_limit: '256M' })
    expect(php83.extensions.find(item => item.module === 'pdo_mysql')).toMatchObject({ installed: true, enabled: false })
    expect(php83.extensions.find(item => item.module === 'mysqli')).toMatchObject({ installed: true, enabled: true })
    expect(php83.extensions.find(item => item.module === 'redis')).toMatchObject({ installed: false, enabled: false, package: 'redis' })
  })

  it('reports a drop-in written outside xPanel instead of overwriting it', () => {
    expect(parseManagedIni(null)).toEqual({})
    expect(parseManagedIni('memory_limit = 1G\n')).toBeNull()
    expect(parseManagedIni(renderManagedIni('8.3', { memory_limit: '9999G' }))).toBeNull()
  })

  it('validates operations at the boundary', () => {
    expect(readPhpOperation({ operation: 'set-ini', version: '8.3', ini: { memory_limit: '512m' } })).toEqual({ operation: 'set-ini', version: '8.3', ini: { memory_limit: '512M' } })
    expect(() => readPhpOperation({ operation: 'set-ini', version: '8.3', ini: { disable_functions: '' } })).toThrow()
    expect(() => readPhpOperation({ operation: 'set-ini', version: '8.3', ini: { upload_max_filesize: '128M', post_max_size: '64M' } })).toThrow(/post_max_size/)
    expect(() => readPhpOperation({ operation: 'install-version', version: '9.9' })).toThrow()
    expect(() => readPhpOperation({ operation: 'set-extension', version: '8.3', extension: '../x', enabled: true })).toThrow()
    expect(() => readPhpOperation({ operation: 'install-version', version: '8.2', command: 'rm' })).toThrow()
  })
})

const ok = { ok: true, code: 0, stdout: '', stderr: '', timedOut: false }
const failed = { ok: false, code: 78, stdout: '', stderr: 'ERROR: failed to load configuration', timedOut: false }

describe('PHP management jobs', () => {
  it('installs a version from the profile package set, then checks php-fpm -t', async () => {
    const { host } = fakeHost()
    const observed = await readPhpManagement(host)
    const preview = await previewPhpOperation(host, { operation: 'install-version', version: '8.2' }, observed)
    expect(preview.state).toBe('ready')
    const plan = await buildPhpJobPlan(host, preview, observed)
    expect(plan.steps.map(step => step.argv)).toEqual([
      ['/usr/bin/apt-get', 'install', '-y', '-q', '--no-install-recommends', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', '--', 'php8.2-fpm', 'php8.2-cli'],
      ['/usr/sbin/php-fpm8.2', '-t'],
    ])
    expect(plan.policy(['/usr/bin/apt-get', 'install', '-y', '--', 'nmap'])).toBe(false)
    expect(plan.policy(plan.steps[1]!.argv)).toBe(true)
  })

  it('refuses a removal that reaches outside the version and an already installed install', async () => {
    const { host, run } = fakeHost()
    const observed = await readPhpManagement(host)
    expect((await previewPhpOperation(host, { operation: 'install-version', version: '8.3' }, observed)).reason).toBe('already-installed')
    run.mockImplementationOnce(async () => ({ ok: true, code: 0, stdout: aptRemove + 'Remv nginx-common [1.24]\n', stderr: '' }))
    expect((await previewPhpOperation(host, { operation: 'remove-version', version: '8.4' }, observed)).reason).toBe('removes-other-packages')
    const removal = await previewPhpOperation(host, { operation: 'remove-version', version: '8.4' }, observed)
    expect(removal.state).toBe('ready')
    expect((await buildPhpJobPlan(host, removal, observed)).steps[0]!.argv.slice(-3)).toEqual(['php8.4-cli', 'php8.4-common', 'php8.4-fpm'])
  })

  it('switches an extension, tests, reloads the version pools and reverts when php-fpm -t fails', async () => {
    const { host } = fakeHost()
    const observed = await readPhpManagement(host)
    const preview = await previewPhpOperation(host, { operation: 'set-extension', version: '8.3', extension: 'pdo_mysql', enabled: true }, observed)
    const plan = await buildPhpJobPlan(host, preview, observed)
    expect(plan.steps.map(step => step.argv)).toEqual([
      ['/usr/sbin/phpenmod', '-v', '8.3', '-s', 'fpm', 'pdo_mysql'], ['/usr/sbin/php-fpm8.3', '-t'], ['/usr/bin/systemctl', 'try-reload-or-restart', '--', 'xpanel-php-fpm-*-8.3.service'],
    ])
    const ran: string[][] = []
    const results: HostJobStepResult[] = [{ id: 'switch-extension', result: ok }, { id: 'test-config', result: failed }]
    const verdict = await plan.finalize!(async (step: HostJobCommandStep) => { ran.push([...step.argv]); return ok }, results)
    expect(ran).toEqual([['/usr/sbin/phpdismod', '-v', '8.3', '-s', 'fpm', 'pdo_mysql'], ['/usr/sbin/php-fpm8.3', '-t']])
    expect(verdict).toEqual({ ok: true, detail: { reverted: true, retested: true } })
    expect(await plan.finalize!(async () => ok, [{ id: 'switch-extension', result: ok }, { id: 'test-config', result: ok }, { id: 'reload-pools', result: ok }])).toEqual({ ok: true, detail: { reverted: false } })
  })

  it('stages php.ini values, installs them through the job and restores the previous file on failure', async () => {
    const { host, files, staged } = fakeHost()
    const path = '/etc/php/8.3/fpm/conf.d/' + MANAGED_INI_NAME
    files.set(path, renderManagedIni('8.3', { memory_limit: '256M' }))
    const observed = await readPhpManagement(host)
    const preview = await previewPhpOperation(host, { operation: 'set-ini', version: '8.3', ini: { memory_limit: '512M', display_errors: 'Off' } }, observed)
    expect(preview.ini).toEqual({ before: { memory_limit: '256M' }, after: { memory_limit: '512M', display_errors: 'Off' } })
    const plan = await buildPhpJobPlan(host, preview, observed)
    const [write, test] = plan.steps
    expect(write!.argv.slice(0, 8)).toEqual(['/usr/bin/install', '-m', '0644', '-o', 'root', '-g', 'root', '--'])
    expect(write!.argv.at(-1)).toBe(path)
    expect(staged.get(write!.argv.at(-2)!)).toContain('memory_limit = 512M')
    expect(test!.argv).toEqual(['/usr/sbin/php-fpm8.3', '-t'])
    const ran: string[][] = []
    await plan.finalize!(async step => { ran.push([...step.argv]); return ok }, [{ id: 'write-ini', result: ok }, { id: 'test-config', result: failed }])
    expect(staged.get(ran[0]!.at(-2)!)).toBe(files.get(path))
    expect(ran[0]!.at(-1)).toBe(path)
  })

  it('switches a Remi extension by renaming its php.d file, and renames it back when php-fpm -t fails', async () => {
    const remi = fakeHost({ family: 'rhel', phpIniFile: version => `/etc/opt/remi/php${version.replace('.', '')}/php.ini`, phpFpmBinary: () => '/opt/remi/php83/root/usr/sbin/php-fpm' })
    remi.dirs.set('/etc/opt/remi/php83/php.d', ['10-opcache.ini', '20-curl.ini', '40-redis.ini.disabled', '99-xpanel.ini'])
    const host = { ...remi.host, run: async (argv: readonly string[]) => argv[0] === '/usr/bin/rpm' ? { ok: true, code: 0, stdout: 'php83-php-fpm\t8.3.6-1.el9\tinstalled\nphp83-php-cli\t8.3.6-1.el9\tinstalled\n', stderr: '' } : { ok: false, code: 1, stdout: '', stderr: '' } }
    const observed = await readPhpManagement(host)
    expect(observed.capabilities.extensions).toBe(true)
    const php83 = observed.versions.find(item => item.version === '8.3')!
    expect(php83.extensions.find(item => item.module === 'curl')).toMatchObject({ enabled: true, file: '20-curl.ini' })
    expect(php83.extensions.find(item => item.module === 'redis')).toMatchObject({ enabled: false, file: '40-redis.ini.disabled' })
    const off = await buildPhpJobPlan(host, await previewPhpOperation(host, { operation: 'set-extension', version: '8.3', extension: 'curl', enabled: false }, observed), observed)
    expect(off.steps[0]!.argv).toEqual(['/usr/bin/mv', '-T', '--', '/etc/opt/remi/php83/php.d/20-curl.ini', '/etc/opt/remi/php83/php.d/20-curl.ini.disabled'])
    const on = await buildPhpJobPlan(host, await previewPhpOperation(host, { operation: 'set-extension', version: '8.3', extension: 'redis', enabled: true }, observed), observed)
    expect(on.steps[0]!.argv).toEqual(['/usr/bin/mv', '-T', '--', '/etc/opt/remi/php83/php.d/40-redis.ini.disabled', '/etc/opt/remi/php83/php.d/40-redis.ini'])
    const ran: string[][] = []
    await off.finalize!(async step => { ran.push([...step.argv]); return ok }, [{ id: 'switch-extension', result: ok }, { id: 'test-config', result: failed }])
    expect(ran[0]).toEqual(['/usr/bin/mv', '-T', '--', '/etc/opt/remi/php83/php.d/20-curl.ini.disabled', '/etc/opt/remi/php83/php.d/20-curl.ini'])
    expect(off.policy(['/usr/bin/mv', '-T', '--', '/etc/passwd', '/tmp/x'])).toBe(false)
  })
})

describe('PHP management agent routes', () => {
  const route = async (path: string, method: string, body: unknown, ctx: Parameters<typeof handlePhpManagerRoute>[3]) => {
    const url = new URL('http://agent.local' + path)
    return handlePhpManagerRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, ctx)
  }
  it('requires root, binds to the observed revision and submits a reviewed job', async () => {
    const { host } = fakeHost()
    const submitJob = vi.fn(async (plan: { kind: string }) => ({ id: 'job-1', kind: plan.kind }) as never)
    const ctx = { assertRoot: vi.fn(async () => ({ actor: 'root' })), host, submitJob }
    const read = await (await route('/host/php/manage', 'GET', undefined, ctx))!.json() as { revision: string; actions: { manage: boolean } }
    expect(read.actions.manage).toBe(true)
    await expect(route('/host/php/manage/apply', 'POST', { operation: 'install-version', version: '8.2', expectedRevision: '0'.repeat(64) }, ctx)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(submitJob).not.toHaveBeenCalled()
    const applied = await route('/host/php/manage/apply', 'POST', { operation: 'install-version', version: '8.2', expectedRevision: read.revision }, ctx)
    expect(applied!.status).toBe(202)
    expect(submitJob).toHaveBeenCalledOnce()
    expect(ctx.assertRoot).toHaveBeenCalledWith('host.php.manage.apply')
  })
  it('is truthfully unavailable without a native host', async () => {
    await expect(route('/host/php/manage', 'GET', undefined, { assertRoot: async () => ({ actor: 'root' }), host: null, submitJob: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await route('/host/other', 'GET', undefined, { assertRoot: async () => ({ actor: 'root' }), host: null, submitJob: null })).toBeNull()
  })
})
