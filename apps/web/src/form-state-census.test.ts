// Form state census: renders every registered document in both themes, read-only (real host, nothing qualified) and
// connected, from one realistic stored state, and lists each live control that renders without a value. The baseline is
// the ratchet of known empty controls (new-entry inputs, client-painted values and open gaps); see the report in the PR.
// Measure: XPANEL_FORM_CENSUS=all prints one ROW line per empty control.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDeliveryCatalog, navigation, registeredDocumentAliases, tools } from '@xpanel/catalog'
import { defaultPlan, type Account, type Domain, type Principal } from '@xpanel/core'
import { renderWebApp, type WebAppRenderState } from './app.ts'
import { parseMarkup, type MarkupNode } from './themes/markup.ts'
import { FRAME_READERS } from './read-only-frame.ts'

const at = '2026-10-22T12:00:00Z'
const plan = { ...defaultPlan({ id: 'census-plan', name: 'Census plan', featureListId: 'census-features' }), shell: 'jailed' as const }
const account: Account = { id: 'census-account', username: 'census', uid: 20042, gid: 20042, home: '/home/census', primaryDomain: 'census.example.test', planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@census.example.test', ipv4: '192.0.2.42', shell: 'jailed', createdAt: at }
const owner: Principal = { kind: 'user', id: 'census-owner', username: account.username, accountId: account.id }
const root: Principal = { kind: 'root', id: 'census-root', username: 'root' }
const domain: Domain = { id: 'census-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: account.home + '/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 } }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }
const mailbox = 'info@census.example.test'
const verified = tools.map(tool => tool.status === 'out-of-scope' ? tool : { ...tool, status: 'verified' as const, delivery: { status: 'verified' as const, reason: 'Census fixture only.', evidence: [] } })
const unqualified = buildDeliveryCatalog([], null)

// What the server hands a read-only document (apps/api/src/main.ts, unqualified branch): bounded saved state only.
const HOST_SUPPLY: Record<'xpanel' | 'xwhm' | 'xmail', readonly string[]> = { xpanel: ['account', 'plan', 'domains'], xwhm: ['principal', 'activeReseller', 'serverSettings', 'accounts', 'plans', 'featureLists', 'resellers', 'domains', 'dnsZones', 'ipPool', 'mailIpConfig'], xmail: ['mailbox'] }
const supplied = <T extends object>(facts: T, surface: 'xpanel' | 'xwhm' | 'xmail', connected: boolean): T =>
  connected ? facts : Object.fromEntries(Object.entries(facts).filter(([key]) => HOST_SUPPLY[surface].includes(key))) as T
const stateFor = (surface: 'xpanel' | 'xwhm' | 'xmail', route: string, uiTheme: string, connected: boolean): WebAppRenderState => ({
  surface, activeRoute: route, uiTheme, locale: 'en', realtimeEnabled: false, accountId: account.id,
  security: { totpEnabled: false }, catalog: connected ? verified : unqualified,
  visibility: { principal: surface === 'xwhm' ? root : owner, disabledFeatures: new Set() },
  ...(surface === 'xwhm' ? { whm: supplied({
    principal: root, activeReseller: null, hostname: 'host.census.example.test', plans: [plan], accounts: [account], domains: [domain],
    dnsZones: [{ id: 'census-zone', accountId: account.id, name: domain.name, serial: 2026102201, records: [{ id: 'census-dns', zone: domain.name, name: '@', type: 'A', ttl: 3600, content: account.ipv4, priority: null }] }],
    featureLists: [{ id: plan.featureListId!, name: 'Census features', ownerId: null, disabled: [] }],
    serverSettings: { hostname: 'host.census.example.test', nameservers: ['ns1.census.example.test', 'ns2.census.example.test'], adminEmail: 'ops@census.example.test', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443,
      nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 65535, multiAccept: false, keepaliveTimeoutSec: 65 },
      apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 } },
    resellers: [{ id: 'census-reseller', username: 'censusreseller', acl: ['list-accounts', 'create-account'], maxAccounts: 10, totalDiskMb: 10240, totalBandwidthMb: 102400, oversell: { disk: false, bandwidth: false }, nameservers: ['ns1.census.example.test'], delegatedIps: [] }],
    ipPool: [{ id: 'census-ip', address: account.ipv4, version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: 'mail.census.example.test', isPrimary: true, notes: '' }],
    mailIpConfig: { mode: 'custom-map', defaultIpv4: account.ipv4, defaultHelo: 'mail.census.example.test', domainOverrides: [] },
    firewallRules: [{ id: 'census-firewall', kind: 'port', action: 'accept', protocol: 'tcp', port: '443', source: null, forwardTo: null, list: null, comment: 'HTTPS', enabled: true }],
    certificates: [{ accountId: account.id, names: [account.primaryDomain], notAfter: '2027-01-01T00:00:00Z' }],
  } as unknown as NonNullable<WebAppRenderState['whm']>, surface, connected) } : {}),
  ...(surface === 'xpanel' ? { panel: supplied({
    account, plan, domains: [domain], activeDomain: domain.name, certificates: [],
    databases: [{ id: 'census-database', accountId: account.id, engine: 'mariadb', name: 'census_data', trashedAt: null }],
    databaseUsers: [{ id: 'census-database-user', accountId: account.id, name: 'census_user', grants: [{ databaseId: 'census-database', privileges: ['SELECT'] }] }],
    serviceUsers: [{ id: 'census-service-user', accountId: account.id, login: mailbox, services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html', passwordHash: '' }],
    dnsRecords: [{ id: 'census-dns', zone: domain.name, name: '@', type: 'A', ttl: 3600, content: account.ipv4, priority: null }],
    files: [],
  } as unknown as NonNullable<WebAppRenderState['panel']>, surface, connected) } : {}),
  ...(surface === 'xmail' ? { mail: supplied({ mailbox, domain: domain.name, quotaUsedMb: 160, quotaLimitMb: 1024, messages: [], sieveRules: [], vacationEnabled: false }, surface, connected) } : {}),
})

interface DocumentCase { surface: 'xpanel' | 'xwhm' | 'xmail'; route: string }
const canonical: DocumentCase[] = navigation.flatMap(surface => surface.surface === 'xpanel' || surface.surface === 'xwhm' || surface.surface === 'xmail'
  ? surface.sections.flatMap(section => section.pages.map(page => ({ surface: surface.surface as DocumentCase['surface'], route: page.route }))) : [])
const documents: DocumentCase[] = [...canonical, ...registeredDocumentAliases.map(alias => ({ surface: canonical.find(page => page.route === alias.parentRoute)!.surface, route: alias.route }))]

const VALUELESS = new Set(['hidden', 'password', 'file', 'search', 'submit', 'button', 'reset', 'image', 'checkbox', 'color', 'range'])
/**
 * Excluded from the census by design: these controllers re-check before every read that the live session transport is the
 * one they started with. That check is a security guard the frame gate cannot keep, so they never read in a read-only frame.
 */
const CENSUS_EXCLUDED: Readonly<Record<string, string>> = Object.freeze({
  'data-account-api-tokens': 'API tokens: the session transport check is a security guard; no read in a read-only frame.',
  'data-account-sessions': 'Sessions: the session transport check is a security guard; no read in a read-only frame.',
})

interface EmptyControl { key: string; tag: string; type: string; label: string; placeholder: string; scope: string; chain: string }
const text = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/** Live, visible form controls that render without a value: no value, no checked radio, a placeholder select or empty text. */
function emptyControls(html: string): EmptyControl[] {
  const nodes = parseMarkup(html)
  const textareas = [...html.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi)].map(match => match[1]!)
  const labels = new Map([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/label>/gi)].map(match => [match[1]!, text(match[2]!)]))
  // Hidden, templated, painted by a frame reader's authorized read (read-only-frame.ts) or excluded above: not a server-rendered empty value.
  const hiddenBy = (index: number): boolean => {
    for (let at = index; at >= 0; at = nodes[at]!.parent) if (nodes[at]!.template >= 0 || nodes[at]!.attrs.has('hidden') || FRAME_READERS.some(name => nodes[at]!.attrs.get(name) === 'true') || Object.keys(CENSUS_EXCLUDED).some(name => nodes[at]!.attrs.has(name))) return true
    return false
  }
  const scopeOf = (index: number): string => {
    for (let at = nodes[index]!.parent; at >= 0; at = nodes[at]!.parent) {
      const hook = [...nodes[at]!.attrs.keys()].find(name => name.startsWith('data-') && !['data-state', 'data-wiring'].includes(name))
      if (hook) return hook + (nodes[at]!.attrs.get(hook) ? '=' + nodes[at]!.attrs.get(hook) : '')
    }
    return ''
  }
  const chainOf = (index: number): string => {
    const names: string[] = []
    for (let at = nodes[index]!.parent; at >= 0; at = nodes[at]!.parent) names.push(...[...nodes[at]!.attrs.keys()].filter(name => name.startsWith('data-')))
    return names.join(' ')
  }
  const keyOf = (node: MarkupNode): string => node.attrs.get('id') ?? node.attrs.get('name')
    ?? [...node.attrs.entries()].filter(([name]) => name.startsWith('data-')).map(([name, value]) => value ? `${name}=${value}` : name)[0] ?? node.attrs.get('aria-label') ?? '?'
  const result: EmptyControl[] = []
  const radios = new Map<string, { checked: boolean; index: number }>()
  let textarea = 0
  nodes.forEach((node, index) => {
    if (node.namespace !== 'html') return
    const content = node.tag === 'textarea' ? textareas[textarea++] ?? '' : ''
    if (hiddenBy(index)) return
    const type = (node.attrs.get('type') ?? 'text').toLowerCase()
    let empty = false
    if (node.tag === 'input' && type === 'radio') {
      const group = node.attrs.get('name') ?? keyOf(node), seen = radios.get(group)
      radios.set(group, { checked: (seen?.checked ?? false) || node.attrs.has('checked'), index: seen?.index ?? index })
      return
    }
    if (node.tag === 'input') empty = !VALUELESS.has(type) && !(node.attrs.get('value') ?? '').trim()
    else if (node.tag === 'textarea') empty = !content.trim()
    else if (node.tag === 'select') {
      const options = nodes.flatMap((option, at) => option.tag === 'option' && option.parent === index || option.tag === 'option' && nodes[option.parent]?.tag === 'optgroup' && nodes[option.parent]!.parent === index ? [at] : [])
      empty = !options.some(at => nodes[at]!.attrs.has('selected')) && (options.length === 0 || !(nodes[options[0]!]!.attrs.get('value') ?? 'x'))
    }
    if (empty) result.push({ key: keyOf(node), tag: node.tag, type: node.tag === 'input' ? type : '', label: labels.get(node.attrs.get('id') ?? '') ?? node.attrs.get('aria-label') ?? '', placeholder: node.attrs.get('placeholder') ?? '', scope: scopeOf(index), chain: chainOf(index) })
  })
  for (const [group, radio] of radios) if (!radio.checked) result.push({ key: group, tag: 'input', type: 'radio', label: '', placeholder: '', scope: scopeOf(radio.index), chain: chainOf(radio.index) })
  return result
}

const VARIANTS = [['classic', false, 'c'], ['classic', true, 'C'], ['v2', false, 'v'], ['v2', true, 'V']] as const
/** One route's empty controls as sorted `key mask` entries; the mask repeats a variant letter once per occurrence. */
function censusEntries(route: string, surface: DocumentCase['surface'], rows?: Array<EmptyControl & { variant: string }>): string[] {
  const masks = new Map<string, string>()
  for (const [theme, connected, letter] of VARIANTS) for (const control of emptyControls(renderWebApp(stateFor(surface, route, theme, connected)))) {
    masks.set(control.key, (masks.get(control.key) ?? '') + letter)
    rows?.push({ ...control, variant: letter })
  }
  return [...masks].map(([key, mask]) => key + ' ' + mask).sort()
}

// The ratchet of known empty controls: a control may leave this list only by showing its value, and nothing new
// may join it unseen. A form that renders a saved setting or product default empty fails here; so does a stale entry.
const baseline = JSON.parse(readFileSync(new URL('./form-state-census.baseline.json', import.meta.url), 'utf8')) as Record<string, string[]>

describe('every form control renders its saved value or real default', { tags: ['feature'] }, () => {
  it('names each excluded controller and keeps it off the frame gate', () => {
    for (const [root, client] of [['data-account-api-tokens', 'account-api-tokens-client.ts'], ['data-account-sessions', 'account-sessions-client.ts']] as const) {
      expect(CENSUS_EXCLUDED[root]).toMatch(/security guard/)
      expect(readFileSync(new URL('./' + client, import.meta.url), 'utf8')).toMatch(/\.xpanelSessionRequest\b/)
    }
  })
  it('covers every registered document in both themes, read-only and connected', () => {
    expect(documents).toHaveLength(218)
    expect(Object.keys(baseline).filter(route => !documents.some(document => document.route === route))).toEqual([])
  })
  for (const document of documents) it(document.route, () => {
    const rows: Array<EmptyControl & { variant: string }> = []
    const actual = censusEntries(document.route, document.surface, rows)
    if (process.env.XPANEL_FORM_CENSUS === 'all') for (const row of rows) console.log('ROW ' + JSON.stringify({ ...row, route: document.route }))
    const known = baseline[document.route] ?? []
    expect({ added: actual.filter(entry => !known.includes(entry)), fixed: known.filter(entry => !actual.includes(entry)) }, document.route).toEqual({ added: [], fixed: [] })
  })
})
