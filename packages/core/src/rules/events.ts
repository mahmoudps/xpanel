import type { Id, LiveEvent } from '../types.ts'

export type LiveEventSubscriber =
  | { kind: 'root'; id?: Id; username?: string }
  | { kind: 'reseller'; id: Id; username?: string }
  | { kind: 'user'; id?: Id; username?: string; accountId: Id; mailboxLogin?: string }
  | { kind: 'service'; id?: Id; login: string }

const MAILBOX_EVENT = new Set(['mail.received', 'mail.flags'])

/**
 * Enforces RBAC isolation on real-time WebSocket events across xWHM, xPanel, and xMail:
 * - `root` receives every event.
 * - `reseller` receives events scoped to their reseller ID or to an account they own.
 *   `mail.received` and `mail.flags` are not included: those stay with the mailbox subscriber.
 * - `user` receives events scoped to their own `accountId`. Mailbox events require
 *   `mailboxLogin` to match. An account session with no mailbox login does not receive them.
 * - `service` (xMail mailbox user) receives events scoped to their own mailbox login.
 */
export const canReceiveLiveEvent = (
  principal: LiveEventSubscriber,
  event: LiveEvent,
  ownedAccountIds: ReadonlySet<Id> = new Set(),
): boolean => {
  if (principal.kind === 'root') return true
  const { scope } = event
  const mailboxEvent = MAILBOX_EVENT.has(event.kind)
  if (principal.kind === 'reseller') {
    if (mailboxEvent) return false
    if (scope.resellerId && scope.resellerId === principal.id) return true
    if (scope.accountId && ownedAccountIds.has(scope.accountId)) return true
    return false
  }
  if (principal.kind === 'user') {
    if (!scope.accountId || scope.accountId !== principal.accountId) return false
    if (mailboxEvent) {
      return Boolean(
        principal.mailboxLogin
        && scope.mailboxLogin
        && scope.mailboxLogin.toLowerCase() === principal.mailboxLogin.toLowerCase(),
      )
    }
    if (principal.mailboxLogin && scope.mailboxLogin) {
      return scope.mailboxLogin.toLowerCase() === principal.mailboxLogin.toLowerCase()
    }
    return true
  }
  if (principal.kind === 'service') {
    return Boolean(scope.mailboxLogin && scope.mailboxLogin.toLowerCase() === principal.login.toLowerCase())
  }
  return false
}
