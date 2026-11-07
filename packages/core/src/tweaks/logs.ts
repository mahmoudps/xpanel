import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition, TweakValue } from './index.ts'
import type { AccountLogSettings } from '../types.ts'

/** Tweak Settings of the Logs section; each key has a real consumer. */
export const LOG_TWEAKS: readonly TweakDefinition[] = [
  // The agent's daily raw access log rotation (apps/agent/src/log-rotation.ts) reads these three for an account without its own settings.
  { key: 'logs.archiveDefault', label: msgid('Archive raw access logs in the home directory by default'), help: msgid('Each site log is rotated once per UTC day after its traffic is counted. An account that has not chosen its own setting keeps the rotated log as a gzip archive in ~/logs, or has it deleted.'), consumer: '/whm/monitoring/logs', kind: 'boolean', default: true },
  { key: 'logs.removePreviousMonthArchiveDefault', label: msgid("Remove the previous month's archives by default"), help: msgid("For an account that has not chosen its own setting, archives from earlier months are removed from ~/logs once a new UTC month starts."), consumer: '/whm/monitoring/logs', kind: 'boolean', default: false },
  { key: 'logs.retentionDaysDefault', label: msgid('Default archive retention (days)'), help: msgid('For an account that has not chosen its own setting, archives older than this many days are removed. Off keeps them until they are removed.'), consumer: '/whm/monitoring/logs', kind: 'integer', default: null, min: 1, max: 3650, nullable: true },
  // The holding area of archives whose copy into ~/logs failed (apps/agent/src/log-rotation.ts): the server bound, never the account setting.
  { key: 'logs.holdDays', label: msgid('Undelivered archives kept (days)'), help: msgid('An archive that could not be copied into ~/logs (for example over quota) is kept on the server and copied again on the next daily rotation. After this many days it is removed and reported as lost.'), consumer: '/whm/monitoring/logs', kind: 'integer', default: 30, min: 1, max: 365, nullable: false },
  { key: 'logs.holdMaxMb', label: msgid('Undelivered archives kept (MB)'), help: msgid('Above this total the oldest undelivered archive is removed first, and every removal is reported as lost.'), consumer: '/whm/monitoring/logs', kind: 'integer', default: 2048, min: 16, max: 1048576, nullable: false },
  // /etc/logrotate.d/xpanel (packages/render extended renderLogrotateConfig): error, backend and PHP-FPM logs.
  { key: 'logs.panelRotateDays', label: msgid('Rotated server logs kept (days)'), help: msgid('The nginx error logs, the Apache backend logs and each account PHP-FPM error log are rotated daily by logrotate and kept for this many days.'), consumer: '/whm/monitoring/logs', kind: 'integer', default: 14, min: 1, max: 365, nullable: false },
]

export interface LogTweakValues {
  /** settings of an account that has not chosen its own (Account.logs absent) */
  defaults: AccountLogSettings
  panelRotateDays: number
  /** bound of the holding area of undelivered archives */
  hold: { days: number; maxBytes: number }
}

/** The Logs section of parsed Tweak Settings values (parseTweakValues). */
export const logTweakValues = (values: Readonly<Record<string, TweakValue>>): LogTweakValues => {
  const retention = values['logs.retentionDaysDefault'], days = values['logs.panelRotateDays'], holdDays = values['logs.holdDays'], holdMb = values['logs.holdMaxMb']
  return {
    defaults: { archive: values['logs.archiveDefault'] !== false, removePreviousMonthArchive: values['logs.removePreviousMonthArchiveDefault'] === true, retentionDays: typeof retention === 'number' ? retention : null },
    panelRotateDays: typeof days === 'number' ? days : 14,
    hold: { days: typeof holdDays === 'number' ? holdDays : 30, maxBytes: (typeof holdMb === 'number' ? holdMb : 2048) * 1024 * 1024 },
  }
}
