import { chmod, chown, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disposableVmAcknowledgement } from '../../../scripts/test-linux-preflight.mjs'
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalProvisioningIdentity } from '../../../packages/core/src/account-provisioning-contract.ts'
import { AccountProvisioningPreparationReader, inspectProvisioningPreparation } from './account-provisioning-preparation.ts'

const fixture = () => {
  const input = { reference: '10000000-0000-4000-8000-000000000001', actorKey: 'root:20000000-0000-4000-8000-000000000002', operationKey: 'account.provision:v3:' + 'a'.repeat(64) }
  const key = Buffer.alloc(32, 23)
  const desiredState = { account: { username: 'alice', planId: '30000000-0000-4000-8000-000000000003' }, planIdentity: 'b'.repeat(64), operationKey: input.operationKey,
    authorizationRef: { kind: 'session', principalId: input.actorKey.slice(5), sessionId: '40000000-0000-4000-8000-000000000004', tokenHash: 'c'.repeat(64), entryPoint: 'xwhm' } }
  const requestIdentity = canonicalProvisioningIdentity(desiredState.account)
  const indexName = 'request-' + createHmac('sha256', key).update(JSON.stringify([input.actorKey, input.operationKey])).digest('hex') + '.json'
  const passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$QkJCQkJCQkJCQkJCQkJCQg$02+8XtfLLaSCZqlfA84rmzJ5VytASY+ko8Y0KCBMjk8'
  const record = { schemaVersion: 1, reference: input.reference, actorKey: input.actorKey, indexName, requestIdentity, passwordHash, desiredState,
    desiredStateDigest: createHash('sha256').update(JSON.stringify(desiredState)).digest('hex') }
  const index = { schemaVersion: 1, phase: 'complete', reference: input.reference, actorKey: input.actorKey, requestIdentity }
  return { input, key, record, index }
}

describe('independent completed preparation inspection', () => {
  it('derives metadata from the existing completed record without disclosing credential bytes', () => {
    const value = fixture(), result = inspectProvisioningPreparation(value.input, value)
    expect(result.metadata.preparationIdentity).toBe(canonicalProvisioningIdentity(value.record.desiredState))
    expect(result.metadata.operationKey).toBe(value.input.operationKey)
    expect(JSON.stringify(result)).not.toContain(value.record.passwordHash)
  })

  it('rejects a reserved or mismatched index rather than inventing completion', () => {
    const value = fixture()
    expect(() => inspectProvisioningPreparation(value.input, { ...value, index: { ...value.index, phase: 'reserved' } })).toThrow()
    expect(() => inspectProvisioningPreparation(value.input, { ...value, index: { ...value.index, reference: '50000000-0000-4000-8000-000000000005' } })).toThrow()
  })

  it('rejects a foreign namespace key or changed operation even when the record exists', () => {
    const value = fixture()
    expect(() => inspectProvisioningPreparation(value.input, { ...value, key: Buffer.alloc(32, 24) })).toThrow()
    expect(() => inspectProvisioningPreparation({ ...value.input, operationKey: 'account.provision:v3:' + 'd'.repeat(64) }, value)).toThrow()
  })

  it('rejects a changed credential reference or account while retaining the old desired digest', () => {
    const value = fixture()
    expect(() => inspectProvisioningPreparation(value.input, { ...value, record: { ...value.record,
      desiredState: { ...value.record.desiredState, authorizationRef: { ...value.record.desiredState.authorizationRef, tokenHash: 'e'.repeat(64) } } } })).toThrow()
    expect(() => inspectProvisioningPreparation(value.input, { ...value, record: { ...value.record,
      desiredState: { ...value.record.desiredState, account: { ...value.record.desiredState.account, username: 'mallory' } } } })).toThrow()
  })

  it('does not accept additional record fields or an invalid prepared credential', () => {
    const value = fixture()
    expect(() => inspectProvisioningPreparation(value.input, { ...value, record: { ...value.record, ready: true } })).toThrow()
    expect(() => inspectProvisioningPreparation(value.input, { ...value, record: { ...value.record, passwordHash: 'not-a-credential' } })).toThrow()
  })
})

// This is an owned temporary fixture only. It never opens or repairs canonical /var/lib/xpanel.
it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)('accepts the installed 2770 data root and refuses a group-writable state directory', async () => {
  if (process.env.XPANEL_TEST_DISPOSABLE_VM !== disposableVmAcknowledgement) {
    throw new Error('BLOCKED: explicit root disposable Linux VM acknowledgement required')
  }
  const temporary = await lstat(tmpdir())
  if (!temporary.isDirectory() || temporary.isSymbolicLink() || (temporary.mode & 0o022)) {
    throw new Error('BLOCKED: the disposable VM runner must provide a protected TMPDIR')
  }
  const owner = { uid: temporary.uid > 0 ? temporary.uid : 65534, gid: temporary.gid > 0 ? temporary.gid : 65534 }
  const base = await mkdtemp(join(tmpdir(), 'xpanel-preparation-layout-'))

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
    const privateRoot = join(stateRoot, 'private'), directory = join(privateRoot, 'account-provisioning')
    await ownedDirectory(privateRoot, owner.uid, owner.gid, 0o700)
    await ownedDirectory(directory, owner.uid, owner.gid, 0o700)
    await writeOwned(join(directory, 'namespace-hmac.key'), value.key)
    await writeOwned(join(directory, value.input.reference + '.json'), JSON.stringify(value.record))
    await writeOwned(join(directory, value.record.indexName), JSON.stringify(value.index))
    const read = () => new AccountProvisioningPreparationReader(stateRoot, owner).read(value.input)
    expect((await read()).metadata.operationKey).toBe(value.input.operationKey)
    // The installer creates /var/lib/xpanel as setgid 02770 for its private service group.
    await chmod(parent, 0o2770)
    expect((await read()).metadata.operationKey).toBe(value.input.operationKey)
    await chmod(stateRoot, 0o2770)
    await expect(read()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await chmod(stateRoot, 0o2750)
    expect((await read()).metadata.operationKey).toBe(value.input.operationKey)
  } finally {

    await rm(base, { recursive: true, force: true })
  }
})
