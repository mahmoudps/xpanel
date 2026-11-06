import { afterEach, describe, expect, it, vi } from 'vitest'
import { COORDINATOR_STARTUP_ATTEMPTS, verifyCoordinatorStartup } from './ops-upgrade-native.ts'

// Pure retry policy of the coordinator startup verification; no archive, socket or systemd is used.
const ancestryChanged = () => Object.assign(new Error('Archive callback failed or verified lifetime changed; staging must remain unpublished'),
  { code: 'ARCHIVE_USE_UNCERTAIN', cause: Object.assign(new Error('Protected ancestry changed'), { code: 'FILE_CHANGED' }) })
afterEach(() => vi.restoreAllMocks())

describe('coordinator startup verification', () => {
  it('verifies again from scratch after an ancestor of the helper archive changed, then starts', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const sleep = vi.fn(async (_ms: number) => undefined)
    const verify = vi.fn().mockRejectedValueOnce(ancestryChanged()).mockResolvedValueOnce('verified')
    await expect(verifyCoordinatorStartup(verify, sleep)).resolves.toBe('verified')
    expect(verify).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(1000)
  })

  it('fails closed after the bounded attempts', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const sleep = vi.fn(async (_ms: number) => undefined), verify = vi.fn(async () => { throw ancestryChanged() })
    await expect(verifyCoordinatorStartup(verify, sleep)).rejects.toMatchObject({ code: 'ARCHIVE_USE_UNCERTAIN' })
    expect(verify).toHaveBeenCalledTimes(COORDINATOR_STARTUP_ATTEMPTS)
    expect(sleep.mock.calls.map(call => call[0])).toEqual([1000, 2000])
    expect(stderr).toHaveBeenCalledTimes(COORDINATOR_STARTUP_ATTEMPTS - 1)
  })

  it('never retries another refusal such as a digest mismatch', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined)
    const verify = vi.fn(async () => { throw Object.assign(new Error('External archive digest does not match'), { code: 'ARCHIVE_CHECKSUM_MISMATCH' }) })
    await expect(verifyCoordinatorStartup(verify, sleep)).rejects.toMatchObject({ code: 'ARCHIVE_CHECKSUM_MISMATCH' })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
