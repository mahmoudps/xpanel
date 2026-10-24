import { describe, expect, it } from 'vitest'
import * as core from './index.ts'

const parseRequest = (value: unknown) => core.parseReconcileRequest(value)
const bind = (request: unknown, context: unknown) => core.bindReconcileOperation(request, context)
const projectPublic = (value: unknown) => core.projectReconcilePublicOperation(value)

const ids = {
  principal: '10000000-0000-4000-8000-000000000001',
  credential: '10000000-0000-4000-8000-000000000002',
  commit: '10000000-0000-4000-8000-000000000003',
  account: '10000000-0000-4000-8000-000000000004',
  owner: '10000000-0000-4000-8000-000000000005',
  domain: '10000000-0000-4000-8000-000000000006',
}
const source = () => ({ revision: 7, checksum: 'a'.repeat(64), committedLeaseId: ids.commit })
const request = () => ({ schemaVersion: 1, requestKey: 'account-change-0001', force: false })
const context = () => ({
  source: source(),
  subject: { kind: 'account', account: { id: ids.account, uid: 20001, username: 'alice', ownerId: ids.owner } },
  action: 'account.update',
  authorization: {
    principalId: ids.principal,
    credential: { kind: 'session', id: ids.credential, revision: 4 },
    audience: 'xwhm',
    scopes: ['accounts:write', 'accounts:read'],
  },
})
const observedAt = '2026-10-23T00:10:00.000Z'
const receipt = () => ({
  outcome: 'applied',
  source: source(),
  generation: { id: 11, status: 'active', stateChecksum: 'a'.repeat(64), filesChecksum: 'b'.repeat(64) },
  observedAt,
  observations: [
    { kind: 'configuration', name: 'managed_files', result: 'passed', observedAt, checksum: 'b'.repeat(64) },
    { kind: 'service', name: 'http', probe: 'protocol', result: 'passed', observedAt },
  ],
})
const publicOperation = () => ({
  schemaVersion: 1,
  reference: 'XP-JOB-2026-000001',
  source: source(),
  status: 'queued',
  phase: 'queued',
  configurationScope: 'global_configuration',
  targetVerified: false,
  verificationRequired: true,
  needsAttention: false,
  cancelRequested: false,
  reason: null,
  receipt: null,
})
const appliedOperation = () => ({ ...publicOperation(), reference: 'XP-JOB-2026-000001', status: 'applied', phase: 'settled', receipt: receipt() })
const rejects = (run: () => unknown) => {
  try { run() } catch (error) {
    expect(error).toBeInstanceOf(core.XpanelError)
    expect((error as core.XpanelError).code).toBe('VALIDATION')
    return
  }
  throw new Error('expected a validation refusal')
}

describe('reconcile operation request and canonical trusted binding', () => {
  it('exports the three contract boundaries from core and copies a minimal client request', () => {
    const raw = request()
    const parsed = parseRequest(raw)
    expect(parsed).toEqual(raw)
    expect(parsed).not.toBe(raw)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(parseRequest({ schemaVersion: 1, requestKey: raw.requestKey })).toEqual(raw)
  })

  it.each(['source', 'role', 'mfaVerified', 'authorization', 'subject', 'principalId', 'requestFingerprint', 'password'])('rejects client authority claim %s', key => {
    rejects(() => parseRequest({ ...request(), [key]: 'client-controlled' }))
  })

  it.each([null, [], true, 'request', { ...request(), schemaVersion: 2 }, { ...request(), force: 'false' },
    { ...request(), requestKey: '' }, { ...request(), requestKey: 'x'.repeat(129) },
    { ...request(), requestKey: 'retry\nsecond' }, { ...request(), requestKey: 'retry\u202e1' },
  ])('rejects malformed or unbounded request %#', raw => rejects(() => parseRequest(raw)))

  it('rejects inherited, symbol, nonenumerable and accessor fields without invoking an accessor', () => {
    let touched = false
    const accessor = { ...request() }
    Object.defineProperty(accessor, 'role', { enumerable: true, get() { touched = true; return 'root' } })
    const hidden = { ...request() }
    Object.defineProperty(hidden, 'role', { value: 'root' })
    rejects(() => parseRequest(accessor))
    rejects(() => parseRequest(hidden))
    rejects(() => parseRequest({ ...request(), [Symbol('role')]: 'root' }))
    rejects(() => parseRequest(Object.assign(Object.create({ role: 'root' }), request())))
    expect(touched).toBe(false)
  })

  it('canonicalizes copied bindings without mutating their inputs or treating fingerprints as authorization', () => {
    const trusted = context()
    const bound = bind(request(), trusted)
    const equivalent = { ...context(), authorization: { ...context().authorization, scopes: ['accounts:read', 'accounts:write', 'accounts:read'] } }
    expect(bound.kind).toBe('host.reconcile')
    expect(bound.requestFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(bind({ force: false, requestKey: request().requestKey, schemaVersion: 1 }, equivalent)).toEqual(bound)
    expect(trusted.authorization.scopes).toEqual(['accounts:write', 'accounts:read'])
    expect(Object.isFrozen(bound.authorization.scopes)).toBe(true)
    expect(Object.isFrozen(bound.subject)).toBe(true)
    expect(() => (bound.authorization.scopes as string[]).push('*')).toThrow()
  })

  it('binds every request, source, subject, action and credential security input into the fingerprint', () => {
    const original = bind(request(), context()).requestFingerprint
    const changes: [unknown, unknown][] = [
      [{ ...request(), requestKey: 'account-change-0002' }, context()],
      [{ ...request(), force: true }, context()],
      [request(), { ...context(), source: { ...source(), revision: 8 } }],
      [request(), { ...context(), source: { ...source(), checksum: 'c'.repeat(64) } }],
      [request(), { ...context(), source: { ...source(), committedLeaseId: ids.domain } }],
      [request(), { ...context(), action: 'account.suspend' }],
      [request(), { ...context(), subject: { ...context().subject, account: { ...context().subject.account, ownerId: null } } }],
      [request(), { ...context(), subject: { ...context().subject, account: { ...context().subject.account, id: ids.domain } } }],
      [request(), { ...context(), subject: { ...context().subject, account: { ...context().subject.account, uid: 20002 } } }],
      [request(), { ...context(), subject: { ...context().subject, account: { ...context().subject.account, username: 'alice2' } } }],
      [request(), { ...context(), authorization: { ...context().authorization, principalId: ids.owner } }],
      [request(), { ...context(), authorization: { ...context().authorization, credential: { ...context().authorization.credential, id: ids.owner } } }],
      [request(), { ...context(), authorization: { ...context().authorization, credential: { ...context().authorization.credential, revision: 5 } } }],
      [request(), { ...context(), authorization: { ...context().authorization, credential: { ...context().authorization.credential, kind: 'api_token' } } }],
      [request(), { ...context(), authorization: { ...context().authorization, audience: 'management' } }],
      [request(), { ...context(), authorization: { ...context().authorization, scopes: ['accounts:read'] } }],
    ]
    for (const [client, trusted] of changes) expect(bind(client, trusted).requestFingerprint).not.toBe(original)
  })

  it('hydrates exact private stored bindings and refuses altered hashes or unknown fields', () => {
    const bound = bind(request(), context())
    const hydrated = core.parseBoundReconcileOperation(JSON.parse(JSON.stringify(bound)))
    expect(hydrated).toEqual(bound)
    expect(hydrated).not.toBe(bound)
    expect(Object.isFrozen(hydrated.authorization.credential)).toBe(true)
    rejects(() => core.parseBoundReconcileOperation({ ...bound, requestFingerprint: '0'.repeat(64) }))
    rejects(() => core.parseBoundReconcileOperation({ ...bound, source: { ...bound.source, revision: 8 } }))
    rejects(() => core.parseBoundReconcileOperation({ ...bound, role: 'root' }))
    rejects(() => core.parseBoundReconcileOperation({ ...bound, kind: 'account.purge' }))
    // A self-consistent fingerprint proves syntax, not origin or permission; the receiver must reauthorize.
    const other = bind(request(), { ...context(), authorization: { ...context().authorization, principalId: ids.owner } })
    expect(core.parseBoundReconcileOperation(other).authorization.principalId).toBe(ids.owner)
  })

  it('supports server, account and domain subjects without accepting paths or mutable public references as identity', () => {
    expect(bind(request(), { ...context(), subject: { kind: 'server' } }).subject).toEqual({ kind: 'server' })
    const domain = { kind: 'domain', domainId: ids.domain, domainName: 'alice.example.test', account: context().subject.account }
    expect(bind(request(), { ...context(), subject: domain }).subject).toEqual(domain)
    rejects(() => bind(request(), { ...context(), subject: { ...domain, path: '/etc/nginx' } }))
    rejects(() => bind(request(), { ...context(), subject: { ...context().subject, reference: 'JOB-2026-000001' } }))
  })

  it('requires committed source identity for positive revisions and normalizes UUID case only', () => {
    rejects(() => bind(request(), { ...context(), source: { ...source(), committedLeaseId: null } }))
    rejects(() => bind(request(), { ...context(), source: { ...source(), revision: Number.MAX_SAFE_INTEGER + 1 } }))
    rejects(() => bind(request(), { ...context(), source: { ...source(), checksum: 'A'.repeat(64) } }))
    expect(bind(request(), { ...context(), source: { revision: 0, checksum: '0'.repeat(64), committedLeaseId: null } }).source.revision).toBe(0)
    const upper = ids.principal.replace('10000000', 'ABCDEF00')
    expect(bind(request(), { ...context(), authorization: { ...context().authorization, principalId: upper } }).authorization.principalId).toBe(upper.toLowerCase())
  })

  it('rejects role/MFA claims, malformed credentials, unknown nested fields and excessive scopes in trusted context too', () => {
    const raw = context()
    const bad = [
      { ...raw, role: 'root' },
      { ...raw, authorization: { ...raw.authorization, role: 'root' } },
      { ...raw, authorization: { ...raw.authorization, mfaVerified: true } },
      { ...raw, authorization: { ...raw.authorization, audience: 'xmail' } },
      { ...raw, authorization: { ...raw.authorization, credential: { ...raw.authorization.credential, id: null } } },
      { ...raw, authorization: { ...raw.authorization, credential: { ...raw.authorization.credential, revision: -1 } } },
      { ...raw, authorization: { ...raw.authorization, scopes: Array(65).fill('accounts:read') } },
      { ...raw, authorization: { ...raw.authorization, scopes: ['password=fixture-secret'] } },
      { ...raw, source: { ...source(), toJSON: () => source() } },
    ]
    for (const value of bad) rejects(() => bind(request(), value))
    expect(bind(request(), { ...raw, authorization: { ...raw.authorization, credential: { kind: 'local_operator', id: null, revision: 0 }, audience: 'management' } }).authorization.credential.id).toBeNull()
  })
})

describe('safe public reconcile operation contract', () => {
  it('keeps unissued references null and never invents an internal-ID-derived reference', () => {
    const unissued = { ...publicOperation(), reference: null, status: 'awaiting_intent', phase: 'intent', reason: 'submission_not_accepted' }
    expect(projectPublic(unissued).reference).toBeNull()
    for (const reference of ['XP-JOB-000001', 'XP-JOB-2026-000001', 'XP-JOB-2026-1000000', 'LEGACY/77-A', 'JOB-2026-0000001', 'CUSTOM-9007199254740992']) {
      expect(projectPublic({ ...publicOperation(), reference }).reference).toBe(reference)
    }
    for (const reference of [ids.account, 'XP-JOB-000000', '', ' XP-JOB-000001', 'XP-JOB-000001\nprivate', 'x'.repeat(65), 'XP-JOB-\u0662\u0660\u0662\u0666-000001']) {
      rejects(() => projectPublic({ ...publicOperation(), reference }))
    }
  })

  it('does not publish a reserved reference or label an unaccepted intent queued or applied', () => {
    const unissued = { ...publicOperation(), reference: null, status: 'awaiting_intent', phase: 'intent', reason: 'submission_not_accepted' }
    expect(projectPublic(unissued).status).toBe('awaiting_intent')
    rejects(() => projectPublic({ ...unissued, reference: 'XP-JOB-2026-000002' }))
    rejects(() => projectPublic({ ...publicOperation(), reference: null }))
    rejects(() => projectPublic({ ...appliedOperation(), reference: null }))
    const unconfirmed = { ...unissued, status: 'needs_attention', phase: 'attention', needsAttention: true, reason: 'intent_unconfirmed' }
    expect(projectPublic(unconfirmed).reference).toBeNull()
    rejects(() => projectPublic({ ...unconfirmed, reference: 'XP-JOB-2026-000002' }))
  })

  it('does not reflect malformed private values in validation errors', () => {
    const privateValue = { password: 'private-fixture-value' }
    for (const trusted of [
      { ...context(), source: { ...source(), revision: privateValue } },
      { ...context(), source: { ...source(), checksum: privateValue } },
      { ...context(), authorization: { ...context().authorization, credential: { ...context().authorization.credential, revision: privateValue } } },
    ]) {
      try { bind(request(), trusted); throw new Error('expected validation') } catch (error) {
        expect(error).toBeInstanceOf(core.XpanelError)
        expect(JSON.stringify(error)).not.toContain('private-fixture-value')
      }
    }
  })

  it('accepts copied pending, observed applied and unknown outcomes with distinct semantics', () => {
    const pending = projectPublic(publicOperation())
    expect(pending.receipt).toBeNull()
    const applied = projectPublic(appliedOperation())
    expect(applied.status).toBe('applied')
    expect(applied.targetVerified).toBe(false)
    expect(applied.verificationRequired).toBe(true)
    expect(Object.isFrozen(applied)).toBe(true)
    expect(Object.isFrozen(applied.receipt?.services)).toBe(true)
    const unknown = { ...publicOperation(), status: 'needs_attention', phase: 'attention', needsAttention: true, reason: 'effect_outcome_unknown' }
    expect(projectPublic(unknown).status).toBe('needs_attention')
  })

  it('validates private receipt binding before projecting an outward DTO without global coordination identities', () => {
    const internal = appliedOperation()
    const outward = projectPublic(internal)
    expect(core.parseReconcileOperationState(internal).receipt?.generation.id).toBe(11)
    expect(outward.sourceRevision).toBe(7)
    expect(outward.receipt).toEqual({ outcome: 'applied', observedAt, services: [{ name: 'http', probe: 'protocol', result: 'passed', observedAt }] })
    expect(core.parseReconcilePublicOperation(outward)).toEqual(outward)
    const serialized = JSON.stringify(outward)
    for (const privateValue of [ids.commit, ids.principal, ids.account, 'a'.repeat(64), 'b'.repeat(64)]) expect(serialized).not.toContain(privateValue)
    for (const privateKey of ['source', 'checksum', 'committedLeaseId', 'generation', 'stateChecksum', 'filesChecksum', 'observations']) {
      expect(Object.hasOwn(outward, privateKey)).toBe(false)
      expect(serialized).not.toContain('"' + privateKey + '"')
    }
    rejects(() => core.parseReconcilePublicOperation(internal))
    rejects(() => projectPublic({ ...internal, receipt: { ...receipt(), source: { ...source(), revision: 8 } } }))
  })

  it('rejects private global fields and raw service details in outward data instead of silently forwarding them', () => {
    const outward = projectPublic(appliedOperation())
    for (const key of ['source', 'committedLeaseId', 'checksum', 'generation', 'principalId', 'requestFingerprint']) {
      rejects(() => core.parseReconcilePublicOperation({ ...outward, [key]: 'private-fixture-value' }))
    }
    rejects(() => core.parseReconcilePublicOperation({ ...outward, receipt: { ...outward.receipt, filesChecksum: 'b'.repeat(64) } }))
    for (const service of [
      { name: 'nginx.service', probe: 'protocol', result: 'passed', observedAt },
      { name: 'http', probe: 'protocol', result: 'passed', observedAt, stderr: 'private-fixture-value' },
      { name: 'http', probe: 'protocol', result: 'passed', observedAt, path: '/etc/nginx' },
    ]) rejects(() => core.parseReconcilePublicOperation({ ...outward, receipt: { ...outward.receipt, services: [service] } }))
  })

  it.each(['principalId', 'accountId', 'requestKey', 'requestFingerprint', 'logPath', 'password', 'error', 'detail'])('refuses private field %s instead of leaking it through a DTO', key => {
    rejects(() => projectPublic({ ...publicOperation(), [key]: 'private-fixture-value' }))
  })

  it('cannot turn pending or unknown evidence into applied, target verification or complete hosting success', () => {
    const values = [
      { ...publicOperation(), status: 'applied', phase: 'settled' },
      { ...appliedOperation(), targetVerified: true },
      { ...appliedOperation(), verificationRequired: false },
      { ...publicOperation(), receipt: receipt() },
      { ...publicOperation(), status: 'needs_attention', phase: 'attention', needsAttention: false, reason: 'effect_outcome_unknown' },
      { ...publicOperation(), status: 'running', phase: 'queued' },
      { ...publicOperation(), status: 'cancelling', phase: 'activate', cancelRequested: false },
      { ...publicOperation(), status: 'succeeded' },
    ]
    for (const value of values) rejects(() => projectPublic(value))
  })

  it('requires exact source/generation binding plus configuration and protocol observation shapes', () => {
    const base = receipt()
    const badReceipts = [
      { ...base, source: { ...source(), revision: 8 } },
      { ...base, source: { ...source(), committedLeaseId: ids.owner } },
      { ...base, generation: { ...base.generation, stateChecksum: 'c'.repeat(64) } },
      { ...base, generation: { ...base.generation, id: 0 } },
      { ...base, generation: { ...base.generation, status: 'pending' } },
      { ...base, observations: [] },
      { ...base, observations: [base.observations[0]] },
      { ...base, observations: [base.observations[1]] },
      { ...base, observations: [base.observations[0], base.observations[1], base.observations[1]] },
      { ...base, observations: [{ ...base.observations[0], checksum: 'c'.repeat(64) }, base.observations[1]] },
      { ...base, observations: [base.observations[0], { ...base.observations[1], probe: 'fake' }] },
      { ...base, observations: [base.observations[0], { ...base.observations[1], result: 'failed' }] },
      { ...base, observations: [base.observations[0], { ...base.observations[1], observedAt: '2026-10-23T00:11:00.000Z' }] },
      { ...base, observations: Array(33).fill(base.observations[1]) },
      { ...base, stdout: 'private executor output' },
    ]
    for (const value of badReceipts) rejects(() => projectPublic({ ...appliedOperation(), receipt: value }))
    expect(projectPublic({ ...appliedOperation(), status: 'unchanged', receipt: { ...base, outcome: 'unchanged' } }).status).toBe('unchanged')
    rejects(() => projectPublic({ ...appliedOperation(), status: 'unchanged' }))
  })

  it('requires bounded public reason codes and terminal phase consistency', () => {
    expect(projectPublic({ ...publicOperation(), status: 'failed', phase: 'settled', reason: 'configuration_test_failed' }).status).toBe('failed')
    rejects(() => projectPublic({ ...publicOperation(), status: 'failed', phase: 'settled', reason: 'password=private-fixture-value' }))
    rejects(() => projectPublic({ ...publicOperation(), status: 'cancelled', phase: 'running', reason: 'cancelled_before_effect' }))
    rejects(() => projectPublic({ ...publicOperation(), status: 'failed', phase: 'settled', reason: null }))
  })
})
