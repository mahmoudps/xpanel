import { createHash } from 'node:crypto'
import { assertEmail, fail } from '@xpanel/core'
import type { WebmailVacationConfig } from '../extended-routes.ts'

export interface VacationWorkspaceFields {
  enabled: boolean
  subject: string
  body: string
  htmlBody: string
  startDate: string | null
  endDate: string | null
  replyIntervalHours: number
}

const keys = ['enabled', 'subject', 'body', 'htmlBody', 'startDate', 'endDate', 'replyIntervalHours', 'expectedRevision'] as const
const unsafeHeader = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const unsafeMessage = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const invalid = (message: string): never => fail('VALIDATION', message)
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('vacation settings must be a plain object')
  return value as Record<string, unknown>
}
const messageText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || unsafeMessage.test(value) || Buffer.byteLength(value, 'utf8') > 64 * 1024) return invalid(`${field} must be safe text of at most 64 KiB UTF-8`)
  return value
}
const schedule = (value: unknown, field: string): string | null => {
  if (value === null) return null
  if (typeof value !== 'string' || value.length !== 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return invalid(`${field} must be null or canonical whole-second UTC ISO time`)
  return value
}
const fields = (value: Record<string, unknown>): VacationWorkspaceFields => {
  if (typeof value.enabled !== 'boolean') return invalid('enabled must be a boolean')
  if (typeof value.subject !== 'string' || unsafeHeader.test(value.subject)) return invalid('subject must be text without header controls')
  const subject = value.subject.trim()
  if (subject.length > 256) return invalid('subject must be at most 256 characters')
  const body = messageText(value.body, 'body'), htmlBody = messageText(value.htmlBody, 'htmlBody')
  if (value.enabled && (!subject || !(body.trim() || htmlBody.trim()))) return invalid('an enabled vacation reply requires a subject and message')
  const replyIntervalHours = value.replyIntervalHours
  if (typeof replyIntervalHours !== 'number' || !Number.isInteger(replyIntervalHours) || replyIntervalHours < 1 || replyIntervalHours > 8760) return invalid('replyIntervalHours must be an integer from 1 to 8760')
  const startDate = schedule(value.startDate, 'startDate'), endDate = schedule(value.endDate, 'endDate')
  if (startDate !== null && endDate !== null && endDate <= startDate) return invalid('endDate must be later than startDate')
  return { enabled: value.enabled, subject, body, htmlBody, startDate, endDate, replyIntervalHours }
}

export const parseVacationWorkspaceRequest = (value: unknown): VacationWorkspaceFields & { expectedRevision: string } => {
  const input = object(value)
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !(keys as readonly string[]).includes(key))) return invalid('exact vacation fields and expectedRevision are required')
  const revision = input.expectedRevision
  if (typeof revision !== 'string' || revision.length !== 64 || !/^[0-9a-f]{64}$/.test(revision)) return invalid('expectedRevision must be an exact lowercase SHA-256 revision')
  return { ...fields(input), expectedRevision: revision }
}

/** Explicit scalar projection; derived source and timestamps are never synthesized. */
export const projectVacationWorkspace = (record: WebmailVacationConfig): WebmailVacationConfig => ({
  mailbox: record.mailbox, enabled: record.enabled, subject: record.subject, body: record.body, htmlBody: record.htmlBody,
  startDate: record.startDate, endDate: record.endDate, replyIntervalHours: record.replyIntervalHours,
  compiledSieve: record.compiledSieve, updatedAt: record.updatedAt,
})

/** Current-value identity (including absence), intentionally not a monotonic counter. */
export const vacationWorkspaceRevision = (config: WebmailVacationConfig | null): string => createHash('sha256')
  .update(JSON.stringify({ namespace: 'xpanel-vacation-workspace:v1', ownerAuthority: config?.ownerAuthority ?? null, vacation: config === null ? null : projectVacationWorkspace(config) }))
  .digest('hex')

const crlf = (value: string): string => value.replace(/\r\n|\r|\n/g, '\r\n')
// RFC5228 permits CRLF in quoted strings: dot-prefixed lines cannot terminate this form.
const quote = (value: string): string => '"' + crlf(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
const base64 = (value: string): string => Buffer.from(crlf(value), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''
const mimeReason = (body: string, html: string): string => {
  // RFC2045 base64 excludes '-', so encoded user content cannot forge this boundary.
  const boundary = 'xpanel-vacation-alternative'
  const part = (type: string, value: string) => [`--${boundary}`, `Content-Type: text/${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', base64(value)]
  return ['MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    ...part('plain', body), ...part('html', html), `--${boundary}--`, ''].join('\r\n')
}

/** RFC5230/6131/5260 source only; installed engine capabilities are not qualified here. */
export const compileVacationWorkspace = (value: VacationWorkspaceFields & { mailbox: string }): string => {
  const input = object(value), content = fields(input)
  const mailbox = assertEmail(input.mailbox, 'mailbox')
  if (!content.enabled) return '# Vacation responder disabled\n'
  const extensions = ['vacation']
  const interval = content.replyIntervalHours % 24 === 0 ? `:days ${content.replyIntervalHours / 24}` : `:seconds ${content.replyIntervalHours * 3600}`
  if (content.replyIntervalHours % 24 !== 0) extensions.push('vacation-seconds')
  const tests: string[] = []
  for (const [date, comparison] of [[content.startDate, 'ge'], [content.endDate, 'lt']] as const) {
    // A whole-second prefix compares consistently with optional runtime fractional seconds.
    if (date !== null) tests.push(`currentdate :zone "+0000" :comparator "i;octet" :value "${comparison}" "iso8601" ${quote(date.slice(0, 19))}`)
  }
  if (tests.length) extensions.push('date', 'relational')
  const reason = content.htmlBody ? mimeReason(content.body, content.htmlBody) : content.body
  const action = `vacation ${interval} :addresses [${quote(mailbox)}] :subject ${quote(content.subject)}${content.htmlBody ? ' :mime' : ''} ${quote(reason)};`
  return [`require [${extensions.map(quote).join(', ')}];`, ...(tests.length ? [`if ${tests.length === 1 ? tests[0] : `allof(${tests.join(', ')})`} {`, `  ${action}`, '}'] : [action]), ''].join('\r\n')
}
