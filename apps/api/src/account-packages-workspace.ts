import { fail } from '@xpanel/core'
import { ACCOUNT_PACKAGE_FEATURE, parseAccountPackageRequest } from '../../agent/src/account-packages.ts'
import type { AccountPackagesView } from '../../agent/src/account-packages.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'

export const ACCOUNT_PACKAGES_PATH = '/api/account/packages'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const row = (value: unknown): boolean => object(value) && typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.name) && (value.version === null || typeof value.version === 'string' && /^[0-9A-Za-z.]{1,32}$/.test(value.version))
/** The account's reply: its own context, bounded lists and no file content. */
export function projectAccountPackagesView(raw: unknown, accountId: string): AccountPackagesView {
  const ok = object(raw) && object(raw.context) && raw.context.accountId === accountId && raw.ecosystem === 'pear' && typeof raw.revision === 'string' && /^[0-9a-f]{64}$/.test(raw.revision) && typeof raw.engine === 'boolean'
    && [raw.packages, raw.system, raw.results].every(list => Array.isArray(list) && list.length <= 256 && list.every(row))
  return ok ? raw as unknown as AccountPackagesView : fail('CONFIG_TEST_FAILED', 'the package reply could not be verified')
}
export async function handleAccountPackagesWorkspaceRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  if (url.pathname !== ACCOUNT_PACKAGES_PATH) return null
  if (!['GET', 'POST'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'packages do not accept selectors', { stateChanged: false })
  const first = await authorizeAccountOwner(ports, req, [ACCOUNT_PACKAGE_FEATURE], 'PEAR packages')
  let raw: unknown
  if (method === 'POST') { const body = await req.text(); if (body.length > 1024) return fail('VALIDATION', 'package request is too large', { stateChanged: false }); try { raw = JSON.parse(body) } catch { return fail('VALIDATION', 'package request must be JSON', { stateChanged: false }) } }
  const request = parseAccountPackageRequest(method, raw), fresh = await authorizeAccountOwner(ports, req, [ACCOUNT_PACKAGE_FEATURE], 'PEAR packages')
  if (fresh.account.id !== first.account.id || fresh.account.username !== first.account.username || fresh.caller.principal.id !== first.caller.principal.id) return fail('CONFLICT', 'package account binding changed', { stateChanged: false })
  const mutation = request.op !== 'read' && request.op !== 'search', reply = await ports.readAgent(fresh.caller, '/accounts/' + fresh.account.username + '/packages', request.op === 'read' ? undefined : request, mutation, method)
  try {
    const after = await authorizeAccountOwner(ports, req, [ACCOUNT_PACKAGE_FEATURE], 'PEAR packages')
    if (after.account.id !== fresh.account.id || after.caller.principal.id !== fresh.caller.principal.id) throw new Error('package_owner_changed')
    return workspaceJson(projectAccountPackagesView(reply, fresh.account.id))
  } catch { return fail('SERVICE_UNAVAILABLE', mutation ? 'package action needs review before retrying' : 'package reply could not be verified', { stateChanged: mutation, unknownOutcome: mutation, verificationRequired: mutation }) }
}
