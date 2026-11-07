import type { AccountLogSettings } from '../types.ts'
import { invalid, isInt, isRecord } from './check.ts'

const LOG_KEYS = ['archive', 'removePreviousMonthArchive', 'retentionDays']

export const validateAccountLogSettings = (v: unknown): AccountLogSettings => {
  if (!isRecord(v) || Object.keys(v).some((k) => !LOG_KEYS.includes(k))) return invalid('log settings are { archive, removePreviousMonthArchive, retentionDays }')
  if (typeof v.archive !== 'boolean' || typeof v.removePreviousMonthArchive !== 'boolean') return invalid('archive and removePreviousMonthArchive must be booleans')
  if (v.retentionDays !== null && !isInt(v.retentionDays, 1, 3650)) return invalid('retentionDays must be 1-3650 or null')
  return { archive: v.archive, removePreviousMonthArchive: v.removePreviousMonthArchive, retentionDays: v.retentionDays }
}

/** A real calendar day written YYYY-MM-DD. */
export const assertUtcDay = (v: unknown, what: string): string => {
  const day = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null
  return day && !Number.isNaN(day.getTime()) && day.toISOString().startsWith(v as string) ? (v as string) : invalid(`${what} must be a YYYY-MM-DD day`)
}
