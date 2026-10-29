// Autoresponders for addresses without a mailbox (a forwarder, or an address that only replies).
// Mail for the address is also delivered to a hidden user of the same account: a passwd-file
// entry with nologin, under a per-account domain in .invalid that smtpd refuses from outside.
// Its Sieve script answers with vacation (once per sender within the interval, never to lists,
// bounces or other autoresponders) and then discards the copy, so nothing is stored.
import { createHash } from 'node:crypto'

export const AUTOREPLY_DOMAIN_SUFFIX = 'autoreply.xpanel.invalid'
/** passdb nologin refuses every login of a hidden user; no password is known for this well-formed hash */
export const LOCKED_MAILBOX_HASH = `{BLF-CRYPT}$2y$10$${'.'.repeat(53)}`

const digest = (value: string, length: number): string => createHash('sha256').update(value).digest('hex').slice(0, length)

/** The hidden delivery domain of one account. */
export const autoreplyDomain = (accountId: string): string => `a${digest(accountId, 16)}.${AUTOREPLY_DOMAIN_SUFFIX}`

/** The hidden user that answers for one address of an account. */
export const autoreplyAddress = (accountId: string, address: string): string =>
  `r${digest(address.toLowerCase(), 20)}@${autoreplyDomain(accountId)}`

// .invalid is never hostable (core naming rules), so no tenant domain or address can take these shapes
export const AUTOREPLY_DOMAIN_RE = /^a[0-9a-f]{16}\.autoreply\.xpanel\.invalid$/
export const AUTOREPLY_ADDRESS_RE = /^r[0-9a-f]{20}@a[0-9a-f]{16}\.autoreply\.xpanel\.invalid$/
