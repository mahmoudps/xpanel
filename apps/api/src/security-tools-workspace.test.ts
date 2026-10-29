import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleSecurityToolsWorkspaceRoute, projectAntivirus, projectIntrusion, projectIsolation, projectUnban } from './security-tools-workspace.ts'
import type { SecurityToolsWorkspaceHelpers } from './security-tools-workspace.ts'

const root = { principal: { kind: 'root', id: 'root-1', username: 'root' } } as AuthenticatedCaller
const observedAt = '2026-10-27T10:00:00.000Z'
const intrusion = { state: 'read', observedAt, jails: [{ name: 'sshd', state: 'read', currentlyFailed: 1, totalFailed: 9, currentlyBanned: 1, totalBanned: 3, banned: ['192.0.2.1'], truncated: false }], unsupportedJails: 0, jailsTruncated: false }
const jobId = '22222222-2222-4222-8222-222222222222'
const antivirus = { observedAt, engine: { state: 'read', version: '1.0.7', signatureVersion: 27440, signatureDate: 'Mon Oct 26 08:21:44 2026' }, updater: { present: true }, jobsAvailable: true, accounts: [{ username: 'alice', status: 'active' }],
  scans: [{ jobId, referenceCode: 'XP-JOB-2026-000123', account: 'alice', target: '/home/alice', status: 'failed', result: 'infected', exitCode: 1, createdAt: observedAt, finishedAt: observedAt, summary: { knownViruses: 1, engineVersion: '1.0.7', scannedDirectories: 1, scannedFiles: 2, infectedFiles: 1, dataScanned: '1 MB', time: '1 sec' }, infected: [{ path: '/home/alice/x.php', signature: 'Php.Webshell-1' }], listComplete: true }],
  updates: [{ jobId, referenceCode: null, status: 'failed', result: 'up_to_date', exitCode: 1, createdAt: observedAt, finishedAt: observedAt, signatureVersion: null }] }
it('preserves authoritative antivirus references and rejects internal or missing references', () => {
  expect(projectAntivirus(antivirus).scans[0]!.referenceCode).toBe('XP-JOB-2026-000123')
  expect(projectAntivirus(antivirus).updates[0]!.referenceCode).toBeNull()
  for (const referenceCode of [undefined, jobId, 'XP-JOB-000000', 'bad\u202eref']) expect(() => projectAntivirus({ ...antivirus, scans: [{ ...antivirus.scans[0], referenceCode }] })).toThrow()
})
const report = { username: 'alice', uid: 1001, status: 'active', observedAt, state: 'drift', counts: { ok: 1, drift: 1, unavailable: 0 }, checks: [{ id: 'passwd', state: 'ok', expected: '1001:1001 /home/alice', observed: '1001:1001 /home/alice' }, { id: 'home', state: 'drift', expected: 'directory 1001:1001 0750', observed: 'directory 1001:1001 0755' }] }
const post = (path: string, body: unknown) => new Request('http://localhost' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const get = (path: string) => new Request('http://localhost' + path)
const call = (req: Request, helpers: SecurityToolsWorkspaceHelpers) => handleSecurityToolsWorkspaceRoute(req, new URL(req.url), req.method, helpers)
const helpers = (reply: (path: string, body?: unknown) => unknown, overrides: Partial<SecurityToolsWorkspaceHelpers> = {}) => {
  const events: string[] = []
  const value: SecurityToolsWorkspaceHelpers = {
    requireCaller: vi.fn(async () => { events.push('auth'); return root }), assertRoot: vi.fn(async (_caller, action: string) => { events.push('root:' + action) }),
    emitAudit: vi.fn(async (entry: { action: string; outcome: string }) => { events.push('audit:' + entry.action + ':' + entry.outcome) }),
    callHost: vi.fn(async (_caller, path: string, body?: unknown) => { events.push('host:' + path); return reply(path, body) }), ...overrides,
  }
  return { value, events }
}

describe('API security tools workspace', () => {
  it('leaves unrelated routes untouched and refuses non-root callers before the agent', async () => {
    const { value } = helpers(() => intrusion)
    expect(await call(get('/api/server/security/ssh'), value)).toBeNull()
    expect(value.requireCaller).not.toHaveBeenCalled()
    const denied = helpers(() => intrusion, { assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN', status: 403 }) } })
    for (const req of [get('/api/server/security-tools/intrusion'), post('/api/server/security-tools/intrusion/unban', { jail: 'sshd', address: '192.0.2.1' }), post('/api/server/security-tools/antivirus/scan', { account: 'alice' }), get('/api/server/security-tools/isolation?account=alice')])
      await expect(call(req, denied.value)).rejects.toMatchObject({ status: 403 })
    expect(denied.value.callHost).not.toHaveBeenCalled()
  })
  it('rejects unknown keys, injected identities, selectors and wrong methods before the agent', async () => {
    const { value } = helpers(() => intrusion)
    expect((await call(new Request('http://localhost/api/server/security-tools/antivirus', { method: 'POST' }), value))!.status).toBe(405)
    for (const req of [get('/api/server/security-tools/intrusion?jail=sshd'), get('/api/server/security-tools/isolation?account=a%20b'), get('/api/server/security-tools/isolation?account=alice&x=1'),
      post('/api/server/security-tools/intrusion/unban', { jail: 'sshd', address: '192.0.2.1', jailPath: '/etc' }), post('/api/server/security-tools/intrusion/unban', { jail: 'sshd;id', address: '192.0.2.1' }), post('/api/server/security-tools/intrusion/unban', { jail: 'sshd', address: '--all' }),
      post('/api/server/security-tools/antivirus/scan', { account: 'alice', target: '/' }), post('/api/server/security-tools/antivirus/scan', { account: '/home/alice' }), post('/api/server/security-tools/antivirus/update', { quiet: false })])
      await expect(call(req, value)).rejects.toMatchObject({ code: 'VALIDATION', status: 400, detail: { stateChanged: false } })
    expect(value.callHost).not.toHaveBeenCalled()
  })
  it('states unavailability truthfully without a host agent', async () => {
    const { value } = helpers(() => intrusion, { callHost: undefined })
    await expect(call(get('/api/server/security-tools/intrusion'), value)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    await expect(call(post('/api/server/security-tools/antivirus/update', {}), value)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('projects host reads, dropping unknown fields and refusing inconsistent evidence', async () => {
    const { value, events } = helpers(path => path.includes('intrusion') ? { ...intrusion, internal: 'x' } : path.includes('antivirus') ? antivirus : { accounts: [{ username: 'alice', status: 'active' }], report })
    expect(await (await call(get('/api/server/security-tools/intrusion'), value))!.json()).toEqual(intrusion)
    expect(await (await call(get('/api/server/security-tools/antivirus'), value))!.json()).toEqual(antivirus)
    expect(await (await call(get('/api/server/security-tools/isolation?account=alice'), value))!.json()).toEqual({ accounts: [{ username: 'alice', status: 'active' }], report })
    expect(events).toContain('host:/host/security-tools/isolation?account=alice')
    for (const bad of [{ ...intrusion, state: 'not_installed' }, { ...intrusion, jails: [{ ...intrusion.jails[0], banned: ['192.0.2.1;id'] }] }, { ...intrusion, state: 'unavailable', jails: [] }, { ...intrusion, jails: [{ ...intrusion.jails[0], name: '-h' }] }]) expect(() => projectIntrusion(bad)).toThrow()
    for (const bad of [{ ...antivirus, scans: [{ ...antivirus.scans[0], infected: [{ path: '/home/bob/x.php', signature: 'X' }] }] }, { ...antivirus, scans: [{ ...antivirus.scans[0], account: 'bob' }] }, { ...antivirus, engine: { state: 'not_installed', version: '1.0', signatureVersion: null, signatureDate: null } }]) expect(() => projectAntivirus(bad)).toThrow()
    for (const bad of [{ accounts: [], report: { ...report, state: 'ok' } }, { accounts: [], report: { ...report, counts: { ok: 2, drift: 0, unavailable: 0 } } }, { accounts: [], report: { ...report, username: 'bob' } }, { accounts: [], report: null }]) expect(() => projectIsolation(bad, 'alice')).toThrow()
    expect(projectIsolation({ accounts: [], report: null }, null)).toEqual({ accounts: [], report: null })
  })
  it('unbans with fresh authority before and after the host call and audits the observed outcome', async () => {
    const result = { jail: 'sshd', address: '192.0.2.1', outcome: 'confirmed', verificationRequired: false, after: { banned: false }, observedAt }
    const { value, events } = helpers(() => result)
    expect(await (await call(post('/api/server/security-tools/intrusion/unban', { jail: 'sshd', address: '192.0.2.1' }), value))!.json()).toEqual(result)
    expect(events).toEqual(['auth', 'root:server.security-tools.unban', 'auth', 'root:server.security-tools.unban', 'host:/host/security-tools/intrusion/unban', 'auth', 'root:server.security-tools.unban', 'audit:server.security_tools.unban:ok'])
    expect(() => projectUnban({ ...result, after: { banned: true } }, { jail: 'sshd', address: '192.0.2.1' })).toThrow()
    expect(() => projectUnban({ ...result, address: '192.0.2.2' }, { jail: 'sshd', address: '192.0.2.1' })).toThrow()
  })
  it('passes a 409 conflict through and audits it as refused', async () => {
    const { value, events } = helpers(() => { throw Object.assign(new Error('the protected host request was refused'), { code: 'CONFLICT', status: 409, detail: { stateChanged: false } }) })
    await expect(call(post('/api/server/security-tools/intrusion/unban', { jail: 'sshd', address: '192.0.2.1' }), value)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(events.at(-1)).toBe('audit:server.security_tools.unban:failed')
    expect(value.emitAudit).toHaveBeenLastCalledWith(expect.objectContaining({ detail: { outcome: 'refused' } }))
  })
  it('returns 202 job acknowledgements for scans and signature updates only when the job is verifiable', async () => {
    const { value } = helpers((path, body) => ({ job: { id: jobId, referenceCode: 'XP-JOB-2026-000123', kind: path.endsWith('/scan') ? 'security.antivirus.scan' : 'security.antivirus.signatures', status: 'queued', extra: body } }))
    const scan = (await call(post('/api/server/security-tools/antivirus/scan', { account: 'alice' }), value))!
    expect(scan.status).toBe(202)
    expect(await scan.json()).toEqual({ job: { id: jobId, referenceCode: 'XP-JOB-2026-000123', kind: 'security.antivirus.scan', status: 'queued' } })
    expect(value.callHost).toHaveBeenCalledWith(root, '/host/security-tools/antivirus/scan', { account: 'alice' })
    expect((await call(post('/api/server/security-tools/antivirus/update', {}), value))!.status).toBe(202)
    const wrong = helpers(() => ({ job: { id: jobId, kind: 'system.packages.upgrade', status: 'queued' } }))
    await expect(call(post('/api/server/security-tools/antivirus/scan', { account: 'alice' }), wrong.value)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { unknownOutcome: true } })
  })
})
