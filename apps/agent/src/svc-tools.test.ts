import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_FPM } from '@xpanel/core'
import { edge, system } from '@xpanel/render'
import { clamscanHomeArgv, clamscanScopedArgv, isAntivirusJobCommand, readScopedScan } from '../../../packages/os/src/security-tools-command.ts'
import { isPearCommand, pearArgv, pearLibraryDir } from '../../../packages/os/src/pear-command.ts'
import { observeForkBomb, observeSmtpRestriction, observeTraceroute, nftHasSmtpRule } from './svc-host-access.ts'
import { checkInstalledRelease, createNightlyMaintenance } from './svc-nightly.ts'
import { renderSvcHost, shellAccounts } from './svc-reconcile.ts'
import { handleSvcRoute } from './svc-routes.ts'
import type { SvcRouteContext } from './svc-routes.ts'
import { buildPearPlan, buildPearSetupPlan, parsePearList, parsePearSearch } from './svc-pear.ts'
import { countMaxChildren } from './svc-php-fpm.ts'
import { effectiveFpm, fpmIniDefaults, SVC_DEFAULTS, SVC_PARSERS } from './svc-policy.ts'
import { forbiddenProcesses, runProcessKiller } from './svc-process-killer.ts'
import { addProcessSample, createProcessLogSampler, parseDbProcessCounts, parseProcessLog, processLogReport } from './svc-process-log.ts'
import { extractVendorArchive, installVendor, parseModsecAuditLog, parseVendorMetadata, svcWafInput } from './svc-waf.ts'
import { observeWebStatus, parseApacheAuto, parseApacheScoreboard, parseStubStatus } from './svc-web-status.ts'

const row = (over: Partial<Parameters<typeof forbiddenProcesses>[0][number]>) => ({ pid: 500, ppid: 1000, uid: 20001, user: 'alice', cpuPercent: 1, memoryPercent: 1, rssBytes: 1024, elapsedSeconds: 10, startedAt: '2026-11-07T00:00:00.000Z', stat: 'S', comm: 'eggdrop', ...over })
const accounts = [{ username: 'alice', uid: 20001 }, { username: 'bob', uid: 20002 }]
const self = { pid: 9000, ppid: 1 }

describe('background process killer', { tags: ['unit'] }, () => {
  it('stops a forbidden process of an untrusted account and leaves the same process of a trusted one', () => {
    const rows = [row({}), row({ pid: 501, uid: 20002, user: 'bob' })]
    const { targets, trustedSkipped } = forbiddenProcesses(rows, { names: ['eggdrop'], trustedUsers: ['bob'] }, accounts, self)
    expect(targets.map(item => item.pid)).toEqual([500])
    expect(trustedSkipped).toBe(1)
  })
  it('never touches system users, panel users or names off the list', () => {
    const rows = [row({ uid: 113, user: 'postfix' }), row({ pid: 502, comm: 'php-fpm' }), row({ pid: 503, uid: 0, user: 'root' })]
    expect(forbiddenProcesses(rows, { names: ['eggdrop'], trustedUsers: [] }, accounts, self).targets).toEqual([])
  })
  it('confirms a kill only when a second read no longer shows the process', async () => {
    const line = '500 1000 20001 alice 1.0 1.0 1024 10 S eggdrop'
    let reads = 0
    const killed: string[][] = []
    const run = async (argv: string[]) => {
      if (argv.includes('-9') || argv.includes('-KILL') || argv.some(item => item === 'KILL')) { killed.push(argv); return { ok: true, stdout: '', stderr: '' } }
      reads++
      return { ok: true, stdout: reads === 1 ? line + '\n' : line.replace('eggdrop', 'bash') + '\n', stderr: '' }
    }
    const result = await runProcessKiller({ run, policy: { enabled: true, names: ['eggdrop'], trustedUsers: [] }, accounts, self, trigger: 'manual', now: () => new Date('2026-11-07T10:00:00.000Z') })
    expect(result.state).toBe('completed')
    expect(result.killed).toEqual([{ pid: 500, user: 'alice', comm: 'eggdrop', outcome: 'confirmed' }])
    expect(killed).toHaveLength(1)
  })
  it('reports a run it could not read as unavailable, with nothing stopped', async () => {
    const result = await runProcessKiller({ run: async () => ({ ok: false, stdout: '', stderr: '' }), policy: { enabled: true, names: ['eggdrop'], trustedUsers: [] }, accounts, self, trigger: 'nightly' })
    expect(result).toMatchObject({ state: 'unavailable', killed: [] })
  })
})

describe('daily process log', { tags: ['unit'] }, () => {
  const at = new Date('2026-11-07T12:00:00.000Z')
  it('averages over the day and lists the top process, as the acceptance reads', () => {
    let file = addProcessSample({ days: [] }, { rows: [row({ cpuPercent: 90, comm: 'burn' })], accounts: [{ username: 'alice', uid: 20001, primaryDomain: 'a.test' }], dbProcesses: new Map([['alice', 2]]), at })
    file = addProcessSample(file, { rows: [], accounts: [], dbProcesses: new Map(), at })
    const report = processLogReport(file, '2026-11-07')!
    expect(report.samples).toBe(2)
    expect(report.users).toEqual([{ user: 'alice', domain: 'a.test', cpuPercent: 45, memoryPercent: 0.5, dbProcesses: 1 }])
    expect(report.top[0]).toEqual({ user: 'alice', domain: 'a.test', comm: 'burn', peakCpuPercent: 90 })
    expect(processLogReport(file, '2026-11-06')).toBeNull()
  })
  it('keeps two days and restarts on a damaged file', () => {
    let file = { days: [] } as ReturnType<typeof parseProcessLog>
    for (const day of ['05', '06', '07']) file = addProcessSample(file, { rows: [], accounts: [], dbProcesses: new Map(), at: new Date(`2026-11-${day}T12:00:00.000Z`) })
    expect(file.days.map(item => item.day)).toEqual(['2026-11-06', '2026-11-07'])
    expect(parseProcessLog('nonsense')).toEqual({ days: [] })
  })
  it('samples once per interval and counts database users by account prefix', async () => {
    let now = at.getTime(), writes = 0
    const sampler = createProcessLogSampler({ run: async () => ({ ok: true, stdout: '', stderr: '' }), accounts: async () => [], dbProcesses: async () => new Map(), read: async () => null, write: async () => { writes++ }, now: () => new Date(now) })
    await sampler.tick(); await sampler.tick()
    now += 5 * 60_000
    await sampler.tick()
    expect(writes).toBe(2)
    expect([...parseDbProcessCounts([{ user: 'alice_wp', count: 2 }, { user: 'alice', count: 1 }, { user: 'root', count: 4 }], new Set(['alice']))]).toEqual([['alice', 3]])
  })
})

describe('web server status', { tags: ['unit'] }, () => {
  const auto = 'ServerVersion: Apache/2.4.58\nServerMPM: prefork\nParentServerConfigGeneration: 3\nServerUptimeSeconds: 120\nTotal Accesses: 9\nCPULoad: .5\nBusyWorkers: 3\nIdleWorkers: 2\nScoreboard: WWW__\n'
  const worker = (slot: string, mode: string, request: string): string => `<tr><td><b>${slot}</b></td><td>1234</td><td>0/1/1</td><td><b>${mode}</b>\n</td><td>0.01</td><td>4</td><td>0</td><td>0</td><td>0.0</td><td>0.00</td><td>0.00\n</td><td>203.0.113.9</td><td>http/1.1</td><td nowrap>a.test:80</td><td nowrap>${request}</td></tr>`
  const html = `<table><tr><th>Srv</th></tr>${worker('0-0', 'W', 'GET /slow?a=1&amp;b=2 HTTP/1.1')}${worker('1-0', 'W', 'GET /two HTTP/1.1')}${worker('2-0', 'R', 'GET /three HTTP/1.1')}${worker('3-0', '_', '')}</table>`
  it('reads the summary and lists each busy worker with client, vhost and request', () => {
    expect(parseApacheAuto(auto)).toMatchObject({ serverVersion: 'Apache/2.4.58', busyWorkers: 3, cpuLoad: 0.5, generation: 3 })
    const workers = parseApacheScoreboard(html, '/.xpanel-status-x')
    expect(workers.map(item => [item.mode, item.client, item.vhost, item.request])).toEqual([
      ['sending', '203.0.113.9', 'a.test:80', 'GET /slow?a=1&b=2 HTTP/1.1'], ['sending', '203.0.113.9', 'a.test:80', 'GET /two HTTP/1.1'], ['reading', '203.0.113.9', 'a.test:80', 'GET /three HTTP/1.1']])
  })
  it('flags the status read itself as internal and never prints its secret path', () => {
    const own = worker('0-0', 'W', 'GET /.xpanel-status-x HTTP/1.1').replace('203.0.113.9', '127.0.0.1')
    expect(parseApacheScoreboard(own, '/.xpanel-status-x')[0]).toMatchObject({ internal: true, request: null })
  })
  it('stays truthful when another engine or a missing module answers', async () => {
    const get = async () => ({ status: 404, body: '' })
    expect((await observeWebStatus({ engine: 'openlitespeed', backendPort: 8081, statusPath: '/s', nginxSocket: '/x', get })).apache.state).toBe('unsupported_engine')
    expect((await observeWebStatus({ engine: 'apache', backendPort: 8081, statusPath: '/s', nginxSocket: '/x', get })).apache).toMatchObject({ state: 'unavailable', reason: 'status_module_unavailable' })
  })
  it('reads nginx stub_status', () => {
    expect(parseStubStatus('Active connections: 2 \nserver accepts handled requests\n 16 16 31 \nReading: 0 Writing: 1 Waiting: 1 \n')).toMatchObject({ activeConnections: 2, requests: 31, waiting: 1 })
    expect(parseStubStatus('nope')).toBeNull()
  })
  it('renders the status path only into a root-readable include', () => {
    const os = { paths: { apacheVhostDir: '/etc/apache2/sites-enabled', nginxVhostDir: '/etc/nginx/conf.d' } } as unknown as Parameters<typeof edge.renderApacheStatus>[0]
    const file = edge.renderApacheStatus(os, 'a'.repeat(64))
    expect(file.mode).toBe(0o640)
    expect(file.content).toContain('Require local')
    expect(() => edge.webStatusPath('../etc')).toThrow()
  })
})

describe('host access tools', { tags: ['unit'] }, () => {
  it('shows a mode changed behind the panel as drift', async () => {
    const stat = async (path: string) => path === '/usr/bin/traceroute.db' ? { regular: true, mode: 0o755, uid: 0 } : null
    expect((await observeTraceroute({ allowed: false, stat })).state).toBe('drift')
    expect((await observeTraceroute({ allowed: true, stat })).state).toBe('applied')
    expect((await observeTraceroute({ allowed: null, stat })).state).toBe('unmanaged')
    expect((await observeTraceroute({ allowed: false, stat: async () => null })).state).toBe('not_installed')
  })
  it('never follows a symlink, and restricts to root only when blocked', () => {
    const script = system.renderTracerouteAccess(false).file.content
    expect(script).toContain('[ ! -L "$f" ]')
    expect(script).toContain('chmod 0700')
    expect(system.renderTracerouteAccess(true).file.content).toContain('chmod 0755')
  })
  it('reports the SMTP rule from the kernel, not from the saved switch', async () => {
    const running = JSON.stringify({ nftables: [{ rule: { comment: system.SMTP_RESTRICTION_COMMENT } }] })
    const present = async () => true
    expect(nftHasSmtpRule(running)).toBe(true)
    expect(await observeSmtpRestriction({ enabled: true, run: async () => ({ ok: true, code: 0, stdout: running }), present })).toMatchObject({ application: 'applied', active: true })
    expect(await observeSmtpRestriction({ enabled: true, run: async () => ({ ok: true, code: 0, stdout: '{"nftables":[]}' }), present })).toMatchObject({ application: 'drift', active: false })
    expect(await observeSmtpRestriction({ enabled: true, run: async () => ({ ok: false, code: 1, stdout: '' }), present })).toMatchObject({ application: 'unavailable', active: null })
  })
  it('renders fork bomb limits per shell user and refuses to claim them without pam_limits', async () => {
    const file = system.renderForkBombLimits(['bob', 'alice'])
    expect(file.content).toContain('alice - nproc 35')
    expect(file.content).not.toContain('root')
    const readText = async (path: string) => path === system.FORK_BOMB_LIMITS_FILE ? file.content : path === '/etc/pam.d/sshd' ? 'session required pam_limits.so\n' : null
    expect((await observeForkBomb({ enabled: true, users: ['alice', 'bob'], readText })).application).toBe('applied')
    expect((await observeForkBomb({ enabled: true, users: ['alice'], readText })).application).toBe('drift')
    const noPam = async (path: string) => path === system.FORK_BOMB_LIMITS_FILE ? file.content : path === '/etc/pam.d/sshd' ? 'session required pam_loginuid.so\n' : null
    expect((await observeForkBomb({ enabled: true, users: ['alice', 'bob'], readText: noPam })).application).toBe('pam_missing')
    const noUsePam = async (path: string) => path === '/etc/ssh/sshd_config' ? 'UsePAM no' : await readText(path)
    expect((await observeForkBomb({ enabled: true, users: ['alice', 'bob'], readText: noUsePam })).application).toBe('pam_missing')
  })
})

describe('antivirus scope', { tags: ['unit'] }, () => {
  const all = { home: true, mail: true, publicFtp: true, publicWeb: true }
  it('scans the whole home unchanged and leaves mail out only for the user who turned it off', () => {
    expect(clamscanScopedArgv('/home/alice', all)).toEqual(clamscanHomeArgv('/home/alice'))
    const off = clamscanScopedArgv('/home/alice', { ...all, mail: false })
    expect(off).toContain('--exclude-dir=^/home/alice/mail(/|$)')
    expect(clamscanScopedArgv('/home/bob', all).join(' ')).not.toContain('exclude-dir')
  })
  it('scans only the chosen areas when the whole home is off, and refuses an empty scope', () => {
    expect(clamscanScopedArgv('/home/alice', { home: false, mail: false, publicFtp: false, publicWeb: true }).at(-1)).toBe('/home/alice/public_html')
    expect(() => clamscanScopedArgv('/home/alice', { home: false, mail: false, publicFtp: false, publicWeb: false })).toThrow()
  })
  it('admits exactly what it builds and reads it back', () => {
    for (const scope of [all, { ...all, mail: false }, { home: false, mail: true, publicFtp: false, publicWeb: true }, { home: false, mail: true, publicFtp: false, publicWeb: false }]) {
      const argv = clamscanScopedArgv('/home/alice', scope)
      expect(isAntivirusJobCommand(argv)).toBe(true)
      expect(readScopedScan(argv.slice(clamscanHomeArgv('/home/alice').length - 1))).toEqual({ target: '/home/alice', scope })
    }
    expect(isAntivirusJobCommand([...clamscanHomeArgv('/home/alice'), '/etc'])).toBe(false)
    expect(isAntivirusJobCommand(clamscanHomeArgv('/home/alice').with(-1, '--exclude-dir=.*'))).toBe(false)
  })
})

describe('PHP-FPM defaults', { tags: ['unit'] }, () => {
  const defaults = { pool: { ...DEFAULT_FPM, maxRequests: 800, maxChildren: 12 }, ini: { ...SVC_DEFAULTS['php-fpm-defaults'].ini, allow_url_fopen: { value: 'Off', locked: true } } }
  it('applies to a domain on the release values and leaves one with its own values', () => {
    expect(effectiveFpm({ ...DEFAULT_FPM }, defaults, 'unlimited').maxRequests).toBe(800)
    expect(effectiveFpm({ ...DEFAULT_FPM, maxRequests: 90 }, defaults, 'unlimited').maxRequests).toBe(90)
    expect(effectiveFpm({ ...DEFAULT_FPM }, null, 'unlimited')).toEqual(DEFAULT_FPM)
  })
  it('stays within the plan worker cap', () => {
    expect(effectiveFpm({ ...DEFAULT_FPM }, defaults, 2)).toMatchObject({ maxChildren: 2, maxSpareServers: 2, startServers: 2 })
  })
  it('refuses max children outside 1 to 10000', () => {
    for (const maxChildren of [0, 10001]) expect(() => SVC_PARSERS['php-fpm-defaults']({ pool: { ...DEFAULT_FPM, maxChildren }, ini: SVC_DEFAULTS['php-fpm-defaults'].ini })).toThrow()
    expect(fpmIniDefaults(defaults)).toEqual([{ key: 'allow_url_fopen', value: 'Off', locked: true }])
  })
  it('counts max children hits', () => {
    expect(countMaxChildren('[07-Nov-2026 10:00:00] WARNING: [pool u] server reached pm.max_children setting (4), consider raising it\nother\n')).toEqual({ hits: 1, last: '07-Nov-2026 10:00:00' })
  })
})

describe('PEAR per PHP version', { tags: ['unit'] }, () => {
  const php = '/usr/bin/php8.3', cmd = '/usr/share/php/pearcmd.php'
  it('gives each version its own library', () => {
    expect(pearArgv(php, cmd, '8.3', 'list')).toContain('php_dir=' + pearLibraryDir('8.3'))
    expect(pearLibraryDir('8.2')).not.toBe(pearLibraryDir('8.3'))
  })
  it('admits only the exact argv it builds', () => {
    expect(isPearCommand(pearArgv(php, cmd, '8.3', 'install', 'Mail'))).toBe(true)
    const shifted = pearArgv(php, cmd, '8.3', 'install', 'Mail')
    shifted[3] = 'php_dir=/etc'
    expect(isPearCommand(shifted)).toBe(false)
    expect(isPearCommand([php, '/tmp/evil.php'])).toBe(false)
    expect(() => pearArgv(php, cmd, '8.3', 'install', '--force')).toThrow()
  })
  it('parses the channel tables', () => {
    expect(parsePearList('Installed packages, channel pear.php.net:\n=====\nPackage Version State\nMail    1.5.0   stable\n')).toEqual([{ name: 'Mail', version: '1.5.0', state: 'stable' }])
    expect(parsePearList('(no packages installed from channel pear.php.net)\n')).toEqual([])
    expect(parsePearSearch('Matched packages, channel pear.php.net:\nMail    1.5.0 (stable)  Class that provides mail\nOld_Pkg  -n/a-   retired\n')).toEqual([{ name: 'Mail', version: '1.5.0', summary: 'Class that provides mail' }])
  })
  it('installs the distribution package for a version and proves it by the file', async () => {
    const plan = buildPearSetupPlan({ family: 'debian', present: async () => false }, '8.3')
    expect(plan.steps[0]!.argv.at(-1)).toBe('php-pear')
    expect(plan.policy(plan.steps[0]!.argv)).toBe(true)
    expect((await plan.verify!(async () => ({ ok: true, code: 0, stdout: '', stderr: '' }) as never)).ok).toBe(false)
    expect(buildPearSetupPlan({ family: 'rhel', present: async () => true }, '8.3').steps[0]!.argv.at(-1)).toBe('php83-php-pear')
  })
  it('runs a change as a mutating job under its own policy', () => {
    const plan = buildPearPlan({ family: 'debian', phpBinary: () => php }, { version: '8.3', operation: 'install', name: 'Mail' })
    expect(plan.policy(plan.steps[0]!.argv)).toBe(true)
  })
})

describe('WAF rules and vendors', { tags: ['unit'] }, () => {
  const rule = 'SecRule REQUEST_URI "@contains /blocked" "id:1001,phase:1,deny,status:403,msg:\'blocked\'"'
  const stored = { id: 1001, text: rule, note: 'test', enabled: true }
  it('accepts a local rule and refuses what could run a program or read other files', () => {
    expect(edge.modsecRuleProblem(rule)).toBeNull()
    for (const bad of ['Include /etc/passwd', 'SecRule ARGS "@rx x" "id:1,exec:/bin/sh"', 'SecRuleScript /x.lua', 'SecRule FILES "@inspectFile /x" "id:2"', 'SecAuditLog /tmp/x', 'SecRemoteRules key https://x']) expect(edge.modsecRuleProblem(bad)).not.toBeNull()
    expect(edge.modsecRuleProblem('LoadModule x y')).toBe('unsupported_directive')
    expect(edge.modsecRuleProblem('SecRule ARGS "@rx x" \\\n  "id:3,deny"')).toBeNull()
  })
  it('binds a rule to its id', () => {
    const parse = SVC_PARSERS['waf-rules']
    expect(() => parse({ engine: 'On', deployedEngine: 'inherit', staged: [{ ...stored, id: 7 }], deployed: [] })).toThrow()
    expect(() => parse({ engine: 'On', deployedEngine: 'inherit', staged: [stored, stored], deployed: [] })).toThrow()
    expect(parse({ engine: 'On', deployedEngine: 'inherit', staged: [stored], deployed: [] })).toMatchObject({ staged: [stored] })
  })
  it('keeps a staged rule out of the generated configuration until it is deployed', async () => {
    const list = async () => []
    expect((await svcWafInput({ engine: 'On', deployedEngine: 'inherit', staged: [stored], deployed: [] }, SVC_DEFAULTS['waf-vendors'], null, list)).customRules).toBeUndefined()
    const live = await svcWafInput({ engine: 'On', deployedEngine: 'On', staged: [stored], deployed: [stored] }, SVC_DEFAULTS['waf-vendors'], null, list)
    expect(live).toMatchObject({ customRules: [rule], ruleEngine: 'On' })
    expect(edge.renderModsecurityCustomRules(live.customRules ?? [])?.content).toContain(rule)
  })
  it('drops only the disabled file of a vendor from the generated includes', async () => {
    const vendor = { id: 'acme', name: 'Acme', description: '', docsUrl: null, metadataUrl: 'https://x.test/m', archiveSha256: 'a'.repeat(64), version: '1', enabled: true, autoUpdate: false, disabledFiles: ['b.conf'] }
    const input = await svcWafInput(SVC_DEFAULTS['waf-rules'], { crsDisabledFiles: ['REQUEST-1.conf'], vendors: [vendor] }, '/crs', async dir => dir === '/crs/rules' ? ['REQUEST-1.conf', 'REQUEST-2.conf'] : ['a.conf', 'b.conf'])
    const main = edge.renderModsecurityMain({ engineConf: '/etc/modsecurity/modsecurity.conf', crsDir: '/crs', ...input }).content
    expect(main).toContain('/vendors/acme/a.conf')
    expect(main).not.toContain('b.conf')
    expect(main).toContain('rules/REQUEST-2.conf')
    expect(main).not.toContain('REQUEST-1.conf')
  })
  it('reads the most relevant message of a hit, with its rule id', () => {
    const entry = { transaction: { client_ip: '203.0.113.9', time_stamp: 'now', request: { method: 'GET', uri: '/blocked', headers: { Host: 'a.test' } }, response: { http_code: 403 }, messages: [{ message: 'low', details: { ruleId: '9', severity: '5' } }, { message: 'blocked', details: { ruleId: '1001', severity: '2' } }] } }
    expect(parseModsecAuditLog('torn line}\n' + JSON.stringify(entry) + '\n')[0]).toMatchObject({ ruleId: 1001, message: 'blocked', clientIp: '203.0.113.9', uri: '/blocked', disruptive: true })
  })
  const tarOf = (files: Record<string, string>, type = '0'): Buffer => {
    const blocks: Buffer[] = []
    for (const [name, content] of Object.entries(files)) {
      const header = Buffer.alloc(512)
      header.write(name, 0); header.write(Buffer.byteLength(content).toString(8).padStart(11, '0'), 124); header.write(type, 156)
      const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512); body.write(content)
      blocks.push(header, body)
    }
    return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
  }
  it('accepts only regular rule files and refuses traversal and rules that run programs', () => {
    expect([...extractVendorArchive(tarOf({ 'pack/rules/a.conf': rule, 'pack/README.md': 'x', 'pack/a.data': 'word' })).keys()]).toEqual(['a.conf', 'a.data'])
    expect(() => extractVendorArchive(tarOf({ '../evil.conf': rule }))).toThrow()
    expect(() => extractVendorArchive(tarOf({ 'a.conf': 'SecRule ARGS "@rx x" "id:1,exec:/bin/sh"' }))).toThrow()
    expect(() => extractVendorArchive(tarOf({ 'readme.txt': 'x' }))).toThrow()
    expect(() => extractVendorArchive(Buffer.from('not gzip'))).toThrow()
  })
  it('refuses an archive that does not match its pinned digest, before writing anything', async () => {
    const archive = tarOf({ 'a.conf': rule }), writes: string[] = []
    const metadata = { format: 'xpanel-waf-vendor/1', id: 'acme', name: 'Acme', version: '1.0', archiveUrl: 'https://x.test/a.tgz', archiveSha256: createHash('sha256').update(archive).digest('hex') }
    const get = (body: Buffer) => async (url: string) => url.endsWith('.tgz') ? body : Buffer.from(JSON.stringify(metadata))
    const host = { writeFile: async (file: { path: string }) => { writes.push(file.path) }, removePath: async () => {} }
    await expect(installVendor('https://x.test/m.json', host, get(Buffer.from('other')))).rejects.toThrow()
    expect(writes).toEqual([])
    expect((await installVendor('https://x.test/m.json', host, get(archive))).files).toEqual(['a.conf'])
    expect(writes).toEqual(['/etc/xpanel/modsecurity/vendors/acme/a.conf'])
    expect(() => parseVendorMetadata({ ...metadata, archiveUrl: 'http://x.test/a.tgz' })).toThrow()
  })
})

describe('services host routes', { tags: ['unit'] }, () => {
  const ctx = (over: Partial<SvcRouteContext> = {}): SvcRouteContext => ({ assertRoot: async () => ({ actor: 'root' }), executor: null, family: null, phpBinary: null, rootDir: '/nonexistent', accounts: async () => [], fpmPools: async () => [], server: async () => null, webStatusPath: null, submitJob: null, ...over })
  const call = (path: string, over?: Partial<SvcRouteContext>, method = 'GET') => { const req = new Request('http://agent.local' + path, { method }); return handleSvcRoute(req, new URL(req.url), method, ctx(over)) }
  it('reports no source builds on Debian without reading rpm', async () => {
    const executor = { runCommand: async () => { throw new Error('rpm read') } } as never
    expect(await (await call('/host/svc/source-builds', { executor, family: 'debian' }))!.json()).toEqual({ hook: false, modules: [] })
  })
  it('ignores other paths and asks for root before anything else', async () => {
    expect(await call('/host/other')).toBeNull()
    await expect(call('/host/svc/traceroute', { assertRoot: async () => { throw new Error('denied') } })).rejects.toThrow('denied')
  })
  it('refuses without the native executor, so nothing is simulated', async () => {
    await expect(call('/host/svc/web-status')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('keeps a manual run in the report history', async () => {
    const written: unknown[] = []
    const executor = { runCommand: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }) } as never
    const response = await call('/host/svc/process-killer/run', { executor, readReports: async () => null, writeReports: async value => { written.push(value) } }, 'POST')
    expect(response!.status).toBe(200)
    expect(written).toMatchObject([{ runs: [{ trigger: 'manual', state: 'completed', killed: [] }] }])
  })
  it('holds to one method per route', async () => {
    expect((await call('/host/svc/traceroute', {}, 'POST'))!.status).toBe(405)
  })
})

describe('pool rendering', { tags: ['unit'] }, () => {
  const account = { id: 'a', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', status: 'active' } as never
  const os = { family: 'debian', paths: { apacheUser: 'www-data', phpLibDir: '/usr/share/php' }, phpFpmBinary: () => '/usr/sbin/php-fpm8.3', phpBinary: () => '/usr/bin/php8.3' } as never
  const php = (ini: Record<string, string>) => ({ version: '8.3', handler: 'fpm', fpm: { ...DEFAULT_FPM }, ini }) as never
  it('gives a locked default the last word and lets a domain override an open one', () => {
    const iniDefaults = [{ key: 'short_open_tag', value: 'Off', locked: true }, { key: 'log_errors', value: 'On', locked: false }]
    const content = edge.renderFpmPool(account, php({ short_open_tag: 'On', log_errors: 'Off' }), os, { iniDefaults }).content
    expect(content).toContain('php_admin_flag[short_open_tag] = off')
    expect(content).not.toContain('php_value[short_open_tag]')
    expect(content).toContain('php_value[log_errors] = Off')
    expect(content).not.toContain('php_value[log_errors] = On')
  })
  it('adds the PEAR library of the pool version to its include path and open_basedir only', () => {
    const library = pearLibraryDir('8.3')
    const content = edge.renderFpmPool(account, php({}), os, { pearLibrary: library }).content
    expect(content).toContain(library)
    expect(content).toMatch(/open_basedir\] = .*\/usr\/share\/xpanel\/pear\/8\.3\/php/)
    expect(edge.renderFpmPool(account, php({}), os).content).not.toContain('pear')
  })
})

describe('saved tools in a generation', { tags: ['unit'] }, () => {
  const os = { paths: { apacheVhostDir: '/etc/apache2/sites-enabled', nginxVhostDir: '/etc/nginx/conf.d' } } as never
  const off = { webdiskTls: null, tracerouteAllowed: null, smtpRestricted: false, forkBombUsers: null, webStatusToken: null, phpFpm: null, wafCustomRules: [], pearLibraries: {} }
  it('renders nothing for tools left off, so their files leave with the generation', () => {
    expect(renderSvcHost(os, off, true)).toEqual({ files: [], actions: [] })
  })
  it('renders each saved tool and reapplies traceroute on every reconcile', () => {
    const { files, actions } = renderSvcHost(os, { ...off, tracerouteAllowed: false, forkBombUsers: ['alice'], webStatusToken: 'a'.repeat(64), wafCustomRules: ['SecAction "id:7,pass"'] }, true)
    expect(files.map(file => file.path)).toEqual([system.TRACEROUTE_ACCESS_SCRIPT, system.FORK_BOMB_LIMITS_FILE, '/etc/nginx/conf.d/000-xpanel-status.conf', '/etc/apache2/sites-enabled/000-xpanel-status.conf', edge.modsecCustomRulesPath])
    expect(actions).toEqual([{ kind: 'exec', argv: [system.TRACEROUTE_ACCESS_SCRIPT] }])
  })
  it('counts only shell accounts under fork bomb protection', () => {
    expect(shellAccounts([{ username: 'a', status: 'active', shell: 'jailed' }, { username: 'b', status: 'active', shell: 'none' }, { username: 'c', status: 'terminating', shell: 'jailed' }] as never)).toEqual(['a'])
  })
})

describe('nightly maintenance', { tags: ['unit'] }, () => {
  it('runs once per UTC day after 02:00 and keeps going when a task fails', async () => {
    let state: { day: string | null } = { day: null }, now = new Date('2026-11-07T01:59:00.000Z')
    const ran: string[] = []
    const nightly = createNightlyMaintenance({ now: () => now, readState: async () => state, writeState: async next => { state = next }, readTweaks: async () => ({ 'support.updateLogRetentionDays': 90 }),
      runProcessKiller: async () => { ran.push('killer'); throw new Error('x') }, pruneJobs: async before => { ran.push('prune:' + before.toISOString().slice(0, 10)) }, updateWafVendors: async () => { ran.push('vendors') }, checkRelease: async () => { ran.push('check') } })
    await nightly.tick()
    expect(ran).toEqual([])
    now = new Date('2026-11-07T02:01:00.000Z')
    await nightly.tick(); await nightly.tick()
    expect(ran).toEqual(['killer', 'prune:2026-08-09', 'vendors', 'check'])
  })
  it('honours switched off retention and file checks', async () => {
    const ran: string[] = []
    await createNightlyMaintenance({ now: () => new Date('2026-11-07T03:00:00.000Z'), readState: async () => ({ day: null }), writeState: async () => {}, readTweaks: async () => ({ 'support.updateLogRetentionDays': null, 'software.nightlyPackageCheck': false }),
      runProcessKiller: async () => {}, pruneJobs: async () => { ran.push('prune') }, updateWafVendors: async () => {}, checkRelease: async () => { ran.push('check') } }).tick()
    expect(ran).toEqual([])
  })
  it('reports files that differ from the release manifest, and an unreadable manifest as unavailable', async () => {
    expect((await checkInstalledRelease('/nonexistent/release')).state).toBe('unavailable')
    const root = await mkdtemp(join(tmpdir(), 'xp-release-'))
    try {
      const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
      await writeFile(join(root, 'same.txt'), 'same'); await writeFile(join(root, 'changed.txt'), 'edited')
      const files = [{ path: 'same.txt', sha256: sha('same') }, { path: 'changed.txt', sha256: sha('original') }, { path: 'gone.txt', sha256: sha('gone') }]
      await writeFile(join(root, 'release-manifest.json'), JSON.stringify({ version: '0.1.31', files }))
      expect(await checkInstalledRelease(root)).toMatchObject({ state: 'modified', release: '0.1.31', checked: 3, modified: ['changed.txt'], missing: ['gone.txt'] })
      await writeFile(join(root, 'release-manifest.json'), JSON.stringify({ version: '0.1.31', files: files.slice(0, 1) }))
      expect(await checkInstalledRelease(root)).toMatchObject({ state: 'clean', checked: 1 })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
