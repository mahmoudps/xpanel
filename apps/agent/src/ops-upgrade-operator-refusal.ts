// Pure refusal rules for the native root-operator IPC. No filesystem, process,
// socket or authority: callers own transport and must remain fail closed.
import { isXpanelError } from '@xpanel/core'

/** Same stable machine-code grammar as the wire protocol. */
export const ROOT_OPERATOR_MACHINE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/
const ARCHIVE_WRAPPER = 'ARCHIVE_USE_UNCERTAIN'
const REVIEW_REQUIRED = 'ROOT_OPERATOR_REVIEW_REQUIRED'
const SERVER_ERROR = 'ROOT_OPERATOR_SERVER_ERROR'
const JOURNAL_PREFIX = 'xpanel-root-operator-refused code='

/** The stable code an error names: its code, else a code-shaped message, else ''. */
const machineCode = (record: { code?: unknown; message?: unknown } | undefined): string => {
  const candidate = typeof record?.code === 'string' ? record.code : typeof record?.message === 'string' ? record.message : ''
  return ROOT_OPERATOR_MACHINE_CODE.test(candidate) ? candidate : ''
}

const stableCodeOrFallback = (error: unknown, fallback: string): string => {
  let current: unknown = error
  let wrapper = ''
  for (let depth = 0; current && depth < 6; depth += 1) {
    const record = typeof current === 'object' ? current as { code?: unknown; message?: unknown; cause?: unknown } : undefined
    const candidate = machineCode(record)
    if (candidate) {
      if (candidate !== ARCHIVE_WRAPPER) return candidate
      wrapper = candidate
    }
    current = record?.cause
  }
  return wrapper || fallback
}

/** Client-facing review code: unknown failures stay the generic review code. */
export const stableMachineCode = (error: unknown): string => stableCodeOrFallback(error, REVIEW_REQUIRED)

/** Server-side refusals distinguish a caught plain error from a silently lost reply. */
export const rootOperatorServerRefusalCode = (error: unknown): string => stableCodeOrFallback(error, SERVER_ERROR)

/** The refusal record never retries and never carries raw error text. */
export const rootOperatorReviewRecord = (operationId: string, error: unknown) => Object.freeze({
  operationId, state: 'review_required' as const, code: stableMachineCode(error), retryAllowed: false as const,
})

/** Exactly one newline-terminated JSON frame whose only key is a stable machine code. */
export function encodeRootOperatorRefusal(code: string): Buffer {
  if (typeof code !== 'string' || !ROOT_OPERATOR_MACHINE_CODE.test(code)) throw new Error('ROOT_OPERATOR_REFUSAL_CODE_INVALID')
  const frame = Buffer.from(JSON.stringify({ refused: code }) + '\n')
  if (frame.length > 128) throw new Error('ROOT_OPERATOR_REFUSAL_FRAME_INVALID')
  return frame
}

/** One bounded sanitized journal line: no stack, secret or operation payload. */
export function rootOperatorRefusalJournalLine(code: string, detail = ''): string {
  if (typeof code !== 'string' || !ROOT_OPERATOR_MACHINE_CODE.test(code)) throw new Error('ROOT_OPERATOR_REFUSAL_CODE_INVALID')
  return JOURNAL_PREFIX + code + detail + '\n'
}

const OWNED_PATH = /^\/[A-Za-z0-9._@:+-]+(?:\/[A-Za-z0-9._@:+-]+)*$/
/** Root-journal detail of an owned-file drift: the product-owned path and the drifted identity field, never sent to the client. */
export const ownedFileDriftDetail = (error: unknown): string => {
  let current: unknown = error
  for (let depth = 0; current && depth < 6; depth += 1) {
    const record = typeof current === 'object' ? current as { entryPath?: unknown; field?: unknown; cause?: unknown } : undefined
    const path = record?.entryPath, field = record?.field
    if (typeof path === 'string' && path.length <= 255 && OWNED_PATH.test(path) && !path.split('/').includes('..')
      && typeof field === 'string' && /^[a-z]{1,16}$/.test(field)) return ` path=${path} field=${field}`
    current = record?.cause
  }
  return ''
}

// Plain words and short acronyms only: digits, quotes, '=', '@' and mixed-case tokens, where values and secrets live, become '?'.
const MESSAGE_WORD = /^\(?(?:[A-Z]?[a-z-]{1,31}|[A-Z]{1,8})[.,;:)]{0,2}$/
const REASON = /^[a-z][a-z0-9_]{0,63}$/
const DETAIL_LIMIT = 160
const ERROR_NAME = /^[A-Z][A-Za-z0-9]{0,39}$/
const ownedToken = (token: string) => token.length <= 255 && OWNED_PATH.test(token) && !token.split('/').includes('..')
const reasonOf = (error: unknown): string =>
  isXpanelError(error) && typeof error.detail.reason === 'string' && REASON.test(error.detail.reason) ? ` reason=${error.detail.reason}` : ''
/** `<prefix> detail="<first message line>"<suffix>`, cut at a whole token so the detail stays within its limit. */
const boundedDetail = (prefix: string, message: string, suffix: string): string => {
  let text = ''
  for (const token of message.split('\n')[0]!.split(' ').filter(Boolean).map(word => MESSAGE_WORD.test(word) || ownedToken(word) ? word : '?')) {
    const next = text ? text + ' ' + token : token
    if (`${prefix} detail="${next}"${suffix}`.length > DETAIL_LIMIT) break
    text = next
  }
  return `${prefix} detail="${text}"${suffix}`
}
/** Root-journal detail of a generic refusal: the product-authored message and reason identifier, never sent to the client. */
export const productRefusalDetail = (error: unknown): string => {
  let current: unknown = error
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (isXpanelError(current)) return boundedDetail('', current.message, reasonOf(current))
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined
  }
  return ''
}
/**
 * Root-journal detail of a wrapper refusal: the innermost cause's error name, its stable code if any and its first
 * message line, sanitized like the product detail. A wrapper code alone names no cause. Never sent to the client.
 */
export const innermostCauseDetail = (error: unknown): string => {
  let inner: { name?: unknown; code?: unknown; message?: unknown; cause?: unknown } | undefined
  for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 8; depth += 1) {
    inner = current as NonNullable<typeof inner>
    current = inner.cause
  }
  if (!inner || inner === error) return ''
  const name = typeof inner.name === 'string' && ERROR_NAME.test(inner.name) ? inner.name : '?', code = machineCode(inner)
  return boundedDetail(` cause=${name}${code ? ` cause_code=${code}` : ''}`, typeof inner.message === 'string' ? inner.message : '', reasonOf(inner))
}
const GENERIC_CODES = new Set(['PRECONDITION_FAILED'])
const WRAPPER_CODES = new Set([ARCHIVE_WRAPPER, 'DESCRIPTOR_UNCERTAIN', REVIEW_REQUIRED])

export interface RootOperatorServerRefusal { readonly code: string; readonly frame: Buffer; readonly journalLine: string }

/** The single server-side refusal payload; callers may only write its frame and journal line. */
export function rootOperatorServerRefusal(error: unknown): RootOperatorServerRefusal {
  const code = rootOperatorServerRefusalCode(error)
  const detail = ownedFileDriftDetail(error)
    + (GENERIC_CODES.has(code) ? productRefusalDetail(error) : WRAPPER_CODES.has(code) ? innermostCauseDetail(error) : '')
  return Object.freeze({ code, frame: encodeRootOperatorRefusal(code), journalLine: rootOperatorRefusalJournalLine(code, detail) })
}

/** Client parser for exactly one single-key refusal frame; anything else is not a refusal. */
export function parseRootOperatorRefusal(frame: Buffer): string | null {
  if (!Buffer.isBuffer(frame)) return null
  const text = frame.toString('utf8')
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return null
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const keys = Reflect.ownKeys(parsed)
  const value = (parsed as { refused?: unknown }).refused
  if (keys.length !== 1 || keys[0] !== 'refused' || typeof value !== 'string' || !ROOT_OPERATOR_MACHINE_CODE.test(value)) return null
  return value
}
