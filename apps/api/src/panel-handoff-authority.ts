import type { Id } from '@xpanel/core'
import { getMailboxSession, getPrincipal, type Db, type PrincipalRecord, type SessionRecord } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import type { TeamMemberResolver } from './auth.ts'
import { assertAccountPlanFeatures } from './authorization.ts'
import { isMailboxPrincipalUsername } from './entry-points.ts'
import { teamToolIds } from './team-access.ts'

export interface HandoffAuthorityDeps {
  db: Db
  store: StateStore
  teamMember: TeamMemberResolver
}

export type HandoffAuthorityTarget =
  | { kind: 'account-owner'; accountId: Id; principalId: Id }
  | { kind: 'mailbox'; accountId: Id; serviceUserId: Id; mailbox: string }

/**
 * The issuer's current authority over the target, read from the database and state indexes only (no host calls).
 * Used when a link is consumed and on every request of the session it opened, so a revocation at any point wins.
 * A read failure rejects; callers decide whether that refuses (consumption) or only denies this request (session).
 */
export const handoffAuthority = async (
  deps: HandoffAuthorityDeps,
  issuer: { principalId: Id; teamMemberId?: Id },
  target: HandoffAuthorityTarget,
): Promise<'ok' | 'issuer' | 'target'> => {
  const account = await deps.store.getAccount(target.accountId)
  if (!account || account.status !== 'active') return 'target'
  const principal = await getPrincipal(deps.db, issuer.principalId)
  if (!principal || principal.disabled) return 'issuer'
  if (target.kind === 'account-owner') {
    if (principal.kind === 'reseller') {
      const reseller = await deps.store.getReseller(principal.id)
      if (!reseller || account.ownerId !== reseller.id || !reseller.acl.includes('edit-account')) return 'issuer'
    } else if (principal.kind !== 'root') return 'issuer'
    const owner = await getPrincipal(deps.db, target.principalId)
    if (!owner || owner.kind !== 'user' || owner.disabled || owner.forcePasswordChange || owner.accountId !== account.id || owner.username !== account.username) return 'target'
    return 'ok'
  }
  if (principal.kind !== 'user' || principal.accountId !== account.id || principal.forcePasswordChange) return 'issuer'
  if (issuer.teamMemberId) {
    // The resolver returns null for a deleted, suspended or expired member.
    const member = await deps.teamMember(account.id, issuer.teamMemberId)
    if (!member || !teamToolIds(member.roles).includes('email-accounts')) return 'issuer'
  }
  const serviceUser = await deps.store.getServiceUser(target.serviceUserId)
  if (!serviceUser || !serviceUser.services.email || serviceUser.accountId !== account.id || serviceUser.login.toLowerCase() !== target.mailbox) return 'target'
  try { await assertAccountPlanFeatures(deps.store, account, ['email-accounts']) } catch { return 'target' }
  return 'ok'
}

/** Per-request check of a handed-off session; false ends that session. */
export const createHandoffSessionCheck = (deps: HandoffAuthorityDeps) => async (session: SessionRecord, principal: PrincipalRecord): Promise<boolean> => {
  if (session.impersonatorPrincipalId === null) return true
  if (principal.kind !== 'user' || !principal.accountId) return false
  const issuer = { principalId: session.impersonatorPrincipalId, ...(session.impersonatorTeamMemberId ? { teamMemberId: session.impersonatorTeamMemberId } : {}) }
  if (!isMailboxPrincipalUsername(principal.username)) {
    return await handoffAuthority(deps, issuer, { kind: 'account-owner', accountId: principal.accountId, principalId: principal.id }) === 'ok'
  }
  // A handed-off mailbox session has only its credential-free binding; anything else is not this session.
  const binding = await getMailboxSession(deps.db, session.id)
  if (!binding || binding.sealedPassword !== null || binding.accountId !== principal.accountId) return false
  return await handoffAuthority(deps, issuer, { kind: 'mailbox', accountId: binding.accountId, serviceUserId: binding.serviceUserId, mailbox: binding.mailbox }) === 'ok'
}
