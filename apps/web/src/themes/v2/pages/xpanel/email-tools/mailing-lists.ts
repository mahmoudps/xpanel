import { v2MailToolsClientTemplates } from './mail-tools-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { accountMailingListClientTemplates } from './routing-client-templates.ts'
import { actions, area, button, check, emailContext, esc, facts, field, fields, header, input, missingAccount, page, section, select, state, table, technical, unread, type PanelEmailAuthority } from './common.ts'

export function renderV2PanelMailingLists(props: PanelSurfaceProps, authority?: PanelEmailAuthority): string {
  const { locale, t, account, canManage, domains, plan } = emailContext(props, authority)
  const route = '/email/mailing-lists', title = t(msgid('Mailing lists'))
  const createAllowed = canManage && domains !== undefined && domains.length > 0
  const domainOptions = domains?.length ? domains.map(row => [row.name, row.name] as const) : [['', t(msgid('No account domain is available'))] as const]
  const saved = section('v2-mailing-lists', title,
    facts([{ label: t(msgid('Plan limit')), valueHtml: plan?.caps.mailingLists === undefined ? esc(t(msgid('Not read'))) : technical(plan.caps.mailingLists) }])
    + table('v2-mailing-list-records', title, [t(msgid('Address')), t(msgid('Members')), t(msgid('Moderation')), t(msgid('Archive')), t(msgid('Action'))], unread(t, 5), { 'data-mailing-lists-rows': true })
    + state(t(msgctxt('theme:v2', 'Saved mailing lists have not been read.')), { 'data-mailing-list-status': true })
    + `<div class="v2-panel-extra__editor" data-mailing-list-form role="group" aria-labelledby="v2-mailing-list-create-heading"><h3 id="v2-mailing-list-create-heading">${esc(t(msgid('Create mailing list')))}</h3>`
    + fields(field('mailing-list-name', t(msgid('List name')), input('mailing-list-name', { 'data-ml-name': true }, ' type="text" dir="ltr" maxlength="64" autocomplete="off"', !createAllowed))
      + field('mailing-list-domain', t(msgid('Domain')), select('mailing-list-domain', domainOptions, { 'data-ml-domain': true }, !createAllowed, ' dir="ltr"'))
      + field('mailing-list-moderation', t(msgid('Moderation')), select('mailing-list-moderation', [['members', t(msgid('Members'))], ['open', t(msgid('Open'))], ['moderated', t(msgid('Moderated'))]], { 'data-ml-moderation': true }, !createAllowed))
      + field('mailing-list-archive', t(msgid('Archive messages')), check('mailing-list-archive', t(msgid('Keep an archive')), { 'data-ml-archive': true }, !createAllowed, true)))
    + field('mailing-list-members', t(msgid('Members (one address per line, optional)')), area('mailing-list-members', { 'data-ml-members': true }, ' rows="4" dir="ltr"', !createAllowed))
    + `<p>${esc(t(msgid('List membership and moderation are stored configuration only; mail delivery to the list is not verified here.')))}</p>`
    + actions(button(t(msgctxt('account-mailing-lists', 'Create list')), { 'data-ml-create': true }, !createAllowed, true)) + '</div>' + accountMailingListClientTemplates(),
    { 'data-mailing-lists': true, 'data-account': (account?.id ?? ''), 'data-mailing-can-manage': String(createAllowed) })
  const delivery = section('v2-mailing-list-delivery', t(msgid('List delivery and moderation')),
    `<p>${esc(t(msgid('Lists with open posting are delivered by expanding the list address to its members in the Postfix alias table. Lists that limit posting to members or hold posts for moderation are not delivered, because that needs a list manager.')))}</p>`
    + actions(button(t(msgid('Refresh')), { 'data-mailx-lists-refresh': true }, !canManage))
    + state(t(msgid('List delivery has not been read.')), { 'data-mailx-lists-status': true })
    + facts([{ label: t(msgid('Delivery to members')), valueHtml: esc(t(msgid('Not read'))), hooks: { 'data-mailx-tools-fact': 'delivery' } }, { label: t(msgid('Observed at (UTC)')), valueHtml: esc(t(msgid('Not read'))), hooks: { 'data-mailx-tools-fact': 'observed-at' } }, { label: t(msgid('Moderation queue')), valueHtml: esc(t(msgid('Unavailable'))) }, { label: t(msgid('Held messages')), valueHtml: esc(t(msgid('None can be held'))) }])
    + table('v2-list-delivery-records', title, [t(msgid('Address')), t(msgid('Members')), t(msgid('Delivery state'))], unread(t, 3), { 'data-mailx-lists-rows': true })
    + `<p data-mailx-lists-action-status role="status"></p>` + actions(button(t(msgid('Apply saved lists')), { 'data-mailx-lists-apply': true }, true, true))
    + check('mailx-lists-hold', t(msgid('Hold posts from non-members for review')))
    + field('mailx-lists-moderators', t(msgid('Moderators')), area('mailx-lists-moderators', undefined, ' rows="3" dir="ltr"'))
    + `<p>${esc(t(msgid('Moderation needs a list manager (for example Mailman or mlmmj) that holds posts for approval. None is installed or connected.')))}</p>` + v2MailToolsClientTemplates('lists'),
    { 'data-mailx-tools': true, 'data-mailx-tools-section': 'lists', 'data-mailx-can-manage': String(canManage) })
  const inert = !authority?.canRead || authority.presentation === 'read-only' || !account
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Manage saved membership, posting policy and the observed delivery state of your account lists.'))) + saved + delivery, inert ? { 'data-readonly': 'true' } : undefined)
}
