import { createDesignTranslator, escapeHtml, normalizeAsciiDigits, type TextTranslator } from './html.ts'

export interface DateTimeFormatOptions {
  readonly locale?: string
  readonly timeZone?: string
  readonly showUtc?: boolean
  readonly includeSeconds?: boolean
}

const IEC_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

export { normalizeAsciiDigits }

export function isolateTechnical(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const normalized = normalizeAsciiDigits(String(value))
  if (!normalized) return ''
  return `<bdi dir="ltr">${escapeHtml(normalized)}</bdi>`
}

export function formatNumber(
  value: number | string | null | undefined,
  _locale: string = 'en',
  decimals?: number,
): string {
  if (value === null || value === undefined || value === '') return '—'
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return '—'
  const options: Intl.NumberFormatOptions = decimals === undefined
    ? { useGrouping: true, maximumFractionDigits: 2 }
    : { useGrouping: true, minimumFractionDigits: decimals, maximumFractionDigits: decimals }
  return normalizeAsciiDigits(new Intl.NumberFormat('en-US', options).format(numeric))
}

export function formatNumberHtml(
  value: number | string | null | undefined,
  locale: string = 'en',
  decimals?: number,
): string {
  return `<span class="ds-num">${isolateTechnical(formatNumber(value, locale, decimals))}</span>`
}

export function formatPercent(
  value: number | null | undefined,
  locale: string = 'en',
  decimals: number = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${formatNumber(value, locale, decimals)}%`
}

export function formatPercentHtml(
  value: number | null | undefined,
  locale: string = 'en',
  decimals: number = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return isolateTechnical(formatPercent(value, locale, decimals))
}

export function formatBytes(bytes: number | null | undefined, locale: string = 'en'): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  const negative = bytes < 0
  let value = Math.abs(bytes)
  let unitIndex = 0
  while (value >= 1024 && unitIndex < IEC_UNITS.length - 1) {
    value /= 1024
    unitIndex++
  }
  const decimals = unitIndex === 0 ? 0 : 2
  const formatted = formatNumber(value, locale, decimals)
  return `${negative ? '-' : ''}${formatted} ${IEC_UNITS[unitIndex]}`
}

export function formatBytesHtml(bytes: number | null | undefined, locale: string = 'en'): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  return `<span class="ds-num">${isolateTechnical(formatBytes(bytes, locale))}</span>`
}

export function formatRate(bytesPerSec: number | null | undefined, locale: string = 'en'): string {
  const formatted = formatBytes(bytesPerSec, locale)
  return formatted === '—' ? formatted : `${formatted}/s`
}

export function formatRateHtml(bytesPerSec: number | null | undefined, locale: string = 'en'): string {
  const formatted = formatRate(bytesPerSec, locale)
  return formatted === '—' ? formatted : `<span class="ds-num">${isolateTechnical(formatted)}</span>`
}

export function formatDuration(totalSeconds: number | null | undefined, copy?: TextTranslator): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '—'
  const t = createDesignTranslator(copy)
  const whole = Math.max(0, Math.floor(totalSeconds))
  if (whole === 0) return t('0s')

  const days = Math.floor(whole / 86400)
  const hours = Math.floor((whole % 86400) / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60

  const parts: string[] = []
  if (days > 0) parts.push(t('{n}d', { n: days }))
  if (hours > 0) parts.push(t('{n}h', { n: hours }))
  if (parts.length < 2 && days === 0 && minutes > 0) parts.push(t('{n}m', { n: minutes }))
  if (parts.length < 2 && days === 0 && hours === 0 && seconds > 0) parts.push(t('{n}s', { n: seconds }))
  return normalizeAsciiDigits(parts.slice(0, 2).join(' '))
}

export function formatDurationHtml(totalSeconds: number | null | undefined, copy?: TextTranslator): string {
  const formatted = formatDuration(totalSeconds, copy)
  if (formatted === '—') return formatted
  return /[^\x00-\x7F]/.test(formatted)
    ? `<span class="ds-num">${escapeHtml(formatted)}</span>`
    : isolateTechnical(formatted)
}

function safeTimeZone(candidate?: string): string {
  if (!candidate || !candidate.trim()) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate.trim() }).format(0)
    return candidate.trim()
  } catch {
    return 'UTC'
  }
}

function formatParts(date: Date, timeZone: string, includeSeconds: boolean): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(date)

  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find(p => p.type === type)?.value ?? ''
  const rawHour = pick('hour')
  const hour = rawHour === '24' ? '00' : rawHour
  const datePart = `${pick('year')}-${pick('month')}-${pick('day')}`
  const timePart = includeSeconds
    ? `${hour}:${pick('minute')}:${pick('second')}`
    : `${hour}:${pick('minute')}`
  const tzPart = pick('timeZoneName') || timeZone
  return normalizeAsciiDigits(`${datePart} ${timePart} ${tzPart}`.trim())
}

export function formatDateTime(
  input: Date | number | string | null | undefined,
  options: DateTimeFormatOptions = {},
): string {
  if (input === null || input === undefined || input === '') return '—'
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return '—'
  const tz = safeTimeZone(options.timeZone)
  return formatParts(date, tz, options.includeSeconds === true)
}

export function formatDateTimeHtml(
  input: Date | number | string | null | undefined,
  options: DateTimeFormatOptions = {},
): string {
  if (input === null || input === undefined || input === '') return '—'
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return '—'
  const tz = safeTimeZone(options.timeZone)
  const primary = formatParts(date, tz, options.includeSeconds === true)
  const utc = formatParts(date, 'UTC', options.includeSeconds === true)
  const primaryTag = `<bdi dir="ltr" data-ds-ts="${escapeHtml(date.toISOString())}">${escapeHtml(primary)}</bdi>`
  if (options.showUtc && tz !== 'UTC') {
    return `${primaryTag} <span class="ds-caption">(${isolateTechnical(utc)})</span>`
  }
  return primaryTag
}
