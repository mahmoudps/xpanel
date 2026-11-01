import { describe, expect, it } from 'vitest'
import { accountCreateOperation, accountCreationAcknowledgement } from './account-create-operation.ts'
import { completedAccountCreationReplayFixture, reobservedAccountCreationFixture, verifiedAccountCreationFixture } from './account-create-fixture.test-helper.ts'

const storage = () => {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
const submitted = { username: 'alpha', primaryDomain: 'alpha.example.test', planId: '10000000-0000-4000-8000-000000000001', ownerId: null, shell: 'jailed' }
const result = verifiedAccountCreationFixture
const account = result().account

describe('account creation technical retry identity', () => {
  it('retains exactly the same key across identical retries and a new client instance', () => {
    const store = storage(), operation = accountCreateOperation(store, 'root:operator')
    const key = operation.begin('alpha')
    expect(key).toMatch(/^account-create:[0-9a-f]{32}$/)
    expect(operation.begin('alpha')).toBe(key)
    expect(accountCreateOperation(store, 'root:operator').begin('alpha')).toBe(key)
    expect(Object.keys(JSON.parse([...store.values.values()][0]!)).sort()).toEqual(['key', 'phase', 'username', 'version'])
  })
  it('keeps an unknown outcome bound and refuses changing its identity or discarding it', () => {
    const store = storage(), operation = accountCreateOperation(store, 'root:operator')
    const key = operation.begin('alpha')
    expect(() => operation.begin('beta')).toThrow('requires_review')
    expect(() => operation.discard()).toThrow('requires_review')
    expect(operation.read()).toMatchObject({ key, username: 'alpha', phase: 'pending' })
  })
  it('permits a corrected identity only after a verified no-effect result, and a new operation after completion', () => {
    const store = storage(), operation = accountCreateOperation(store, 'root:operator')
    const original = operation.begin('alpha'); operation.mark('no-effects')
    expect(operation.begin('alpha')).toBe(original)
    operation.mark('no-effects')
    const corrected = operation.begin('beta'); expect(corrected).not.toBe(original)
    operation.mark('complete'); operation.discard(); expect(operation.read()).toBeNull()
    expect(operation.begin('beta')).not.toBe(corrected)
  })
  it('separates authenticated public actors and never adopts malformed persisted records', () => {
    const store = storage(), first = accountCreateOperation(store, 'root:operator')
    first.begin('alpha')
    expect(accountCreateOperation(store, 'reseller:other').read()).toBeNull()
    const key = [...store.values.keys()][0]!
    store.values.set(key, JSON.stringify({ ...first.read(), password: 'must-not-be-adopted' }))
    expect(() => first.begin('alpha')).toThrow('invalid_account_request_record')
    expect(() => accountCreateOperation(store, 'user:alpha')).toThrow('actor_unavailable')
  })
  it('fails before returning a key if storage cannot retain the exact record', () => {
    const operation = accountCreateOperation({ getItem: () => null, setItem: () => {}, removeItem: () => {} }, 'root:operator')
    expect(() => operation.begin('alpha')).toThrow('not_retained')
  })
})

describe('public native creation acknowledgement', () => {
  it('distinguishes fresh effects, current independent reobservation and completed history', () => {
    expect(accountCreationAcknowledgement(result(), submitted)).toBe('verified')
    expect(accountCreationAcknowledgement(reobservedAccountCreationFixture(), submitted)).toBe('verified')
    expect(accountCreationAcknowledgement(completedAccountCreationReplayFixture(), submitted)).toBe('replay')
  })
  it.each([0, 1, 2])('accepts a fully bound fresh effect resumed from public phase %s', resumedFromStep => {
    const value = result(); value.operation.resumedFromStep = resumedFromStep
    expect(accountCreationAcknowledgement(value, submitted)).toBe('verified')
  })
  it('rejects the legacy configuration-only acknowledgement', () => {
    expect(accountCreationAcknowledgement({ account, reconcile: { status: 'applied' }, execution: { status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } }, submitted)).toBeUndefined()
  })
  it.each(['account', 'uid', 'generation', 'source', 'quota', 'dns', 'php', 'owner', 'shell', 'operation', 'extra', 'nested-extra', 'contradictory-replay', 'missing-completed-replay', 'unknown-operation', 'completed-fresh'] as const)('rejects mismatched or missing %s evidence', fault => {
    const value = structuredClone(result())
    if (fault === 'account') Object.assign(value.execution.observation, { accountId: '20000000-0000-4000-8000-000000000003' })
    if (fault === 'uid') Object.assign(value.execution.observation, { uid: value.execution.observation.uid + 1 })
    if (fault === 'generation') value.reconcile.generation.id++
    if (fault === 'source') Object.assign(value.execution.observation, { sourceChecksum: '' })
    if (fault === 'quota') Object.assign(value.execution.observation.quota, { enforced: false })
    if (fault === 'dns') Object.assign(value.execution.observation.dns, { authoritative: false })
    if (fault === 'php') Object.assign(value.execution.observation.php, { cgroup: '/foreign' })
    if (fault === 'owner') Object.assign(value.account, { ownerId: 'foreign' })
    if (fault === 'shell') value.account.shell = 'none'
    if (fault === 'operation') Object.assign(value.operation, { status: 'running' })
    if (fault === 'extra') Object.assign(value.execution.observation, { unreviewed: true })
    if (fault === 'nested-extra') Object.assign(value.execution.observation.php, { unreviewed: true })
    if (fault === 'contradictory-replay') Object.assign(value.execution, { replay: true })
    if (fault === 'missing-completed-replay') Reflect.deleteProperty(value.operation, 'completedReplay')
    if (fault === 'unknown-operation') Object.assign(value.operation, { unreviewed: true })
    if (fault === 'completed-fresh') value.operation.completedReplay = true
    expect(accountCreationAcknowledgement(value, submitted)).toBeUndefined()
  })
  it.each([-1, 0.5, 3, 4, 5, Infinity])('rejects a fresh effect at an impossible public phase %s', resumedFromStep => {
    const value = result(); value.operation.resumedFromStep = resumedFromStep
    expect(accountCreationAcknowledgement(value, submitted)).toBeUndefined()
  })
  it.each([
    ['reobservation before the host phase', () => { const value = reobservedAccountCreationFixture(); value.operation.resumedFromStep = 2; return value }],
    ['reobservation at the completed phase', () => { const value = reobservedAccountCreationFixture(); value.operation.resumedFromStep = 4; return value }],
    ['reobservation marked as fresh', () => { const value = reobservedAccountCreationFixture(); value.operation.freshExecution = true; return value }],
    ['reobservation marked as historical', () => { const value = reobservedAccountCreationFixture(); value.operation.completedReplay = true; return value }],
    ['reobservation carrying an application', () => { const value = reobservedAccountCreationFixture(); return { ...value, reconcile: result().reconcile } }],
    ['reobservation without current proof', () => { const value = reobservedAccountCreationFixture(); return { ...value, execution: { ...value.execution, observation: undefined } } }],
    ['history before terminal completion', () => { const value = completedAccountCreationReplayFixture(); value.operation.resumedFromStep = 3; return value }],
    ['history marked as current', () => { const value = completedAccountCreationReplayFixture(); value.operation.completedReplay = false; return value }],
    ['history marked as fresh', () => { const value = completedAccountCreationReplayFixture(); value.operation.freshExecution = true; return value }],
    ['history carrying an application', () => { const value = completedAccountCreationReplayFixture(); return { ...value, reconcile: result().reconcile } }],
    ['history with a foreign UID', () => { const value = completedAccountCreationReplayFixture(); Object.assign(value.execution.lastVerifiedObservation, { uid: value.account.uid + 1 }); return value }],
    ['history claiming current verification', () => { const value = completedAccountCreationReplayFixture(); return { ...value, execution: { ...value.execution, targetVerified: true, verificationRequired: false } } }],
  ] as const)('rejects contradictory %s', (_name, response) => {
    expect(accountCreationAcknowledgement(response(), submitted)).toBeUndefined()
  })
})
