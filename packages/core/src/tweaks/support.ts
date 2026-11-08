import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition, TweakValue } from './index.ts'

/** Tweak Settings of the Support section; each key has a real consumer. */
export const SUPPORT_TWEAKS: readonly TweakDefinition[] = [
  // Read by the nightly maintenance run (apps/agent/src/svc-nightly.ts).
  { key: 'support.updateLogRetentionDays', label: msgid('Update job logs kept (days)'), help: msgid('Logs of finished package update, repair and PHP jobs older than this are removed by the nightly maintenance run. Off keeps them.'), consumer: '/whm/support', kind: 'integer', default: 90, min: 1, max: 3650, nullable: true },
]

export const updateLogRetentionDays = (values: Readonly<Record<string, TweakValue>>): number | null => {
  const value = values['support.updateLogRetentionDays']
  return typeof value === 'number' ? value : null
}
