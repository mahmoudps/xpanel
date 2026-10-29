import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'

export interface PhpWorkspaceHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  /** The authenticated agent owns inventory. No caller-selected command or path is accepted. */
  readInventory: (caller: AuthenticatedCaller) => Promise<Response>
  listDomains: () => Promise<Domain[]>
  listAccounts: () => Promise<Account[]>
}
export interface PhpDesiredVersionUsage {
  version: string
  domainCount: number
  accountCount: number
  handlers: { handler: string; count: number }[]
  domains: { name: string; account: string | null; handler: string }[]
}

/** In-use desired configuration is kept separate from installed package/runtime evidence. */
export function projectPhpDesiredUsage(domains: readonly Domain[], accounts: readonly Account[]): PhpDesiredVersionUsage[] {
  if (domains.length > 10000 || accounts.length > 10000) return fail('PRECONDITION_FAILED', 'PHP usage inventory exceeds the bounded workspace capacity')
  const owners = new Map(accounts.map(account => [account.id, account.username]))
  const groups = new Map<string, Domain[]>()
  for (const domain of domains) {
    const current = groups.get(domain.php.version) ?? []
    current.push(domain); groups.set(domain.php.version, current)
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true })).map(([version, entries]) => {
    const handlers = new Map<string, number>()
    for (const domain of entries) handlers.set(domain.php.handler, (handlers.get(domain.php.handler) ?? 0) + 1)
    return {
      version, domainCount: entries.length, accountCount: new Set(entries.map(domain => domain.accountId)).size,
      handlers: [...handlers].sort(([left], [right]) => left.localeCompare(right)).map(([handler, count]) => ({ handler, count })),
      domains: entries.sort((left, right) => left.name.localeCompare(right.name)).map(domain => ({ name: domain.name, account: owners.get(domain.accountId) ?? null, handler: domain.php.handler })),
    }
  })
}

export async function handlePhpWorkspaceRoute(request: Request, url: URL, method: string, helpers: PhpWorkspaceHelpers): Promise<Response | null> {
  if (!['/api/server/php/inventory', '/api/server/php/usage'].includes(url.pathname)) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.php.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if ([...url.searchParams.keys()].length !== 0) return fail('VALIDATION', 'PHP workspace reads do not accept caller-selected versions, accounts, commands or paths')
  if (url.pathname === '/api/server/php/inventory') return helpers.readInventory(caller)
  const [domains, accounts] = await Promise.all([helpers.listDomains(), helpers.listAccounts()])
  return Response.json({ scope: 'saved-domain-configuration', observedRuntime: false, usage: projectPhpDesiredUsage(domains, accounts) }, { headers: { 'cache-control': 'no-store' } })
}
