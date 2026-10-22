// Suspension is one flag on the account. Everything the reconciler must switch is derived
// from it here, so no subsystem can be forgotten or carry a flag of its own.
import type { Account, Domain } from '../types.ts'
import { invalid, isInt, isRecord } from './check.ts'

export type LoginSubsystem = 'panel-login' | 'shell-login' | 'ftp-login' | 'webdisk-login' | 'mail-login' | 'database-login'

export type SuspensionEffect =
  | { subsystem: LoginSubsystem; state: 'allowed' | 'denied' }
  | { subsystem: 'cron'; state: 'enabled' | 'disabled' }
  | { subsystem: 'slice'; unit: string; state: 'running' | 'stopped' }
  | { subsystem: 'vhost'; state: 'serving' | 'suspended-page' }
  /** suspended mailboxes keep receiving; a terminating account defers so senders retry */
  | { subsystem: 'mail-delivery'; state: 'accept' | 'defer' }

export type Subsystem = SuspensionEffect['subsystem']

export const LOGIN_SUBSYSTEMS: readonly LoginSubsystem[] = [
  'panel-login', 'shell-login', 'ftp-login', 'webdisk-login', 'mail-login', 'database-login',
]

/**
 * login.defs UID_MIN..UID_MAX on Debian and RHEL. Above it sit systemd's reserved ranges
 * (homed, dynamic users, containers), nobody (65534, which OpenLiteSpeed runs as) and the
 * 16-bit -1 (65535); an account there would share an identity with a system process.
 */
export const MIN_ACCOUNT_UID = 1000
export const MAX_ACCOUNT_UID = 60_000

/** systemd slice holding every long-running process of the account. */
export const sliceUnit = (uid: number): string => {
  if (!isInt(uid, MIN_ACCOUNT_UID, MAX_ACCOUNT_UID)) return invalid(`account uid must be an integer between ${MIN_ACCOUNT_UID} and ${MAX_ACCOUNT_UID}`, { uid })
  return `xpanel-${uid}.slice`
}

export const isSuspended = (account: Pick<Account, 'status'>): boolean => account.status !== 'active'

/**
 * Desired state of every subsystem for this account, in the order the reconciler should
 * apply it: suspending cuts access first and stops processes before swapping the vhost;
 * reactivating starts processes before the site and logins come back.
 */
export const suspensionEffects = (account: Pick<Account, 'status' | 'uid'>): SuspensionEffect[] => {
  if (!isRecord(account)) return invalid('account must be an object')
  const unit = sliceUnit(account.uid)
  if (account.status !== 'active' && account.status !== 'suspended' && account.status !== 'terminating') {
    return invalid('unknown account status', { status: account.status })
  }
  if (account.status === 'active') {
    return [
      { subsystem: 'mail-delivery', state: 'accept' },
      { subsystem: 'slice', unit, state: 'running' },
      { subsystem: 'vhost', state: 'serving' },
      { subsystem: 'cron', state: 'enabled' },
      ...LOGIN_SUBSYSTEMS.map((subsystem) => ({ subsystem, state: 'allowed' as const })),
    ]
  }
  return [
    ...LOGIN_SUBSYSTEMS.map((subsystem) => ({ subsystem, state: 'denied' as const })),
    { subsystem: 'cron', state: 'disabled' },
    { subsystem: 'slice', unit, state: 'stopped' },
    { subsystem: 'vhost', state: 'suspended-page' },
    { subsystem: 'mail-delivery', state: account.status === 'terminating' ? 'defer' : 'accept' },
  ]
}

export type DomainServingState = 'serving' | 'suspended' | 'expired'

/** Per-domain view: the account flag wins, then the domain's own stop, then its expiry. */
export const domainServingState = (
  account: Pick<Account, 'status'>,
  domain: Pick<Domain, 'suspended' | 'expiresAt'>,
  now: Date = new Date(),
): DomainServingState => {
  if (isSuspended(account) || domain.suspended) return 'suspended'
  if (domain.expiresAt !== null) {
    const at = Date.parse(domain.expiresAt)
    // an unparsable expiry fails closed
    if (Number.isNaN(at) || at <= now.getTime()) return 'expired'
  }
  return 'serving'
}
