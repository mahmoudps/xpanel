import { fail } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { CPAN_SEARCH_PATH, handleCpanSearchRoute } from './perl-cpan-search.ts'

/** Owner tools decided by the agent. This layer pins the account, checks the plan feature and bounds the request. */
export const OWNER_TOOL_ROUTES: readonly { path: string; agent: string; tool: string; methods: readonly string[]; label: string }[] = [
  { path: '/api/account/server-information', agent: 'server-information', tool: 'xpanel-server-information', methods: ['GET'], label: 'Server information' },
  { path: '/api/account/perl-modules', agent: 'perl-modules', tool: 'perl-modules', methods: ['GET', 'POST'], label: 'Perl modules' },
  { path: '/api/account/perl-modules/log', agent: 'perl-modules/log', tool: 'perl-modules', methods: ['GET'], label: 'Perl modules' },
  { path: '/api/account/images', agent: 'images', tool: 'images', methods: ['GET', 'POST'], label: 'Images' },
  { path: '/api/account/website-backups', agent: 'website-backups', tool: 'website-backups', methods: ['GET', 'POST'], label: 'Website backups' },
]

export async function handleAccountOwnerToolsRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  if (url.pathname === CPAN_SEARCH_PATH) return handleCpanSearchRoute(req, url, method, ports)
  const route = OWNER_TOOL_ROUTES.find(item => item.path === url.pathname)
  if (!route) return null
  if (!route.methods.includes(method)) return new Response(null, { status: 405, headers: { allow: route.methods.join(', ') } })
  const { caller, account } = await authorizeAccountOwner(ports, req, [route.tool], route.label)
  const path = '/accounts/' + account.username + '/' + route.agent
  if (method === 'GET') {
    const query = url.searchParams.get('domainId')
    if ([...url.searchParams.keys()].some(key => key !== 'domainId') || query !== null && !/^[0-9a-f-]{36}$/.test(query)) return fail('VALIDATION', 'this tool takes no other selectors', { stateChanged: false })
    return workspaceJson(await ports.readAgent(caller, path + (query ? '?domainId=' + query : ''), undefined, false, 'GET'))
  }
  if (url.search) return fail('VALIDATION', 'changes take no selectors', { stateChanged: false })
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 4096 ? JSON.parse(text) : null } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'request body must be a JSON object', { stateChanged: false })
  return workspaceJson(await ports.readAgent(caller, path, body, true, 'POST'))
}
