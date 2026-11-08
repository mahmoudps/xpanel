import { describe, expect, it } from 'vitest'
import { currentRootOperatorBinding, parseRootOperatorRequest, rootOperatorAttentionLine } from './root-operator.mjs'

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
  it('journals the failed step and a bounded one-line reason beside the stable code', () => {
    const details = { phase: 'retirement_pending', qualified: false, step: 'rewind:units', reason: 'generation 5 requires operator attention:\nline two' }
    expect(rootOperatorAttentionLine('upgrade', { code: 'LIFECYCLE_ROLLBACK_FAILED', details }))
      .toBe('xpanel-root-operator-attention kind=upgrade code=LIFECYCLE_ROLLBACK_FAILED step=rewind:units reason="generation 5 requires operator attention: line two"\n')
    expect(rootOperatorAttentionLine('upgrade', { code: 'LIFECYCLE_ROLLBACK_FAILED', details: { ...details, reason: 'x'.repeat(900) } }))
      .toBe(`xpanel-root-operator-attention kind=upgrade code=LIFECYCLE_ROLLBACK_FAILED step=rewind:units reason="${'x'.repeat(400)}"\n`)
    expect(rootOperatorAttentionLine('recover', { code: 'bad code', details: { step: 'Rewind units', reason: 'r' } })).toBe('xpanel-root-operator-attention kind=recover code=UNSTABLE\n')
  })
  it('does not invoke accessors or expose a binding outside the live native scope', async () => {
    const value = request(); let touched = false
    Object.defineProperty(value, 'kind', { enumerable: true, get() { touched = true; return 'upgrade' } })
    expect(() => parseRootOperatorRequest(value)).toThrow('ROOT_OPERATOR_REQUEST_INVALID')
    expect(touched).toBe(false)
    expect(await currentRootOperatorBinding()).toBeNull()
  })
})
