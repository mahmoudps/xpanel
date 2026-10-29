import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { renderHandoffButton } from '../panel-handoff-controls.ts'

export function renderAccountCollaborationWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues) => translator(input.locale)(message, values)
  // Each xMail button opens the mailbox chosen above with a one-time handoff; no xMail address is rendered.
  const mailHandoff = (landing: 'calendar' | 'contacts', label: string) => renderHandoffButton(input.locale, { audience: 'xmail', mailboxSelect: 'collaboration-mailbox', landing, label, disabled: !input.canManage })
  const field = (id: string, label: string, control: string) => `<div class="xp-collaboration__field"><label for="${id}">${label}</label>${control}</div>`
  const empty = t('Saved mailbox collections have not been read.')
  return `<div class="xp-collaboration" data-account-collaboration data-collaboration-enabled="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>.xp-collaboration{--xp-collaboration-inset:13px;display:flex;flex-direction:column;gap:32px;min-inline-size:0;text-align:start}.xp-collaboration :is(h2,p,dl,dd){margin:0}.xp-collaboration__card{display:flex;flex-direction:column;gap:24px;min-inline-size:0;padding:24px;border:1px solid var(--xp-border);border-radius:12px;background:var(--xp-bg-surface)}.xp-collaboration__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.xp-collaboration__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-collaboration__field>label{padding-inline:var(--xp-collaboration-inset);font-weight:600}.xp-collaboration :is(input,select){inline-size:100%;box-sizing:border-box;min-inline-size:0;min-block-size:44px;padding:10px calc(var(--xp-collaboration-inset) - 1px);border:1px solid var(--xp-border-strong);border-radius:8px;color:inherit;background:var(--xp-bg-surface);font:inherit;text-align:left}.xp-collaboration[dir=rtl] :is(input,select){text-align:right}.xp-collaboration__actions{display:flex;flex-wrap:wrap;gap:16px}.xp-collaboration .xp-btn{min-block-size:44px}.xp-collaboration__scroll{min-inline-size:0;max-inline-size:100%;overflow:auto}.xp-collaboration table{inline-size:100%;min-inline-size:680px;border-collapse:collapse}.xp-collaboration :is(th,td){text-align:start;vertical-align:top;padding:8px;overflow-wrap:anywhere}.xp-collaboration th{border-block-end:1px solid var(--xp-border)}.xp-collaboration .xp-collaboration__scroll bdi[dir=ltr]{white-space:normal!important;overflow-wrap:anywhere;min-inline-size:0;flex-shrink:1!important}.xp-collaboration :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}@media(max-width:600px){.xp-collaboration__card{padding:16px}}@media(max-width:639px){.xp-collaboration__fields{grid-template-columns:minmax(0,1fr)}}</style>
    <section class="xp-collaboration__card" aria-labelledby="collaboration-collections-heading"><h2 id="collaboration-collections-heading">${t('Mailbox collections')}</h2>
      <div class="xp-collaboration__actions"><button class="xp-btn" type="button" data-collaboration-refresh${input.canManage ? '' : ' disabled'}>${t('Read saved collections')}</button></div>
      <p data-collaboration-status data-state="unread" role="status">${empty}</p>
      <div class="xp-collaboration__scroll" role="region" tabindex="0" aria-label="${t('Saved mailbox collections')}"><table class="xp-table"><thead><tr>${[t('Mailbox'), t('Name'), t('Type'), t('Saved items'), t('Settings')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-collaboration-collections><tr><td colspan="5">${empty}</td></tr></tbody></table></div>
      <p class="xp-help">${t('This account overview includes only current owned mailbox metadata. Event bodies and contact details are managed in an independently authenticated xMail session. Unverified legacy ownership is withheld without exposing its records or counts.')}</p>
    </section>
    <section class="xp-collaboration__card" aria-labelledby="collaboration-create-heading"><h2 id="collaboration-create-heading">${t('Create a calendar')}</h2>
      <div class="xp-collaboration__fields">
        ${field('collaboration-mailbox', t('Owner mailbox'), `<select id="collaboration-mailbox" data-collaboration-mailbox dir="ltr" disabled><option value="">${t('Read mailboxes first')}</option></select>`)}
        ${field('collaboration-type', t('Collection type'), `<select id="collaboration-type" disabled><option>${t(msgctxt('account-collaboration-workspace', 'Calendar'))}</option></select>`)}
        ${field('collaboration-name', t('Calendar name'), '<input id="collaboration-name" data-collaboration-name type="text" maxlength="200" autocomplete="off" disabled>')}
        ${field('collaboration-color', t('Color (HEX)'), '<input id="collaboration-color" data-collaboration-color type="text" dir="ltr" maxlength="7" value="#4f6bed" autocomplete="off" spellcheck="false" disabled>')}
        ${field('collaboration-timezone', t('Time zone'), '<input id="collaboration-timezone" data-collaboration-timezone type="text" dir="ltr" maxlength="100" value="UTC" autocomplete="off" spellcheck="false" disabled>')}
      </div>
      <p class="xp-help">${t('Creates a real saved calendar for the selected mailbox using its existing writer and current ownership. Calendar edit and delete, defaults, descriptions, address books and task lists are in Collection settings below.')}</p>
      <div class="xp-collaboration__actions"><button class="xp-btn xp-btn--primary" type="button" data-collaboration-create disabled>${t('Create calendar')}</button></div>
    </section>
    <section class="xp-collaboration__card" aria-labelledby="collaboration-sharing-heading"><h2 id="collaboration-sharing-heading">${t('Current calendar sharing')}</h2>
      <div class="xp-collaboration__scroll" role="region" tabindex="0" aria-label="${t('Current same-account sharing')}"><table class="xp-table"><thead><tr>${[t('Owner'), t('Calendar'), t('Recipient'), t(msgctxt('account-collaboration-workspace', 'Permission'))].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-collaboration-shares><tr><td colspan="4">${empty}</td></tr></tbody></table></div>
      <div class="xp-collaboration__actions"><button class="xp-btn" type="button" disabled>${t('Share collection')}</button><button class="xp-btn" type="button" disabled>${t('Change permission')}</button><button class="xp-btn" type="button" disabled>${t('Revoke share')}</button></div>
      <p class="xp-help">${t('Only currently bound grants between mailboxes in this account appear here. Sharing changes require the existing xMail owner workflow; this portal does not change its permissions.')}</p>
    </section>
    <section class="xp-collaboration__card" aria-labelledby="collaboration-clients-heading"><h2 id="collaboration-clients-heading">${t('xMail and device setup')}</h2>
      <div class="xp-collaboration__actions">${mailHandoff('calendar', msgid('Open xMail calendars'))}${mailHandoff('contacts', msgid('Open xMail contacts'))}</div>
      <p class="xp-help">${t('Opens the selected mailbox in xMail in a new tab with a sign-in link that works once. The account session and password are not transferred; reading messages there still requires the mailbox password.')}</p>
      <p class="xp-help">${t('CalDAV/CardDAV service URLs, principal paths, direct DAV collection URLs, synchronization and device discovery have not been qualified. No DAV port or credential endpoint is assumed. iOS, macOS, Thunderbird and third-party Android/Outlook sync setup remain unavailable until a verified DAV provider supplies those settings.')}</p>
    </section>
  </div>`
}
