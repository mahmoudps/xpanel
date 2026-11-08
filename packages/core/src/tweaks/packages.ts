import { fail } from '../errors.ts'
import { msgid } from '../i18n/translator.ts'
import type { Plan } from '../types.ts'
import type { TweakDefinition, TweakValue } from './index.ts'

/** cPanel's ceiling for these three package values. */
export const PACKAGE_VALUE_MAX_MB = 4_294_967_296
const value = { consumer: '/whm/plans', kind: 'integer', min: 1, max: PACKAGE_VALUE_MAX_MB, nullable: false } as const

/** Tweak Settings of the Packages section: read by POST /api/plans for a value the request leaves out. */
export const PACKAGE_TWEAKS: readonly TweakDefinition[] = [
  { key: 'packages.defaultMailboxQuotaMb', label: msgid('Default email quota for a new package (MB)'), help: msgid('Used when a new package does not state its mailbox quota.'), ...value, default: 1024 },
  { key: 'packages.defaultDiskMb', label: msgid('Default disk quota for a new package (MB)'), help: msgid('Used when a new package does not state its disk quota.'), ...value, default: 10240 },
  { key: 'packages.defaultBandwidthMb', label: msgid('Default monthly bandwidth for a new package (MB)'), help: msgid('Used when a new package does not state its monthly bandwidth.'), ...value, default: 1048576 },
]

export interface PackageDefaults { mailboxQuotaMb: number; diskMb: number; bandwidthMbMonth: number }
/** The Packages section of parsed Tweak Settings values (parseTweakValues). */
export const packageDefaults = (values: Readonly<Record<string, TweakValue>>): PackageDefaults => ({
  mailboxQuotaMb: values['packages.defaultMailboxQuotaMb'] as number, diskMb: values['packages.defaultDiskMb'] as number, bandwidthMbMonth: values['packages.defaultBandwidthMb'] as number,
})
/** Refuses a finite package value above the ceiling; unlimited stays governed by the reseller's privileges. */
export const assertPackageValues = (plan: { resources?: Partial<Plan['resources']>; defaultMailboxQuotaMb?: Plan['defaultMailboxQuotaMb'] }): void => {
  for (const [field, amount] of Object.entries({ diskMb: plan.resources?.diskMb, bandwidthMbMonth: plan.resources?.bandwidthMbMonth, defaultMailboxQuotaMb: plan.defaultMailboxQuotaMb })) {
    if (typeof amount === 'number' && amount > PACKAGE_VALUE_MAX_MB) fail('VALIDATION', `${field} may not exceed ${PACKAGE_VALUE_MAX_MB} MB`, { field, stateChanged: false })
  }
}
