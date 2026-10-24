import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { fail, isXpanelError } from '@xpanel/core'
import { WriterLock } from '@xpanel/state'
import type { WriterLease } from '@xpanel/state'
import type { Db } from '../client.ts'
import { assertNoActiveDatabaseTransaction, assertRegisteredDatabaseRunner, getStrictOperationDatabaseOrigin } from '../sql-runner.ts'
import type { SqlRunner, StrictOperationDatabaseOrigin } from '../sql-runner.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { computeAuditEntryHash, GENESIS_AUDIT_HASH } from './audit.ts'
import type { AuditFileRecord } from './audit.ts'

export type OperationIntentPurpose = 'host.reconcile.intent' | 'reference.repair.intent' | 'host.lifecycle.intent'

export const LIFECYCLE_INTENT_ACTIONS = ['lifecycle.upgrade', 'lifecycle.rollback', 'lifecycle.recover', 'lifecycle.uninstall', 'lifecycle.adopt'] as const

export interface OperationIntentBinding {
  readonly purpose: OperationIntentPurpose
  readonly jobId: string
  readonly requestFingerprint: string
  readonly action: string
  readonly principalId: string
}

declare const receiptBrand: unique symbol
/** An identity capability, not a serializable durable=true assertion. */
export interface OperationIntentReceipt { readonly [receiptBrand]: true }

export interface VerifiedOperationIntent {
  readonly eventUid: string
  readonly entryHash: string
  readonly seq: number
}

export interface RootOperationAuditAuthority {
  appendReconcileIntent(binding: OperationIntentBinding): Promise<OperationIntentReceipt>
  recoverReconcileIntent(binding: OperationIntentBinding): Promise<OperationIntentReceipt>
  appendReferenceRepairIntent(binding: OperationIntentBinding): Promise<OperationIntentReceipt>
  recoverReferenceRepairIntent(binding: OperationIntentBinding): Promise<OperationIntentReceipt>
  appendLifecycleIntent(binding: OperationIntentBinding): Promise<OperationIntentReceipt>
  recoverLifecycleIntent(binding: OperationIntentBinding): Promise<OperationIntentReceipt>
}

export const OPERATION_AUDIT_LOG_NAME = 'operation-intents.jsonl'
export const OPERATION_AUDIT_PENDING_NAME = 'append-intent.json'
export const OPERATION_AUDIT_ANCHOR_NAME = 'operation-audit-authority.json'
export const MAX_OPERATION_AUDIT_BYTES = 16 * 1024 * 1024
export const MAX_OPERATION_AUDIT_RECORDS = 8192
export const MAX_OPERATION_AUDIT_LINE_BYTES = 4096
const MAX_PENDING_BYTES = 8192
const DEFAULT_DIRECTORY = '/var/lib/xpanel-agent/operation-audit'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const ACTION = /^[a-z][a-z0-9_.:-]{0,127}$/
const decoder = new TextDecoder('utf-8', { fatal: true })

interface FileIdentity { device: string; inode: string }
interface SinkAnchor {
  schemaVersion: 1
  authorityId: string
  origin: StrictOperationDatabaseOrigin
  directoryIdentity: FileIdentity
  logIdentity: FileIdentity
  lastSeq: number
  lastHash: string
  bytes: number
}
interface PendingAppend {
  schemaVersion: 1
  logIdentity: FileIdentity
  priorAnchor: SinkAnchor
  priorBytes: number
  priorSeq: number
  priorHash: string
  record: AuditFileRecord
}
interface FileCapture {
  identity: FileIdentity
  bytes: Buffer
  records: AuditFileRecord[]
  pending: PendingAppend | null
  target: AuditFileRecord | null
  anchor: SinkAnchor
}
interface ReceiptEvidence {
  binding: OperationIntentBinding
  record: VerifiedOperationIntent
  sinkIdentity: Readonly<FileIdentity>
  directoryIdentity: Readonly<FileIdentity>
  origin: Readonly<StrictOperationDatabaseOrigin>
  authorityId: string
}
const receipts = new WeakMap<object, ReceiptEvidence>()

const unavailable = (reason: string): never =>
  fail('PRECONDITION_FAILED', 'operation audit authority is unavailable', { reason })
const invalid = (reason: string): never =>
  fail('VALIDATION', 'invalid operation audit evidence', { reason })
const object = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('object_required')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key))) return invalid('unexpected_fields')
  return record
}
const integer = (value: unknown, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) return invalid('invalid_integer')
  return Number(value)
}
const text = (value: unknown, pattern: RegExp): string => {
  if (typeof value !== 'string' || !pattern.test(value)) return invalid('invalid_text')
  return value
}
const purpose = (value: unknown): OperationIntentPurpose => {
  if (value !== 'host.reconcile.intent' && value !== 'reference.repair.intent' && value !== 'host.lifecycle.intent') return invalid('unsupported_purpose')
  return value
}
const normalizeBinding = (input: unknown): OperationIntentBinding => {
  const b = object(input, ['purpose', 'jobId', 'requestFingerprint', 'action', 'principalId'])
  const result = Object.freeze({
    purpose: purpose(b.purpose),
    jobId: text(b.jobId, UUID),
    requestFingerprint: text(b.requestFingerprint, SHA256),
    action: text(b.action, ACTION),
    principalId: text(b.principalId, UUID),
  })
  if (result.purpose === 'reference.repair.intent' && result.action !== 'job.reference.repair') return invalid('invalid_repair_action')
  if (result.purpose === 'host.lifecycle.intent' && !(LIFECYCLE_INTENT_ACTIONS as readonly string[]).includes(result.action)) return invalid('invalid_lifecycle_action')
  if (result.purpose !== 'host.lifecycle.intent' && result.action.startsWith('lifecycle.')) return invalid('lifecycle_purpose_required')
  return result
}
const equalBinding = (a: OperationIntentBinding, b: OperationIntentBinding): boolean =>
  a.purpose === b.purpose && a.jobId === b.jobId && a.requestFingerprint === b.requestFingerprint &&
  a.action === b.action && a.principalId === b.principalId

/** Read-only persisted binding check; it confers no root, audit-receipt or host-guard capability. */
export const assertPersistedLifecycleIntent = async (tx: SqlRunner, input: OperationIntentBinding): Promise<void> => {
  getStrictOperationDatabaseOrigin(tx)
  const binding = normalizeBinding(input)
  if (binding.purpose !== 'host.lifecycle.intent') return invalid('lifecycle_purpose_required')
  const [job] = await tx.query<{ kind: string; actor: string; detail: string; username: string; principal_kind: string; disabled: number }>(
    'SELECT j.kind,j.actor,j.detail,p.username,p.kind AS principal_kind,p.disabled FROM jobs j JOIN principals p ON p.id=$2 WHERE j.id=$1',
    [binding.jobId, binding.principalId],
  )
  if (!job || job.kind !== binding.action || job.actor !== job.username || job.principal_kind !== 'root' || job.disabled !== 0) return unavailable('lifecycle_job_or_root_mismatch')
  let detail: unknown
  try { detail = JSON.parse(job.detail) } catch { return unavailable('lifecycle_job_detail_invalid') }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail) || !Object.hasOwn(detail, 'lifecycleIntent')) return unavailable('lifecycle_job_binding_missing')
  const persisted = normalizeBinding((detail as Record<string, unknown>).lifecycleIntent)
  if (!equalBinding(binding, persisted)) return unavailable('lifecycle_job_binding_mismatch')
}
const recordBinding = (record: AuditFileRecord): OperationIntentBinding =>
  normalizeBinding({
    purpose: record.action,
    jobId: record.detail.jobId,
    requestFingerprint: record.detail.requestFingerprint,
    action: record.detail.action,
    principalId: record.principalId,
  })

export const assertOperationIntentReceipt = (
  receipt: unknown,
  expected: OperationIntentBinding,
  tx: SqlRunner,
): Readonly<VerifiedOperationIntent> => {
  const binding = normalizeBinding(expected)
  const evidence = receipt !== null && typeof receipt === 'object' ? receipts.get(receipt) : undefined
  if (!evidence || !equalBinding(evidence.binding, binding)) return unavailable('unrecognized_or_mismatched_receipt')
  if (!equalOrigin(evidence.origin, getStrictOperationDatabaseOrigin(tx))) return unavailable('receipt_database_origin_mismatch')
  return evidence.record
}

const identity = (info: BigIntStats): FileIdentity => ({ device: String(info.dev), inode: String(info.ino) })
const equalIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.device === b.device && a.inode === b.inode
const parseIdentity = (input: unknown): FileIdentity => {
  const value = object(input, ['device', 'inode'])
  return { device: text(value.device, /^(?:0|[1-9][0-9]*)$/), inode: text(value.inode, /^[1-9][0-9]*$/) }
}

const equalOrigin = (a: StrictOperationDatabaseOrigin, b: StrictOperationDatabaseOrigin): boolean =>
  a.file === b.file && a.device === b.device && a.inode === b.inode && a.issuerId === b.issuerId
const parseOrigin = (input: unknown): StrictOperationDatabaseOrigin => {
  const value = object(input, ['file', 'device', 'inode', 'issuerId'])
  if (typeof value.file !== 'string' || !isAbsolute(value.file) || value.file.includes('\0')) return invalid('invalid_origin_file')
  const physical = parseIdentity({ device: value.device, inode: value.inode })
  return { file: value.file, ...physical, issuerId: text(value.issuerId, UUID) }
}
const anchorJson = (anchor: SinkAnchor): string => JSON.stringify(anchor) + '\n'
const parseAnchor = (input: unknown): SinkAnchor => {
  const value = object(input, ['schemaVersion', 'authorityId', 'origin', 'directoryIdentity', 'logIdentity', 'lastSeq', 'lastHash', 'bytes'])
  if (value.schemaVersion !== 1) return invalid('invalid_anchor_version')
  const result: SinkAnchor = {
    schemaVersion: 1, authorityId: text(value.authorityId, UUID), origin: parseOrigin(value.origin),
    directoryIdentity: parseIdentity(value.directoryIdentity), logIdentity: parseIdentity(value.logIdentity),
    lastSeq: integer(value.lastSeq, 0, MAX_OPERATION_AUDIT_RECORDS), lastHash: text(value.lastHash, SHA256),
    bytes: integer(value.bytes, 0, MAX_OPERATION_AUDIT_BYTES),
  }
  if ((result.lastSeq === 0) !== (result.bytes === 0) || (result.lastSeq === 0 && result.lastHash !== GENESIS_AUDIT_HASH)) return invalid('invalid_anchor_tip')
  return result
}
const decodeAnchor = (bytes: Buffer): SinkAnchor => {
  let parsed: unknown
  try { parsed = JSON.parse(decoder.decode(bytes)) } catch { return invalid('malformed_anchor') }
  const anchor = parseAnchor(parsed)
  if (bytes.toString('utf8') !== anchorJson(anchor)) return invalid('noncanonical_anchor')
  return anchor
}
const nextAnchor = (pending: PendingAppend): SinkAnchor => ({
  ...pending.priorAnchor, lastSeq: pending.record.seq, lastHash: pending.record.entryHash,
  bytes: pending.priorBytes + recordLine(pending.record).length,
})

const requireRoot = (): void => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) return unavailable('linux_root_required')
}

const validateDirectory = async (directory: string): Promise<BigIntStats> => {
  requireRoot()
  let current = directory
  let rootInfo: BigIntStats | undefined
  for (;;) {
    const info = await lstat(current, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n || (info.mode & 0o022n) !== 0n) return unavailable('untrusted_directory_ancestry')
    if (current === directory) {
      if (info.gid !== 0n || (info.mode & 0o7777n) !== 0o700n) return unavailable('root_only_directory_required')
      rootInfo = info
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return rootInfo!
}
const syncDirectory = async (directory: string, expected: FileIdentity): Promise<void> => {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    if (!equalIdentity(identity(info), expected) || !info.isDirectory() || info.uid !== 0n || info.gid !== 0n || (info.mode & 0o7777n) !== 0o700n) return unavailable('directory_identity_changed')
    await handle.sync()
  } finally { await handle.close() }
}

const recordLine = (record: AuditFileRecord): Buffer => Buffer.from(JSON.stringify(record) + '\n', 'utf8')
const parseRecord = (input: unknown, expectedSeq: number, expectedHash: string): AuditFileRecord => {
  const value = object(input, ['seq', 'eventUid', 'id', 'at', 'actor', 'principalId', 'ip', 'action', 'target', 'detail', 'outcome', 'prevHash', 'entryHash'])
  const seq = integer(value.seq, 1, MAX_OPERATION_AUDIT_RECORDS)
  const detail = object(value.detail, ['schemaVersion', 'kind', 'jobId', 'requestFingerprint', 'action', 'principalId'])
  const binding = normalizeBinding({ purpose: value.action, jobId: detail.jobId, requestFingerprint: detail.requestFingerprint, action: detail.action, principalId: detail.principalId })
  if (seq !== expectedSeq || value.id !== String(seq) || value.prevHash !== expectedHash ||
    value.principalId !== binding.principalId || value.target !== 'operation:' + binding.jobId ||
    value.ip !== null || value.outcome !== 'ok' || detail.schemaVersion !== 1 ||
    detail.kind !== (binding.purpose === 'host.reconcile.intent' ? 'host.reconcile' : 'reference.repair')) return invalid('record_binding_or_chain_mismatch')
  const at = typeof value.at === 'string' ? value.at : ''
  if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) return invalid('invalid_time')
  const actor = typeof value.actor === 'string' ? value.actor : ''
  if (!actor || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) return invalid('invalid_actor')
  const record: AuditFileRecord = {
    seq, eventUid: text(value.eventUid, UUID), id: String(seq), at, actor,
    principalId: binding.principalId, ip: null, action: binding.purpose, target: 'operation:' + binding.jobId,
    detail: { schemaVersion: 1, kind: detail.kind, jobId: binding.jobId, requestFingerprint: binding.requestFingerprint, action: binding.action, principalId: binding.principalId },
    outcome: 'ok', prevHash: text(value.prevHash, SHA256), entryHash: text(value.entryHash, SHA256),
  }
  if (computeAuditEntryHash(record) !== record.entryHash || recordLine(record).length > MAX_OPERATION_AUDIT_LINE_BYTES) return invalid('record_hash_or_size_mismatch')
  return record
}
const parseLog = (bytes: Buffer): AuditFileRecord[] => {
  if (bytes.length > MAX_OPERATION_AUDIT_BYTES) return unavailable('audit_capacity_requires_reviewed_rotation')
  if (bytes.length === 0) return []
  if (bytes[bytes.length - 1] !== 10) return invalid('unexplained_partial_tail')
  let content: string
  try { content = decoder.decode(bytes) } catch { return invalid('invalid_utf8') }
  const lines = content.slice(0, -1).split('\n')
  if (lines.length > MAX_OPERATION_AUDIT_RECORDS) return unavailable('audit_capacity_requires_reviewed_rotation')
  const records: AuditFileRecord[] = [], events = new Set<string>(), jobs = new Set<string>()
  for (const line of lines) {
    if (!line || Buffer.byteLength(line, 'utf8') + 1 > MAX_OPERATION_AUDIT_LINE_BYTES) return invalid('invalid_line_size')
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { return invalid('malformed_record') }
    const record = parseRecord(parsed, records.length + 1, records.at(-1)?.entryHash ?? GENESIS_AUDIT_HASH)
    if (recordLine(record).toString('utf8') !== line + '\n') return invalid('noncanonical_record')
    const key = record.action + ':' + record.detail.jobId
    if (events.has(record.eventUid) || jobs.has(key)) return invalid('duplicate_event_or_operation')
    events.add(record.eventUid); jobs.add(key); records.push(record)
  }
  return records
}
const pendingJson = (pending: PendingAppend): string => JSON.stringify(pending) + '\n'
const parsePending = (bytes: Buffer): PendingAppend => {
  if (bytes.length > MAX_PENDING_BYTES) return invalid('oversized_append_intent')
  let parsed: unknown
  try { parsed = JSON.parse(decoder.decode(bytes)) } catch { return invalid('malformed_append_intent') }
  const value = object(parsed, ['schemaVersion', 'logIdentity', 'priorAnchor', 'priorBytes', 'priorSeq', 'priorHash', 'record'])
  if (value.schemaVersion !== 1) return invalid('append_intent_version')
  const priorSeq = integer(value.priorSeq, 0, MAX_OPERATION_AUDIT_RECORDS - 1)
  const priorHash = text(value.priorHash, SHA256)
  const result: PendingAppend = {
    schemaVersion: 1, logIdentity: parseIdentity(value.logIdentity), priorAnchor: parseAnchor(value.priorAnchor),
    priorBytes: integer(value.priorBytes, 0, MAX_OPERATION_AUDIT_BYTES),
    priorSeq, priorHash, record: parseRecord(value.record, priorSeq + 1, priorHash),
  }
  if (!equalIdentity(result.logIdentity, result.priorAnchor.logIdentity) || result.priorBytes !== result.priorAnchor.bytes || result.priorSeq !== result.priorAnchor.lastSeq || result.priorHash !== result.priorAnchor.lastHash) return invalid('pending_anchor_mismatch')
  const raw = bytes.toString('utf8')
  if (raw !== pendingJson(result) && raw + '\n' !== pendingJson(result)) return invalid('noncanonical_append_intent')
  return result
}
const canonicalJson = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item
    if (Array.isArray(item)) return item.map(normalize)
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]))
  }
  return JSON.stringify(normalize(value))
}

/**
 * Dedicated root-agent authority for 2 intent kinds. This proves ordered durable
 * provenance under a trusted control plane, not human authorization after API/DB
 * compromise. General API auditing, rotation and host-effect authority remain separate.
 */
export const createRootOperationAuditAuthority = async (
  db: Db,
  options: { directory?: string } = {},
): Promise<RootOperationAuditAuthority> => {
  const assertProvider = (): void => {
    assertRegisteredDatabaseRunner(db)
    assertNoActiveDatabaseTransaction()
  }
  assertProvider()
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'directory')) return invalid('unknown_option')
  const strictOrigin = async (): Promise<Readonly<StrictOperationDatabaseOrigin>> => {
    assertProvider()
    return db.transaction(async tx => Object.freeze({ ...getStrictOperationDatabaseOrigin(tx) }))
  }
  const origin = await strictOrigin()
  requireRoot()
  const configured = options.directory ?? DEFAULT_DIRECTORY
  if (typeof configured !== 'string' || !isAbsolute(configured) || configured.includes('\0')) return invalid('absolute_directory_required')
  const directory = resolve(configured)
  if (directory === '/var/lib/xpanel' || directory.startsWith('/var/lib/xpanel' + sep)) return unavailable('desired_state_directory_forbidden')
  const rootInfo = await validateDirectory(directory)
  const directoryIdentity = Object.freeze(identity(rootInfo))
  const lock = new WriterLock(directory)
  const logPath = join(directory, OPERATION_AUDIT_LOG_NAME)
  const pendingPath = join(directory, OPERATION_AUDIT_PENDING_NAME)
  const anchorPath = join(directory, OPERATION_AUDIT_ANCHOR_NAME)
  const candidatePath = anchorPath + '.candidate'
  const assertOrigin = (tx: SqlRunner): void => {
    if (!equalOrigin(origin, getStrictOperationDatabaseOrigin(tx))) return unavailable('database_origin_changed')
  }
  const assertDirectory = async (): Promise<void> => {
    const now = await validateDirectory(directory)
    if (!equalIdentity(directoryIdentity, identity(now))) return unavailable('directory_identity_changed')
  }
  const checkFile = async (handle: FileHandle, path: string): Promise<BigIntStats> => {
    const [info, named] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
    if (!info.isFile() || info.nlink !== 1n || info.uid !== 0n || info.gid !== 0n || (info.mode & 0o7777n) !== 0o600n ||
      named.isSymbolicLink() || !equalIdentity(identity(info), identity(named))) return unavailable('unsafe_audit_file')
    return info
  }
  const openExisting = async (path: string): Promise<FileHandle | null> => {
    let handle: FileHandle
    try { handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try { await checkFile(handle, path); return handle } catch (error) { await handle.close(); throw error }
  }
  const createExclusive = async (path: string): Promise<FileHandle> => {
    const handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      // Root can have the service primary GID. Set ownership on the newly opened
      // fd; existing directories/files must already be root:root and are never repaired.
      await handle.chown(0, 0)
      await handle.chmod(0o600)
      await checkFile(handle, path)
      return handle
    } catch (error) { await handle.close(); throw error }
  }
  const readBytes = async (handle: FileHandle, path: string, limit: number): Promise<Buffer> => {
    const before = await checkFile(handle, path)
    if (before.size > BigInt(limit)) return unavailable('audit_capacity_requires_reviewed_rotation')
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (part.bytesRead === 0) return unavailable('audit_file_changed_during_read')
      offset += part.bytesRead
    }
    const after = await checkFile(handle, path)
    if (before.size !== after.size || !equalIdentity(identity(before), identity(after))) return unavailable('audit_file_changed_during_read')
    return bytes
  }
  const readOptional = async (path: string, limit: number): Promise<Buffer | null> => {
    const handle = await openExisting(path)
    if (!handle) return null
    try { return await readBytes(handle, path, limit) } finally { await handle.close() }
  }
  const loadPending = async (): Promise<PendingAppend | null> => {
    const bytes = await readOptional(pendingPath, MAX_PENDING_BYTES)
    return bytes === null ? null : parsePending(bytes)
  }
  const loadAnchor = async (): Promise<SinkAnchor | null> => {
    const bytes = await readOptional(anchorPath, MAX_PENDING_BYTES)
    return bytes === null ? null : decodeAnchor(bytes)
  }
  const checkOwner = (anchor: SinkAnchor, logIdentity: FileIdentity): void => {
    if (!equalOrigin(anchor.origin, origin) || !equalIdentity(anchor.directoryIdentity, directoryIdentity) ||
      !equalIdentity(anchor.logIdentity, logIdentity)) return unavailable('sink_owner_or_identity_mismatch')
  }
  const checkTip = (anchor: SinkAnchor, bytes: Buffer, records: readonly AuditFileRecord[]): void => {
    if (anchor.bytes !== bytes.length || anchor.lastSeq !== records.length ||
      anchor.lastHash !== (records.at(-1)?.entryHash ?? GENESIS_AUDIT_HASH)) return unavailable('sink_highwater_mismatch')
  }
  const underGuard = async <T>(operation: (lease: WriterLease) => Promise<T>): Promise<T> => {
    // Reject every outer DB transaction, even another physical file/connection,
    // before waiting for the audit guard or doing any filesystem work.
    assertProvider()
    await assertDirectory()
    const lease = await lock.acquire()
    try { await assertDirectory(); await lease.assertFencingToken(); return await operation(lease) }
    finally { await lease.release() }
  }
  const sync = async (handle: FileHandle, path: string): Promise<void> => {
    await checkFile(handle, path)
    await handle.sync()
    await syncDirectory(directory, directoryIdentity)
  }
  type IndexRow = { at: string; actor: string; principal_id: string | null; ip: string | null; action: string; target: string; detail: string; outcome: string }
  const expectedDetail = (record: AuditFileRecord) => ({
    ...record.detail, _auditEventUid: record.eventUid, _auditSeq: record.seq,
    _auditPrevHash: record.prevHash, _auditEntryHash: record.entryHash,
  })
  const matchesIndex = (row: IndexRow, record: AuditFileRecord): boolean => {
    let detail: unknown
    try { detail = JSON.parse(row.detail) } catch { return false }
    return row.at === record.at && row.actor === record.actor && row.principal_id === record.principalId &&
      row.ip === record.ip && row.action === record.action && row.target === record.target &&
      row.outcome === record.outcome && canonicalJson(detail) === canonicalJson(expectedDetail(record))
  }
  const readIndex = (): Promise<IndexRow[]> => {
    assertProvider()
    // Reviewed narrow audit-guard -> short strict DB READ edge. There is no FS
    // work inside the callback and no DB->audit path; writes/indexing are outside.
    return db.transaction(async tx => {
      assertOrigin(tx)
      const rows = await tx.query<IndexRow>(
        "SELECT at, actor, principal_id, ip, action, target, detail, outcome FROM audit_log WHERE action IN ('host.reconcile.intent','reference.repair.intent') LIMIT $1",
        [MAX_OPERATION_AUDIT_RECORDS + 1],
      )
      if (rows.length > MAX_OPERATION_AUDIT_RECORDS) return unavailable('audit_index_capacity_exceeded')
      return rows
    })
  }
  const assertIndexedHistory = (records: readonly AuditFileRecord[], rows: readonly IndexRow[], requireAll = false): void => {
    const seen = new Set<number>()
    for (const row of rows) {
      let detail: Record<string, unknown>
      try { detail = JSON.parse(row.detail) as Record<string, unknown> } catch { return unavailable('invalid_audit_index_detail') }
      if (!detail || typeof detail !== 'object' || !Number.isSafeInteger(detail._auditSeq)) return unavailable('invalid_audit_index_detail')
      const seq = Number(detail._auditSeq), record = records[seq - 1]
      if (!record || seen.has(seq) || !matchesIndex(row, record)) return unavailable('indexed_history_missing_or_conflicting')
      seen.add(seq)
    }
    if (requireAll && seen.size !== records.length) return unavailable('audit_index_incomplete')
  }
  const previewPending = (bytes: Buffer, pending: PendingAppend): { complete: Buffer; records: AuditFileRecord[]; partial: boolean } => {
    if (bytes.length < pending.priorBytes) return invalid('pending_prefix_missing')
    const prefix = bytes.subarray(0, pending.priorBytes), previous = parseLog(prefix)
    if (previous.length !== pending.priorSeq || (previous.at(-1)?.entryHash ?? GENESIS_AUDIT_HASH) !== pending.priorHash) return invalid('pending_prior_tip_mismatch')
    const line = recordLine(pending.record), tail = bytes.subarray(pending.priorBytes)
    if (pending.priorBytes + line.length > MAX_OPERATION_AUDIT_BYTES || tail.length > line.length || !tail.equals(line.subarray(0, tail.length))) return invalid('pending_tail_conflict')
    return { complete: Buffer.concat([prefix, line]), records: [...previous, pending.record], partial: tail.length !== line.length }
  }
  const repairPending = async (handle: FileHandle, pending: PendingAppend, lease: WriterLease): Promise<Buffer> => {
    if (!equalIdentity(identity(await checkFile(handle, logPath)), pending.logIdentity)) return unavailable('pending_log_identity_mismatch')
    const bytes = await readBytes(handle, logPath, MAX_OPERATION_AUDIT_BYTES)
    const preview = previewPending(bytes, pending)
    const journal = await openExisting(pendingPath)
    if (!journal) return unavailable('append_intent_missing')
    try {
      if (pendingJson(parsePending(await readBytes(journal, pendingPath, MAX_PENDING_BYTES))) !== pendingJson(pending)) return invalid('append_intent_changed')
      await sync(journal, pendingPath)
    } finally { await journal.close() }
    await lease.assertFencingToken()
    if (preview.partial) await handle.writeFile(preview.complete.subarray(bytes.length))
    await sync(handle, logPath)
    const complete = await readBytes(handle, logPath, MAX_OPERATION_AUDIT_BYTES)
    if (!complete.equals(preview.complete)) return unavailable('append_result_unknown')
    return complete
  }
  const publishAnchor = async (pending: PendingAppend, lease: WriterLease): Promise<SinkAnchor> => {
    const current = await loadAnchor(), expected = nextAnchor(pending)
    if (!current || (anchorJson(current) !== anchorJson(pending.priorAnchor) && anchorJson(current) !== anchorJson(expected))) return unavailable('anchor_update_conflict')
    let candidate = await openExisting(candidatePath)
    if (anchorJson(current) === anchorJson(expected)) {
      // A candidate here would not be a known interrupted replacement. Do not discard it.
      if (candidate) { await candidate.close(); return unavailable('unexplained_anchor_candidate') }
      const handle = await openExisting(anchorPath)
      if (!handle) return unavailable('anchor_missing')
      try { await sync(handle, anchorPath) } finally { await handle.close() }
      return expected
    }
    const desired = Buffer.from(anchorJson(expected), 'utf8')
    if (!candidate) candidate = await createExclusive(candidatePath)
    try {
      const bytes = await readBytes(candidate, candidatePath, MAX_PENDING_BYTES)
      if (bytes.length > desired.length || !bytes.equals(desired.subarray(0, bytes.length))) return unavailable('anchor_candidate_conflict')
      if (bytes.length < desired.length) await candidate.writeFile(desired.subarray(bytes.length))
      await sync(candidate, candidatePath)
    } finally { await candidate.close() }
    await lease.assertFencingToken()
    await rename(candidatePath, anchorPath)
    await syncDirectory(directory, directoryIdentity)
    const accepted = await loadAnchor()
    if (!accepted || anchorJson(accepted) !== anchorJson(expected)) return unavailable('anchor_update_unknown')
    return accepted
  }
  const findTarget = (records: readonly AuditFileRecord[], binding: OperationIntentBinding): AuditFileRecord | null => {
    const record = records.find(item => item.action === binding.purpose && item.detail.jobId === binding.jobId)
    if (!record) return null
    if (!equalBinding(recordBinding(record), binding)) return fail('CONFLICT', 'operation audit intent binding differs from the durable event')
    return record
  }
  const prepare = async (binding: OperationIntentBinding, append: boolean, actor: string): Promise<FileCapture> =>
    underGuard(async lease => {
      let pending = await loadPending(), anchor = await loadAnchor()
      const candidate = await readOptional(candidatePath, MAX_PENDING_BYTES)
      // The surviving index is independent rollback evidence. Read it before any
      // creation, append, suffix recovery or cleanup, never during filesystem I/O.
      const indexed = await readIndex()
      let handle = await openExisting(logPath)
      if (!anchor) {
        if (pending || candidate !== null || handle || indexed.length) {
          if (handle) await handle.close()
          return unavailable('unanchored_existing_evidence')
        }
        if (!append) return unavailable('operation_intent_not_found')
        handle = await createExclusive(logPath)
        try {
          await sync(handle, logPath)
          anchor = {
            schemaVersion: 1, authorityId: randomUUID(), origin: { ...origin }, directoryIdentity: { ...directoryIdentity },
            logIdentity: identity(await checkFile(handle, logPath)), lastSeq: 0, lastHash: GENESIS_AUDIT_HASH, bytes: 0,
          }
          const initial = await createExclusive(anchorPath)
          try { await initial.writeFile(anchorJson(anchor), 'utf8'); await sync(initial, anchorPath) } finally { await initial.close() }
        } catch (error) { await handle.close(); throw error }
      }
      if (!handle) return unavailable('anchored_log_missing')
      try {
        const logIdentity = identity(await checkFile(handle, logPath))
        checkOwner(anchor, logIdentity)
        let bytes = await readBytes(handle, logPath, MAX_OPERATION_AUDIT_BYTES), records: AuditFileRecord[]
        if (pending) {
          checkOwner(pending.priorAnchor, logIdentity)
          if (pending.priorAnchor.authorityId !== anchor.authorityId) return unavailable('pending_authority_mismatch')
          const next = nextAnchor(pending), isPrior = anchorJson(anchor) === anchorJson(pending.priorAnchor)
          if (!isPrior && anchorJson(anchor) !== anchorJson(next)) return unavailable('pending_highwater_conflict')
          const preview = previewPending(bytes, pending)
          // A replacement candidate is created only after the complete log has
          // been synced. Conflicting candidate bytes or a partial log beside it
          // are rollback evidence, not permission to mutate the append suffix.
          if (candidate !== null) {
            const expected = Buffer.from(anchorJson(next), 'utf8')
            if (!isPrior || candidate.length > expected.length || !candidate.equals(expected.subarray(0, candidate.length))) return unavailable('anchor_candidate_conflict')
            if (preview.partial) return unavailable('candidate_log_rewound')
          }
          assertIndexedHistory(preview.records, indexed)
          if (preview.partial && (!isPrior || indexed.some(row => {
            const detail = JSON.parse(row.detail) as Record<string, unknown>
            return detail._auditSeq === pending!.record.seq
          }))) return unavailable('durable_history_rewound')
          bytes = await repairPending(handle, pending, lease)
          records = parseLog(bytes)
          anchor = await publishAnchor(pending, lease)
        } else {
          if (candidate !== null) return unavailable('unexplained_anchor_candidate')
          records = parseLog(bytes)
          checkTip(anchor, bytes, records)
          assertIndexedHistory(records, indexed)
        }
        let target = findTarget(records, binding)
        if (!pending && !target) {
          if (!append) return unavailable('operation_intent_not_found')
          if (records.length >= MAX_OPERATION_AUDIT_RECORDS) return unavailable('audit_capacity_requires_reviewed_rotation')
          const record: AuditFileRecord = {
            seq: records.length + 1, eventUid: randomUUID(), id: String(records.length + 1), at: new Date().toISOString(), actor,
            principalId: binding.principalId, ip: null, action: binding.purpose, target: 'operation:' + binding.jobId,
            detail: { schemaVersion: 1, kind: binding.purpose === 'host.reconcile.intent' ? 'host.reconcile' : 'reference.repair', jobId: binding.jobId, requestFingerprint: binding.requestFingerprint, action: binding.action, principalId: binding.principalId },
            outcome: 'ok', prevHash: records.at(-1)?.entryHash ?? GENESIS_AUDIT_HASH, entryHash: '',
          }
          record.entryHash = computeAuditEntryHash(record)
          parseRecord(record, record.seq, record.prevHash)
          if (bytes.length + recordLine(record).length > MAX_OPERATION_AUDIT_BYTES) return unavailable('audit_capacity_requires_reviewed_rotation')
          pending = { schemaVersion: 1, logIdentity, priorAnchor: anchor, priorBytes: bytes.length, priorSeq: records.length, priorHash: record.prevHash, record }
          const journal = await createExclusive(pendingPath)
          try { await journal.writeFile(pendingJson(pending), 'utf8'); await sync(journal, pendingPath) } finally { await journal.close() }
          bytes = await repairPending(handle, pending, lease)
          records = parseLog(bytes)
          anchor = await publishAnchor(pending, lease)
          target = findTarget(records, binding)
        } else {
          await sync(handle, logPath)
        }
        checkTip(anchor, bytes, records)
        return { identity: logIdentity, bytes, records, pending, target, anchor }
      } finally { await handle.close() }
    })
  const indexRecords = async (records: readonly AuditFileRecord[]): Promise<void> => {
    assertProvider()
    await db.transaction(async tx => {
      assertOrigin(tx)
      for (const record of records) {
        const rows = await tx.query<IndexRow>(
          "SELECT at, actor, principal_id, ip, action, target, detail, outcome FROM audit_log WHERE json_extract(detail, '$._auditEventUid') = $1 OR json_extract(detail, '$._auditEntryHash') = $2",
          [record.eventUid, record.entryHash],
        )
        if (rows.length > 1) return unavailable('duplicate_audit_index_identity')
        const existing = rows[0]
        if (existing && !matchesIndex(existing, record)) return unavailable('audit_index_binding_conflict')
        if (!existing) await tx.query(
          'INSERT INTO audit_log (at, actor, principal_id, ip, action, target, detail, outcome) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [record.at, record.actor, record.principalId, record.ip, record.action, record.target, JSON.stringify(expectedDetail(record)), record.outcome],
        )
      }
    })
  }
  const finish = async (capture: FileCapture): Promise<boolean> => underGuard(async lease => {
    const handle = await openExisting(logPath)
    if (!handle) return unavailable('verified_log_missing')
    try {
      const physical = identity(await checkFile(handle, logPath))
      if (!equalIdentity(physical, capture.identity)) return unavailable('verified_log_identity_changed')
      const bytes = await readBytes(handle, logPath, MAX_OPERATION_AUDIT_BYTES)
      if (bytes.length < capture.bytes.length || !bytes.subarray(0, capture.bytes.length).equals(capture.bytes)) return unavailable('verified_prefix_changed')
      const pending = await loadPending()
      // Another real producer may have appended while this process indexed.
      // Replay it next iteration rather than clearing a different event's journal.
      if (pending && (!capture.pending || pendingJson(pending) !== pendingJson(capture.pending))) return false
      const anchor = await loadAnchor()
      if (!anchor || anchor.authorityId !== capture.anchor.authorityId) return unavailable('verified_anchor_changed')
      checkOwner(anchor, physical)
      const records = parseLog(bytes)
      checkTip(anchor, bytes, records)
      if (await readOptional(candidatePath, MAX_PENDING_BYTES) !== null) return unavailable('unexplained_anchor_candidate')
      assertIndexedHistory(records, await readIndex(), true)
      await sync(handle, logPath)
      const anchorHandle = await openExisting(anchorPath)
      if (!anchorHandle) return unavailable('verified_anchor_missing')
      try { await sync(anchorHandle, anchorPath) } finally { await anchorHandle.close() }
      if (pending) {
        await lease.assertFencingToken()
        await unlink(pendingPath)
        await syncDirectory(directory, directoryIdentity)
      }
      return true
    } finally { await handle.close() }
  })
  const run = (input: OperationIntentBinding, expectedPurpose: OperationIntentPurpose, append: boolean): Promise<OperationIntentReceipt> =>
    withSqliteErrors(async () => {
      assertProvider()
      const binding = normalizeBinding(input)
      if (binding.purpose !== expectedPurpose) return invalid('method_purpose_mismatch')
      if (!equalOrigin(origin, await strictOrigin())) return unavailable('database_origin_changed')
      requireRoot()
      assertProvider()
      const actors = await db.transaction(async tx => {
        assertOrigin(tx)
        if (binding.purpose === 'host.lifecycle.intent') await assertPersistedLifecycleIntent(tx, binding)
        return tx.query<{ username: string }>('SELECT username FROM principals WHERE id = $1', [binding.principalId])
      })
      const actor = actors[0]?.username
      if (typeof actor !== 'string' || !actor || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) return unavailable('principal_unavailable')
      for (let attempt = 0; attempt < 8; attempt++) {
        let capture: FileCapture
        try { capture = await prepare(binding, append, actor) }
        catch (error) {
          if (isXpanelError(error)) throw error
          return fail('SERVICE_UNAVAILABLE', 'operation audit file proof failed', { reason: (error as NodeJS.ErrnoException).code ?? 'AUDIT_IO_FAILED' })
        }
        // No audit guard or filesystem I/O inside this control DB transaction.
        await indexRecords(capture.records)
        let finished: boolean
        try { finished = await finish(capture) }
        catch (error) {
          if (isXpanelError(error)) throw error
          return fail('SERVICE_UNAVAILABLE', 'operation audit completion could not be confirmed', { reason: (error as NodeJS.ErrnoException).code ?? 'AUDIT_IO_FAILED' })
        }
        if (!finished || !capture.target) continue
        const receipt = Object.freeze(Object.create(null)) as OperationIntentReceipt
        receipts.set(receipt, {
          binding, record: Object.freeze({ eventUid: capture.target.eventUid, entryHash: capture.target.entryHash, seq: capture.target.seq }),
          sinkIdentity: Object.freeze({ ...capture.identity }), directoryIdentity, origin, authorityId: capture.anchor.authorityId,
        })
        return receipt
      }
      return fail('CONFLICT', 'operation audit is busy; the durable intent requires retry')
    })
  return Object.freeze({
    appendReconcileIntent: (binding: OperationIntentBinding) => run(binding, 'host.reconcile.intent', true),
    recoverReconcileIntent: (binding: OperationIntentBinding) => run(binding, 'host.reconcile.intent', false),
    appendReferenceRepairIntent: (binding: OperationIntentBinding) => run(binding, 'reference.repair.intent', true),
    recoverReferenceRepairIntent: (binding: OperationIntentBinding) => run(binding, 'reference.repair.intent', false),
    appendLifecycleIntent: (binding: OperationIntentBinding) => run(binding, 'host.lifecycle.intent', true),
    recoverLifecycleIntent: (binding: OperationIntentBinding) => run(binding, 'host.lifecycle.intent', false),
  })
}
