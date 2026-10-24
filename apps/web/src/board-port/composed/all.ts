import { renderComposedRoutes } from './render.ts'
import type { ComposedContext } from './context.ts'
import type { ComposedRoute } from './types.ts'
import { xpanel_security } from './sections/xpanel-security.ts'

const xpanelRoutes: readonly ComposedRoute[] = [...xpanel_security]
const xwhmRoutes: readonly ComposedRoute[] = []

export const renderComposedXpanel = (ctx: ComposedContext & { route: string }): string | undefined =>
  renderComposedRoutes(xpanelRoutes, ctx)

export const renderComposedXwhm = (ctx: ComposedContext & { route: string }): string | undefined =>
  renderComposedRoutes(xwhmRoutes, ctx)

export const composedXpanelRoutes = xpanelRoutes
export const composedXwhmRoutes = xwhmRoutes
