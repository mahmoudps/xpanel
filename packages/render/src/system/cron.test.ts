import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import { cronToOnCalendar } from './cron.ts'

describe('cronToOnCalendar', () => {
  it.each([
    ['*/5 * * * *', ['*-*-* *:00/5:00']],
    ['0 3 * * 1-5', ['Mon..Fri *-*-* 03:00:00']],
    ['@daily', ['*-*-* 00:00:00']],
    ['@midnight', ['*-*-* 00:00:00']],
    ['@hourly', ['*-*-* *:00:00']],
    ['@weekly', ['Sun *-*-* 00:00:00']],
    ['@monthly', ['*-*-01 00:00:00']],
    ['@yearly', ['*-01-01 00:00:00']],
    ['@ANNUALLY', ['*-01-01 00:00:00']],
    ['* * * * *', ['*-*-* *:*:00']],
    ['0 0 * * *', ['*-*-* 00:00:00']],
    ['15,45 9-17 * * *', ['*-*-* 09..17:15,45:00']],
    ['0 */2 * * *', ['*-*-* 00/2:00:00']],
    ['5-59/15 * * * *', ['*-*-* *:05/15:00']],
    ['0-30/10 * * * *', ['*-*-* *:00,10,20,30:00']],
    ['30 4 1 */3 *', ['*-01/3-01 04:30:00']],
    ['0 12 * jan,jul *', ['*-01,07-* 12:00:00']],
    ['0 12 * * sat,sun', ['Sat,Sun *-*-* 12:00:00']],
    ['0 12 * * 5-7', ['Fri..Sun *-*-* 12:00:00']],
    ['0 12 * * 0,7', ['Sun *-*-* 12:00:00']],
    ['0 12 * * 0-7', ['*-*-* 12:00:00']],
    ['0 12 * * MON-wed', ['Mon..Wed *-*-* 12:00:00']],
    ['0 0 1-7 * *', ['*-*-01..07 00:00:00']],
    ['  0   3  *  *  *  ', ['*-*-* 03:00:00']],
    ['0\t3\t*\t*\t*', ['*-*-* 03:00:00']],
    ['59 23 31 12 *', ['*-12-31 23:59:00']],
  ])('%s', (schedule, expected) => {
    expect(cronToOnCalendar(schedule)).toEqual(expected)
  })

  it('splits OR semantics when both day fields are restricted', () => {
    expect(cronToOnCalendar('30 2 1,15 * 0')).toEqual(['Sun *-*-* 02:30:00', '*-*-01,15 02:30:00'])
    expect(cronToOnCalendar('0 0 13 * 5')).toEqual(['Fri *-*-* 00:00:00', '*-*-13 00:00:00'])
  })

  it('keeps AND semantics when a day field starts with * (Vixie DOM_STAR/DOW_STAR)', () => {
    expect(cronToOnCalendar('0 0 */2 * 1')).toEqual(['Mon *-*-01/2 00:00:00'])
    // systemd weeks start on Monday, so Sunday is listed last
    expect(cronToOnCalendar('0 0 1 * */2')).toEqual(['Tue,Thu,Sat,Sun *-*-01 00:00:00'])
  })

  it.each([
    ['60 * * * *'],
    ['* 24 * * *'],
    ['* * 0 * *'],
    ['* * 32 * *'],
    ['* * * 13 *'],
    ['* * * 0 *'],
    ['* * * * 8'],
    ['*/0 * * * *'],
    ['*/60 * * * *'],
    ['5-1 * * * *'],
    ['1,,2 * * * *'],
    [',1 * * * *'],
    ['1-2-3 * * * *'],
    ['1/2/3 * * * *'],
    ['* * * *'],
    ['* * * * * *'],
    ['0 0 * * * /bin/true'],
    ['@reboot'],
    ['@every 5m'],
    ['? * * * *'],
    ['0 0 L * *'],
    ['0 0 * * 1#2'],
    ['0 0 1W * *'],
    ['a b c d e'],
    ['* * * foo *'],
    ['* * * * funday'],
    ['-1 * * * *'],
    ['1- * * * *'],
    ['*/x * * * *'],
    ['100 * * * *'],
    [''],
    ['   '],
    ['* * * * *\n* * * * *'],
    ['0 0 * * *; rm -rf /'],
    ['0 0 * * * ;rm -rf /'],
    ['$(id) * * * *'],
  ])('rejects %j', (schedule) => {
    expect(() => cronToOnCalendar(schedule)).toThrowError(XpanelError)
  })

  it('rejects non-strings and oversized input', () => {
    expect(() => cronToOnCalendar(5)).toThrowError(XpanelError)
    expect(() => cronToOnCalendar(null)).toThrowError(XpanelError)
    expect(() => cronToOnCalendar(`${'1,'.repeat(70)}1 * * * *`)).toThrowError(XpanelError)
  })
})
