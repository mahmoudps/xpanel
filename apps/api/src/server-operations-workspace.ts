import { readIssuedCertificate, recordForwardCertificate } from './forward-certificate.ts'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  canonicalIp, defaultMaintenanceSchedule, defaultPanelTlsPolicy, defaultServerRoles, defaultSpf, defaultUpdatePreferences, effectiveServerRoles, fail, isXpanelError, natPublicAddresses, nextForwarderIp, runsMoreThanDaily,
  SERVER_OPERATIONS_STATE, SERVER_PROFILES, serverRoleChanges, spfWithAddress, validateDomainForwards, validateDomainName, validateForwardUrl, validateMaintenanceSchedule, validatePanelTlsPolicy, validateServerResolvers,
  validateServerRoles, validateSystemMailForwards, validateUpdatePreferences,
} from '@xpanel/core'
import type { DnsRecord, DomainForward, MaintenanceSchedule, PanelTlsPolicy, ServerRoleChange, ServerRoleState, SystemMailForwards, UpdatePreferences } from '@xpanel/core'
import { acquireJobLease, completeJobWithLease, enqueueDurableJob, getDurableJob, listJobs, renewJobLease, saveJobCheckpoint } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { DnsZoneState, StateSnapshot, StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { ipUsage } from './ip-network-workspace.ts'
import { assertExpectedRevision, exactKeys, panelConfigRevision, panelJson, readPanelConfigBody, stateConfigFile } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'

/**
 * WHM server, network and DNS operations: each tool's desired state is one revision-bound file under extended/server.
 * The agent applies them (reconcile, host job or a reviewed host route) and every reply carries what the host reported.
 */
export interface ServerOperationsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit' | 'triggerReconcile'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock' | 'readSnapshot' | 'getServerSettings' | 'listDnsZones' | 'getDnsZone' | 'saveDnsZone' | 'createCertificate'>
  db: Db
  /** Configuration Cluster: a new version of these files, pushed to every member. Null without members. */
  sendToCluster?: (sections: readonly string[], note: string, caller: AuthenticatedCaller) => Promise<{ version: number; members: number } | null>
  /** Protected agent transport; a body sends a POST. Absent when no host agent is connected. */
  callHost?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
}

const unchanged = { stateChanged: false }
const accepted = (body: unknown, status: 201 | 202): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
type Store = ServerOperationsHelpers['store']
type ResolversFile = { resolvers: string[] }
const parsed = <T>(validate: (raw: unknown) => T) => (raw: unknown): T | null => { try { return validate(raw) } catch { return null } }
const files = (store: Pick<Store, 'rootDir' | 'getWriterLock'>) => ({
  resolvers: stateConfigFile<ResolversFile | null>(store, SERVER_OPERATIONS_STATE.resolvers, 'server-resolvers:v1', parsed(raw => ({ resolvers: validateServerResolvers((raw as ResolversFile).resolvers) })), () => null),
  forwards: stateConfigFile<DomainForward[]>(store, SERVER_OPERATIONS_STATE.domainForwards, 'domain-forwards:v1', parsed(validateDomainForwards), () => []),
  roles: stateConfigFile<ServerRoleState>(store, SERVER_OPERATIONS_STATE.roles, 'server-roles:v1', parsed(validateServerRoles), defaultServerRoles),
  systemMail: stateConfigFile<SystemMailForwards | null>(store, SERVER_OPERATIONS_STATE.systemMail, 'system-mail:v1', parsed(validateSystemMailForwards), () => null),
  panelTls: stateConfigFile<PanelTlsPolicy | null>(store, SERVER_OPERATIONS_STATE.panelTls, 'panel-tls:v1', parsed(validatePanelTlsPolicy), () => null),
  maintenance: stateConfigFile<MaintenanceSchedule>(store, SERVER_OPERATIONS_STATE.maintenance, 'maintenance-schedule:v1', parsed(validateMaintenanceSchedule), defaultMaintenanceSchedule),
  updates: stateConfigFile<UpdatePreferences>(store, SERVER_OPERATIONS_STATE.updates, 'update-preferences:v1', parsed(validateUpdatePreferences), defaultUpdatePreferences),
})
/** The revision-bound files of this workspace, for tools that move them between servers. */
export const serverOperationFiles = files
const NAMESPACES = { resolvers: 'server-resolvers:v1', forwards: 'domain-forwards:v1', roles: 'server-roles:v1', systemMail: 'system-mail:v1', panelTls: 'panel-tls:v1', maintenance: 'maintenance-schedule:v1', updates: 'update-preferences:v1' } as const

/** The value and revision of one file; a saved file that fails its validator is refused, never replaced by defaults. */
async function current<T>(file: PanelConfigFile<T>, namespace: string): Promise<{ value: T; revision: string }> {
  const { raw, value } = await file.read()
  if (value === null && raw !== null) return fail('PRECONDITION_FAILED', 'the saved setting is invalid; restore it before changing it', { ...unchanged, reason: 'server_setting_invalid' })
  return { value: value as T, revision: panelConfigRevision(namespace, raw) }
}

interface Context { request: Request; caller: AuthenticatedCaller; helpers: ServerOperationsHelpers; action: string }
const authority = (ctx: Context) => async (): Promise<void> => {
  const fresh = await ctx.helpers.requireCaller(ctx.request)
  if (fresh.principal.id !== ctx.caller.principal.id) fail('FORBIDDEN', 'server authority changed', unchanged)
  await ctx.helpers.assertRoot(fresh, ctx.action)
}
const audit = (ctx: Context, action: string, target: string, detail: Record<string, unknown> = {}): Promise<unknown> =>
  ctx.helpers.emitAudit({ actor: ctx.caller.principal.username, action, target, detail, outcome: 'ok', principalId: ctx.caller.principal.id })

/** A generation the host's config test refused restores the previous saved value, which is still running. */
export async function saveAndReconcile<T>(ctx: Context, file: PanelConfigFile<T>, namespace: string, next: T, expected: string, previous: T): Promise<{ reconcile: Record<string, unknown> | null; revision: string }> {
  const saved = await file.write(next, expected, authority(ctx))
  const reconcile = await ctx.helpers.triggerReconcile(ctx.caller)
  const failedTest = reconcile?.body.status === 'failed' && reconcile.body.verificationRequired !== true && typeof reconcile.body.failedTest === 'string' ? reconcile.body.failedTest : null
  if (failedTest) {
    await file.write(previous, panelConfigRevision(namespace, saved.raw), authority(ctx))
    return fail('CONFIG_TEST_FAILED', 'the configuration test refused this change; the previous setting stays saved and running', { ...unchanged, failedTest, reason: 'config_test_refused' })
  }
  return { reconcile: reconcile?.body ?? null, revision: panelConfigRevision(namespace, saved.raw) }
}

const domainsOf = (snapshot: Pick<StateSnapshot, 'domains' | 'accounts'>): string[] => snapshot.domains.map(domain => domain.name)

// ---- Resolver Configuration ----------------------------------------------------------------

async function resolversRoute(ctx: Context, method: string): Promise<Response> {
  const { helpers, caller } = ctx, file = files(helpers.store).resolvers, read = await current(file, NAMESPACES.resolvers)
  if (method === 'GET') return panelJson({ revision: read.revision, resolvers: read.value?.resolvers ?? null })
  const body = await readPanelConfigBody(ctx.request)
  if (!exactKeys(body, ['resolvers', 'expectedRevision'])) return fail('VALIDATION', 'exactly resolvers and expectedRevision are required', unchanged)
  const resolvers = validateServerResolvers(body.resolvers), expected = assertExpectedRevision(body.expectedRevision)
  const saved = await file.write({ resolvers }, expected, authority(ctx))
  await audit(ctx, 'server.resolvers.saved', 'server:resolvers', { resolvers })
  let applied: boolean | null = null, refused: string | null = null
  if (helpers.callHost) {
    try { applied = (await helpers.callHost(caller, '/host/server/resolvers/apply', {}) as { applied?: unknown }).applied === true }
    catch (error) { applied = false; refused = isXpanelError(error) ? String(error.detail.reason ?? error.code) : 'host_apply_failed' }
  }
  return panelJson({ revision: panelConfigRevision(NAMESPACES.resolvers, saved.raw), resolvers, applied, refused })
}

// ---- Domain Forwarding ---------------------------------------------------------------------

/** Asks the host for the certificate of a forward, records it without an account and renders the HTTPS server. */
async function forwardCertificateRoute(ctx: Context, domain: string): Promise<Response> {
  const { helpers, caller } = ctx, list = (await current(files(helpers.store).forwards, NAMESPACES.forwards)).value ?? []
  if (!list.some(item => item.domain === domain)) return fail('NOT_FOUND', 'no forward exists for that domain', unchanged)
  if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'privileged host agent is not connected', unchanged)
  const issued = readIssuedCertificate(await helpers.callHost(caller, '/host/domain-forwards/certificate', { domain }))
  if (!issued) return fail('SERVICE_UNAVAILABLE', 'the certificate outcome could not be verified', { stateChanged: true, verificationRequired: true })
  await recordForwardCertificate(helpers.store, issued)
  const reconcile = await helpers.triggerReconcile(caller)
  await audit(ctx, 'server.domain_forward.certificate', `domain:${domain}`, { notAfter: issued.notAfter })
  return panelJson({ domain, notAfter: issued.notAfter, reconcile: reconcile?.body ?? null })
}

async function forwardsRoute(ctx: Context, method: string, domain: string | undefined): Promise<Response> {
  const { helpers } = ctx, file = files(helpers.store).forwards, read = await current(file, NAMESPACES.forwards)
  const list = read.value ?? []
  if (method === 'GET') return panelJson({ revision: read.revision, forwards: list })
  if (method === 'DELETE') {
    const next = list.filter(item => item.domain !== domain)
    if (next.length === list.length) return fail('NOT_FOUND', 'no forward exists for that domain', unchanged)
    const body = await readPanelConfigBody(ctx.request)
    const result = await saveAndReconcile(ctx, file, NAMESPACES.forwards, next, assertExpectedRevision(body.expectedRevision), list)
    await audit(ctx, 'server.domain_forward.removed', `domain:${domain}`)
    return panelJson({ ...result, forwards: next })
  }
  const body = await readPanelConfigBody(ctx.request)
  if (!exactKeys(body, ['domain', 'url', 'expectedRevision'])) return fail('VALIDATION', 'exactly domain, url and expectedRevision are required', unchanged)
  const name = validateDomainName(body.domain), url = validateForwardUrl(body.url), expected = assertExpectedRevision(body.expectedRevision)
  const snapshot = await helpers.store.readSnapshot()
  if (domainsOf(snapshot).includes(name)) return fail('CONFLICT', 'this domain is hosted on an account of this server', { ...unchanged, reason: 'forward_domain_hosted' })
  if (list.some(item => item.domain === name)) return fail('CONFLICT', 'this domain already has a forward', { ...unchanged, reason: 'forward_exists' })
  const used = new Set([...ipUsage(snapshot, null).filter(row => row.accounts.length + row.domains.length + row.mail.length + row.resellers.length > 0).map(row => row.address), ...list.map(item => item.ip)])
  const forward: DomainForward = { domain: name, url, ip: nextForwarderIp(snapshot.ipPool ?? [], used), createdAt: new Date().toISOString() }
  const next = [...list, forward]
  const result = await saveAndReconcile(ctx, file, NAMESPACES.forwards, next, expected, list)
  await audit(ctx, 'server.domain_forward.created', `domain:${name}`, { ip: forward.ip })
  return accepted({ ...result, forward, forwards: next }, 201)
}

// ---- Server Profile, DNS and FTP server selection ------------------------------------------

/** Accounts keep sites, mail and databases: a role they use is not stopped under them. */
const assertRolesFree = (snapshot: Pick<StateSnapshot, 'accounts'>, changes: readonly ServerRoleChange[]): void => {
  const blocked = changes.filter(item => item.change === 'disable' && ['web', 'mail', 'mysql'].includes(item.role)).map(item => item.role)
  if (blocked.length && snapshot.accounts.length) fail('PRECONDITION_FAILED', 'hosted accounts use these roles; move or remove them first', { ...unchanged, reason: 'role_in_use', roles: blocked, accounts: snapshot.accounts.length })
}

const rolesView = (state: ServerRoleState, revision: string) => ({ revision, state, effective: [...effectiveServerRoles(state)], profiles: SERVER_PROFILES })

async function applyRoles(ctx: Context, read: { value: ServerRoleState }, next: ServerRoleState, expected: string): Promise<Response> {
  const { helpers, caller } = ctx
  const changes = serverRoleChanges(read.value, next)
  if (changes.length === 0 && JSON.stringify(read.value) === JSON.stringify(next)) return fail('VALIDATION', 'this is the current configuration', { ...unchanged, reason: 'NO_CHANGES' })
  assertRolesFree(await helpers.store.readSnapshot(), changes)
  const saved = await files(helpers.store).roles.write(next, expected, authority(ctx))
  await audit(ctx, 'server.roles.saved', 'server:roles', { profile: next.profile, changes })
  const revision = panelConfigRevision(NAMESPACES.roles, saved.raw)
  if (!helpers.callHost || changes.length === 0) return panelJson({ ...rolesView(next, revision), changes, job: null, units: [] })
  const host = await helpers.callHost(caller, '/host/server/roles/apply', { changes }) as { job?: unknown; units?: unknown }
  return accepted({ ...rolesView(next, revision), changes, job: host.job ?? null, units: host.units ?? [] }, 202)
}

async function rolesRoute(ctx: Context, method: string, tail: string | undefined): Promise<Response> {
  const file = files(ctx.helpers.store).roles, read = await current(file, NAMESPACES.roles)
  if (method === 'GET') return panelJson(rolesView(read.value, read.revision))
  const body = await readPanelConfigBody(ctx.request)
  const review = tail === 'review', selection = ctx.action === 'server.service_selection.save'
  const keys = selection ? ['dnsServer', 'ftpServer', 'expectedRevision'] : review ? ['profile', 'optional'] : ['profile', 'optional', 'expectedRevision']
  if (!exactKeys(body, keys)) return fail('VALIDATION', `exactly ${keys.join(', ')} are required`, unchanged)
  const next = validateServerRoles(selection ? { ...read.value, dnsServer: body.dnsServer, ftpServer: body.ftpServer } : { ...read.value, profile: body.profile, optional: body.optional })
  if (review) {
    const changes = serverRoleChanges(read.value, next), snapshot = await ctx.helpers.store.readSnapshot()
    if (changes.length === 0 && JSON.stringify(read.value) === JSON.stringify(next)) return fail('VALIDATION', 'this is the current configuration', { ...unchanged, reason: 'NO_CHANGES' })
    assertRolesFree(snapshot, changes)
    return panelJson({ revision: read.revision, changes, effective: [...effectiveServerRoles(next)] })
  }
  return applyRoles(ctx, read, next, assertExpectedRevision(body.expectedRevision))
}

// ---- Edit System Mail Preferences ----------------------------------------------------------

async function systemMailRoute(ctx: Context, method: string): Promise<Response> {
  const file = files(ctx.helpers.store).systemMail, read = await current(file, NAMESPACES.systemMail)
  if (method === 'GET') return panelJson({ revision: read.revision, forwards: read.value })
  const body = await readPanelConfigBody(ctx.request)
  if (!exactKeys(body, ['forwards', 'expectedRevision'])) return fail('VALIDATION', 'exactly forwards and expectedRevision are required', unchanged)
  const forwards = validateSystemMailForwards(body.forwards), expected = assertExpectedRevision(body.expectedRevision)
  const usernames = new Set(['root', ...(await ctx.helpers.store.readSnapshot()).accounts.map(account => account.username)])
  const unknown = Object.values(forwards).find(target => target !== null && !target.includes('@') && !usernames.has(target))
  if (unknown) return fail('VALIDATION', 'a local forward must name a hosting account or root', { ...unchanged, reason: 'forward_target_unknown' })
  const result = await saveAndReconcile(ctx, file, NAMESPACES.systemMail, forwards, expected, read.value)
  await audit(ctx, 'server.system_mail.saved', 'server:system-mail')
  return panelJson({ ...result, forwards })
}

// ---- cPanel Web Services Configuration ------------------------------------------------------

async function panelTlsRoute(ctx: Context, method: string): Promise<Response> {
  const file = files(ctx.helpers.store).panelTls, read = await current(file, NAMESPACES.panelTls)
  if (method === 'GET') return panelJson({ revision: read.revision, saved: read.value !== null, policy: read.value ?? defaultPanelTlsPolicy() })
  const body = await readPanelConfigBody(ctx.request)
  if (!exactKeys(body, ['protocols', 'ciphers', 'expectedRevision'])) return fail('VALIDATION', 'exactly protocols, ciphers and expectedRevision are required', unchanged)
  const policy = validatePanelTlsPolicy({ protocols: body.protocols, ciphers: body.ciphers })
  const result = await saveAndReconcile(ctx, file, NAMESPACES.panelTls, policy, assertExpectedRevision(body.expectedRevision), read.value)
  await audit(ctx, 'server.panel_tls.saved', 'server:panel-tls', { protocols: policy.protocols })
  return panelJson({ ...result, saved: true, policy })
}

// ---- Configure cPanel Cron Jobs -------------------------------------------------------------

const backupSchedulePath = (store: Pick<Store, 'rootDir'>): string => join(store.rootDir, 'extended', 'backups', 'schedule.json')

async function maintenanceRoute(ctx: Context, method: string): Promise<Response> {
  const { helpers } = ctx, file = files(helpers.store).maintenance, read = await current(file, NAMESPACES.maintenance)
  const saved = await readJsonIfExists<Record<string, unknown>>(backupSchedulePath(helpers.store))
  const backup = saved && typeof saved.cron === 'string' ? saved.cron : null
  const view = (updater: string, cron: string | null, revision: string) => ({ revision, updater, backup: cron, moreThanDaily: { updater: runsMoreThanDaily(updater), backup: cron !== null && runsMoreThanDaily(cron) } })
  if (method === 'GET') return panelJson(view(read.value.updater, backup, read.revision))
  const body = await readPanelConfigBody(ctx.request)
  if (!exactKeys(body, ['updater', 'backup', 'expectedRevision'])) return fail('VALIDATION', 'exactly updater, backup and expectedRevision are required', unchanged)
  const { updater } = validateMaintenanceSchedule({ updater: body.updater })
  const nextBackup = body.backup === null ? null : validateMaintenanceSchedule({ updater: body.backup }).updater
  if (nextBackup !== null && !saved) return fail('PRECONDITION_FAILED', 'save a backup configuration first; its schedule is edited here once it exists', { ...unchanged, reason: 'backup_schedule_not_saved' })
  const written = await file.write({ updater }, assertExpectedRevision(body.expectedRevision), authority(ctx))
  if (nextBackup !== null && nextBackup !== backup) {
    // The one schedule file the backup runner reads, through the writer lease the backup workspace also holds.
    const lease = await helpers.store.getWriterLock().acquire()
    try { await lease.assertFencingToken(); await atomicWriteJson(backupSchedulePath(helpers.store), { ...saved, cron: nextBackup, updatedAt: new Date().toISOString() }) } finally { await lease.release() }
  }
  await audit(ctx, 'server.maintenance_schedule.saved', 'server:maintenance-schedule', { updater, backup: nextBackup })
  return panelJson(view(updater, nextBackup ?? backup, panelConfigRevision(NAMESPACES.maintenance, written.raw)))
}

// ---- Update Preferences ---------------------------------------------------------------------

async function updatesRoute(ctx: Context, method: string): Promise<Response> {
  const { helpers, caller } = ctx, file = files(helpers.store).updates, read = await current(file, NAMESPACES.updates)
  const view = (value: UpdatePreferences, revision: string, ledger: unknown) => ({ revision, tier: value.tier, updates: value.updates, securityPatches: value.securityPatches, majorDelayDays: value.majorDelayDays, owner: value.owner?.username ?? null, ledger })
  const ledger = await readJsonIfExists<unknown>(join(helpers.store.rootDir, SERVER_OPERATIONS_STATE.updateLedger))
  if (method === 'GET') return panelJson(view(read.value, read.revision, ledger))
  const body = await readPanelConfigBody(ctx.request)
  const { sendToCluster, majorDelayDays = 0, ...fixed } = body
  if (!exactKeys(fixed, ['tier', 'updates', 'securityPatches', 'expectedRevision']) || sendToCluster !== undefined && typeof sendToCluster !== 'boolean') return fail('VALIDATION', 'exactly tier, updates, securityPatches, majorDelayDays and expectedRevision are required', unchanged)
  const next = validateUpdatePreferences({ tier: body.tier, updates: body.updates, securityPatches: body.securityPatches, majorDelayDays, owner: { principalId: caller.principal.id, username: caller.principal.username } })
  const written = await file.write(next, assertExpectedRevision(body.expectedRevision), authority(ctx))
  await audit(ctx, 'server.update_preferences.saved', 'server:update-preferences', { tier: next.tier, updates: next.updates, securityPatches: next.securityPatches, majorDelayDays: next.majorDelayDays })
  const pushed = sendToCluster === true ? await helpers.sendToCluster?.(['update-preferences'], 'Update preferences', caller) ?? null : null
  return panelJson({ ...view(next, panelConfigRevision(NAMESPACES.updates, written.raw), ledger), ...(sendToCluster === true ? { cluster: pushed } : {}) })
}

// ---- Add an A Entry for Hostname ------------------------------------------------------------

const primaryAddress = (pool: StateSnapshot['ipPool']): string | null => pool?.find(entry => entry.version === 4 && entry.isPrimary)?.address ?? null

async function hostnameRecordRoute(ctx: Context): Promise<Response> {
  const { helpers, caller } = ctx
  const body = await readPanelConfigBody(ctx.request)
  if (Object.keys(body).some(key => key !== 'ip')) return fail('VALIDATION', 'only ip is accepted', unchanged)
  const settings = await helpers.store.getServerSettings()
  if (!settings) return fail('PRECONDITION_FAILED', 'the server settings are not saved', { ...unchanged, reason: 'server_settings_missing' })
  const hostname = settings.hostname, snapshot = await helpers.store.readSnapshot()
  const raw = body.ip ?? primaryAddress(snapshot.ipPool)
  if (raw === null || raw === undefined) return fail('VALIDATION', 'an address is required: no primary address is saved', { ...unchanged, reason: 'hostname_address_required' })
  const ip = canonicalIp(raw, 'address')
  if (ip.version !== 4) return fail('VALIDATION', 'an A record takes an IPv4 address', { ...unchanged, reason: 'hostname_address_required' })
  const parent = (await helpers.store.listDnsZones()).filter(zone => hostname === zone.name || hostname.endsWith(`.${zone.name}`)).sort((a, b) => b.name.length - a.name.length)[0]
  const zoneName = parent?.name ?? hostname, owner = hostname === zoneName ? '@' : hostname.slice(0, -(zoneName.length + 1))
  const record: DnsRecord = { id: randomUUID(), zone: zoneName, name: owner, type: 'A', ttl: 14400, content: ip.address, priority: null }
  const nameservers = settings.nameservers.map((host): DnsRecord => ({ id: randomUUID(), zone: zoneName, name: '@', type: 'NS', ttl: 86400, content: host, priority: null }))
  const zone: DnsZoneState = parent
    ? { ...parent, serial: parent.serial + 1, records: [...parent.records.filter(item => !(item.type === 'A' && item.name === owner)), record] }
    : { id: randomUUID(), accountId: null, name: hostname, serial: 1, records: [...nameservers, record] }
  await helpers.store.saveDnsZone(zone, { dnsGuard: authority(ctx) })
  const reconcile = await helpers.triggerReconcile(caller)
  await audit(ctx, 'server.hostname_record.added', `zone:${zoneName}`, { hostname, ip: ip.address, created: !parent })
  let verified: boolean | null = null
  if (helpers.callHost) {
    const answer = await helpers.callHost(caller, `/host/dns-ops/lookup?name=${encodeURIComponent(hostname)}`).catch(() => null) as { addresses?: unknown } | null
    verified = Array.isArray(answer?.addresses) && answer.addresses.includes(ip.address)
  }
  return panelJson({ hostname, ip: ip.address, zone: zoneName, created: !parent, verified, reconcile: reconcile?.body ?? null })
}

// ---- Perform a DNS Cleanup ------------------------------------------------------------------

async function dnsCleanupRoute(ctx: Context, method: string): Promise<Response> {
  const { helpers, caller } = ctx
  if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'DNS cleanup requires the protected host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  if (method === 'GET') return panelJson(await helpers.callHost(caller, '/host/dns-ops/cleanup'))
  const result = await helpers.callHost(caller, '/host/dns-ops/cleanup', {}) as { cleaned?: unknown }
  await audit(ctx, 'server.dns_cleanup.done', 'server:dns', { cleaned: result.cleaned })
  return panelJson(result)
}

// ---- Enable DKIM and SPF for All ------------------------------------------------------------

export const MAIL_AUTH_JOB_KIND = 'dns.mail-auth.bulk'
const LEASE_MS = 60_000

/** SPF of one saved zone with the server's main address: existing policies keep every term, a zone without one gets the default. */
export const zoneWithMailAuth = (zone: DnsZoneState, address: string): DnsZoneState | null => {
  const spf = zone.records.find(record => record.type === 'TXT' && record.name === '@' && record.content.toLowerCase().startsWith('v=spf1'))
  if (!spf) return { ...zone, serial: zone.serial + 1, records: [...zone.records, { id: randomUUID(), zone: zone.name, name: '@', type: 'TXT', ttl: 14400, content: defaultSpf(address), priority: null }] }
  const content = spfWithAddress(spf.content, address)
  return content === null ? null : { ...zone, serial: zone.serial + 1, records: zone.records.map(record => record === spf ? { ...record, content } : record) }
}

async function mailAuthRoute(ctx: Context, method: string): Promise<Response> {
  const { helpers, caller } = ctx, db = helpers.db
  if (method === 'GET') {
    const latest = (await listJobs(db, { limit: 50 })).find(job => job.kind === MAIL_AUTH_JOB_KIND)
    const job = latest ? await getDurableJob(db, latest.id) : null
    return panelJson({ job: job ? { id: job.id, reference: job.referenceCode, status: job.status, error: job.error ?? null, progress: job.checkpointData, detail: job.detail } : null })
  }
  const snapshot = await helpers.store.readSnapshot()
  const main = primaryAddress(snapshot.ipPool)
  if (!main) return fail('PRECONDITION_FAILED', 'no primary address is saved', { ...unchanged, reason: 'hostname_address_required' })
  // SPF names the address the world sees, so a 1:1 NAT private address publishes its public mapping.
  const address = natPublicAddresses(snapshot.ipPool ?? []).get(main) ?? main
  const zones = snapshot.zones.filter(zone => zone.accountId !== null).map(zone => zone.name)
  const job = await enqueueDurableJob(db, { kind: MAIL_AUTH_JOB_KIND, actor: `root:${caller.principal.username}`, summary: `Enable DKIM and SPF on ${zones.length} zones`, detail: { zones: zones.length, address }, idempotencyKey: `${MAIL_AUTH_JOB_KIND}:${randomUUID()}`, maxAttempts: 1 })
  const workerId = `mail-auth-${randomUUID()}`
  const lease = await acquireJobLease(db, { jobId: job.id, workerId, leaseDurationMs: LEASE_MS })
  if (!lease) return fail('CONFLICT', 'this job is unavailable', unchanged)
  const held = { jobId: lease.id, workerId, fencingToken: lease.fencingToken }
  await audit(ctx, 'server.mail_auth.queued', 'server:dns', { zones: zones.length })
  void (async () => {
    let updated = 0, kept = 0, failed = 0
    try {
      for (const [index, name] of zones.entries()) {
        try {
          const zone = await helpers.store.getDnsZone(name)
          const next = zone ? zoneWithMailAuth(zone, address) : null
          if (next) { await helpers.store.saveDnsZone(next); updated += 1 } else kept += 1
        } catch { failed += 1 }
        if (index % 16 === 15) { await renewJobLease(db, { ...held, leaseDurationMs: LEASE_MS }); await saveJobCheckpoint(db, { ...held, step: `zone-${index}`, data: { done: index + 1, total: zones.length, updated, kept, failed } }) }
      }
      await renewJobLease(db, { ...held, leaseDurationMs: 300_000 })
      // The reconcile creates missing DKIM keys and publishes their selector records; existing keys stay untouched.
      const reconcile = await helpers.triggerReconcile(caller)
      const applied = reconcile !== null && reconcile.ok && ['applied', 'noop'].includes(String(reconcile.body.status))
      const ok = applied && failed === 0
      await completeJobWithLease(db, { ...held, status: ok ? 'succeeded' : 'failed', ...(ok ? {} : { error: failed ? `${failed} zones could not be saved` : 'the reconcile did not confirm the records' }), needsAttention: !ok, detail: { zones: zones.length, address, updated, kept, failed, reconcile: reconcile?.body.status ?? null } })
    } catch {
      await completeJobWithLease(db, { ...held, status: 'failed', error: 'the job stopped before it finished', needsAttention: true, detail: { zones: zones.length, address, updated, kept, failed } }).catch(() => undefined)
    }
  })()
  return accepted({ job: { id: job.id, reference: job.referenceCode, status: 'running' }, zones: zones.length, address }, 202)
}

const ROUTES: Readonly<Record<string, { allow: string; guard: string }>> = {
  resolvers: { allow: 'GET, PUT', guard: 'server.resolvers.save' },
  'domain-forwards': { allow: 'GET, POST, DELETE', guard: 'server.domain_forward.save' },
  'role-profile': { allow: 'GET, PUT, POST', guard: 'server.roles.save' },
  'service-selection': { allow: 'GET, PUT', guard: 'server.service_selection.save' },
  'system-mail': { allow: 'GET, PUT', guard: 'server.system_mail.save' },
  'panel-tls': { allow: 'GET, PUT', guard: 'server.panel_tls.save' },
  'maintenance-schedule': { allow: 'GET, PUT', guard: 'server.maintenance_schedule.save' },
  'update-preferences': { allow: 'GET, PUT', guard: 'server.update_preferences.save' },
  'dns-ops': { allow: 'GET, POST', guard: 'server.dns_ops' },
}
const ROUTE = /^\/api\/server\/(resolvers|domain-forwards|role-profile|service-selection|system-mail|panel-tls|maintenance-schedule|update-preferences|dns-ops)(?:\/([a-z0-9.-]{1,253})(\/certificate)?)?$/

export async function handleServerOperationsRoute(request: Request, url: URL, method: string, helpers: ServerOperationsHelpers): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const [, tool, tail, certificate] = match as unknown as [string, string, string | undefined, string | undefined]
  if (certificate && (tool !== 'domain-forwards' || method !== 'POST')) return null
  const route = ROUTES[tool]!
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, method === 'GET' ? `${route.guard}.read` : route.guard)
  if (!route.allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow: route.allow } })
  if (url.search) return fail('VALIDATION', 'server operations accept no query selectors', unchanged)
  const ctx: Context = { request, caller, helpers, action: route.guard }
  switch (tool) {
    case 'resolvers': return tail ? null : resolversRoute(ctx, method)
    case 'domain-forwards': return certificate ? forwardCertificateRoute(ctx, tail!) : (method === 'DELETE') === (tail !== undefined) ? forwardsRoute(ctx, method, tail) : null
    case 'role-profile': return method === 'POST' && tail !== 'review' || method !== 'POST' && tail ? null : rolesRoute(ctx, method, tail)
    case 'service-selection': return tail ? null : rolesRoute(ctx, method, undefined)
    case 'system-mail': return tail ? null : systemMailRoute(ctx, method)
    case 'panel-tls': return tail ? null : panelTlsRoute(ctx, method)
    case 'maintenance-schedule': return tail ? null : maintenanceRoute(ctx, method)
    case 'update-preferences': return tail ? null : updatesRoute(ctx, method)
    default:
      if (tail === 'hostname-a-record' && method === 'POST') return hostnameRecordRoute(ctx)
      if (tail === 'cleanup') return dnsCleanupRoute(ctx, method)
      if (tail === 'mail-auth') return mailAuthRoute(ctx, method)
      return null
  }
}
