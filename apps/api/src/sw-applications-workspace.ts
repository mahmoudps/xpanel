import { fail } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { readApplicationInstallRequest } from '../../agent/src/application-install.ts'
import { readSwApplicationsView } from '../../../packages/os/src/sw-applications-command.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FEATURE = ['application-manager']
/** Owner-only signed-catalog applications; the agent coordinator decides every write and none succeeds without a verified job. */
export async function handleSwApplicationsWorkspaceRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  const jobs = url.pathname === '/api/account/applications/jobs'
  if (!jobs && url.pathname !== '/api/account/applications') return null
  const expected = jobs ? 'POST' : 'GET'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  const first = await authorizeAccountOwner(ports, req, FEATURE, 'Applications')
  const again = async (): Promise<void> => {
    const after = await authorizeAccountOwner(ports, req, FEATURE, 'Applications')
    if (after.account.id !== first.account.id || after.caller.principal.id !== first.caller.principal.id) return fail('CONFLICT', 'account binding changed', { stateChanged: false })
  }
  const path = '/accounts/' + first.account.username + '/applications'
  if (!jobs) {
    const keys = [...url.searchParams.keys()], domainId = url.searchParams.get('domainId')
    if (keys.length > 1 || keys.length === 1 && (keys[0] !== 'domainId' || !UUID.test(domainId ?? ''))) return fail('VALIDATION', 'select one owned domain; paths are not accepted', { stateChanged: false })
    const reply = await ports.readAgent(first.caller, path + (domainId ? '?domainId=' + domainId : ''), undefined, false, 'GET')
    let view
    try { view = readSwApplicationsView(reply); if (view.context.accountId !== first.account.id || (view.selected?.domainId ?? null) !== domainId) throw new Error('wrong_target') }
    catch { return fail('PRECONDITION_FAILED', 'the applications reply could not be verified', { stateChanged: false }) }
    await again()
    return workspaceJson(view)
  }
  if (url.search) return fail('VALIDATION', 'application jobs do not accept selectors', { stateChanged: false })
  const text = await req.text()
  let raw: unknown
  try { raw = text.length <= 2048 ? JSON.parse(text) : null } catch { raw = null }
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!record || typeof record.domainId !== 'string' || !UUID.test(record.domainId)) return fail('VALIDATION', 'choose an owned domain and a reviewed application change', { stateChanged: false })
  const { domainId, ...change } = record
  const request = readApplicationInstallRequest(change)
  await again()
  const reply = await ports.readAgent<Record<string, unknown>>(first.caller, path + '/jobs', { domainId, ...request }, true)
  const job = reply && typeof reply === 'object' && reply.job && typeof reply.job === 'object' ? reply.job as Record<string, unknown> : null
  if (!job || typeof job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job.id) || job.kind !== 'application.' + request.action || job.accountId !== first.account.id) return fail('SERVICE_UNAVAILABLE', 'the application job could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  try { await again() } catch { return fail('SERVICE_UNAVAILABLE', 'account authority changed after job submission; review the job before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return workspaceJson({ job }, 202)
}
