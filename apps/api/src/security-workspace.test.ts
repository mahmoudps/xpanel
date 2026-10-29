import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { SshObservation } from '../../agent/src/services/security-observation.ts'
import { createSecurityWorkspaceRoutes, projectSshObservation, securityEvidenceChecks } from './security-workspace.ts'

// Synthetic authentication, catalog and host ports test this route adapter only.
// Shared server authentication/CSRF and native SSH require separate integration evidence.
const root = { principal: { kind: 'root', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'root' } } as AuthenticatedCaller
const owner = { principal: { kind: 'user', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', username: 'owner', accountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } } as AuthenticatedCaller
const observation = (): SshObservation => ({ observedAt: '2026-10-26T15:00:00Z', policy: { state: 'read', values: { port: '22', pubkeyauthentication: 'yes', passwordauthentication: 'yes', permitrootlogin: 'prohibit-password', maxauthtries: '3' } }, service: { state: 'read', unit: 'ssh.service', active: 'active', substate: 'running', enabled: 'enabled' }, keys: { state: 'read', revision: 'a'.repeat(64), items: [{ fingerprint: 'SHA256:' + 'A'.repeat(43), keyType: 'ssh-ed25519', comment: 'existing', managed: false, protected: true, addedAt: null, lastUsedAt: null }], opaqueEntries: 0 }, failedLogins: { state: 'read', items: [], window: '24h', limit: 500, truncated: false } })
const fixture = () => {
  const helpers = {
    requireCaller: vi.fn(async () => root),
    assertRoot: vi.fn(async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root only') }),
    emitAudit: vi.fn(async (_input: Record<string, unknown>) => undefined), store: { getServerSettings: vi.fn(async () => null) },
    observeSsh: vi.fn(async (input: { window: '24h' | '7d' }) => ({ ...observation(), failedLogins: { ...observation().failedLogins, window: input.window } })),
    addRootKey: vi.fn(async (input: { publicKey: unknown; expectedRevision: unknown }) => {
      const fingerprint = 'SHA256:' + createHash('sha256').update(Buffer.from(String(input.publicKey).split(' ')[1]!, 'base64')).digest('base64').replace(/=+$/, '')
      return { applied: true as const, keys: { ...observation().keys, revision: 'b'.repeat(64), items: [...observation().keys.items, { fingerprint, keyType: 'ssh-ed25519', comment: 'new synthetic key', managed: true, protected: false, addedAt: '2026-10-26T15:01:00Z', lastUsedAt: null }] } }
    }),
    removeManagedRootKey: vi.fn(async (_input: { fingerprint: unknown; expectedRevision: unknown }) => ({ applied: true as const, keys: observation().keys })),
    assertKeyMutationQualified: vi.fn(async () => undefined),
  }
  const handler = createSecurityWorkspaceRoutes(helpers)
  const request = (path: string, method = 'GET', body?: unknown) => {
    const url = new URL('http://localhost' + path)
    return handler(new Request(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method)
  }
  return { helpers, request }
}

describe('root security workspace route boundary', () => {
  it('returns individual observations without an overall security pass or state allocation', async () => {
    const f = fixture(), response = await f.request('/api/security/workspace')
    expect(response?.status).toBe(200)
    const value = await response!.json() as Record<string, unknown>
    expect(value.overall).toBe('not-qualified')
    expect(value.configuration).toEqual({ state: 'unavailable', source: 'saved-configuration' })
    expect(f.helpers.emitAudit).not.toHaveBeenCalled()
    expect(securityEvidenceChecks(observation()).find(check => check.id === 'ssh-password')?.state).toBe('attention')
    expect(securityEvidenceChecks(null).every(check => check.state === 'unavailable')).toBe(true)
  })
  it('refuses non-root access before reading host data or key state', async () => {
    const f = fixture(); f.helpers.requireCaller.mockResolvedValue(owner)
    await expect(f.request('/api/security/ssh')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(f.helpers.observeSsh).not.toHaveBeenCalled()
    await expect(f.request('/api/security/ssh/keys', 'POST', { publicKey: 'synthetic', expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(f.helpers.addRootKey).not.toHaveBeenCalled()
  })
  it('admits only the exact bounded log windows and refuses selectors and duplicate ranges', async () => {
    const f = fixture()
    expect((await f.request('/api/security/ssh?window=7d'))?.status).toBe(200)
    expect(f.helpers.observeSsh).toHaveBeenLastCalledWith({ window: '7d' })
    for (const query of ['?accountId=foreign', '?window=all', '?window=24h&window=7d']) await expect(f.request('/api/security/ssh' + query)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('keeps native mutations unavailable when catalog qualification refuses them', async () => {
    const f = fixture(); f.helpers.assertKeyMutationQualified.mockImplementation(async () => fail('PRECONDITION_FAILED', 'unqualified', { stateChanged: false }))
    const read = await f.request('/api/security/ssh')
    expect(await read!.json()).toMatchObject({ keyActions: { add: false, remove: false } })
    await expect(f.request('/api/security/ssh/keys', 'POST', { publicKey: 'ssh-ed25519 ' + 'A'.repeat(64), expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(f.helpers.addRootKey).not.toHaveBeenCalled(); expect(f.helpers.emitAudit).not.toHaveBeenCalled()
  })
  it.each([{ publicKey: 'x', expectedRevision: 'invalid' }, { publicKey: 'x', expectedRevision: 'a'.repeat(64), accountId: 'foreign' }, { publicKey: 'private\nkey', expectedRevision: 'a'.repeat(64) }])('refuses invalid key bodies before invoking host operations', async input => {
    const f = fixture()
    await expect(f.request('/api/security/ssh/keys', 'POST', input)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.helpers.addRootKey).not.toHaveBeenCalled()
  })
  it('reauthorizes after qualification and before native dispatch', async () => {
    const f = fixture(); f.helpers.requireCaller.mockResolvedValueOnce(root).mockResolvedValueOnce(owner)
    await expect(f.request('/api/security/ssh/keys', 'POST', { publicKey: 'ssh-ed25519 ' + 'A'.repeat(64), expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(f.helpers.addRootKey).not.toHaveBeenCalled()
  })
  it('audits the requested mutation before dispatch and completion only after its verified adapter ACK', async () => {
    const f = fixture(), response = await f.request('/api/security/ssh/keys', 'POST', { publicKey: 'ssh-ed25519 ' + 'A'.repeat(64), expectedRevision: 'a'.repeat(64) })
    expect(response?.status).toBe(200)
    expect(f.helpers.requireCaller).toHaveBeenCalledTimes(3)
    expect(f.helpers.emitAudit.mock.calls.map(call => call[0].action)).toEqual(['security.ssh.key.change_requested', 'security.ssh.key.added'])
    expect(f.helpers.emitAudit.mock.invocationCallOrder[0]).toBeLessThan(f.helpers.addRootKey.mock.invocationCallOrder[0]!)
    expect(await response!.json()).toMatchObject({ applied: true })
    expect(String(f.helpers.emitAudit.mock.calls[1]?.[0].target)).toMatch(/^ssh-key:SHA256:/)
  })
  it('projects the host boundary without forwarding key blobs, raw config fields or arbitrary data', () => {
    const raw = { ...observation(), privateKey: 'DO-NOT-FORWARD' }
    raw.policy.values.privateKey = 'DO-NOT-FORWARD'
    const output = projectSshObservation({ ...raw, keys: { ...raw.keys, items: raw.keys.items.map(item => ({ ...item, publicKey: 'DO-NOT-FORWARD' })) } })
    expect(JSON.stringify(output)).not.toContain('DO-NOT-FORWARD')
    expect(() => projectSshObservation({ ...raw, keys: { ...raw.keys, state: 'unavailable', revision: null } })).toThrow()
  })
})
import { createHash } from 'node:crypto'
