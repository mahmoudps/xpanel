import { describe, expect, it } from 'vitest'
import { backupCronMatches, backupScheduleDue, nextBackupCronRun, parseBackupCron } from './backup-destination.ts'

const at = (iso: string): Date => new Date(iso)
describe('backup schedule cron (UTC)', () => {
  it('accepts the saved grammar and refuses anything else', () => {
    for (const cron of ['0 2 * * *', '*/15 * * * *', '0 3 1-7 * 1', '30 4 * * 7', '5/20 0 1,15 1-12/2 *']) expect(() => parseBackupCron(cron)).not.toThrow()
    for (const cron of ['0 2 * *', '60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '*/0 * * * *', '1-0 * * * *', 'a * * * *', '0 0 * * * *', 5]) expect(() => parseBackupCron(cron)).toThrow()
  })
  it('finds the next matching minute strictly after a time', () => {
    expect(nextBackupCronRun(parseBackupCron('0 2 * * *'), at('2026-10-28T01:59:30.000Z'))?.toISOString()).toBe('2026-10-28T02:00:00.000Z')
    expect(nextBackupCronRun(parseBackupCron('0 2 * * *'), at('2026-10-28T02:00:00.000Z'))?.toISOString()).toBe('2026-10-29T02:00:00.000Z')
    expect(nextBackupCronRun(parseBackupCron('15 3 1 1 *'), at('2026-10-28T00:00:00.000Z'))?.toISOString()).toBe('2027-01-01T03:15:00.000Z')
    expect(nextBackupCronRun(parseBackupCron('0 0 30 2 *'), at('2026-10-28T00:00:00.000Z'))).toBeNull()
  })
  it('uses crontab(5) day semantics: either restricted day field matches, 7 is Sunday', () => {
    const either = parseBackupCron('0 0 1 * 1')
    expect(backupCronMatches(either, at('2026-11-01T00:00:00.000Z'))).toBe(true) // day 1, a Sunday
    expect(backupCronMatches(either, at('2026-11-02T00:00:00.000Z'))).toBe(true) // a Monday
    expect(backupCronMatches(either, at('2026-11-03T00:00:00.000Z'))).toBe(false)
    expect(backupCronMatches(parseBackupCron('0 0 */2 * 1'), at('2026-11-02T00:00:00.000Z'))).toBe(false) // star day field: both must match
    expect(backupCronMatches(parseBackupCron('0 0 * * 7'), at('2026-11-01T00:00:00.000Z'))).toBe(true)
  })
  it('coalesces missed minutes into one due run', () => {
    const cron = parseBackupCron('0 * * * *')
    expect(backupScheduleDue(cron, at('2026-10-28T00:00:00.000Z'), at('2026-10-28T00:59:00.000Z'))).toBeNull()
    expect(backupScheduleDue(cron, at('2026-10-28T00:00:00.000Z'), at('2026-10-28T05:30:00.000Z'))?.toISOString()).toBe('2026-10-28T01:00:00.000Z')
  })
})
