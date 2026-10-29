import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fail } from '@xpanel/core'
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

/** Archives a destination may request: root API token callers only, because the token signs the manifest. */
export const TRANSFER_SOURCE_BACKUP_ROUTE = /^\/api\/transfers\/source\/accounts\/([a-z][a-z0-9]{0,15})\/backup(?:\/([^/]+))?$/
export const transferSourceBackupPath = (username: string, file?: string): string => '/api/transfers/source/accounts/' + username + '/backup' + (file === undefined ? '' : '/' + file)
export const TRANSFER_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024
export interface TransferArchiveManifest { source: string; username: string; file: string; bytes: number; sha256: string; createdAt: string }
export const isTransferArchiveName = (username: string, file: string): boolean => new RegExp(`^xpanel-backup-${username}-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\\.tar\\.gz$`).test(file)
const MANIFEST_KEYS = 'bytes,createdAt,file,sha256,source,username'
/** HMAC-SHA256 under the API token both servers hold; the canonical form is the fixed field order. */
export const signTransferManifest = (token: string, manifest: TransferArchiveManifest): string =>
  createHmac('sha256', token).update(JSON.stringify([manifest.source, manifest.username, manifest.file, manifest.bytes, manifest.sha256, manifest.createdAt])).digest('hex')
/** Destination check of a source reply: exact shape, the expected source and account, and a matching signature. */
export function verifyTransferManifest(raw: unknown, token: string, expected: { source: string; username: string }): TransferArchiveManifest {
  const bad = (): never => fail('PRECONDITION_FAILED', 'the source returned an invalid or unsigned archive manifest', { stateChanged: false })
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  if (!object(raw) || Object.keys(raw).sort().join() !== 'manifest,signature' || typeof raw.signature !== 'string' || !/^[0-9a-f]{64}$/.test(raw.signature) || !object(raw.manifest)) return bad()
  const m = raw.manifest
  if (Object.keys(m).sort().join() !== MANIFEST_KEYS || m.source !== expected.source || m.username !== expected.username || typeof m.file !== 'string' || !isTransferArchiveName(expected.username, m.file)
    || !Number.isSafeInteger(m.bytes) || (m.bytes as number) <= 0 || (m.bytes as number) > TRANSFER_ARCHIVE_MAX_BYTES || typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)
    || typeof m.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(m.createdAt)) return bad()
  const manifest: TransferArchiveManifest = { source: m.source as string, username: m.username as string, file: m.file, bytes: m.bytes as number, sha256: m.sha256, createdAt: m.createdAt }
  if (!timingSafeEqual(Buffer.from(signTransferManifest(token, manifest), 'hex'), Buffer.from(raw.signature, 'hex'))) return bad()
  return manifest
}

export interface TransferSourceBackupPorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  readSnapshot: () => Promise<Pick<StateSnapshot, 'server' | 'accounts'>>
  /** Agent POST /transfers/source/accounts/<username>/archives: { file, bytes, sha256 }. */
  createArchive: (caller: AuthenticatedCaller, username: string) => Promise<Response>
  /** Agent GET /transfers/source/accounts/<username>/archives/<file>: the archive bytes. */
  openArchive: (caller: AuthenticatedCaller, username: string, file: string) => Promise<Response>
  now?: () => Date
}

/** POST /api/transfers/source/accounts/<username>/backup (signed manifest) and GET …/backup/<file> (archive stream). */
export async function handleTransferSourceBackupRoute(req: Request, url: URL, method: string, ports: TransferSourceBackupPorts): Promise<Response | null> {
  const match = TRANSFER_SOURCE_BACKUP_ROUTE.exec(url.pathname)
  if (!match) return null
  const username = match[1]!, file = match[2]
  const caller = await ports.requireCaller(req)
  await ports.assertRoot(caller, 'transfers.source.backup')
  const allow = file === undefined ? 'POST' : 'GET'
  if (method !== allow) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return fail('VALIDATION', 'the source archive accepts no selectors', { stateChanged: false })
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization')?.trim() ?? '')?.[1]
  if (caller.apiTokenId === null || !token) return fail('FORBIDDEN', 'a root API token is required to export an account to another server', { stateChanged: false })
  const snapshot = await ports.readSnapshot()
  const account = snapshot.accounts.find(item => item.username === username)
  const source = snapshot.server?.settings.hostname
  if (!account || account.status === 'terminating') return fail('NOT_FOUND', 'account not found', { stateChanged: false })
  if (!source) return unavailable('this server has no saved hostname; finish server setup first')
  const fresh = async (): Promise<void> => {
    const current = await ports.requireCaller(req)
    await ports.assertRoot(current, 'transfers.source.backup')
    if (current.principal.id !== caller.principal.id || current.apiTokenId !== caller.apiTokenId) fail('FORBIDDEN', 'source archive authority changed', { stateChanged: false })
  }
  if (file !== undefined) {
    if (!isTransferArchiveName(username, file)) return fail('VALIDATION', 'the archive name is invalid', { stateChanged: false })
    const response = await ports.openArchive(caller, username, file)
    if (response.status !== 200 || !response.body) { await response.body?.cancel().catch(() => undefined); return unavailable('the archive could not be read on this source') }
    await fresh()
    const length = response.headers.get('content-length')
    return new Response(response.body, { headers: { 'content-type': 'application/gzip', ...(length && /^\d+$/.test(length) ? { 'content-length': length } : {}), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }
  if (req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || (await req.text()).trim() !== '{}') return fail('VALIDATION', 'the archive request body is exactly {}', { stateChanged: false })
  const response = await ports.createArchive(caller, username)
  if (response.status !== 201) { await response.body?.cancel().catch(() => undefined); return unavailable('the account archive could not be created on this source') }
  const reply = await readReply(response)
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return unavailable('the account archive could not be verified on this source')
  const created = reply as Record<string, unknown>
  if (typeof created.file !== 'string' || !isTransferArchiveName(username, created.file) || !Number.isSafeInteger(created.bytes) || (created.bytes as number) <= 0 || (created.bytes as number) > TRANSFER_ARCHIVE_MAX_BYTES || typeof created.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(created.sha256)) return unavailable('the account archive could not be verified on this source')
  await fresh()
  const manifest: TransferArchiveManifest = { source, username, file: created.file, bytes: created.bytes as number, sha256: created.sha256, createdAt: (ports.now?.() ?? new Date()).toISOString() }
  return Response.json({ manifest, signature: signTransferManifest(token, manifest) }, { status: 201, headers: { 'cache-control': 'no-store' } })
}
