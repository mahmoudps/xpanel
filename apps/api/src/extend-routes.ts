import type { StateStore } from '@xpanel/state'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { handleDemoModeRoute } from './demo-mode.ts'
import { handleHooksRoute } from './hooks-workspace.ts'
import type { HookHost } from './hooks-workspace.ts'
import { handlePluginPackagesRoute } from './plugin-packages.ts'
import { handleRegisteredAppsRoute } from './registered-apps.ts'
import { handleSiteSoftwareRoute } from './site-software-catalog.ts'
import { handleSiteSoftwareInstancesApiRoute } from './site-software-instances.ts'
import { handleThemePackagesRoute } from './theme-packages.ts'

/** Demo mode, hooks, registered applications, plugin packages, theme packages and the signed site software catalog (root, xWHM). */
export interface ExtendRouteHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  /** Protected agent transport; a body sends a POST mutation. Absent when no agent is connected. */
  callHost?: HookHost
}

export async function handleExtendRoute(request: Request, url: URL, method: string, helpers: ExtendRouteHelpers): Promise<Response | null> {
  return await handleDemoModeRoute(request, url, method, helpers)
    ?? await handleHooksRoute(request, url, method, helpers)
    ?? await handleRegisteredAppsRoute(request, url, method, helpers)
    ?? await handlePluginPackagesRoute(request, url, method, helpers)
    ?? await handleSiteSoftwareRoute(request, url, method, helpers)
    ?? await handleSiteSoftwareInstancesApiRoute(request, url, method, helpers)
    ?? await handleThemePackagesRoute(request, url, method, helpers)
}
