import './i18n.ts'

/** Theme-free facts of the Home notifications and Getting Started sections. */
export interface PersonalHomeFacts { notifications: { disk: boolean; bandwidth: boolean; announcements: boolean }; onboardingDismissed: boolean }
export interface AccountWarning { id: 'disk' | 'bandwidth'; level: 'warning' | 'critical'; percent: number }

const WARNING_PERCENT = 80, CRITICAL_PERCENT = 95
const warning = (id: AccountWarning['id'], usedBytes: number | undefined | null, capMb: number | 'unlimited' | undefined): AccountWarning | null => {
  if (typeof usedBytes !== 'number' || typeof capMb !== 'number' || capMb <= 0) return null
  const percent = Math.floor(usedBytes / (capMb * 1024 * 1024) * 100)
  return percent < WARNING_PERCENT ? null : { id, level: percent >= CRITICAL_PERCENT ? 'critical' : 'warning', percent }
}

/** Warnings come only from measured usage against a positive cap; an unread measurement is no warning. */
export function accountWarnings(input: { diskBytes?: number | null; bandwidthBytes?: number | null; diskMb?: number | 'unlimited'; bandwidthMb?: number | 'unlimited' }, personal?: PersonalHomeFacts): AccountWarning[] {
  const choices = personal?.notifications ?? { disk: true, bandwidth: true }
  return [choices.disk ? warning('disk', input.diskBytes, input.diskMb) : null, choices.bandwidth ? warning('bandwidth', input.bandwidthBytes, input.bandwidthMb) : null].filter((item): item is AccountWarning => item !== null)
}

export const accountWarningMessage = (item: AccountWarning): string => item.id === 'disk' ? msgid('Disk space is {percent}% used.') : msgid('Monthly bandwidth is {percent}% used.')

/** Getting Started links, as far as the account's plan routes offer them. */
export const ONBOARDING_TASKS: readonly { route: string; label: string }[] = [
  { route: '/domains', label: msgid('Add a domain') },
  { route: '/email/accounts', label: msgid('Create a mailbox') },
  { route: '/domains/site-publisher', label: msgid('Publish a site') },
]
