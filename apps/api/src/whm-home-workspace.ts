import { fail, isUuid } from '@xpanel/core'
import type { AuditEntry } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'

export const FAVORITE_LIMIT = 24
const INBOX_LIMIT = 100, READ_LIMIT = 500
const FAVORITE_ROUTE = '/api/admin/favorites', INBOX_ROUTE = '/api/admin/notifications', READ_ROUTE = '/api/admin/notifications/read'
const ROUTE = /^\/whm(?:\/[a-z0-9][a-z0-9_-]*){0,4}$/
const ITEM_ID = /^(?:job|audit|backup):[0-9a-zA-Z-]{1,64}$/
const unchanged = { stateChanged: false }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export interface FavoritesDocument { routes: string[]; descriptions: boolean }
export interface InboxItem { id: string; at: string; kind: 'job' | 'audit' | 'backup'; title: string; target: string | null; read: boolean }
interface FailedJob { id: string; summary: string; finishedAt: string | null; updatedAt: string }
interface FailedRun { id: string; startedAt: string; finishedAt: string | null; state: string }
export interface WhmHomePorts {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>
  /** ExtendedFeaturesStore files, one per administrator. */
  read: (relPath: string) => Promise<unknown>
  write: (relPath: string, value: unknown) => Promise<unknown>
  failedJobs: () => Promise<FailedJob[]>
  failedAudit: () => Promise<Pick<AuditEntry, 'id' | 'at' | 'action' | 'target'>[]>
  /** The backup run ledger; empty when no host agent answers, never a reason to hide the rest. */
  backupRuns: (caller: AuthenticatedCaller) => Promise<FailedRun[]>
  actionLabel: (action: string, request: Request) => string
}

const identity = (caller: AuthenticatedCaller): string => {
  const { kind, id } = caller.principal
  return (kind === 'root' || kind === 'reseller') && isUuid(id) ? id.toLowerCase() : fail('FORBIDDEN', 'administrator access is required', unchanged)
}

export function parseFavorites(raw: unknown): FavoritesDocument {
  if (raw === null || raw === undefined) return { routes: [], descriptions: true }
  const value = raw as Partial<FavoritesDocument>
  if (typeof raw !== 'object' || !Array.isArray(value.routes) || value.routes.length > FAVORITE_LIMIT || !value.routes.every(route => typeof route === 'string' && ROUTE.test(route)) || new Set(value.routes).size !== value.routes.length || typeof value.descriptions !== 'boolean'
    || Object.keys(raw).length !== 2) return fail('VALIDATION', `favorites are at most ${FAVORITE_LIMIT} different WHM pages and the description choice`, unchanged)
  return { routes: value.routes, descriptions: value.descriptions }
}

/** Newest first; a job that failed and the audit entry naming it stay separate facts. */
export const inboxItems = (jobs: readonly FailedJob[], audit: readonly Pick<AuditEntry, 'id' | 'at' | 'action' | 'target'>[], runs: readonly FailedRun[], read: ReadonlySet<string>, label: (action: string) => string): InboxItem[] => [
  ...jobs.map((job): InboxItem => ({ id: 'job:' + job.id, at: job.finishedAt ?? job.updatedAt, kind: 'job', title: job.summary, target: null, read: read.has('job:' + job.id) })),
  ...audit.map((entry): InboxItem => ({ id: 'audit:' + entry.id, at: entry.at, kind: 'audit', title: label(entry.action), target: entry.target, read: read.has('audit:' + entry.id) })),
  ...runs.filter(run => run.state !== 'running' && run.state !== 'succeeded').map((run): InboxItem => ({ id: 'backup:' + run.id, at: run.finishedAt ?? run.startedAt, kind: 'backup', title: label('server.backup_run.failed'), target: null, read: read.has('backup:' + run.id) })),
].sort((left, right) => right.at.localeCompare(left.at)).slice(0, INBOX_LIMIT)

const readIds = async (ports: WhmHomePorts, id: string): Promise<string[]> => {
  const raw = await ports.read(`preferences/${id}.notifications.json`)
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && ITEM_ID.test(item)).slice(0, READ_LIMIT) : []
}

/** GET/PUT /api/admin/favorites and GET /api/admin/notifications with POST .../read, each per administrator. */
export async function handleWhmHomeRoute(request: Request, url: URL, method: string, ports: WhmHomePorts): Promise<Response | null> {
  if (![FAVORITE_ROUTE, INBOX_ROUTE, READ_ROUTE].includes(url.pathname)) return null
  const caller = await ports.requireCaller(request), id = identity(caller)
  if (url.pathname === FAVORITE_ROUTE) {
    if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
    if (url.search) return fail('VALIDATION', 'favorites take no selectors', unchanged)
    if (method === 'GET') { try { return json(parseFavorites(await ports.read(`preferences/${id}.favorites.json`))) } catch { return json(parseFavorites(null)) } }
    const document = parseFavorites(await ports.readJsonBody(request))
    await ports.write(`preferences/${id}.favorites.json`, document)
    return json(document)
  }
  // Failed host operations are server facts; a reseller's bell is present and empty.
  if (caller.principal.kind !== 'root') return method === 'GET' && url.pathname === INBOX_ROUTE ? json({ items: [], unread: 0 }) : fail('FORBIDDEN', 'root access is required', unchanged)
  if (url.pathname === READ_ROUTE) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const body = await ports.readJsonBody(request), ids = body.ids
    if (Object.keys(body).join() !== 'ids' || !Array.isArray(ids) || !ids.length || ids.length > INBOX_LIMIT || !ids.every(item => typeof item === 'string' && ITEM_ID.test(item))) return fail('VALIDATION', 'ids must list inbox items', unchanged)
    const merged = [...new Set([...ids as string[], ...await readIds(ports, id)])].slice(0, READ_LIMIT)
    await ports.write(`preferences/${id}.notifications.json`, merged)
    return json({ read: ids })
  }
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const [jobs, audit, runs, read] = await Promise.all([ports.failedJobs(), ports.failedAudit(), ports.backupRuns(caller).catch(() => []), readIds(ports, id)])
  const items = inboxItems(jobs, audit, runs, new Set(read), action => ports.actionLabel(action, request))
  return json({ items, unread: items.filter(item => !item.read).length })
}
