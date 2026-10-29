import { describe, expect, it, vi } from 'vitest'
import type { Account, Plan } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { validateHostJobPlan } from './host-jobs.ts'
import { ACCOUNT_SCAN_JOB_KIND, accountScanGate, accountScanKind, handleAccountVirusScanRoute } from './account-virus-scan.ts'
import type { AccountVirusScanRouteDeps } from './account-virus-scan.ts'
import type { AntivirusJobs } from './security-tools-antivirus.ts'
import { clamscanHomeArgv } from '../../../packages/os/src/security-tools-command.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111', BOB = '22222222-2222-4222-8222-222222222222'
const alice = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan' } as Account
const bob = { ...alice, id: BOB, username: 'bob', uid: 1002, home: '/home/bob' } as Account
const NOW = new Date('2026-10-27T12:00:00.000Z')
const command = (home: string) => '$ ' + clamscanHomeArgv(home).join(' ')
const summary = (infected: number) => `----------- SCAN SUMMARY -----------\nKnown viruses: 8693452\nEngine version: 1.0.7\nScanned directories: 41\nScanned files: 312\nInfected files: ${infected}\nData scanned: 12.40 MB\nTime: 21.512 sec (0 m 21 s)\n`
const log = (home: string, stdout: string, exit: number) => `2026-10-27T10:00:00.200Z step 1/1 scan\n${command(home)}\n${stdout}[exit ${exit}]\n`
const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`
const job = (n: number, kind: string, accountId: string | null, status: HostJobView['status'], exitCode: number | null, minutesAgo: number): HostJobView => ({
  id: id(n), referenceCode: null, kind, status, progress: 100, summary: 'x', accountId, actor: 'alice', createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), startedAt: null, finishedAt: status === 'queued' || status === 'running' ? null : NOW.toISOString(),
  steps: [{ id: 'scan', title: 'x', state: status === 'succeeded' ? 'succeeded' : 'pending', exitCode }], error: null, failureClass: null, cancelRequested: false, verification: null, logBytes: 10 })

function setup(over: { jobs?: HostJobView[]; logs?: Record<string, string>; run?: AccountVirusScanRouteDeps['run']; principal?: Record<string, unknown> | null; disabled?: string[]; role?: 'user' | 'reseller' | 'root'; home?: string; uid?: number; type?: 'directory' | 'symlink'; listOverride?: AntivirusJobs['list']; noRunner?: boolean; submitFails?: boolean; ghost?: boolean } = {}) {
  const jobs = [...(over.jobs ?? [])], logs = over.logs ?? {}
  const list = vi.fn(async (options: { kindPrefix?: string; limit?: number } = {}) => jobs.filter(item => item.kind.startsWith(options.kindPrefix ?? '')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, options.limit ?? 50))
  const readLog = vi.fn(async (jobId: string) => ({ id: jobId, available: jobId in logs, offset: 0, nextOffset: logs[jobId]?.length ?? 0, total: logs[jobId]?.length ?? 0, truncated: false, text: logs[jobId] ?? '' }))
  const runner: AntivirusJobs = { list: over.listOverride ?? list as unknown as AntivirusJobs['list'], readLog: readLog as unknown as AntivirusJobs['readLog'] }
  const plans: HostJobPlan[] = []
  const submitJob = vi.fn(async (plan: HostJobPlan, actor: string) => {
    if (over.submitFails) throw new Error('db')
    plans.push(plan)
    const created = { ...job(9, plan.kind, plan.accountId, 'queued', null, 0), actor }
    if (!over.ghost) jobs.push(created)
    return created
  })
  const run = over.run === undefined ? vi.fn(async () => ({ ok: true, code: 0, stdout: 'ClamAV 1.0.7/27440/Mon Oct 26 08:21:44 2026\n', stderr: '' })) : over.run
  const audit = vi.fn(async () => undefined)
  const deps: AccountVirusScanRouteDeps = {
    caller: { principalId: 'p-alice', actor: 'alice', role: over.role ?? 'user', accountId: over.role && over.role !== 'user' ? null : ACCOUNT, resellerId: null },
    store: { getAccountByUsername: async name => name === 'alice' ? alice : name === 'bob' ? bob : null, withAccountLifecycleLease: async (accountId, operation) => operation(accountId === ACCOUNT ? alice : bob),
      getPlan: async () => ({ featureListId: 'list' }) as Plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: over.disabled ?? [] }) },
    currentPrincipal: async () => over.principal === undefined ? { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT, disabled: false } : over.principal as never,
    run, jobs: over.noRunner ? null : runner, submitJob: over.noRunner ? null : submitJob, audit, present: async () => true,
    resolveHome: async home => over.home ?? home, inspectHome: async () => ({ type: over.type ?? 'directory', uid: over.uid ?? 1001, gid: 1001, mode: 0o750 }), now: () => NOW,
  }
  const call = (path: string, method = 'GET', body?: string, type = 'application/json') => { const url = new URL('http://agent.local' + path); return handleAccountVirusScanRoute(new Request(url, { method, ...(body !== undefined ? { body, headers: { 'content-type': type } } : {}) }), url, method, deps) }
  return { call, plans, submitJob, readLog, list, audit, run }
}

describe('account virus scan reads', () => {
  it('reports the engine and only this account\'s scans with home-relative infected paths', async () => {
    const mine = accountScanKind(ACCOUNT)
    const t = setup({ jobs: [job(1, mine, ACCOUNT, 'succeeded', 1, 30), job(2, mine, ACCOUNT, 'succeeded', 0, 60), job(3, accountScanKind(BOB), BOB, 'succeeded', 1, 20), job(4, 'security.antivirus.scan', ACCOUNT, 'succeeded', 1, 10), job(5, mine, BOB, 'succeeded', 1, 5)],
      logs: { [id(1)]: log('/home/alice', '/home/alice/public_html/x.php: Php.Webshell.Generic-1 FOUND\n/home/alice: Eicar-Test FOUND\n' + summary(2), 1), [id(2)]: log('/home/alice', summary(0), 0), [id(3)]: log('/home/bob', '/home/bob/secret.php: Php.Webshell-1 FOUND\n' + summary(1), 1) } })
    const view = await (await t.call('/accounts/alice/virus-scan'))!.json() as Record<string, any>
    expect(view.context).toEqual({ accountId: ACCOUNT, username: 'alice' })
    expect(view.engine).toEqual({ state: 'read', version: '1.0.7', signatureVersion: 27440, signatureDate: 'Mon Oct 26 08:21:44 2026' })
    expect(view.limits).toEqual({ history: 10, cooldownMinutes: 15, findingsPerScan: 50 }); expect(view.start).toEqual({ allowed: true, reason: null, availableAt: null }); expect(view.started).toBeNull()
    expect(view.scans.map((scan: { jobId: string; result: string }) => [scan.jobId, scan.result])).toEqual([[id(1), 'infected'], [id(2), 'clean']])
    expect(view.scans[0].infected).toEqual([{ path: 'public_html/x.php', signature: 'Php.Webshell.Generic-1' }, { path: '.', signature: 'Eicar-Test' }]); expect(view.scans[0].listComplete).toBe(true)
    expect(view.scans[0].summary).toMatchObject({ scannedFiles: 312, infectedFiles: 2 }); expect(view.scans[1].infected).toEqual([])
    expect(JSON.stringify(view)).not.toContain('/home/'); expect(JSON.stringify(view)).not.toContain('bob')
    expect(t.list).toHaveBeenCalledWith({ kindPrefix: accountScanKind(ACCOUNT), limit: 10 }); expect(t.readLog.mock.calls.map(call => call[0]).sort()).toEqual([id(1), id(2)])
    expect(await t.call('/accounts/alice/files')).toBeNull()
  })
  it('drops findings whose logged target is not this account home', async () => {
    const t = setup({ jobs: [job(1, accountScanKind(ACCOUNT), ACCOUNT, 'succeeded', 1, 30)], logs: { [id(1)]: log('/home/bob', '/home/bob/a.php: Php.Webshell-1 FOUND\n' + summary(1), 1) } })
    const scan = (await (await t.call('/accounts/alice/virus-scan'))!.json() as Record<string, any>).scans[0]
    expect(scan).toMatchObject({ result: 'infected', infected: [], summary: null, listComplete: false })
  })
  it('is owner-only: other roles are refused, foreign accounts are not found, plan and principal re-checked', async () => {
    for (const role of ['root', 'reseller'] as const) await expect(setup({ role }).call('/accounts/alice/virus-scan')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    for (const name of ['bob', 'nobody']) await expect(setup().call('/accounts/' + name + '/virus-scan')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    for (const disabled of [['virus-scanner'], ['clamavconnector_scan']]) await expect(setup({ disabled }).call('/accounts/alice/virus-scan')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    for (const principal of [null, { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT, disabled: true }, { kind: 'user', id: 'p-alice', username: 'alice', accountId: BOB, disabled: false }]) await expect(setup({ principal }).call('/accounts/alice/virus-scan')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup().call('/accounts/alice/virus-scan?account=bob')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await setup().call('/accounts/alice/virus-scan', 'DELETE'))!.status).toBe(405)
  })
  it('reports an unavailable engine and runner without simulating them', async () => {
    const view = await (await setup({ run: null }).call('/accounts/alice/virus-scan'))!.json() as Record<string, any>
    expect(view.engine.state).toBe('unavailable'); expect(view.start).toEqual({ allowed: false, reason: 'engine_unavailable', availableAt: null })
    const off = await (await setup({ noRunner: true }).call('/accounts/alice/virus-scan'))!.json() as Record<string, any>
    expect(off).toMatchObject({ jobsAvailable: false, scans: [], start: { allowed: false, reason: 'jobs_unavailable' } })
  })
})

describe('account virus scan start', () => {
  it('queues one reviewed scan of the verified home under the account kind and reads it back', async () => {
    const t = setup(), response = await t.call('/accounts/alice/virus-scan', 'POST', '{}')
    expect(response!.status).toBe(202)
    const [plan] = t.plans, [step] = validateHostJobPlan(plan!)
    expect(plan).toMatchObject({ kind: ACCOUNT_SCAN_JOB_KIND + ':' + ACCOUNT, accountId: ACCOUNT, fingerprint: { username: 'alice', target: '/home/alice' }, summary: 'Antivirus scan of account alice requested by its owner' })
    expect(step).toMatchObject({ argv: clamscanHomeArgv('/home/alice'), successExitCodes: [1], mutates: false }); expect(plan!.policy(step!.argv)).toBe(true)
    expect(t.submitJob).toHaveBeenCalledWith(expect.anything(), 'alice')
    const view = await response!.json() as Record<string, any>
    expect(view.started).toEqual({ jobId: id(9) }); expect(view.scans[0]).toMatchObject({ jobId: id(9), status: 'queued', result: 'pending' }); expect(view.start.reason).toBe('scan_active')
    expect(t.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.virus_scan.submitted', target: 'account:alice', detail: { jobId: id(9) } }))
  })
  it('allows one queued or running scan and one start per 15 minutes', async () => {
    const mine = accountScanKind(ACCOUNT)
    await expect(setup({ jobs: [job(1, mine, ACCOUNT, 'running', null, 40)] }).call('/accounts/alice/virus-scan', 'POST', '{}')).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'scan_active', stateChanged: false } })
    await expect(setup({ jobs: [job(1, mine, ACCOUNT, 'failed', 2, 5)] }).call('/accounts/alice/virus-scan', 'POST', '{}')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', detail: { reason: 'cooldown', availableAt: '2026-10-27T12:10:00.000Z' } })
    expect((await setup({ jobs: [job(1, mine, ACCOUNT, 'succeeded', 0, 16)] }).call('/accounts/alice/virus-scan', 'POST', '{}'))!.status).toBe(202)
    // Another account's or root's scans never block this owner.
    expect((await setup({ jobs: [job(1, accountScanKind(BOB), BOB, 'running', null, 1)] }).call('/accounts/alice/virus-scan', 'POST', '{}'))!.status).toBe(202)
    expect(accountScanGate([], NOW)).toEqual({ reason: null, availableAt: null })
  })
  it('re-checks the gate inside the account lease so a racing start is refused', async () => {
    let calls = 0
    const queued = job(1, accountScanKind(ACCOUNT), ACCOUNT, 'queued', null, 0)
    const t = setup({ listOverride: (async () => calls++ === 0 ? [] : [queued]) as unknown as AntivirusJobs['list'] })
    await expect(t.call('/accounts/alice/virus-scan', 'POST', '{}')).rejects.toMatchObject({ code: 'CONFLICT' }); expect(t.submitJob).not.toHaveBeenCalled()
  })
  it('scans only a verified home owned by the account and accepts no request fields', async () => {
    for (const over of [{ home: '/home/bob' }, { home: '/' }, { uid: 0 }, { type: 'symlink' as const }]) {
      const t = setup(over)
      await expect(t.call('/accounts/alice/virus-scan', 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'account_home_unverified' } }); expect(t.submitJob).not.toHaveBeenCalled()
    }
    for (const [body, type] of [['{"target":"/etc"}', 'application/json'], ['[]', 'application/json'], ['nope', 'application/json'], ['{}', 'text/plain']] as const) await expect(setup().call('/accounts/alice/virus-scan', 'POST', body, type)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setup().call('/accounts/bob/virus-scan', 'POST', '{}')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(setup({ run: null }).call('/accounts/alice/virus-scan', 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'engine_unavailable' } })
    await expect(setup({ noRunner: true }).call('/accounts/alice/virus-scan', 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'jobs_unavailable' } })
  })
  it('reports an unknown outcome when submission or its read-back cannot be proven', async () => {
    await expect(setup({ submitFails: true }).call('/accounts/alice/virus-scan', 'POST', '{}')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
    await expect(setup({ ghost: true }).call('/accounts/alice/virus-scan', 'POST', '{}')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
  })
})
