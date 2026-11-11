import type { MessageValues } from '../i18n.ts'
import { formatIsolatedBytes, isolateLtr as ltr } from '../display-format.ts'

/** One measured total; `unmeasured` owned accounts had no value in the source, so the total is a lower bound. */
export interface MeasuredTotal { state: 'read' | 'unavailable'; bytes: number | null; observedAt: string | null; unmeasured: number }
export interface ResellerUsageObservation { accounts: number; disk: MeasuredTotal; traffic: MeasuredTotal & { month: string | null } }
/** One account's measured values; `unmeasured` is 1 when its source does not list the account. */
export interface AccountUsageObservation { disk: MeasuredTotal; traffic: MeasuredTotal }

type Translate = (message: string, values?: MessageValues) => string

/** "YYYY-MM-DD HH:mm UTC" from an ISO instant. */
export const utcMinute = (iso: string): string => iso.slice(0, 16).replace('T', ' ') + ' UTC'

/** A measured reseller total as plain text: the value with its observation time, or the truthful unavailable state. */
export function measuredTotalText(t: Translate, total: MeasuredTotal | undefined): string {
  if (!total) return t('Not read')
  if (total.state !== 'read' || total.observedAt === null) return t('Unavailable on this host')
  if (total.bytes === null) return t('Not measured, observed {time}', { time: ltr(utcMinute(total.observedAt)) })
  const value = t('{size}, observed {time}', { size: formatIsolatedBytes(total.bytes), time: ltr(utcMinute(total.observedAt)) })
  return total.unmeasured ? value + ' ' + t('{count, plural, one {({count} account not measured)} other {({count} accounts not measured)}}', { count: total.unmeasured }) : value
}
