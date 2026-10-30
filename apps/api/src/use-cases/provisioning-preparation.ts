import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { assertArgon2Hash, fail, isXpanelError } from '@xpanel/core'

/** Must use the existing authority's cross-process writer lease, not an in-memory mutex. */
export interface ProvisioningPreparationOptions {
  readonly directory: string
  readonly withLock: <T>(work: () => Promise<T>) => Promise<T>
}

export interface PreparedProvisioning<T> {
  readonly reference: string
  /** Private authority only. Never serialize this return value into jobs, audit or HTTP replies. */
  readonly passwordHash: string
  readonly desiredState: T
  readonly requestIdentity: string
}

export interface PrepareProvisioningInput<T> {
  readonly actorKey: string
  readonly idempotencyKey: string
  readonly requestIdentity: string
  /** Used only in memory by the trusted verifier; never stored or included in an error. */
  readonly credentialIntent: string
  readonly preparePasswordHash: () => Promise<string>
  /** Runtime supplies the existing password verifier. No fast plaintext-intent tag is persisted. */
  readonly verifyCredentialIntent: (intent: string, passwordHash: string) => Promise<boolean>
  /** Runs under withLock only for a first request; replay uses its persisted exact value. */
  readonly prepareDesiredState: () => Promise<T>
}

/** Injected into the lifecycle coordinator; it conveys no host-execution capability. */
export interface ProvisioningPreparationStore {
  prepare<T>(input: PrepareProvisioningInput<T>): Promise<PreparedProvisioning<T>>
  load<T>(reference: string, actorKey: string): Promise<PreparedProvisioning<T>>
}

interface PreparationIndex {
  readonly schemaVersion: 1
  readonly phase: 'reserved' | 'complete'
  readonly reference: string
  readonly actorKey: string
  readonly requestIdentity: string
}

interface PreparationRecord<T> {
  readonly schemaVersion: 1
  readonly reference: string
  readonly actorKey: string
  readonly indexName: string
  readonly requestIdentity: string
  readonly passwordHash: string
  readonly desiredState: T
  readonly desiredStateDigest: string
}

const HEX = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_BYTES = 2 * 1024 * 1024
const refused = (reason: string): never => fail('PRECONDITION_FAILED', 'private provisioning preparation requires review', {
  stateChanged: false, verificationRequired: true, reason,
})
const conflict = (): never => fail('CONFLICT', 'the provisioning request does not match its saved preparation', { stateChanged: false })
const sha = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

const jsonBytes = (value: unknown): string => {
  try {
    const bytes = JSON.stringify(value)
    if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > MAX_BYTES) return refused('preparation_size_invalid')
    return bytes
  } catch { return refused('preparation_json_invalid') }
}

/**
 * Operator-configured POSIX service-private credential authority. The service UID may be non-root.
 * A reserved-but-unwritten credential is deliberately not rehashed after an interrupted attempt.
 */
export class FileProvisioningPreparationStore implements ProvisioningPreparationStore {
  private readonly directory: string
  private readonly withLock: ProvisioningPreparationOptions['withLock']

  constructor(options: ProvisioningPreparationOptions) {
    if (!isAbsolute(options.directory) || resolve(options.directory) !== options.directory) {
      fail('VALIDATION', 'an absolute canonical provisioning preparation directory is required', { stateChanged: false })
    }
    this.directory = options.directory
    this.withLock = options.withLock
  }

  private requirePosix(): number {
    if (process.platform !== 'linux' || !process.getuid) return refused('private_filesystem_not_supported')
    return process.getuid()
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }

  private async protectedAncestors(): Promise<void> {
    const uid = this.requirePosix()
    let path = this.directory
    for (;;) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== uid && info.uid !== 0) || (info.mode & 0o022)) {
        return refused('private_directory_untrusted')
      }
      if (path === this.directory && (info.uid !== uid || (info.mode & 0o777) !== 0o700)) return refused('private_directory_untrusted')
      if (path === parse(path).root) return
      path = dirname(path)
    }
  }

  private async initialize(): Promise<void> {
    const uid = this.requirePosix()
    const create = async (path: string): Promise<void> => {
      let info
      try { info = await lstat(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await create(dirname(path))
        await mkdir(path, { mode: 0o700 })
        await this.syncDirectory(dirname(path))
        await this.syncDirectory(path)
        info = await lstat(path)
      }
      if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== uid && info.uid !== 0) || (info.mode & 0o022)) {
        return refused('private_directory_untrusted')
      }
    }
    await create(this.directory)
    await this.protectedAncestors()
    // Re-acknowledge existing links as well: a previous mkdir may have lost its fsync acknowledgment.
    let path = this.directory
    while (path !== parse(path).root) { await this.syncDirectory(dirname(path)); path = dirname(path) }
  }

  private async readPrivate(path: string): Promise<Buffer> {
    const uid = this.requirePosix()
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o777) !== 0o600
      || before.nlink !== 1 || before.size > MAX_BYTES) return refused('private_record_untrusted')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const admitted = await handle.stat()
      if (admitted.dev !== before.dev || admitted.ino !== before.ino || admitted.size !== before.size) return refused('private_record_changed')
      const bytes = await handle.readFile()
      const after = await handle.stat(), pathAfter = await lstat(path)
      if (after.dev !== admitted.dev || after.ino !== admitted.ino || after.size !== admitted.size || after.mtimeMs !== admitted.mtimeMs
        || after.ctimeMs !== admitted.ctimeMs || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) return refused('private_record_changed')
      return bytes
    } finally { await handle.close() }
  }

  private async readJson(path: string): Promise<Record<string, unknown>> {
    let value: unknown
    try { value = JSON.parse((await this.readPrivate(path)).toString('utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
      if (isXpanelError(error)) throw error
      return refused('private_record_invalid')
    }
    if (!object(value)) return refused('private_record_invalid')
    return value
  }

  private async writeExclusive(path: string, bytes: Uint8Array | string): Promise<void> {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await this.syncDirectory(dirname(path))
  }

  private async key(create: boolean): Promise<Buffer> {
    const path = join(this.directory, 'namespace-hmac.key')
    let key
    try { key = await this.readPrivate(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error
      // Losing a namespace key must not rotate request identity and silently issue a second hash.
      // The configured directory is dedicated; unrelated or partial material requires review.
      if ((await readdir(this.directory)).length) return refused('private_namespace_key_missing')
      await this.writeExclusive(path, randomBytes(32))
      key = await this.readPrivate(path)
    }
    if (key.length !== 32) return refused('private_intent_key_invalid')
    return key
  }

  private validateIndex(value: Record<string, unknown>): PreparationIndex {
    if (Object.keys(value).sort().join(',') !== 'actorKey,phase,reference,requestIdentity,schemaVersion'
      || value.schemaVersion !== 1 || (value.phase !== 'reserved' && value.phase !== 'complete') || typeof value.reference !== 'string'
      || !UUID.test(value.reference) || typeof value.actorKey !== 'string' || typeof value.requestIdentity !== 'string'
      || !HEX.test(value.requestIdentity)) return refused('private_index_invalid')
    return value as unknown as PreparationIndex
  }

  private async record<T>(index: PreparationIndex, indexName: string): Promise<PreparationRecord<T>> {
    const value = await this.readJson(join(this.directory, `${index.reference}.json`))
    if (Object.keys(value).sort().join(',') !== 'actorKey,desiredState,desiredStateDigest,indexName,passwordHash,reference,requestIdentity,schemaVersion'
      || value.schemaVersion !== 1 || value.reference !== index.reference || value.actorKey !== index.actorKey || value.indexName !== indexName
      || value.requestIdentity !== index.requestIdentity || typeof value.passwordHash !== 'string'
      || value.desiredStateDigest !== sha(jsonBytes(value.desiredState))) return refused('private_preparation_binding_invalid')
    try { assertArgon2Hash(value.passwordHash) } catch { return refused('private_credential_invalid') }
    return value as unknown as PreparationRecord<T>
  }

  private async acknowledge(index: PreparationIndex, indexName: string): Promise<void> {
    if (index.phase === 'complete') return
    const temp = join(this.directory, `.ack-${randomUUID()}.json`)
    await this.writeExclusive(temp, jsonBytes({ ...index, phase: 'complete' }))
    await rename(temp, join(this.directory, indexName))
    await this.syncDirectory(this.directory)
  }

  async prepare<T>(input: PrepareProvisioningInput<T>): Promise<PreparedProvisioning<T>> {
    if (typeof input.actorKey !== 'string' || !input.actorKey || input.actorKey.length > 256 || /[\r\n\0]/.test(input.actorKey)
      || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.idempotencyKey)
      || typeof input.requestIdentity !== 'string' || !HEX.test(input.requestIdentity)
      || typeof input.credentialIntent !== 'string' || !input.credentialIntent.length || input.credentialIntent.length > 4096) {
      return fail('VALIDATION', 'bounded provisioning identity and credential intent are required', { stateChanged: false })
    }
    return this.withLock(async () => {
      await this.initialize()
      const key = await this.key(true)
      const indexName = `request-${createHmac('sha256', key).update(JSON.stringify([input.actorKey, input.idempotencyKey])).digest('hex')}.json`
      let index: PreparationIndex | null = null
      try { index = this.validateIndex(await this.readJson(join(this.directory, indexName))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (index) {
        if (index.actorKey !== input.actorKey || index.requestIdentity !== input.requestIdentity) return conflict()
        let record: PreparationRecord<T>
        try { record = await this.record<T>(index, indexName) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return refused('reserved_credential_outcome_unknown')
          throw error
        }
        let matches = false
        try { matches = await input.verifyCredentialIntent(input.credentialIntent, record.passwordHash) }
        catch { return refused('credential_verification_unavailable') }
        if (!matches) return conflict()
        await this.acknowledge(index, indexName)
        return { reference: record.reference, passwordHash: record.passwordHash, desiredState: record.desiredState, requestIdentity: record.requestIdentity }
      }
      let desiredState: T
      try { desiredState = JSON.parse(jsonBytes(await input.prepareDesiredState())) as T }
      catch (error) { return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'desired provisioning preparation was refused', { stateChanged: false }) }
      index = { schemaVersion: 1, phase: 'reserved', reference: randomUUID(), actorKey: input.actorKey, requestIdentity: input.requestIdentity }
      await this.writeExclusive(join(this.directory, indexName), jsonBytes(index))
      let passwordHash: string
      try { passwordHash = assertArgon2Hash(await input.preparePasswordHash()) }
      catch { return refused('reserved_credential_outcome_unknown') }
      let matches = false
      try { matches = await input.verifyCredentialIntent(input.credentialIntent, passwordHash) }
      catch { return refused('credential_verification_unavailable') }
      if (!matches) return refused('prepared_credential_intent_mismatch')
      const record: PreparationRecord<T> = { schemaVersion: 1, reference: index.reference, actorKey: input.actorKey, indexName,
        requestIdentity: input.requestIdentity, passwordHash, desiredState, desiredStateDigest: sha(jsonBytes(desiredState)) }
      const target = join(this.directory, `${index.reference}.json`)
      try { await lstat(target); return refused('private_reference_already_exists') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const staged = join(this.directory, `.record-${randomUUID()}.json`)
      await this.writeExclusive(staged, jsonBytes(record))
      // This is a fresh UUID destination, checked absent under the caller's authority writer lease.
      // A crash before publication leaves reserved/unknown state; no new credential is generated.
      await rename(staged, target)
      await this.syncDirectory(this.directory)
      await this.acknowledge(index, indexName)
      return { reference: record.reference, passwordHash: record.passwordHash, desiredState: record.desiredState, requestIdentity: record.requestIdentity }
    })
  }

  async load<T>(reference: string, actorKey: string): Promise<PreparedProvisioning<T>> {
    if (typeof reference !== 'string' || !UUID.test(reference) || typeof actorKey !== 'string' || !actorKey || actorKey.length > 256
      || /[\r\n\0]/.test(actorKey)) return fail('VALIDATION', 'a bounded preparation reference and actor are required', { stateChanged: false })
    return this.withLock(async () => {
      await this.protectedAncestors()
      await this.key(false)
      const raw = await this.readJson(join(this.directory, `${reference}.json`))
      if (raw.actorKey !== actorKey) return fail('FORBIDDEN', 'the provisioning preparation belongs to another actor', { stateChanged: false })
      if (typeof raw.indexName !== 'string' || !/^request-[0-9a-f]{64}\.json$/.test(raw.indexName)) return refused('private_preparation_binding_invalid')
      const index = this.validateIndex(await this.readJson(join(this.directory, raw.indexName)))
      if (index.reference !== reference || index.actorKey !== actorKey) return refused('private_preparation_binding_invalid')
      const record = await this.record<T>(index, raw.indexName)
      await this.acknowledge(index, raw.indexName)
      return { reference, passwordHash: record.passwordHash, desiredState: record.desiredState, requestIdentity: record.requestIdentity }
    })
  }
}
