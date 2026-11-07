import { fail } from '@xpanel/core'

const HOUR_MS = 3_600_000

/** Webmail sends per mailbox in the last hour. shortcut: counted in this process, so a restart forgets; one API process sends. */
export function createMailboxSendLimiter(now: () => number = Date.now) {
  const sends = new Map<string, number[]>()
  return {
    /** Counts this send when it fits; a refused send never reaches the mail server. */
    assertAvailable(mailbox: string, limit: number): void {
      const at = now(), recent = (sends.get(mailbox) ?? []).filter(time => at - time < HOUR_MS)
      if (recent.length >= limit) return fail('LIMIT_EXCEEDED', 'this mailbox has reached its hourly send limit', { stateChanged: false, limit })
      sends.set(mailbox, [...recent, at])
    },
  }
}
