import type { Principal, Reseller } from '@xpanel/core'
import type { CatalogTool, Surface } from './types.ts'

export interface VisibilityContext {
  principal: Principal
  /** Required for feature-gated user tools; an explicit empty set means all features are enabled. */
  disabledFeatures?: ReadonlySet<string>
  /** for 'reseller' principals */
  reseller?: Pick<Reseller, 'acl'>
}

export const surfacesFor = (p: Principal): Surface[] =>
  p.kind === 'user' ? ['xpanel', 'xmail'] : ['xwhm', 'aapanel']

/** Only verified tools are shown. Visibility does not replace server-side authorization. */
export const isVisible = (tool: CatalogTool, ctx: VisibilityContext): boolean => {
  if (tool.status !== 'verified' || tool.delivery.status !== 'verified') return false
  if (!surfacesFor(ctx.principal).includes(tool.surface)) return false
  switch (ctx.principal.kind) {
    case 'root':
      return true
    case 'reseller':
      if (tool.rootOnly) return false
      return tool.resellerAcl === null || (ctx.reseller?.acl.includes(tool.resellerAcl) ?? false)
    case 'user':
      return tool.featureKey === null || (ctx.disabledFeatures !== undefined && !ctx.disabledFeatures.has(tool.featureKey))
  }
}

export const visibleTools = (tools: readonly CatalogTool[], ctx: VisibilityContext): CatalogTool[] =>
  tools.filter(t => isVisible(t, ctx))
