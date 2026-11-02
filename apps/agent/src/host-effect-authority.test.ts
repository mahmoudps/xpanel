import { describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { FakeHostExecutor } from './executor.ts'
import { authorizedHostEffect, withHostEffectAuthority } from './host-effect-authority.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const guard = (allowed: () => boolean) => ({ signal: new AbortController().signal,
  async assertAuthority() { if (!allowed()) fail('FORBIDDEN', 'revoked') },
})

describe('operation-scoped native effect authority', () => {
  it('refuses a revoked operation before its first effect and preserves normal work', async () => {
    const executor = new FakeHostExecutor()
    let writes = 0
    await expect(withHostEffectAuthority(executor, guard(() => false), async () => {
      await authorizedHostEffect(executor, async () => { writes++ })
    })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(writes).toBe(0)
    await authorizedHostEffect(executor, async () => { writes++ })
    expect(writes).toBe(1)
  })

  it('does not pretend an in-flight completed effect was undone after revocation', async () => {
    const executor = new FakeHostExecutor()
    let allowed = true, writes = 0
    await expect(withHostEffectAuthority(executor, guard(() => allowed), async () => {
      await authorizedHostEffect(executor, async () => { writes++; allowed = false })
      await authorizedHostEffect(executor, async () => { writes++ })
    })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: true, verificationRequired: true } })
    expect(writes).toBe(1)
  })

  it('isolates concurrent operations and unrelated normal calls on the same executor', async () => {
    const executor = new FakeHostExecutor(), gate = deferred(), aReady = deferred(), bReady = deferred()
    const writes: string[] = []
    let aAllowed = true
    const a = withHostEffectAuthority(executor, guard(() => aAllowed), async () => {
      aReady.resolve(); await gate.promise
      await authorizedHostEffect(executor, async () => { writes.push('a') })
    })
    const b = withHostEffectAuthority(executor, guard(() => true), async () => {
      bReady.resolve(); await gate.promise
      await authorizedHostEffect(executor, async () => { writes.push('b') })
    })
    await Promise.all([aReady.promise, bReady.promise])
    aAllowed = false
    await authorizedHostEffect(executor, async () => { writes.push('normal') })
    gate.resolve()
    const results = await Promise.allSettled([a, b])
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled'])
    expect(writes).toEqual(['normal', 'b'])
  })

  it('does not grant its authority to another executor instance', async () => {
    const executor = new FakeHostExecutor(), other = new FakeHostExecutor()
    let allowed = true, writes = 0
    await expect(withHostEffectAuthority(executor, guard(() => allowed), async () => {
      allowed = false
      await authorizedHostEffect(other, async () => { writes++ })
    })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(writes).toBe(1)
  })

  it('drains an already-started primitive before retiring its authority', async () => {
    const executor = new FakeHostExecutor(), started = deferred(), release = deferred()
    let completed = false, returned = false
    const run = withHostEffectAuthority(executor, guard(() => true), async () => {
      void authorizedHostEffect(executor, async () => { started.resolve(); await release.promise; completed = true })
    }).then(() => { returned = true })
    await started.promise
    expect(returned).toBe(false)
    release.resolve()
    await run
    expect(completed).toBe(true)
    expect(returned).toBe(true)
  })

  it('denies delayed callbacks after the request context has retired', async () => {
    const executor = new FakeHostExecutor(), later = deferred()
    let writes = 0, child!: Promise<void>
    await withHostEffectAuthority(executor, guard(() => true), async () => {
      child = later.promise.then(() => authorizedHostEffect(executor, async () => { writes++ }))
    })
    const checked = expect(child).rejects.toMatchObject({ detail: { stateChanged: false } })
    later.resolve()
    await checked
    expect(writes).toBe(0)
  })

  it('cannot swallow lost authority and acknowledge a successful operation', async () => {
    const executor = new FakeHostExecutor()
    let allowed = true
    await expect(withHostEffectAuthority(executor, guard(() => allowed), async () => {
      try { await authorizedHostEffect(executor, async () => { allowed = false }) } catch { /* caller attempts to ignore loss */ }
      return 'success'
    })).rejects.toMatchObject({ detail: { stateChanged: true, verificationRequired: true } })
  })

  it('enforces read-only native reobservation independently of a current lease', async () => {
    const executor = new FakeHostExecutor()
    let writes = 0
    await expect(withHostEffectAuthority(executor, { ...guard(() => true), readOnly: true }, async () => {
      await authorizedHostEffect(executor, async () => { writes++ })
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(writes).toBe(0)
  })
})
