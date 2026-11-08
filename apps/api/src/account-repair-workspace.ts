import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'

export interface AccountRepairWorkspaceHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  callHost: (caller: AuthenticatedCaller, path: '/host/accounts/repair/preview' | '/host/accounts/repair/run', body: Record<string, unknown>) => Promise<unknown>
  /** Re-renders saved state: web and PHP configuration, slice limits, quota and DNS. Null without the agent. */
  rerender: (caller: AuthenticatedCaller) => Promise<{ ok: boolean; status: number } | null>
  emitAudit: (entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok'; principalId: string }, scope: { accountId: string | null; resellerId: string | null }) => Promise<unknown>
}
const unchanged = { stateChanged: false }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Root Account Repair: a preview of wrong ownership, then the selected fixes as a host job and one re-render. */
export async function handleAccountRepairWorkspaceRoute(request: Request, url: URL, method: string, helpers: AccountRepairWorkspaceHelpers): Promise<Response | null> {
  const preview = url.pathname === '/api/accounts/repair/preview'
  if (!preview && url.pathname !== '/api/accounts/repair/run') return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'accounts.repair')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'account repair accepts no selectors', unchanged)
  const text = await request.text()
  if (text.length > 4096) return fail('VALIDATION', 'account repair request exceeds its bound', unchanged)
  let body: Record<string, unknown>
  try { body = JSON.parse(text) as Record<string, unknown> } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!body || typeof body !== 'object' || !Array.isArray(body.accounts)) return fail('VALIDATION', 'choose at least one account', unchanged)
  if (preview) {
    if (Object.keys(body).join() !== 'accounts') return fail('VALIDATION', 'a preview takes only accounts', unchanged)
    return json(200, await helpers.callHost(caller, '/host/accounts/repair/preview', { accounts: body.accounts }))
  }
  const fixes = body.fixes
  if (Object.keys(body).sort().join() !== 'accounts,fixes' || !Array.isArray(fixes) || !fixes.length || fixes.some(fix => fix !== 'ownership' && fix !== 'rerender') || new Set(fixes).size !== fixes.length) return fail('VALIDATION', 'choose ownership, rerender or both', unchanged)
  const job = fixes.includes('ownership') ? await helpers.callHost(caller, '/host/accounts/repair/run', { accounts: body.accounts }) as { job?: unknown } : null
  const applied = fixes.includes('rerender') ? await helpers.rerender(caller) : null
  await helpers.emitAudit({ actor: caller.principal.username, action: 'accounts.repair_submitted', target: 'accounts:' + body.accounts.length, detail: { accounts: body.accounts, fixes, reconcile: applied?.ok ?? null }, outcome: 'ok', principalId: caller.principal.id }, { accountId: null, resellerId: null })
  return json(202, { job: job?.job ?? null, rerender: fixes.includes('rerender') ? applied === null ? 'not-connected' : applied.ok ? 'applied' : 'failed' : 'not-requested' })
}
