import type { PanelSurfaceProps } from '../../../../contract.ts'
import { escapeHtml } from '../../../html.ts'
import { stagingClientTemplates } from './client-templates.ts'
import { domainButton, domainCard, domainContext, domainFacts, domainHeader, domainTable, missingDomainAccount, NO_DOMAIN_AUTHORITY, type DomainPageAuthority } from './common.ts'

export function renderV2StagingPage(props: PanelSurfaceProps, authority: DomainPageAuthority = NO_DOMAIN_AUTHORITY): string {
  const { t, account, canManage } = domainContext(props, authority)
  const unread = t(msgid('Not read'))
  const list = domainCard('staging-list', t(msgid('Staging copies')), `<p>${escapeHtml(t(msgid('A staging copy holds the files of one site in a private folder of your home directory. Change it, review the differences, then promote them to the live site.')))}</p>${domainTable(t(msgid('Sites and their staging copies')), [t(msgid('Domain')), t(msgid('Staging folder')), t(msgid('State')), t(msgid('Files')), t(msgid('Created (UTC)')), t(msgid('Last promoted (UTC)')), t(msgid('Actions'))], `<tr><td colspan="7">${escapeHtml(unread)}</td></tr>`, { 'data-staging-rows': true })}`,
    domainButton(t(msgid('Refresh')), { 'data-staging-refresh': true }, !canManage))
  const review = domainCard('staging-review', t(msgid('Review changes')), `${domainFacts([
    { label: t(msgid('Domain')), valueHtml: escapeHtml(unread), hooks: { 'data-staging-domain': true } },
    { label: t(msgid('Live files')), valueHtml: escapeHtml(unread), hooks: { 'data-staging-live': true } },
    { label: t(msgid('Staging files')), valueHtml: escapeHtml(unread), hooks: { 'data-staging-staging': true } },
    { label: t(msgid('Changes')), valueHtml: escapeHtml(unread), hooks: { 'data-staging-changes': true } },
  ])}${domainTable(t(msgid('Changes to promote')), [t(msgid('File')), t(msgid('Change')), t(msgid('Size'))], `<tr><td colspan="3">${escapeHtml(t(msgid('No changes have been reviewed.')))}</td></tr>`, { 'data-staging-review': true })}<label class="v2-domain-check"><input type="checkbox" data-staging-ack disabled><span>${escapeHtml(t(msgid('I reviewed these changes. Replaced and removed live files are moved to the trash first.')))}</span></label><div class="v2-domain-actions">${domainButton(t(msgid('Promote to live')), { 'data-staging-promote': true }, true, true)}</div>`)
  const result = domainCard('staging-result', t(msgid('Result')), domainTable(t(msgid('Staging results')), [t(msgid('File')), t(msgid('Change')), t(msgid('Result'))], `<tr><td colspan="3">${escapeHtml(t(msgid('No change has run.')))}</td></tr>`, { 'data-staging-results': true }))
  const rules = domainCard('staging-how', t(msgid('How staging works')), `<ul class="v2-domain-notes">${[
    msgid('Only files are staged. Databases are not copied; a site that uses a database keeps using the live one.'),
    msgid('A staging copy holds up to 500 regular files of up to 2 MiB each and 64 MiB in total. Sites with links cannot be staged.'),
    msgid('To preview the staging copy on its own address, add a subdomain whose document root is the staging folder.'),
    msgid('Promoting moves every replaced or removed live file to the trash, where you can restore it. Files added by the promotion are not removed by a restore.'),
    msgid('Discarding moves the staging folder to the trash.'),
  ].map(message => `<li>${escapeHtml(t(message))}</li>`).join('')}</ul>`)
  return `<section class="v2-domain-page"${authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-account-staging data-account="${escapeHtml((account?.id ?? ''))}" data-staging-manage="${canManage}">${domainHeader(t, '/domains/staging', t(msgid('Staging sites')), t(msgctxt('theme:v2', 'Create a separate copy, review changed files and promote only after review.')))}<p data-staging-status role="status" data-state="${canManage ? 'unread' : 'unavailable'}">${escapeHtml(canManage ? t(msgid('Staging copies have not been read.')) : t(msgid('Staging sites are not available for this account. Nothing was read or changed.')))}</p><div class="v2-domain-split"><div class="v2-domain-stack">${list}${review}${result}</div><aside>${rules}</aside></div>${stagingClientTemplates()}</section>`
}
