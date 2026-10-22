import type { Principal, Reseller } from '@xpanel/core'
import type { CatalogTool, Surface } from './types.ts'

export interface VisibilityContext {
  principal: Principal
  /** for 'user' principals: feature keys disabled by the account's feature list */
  disabledFeatures?: ReadonlySet<string>
  /** for 'reseller' principals */
  reseller?: Pick<Reseller, 'acl'>
}

export const surfacesFor = (p: Principal): Surface[] =>
  p.kind === 'user' ? ['xpanel', 'xmail'] : ['xwhm', 'aapanel']

/** Only ready tools are ever shown. Feature lists hide xPanel tools; reseller ACLs hide xWHM tools. */
export const isVisible = (tool: CatalogTool, ctx: VisibilityContext): boolean => {
  if (tool.status !== 'ready') return false
  if (!surfacesFor(ctx.principal).includes(tool.surface)) return false
  switch (ctx.principal.kind) {
    case 'root':
      return true
    case 'reseller':
      if (tool.rootOnly) return false
      return tool.resellerAcl === null || (ctx.reseller?.acl.includes(tool.resellerAcl) ?? false)
    case 'user':
      return tool.featureKey === null || !(ctx.disabledFeatures?.has(tool.featureKey) ?? false)
  }
}

export const visibleTools = (tools: readonly CatalogTool[], ctx: VisibilityContext): CatalogTool[] =>
  tools.filter(t => isVisible(t, ctx))
