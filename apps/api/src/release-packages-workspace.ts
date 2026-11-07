import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'

export interface ReleasePackagesWorkspaceHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  /** Authenticated agent RPC; a body makes it a mutation. */
  readHost: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Root-only report of the packages the installed release declares, and the retry of their job. */
export async function handleReleasePackagesWorkspaceRoute(request: Request, url: URL, method: string, helpers: ReleasePackagesWorkspaceHelpers): Promise<Response | null> {
  const retry = url.pathname === '/api/server/upgrade/packages/retry'
  if (!retry && url.pathname !== '/api/server/upgrade/packages') return null
  const action = retry ? 'server.upgrade.packages' : 'server.upgrade.read', allowed = retry ? 'POST' : 'GET'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (method !== allowed) return new Response(null, { status: 405, headers: { allow: allowed } })
  if (url.search) return fail('VALIDATION', 'release package routes do not accept selectors', { stateChanged: false })
  if (!retry) return json(await helpers.readHost(caller, '/host/upgrade/packages'))
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  let body: unknown
  try { body = JSON.parse((await request.text()).slice(0, 4096)) } catch { body = null }
  const value = body as Record<string, unknown> | null
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'expectedRevision' || typeof value.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedRevision)) return fail('VALIDATION', 'the observed package revision is required', { stateChanged: false })
  const current = await helpers.requireCaller(request)
  if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'upgrade authority changed', { stateChanged: false })
  await helpers.assertRoot(current, action)
  return json(await helpers.readHost(current, '/host/upgrade/packages/retry', { expectedRevision: value.expectedRevision }), 202)
}
