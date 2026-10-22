import type { Id, LiveEvent } from '../types.ts'

export type LiveEventSubscriber =
  | { kind: 'root'; id?: Id; username?: string }
  | { kind: 'reseller'; id: Id; username?: string }
  | { kind: 'user'; id?: Id; username?: string; accountId: Id }
  | { kind: 'service'; id?: Id; login: string }

/**
 * Enforces RBAC isolation on real-time WebSocket events across xWHM, xPanel, and xMail:
 * - `root` receives every event.
 * - `reseller` receives events scoped to their reseller ID or to an account they own.
 * - `user` receives events scoped to their own `accountId`.
 * - `service` (xMail mailbox user) receives events scoped to their own `mailboxLogin`.
 */
export const canReceiveLiveEvent = (
  principal: LiveEventSubscriber,
  event: LiveEvent,
  ownedAccountIds: ReadonlySet<Id> = new Set(),
): boolean => {
  if (principal.kind === 'root') return true
  const { scope } = event
  if (principal.kind === 'reseller') {
    if (scope.resellerId && scope.resellerId === principal.id) return true
    if (scope.accountId && ownedAccountIds.has(scope.accountId)) return true
    return false
  }
  if (principal.kind === 'user') {
    return Boolean(scope.accountId && scope.accountId === principal.accountId)
  }
  if (principal.kind === 'service') {
    return Boolean(scope.mailboxLogin && scope.mailboxLogin.toLowerCase() === principal.login.toLowerCase())
  }
  return false
}
