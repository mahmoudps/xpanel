import { describe, expect, it, vi } from 'vitest'
describe('shared coordinator request serialization, without granting native authority', () => {
  it('keeps agent and operator requests excluded until a background operation settles', async () => {
    vi.resetModules()
    const gate = await import('./ops-upgrade-coordinator-gate.ts')
    const claim = gate.claimCoordinatorRequest()
    let finish!: () => void
    const operation = new Promise<void>(resolve => { finish = resolve })
    claim.retainUntil(operation); claim.release()
    expect(() => gate.claimCoordinatorRequest()).toThrow()
    expect(() => gate.claimCoordinatorRequest('recovery')).toThrow()
    finish(); await operation; await Promise.resolve()
    expect(gate.coordinatorRequestActive()).toBe(false)
    gate.claimCoordinatorRequest().release()
  })
  it('requires the separate recovery scheduling path after an uncertain result', async () => {
    vi.resetModules()
    const gate = await import('./ops-upgrade-coordinator-gate.ts')
    const failed = gate.claimCoordinatorRequest(); failed.attention(); failed.release()
    expect(() => gate.claimCoordinatorRequest()).toThrow()
    const recovery = gate.claimCoordinatorRequest('recovery')
    recovery.recovered(); recovery.release()
    gate.claimCoordinatorRequest().release()
  })
  it('publishes rejection attention before a sibling settlement reaction can claim the released slot', async () => {
    vi.resetModules()
    const gate = await import('./ops-upgrade-coordinator-gate.ts')
    let reject!: (error: Error) => void
    const pending = new Promise<void>((_resolve, fail) => { reject = fail })
    const retained = gate.claimCoordinatorRequest()
    retained.retainUntil(pending); retained.release()
    // Registered after retainUntil: on the old finally().catch() chain this
    // reaction ran after release but before attention was recorded.
    const sibling = pending.catch(() => {
      expect(gate.coordinatorRequestActive()).toBe(false)
      expect(() => gate.claimCoordinatorRequest()).toThrow()
      const recovery = gate.claimCoordinatorRequest('recovery')
      recovery.recovered(); recovery.release()
    })
    reject(new Error('controlled operation rejection'))
    await sibling
    gate.claimCoordinatorRequest().release()
  })
})
