import type { Translate } from '../../../../../i18n.ts'
import { actions, button, esc, field, fields, status, table, toolCard } from './common.ts'

/** Root only: previewed ownership repair and a re-render; whm-account-repair-client.ts owns the behaviour. */
export function renderV2AccountRepair(t: Translate, canManage: boolean): string {
  const off = canManage ? '' : ' disabled'
  const check = (hook: string, label: string): string => `<label class="v2-account-tool__choice"><input type="checkbox" ${hook} checked${off}><span>${esc(t(label))}</span></label>`
  return toolCard('account-repair', t(msgid('Account repair')), `<p>${esc(t(msgid('Fixes what the checks above report. Preview first: it reads each home and changes nothing. Plan, status and quota problems are fixed on the pages the checks link to.')))}</p>`
    + fields(field('v2-whm-account-repair-accounts', t(msgid('Accounts, separated by spaces')), `<input id="v2-whm-account-repair-accounts" dir="ltr" maxlength="600" autocomplete="off" spellcheck="false" data-account-repair-accounts${off}>`))
    + actions(check('data-account-repair-ownership', msgid('Restore file ownership in the home')) + check('data-account-repair-rerender', msgid('Rebuild web, PHP, quota and DNS configuration from saved settings')))
    + actions(button(t(msgid('Preview')), { 'data-account-repair-preview': true }, canManage) + button(t(msgid('Run repair')), { 'data-account-repair-run': true }))
    + status(t(canManage ? msgid('No preview has been read.') : msgid('Account repair requires root. Nothing was read or changed.')), { 'data-account-repair-status': true }, canManage ? 'unread' : 'unavailable')
    + table(t(msgid('Repair preview')), [t(msgid('Account')), t(msgid('Ownership')), t(msgid('First path found'))], { 'data-account-repair-rows': true }, t(msgid('No preview has been read.'))),
    { 'data-whm-account-repair': true, 'data-account-repair-can-manage': String(canManage) })
}
