import { describe, expect, it } from 'vitest'
import { currentRootOperatorBinding, parseRootOperatorRequest } from './root-operator.mjs'

const request = () => ({ operationId: '12345678-1234-1234-1234-123456789abc', kind: 'upgrade', expectedArchiveSha256: 'a'.repeat(64) })
describe('distinct root operator request syntax; no peer or native acceptance claim', () => {
  it('accepts only a bounded command identity and never request authority', () => {
    expect(parseRootOperatorRequest(request())).toEqual(request())
    expect(Object.isFrozen(parseRootOperatorRequest({ ...request(), kind: 'recover' }))).toBe(true)
  })
  it.each(['actor', 'principalId', 'artifactPath', 'signingKeyPath', 'provider', 'ready', 'force', 'root'])('rejects supplied %s authority', key => {
    expect(() => parseRootOperatorRequest({ ...request(), [key]: true })).toThrow('ROOT_OPERATOR_REQUEST_INVALID')
  })
  it.each([null, {}, { ...request(), kind: 'uninstall' }, { ...request(), expectedArchiveSha256: Object('a'.repeat(64)) }, { ...request(), operationId: '../other' }])('rejects malformed identity', value => {
    expect(() => parseRootOperatorRequest(value)).toThrow('ROOT_OPERATOR_REQUEST_INVALID')
  })
  it('does not invoke accessors or expose a binding outside the live native scope', async () => {
    const value = request(); let touched = false
    Object.defineProperty(value, 'kind', { enumerable: true, get() { touched = true; return 'upgrade' } })
    expect(() => parseRootOperatorRequest(value)).toThrow('ROOT_OPERATOR_REQUEST_INVALID')
    expect(touched).toBe(false)
    expect(await currentRootOperatorBinding()).toBeNull()
  })
})
