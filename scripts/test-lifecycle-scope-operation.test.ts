import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'

// Exercises the actual private capture statements in isolation. No factory/native authority is mocked
// into readiness, and no installed process, prepared capability, coordinator or filesystem is accessed.
const source = readFileSync(new URL('./lifecycle-root-safety.mjs', import.meta.url), 'utf8')
const factoryStart = source.indexOf('export async function createNativeUpgradeSafety(options)')
const captureEnd = source.indexOf('\n  let activeScope', factoryStart)
assert(factoryStart >= 0 && captureEnd > factoryStart)
const factory = source.slice(factoryStart, captureEnd)
const operationCapture = factory.split('\n').find(line => line.trim().startsWith('const db = options.db, operation = options.operation'))
const registration = factory.split('\n').find(line => line.trim().startsWith('factories.set(factory,'))
assert(operationCapture && registration)
const capture = new Function('options', 'mutate', 'factories', 'factory', 'origin', 'principal', 'processPin', 'receipt', 'trust', 'recovery',
  operationCapture + '\n' + registration + '\nmutate(); return factories.get(factory)')

describe('immutable operation captured for a native factory configuration; no admission proof', () => {
  it.each(['upgrade', 'recover', 'rollback', 'uninstall', 'adopt'] as const)('retains %s independently of later caller option mutation', operation => {
    const options = { db: null, operation }, records = new WeakMap(), token = Object.freeze({})
    const configured = capture(options, () => { Object.assign(options, { operation: 'different' }) }, records, token,
      null, null, null, null, null, null)
    assert.equal(configured.operation, operation)
    assert.equal(configured.options.operation, 'different')
    assert.equal(records.get(token), configured)
    assert.equal(records.get(Object.freeze({})), undefined)
  })
})

// Actual non-secret projection only. Native process/trust admission has its own required native checks.
const identityStart = source.indexOf('export async function readNativeReleaseTrustIdentity()')
const identityEnd = source.indexOf('\nexport ', identityStart + 1)
assert(identityStart >= 0 && identityEnd > identityStart)
const identityBody = source.slice(identityStart, identityEnd).replace('export async function', 'async function')
describe('archive trust identity projection', () => {
  it('returns the HMAC identity fields and excludes key material', async () => {
    const trust = { keyId: 'archive-test', signingKeyPath: '/etc/xpanel/archive-test.key', key: Buffer.alloc(32, 7), publisherKeyId: 'publisher-distinct' }
    const project = new Function('processIdentity', 'trustConfiguration', identityBody + '\nreturn readNativeReleaseTrustIdentity')(
      async () => {}, async () => trust,
    )
    const result = await project()
    assert.deepEqual(result, { keyId: 'archive-test', signingKeyPath: '/etc/xpanel/archive-test.key' })
    assert(Object.isFrozen(result)); assert.equal(Object.keys(result).length, 2)
  })
})
