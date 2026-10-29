import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fail, isXpanelError, validateDomainName } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

/** Provider credentials live only in this 0600 state file; no view, audit entry or error ever carries a token. */
export const SEC_DNS_PROVIDERS_STATE = 'extended/dns/sec-providers.json'
export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
const MAX_ACCOUNTS = 16, MAX_LINKS = 2000, MAX_RECORDS = 500
interface ProviderAccount { id: string; provider: 'cloudflare'; label: string; token: string; tokenId: string; createdAt: string; verifiedAt: string }
interface ProviderLink { domain: string; accountId: string; zoneId: string; zoneName: string; linkedAt: string }
interface ProvidersFile { version: 1; accounts: ProviderAccount[]; links: ProviderLink[] }
export interface SecCloudflareHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  /** Outbound HTTPS to the official Cloudflare API only; injected so tests never touch the network. */
  fetch: typeof fetch
  now?: () => Date
}
export type CloudflareRecordState = 'match' | 'differs' | 'missing_at_cloudflare' | 'only_at_cloudflare'

const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const ID = /^[0-9a-f]{32}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Cloudflare API tokens are 40 URL-safe characters; a bounded grammar keeps any other secret format out of the file.
const TOKEN = /^[A-Za-z0-9_-]{40}$/
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const domainOf = (value: unknown): string => { try { const name = validateDomainName(value); return name === value ? name : invalid('a canonical domain name is required') } catch { return invalid('a canonical domain name is required') } }

export function readProvidersFile(value: unknown): ProvidersFile | null {
  if (value === null) return { version: 1, accounts: [], links: [] }
  if (!object(value) || Object.keys(value).sort().join() !== 'accounts,links,version' || value.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS || !Array.isArray(value.links) || value.links.length > MAX_LINKS) return null
  const accounts = value.accounts.map(item => object(item) && Object.keys(item).sort().join() === 'createdAt,id,label,provider,token,tokenId,verifiedAt' && typeof item.id === 'string' && UUID.test(item.id) && item.provider === 'cloudflare'
    && typeof item.label === 'string' && /^[\p{L}\p{N} ._-]{1,64}$/u.test(item.label) && typeof item.token === 'string' && TOKEN.test(item.token) && typeof item.tokenId === 'string' && ID.test(item.tokenId) && iso(item.createdAt) && iso(item.verifiedAt) ? item as unknown as ProviderAccount : null)
  const ids = new Set(accounts.map(item => item?.id))
  const links = value.links.map(item => { try { return object(item) && Object.keys(item).sort().join() === 'accountId,domain,linkedAt,zoneId,zoneName' && domainOf(item.domain) && ids.has(item.accountId as string) && typeof item.zoneId === 'string' && ID.test(item.zoneId) && domainOf(item.zoneName) === item.domain && iso(item.linkedAt) ? item as unknown as ProviderLink : null } catch { return null } })
  if (accounts.some(item => !item) || links.some(item => !item) || ids.size !== accounts.length || new Set(links.map(item => item!.domain)).size !== links.length) return null
  return { version: 1, accounts: accounts as ProviderAccount[], links: links as ProviderLink[] }
}
/** The revision covers token digests, never token bytes. */
export const providersRevision = (raw: unknown): string => {
  const file = readProvidersFile(raw)
  const redacted = file ? { ...file, accounts: file.accounts.map(item => ({ ...item, token: createHash('sha256').update(item.token).digest('hex') })) } : { invalid: true }
  return createHash('sha256').update(JSON.stringify({ namespace: 'sec:dns-providers:v1', redacted })).digest('hex')
}
const publicAccount = (item: ProviderAccount) => ({ id: item.id, provider: item.provider, label: item.label, tokenId: item.tokenId, createdAt: item.createdAt, verifiedAt: item.verifiedAt })

/** One call to the documented v4 API: Bearer token, JSON envelope {success, errors, result}; bounded time and size. */
export async function cloudflareCall(fetcher: typeof fetch, token: string, path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(CLOUDFLARE_API + path, { method: init.method ?? 'GET', headers: { authorization: 'Bearer ' + token, accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), redirect: 'error', signal: AbortSignal.timeout(10_000) })
  } catch { return fail('SERVICE_UNAVAILABLE', 'Cloudflare could not be reached', { stateChanged: false, reason: 'provider_unreachable' }) }
  const text = await response.text().catch(() => '')
  let body: unknown = null
  try { body = text.length <= 1024 * 1024 ? JSON.parse(text) : null } catch { body = null }
  if (!object(body) || typeof body.success !== 'boolean') return fail('SERVICE_UNAVAILABLE', 'Cloudflare returned an unrecognized response', { stateChanged: false, reason: 'provider_response_invalid' })
  if (!body.success || !response.ok) {
    const codes = Array.isArray(body.errors) ? body.errors.map(item => object(item) && Number.isSafeInteger(item.code) ? item.code as number : 0).slice(0, 5) : []
    return fail(response.status === 401 || response.status === 403 ? 'FORBIDDEN' : 'PRECONDITION_FAILED', 'Cloudflare refused the request', { stateChanged: false, reason: 'provider_refused', providerStatus: response.status, providerCodes: codes })
  }
  return body.result
}
async function verifyToken(fetcher: typeof fetch, token: string): Promise<string> {
  const result = await cloudflareCall(fetcher, token, '/user/tokens/verify')
  if (!object(result) || typeof result.id !== 'string' || !ID.test(result.id) || result.status !== 'active') return fail('PRECONDITION_FAILED', 'the Cloudflare token is not active', { stateChanged: false, reason: 'token_inactive' })
  return result.id
}
async function findZone(fetcher: typeof fetch, token: string, domain: string): Promise<{ id: string; name: string }> {
  const result = await cloudflareCall(fetcher, token, '/zones?name=' + encodeURIComponent(domain) + '&per_page=5')
  const zones = Array.isArray(result) ? result.filter(item => object(item) && item.name === domain && typeof item.id === 'string' && ID.test(item.id)) : null
  if (!zones) return fail('SERVICE_UNAVAILABLE', 'Cloudflare returned an unrecognized response', { stateChanged: false, reason: 'provider_response_invalid' })
  if (zones.length !== 1) return fail('NOT_FOUND', 'this Cloudflare account has no zone with exactly this name', { stateChanged: false, reason: 'zone_not_found' })
  return { id: zones[0]!.id as string, name: domain }
}
const clean = (type: string, content: string): string => { const value = type === 'TXT' ? content.replace(/^"(.*)"$/s, '$1') : content; return ['CNAME', 'MX', 'NS'].includes(type) ? value.replace(/\.$/, '').toLowerCase() : value }
const COMPARED = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV'])
/** Compares this server's saved records with the Cloudflare zone by name, type and content (NS and SOA are provider-owned). */
export function compareCloudflareRecords(zone: string, local: readonly { name: string; type: string; content: string; priority: number | null }[], remote: readonly { name: string; type: string; content: string; proxied: boolean | null; priority: number | null }[]) {
  const fqdn = (name: string): string => name === '@' ? zone : name.endsWith('.' + zone) || name === zone ? name : name + '.' + zone
  const key = (name: string, type: string): string => fqdn(name).toLowerCase() + ' ' + type
  const groups = new Map<string, { name: string; type: string; local: string[]; remote: string[]; proxied: boolean | null }>()
  const group = (name: string, type: string) => { const k = key(name, type); if (!groups.has(k)) groups.set(k, { name: fqdn(name).toLowerCase(), type, local: [], remote: [], proxied: null }); return groups.get(k)! }
  for (const item of local) if (COMPARED.has(item.type)) group(item.name, item.type).local.push((item.priority === null ? '' : item.priority + ' ') + clean(item.type, item.content))
  for (const item of remote) if (COMPARED.has(item.type)) { const g = group(item.name, item.type); g.remote.push((item.priority === null ? '' : item.priority + ' ') + clean(item.type, item.content)); g.proxied = g.proxied || item.proxied === true }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)).slice(0, MAX_RECORDS).map(g => {
    const l = [...g.local].sort(), r = [...g.remote].sort()
    // A proxied (orange-cloud) A/AAAA/CNAME is published by Cloudflare with its own addresses; only its presence is compared.
    const state: CloudflareRecordState = !r.length ? 'missing_at_cloudflare' : !l.length ? 'only_at_cloudflare' : g.proxied || JSON.stringify(l) === JSON.stringify(r) ? 'match' : 'differs'
    return { name: g.name, type: g.type, local: l, cloudflare: r, proxied: g.proxied, state }
  })
}
async function readZone(helpers: SecCloudflareHelpers, account: ProviderAccount, link: ProviderLink) {
  const token = account.token, zone = await cloudflareCall(helpers.fetch, token, '/zones/' + link.zoneId), ssl = await cloudflareCall(helpers.fetch, token, '/zones/' + link.zoneId + '/settings/ssl')
  if (!object(zone) || zone.id !== link.zoneId || zone.name !== link.domain || typeof zone.status !== 'string' || !/^[a-z_]{1,32}$/.test(zone.status) || !Array.isArray(zone.name_servers) || !object(ssl) || !['off', 'flexible', 'full', 'strict'].includes(ssl.value as string)) return fail('SERVICE_UNAVAILABLE', 'Cloudflare returned an unrecognized response', { stateChanged: false, reason: 'provider_response_invalid' })
  const remote: { name: string; type: string; content: string; proxied: boolean | null; priority: number | null }[] = []
  let truncated = false
  for (let page = 1; page <= 5; page++) {
    const rows = await cloudflareCall(helpers.fetch, token, `/zones/${link.zoneId}/dns_records?per_page=100&page=${page}`)
    if (!Array.isArray(rows)) return fail('SERVICE_UNAVAILABLE', 'Cloudflare returned an unrecognized response', { stateChanged: false, reason: 'provider_response_invalid' })
    for (const row of rows) if (object(row) && typeof row.name === 'string' && typeof row.type === 'string' && typeof row.content === 'string' && row.content.length <= 4096) remote.push({ name: row.name, type: row.type, content: row.content, proxied: typeof row.proxied === 'boolean' ? row.proxied : null, priority: Number.isSafeInteger(row.priority) ? row.priority as number : null })
    if (rows.length < 100) break
    if (page === 5) truncated = true
  }
  const local = (await helpers.store.getDnsZone(link.domain))?.records ?? null
  return { domain: link.domain, zoneId: link.zoneId, status: zone.status, paused: zone.paused === true, nameServers: zone.name_servers.filter(item => typeof item === 'string' && /^[a-z0-9.-]{1,253}$/.test(item)).slice(0, 8), sslMode: ssl.value,
    localZone: local !== null, records: compareCloudflareRecords(link.domain, local ?? [], remote), truncated, observedAt: (helpers.now ?? (() => new Date()))().toISOString() }
}

const bodyOf = async (request: Request, keys: readonly string[]): Promise<Record<string, unknown>> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const raw = await request.text()
  let value: unknown
  try { value = raw.length <= 2048 ? JSON.parse(raw) : null } catch { value = null }
  if (!object(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) return invalid('unsupported request fields')
  return value
}
const revisionOf = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : invalid('the exact observed revision is required')
const readRaw = async (store: Pick<StateStore, 'rootDir'>): Promise<unknown> => { try { return await readJsonIfExists<unknown>(join(store.rootDir, SEC_DNS_PROVIDERS_STATE)) } catch { return fail('PRECONDITION_FAILED', 'saved DNS provider configuration is unreadable', unchanged) } }
const readFile = async (store: Pick<StateStore, 'rootDir'>): Promise<{ raw: unknown; file: ProvidersFile }> => { const raw = await readRaw(store), file = readProvidersFile(raw); return file ? { raw, file } : fail('PRECONDITION_FAILED', 'saved DNS provider configuration requires review', unchanged) }
const same = (left: AuthenticatedCaller, right: AuthenticatedCaller): boolean => left.principal.id === right.principal.id && left.sessionId === right.sessionId && left.apiTokenId === right.apiTokenId

async function write(helpers: SecCloudflareHelpers, expected: string, change: (file: ProvidersFile) => ProvidersFile, fresh: () => Promise<unknown>): Promise<ProvidersFile> {
  const lease = await helpers.store.getWriterLock().acquire()
  let attempted = false
  try {
    await fresh()
    const { raw, file } = await readFile(helpers.store)
    if (providersRevision(raw) !== expected) return fail('CONFLICT', 'DNS provider configuration changed; reload before saving', unchanged)
    const next = change(structuredClone(file))
    if (!readProvidersFile(next)) return invalid('the change would make the provider configuration invalid')
    await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(join(helpers.store.rootDir, SEC_DNS_PROVIDERS_STATE), next, 0o600, async () => { await fresh(); await lease.assertFencingToken() })
    if (JSON.stringify(await readRaw(helpers.store)) !== JSON.stringify(next)) throw new Error('readback_mismatch')
    return next
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the provider configuration could not be verified; review before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
}
const serverView = async (helpers: SecCloudflareHelpers, raw: unknown, file: ProvidersFile) => ({
  revision: providersRevision(raw), accounts: file.accounts.map(publicAccount), links: file.links.map(link => ({ ...link })),
  domains: (await helpers.store.listDomains()).map(domain => domain.name).sort().slice(0, 5000),
})

/** Root provider accounts and zone links (/whm/dns/providers) and the owner's own linked domains (/domains/cloudflare). */
export async function handleSecCloudflareRoute(request: Request, url: URL, method: string, helpers: SecCloudflareHelpers): Promise<Response | null> {
  const p = url.pathname
  if (p.startsWith('/api/account/sec/cloudflare')) return accountRoute(request, url, method, helpers)
  if (!p.startsWith('/api/server/sec/dns-providers')) return null
  const ROUTES: Record<string, string> = { '/api/server/sec/dns-providers': 'GET', '/api/server/sec/dns-providers/zone': 'GET', '/api/server/sec/dns-providers/accounts': 'POST', '/api/server/sec/dns-providers/accounts/remove': 'POST', '/api/server/sec/dns-providers/links': 'POST', '/api/server/sec/dns-providers/links/remove': 'POST', '/api/server/sec/dns-providers/purge': 'POST' }
  if (!Object.hasOwn(ROUTES, p)) return null
  const action = 'server.sec.dns-providers.' + (ROUTES[p] === 'GET' ? 'read' : p.split('/').slice(5).join('.'))
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (method !== ROUTES[p]) return new Response(null, { status: 405, headers: { allow: ROUTES[p]! } })
  const fresh = async (): Promise<AuthenticatedCaller> => { const current = await helpers.requireCaller(request); await helpers.assertRoot(current, action); return same(caller, current) ? current : fail('FORBIDDEN', 'root authorization changed', unchanged) }
  const zone = p === '/api/server/sec/dns-providers/zone', query = [...url.searchParams]
  if (zone ? query.length !== 1 || query[0]![0] !== 'domain' : url.search) return invalid(zone ? 'exactly one domain is required' : 'provider routes accept no query selectors')
  const now = () => (helpers.now ?? (() => new Date()))().toISOString()
  const audit = async (actor: AuthenticatedCaller, name: string, target: string, detail: Record<string, unknown> = {}) => { try { await helpers.emitAudit({ actor: actor.principal.username, action: 'server.sec.dns-providers.' + name, target, principalId: actor.principal.id, outcome: 'ok', detail }) } catch { fail('SERVICE_UNAVAILABLE', 'the change was saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) } }
  if (p === '/api/server/sec/dns-providers') { const { raw, file } = await readFile(helpers.store); const view = await serverView(helpers, raw, file); await fresh(); return workspaceJson(view) }
  if (zone || p === '/api/server/sec/dns-providers/purge') {
    const domain = domainOf(zone ? query[0]![1] : (await bodyOf(request, ['domain'])).domain)
    const { file } = await readFile(helpers.store), link = file.links.find(item => item.domain === domain), account = link && file.accounts.find(item => item.id === link.accountId)
    if (!link || !account) return fail('NOT_FOUND', 'the domain is not linked to a Cloudflare zone', unchanged)
    if (zone) return workspaceJson(await readZone(helpers, account, link))
    return workspaceJson(await purge(helpers, await fresh(), account, link, audit))
  }
  if (p === '/api/server/sec/dns-providers/accounts') {
    const body = await bodyOf(request, ['label', 'token', 'expectedRevision'])
    if (typeof body.label !== 'string' || !/^[\p{L}\p{N} ._-]{1,64}$/u.test(body.label) || body.label.trim() !== body.label) return invalid('a label of 1 to 64 letters, digits, spaces, dots, dashes or underscores is required')
    if (typeof body.token !== 'string' || !TOKEN.test(body.token)) return invalid('a Cloudflare API token of 40 characters is required')
    const expected = revisionOf(body.expectedRevision), token = body.token, label = body.label
    // Verify with Cloudflare before anything is stored: an inactive or wrong token is never saved.
    const tokenId = await verifyToken(helpers.fetch, token)
    const actor = await fresh(), id = randomUUID()
    const next = await write(helpers, expected, file => { if (file.accounts.length >= MAX_ACCOUNTS) invalid('at most 16 provider accounts can be saved'); if (file.accounts.some(item => item.tokenId === tokenId)) fail('CONFLICT', 'this token is already saved', unchanged); file.accounts.push({ id, provider: 'cloudflare', label, token, tokenId, createdAt: now(), verifiedAt: now() }); return file }, fresh)
    await audit(actor, 'account_added', 'dns-provider:' + id, { provider: 'cloudflare' })
    return workspaceJson(await serverView(helpers, next, next))
  }
  if (p === '/api/server/sec/dns-providers/accounts/remove') {
    const body = await bodyOf(request, ['accountId', 'expectedRevision'])
    if (typeof body.accountId !== 'string' || !UUID.test(body.accountId)) return invalid('a provider account id is required')
    const target = body.accountId, actor = await fresh()
    const next = await write(helpers, revisionOf(body.expectedRevision), file => { if (!file.accounts.some(item => item.id === target)) fail('NOT_FOUND', 'provider account not found', unchanged); return { ...file, accounts: file.accounts.filter(item => item.id !== target), links: file.links.filter(item => item.accountId !== target) } }, fresh)
    await audit(actor, 'account_removed', 'dns-provider:' + target)
    return workspaceJson(await serverView(helpers, next, next))
  }
  if (p === '/api/server/sec/dns-providers/links') {
    const body = await bodyOf(request, ['domain', 'accountId', 'expectedRevision'])
    const domain = domainOf(body.domain), expected = revisionOf(body.expectedRevision)
    if (!(await helpers.store.listDomains()).some(item => item.name === domain)) return fail('NOT_FOUND', 'the domain is not hosted on this server', unchanged)
    const { file } = await readFile(helpers.store), account = file.accounts.find(item => item.id === body.accountId)
    if (!account) return fail('NOT_FOUND', 'provider account not found', unchanged)
    const found = await findZone(helpers.fetch, account.token, domain), actor = await fresh()
    const next = await write(helpers, expected, current => { if (current.links.some(item => item.domain === domain)) fail('CONFLICT', 'the domain is already linked', unchanged); if (!current.accounts.some(item => item.id === account.id)) fail('CONFLICT', 'the provider account changed', unchanged); current.links.push({ domain, accountId: account.id, zoneId: found.id, zoneName: found.name, linkedAt: now() }); current.links.sort((a, b) => a.domain.localeCompare(b.domain)); return current }, fresh)
    await audit(actor, 'domain_linked', 'domain:' + domain, { accountId: account.id })
    return workspaceJson(await serverView(helpers, next, next))
  }
  const body = await bodyOf(request, ['domain', 'expectedRevision'])
  const domain = domainOf(body.domain), actor = await fresh()
  const next = await write(helpers, revisionOf(body.expectedRevision), file => file.links.some(item => item.domain === domain) ? { ...file, links: file.links.filter(item => item.domain !== domain) } : fail('NOT_FOUND', 'the domain is not linked', unchanged), fresh)
  await audit(actor, 'domain_unlinked', 'domain:' + domain)
  return workspaceJson(await serverView(helpers, next, next))
}

async function purge(helpers: SecCloudflareHelpers, actor: AuthenticatedCaller, account: ProviderAccount, link: ProviderLink, audit: (actor: AuthenticatedCaller, name: string, target: string, detail?: Record<string, unknown>) => Promise<void>) {
  let result: unknown
  try { result = await cloudflareCall(helpers.fetch, account.token, '/zones/' + link.zoneId + '/purge_cache', { method: 'POST', body: { purge_everything: true } }) }
  catch (error) { if (isXpanelError(error) && error.detail.reason !== 'provider_unreachable') throw error; return fail('SERVICE_UNAVAILABLE', 'the purge outcome is unknown; check the Cloudflare dashboard before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
  // Cloudflare answers with the zone id once the purge is accepted; there is no cache state to read back.
  if (!object(result) || result.id !== link.zoneId) return fail('SERVICE_UNAVAILABLE', 'the purge outcome is unknown; check the Cloudflare dashboard before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
  await audit(actor, 'cache_purged', 'domain:' + link.domain)
  return { domain: link.domain, outcome: 'accepted', observedAt: (helpers.now ?? (() => new Date()))().toISOString() }
}

async function accountRoute(request: Request, url: URL, method: string, helpers: SecCloudflareHelpers): Promise<Response | null> {
  const p = url.pathname, list = p === '/api/account/sec/cloudflare', zone = p === '/api/account/sec/cloudflare/zone', purgePath = p === '/api/account/sec/cloudflare/purge'
  if (!list && !zone && !purgePath) return null
  const expected = purgePath ? 'POST' : 'GET'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  const query = [...url.searchParams]
  if (zone ? query.length !== 1 || query[0]![0] !== 'domain' : url.search) return invalid(zone ? 'exactly one domain is required' : 'Cloudflare routes accept no selectors')
  const ports = { store: helpers.store, requireCaller: (req: Request) => helpers.requireCaller(req) }
  const first = await authorizeAccountOwner(ports, request, ['cloudflare-account'], 'Cloudflare')
  const owned = async (account: Account) => (await helpers.store.listDomains({ accountId: account.id })).map(domain => domain.name)
  const { file } = await readFile(helpers.store)
  if (list) return workspaceJson({ domains: (await owned(first.account)).sort().map(domain => { const link = file.links.find(item => item.domain === domain); return { domain, linked: !!link, zoneId: link?.zoneId ?? null } }) })
  const domain = domainOf(zone ? query[0]![1] : (await bodyOf(request, ['domain'])).domain)
  if (!(await owned(first.account)).includes(domain)) return fail('NOT_FOUND', 'domain not found', unchanged)
  const link = file.links.find(item => item.domain === domain), account = link && file.accounts.find(item => item.id === link.accountId)
  if (!link || !account) return fail('PRECONDITION_FAILED', 'this domain is not connected to Cloudflare; the server administrator connects domains', { stateChanged: false, reason: 'not_linked' })
  if (zone) return workspaceJson(await readZone(helpers, account, link))
  const again = await authorizeAccountOwner(ports, request, ['cloudflare-account'], 'Cloudflare')
  if (again.caller.principal.id !== first.caller.principal.id || !(await owned(again.account)).includes(domain)) return fail('CONFLICT', 'the account binding changed before the purge', unchanged)
  const audit = async (actor: AuthenticatedCaller, name: string, target: string) => { try { await helpers.emitAudit({ actor: actor.principal.username, action: 'account.sec.cloudflare.' + name, target, principalId: actor.principal.id, outcome: 'ok', detail: {} }) } catch { fail('SERVICE_UNAVAILABLE', 'the purge was accepted but its audit record requires review', { stateChanged: true, verificationRequired: true }) } }
  return workspaceJson(await purge(helpers, again.caller, account, link, audit))
}
