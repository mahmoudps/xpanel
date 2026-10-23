import type { Locale } from '../i18n.ts'
import { formatAsciiBytes } from '../tokens.ts'

export interface MailboxQuotaText {
  text: string
  /** Null when the used/limit ratio was not measured. A zero here would be a fake empty meter. */
  percent: number | null
}

/**
 * `mailboxQuotaMb` is stored under a megabyte name and enforced as `n * 1024 * 1024` bytes
 * (`userdb_quota_rule=*:storage=<n>M`, Dovecot M = 2^20). The label is therefore MiB.
 * Used space is shown only when a measurement was passed in.
 */
const formatQuotaBytes = (bytes: number): string => {
  if (bytes < 1000) return `${new Intl.NumberFormat('en-US').format(Math.round(bytes))} B`
  const kb = bytes / 1000
  const rounded = kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10
  return `${rounded} KB`
}

/** Decoded attachment bytes under 10,000 stay in bytes. Larger files use the decimal byte formatter. */
export const formatAttachmentBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 10_000) return `${new Intl.NumberFormat('en-US').format(Math.round(bytes))} B`
  return formatAsciiBytes(bytes)
}

export const formatMailboxQuota = (
  used: number | undefined,
  limit: number | 'unlimited' | undefined,
  locale: Locale,
  usedBytes?: number,
): MailboxQuotaText => {
  const ar = locale === 'ar'
  const unlimited = ar ? 'بلا حد' : 'unlimited'
  const usedKnown = typeof used === 'number' && Number.isFinite(used) && used >= 0
  const limitKnown = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
  const bytesKnown = typeof usedBytes === 'number' && Number.isFinite(usedBytes) && usedBytes >= 0 && usedBytes < 1024 * 1024
  if (bytesKnown && limitKnown) {
    return {
      text: `${formatQuotaBytes(usedBytes)} / ${limit} MiB`,
      percent: Math.max(0, Math.min(100, Math.round((usedBytes / (limit * 1024 * 1024)) * 100))),
    }
  }
  if (usedKnown && limitKnown) {
    return {
      text: `${used} / ${limit} MiB`,
      percent: Math.max(0, Math.min(100, Math.round((used / limit) * 100))),
    }
  }
  if (usedKnown && limit === 'unlimited') return { text: `${used} MiB / ${unlimited}`, percent: null }
  if (usedKnown) return { text: `${used} MiB`, percent: null }
  if (limitKnown) return { text: `— / ${limit} MiB`, percent: null }
  if (limit === 'unlimited') return { text: `— / ${unlimited}`, percent: null }
  return { text: '—', percent: null }
}

/** Labels a UTC instant. A value that is not ISO-8601 is shown unchanged, with no timezone added. */
export const formatMailStamp = (value: string): { time: string; full: string; datetime: string } => {
  const raw = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) || Number.isNaN(Date.parse(raw))) {
    return { time: raw || '—', full: raw || '—', datetime: raw }
  }
  const iso = new Date(raw).toISOString()
  const day = iso.slice(0, 10)
  const clock = iso.slice(11, 16)
  return { time: `${clock} UTC`, full: `${day} ${clock} UTC`, datetime: iso }
}
