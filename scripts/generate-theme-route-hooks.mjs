// Regenerates apps/web/src/themes/route-hooks.ts, the hook registry every UI theme must satisfy. For each registered
// document it renders the classic document (qualified catalog, live state present) and keeps the data-* attributes and
// ids that the shipped controller scripts select or read, plus the <template data-xp-template> those scripts clone.
//
//   node scripts/generate-theme-route-hooks.mjs          rewrite the registry
//   node scripts/generate-theme-route-hooks.mjs --check  exit 1 when the registry is stale
//
// Run it with the pinned Node (it imports the TypeScript sources directly).

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assertControllerSourceAudit } from './theme-controller-audit.mjs'

assertControllerSourceAudit()

const { tools } = await import('../packages/catalog/src/index.ts')
const { renderWebApp, serveStaticAsset } = await import('../apps/web/src/app.ts')
const { createInitialLiveEventState } = await import('../apps/web/src/ws-client.ts')
const { parseMarkup } = await import('../apps/web/src/themes/markup.ts')
const { checkConformance, controllerContractsForRoute, loginContract, registeredThemeDocuments } = await import('../apps/web/src/themes/contract.ts')
const { ROUTE_HOOKS: previousRoutes, SURFACE_HOOKS: previousSurfaces } = await import('../apps/web/src/themes/route-hooks.ts')
const { defaultPlan } = await import('../packages/core/src/index.ts')
const { AUTHORITATIVE_CONTROLLER_DECLARATIONS } = await import('../apps/web/src/themes/controller-hooks.ts')

const OUTPUT = fileURLToPath(new URL('../apps/web/src/themes/route-hooks.ts', import.meta.url))
const HOOK_NAME = /^(?:data-[a-z0-9]+(?:-[a-z0-9]+)*|name|role)$/
const ID = /^[\w-]+$/

// Qualified route observations use synthetic identity and explicit positive data when the controller requires it.
const qualified = tools.map(tool => tool.status === 'out-of-scope' ? tool : ({
  ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Route hook registry generation only.', evidence: [] },
}))
const principals = {
  xwhm: { kind: 'root', id: '33333333-3333-4333-8333-333333333333', username: 'registryroot' },
  xpanel: { kind: 'user', id: '11111111-1111-4111-8111-111111111111', username: 'registryuser', accountId: '11111111-1111-4111-8111-111111111111' },
  xmail: { kind: 'user', id: '11111111-1111-4111-8111-111111111111', username: 'registryuser', accountId: '11111111-1111-4111-8111-111111111111' },
}
// Explicit synthetic identities; route-specific positive states add only their required observations.
const identity = {
  xwhm: {},
  xpanel: { panel: {
    account: {
      id: '11111111-1111-4111-8111-111111111111', username: 'registryuser', uid: 2000, gid: 2000, home: '/home/registryuser', primaryDomain: 'example.test',
      planId: '22222222-2222-4222-8222-222222222222', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'registryuser@example.test',
      ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-01-01T00:00:00.000Z',
    },
    plan: defaultPlan({ id: '22222222-2222-4222-8222-222222222222', name: 'Registry plan' }),
  } },
  xmail: { mail: { mailbox: 'registryuser@example.test', domain: 'example.test' } },
}

// Explicit synthetic primary domain for the positive SSL state; no native operation is executed.
const sslDomain = {
  id: '44444444-4444-4444-8444-444444444444', accountId: identity.xpanel.panel.account.id,
  name: identity.xpanel.panel.account.primaryDomain, kind: 'primary', parentId: null,
  docRoot: identity.xpanel.panel.account.home + '/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
}

/** What controller code selects or reads: attribute names, exact name=value pairs and element ids. */
function controllerReferences(js) {
  const names = new Set(), pairs = new Set(), ids = new Set()
  for (const m of js.matchAll(/\[(data-[a-z0-9-]+|name|role)(?:\s*([~|^$*]?=)\s*\\?["']?([^"'\]\\]*)\\?["']?)?\s*\]/g)) {
    if (m[2] === '=') pairs.add(`${m[1]}=${m[3]}`)
    else names.add(m[1])
  }
  for (const m of js.matchAll(/(?:get|has)Attribute\(\s*['"](data-[a-z0-9-]+|name|role)['"]/g)) names.add(m[1])
  for (const m of js.matchAll(/\.dataset\.([a-zA-Z][a-zA-Z0-9]*)/g)) names.add(`data-${m[1].replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`)
  for (const m of js.matchAll(/getElementById\(\s*['"]([\w-]+)['"]/g)) ids.add(m[1])
  for (const m of js.matchAll(/#([a-z][\w-]*)/g)) ids.add(m[1])
  return { names, pairs, ids }
}

const inlineScripts = html => [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n')
const sorted = values => [...values].sort()

function templateContracts(nodes, scope) {
  return nodes.flatMap((node, index) => {
    if (node.namespace !== 'html' || node.tag !== 'template' || node.template !== scope || !node.attrs.has('data-xp-template')) return []
    const own = nodes.filter(child => child.template === index)
    const slots = sorted(new Set(own.flatMap(child => child.attrs.has('data-xp-slot') ? [child.attrs.get('data-xp-slot')] : [])))
    const actions = sorted(new Set(own.flatMap(child => child.attrs.has('data-xp-action') ? [child.attrs.get('data-xp-action')] : [])))
    const nested = templateContracts(nodes, index)
    return [{ name: node.attrs.get('data-xp-template'), slots, actions, ...(nested.length ? { templates: nested } : {}) }]
  }).sort((a, b) => a.name.localeCompare(b.name))
}

function documentHooks(html, sharedJs) {
  const refs = controllerReferences(`${sharedJs}\n${inlineScripts(html)}`)
  const nodes = parseMarkup(html)
  const hooks = new Set()
  for (const node of nodes) {
    if (node.template >= 0 || node.namespace === 'html' && node.tag === 'template') continue
    for (const [name, value] of node.attrs) {
      if (name === 'id' && refs.ids.has(value) && ID.test(value)) hooks.add(`#${value}`)
      if (!HOOK_NAME.test(name)) continue
      if (refs.names.has(name)) hooks.add(`[${name}]`)
      if (!value.includes('"') && refs.pairs.has(`${name}=${value}`)) hooks.add(`[${name}="${value}"]`)
    }
  }
  // Templates count only when a controller looks them up.
  const templates = templateContracts(nodes, -1).filter(t => refs.names.has('data-xp-template') || refs.pairs.has(`data-xp-template=${t.name}`))
  return { hooks, templates }
}

const sharedJs = await serveStaticAsset('/assets/ws-client.js').text()
const live = createInitialLiveEventState()

const generationFailures = []
const login = {}, loginDisabled = {}
for (const audience of ['xpanel', 'xwhm', 'xmail'])
  {
    const enabledHtml = renderWebApp({ surface: 'login', locale: 'en', theme: 'light', login: { audience } })
    const disabledHtml = renderWebApp({ surface: 'login', locale: 'en', theme: 'light', mfaRuntimeMode: 'disabled', login: { audience } })
    for (const html of [enabledHtml, disabledHtml]) {
      const issues = checkConformance(html, loginContract(audience))
      if (issues.length) generationFailures.push({ route: `/login:${audience}`, issues })
    }
    login[audience] = sorted(documentHooks(enabledHtml, sharedJs).hooks)
    loginDisabled[audience] = sorted(documentHooks(disabledHtml, sharedJs).hooks)
  }

const pages = registeredThemeDocuments().map(page => {
  const renderState = {
    surface: page.surface, activeRoute: page.route, locale: 'en', theme: 'light', catalog: qualified, liveState: live,
    visibility: { principal: principals[page.surface], disabledFeatures: new Set() }, ...identity[page.surface],
    ...(['/security/ssl', '/email/forwarders'].includes(page.route) ? { panel: { ...identity.xpanel.panel, domains: [sslDomain] } } : {}),
    ...(page.route === '/whm/email/outbound' ? { whm: { mailIpConfig: { mode: 'server-default', defaultIpv4: null, defaultIpv6: null, defaultHelo: null, domainOverrides: [] } } } : {}),
  }
  // Same ownership filter as extensions/account-pages.ts; never infer domains from primaryDomain.
  const accountDomains = (renderState.panel?.domains ?? []).filter(domain => domain.accountId === renderState.panel.account.id)
  const contextFacts = { 'account-domains': accountDomains.length ? 'present' : 'absent' }
  const html = renderWebApp(renderState)
  const unavailable = html.includes('data-tool-availability="unverified"')
  const previous = previousRoutes[page.route]
  // A missing mandatory control cannot disappear merely because the renderer omitted it.
  const required = {
    authoritativeControllers: AUTHORITATIVE_CONTROLLER_DECLARATIONS,
    context: { route: page.route, surface: page.surface, qualified: !unavailable, facts: contextFacts },
    hooks: [
      ...(previous ? (previous.unavailable ? previous.hooks : [...previousSurfaces[page.surface], ...previous.hooks]) : []),
      ...(page.route === '/whm/email/outbound' ? ['[data-mail-ip-config-form]'] : []),
    ],
    ...(previous?.templates ? { templates: previous.templates } : {}),
    ...(unavailable ? {} : { controllers: controllerContractsForRoute(page.route) }),
  }
  const issues = checkConformance(html, required)
  if (issues.length) generationFailures.push({ route: page.route, issues })
  return { surface: page.surface, route: page.route, unavailable, ...documentHooks(html, sharedJs) }
})

if (generationFailures.length) throw new Error(`Cannot regenerate incomplete contracts: ${JSON.stringify(generationFailures)}`)

const surfaces = {}
for (const kind of ['xpanel', 'xwhm', 'xmail']) {
  const own = pages.filter(page => page.surface === kind && !page.unavailable)
  surfaces[kind] = sorted([...(own[0]?.hooks ?? new Set())].filter(hook => own.every(page => page.hooks.has(hook))))
}

const quote = value => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const list = values => `[${values.map(quote).join(', ')}]`
const lines = [
  '// Generated document observations; required controller contracts are declared independently in contract.ts.',
  '// Regenerate with `node scripts/generate-theme-route-hooks.mjs` after reviewed controller/renderer changes.',
  '// The generator refuses to silently delete previously recorded hooks or templates.',
  '',
  "import type { HookSelector } from './markup.ts'",
  "import type { RouteHooks, ThemeSurface } from './contract.ts'",
  '',
  "export const LOGIN_HOOKS: Readonly<Record<'xpanel' | 'xwhm' | 'xmail', readonly HookSelector[]>> = {",
  ...Object.entries(login).map(([audience, hooks]) => `  ${audience}: ${list(hooks)},`),
  '}',
  '',
  "export const LOGIN_DISABLED_HOOKS: Readonly<Record<'xpanel' | 'xwhm' | 'xmail', readonly HookSelector[]>> = {",
  ...Object.entries(loginDisabled).map(([audience, hooks]) => `  ${audience}: ${list(hooks)},`),
  '}',
  '',
  'export const SURFACE_HOOKS: Readonly<Record<ThemeSurface, readonly HookSelector[]>> = {',
  ...Object.entries(surfaces).map(([kind, hooks]) => `  ${kind}: ${list(hooks)},`),
  '}',
  '',
  'export const ROUTE_HOOKS: Readonly<Record<string, RouteHooks>> = {',
  ...pages.map(page => {
    const shared = new Set(page.unavailable ? [] : surfaces[page.surface])
    const hooks = sorted([...page.hooks].filter(hook => !shared.has(hook)))
    return `  ${quote(page.route)}: { ${page.unavailable ? 'unavailable: true, ' : ''}hooks: ${list(hooks)}${page.templates.length ? `, templates: ${JSON.stringify(page.templates)}` : ''} },`
  }),
  '}',
  '',
]
const text = lines.join('\n')

if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') } catch {}
  if (current !== text) {
    console.error('apps/web/src/themes/route-hooks.ts is stale: run node scripts/generate-theme-route-hooks.mjs')
    process.exit(1)
  }
  console.log(`route hooks current: ${pages.length} documents`)
} else {
  writeFileSync(OUTPUT, text)
  console.log(`wrote ${pages.length} documents, ${pages.reduce((sum, page) => sum + page.hooks.size, 0)} document hooks`)
}
