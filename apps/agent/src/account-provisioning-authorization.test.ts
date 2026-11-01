import { chmod, chown, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disposableVmAcknowledgement } from '../../../scripts/test-linux-preflight.mjs'
import { describe, expect, it } from 'vitest'
import { createDb, type ApiTokenRecord, type PrincipalRecord, type SessionRecord } from '@xpanel/db'
import { canonicalProvisioningIdentity } from '../../../packages/core/src/account-provisioning-contract.ts'
import { assertProvisioningAuthorization, provisioningAuthorizationPorts, type ProvisioningAuthorizationReadPorts, type ProvisioningAuthorizationReference } from './account-provisioning-authorization.ts'

const principalId = '10000000-0000-4000-8000-000000000001'
const planId = '20000000-0000-4000-8000-000000000002'
const sessionId = '30000000-0000-4000-8000-000000000003'
const tokenId = '40000000-0000-4000-8000-000000000004'
const tokenHash = 'a'.repeat(64)
const actor = { id: principalId, kind: 'root' as const, username: 'admin' }
const fixture = () => {
  const now = Date.now()
  let principal = { ...actor, disabled: false, forcePasswordChange: false, totpEnabled: false, totpSecretEnc: null } as unknown as PrincipalRecord
  let session: SessionRecord | null = { id: sessionId, principalId, tokenHash, createdAt: new Date(now - 1000).toISOString(), lastSeenAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    revokedAt: null, mfaVerified: false, impersonatorPrincipalId: null, impersonatorTeamMemberId: null, impersonatorLogin: null, ip: null, userAgent: null }
  let token = { id: tokenId, principalId, tokenHash, revokedAt: null, expiresAt: new Date(now + 60_000).toISOString(), scopes: ['accounts:write'], allowedIps: ['192.0.2.0/24'] } as unknown as ApiTokenRecord
  const saved = { version: 1, apiIdentifier: 'fixture-whmcs', enabled: true, autoCreate: true, allowedAddresses: ['192.0.2.0/24'], planMap: [{ package: 'basic', planId }],
    ssoTarget: 'xpanel', token: { sha256: tokenHash, hint: 'fixture', createdAt: new Date(now).toISOString(), issuedBy: principalId }, updatedAt: new Date(now).toISOString(), whmcsUrl: 'https://billing.example.test' }
  const ports: ProvisioningAuthorizationReadPorts = { principal: async () => principal, session: async () => session, apiToken: async () => token, whmcs: async () => saved }
  const check = (reference: ProvisioningAuthorizationReference, mode: 'disabled' | 'optional' = 'optional') => assertProvisioningAuthorization({ reference, actor, planId, ports, policy: { mode } })
  return { check, saved, ports, setPrincipal: (value: Partial<PrincipalRecord>) => { principal = { ...principal, ...value } },
    revokeSession: () => { session = null }, setSession: (value: Partial<SessionRecord>) => { session = { ...session!, ...value } }, setToken: (value: Partial<ApiTokenRecord>) => { token = { ...token, ...value } } }
}

describe('protected original provisioning credential', () => {
  const session: ProvisioningAuthorizationReference = { kind: 'session', principalId, sessionId, tokenHash, entryPoint: 'xwhm' }
  const apiToken: ProvisioningAuthorizationReference = { kind: 'api-token', principalId, tokenId, tokenHash, clientIp: '192.0.2.10', scope: 'accounts:write' }

  it('rereads the original session rather than accepting an enabled principal alone', async () => {
    const f = fixture()
    await f.check(session)
    f.revokeSession()
    await expect(f.check(session)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects expired, forced-password and impersonated sessions before the next effect', async () => {
    const expired = fixture(); expired.setSession({ lastSeenAt: new Date(0).toISOString() })
    await expect(expired.check(session)).rejects.toThrow()
    const forced = fixture(); forced.setPrincipal({ forcePasswordChange: true })
    await expect(forced.check(session)).rejects.toThrow()
    const handedOff = fixture(); handedOff.setSession({ impersonatorPrincipalId: '50000000-0000-4000-8000-000000000005' })
    await expect(handedOff.check(session)).rejects.toThrow()
  })

  it('keeps development MFA disabled and verifies an opted-in production factor', async () => {
    const f = fixture()
    f.setPrincipal({ totpEnabled: true, totpSecretEnc: new Uint8Array(32) })
    await f.check(session, 'disabled')
    await expect(f.check(session, 'optional')).rejects.toThrow()
    f.setSession({ mfaVerified: true })
    await f.check(session, 'optional')
  })

  it('checks current API-token scope, source address and revocation', async () => {
    const f = fixture()
    await f.check(apiToken)
    f.setToken({ scopes: ['accounts:read'] })
    await expect(f.check(apiToken)).rejects.toThrow()
    f.setToken({ scopes: ['accounts:*'], allowedIps: ['198.51.100.0/24'] })
    await expect(f.check(apiToken)).rejects.toThrow()
    f.setToken({ allowedIps: [], revokedAt: new Date().toISOString() })
    await expect(f.check(apiToken)).rejects.toThrow()
  })

  it('binds WHMCS array mappings, exact active token, issuer and saved record', async () => {
    const f = fixture()
    const ref: ProvisioningAuthorizationReference = { kind: 'whmcs', principalId, apiIdentifier: f.saved.apiIdentifier, tokenSha256: tokenHash,
      recordIdentity: canonicalProvisioningIdentity(f.saved), clientIp: '192.0.2.10', package: 'basic', planId }
    await f.check(ref)
    await expect(f.check({ ...ref, package: 'other' })).rejects.toThrow()
    f.saved.token.sha256 = 'b'.repeat(64)
    await expect(f.check(ref)).rejects.toThrow()
    f.saved.token.sha256 = tokenHash
    f.setPrincipal({ disabled: true })
    await expect(f.check(ref)).rejects.toThrow()
  })

  it('does not accept public-body extras or a different credential lookup id', async () => {
    const f = fixture()
    await expect(assertProvisioningAuthorization({ reference: { ...session, skipAuth: true }, actor, planId, ports: f.ports, policy: { mode: 'optional' } })).rejects.toThrow()
    await expect(f.check({ ...session, sessionId: tokenId })).rejects.toThrow()
  })
})

// This is an owned temporary fixture only. It never opens or repairs canonical /var/lib/xpanel.
it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)('reads the installed layout, denies parent mode 2770, then accepts a fixture correction to 2750', async () => {
  if (process.env.XPANEL_TEST_DISPOSABLE_VM !== disposableVmAcknowledgement) {
    throw new Error('BLOCKED: explicit root disposable Linux VM acknowledgement required')
  }
  const temporary = await lstat(tmpdir())
  if (!temporary.isDirectory() || temporary.isSymbolicLink() || (temporary.mode & 0o022)) {
    throw new Error('BLOCKED: the disposable VM runner must provide a protected TMPDIR')
  }
  const owner = { uid: temporary.uid > 0 ? temporary.uid : 65534, gid: temporary.gid > 0 ? temporary.gid : 65534 }
  const base = await mkdtemp(join(tmpdir(), 'xpanel-whmcs-layout-'))
  let database: ReturnType<typeof createDb> | undefined
  try {
    await chmod(base, 0o700)
    const parent = join(base, 'xpanel'), stateRoot = join(parent, 'state')
    const ownedDirectory = async (path: string, uid: number, gid: number, mode: number) => {
      await mkdir(path)
      await chown(path, uid, gid)
      await chmod(path, mode)
    }
    await ownedDirectory(parent, owner.uid, owner.gid, 0o2750)
    await ownedDirectory(stateRoot, owner.uid, owner.gid, 0o2750)
    const writeOwned = async (path: string, bytes: string | Uint8Array) => {
      await writeFile(path, bytes, { mode: 0o600 })
      await chown(path, owner.uid, owner.gid)
      await chmod(path, 0o600)
    }
    const value = fixture()
    const extended = join(stateRoot, 'extended'), directory = join(extended, 'integrations')
    await ownedDirectory(extended, owner.uid, owner.gid, 0o700)
    await ownedDirectory(directory, owner.uid, owner.gid, 0o700)
    await writeOwned(join(directory, 'whmcs.json'), JSON.stringify(value.saved))
    database = createDb(':memory:')
    const ports = provisioningAuthorizationPorts({ db: database.db, stateRoot, owner })
    const read = () => ports.whmcs()
    await expect(read()).resolves.toEqual(value.saved)
    await chmod(parent, 0o2770)
    const before = await lstat(parent)
    await expect(read()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // Only this private fixture is changed; relay's fixed-target normalizer is tested separately.
    await chmod(parent, 0o2750)
    const after = await lstat(parent)
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
    await expect(read()).resolves.toEqual(value.saved)
  } finally {
    try { await database?.close() }
    finally { await rm(base, { recursive: true, force: true }) }
  }
})
