import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Database, DatabaseUser, Domain } from '@xpanel/core'
import { prepareDatabaseIndexCreation, prepareDatabaseIndexTransition } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { services } from '@xpanel/render'
import { applicationDigest, isApplicationArtifactPath, isApplicationDigest, isApplicationId, isApplicationVersion, readApplicationPath, verifyApplicationArtifact } from '../../../packages/os/src/application-artifact.ts'
import type { ApplicationArtifactDescriptor, ApplicationArtifactFile, VerifiedApplicationArtifact } from '../../../packages/os/src/application-artifact.ts'
import { databaseOf, readApplicationObservedState } from './application-install.ts'
import type { ApplicationArtifactProvider, ApplicationDatabaseName, ApplicationDatabasePort, ApplicationObservedState, ApplicationRecovery, ApplicationTarget, ApplicationTargetSession, ApplicationTransactionIntent } from './application-install.ts'
import type { ApplicationWorkerRun } from './application-worker.ts'
import { SW_CATALOG_DIRECTORY } from './sw-application-catalog-store.ts'
import { withPinnedHostTargetParent } from './host-target-parent.ts'

/** The native provider: root keeps the artifacts by signed digest, and every account file change runs as the account. */
export const APPLICATION_ARTIFACT_DIRECTORY = join(SW_CATALOG_DIRECTORY, 'artifacts')
export const APPLICATION_STORE_DIRECTORY = '.xpanel-apps'
export const MAX_ACCOUNT_APPLICATIONS = 64
const unchanged = { stateChanged: false }
const CONFIG_MODE = '0640'
export const applicationInstanceKey = (root: string): string => applicationDigest(root).slice(0, 32)

/** The instance directory relative to the home; a document root outside the home has no confined target. */
export function applicationRoot(account: Pick<Account, 'home'>, domain: Pick<Domain, 'docRoot'>, path: string): string {
  const relative = domain.docRoot.startsWith(account.home + '/') ? domain.docRoot.slice(account.home.length + 1).replace(/\/+$/, '') : ''
  if (!isApplicationArtifactPath(relative)) return fail('PRECONDITION_FAILED', 'this document root cannot host an application', { ...unchanged, reason: 'application_root_unsupported' })
  return path ? relative + '/' + path : relative
}

export interface ApplicationInstanceRecord {
  domain: string; path: string; appId: string; version: string; previousVersion: string | null; artifactSha256: string
  database: ApplicationDatabaseName | null; config: string | null; updatedAt: string
  /** Digest of the summary line, so a root action names exactly the row it reviewed. */
  revision: string; key: string
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** The record sits in the account's home, so it is read as untrusted input and only ever selects that account's own objects. */
export function readApplicationSummary(line: string, key: string): ApplicationInstanceRecord | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!object(value) || value.schemaVersion !== 1 || typeof value.domain !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(value.domain) || typeof value.path !== 'string' || value.path !== '' && !isApplicationArtifactPath(value.path)
    || !isApplicationId(value.appId) || !isApplicationVersion(value.version) || !isApplicationDigest(value.artifactSha256) || value.previousVersion !== null && !isApplicationVersion(value.previousVersion)
    || value.config !== null && !isApplicationArtifactPath(value.config) || typeof value.updatedAt !== 'string' || !STAMP.test(value.updatedAt)) return null
  let database: ApplicationDatabaseName | null
  try { database = databaseOf(value.database) } catch { return null }
  return { domain: value.domain, path: value.path, appId: value.appId, version: value.version, previousVersion: value.previousVersion as string | null, artifactSha256: value.artifactSha256, database, config: value.config as string | null, updatedAt: value.updatedAt, revision: applicationDigest(line), key }
}
/** Root reads only the summary line, through descriptors, so a large list of files never reaches the agent heap. */
export async function readAccountApplications(account: Pick<Account, 'home' | 'uid'>): Promise<ApplicationInstanceRecord[]> {
  const records: ApplicationInstanceRecord[] = []
  try {
    await withPinnedHostTargetParent(join(account.home, APPLICATION_STORE_DIRECTORY, 'instances', 'record'), async anchored => {
      const directory = dirname(anchored)
      for (const name of (await readdir(directory)).filter(item => /^[0-9a-f]{32}\.json$/.test(item)).sort().slice(0, MAX_ACCOUNT_APPLICATIONS)) {
        let handle: FileHandle | null = null
        try {
          handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          const info = await handle.stat(), buffer = Buffer.alloc(4096)
          if (!info.isFile() || info.uid !== account.uid) continue
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), end = buffer.subarray(0, bytesRead).indexOf(0x0a)
          const record = end > 0 ? readApplicationSummary(buffer.toString('utf8', 0, end), name.slice(0, 32)) : null
          if (record) records.push(record)
        } finally { await handle?.close() }
      }
    })
  } catch (error) { if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '') && !isXpanelError(error)) throw error }
  return records
}

/** Rows whose domain the account still owns and whose name still matches that directory; a tampered or stale record drops out. */
export function ownedApplications(account: Pick<Account, 'id' | 'home'>, domains: readonly Domain[], records: readonly ApplicationInstanceRecord[]): (ApplicationInstanceRecord & { domainId: string })[] {
  return records.flatMap(record => {
    const domain = domains.find(item => item.accountId === account.id && item.name === record.domain)
    if (!domain) return []
    try { return applicationInstanceKey(applicationRoot(account, domain, readApplicationPath(record.path))) === record.key ? [{ ...record, domainId: domain.id }] : [] } catch { return [] }
  })
}

const paths = (files: readonly ApplicationArtifactFile[] | undefined): Map<string, string> => new Map((files ?? []).map(file => [file.path, file.sha256]))
/** One line the panel lists, then the file lists only the worker reads. */
function recordText(target: ApplicationTarget, intent: ApplicationTransactionIntent, before: ApplicationObservedState): string {
  const next = intent.next
  if (!next) return ''
  const current = before.installation
  const prior = current ? { appId: current.appId, version: current.version, artifactSha256: current.artifactSha256, files: current.files } : null
  const summary = { schemaVersion: 1, domain: target.domain, path: target.path, appId: next.appId, version: next.version, previousVersion: prior?.version ?? null, artifactSha256: next.artifactSha256,
    database: intent.database ?? current?.database ?? null, config: intent.config, updatedAt: new Date().toISOString() }
  return JSON.stringify(summary) + '\n' + JSON.stringify({ files: next.files, previous: prior }) + '\n'
}

export interface ApplicationProviderOptions { worker: ApplicationWorkerRun; artifacts?: string }

export function createApplicationProvider(options: ApplicationProviderOptions): ApplicationArtifactProvider {
  const { worker, artifacts = APPLICATION_ARTIFACT_DIRECTORY } = options
  const base = (target: ApplicationTarget): { root: string; key: string } => ({ root: target.root, key: applicationInstanceKey(target.root) })
  return Object.freeze({
    admission: Object.freeze({ descriptorConfinement: true, accountLifetimeFence: true, durablePreimages: true, scopedWrites: true, digestReadback: true, boundedDeadlines: true, contentAddressedEgress: true }),
    async readArtifact(descriptor: ApplicationArtifactDescriptor): Promise<Uint8Array> {
      let handle: FileHandle
      try { handle = await open(join(artifacts, descriptor.sha256), constants.O_RDONLY | constants.O_NOFOLLOW) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail('PRECONDITION_FAILED', 'this application release is not stored on this server', { ...unchanged, reason: 'application_artifact_missing' }); throw error }
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== descriptor.bytes) return fail('PRECONDITION_FAILED', 'the stored application release does not match the catalog', { ...unchanged, reason: 'application_artifact_invalid' })
        return await handle.readFile()
      } finally { await handle.close() }
    },
    async pendingTransactions(target: ApplicationTarget) {
      return (await worker(target, { op: 'pending', ...base(target) }, [], 50)).transactions as { transactionId: string; beforeRevision: string; expectedCommittedRevision: string | null }[]
    },
    async openTarget(target: ApplicationTarget): Promise<ApplicationTargetSession> {
      const place = base(target)
      let active: string | null = null, beforeRevision: string | null = null, commitAttempted = false, record = ''
      const observe = async (): Promise<ApplicationObservedState> => readApplicationObservedState(await worker(target, { op: 'observe', ...place, active }, [], 50))
      return {
        target,
        observe,
        async snapshot(intent, before) {
          record = recordText(target, intent, before)
          const current = paths(before.installation?.files), next = paths(intent.next?.files), changed = new Set([...current, ...next].filter(([path]) => current.get(path) !== next.get(path)).map(([path]) => path))
          // An update leaves the rendered config alone, so only an install or removal touches it.
          if (intent.config && (intent.action === 'install' || intent.action === 'remove')) changed.add(intent.config)
          const fresh = [...next.keys()].filter(path => !current.has(path))
          if (intent.action === 'install' && intent.config) fresh.push(intent.config)
          await worker(target, { op: 'snapshot', ...place, transactionId: intent.transactionId, beforeRevision: before.revision, next: applicationDigest(record), database: intent.action === 'install' ? intent.database : null, paths: [...changed].sort(), fresh }, [], 50)
          active = intent.transactionId; beforeRevision = before.revision
          return { transactionId: intent.transactionId, beforeRevision: before.revision, durable: true }
        },
        async apply(intent, artifact, _signal, config) {
          const current = paths((await observe()).installation?.files), next = intent.next?.files ?? []
          const write: { path: string; sha256: string; bytes: number; mode: string }[] = next.filter(file => current.get(file.path) !== file.sha256).map(file => ({ ...file }))
          const payload = write.map(file => (artifact as VerifiedApplicationArtifact).readFile(file.path))
          if (config && intent.config) { write.push({ path: intent.config, sha256: applicationDigest(config), bytes: config.byteLength, mode: CONFIG_MODE }); payload.push(config) }
          const keep = new Set(next.map(file => file.path)), remove = [...current.keys()].filter(path => !keep.has(path))
          if (intent.action === 'remove' && intent.config) remove.push(intent.config)
          await worker(target, { op: 'apply', ...place, transactionId: intent.transactionId, write, remove, manifest: record }, payload, 110)
        },
        async commit(transactionId, expectedRevision) {
          commitAttempted = true
          await worker(target, { op: 'commit', ...place, transactionId }, [], 20)
          active = null
          if ((await observe()).revision !== expectedRevision) throw new Error('commit_unverified')
          return { transactionId, committedRevision: expectedRevision }
        },
        async recover(transactionId): Promise<ApplicationRecovery> {
          const result = await worker(target, { op: 'recover', ...place, transactionId }, [], 110)
          active = null
          const observation = await observe()
          const state = result.state === 'none' ? (commitAttempted ? 'committed' : 'not_started') : result.state as ApplicationRecovery['state']
          return { transactionId, state, beforeRevision: (result.beforeRevision as string | undefined) ?? beforeRevision ?? observation.revision, committedRevision: state === 'committed' ? observation.revision : null, observation, database: databaseOf(result.database ?? null) }
        },
        async close() { /* every worker holds its descriptors only for one stage */ },
      }
    },
  })
}

export interface ApplicationDatabasePorts {
  store: {
    getAccount(id: string): Promise<Account | null>
    createDatabase(input: { accountId: string; name: string }, options?: { prepareIndex?: (account: Account, database: Database) => ReturnType<typeof prepareDatabaseIndexCreation> }): Promise<Database>
    createDatabaseUser(input: { accountId: string; name: string; authPlugin: 'mysql_native_password'; authString: string; initialGrant: { databaseId: string; privileges: string[] } }): Promise<DatabaseUser>
    listDatabases(accountId: string, options?: { includeTrashed?: boolean }): Promise<Database[]>
    listDatabaseUsers(accountId: string): Promise<DatabaseUser[]>
    trashDatabase(id: string, options?: { prepareTransitionIndex?: (account: Account, before: Database, after: Database) => ReturnType<typeof prepareDatabaseIndexTransition> }): Promise<Database>
    purgeDatabase(id: string): Promise<boolean>
    deleteDatabaseUser(id: string): Promise<boolean>
  }
  db: Db
  reconcile(account: Account): Promise<{ status: string }>
}
/** Desired state first, then the normal account reconcile, as every database page does. */
export function createApplicationDatabases(ports: ApplicationDatabasePorts): ApplicationDatabasePort {
  const { store } = ports
  const account = async (target: ApplicationTarget): Promise<Account> => await store.getAccount(target.accountId) ?? fail('NOT_FOUND', 'the account no longer exists', unchanged)
  const apply = async (target: ApplicationTarget): Promise<void> => {
    const status = (await ports.reconcile(await account(target))).status
    if (status !== 'applied' && status !== 'noop') fail('SERVICE_UNAVAILABLE', 'the database change was saved but the host did not apply it', { stateChanged: true, verificationRequired: true })
  }
  const remove = async (target: ApplicationTarget, name: ApplicationDatabaseName, purge: boolean): Promise<void> => {
    const database = (await store.listDatabases(target.accountId, { includeTrashed: true })).find(item => item.name === name.name)
    if (database && database.trashedAt === null) await store.trashDatabase(database.id, { prepareTransitionIndex: (fresh, before, after) => prepareDatabaseIndexTransition(ports.db, fresh, before, after) })
    if (database && purge) await store.purgeDatabase(database.id)
    const user = (await store.listDatabaseUsers(target.accountId)).find(item => item.name === name.user)
    if (user) await store.deleteDatabaseUser(user.id)
    if (database || user) await apply(target)
  }
  return {
    async create(target, name) {
      const password = randomBytes(24).toString('base64url')
      const database = await store.createDatabase({ accountId: target.accountId, name: name.name }, { prepareIndex: (fresh, created) => prepareDatabaseIndexCreation(ports.db, fresh, created) })
      await store.createDatabaseUser({ accountId: target.accountId, name: name.user, authPlugin: 'mysql_native_password', authString: services.mysqlNativePasswordHash(password), initialGrant: { databaseId: database.id, privileges: ['ALL PRIVILEGES'] } })
      await apply(target)
      return { host: 'localhost', password }
    },
    retire: (target, name) => remove(target, name, false),
    discard: (target, name) => remove(target, name, true),
  }
}

export interface StoredApplicationArtifacts {
  has(sha256: string): Promise<boolean>
  /** Appends one chunk, and offset 0 starts over; the last chunk verifies the digest and bundle before the file enters the store. */
  append(descriptor: ApplicationArtifactDescriptor, appId: string, version: string, offset: number, chunk: Uint8Array): Promise<{ received: number; complete: boolean }>
}
/** Below the API's 1 MiB request limit once in base64 JSON. */
export const APPLICATION_ARTIFACT_CHUNK_BYTES = 512 * 1024
export function createApplicationArtifactStore(directory = APPLICATION_ARTIFACT_DIRECTORY): StoredApplicationArtifacts {
  const present = async (path: string): Promise<number | null> => { try { return (await stat(path)).size } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } }
  return {
    has: async sha256 => isApplicationDigest(sha256) && await present(join(directory, sha256)) !== null,
    async append(descriptor, appId, version, offset, chunk) {
      const final = join(directory, descriptor.sha256), part = final + '.part'
      if (await present(final) !== null) return { received: descriptor.bytes, complete: true }
      if (offset === 0) await rm(part, { force: true })
      const received = await present(part) ?? 0
      if (offset !== received) return fail('CONFLICT', 'the upload offset does not match what was received', { ...unchanged, reason: 'application_artifact_offset', received })
      if (offset + chunk.byteLength > descriptor.bytes || chunk.byteLength > APPLICATION_ARTIFACT_CHUNK_BYTES) return fail('VALIDATION', 'the upload is larger than the signed release', unchanged)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const handle = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
      try { await handle.write(chunk); await handle.sync() } finally { await handle.close() }
      if (offset + chunk.byteLength < descriptor.bytes) return { received: offset + chunk.byteLength, complete: false }
      const reader = await open(part, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { verifyApplicationArtifact(await reader.readFile(), descriptor, appId, version) }
      catch (error) { await rm(part, { force: true }); if (isXpanelError(error)) return fail('VALIDATION', 'the file does not match the signed release', { ...unchanged, reason: 'application_artifact_invalid' }); throw error }
      finally { await reader.close() }
      await rename(part, final)
      return { received: descriptor.bytes, complete: true }
    },
  }
}
