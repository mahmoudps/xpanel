import { renderComposedRoutes } from './render.ts'
import type { ComposedContext } from './context.ts'
import type { ComposedRoute } from './types.ts'
import { xpanel_advanced } from './sections/xpanel-advanced.ts'

const xpanelRoutes: readonly ComposedRoute[] = [...xpanel_advanced]
const xwhmRoutes: readonly ComposedRoute[] = []

export const renderComposedXpanel = (ctx: ComposedContext & { route: string }): string | undefined =>
  renderComposedRoutes(xpanelRoutes, ctx)

export const renderComposedXwhm = (ctx: ComposedContext & { route: string }): string | undefined =>
  renderComposedRoutes(xwhmRoutes, ctx)

export const composedXpanelRoutes = xpanelRoutes
export const composedXwhmRoutes = xwhmRoutes
