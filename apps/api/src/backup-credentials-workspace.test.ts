import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createBackupCredentialsWorkspaceRoutes, readBackupCredentialViews } from './backup-credentials-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'

const root = { principal: { id: 'root-id', kind: 'root', username: 'root' }, sessionId: 'session', apiTokenId: null } as AuthenticatedCaller
const KEY = 'ssh-ed25519 ' + 'A'.repeat(68) + ' xpanel-backup-vault'
const local = { ref: 'local-disk', label: 'This server (separate disk)', kinds: ['local'], revision: 'a'.repeat(64), publicKey: null }
const vault = { ref: 'vault', label: 'Vault key', kinds: ['sftp'], revision: 'b'.repeat(64), publicKey: KEY }
const setup = (host: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>) => {
  let caller: AuthenticatedCaller = root
  const audit = vi.fn(async () => {}), destinationHost = vi.fn(host)
  const route = createBackupCredentialsWorkspaceRoutes({ requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async (c: AuthenticatedCaller) => { if (c.principal.kind !== 'root') fail('FORBIDDEN', 'root access is required') }), emitAudit: audit, destinationHost } as never)
  const call = (method = 'GET', body?: unknown, path = '/api/backups/workspace/credentials') => route(new Request('http://api' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api' + path), method)
  return { call, audit, destinationHost, swap: (next: AuthenticatedCaller) => { caller = next } }
}

describe('backup credential profiles API', () => {
  it('lists profiles without secrets and refuses a reply carrying anything else', async () => {
    const t = setup(async () => ({ profiles: [local, vault] }))
    expect(await (await t.call())!.json()).toEqual({ profiles: [local, vault] })
    expect(() => readBackupCredentialViews([{ ...vault, privateKey: 'x' }])).toThrow()
    expect(() => readBackupCredentialViews([{ ...vault, publicKey: '-----BEGIN OPENSSH PRIVATE KEY-----' }])).toThrow()
    expect(() => readBackupCredentialViews([{ ...local, publicKey: KEY }])).toThrow()
  })
  it('creates a key pair with fresh root authority, audits it and returns only the public key', async () => {
    const t = setup(async (_caller, _path, body) => body ? { profile: vault } : { profiles: [] })
    const response = await t.call('POST', { ref: 'vault', label: 'Vault key' })
    expect(response!.status).toBe(201)
    expect(await response!.json()).toEqual({ profile: vault })
    expect(t.destinationHost).toHaveBeenLastCalledWith(root, '/host/backups/credentials', { ref: 'vault', label: 'Vault key' })
    expect(t.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'backup.credential.created', target: 'backup-credential:vault' }))
    await expect(t.call('POST', { ref: 'vault' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await t.call('DELETE'))!.status).toBe(405)
    t.swap({ ...root, principal: { id: 'u', kind: 'user', username: 'alice' } } as AuthenticatedCaller)
    await expect(t.call('POST', { ref: 'vault', label: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('marks a lost creation reply as requiring review', async () => {
    const t = setup(async (_caller, _path, body) => { if (body) throw new Error('socket hang up'); return { profiles: [] } })
    await expect(t.call('POST', { ref: 'vault', label: 'Vault key' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    expect(t.audit).not.toHaveBeenCalled()
  })
})
