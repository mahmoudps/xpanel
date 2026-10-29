// Dry run of saved filters against a sample message. It follows the script renderSieveScript
// emits: rules in order, tests with Sieve's default i;ascii-casemap comparator, actions until
// stop, and discard or reject ending the script. Header values are taken as given (no RFC 2047
// decoding), so a trace explains the rules; it is not proof of delivery.
import type { FilterAction, FilterTest, MailFilter, MatchOp } from './mail.ts'

export interface SampleMessage {
  headers: readonly { name: string; value: string }[]
  body: string
  /** octets; computed from the headers and body when absent */
  size?: number
}

export interface TestTrace {
  test: FilterTest
  /** the header values or body the test read, or the message size */
  actual: string[] | number
  matched: boolean
}

export interface RuleTrace {
  index: number
  name: string
  matched: boolean
  tests: TestTrace[]
  /** actions the rule ran; empty when it did not match */
  ran: FilterAction[]
  stopped: boolean
}

export interface FilterTraceOutcome {
  /** folders that receive the message; INBOX for keep and for the implicit keep */
  folders: string[]
  redirects: string[]
  discarded: boolean
  rejected: string | null
  markedRead: boolean
  /** index of the rule that ended processing, or null when every rule ran */
  stoppedAt: number | null
}

export interface FilterTrace {
  rules: RuleTrace[]
  outcome: FilterTraceOutcome
}

const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** RFC 5228 2.7.1 :matches: * any sequence, ? one character, backslash quotes the next one. */
const wildcard = (pattern: string): RegExp => {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\' && i + 1 < pattern.length) source += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    else if (c === '*') source += '[\\s\\S]*'
    else if (c === '?') source += '[\\s\\S]'
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'u')
}

const matches = (op: MatchOp, key: string, value: string): boolean => {
  const k = fold(key), v = fold(value)
  switch (op) {
    case 'contains': return v.includes(k)
    case 'is': return v === k
    case 'matches': return wildcard(k).test(v)
    case 'begins': return v.startsWith(k)
    case 'ends': return v.endsWith(k)
    case 'regex': return new RegExp(key, 'iu').test(value)
  }
}

const messageSize = (m: SampleMessage): number =>
  m.size ?? Buffer.byteLength(m.headers.map((h) => `${h.name}: ${h.value}\r\n`).join('') + '\r\n' + m.body)

const evaluate = (t: FilterTest, m: SampleMessage): TestTrace => {
  let actual: string[] | number
  let result: boolean
  if (t.field === 'size') {
    actual = messageSize(m)
    result = t.op === 'over' ? actual > t.bytes : actual < t.bytes
  } else if (t.field === 'body') {
    actual = [m.body]
    result = matches(t.op, t.value, m.body)
  } else {
    const name = fold(t.field === 'header' ? t.header : t.field)
    actual = m.headers.filter((h) => fold(h.name) === name).map((h) => h.value)
    // a missing header never matches (RFC 5228 5.7)
    result = actual.some((value) => matches(t.op, t.value, value))
  }
  return { test: t, actual, matched: t.not ? !result : result }
}

export const traceMailFilters = (filters: readonly MailFilter[], message: SampleMessage): FilterTrace => {
  const outcome: FilterTraceOutcome = { folders: [], redirects: [], discarded: false, rejected: null, markedRead: false, stoppedAt: null }
  const rules: RuleTrace[] = []
  let implicitKeep = true
  for (const [index, filter] of filters.entries()) {
    if (filter.enabled === false) continue
    const tests = filter.tests.map((t) => evaluate(t, message))
    const matched = tests.length === 0 || (filter.match === 'all' ? tests.every((t) => t.matched) : tests.some((t) => t.matched))
    const ran: FilterAction[] = []
    let stopped = false
    if (matched) {
      for (const action of filter.actions) {
        ran.push(action)
        if (action.kind === 'fileinto') { outcome.folders.push(action.folder); implicitKeep = false }
        else if (action.kind === 'redirect') { outcome.redirects.push(action.to); if (!action.copy) implicitKeep = false }
        else if (action.kind === 'keep') outcome.folders.push('INBOX')
        else if (action.kind === 'discard') { outcome.discarded = true; implicitKeep = false }
        else if (action.kind === 'reject') { outcome.rejected = action.message; implicitKeep = false }
        else if (action.kind === 'mark-read') outcome.markedRead = true
        if (action.kind === 'stop') { stopped = true; break }
      }
      // the renderer ends the script after discard and reject
      if (outcome.discarded || outcome.rejected !== null) stopped = true
    }
    rules.push({ index, name: filter.name, matched, tests, ran, stopped })
    if (stopped) { outcome.stoppedAt = index; break }
  }
  if (implicitKeep) outcome.folders.push('INBOX')
  outcome.folders = [...new Set(outcome.folders)]
  outcome.redirects = [...new Set(outcome.redirects)]
  return { rules, outcome }
}
