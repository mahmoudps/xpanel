import type { Account, Domain, Plan, Principal, Reseller, ServiceUser } from '@xpanel/core'
import type { Locale } from '../../i18n.ts'
/** Read models supplied by the authenticated adapter, never by request query flags.
 * Omitted arrays have not been read; an empty array is a completed empty read.
 * Catalog admission and API authorization remain independent of this presentation guard.
 */
export interface ComposedContext {
  locale: Locale
  route: string
  principal?: Principal
  /** Trusted authorization record from VisibilityContext, independent of list reads. */
  reseller?: Pick<Reseller, 'id' | 'acl'>
  account?: Account
  plan?: Plan
  domains?: readonly Domain[]
  serviceUsers?: readonly ServiceUser[]
  accounts?: readonly Account[]
  resellers?: readonly Reseller[]
  usage?: {
    phpVersion: string | null
    diskBytes: number | null
    memoryBytes: number | null
    processCount: number | null
    bandwidth: 'unmeasured'
    ioEnforced?: boolean | null
  }
  /** Only logical reader names, never raw host errors or credentials. */
  failedReads?: readonly ('domains' | 'serviceUsers' | 'accounts' | 'resellers' | 'usage')[]
}

export const canReadSelectedAccount = (context: ComposedContext): boolean => {
  const { principal, account } = context
  if (!principal || !account) return false
  if (principal.kind === 'root') return true
  if (principal.kind === 'user') return principal.accountId === account.id
  return account.ownerId === principal.id && context.reseller?.id === principal.id && context.reseller.acl.includes('list-accounts')
}

export const canReadWhm = (context: ComposedContext): boolean => {
  const principal = context.principal
  return principal?.kind === 'root' || (principal?.kind === 'reseller' && context.reseller?.id === principal.id && context.reseller.acl.includes('list-accounts'))
}
