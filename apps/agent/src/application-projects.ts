import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import { system } from '@xpanel/render'
import { handleAccountRuntimeRoute, pythonEnvUnitName, readRuntimeHostFacts, readRuntimeRegistry, readUnitStates, runtimeRevision } from './account-runtime.ts'
import type { AccountRuntimeContext, RuntimeHost, UnitState } from './account-runtime.ts'

/**
 * Root's view of Go and Java projects and named Python environments across accounts. Every change re-enters the account
 * runtime route with root authority, so a project is one more entry of that account's runtime file, in its slice and
 * isolation, with the same reconcile, rollback and audit as the account's own applications.
 */
const unchanged = { stateChanged: false }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const stateName = (u: UnitState | undefined): string => !u || u.load !== 'loaded' ? 'stopped' : u.active === 'active' ? 'running' : u.active === 'activating' ? 'starting' : u.active === 'failed' ? 'failed' : 'stopped'
const oneshot = (u: UnitState | undefined): string => !u || u.load !== 'loaded' ? 'none' : u.active === 'active' ? 'ready' : u.active === 'activating' ? 'running' : u.active === 'failed' ? 'failed' : 'none'

export interface ApplicationProjectsContext extends Omit<AccountRuntimeContext, 'asRoot' | 'host'> {
  assertRoot(action: string): Promise<{ actor: string }>
  host: RuntimeHost | null
  store: AccountRuntimeContext['store'] & { listAccounts(): Promise<Account[]> }
}

export async function handleApplicationProjectsRoute(req: Request, url: URL, method: string, ctx: ApplicationProjectsContext): Promise<Response | null> {
  if (url.pathname !== '/host/application-projects' && url.pathname !== '/host/application-projects/log') return null
  if (url.pathname.endsWith('/log')) {
    await ctx.assertRoot('application.projects.read')
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const account = url.searchParams.get('account') ?? '', target = url.searchParams.get('target') ?? ''
    if (!/^[a-z][a-z0-9]{0,15}$/.test(account)) return fail('VALIDATION', 'choose one account', unchanged)
    return handleAccountRuntimeRoute(new Request(`http://agent.local/accounts/${account}/runtime/log?target=${encodeURIComponent(target)}`), new URL(`http://agent.local/accounts/${account}/runtime/log?target=${encodeURIComponent(target)}`), 'GET', { ...ctx, asRoot: true })
  }
  if (method === 'GET') {
    await ctx.assertRoot('application.projects.read')
    const accounts = (await ctx.store.listAccounts()).filter(account => account.status === 'active').sort((a, b) => a.username.localeCompare(b.username, 'en')).slice(0, 2000)
    const domains = await ctx.store.listDomains(), root = ctx.store.rootDir
    const facts = await readRuntimeHostFacts(ctx.host, { username: 'root', uid: 0 })
    const rows = await Promise.all(accounts.map(async account => {
      const registry = await readRuntimeRegistry(root, account.id), projects = registry.apps.filter(app => app.project), envs = registry.pythonEnvs ?? []
      const units = [...projects.map(app => system.appPaths(account.username, app.name).service), ...envs.map(env => pythonEnvUnitName(account.username, env.name))]
      const states = await readUnitStates(ctx.host, units)
      const site = (id: string): Domain | undefined => domains.find(domain => domain.id === id)
      return {
        account: account.username, revision: runtimeRevision(registry), domains: domains.filter(domain => domain.accountId === account.id && !domain.suspended && domain.kind !== 'alias').map(domain => ({ id: domain.id, name: domain.name })),
        projects: projects.map(app => ({ name: app.name, runtime: app.runtime, root: app.root, startup: app.startup, domainId: app.domainId, domain: site(app.domainId)?.name ?? null, path: app.path, enabled: app.enabled, state: stateName(states.get(system.appPaths(account.username, app.name).service)), env: app.env, ...app.project! })),
        environments: envs.map(env => ({ name: env.name, version: env.version, path: account.home + '/python-envs/' + env.name, state: oneshot(states.get(pythonEnvUnitName(account.username, env.name))) })),
      }
    }))
    return json(200, { runtimes: facts.runtimes.filter(row => row.kind === 'go' || row.kind === 'java'), jdks: facts.jdks, python: facts.python, accounts: rows, available: ctx.host !== null && ctx.reconcile !== null })
  }
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  await ctx.assertRoot('application.projects.change')
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 65536 ? JSON.parse(text) : null } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as { account?: unknown }).account !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test((body as { account: string }).account)) return fail('VALIDATION', 'choose one account and one operation', unchanged)
  const { account, op } = body as { account: string; op: unknown }, target = `http://agent.local/accounts/${account}/runtime`
  return handleAccountRuntimeRoute(new Request(target, { method: 'POST', body: JSON.stringify(op) }), new URL(target), 'POST', { ...ctx, asRoot: true })
}
