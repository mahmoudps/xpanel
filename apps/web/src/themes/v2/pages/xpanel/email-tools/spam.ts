import { v2MailToolsClientTemplates } from './mail-tools-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, area, button, check, emailContext, esc, facts, field, fields, header, input, missingAccount, page, section, state, table, unread, type PanelEmailAuthority } from './common.ts'

export function renderV2PanelSpamFilters(props: PanelSurfaceProps, authority?: PanelEmailAuthority): string {
  const { locale, t, account, canManage } = emailContext(props, authority)
  const route = '/email/spam-filters', title = t(msgid('Spam filters'))
  const score = (id: string, label: string): string => field(id, label, input(id, { 'data-spam-score': id }, ' type="number" dir="ltr" min="0" max="100" step="0.5"', !canManage))
  const saved = section('v2-spam-settings', t(msgid('Filtering')),
    `<p>${esc(t(msgid('Spam scoring, mailbox routing and the allow/block lists are stored configuration. The mail server effect remains unverified until host reconciliation reports it.')))}</p>`
    + fields(check('spam-enabled', t(msgid('Enable filtering')), { 'data-spam-enabled': true }, !canManage)
      + check('spam-box-enabled', t(msgid('Move spam to the spam folder')), { 'data-spam-box': true }, !canManage)
      + check('spam-autodelete', t(msgid('Delete very high scores')), { 'data-spam-autodelete': true }, !canManage))
    + `<fieldset><legend>${esc(t(msgid('Score thresholds (0 through 100)')))}</legend>${fields(score('spam-rewrite', t(msgid('Rewrite subject score'))) + score('spam-header', t(msgid('Add header score'))) + score('spam-greylist', t(msgid('Greylist score'))) + score('spam-reject', t(msgid('Reject score'))) + score('spam-autodelete-score', t(msgid('Auto-delete score'))))}</fieldset>`
    + `<fieldset><legend>${esc(t(msgid('Allow and block lists')))}</legend>${fields(field('spam-allowlist', t(msgid('Allowlist (addresses, CIDRs or hostnames, one per line)')), area('spam-allowlist', { 'data-spam-allowlist': true }, ' rows="5" dir="ltr"', !canManage)) + field('spam-blocklist', t(msgid('Blocklist (addresses, CIDRs or hostnames, one per line)')), area('spam-blocklist', { 'data-spam-blocklist': true }, ' rows="5" dir="ltr"', !canManage)))}</fieldset>`
    + actions(button(t(msgid('Save spam settings')), { 'data-spam-save': true }, !canManage, true))
    + state(t(msgctxt('theme:v2', 'Spam settings have not been read.')), { 'data-spam-status': true }),
    { 'data-spam-settings': true, 'data-account': (account?.id ?? ''), 'data-spam-can-manage': String(canManage) })
  const native = section('v2-spam-native', t(msgid('Spam filter per mailbox')),
    `<p>${esc(t(msgid('Saved mailbox spam preferences take effect on this server. Allowed senders and a mailbox that sets its own filtering or score go to the rspamd settings file. Blocked senders and moving flagged mail to Junk go to the mailbox Sieve policy script, which runs before the mailbox filters.')))}</p>`
    + actions(button(t(msgid('Refresh')), { 'data-mailx-tools-refresh': true }, !canManage))
    + state(t(msgid('Mailbox spam state has not been read.')), { 'data-mailx-tools-status': true })
    + facts([{ label: t(msgid('Detected filter')), valueHtml: esc(t(msgid('Not read'))), hooks: { 'data-mailx-tools-fact': 'engine' } }, { label: t(msgid('Postfix passes mail to the filter')), valueHtml: esc(t(msgid('Not read'))), hooks: { 'data-mailx-tools-fact': 'wiring' } }, { label: t(msgid('Observed at (UTC)')), valueHtml: esc(t(msgid('Not read'))), hooks: { 'data-mailx-tools-fact': 'observed-at' } }])
    + table('v2-spam-mailboxes', t(msgid('Mailboxes')), [t(msgid('Mailbox')), t(msgid('Saved preference')), t(msgid('Applied on this server')), t(msgid('Takes effect')), t(msgid('Train the filter'))], unread(t, 5), { 'data-mailx-tools-rows': true })
    + `<p>${esc(t(msgid('Training reads the messages in the mailbox Inbox (as not spam) or Junk folder (as spam) and teaches the server-wide filter. It runs as a host job.')))}</p><p data-mailx-tools-action-status role="status"></p>`
    + actions(button(t(msgid('Apply saved preferences')), { 'data-mailx-tools-apply': true }, true, true)) + v2MailToolsClientTemplates('spam'),
    { 'data-mailx-tools': true, 'data-mailx-tools-section': 'spam', 'data-mailx-can-manage': String(canManage) })
  const challenge = section('v2-spam-boxtrapper', 'BoxTrapper',
    `<p data-state="unavailable" role="status">${esc(t(msgid('BoxTrapper is unavailable on this server.')))}</p>`
    + facts([{ label: t(msgid('Challenge-response verification')), valueHtml: esc(t(msgid('Unavailable'))) }, { label: t(msgid('Verification queue')), valueHtml: esc(t(msgid('Unavailable'))) }])
    + check('mailx-boxtrapper-enabled', t(msgid('Ask unknown senders to verify before delivery')))
    + field('mailx-boxtrapper-allow', t(msgid('Senders delivered without verification')), area('mailx-boxtrapper-allow', undefined, ' rows="3" dir="ltr"'))
    + `<p>${esc(t(msgid('Missing native step: xPanel has no challenge-response provider for Postfix and Dovecot. Challenge mail sent to forged senders creates backscatter, so none is enabled. Use the spam filter and sender lists instead.')))}</p>`)
  const inert = !authority?.canRead || authority.presentation === 'read-only' || !account
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Keep saved spam policy separate from the filter state observed on this server.'))) + saved + native + challenge, inert ? { 'data-readonly': 'true' } : undefined)
}
