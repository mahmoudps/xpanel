import type { Translate } from '../../../../../i18n.ts'
import { actions, button, check, esc, field, fields, help, inputControl, section, select, status, table } from './common.ts'

/** WHM Statistics Software Configuration inside Logs, on the same hooks as the classic card; web-stats-client.ts reads and saves it. */
export function renderV2WhmWebStatsEngines(t: Translate, canRead: boolean, enabled: boolean): string {
  const policy = (name: string) => ({ 'data-web-stats-policy': name })
  const body = help(t, msgid('Choose which engines exist for users, who may change them, and when logs and bandwidth are processed. Analog is the traffic report on the account Traffic page, so turning it off keeps totals and bandwidth and withholds its lists.'))
    + status(t, msgid('The statistics configuration has not been read.'), { 'data-web-stats-status': true })
    + `<p data-web-stats-summary>${esc(t(msgid('Not read')))}</p>`
    + fields(([['analog.available', msgid('Analog is available to users')], ['analog.byDefault', msgid('Analog is on by default')], ['awstats.available', msgid('AWStats is available to users')], ['awstats.byDefault', msgid('AWStats is on by default')], ['webalizer.available', msgid('Webalizer is available to users')], ['webalizer.byDefault', msgid('Webalizer is on by default')],
      ['allowInclude', msgid('Allow an AWStats include file in each account')], ['reverseDns', msgid('Resolve visitor addresses with reverse DNS')], ['avoidBackups', msgid('Never start a run during a backup')]] as const).map(([name, label]) => check(t, label, policy(name))).join(''))
    + fields(field(t, 'v2-web-stats-users', msgid('Who may change engines'), select(t, 'v2-web-stats-users', policy('users'), [['all', msgid('All users')], ['listed', msgid('Only the users listed here')]]))
      + field(t, 'v2-web-stats-interval', msgid('Log processing interval (hours)'), inputControl('v2-web-stats-interval', policy('intervalHours'), false, ' dir="ltr" min="0.25" max="168" step="0.25" inputmode="decimal"', 'number'), msgid('In steps of 0.25 hours; 24 or more is recommended.'))
      + field(t, 'v2-web-stats-bandwidth', msgid('Bandwidth processing interval (minutes)'), inputControl('v2-web-stats-bandwidth', policy('bandwidthIntervalMinutes'), false, ' dir="ltr" min="5" max="360" step="5" inputmode="numeric"', 'number'), msgid('In steps of 5 minutes, up to 360. The bandwidth meter reads this value. Limits are enforced and logs rotate after each collection, so a longer interval delays both.'))
      + field(t, 'v2-web-stats-blackout', msgid('Blackout hours (UTC)'), inputControl('v2-web-stats-blackout', policy('blackoutHours'), false, ' dir="ltr" inputmode="numeric" autocomplete="off"'), msgid('Comma-separated hours from 0 to 23. A run due in one of these hours starts at the first free hour.'))
      + field(t, 'v2-web-stats-allowed', msgid('Allowed users and engines'), `<textarea id="v2-web-stats-allowed" data-web-stats-policy="allowed" dir="ltr" rows="3" disabled></textarea>`, msgid('One user per line: username, then any of analog, awstats and webalizer.')))
    + actions(button(t, msgid('Save'), { 'data-web-stats-save': true }, false, true))
    + section(t, 'web-stats-behind', msgid('Accounts behind schedule'), table(t, msgid('Accounts behind schedule'), [msgid('Account'), msgid('Minutes behind'), msgid('Bytes waiting')], { 'data-web-stats-behind': true }, msgid('Nothing has been read.'), [1, 2])
      + fields(field(t, 'v2-web-stats-process-user', msgid('Account'), inputControl('v2-web-stats-process-user', { 'data-web-stats-process-user': true }, false, ' dir="ltr" autocomplete="off"')))
      + actions(button(t, msgid('Process now'), { 'data-web-stats-process': true })))
  return section(t, 'web-stats-engines', msgid('Web statistics engines'), body, { 'data-web-stats-engines': true, 'data-web-stats-enabled': String(canRead && enabled) })
}
