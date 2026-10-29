import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fail } from '@xpanel/core'
import type { Account, Domain, Plan, ServiceUser } from '@xpanel/core'
import type { StateSnapshot } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { projectDisk } from './monitoring-workspace.ts'
import { TRANSFER_SOURCE_INVENTORY_PATH } from './acct-transfer-discovery.ts'
import type { TransferSourceInventory } from './acct-transfer-discovery.ts'
import { readReply } from './backup-file-restore-workspace.ts'

export type TransferSourceSnapshot = Pick<StateSnapshot, 'server' | 'plans' | 'accounts' | 'domains' | 'databases' | 'serviceUsers'>
export interface TransferSourcePorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  readSnapshot: () => Promise<TransferSourceSnapshot>
  /** Agent `/host/monitoring/disk` reply (repquota per account home). */
  readDisk: (caller: AuthenticatedCaller) => Promise<unknown>
  /** Installed release version; defaults to this API package's own version. */
  version?: () => Promise<string>
}
const unavailable = (message: string): never => fail('PRECONDITION_FAILED', message, { stateChanged: false })
const packageVersion = async (): Promise<string> => {
  const raw: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  return raw && typeof raw === 'object' && typeof (raw as { version?: unknown }).version === 'string' ? (raw as { version: string }).version : unavailable('the installed release version could not be read')
}

/** What this server can hand to another xPanel destination: observed facts only, no secrets, no file contents. */
export function buildTransferSourceInventory(snapshot: TransferSourceSnapshot, disk: ReturnType<typeof projectDisk>, version: string): TransferSourceInventory {
  const hostname = snapshot.server?.settings.hostname
  if (!hostname) return unavailable('this server has no saved hostname; finish server setup first')
  if (disk.accounts.state !== 'read') return unavailable('account disk usage could not be observed on this source')
  const used = new Map(disk.accounts.items.map(item => [item.username, item.usedBytes]))
  const plans = new Map(snapshot.plans.map(plan => [plan.id, plan.name]))
  const accounts = snapshot.accounts.filter(account => account.status !== 'terminating').sort((a, b) => a.username.localeCompare(b.username)).map(account => {
    const plan = plans.get(account.planId), diskBytes = used.get(account.username)
    if (plan === undefined) return unavailable('an account refers to a plan that is not saved here')
    if (diskBytes === undefined || diskBytes === null) return unavailable('account disk usage could not be observed on this source')
    const domains = snapshot.domains.filter(domain => domain.accountId === account.id)
    return {
      username: account.username, uid: account.uid, primaryDomain: account.primaryDomain, domains: domains.map(domain => domain.name).sort(), plan, diskBytes,
      databases: snapshot.databases.filter(database => database.accountId === account.id && database.trashedAt === null).map(database => database.name).sort(),
      mailboxes: snapshot.serviceUsers.filter(user => user.accountId === account.id && user.services.email).length,
      phpVersions: [...new Set(domains.map(domain => domain.php.version))].sort(),
    }
  })
  return { source: { hostname, version }, accounts, plans: [...new Set(snapshot.plans.map(plan => plan.name))].sort().map(name => ({ name })) }
}

/** GET /api/transfers/source/inventory, read by a destination server with a root API token (lifecycle read scope). */
export async function handleTransferSourceInventoryRoute(req: Request, url: URL, method: string, ports: TransferSourcePorts): Promise<Response | null> {
  if (url.pathname !== TRANSFER_SOURCE_INVENTORY_PATH) return null
  const caller = await ports.requireCaller(req)
  await ports.assertRoot(caller, 'transfers.source.inventory')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'the source inventory accepts no selectors', { stateChanged: false })
  let disk: ReturnType<typeof projectDisk>
  try { disk = projectDisk(await ports.readDisk(caller)) } catch { return unavailable('account disk usage could not be observed on this source') }
  const inventory = buildTransferSourceInventory(await ports.readSnapshot(), disk, await (ports.version ?? packageVersion)())
  const fresh = await ports.requireCaller(req)
  await ports.assertRoot(fresh, 'transfers.source.inventory')
  if (fresh.principal.id !== caller.principal.id || fresh.apiTokenId !== caller.apiTokenId || fresh.sessionId !== caller.sessionId) return fail('FORBIDDEN', 'source inventory authority changed', { stateChanged: false })
  return Response.json(inventory, { headers: { 'cache-control': 'no-store' } })
}

/** One account package a destination may request: root API token callers only, because the token signs the manifest. */
export const TRANSFER_SOURCE_PACKAGE_ROUTE = /^\/api\/transfers\/source\/accounts\/([a-z][a-z0-9]{0,15})\/package(?:\/([0-9a-f-]{36})(?:\/([^/]+))?)?$/
export const transferSourcePackagePath = (username: string, id?: string): string => '/api/transfers/source/accounts/' + username + '/package' + (id === undefined ? '' : '/' + id)
export const TRANSFER_ARTIFACT_MAX_BYTES = 50 * 1024 ** 3
const ARTIFACT = /^(?:home\.tar\.gz|db-[a-z][a-z0-9]{0,15}_[A-Za-z0-9_]{1,48}\.sql|(?:cert|key)-[0-9]{1,3}\.pem)$/

export type TransferPackageSnapshot = Pick<StateSnapshot, 'server' | 'plans' | 'accounts' | 'domains' | 'databases' | 'databaseUsers' | 'serviceUsers' | 'zones' | 'cronJobs'>
export interface TransferArtifact { name: string; bytes: number; sha256: string }
/**
 * The account's desired state as this server holds it. Password material travels as the stored hashes only
 * (mailbox scheme hashes, MariaDB authentication strings) so sites and mail keep working after the move; it is
 * sent once over the pinned channel and never journaled on either side.
 */
export interface TransferAccountBundle {
  account: { username: string; home: string; primaryDomain: string; contactEmail: string; shell: Account['shell']; ipv4: string }
  plan: Omit<Plan, 'id' | 'ownerId' | 'featureListId'>
  domains: { name: string; kind: Domain['kind']; parent: string | null; docRoot: string; siteType: Domain['siteType']; upstream: string | null; redirect: Domain['redirect']; php: Domain['php']; wildcard: boolean; indexFiles?: string[] }[]
  databases: { name: string; artifact: string }[]
  databaseUsers: { name: string; authPlugin: 'mysql_native_password' | 'ed25519'; authString: string; grants: { database: string; privileges: string[] }[] }[]
  mailboxes: { login: string; services: ServiceUser['services']; mailboxQuotaMb: ServiceUser['mailboxQuotaMb']; ftpDir: string; passwordHash: string }[]
  zones: { name: string; records: { name: string; type: string; ttl: number; content: string; priority: number | null }[] }[]
  cron: { schedule: string; command: string; comment: string; enabled: boolean; maxRuntimeSec?: number }[]
  certificates: { names: string[]; cert: string; key: string }[]
}
export interface TransferPackageManifest { source: string; username: string; package: string; createdAt: string; artifacts: TransferArtifact[]; bundle: TransferAccountBundle }

/** HMAC-SHA256 under the API token both servers hold, over the manifest's JSON text as sent. */
export const signTransferManifest = (token: string, manifest: unknown): string => createHmac('sha256', token).update(JSON.stringify(manifest)).digest('hex')

export function buildTransferAccountBundle(snapshot: TransferPackageSnapshot, username: string, result: { databases: { name: string; artifact: string }[]; certificates: { names: string[]; cert: string; key: string }[] }): TransferAccountBundle {
  const account = snapshot.accounts.find(item => item.username === username) ?? unavailable('the account is no longer on this source')
  const plan = snapshot.plans.find(item => item.id === account.planId) ?? unavailable('the account plan is not saved here')
  const domains = snapshot.domains.filter(domain => domain.accountId === account.id)
  const byId = new Map(domains.map(domain => [domain.id, domain.name]))
  const databases = new Map(snapshot.databases.filter(db => db.accountId === account.id).map(db => [db.id, db.name]))
  const { id: _id, ownerId: _owner, featureListId: _features, ...planFields } = plan
  return {
    account: { username, home: account.home, primaryDomain: account.primaryDomain, contactEmail: account.contactEmail, shell: account.shell, ipv4: account.ipv4 },
    plan: planFields,
    domains: domains.map(domain => ({ name: domain.name, kind: domain.kind, parent: domain.parentId ? byId.get(domain.parentId) ?? null : null, docRoot: domain.docRoot, siteType: domain.siteType, upstream: domain.upstream, redirect: domain.redirect, php: domain.php, wildcard: domain.wildcard, ...(domain.indexFiles ? { indexFiles: domain.indexFiles } : {}) })),
    databases: result.databases,
    databaseUsers: snapshot.databaseUsers.filter(user => user.accountId === account.id).map(user => ({ name: user.name, authPlugin: user.authPlugin, authString: user.authString,
      grants: user.grants.flatMap(grant => databases.has(grant.databaseId) ? [{ database: databases.get(grant.databaseId)!, privileges: [...grant.privileges] }] : []) })),
    mailboxes: snapshot.serviceUsers.filter(user => user.accountId === account.id).map(user => ({ login: user.login, services: user.services, mailboxQuotaMb: user.mailboxQuotaMb, ftpDir: user.ftpDir, passwordHash: user.passwordHash })),
    zones: snapshot.zones.filter(zone => zone.accountId === account.id).map(zone => ({ name: zone.name, records: zone.records.map(record => ({ name: record.name, type: record.type, ttl: record.ttl, content: record.content, priority: record.priority })) })),
    cron: snapshot.cronJobs.filter(job => job.accountId === account.id).map(job => ({ schedule: job.schedule, command: job.command, comment: job.comment, enabled: job.enabled, ...(job.maxRuntimeSec === undefined ? {} : { maxRuntimeSec: job.maxRuntimeSec }) })),
    certificates: result.certificates.map(cert => ({ names: cert.names, cert: cert.cert, key: cert.key })),
  }
}

const list = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length <= max
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
/** Destination check of a source reply: exact envelope, the expected source, account and package, a matching signature. Store rules validate the rest. */
export function verifyTransferManifest(raw: unknown, token: string, expected: { source: string; username: string; package: string }): TransferPackageManifest {
  const bad = (): never => fail('PRECONDITION_FAILED', 'the source returned an invalid or unsigned package manifest', { stateChanged: false })
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  if (!object(raw) || Object.keys(raw).sort().join() !== 'manifest,signature,state' || raw.state !== 'ready' || typeof raw.signature !== 'string' || !/^[0-9a-f]{64}$/.test(raw.signature) || !object(raw.manifest)) return bad()
  if (!timingSafeEqual(Buffer.from(signTransferManifest(token, raw.manifest), 'hex'), Buffer.from(raw.signature, 'hex'))) return bad()
  const m = raw.manifest
  if (Object.keys(m).sort().join() !== 'artifacts,bundle,createdAt,package,source,username' || m.source !== expected.source || m.username !== expected.username || m.package !== expected.package || !text(m.createdAt, 40) || !list(m.artifacts, 1000) || !object(m.bundle)) return bad()
  const artifacts = m.artifacts.map(item => object(item) && typeof item.name === 'string' && ARTIFACT.test(item.name) && Number.isSafeInteger(item.bytes) && (item.bytes as number) >= 0 && (item.bytes as number) <= TRANSFER_ARTIFACT_MAX_BYTES && typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256) ? { name: item.name, bytes: item.bytes as number, sha256: item.sha256 } : bad())
  const b = m.bundle
  const names = new Set(artifacts.map(item => item.name))
  if (!names.has('home.tar.gz') || !object(b.account) || b.account.username !== expected.username || !object(b.plan) || !list(b.domains, 5000) || !list(b.databases, 10_000) || !list(b.databaseUsers, 10_000) || !list(b.mailboxes, 100_000) || !list(b.zones, 5000) || !list(b.cron, 1000) || !list(b.certificates, 1000)) return bad()
  if (!b.databases.every(db => object(db) && typeof db.artifact === 'string' && names.has(db.artifact)) || !b.certificates.every(cert => object(cert) && typeof cert.cert === 'string' && names.has(cert.cert) && typeof cert.key === 'string' && names.has(cert.key))) return bad()
  return { source: m.source as string, username: m.username as string, package: m.package as string, createdAt: m.createdAt, artifacts, bundle: b as unknown as TransferAccountBundle }
}

export interface TransferSourcePackagePorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  readSnapshot: () => Promise<TransferPackageSnapshot>
  /** callAgent: /transfers/tasks and /transfers/packages on this server's agent. */
  agent: (caller: AuthenticatedCaller, path: string, init?: { method?: string; body?: unknown }) => Promise<Response>
}

/**
 * POST …/package {} starts packaging (202); GET …/package/<id> polls it and, once ready, returns the signed manifest
 * with the account bundle; GET …/package/<id>/<artifact> streams one artifact; DELETE …/package/<id> removes the files.
 */
export async function handleTransferSourcePackageRoute(req: Request, url: URL, method: string, ports: TransferSourcePackagePorts): Promise<Response | null> {
  const match = TRANSFER_SOURCE_PACKAGE_ROUTE.exec(url.pathname)
  if (!match) return null
  const username = match[1]!, id = match[2]?.toLowerCase(), artifact = match[3]
  const caller = await ports.requireCaller(req)
  await ports.assertRoot(caller, 'transfers.source.package')
  const allow = id === undefined ? ['POST'] : artifact === undefined ? ['GET', 'DELETE'] : ['GET']
  if (!allow.includes(method)) return new Response(null, { status: 405, headers: { allow: allow.join(', ') } })
  if (url.search) return fail('VALIDATION', 'the source package accepts no selectors', { stateChanged: false })
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization')?.trim() ?? '')?.[1]
  if (caller.apiTokenId === null || !token) return fail('FORBIDDEN', 'a root API token is required to export an account to another server', { stateChanged: false })
  const snapshot = await ports.readSnapshot()
  const account = snapshot.accounts.find(item => item.username === username)
  const source = snapshot.server?.settings.hostname
  if (!account || account.status === 'terminating') return fail('NOT_FOUND', 'account not found', { stateChanged: false })
  if (!source) return unavailable('this server has no saved hostname; finish server setup first')
  const fresh = async (): Promise<void> => {
    const current = await ports.requireCaller(req)
    await ports.assertRoot(current, 'transfers.source.package')
    if (current.principal.id !== caller.principal.id || current.apiTokenId !== caller.apiTokenId) fail('FORBIDDEN', 'source package authority changed', { stateChanged: false })
  }
  if (id === undefined) {
    if (req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || (await req.text()).trim() !== '{}') return fail('VALIDATION', 'the package request body is exactly {}', { stateChanged: false })
    const started = await ports.agent(caller, '/transfers/tasks', { method: 'POST', body: { kind: 'package', username } })
    const reply = started.status === 202 ? await readReply(started) as { task?: { id?: unknown } } | null : (await started.body?.cancel().catch(() => undefined), null)
    if (typeof reply?.task?.id !== 'string') return unavailable('the account package could not be started on this source')
    return Response.json({ package: reply.task.id }, { status: 202, headers: { 'cache-control': 'no-store' } })
  }
  if (artifact !== undefined) {
    let name: string
    try { name = decodeURIComponent(artifact) } catch { return fail('VALIDATION', 'the artifact name is invalid', { stateChanged: false }) }
    if (!ARTIFACT.test(name)) return fail('VALIDATION', 'the artifact name is invalid', { stateChanged: false })
    const response = await ports.agent(caller, '/transfers/packages/' + id + '/' + name)
    if (response.status !== 200 || !response.body) { await response.body?.cancel().catch(() => undefined); return unavailable('the artifact could not be read on this source') }
    await fresh()
    const length = response.headers.get('content-length')
    return new Response(response.body, { headers: { 'content-type': 'application/octet-stream', ...(length && /^\d+$/.test(length) ? { 'content-length': length } : {}), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }
  if (method === 'DELETE') {
    const removed = await ports.agent(caller, '/transfers/tasks/' + id, { method: 'DELETE' })
    await removed.body?.cancel().catch(() => undefined)
    return removed.ok ? Response.json({ discarded: true }, { headers: { 'cache-control': 'no-store' } }) : unavailable('the package files could not be removed on this source')
  }
  const read = await ports.agent(caller, '/transfers/tasks/' + id)
  const reply = read.status === 200 ? await readReply(read) as { task?: Record<string, unknown> } | null : (await read.body?.cancel().catch(() => undefined), null)
  const task = reply?.task
  if (!task || task.kind !== 'package' || task.username !== username) return fail('NOT_FOUND', 'package not found', { stateChanged: false })
  if (task.state === 'queued' || task.state === 'running') return Response.json({ state: 'running' }, { headers: { 'cache-control': 'no-store' } })
  if (task.state !== 'succeeded') return Response.json({ state: 'failed', error: typeof task.error === 'string' ? task.error : 'the package could not be created' }, { headers: { 'cache-control': 'no-store' } })
  const result = task.result as { artifacts: TransferArtifact[]; databases: { name: string; artifact: string }[]; certificates: { names: string[]; cert: string; key: string }[] }
  const manifest: TransferPackageManifest = { source, username, package: id, createdAt: typeof task.updatedAt === 'string' ? task.updatedAt : new Date().toISOString(), artifacts: result.artifacts,
    bundle: buildTransferAccountBundle(await ports.readSnapshot(), username, result) }
  await fresh()
  return Response.json({ state: 'ready', manifest, signature: signTransferManifest(token, manifest) }, { headers: { 'cache-control': 'no-store' } })
}
