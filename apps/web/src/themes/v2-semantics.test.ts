import { describe, expect, it } from 'vitest'
import type { Account, Domain } from '@xpanel/core'
import { renderV2PanelTraffic } from './v2/pages/xpanel/observations/traffic.ts'
import { renderV2PanelWebStatistics } from './v2/pages/xpanel/observations/web-stats.ts'
import { WEB_STATS_FIXTURE } from '../../../../tests/fixtures/web-stats-view.ts'
import { routeContracts, checkConformance, parseMarkup } from './contract.ts'
import { checkControllerDeclarations } from './controller-conformance.ts'
import { V2_STATEFUL_OBSERVATION_COUNTERPARTS, V2_HOME_OBSERVATION_HOOKS, V2_OBSERVATION_COUNTERPARTS, V2_SHARED_CHROME_REQUIREMENTS, V2_WEB_STATS_REQUIREMENT, checkV2Conformance, v2RouteContracts } from './v2-semantics.ts'
import { renderV2Shell } from './v2/shell/shell.ts'
import { v2Messages } from './v2/messages.ts'
import { v2ConformanceCopy } from './v2/conformance-copy.ts'
import { v2WhmClientTemplates } from './v2/whm-client-templates.ts'
import { renderV2BackupsPage } from './v2/pages/xwhm/lifecycle/backups.ts'

const documentFor = (locale: 'en' | 'ar', realtimeEnabled: boolean): string => '<!doctype html><html lang="' + locale + '" dir="' + (locale === 'ar' ? 'rtl' : 'ltr') + '" data-ui-theme="v2" data-theme="light" data-surface="xpanel"><body>'
  + renderV2Shell(v2Messages.translator(locale), { surface: 'xpanel', activeRoute: '/home', homeHref: '/home', realtimeEnabled,
    languages: [], scheme: { current: 'light', toggleHref: '/home?theme=dark' }, account: { signedIn: true, username: 'alice' }, contentHtml: '<h1>Workspace</h1>' }) + '</body></html>'
const statusIssues = (html: string) => checkV2Conformance(html, { hooks: [], authoritativeControllers: V2_SHARED_CHROME_REQUIREMENTS, context: { route: '/home', surface: 'xpanel', qualified: true } })

describe('explicit V2 semantic counterparts', () => {
  it.each(['en', 'ar'] as const)('accepts real %s shared chrome with observed-or-unavailable live states', locale => {
    for (const realtime of [false, true]) expect(statusIssues(documentFor(locale, realtime))).toEqual([])
  })
  it.each([
    ['wrong role', 'role="status"', 'role="presentation"'],
    ['unknown live state', 'data-ws-indicator="disconnected"', 'data-ws-indicator="verified"'],
    ['hidden live control', 'data-ws-indicator="disconnected"', 'hidden data-ws-indicator="disconnected"'],
    ['inert live control', 'data-ws-indicator="disconnected"', 'inert data-ws-indicator="disconnected"'],
    ['missing connected label', 'data-ws-label="connected"', 'data-ws-label="not-connected"'],
    ['missing unavailable label', 'data-ws-label="unavailable"', 'data-ws-label="not-unavailable"'],
    ['wrong theme', 'data-ui-theme="v2"', 'data-ui-theme="classic"'],
    ['empty visible label', '>Connecting</span>', '></span>'],
    ['whitespace visible label', '>Connecting</span>', '>   </span>'],
    ['hidden toolbar ancestor', '<div class="v2-tools__content">', '<div class="v2-tools__content" hidden>'],
    ['inert toolbar ancestor', '<div class="v2-tools__content">', '<div class="v2-tools__content" inert>'],
  ])('rejects %s without a dummy marker', (_name, before, after) => {
    const html = documentFor('en', true)
    expect(html).toContain(before)
    expect(statusIssues(html.replace(before, after)).length).toBeGreaterThan(0)
  })

  it('rejects a duplicate live control and comment text that cannot replace an empty real label', () => {
    const html = documentFor('en', true)
    const duplicate = '<span data-ws-indicator="disconnected" role="status"><span data-ws-label="connected">Live</span><span data-ws-label="disconnected">Connecting</span><span data-ws-label="unavailable">Live updates off</span></span>'
    expect(statusIssues(html.replace('</header>', duplicate + '</header>')).length).toBeGreaterThan(0)
    expect(statusIssues(html.replace('>Connecting</span>', '></span><!--<span data-ws-label="disconnected">Connecting</span>-->')).length).toBeGreaterThan(0)
  })
  it('accepts unknown mail totals and rejects malformed or impossible known counts', () => {
    const frame = documentFor('en', true).replace('data-surface="xpanel"', 'data-surface="xmail"')
    const body = (loaded: string, total?: string) => '<div data-mail-folder-workspace><span data-mail-pager data-loaded="' + loaded + '" data-rest="Latest loaded messages"' + (total === undefined ? '' : ' data-total="' + total + '"') + '>Latest loaded messages</span></div>'
    const check = (loaded: string, total?: string) => checkV2Conformance(frame.replace('</main>', body(loaded, total) + '</main>'), { hooks: [], authoritativeControllers: V2_SHARED_CHROME_REQUIREMENTS, context: { route: '/mail/inbox', surface: 'xmail', qualified: true } })
    expect(check('0')).toEqual([])
    expect(check('0', '0')).toEqual([])
    expect(check('1', '3')).toEqual([])
    const invalidCounts: readonly (readonly [string,string])[] = [['1','0'],['1','-1'],['1','unknown'],['NaN','3']]
    for (const [loaded,total] of invalidCounts) expect(check(loaded,total).length).toBeGreaterThan(0)
  })
  it('keeps Classic output and all independent controllers/templates while changing only enumerated observations', () => {
    const before = routeContracts(), adapted = v2RouteContracts()
    expect(routeContracts()).toEqual(before)
    expect(adapted.map(item => item.route)).toEqual(before.map(item => item.route))
    for (const original of before) {
      const next = adapted.find(item => item.route === original.route)
      if (!next) throw new Error('Missing V2 route')
      const removed = original.hooks.filter(hook => !next.hooks.includes(hook))
      expect(removed.every(hook => hook === '[data-status]' || hook === '[data-wiring="soon"]' || hook === '[data-wiring="unavailable"]' || original.route === '/home' && V2_HOME_OBSERVATION_HOOKS.includes(hook) || original.route === '/software/htaccess' && ['[data-auth-error]', '[data-auth-status]'].includes(hook) || ['/mail/inbox', '/mail/sent', '/mail/drafts', '/mail/trash'].includes(original.route) && hook === '[data-total]' || original.route === '/whm/security/ssh' && hook === '[data-server-settings-form]' || original.route === '/whm/software/php' && hook === '[data-php-extension-draft-grid]' || ['/whm/accounts/bandwidth','/whm/server/networking'].includes(original.route) && hook === '[data-numeric]' || original.route === '/whm/server/terminal' && hook === '[data-tone]' || original.route === '/whm/panel/data' && hook === '[data-xp-slot]' || ['/whm/backups','/whm/backups/restore'].includes(original.route) && ['[data-account-backups]','[data-backup-local-read]','[data-backup-destination-rows]','[data-backup-sftp-status]'].includes(hook))).toBe(true)
      expect(next.controllers).toEqual(original.controllers)
      expect(next.templates).toEqual(original.templates)
      const prefix=next.authoritativeControllers?.slice(0,original.authoritativeControllers?.length)
      if(['/whm/backups','/whm/backups/restore'].includes(original.route)) {
        for(const old of original.authoritativeControllers??[]) if(!Object.keys(expectedBackupArms).includes(old.id) && old.id!=='whm-backups-forwarded') expect(prefix?.find(item=>item.id===old.id)).toEqual(old)
      } else expect(prefix).toEqual(original.authoritativeControllers)
    }
  })
  it('keeps the real Home announcement gaps visible to the same checker', () => {
    for (const route of ['/home']) {
      const original = routeContracts().find(item => item.route === route)
      const adapted = v2RouteContracts().find(item => item.route === route)
      if (!original || !adapted) throw new Error('Missing preserved route')
      const originalIssues = checkConformance('<html></html>', original)
      const nextIssues = checkConformance('<html></html>', adapted)
      for (const issue of originalIssues.filter(issue => !(issue.kind === 'hook' && issue.controller === undefined && (issue.name === '[data-status]' || route === '/home' && V2_HOME_OBSERVATION_HOOKS.some(hook => hook === issue.name))))) expect(nextIssues).toContainEqual(issue)
    }
  })
  it('requires the actual unavailable installer and disabled actions instead of a wiring label', () => {
    const counterpart = V2_OBSERVATION_COUNTERPARTS.find(item => item.route === '/whm/software/store')
    if (!counterpart) throw new Error('Missing installer counterpart')
    const html = '<section data-store-workspace data-whm-detail-route="/whm/software/store"><p role="status" data-installer-state="unavailable">Installer unavailable</p><dl><dd data-store-fact="catalog">Not read</dd></dl><button type="button" disabled>Install</button></section>'
    const check = (value: string) => checkControllerDeclarations(parseMarkup(value), [counterpart.requirement], { route: counterpart.route, surface: 'xwhm', qualified: true })
    expect(check(html)).toEqual([])
    expect(check(html.replace('data-installer-state="unavailable"', 'data-wiring="unavailable"')).length).toBeGreaterThan(0)
    expect(check(html.replace(' disabled', '')).length).toBeGreaterThan(0)
  })
  it.each(['en', 'ar'] as const)('binds the web statistics selection, days and engines and keeps the report selection GET-only (%s)', locale => {
    const route = '/metrics/web-stats'
    const html = renderV2PanelWebStatistics({ locale, account: WEB_STATS_FIXTURE.account, webStats: WEB_STATS_FIXTURE.view }, { canRead: true, canManage: false })
    const check = (value: string) => checkControllerDeclarations(parseMarkup(value), [V2_WEB_STATS_REQUIREMENT], { route, surface: 'xpanel', qualified: true })
    expect(check(html)).toEqual([])
    expect(html).toContain('data-chart-state="loaded"')
    for (const name of ['selection', 'days', 'engines']) expect(check(html.replace(`id="v2-web-stats-${name}-heading"`, 'id="missing"'))).not.toEqual([])
    expect(check(html.replace('method="get"', 'method="post"'))).not.toEqual([])
    expect(check(html.replace('data-chart-state="loaded"', 'data-chart-state="verified"'))).not.toEqual([])
  })
  it.each([
    { route: '/metrics/traffic', locale: 'en' }, { route: '/metrics/traffic', locale: 'ar' },
  ] as const)('binds the real labelled analytics cards and GET-only selection for $route ($locale)', ({ route, locale }) => {
    const counterpart = V2_OBSERVATION_COUNTERPARTS.find(item => item.route === route)
    if (!counterpart) throw new Error('Missing analytics counterpart')
    const account: Account = { id: 'analytics-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example', planId: 'plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-10-29T00:00:00Z' }
    const domain: Domain = { id: 'analytics-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 0, processIdleTimeoutSec: 10 } }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }
    const html = renderV2PanelTraffic({ locale, account, domains: [domain] }, { canRead: true, canManage: false, domainSelectionAvailable: true })
    const check = (value: string) => checkControllerDeclarations(parseMarkup(value), [counterpart.requirement], { route, surface: 'xpanel', qualified: true })
    expect(check(html)).toEqual([])
    expect(html).toContain(`method="get" action="${route}"`)
    for (const name of ['selection', 'requests', 'visitors']) {
      const id = `v2-traffic-${name}-heading`
      expect(html).toContain(`aria-labelledby="${id}"`)
      expect(check(html.replace(`id="${id}"`, `id="missing-${id}"`))).not.toEqual([])
      expect(check(html.replace(`aria-labelledby="${id}"`, `aria-labelledby="missing-${id}"`))).not.toEqual([])
    }
    expect(check(html.replace('data-chart-state="unread"', 'data-chart-state="verified"'))).not.toEqual([])
    expect(check(html.replace('method="get"', 'method="post"'))).not.toEqual([])
  })
})

const actualContract = (route: string) => {
  const contract = v2RouteContracts().find(item => item.route === route)
  if (!contract) throw new Error('Missing real route contract: ' + route)
  return contract
}
const fixtureInShell = (body: string, surface: 'xwhm'|'xmail' = 'xwhm') => documentFor('en',true).replace('data-surface="xpanel"','data-surface="' + surface + '"').replace('</main>',body + '</main>')
const focusedIssues = (body: string,route: string,controllers: readonly string[]) => checkV2Conformance(fixtureInShell(body,route.startsWith('/mail/') ? 'xmail' : 'xwhm'),actualContract(route)).filter(issue => issue.controller !== undefined && controllers.includes(issue.controller))
const statefulCounterpart = (route: string) => {
  const item = V2_STATEFUL_OBSERVATION_COUNTERPARTS.find(item => item.route === route)
  if (!item) throw new Error('Missing finite stateful counterpart')
  return item
}
const numericFixtures = [
 {route:'/whm/accounts/bandwidth',root:'data-whm-metering="bandwidth" data-metering-can-read="true"',rows:'data-whm-metering-rows="bandwidth"',refresh:'data-whm-metering-refresh',status:'data-whm-metering-status',columns:8,numeric:[3,4,5,6,7],otherRows:''},
 {route:'/whm/server/networking',root:'data-whm-server-observation="network" data-server-observation-can-read="true"',rows:'data-whm-server-observation-interface-rows',refresh:'data-whm-server-observation-refresh',status:'data-whm-server-observation-status',columns:4,numeric:[2],otherRows:'<table><tbody data-whm-server-observation-pool-rows></tbody><tbody data-whm-server-observation-unpooled-rows></tbody><tbody data-whm-server-observation-route-rows></tbody></table>'},
 {route:'/whm/server/networking',root:'data-whm-server-observation="network" data-server-observation-can-read="true"',rows:'data-whm-server-observation-pool-rows',refresh:'data-whm-server-observation-refresh',status:'data-whm-server-observation-status',columns:5,numeric:[],otherRows:'<table><tbody data-whm-server-observation-interface-rows></tbody><tbody data-whm-server-observation-unpooled-rows></tbody><tbody data-whm-server-observation-route-rows></tbody></table>'},
 {route:'/whm/server/networking',root:'data-whm-server-observation="network" data-server-observation-can-read="true"',rows:'data-whm-server-observation-unpooled-rows',refresh:'data-whm-server-observation-refresh',status:'data-whm-server-observation-status',columns:3,numeric:[2],otherRows:'<table><tbody data-whm-server-observation-interface-rows></tbody><tbody data-whm-server-observation-pool-rows></tbody><tbody data-whm-server-observation-route-rows></tbody></table>'},
 {route:'/whm/server/networking',root:'data-whm-server-observation="network" data-server-observation-can-read="true"',rows:'data-whm-server-observation-route-rows',refresh:'data-whm-server-observation-refresh',status:'data-whm-server-observation-status',columns:6,numeric:[5],otherRows:'<table><tbody data-whm-server-observation-interface-rows></tbody><tbody data-whm-server-observation-pool-rows></tbody><tbody data-whm-server-observation-unpooled-rows></tbody></table>'},
]
describe('V2 source-owned loaded state semantics', () => {
  it('runs mail count negatives with the actual route contract and truthful unknown totals', () => {
    const contract = actualContract('/mail/inbox')
    expect(contract.context?.route).toBe('/mail/inbox')
    const body=(attrs: string) => '<div data-mail-folder-workspace><span data-mail-pager data-rest="Unread" ' + attrs + '>Unread</span></div>'
    const check=(html: string) => focusedIssues(html,'/mail/inbox',['v2-mail-known-count'])
    expect(check(body('data-loaded="0"'))).toEqual([])
    expect(check(body('data-loaded="2" data-total="4"'))).toEqual([])
    expect(check(body('data-loaded="2" data-total="1"'))).toHaveLength(1)
    expect(check(body('data-loaded="unknown"'))).toHaveLength(1)
    expect(check(body('data-loaded="0"').replace('data-mail-folder-workspace','data-unowned-mail'))).toHaveLength(1)
  })
  it.each(numericFixtures)('validates actual loaded numeric cells for $rows', fixture => {
    const counterpart=statefulCounterpart(fixture.route), ids=[counterpart.requirement.id,'v2-numeric-loaded-row']
    const cells=Array.from({length:fixture.columns},(_,index) => fixture.numeric.includes(index) ? '<td data-numeric><bdi dir="ltr">12</bdi></td>' : '<td>Observed</td>').join('')
    const body=(row: string) => '<section ' + fixture.root + '><button type="button" ' + fixture.refresh + '>Read</button><p role="status" data-state="unread" ' + fixture.status + '>Not read</p><table><tbody ' + fixture.rows + '>' + row + '</tbody></table>' + fixture.otherRows + '</section>'
    const check=(value:string) => focusedIssues(value,fixture.route,ids)
    expect(check(body('<tr>' + cells + '</tr>'))).toEqual([])
    expect(check(body('<tr><td colspan="' + fixture.columns + '">Not read</td></tr>'))).toEqual([])
    expect(check(body('<tr>' + cells + '<td>Extra</td></tr>')).length).toBeGreaterThan(0)
    if(fixture.numeric.length) {
      expect(check(body('<tr>' + cells.replace(' data-numeric','') + '</tr>')).length).toBeGreaterThan(0)
      expect(check(body('<tr>' + cells.replace('dir="ltr"','dir="rtl"') + '</tr>')).length).toBeGreaterThan(0)
      expect(check(body('<tr>' + cells.replace('<bdi dir="ltr">12</bdi>','12') + '</tr>') + '<bdi dir="ltr" data-numeric>12</bdi>').length).toBeGreaterThan(0)
    }
  })
  it.each([true,false])('uses actual terminal targets when canUse=%s without an invented initial tone', canUse => {
    const root='<div data-terminal-workspace data-terminal-kind="root" data-terminal-can-use="' + canUse + '">'
    const body=root + '<span data-terminal-pill>No session</span><span data-terminal-exec-pill>Not read</span><p role="status" data-terminal-status data-state="' + (canUse ? 'closed':'unavailable') + '">No session</p></div>'
    const ids=['v2-semantic-terminal-state','v2-terminal-state-ownership'], check=(value:string) => focusedIssues(value,'/whm/server/terminal',ids)
    expect(body).not.toContain('data-tone')
    expect(check(body)).toEqual([])
    expect(check(body.replace('data-terminal-pill','data-wrong-pill'))).not.toEqual([])
    expect(check(body.replace('<span data-terminal-exec-pill>Not read</span>','') + '<span data-terminal-exec-pill>Not read</span>')).not.toEqual([])
    expect(check(body.replace('data-terminal-status','data-wrong-status'))).not.toEqual([])
    if(canUse) expect(check(body.replace('data-state="closed"','data-state="open"'))).toEqual([])
    else expect(check(body.replace('data-state="unavailable"','data-state="open"'))).not.toEqual([])
  })
  const generationNames=['whm-generation-current-active','whm-generation-current-none','whm-generation-row','whm-generation-empty','whm-generation-state-active','whm-generation-state-other','whm-generation-rollback']
  it.each(generationNames)('requires the actual owned typed generation prototype %s', name => {
    const prototypes=v2WhmClientTemplates('panel-data')
    const body='<div data-whm-generations data-generations-editable="false">' + prototypes + '<p data-generations-current><span data-generations-current-label>Not read</span></p><p role="status" data-generations-status>Not read</p><table><tbody data-generation-rows></tbody></table></div>'
    const ids=['v2-semantic-panel-generation-templates','v2-generation-template-ownership'],check=(value:string)=>focusedIssues(value,'/whm/panel/data',ids)
    expect(check(body)).toEqual([])
    const start=prototypes.indexOf('<template data-xp-template="' + name + '"'),end=prototypes.indexOf('</template>',start)
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start)
    const template=prototypes.slice(start,end + '</template>'.length)
    expect(check(body.replace(template,''))).not.toEqual([])
    expect(check(body.replace(template,template + template))).not.toEqual([])
    expect(check(body.replace(template,template.replace('data-xp-slot=','data-wrong-slot=')))).not.toEqual([])
    const tag=name==='whm-generation-row'||name==='whm-generation-empty'?'tr':name==='whm-generation-rollback'?'button':'span'
    const wrongTag=template.replace('<'+tag,'<aside').replace('</'+tag+'></template>','</aside></template>')
    expect(wrongTag).not.toBe(template)
    expect(check(body.replace(template,wrongTag))).not.toEqual([])
  })
  it('checks the PHP switch inside the supported document virtual root', () => {
    const contract=actualContract('/whm/software/php')
    const declaration=contract.authoritativeControllers?.find(item=>item.id==='v2-semantic-php-extension-switch')
    if(!declaration) throw new Error('Missing PHP switch contract')
    const context=contract.context
    if(!context) throw new Error('Missing real PHP contract context')
    expect(declaration.rootSelector).toBe('document')
    const html='<template data-xp-template="whm-php-extension-switch"><label><input type="checkbox" data-xp-slot="input"><span data-xp-slot="state"></span></label></template>'
    expect(checkControllerDeclarations(parseMarkup(html),[declaration],context)).toEqual([])
    expect(checkControllerDeclarations(parseMarkup(html.replace('data-xp-slot="input"','data-wrong-slot="input"')),[declaration],context)).not.toEqual([])
  })
})

const expectedBackupArms: Readonly<Record<string,readonly string[]>>={
  "whm-backups-dynamic-104": [
    "#backup-layout-destination-enabled",
    "#backup-layout-destination-name",
    "#backup-layout-destination-retention",
    "#backup-layout-destination-endpoint",
    "#backup-layout-destination-prefix",
    "#backup-layout-destination-bucket",
    "#backup-layout-destination-region",
    "#backup-layout-destination-user"
  ],
  "whm-backups-dynamic-105": [
    "#backup-layout-destination-kind"
  ],
  "whm-backups-dynamic-106": [
    "[data-backup-action=\"save-destination\"]",
    "[data-backup-action=\"new-destination\"]"
  ],
  "whm-backups-dynamic-371": [
    "[data-backup-action=\"test-sftp\"]"
  ]
}
const backupProfileIssues=(body:string,route:string,locale:'en'|'ar'='en')=>{
  const frame=documentFor(locale,true).replace('data-surface="xpanel"','data-surface="xwhm"').replace('</main>',body+'</main>')
  return checkV2Conformance(frame,actualContract(route),v2ConformanceCopy).filter(issue=>issue.controller!==undefined && (issue.controller.startsWith('v2-backup') || issue.controller.startsWith('v2-semantic-backup') || issue.controller==='v2-semantic-local-archive-unavailable' || Object.keys(expectedBackupArms).includes(issue.controller)))
}
const backupStates: readonly {route:'/whm/backups'|'/whm/backups/restore';locale:'en'|'ar';canRead:boolean;canManage:boolean}[]=[
 {route:'/whm/backups',locale:'en',canRead:true,canManage:true},{route:'/whm/backups',locale:'ar',canRead:true,canManage:true},
 {route:'/whm/backups/restore',locale:'en',canRead:true,canManage:true},{route:'/whm/backups/restore',locale:'ar',canRead:true,canManage:true},
 {route:'/whm/backups',locale:'en',canRead:false,canManage:false},{route:'/whm/backups',locale:'ar',canRead:false,canManage:false},
 {route:'/whm/backups/restore',locale:'en',canRead:false,canManage:false},{route:'/whm/backups/restore',locale:'ar',canRead:false,canManage:false},
]
describe('V2 positively delegated backup contract',()=>{
 it.each(backupStates)('preserves real $route $locale manager and unavailable local layout (manage=$canManage)',state=>{
  const html=renderV2BackupsPage({...state,activeRoute:state.route})
  expect(backupProfileIssues(html,state.route,state.locale)).toEqual([])
  const frame=documentFor(state.locale,true).replace('data-surface="xpanel"','data-surface="xwhm"').replace('</main>',html+'</main>')
  const hasProviderIssue=(issues:ReturnType<typeof checkV2Conformance>)=>issues.some(issue=>issue.controller==='v2-backup-manager-ownership'&&issue.name==='[data-local-archives-unavailable]:theme-provider')
  expect(hasProviderIssue(checkV2Conformance(frame,actualContract(state.route)))).toBe(true)
  expect(hasProviderIssue(checkV2Conformance(frame,actualContract(state.route),()=>v2ConformanceCopy(state.locale==='en'?'ar':'en')))).toBe(true)
  expect(hasProviderIssue(checkV2Conformance(frame,actualContract(state.route),()=>({locale:state.locale,localArchiveWorkflowNotice:''})))).toBe(true)
  for(const value of [1, {}]) {
    const malformed={...v2ConformanceCopy(state.locale)}
    Reflect.set(malformed,'localArchiveWorkflowNotice',value)
    expect(hasProviderIssue(checkV2Conformance(frame,actualContract(state.route),()=>malformed))).toBe(true)
  }
 })
 it.each(Object.keys(expectedBackupArms))('retains every non-destination arm and the original legacy branch for %s',id=>{
  const original=routeContracts().find(item=>item.route==='/whm/backups')?.authoritativeControllers?.find(item=>item.id===id)
  const adapted=actualContract('/whm/backups').authoritativeControllers?.find(item=>item.id===id)
  const removed=expectedBackupArms[id]
  if(!original||!adapted||!removed) throw new Error('Missing exact backup declaration')
  expect(adapted.requiredSelectors).toEqual(original.requiredSelectors?.filter(selector=>!removed.includes(selector)))
  expect(adapted.elements).toEqual(original.elements?.filter(element=>!removed.includes(element.selector)))
  expect(adapted.conditionalRequirements).toEqual([...(original.conditionalRequirements??[]),{rootAttributes:{'data-backup-destination-editor':{not:'manager'}},requiredSelectors:original.requiredSelectors?.filter(selector=>removed.includes(selector)),elements:original.elements?.filter(element=>removed.includes(element.selector))}])
  for(const key of ['rootSelector','rootRequired','applicableRoutes','rootAttributeExclusions','templateScopes'] as const) expect(adapted[key]).toEqual(original[key])
  const legacy=renderV2BackupsPage({locale:'en',canRead:true,canManage:true}).replace('data-backup-destination-editor="manager"','data-backup-destination-editor="legacy"')
  const context=actualContract('/whm/backups').context
  if(!context) throw new Error('Missing real backup context')
  expect(checkControllerDeclarations(parseMarkup(legacy),[adapted],context)).toEqual(checkControllerDeclarations(parseMarkup(legacy),[original],context))
 })
 const corruptions: readonly {name:string;mutate:(html:string)=>string}[]=[
  {name:'missing mandatory mode',mutate:html=>html.replace('data-backup-destination-editor="manager"','data-backup-destination-editor="unknown"')},
  {name:'foreign or duplicate manager',mutate:html=>html+'<section data-whm-backup-destinations data-backup-inline-manager data-destination-sftp-projection data-can-manage="true"></section>'},
  {name:'mismatched manager permission',mutate:html=>html.replace('data-can-manage="true"','data-can-manage="false"')},
  {name:'wrong managed form kind',mutate:html=>html.replace('<form data-destination-form','<div data-destination-form')},
  {name:'wrong credential control',mutate:html=>html.replace('<select id="v2-backup-destination-credential"','<input id="v2-backup-destination-credential"')},
  {name:'missing owned Host/Port group',mutate:html=>html.replace('data-destination-sftp-address','data-wrong-sftp-address')},
  {name:'wrong Port bounds',mutate:html=>html.replace('max="65535"','max="65536"')},
  {name:'missing typed Test action',mutate:html=>html.replace('data-xp-action="test"','data-xp-action="wrong-test"')},
  {name:'missing typed Activate action',mutate:html=>html.replace('data-xp-action="activate"','data-xp-action="wrong-activate"')},
  {name:'enabled local Create',mutate:html=>html.replace(/(<button\b[^>]*data-backup-create[^>]*?) disabled/,'$1')},
  {name:'accidental native local binding',mutate:html=>html.replace('data-local-archives-unavailable','data-local-archives-unavailable data-account-backups')},
  {name:'missing home-only scope warning',mutate:html=>html.replace('data-local-archive-scope-warning','data-missing-scope-warning')},
 ]
 it.each(corruptions)('rejects $name without weakening current native guards',test=>{
  const html=renderV2BackupsPage({locale:'en',canRead:true,canManage:true}),changed=test.mutate(html)
  expect(changed).not.toBe(html)
  expect(backupProfileIssues(changed,'/whm/backups')).not.toEqual([])
 })
 it('keeps every retained schedule, run and restore requirement mandatory', { tags: ['slow'] },()=>{
  const route='/whm/backups',contract=actualContract(route),html=renderV2BackupsPage({locale:'en',canRead:true,canManage:true})
  for(const declaration of contract.authoritativeControllers??[]) if(Object.keys(expectedBackupArms).includes(declaration.id)) for(const selector of declaration.requiredSelectors??[]) {
    let changed=html
    if(selector.startsWith('#')) changed=html.replace('id="'+selector.slice(1)+'"','id="removed-control"')
    else {const match=/^\[data-backup-action="([^"]+)"\]$/.exec(selector);if(!match?.[1]) throw new Error('Unexpected retained control selector');changed=html.replace('data-backup-action="'+match[1]+'"','data-backup-action="removed-control"')}
    expect(changed,selector).not.toBe(html)
    expect(backupProfileIssues(changed,route).some(issue=>issue.controller===declaration.id),selector).toBe(true)
  }
 })
})

describe('V2 delegated backup forwarded status contract',()=>{
 const stateCases:readonly {route:'/whm/backups'|'/whm/backups/restore';locale:'en'|'ar'}[]=[{route:'/whm/backups',locale:'en'},{route:'/whm/backups',locale:'ar'},{route:'/whm/backups/restore',locale:'en'},{route:'/whm/backups/restore',locale:'ar'}]
 it.each(stateCases)('uses the real manager in $route ($locale) while retaining snapshot and restore hooks',({route,locale})=>{
  const contract=actualContract(route),declaration=contract.authoritativeControllers?.find(item=>item.id==='whm-backups-forwarded'),context=contract.context
  if(!declaration||!context) throw new Error('Missing real forwarded backup contract')
  const html=renderV2BackupsPage({locale,activeRoute:route,canRead:true,canManage:true})
  const check=(value:string)=>checkControllerDeclarations(parseMarkup(value),[declaration],context)
  expect(html).not.toContain('data-backup-sftp-status')
  expect(check(html)).toEqual([])
  for(const hook of ['data-backup-snapshot-rows','data-backup-restore-status']){
   const changed=html.replace(hook,'data-missing-forwarded-hook')
   expect(changed).not.toBe(html)
   expect(check(changed)).not.toEqual([])
  }
 })
 it('preserves every forwarded guard and non-SFTP requirement in manager and legacy modes',()=>{
  const route='/whm/backups',before=routeContracts().find(item=>item.route===route)?.authoritativeControllers?.find(item=>item.id==='whm-backups-forwarded'),contract=actualContract(route),after=contract.authoritativeControllers?.find(item=>item.id==='whm-backups-forwarded'),context=contract.context
  if(!before||!after||!context||!before.conditionalRequired||!after.conditionalRequired) throw new Error('Missing exact forwarded backup contract')
  const sftp='[data-backup-sftp-status]',index=before.conditionalRequired.findIndex(arm=>arm.requiredSelectors?.includes(sftp)),oldArm=before.conditionalRequired[index]
  if(index<0||!oldArm||!oldArm.requiredSelectors) throw new Error('Missing exact legacy SFTP arm')
  const {conditionalRequired:beforeArms,...beforeRest}=before,{conditionalRequired:afterArms,...afterRest}=after
  expect(afterRest).toEqual(beforeRest)
  expect(afterArms.slice(0,index)).toEqual(beforeArms.slice(0,index))
  expect(afterArms[index]).toEqual({...oldArm,requiredSelectors:oldArm.requiredSelectors.filter(selector=>selector!==sftp)})
  expect(afterArms[index+1]).toEqual({...oldArm,rootAttributes:{...oldArm.rootAttributes,'data-backup-destination-editor':{not:'manager'}},requiredSelectors:[sftp]})
  expect(afterArms.slice(index+2)).toEqual(beforeArms.slice(index+1))
  const base=renderV2BackupsPage({locale:'en',activeRoute:route,canRead:true,canManage:true})
  for(const mode of ['manager','legacy'])for(const readState of ['unread','denied']){
   const html=base.replace('data-backup-destination-editor="manager"','data-backup-destination-editor="'+mode+'"').replace('data-backup-read-state="unread"','data-backup-read-state="'+readState+'"')
   const issues=checkControllerDeclarations(parseMarkup(html),[after],context)
   expect(issues.some(issue=>issue.name===sftp),mode+':'+readState).toBe(mode==='legacy'&&readState==='unread')
   if(mode==='legacy') expect(issues).toEqual(checkControllerDeclarations(parseMarkup(html),[before],context))
  }
 })
})
