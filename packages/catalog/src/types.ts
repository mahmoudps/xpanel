import type { ResellerAcl } from '@xpanel/core'

/** xpanel = account owner, xwhm = root/reseller, xmail = webmail, aapanel = aaPanel-derived server surfaces (shown inside xWHM). */
export type Surface = 'xpanel' | 'xwhm' | 'xmail' | 'aapanel'

/** Delivery tiers require observations; a test name is only a declaration. */
export type DeliveryStage = 'implemented' | 'integrated' | 'verified'
export type ToolStatus = 'researched' | DeliveryStage | 'out-of-scope'
export type EvidenceEnvironment = 'unit' | 'http' | 'browser' | 'linux' | 'external'

export interface CapabilityEvidence {
  toolId: string
  stage: DeliveryStage
  acceptance: string
  result: 'passed' | 'failed' | 'blocked' | 'not_run'
  sourceFingerprint: string
  artifactSha256: string | null
  environment: EvidenceEnvironment
  profile: string
  executor: 'real' | 'fake'
  runArtifact: string
  runArtifactSha256: string
  observedAt: string
}

export interface VerificationTarget {
  sourceFingerprint: string
  artifactSha256: string | null
  supportedProfiles: readonly string[]
}

export interface CapabilityDelivery {
  status: ToolStatus
  reason: string
  /** Only observations matching the target and the full acceptance criterion are retained. */
  evidence: readonly CapabilityEvidence[]
}

/** Display text is the English source string; translations live in `locales/<lang>.json` under `catalogKeys`. */
export interface CatalogGroup {
  id: string
  surface: Surface
  name: string
  order: number
}

export interface ToolDefinition {
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
  status: 'researched' | 'out-of-scope'
  outOfScopeReason?: string
}

export interface CatalogTool extends Omit<ToolDefinition, 'status'> {
  status: ToolStatus
  delivery: CapabilityDelivery
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
