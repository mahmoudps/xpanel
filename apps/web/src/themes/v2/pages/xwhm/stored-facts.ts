import { canOpenRegisteredRoute, isToolAuthorized } from '@xpanel/catalog'
import type { WhmSurfaceProps } from '../../../contract.ts'

export interface WhmStoredFactAuthority {
  readonly presentation?: 'live' | 'read-only'
  readonly canReadFacts?: boolean
  readonly authorizedTools?: ReadonlySet<string>
}

/** Trusted projection facts still require the current principal, route and each collection permission. */
export function whmStoredFacts(props: WhmSurfaceProps, authority: WhmStoredFactAuthority, ids: readonly string[], route = props.activeRoute ?? '/whm'): boolean {
  const principal = props.visibility?.principal ?? props.principal
  if (authority.presentation !== 'read-only' || authority.canReadFacts !== true || !principal || !props.catalog || !authority.authorizedTools) return false
  if (props.principal && (props.principal.id !== principal.id || props.principal.kind !== principal.kind)) return false
  if (principal.kind !== 'root' && principal.kind !== 'reseller') return false
  const visibility = { ...props.visibility, principal, reseller: props.visibility?.reseller ?? props.activeReseller ?? undefined }
  return canOpenRegisteredRoute(route, visibility) && ids.some(id => authority.authorizedTools!.has(id) && props.catalog!.some(tool => tool.id === id && isToolAuthorized(tool, visibility)))
}
