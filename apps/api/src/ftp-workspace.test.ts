import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SERVER_FTP_SETTINGS } from '@xpanel/core'
import { describe, expect, it, vi } from 'vitest'
import { handleFtpWorkspaceRoute, validateFtpReport, validateFtpSessions } from './ftp-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111'
const account = { id: accountId, username: 'alice', status: 'active', planId: 'p', ownerId: null }
const owner = { principal: { kind: 'user', id: 'u1', username: 'alice', accountId }, scopes: [] }
const root = { principal: { kind: 'root', id: 'r1', username: 'root' } }
const stateRoot = async () => mkdtemp(join(tmpdir(), 'ftp-ws-'))
const lock = { acquire: async () => ({ assertFencingToken: async () => undefined, release: async () => undefined }) }
const helpers = (rootDir: string, caller: unknown, settings: unknown, over: Record<string, unknown> = {}) => ({
  store: { rootDir, getWriterLock: () => lock, getAccount: async () => account, getServerSettings: async () => settings, saveServerSettings: vi.fn(async (next: unknown) => next), listDomains: async () => [{ name: 'example.test' }], getPlan: async () => ({ featureListId: 'f' }), getFeatureList: async () => ({ disabled: [] }) },
  requireCaller: async () => caller, assertRoot: vi.fn(async () => undefined), emitAudit: vi.fn(async () => undefined), triggerReconcile: vi.fn(async () => ({ ok: true, status: 200, body: {} })), readAgent: vi.fn(async (_c: unknown, _p: string, input?: { welcome?: string }) => ({ welcome: input?.welcome ?? 'Hi' })), ...over,
}) as unknown as Parameters<typeof handleFtpWorkspaceRoute>[3]
const call = (path: string, method: string, input: Parameters<typeof handleFtpWorkspaceRoute>[3], body?: unknown) => handleFtpWorkspaceRoute(new Request('http://api' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), new URL('http://api' + path), method, input)

describe('FTP server settings route', () => {
  it('reads defaults, saves through the root guard and reconciles', async () => {
    const dir = await stateRoot(), input = helpers(dir, root, { hostname: 'h' })
    expect(await (await call('/api/server/ftp/settings', 'GET', input))!.json()).toEqual({ settings: DEFAULT_SERVER_FTP_SETTINGS, saved: false })
    const settings = { ...DEFAULT_SERVER_FTP_SETTINGS, maxConnectionsPerIp: 2 }
    const reply = await (await call('/api/server/ftp/settings', 'PUT', input, { settings }))!.json() as Record<string, unknown>
    expect(reply).toMatchObject({ saved: true, application: { status: 'applied' } })
    expect((input as unknown as { triggerReconcile: { mock: { calls: unknown[] } } }).triggerReconcile.mock.calls).toHaveLength(1)
    await rm(dir, { recursive: true, force: true })
  })
  it('refuses cleartext FTP before saving', async () => {
    const dir = await stateRoot(), input = helpers(dir, root, { hostname: 'h' })
    await expect(call('/api/server/ftp/settings', 'PUT', input, { settings: { ...DEFAULT_SERVER_FTP_SETTINGS, tls: 'disabled' } })).rejects.toThrow(/plaintext-only/)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('Anonymous FTP route', () => {
  const allowed = { ftp: { ...DEFAULT_SERVER_FTP_SETTINGS, anonymous: true, anonymousUploads: false } }
  it('refuses while the server does not allow it, and uploads the server closed', async () => {
    const dir = await stateRoot(), input = helpers(dir, owner, { ...allowed, ftp: DEFAULT_SERVER_FTP_SETTINGS })
    const view = await (await call('/api/account/ftp/anonymous', 'GET', input))!.json() as { revision: string }
    await expect(call('/api/account/ftp/anonymous', 'PUT', input, { enabled: true, uploads: false, welcome: '', expectedRevision: view.revision })).rejects.toThrow(/does not allow anonymous FTP/)
    await expect(call('/api/account/ftp/anonymous', 'PUT', helpers(dir, owner, allowed), { enabled: true, uploads: true, welcome: '', expectedRevision: view.revision })).rejects.toThrow(/anonymous uploads/)
    await rm(dir, { recursive: true, force: true })
  })
  it('saves, applies, then writes the welcome file; a stale revision conflicts', async () => {
    const dir = await stateRoot(), input = helpers(dir, owner, allowed)
    const view = await (await call('/api/account/ftp/anonymous', 'GET', input))!.json() as { revision: string; logins: string[] }
    expect(view.logins).toEqual(['anonymous@example.test'])
    const saved = await (await call('/api/account/ftp/anonymous', 'PUT', input, { enabled: true, uploads: false, welcome: 'Hello', expectedRevision: view.revision }))!.json() as Record<string, unknown>
    expect(saved).toMatchObject({ enabled: true, uploads: false, welcome: 'Hello', application: { status: 'applied' } })
    await expect(call('/api/account/ftp/anonymous', 'PUT', input, { enabled: false, uploads: false, welcome: '', expectedRevision: view.revision })).rejects.toThrow(/reload/)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('agent reply validation', () => {
  it('rejects a session or report of another account', () => {
    const session = { context: { accountId, username: 'alice' }, state: 'read', observedAt: '2026-11-07T10:00:00.000Z', sessions: [{ pid: 2, login: 'a', seconds: 1, state: 'idle', file: null, client: '203.0.113.1' }] }
    expect(validateFtpSessions(session, accountId).sessions).toHaveLength(1)
    expect(() => validateFtpSessions(session, 'other')).toThrow()
    expect(() => validateFtpSessions({ ...session, sessions: [{ ...session.sessions[0], extra: 1 }] }, accountId)).toThrow()
    const report = { context: { accountId, username: 'alice' }, state: 'read', month: '2026-11', observedAt: session.observedAt, window: null, totals: { transfers: 0, downloads: 0, uploads: 0, bytes: 0 }, days: [], hours: [], users: [] }
    expect(validateFtpReport(report, accountId, '2026-11').month).toBe('2026-11')
    expect(() => validateFtpReport(report, accountId, '2026-10')).toThrow()
  })
})
