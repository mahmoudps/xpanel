import type { Account, Principal, ResellerAcl } from '@xpanel/core'
import type { WhmSurfaceProps } from '../surfaces/xwhm.ts'
import type { SurfaceAuthority } from './theme-surface.ts'

export const qualified = (props: WhmSurfaceProps, id: string): boolean => props.catalog?.some(tool => tool.id === id && tool.status === 'verified' && tool.delivery.status === 'verified') === true
export const principalOf = (props: WhmSurfaceProps): Principal | undefined => props.visibility?.principal ?? props.principal
export const allowed = (props: WhmSurfaceProps, acl: ResellerAcl): boolean => {
  const principal = principalOf(props)
  return principal?.kind === 'root' || principal?.kind === 'reseller' && (props.visibility?.reseller?.acl ?? props.activeReseller?.acl ?? []).includes(acl)
}
export const readableAccounts = (props: WhmSurfaceProps, authority?: Pick<SurfaceAuthority, 'presentation' | 'canReadFacts' | 'authorizedTools'>): readonly Account[] | undefined => {
  const storedFacts = authority?.presentation === 'read-only' && authority.canReadFacts === true && authority.authorizedTools.has('list-accounts')
  const readable = authority?.presentation === 'read-only' ? storedFacts : !props.capabilityUnavailable && qualified(props, 'list-accounts')
  if (!allowed(props, 'list-accounts') || !readable) return undefined
  const principal = principalOf(props)!
  return props.accounts?.filter(account => principal.kind === 'root' || account.ownerId === principal.id)
}
export const accountFor = (props: WhmSurfaceProps, username: string): Account | undefined => /^[a-z][a-z0-9]{0,15}$/.test(username) ? readableAccounts(props)?.find(account => account.username === username) : undefined
export const canCreate = (props: WhmSurfaceProps): boolean => props.capabilityUnavailable !== true && allowed(props, 'create-account') && qualified(props, 'create-account')

