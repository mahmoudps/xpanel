import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { services } from '@xpanel/render'
import { BOXTRAPPER_ACTIONS, BOXTRAPPER_ID, BOXTRAPPER_MAX_IDS, boxTrapperArgv } from '../../../packages/os/src/boxtrapper-command.ts'
import type { BoxTrapperAction, BoxTrapperCall } from '../../../packages/os/src/boxtrapper-command.ts'
import { MAILX_SIEVE_DIR } from '../../../packages/os/src/mailx-command.ts'
import { boxTrapperHostReady, boxTrapperStore } from './boxtrapper-render.ts'

export interface BoxTrapperRouteContext {
  family: string
  /** Fresh authority of the account's owner, or of its sealed mailbox session; the mailbox rests on the API's session check. */
  assertAccount: (username: string) => Promise<Account>
  readSnapshot: () => Promise<{ serviceUsers: readonly { accountId: string; login: string; services: { email: boolean } }[] }>
  /** Native Linux host executor only; null keeps the queue unavailable instead of simulating it. */
  run: ((argv: string[]) => Promise<{ ok: boolean; code: number | null; stdout: string }>) | null
  read: ((path: string) => Promise<string | null>) | null
}
const ROUTE = /^\/host\/mailx\/accounts\/([a-z][a-z0-9]{0,15})\/boxtrapper$/
const MAX_BODY = 128 * 1024
const unchanged = { stateChanged: false }
const unknown = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function readCall(value: unknown, mailbox: string): BoxTrapperCall | { op: 'status' } {
  const bad = (): never => fail('VALIDATION', 'unsupported BoxTrapper request', unchanged)
  if (!object(value)) return bad()
  const day = (item: unknown): string => typeof item === 'string' && /^(?:latest|\d{8})$/.test(item) ? item : bad()
  const id = (item: unknown): string => typeof item === 'string' && BOXTRAPPER_ID.test(item) ? item : bad()
  switch (value.op) {
    case 'status': case 'lists': return { op: value.op }
    case 'queue': case 'log': return { op: value.op, day: day(value.day) }
    case 'message': return { op: 'message', id: id(value.id) }
    case 'lists-set': return typeof value.revision === 'string' && typeof value.encoded === 'string' ? { op: 'lists-set', revision: value.revision, encoded: value.encoded } : bad()
    case 'act': return (BOXTRAPPER_ACTIONS as readonly unknown[]).includes(value.action) && Array.isArray(value.ids) && value.ids.length >= 1 && value.ids.length <= BOXTRAPPER_MAX_IDS
      ? { op: 'act', mailbox, action: value.action as BoxTrapperAction, ids: value.ids.map(id) } : bad()
    default: return bad()
  }
}

/** Host side of a mailbox's BoxTrapper: every read and change runs as the account, so root never opens these files. */
export async function handleBoxTrapperRoute(req: Request, url: URL, method: string, ctx: BoxTrapperRouteContext): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'BoxTrapper routes accept no selectors', unchanged)
  const account = await ctx.assertAccount(match[1]!), text = await req.text()
  if (text.length > MAX_BODY) return fail('LIMIT_EXCEEDED', 'BoxTrapper request exceeds its bound', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!object(body) || typeof body.mailbox !== 'string') return fail('VALIDATION', 'a mailbox is required', unchanged)
  const mailbox = body.mailbox, call = readCall(body.call, mailbox)
  if (!ctx.run || !ctx.read) return fail('PRECONDITION_FAILED', 'BoxTrapper requires the native Linux host executor', { ...unchanged, reason: 'host_executor_unavailable' })
  if (!(await ctx.readSnapshot()).serviceUsers.some(user => user.accountId === account.id && user.services.email && user.login.toLowerCase() === mailbox)) return fail('NOT_FOUND', 'mailbox not found', unchanged)
  const ready = await boxTrapperHostReady(ctx.family)
  if (call.op === 'status') {
    const at = mailbox.lastIndexOf('@'), paths = services.boxTrapperPaths(MAILX_SIEVE_DIR, mailbox.slice(at + 1), mailbox.slice(0, at))
    return json({ ready, script: await ctx.read(paths.script).catch(() => null) !== null })
  }
  if (!ready) return fail('PRECONDITION_FAILED', "Pigeonhole's external programs module is not installed", { ...unchanged, reason: 'sieve_extprograms_missing' })
  const changing = call.op === 'lists-set' || call.op === 'act'
  const result = await ctx.run(boxTrapperArgv(account.username, boxTrapperStore(account.home, mailbox), call))
  if (!result.ok || result.code !== 0) return fail('SERVICE_UNAVAILABLE', 'the BoxTrapper program did not answer', changing ? unknown : unchanged)
  try { return json(JSON.parse(result.stdout)) } catch { return fail('SERVICE_UNAVAILABLE', 'the BoxTrapper answer could not be read', changing ? unknown : unchanged) }
}
