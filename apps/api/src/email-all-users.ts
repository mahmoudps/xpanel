import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { DeliveryFailure } from './alert-delivery.ts'
import type { EmailSender } from './alert-delivery.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

const ROUTE = '/api/server/announcements/email'
const LIMITS = { name: 80, address: 254, subject: 200, body: 20_000, recipients: 5000, preview: 50 }
const ADDRESS = /^[^\s@<>"',;:\\]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const line = (value: unknown, what: string, max: number): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text) ? text : fail('VALIDATION', `${what} must be one line of 1-${max} characters`, unchanged)
}

export interface EmailAllUsersHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  listAccounts: () => Promise<Pick<Account, 'username' | 'contactEmail' | 'ownerId' | 'status'>[]>
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>
  /** The local MTA sender of system mail. */
  email: EmailSender
}

export function parseUsersEmail(body: Record<string, unknown>) {
  if (Object.keys(body).some(key => !['fromName', 'fromAddress', 'subject', 'body', 'includeResellerCustomers', 'confirm'].includes(key))) return fail('VALIDATION', 'unsupported message field', unchanged)
  const fromAddress = line(body.fromAddress, 'the sender address', LIMITS.address)
  if (!ADDRESS.test(fromAddress)) return fail('VALIDATION', 'the sender address is not valid', unchanged)
  const text = typeof body.body === 'string' ? body.body : ''
  if (!text.trim() || text.length > LIMITS.body || text.includes('\0')) return fail('VALIDATION', `the message must be 1-${LIMITS.body} characters`, unchanged)
  if (body.includeResellerCustomers !== undefined && typeof body.includeResellerCustomers !== 'boolean') return fail('VALIDATION', 'includeResellerCustomers must be true or false', unchanged)
  return { fromName: line(body.fromName, 'the sender name', LIMITS.name), fromAddress, subject: line(body.subject, 'the subject', LIMITS.subject), text, includeResellerCustomers: body.includeResellerCustomers === true, confirm: body.confirm }
}

/** One recipient per account with a contact address; resellers' customers only on request. */
export const usersEmailAudience = (accounts: readonly Pick<Account, 'username' | 'contactEmail' | 'ownerId' | 'status'>[], includeResellerCustomers: boolean) => {
  const listed = accounts.filter(account => account.status !== 'terminating' && (includeResellerCustomers || account.ownerId === null))
  return { recipients: listed.filter(account => account.contactEmail).map(account => ({ username: account.username, address: account.contactEmail })), skipped: listed.filter(account => !account.contactEmail).map(account => account.username) }
}

/** WHM Email All Users. The first POST shows who would receive what; only a POST repeating that exact review sends. */
export async function handleEmailAllUsersRoute(request: Request, url: URL, method: string, helpers: EmailAllUsersHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'announcements.email')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'the message takes no selectors', unchanged)
  const input = parseUsersEmail(await helpers.readJsonBody(request))
  const { recipients, skipped } = usersEmailAudience(await helpers.listAccounts(), input.includeResellerCustomers)
  if (!recipients.length) return fail('PRECONDITION_FAILED', 'no account has a contact email address', { ...unchanged, reason: 'contact_unavailable', skipped })
  // shortcut: one request sends in sequence and answers with the list; a job queue is needed above this bound.
  if (recipients.length > LIMITS.recipients) return fail('LIMIT_EXCEEDED', `one message goes to at most ${LIMITS.recipients} accounts`, { ...unchanged, reason: 'too_many_recipients' })
  const review = createHash('sha256').update(JSON.stringify([input.fromName, input.fromAddress, input.subject, input.text, recipients])).digest('hex')
  if (input.confirm === undefined) return json({ review, recipients: recipients.length, sample: recipients.slice(0, LIMITS.preview), skipped })
  if (input.confirm !== review) return fail('CONFLICT', 'the message or its recipients changed; review it again', { ...unchanged, reason: 'review_stale' })
  // One message per account, so no account learns another one's address.
  const sent: { username: string; address: string }[] = [], failed: { username: string; error: string }[] = []
  for (const recipient of recipients) {
    try { await helpers.email({ to: [recipient.address], subject: input.subject, text: input.text, from: { address: input.fromAddress, name: input.fromName } }); sent.push(recipient) }
    catch (error) { failed.push({ username: recipient.username, error: error instanceof DeliveryFailure ? error.code : 'unreachable' }) }
  }
  await helpers.emitAudit({ actor: caller.principal.username, action: 'server.users_email.sent', target: 'accounts:all', detail: { subject: input.subject, sent: sent.length, failed: failed.length, skipped: skipped.length, includeResellerCustomers: input.includeResellerCustomers }, outcome: 'ok', principalId: caller.principal.id })
  return json({ sent, failed, skipped }, failed.length && !sent.length ? 503 : 200)
}
