import { fail } from '@xpanel/core'
import { system } from '@xpanel/render'
import type { Account } from '@xpanel/core'

export interface CronQualificationInput {
  readonly account: Account
  readonly job: { readonly id: string; readonly schedule: string; readonly command: string; readonly enabled: boolean }
  readonly action: 'observe' | 'run'
}

export interface CronQualificationOptions {
  /** Fixed native probe, injected only by trusted startup composition. */
  readonly isActive: (unit: string) => Promise<boolean>
}

const unavailable = (reason: string, detail: Record<string, unknown> = {}): never =>
  fail('PRECONDITION_FAILED', 'Trusted cron host qualification is unavailable', { stateChanged: false, reason, ...detail })

/** Timer units run below the account's own slice; a foreign unit naming pattern is never admitted. */
export const CRON_UNIT_NAME = /^xpanel-cron-[a-z0-9_-]{1,128}\.(?:service|timer)$/

/**
 * Trusted startup qualification for tenant cron. It proves the host scheduler primitives this
 * account's job needs (systemd timers active and the stored schedule translatable) instead of
 * assuming a configured unit alone is executable. It grants no host command.
 */
export const createNativeCronQualification = (options: CronQualificationOptions) => {
  if (typeof options.isActive !== 'function') throw new TypeError('cron qualification requires the native unit probe')
  return async (input: CronQualificationInput): Promise<void> => {
    const { account, job, action } = input
    if (!['observe', 'run'].includes(action)) return unavailable('action_not_supported')
    if (!Number.isSafeInteger(account.uid) || account.uid < 1 || typeof account.username !== 'string' || account.username.length < 1) {
      return unavailable('account_identity_invalid')
    }
    if (!job || typeof job.schedule !== 'string' || typeof job.command !== 'string' || job.command.length < 1) return unavailable('job_invalid')
    if (!CRON_UNIT_NAME.test('xpanel-cron-' + job.id + '.timer')) return unavailable('job_identity_invalid')
    let onCalendar: string
    try { onCalendar = system.cronToOnCalendar(job.schedule) } catch { return unavailable('schedule_not_supported') }
    if (typeof onCalendar !== 'string' || onCalendar.length < 1) return unavailable('schedule_not_supported')
    if (!await options.isActive('timers.target')) return unavailable('systemd_timers_inactive')
    if (action === 'run' && !job.enabled) return unavailable('job_disabled')
  }
}
