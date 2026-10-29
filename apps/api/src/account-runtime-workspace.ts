import { fail } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { readAccountRuntimeView, readRuntimeOp, RUNTIME_LOG_TARGET } from '../../../packages/os/src/account-runtime-command.ts'

const unverified = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
/**
 * Owner-only runtime apps, caches and containers. The agent decides every write against the account, plan and
 * host; this layer pins the account, re-checks authority around the call and verifies every reply.
 * Plan features are enforced per operation by the agent, so the route itself names no single tool.
 */
export async function handleAccountRuntimeWorkspaceRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  const log = url.pathname === '/api/account/runtime/log'
  if (!log && url.pathname !== '/api/account/runtime') return null
  if (log ? method !== 'GET' : method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: log ? 'GET' : 'GET, POST' } })
  const first = await authorizeAccountOwner(ports, req, [], 'Runtime services')
  const again = async (): Promise<void> => {
    const after = await authorizeAccountOwner(ports, req, [], 'Runtime services')
    if (after.account.id !== first.account.id || after.caller.principal.id !== first.caller.principal.id) return fail('CONFLICT', 'account binding changed', { stateChanged: false })
  }
  const path = '/accounts/' + first.account.username + '/runtime'
  if (log) {
    const keys = [...url.searchParams.keys()], target = url.searchParams.get('target') ?? ''
    if (keys.length !== 1 || keys[0] !== 'target' || !RUNTIME_LOG_TARGET.test(target)) return fail('VALIDATION', 'choose one application, container or cache log', { stateChanged: false })
    const reply = await ports.readAgent<Record<string, unknown>>(first.caller, path + '/log?target=' + encodeURIComponent(target), undefined, false, 'GET')
    if (!reply || reply.target !== target || typeof reply.unit !== 'string' || !/^xpanel-[a-z0-9-]{1,80}\.service$/.test(reply.unit) || !Array.isArray(reply.lines) || reply.lines.length > 200
      || !reply.lines.every(line => typeof line === 'string' && line.length <= 2000)) return fail('PRECONDITION_FAILED', 'the log reply could not be verified', { stateChanged: false })
    await again()
    return workspaceJson({ target, unit: reply.unit, lines: reply.lines })
  }
  if (method === 'GET') {
    if (url.search) return fail('VALIDATION', 'the runtime view takes no selectors', { stateChanged: false })
    let view
    try { view = readAccountRuntimeView(await ports.readAgent(first.caller, path, undefined, false, 'GET')); if (view.context.accountId !== first.account.id || view.context.username !== first.account.username) throw new Error('wrong_target') }
    catch { return fail('PRECONDITION_FAILED', 'the runtime reply could not be verified', { stateChanged: false }) }
    await again()
    return workspaceJson(view)
  }
  if (url.search) return fail('VALIDATION', 'runtime operations take no selectors', { stateChanged: false })
  const text = await req.text()
  let raw: unknown
  try { raw = text.length <= 65536 ? JSON.parse(text) : null } catch { raw = null }
  const op = readRuntimeOp(raw)
  await again()
  const reply = await ports.readAgent<Record<string, unknown>>(first.caller, path, op, true, 'POST')
  if (!reply || reply.op !== op.op || typeof reply.revision !== 'string' || !/^[0-9a-f]{64}$/.test(reply.revision) || typeof reply.changed !== 'boolean') return fail('SERVICE_UNAVAILABLE', 'the runtime change could not be verified; read again before retrying', unverified)
  try { await again() } catch { return fail('SERVICE_UNAVAILABLE', 'account authority changed after the change; read again before retrying', unverified) }
  return workspaceJson({ op: reply.op, revision: reply.revision, changed: reply.changed }, op.op === 'app.deps' ? 202 : 200)
}
