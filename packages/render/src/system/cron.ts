// 5-field crontab(5) schedule -> systemd.time(7) OnCalendar= expressions.
//
// Semantics follow Vixie cron / cronie:
// - `n/step` means `n-max/step`; `*` in day-of-week covers 0-6 and 7 is Sunday.
// - When both day-of-month and day-of-week are restricted and neither starts with `*`, a job runs when
//   EITHER matches. OnCalendar ANDs its components, so that case yields two expressions; a timer with
//   several OnCalendar= lines fires on any of them.
// - Month and weekday names (jan, mon ...) are accepted, case-insensitively.
// - @reboot has no calendar equivalent and is rejected. Seconds and Quartz extensions (? L W #) too.

import { invalid } from './validate.ts'

interface FieldSpec {
  name: string
  min: number
  max: number
  names?: Record<string, number>
}

const MINUTE: FieldSpec = { name: 'minute', min: 0, max: 59 }
const HOUR: FieldSpec = { name: 'hour', min: 0, max: 23 }
const DOM: FieldSpec = { name: 'day-of-month', min: 1, max: 31 }
const MONTH: FieldSpec = {
  name: 'month', min: 1, max: 12,
  names: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
}
const DOW: FieldSpec = { name: 'day-of-week', min: 0, max: 7, names: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } }

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const SYSTEMD_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const bad = (spec: FieldSpec, text: string, why: string): never =>
  invalid(`invalid cron ${spec.name} "${text}": ${why}`, { field: spec.name, value: text })

const parseValue = (spec: FieldSpec, token: string, whole: string): number => {
  if (/^[0-9]{1,2}$/.test(token)) {
    const n = Number(token)
    if (n < spec.min || n > spec.max) bad(spec, whole, `${n} is outside ${spec.min}-${spec.max}`)
    return n
  }
  const named = spec.names?.[token.toLowerCase()]
  if (named === undefined) return bad(spec, whole, `"${token}" is not a value`)
  return named
}

interface ParsedField {
  values: number[]
  star: boolean
}

const parseField = (spec: FieldSpec, text: string): ParsedField => {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    if (part === '') bad(spec, text, 'empty list element')
    const pieces = part.split('/')
    if (pieces.length > 2) bad(spec, text, 'more than one step')
    const [range = '', stepText] = pieces
    let step = 1
    if (stepText !== undefined) {
      if (!/^[0-9]{1,2}$/.test(stepText)) bad(spec, text, 'step must be a number')
      step = Number(stepText)
      if (step < 1 || step > spec.max) bad(spec, text, `step must be 1-${spec.max}`)
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = spec.min
      hi = spec === DOW ? 6 : spec.max
    } else if (range.includes('-')) {
      const ends = range.split('-')
      if (ends.length !== 2) bad(spec, text, 'malformed range')
      lo = parseValue(spec, ends[0] ?? '', text)
      hi = parseValue(spec, ends[1] ?? '', text)
      if (lo > hi) bad(spec, text, 'range start is after its end')
    } else {
      lo = parseValue(spec, range, text)
      hi = stepText === undefined ? lo : spec.max
    }
    for (let v = lo; v <= hi; v += step) out.add(spec === DOW && v === 7 ? 0 : v)
  }
  return { values: [...out].sort((a, b) => a - b), star: text.startsWith('*') }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

const isFull = (spec: FieldSpec, values: number[]): boolean =>
  values.length === (spec === DOW ? 7 : spec.max - spec.min + 1)

const joinRuns = (values: number[], fmt: (n: number) => string): string => {
  const parts: string[] = []
  for (let i = 0; i < values.length; ) {
    let j = i
    while (j + 1 < values.length && (values[j + 1] as number) === (values[j] as number) + 1) j++
    const a = values[i] as number
    const b = values[j] as number
    if (j - i >= 2) parts.push(`${fmt(a)}..${fmt(b)}`)
    else for (let k = i; k <= j; k++) parts.push(fmt(values[k] as number))
    i = j + 1
  }
  return parts.join(',')
}

const formatNumeric = (spec: FieldSpec, values: number[]): string => {
  if (isFull(spec, values)) return '*'
  const first = values[0] as number
  const step = values.length >= 3 ? (values[1] as number) - first : 0
  const progression =
    step >= 2 &&
    values.every((v, i) => v === first + i * step) &&
    (values[values.length - 1] as number) + step > spec.max
  return progression ? `${pad2(first)}/${step}` : joinRuns(values, pad2)
}

const formatDow = (values: number[]): string => {
  if (isFull(DOW, values)) return ''
  // systemd weeks start on Monday, so Sunday sorts last: ranges then stay ascending (Sat..Sun).
  const mondayFirst = values.map((v) => (v === 0 ? 7 : v)).sort((a, b) => a - b)
  return joinRuns(mondayFirst, (n) => SYSTEMD_DOW[n % 7] as string)
}

const expression = (dow: string, month: string, dom: string, hour: string, minute: string): string =>
  `${dow ? `${dow} ` : ''}*-${month}-${dom} ${hour}:${minute}:00`

/** Converts a crontab schedule into one or two OnCalendar= values. Throws VALIDATION on anything else. */
export const cronToOnCalendar = (schedule: unknown): string[] => {
  if (typeof schedule !== 'string' || schedule.length > 128) return invalid('cron schedule must be a string of at most 128 chars')
  const trimmed = schedule.trim()
  if (/[\u0000-\u001f\u007f]/.test(trimmed.replace(/[ \t]/g, ''))) return invalid('cron schedule contains control characters')
  let text = trimmed
  if (text.startsWith('@')) {
    const macro = MACROS[text.toLowerCase()]
    if (!macro) return invalid(`unsupported cron macro ${text}`, { schedule: text })
    text = macro
  }
  const fields = text.split(/[ \t]+/)
  if (fields.length !== 5) return invalid('cron schedule needs exactly 5 fields', { schedule: text, fields: fields.length })
  const [mi, ho, dm, mo, dw] = fields as [string, string, string, string, string]
  const minute = formatNumeric(MINUTE, parseField(MINUTE, mi).values)
  const hour = formatNumeric(HOUR, parseField(HOUR, ho).values)
  const domField = parseField(DOM, dm)
  const month = formatNumeric(MONTH, parseField(MONTH, mo).values)
  const dowField = parseField(DOW, dw)
  const dom = formatNumeric(DOM, domField.values)
  const dow = formatDow(dowField.values)
  if (!domField.star && !dowField.star) {
    return [expression(dow, month, '*', hour, minute), expression('', month, dom, hour, minute)]
  }
  return [expression(dow, month, dom, hour, minute)]
}
