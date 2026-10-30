import { v2AccountLifecycleTemplates } from '../account-tools/lifecycle-client-templates.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { actions, button, context, esc, field, fields, page, status, table, toolCard, type WhmAccountToolAuthority } from '../account-tools/common.ts'

/** The controller must receive and revalidate a real review before it can unlock conversion. */
export function renderV2WhmConvertAddonPage(props: WhmSurfaceProps, authority: WhmAccountToolAuthority): string {
  const { t, editable } = context(props, authority)
  const title = t(msgid('Convert addon domain'))
  const container = editable ? 'form' : 'div'
  // Core unlocks these only after reading real candidates and native preview capabilities.
  const off = ' disabled'
  const steps = `<ol class="v2-recovery__steps" aria-label="${esc(t(msgid('Conversion steps')))}">${[msgid('Addon domain'), msgid('New account'), msgid('Review'), msgid('Convert')].map((label, index) => `<li${index === 0 ? ' aria-current="step"' : ''}><span class="v2-recovery__step-number" aria-hidden="true">${index + 1}</span><span>${esc(t(label))}</span></li>`).join('')}</ol>`
  const choice = toolCard('convert-addon-choice', t(msgid('Addon domain and new account')), `<${container} class="v2-account-tool__groups" data-acct-convert-form${editable ? ' novalidate' : ''}>${fields(
    field('v2-acct-convert-domain', t(msgid('Addon domain')), `<select id="v2-acct-convert-domain" dir="ltr" data-acct-convert-input="domainId"${off}><option value="">${esc(t(msgid('Not read')))}</option></select>`)
    + field('v2-acct-convert-username', t(msgid('New account username')), `<input id="v2-acct-convert-username" type="text" maxlength="16" autocomplete="off" spellcheck="false" dir="ltr" aria-describedby="v2-acct-convert-username-help" data-acct-convert-input="username"${off}>`, t(msgid('Lower-case letters and digits, starting with a letter.')))
    + field('v2-acct-convert-plan', t(msgid('Plan')), `<select id="v2-acct-convert-plan" data-acct-convert-input="planId"${off}><option value="">${esc(t(msgid('Not read')))}</option></select>`))}${actions(`<button type="${editable ? 'submit' : 'button'}" class="v2-btn v2-btn--primary" data-acct-convert-preview${off}>${esc(t(msgid('Review conversion')))}</button>${button(t(msgid('Refresh')), { 'data-acct-convert-refresh': true }, editable)}`)}</${container}>`)
  const reviewed = toolCard('convert-addon-review', t(msgid('What moves to the new account')), status(t(msgid('No conversion has been reviewed.')), { 'data-acct-convert-review-status': true })
    + `<dl class="v2-account-tool__facts" data-acct-convert-facts></dl>`
    + table(t(msgid('Domains')), [msgid('Domain'), msgid('Kind'), msgid('Document root')].map(label => t(label)), { 'data-acct-convert-rows': 'domains' }, t(msgid('Not read')))
    + table(t(msgid('Mail and service users')), [msgid('Login'), msgid('Service')].map(label => t(label)), { 'data-acct-convert-rows': 'mail' }, t(msgid('Not read')))
    + table(t(msgid('DNS zones')), [msgid('Zone'), msgid('Records')].map(label => t(label)), { 'data-acct-convert-rows': 'dns' }, t(msgid('Not read')))
    + table(t(msgid('Conflicts')), [msgid('Conflict'), msgid('Value')].map(label => t(label)), { 'data-acct-convert-rows': 'conflicts' }, t(msgid('Not read'))))
  const apply = toolCard('convert-addon-apply', t(msgid('Convert')), `<p data-acct-convert-capability>${esc(t(msgid('Conversion availability has not been read.')))}</p>`
    + field('v2-acct-convert-confirm', t(msgid('Type the confirmation')), `<input id="v2-acct-convert-confirm" type="text" autocomplete="off" spellcheck="false" dir="ltr" aria-describedby="v2-acct-convert-confirm-help" data-acct-convert-input="confirm" disabled>`, t(msgid('Type convert followed by the domain name, for example convert shop.example.com.')))
    + actions(button(t(msgid('Convert to account')), { 'data-acct-convert-apply': true }, false, true)))
  const rules = [
    msgctxt('theme:v2', 'Only the reviewed addon domain and the listed related data may move to the new account.'),
    msgctxt('theme:v2', 'The server checks the reviewed state again before changing anything.'),
    msgctxt('theme:v2', 'Resolve every conflict, then type the exact domain confirmation before converting.'),
    msgctxt('theme:v2', 'Conversion needs the host agent and confined account file runner. A review alone does not prove that either is available.'),
    msgctxt('theme:v2', 'If conversion fails, inspect the saved outcome and any remaining system user before retrying.'),
  ]
  const aside = toolCard('convert-addon-rules', t(msgctxt('theme:v2', 'Before converting')), `<ul class="v2-recovery__rules">${rules.map(rule => `<li>${esc(t(rule))}</li>`).join('')}</ul>`)
  const intro = status(t(msgid('Addon domains have not been read.')), { 'data-acct-convert-status': true })
    + `<div data-acct-convert-loading aria-busy="true" aria-label="${esc(t(msgid('Loading addon domains')))}" hidden></div><div data-acct-convert-empty hidden><h3>${esc(t(msgid('No addon domains')))}</h3><p>${esc(t(msgid('Only an addon domain of an existing account can become its own account.')))}</p></div>`
  return page(props, '/whm/transfers/convert-addon', title, t(msgid('Review what moves when an addon domain becomes its own account.')),
    `<div class="v2-recovery-tools v2-recovery__column" data-acct-convert-addon data-can-manage="${editable}">${steps}${intro}<div class="v2-recovery__grid"><div class="v2-recovery__column">${choice}${reviewed}${apply}</div><aside class="v2-recovery__column">${aside}</aside></div>${v2AccountLifecycleTemplates('convert')}</div>`)
}
