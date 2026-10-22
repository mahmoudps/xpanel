import type { ResellerAcl } from '@xpanel/core'

/** xpanel = account owner, xwhm = root/reseller, xmail = webmail, aapanel = aaPanel-derived server surfaces (shown inside xWHM). */
export type Surface = 'xpanel' | 'xwhm' | 'xmail' | 'aapanel'

/**
 * planned: in the catalog, no screen yet.
 * ready: has a screen AND a passing acceptance test; only ready tools are shown.
 * out-of-scope: listed for coverage, never shown (Sitejet, WP Toolkit, CloudLinux...).
 */
export type ToolStatus = 'planned' | 'ready' | 'out-of-scope'

/** Display text is the English source string; translations live in `locales/<lang>.json` under `catalogKeys`. */
export interface CatalogGroup {
  id: string
  surface: Surface
  name: string
  order: number
}

export interface CatalogTool {
  id: string
  surface: Surface
  groupId: string
  name: string
  summary: string
  /** feature key gated by the account's feature list (xpanel/xmail tools) */
  featureKey: string | null
  /** reseller privilege that unlocks the tool; null with rootOnly=false means any reseller */
  resellerAcl: ResellerAcl | null
  rootOnly: boolean
  /** main entity the screen manages */
  entity: string
  /** vitest name or file that proves the tool's acceptance criterion; required for 'ready' */
  acceptanceTest: string | null
  status: ToolStatus
  outOfScopeReason?: string
}

/** A duplicate tool folded into its canonical tool during the navigation design; its behaviors still apply. */
export interface AbsorbedTool {
  id: string
  name: string
  source: string
  behaviors: string[]
}

/** Behavior specification behind a tool, taken from public documentation. Not shipped to the browser. */
export interface ToolSpec {
  id: string
  behaviors: string[]
  acceptance: string
  source: string
  upstreamFeatureKey: string
  upstreamAcl: string
  upstreamApi: string
  absorbed: AbsorbedTool[]
}

export type NavSurfaceId = 'xpanel' | 'xwhm' | 'xmail'

export type PageTemplate = 'custom' | 'list' | 'settings' | 'wizard' | 'log' | 'matrix' | 'dashboard' | 'editor'

/** owner = account owner; root; reseller (any); reseller:<acl> = reseller holding that privilege. */
export type NavRole = 'owner' | 'root' | 'reseller' | `reseller:${ResellerAcl}`

export interface NavPage {
  id: string
  name: string
  route: string
  template: PageTemplate
  /** id of the page's bespoke screen design; null when the page follows its template */
  artboard: string | null
  primaryAction: string | null
  roles: NavRole[]
  /** catalog tool ids this page delivers */
  tools: string[]
  /** search aliases, including cPanel, WHM and aaPanel names */
  keywords: string[]
  summary: string
}

export interface NavSection {
  id: string
  name: string
  /** lucide-react icon name */
  icon: string
  pages: NavPage[]
}

export interface NavSurface {
  surface: NavSurfaceId
  sections: NavSection[]
}
