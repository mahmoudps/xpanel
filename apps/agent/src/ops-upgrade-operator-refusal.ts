// Pure refusal rules for the native root-operator IPC. No filesystem, process,
// socket or authority: callers own transport and must remain fail closed.

/** Same stable machine-code grammar as the wire protocol. */
export const ROOT_OPERATOR_MACHINE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/
const ARCHIVE_WRAPPER = 'ARCHIVE_USE_UNCERTAIN'
const REVIEW_REQUIRED = 'ROOT_OPERATOR_REVIEW_REQUIRED'
const SERVER_ERROR = 'ROOT_OPERATOR_SERVER_ERROR'
const JOURNAL_PREFIX = 'xpanel-root-operator-refused code='

const stableCodeOrFallback = (error: unknown, fallback: string): string => {
  let current: unknown = error
  let wrapper = ''
  for (let depth = 0; current && depth < 6; depth += 1) {
    const record = typeof current === 'object' ? current as { code?: unknown; message?: unknown; cause?: unknown } : undefined
    const candidate = typeof record?.code === 'string' ? record.code : typeof record?.message === 'string' ? record.message : ''
    if (ROOT_OPERATOR_MACHINE_CODE.test(candidate)) {
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

/** One bounded sanitized journal line: no stack, path, secret or operation payload. */
export function rootOperatorRefusalJournalLine(code: string): string {
  if (typeof code !== 'string' || !ROOT_OPERATOR_MACHINE_CODE.test(code)) throw new Error('ROOT_OPERATOR_REFUSAL_CODE_INVALID')
  return JOURNAL_PREFIX + code + '\n'
}

export interface RootOperatorServerRefusal { readonly code: string; readonly frame: Buffer; readonly journalLine: string }

/** The single server-side refusal payload; callers may only write its frame and journal line. */
export function rootOperatorServerRefusal(error: unknown): RootOperatorServerRefusal {
  const code = rootOperatorServerRefusalCode(error)
  return Object.freeze({ code, frame: encodeRootOperatorRefusal(code), journalLine: rootOperatorRefusalJournalLine(code) })
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
