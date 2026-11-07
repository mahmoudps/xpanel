import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { services } from '@xpanel/render'
import { LIST_GATE_ACTIONS, LIST_GATE_ID, LIST_GATE_MAX_IDS, listGateArgv } from '../../../packages/os/src/list-gate-command.ts'
import type { ListGateAction, ListGateCall } from '../../../packages/os/src/list-gate-command.ts'
import { MAILX_SIEVE_DIR } from '../../../packages/os/src/mailx-command.ts'
import { listGateHostReady } from './list-moderation-policy.ts'
import { readListFile } from './mailfx-render.ts'

export interface ListModerationRouteContext {
  stateRoot: string
  /** Fresh authority of the account's owner, or of its sealed mailbox session; the list rests on the API's sign-in. */
  assertAccount: (username: string) => Promise<Account>
  readSnapshot: () => Promise<{ domains: readonly { accountId: string; name: string }[] }>
  /** Native Linux host executor only; null keeps the queue unavailable instead of simulating it. */
  run: ((argv: string[]) => Promise<{ ok: boolean; code: number | null; stdout: string }>) | null
  read: ((path: string) => Promise<string | null>) | null
}
const ROUTE = /^\/host\/mailx\/accounts\/([a-z][a-z0-9]{0,15})\/list-moderation$/
const MAX_BODY = 16 * 1024
const unchanged = { stateChanged: false }
const unknown = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

type RouteCall = { op: 'status' | 'queue' | 'purge' } | { op: 'message'; id: string } | { op: 'act'; action: ListGateAction; reason: string; ids: string[] }
function readCall(value: unknown): RouteCall {
  const bad = (): never => fail('VALIDATION', 'unsupported list moderation request', unchanged)
  if (!object(value)) return bad()
  const id = (item: unknown): string => typeof item === 'string' && LIST_GATE_ID.test(item) ? item : bad()
  switch (value.op) {
    case 'status': case 'queue': case 'purge': return { op: value.op }
    case 'message': return { op: 'message', id: id(value.id) }
    case 'act': return (LIST_GATE_ACTIONS as readonly unknown[]).includes(value.action) && typeof value.reason === 'string' && Array.isArray(value.ids) && value.ids.length >= 1 && value.ids.length <= LIST_GATE_MAX_IDS
      ? { op: 'act', action: value.action as ListGateAction, reason: value.reason, ids: value.ids.map(id) } : bad()
    default: return bad()
  }
}

/** Host side of a list's moderation: every read and change runs as the account, so root never opens these files. */
export async function handleListModerationRoute(req: Request, url: URL, method: string, ctx: ListModerationRouteContext): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'list moderation routes accept no selectors', unchanged)
  const account = await ctx.assertAccount(match[1]!), text = await req.text()
  if (text.length > MAX_BODY) return fail('LIMIT_EXCEEDED', 'list moderation request exceeds its bound', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!object(body) || typeof body.address !== 'string') return fail('VALIDATION', 'a list address is required', unchanged)
  const address = services.normalizeHostedEmail(body.address, 'mailing list').address, call = readCall(body.call)
  if (!ctx.run || !ctx.read) return fail('PRECONDITION_FAILED', 'list moderation requires the native Linux host executor', { ...unchanged, reason: 'host_executor_unavailable' })
  const saved = (await readListFile(ctx.stateRoot)).find(list => list.address.toLowerCase() === address)
  // A purge follows the list's deletion, so only the domain still proves whose queue this was.
  const owned = call.op === 'purge' ? !saved && (await ctx.readSnapshot()).domains.some(domain => domain.accountId === account.id && domain.name === address.slice(address.indexOf('@') + 1)) : saved?.accountId === account.id
  if (!owned) return fail('NOT_FOUND', 'mailing list not found', unchanged)
  const gate = services.listGateAddress(account.id, address), ready = listGateHostReady()
  if (call.op === 'status') return json({ ready, active: await ctx.read(services.listGatePaths(MAILX_SIEVE_DIR, gate).rules).catch(() => null) !== null })
  if (!ready) return fail('PRECONDITION_FAILED', "Pigeonhole's external programs module is not installed", { ...unchanged, reason: 'sieve_extprograms_missing' })
  const maildir = services.listGateMaildir(account.home, gate), changing = call.op === 'act' || call.op === 'purge'
  const hostCall: ListGateCall = call.op === 'act' ? { ...call, address } : call.op === 'message' ? call : { op: call.op, maildir }
  const result = await ctx.run(listGateArgv(account.username, services.listGateStore(account.home, address), hostCall))
  if (!result.ok || result.code !== 0) return fail('SERVICE_UNAVAILABLE', 'the list gate program did not answer', changing ? unknown : unchanged)
  try { return json(JSON.parse(result.stdout)) } catch { return fail('SERVICE_UNAVAILABLE', 'the list gate answer could not be read', changing ? unknown : unchanged) }
}
