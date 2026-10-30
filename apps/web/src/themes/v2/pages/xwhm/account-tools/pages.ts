import { v2AccountLifecycleTemplates } from './lifecycle-client-templates.ts'
import { v2WhmClientTemplates } from '../../../whm-client-templates.ts'
import { languageName, localeDirection } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { v2Messages } from '../../../messages.ts'
import { actions, button, context, esc, facts, field, fields, page, status, table, toolCard, type WhmAccountToolAuthority } from './common.ts'
import { v2WhmDiagnosticTemplates } from '../whm-diagnostic-client-templates.ts'

export function renderV2WhmAccountHealthPage(props: WhmSurfaceProps, authority: WhmAccountToolAuthority): string {
  const { t, readable } = context(props, authority)
  const title = t(msgid('Account health & repair'))
  const unread = t(msgid('Not read'))
  const summary = toolCard('health-summary', t(msgid('Health checks')), `<p>${esc(t(msgid('Checks compare each account with its saved plan, certificates, DNS zones and PHP settings, and read its system user, home directory and disk quota on this server. Checks never change anything. Each problem links to the page that fixes it.')))}</p>`
    + actions(button(t(msgid('Run checks')), { 'data-whm-health-run': true }, readable, true))
    + status(t(readable ? msgid('Checks have not been run.') : msgid('Account health requires an authorized root administrator or a reseller with the list-accounts privilege. Nothing was read or changed.')), { 'data-whm-health-status': true }, readable ? 'unread' : 'unavailable')
    + facts([
      { label: t(msgid('Accounts checked')), hooks: { 'data-whm-health-count-accounts': true } },
      { label: t(msgid('Accounts with problems')), hooks: { 'data-whm-health-count-affected': true } },
      { label: t(msgid('Problems found')), hooks: { 'data-whm-health-count-problems': true } },
      { label: t(msgid('Checks not verified')), hooks: { 'data-whm-health-count-unavailable': true } },
      { label: t(msgid('Last checked (UTC)')), hooks: { 'data-whm-health-observed-at': true } },
    ], unread) + `<p class="v2-muted">${esc(t(msgid('Not verified means the evidence could not be read. It is never counted as healthy.')))}</p>`)
  const options = [
    ['all', msgctxt('whm-account-health-workspace', 'All accounts')], ['problem', msgid('With problems')],
    ['unavailable', msgid('Not fully verified')], ['ok', msgid('No problems found')],
  ] as const
  const off = readable ? '' : ' disabled'
  const accounts = toolCard('health-accounts', t(msgid('Accounts')), `<div role="search" aria-label="${esc(t(msgid('Filter checked accounts')))}">${fields(field('v2-whm-health-filter', t(msgctxt('whm-account-health-workspace', 'Show')), `<select id="v2-whm-health-filter" data-whm-health-filter${off}>${options.map(([value, label]) => `<option value="${value}">${esc(t(label))}</option>`).join('')}</select>`)
    + field('v2-whm-health-search', t(msgid('Account or domain')), `<input id="v2-whm-health-search" type="search" dir="ltr" maxlength="253" autocomplete="off" spellcheck="false" data-whm-health-search${off}>`))}</div>`
    + actions(`<label class="v2-account-tool__choice"><input type="checkbox" data-whm-health-select-all${off}><span>${esc(t(msgid('Select all shown')))}</span></label>${button(t(msgid('Recheck selected')), { 'data-whm-health-recheck': true })}<span data-whm-health-selection role="status">${esc(t(msgid('No accounts selected.')))}</span>`)
    + `<div class="v2-account-tool__groups" data-whm-health-list aria-live="polite"><p data-whm-health-empty>${esc(t(msgid('No accounts have been checked.')))}</p></div>`)
  return page(props, '/whm/accounts/health', title, t(msgid('Read-only checks of each account against its saved plan and this server, with links to the pages that fix each problem.')), v2WhmDiagnosticTemplates() + summary + accounts,
    { 'data-whm-health-workspace': true, 'data-health-can-read': String(readable), 'data-health-root': String(authority.root === true) })
}

export function renderV2WhmAccountBandwidthPage(props: WhmSurfaceProps, authority: WhmAccountToolAuthority): string {
  const { t, readable } = context(props, authority)
  const title = t(msgid('Bandwidth'))
  const body = toolCard('bandwidth', t(msgid('Bandwidth per account')), `<p>${esc(t(msgid('Traffic this month (UTC), counted from the saved site access logs, the Postfix delivery journal and the FTP transfer journal. Each source is sent plus received bytes.')))}</p><p>${esc(t(msgid('A plan with bandwidth enforcement on serves a bandwidth-exceeded page on its websites once the monthly limit is used, until the next month (UTC) or until the limit is raised. Mail, FTP and the panels keep working. Other plans are only compared.')))}</p>`
    + actions(button(t(msgid('Read bandwidth')), { 'data-whm-metering-refresh': true }, readable))
    + status(t(readable ? msgid('Bandwidth has not been read.') : msgid('Metering requires an authorized root administrator on a qualified host.')), { 'data-whm-metering-status': true }, readable ? 'unread' : 'unavailable')
    + facts([
      ['month', msgid('Month (UTC)')], ['since', msgid('Counted since (UTC)')], ['updated', msgid('Last counted (UTC)')],
      ['pending', msgid('Log data not yet counted')], ['web', msgid('Web logs')], ['mail', msgid('Mail journal')], ['ftp', msgid('FTP journal')],
    ].map(([key, label]) => ({ label: t(label!), hooks: { 'data-whm-metering-fact': key! } })), t(msgid('Not read')))
    + table(t(msgid('Bandwidth per account')), [msgid('Account'), msgid('Domain'), msgid('Status'), msgid('Web'), msgid('Mail'), 'FTP', msgid('Total'), msgid('Plan limit')].map(label => t(label)), { 'data-whm-metering-rows': 'bandwidth' }, t(msgid('No bandwidth has been read.'))))
  return page(props, '/whm/accounts/bandwidth', title, t(msgid('Monthly traffic per account: web from the saved site access logs, plus mail and FTP from their service logs.')), body,
    { 'data-whm-metering': 'bandwidth', 'data-metering-can-read': String(readable) })
}

export function renderV2WhmAccountAnnouncementsPage(props: WhmSurfaceProps, authority: WhmAccountToolAuthority): string {
  const { t, locale, editable } = context(props, authority)
  const off = editable ? '' : ' disabled'
  const title = t(msgid('Announcements'))
  const list = toolCard('announcements-list', t(msgid('Saved announcements')), status(t(msgid('Announcements have not been read. No announcement is assumed to be shown.')), { 'data-whm-announcements-status': true })
    + `<div data-whm-announcements-loading aria-busy="true" aria-label="${esc(t(msgid('Loading announcements')))}" hidden></div>`
    + table(t(msgid('Announcements, newest first')), [msgid('Title'), msgid('Severity'), msgid('Audience'), msgid('Shown (UTC)'), msgid('State'), msgid('Updated (UTC)'), msgid('Actions')].map(label => t(label)), { 'data-whm-announcements-rows': true }, t(msgid('Not read')))
    + `<div data-whm-announcements-empty hidden><h3>${esc(t(msgid('No announcements yet')))}</h3><p>${esc(t(msgid('Create one below. Account owners see no notice until then.')))}</p></div><p class="v2-muted">${esc(t(msgid('Newest first. Up to 50 announcements can be active. Archived ones are kept as history, up to 100 records in all; past that, the oldest archived record is removed.')))}</p>`
    + actions(button(t(msgid('Refresh')), { 'data-whm-announcements-refresh': true }, editable))
    + status('', { 'data-whm-announcements-list-status': true }, 'unread', true))
  const select = (key: string, options: readonly (readonly [string, string])[]): string => `<select id="v2-announcements-${key}" name="${key}" data-whm-announcements-input="${key}"${off}>${options.map(([value, label]) => `<option value="${esc(value)}">${esc(t(label))}</option>`).join('')}</select>`
  const content = (['en', 'ar'] as const).map(language => `<fieldset${off}><legend>${esc(languageName(language, locale))}</legend>`
    + field(`v2-announcements-title-${language}`, t(msgid('Title')), `<input id="v2-announcements-title-${language}" name="title-${language}" lang="${language}" dir="${localeDirection(language)}" type="text" maxlength="140" autocomplete="off" required aria-describedby="v2-announcements-text-help" data-whm-announcements-input="title-${language}"${off}>`)
    + field(`v2-announcements-body-${language}`, t(msgid('Message')), `<textarea id="v2-announcements-body-${language}" name="body-${language}" lang="${language}" dir="${localeDirection(language)}" rows="5" maxlength="2000" required aria-describedby="v2-announcements-text-help" data-whm-announcements-input="body-${language}"${off}></textarea>`) + '</fieldset>').join('')
  const choices = fields(field('v2-announcements-severity', t(msgid('Severity')), select('severity', [['info', msgid('Notice')], ['warning', msgid('Warning')], ['maintenance', msgid('Maintenance')]]))
    + field('v2-announcements-audience', t(msgid('Audience')), select('audience', [['all', msgid('All accounts')], ['plan', msgid('Accounts on a plan')], ['reseller', msgid("A reseller's accounts")], ['accounts', msgid('Listed accounts')]]))
    + field('v2-announcements-plan', t(msgid('Plan')), select('plan', [['', msgid('Not read')]]), undefined, { 'data-whm-announcements-audience-field': 'plan' }, true)
    + field('v2-announcements-reseller', t(msgid('Reseller')), select('reseller', [['', msgid('Not read')]]), undefined, { 'data-whm-announcements-audience-field': 'reseller' }, true)
    + field('v2-announcements-usernames', t(msgid('Accounts')), `<textarea id="v2-announcements-usernames" name="usernames" rows="3" dir="ltr" maxlength="1800" autocomplete="off" spellcheck="false" data-whm-announcements-input="usernames" aria-describedby="v2-announcements-usernames-help"${off}></textarea>`, t(msgid('Account usernames, one per line or comma-separated, up to 100. Each must exist.')), { 'data-whm-announcements-audience-field': 'accounts' }, true))
  const dates = fields(field('v2-announcements-starts', t(msgctxt('whm-announcements-workspace', 'Starts (UTC)')), `<input id="v2-announcements-starts" name="starts" type="datetime-local" dir="ltr" data-whm-announcements-input="starts" aria-describedby="v2-announcements-starts-help"${off}>`, t(msgid('Empty starts as soon as it is saved.')))
    + field('v2-announcements-ends', t(msgctxt('whm-announcements-workspace', 'Ends (UTC)')), `<input id="v2-announcements-ends" name="ends" type="datetime-local" dir="ltr" data-whm-announcements-input="ends" aria-describedby="v2-announcements-ends-help"${off}>`, t(msgid('Empty keeps it shown until you archive it.'))))
  const previews = (['en', 'ar'] as const).map(language => {
    const tr = v2Messages.translator(language)
    const labels = { info: tr(msgid('Notice')), warning: tr(msgid('Warning')), maintenance: tr(msgid('Maintenance')), until: tr(msgid('Until {end}')), dismiss: tr(msgid('Dismiss')), dismissFor: tr(msgid('Dismiss announcement: {title}')) }
    return `<div class="v2-account-tool__preview" data-whm-announcements-preview="${language}" lang="${language}" dir="${localeDirection(language)}" data-whm-announcements-labels="${esc(JSON.stringify(labels))}" aria-label="${esc(t(msgid('{language} preview'), { language: languageName(language, locale) }))}" hidden></div>`
  }).join('')
  const container = editable ? 'form' : 'div'
  const editor = toolCard('announcements-editor', t(msgid('Create announcement')), `<${container} class="v2-account-tool__groups" data-whm-announcements-form aria-labelledby="v2-announcements-editor-heading"${editable ? ' novalidate' : ''}><h3 id="v2-announcements-editor-heading" data-whm-announcements-editor-heading>${esc(t(msgid('Create announcement')))}</h3>${content}<p class="v2-muted" id="v2-announcements-text-help">${esc(t(msgid('Plain text only: HTML is refused and links are not made clickable. Titles up to 140 characters, messages up to 2000. Both languages are required.')))}</p>${choices}${dates}<section class="v2-account-tool__groups" aria-labelledby="v2-announcements-preview-heading"><h3 id="v2-announcements-preview-heading">${esc(t(msgid('Preview')))}</h3><p data-whm-announcements-preview-empty>${esc(t(msgid('Fill in both titles and messages to see how account owners will see the notice.')))}</p><div class="v2-account-tool__previews">${previews}</div></section>${actions(`<button type="${editable ? 'submit' : 'button'}" class="v2-btn v2-btn--primary" data-whm-announcements-save${off}>${esc(t(msgid('Create announcement')))}</button><button type="button" class="v2-btn" data-whm-announcements-cancel hidden${off}>${esc(t(msgid('Cancel editing')))}</button>`)}${status('', { 'data-whm-announcements-save-status': true }, 'unread', true)}</${container}>`)
  return page(props, '/whm/accounts/announcements', title, t(msgid("Notices shown on account owners' xPanel home page while they are live, in English and Arabic. Owners can dismiss a notice for their own account. Nothing is emailed.")), v2WhmClientTemplates('announcements') + list + editor,
    { 'data-whm-announcements-workspace': true, 'data-announcements-can-manage': String(editable), 'data-capability-state': editable ? 'authorized' : 'unavailable' })
}

export function renderV2WhmAccountTemplatesPage(props: WhmSurfaceProps, authority: WhmAccountToolAuthority): string {
  const { t, editable } = context(props, authority)
  const title = t(msgid('Templates'))
  const off = editable ? '' : ' disabled'
  const input = (key: string, label: string, max = 140): string => field(`v2-account-template-${key}`, label, `<input id="v2-account-template-${key}" type="text" maxlength="${max}" dir="auto" autocomplete="off" data-acct-templates-input="${key}"${off}>`)
  const application = toolCard('template-application', t(msgid('Where templates apply')), status(t(msgid('A new account whose plan uses a template gets the default zone plus the template records. Existing accounts and zones do not change.')), { 'data-acct-templates-application': true }, 'ready')
    + status(t(msgid('The default and suspended page text is saved only. The web server still shows its shipped pages, because this server has no publisher for those pages yet.')), { 'data-acct-templates-pages': true }, 'unavailable'))
  const list = toolCard('template-list', t(msgid('Saved templates')), status(t(msgid('Templates have not been read.')), { 'data-acct-templates-status': true })
    + `<div data-acct-templates-loading aria-busy="true" aria-label="${esc(t(msgid('Loading templates')))}" hidden></div>`
    + table(t(msgid('Account creation templates')), [msgid('Name'), msgid('Plans'), msgid('Zone records'), msgid('Updated (UTC)'), msgid('Actions')].map(label => t(label)), { 'data-acct-templates-rows': true }, t(msgid('Not read')))
    + `<div data-acct-templates-empty hidden><h3>${esc(t(msgid('No templates yet')))}</h3><p>${esc(t(msgid('Create one below. A plan uses at most one template.')))}</p></div>`
    + actions(button(t(msgid('Refresh')), { 'data-acct-templates-refresh': true }, editable)) + status('', { 'data-acct-templates-list-status': true }, 'unread', true))
  const contentPage = (kind: 'defaultPage' | 'suspendedPage', label: string, help: string): string => `<fieldset${off}><legend>${esc(label)}</legend><p>${esc(help)}</p>${input(`${kind}.title`, t(msgid('Title')))}${field(`v2-account-template-${kind}.body`, t(msgid('Message')), `<textarea id="v2-account-template-${kind}.body" rows="4" maxlength="2000" dir="auto" data-acct-templates-input="${kind}.body"${off}></textarea>`)}</fieldset>`
  const container = editable ? 'form' : 'div'
  const editor = toolCard('template-editor', t(msgid('Create template')), `<${container} class="v2-account-tool__groups" data-acct-templates-form${editable ? ' novalidate' : ''}><h3 data-acct-templates-editor-heading>${esc(t(msgid('Create template')))}</h3>${input('name', t(msgid('Template name')), 64)}<fieldset${off}><legend>${esc(t(msgid('Plans that use this template')))}</legend><div class="v2-account-tool__choice-list" data-acct-templates-plans><p>${esc(t(msgid('Plans have not been read.')))}</p></div></fieldset>`
    + field('v2-account-template-zone', t(msgid('Extra zone records')), `<textarea id="v2-account-template-zone" rows="8" dir="ltr" spellcheck="false" autocomplete="off" data-acct-templates-input="zone" aria-describedby="v2-account-template-zone-help"${off}></textarea>`, t(msgid('One record per line: name, TTL in seconds, type, the priority for MX and SRV, then the content, for example: shop 3600 CNAME www.%domain%. These are added to the default zone. Lines starting with ; are ignored. Placeholders: {placeholders}. A line using %ipv6% is left out for an account without IPv6.'), { placeholders: '%domain%, %ipv4%, %ipv6%, %mailhost%' }))
    + contentPage('defaultPage', t(msgid('Default website page')), t(msgid('Plain text shown on a new site before the owner uploads files.')))
    + contentPage('suspendedPage', t(msgid('Suspended account page')), t(msgid('Plain text shown while an account is suspended.')))
    + actions(`<button type="${editable ? 'submit' : 'button'}" class="v2-btn v2-btn--primary" data-acct-templates-save${off}>${esc(t(msgid('Create template')))}</button><button type="button" class="v2-btn" data-acct-templates-cancel hidden${off}>${esc(t(msgid('Cancel editing')))}</button>`)
    + status('', { 'data-acct-templates-save-status': true }, 'unread', true) + `</${container}>`)
  const preview = toolCard('template-preview', t(msgid('Zone preview')), `<p data-acct-templates-preview-note>${esc(t(msgid('Choose Edit on a saved template to see its full zone for example.com with documentation addresses 192.0.2.10 and 2001:db8::10. Unsaved changes are checked when you save.')))}</p>`
    + table(t(msgid('Zone preview')), [t(msgid('Name')), 'TTL', t(msgid('Type')), t(msgid('Priority')), t(msgid('Content'))], { 'data-acct-templates-preview': true }, t(msgid('No template selected'))))
  return page(props, '/whm/accounts/templates', title, t(msgid('Zone records and page text for new accounts on a plan. New accounts get the template zone records; the page text is saved only.')), application + list + editor + preview + v2AccountLifecycleTemplates('templates'),
    { 'data-acct-templates-workspace': true, 'data-templates-can-manage': String(editable) })
}
