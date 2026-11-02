import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { ConfigGeneration } from '@xpanel/db'
import { account, domain } from '../../../packages/render/src/edge/testkit.ts'
import { canonicalProvisioningIdentity } from '../../../packages/core/src/account-provisioning-contract.ts'
import type { AccountProvisioningObservationProvider } from './account-provisioning-runtime.ts'
import { FakeHostExecutor } from './executor.ts'
import { DEFAULT_DNS_ZONE_DIR, DEFAULT_NAMED_ZONES_CONF } from './services/dns.ts'
import { createReadonlyAccountProvisioningObserver, parseProvisioningProcessFiles, type ReadonlyAccountObservationOptions } from './account-provisioning-observer.ts'

const unit = 'xpanel-php-fpm-alice-8.3.service'
const group = '/xpanel.slice/xpanel-20001.slice/' + unit
const stat = (start = '12345', state = 'S') => '701 (php worker (a)) ' + [state, '700', ...Array<string>(17).fill('0'), start, '0'].join(' ')
const status = (uid = 20001) => 'Name:\tphp-fpm\nUid:\t' + Array(4).fill(uid).join('\t') + '\nGid:\t20001\t20001\t20001\t20001\n'
const raw = () => ({ stat: stat(), status: status(), cgroup: '0::' + group + '\n' })

function scene() {
  const tenant = account({ id: '22222222-2222-4222-8222-222222222222', planId: '33333333-3333-4333-8333-333333333333', uid: 20001, gid: 20001, primaryDomain: 'tenant.example.test' })
  const primary = domain({ id: '66666666-6666-4666-8666-666666666666', accountId: tenant.id, name: tenant.primaryDomain })
  const authority = { actor: { id: '11111111-1111-4111-8111-111111111111', kind: 'root' as const, username: 'root' },
    account: { id: tenant.id, username: tenant.username, ownerId: tenant.ownerId, planId: tenant.planId, uid: tenant.uid, gid: tenant.gid, home: tenant.home, primaryDomain: tenant.primaryDomain },
    operation: { id: '44444444-4444-4444-8444-444444444444', workerId: 'test-worker', fencingToken: 2, leaseExpiresAt: '2099-01-01T00:00:00.000Z', requestFingerprint: 'a'.repeat(64) },
    desired: { revision: 5, checksum: 'b'.repeat(64), preparationReference: '55555555-5555-4555-8555-555555555555', preparationIdentity: 'c'.repeat(64) } }
  const request = { authority, binding: canonicalProvisioningIdentity(authority) }
  const generation: ConfigGeneration = { id: 7, checksum: 'd'.repeat(64), status: 'active', actor: 'root:root',
    createdAt: '2026-10-30T00:00:00.000Z', testedAt: '2026-10-30T00:00:01.000Z', activatedAt: '2026-10-30T00:00:02.000Z', error: null }
  const zone = '$ORIGIN tenant.example.test.\n$TTL 3600\n@ IN SOA ns1.example.test. hostmaster.example.test. 2026103001 3600 1800 1209600 3600\n@ IN NS ns1.example.test.\n@ IN A 192.0.2.20\n'
  const entries = [{ path: DEFAULT_DNS_ZONE_DIR + '/' + tenant.primaryDomain + '.zone', content: zone },
    { path: DEFAULT_NAMED_ZONES_CONF, content: 'zone "tenant.example.test" { type master; file "' + DEFAULT_DNS_ZONE_DIR + '/tenant.example.test.zone"; };\n' }]
  const executor = new FakeHostExecutor()
  for (const file of entries) executor.files.set(file.path, { ...file, mode: 0o640, owner: 'root', group: 'pdns' })
  const validated = executor.runCommand.bind(executor)
  const run = vi.spyOn(executor, 'runCommand').mockImplementation(async argv => {
    await validated(argv) // the executor's own argv admission, as on a real host
    let stdout = ''
    if (argv[0] === '/usr/bin/findmnt') stdout = (argv[4] === 'TARGET' ? '/home' : argv[4] === 'SOURCE' ? '/dev/vda1' : 'ext4') + '\n'
    else if (argv[0] === '/usr/sbin/quotaon') return { ok: false, code: 1, stdout: 'user quota on /home (/dev/vda1) is on\n', stderr: '' }
    else if (argv[0] === '/usr/bin/systemctl') stdout = argv.includes('--timestamp=unix')
      ? 'Id=' + unit + '\nLoadState=loaded\nActiveState=active\nSubState=running\n'
      : 'Id=' + unit + '\nUser=alice\nGroup=alice\nMainPID=700\nControlGroup=' + group + '\nActiveState=active\n'
    else throw new Error('unexpected command')
    return { ok: true, code: 0, stdout, stderr: '' }
  })
  const processRaw = raw()
  const processHandle = { read: vi.fn(async (name: keyof typeof processRaw) => processRaw[name]), assertCurrent: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const home = { assertCurrent: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const response = { pid: 701, status: 200, challenge: '', requestBinding: request.binding, assertCurrent: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const options: ReadonlyAccountObservationOptions = { executor, store: { listDomains: async () => [primary] }, dns: { verify: vi.fn(async () => {}) },
    assertHttpAvailable: vi.fn(async () => {}), openCorrelatedHttpRequest: vi.fn(async input => { response.challenge = input.challenge; return response }),
    openProcessFiles: vi.fn(async () => processHandle), openHome: vi.fn(async () => home) }
  const input: Parameters<AccountProvisioningObservationProvider['observe']>[0] = { account: tenant, request,
    reconciliation: { status: 'noop', generation, stateChecksum: authority.desired.checksum },
    manifest: { schemaVersion: 1, generationId: generation.id, stateChecksum: authority.desired.checksum, filesChecksum: generation.checksum,
      actor: 'root:root', createdAt: generation.createdAt, managedUnits: [unit], testResults: [],
      files: entries.map(file => ({ path: file.path, sha256: createHash('sha256').update(file.content).digest('hex'), sizeBytes: Buffer.byteLength(file.content),
        mode: 0o640, owner: 'root', group: 'pdns', logicalOwner: 'account:' + tenant.id, service: 'dns', dependentUnits: [] })) } }
  const abort = new AbortController(), context = { signal: abort.signal, readOnly: true, assertAuthority: vi.fn(async () => {}) }
  return { options, input, context, processRaw, processHandle, home, response, run, abort }
}

describe('readonly provisioning observation (isolated raw-file and transport fixtures, not native qualification)', () => {
  it('parses kernel identity without confusing parentheses in comm with stat fields', () => {
    expect(parseProvisioningProcessFiles(701, raw())).toMatchObject({ pid: 701, parentPid: 700, startTime: '12345', uids: [20001, 20001, 20001, 20001], cgroup: group })
  })
  it.each([
    { ...raw(), stat: '701 (broken) S 700' },
    { ...raw(), stat: stat('0') },
    { ...raw(), status: status() + status() },
    { ...raw(), status: status().replace('20001', 'root') },
    { ...raw(), cgroup: '2:cpu:/legacy\n' },
    { ...raw(), cgroup: '0::/xpanel.slice/../wrong\n' },
  ])('rejects malformed independent process files %#', files => {
    expect(() => parseProvisioningProcessFiles(701, files)).toThrow()
  })
  it('requires the missing trusted HTTP seam before reading any host facts', async () => {
    const s = scene(), observer = createReadonlyAccountProvisioningObserver({ ...s.options, openCorrelatedHttpRequest: undefined })
    await expect(observer.assertAvailable(s.input, s.context)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
    expect(s.run).not.toHaveBeenCalled()
    expect(s.options.openProcessFiles).not.toHaveBeenCalled()
  })
  it('assembles only from the independent raw-file, quota, DNS and unit observations', async () => {
    const s = scene(), result = await createReadonlyAccountProvisioningObserver(s.options).observe(s.input, s.context)
    expect(result).toMatchObject({ accountId: s.input.account.id, uid: 20001, gid: 20001, cgroup: group, services: [unit],
      quota: { enforced: true, filesystem: '/home' }, dns: { zone: 'tenant.example.test', serial: 2026103001, authoritative: true }, php: { status: 200, uid: 20001, cgroup: group } })
    expect(s.options.dns.verify).toHaveBeenCalledTimes(1)
    expect(s.processHandle.close).toHaveBeenCalledTimes(1); expect(s.response.close).toHaveBeenCalledTimes(1); expect(s.home.close).toHaveBeenCalledTimes(1)
    expect(s.options.executor).toMatchObject({ executedActions: [], executedTests: [] })
  })
  it.each(['uid', 'cgroup', 'zombie', 'parent'] as const)('refuses wrong process %s and releases every held resource', async field => {
    const s = scene()
    if (field === 'uid') s.processRaw.status = status(20002)
    if (field === 'cgroup') s.processRaw.cgroup = '0::/system.slice/php-fpm.service\n'
    if (field === 'zombie') s.processRaw.stat = stat('12345', 'Z')
    if (field === 'parent') s.processRaw.stat = s.processRaw.stat.replace(' S 700 ', ' S 999 ')
    await expect(createReadonlyAccountProvisioningObserver(s.options).observe(s.input, s.context)).rejects.toThrow()
    expect(s.processHandle.close).toHaveBeenCalledOnce(); expect(s.response.close).toHaveBeenCalledOnce(); expect(s.home.close).toHaveBeenCalledOnce()
  })
  it('refuses a PID-start identity change between observations', async () => {
    const s = scene(); let reads = 0
    s.processHandle.read.mockImplementation(async name => name === 'stat' ? stat(++reads === 1 ? '12345' : '12346') : s.processRaw[name])
    await expect(createReadonlyAccountProvisioningObserver(s.options).observe(s.input, s.context)).rejects.toThrow()
  })
  it.each(['binding', 'status'] as const)('rejects an invalid trusted-transport result %s before reading process files', async kind => {
    const s = scene()
    if (kind === 'binding') s.response.requestBinding = 'f'.repeat(64)
    else s.response.status = 503
    await expect(createReadonlyAccountProvisioningObserver(s.options).observe(s.input, s.context)).rejects.toThrow()
    expect(s.options.openProcessFiles).not.toHaveBeenCalled(); expect(s.response.close).toHaveBeenCalledOnce()
  })
  it('requires readonly authority and a current request binding', async () => {
    const s = scene()
    await expect(createReadonlyAccountProvisioningObserver(s.options).observe(s.input, { ...s.context, readOnly: false })).rejects.toThrow()
    expect(s.run).not.toHaveBeenCalled()
  })
  it('refuses drift in a generation-owned DNS file', async () => {
    const s = scene(); s.input.manifest.files[0]!.sha256 = '0'.repeat(64)
    await expect(createReadonlyAccountProvisioningObserver(s.options).observe(s.input, s.context)).rejects.toThrow()
    expect(s.options.openCorrelatedHttpRequest).not.toHaveBeenCalled()
  })
  it('does not create proof after authority is revoked while the HTTP request is held', async () => {
    const s = scene(); s.response.assertCurrent.mockImplementation(async () => { s.abort.abort() })
    await expect(createReadonlyAccountProvisioningObserver(s.options).observe(s.input, s.context)).rejects.toThrow()
    expect(s.response.close).toHaveBeenCalledOnce()
  })
})

describe('readonly observation failure composition (isolated fixtures)', () => {
  it.each(['quota', 'service', 'unit'] as const)('refuses unverified %s facts before the HTTP probe', async kind => {
    const s = scene(), original = s.run.getMockImplementation()
    if (!original) throw new Error('missing command fixture')
    s.run.mockImplementation(async argv => {
      if (kind === 'quota' && argv[0] === '/usr/sbin/quotaon') return { ok: true, code: 0, stdout: 'user quota on /home (/dev/vda1) is off\n', stderr: '' }
      const result = await original(argv)
      if (kind === 'service' && argv.includes('--timestamp=unix')) return { ...result, stdout: result.stdout.replace('ActiveState=active', 'ActiveState=inactive') }
      if (kind === 'unit' && argv[0] === '/usr/bin/systemctl' && !argv.includes('--timestamp=unix')) return { ...result, stdout: result.stdout.replace('User=alice', 'User=other') }
      return result
    })
    await expect(createReadonlyAccountProvisioningObserver(s.options).observe(s.input, s.context)).rejects.toThrow()
    expect(s.options.openCorrelatedHttpRequest).not.toHaveBeenCalled()
  })
  it('does not hide failure of the existing authoritative DNS verifier', async () => {
    const s = scene()
    s.options.dns.verify = vi.fn(async () => { throw new Error('DNS was not authoritative') })
    await expect(createReadonlyAccountProvisioningObserver(s.options).observe(s.input, s.context)).rejects.toThrow('DNS was not authoritative')
    expect(s.options.openCorrelatedHttpRequest).not.toHaveBeenCalled()
  })
  it('rejects a wrong challenge and closes the held HTTP request', async () => {
    const s = scene()
    const observer = createReadonlyAccountProvisioningObserver({ ...s.options,
      openCorrelatedHttpRequest: async () => ({ ...s.response, challenge: 'wrong' }) })
    await expect(observer.observe(s.input, s.context)).rejects.toThrow()
    expect(s.response.close).toHaveBeenCalledOnce()
    expect(s.options.openProcessFiles).not.toHaveBeenCalled()
  })
  it('samples its deadline after the awaited availability check', async () => {
    const s = scene(); let now = 0
    const observer = createReadonlyAccountProvisioningObserver({ ...s.options, now: () => now,
      assertHttpAvailable: async () => { now = 15001 } })
    await expect(observer.assertAvailable(s.input, s.context)).rejects.toThrow()
    expect(s.run).not.toHaveBeenCalled()
  })
})

describe('stable observation identity and path admission', () => {
  it('allows a scheduler state change while the worker identity remains unchanged', async () => {
    const s = scene(); let reads = 0
    s.processHandle.read.mockImplementation(async name => name === 'stat' ? stat('12345', ++reads === 1 ? 'S' : 'R') : s.processRaw[name])
    await expect(createReadonlyAccountProvisioningObserver(s.options).observe(s.input, s.context)).resolves.toMatchObject({ uid: 20001, cgroup: group })
  })
  it('rejects a noncanonical domain before any host path or store read', async () => {
    const s = scene(), primaryDomain = '../escape.test'
    const authority = { ...s.input.request.authority, account: { ...s.input.request.authority.account, primaryDomain } }
    const input = { ...s.input, account: { ...s.input.account, primaryDomain },
      request: { authority, binding: canonicalProvisioningIdentity(authority) } }
    const listDomains = vi.fn(async () => [])
    await expect(createReadonlyAccountProvisioningObserver({ ...s.options, store: { listDomains } }).observe(input, s.context))
      .rejects.toMatchObject({ detail: { reason: 'invalid_account_domain' } })
    expect(listDomains).not.toHaveBeenCalled(); expect(s.run).not.toHaveBeenCalled()
  })
})

describe('acquisition ownership under cancellation (isolated resources)', () => {
  it.each([
    ['home', 'revocation'], ['http', 'revocation'], ['process', 'revocation'],
    ['home', 'deadline'], ['http', 'deadline'], ['process', 'deadline'],
  ] as const)('closes acquired %s handles when %s arrives before the post-await guard', async (stage, failure) => {
    const s = scene(); let now = 0
    const openHome = s.options.openHome, openHttp = s.options.openCorrelatedHttpRequest, openProcess = s.options.openProcessFiles
    if (!openHome || !openHttp || !openProcess) throw new Error('missing fixture resource factories')
    const after = (acquired: typeof stage) => {
      if (stage !== acquired) return
      if (failure === 'revocation') s.abort.abort()
      else now = 15001
    }
    const observer = createReadonlyAccountProvisioningObserver({ ...s.options, now: () => now,
      openHome: async account => { const handle = await openHome(account); after('home'); return handle },
      openCorrelatedHttpRequest: async (input, context) => { const handle = await openHttp(input, context); after('http'); return handle },
      openProcessFiles: async pid => { const handle = await openProcess(pid); after('process'); return handle },
    })
    await expect(observer.observe(s.input, s.context)).rejects.toMatchObject({ detail: { reason: 'observation_authority_or_deadline' } })
    expect(s.home.close).toHaveBeenCalledTimes(1)
    expect(s.response.close).toHaveBeenCalledTimes(stage === 'home' ? 0 : 1)
    expect(s.processHandle.close).toHaveBeenCalledTimes(stage === 'process' ? 1 : 0)
  })

  it.each([
    '0::' + group + '\n2:cpu:/legacy\n',
    '0::' + group + ' \n',
  ])('rejects mixed or whitespace-altered cgroup membership %#', cgroup => {
    expect(() => parseProvisioningProcessFiles(701, { ...raw(), cgroup })).toThrow()
  })
})

describe('resource cleanup completion', () => {
  it('closes the remaining resources when one close throws synchronously', async () => {
    const s = scene()
    s.processHandle.close.mockImplementation(() => { throw new Error('close failed') })
    await expect(createReadonlyAccountProvisioningObserver(s.options).observe(s.input, s.context))
      .rejects.toMatchObject({ detail: { reason: 'observation_handle_release_failed' } })
    expect(s.processHandle.close).toHaveBeenCalledOnce()
    expect(s.response.close).toHaveBeenCalledOnce()
    expect(s.home.close).toHaveBeenCalledOnce()
  })
})
