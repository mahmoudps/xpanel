import type { Principal, Reseller } from '@xpanel/core'
import type { CatalogTool, Surface } from './types.ts'

export interface VisibilityContext {
  principal: Principal
  /** Required for feature-gated user tools; an explicit empty set means all features are enabled. */
  disabledFeatures?: ReadonlySet<string>
  /** for 'reseller' principals */
  reseller?: Pick<Reseller, 'acl'>
  /** A team member session: only these tool ids, on top of the plan feature gate. */
  allowedToolIds?: ReadonlySet<string>
}

export const surfacesFor = (p: Principal): Surface[] =>
  p.kind === 'user' ? ['xpanel', 'xmail'] : ['xwhm', 'aapanel']

/** Role, feature and team visibility, independent of delivery qualification. This never grants API admission. */
export const isToolAuthorized = (tool: CatalogTool, ctx: VisibilityContext): boolean => {
  if (!surfacesFor(ctx.principal).includes(tool.surface)) return false
  switch (ctx.principal.kind) {
    case 'root':
      return true
    case 'reseller':
      if (tool.rootOnly) return false
      return tool.resellerAcl === null || (ctx.reseller?.acl.includes(tool.resellerAcl) ?? false)
    case 'user':
      if (ctx.allowedToolIds && !ctx.allowedToolIds.has(tool.id)) return false
      return tool.featureKey === null || (ctx.disabledFeatures !== undefined && !ctx.disabledFeatures.has(tool.featureKey))
  }
}

/** Only verified tools are shown. Visibility does not replace server-side authorization. */
export const isVisible = (tool: CatalogTool, ctx: VisibilityContext): boolean =>
  tool.status === 'verified' && tool.delivery.status === 'verified' && isToolAuthorized(tool, ctx)

export const visibleTools = (tools: readonly CatalogTool[], ctx: VisibilityContext): CatalogTool[] =>
  tools.filter(t => isVisible(t, ctx))
