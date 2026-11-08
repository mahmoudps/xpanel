import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition, TweakValue } from './index.ts'

/** Tweak Settings of the Status section; each key has a real consumer. */
export const STATUS_TWEAKS: readonly TweakDefinition[] = [
  // Read by the server health load check (apps/agent/src/server-health.ts) on every read.
  { key: 'status.loadThreshold', label: msgid('Load threshold'), help: msgid('The 1-minute load average at which the load check reports a problem; half of it reports a warning. Off keeps the automatic grading per processor.'), consumer: '/whm/panel/notifications', kind: 'integer', default: null, min: 1, max: 4096, nullable: true },
]

/** The saved fixed threshold, or null for automatic grading. */
export const statusLoadThreshold = (values: Readonly<Record<string, TweakValue>>): number | null => {
  const value = values['status.loadThreshold']
  return typeof value === 'number' ? value : null
}
