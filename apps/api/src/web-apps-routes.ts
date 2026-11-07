import { fail, validateDomainName } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { requireDomainAccount } from './authorization.ts'
import type { InstalledAppRecord } from './extended-routes.ts'

export interface WebAppsRoutePorts {
  store: StateStore
  requireCaller: (req: Request) => Promise<AuthenticatedCaller>
  resolveAccountParam: (idOrUsername: string) => Promise<Account>
  assertCanAccessAccount: (caller: AuthenticatedCaller, account: Account, action: string) => Promise<void>
  readApps: (accountId: string) => Promise<InstalledAppRecord[]>
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } })
const readBody = async <T>(req: Request): Promise<T> => {
  if (req.body === null) return {} as T
  let body: unknown
  try { body = await req.json() } catch { return fail('VALIDATION', 'request body must be valid JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'request body must be a JSON object')
  return body as T
}
// Web apps run through /api/account/runtime, one systemd unit per application; catalog applications run through /api/account/applications.
const unavailable = (): never => fail('PRECONDITION_FAILED', 'applications are changed through the account applications page or /api/server/site-software/instances', {
  reason: 'application_route_replaced', stateChanged: false, nativeApplied: false,
})

/** /api/apps/:account[/:id[/staging-clone|staging-push]]: stored records read-only, every change refused. */
export async function handleWebAppsRoute(req: Request, url: URL, method: string, ports: WebAppsRoutePorts): Promise<Response | null> {
  const pathname = url.pathname
  const appStagingMatch = /^\/api\/apps\/([^/]+)\/([^/]+)\/(staging-clone|staging-push)$/.exec(pathname)
  const appItemMatch = /^\/api\/apps\/([^/]+)\/([^/]+)$/.exec(pathname)
  const appListMatch = /^\/api\/apps\/([^/]+)$/.exec(pathname)
  if (!appStagingMatch && !appItemMatch && !appListMatch) return null
  const caller = await ports.requireCaller(req)
  const account = await ports.resolveAccountParam((appStagingMatch?.[1] ?? appItemMatch?.[1] ?? appListMatch?.[1])!)
  await ports.assertCanAccessAccount(caller, account, 'apps.manage')
  const apps = await ports.readApps(account.id)

  if (appListMatch && method === 'GET') return json({ apps })
  if (appListMatch && method === 'POST') {
    const body = await readBody<Partial<InstalledAppRecord>>(req)
    const domain = validateDomainName(body.domain ?? account.primaryDomain)
    if (domain !== account.primaryDomain) await requireDomainAccount(ports.store, caller, domain, 'apps.manage', account.id)
    await ports.assertCanAccessAccount(caller, account, 'apps.manage')
    return unavailable()
  }
  if (appStagingMatch && method === 'POST') {
    const targetApp = apps.find(app => app.id === appStagingMatch[2])
    if (!targetApp) return fail('NOT_FOUND', `installed app "${appStagingMatch[2]}" not found`)
    if (appStagingMatch[3] === 'staging-clone') {
      const body = await readBody<{ stagingDomain?: string }>(req)
      const stagingDomain = body.stagingDomain ? validateDomainName(body.stagingDomain) : `staging.${targetApp.domain}`
      if (body.stagingDomain && stagingDomain !== account.primaryDomain && stagingDomain !== `staging.${targetApp.domain}`) {
        await requireDomainAccount(ports.store, caller, stagingDomain, 'apps.manage', account.id)
      }
    }
    await ports.assertCanAccessAccount(caller, account, 'apps.manage')
    return unavailable()
  }
  if (method === 'DELETE' && !appStagingMatch) {
    const body = await readBody<{ id?: string }>(req)
    const targetId = appItemMatch?.[2] ?? url.searchParams.get('id') ?? body.id
    if (!apps.some(app => app.id === targetId)) return fail('NOT_FOUND', `installed app "${targetId ?? ''}" not found`)
    await ports.assertCanAccessAccount(caller, account, 'apps.manage')
    return unavailable()
  }
  return null
}
