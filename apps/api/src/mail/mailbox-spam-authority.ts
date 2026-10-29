import { join } from 'node:path'
import { fail, normalizeMailboxMetadataAddress } from '@xpanel/core'
import type { MailboxMetadataAuthority } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { captureMailboxMetadataAuthority } from './metadata-authority.ts'
import type { MailboxMetadataAuthorityStore } from './metadata-authority.ts'
import type { SealedMailboxAuditEvent, SealedMailboxSession } from './folder-admin.ts'

export interface MailboxToolsPorts {
  open(request: Request): Promise<SealedMailboxSession>
  store: MailboxMetadataAuthorityStore & Pick<StateStore, 'rootDir' | 'getWriterLock' | 'getDomainByName'>
  audit(request: Request, event: SealedMailboxAuditEvent): Promise<void>
  now?: () => Date
}
export interface BoundMailboxTool { session: SealedMailboxSession; authority: MailboxMetadataAuthority }
export const MAILBOX_TOOL_UNCHANGED = { stateChanged: false }
export const mailboxToolFile = (ports: MailboxToolsPorts, ...parts: string[]): string => join(ports.store.rootDir, 'extended', ...parts)
export const mailboxToolObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const mailboxToolRevision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
export async function openMailboxTool(request: Request, ports: MailboxToolsPorts): Promise<BoundMailboxTool> {
  const session = await ports.open(request), mailbox = normalizeMailboxMetadataAddress(session?.record?.mailbox)
  if (!mailbox || typeof session?.password !== 'string') return fail('FORBIDDEN', 'sealed mailbox session required', MAILBOX_TOOL_UNCHANGED)
  const authority = await captureMailboxMetadataAuthority(ports.store, mailbox)
  if (authority.accountId !== session.record.accountId || authority.serviceUserId !== session.record.serviceUserId || authority.mailbox !== mailbox) return fail('FORBIDDEN', 'mailbox lifetime changed; sign in again', MAILBOX_TOOL_UNCHANGED)
  return { session, authority }
}
export async function freshMailboxTool(request: Request, ports: MailboxToolsPorts, selected: BoundMailboxTool): Promise<void> {
  const current = await openMailboxTool(request, ports), before = selected.session, after = current.session
  if ((['sessionId', 'mailbox', 'accountId', 'serviceUserId'] as const).some(key => before.record[key] !== after.record[key]) || before.password !== after.password || JSON.stringify(selected.authority) !== JSON.stringify(current.authority)) return fail('FORBIDDEN', 'mailbox authorization changed; sign in again', MAILBOX_TOOL_UNCHANGED)
}
/** JSON requests are streamed to a fixed bound before parse; selectors never enter the operation. */
export async function mailboxToolBody(request: Request, url: URL, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (url.search || request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !request.body) return fail('VALIDATION', 'mailbox tools require JSON without selectors', MAILBOX_TOOL_UNCHANGED)
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 65_536)) return fail('VALIDATION', 'mailbox tool request is too large', MAILBOX_TOOL_UNCHANGED)
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0, body: unknown
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65_536) { await reader.cancel(); return fail('VALIDATION', 'mailbox tool request is too large', MAILBOX_TOOL_UNCHANGED) } chunks.push(part.value) }
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { return fail('VALIDATION', 'mailbox tool request must be UTF-8 JSON', MAILBOX_TOOL_UNCHANGED) }
  } finally { reader.releaseLock() }
  if (!mailboxToolObject(body) || Object.keys(body).length !== fields.length || fields.some(key => !Object.hasOwn(body, key))) return fail('VALIDATION', 'mailbox tool request requires only supported fields', MAILBOX_TOOL_UNCHANGED)
  return body
}
