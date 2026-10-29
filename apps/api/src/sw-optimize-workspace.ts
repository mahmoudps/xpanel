import { fail } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { readSwOptimizeView } from '../../../packages/os/src/sw-optimize-command.ts'

export const SW_OPTIMIZE_PATH = '/api/account/optimize'
/** Signed-in account owner only; the account comes from the session and the agent pins it again. */
export async function handleSwOptimizeWorkspaceRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  if (url.pathname !== SW_OPTIMIZE_PATH) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'optimization reads do not accept selectors', { stateChanged: false })
  const first = await authorizeAccountOwner(ports, req, ['optimize-website'], 'Website optimization')
  const reply = await ports.readAgent(first.caller, '/accounts/' + first.account.username + '/optimize', undefined, false, 'GET')
  let view
  try { view = readSwOptimizeView(reply); if (view.context.accountId !== first.account.id || view.context.username !== first.account.username) throw new Error('wrong_account') }
  catch { return fail('PRECONDITION_FAILED', 'the optimization reply could not be verified', { stateChanged: false }) }
  const after = await authorizeAccountOwner(ports, req, ['optimize-website'], 'Website optimization')
  if (after.account.id !== first.account.id || after.caller.principal.id !== first.caller.principal.id) return fail('CONFLICT', 'account binding changed', { stateChanged: false })
  return workspaceJson(view)
}
