import { fail } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { readApplicationInstallRequest } from '../../agent/src/application-install.ts'
import { readSwApplicationsView } from '../../../packages/os/src/sw-applications-command.ts'

import { readApplicationPath } from '../../../packages/os/src/application-artifact.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FEATURE = ['application-manager']
/** Owner-only signed-catalog applications; the agent coordinator decides every write and none succeeds without a verified job. */
export async function handleSwApplicationsWorkspaceRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  const jobs = url.pathname === '/api/account/applications/jobs', recovering = url.pathname === '/api/account/applications/recover'
  if (!jobs && !recovering && url.pathname !== '/api/account/applications') return null
  const expected = jobs || recovering ? 'POST' : 'GET'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  const first = await authorizeAccountOwner(ports, req, FEATURE, 'Applications')
  const again = async (): Promise<void> => {
    const after = await authorizeAccountOwner(ports, req, FEATURE, 'Applications')
    if (after.account.id !== first.account.id || after.caller.principal.id !== first.caller.principal.id) return fail('CONFLICT', 'account binding changed', { stateChanged: false })
  }
  const path = '/accounts/' + first.account.username + '/applications'
  if (!jobs && !recovering) {
    const keys = [...url.searchParams.keys()], domainId = url.searchParams.get('domainId'), where = url.searchParams.get('path')
    if (keys.length > 2 || new Set(keys).size !== keys.length || keys.some(key => key !== 'domainId' && key !== 'path') || domainId === null && keys.length || domainId !== null && !UUID.test(domainId)) return fail('VALIDATION', 'select one owned domain and an optional directory under it', { stateChanged: false })
    const place = readApplicationPath(where ?? '')
    const reply = await ports.readAgent(first.caller, path + (domainId ? '?domainId=' + domainId + (place ? '&path=' + encodeURIComponent(place) : '') : ''), undefined, false, 'GET')
    let view
    try { view = readSwApplicationsView(reply); if (view.context.accountId !== first.account.id || (view.selected?.domainId ?? null) !== domainId || (view.selected?.path ?? '') !== place) throw new Error('wrong_target') }
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
  const { domainId, path: where, ...change } = record
  const place = readApplicationPath(where)
  if (recovering) {
    if (Object.keys(change).length) return fail('VALIDATION', 'recovery takes one domain and an optional directory', { stateChanged: false })
    await again()
    return workspaceJson(await ports.readAgent(first.caller, path + '/recover', { domainId, path: place }, true))
  }
  const request = readApplicationInstallRequest(change)
  await again()
  const reply = await ports.readAgent<Record<string, unknown>>(first.caller, path + '/jobs', { domainId, path: place, ...request }, true)
  const job = reply && typeof reply === 'object' && reply.job && typeof reply.job === 'object' ? reply.job as Record<string, unknown> : null
  if (!job || typeof job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job.id) || job.kind !== 'application.' + request.action || job.accountId !== first.account.id) return fail('SERVICE_UNAVAILABLE', 'the application job could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  try { await again() } catch { return fail('SERVICE_UNAVAILABLE', 'account authority changed after job submission; review the job before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return workspaceJson({ job }, 202)
}
