import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { handleSecurityToolsRoute } from './security-tools-routes.ts'
import type { SecurityToolsRouteContext } from './security-tools-routes.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', shell: 'none', planId: 'p1' } as unknown as Account
const plan = { id: 'p1', shell: 'none', resources: { diskMb: 'unlimited', bandwidthMbMonth: 'unlimited', ioReadBps: 'unlimited', ioWriteBps: 'unlimited', ioReadIops: 'unlimited', ioWriteIops: 'unlimited', memoryMb: 'unlimited', maxProcesses: 'unlimited', cpuPercent: 'unlimited' } } as unknown as Plan
const jailStatus = (banned: string[]) => `Status for the jail: sshd\n|- Filter\n|  |- Currently failed:\t0\n|  |- Total failed:\t4\n|  \`- File list:\t/var/log/auth.log\n\`- Actions\n   |- Currently banned:\t${banned.length}\n   |- Total banned:\t9\n   \`- Banned IP list:\t${banned.join(' ')}\n`
const post = (path: string, body: unknown, type = 'application/json') => new Request('http://agent.local' + path, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const get = (path: string) => new Request('http://agent.local' + path)
const call = (req: Request, ctx: SecurityToolsRouteContext) => handleSecurityToolsRoute(req, new URL(req.url), req.method, ctx)
const job = (plan: HostJobPlan): HostJobView => ({ id: '22222222-2222-4222-8222-222222222222', referenceCode: null, kind: plan.kind, status: 'queued', progress: 0, summary: plan.summary, accountId: plan.accountId, actor: 'root', createdAt: '2026-10-27T10:00:00.000Z', startedAt: null, finishedAt: null, steps: [], error: null, failureClass: null, cancelRequested: false, verification: null, logBytes: 0 })
const context = (bans: string[][] = [], overrides: Partial<SecurityToolsRouteContext> = {}) => {
  const events: string[] = []
  const runCommand = vi.fn(async (argv: string[]) => {
    events.push(argv.slice(1).join(' '))
    if (argv[1] === 'set') return { ok: true, code: 0, stdout: '1\n', stderr: '' }
    if (argv[0] === '/usr/bin/fail2ban-client') return { ok: true, code: 0, stdout: jailStatus(bans.shift() ?? []), stderr: '' }
    if (argv[0] === '/usr/bin/clamscan') return { ok: true, code: 0, stdout: 'ClamAV 1.0.7/27440/Mon Oct 26 08:21:44 2026\n', stderr: '' }
    if (argv[0] === '/usr/bin/getent') return { ok: true, code: 0, stdout: 'alice:x:1001:1001::/home/alice:/usr/sbin/nologin\n', stderr: '' }
    return { ok: true, code: 0, stdout: 'LoadState=loaded\nActiveState=active\n', stderr: '' }
  })
  const submitJob = vi.fn(async (value: HostJobPlan) => { events.push('submit:' + value.kind); return job(value) })
  const ctx: SecurityToolsRouteContext = {
    assertRoot: vi.fn(async (action: string) => { events.push('root:' + action); return { actor: 'root' } }),
    executor: { runCommand, readSliceMetrics: async () => ({ uid: 1001, cpuUsageUsec: 0, memoryCurrentBytes: 0, ioReadBytes: 0, ioWriteBytes: 0, pidsCurrent: 1, memoryMax: 'max', pidsMax: 'max', cpuMax: 'max 100000', ioMax: '' }) } as unknown as SecurityToolsRouteContext['executor'],
    readSnapshot: async () => ({ accounts: [account, { ...account, id: '33333333-3333-4333-8333-333333333333', username: 'bob', uid: 1002, home: '/home/bob', status: 'terminating' } as Account], plans: [plan], domains: [] as Domain[] }),
    submitJob, jobs: { list: async () => [], readLog: async () => { throw new Error('no log') } } as unknown as SecurityToolsRouteContext['jobs'],
    audit: vi.fn(async (entry: { action: string }) => { events.push('audit:' + entry.action) }),
    present: async () => true, resolveHome: async home => home, inspectHome: async () => ({ type: 'directory', uid: 1001, gid: 1001, mode: 0o750 }), ioDevices: async () => null,
    now: () => new Date('2026-10-27T10:00:00Z'), ...overrides,
  }
  return { ctx, events, runCommand, submitJob }
}

describe('agent security tools routes', () => {
  it('ignores unrelated paths and refuses non-root callers before any host read', async () => {
    const { ctx, runCommand } = context()
    expect(await call(get('/host/security/ssh'), ctx)).toBeNull()
    expect(ctx.assertRoot).not.toHaveBeenCalled()
    const denied = context([], { assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) } })
    for (const req of [get('/host/security-tools/intrusion'), post('/host/security-tools/intrusion/unban', { jail: 'sshd', address: '192.0.2.1' }), post('/host/security-tools/antivirus/scan', { account: 'alice' }), get('/host/security-tools/isolation?account=alice')]) await expect(call(req, denied.ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(denied.runCommand).not.toHaveBeenCalled(); expect(runCommand).not.toHaveBeenCalled()
  })
  it('validates methods, selectors and strict bodies with 405 and VALIDATION', async () => {
    const { ctx, runCommand } = context()
    expect((await call(new Request('http://agent.local/host/security-tools/intrusion', { method: 'DELETE' }), ctx))!.status).toBe(405)
    for (const req of [get('/host/security-tools/intrusion?jail=sshd'), get('/host/security-tools/isolation?account=Alice'), get('/host/security-tools/isolation?account=alice&account=bob'), get('/host/security-tools/isolation?path=/etc'),
      post('/host/security-tools/intrusion/unban', { jail: 'sshd', address: '192.0.2.1', all: true }), post('/host/security-tools/intrusion/unban', { jail: '-h', address: '192.0.2.1' }), post('/host/security-tools/intrusion/unban', { jail: 'sshd', address: '192.0.2.0/24' }),
      post('/host/security-tools/antivirus/scan', { account: 'alice', path: '/etc' }), post('/host/security-tools/antivirus/scan', { account: '../root' }), post('/host/security-tools/antivirus/scan', { account: 'alice' }, 'text/plain'), post('/host/security-tools/antivirus/update', { force: true }),
      post('/host/security-tools/antivirus/scan', 'x'.repeat(2000))]) await expect(call(req, ctx)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(runCommand).not.toHaveBeenCalled()
  })
  it('stays unavailable without the native executor', async () => {
    const { ctx } = context([], { executor: null })
    await expect(call(get('/host/security-tools/intrusion'), ctx)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('reads intrusion state with no-store', async () => {
    const { ctx } = context([['192.0.2.1']], { executor: { runCommand: async (argv: string[]) => ({ ok: true, code: 0, stdout: argv.length === 2 ? 'Status\n|- Number of jail:\t1\n`- Jail list:\tsshd\n' : jailStatus(['192.0.2.1']), stderr: '' }) } as unknown as SecurityToolsRouteContext['executor'] })
    const response = (await call(get('/host/security-tools/intrusion'), ctx))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ state: 'read', jails: [{ name: 'sshd', banned: ['192.0.2.1'] }] })
  })
  it('audits, re-reads, re-authorizes right before unbanning and returns 409 when not banned', async () => {
    const { ctx, events } = context([['192.0.2.1'], []])
    expect(await (await call(post('/host/security-tools/intrusion/unban', { jail: 'sshd', address: '192.0.2.1' }), ctx))!.json()).toMatchObject({ outcome: 'confirmed', after: { banned: false } })
    expect(events).toEqual(['root:security.intrusion.unban', 'audit:security.intrusion.unban_requested', 'status sshd', 'root:security.intrusion.unban', 'set sshd unbanip 192.0.2.1', 'status sshd', 'audit:security.intrusion.unban'])
    const conflict = context([['198.51.100.1']])
    await expect(call(post('/host/security-tools/intrusion/unban', { jail: 'sshd', address: '192.0.2.1' }), conflict.ctx)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(conflict.events.filter(event => event.startsWith('set '))).toEqual([])
    expect(conflict.ctx.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'security.intrusion.unban', outcome: 'failed', detail: { outcome: 'refused' } }))
  })
  it('submits a scan of the store home only, after verifying ownership, and a signature update job', async () => {
    const { ctx, events, submitJob } = context()
    const response = (await call(post('/host/security-tools/antivirus/scan', { account: 'alice' }), ctx))!
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ job: { id: '22222222-2222-4222-8222-222222222222', referenceCode: null, kind: 'security.antivirus.scan', status: 'queued' } })
    expect(submitJob.mock.calls[0]![0].steps[0]!.argv.at(-1)).toBe('/home/alice')
    expect(submitJob.mock.calls[0]![0].accountId).toBe(account.id)
    expect(events).toEqual(['root:security.antivirus.scan', 'root:security.antivirus.scan', 'submit:security.antivirus.scan', 'audit:security.antivirus.scan_submitted'])
    expect((await call(post('/host/security-tools/antivirus/update', {}), ctx))!.status).toBe(202)
    expect(submitJob.mock.calls[1]![0].steps[0]!.argv).toEqual(['/usr/bin/freshclam', '--quiet'])
  })
  it('refuses scans of unknown, terminating or unverified homes and without a job runner', async () => {
    for (const [name, overrides] of [['nobody', {}], ['bob', {}], ['alice', { inspectHome: async () => ({ type: 'directory', uid: 0, gid: 0, mode: 0o755 }) }], ['alice', { inspectHome: async () => ({ type: 'symlink', uid: 1001, gid: 1001, mode: 0o777 }) }],
      ['alice', { resolveHome: async () => '/etc' }], ['alice', { resolveHome: async () => '/home/bob' }], ['alice', { resolveHome: async () => { throw new Error('ENOENT') } }], ['alice', { submitJob: null }]] as const) {
      const { ctx, submitJob } = context([], overrides as Partial<SecurityToolsRouteContext>)
      await expect(call(post('/host/security-tools/antivirus/scan', { account: name }), ctx)).rejects.toMatchObject({ detail: { stateChanged: false } })
      expect(submitJob).not.toHaveBeenCalled()
    }
    const { ctx } = context([], { present: async path => path !== '/usr/bin/freshclam' })
    await expect(call(post('/host/security-tools/antivirus/update', {}), ctx)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'freshclam_not_installed' } })
  })
  it('lists accounts and reads one account isolation report', async () => {
    const { ctx } = context()
    expect(await (await call(get('/host/security-tools/isolation'), ctx))!.json()).toEqual({ accounts: [{ username: 'alice', status: 'active' }, { username: 'bob', status: 'terminating' }], report: null })
    const body = await (await call(get('/host/security-tools/isolation?account=alice'), ctx))!.json() as { report: unknown }
    expect(body.report).toMatchObject({ username: 'alice', state: 'ok' })
    await expect(call(get('/host/security-tools/isolation?account=carol'), ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
