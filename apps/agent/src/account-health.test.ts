import { describe, expect, it, vi } from 'vitest'
import { defaultPlan } from '@xpanel/core'
import type { Account, Certificate, Domain, FeatureList, Reseller, ServiceUser } from '@xpanel/core'
import { accountHealthPasswdArgv, evaluateAccountHealth, handleAccountHealthRoute } from './account-health.ts'
import type { AccountHealthCaller, AccountHealthHost, AccountHealthState, HealthCheck, HomeStat } from './account-health.ts'

const NOW = new Date('2026-10-27T10:00:00.000Z')
const plan = defaultPlan({ id: 'plan-1', name: 'Standard', featureListId: 'features-1' })
const features: FeatureList = { id: 'features-1', name: 'Default', ownerId: null, disabled: [] }
const reseller: Reseller = { id: 'reseller-1', username: 'resell', acl: ['list-accounts'], maxAccounts: 5, totalDiskMb: 'unlimited', totalBandwidthMb: 'unlimited', oversell: true, nameservers: [], delegatedIps: [] }
const account = (username: string, overrides: Partial<Account> = {}): Account => ({ id: 'id-' + username, username, uid: 20001, gid: 20001, home: '/home/' + username, primaryDomain: username + '.example.test', planId: plan.id,
  ownerId: 'reseller-1', status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-01-01T00:00:00.000Z', ...overrides })
const domain = (owner: Account, overrides: Partial<Domain> = {}): Domain => ({ id: 'domain-' + owner.username, accountId: owner.id, name: owner.primaryDomain, kind: 'primary', parentId: null, docRoot: owner.home + '/public_html', siteType: 'php',
  upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 5, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: 'cert-' + owner.username, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ...overrides })
const certificate = (owner: Account, overrides: Partial<Certificate> = {}): Certificate => ({ id: 'cert-' + owner.username, accountId: owner.id, names: [owner.primaryDomain, 'www.' + owner.primaryDomain], source: 'acme', challenge: 'http-01', notAfter: '2027-01-20T00:00:00.000Z', autoRenew: true, ...overrides })
const mailbox = (owner: Account, index: number): ServiceUser => ({ id: `mail-${owner.username}-${index}`, accountId: owner.id, login: `m${index}@${owner.primaryDomain}`, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: '' })
const alice = account('alice'), bob = account('bob', { uid: 20002, gid: 20002, ownerId: null })
const state = (overrides: Partial<AccountHealthState> = {}): AccountHealthState => ({ accounts: [alice, bob], plans: [plan], featureLists: [features], resellers: [reseller],
  domains: [domain(alice), domain(bob)], serviceUsers: [mailbox(alice, 1)], certificates: [certificate(alice), certificate(bob)],
  zones: [{ name: 'alice.example.test' }, { name: 'bob.example.test' }], server: { settings: { engine: 'apache', apacheMpm: 'itk' } }, ...overrides })
const MOUNTINFO = '29 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n'
const REPQUOTA = 'Block limits                File limits\nUser            used    soft    hard  grace    used  soft  hard  grace\nalice     --    1024       0 5242880             10     0     0\nbob       --    2048       0 5242880             10     0     0\n'
const passwd: Record<string, string> = { alice: 'alice:x:20001:20001::/home/alice:/usr/sbin/nologin\n', bob: 'bob:x:20002:20002::/home/bob:/usr/sbin/nologin\n' }
const host = (overrides: { run?: AccountHealthHost['run']; lstat?: AccountHealthHost['lstat']; readFile?: AccountHealthHost['readFile'] } = {}) => {
  const commands: string[] = []
  const value: AccountHealthHost = {
    run: overrides.run ?? (async argv => { commands.push(argv.join(' ')); if (argv[0] === '/usr/sbin/repquota') return { ok: true, code: 0, stdout: REPQUOTA, stderr: '' }
      const row = passwd[argv[2]!]; return row ? { ok: true, code: 0, stdout: row, stderr: '' } : { ok: false, code: 2, stdout: '', stderr: '' } }),
    readFile: overrides.readFile ?? (async path => path === '/proc/self/mountinfo' ? MOUNTINFO : null),
    lstat: overrides.lstat ?? (async path => ({ uid: path === '/home/bob' ? 20002 : 20001, gid: 20001, mode: 0o40710, directory: true, symlink: false })),
  }
  return { value, commands }
}
const evaluate = async (input: Partial<AccountHealthState> = {}, h: AccountHealthHost | null = host().value, accounts: Account[] = [alice]) =>
  (await evaluateAccountHealth({ state: state(input), accounts, host: h, now: () => NOW })).accounts[0]!
const find = (checks: readonly HealthCheck[], id: string): HealthCheck => checks.find(entry => entry.id === id)!

describe('account health checks', () => {
  it('reports every check ok for a consistent account and counts problems, not percentages', async () => {
    const report = await evaluateAccountHealth({ state: state(), accounts: [alice, bob], host: host().value, now: () => NOW })
    expect(report.observedAt).toBe(NOW.toISOString()); expect(report.host).toBe('read')
    const first = report.accounts[0]!
    expect(first.checks.map(entry => [entry.id, entry.state, entry.reason])).toEqual([
      ['status', 'ok', 'active'], ['plan', 'ok', 'plan_ok'], ['disk', 'ok', 'within_quota'], ['system-user', 'ok', 'user_ok'], ['home', 'ok', 'home_ok'],
      ['mailboxes', 'ok', 'within_limit'], ['certificates', 'ok', 'domains_ok'], ['dns', 'ok', 'domains_ok'], ['php', 'ok', 'domains_ok'],
    ])
    expect(first).toMatchObject({ username: 'alice', primaryDomain: 'alice.example.test', status: 'active', problems: 0, unavailable: 0 })
    expect(find(first.checks, 'disk').evidence).toBe('repquota -u /: used=1024 KiB hard=5242880 KiB; plan diskMb=5120')
    expect(find(first.checks, 'home').evidence).toContain('mode=0710')
    expect(find(first.checks, 'certificates').items).toEqual([{ name: 'alice.example.test', state: 'ok', reason: 'cert_valid', evidence: expect.stringContaining('notAfter=2027-01-20') }])
    expect(JSON.stringify(report)).not.toMatch(/cert-alice|plan-1|features-1|id-alice/)
  })

  it('runs one quota report per mount and one identity lookup per account', async () => {
    const h = host()
    await evaluateAccountHealth({ state: state(), accounts: [alice, bob], host: h.value, now: () => NOW })
    expect(h.commands).toEqual(['/usr/sbin/repquota -u /', '/usr/bin/getent passwd alice', '/usr/bin/getent passwd bob'])
    expect(() => accountHealthPasswdArgv('-x')).toThrow()
  })

  it.each([
    ['status', {}, account('alice', { status: 'suspended' }), 'suspended'],
    ['plan', { plans: [] }, alice, 'plan_missing'],
    ['plan', { featureLists: [] }, alice, 'feature_list_missing'],
    ['mailboxes', { plans: [{ ...plan, caps: { ...plan.caps, mailboxes: 1 } }], serviceUsers: [mailbox(alice, 1), mailbox(alice, 2)] }, alice, 'over_limit'],
    ['dns', { zones: [{ name: 'other.test' }] }, alice, 'domains_problem'],
  ] as const)('reports %s problems from saved state (%s)', async (id, input, target, reason) => {
    const result = await evaluate(input as Partial<AccountHealthState>, host().value, [target])
    expect(find(result.checks, id)).toMatchObject({ state: 'problem', reason })
    expect(result.problems).toBeGreaterThan(0)
  })

  it('reports per-domain certificate, zone and PHP problems with the worst first', async () => {
    const extra = domain(alice, { id: 'd2', name: 'shop.alice.example.test', certificateId: null, php: { ...domain(alice).php, version: '5.6' } })
    const expired = await evaluate({ domains: [domain(alice), extra], certificates: [certificate(alice, { notAfter: '2026-10-01T00:00:00.000Z' })] })
    const certs = find(expired.checks, 'certificates')
    expect(certs).toMatchObject({ state: 'problem', reason: 'domains_problem', omitted: 0 })
    expect(certs.items!.map(entry => [entry.name, entry.reason])).toEqual([['alice.example.test', 'cert_expired'], ['shop.alice.example.test', 'cert_missing']])
    expect(find(expired.checks, 'dns').items!.map(entry => entry.evidence)).toEqual(['zone=alice.example.test', 'zone=alice.example.test'])
    expect(find(expired.checks, 'php').items!.map(entry => [entry.name, entry.reason])).toEqual([['shop.alice.example.test', 'php_unsupported_version'], ['alice.example.test', 'php_ok']])
    const soon = await evaluate({ certificates: [certificate(alice, { notAfter: '2026-11-03T00:00:00.000Z' })] })
    expect(find(soon.checks, 'certificates').items![0]!.reason).toBe('cert_expiring')
    const wrong = await evaluate({ certificates: [certificate(alice, { names: ['*.example.test'] })] })
    expect(find(wrong.checks, 'certificates').items![0]!.reason).toBe('cert_valid')
    const narrow = await evaluate({ certificates: [certificate(alice, { names: ['*.alice.example.test'] })] })
    expect(find(narrow.checks, 'certificates').items![0]!.reason).toBe('cert_not_covering')
    const handler = await evaluate({ domains: [domain(alice, { php: { ...domain(alice).php, handler: 'lsphp' } })] })
    expect(find(handler.checks, 'php').items![0]!.reason).toBe('php_handler_unavailable')
    const many = await evaluate({ domains: Array.from({ length: 30 }, (_, index) => domain(alice, { id: 'm' + index, name: `s${String(index).padStart(2, '0')}.alice.example.test` })) })
    expect(find(many.checks, 'dns')).toMatchObject({ omitted: 5 }); expect(find(many.checks, 'dns').items).toHaveLength(25)
  })

  it.each([
    ['over quota', REPQUOTA.replace('alice     --    1024', 'alice     ++ 5242880'), 'over_quota'],
    ['hard cap differs from plan', REPQUOTA.replace('1024       0 5242880', '1024       0 1048576'), 'quota_mismatch'],
    ['no hard cap', REPQUOTA.replace('1024       0 5242880', '1024       0       0'), 'quota_mismatch'],
  ])('reports disk problems: %s', async (_name, report, reason) => {
    const h = host({ run: async argv => argv[0] === '/usr/sbin/repquota' ? { ok: true, code: 0, stdout: report, stderr: '' } : { ok: true, code: 0, stdout: passwd.alice!, stderr: '' } })
    expect(find((await evaluate({}, h.value)).checks, 'disk')).toMatchObject({ state: 'problem', reason })
  })

  it.each([
    ['missing user', { ok: false, code: 2, stdout: '', stderr: '' }, 'problem', 'user_missing'],
    ['uid mismatch', { ok: true, code: 0, stdout: 'alice:x:30001:20001::/home/alice:/bin/sh\n', stderr: '' }, 'problem', 'user_mismatch'],
    ['home mismatch', { ok: true, code: 0, stdout: 'alice:x:20001:20001::/srv/alice:/bin/sh\n', stderr: '' }, 'problem', 'user_mismatch'],
    ['database error', { ok: false, code: 1, stdout: '', stderr: '' }, 'unavailable', 'user_unread'],
    ['malformed output', { ok: true, code: 0, stdout: 'alice:x:20001\n', stderr: '' }, 'unavailable', 'user_unread'],
    ['two rows', { ok: true, code: 0, stdout: passwd.alice! + passwd.alice!, stderr: '' }, 'unavailable', 'user_unread'],
  ] as const)('observes the system user: %s', async (_name, result, state, reason) => {
    const h = host({ run: async argv => argv[0] === '/usr/sbin/repquota' ? { ok: true, code: 0, stdout: REPQUOTA, stderr: '' } : { ...result } })
    expect(find((await evaluate({}, h.value)).checks, 'system-user')).toMatchObject({ state, reason })
  })

  it.each([
    ['missing', null, 'problem', 'home_missing'],
    ['symlink', { uid: 20001, gid: 20001, mode: 0o120777, directory: false, symlink: true }, 'problem', 'home_not_directory'],
    ['wrong owner', { uid: 0, gid: 0, mode: 0o40710, directory: true, symlink: false }, 'problem', 'home_wrong_owner'],
    ['world writable', { uid: 20001, gid: 20001, mode: 0o40777, directory: true, symlink: false }, 'problem', 'home_world_writable'],
  ] as const)('observes the home directory: %s', async (_name, stat, state, reason) => {
    const h = host({ lstat: async () => stat as HomeStat | null })
    expect(find((await evaluate({}, h.value)).checks, 'home')).toMatchObject({ state, reason })
  })

  it('keeps unread host evidence and inconsistent saved state unavailable, never ok', async () => {
    const offline = await evaluate({}, null)
    for (const id of ['disk', 'system-user', 'home']) expect(find(offline.checks, id)).toMatchObject({ state: 'unavailable', reason: 'host_unavailable' })
    expect(offline.unavailable).toBe(3)
    expect((await evaluateAccountHealth({ state: state(), accounts: [alice], host: null, now: () => NOW })).host).toBe('unavailable')
    const noQuota = host({ run: async argv => argv[0] === '/usr/sbin/repquota' ? { ok: false, code: 1, stdout: '', stderr: 'no quota' } : { ok: true, code: 0, stdout: passwd.alice!, stderr: '' } })
    expect(find((await evaluate({}, noQuota.value)).checks, 'disk')).toMatchObject({ state: 'unavailable', reason: 'quota_unread' })
    const humanUnits = host({ run: async argv => argv[0] === '/usr/sbin/repquota' ? { ok: true, code: 0, stdout: REPQUOTA.replace('Block limits', 'Block limits (MB)'), stderr: '' } : { ok: true, code: 0, stdout: passwd.alice!, stderr: '' } })
    expect(find((await evaluate({}, humanUnits.value)).checks, 'disk').reason).toBe('quota_unread')
    const tmpfs = host({ readFile: async () => '29 1 0:30 / / rw - tmpfs tmpfs rw\n' })
    expect(find((await evaluate({}, tmpfs.value)).checks, 'disk').evidence).toContain('no quota filesystem')
    const brokenStat = host({ lstat: async () => { throw new Error('EACCES') } })
    expect(find((await evaluate({}, brokenStat.value)).checks, 'home')).toMatchObject({ state: 'unavailable', reason: 'home_unread' })
    expect(find((await evaluate({}, host().value, [account('alice', { home: '/home/../etc' })])).checks, 'home').reason).toBe('home_unread')
    expect(find((await evaluate({ plans: [] })).checks, 'disk')).toMatchObject({ state: 'unavailable', reason: 'plan_missing' })
    expect(find((await evaluate({ plans: [] })).checks, 'mailboxes')).toMatchObject({ state: 'unavailable', reason: 'plan_missing' })
    const noServer = await evaluate({ server: null })
    expect(find(noServer.checks, 'php')).toMatchObject({ state: 'unavailable', reason: 'domains_unavailable' })
    expect(find(noServer.checks, 'php').items![0]!.reason).toBe('php_engine_unread')
    const noDomains = await evaluate({ domains: [] })
    expect(find(noDomains.checks, 'certificates')).toMatchObject({ state: 'unavailable', reason: 'no_domains', items: [] })
    expect(find(noDomains.checks, 'php')).toMatchObject({ state: 'ok', reason: 'no_php_sites' })
    const badDate = await evaluate({ certificates: [certificate(alice, { notAfter: 'soon' })] })
    expect(find(badDate.checks, 'certificates').items![0]!.reason).toBe('cert_unread')
  })

  it('removes control and bidirectional characters from evidence', async () => {
    const result = await evaluate({ plans: [{ ...plan, name: 'Gold\u202e\u0007' }] })
    expect(find(result.checks, 'plan').evidence).toBe('plan=Gold?? featureList=Default')
  })
})

const rootCaller: AccountHealthCaller = { principalId: 'root-1', actor: 'root', role: 'root', resellerId: null }
const resellerCaller: AccountHealthCaller = { principalId: 'reseller-1', actor: 'resell', role: 'reseller', resellerId: 'reseller-1' }
const route = (query: string, caller: AccountHealthCaller | (() => AccountHealthCaller) = rootCaller, input: () => AccountHealthState = () => state(), method = 'GET', h: AccountHealthHost | null = host().value) => {
  const url = new URL('http://agent.local/host/accounts/health' + query)
  const authenticate = vi.fn(async () => typeof caller === 'function' ? caller() : caller)
  return { response: handleAccountHealthRoute(new Request(url, { method }), url, method, { authenticate, readState: async () => input(), host: h, now: () => NOW }), authenticate }
}

describe('account health agent route', () => {
  it('returns a bounded report for root and re-authenticates after observation', async () => {
    const { response, authenticate } = route('?username=alice&username=bob')
    const result = await response
    expect(result!.status).toBe(200); expect(result!.headers.get('cache-control')).toBe('no-store')
    expect((await result!.json() as { accounts: { username: string }[] }).accounts.map(entry => entry.username)).toEqual(['alice', 'bob'])
    expect(authenticate).toHaveBeenCalledTimes(2)
    expect(await route('', rootCaller).response.then(() => null, error => error.code)).toBe('VALIDATION')
    const other = new URL('http://agent.local/host/accounts')
    expect(await handleAccountHealthRoute(new Request(other), other, 'GET', { authenticate: async () => rootCaller, readState: async () => state(), host: null })).toBeNull()
  })

  it('scopes resellers to their own accounts with list-accounts', async () => {
    expect((await (await route('?username=alice', resellerCaller).response)!.json() as { accounts: { username: string }[] }).accounts[0]!.username).toBe('alice')
    await expect(route('?username=bob', resellerCaller).response).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(route('?username=alice', resellerCaller, () => state({ resellers: [{ ...reseller, acl: [] }] })).response).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(route('?username=alice', { ...rootCaller, role: 'user' }).response).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it.each([
    ['empty', '?'], ['too many', '?' + Array.from({ length: 51 }, (_, index) => 'username=u' + index).join('&')], ['duplicate', '?username=alice&username=alice'],
    ['grammar', '?username=Alice'], ['option-like', '?username=-x'], ['extra key', '?username=alice&path=/etc'],
  ])('refuses selectors (422 VALIDATION): %s', async (_name, query) => {
    await expect(route(query).response).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('refuses unknown accounts, wrong methods and changed authority', async () => {
    await expect(route('?username=carol').response).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await route('?username=alice', rootCaller, () => state(), 'POST').response)!.status).toBe(405)
    let calls = 0
    await expect(route('?username=alice', () => calls++ ? resellerCaller : rootCaller).response).rejects.toMatchObject({ code: 'FORBIDDEN' })
    let reads = 0
    await expect(route('?username=alice', resellerCaller, () => reads++ ? state({ accounts: [account('alice', { ownerId: 'someone-else' }), bob] }) : state()).response).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
