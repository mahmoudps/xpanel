import { fail } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { EMAIL_DISK_USAGE_FEATURE, parseCleanupRequest } from '../../agent/src/mailbox-disk-usage.ts'
import { isMaintenanceMailbox } from '../../../packages/os/src/mailbox-maintenance-command.ts'

const PATH = '/api/account/email/disk-usage', CLEANUP = PATH + '/cleanup'
const unchanged = { stateChanged: false }

/** Account owner's Email Disk Usage; every delete names a preset or a reviewed query, and the agent re-checks all of it. */
export async function handleEmailDiskUsageWorkspaceRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  if (url.pathname !== PATH && url.pathname !== CLEANUP) return null
  const cleanup = url.pathname === CLEANUP
  if (method !== (cleanup ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: cleanup ? 'POST' : 'GET' } })
  const { caller, account } = await authorizeAccountOwner(ports, req, [EMAIL_DISK_USAGE_FEATURE], 'Email Disk Usage')
  const agentPath = '/accounts/' + account.username + '/email/disk-usage'
  if (!cleanup) {
    const mailbox = url.searchParams.get('mailbox')
    if ([...url.searchParams.keys()].join() !== 'mailbox' || !isMaintenanceMailbox(mailbox)) return fail('VALIDATION', 'choose one mailbox', unchanged)
    return workspaceJson(await ports.readAgent(caller, agentPath + '?mailbox=' + encodeURIComponent(mailbox), undefined, false, 'GET'))
  }
  if (url.search) return fail('VALIDATION', 'cleanup takes no query selectors', unchanged)
  const text = await req.text()
  if (text.length > 2048) return fail('VALIDATION', 'cleanup request is too large', unchanged)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fail('VALIDATION', 'cleanup request must be JSON', unchanged) }
  parseCleanupRequest(raw)
  return workspaceJson(await ports.readAgent(caller, agentPath + '/cleanup', raw, true, 'POST'))
}
