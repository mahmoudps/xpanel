import { describe, expect, it } from 'vitest'
import { createMailboxSendLimiter } from './send-limit.ts'

describe('mailbox hourly send limit', () => {
  it('refuses the send above the limit per mailbox and frees it after an hour', () => {
    let at = 0
    const limiter = createMailboxSendLimiter(() => at)
    limiter.assertAvailable('a@example.test', 2); limiter.assertAvailable('a@example.test', 2)
    expect(() => limiter.assertAvailable('a@example.test', 2)).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }))
    limiter.assertAvailable('b@example.test', 2)
    at = 3_600_000
    limiter.assertAvailable('a@example.test', 2)
  })
})
