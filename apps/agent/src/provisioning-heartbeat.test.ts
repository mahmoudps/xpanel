import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withProvisioningHeartbeat } from './provisioning-heartbeat.ts'

const reply = (): Response => new Response(JSON.stringify({ outcome: 'known' }), { status: 200, headers: { 'content-type': 'application/json' } })
const deferred = () => {
  let resolve: (value: Response) => void = () => undefined, reject: (error: unknown) => void = () => undefined
  const promise = new Promise<Response>((ok, no) => { resolve = ok; reject = no })
  return { promise, resolve, reject }
}

describe('account provisioning keepalive', { tags: ['unit'] }, () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('returns a quick reply or refusal unchanged', async () => {
    const quick = reply()
    expect(await withProvisioningHeartbeat(Promise.resolve(quick), 10_000)).toBe(quick)
    const refusal = new Error('refused before host work')
    await expect(withProvisioningHeartbeat(Promise.reject(refusal), 10_000)).rejects.toBe(refusal)
  })

  it('keeps a slow host operation alive past the old 180 s budget and then delivers its reply', async () => {
    const work = deferred()
    const pending = withProvisioningHeartbeat(work.promise, 10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    const response = await pending
    expect(response.status).toBe(200)
    const reader = response.body!.getReader(), received: Uint8Array[] = []
    const next = async () => { const chunk = await reader.read(); if (!chunk.done) received.push(chunk.value); return chunk.done }
    expect(await next()).toBe(false)
    for (let elapsed = 0; elapsed < 200_000; elapsed += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await next()).toBe(false)
    }
    expect(received.length).toBeGreaterThan(18)
    work.resolve(reply())
    while (!await next()) { /* drain */ }
    const text = Buffer.concat(received).toString('utf8')
    expect(text.trim()).toBe('{"outcome":"known"}')
    expect(JSON.parse(text)).toEqual({ outcome: 'known' })
  })

  it('ends the stream unfinished when the operation is refused after the keepalive started', async () => {
    const work = deferred()
    const pending = withProvisioningHeartbeat(work.promise, 10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    const reader = (await pending).body!.getReader()
    expect((await reader.read()).done).toBe(false)
    work.reject(new Error('authority lapsed'))
    await expect(reader.read()).rejects.toThrow('authority lapsed')
  })
})
