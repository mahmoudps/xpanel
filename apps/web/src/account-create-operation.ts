export type AccountCreateOperationPhase = 'pending' | 'no-effects' | 'complete'
export interface AccountCreateOperationRecord {
  readonly version: 1
  readonly key: string
  readonly username: string
  readonly phase: AccountCreateOperationPhase
}

/** Retains only an opaque retry key and account username, never credentials or a credential digest. */
export function accountCreateOperation(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, actor: string) {
  if (typeof actor !== 'string' || !/^(root|reseller):[^\u0000-\u0020\u007f<>]{1,128}$/.test(actor)) throw new Error('account_request_actor_unavailable')
  const namespace = 'xpanel.account-create.v1.' + encodeURIComponent(actor)
  const read = (): AccountCreateOperationRecord | null => {
    const raw = storage.getItem(namespace)
    if (raw === null) return null
    if (raw.length > 512) throw new Error('invalid_account_request_record')
    const value = JSON.parse(raw) as AccountCreateOperationRecord
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'key,phase,username,version'
      || value.version !== 1 || typeof value.key !== 'string' || !/^account-create:[0-9a-f]{32}$/.test(value.key)
      || typeof value.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(value.username)
      || !['pending', 'no-effects', 'complete'].includes(value.phase)) throw new Error('invalid_account_request_record')
    return value
  }
  const write = (value: AccountCreateOperationRecord): void => {
    const raw = JSON.stringify(value)
    storage.setItem(namespace, raw)
    if (storage.getItem(namespace) !== raw) throw new Error('account_request_not_retained')
  }
  return {
    read,
    begin(username: string): string {
      if (!/^[a-z][a-z0-9]{0,15}$/.test(username)) throw new Error('invalid_account_request_username')
      const existing = read()
      if (existing && existing.username !== username && existing.phase !== 'no-effects') throw new Error('account_request_requires_review')
      if (existing && existing.username === username) { write({ ...existing, phase: 'pending' }); return existing.key }
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      const key = 'account-create:' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
      write({ version: 1, key, username, phase: 'pending' })
      return key
    },
    mark(phase: AccountCreateOperationPhase): void {
      const existing = read()
      if (!existing || !['pending', 'no-effects', 'complete'].includes(phase)) throw new Error('account_request_unavailable')
      write({ ...existing, phase })
    },
    discard(): void {
      if (read()?.phase === 'pending') throw new Error('account_request_requires_review')
      storage.removeItem(namespace)
      if (storage.getItem(namespace) !== null) throw new Error('account_request_not_cleared')
    },
  }
}

/** Validates the public acknowledgement; the server retains authority for real native observations. */
export function accountCreationAcknowledgement(value: unknown, submitted: { username: string; primaryDomain: string; planId: string; ownerId?: string | null; shell?: string }): 'verified' | 'replay' | undefined {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const uuid = (item: unknown): boolean => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const text = (item: unknown, max = 4096): item is string => typeof item === 'string' && item.length > 0 && item.length <= max && !/[\u0000-\u001f\u007f]/.test(item)
  const integer = (item: unknown, minimum: number): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= minimum
  const hex = (item: unknown): boolean => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const fields = (item: Record<string, unknown>, names: string): boolean => Object.keys(item).sort().join() === names.split(',').sort().join()
  if (!object(value) || !object(value.account) || !object(value.operation) || !object(value.execution)) return
  const a = value.account, operation = value.operation, execution = value.execution
  if (!uuid(a.id) || a.username !== submitted.username || a.primaryDomain !== submitted.primaryDomain || a.planId !== submitted.planId
    || !integer(a.uid, 1) || !integer(a.gid, 1) || !text(a.home) || !text(a.ipv4, 15)
    || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(a.ipv4) || a.ipv4.split('.').some(part => Number(part) > 255)
    || (Object.hasOwn(submitted, 'ownerId') && a.ownerId !== submitted.ownerId) || (Object.hasOwn(submitted, 'shell') && a.shell !== submitted.shell)
    || operation.status !== 'succeeded' || !integer(operation.resumedFromStep, 0) || operation.resumedFromStep > 4
    || !(operation.reference === null || text(operation.reference, 128)) || execution.scope !== 'account') return
  const verified = operation.completedReplay === false && execution.status === 'account_verified' && execution.targetVerified === true && execution.verificationRequired === false
  const fresh = verified && operation.freshExecution === true && operation.resumedFromStep <= 2
  const resumed = verified && operation.freshExecution === false && operation.resumedFromStep === 3 && value.reconcile === null
  const replay = operation.completedReplay === true && operation.freshExecution === false && operation.resumedFromStep === 4 && value.reconcile === null && execution.status === 'already_completed'
    && execution.targetVerified === false && execution.verificationRequired === true && execution.replay === true
  if ((!fresh && !resumed && !replay) || !fields(operation, 'status,reference,resumedFromStep,freshExecution,completedReplay')
    || !fields(execution, fresh || resumed ? 'status,scope,targetVerified,verificationRequired,observation' : 'status,scope,targetVerified,verificationRequired,replay,lastVerifiedObservation')) return
  const e = fresh || resumed ? execution.observation : execution.lastVerifiedObservation
  if (!object(e) || !fields(e, 'accountId,uid,gid,home,revision,generationId,generationChecksum,sourceChecksum,cgroup,services,quota,dns,php')
    || e.accountId !== a.id || e.uid !== a.uid || e.gid !== a.gid || e.home !== a.home
    || !integer(e.revision, 0) || !integer(e.generationId, 1) || !hex(e.generationChecksum) || !hex(e.sourceChecksum) || !text(e.cgroup)
    || !Array.isArray(e.services) || e.services.length < 1 || e.services.length > 128 || e.services.some(service => !text(service, 256))
    || !object(e.quota) || !fields(e.quota, 'enforced,filesystem') || e.quota.enforced !== true || !text(e.quota.filesystem, 256)
    || !object(e.dns) || !fields(e.dns, 'zone,serial,authoritative') || e.dns.zone !== a.primaryDomain || e.dns.authoritative !== true || !integer(e.dns.serial, 1) || e.dns.serial > 4294967295
    || !object(e.php) || !fields(e.php, 'status,uid,cgroup') || e.php.status !== 200 || e.php.uid !== a.uid || e.php.cgroup !== e.cgroup) return
  if (fresh) {
    const reconciliation = value.reconcile
    if (!object(reconciliation) || !['applied', 'noop'].includes(reconciliation.status as string) || !object(reconciliation.generation)
      || reconciliation.generation.status !== 'active' || reconciliation.generation.id !== e.generationId || reconciliation.generation.checksum !== e.generationChecksum
      || (reconciliation.status === 'noop' && reconciliation.stateChecksum !== e.sourceChecksum)) return
  }
  return fresh || resumed ? 'verified' : 'replay'
}

export const ACCOUNT_CREATE_OPERATION_BINDING = accountCreateOperation.toString()
export const ACCOUNT_CREATION_ACKNOWLEDGEMENT_BINDING = accountCreationAcknowledgement.toString()
