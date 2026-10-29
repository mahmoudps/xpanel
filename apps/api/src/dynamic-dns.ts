import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { tools } from '@xpanel/catalog'
import { canonicalIp, fail, isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { atomicWriteJson } from '@xpanel/state'
import type { DnsZoneState, StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { authorizeAccountOwner } from './account-ssh-workspace.ts'
import { assertDnsZoneRevision, dnsZoneRevision } from './dns-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export const DYNAMIC_DNS_PATH = '/api/account/dynamic-dns'
export const DYNAMIC_DNS_ID = /^ddns_[A-Za-z0-9_-]{22}$/
export const DYNAMIC_DNS_LIMIT = 25
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/
const MAX_ENTRIES = 10000
const MAX_BYTES = 8 * 1024 * 1024
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
const protocol = (text: string, status = 200): Response => new Response(text + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(text === 'badauth' ? { 'www-authenticate': 'Basic realm="Dynamic DNS"' } : {}) } })
const stamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
export const dynamicDnsHostname = (value: unknown): value is string => typeof value === 'string' && value.length <= 253 && value.includes('.') && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
const descriptionOf = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/.test(value)) return invalid('description must be plain text of at most 200 characters')
  return value.trim()
}
export interface DynamicDnsEntry {
  id: string; accountId: string; accountUsername: string; accountCreatedAt: string; principalId: string
  zone: string; zoneId: string; hostname: string; type: 'A' | 'AAAA'; recordId: string; description: string
  secretHash: string; createdAt: string; updatedAt: string; lastChangedAt: string | null; pendingIp: string | null
}
export interface DynamicDnsRegistry { read(): Promise<DynamicDnsEntry[]>; write(entries: DynamicDnsEntry[]): Promise<void> }
/** Only hashes are persisted. The state writer lease serializes all callers of write(), including API processes. */
export function createDynamicDnsRegistry(rootDir: string): DynamicDnsRegistry {
  const path = join(rootDir, 'extended', 'dynamic-dns.json')
  return {
    async read() {
      let handle
      try { handle = await open(path, 'r') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
      try {
        if ((await handle.stat()).size > MAX_BYTES) return fail('SERVICE_UNAVAILABLE', 'dynamic DNS registry is too large')
        return parseDynamicDnsRegistry(JSON.parse(await handle.readFile('utf8')))
      } finally { await handle.close() }
    },
    async write(entries) {
      parseDynamicDnsRegistry(entries)
      await atomicWriteJson(path, entries, 0o600)
      if (JSON.stringify(await this.read()) !== JSON.stringify(entries)) fail('SERVICE_UNAVAILABLE', 'dynamic DNS registry write requires inspection', { stateChanged: true, verificationRequired: true })
    },
  }
}
export function parseDynamicDnsRegistry(raw: unknown): DynamicDnsEntry[] {
  const bad = (): never => fail('SERVICE_UNAVAILABLE', 'dynamic DNS registry requires inspection')
  if (!Array.isArray(raw) || raw.length > MAX_ENTRIES) return bad()
  const ids = new Set<string>(), targets = new Set<string>()
  for (const row of raw) {
    if (!object(row) || Object.keys(row).sort().join() !== 'accountCreatedAt,accountId,accountUsername,createdAt,description,hostname,id,lastChangedAt,pendingIp,principalId,recordId,secretHash,type,updatedAt,zone,zoneId'
      || typeof row.id !== 'string' || !DYNAMIC_DNS_ID.test(row.id) || ids.has(row.id)
      || ![row.accountId, row.principalId, row.zoneId, row.recordId].every(value => typeof value === 'string' && UUID.test(value))
      || typeof row.accountUsername !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(row.accountUsername)
      || !stamp(row.accountCreatedAt) || !stamp(row.createdAt) || !stamp(row.updatedAt) || !(row.lastChangedAt === null || stamp(row.lastChangedAt))
      || !dynamicDnsHostname(row.zone) || !dynamicDnsHostname(row.hostname) || !(row.hostname === row.zone || row.hostname.endsWith('.' + row.zone))
      || !['A', 'AAAA'].includes(row.type as string) || typeof row.secretHash !== 'string' || !HASH.test(row.secretHash)
      || typeof row.description !== 'string' || row.description !== descriptionOf(row.description)
      || !(row.pendingIp === null || typeof row.pendingIp === 'string' && isIP(row.pendingIp) === (row.type === 'A' ? 4 : 6))) return bad()
    const target = row.hostname + ':' + row.type
    if (targets.has(target)) return bad()
    ids.add(row.id); targets.add(target)
  }
  return raw as DynamicDnsEntry[]
}
export interface DynamicDnsPorts {
  store: StateStore
  requireCaller(req: Request): Promise<AuthenticatedCaller>
  emitAudit: ExtendedRouteHelpers['emitAudit']
  readPrincipal(id: string): Promise<{ id: string; kind: string; username: string; accountId: string | null; disabled: boolean } | null>
  /** Must fail closed unless the real host supports DNS publication. No caller-supplied bypass. */
  assertUpdateAvailable(account: Account): Promise<void>
  /** Real stored principal, never a fabricated session. true only after checked state/apply acknowledgement. */
  reconcile(principalId: string, account: Account): Promise<boolean>
  registry?: DynamicDnsRegistry
  now?: () => number
}
const publicEntry = (entry: DynamicDnsEntry) => ({ id: entry.id, hostname: entry.hostname, zone: entry.zone, type: entry.type, description: entry.description, createdAt: entry.createdAt, updatedAt: entry.updatedAt, lastChangedAt: entry.lastChangedAt, pending: entry.pendingIp !== null })
// The opaque digest changes on rotation even when two writes share a clock tick; raw hashes are never returned.
const revisionOf = (rows: DynamicDnsEntry[]): string => hash(JSON.stringify(rows))
const relativeName = (entry: Pick<DynamicDnsEntry, 'zone' | 'hostname'>): string => entry.hostname === entry.zone ? '@' : entry.hostname.slice(0, -(entry.zone.length + 1))
const sameLifetime = (entry: DynamicDnsEntry, account: Account): boolean => entry.accountId === account.id && entry.accountUsername === account.username && entry.accountCreatedAt === account.createdAt && account.status === 'active'
const matchingRecords = (zone: DnsZoneState, entry: Pick<DynamicDnsEntry, 'zone' | 'hostname' | 'type'>) => zone.records.filter(record => record.name === relativeName(entry) && record.type === entry.type)
const boundZone = (zone: DnsZoneState | null, entry: DynamicDnsEntry): DnsZoneState => {
  if (!zone || zone.id !== entry.zoneId || zone.accountId !== entry.accountId || zone.name !== entry.zone) return fail('NOT_FOUND', 'dynamic DNS zone is no longer owned by this account')
  const matches = matchingRecords(zone, entry)
  if (matches.length > 1 || matches.some(record => record.id !== entry.recordId) || zone.records.some(record => record.name === relativeName(entry) && record.type === 'CNAME')) return fail('CONFLICT', 'the DNS record binding changed')
  return zone
}
const bodyOf = async (req: Request): Promise<Record<string, unknown>> => {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await req.text()
  if (Buffer.byteLength(text) > 4096) return invalid('dynamic DNS request is too large')
  try { const value: unknown = JSON.parse(text); if (object(value)) return value } catch { /* fixed validation response */ }
  return invalid('a JSON object is required')
}

export function createDynamicDnsRoutes(ports: DynamicDnsPorts) {
  const registry = ports.registry ?? createDynamicDnsRegistry(ports.store.rootDir), now = ports.now ?? Date.now
  const failedAuth = new Map<string, { count: number; until: number }>(), busy = new Set<string>()
  const accountRows = (rows: DynamicDnsEntry[], account: Account) => rows.filter(row => sameLifetime(row, account))
  const freshPrincipal = async (entry: DynamicDnsEntry, account: Account): Promise<void> => {
    const principal = await ports.readPrincipal(entry.principalId)
    if (!sameLifetime(entry, account) || !principal || principal.id !== entry.principalId || principal.disabled || principal.kind !== 'user' || principal.accountId !== account.id || principal.username !== account.username) fail('FORBIDDEN', 'dynamic DNS owner is no longer active')
    const plan = await ports.store.getPlan(account.planId), list = plan ? await ports.store.getFeatureList(plan.featureListId) : null, tool = tools.find(item => item.id === 'dynamic-dns')
    if (!list || !tool || list.disabled.includes(tool.id) || !!tool.featureKey && list.disabled.includes(tool.featureKey)) fail('FORBIDDEN', 'dynamic DNS is disabled by the account plan')
  }
  const view = async (account: Account, rows: DynamicDnsEntry[]) => ({ context: { accountId: account.id }, revision: revisionOf(accountRows(rows, account)), entries: accountRows(rows, account).map(publicEntry), zones: (await ports.store.listDnsZones(account.id)).map(zone => ({ name: zone.name })), limit: DYNAMIC_DNS_LIMIT })
  const audit = (entry: DynamicDnsEntry, action: string, account: Account, ip?: string) => ports.emitAudit({ actor: account.username, action: 'dns.dynamic.' + action, target: 'dns:' + entry.hostname, detail: { type: entry.type, ...(ip ? { address: ip } : {}) }, outcome: 'ok', principalId: entry.principalId }, { accountId: account.id, resellerId: account.ownerId })

  async function manage(req: Request, url: URL, method: string): Promise<Response | null> {
    if (url.pathname !== DYNAMIC_DNS_PATH && !url.pathname.startsWith(DYNAMIC_DNS_PATH + '/')) return null
    try {
      const first = await authorizeAccountOwner(ports, req, ['dynamic-dns'], 'Dynamic DNS')
      if (first.caller.sessionId === null || first.caller.apiTokenId !== null) return fail('FORBIDDEN', 'dynamic DNS credentials require an interactive account-owner session', { stateChanged: false })
      const match = /^\/api\/account\/dynamic-dns(?:\/(ddns_[A-Za-z0-9_-]{22})(?:\/(rotate))?)?$/.exec(url.pathname)
      if (!match || url.search) return invalid('unsupported dynamic DNS selector')
      const id = match[1], rotate = match[2] === 'rotate'
      if (!(id ? rotate ? method === 'POST' : method === 'DELETE' : method === 'GET' || method === 'POST')) return new Response(null, { status: 405, headers: { allow: id ? rotate ? 'POST' : 'DELETE' : 'GET, POST' } })
      if (method === 'GET') return json(await view(first.account, await registry.read()))
      const body = await bodyOf(req), keys = Object.keys(body).sort().join()
      if (keys !== (id ? 'expectedRevision' : 'description,expectedRevision,hostname,type,zone') || typeof body.expectedRevision !== 'string' || !HASH.test(body.expectedRevision)) return invalid('a current revision and the exact dynamic DNS fields are required')
      if (!id && (!dynamicDnsHostname(body.zone) || !dynamicDnsHostname(body.hostname) || !['A', 'AAAA'].includes(body.type as string))) return invalid('zone and hostname must be lowercase full DNS names; type must be A or AAAA')
      const description = id ? '' : descriptionOf(body.description)
      return await ports.store.withAccountLifecycleLease(first.account.id, async account => {
        const fresh = await authorizeAccountOwner(ports, req, ['dynamic-dns'], 'Dynamic DNS')
        if (fresh.caller.principal.id !== first.caller.principal.id || fresh.caller.sessionId !== first.caller.sessionId || fresh.caller.apiTokenId !== null || fresh.account.id !== account.id || fresh.account.createdAt !== first.account.createdAt || fresh.account.username !== first.account.username) return fail('CONFLICT', 'the account session changed', { stateChanged: false })
        const rows = await registry.read(), owned = accountRows(rows, account)
        if (revisionOf(owned) !== body.expectedRevision) return fail('CONFLICT', 'dynamic DNS changed; reload before retrying', { stateChanged: false })
        const timestamp = new Date(now()).toISOString()
        let entry: DynamicDnsEntry, next: DynamicDnsEntry[], issued: { id: string; secret: string } | undefined
        if (!id) {
          if (owned.length >= DYNAMIC_DNS_LIMIT || rows.length >= MAX_ENTRIES) return fail('LIMIT_EXCEEDED', 'dynamic DNS capacity reached', { stateChanged: false })
          const zone = await ports.store.getDnsZone(body.zone as string), hostname = body.hostname as string, type = body.type as 'A' | 'AAAA'
          if (!zone || zone.accountId !== account.id || !(hostname === zone.name || hostname.endsWith('.' + zone.name))) return fail('NOT_FOUND', 'select an owned DNS zone and a hostname inside it', { stateChanged: false })
          if (rows.some(row => row.hostname === hostname && row.type === type)) return fail('CONFLICT', 'this hostname and record type already have a dynamic DNS credential', { stateChanged: false })
          const matches = matchingRecords(zone, { zone: zone.name, hostname, type })
          if (matches.length > 1 || zone.records.some(record => record.name === relativeName({ hostname, zone: zone.name }) && record.type === 'CNAME')) return fail('CONFLICT', 'choose a hostname without a CNAME or multiple address records', { stateChanged: false })
          const secret = randomBytes(32).toString('base64url'), credentialId = 'ddns_' + randomBytes(16).toString('base64url')
          entry = { id: credentialId, accountId: account.id, accountUsername: account.username, accountCreatedAt: account.createdAt, principalId: fresh.caller.principal.id, zone: zone.name, zoneId: zone.id, hostname, type, recordId: matches[0]?.id ?? randomUUID(), description, secretHash: hash(secret), createdAt: timestamp, updatedAt: timestamp, lastChangedAt: null, pendingIp: null }
          next = [...rows, entry]; issued = { id: credentialId, secret }
        } else {
          const existing = owned.find(row => row.id === id)
          if (!existing) return fail('NOT_FOUND', 'dynamic DNS credential not found', { stateChanged: false })
          entry = existing
          if (rotate) { const secret = randomBytes(32).toString('base64url'); entry = { ...existing, secretHash: hash(secret), updatedAt: timestamp }; issued = { id, secret } }
          next = rotate ? rows.map(row => row.id === id ? entry : row) : rows.filter(row => row.id !== id)
        }
        await registry.write(next)
        try { await audit(entry, id ? rotate ? 'rotated' : 'deleted' : 'created', account) }
        catch { await registry.write(rows); return fail('SERVICE_UNAVAILABLE', 'credential change could not be audited', { stateChanged: true, verificationRequired: true }) }
        return json({ ...await view(account, next), ...(issued ? { issued } : {}) }, id ? 200 : 201)
      })
    } catch (error) {
      if (isXpanelError(error) && error.code === 'VALIDATION') return json({ error: { code: 'VALIDATION', message: error.message, detail: error.detail } }, 422)
      throw error
    }
  }

  /** dyndns2: ddclient's protocol specification; one FQDN and one address per request. */
  async function update(req: Request, url: URL, remoteAddress: string | null): Promise<Response | null> {
    if (url.pathname !== '/nic/update') return null
    if (req.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } })
    const timestamp = now(), source = remoteAddress && isIP(remoteAddress) ? canonicalIp(remoteAddress).address : 'unknown'
    for (const [address, item] of failedAuth) if (item.until <= timestamp) failedAuth.delete(address)
    if ((failedAuth.get(source)?.count ?? 0) >= 10 || failedAuth.size >= 4096 && !failedAuth.has(source)) return protocol('abuse', 429)
    const badAuth = (): Response => { const before = failedAuth.get(source); failedAuth.set(source, { count: (before?.count ?? 0) + 1, until: before?.until ?? timestamp + 300000 }); return protocol('badauth', 401) }
    const authorization = req.headers.get('authorization') ?? '', basic = /^Basic ([A-Za-z0-9+/]{1,256}={0,2})$/.exec(authorization)
    if (!basic) return badAuth()
    const decoded = Buffer.from(basic[1]!, 'base64'), encoded = decoded.toString('base64')
    if (encoded !== basic[1] || !/^[\x21-\x7e]+$/.test(decoded.toString('ascii'))) return badAuth()
    const text = decoded.toString('utf8'), colon = text.indexOf(':'), id = text.slice(0, colon), secret = text.slice(colon + 1)
    if (colon < 0 || !DYNAMIC_DNS_ID.test(id) || !SECRET.test(secret)) return badAuth()
    let rows: DynamicDnsEntry[]
    try { rows = await registry.read() } catch { return protocol('911', 503) }
    const entry = rows.find(row => row.id === id)
    const valid = timingSafeEqual(Buffer.from(hash(secret), 'hex'), Buffer.from(entry?.secretHash ?? '0'.repeat(64), 'hex'))
    if (!entry || !valid) return badAuth()
    if (url.searchParams.size > 2 || [...url.searchParams.keys()].some(key => !['hostname', 'myip'].includes(key)) || url.searchParams.getAll('hostname').length !== 1 || url.searchParams.getAll('myip').length > 1) return protocol('notfqdn')
    const hostname = url.searchParams.get('hostname')
    if (!dynamicDnsHostname(hostname)) return protocol('notfqdn')
    if (hostname !== entry.hostname) return protocol('nohost')
    const rawIp = url.searchParams.get('myip') ?? remoteAddress
    if (!rawIp || isIP(rawIp) !== (entry.type === 'A' ? 4 : 6)) return protocol('notfqdn')
    const ip = canonicalIp(rawIp).address
    if (busy.has(id)) return protocol('911', 503)
    busy.add(id)
    try {
      const account = await ports.store.getAccount(entry.accountId)
      if (!account) return protocol('nohost')
      await freshPrincipal(entry, account)
      await ports.assertUpdateAvailable(account)
      const zone = boundZone(await ports.store.getDnsZone(entry.zone), entry), records = matchingRecords(zone, entry), unchanged = records.length === 1 && canonicalIp(records[0]!.content).address === ip
      const revision = dnsZoneRevision(zone)
      if (entry.pendingIp !== null && entry.pendingIp !== ip) return protocol('911', 503)
      if (!unchanged && entry.pendingIp === null && entry.lastChangedAt !== null && timestamp - Date.parse(entry.lastChangedAt) < 60000) return protocol('abuse', 429)
      const expectedEntry = unchanged ? entry : { ...entry, lastChangedAt: new Date(timestamp).toISOString(), pendingIp: ip }
      if (!unchanged) {
        const record = { id: entry.recordId, zone: entry.zone, name: relativeName(entry), type: entry.type, ttl: records[0]?.ttl ?? 300, content: ip, priority: null }
        const next = { ...zone, serial: zone.serial === 4294967295 ? 1 : zone.serial + 1, records: records.length ? zone.records.map(row => row.id === entry.recordId ? record : row) : [...zone.records, record] }
        await ports.store.saveDnsZone(next, { dnsGuard: async currentZone => {
          assertDnsZoneRevision(boundZone(currentZone, entry), revision)
          const fresh = await ports.store.getAccount(account.id)
          if (!fresh) return fail('NOT_FOUND', 'dynamic DNS owner is unavailable')
          await freshPrincipal(entry, fresh)
          const latest = await registry.read(), current = latest.find(row => row.id === id)
          if (!current || current.secretHash !== entry.secretHash || JSON.stringify(current) !== JSON.stringify(entry)) return fail('CONFLICT', 'dynamic DNS credential changed')
          // Persist the attempt before publication: a crash cannot bypass throttling or turn a pending write into nochg.
          await registry.write(latest.map(row => row.id === id ? expectedEntry : row))
        } })
      }
      const observed = boundZone(await ports.store.getDnsZone(entry.zone), entry), observedRecords = matchingRecords(observed, entry)
      if (observedRecords.length !== 1 || canonicalIp(observedRecords[0]!.content).address !== ip) return protocol('911', 503)
      const committedRevision = await ports.store.getRevision()
      if (!await ports.reconcile(entry.principalId, account) || await ports.store.getRevision() !== committedRevision) return protocol('911', 503)
      return await ports.store.withAccountLifecycleLease(account.id, async fresh => {
        if (await ports.store.getRevision() !== committedRevision) return protocol('911', 503)
        await freshPrincipal(entry, fresh)
        const latest = await registry.read(), current = latest.find(row => row.id === id)
        if (!current || JSON.stringify(current) !== JSON.stringify(expectedEntry)) return protocol('911', 503)
        assertDnsZoneRevision(boundZone(await ports.store.getDnsZone(entry.zone), entry), dnsZoneRevision(observed))
        await audit(entry, 'updated', fresh, ip)
        if (current.pendingIp !== null) await registry.write(latest.map(row => row.id === id ? { ...row, pendingIp: null } : row))
        return protocol((unchanged && entry.pendingIp === null ? 'nochg ' : 'good ') + ip)
      })
    } catch (error) {
      if (isXpanelError(error) && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) return protocol('nohost')
      return protocol('911', 503)
    } finally { busy.delete(id) }
  }
  return { manage, update }
}
