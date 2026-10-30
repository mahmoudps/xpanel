import { createHash } from 'node:crypto'
import { fail } from './errors.ts'
import type { Id, Principal } from './types.ts'

/** Internal authenticated service protocol. None of its authority fields are HTTP form inputs. */
export interface ProvisioningAuthority {
  readonly actor: Pick<Principal, 'id' | 'kind' | 'username'>
  readonly account: { readonly id: Id; readonly username: string; readonly ownerId: Id | null; readonly planId: Id; readonly uid: number; readonly gid: number; readonly home: string; readonly primaryDomain: string }
  readonly operation: { readonly id: Id; readonly workerId: string; readonly fencingToken: number; readonly leaseExpiresAt: string; readonly requestFingerprint: string }
  readonly desired: { readonly revision: number; readonly checksum: string; readonly preparationReference: string; readonly preparationIdentity: string }
}

export interface AccountExecutionObservation {
  readonly accountId: Id
  readonly uid: number
  readonly gid: number
  readonly home: string
  readonly revision: number
  readonly generationId: number
  readonly generationChecksum: string
  readonly sourceChecksum: string
  readonly cgroup: string
  readonly services: readonly string[]
  readonly quota: { readonly enforced: true; readonly filesystem: string }
  readonly dns: { readonly zone: string; readonly serial: number; readonly authoritative: true }
  readonly php: { readonly status: 200; readonly uid: number; readonly cgroup: string }
}

export interface ProvisioningReconcileRequest { readonly authority: ProvisioningAuthority; readonly binding: string }
export interface ProvisioningGenerationResult { readonly status: string; readonly generation?: { readonly id: number; readonly checksum: string } | null }
export interface ProvisioningReconcileReply<T extends ProvisioningGenerationResult = ProvisioningGenerationResult> {
  readonly binding: string
  readonly outcome: 'known' | 'unknown'
  readonly reconciliation: T
  readonly execution?: AccountExecutionObservation
}

export const ACCOUNT_PROVISIONING_IDENTITY_ALGORITHM = 'xpanel-account-provisioning-canonical-v1' as const
export const canonicalProvisioningIdentity = (value: unknown): string => {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sort(v)])) : item
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex')
}

const HEX = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (): never => fail('VALIDATION', 'invalid authenticated account provisioning request', { stateChanged: false })
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return invalid()
  return value
}
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const integer = (value: unknown, minimum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 2147483647
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
const hex = (value: unknown): value is string => typeof value === 'string' && HEX.test(value)

export function parseProvisioningReconcileRequest(value: unknown): ProvisioningReconcileRequest {
  const request = exact(value, ['authority', 'binding'])
  const authority = exact(request.authority, ['actor', 'account', 'operation', 'desired'])
  const actor = exact(authority.actor, ['id', 'kind', 'username'])
  const account = exact(authority.account, ['id', 'username', 'ownerId', 'planId', 'uid', 'gid', 'home', 'primaryDomain'])
  const operation = exact(authority.operation, ['id', 'workerId', 'fencingToken', 'leaseExpiresAt', 'requestFingerprint'])
  const desired = exact(authority.desired, ['revision', 'checksum', 'preparationReference', 'preparationIdentity'])
  if (!uuid(actor.id) || typeof actor.kind !== 'string' || !['root', 'reseller'].includes(actor.kind) || !text(actor.username, 128)
    || !uuid(account.id) || !text(account.username, 16) || !/^[a-z][a-z0-9]{0,15}$/.test(account.username)
    || !(account.ownerId === null || uuid(account.ownerId)) || !uuid(account.planId)
    || !integer(account.uid, 1) || !integer(account.gid, 1) || !text(account.home, 4096) || !account.home.startsWith('/')
    || account.home.includes('//') || account.home.split('/').some(part => part === '.' || part === '..')
    || !text(account.primaryDomain, 253) || !uuid(operation.id) || !text(operation.workerId, 200)
    || !integer(operation.fencingToken, 1) || !text(operation.leaseExpiresAt, 32)
    || !Number.isFinite(Date.parse(operation.leaseExpiresAt)) || new Date(operation.leaseExpiresAt).toISOString() !== operation.leaseExpiresAt
    || !hex(operation.requestFingerprint) || !integer(desired.revision, 0) || !hex(desired.checksum)
    || !uuid(desired.preparationReference) || !hex(desired.preparationIdentity) || !hex(request.binding)) return invalid()
  if (canonicalProvisioningIdentity(authority) !== request.binding) return invalid()
  return value as ProvisioningReconcileRequest
}

const unverifiedReply = (): never => fail('PRECONDITION_FAILED', 'account host observations do not match the requested identity and generation', { stateChanged: true, verificationRequired: true })
const replyRecord = (value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return unverifiedReply()
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)) || required.some(key => !Object.hasOwn(value, key))) return unverifiedReply()
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return unverifiedReply()
  }
  return value
}
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const nonnegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const observedText = (value: unknown, max: number): value is string => text(value, max) && value.trim().length > 0

/** Validate untrusted decoded JSON before comparing identities; TypeScript shapes are not evidence. */
export function assertProvisioningReply<T extends ProvisioningGenerationResult>(request: ProvisioningReconcileRequest, reply: ProvisioningReconcileReply<T>): AccountExecutionObservation | undefined {
  // A missing expected value must never match another missing value after host work.
  try { parseProvisioningReconcileRequest(request) } catch { return unverifiedReply() }
  const value = replyRecord(reply, ['binding', 'outcome', 'reconciliation'], ['execution'])
  if (!hex(value.binding) || value.binding !== request.binding || value.outcome !== 'known' || !object(value.reconciliation)) return unverifiedReply()
  const status = value.reconciliation.status
  const fields = status === 'applied' ? ['status', 'generation', 'filesCount', 'durationMs']
    : status === 'noop' ? ['status', 'generation', 'stateChecksum']
      : status === 'failed' ? ['status', 'generation', 'failedTest', 'error'] : null
  if (!fields) return unverifiedReply()
  const result = replyRecord(value.reconciliation, fields, status === 'applied' ? ['removedFilesCount', 'repairedDriftCount']
    : status === 'failed' ? ['rolledBack', 'restoredGenerationId', 'stateChanged', 'verificationRequired'] : [])
  // These are the actual ConfigGeneration identity fields, not truthiness checks.
  const generation = replyRecord(result.generation, ['id', 'checksum', 'status'], ['createdAt', 'error', 'actor', 'testedAt', 'activatedAt'])
  if (!positiveId(generation.id) || !hex(generation.checksum)) return unverifiedReply()
  const timestamp = (value: unknown): boolean => observedText(value, 64) && Number.isFinite(Date.parse(value))
  if ((Object.hasOwn(generation, 'createdAt') && !timestamp(generation.createdAt))
    || (Object.hasOwn(generation, 'actor') && !observedText(generation.actor, 256))
    || (Object.hasOwn(generation, 'error') && generation.error !== null && (typeof generation.error !== 'string' || generation.error.length > 16000 || generation.error.includes('\0')))
    || ['testedAt', 'activatedAt'].some(key => Object.hasOwn(generation, key) && generation[key] !== null && !timestamp(generation[key]))) return unverifiedReply()
  if (status === 'failed') {
    if (typeof generation.status !== 'string' || !['pending', 'tested', 'active', 'superseded', 'failed', 'rolled_back'].includes(generation.status)
      || !observedText(result.failedTest, 4096) || typeof result.error !== 'string' || result.error.length === 0 || result.error.length > 16000 || result.error.includes('\0')
      || (Object.hasOwn(result, 'rolledBack') && typeof result.rolledBack !== 'boolean')
      || (Object.hasOwn(result, 'stateChanged') && typeof result.stateChanged !== 'boolean')
      || (Object.hasOwn(result, 'verificationRequired') && result.verificationRequired !== true)
      || (Object.hasOwn(result, 'restoredGenerationId') && result.restoredGenerationId !== null && !positiveId(result.restoredGenerationId))
      || Object.hasOwn(value, 'execution')) return unverifiedReply()
    return undefined
  }
  if (generation.status !== 'active') return unverifiedReply()
  if (status === 'applied' && (!nonnegativeInteger(result.filesCount) || typeof result.durationMs !== 'number' || !Number.isFinite(result.durationMs) || result.durationMs < 0
    || ['removedFilesCount', 'repairedDriftCount'].some(key => Object.hasOwn(result, key) && !nonnegativeInteger(result[key])))) return unverifiedReply()
  if (status === 'noop' && (!hex(result.stateChecksum) || result.stateChecksum !== request.authority.desired.checksum)) return unverifiedReply()
  const e = replyRecord(value.execution, ['accountId', 'uid', 'gid', 'home', 'revision', 'generationId', 'generationChecksum', 'sourceChecksum', 'cgroup', 'services', 'quota', 'dns', 'php'])
  const quota = replyRecord(e.quota, ['enforced', 'filesystem'])
  const dns = replyRecord(e.dns, ['zone', 'serial', 'authoritative'])
  const php = replyRecord(e.php, ['status', 'uid', 'cgroup'])
  const a = request.authority.account, d = request.authority.desired
  if (!uuid(e.accountId) || e.accountId !== a.id || !integer(e.uid, 1) || e.uid !== a.uid || !integer(e.gid, 1) || e.gid !== a.gid
    || !observedText(e.home, 4096) || e.home !== a.home || !nonnegativeInteger(e.revision) || e.revision !== d.revision
    || !hex(e.sourceChecksum) || e.sourceChecksum !== d.checksum || !positiveId(e.generationId) || e.generationId !== generation.id
    || !hex(e.generationChecksum) || e.generationChecksum !== generation.checksum || !observedText(e.cgroup, 4096)
    || !Array.isArray(e.services) || e.services.length === 0 || e.services.length > 128 || e.services.some(service => !observedText(service, 256))
    || quota.enforced !== true || !observedText(quota.filesystem, 256) || !observedText(dns.zone, 253) || dns.zone !== a.primaryDomain
    || dns.authoritative !== true || !positiveId(dns.serial) || dns.serial > 4294967295
    || php.status !== 200 || !integer(php.uid, 1) || php.uid !== a.uid || !observedText(php.cgroup, 4096) || php.cgroup !== e.cgroup) return unverifiedReply()
  return value.execution as AccountExecutionObservation
}
