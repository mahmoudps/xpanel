import { renderComposedRoutes } from './render.ts'
import type { ComposedContext } from './context.ts'
import type { ComposedRoute } from './types.ts'
import { xwhm_email } from './sections/xwhm-email.ts'

const xpanelRoutes: readonly ComposedRoute[] = []
const xwhmRoutes: readonly ComposedRoute[] = [...xwhm_email]

export const renderComposedXpanel = (ctx: ComposedContext & { route: string }): string | undefined =>
  renderComposedRoutes(xpanelRoutes, ctx)

export const renderComposedXwhm = (ctx: ComposedContext & { route: string }): string | undefined =>
  renderComposedRoutes(xwhmRoutes, ctx)

export const composedXpanelRoutes = xpanelRoutes
export const composedXwhmRoutes = xwhmRoutes
