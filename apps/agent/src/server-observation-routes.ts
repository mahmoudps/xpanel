import { fail } from '@xpanel/core'
import { readServerNetwork, readServerRole, readServerTimers } from './server-observation.ts'
import type { ServerCronDirectoryRead, ServerObservationReadFile, ServerObservationRun } from './server-observation.ts'

export interface ServerObservationRouteContext {
  /** Re-authenticates the current caller and requires root on every call. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Null when this agent is not running with the native Linux host executor. */
  run: ServerObservationRun | null
  readFile: ServerObservationReadFile | null
  readCronDirectory: ServerCronDirectoryRead | null
  now?: () => Date
}

const ROUTES: Readonly<Record<string, string>> = { '/host/server/timers': 'server.timers.read', '/host/server/network': 'server.network.read', '/host/server/role': 'server.role.read' }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Root-only read-only server observations. Returns null for other paths. Nothing here changes the host. */
export async function handleServerObservationRoute(req: Request, url: URL, method: string, ctx: ServerObservationRouteContext): Promise<Response | null> {
  const action = ROUTES[url.pathname]
  if (!action) return null
  await ctx.assertRoot(action)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search || req.body !== null) return fail('VALIDATION', 'server observations do not accept selectors or a body', { stateChanged: false })
  const base = { ...(ctx.run ? { run: ctx.run } : {}), ...(ctx.now ? { now: ctx.now } : {}) }
  const body = url.pathname === '/host/server/timers' ? await readServerTimers({ ...base, ...(ctx.readCronDirectory ? { readCronDirectory: ctx.readCronDirectory } : {}) })
    : url.pathname === '/host/server/network' ? await readServerNetwork({ ...base, ...(ctx.readFile ? { readFile: ctx.readFile } : {}) })
    : await readServerRole(base)
  // A caller whose root authority ended during the read never receives host facts.
  await ctx.assertRoot(action)
  return json(body)
}
