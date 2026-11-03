import { describe, expect, it } from 'vitest'
import { assertNativeRootOperatorDispatchHeld, getNativeRootOperatorDispatchInfo, rootOperatorArgv } from './ops-upgrade-root-dispatch.ts'

describe('root operator dispatch capability boundary', () => {
  it('does not accept request flags, copied metadata or caller assertions as a native transport', async () => {
    let invoked = false
    const getter = Object.defineProperty({}, 'verify', { get() { invoked = true; throw new Error('untrusted getter') } })
    for (const value of [null, {}, getter, { purpose: 'root-operator-apply', request: { phase: 'apply', kind: 'recover' }, uid: 0, assertCurrent() {} }]) {
      expect(() => getNativeRootOperatorDispatchInfo(value)).toThrow()
      await expect(assertNativeRootOperatorDispatchHeld(value)).rejects.toThrow()
    }
    expect(invoked).toBe(false)
  })
  it('pins the signed helper invocation to the exact operation, kind and archive identity', () => {
    const request = { kind: 'recover' as const, operationId: '12345678-1234-4234-8234-123456789abc', expectedArchiveSha256: 'a'.repeat(64) }
    expect(rootOperatorArgv('/usr/local/bin/node', '/opt/xpanel/releases/0.2.0', request)).toEqual([
      '/usr/local/bin/node', '/opt/xpanel/releases/0.2.0/scripts/root-operator-entry.mjs', '--kind=recover',
      '--archive-sha256=' + 'a'.repeat(64), '--operation-id=' + request.operationId,
    ])
  })
})
