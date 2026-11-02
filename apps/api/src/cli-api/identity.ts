import { fail } from '@xpanel/core'
import { findPrincipalByUsername } from '@xpanel/db'
import type { Db, PrincipalRecord } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { principalRecordToPrincipal, type AuthenticatedCaller } from '../auth.ts'
import { assertAccountPlanFeatures } from '../authorization.ts'
import { entryPointAdmitsPrincipal, type EntryPoint } from '../entry-points.ts'

/** The account or reseller root names with --user / --reseller. Honored only for kernel UID 0. */
export interface CliActAs { kind: 'user' | 'reseller'; name: string }

/** Set only by the local command-line API socket, from the kernel peer credentials of the connection. */
export interface CliPeer { uid: number; actAs: CliActAs | null }

export const CLI_API_FEATURE = 'command-line-api'
export const CLI_COMMAND: Readonly<Record<'xpanel' | 'xwhm', string>> = Object.freeze({ xpanel: 'xuapi', xwhm: 'xwhmapi' })

/**
 * Routes reachable from the command-line API. Sign-in, sign-out, handoffs and integrations create or consume
 * credentials of their own; the command line carries none.
 */
export const cliApiAllowsRoute = (pathname: string, method: string): boolean => {
  if (!pathname.startsWith('/api/')) return false
  if (pathname.startsWith('/api/auth/')) return pathname === '/api/auth/me' && method === 'GET'
  return !/^\/api\/(?:handoff|integrations)(?:\/|$)/.test(pathname)
}

const enabledPrincipal = (record: PrincipalRecord | null, kind: PrincipalRecord['kind']): PrincipalRecord => {
  if (!record || record.kind !== kind || record.disabled) return fail('UNAUTHENTICATED', 'the requested identity is unavailable')
  return record
}

/**
 * Resolves the acting principal of a command-line call. The kernel UID names the caller: a hosting account acts
 * only as itself on xuapi; root names the account (xuapi --user) or acts as root or a reseller (xwhmapi --reseller)
 * and is then recorded as the impersonator. Every later check is the normal request authorization.
 */
export const authenticateCliPeer = async (
  deps: { db: Db; store: StateStore },
  entryPoint: EntryPoint | undefined,
  peer: CliPeer,
): Promise<AuthenticatedCaller> => {
  if (entryPoint !== 'xpanel' && entryPoint !== 'xwhm') return fail('FORBIDDEN', 'the command-line API is unavailable on this entry point')
  if (!Number.isSafeInteger(peer.uid) || peer.uid < 0) return fail('UNAUTHENTICATED', 'kernel peer credentials are unavailable')
  const asRoot = peer.uid === 0
  let record: PrincipalRecord
  if (entryPoint === 'xpanel') {
    let account
    if (asRoot) {
      if (peer.actAs?.kind !== 'user') return fail('FORBIDDEN', 'root must name the account with --user')
      account = await deps.store.getAccountByUsername(peer.actAs.name)
      if (!account) return fail('NOT_FOUND', 'account not found')
    } else {
      account = (await deps.store.listAccounts()).find(candidate => candidate.uid === peer.uid)
      if (!account) return fail('UNAUTHENTICATED', 'this system user is not a hosting account')
      if (peer.actAs && !(peer.actAs.kind === 'user' && peer.actAs.name === account.username)) return fail('FORBIDDEN', '--user and --reseller are available only to root')
    }
    record = enabledPrincipal(await findPrincipalByUsername(deps.db, account.username), 'user')
    if (record.accountId !== account.id) return fail('UNAUTHENTICATED', 'the requested identity is unavailable')
    await assertAccountPlanFeatures(deps.store, account, [CLI_API_FEATURE])
  } else {
    if (!asRoot) return fail('FORBIDDEN', 'xwhmapi is available only to root')
    if (peer.actAs?.kind === 'user') return fail('FORBIDDEN', 'xwhmapi acts as root or as a reseller named with --reseller')
    record = peer.actAs ? enabledPrincipal(await findPrincipalByUsername(deps.db, peer.actAs.name), 'reseller') : enabledPrincipal(await findPrincipalByUsername(deps.db, 'root'), 'root')
  }
  if (!entryPointAdmitsPrincipal(entryPoint, record)) return fail('FORBIDDEN', 'this identity cannot use this command')
  const impersonator = asRoot && record.kind !== 'root'
    ? Object.freeze({ principalId: enabledPrincipal(await findPrincipalByUsername(deps.db, 'root'), 'root').id, login: `root via ${CLI_COMMAND[entryPoint]}` })
    : undefined
  return {
    principal: principalRecordToPrincipal(record),
    principalRecord: record,
    sessionId: null,
    sessionToken: null,
    apiTokenId: null,
    // The authority of the acting principal itself, as for its own signed-in session; route policies still apply.
    scopes: ['*'],
    csrfValid: true,
    mfaVerified: true,
    ...(impersonator ? { impersonator } : {}),
  }
}
