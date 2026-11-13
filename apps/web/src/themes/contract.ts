// The UI theme contract: what core hands a theme, and the hooks every theme's markup must carry so the core
// controllers keep working. Types and pure helpers only. Core imports themes only through the registry; this file
// imports no theme.

import { navigation, registeredDocumentAliases, type CatalogTool, type PageTemplate, type VisibilityContext } from '@xpanel/catalog'
import type { Account } from '@xpanel/core'
import type { WebBranding } from '../branding.ts'
import type { AccountSecurityCardProps } from '../surfaces/account-security.ts'
import type { TableDensity, ThemeMode } from '../app.ts'
import type { CommandPaletteEntry, CommandPaletteSurface } from '../command-palette.ts'
import type { Locale } from '../i18n.ts'
import type { ThemeMessages } from '../theme-messages.ts'
import type { StatusPageModel } from '../status-page.ts'
import type { LoginSurfaceProps } from '../surfaces/login.ts'
import type { MailSurfaceProps } from '../surfaces/xmail.ts'
import type { PanelSurfaceProps } from '../surfaces/xpanel.ts'
import type { WhmSurfaceProps } from '../surfaces/xwhm.ts'
import type { AsyncActionBannerProps } from '../tokens.ts'
import type { LiveEventState } from '../ws-client.ts'
import { matchesHook, parseMarkup, type HookSelector, type MarkupNode } from './markup.ts'
import { LOGIN_DISABLED_HOOKS, LOGIN_HOOKS, ROUTE_HOOKS, SURFACE_HOOKS } from './route-hooks.ts'
import { AUTHORITATIVE_CONTROLLER_DECLARATIONS } from './controller-hooks.ts'
import { checkControllerDeclarations, type ControllerContext, type ControllerDeclaration } from './controller-conformance.ts'

export type { LoginSurfaceProps, MailSurfaceProps, PanelSurfaceProps, StatusPageModel, WhmSurfaceProps }
export { matchesHook, parseMarkup, type HookSelector, type MarkupNode }

/** Built-in themes are classic and v2; an installed theme package adds its own validated id. */
export type UiThemeId = string
export type ThemeSurface = 'xpanel' | 'xwhm' | 'xmail'

/** Core-owned self-auth presentation only; none of these flags grants a native provider operation. */
export interface AuthPersonalView {
  readonly state: 'ready' | 'denied' | 'unavailable'
  readonly canChangePassword: boolean
  readonly canReadSessions: boolean
  readonly canRevokeSessions: boolean
  readonly canReadApiTokens: boolean
  readonly canManageApiTokens: boolean
}

/** Internal authenticated producer evidence. Core strips every identity field before a theme sees the view. */
export interface AuthPersonalSource extends AuthPersonalView {
  readonly schemaVersion: 1
  readonly provenance: 'interactive-owner'
  readonly surface: 'xpanel'
  readonly route: '/security/account'
  readonly principalId: string
  readonly accountId: string
  readonly username: string
}

export interface ThemeViewProps {
  /** Identity-matched self-auth only, independently projected from native hosting qualification. */
  readonly authPersonal?: AuthPersonalView
  readonly branding?: WebBranding
  /** Core derives installed presentation packages from the same registry used by personal preferences. */
  readonly themePackages?: readonly ThemePackageView[]
  /** Already computed by core; themes never reconstruct route admission or missing-account policy. */
  readonly unavailableView?: UnavailableProps
}

export interface ThemePackageView {
  readonly id: UiThemeId
  readonly label: string
  readonly surfaces: readonly ThemeSurface[]
  readonly available: boolean
}

/** Supplied only by core after role admission; provider reads and mutations remain independently qualified. */
export type ReadOnlySurfaceFacts =
  | { readonly surface: 'xpanel'; readonly panel: PanelSurfaceProps & Pick<ThemeViewProps, 'authPersonal'> }
  | { readonly surface: 'xwhm'; readonly whm: WhmSurfaceProps }
  | { readonly surface: 'xmail'; readonly mail: MailSurfaceProps }

/** A static file core serves under `/assets/` with an immutable cache; `href` carries the content version. */
export interface ThemeAsset {
  readonly path: `/assets/${string}`
  readonly href: string
  readonly contentType: string
  readonly body: string
}

/** The frame around every page. Core computes the `<html>` attributes (lang, dir, data-theme, data-density,
 *  data-surface, data-mfa-mode, data-realtime-enabled, data-status) and the head and body markup; the theme adds
 *  its own assets and never changes those attributes. */
export interface DocumentProps {
  /** Trusted dispatched document context, for theme-owned route assets only. It grants no page authority. */
  readonly route?: string
  readonly surface?: ThemeSurface | 'login'
  /** The server's actual render branch; never inferred from body markup or a query preference. */
  readonly viewKind?: 'workspace' | 'login' | 'status' | 'unavailable'
  readonly branding?: WebBranding
  readonly htmlAttributeSuffix: string
  /** Escaped by core in its protected attribute order; the theme must preserve this string. */
  readonly htmlAttributes: string
  readonly title: string
  readonly faviconHref: string
  readonly faviconContentType?: string
  /** Core head markup placed after the theme's assets, such as the page's translation script. */
  readonly headHtml: string
  readonly bodyHtml: string
}

/** Identity facts of the current session, already translated by core. */
export interface WorkspaceSummaryView {
  readonly title: string
  readonly fields: readonly { readonly key: string; readonly label: string; readonly value: string; readonly ltr: boolean }[]
  /** The owner surface has no authorized account to show. */
  readonly accountEmpty: boolean
  readonly accountEmptyText?: string
  readonly mfaText?: string
  /** Root without two-factor sign-in: link to the optional enrollment page. */
  readonly mfaHref?: string
}

/** A route that is not qualified on this host. Unqualified provider data is never part of these props. */
export interface UnavailableProps extends ThemeViewProps {
  readonly surface: ThemeSurface
  readonly locale: Locale
  readonly theme: ThemeMode
  readonly density: TableDensity
  readonly route: string
  readonly heading: string
  /** Registered and open to this role: the theme shows the route's read-only layout, never its operations. */
  readonly admitted: boolean
  readonly securityPage: boolean
  /** Routes the sidebar may link to. */
  readonly qualifiedRoutes: ReadonlySet<string>
  readonly catalog?: readonly CatalogTool[]
  readonly visibility?: VisibilityContext
  readonly session?: { readonly username: string; readonly role: string; readonly accountId?: string }
  readonly signedIn: boolean
  readonly accountId?: string
  readonly storeAccount?: Pick<Account, 'id' | 'status'>
  readonly actionState?: AsyncActionBannerProps
  readonly summary?: WorkspaceSummaryView
  readonly supportEmail?: string
  readonly readOnlyFacts?: ReadOnlySurfaceFacts
}

export interface ActivityDrawerProps {
  readonly locale: Locale
  readonly live: LiveEventState
}

export interface CommandPaletteProps {
  readonly surface: CommandPaletteSurface
  readonly locale: Locale
  readonly entries: readonly CommandPaletteEntry[]
}

export interface ReconcileBannerProps {
  readonly locale: Locale
  readonly live: LiveEventState
}

export interface DocumentBodyProps {
  readonly locale: Locale
  readonly branding?: WebBranding
  readonly impersonation?: { readonly target: string; readonly issuer: string }
  readonly qualificationMode?: boolean
  /** Shown while root previews an installed theme on this document. */
  readonly themePreviewName?: string
  readonly handoffControls: boolean
  readonly surfaceHtml: string
  readonly reconcileHtml: string
  readonly paletteHtml: string
  readonly activityHtml: string
  readonly clientScriptsHtml: string
}

/** The design tokens of a built-in theme an uploaded package may set (packages.ts), with the shipped values. */
export interface ThemePackageTokens {
  readonly required: readonly string[]
  readonly optional: readonly string[]
  /** Tokens whose value is a radius in px; every other token is a color. */
  readonly radii: readonly string[]
  /** [text, background] pairs that must keep 4.5:1 contrast; both are required tokens. */
  readonly contrast: readonly (readonly [string, string])[]
  readonly defaults: { readonly light: Readonly<Record<string, string>>; readonly dark: Readonly<Record<string, string>> }
}

export interface UiTheme {
  readonly id: UiThemeId
  /** An installed package renders with this built-in theme, whose data-ui-theme its stylesheets select. */
  readonly baseId?: UiThemeId
  /** An installed package's own name; built-in names are translated by core. */
  readonly label?: string
  readonly packageTokens?: ThemePackageTokens
  readonly assets: readonly ThemeAsset[]
  readonly messages?: ThemeMessages
  renderDocument(props: DocumentProps): string
  renderLogin(props: LoginSurfaceProps & ThemeViewProps): string
  renderPanel(props: PanelSurfaceProps & ThemeViewProps): string
  renderWhm(props: WhmSurfaceProps & ThemeViewProps): string
  renderMail(props: MailSurfaceProps & ThemeViewProps): string
  renderStatus(props: StatusPageModel & ThemeViewProps): string
  renderUnavailable(props: UnavailableProps): string
  readonly slots: {
    documentBody(props: DocumentBodyProps): string
    accountSecurity(props: { readonly bodyHtml: string; readonly security: AccountSecurityCardProps }): string
    activityDrawer(props: ActivityDrawerProps): string
    commandPalette(props: CommandPaletteProps): string
    reconcileBanner(props: ReconcileBannerProps): string
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Hook registry

/** A `<template data-xp-template>` a controller clones, with the slots it fills and the actions it wires. Nested
 *  templates must sit inside their parent template. */
export interface TemplateContract {
  readonly name: string
  readonly slots: readonly string[]
  readonly actions: readonly string[]
  readonly templates?: readonly TemplateContract[]
}

/** The control selected by core. Attribute true/false means required present/absent. */
export interface ElementRequirement {
  readonly hook: HookSelector
  readonly tag?: string
  readonly attributes?: Readonly<Record<string, string | boolean>>
  /** querySelector selects the first match; querySelectorAll contracts may require every match. */
  readonly occurrence?: 'first' | 'every'
}

export interface ControllerRequirement {
  readonly name: string
  readonly root: HookSelector
  readonly hooks: readonly HookSelector[]
  readonly elements?: readonly ElementRequirement[]
}

export interface HookRequirement {
  readonly hooks: readonly HookSelector[]
  readonly templates?: readonly TemplateContract[]
  readonly elements?: readonly ElementRequirement[]
  readonly controllers?: readonly ControllerRequirement[]
  readonly authoritativeControllers?: readonly ControllerDeclaration[]
  readonly context?: ControllerContext
  readonly documentHooks?: { readonly attribute: string; readonly cases: Readonly<Record<string, readonly HookSelector[]>>; readonly fallback: readonly HookSelector[] }
}

/** Required controls are authored from the controller, independently of the rendered observation snapshot. */
export const REVERSE_PROXY_CONTROLLER: ControllerRequirement = {
  name: 'account-reverse-proxy',
  root: '[data-reverse-proxy]',
  hooks: [
    '[data-rp-status]', '[data-rp-rows]', '[data-rp-application]', '[data-rp-refresh]',
    '[data-rp-mode]', '[data-rp-upstream]', '[data-rp-upstream-field]', '[data-rp-error]',
    '[data-rp-save]', '[data-rp-cancel]', '[data-rp-selected]', '[data-rp-current]',
    '[data-rp-root]', '[data-rp-options]', '[data-rp-websocket]', '[data-rp-host]',
    '[data-rp-header-rows]', '[data-rp-add-header]', '[data-rp-headers-error]',
  ],
  elements: [
    { hook: '[data-rp-status]', attributes: { role: 'status' } },
    { hook: '[data-rp-rows]', tag: 'tbody' },
    { hook: '[data-rp-refresh]', tag: 'button', attributes: { type: 'button' } },
    { hook: '[data-rp-mode]', tag: 'select' },
    { hook: '[data-rp-upstream]', tag: 'input', attributes: { type: 'text', dir: 'ltr' } },
    // The upstream error is the first match; the header error has a separate controller role.
    { hook: '[data-rp-error]', attributes: { 'data-rp-headers-error': false } },
    { hook: '[data-rp-save]', tag: 'button', attributes: { type: 'button' } },
    { hook: '[data-rp-cancel]', tag: 'button', attributes: { type: 'button' } },
    { hook: '[data-rp-selected]', attributes: { dir: 'ltr' } },
    { hook: '[data-rp-root]', attributes: { dir: 'ltr' } },
    { hook: '[data-rp-websocket]', tag: 'input', attributes: { type: 'checkbox' } },
    { hook: '[data-rp-host]', tag: 'select' },
    { hook: '[data-rp-header-rows]', tag: 'tbody' },
    { hook: '[data-rp-add-header]', tag: 'button', attributes: { type: 'button' } },
  ],
}

export const controllerContractsForRoute = (route: string): readonly ControllerRequirement[] =>
  route === '/domains/reverse-proxy' ? [REVERSE_PROXY_CONTROLLER] : []

/** One registry entry. An `unavailable` page cannot be qualified by the catalog: it renders through
 *  `renderUnavailable`, and its hooks are complete without the surface list. */
export interface RouteHooks extends HookRequirement {
  readonly unavailable?: true
}

export interface RouteContract extends RouteHooks {
  readonly route: string
  readonly surface: ThemeSurface
  readonly template: PageTemplate
  readonly artboard?: string
}

export type LoginAudience = keyof typeof LOGIN_HOOKS

let cachedRegisteredDocuments: Array<(typeof navigation)[number]['sections'][number]['pages'][number] & { surface: ThemeSurface }> | undefined
let cachedRouteContracts: RouteContract[] | undefined

/** Navigation authority for every registered document, including aliases with their own rendered state. */
export function registeredThemeDocuments() {
  if (cachedRegisteredDocuments) return cachedRegisteredDocuments.slice()
  const canonical = navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => ({
    ...page, surface: surface.surface as ThemeSurface,
  }))))
  const byRoute = new Map(canonical.map(page => [page.route, page]))
  const aliases = registeredDocumentAliases.map(alias => {
    const parent = byRoute.get(alias.parentRoute)
    if (!parent) throw new Error(`Unknown theme contract parent: ${alias.parentRoute}`)
    return { ...parent, route: alias.route }
  })
  cachedRegisteredDocuments = [...canonical, ...aliases]
  return cachedRegisteredDocuments.slice()
}

/** A generated observation is required for each document; aliases never silently inherit parent markup. */
export function routeContracts(): RouteContract[] {
  if (cachedRouteContracts) return cachedRouteContracts.slice()
  cachedRouteContracts = registeredThemeDocuments().map(page => {
    const own = ROUTE_HOOKS[page.route]
    if (!own) throw new Error(`Missing theme hook snapshot for ${page.route}; regenerate route hooks`)
    return {
      route: page.route,
      surface: page.surface,
      template: page.template,
      ...(page.artboard ? { artboard: page.artboard } : {}),
      ...(own.unavailable ? { unavailable: true as const } : {}),
      hooks: own.unavailable ? own.hooks : [...SURFACE_HOOKS[page.surface], ...own.hooks],
      ...(own.templates ? { templates: own.templates } : {}),
      ...(own.unavailable ? {} : { controllers: controllerContractsForRoute(page.route) }),
      authoritativeControllers: AUTHORITATIVE_CONTROLLER_DECLARATIONS,
      context: { route: page.route, surface: page.surface, qualified: !own.unavailable },
    }
  })
  return cachedRouteContracts.slice()
}

/** Sign-in requires the actual named fields core submits, independently of observed data hooks. */
export const loginContract = (audience: LoginAudience): HookRequirement => ({
  hooks: ['[name="username"]', '[name="password"]'],
  documentHooks: { attribute: 'data-mfa-mode', cases: { disabled: LOGIN_DISABLED_HOOKS[audience] }, fallback: LOGIN_HOOKS[audience] },
  authoritativeControllers: AUTHORITATIVE_CONTROLLER_DECLARATIONS,
  context: { route: '/login', surface: 'login', loginAudience: audience, qualified: true },
  elements: [
    { hook: '[name="username"]', tag: 'input', attributes: { type: 'text' } },
    { hook: '[name="password"]', tag: 'input', attributes: { type: 'password' } },
  ],
})

// ---------------------------------------------------------------------------------------------------------------
// Conformance

export interface ConformanceIssue {
  readonly kind: 'hook' | 'template' | 'slot' | 'action' | 'element' | 'controller' | 'relation'
  readonly name: string
  /** The template the slot, action or nested template belongs to. */
  readonly template?: string
  readonly controller?: string
}

function checkTemplates(
  nodes: readonly MarkupNode[],
  contracts: readonly TemplateContract[],
  scope: number,
  issues: ConformanceIssue[],
  templatesByScope: ReadonlyMap<number, ReadonlyMap<string, readonly number[]>>,
  nodesByTemplate: ReadonlyMap<number, readonly MarkupNode[]>,
): void {
  const parentName = scope < 0 ? undefined : nodes[scope]!.attrs.get('data-xp-template')
  const scopedTemplates = templatesByScope.get(scope)
  for (const contract of contracts) {
    const found = scopedTemplates?.get(contract.name) ?? []
    if (found.length === 0) {
      issues.push({ kind: 'template', name: contract.name, ...(parentName ? { template: parentName } : {}) })
      continue
    }
    // Every copy must be complete: a controller may clone any of them.
    for (const at of found) {
      const own = nodesByTemplate.get(at) ?? []
      for (const slot of contract.slots)
        if (!own.some(node => node.attrs.get('data-xp-slot') === slot)) issues.push({ kind: 'slot', name: slot, template: contract.name })
      for (const action of contract.actions)
        if (!own.some(node => node.attrs.get('data-xp-action') === action)) issues.push({ kind: 'action', name: action, template: contract.name })
      if (contract.templates?.length) checkTemplates(nodes, contract.templates, at, issues, templatesByScope, nodesByTemplate)
    }
  }
}

function checkElements(nodes: readonly MarkupNode[], requirements: readonly ElementRequirement[], issues: ConformanceIssue[], controller?: string): void {
  for (const requirement of requirements) {
    const matches = nodes.filter(node => matchesHook(node, requirement.hook))
    const selected = requirement.occurrence === 'every' ? matches : matches.slice(0, 1)
    const invalid = selected.length === 0 || selected.some(node =>
      (requirement.tag !== undefined && (node.namespace !== 'html' || node.tag !== requirement.tag))
      || Object.entries(requirement.attributes ?? {}).some(([name, value]) =>
        value === true ? !node.attrs.has(name) : value === false ? node.attrs.has(name) : node.attrs.get(name) !== value))
    if (invalid && !issues.some(issue => issue.kind === 'hook' && issue.name === requirement.hook && issue.controller === controller))
      issues.push({ kind: 'element', name: requirement.hook, ...(controller ? { controller } : {}) })
  }
}

const isDescendant = (nodes: readonly MarkupNode[], index: number, ancestor: number): boolean => {
  for (let parent = nodes[index]!.parent; parent >= 0; parent = nodes[parent]!.parent)
    if (parent === ancestor) return true
  return false
}

/** Checks live controls in the scope actually queried by core, then template structure. */
export function checkConformance(html: string, requirement: HookRequirement, parsedNodes?: readonly MarkupNode[]): ConformanceIssue[] {
  const nodes = parsedNodes ?? parseMarkup(html)
  const live: MarkupNode[] = []
  const liveIds = new Set<string>()
  const liveAttrNames = new Set<string>()
  const liveAttrPairs = new Set<string>()
  const templatesByScope = new Map<number, Map<string, number[]>>()
  const nodesByTemplate = new Map<number, MarkupNode[]>()
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!
    if (node.template < 0) {
      live.push(node)
      for (const [k, v] of node.attrs) {
        liveAttrNames.add(k)
        liveAttrPairs.add(`${k}\0${v}`)
        if (k === 'id') liveIds.add(v)
      }
    } else {
      let own = nodesByTemplate.get(node.template)
      if (!own) { own = []; nodesByTemplate.set(node.template, own) }
      own.push(node)
    }
    if (node.namespace === 'html' && node.tag === 'template') {
      const tplName = node.attrs.get('data-xp-template')
      if (tplName !== undefined) {
        let byName = templatesByScope.get(node.template)
        if (!byName) { byName = new Map(); templatesByScope.set(node.template, byName) }
        let indices = byName.get(tplName)
        if (!indices) { indices = []; byName.set(tplName, indices) }
        indices.push(index)
      }
    }
  }
  const probeNode = live[0]
  const liveHasHook = (hook: HookSelector): boolean => {
    if (probeNode) matchesHook(probeNode, hook)
    if (hook.startsWith('#')) return liveIds.has(hook.slice(1))
    const eq = hook.indexOf('="')
    if (eq < 0) return liveAttrNames.has(hook.slice(1, -1))
    return liveAttrPairs.has(`${hook.slice(1, eq)}\0${hook.slice(eq + 2, -2)}`)
  }
  const issues: ConformanceIssue[] = []
  const htmlNode = live.find(node => node.tag === 'html')
  const observed = requirement.documentHooks ? (requirement.documentHooks.cases[htmlNode?.attrs.get(requirement.documentHooks.attribute) ?? ''] ?? requirement.documentHooks.fallback) : []
  for (const hook of new Set([...requirement.hooks, ...observed]))
    if (probeNode ? !liveHasHook(hook) : !live.some(node => matchesHook(node, hook))) issues.push({ kind: 'hook', name: hook })
  checkElements(live, requirement.elements ?? [], issues)
  for (const controller of requirement.controllers ?? []) {
    const roots = nodes.flatMap((node, index) => node.template < 0 && matchesHook(node, controller.root) ? [index] : [])
    if (!roots.length) issues.push({ kind: 'controller', name: controller.root, controller: controller.name })
    for (const root of roots) {
      const own = nodes.filter((node, index) => node.template < 0 && isDescendant(nodes, index, root))
      for (const hook of new Set(controller.hooks))
        if (!own.some(node => matchesHook(node, hook))) issues.push({ kind: 'hook', name: hook, controller: controller.name })
      checkElements(own, controller.elements ?? [], issues, controller.name)
    }
  }
  issues.push(...checkControllerDeclarations(nodes, requirement.authoritativeControllers ?? [], requirement.context ?? {}))
  checkTemplates(nodes, requirement.templates ?? [], -1, issues, templatesByScope, nodesByTemplate)
  return issues.filter((issue, index) => issues.findIndex(other => other.kind === issue.kind && other.name === issue.name && other.template === issue.template && other.controller === issue.controller) === index)
}
