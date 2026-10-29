import { describe, expect, it, vi } from 'vitest'
import type { Account, Plan } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { handleAccountVirusScanRoute, isHomeRelativePath, projectAccountVirusScan } from './account-virus-scan-workspace.ts'
import type { ReadAgent } from './account-ssh-workspace.ts'
import { accountScanKind, handleAccountVirusScanRoute as handleAgentScan } from '../../agent/src/account-virus-scan.ts'
import type { HostJobPlan, HostJobView } from '../../agent/src/host-job-contract.ts'
import { clamscanHomeArgv } from '../../../packages/os/src/security-tools-command.ts'

// The agent route is the actual handler; only the host runner, executor and transport are doubles.
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan' } as Account
const owner = { principal: { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT }, apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false } } as unknown as AuthenticatedCaller
const NOW = new Date('2026-10-27T12:00:00.000Z'), JOB = '00000001-0000-4000-8000-000000000000'
const finished: HostJobView = { id: JOB, referenceCode: null, kind: accountScanKind(ACCOUNT), status: 'succeeded', progress: 100, summary: 'x', accountId: ACCOUNT, actor: 'alice', createdAt: '2026-10-27T11:00:00.000Z', startedAt: null, finishedAt: '2026-10-27T11:01:00.000Z',
  steps: [{ id: 'scan', title: 'x', state: 'succeeded', exitCode: 1 }], error: null, failureClass: null, cancelRequested: false, verification: null, logBytes: 10 }
const log = '$ ' + clamscanHomeArgv('/home/alice').join(' ') + '\n/home/alice/public_html/shell.php: Php.Webshell-1 FOUND\n----------- SCAN SUMMARY -----------\nScanned files: 3\nInfected files: 1\n[exit 1]\n'

function setup(options: { disabled?: string[]; caller?: AuthenticatedCaller; reply?: (value: Record<string, unknown>) => unknown; jobs?: HostJobView[] } = {}) {
  const jobs = [...(options.jobs ?? [finished])], plans: HostJobPlan[] = []
  const readAgent = vi.fn(async (_caller: AuthenticatedCaller, path: string, input?: unknown, _mutation?: boolean, method = 'GET') => {
    const url = new URL('http://agent.local' + path)
    const request = new Request(url, { method: input === undefined ? 'GET' : method, ...(input === undefined ? {} : { body: JSON.stringify(input), headers: { 'content-type': 'application/json' } }) })
    const response = await handleAgentScan(request, url, request.method, {
      caller: { principalId: 'p-alice', actor: 'alice', role: 'user', accountId: ACCOUNT, resellerId: null },
      store: { getAccountByUsername: async () => account, withAccountLifecycleLease: async (_id, operation) => operation(account), getPlan: async () => ({ featureListId: 'list' }) as Plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: [] }) },
      currentPrincipal: async () => ({ kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT, disabled: false }),
      run: async () => ({ ok: true, code: 0, stdout: 'ClamAV 1.0.7/27440/Mon Oct 26 08:21:44 2026\n', stderr: '' }), present: async () => true,
      jobs: { list: (async () => [...jobs].reverse()) as never, readLog: (async (id: string) => ({ id, available: true, offset: 0, nextOffset: log.length, total: log.length, truncated: false, text: log })) as never },
      submitJob: async plan => { plans.push(plan); const job = { ...finished, id: '00000002-0000-4000-8000-000000000000', status: 'queued' as const, createdAt: NOW.toISOString(), finishedAt: null, steps: [{ ...finished.steps[0]!, state: 'pending' as const, exitCode: null }] }; jobs.push(job); return job },
      resolveHome: async home => home, inspectHome: async () => ({ type: 'directory', uid: 1001, gid: 1001, mode: 0o750 }), now: () => NOW,
    })
    const value = await response!.json() as Record<string, unknown>
    return options.reply ? options.reply(value) : value
  })
  const store = { getAccount: async (id: string) => id === ACCOUNT ? account : null, getPlan: async () => ({ featureListId: 'list' }), getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: options.disabled ?? [] }) } as unknown as StateStore
  const ports = { store, requireCaller: async () => options.caller ?? owner, readAgent: readAgent as unknown as ReadAgent }
  const route = (path: string, method = 'GET', body?: string) => { const url = new URL('http://panel.test' + path); return handleAccountVirusScanRoute(new Request(url, { method, ...(body !== undefined ? { body } : {}) }), url, method, ports) }
  return { route, readAgent, plans }
}

describe('account virus scan workspace', () => {
  it('reads the session account status with home-relative findings only', async () => {
    const t = setup(), response = await t.route('/api/account/virus-scan'), body = await response!.json() as Record<string, any>
    expect(t.readAgent.mock.calls[0]![1]).toBe('/accounts/alice/virus-scan'); expect(t.readAgent.mock.calls[0]![2]).toBeUndefined()
    expect(body.engine).toMatchObject({ state: 'read', signatureVersion: 27440 }); expect(body.start).toEqual({ allowed: true, reason: null, availableAt: null })
    expect(body.scans).toEqual([expect.objectContaining({ jobId: JOB, result: 'infected', infected: [{ path: 'public_html/shell.php', signature: 'Php.Webshell-1' }] })]); expect(JSON.stringify(body)).not.toContain('/home/alice')
    expect(await t.route('/api/account/other')).toBeNull()
  })
  it('starts one scan with an empty body after fresh authority and returns the read-back', async () => {
    const t = setup(), response = await t.route('/api/account/virus-scan', 'POST', '{}'), body = await response!.json() as Record<string, any>
    expect(response!.status).toBe(202); expect(t.readAgent.mock.calls[0]!.slice(1)).toEqual(['/accounts/alice/virus-scan', {}, true, 'POST'])
    expect(t.plans).toHaveLength(1); expect(t.plans[0]).toMatchObject({ kind: accountScanKind(ACCOUNT), accountId: ACCOUNT })
    expect(body.started).toEqual({ jobId: '00000002-0000-4000-8000-000000000000' }); expect(body.start.reason).toBe('scan_active')
  })
  it('refuses selectors, fields, other roles and a disabled plan feature before any agent call', async () => {
    const t = setup()
    for (const [path, method, body] of [['/api/account/virus-scan?account=bob', 'GET'], ['/api/account/virus-scan', 'POST', '{"target":"/etc"}'], ['/api/account/virus-scan', 'POST', '[]'], ['/api/account/virus-scan', 'POST', 'x']] as const)
      await expect(t.route(path, method, body)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await t.route('/api/account/virus-scan', 'DELETE'))!.status).toBe(405)
    for (const kind of ['root', 'reseller'] as const) await expect(setup({ caller: { ...owner, principal: { kind, id: kind, username: kind } } as unknown as AuthenticatedCaller }).route('/api/account/virus-scan')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setup({ caller: { ...owner, principal: { ...owner.principal, accountId: '99999999-9999-4999-8999-999999999999' } } as unknown as AuthenticatedCaller }).route('/api/account/virus-scan')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    for (const disabled of [['virus-scanner'], ['clamavconnector_scan']]) await expect(setup({ disabled }).route('/api/account/virus-scan')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(t.readAgent).not.toHaveBeenCalled()
  })
  it('rejects foreign, absolute or malformed agent replies; an unprovable start is an unknown outcome', async () => {
    const replies: ((value: Record<string, any>) => unknown)[] = [
      value => ({ ...value, context: { accountId: ACCOUNT, username: 'bob' } }),
      value => ({ ...value, scans: [{ ...value.scans[0], infected: [{ path: '/home/alice/public_html/shell.php', signature: 'Php.Webshell-1' }] }] }),
      value => ({ ...value, scans: [{ ...value.scans[0], infected: [{ path: '../bob/x', signature: 'Php.Webshell-1' }] }] }),
      value => ({ ...value, start: { allowed: true, reason: 'cooldown', availableAt: null } }),
      value => ({ ...value, limits: { history: 1000, cooldownMinutes: 15, findingsPerScan: 50 } }),
      value => ({ ...value, scans: Array.from({ length: 11 }, () => value.scans[0]) }),
    ]
    for (const reply of replies) await expect(setup({ reply }).route('/api/account/virus-scan')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
    await expect(setup({ reply: value => ({ ...value, started: null }) }).route('/api/account/virus-scan', 'POST', '{}')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
    expect(projectAccountVirusScan(null, account, false)).toBeNull()
    expect(['.', 'a/b.php', 'x'].every(isHomeRelativePath)).toBe(true); expect(['', '/etc', 'a//b', './a', 'a/../b', 'a\u202eb'].some(isHomeRelativePath)).toBe(false)
  })
})
