import { createHash } from 'node:crypto'
import { fail } from './errors.ts'
import { assertBool, assertId, isUuid, oneOf } from './schemas.ts'
import { validateDomainName, validateUsername } from './rules/naming.ts'

export const RECONCILE_OPERATION_SCHEMA_VERSION = 1
export const MAX_RECONCILE_SCOPES = 64
export const MAX_RECONCILE_OBSERVATIONS = 32

export interface ReconcileRequest {
  readonly schemaVersion: 1
  readonly requestKey: string
  readonly force: boolean
}

export interface ReconcileSourceBinding {
  readonly revision: number
  readonly checksum: string
  readonly committedLeaseId: string | null
}

export interface ReconcileAccountBinding {
  readonly id: string
  readonly uid: number
  readonly username: string
  readonly ownerId: string | null
}

export type ReconcileSubject =
  | { readonly kind: 'server' }
  | { readonly kind: 'account'; readonly account: ReconcileAccountBinding }
  | { readonly kind: 'domain'; readonly domainId: string; readonly domainName: string; readonly account: ReconcileAccountBinding }

export type ReconcileCredentialBinding =
  | { readonly kind: 'session' | 'api_token'; readonly id: string; readonly revision: number }
  | { readonly kind: 'local_operator'; readonly id: null; readonly revision: number }

export interface ReconcileAuthorizationBinding {
  readonly principalId: string
  readonly credential: ReconcileCredentialBinding
  readonly audience: 'xpanel' | 'xwhm' | 'management'
  readonly scopes: readonly string[]
}

/** The receiver must reconstruct this context from current trusted state; parsing is not authorization. */
export interface ReconcileContext {
  readonly source: ReconcileSourceBinding
  readonly subject: ReconcileSubject
  readonly action: string
  readonly authorization: ReconcileAuthorizationBinding
}

export interface BoundReconcileOperation extends ReconcileRequest, ReconcileContext {
  readonly kind: 'host.reconcile'
  readonly requestFingerprint: string
}

export type ReconcilePhase = 'intent' | 'queued' | 'prepare' | 'stage' | 'test' | 'activate' | 'reload' | 'verify' | 'settle' | 'settled' | 'attention'
export type ReconcilePublicStatus = 'awaiting_intent' | 'queued' | 'running' | 'cancelling' | 'applied' | 'unchanged' | 'failed' | 'needs_attention' | 'cancelled' | 'superseded'
export type ReconcilePublicReason = (typeof PUBLIC_REASONS)[number]

export type ReconcileServiceName = 'http' | 'panel' | 'tls' | 'dns' | 'smtp' | 'imap' | 'database' | 'ssh' | 'ftp' | 'php' | 'scheduler'
export type ReconcileObservation =
  | { readonly kind: 'configuration'; readonly name: 'managed_files'; readonly result: 'passed'; readonly observedAt: string; readonly checksum: string }
  | { readonly kind: 'service'; readonly name: ReconcileServiceName; readonly probe: 'protocol' | 'process_identity'; readonly result: 'passed'; readonly observedAt: string }

export interface ReconcileObservedReceipt {
  readonly outcome: 'applied' | 'unchanged'
  readonly source: ReconcileSourceBinding
  readonly generation: {
    readonly id: number
    readonly status: 'active'
    readonly stateChecksum: string
    readonly filesChecksum: string
  }
  readonly observedAt: string
  readonly observations: readonly ReconcileObservation[]
}

interface ReconcileStateBase {
  readonly schemaVersion: 1
  /** Persisted official reference, or null when unissued. This contract never allocates one. */
  readonly reference: string | null
  readonly source: ReconcileSourceBinding
  readonly configurationScope: 'global_configuration'
  readonly targetVerified: false
  readonly verificationRequired: true
  readonly cancelRequested: boolean
}

type OperationOutcome<Receipt> =
  | { readonly status: 'awaiting_intent'; readonly phase: 'intent'; readonly reference: null; readonly needsAttention: false; readonly reason: 'submission_not_accepted'; readonly receipt: null }
  | { readonly status: 'queued' | 'running' | 'cancelling'; readonly phase: ReconcilePhase; readonly reference: string; readonly needsAttention: false; readonly reason: null; readonly receipt: null }
  | { readonly status: 'applied' | 'unchanged'; readonly phase: 'settled'; readonly reference: string; readonly needsAttention: false; readonly reason: null; readonly receipt: Receipt }
  | { readonly status: 'needs_attention'; readonly phase: 'attention'; readonly needsAttention: true; readonly reason: ReconcilePublicReason; readonly receipt: null }
  | { readonly status: 'failed' | 'cancelled' | 'superseded'; readonly phase: 'settled'; readonly needsAttention: false; readonly reason: ReconcilePublicReason; readonly receipt: null }

/** Full private persistence/worker state. Never return this object from a tenant API. */
export type ReconcileOperationState = ReconcileStateBase & OperationOutcome<ReconcileObservedReceipt>

export interface ReconcilePublicReceipt {
  readonly outcome: 'applied' | 'unchanged'
  readonly observedAt: string
  readonly services: readonly Omit<Extract<ReconcileObservation, { kind: 'service' }>, 'kind'>[]
}

interface ReconcilePublicBase extends Omit<ReconcileStateBase, 'source'> {
  readonly sourceRevision: number
}

export type ReconcilePublicOperation = ReconcilePublicBase & OperationOutcome<ReconcilePublicReceipt>

const PUBLIC_REASONS = [
  'submission_not_accepted', 'intent_unconfirmed', 'reference_unissued',
  'source_superseded', 'authorization_changed', 'cancelled_before_effect', 'cancelled_after_recovery',
  'validation_failed', 'configuration_test_failed', 'service_observation_failed', 'host_execution_failed',
  'effect_outcome_unknown', 'lease_lost', 'receipt_unavailable', 'recovery_failed', 'durability_failed', 'unsupported_operation',
] as const
const UNKNOWN_REASONS: readonly ReconcilePublicReason[] = ['intent_unconfirmed', 'reference_unissued', 'effect_outcome_unknown', 'lease_lost', 'receipt_unavailable', 'recovery_failed', 'durability_failed']
const RUNNING_PHASES = ['prepare', 'stage', 'test', 'activate', 'reload', 'verify', 'settle'] as const
const SERVICE_NAMES: readonly ReconcileServiceName[] = ['http', 'panel', 'tls', 'dns', 'smtp', 'imap', 'database', 'ssh', 'ftp', 'php', 'scheduler']

const invalid = (field: string): never => fail('VALIDATION', `invalid reconcile ${field}`, { field })

/** Only plain data properties are accepted; unknown/private fields are rejected rather than copied. */
const record = (value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return invalid('object prototype')
  const keys = Reflect.ownKeys(value)
  if (keys.length > required.length + optional.length) return invalid('object fields')
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) return invalid('object fields')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid('object properties')
  }
  if (required.some(key => !Object.hasOwn(value, key))) return invalid('required fields')
  return value as Record<string, unknown>
}

const array = (value: unknown, maximum: number, field: string): readonly unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return invalid(field)
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1) return invalid(field)
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid(field)
  }
  return value
}

const token = (value: unknown, maximum: number, pattern: RegExp, field: string): string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && pattern.test(value) ? value : invalid(field)

const integer = (value: unknown, minimum: number, maximum: number, field: string): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : invalid(field)

const checksum = (value: unknown, field: string): string => token(value, 64, /^[0-9a-f]{64}$/, field)

const sourceBinding = (value: unknown): ReconcileSourceBinding => {
  const source = record(value, ['revision', 'checksum', 'committedLeaseId'])
  const revision = integer(source.revision, 0, Number.MAX_SAFE_INTEGER, 'source.revision')
  const committedLeaseId = source.committedLeaseId === null && revision === 0 ? null : assertId(source.committedLeaseId, 'source.committedLeaseId')
  return Object.freeze({ revision, checksum: checksum(source.checksum, 'source.checksum'), committedLeaseId })
}

const accountBinding = (value: unknown): ReconcileAccountBinding => {
  const account = record(value, ['id', 'uid', 'username', 'ownerId'])
  return Object.freeze({
    id: assertId(account.id, 'account.id'),
    uid: integer(account.uid, 1000, 65_533, 'account.uid'),
    username: validateUsername(token(account.username, 16, /^[a-z][a-z0-9]*$/, 'account.username')),
    ownerId: account.ownerId === null ? null : assertId(account.ownerId, 'account.ownerId'),
  })
}

const subjectBinding = (value: unknown): ReconcileSubject => {
  const subject = record(value, ['kind'], ['account', 'domainId', 'domainName'])
  if (subject.kind === 'server') { record(value, ['kind']); return Object.freeze({ kind: 'server' }) }
  if (subject.kind === 'account') {
    record(value, ['kind', 'account'])
    return Object.freeze({ kind: 'account', account: accountBinding(subject.account) })
  }
  if (subject.kind !== 'domain') return invalid('subject.kind')
  record(value, ['kind', 'account', 'domainId', 'domainName'])
  return Object.freeze({ kind: 'domain', domainId: assertId(subject.domainId, 'subject.domainId'), domainName: validateDomainName(token(subject.domainName, 253, /^[A-Za-z0-9.-]+$/, 'subject.domainName')), account: accountBinding(subject.account) })
}

const credentialBinding = (value: unknown): ReconcileCredentialBinding => {
  const credential = record(value, ['kind', 'id', 'revision'])
  const kind = oneOf(credential.kind, ['session', 'api_token', 'local_operator'] as const, 'credential.kind')
  const revision = integer(credential.revision, 0, Number.MAX_SAFE_INTEGER, 'credential.revision')
  if (kind === 'local_operator') {
    if (credential.id !== null) return invalid('credential.id')
    return Object.freeze({ kind, id: null, revision })
  }
  return Object.freeze({ kind, id: assertId(credential.id, 'credential.id'), revision })
}

const authorizationBinding = (value: unknown): ReconcileAuthorizationBinding => {
  const authorization = record(value, ['principalId', 'credential', 'audience', 'scopes'])
  const rawScopes = array(authorization.scopes, MAX_RECONCILE_SCOPES, 'authorization.scopes')
  if (rawScopes.length === 0) return invalid('authorization.scopes')
  const scopes = rawScopes.map(scope => scope === '*' ? '*' : token(scope, 97, /^[a-z][a-z0-9-]{0,47}:(?:[a-z][a-z0-9-]{0,47}|\*)$/, 'authorization.scopes'))
  return Object.freeze({
    principalId: assertId(authorization.principalId, 'authorization.principalId'),
    credential: credentialBinding(authorization.credential),
    audience: oneOf(authorization.audience, ['xpanel', 'xwhm', 'management'] as const, 'authorization.audience'),
    scopes: Object.freeze([...new Set(scopes)].sort()),
  })
}

/** Parses client input only. Source, role, principal, scope and MFA claims are never client fields. */
export const parseReconcileRequest = (value: unknown): ReconcileRequest => {
  const request = record(value, ['schemaVersion', 'requestKey'], ['force'])
  if (request.schemaVersion !== RECONCILE_OPERATION_SCHEMA_VERSION) return invalid('schemaVersion')
  return Object.freeze({
    schemaVersion: RECONCILE_OPERATION_SCHEMA_VERSION,
    requestKey: token(request.requestKey, 128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'requestKey'),
    force: request.force === undefined ? false : assertBool(request.force, 'force'),
  })
}

/** Canonical syntax binding only: fingerprints do not prove provenance, authorization or freshness. */
export const bindReconcileOperation = (requestValue: unknown, trustedContext: unknown): BoundReconcileOperation => {
  const request = parseReconcileRequest(requestValue)
  const context = record(trustedContext, ['source', 'subject', 'action', 'authorization'])
  const binding = {
    ...request,
    kind: 'host.reconcile' as const,
    source: sourceBinding(context.source),
    subject: subjectBinding(context.subject),
    action: token(context.action, 96, /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$/, 'action'),
    authorization: authorizationBinding(context.authorization),
  }
  return Object.freeze({ ...binding, requestFingerprint: createHash('sha256').update(JSON.stringify(binding), 'utf8').digest('hex') })
}

/** Hydrates private stored syntax. Matching a self-hash is not provenance, authorization or freshness. */
export const parseBoundReconcileOperation = (value: unknown): BoundReconcileOperation => {
  const stored = record(value, ['schemaVersion', 'requestKey', 'force', 'kind', 'source', 'subject', 'action', 'authorization', 'requestFingerprint'])
  if (stored.kind !== 'host.reconcile') return invalid('kind')
  const bound = bindReconcileOperation(
    { schemaVersion: stored.schemaVersion, requestKey: stored.requestKey, force: stored.force },
    { source: stored.source, subject: stored.subject, action: stored.action, authorization: stored.authorization },
  )
  if (checksum(stored.requestFingerprint, 'requestFingerprint') !== bound.requestFingerprint) return invalid('requestFingerprint')
  return bound
}

const publicReference = (value: unknown): string | null => {
  if (value === null) return null
  const reference = token(value, 64, /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, 'reference')
  if (isUuid(value) || reference === 'XP-JOB-000000' || reference.trim() !== reference) return invalid('reference')
  // An official historic value must remain unchanged. Issuance and allocator format are repository policy.
  return reference
}

const instant = (value: unknown): string => {
  const text = token(value, 24, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'observedAt')
  const parsed = new Date(text)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) return invalid('observedAt')
  return text
}

const sameSource = (left: ReconcileSourceBinding, right: ReconcileSourceBinding): boolean =>
  left.revision === right.revision && left.checksum === right.checksum && left.committedLeaseId === right.committedLeaseId

const observation = (value: unknown, observedAt: string, filesChecksum: string): ReconcileObservation => {
  const item = record(value, ['kind', 'name', 'result', 'observedAt'], ['checksum', 'probe'])
  const at = instant(item.observedAt)
  if (at > observedAt || item.result !== 'passed') return invalid('observation')
  if (item.kind === 'configuration') {
    record(value, ['kind', 'name', 'result', 'observedAt', 'checksum'])
    if (item.name !== 'managed_files' || checksum(item.checksum, 'observation.checksum') !== filesChecksum) return invalid('observation.checksum')
    return Object.freeze({ kind: 'configuration', name: 'managed_files', result: 'passed', observedAt: at, checksum: filesChecksum })
  }
  if (item.kind !== 'service') return invalid('observation.kind')
  record(value, ['kind', 'name', 'result', 'observedAt', 'probe'])
  return Object.freeze({ kind: 'service', name: oneOf(item.name, SERVICE_NAMES, 'observation.name'), probe: oneOf(item.probe, ['protocol', 'process_identity'] as const, 'observation.probe'), result: 'passed', observedAt: at })
}

const observedReceipt = (value: unknown, expectedSource: ReconcileSourceBinding, outcome: 'applied' | 'unchanged'): ReconcileObservedReceipt => {
  const receipt = record(value, ['outcome', 'source', 'generation', 'observedAt', 'observations'])
  const source = sourceBinding(receipt.source)
  if (receipt.outcome !== outcome || !sameSource(source, expectedSource)) return invalid('receipt binding')
  const rawGeneration = record(receipt.generation, ['id', 'status', 'stateChecksum', 'filesChecksum'])
  const stateChecksum = checksum(rawGeneration.stateChecksum, 'generation.stateChecksum')
  if (rawGeneration.status !== 'active' || stateChecksum !== source.checksum) return invalid('generation binding')
  const generation = Object.freeze({ id: integer(rawGeneration.id, 1, Number.MAX_SAFE_INTEGER, 'generation.id'), status: 'active' as const, stateChecksum, filesChecksum: checksum(rawGeneration.filesChecksum, 'generation.filesChecksum') })
  const observedAt = instant(receipt.observedAt)
  const observations = array(receipt.observations, MAX_RECONCILE_OBSERVATIONS, 'observations').map(value => observation(value, observedAt, generation.filesChecksum))
  const identities = new Set(observations.map(item => item.kind + ':' + item.name))
  if (identities.size !== observations.length || !observations.some(item => item.kind === 'configuration') || !observations.some(item => item.kind === 'service' && item.probe === 'protocol')) return invalid('observations')
  return Object.freeze({ outcome, source, generation, observedAt, observations: Object.freeze(observations) })
}

const COMMON_OPERATION_FIELDS = ['schemaVersion', 'reference', 'status', 'phase', 'configurationScope', 'targetVerified', 'verificationRequired', 'needsAttention', 'cancelRequested', 'reason', 'receipt'] as const

const operationBase = (operation: Record<string, unknown>): Omit<ReconcileStateBase, 'source'> => {
  if (operation.schemaVersion !== 1 || operation.configurationScope !== 'global_configuration' || operation.targetVerified !== false || operation.verificationRequired !== true) return invalid('public scope')
  return {
    schemaVersion: 1,
    reference: publicReference(operation.reference),
    configurationScope: 'global_configuration',
    targetVerified: false,
    verificationRequired: true,
    cancelRequested: assertBool(operation.cancelRequested, 'cancelRequested'),
  }
}

const operationOutcome = <Receipt>(
  operation: Record<string, unknown>,
  base: Omit<ReconcileStateBase, 'source'>,
  parseReceipt: (value: unknown, outcome: 'applied' | 'unchanged') => Receipt,
): OperationOutcome<Receipt> => {
  const status = oneOf(operation.status, ['awaiting_intent', 'queued', 'running', 'cancelling', 'applied', 'unchanged', 'failed', 'needs_attention', 'cancelled', 'superseded'] as const, 'status')
  if (status === 'awaiting_intent') {
    if (base.reference !== null || operation.phase !== 'intent' || operation.needsAttention !== false || operation.reason !== 'submission_not_accepted' || operation.receipt !== null || base.cancelRequested) return invalid('unaccepted submission')
    return { status, phase: 'intent', reference: null, needsAttention: false, reason: 'submission_not_accepted', receipt: null }
  }
  if (status === 'applied' || status === 'unchanged') {
    if (base.reference === null || operation.phase !== 'settled' || operation.needsAttention !== false || operation.reason !== null) return invalid('completed outcome')
    return { status, phase: 'settled', reference: base.reference, needsAttention: false, reason: null, receipt: parseReceipt(operation.receipt, status) }
  }
  if (operation.receipt !== null) return invalid('pending receipt')
  if (status === 'needs_attention') {
    if (operation.phase !== 'attention' || operation.needsAttention !== true) return invalid('unknown outcome')
    const reason = oneOf(operation.reason, UNKNOWN_REASONS, 'reason')
    if ((reason === 'intent_unconfirmed' || reason === 'reference_unissued') && base.reference !== null) return invalid('unissued reference')
    return { status, phase: 'attention', needsAttention: true, reason, receipt: null }
  }
  if (operation.needsAttention !== false) return invalid('needsAttention')
  if (status === 'queued' || status === 'running' || status === 'cancelling') {
    if (base.reference === null || operation.reason !== null || (status === 'cancelling' && !base.cancelRequested)) return invalid('pending outcome')
    const phase = status === 'queued' ? oneOf(operation.phase, ['queued'] as const, 'phase') : oneOf(operation.phase, RUNNING_PHASES, 'phase')
    return { status, phase, reference: base.reference, needsAttention: false, reason: null, receipt: null }
  }
  if (operation.phase !== 'settled') return invalid('terminal phase')
  const reason = oneOf(operation.reason, PUBLIC_REASONS, 'reason')
  if (reason === 'submission_not_accepted' || UNKNOWN_REASONS.includes(reason) || (status === 'superseded' && reason !== 'source_superseded') || (status === 'cancelled' && reason !== 'cancelled_before_effect' && reason !== 'cancelled_after_recovery')) return invalid('terminal reason')
  return { status, phase: 'settled', needsAttention: false, reason, receipt: null }
}

/** Full internal validation; observation syntax does not prove that an authentic probe ran. */
export const parseReconcileOperationState = (value: unknown): ReconcileOperationState => {
  const operation = record(value, [...COMMON_OPERATION_FIELDS, 'source'])
  const base = operationBase(operation)
  const source = sourceBinding(operation.source)
  const outcome = operationOutcome(operation, base, (receipt, status) => observedReceipt(receipt, source, status))
  return Object.freeze({ ...base, source, ...outcome })
}

const publicObservedReceipt = (value: unknown, expectedOutcome: 'applied' | 'unchanged'): ReconcilePublicReceipt => {
  const receipt = record(value, ['outcome', 'observedAt', 'services'])
  if (receipt.outcome !== expectedOutcome) return invalid('receipt outcome')
  const observedAt = instant(receipt.observedAt)
  const services = array(receipt.services, MAX_RECONCILE_OBSERVATIONS - 1, 'services').map(value => {
    const service = record(value, ['name', 'probe', 'result', 'observedAt'])
    const at = instant(service.observedAt)
    if (at > observedAt || service.result !== 'passed') return invalid('service observation')
    return Object.freeze({ name: oneOf(service.name, SERVICE_NAMES, 'service.name'), probe: oneOf(service.probe, ['protocol', 'process_identity'] as const, 'service.probe'), result: 'passed' as const, observedAt: at })
  })
  if (new Set(services.map(service => service.name)).size !== services.length || !services.some(service => service.probe === 'protocol')) return invalid('services')
  return Object.freeze({ outcome: expectedOutcome, observedAt, services: Object.freeze(services) })
}

/** Validates outward syntax only. Internal IDs, global checksums, raw logs and unit names are forbidden. */
export const parseReconcilePublicOperation = (value: unknown): ReconcilePublicOperation => {
  const operation = record(value, [...COMMON_OPERATION_FIELDS, 'sourceRevision'])
  const base = operationBase(operation)
  const sourceRevision = integer(operation.sourceRevision, 0, Number.MAX_SAFE_INTEGER, 'sourceRevision')
  return Object.freeze({ ...base, sourceRevision, ...operationOutcome(operation, base, publicObservedReceipt) })
}

/** Validate private binding before projection; never expose raw worker state as a public DTO. */
export const projectReconcilePublicOperation = (value: unknown): ReconcilePublicOperation => {
  const state = parseReconcileOperationState(value)
  const receipt = state.receipt === null ? null : {
    outcome: state.receipt.outcome,
    observedAt: state.receipt.observedAt,
    services: state.receipt.observations.flatMap(item => item.kind === 'service'
      ? [{ name: item.name, probe: item.probe, result: item.result, observedAt: item.observedAt }]
      : []),
  }
  return parseReconcilePublicOperation({
    schemaVersion: state.schemaVersion,
    reference: state.reference,
    sourceRevision: state.source.revision,
    status: state.status,
    phase: state.phase,
    configurationScope: state.configurationScope,
    targetVerified: state.targetVerified,
    verificationRequired: state.verificationRequired,
    cancelRequested: state.cancelRequested,
    needsAttention: state.needsAttention,
    reason: state.reason,
    receipt,
  })
}
