import type { Id, LiveEvent } from '../types.ts'

export type LiveEventSubscriber =
  | { kind: 'root'; id?: Id; username?: string }
  | { kind: 'reseller'; id: Id; username?: string }
  | { kind: 'user'; id?: Id; username?: string; accountId: Id; mailboxLogin?: string }
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
  const { scope } = event
  if (!scope || typeof scope !== 'object') return false
  const mailboxEvent = event.kind === 'mail.received' || event.kind === 'mail.flags' || event.kind === 'mail.changed'
  if (mailboxEvent && (typeof scope.accountId !== 'string' || scope.accountId.length === 0 || typeof scope.mailboxLogin !== 'string' || scope.mailboxLogin.length === 0)) return false
  if ((event.kind === 'mail.changed' || event.kind === 'mail.flags') && (!event.data || typeof event.data !== 'object' || Array.isArray(event.data))) return false
  if (event.kind === 'mail.changed' && (event.data.folder !== 'INBOX' || Object.keys(event.data).some(key => key !== 'folder'))) return false
  if (event.kind === 'mail.flags' && (event.data.folder !== 'INBOX'
    || Object.keys(event.data).some(key => !['mailbox', 'folder', 'uid', 'flags'].includes(key))
    || typeof event.data.mailbox !== 'string' || event.data.mailbox.toLowerCase() !== scope.mailboxLogin?.toLowerCase()
    || !Number.isInteger(event.data.uid) || event.data.uid < 1 || event.data.uid > 0xffffffff
    || !Array.isArray(event.data.flags) || event.data.flags.length > 128
    || event.data.flags.some(flag => typeof flag !== 'string' || flag.length > 128 || /[\r\n\u0000]/.test(flag)))) return false
  if (principal.kind === 'root') return true
  if (principal.kind === 'reseller') {
    if (mailboxEvent || scope.mailboxLogin) return false
    if (scope.resellerId && scope.resellerId === principal.id) return true
    if (scope.accountId && ownedAccountIds.has(scope.accountId)) return true
    return false
  }
  if (principal.kind === 'user') {
    if (!scope.accountId || scope.accountId !== principal.accountId) return false
    if (mailboxEvent || scope.mailboxLogin || principal.mailboxLogin) {
      return Boolean(principal.mailboxLogin && scope.mailboxLogin && principal.mailboxLogin.toLowerCase() === scope.mailboxLogin.toLowerCase())
    }
    return true
  }
  if (principal.kind === 'service') {
    return Boolean(scope.mailboxLogin && scope.mailboxLogin.toLowerCase() === principal.login.toLowerCase())
  }
  return false
}
