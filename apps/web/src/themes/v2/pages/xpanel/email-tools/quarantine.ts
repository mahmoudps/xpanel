import { accountQuarantineClientTemplates } from './routing-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, emailContext, esc, facts, field, fields, header, missingAccount, page, section, select, state, type PanelEmailAuthority } from './common.ts'

export function renderV2PanelQuarantine(props: PanelSurfaceProps, authority?: PanelEmailAuthority): string {
  const { locale, t, account, canManage, mailboxes } = emailContext(props, authority)
  const route = '/email/spam-quarantine', title = t(msgid('Spam quarantine'))
  const value = (label: string, hook: string): { label: string; valueHtml: string } => ({ label, valueHtml: `<span data-quarantine-${hook}>${esc(t(msgid('Not read')))}</span>` })
  const held = section('v2-quarantine-held', t(msgid('Held messages')),
    `<p>${esc(t(msgid('Review messages held by the configured mail filter. Release is confirmed only after a not-spam correction and Inbox readback.')))}</p>`
    + fields(field('quarantine-mailbox', t(msgid('Mailbox')), select('quarantine-mailbox', (mailboxes ?? []).map(mailbox => [mailbox.login, mailbox.login] as const), { 'data-quarantine-mailbox': true }, !canManage, ' dir="ltr"'))
      + facts([value(t(msgid('Held messages reported by the source')), 'total'), value(t(msgid('Source observation (UTC)')), 'observed')]))
    + actions(button(t(msgid('Read current quarantine')), { 'data-quarantine-refresh': true }, !canManage) + button(t(msgid('Older messages')), { 'data-quarantine-older': true }) + button(t(msgid('Newest messages')), { 'data-quarantine-newest': true }))
    + state(t(msgid('Quarantine has not been read.')), { 'data-quarantine-status': true })
    + `<ul class="v2-panel-extra__list" data-quarantine-messages></ul>`)
  const review = `<div data-quarantine-detail hidden>${section('v2-quarantine-detail', t(msgid('Message review')),
    facts([value(t(msgctxt('account-quarantine', 'From')), 'from'), value(t(msgid('Subject')), 'subject'), value(t(msgid('Received (UTC)')), 'received'), value(t(msgid('Held since (UTC)')), 'held'), value(t(msgid('Spam score')), 'score')])
    + `<div class="v2-field"><span id="quarantine-headers-label" class="v2-label">${esc(t(msgid('Header preview')))}</span><pre id="quarantine-headers" class="v2-panel-extra__raw v2-mono" aria-labelledby="quarantine-headers-label" dir="ltr" tabindex="0" data-quarantine-headers></pre></div>`
    + actions(button(t(msgid('Release to Inbox and correct filter')), { 'data-quarantine-release': true }, true, true) + button(t(msgid('Permanently delete held message')), { 'data-quarantine-delete': true }) + button(t(msgid('Always allow sender')), { 'data-quarantine-allow': true }))
    + `<p data-quarantine-release-limit hidden>${esc(t(msgid('This message exceeds the 1 MiB bounded learning size. Release is unavailable; deletion remains a separate confirmed action.')))}</p><p>${esc(t(msgid('Sender allow rules need an active filter-policy adapter and are unavailable here. Deletion permanently removes only the selected held message.')))}</p>`,
    )}</div>`
  const retention = section('v2-quarantine-retention', t(msgid('Retention and digest')),
    fields(facts([value(t(msgid('Retention window (days)')), 'retention')]) + field('quarantine-digest', t(msgid('Digest email')), select('quarantine-digest', [['', t(msgid('Unavailable: digest transport is not configured'))]])))
    + `<p>${esc(t(msgid('The configured retention window is read from the active profile. Expiry below is an explicit action for the displayed UID window; automatic expiry and digest delivery are not claimed.')))}</p>`
    + actions(button(t(msgid('Delete expired messages in this window')), { 'data-quarantine-expire': true })))
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Read held mail, review headers and confirm each release or permanent removal.')))
    + `<div class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-account-quarantine data-account="${esc((account?.id ?? ''))}" data-quarantine-manage="${canManage}">${held}${review}${retention}${accountQuarantineClientTemplates()}</div>`)
}
