import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { SecurityObservationWindow } from '@xpanel/os'
import type { SshObservation, SshKeyObservation } from '../../agent/src/services/security-observation.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface SecurityWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'getServerSettings'>
  observeSsh?: (input: { window: SecurityObservationWindow }) => Promise<SshObservation>
  addRootKey?: (input: { publicKey: unknown; expectedRevision: unknown }) => Promise<{ applied: true; keys: SshObservation['keys'] }>
  removeManagedRootKey?: (input: { fingerprint: unknown; expectedRevision: unknown }) => Promise<{ applied: true; keys: SshObservation['keys'] }>
  /** Read-only trusted catalog admission, also used to report actual action availability. */
  assertKeyMutationQualified: () => Promise<void>
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const safeText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(value)
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value)
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const badObservation = (): never => fail('PRECONDITION_FAILED', 'SSH observation could not be verified', { stateChanged: false, verificationRequired: true })

/** Whitelist the host boundary; no raw public-key blob, journal line, private key or config escapes. */
export function projectSshKeyObservation(value: unknown): SshObservation['keys'] {
  if (!object(value) || !['read', 'partial', 'review-required', 'unavailable'].includes(String(value.state)) || !Array.isArray(value.items) || value.items.length > 500 || !Number.isSafeInteger(value.opaqueEntries) || Number(value.opaqueEntries) < 0) return badObservation()
  if (value.state === 'unavailable' ? value.revision !== null : !revision(value.revision)) return badObservation()
  if (value.state === 'unavailable' && (value.items.length !== 0 || value.opaqueEntries !== 0)) return badObservation()
  const items: SshKeyObservation[] = value.items.map(raw => {
    if (!object(raw) || !fingerprint(raw.fingerprint) || !safeText(raw.keyType, 64) || !safeText(raw.comment, 256) || typeof raw.managed !== 'boolean' || typeof raw.protected !== 'boolean' || raw.addedAt !== null && !timestamp(raw.addedAt) || raw.lastUsedAt !== null) return badObservation()
    return { fingerprint: raw.fingerprint, keyType: raw.keyType, comment: raw.comment, managed: raw.managed, protected: raw.protected, addedAt: raw.addedAt as string | null, lastUsedAt: null }
  })
  return { state: value.state as SshObservation['keys']['state'], revision: value.revision as string | null, items, opaqueEntries: Number(value.opaqueEntries), ...(value.state === 'review-required' ? { reason: 'root_key_write_requires_review' } : value.state === 'unavailable' ? { reason: 'ssh_keys_unavailable' } : {}) }
}

export function projectSshObservation(value: unknown): SshObservation {
  if (!object(value) || !timestamp(value.observedAt) || !object(value.policy) || !object(value.policy.values) || !object(value.service) || !object(value.failedLogins)) return badObservation()
  const policy = value.policy, service = value.service, failures = value.failedLogins
  if (!['read', 'unavailable'].includes(String(policy.state)) || !['read', 'unavailable'].includes(String(service.state)) || !['read', 'unavailable'].includes(String(failures.state))) return badObservation()
  const allowedPolicy = new Set(['port', 'pubkeyauthentication', 'passwordauthentication', 'permitrootlogin', 'kbdinteractiveauthentication', 'authenticationmethods', 'maxauthtries', 'logingracetime', 'allowusers', 'allowgroups'])
  const values: Record<string, string> = {}
  const policyValues = policy.values
  if (!object(policyValues)) return badObservation()
  for (const [key, raw] of Object.entries(policyValues)) {
    if (!allowedPolicy.has(key)) continue
    if (!safeText(raw, 1024)) return badObservation()
    values[key] = raw
  }
  if (!safeText(service.unit, 128) || !/^[a-zA-Z0-9_.@-]+\.service$/.test(service.unit) || [service.active, service.substate, service.enabled].some(raw => raw !== null && !safeText(raw, 128))) return badObservation()
  if (!Array.isArray(failures.items) || failures.items.length > 500 || !['24h', '7d'].includes(String(failures.window)) || failures.limit !== 500 || typeof failures.truncated !== 'boolean') return badObservation()
  const items = failures.items.map(raw => {
    if (!object(raw) || !timestamp(raw.at) || !safeText(raw.address, 64) || !safeText(raw.username, 64) || !safeText(raw.method, 64)) return badObservation()
    return { at: raw.at, address: raw.address, username: raw.username, method: raw.method }
  })
  return {
    observedAt: value.observedAt,
    policy: { state: policy.state as 'read' | 'unavailable', values, ...(policy.state === 'unavailable' ? { reason: 'ssh_policy_unavailable' } : {}) },
    service: { state: service.state as 'read' | 'unavailable', unit: service.unit, active: service.active as string | null, substate: service.substate as string | null, enabled: service.enabled as string | null, ...(service.state === 'unavailable' ? { reason: 'ssh_service_unavailable' } : {}) },
    keys: projectSshKeyObservation(value.keys),
    failedLogins: { state: failures.state as 'read' | 'unavailable', items, window: failures.window as SecurityObservationWindow, limit: 500, truncated: failures.truncated, ...(failures.state === 'unavailable' ? { reason: 'ssh_journal_unavailable' } : {}) },
  }
}

export interface SecurityEvidenceCheck {
  id: 'ssh-service' | 'ssh-public-key' | 'ssh-password' | 'ssh-root-login' | 'ssh-attempts'
  state: 'observed-ok' | 'attention' | 'unavailable'
  value: string | null
  source: 'host-observation'
}

export const securityEvidenceChecks = (ssh: SshObservation | null): SecurityEvidenceCheck[] => {
  const policy = ssh?.policy.state === 'read' ? ssh.policy.values : {}
  const check = (id: SecurityEvidenceCheck['id'], value: string | null | undefined, acceptable: (value: string) => boolean): SecurityEvidenceCheck => ({ id, value: value ?? null, source: 'host-observation', state: value === null || value === undefined ? 'unavailable' : acceptable(value) ? 'observed-ok' : 'attention' })
  return [
    check('ssh-service', ssh?.service.state === 'read' ? ssh.service.active : null, value => value === 'active'),
    check('ssh-public-key', policy.pubkeyauthentication, value => value === 'yes'),
    check('ssh-password', policy.passwordauthentication, value => value === 'no'),
    check('ssh-root-login', policy.permitrootlogin, value => ['prohibit-password', 'without-password', 'no'].includes(value)),
    check('ssh-attempts', policy.maxauthtries, value => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 6),
  ]
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const bodyObject = async (req: Request, fields: readonly string[]): Promise<Record<string, unknown>> => {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  let body: unknown
  try { body = await req.json() } catch { return fail('VALIDATION', 'request body is not valid JSON', { stateChanged: false }) }
  if (!object(body) || Object.keys(body).some(key => !fields.includes(key))) return fail('VALIDATION', 'unsupported security workspace field', { stateChanged: false })
  if (!revision(body.expectedRevision)) return fail('VALIDATION', 'saved SSH key revision is required', { stateChanged: false })
  return body
}

export function createSecurityWorkspaceRoutes(helpers: SecurityWorkspaceHelpers): (req: Request, url: URL, method: string) => Promise<Response | null> {
  return async (req, url, method) => {
    const path = url.pathname
    if (!['/api/security/workspace', '/api/security/ssh', '/api/security/ssh/keys'].includes(path)) return null
    const writing = path === '/api/security/ssh/keys' && ['POST', 'DELETE'].includes(method)
    if (!writing && (path === '/api/security/ssh/keys' || method !== 'GET')) return new Response(null, { status: 405, headers: { allow: path === '/api/security/ssh/keys' ? 'POST, DELETE' : 'GET' } })
    let caller = await helpers.requireCaller(req)
    await helpers.assertRoot(caller, writing ? 'security.ssh.keys.modify' : 'security.observe')
    if ([...url.searchParams.keys()].some(key => key !== 'window') || url.searchParams.getAll('window').length > 1 || writing && url.search) return fail('VALIDATION', 'unsupported security workspace selector', { stateChanged: false })
    const window = url.searchParams.get('window') ?? '24h'
    if (!['24h', '7d'].includes(window)) return fail('VALIDATION', 'SSH observation window must be 24h or 7d', { stateChanged: false })
    if (writing) {
      const body = await bodyObject(req, method === 'POST' ? ['publicKey', 'expectedRevision'] : ['fingerprint', 'expectedRevision'])
      if (method === 'POST' && !safeText(body.publicKey, 8192) || method === 'DELETE' && !fingerprint(body.fingerprint)) return fail('VALIDATION', 'a bounded public key or saved fingerprint is required', { stateChanged: false })
      await helpers.assertKeyMutationQualified()
      caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'security.ssh.keys.modify')
      const operation = method === 'POST' ? helpers.addRootKey : helpers.removeManagedRootKey
      if (!operation) return fail('PRECONDITION_FAILED', 'SSH key operations require a qualified host adapter', { stateChanged: false })
      await helpers.emitAudit({ actor: caller.principal.username, action: 'security.ssh.key.change_requested', target: 'ssh:root-authorized-keys', detail: { operation: method === 'POST' ? 'add' : 'remove' }, outcome: 'ok', principalId: caller.principal.id })
      caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'security.ssh.keys.modify')
      const result = method === 'POST'
        ? await helpers.addRootKey!({ publicKey: body.publicKey, expectedRevision: body.expectedRevision })
        : await helpers.removeManagedRootKey!({ fingerprint: body.fingerprint, expectedRevision: body.expectedRevision })
      let keys: SshObservation['keys'], targetFingerprint: string
      try {
        if (!object(result) || result.applied !== true) throw new Error('invalid_ack')
        keys = projectSshKeyObservation(result.keys)
        if (!['read', 'partial'].includes(keys.state)) throw new Error('invalid_key_state')
        if (method === 'POST') {
          const blob = String(body.publicKey).trim().split(/\s+/)[1]
          if (!blob || !/^[A-Za-z0-9+/]{32,}={0,2}$/.test(blob)) throw new Error('invalid_key_identity')
          targetFingerprint = 'SHA256:' + createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')
          if (!keys.items.some(key => key.fingerprint === targetFingerprint && key.managed)) throw new Error('wrong_key_ack')
        } else {
          targetFingerprint = String(body.fingerprint)
          if (keys.items.some(key => key.fingerprint === targetFingerprint)) throw new Error('key_still_observed')
        }
      } catch { return fail('PRECONDITION_FAILED', 'SSH key-change outcome requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
      try { await helpers.emitAudit({ actor: caller.principal.username, action: method === 'POST' ? 'security.ssh.key.added' : 'security.ssh.key.removed', target: 'ssh-key:' + targetFingerprint, detail: { managedKeys: keys.items.filter(key => key.managed).length }, outcome: 'ok', principalId: caller.principal.id }) }
      catch { return fail('PRECONDITION_FAILED', 'SSH key change requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
      return json({ applied: true, fingerprint: targetFingerprint, authenticationVerified: false, keys })
    }
    if (!helpers.observeSsh && path === '/api/security/ssh') return fail('PRECONDITION_FAILED', 'SSH observations require an authorized host adapter', { stateChanged: false })
    let ssh: SshObservation | null = null
    if (helpers.observeSsh) {
      try { ssh = projectSshObservation(await helpers.observeSsh({ window: window as SecurityObservationWindow })) }
      catch { if (path === '/api/security/ssh') return fail('PRECONDITION_FAILED', 'authorized SSH observations are unavailable', { stateChanged: false, verificationRequired: true }) }
      if (ssh && ssh.failedLogins.window !== window) return badObservation()
    }
    if (path === '/api/security/ssh') {
      let qualified = false
      try { await helpers.assertKeyMutationQualified(); qualified = true } catch { /* observations never grant mutation admission */ }
      const keysAvailable = !!ssh && ['read', 'partial'].includes(ssh.keys.state)
      return json({ ssh, keyActions: { add: qualified && keysAvailable && ssh!.keys.opaqueEntries === 0 && !!helpers.addRootKey, remove: qualified && keysAvailable && ssh!.keys.items.length > 1 && ssh!.keys.items.some(key => key.managed && !key.protected) && !!helpers.removeManagedRootKey } })
    }
    const settings = await helpers.store.getServerSettings()
    return json({ checkedAt: new Date().toISOString(), configuration: settings ? { state: 'read', source: 'saved-configuration', panelPort: settings.panelPort, sshPort: settings.sshPort, engine: settings.engine } : { state: 'unavailable', source: 'saved-configuration' }, ssh, checks: securityEvidenceChecks(ssh), overall: 'not-qualified' })
  }
}
