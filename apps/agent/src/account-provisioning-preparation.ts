import { createHash, createHmac } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import { assertArgon2Hash, fail, isUuid, isXpanelError } from '@xpanel/core'
import { canonicalProvisioningIdentity } from '../../../packages/core/src/account-provisioning-contract.ts'
import type { VerifiedPreparationMetadata } from './account-provisioning-handler.ts'
import { parseProvisioningAuthorizationReference, type ProvisioningAuthorizationReference } from './account-provisioning-authorization.ts'

const MAX_BYTES = 2 * 1024 * 1024
const HEX = /^[0-9a-f]{64}$/
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const refuse = (): never => fail('PRECONDITION_FAILED', 'the protected account preparation is unavailable or changed', { stateChanged: false, verificationRequired: true })
const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!record(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) return refuse()
  return value
}

export interface ProvisioningPreparationIdentity {
  readonly reference: string
  readonly actorKey: string
  readonly operationKey: string
}

/** Internal read-only projection. Credential bytes never leave the reader. */
export interface VerifiedProvisioningPreparation {
  readonly metadata: VerifiedPreparationMetadata
  readonly authorizationRef: ProvisioningAuthorizationReference
}

/** Pure validation of the existing API-owned serialized authority; not native acceptance. */
export function inspectProvisioningPreparation(
  input: ProvisioningPreparationIdentity,
  material: { readonly key: Uint8Array; readonly record: unknown; readonly index: unknown; readonly authorization?: unknown },
): VerifiedProvisioningPreparation {
  if (!isUuid(input.reference) || !/^(root|reseller):[0-9a-f-]{36}$/i.test(input.actorKey)
    || !/^account\.provision:v3:[0-9a-f]{64}$/.test(input.operationKey) || material.key.byteLength !== 32) return refuse()
  const indexName = 'request-' + createHmac('sha256', material.key).update(JSON.stringify([input.actorKey, input.operationKey])).digest('hex') + '.json'
  const source = exact(material.record, ['schemaVersion', 'reference', 'actorKey', 'indexName', 'requestIdentity', 'passwordHash', 'desiredState', 'desiredStateDigest'])
  const index = exact(material.index, ['schemaVersion', 'phase', 'reference', 'actorKey', 'requestIdentity'])
  const desired = source.desiredState
  if (source.schemaVersion !== 1 || source.reference !== input.reference || source.actorKey !== input.actorKey || source.indexName !== indexName
    || !record(desired) || !record(desired.account) || desired.operationKey !== input.operationKey
    || typeof desired.planIdentity !== 'string' || !HEX.test(desired.planIdentity)
    || source.requestIdentity !== canonicalProvisioningIdentity(desired.account)
    || source.desiredStateDigest !== createHash('sha256').update(JSON.stringify(desired)).digest('hex')
    || index.schemaVersion !== 1 || index.phase !== 'complete' || index.reference !== input.reference
    || index.actorKey !== input.actorKey || index.requestIdentity !== source.requestIdentity) return refuse()
  if (typeof source.passwordHash !== 'string') return refuse()
  try { assertArgon2Hash(source.passwordHash) } catch { return refuse() }
  const original = parseProvisioningAuthorizationReference(desired.authorizationRef)
  // A verified retry records its own live credential; it may only be another credential of the same principal.
  let authorizationRef = original
  if (material.authorization !== undefined) {
    const current = exact(material.authorization, ['schemaVersion', 'reference', 'actorKey', 'authorization'])
    if (current.schemaVersion !== 1 || current.reference !== input.reference || current.actorKey !== input.actorKey) return refuse()
    authorizationRef = parseProvisioningAuthorizationReference(current.authorization)
    if (authorizationRef.principalId !== original.principalId) return refuse()
  }
  return {
    metadata: {
      reference: input.reference, actorKey: input.actorKey, operationKey: input.operationKey,
      requestIdentity: source.requestIdentity as string, preparationIdentity: canonicalProvisioningIdentity(desired),
      desiredStateDigest: source.desiredStateDigest as string, planIdentity: desired.planIdentity, phase: 'complete',
    },
    authorizationRef,
  }
}

interface DirectoryPin { readonly path: string; readonly handle: FileHandle; readonly dev: number; readonly ino: number }
export interface ProvisioningPreparationOwner { readonly uid: number; readonly gid: number }

/** Root Agent reader of the fixed API service-private directory, using retained ancestor FDs. */
export class AccountProvisioningPreparationReader {
  readonly directory: string
  private readonly stateRoot: string
  private readonly owner: ProvisioningPreparationOwner

  constructor(stateRoot: string, owner: ProvisioningPreparationOwner) {
    this.stateRoot = stateRoot
    this.owner = owner
    if (!posix.isAbsolute(stateRoot) || posix.normalize(stateRoot) !== stateRoot || /[\x00-\x1f\x7f\\]/.test(stateRoot)
      || !Number.isSafeInteger(owner.uid) || owner.uid <= 0 || !Number.isSafeInteger(owner.gid) || owner.gid <= 0) refuse()
    this.directory = posix.join(stateRoot, 'private', 'account-provisioning')
  }

  async read(input: ProvisioningPreparationIdentity): Promise<VerifiedProvisioningPreparation> {
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || !isUuid(input.reference)) return refuse()
    const pins: DirectoryPin[] = []
    const verify = async (): Promise<void> => {
      for (const pin of pins) {
        const opened = await pin.handle.stat(), named = await lstat(pin.path)
        // Only the installed data root (/var/lib/xpanel, setgid for the private service group) may be 02770.
        // Protected startup narrows that root to 02750; both shapes carry no group write permission.
        const rootMode = named.mode & 0o7777
        const trustedStateRoot = pin.path === posix.dirname(this.stateRoot) && named.uid === this.owner.uid && named.gid === this.owner.gid
          && (rootMode === 0o2770 || rootMode === 0o2750)
        if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
          || opened.dev !== pin.dev || opened.ino !== pin.ino || named.dev !== pin.dev || named.ino !== pin.ino
          || (!trustedStateRoot && ((named.uid !== 0 && named.uid !== this.owner.uid) || (named.mode & 0o022)))) return refuse()
        // A carried-over host may have an SGID-inherited private leaf (02700); group bits stay empty either way.
        const leafMode = named.mode & 0o7777
        if (pin.path === this.directory && (named.uid !== this.owner.uid || (leafMode !== 0o700 && leafMode !== 0o2700))) return refuse()
      }
    }
    try {
      for (const segment of ['/', ...this.directory.split('/').filter(Boolean)]) {
        const parent = pins.at(-1)
        const path = parent ? posix.join(parent.path, segment) : '/'
        const held = parent ? '/proc/self/fd/' + parent.handle.fd + '/' + segment : '/'
        const handle = await open(held, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        const info = await handle.stat()
        pins.push({ path, handle, dev: info.dev, ino: info.ino })
        await verify()
      }
      const parent = pins.at(-1)!.handle
      const readPrivate = async (name: string): Promise<Buffer> => {
        const path = '/proc/self/fd/' + parent.fd + '/' + name
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const before = await handle.stat()
          if (!before.isFile() || before.uid !== this.owner.uid || (before.mode & 0o7777) !== 0o600 || before.nlink !== 1 || before.size > MAX_BYTES) return refuse()
          const bytes = await handle.readFile()
          const after = await handle.stat(), named = await lstat(path)
          if (bytes.byteLength !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid || before.nlink !== after.nlink
            || after.dev !== named.dev || after.ino !== named.ino || after.mode !== named.mode || after.uid !== named.uid || after.gid !== named.gid || after.nlink !== named.nlink
            || after.mtimeMs !== named.mtimeMs || after.ctimeMs !== named.ctimeMs || after.size !== named.size || named.isSymbolicLink()) return refuse()
          await verify()
          return bytes
        } finally { await handle.close() }
      }
      const key = await readPrivate('namespace-hmac.key')
      try {
        if (key.length !== 32) return refuse()
        const indexName = 'request-' + createHmac('sha256', key).update(JSON.stringify([input.actorKey, input.operationKey])).digest('hex') + '.json'
        const source = JSON.parse((await readPrivate(input.reference + '.json')).toString('utf8')) as unknown
        const index = JSON.parse((await readPrivate(indexName)).toString('utf8')) as unknown
        let authorization: unknown
        try { authorization = JSON.parse((await readPrivate(input.reference + '.authorization.json')).toString('utf8')) as unknown }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        const result = inspectProvisioningPreparation(input, { key, record: source, index, ...(authorization !== undefined && { authorization }) })
        await verify()
        return result
      } finally { key.fill(0) }
    } catch (error) {
      if (isXpanelError(error)) throw error
      return refuse()
    } finally { for (const pin of pins.reverse()) await pin.handle.close() }
  }
}
