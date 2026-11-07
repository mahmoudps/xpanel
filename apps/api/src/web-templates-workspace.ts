import { fail } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'

const ROUTE = /^\/api\/accounts\/web-templates(?:\/(default|suspended))?$/
const unchanged = { stateChanged: false }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const revisionOf = (raw: unknown): string => sha256Hex(JSON.stringify(raw ?? null))
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export interface WebTemplatesPorts {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>
  /** null for root: its pages are the server's own. */
  resellerOf: (caller: AuthenticatedCaller) => Promise<string | null>
  /** ExtendedFeaturesStore `accounts/web-templates/<scope>.json`. */
  read: (scope: string) => Promise<unknown>
  write: (scope: string, value: unknown) => Promise<unknown>
  /** Publishes the saved pages through the host reconcile. */
  apply: (caller: AuthenticatedCaller) => Promise<unknown>
  audit: (caller: AuthenticatedCaller, kind: edge.AccountPageKind, action: 'saved' | 'reverted') => Promise<void>
  now?: () => Date
}

type Saved = Partial<Record<edge.AccountPageKind, { html: string; updatedAt: string; updatedBy: string }>>
const savedOf = (raw: unknown): Saved => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Saved : {}
export const assertPageHtml = (value: unknown): string => {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || Buffer.byteLength(value, 'utf8') > edge.ACCOUNT_PAGE_MAX_BYTES || FORBIDDEN.test(value)) return fail('VALIDATION', `a page is 1 byte to ${edge.ACCOUNT_PAGE_MAX_BYTES / 1024} KiB of text`, unchanged)
  return value
}
const view = (raw: unknown, scope: string) => {
  const saved = savedOf(raw)
  return { scope, revision: revisionOf(raw), variables: ['%contact%'], pages: Object.fromEntries(edge.ACCOUNT_PAGE_KINDS.map(kind => [kind, { state: saved[kind] ? 'custom' : 'shipped', html: saved[kind]?.html ?? edge.SHIPPED_ACCOUNT_PAGES[kind], updatedAt: saved[kind]?.updatedAt ?? null, shipped: edge.SHIPPED_ACCOUNT_PAGES[kind] }])) }
}

// shortcut: in-process serialization only; one API process owns these extended state files.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run }

/** WHM Web Template Editor. GET reads the caller's pages; PUT saves one and DELETE restores the shipped page, then the host publishes them. */
export async function handleWebTemplatesRoute(request: Request, url: URL, method: string, ports: WebTemplatesPorts): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const caller = await ports.requireCaller(request)
  if (caller.principal.kind !== 'root' && caller.principal.kind !== 'reseller') return fail('FORBIDDEN', 'hosting administrator permission is required', unchanged)
  const kind = match[1] as edge.AccountPageKind | undefined, allow = kind ? 'PUT, DELETE' : 'GET'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return fail('VALIDATION', 'web templates take no selectors', unchanged)
  const reseller = await ports.resellerOf(caller), scope = reseller ?? 'root'
  if (!kind) return json(view(await ports.read(scope), scope))
  const body = await ports.readJsonBody(request)
  const html = method === 'PUT' ? assertPageHtml(body.html) : null
  return serial(async () => {
    const raw = await ports.read(scope)
    if (revisionOf(raw) !== body.expectedRevision) return fail('CONFLICT', 'the templates changed since they were read; reload before saving', unchanged)
    const { [kind]: _old, ...others } = savedOf(raw)
    const next: Saved = html === null ? others : { ...others, [kind]: { html, updatedAt: (ports.now?.() ?? new Date()).toISOString(), updatedBy: caller.principal.username } }
    await ports.write(scope, next)
    if (revisionOf(await ports.read(scope)) !== revisionOf(next)) return fail('SERVICE_UNAVAILABLE', 'the saved template could not be verified', { stateChanged: true, verificationRequired: true })
    await ports.audit(caller, kind, html === null ? 'reverted' : 'saved')
    let application: unknown
    try { application = await ports.apply(caller) }
    catch { return json({ ...view(next, scope), application: null, published: false }) }
    return json({ ...view(next, scope), application, published: (application as { ok?: unknown } | null)?.ok === true })
  })
}
