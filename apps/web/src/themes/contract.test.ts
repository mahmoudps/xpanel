import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { navigation, registeredDocumentAliases, tools, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { defaultPlan, type Domain, type MailIpConfig } from '@xpanel/core'
import { renderWebApp } from '../app.ts'
import { createInitialLiveEventState } from '../ws-client.ts'
import { checkConformance, controllerContractsForRoute, loginContract, matchesHook, parseMarkup, registeredThemeDocuments, REVERSE_PROXY_CONTROLLER, routeContracts } from './contract.ts'
import { renderAccountReverseProxyWorkspace } from '../board-port/account-reverse-proxy-workspace.ts'
import { ROUTE_HOOKS, SURFACE_HOOKS } from './route-hooks.ts'
import { AUTHORITATIVE_CONTROLLER_DECLARATIONS } from './controller-hooks.ts'
import { renderAccountForwarders } from '../board-port/extensions/account-forwarders.ts'
import { renderAccountDbEngineWorkspace } from '../board-port/db-engines-workspace.ts'

describe('parseMarkup', () => {
  it('records nesting, attributes and template ancestry', () => {
    const nodes = parseMarkup('<main id="m"><template data-xp-template="row"><li data-xp-slot="name"><b>x</b></li></template><p data-a=\'1\' data-b=2 hidden></p></main>')
    expect(nodes.map(node => node.tag)).toEqual(['main', 'template', 'li', 'b', 'p'])
    expect(nodes[2]).toMatchObject({ parent: 1, template: 1 })
    expect(nodes[3]).toMatchObject({ parent: 2, template: 1 })
    expect(nodes[4]).toMatchObject({ parent: 0, template: -1 })
    expect([...nodes[4]!.attrs]).toEqual([['data-a', '1'], ['data-b', '2'], ['hidden', '']])
  })

  it('skips script, style and comment contents, keeps void elements flat and decodes values', () => {
    const nodes = parseMarkup('<!-- <i data-x> --><script>const s = "<div data-fake>"</script><style>[data-y]{}</style><input data-v="a&amp;b"><span></span>')
    expect(nodes.map(node => node.tag)).toEqual(['script', 'style', 'input', 'span'])
    expect(nodes[3]!.parent).toBe(-1)
    expect(nodes[2]!.attrs.get('data-v')).toBe('a&b')
  })
})

describe('matchesHook', () => {
  const [node] = parseMarkup('<button id="go" data-action="logout" data-ready>')
  it('matches names, exact values and ids', () => {
    expect(matchesHook(node!, '[data-ready]')).toBe(true)
    expect(matchesHook(node!, '[data-action="logout"]')).toBe(true)
    expect(matchesHook(node!, '[data-action="open-cmdk"]')).toBe(false)
    expect(matchesHook(node!, '#go')).toBe(true)
    const [field] = parseMarkup('<input name="password" role="textbox">')
    expect(matchesHook(field!, '[name="password"]')).toBe(true)
    expect(matchesHook(field!, '[role="textbox"]')).toBe(true)
  })
  it('rejects selectors outside the hook grammar', () => {
    expect(() => matchesHook(node!, '[data-a] [data-b]' as '[data-a]')).toThrow(/Unsupported/)
  })
})

describe('checkConformance', () => {
  const requirement = {
    hooks: ['[data-list]', '#main-content'] as const,
    templates: [{ name: 'log-entry', slots: ['time', 'message', 'details'], actions: ['expand'], templates: [{ name: 'log-fact', slots: ['label', 'value'], actions: [] }] }],
  }
  const entry = (inner: string) => `<template data-xp-template="log-entry"><li><time data-xp-slot="time"></time><p data-xp-slot="message"></p><button data-xp-action="expand"></button><dl data-xp-slot="details"></dl>${inner}</li></template>`

  it('passes a complete document', () => {
    const html = `<main id="main-content"><ul data-list></ul>${entry('<template data-xp-template="log-fact"><dt data-xp-slot="label"></dt><dd data-xp-slot="value"></dd></template>')}</main>`
    expect(checkConformance(html, requirement)).toEqual([])
  })

  it('names each missing hook, template, slot and action', () => {
    const html = `<main><template data-xp-template="x"><i data-list></i></template><template data-xp-template="log-entry"><li><time data-xp-slot="time"></time></li></template></main>`
    expect(checkConformance(html, requirement)).toEqual([
      { kind: 'hook', name: '[data-list]' },
      { kind: 'hook', name: '#main-content' },
      { kind: 'slot', name: 'message', template: 'log-entry' },
      { kind: 'slot', name: 'details', template: 'log-entry' },
      { kind: 'action', name: 'expand', template: 'log-entry' },
      { kind: 'template', name: 'log-fact', template: 'log-entry' },
    ])
  })

  it('requires HTML controls and HTML templates while accepting controls in SVG foreignObject', () => {
    const control = { hooks: [], elements: [{ hook: '[data-control]' as const, tag: 'button' }] }
    expect(checkConformance('<svg><button data-control></button></svg>', control)).toEqual([{ kind: 'element', name: '[data-control]' }])
    expect(checkConformance('<svg><foreignObject><button data-control></button></foreignObject></svg>', control)).toEqual([])
    expect(checkConformance('<svg><template data-xp-template="row"><path data-xp-slot="label" /></template></svg>', { hooks: [], templates: [{ name: 'row', slots: ['label'], actions: [] }] })).toEqual([{ kind: 'template', name: 'row' }])
  })

  it('requires a nested template inside its parent and checks every copy', () => {
    const fact = '<template data-xp-template="log-fact"><dt data-xp-slot="label"></dt><dd data-xp-slot="value"></dd></template>'
    const outside = `<main id="main-content" data-list>${entry('')}${fact}</main>`
    expect(checkConformance(outside, requirement)).toEqual([{ kind: 'template', name: 'log-fact', template: 'log-entry' }])
    const brokenCopy = `<main id="main-content" data-list>${entry(fact)}${entry('<template data-xp-template="log-fact"><dt data-xp-slot="label"></dt></template>')}</main>`
    expect(checkConformance(brokenCopy, requirement)).toEqual([{ kind: 'slot', name: 'value', template: 'log-fact' }])
  })
})

describe('route registry', () => {
  it('has one entry per registered page and no stale entries', () => {
    const canonical = navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
    const routes = [...canonical, ...registeredDocumentAliases.map(alias => alias.route)]
    expect(canonical).toHaveLength(203)
    expect(routes).toHaveLength(217)
    expect(Object.keys(ROUTE_HOOKS).sort()).toEqual([...routes].sort())
    expect(routeContracts().map(contract => contract.route)).toEqual(routes)
  })

  it('adds the surface hooks to operational pages only', () => {
    const contracts = routeContracts()
    const unavailable = contracts.filter(contract => contract.unavailable)
    expect(unavailable.length).toBeGreaterThan(0)
    for (const contract of unavailable) expect(contract.hooks).toEqual(ROUTE_HOOKS[contract.route]!.hooks)
    const logs = contracts.find(contract => contract.route === '/whm/monitoring/logs')!
    expect(logs).toMatchObject({ surface: 'xwhm', template: 'log' })
    expect(logs.hooks).toEqual(expect.arrayContaining([...SURFACE_HOOKS.xwhm, '[data-whm-monitoring]']))
  })
})

describe('required controller contracts', () => {
  const proxy = () => renderAccountReverseProxyWorkspace({
    lang: 'en', accountId: '11111111-1111-4111-8111-111111111111', home: '/home/contractuser', canManage: true,
  })
  const required = { hooks: [], controllers: controllerContractsForRoute('/domains/reverse-proxy') }
  const keys = ['status', 'rows', 'application', 'refresh', 'mode', 'upstream', 'upstream-field', 'error', 'save', 'cancel', 'selected', 'current', 'root', 'options', 'websocket', 'host', 'header-rows', 'add-header', 'headers-error']

  it('covers every control selected by the reverse proxy controller, including concatenated selectors', () => {
    const source = readFileSync(new URL('../account-reverse-proxy-client.ts', import.meta.url), 'utf8')
    const selected = [...source.matchAll(/\bfind(?:<[^>]+>)?\('([^']+)'\)/g)].map(match => `[data-rp-${match[1]}]`)
    expect(new Set(selected)).toEqual(new Set(REVERSE_PROXY_CONTROLLER.hooks))
    expect(selected).toHaveLength(19)
    expect(checkConformance(proxy(), required)).toEqual([])
  })

  it.each(keys)('detects a missing required %s control even when regeneration could omit it', key => {
    const missing = proxy().replace(new RegExp(`\\bdata-rp-${key}(?=[\\s=>])`), 'data-omitted-control')
    expect(checkConformance(missing, required).some(issue => issue.name === `[data-rp-${key}]`)).toBe(true)
  })

  it('requires a control inside the controller root rather than accepting an unrelated global hook', () => {
    const html = proxy().replace('data-rp-save', 'data-omitted-save') + '<button type="button" data-rp-save></button>'
    expect(checkConformance(html, required)).toContainEqual({ kind: 'hook', name: '[data-rp-save]', controller: 'account-reverse-proxy' })
  })

  it('checks semantic control types instead of accepting a same-named non-control', () => {
    const html = proxy().replace(/<select(?=[^>]*data-rp-mode)[^>]*>[\s\S]*?<\/select>/, '<span data-rp-mode></span>')
    expect(checkConformance(html, required)).toContainEqual({ kind: 'element', name: '[data-rp-mode]', controller: 'account-reverse-proxy' })
  })
})

describe('classic conforms to every registered document contract', () => {
  const catalog: CatalogTool[] = tools.map(tool => tool.status === 'out-of-scope' ? tool : ({
    ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Conformance unit fixture only.', evidence: [] },
  }))
  const accountId = '11111111-1111-4111-8111-111111111111'
  const user = { kind: 'user' as const, id: accountId, username: 'contractuser', accountId }
  const visibility = (principal: VisibilityContext['principal']): VisibilityContext => ({ principal, disabledFeatures: new Set() })
  const live = createInitialLiveEventState()
  const account = {
    id: accountId, username: 'contractuser', uid: 2000, gid: 2000, home: '/home/contractuser', primaryDomain: 'example.test', planId: '22222222-2222-4222-8222-222222222222', ownerId: null,
    status: 'active' as const, suspendReason: null, contactEmail: 'contractuser@example.test', ipv4: '192.0.2.10', shell: 'none' as const, createdAt: '2026-01-01T00:00:00.000Z',
  }

  const sslDomain: Domain = {
    id: '44444444-4444-4444-8444-444444444444', accountId: account.id, name: account.primaryDomain,
    kind: 'primary', parentId: null, docRoot: account.home + '/public_html', siteType: 'php', upstream: null, redirect: null,
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
    wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
  }

  const mailIpConfig: MailIpConfig = { mode: 'server-default', defaultIpv4: null, defaultIpv6: null, defaultHelo: null, domainOverrides: [] }

  it.each(registeredThemeDocuments())('$route', document => {
    const identity = document.surface === 'xwhm'
      ? { visibility: visibility({ kind: 'root', id: '33333333-3333-4333-8333-333333333333', username: 'contractroot' }), ...(document.route === '/whm/email/outbound' ? { whm: { mailIpConfig: mailIpConfig } } : {}) }
      : document.surface === 'xpanel'
        ? { visibility: visibility(user), panel: { account, plan: defaultPlan({ id: '22222222-2222-4222-8222-222222222222', name: 'Basic' }), ...(['/security/ssl', '/email/forwarders'].includes(document.route) ? { domains: [sslDomain] } : {}) } }
        : { visibility: visibility(user), mail: { mailbox: 'contractuser@example.test', domain: 'example.test' } }
    const html = renderWebApp({ ...identity, surface: document.surface, activeRoute: document.route, locale: 'ar', theme: 'dark', catalog, liveState: live })
    const contract = routeContracts().find(item => item.route === document.route)!
    // Mirror the authorized domain filter passed to renderAccountForwarders by account-pages.ts.
    const accountDomains = (identity.panel?.domains ?? []).filter(domain => domain.accountId === identity.panel?.account.id)
    const domainFact: 'present' | 'absent' = accountDomains.length ? 'present' : 'absent'
    expect(checkConformance(html, { ...contract, context: { ...contract.context, facts: { 'account-domains': domainFact } } })).toEqual([])
  })

  const renderWhmState = (route: string, mailConfig?: MailIpConfig) => renderWebApp({
    surface: 'xwhm', activeRoute: route, locale: 'en', catalog, liveState: live,
    visibility: visibility({ kind: 'root', id: '33333333-3333-4333-8333-333333333333', username: 'contractroot' }),
    ...(mailConfig ? { whm: { mailIpConfig: mailConfig } } : {}),
  })
  const renderPanelState = (route: string) => renderWebApp({
    surface: 'xpanel', activeRoute: route, locale: 'en', catalog, liveState: live,
    visibility: visibility(user), panel: { account, plan: defaultPlan({ id: account.planId, name: 'Basic' }) },
  })
  const controllerStateRequirement = (id: string, route: string, surface: 'xpanel' | 'xwhm' = 'xwhm') => ({
    hooks: [], authoritativeControllers: AUTHORITATIVE_CONTROLLER_DECLARATIONS.filter(item => item.id === id),
    context: { route, surface, qualified: true },
  })

  it('retains direct backup guards independently of the observed hook snapshot', () => {
    const html = renderPanelState('/files/backup')
    const required = controllerStateRequirement('account-backup', '/files/backup', 'xpanel')
    expect(checkConformance(html, required)).toEqual([])
    expect(checkConformance(html.replace('data-account-backup-select disabled', 'data-missing-backup-select disabled'), required)).toContainEqual({ kind: 'hook', name: '[data-account-backup-select]', controller: 'account-backup' })
  })

  it('keeps all 4 source-defined account team role inputs', () => {
    const html = renderPanelState('/preferences/team')
    const required = controllerStateRequirement('acct-team', '/preferences/team', 'xpanel')
    expect(checkConformance(html, required)).toEqual([])
    expect(checkConformance(html.replace('data-acct-team-role aria-describedby=', 'data-missing-team-role aria-describedby='), required)).toContainEqual({ kind: 'controller', name: '[data-acct-team-role]', controller: 'acct-team-role-count', detail: 'Lookup scope count differs' })
  })

  it('requires the source-defined hotlink fields within their feature workspace', () => {
    const html = renderPanelState('/security/hotlink')
    const required = controllerStateRequirement('account-web-field-controls:hotlink', '/security/hotlink', 'xpanel')
    expect(checkConformance(html, required)).toEqual([])
    expect(checkConformance(html.replace('data-wd-field="allowedHosts"', 'data-missing-field="allowedHosts"'), required)).toContainEqual({ kind: 'hook', name: '[data-wd-field="allowedHosts"]', controller: 'account-web-field-controls:hotlink' })
  })

  it('distinguishes PostgreSQL managed forms from the disabled read-only groups', () => {
    const declarations = AUTHORITATIVE_CONTROLLER_DECLARATIONS.filter(item => item.id === 'db-engines')
    const required = { hooks: [], authoritativeControllers: declarations, context: { route: '/databases/postgresql', surface: 'xpanel' as const, qualified: true } }
    const input = { page: 'postgresql' as const, lang: 'en' as const, accountId, username: account.username }
    const managed = renderAccountDbEngineWorkspace({ ...input, canManage: true })
    const readOnly = renderAccountDbEngineWorkspace({ ...input, canManage: false })
    expect(checkConformance(managed, required)).toEqual([])
    expect(checkConformance(readOnly, required)).toEqual([])
    expect(checkConformance(managed.replace('<form data-db-pg-form="database"', '<div data-db-pg-form="database"'), required).some(issue => issue.kind === 'controller' || issue.kind === 'element')).toBe(true)
    expect(checkConformance(readOnly.replace('name="owner" dir="ltr" disabled', 'name="owner" dir="ltr"'), required)).toContainEqual({ kind: 'element', name: '[name="owner"]', controller: 'db-engines:variants:1', detail: 'Selected control semantics differ' })
  })

  it('requires numeric thresholds only for the 7 threshold-bearing alert rules and all 10 checkboxes', () => {
    const html = renderWhmState('/whm/monitoring/alerts')
    const required = controllerStateRequirement('whm-monitoring-alerts-dynamic-119', '/whm/monitoring/alerts')
    expect(html.match(/data-whm-alerts-threshold\b/g)).toHaveLength(7)
    expect(html.match(/data-whm-alerts-enabled\b/g)).toHaveLength(10)
    expect(checkConformance(html, required)).toEqual([])
    expect(checkConformance(html.replace('data-whm-alerts-threshold', 'data-missing-threshold'), required)).toContainEqual({ kind: 'hook', name: '[data-whm-alerts-threshold]', controller: 'whm-monitoring-alerts-dynamic-119' })
    expect(checkConformance(html.replace('data-whm-alerts-enabled', 'data-missing-enabled'), required)).toContainEqual({ kind: 'hook', name: '[data-whm-alerts-enabled]', controller: 'whm-monitoring-alerts-dynamic-119' })
  })

  it('keeps the module-only PHP fact mandatory on modules while accepting the runtime page', () => {
    const modules = renderWhmState('/whm/software/modules')
    const required = controllerStateRequirement('whm-software-center-forwarded', '/whm/software/modules')
    expect(checkConformance(modules, required)).toEqual([])
    expect(checkConformance(modules.replace('data-sc-php-versions', 'data-missing-php-versions'), required)).toContainEqual({ kind: 'hook', name: '[data-sc-php-versions]', controller: 'whm-software-center-forwarded' })
    expect(checkConformance(renderWhmState('/whm/software/runtimes'), controllerStateRequirement('whm-software-center-forwarded', '/whm/software/runtimes'))).toEqual([])
  })

  it('separates the unavailable outbound state from the positive saved-configuration form', () => {
    const required = controllerStateRequirement('mail-ip-config-fields', '/whm/email/outbound')
    const unavailable = renderWhmState('/whm/email/outbound')
    expect(parseMarkup(unavailable).some(node => node.attrs.has('data-mail-ip-config-form'))).toBe(false)
    expect(checkConformance(unavailable, required)).toEqual([])
    const configured = renderWhmState('/whm/email/outbound', mailIpConfig)
    expect(checkConformance(configured, { ...required, hooks: ['[data-mail-ip-config-form]'] as const })).toEqual([])
    expect(checkConformance(configured.replace('name="defaultHelo"', 'name="missingHelo"'), required)).toContainEqual({ kind: 'hook', name: '[name="defaultHelo"]', controller: 'mail-ip-config-fields' })
  })

  it('requires managed domain forms only for the actual provided domain state', () => {
    const forwarderDeclarations = AUTHORITATIVE_CONTROLLER_DECLARATIONS.filter(item => item.id.startsWith('account-forwarders'))
    const input = { lang: 'en' as const, canManage: true, domains: [{ name: 'example.test' }] }
    const required = {
      hooks: [], authoritativeControllers: forwarderDeclarations,
      context: { route: '/email/forwarders', surface: 'xpanel' as const, qualified: true, facts: { 'account-domains': input.domains.length ? 'present' as const : 'absent' as const } },
    }
    const html = renderAccountForwarders(input)
    expect(checkConformance(html, required)).toEqual([])
    expect(checkConformance(html.replace('data-autoresponder-form class=', 'data-missing-autoresponder-form class='), required)).toContainEqual({ kind: 'hook', name: '[data-autoresponder-form]', controller: 'account-forwarders:variants:1' })
    expect(checkConformance(html.replace('name="address"', 'name="missing-address"'), required)).toContainEqual({ kind: 'hook', name: '[name="address"],[id="address"]', controller: 'autoresponder-edit-named-controls' })
    expect(checkConformance(html.replace('id="forwarder-source" name="source"', 'id="source"'), required)).toEqual([])
    const duplicateSource = html.replace('</form>', '<input name="source" type="email" dir="ltr" maxlength="254"></form>')
    expect(checkConformance(duplicateSource, required)).toContainEqual({ kind: 'controller', name: '[name="source"],[id="source"]', controller: 'forwarder-create-named-controls:named-control:0', detail: 'Lookup scope count differs' })
    const emptyInput = { ...input, domains: [] }
    expect(checkConformance(renderAccountForwarders(emptyInput), { ...required, context: { ...required.context, facts: { 'account-domains': emptyInput.domains.length ? 'present' : 'absent' } } })).toEqual([])
    expect(checkConformance(renderAccountForwarders({ ...input, canManage: false }), { ...required, context: { route: '/email/forwarders', surface: 'xpanel', qualified: true } })).toEqual([])
  })

  it.each(['xpanel', 'xwhm', 'xmail'] as const)('sign-in %s', audience => {
    expect(checkConformance(renderWebApp({ surface: 'login', locale: 'ar', login: { audience } }), loginContract(audience))).toEqual([])
  })

  it.each(['xpanel', 'xwhm', 'xmail'] as const)('development disabled sign-in %s preserves the intentional absence of factor controls', audience => {
    const html = renderWebApp({ surface: 'login', locale: 'en', mfaRuntimeMode: 'disabled', login: { audience } })
    expect(parseMarkup(html).some(node => node.attrs.has('data-auth-mfa-fields'))).toBe(false)
    expect(checkConformance(html, loginContract(audience))).toEqual([])
  })

  it('detects a missing named sign-in field independently of data hooks', () => {
    const html = renderWebApp({ surface: 'login', locale: 'en', login: { audience: 'xwhm' } }).replace('name="password"', 'name="omittedPassword"')
    expect(checkConformance(html, loginContract('xwhm'))).toContainEqual({ kind: 'hook', name: '[name="password"]' })
  })
})

describe('contract boundary', () => {
  const modules = ['contract.ts', 'markup.ts', 'route-hooks.ts', 'controller-hooks.ts', 'controller-conformance.ts', 'selector-audit-data.ts']
  it.each(modules)('%s imports only peer core-contract modules', file => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map(match => match[1]!)
    expect(specifiers.filter(specifier => specifier.startsWith('./') && !modules.includes(specifier.slice(2)))).toEqual([])
  })
})
