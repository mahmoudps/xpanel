import { teamClientTemplates } from './team-logs-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/** Role names and what each grants, in catalog terms (apps/api/src/team-access.ts teamRolesAllowTool). */
export const ACCOUNT_TEAM_ROLES = [
  ['administrator', msgid('Administrator'), msgid('Every account tool except calendars and contacts, service users, the owner preferences and sign-in security, API tokens and this team page.')],
  ['database', msgid('Database'), msgid('Database tools.')],
  ['email', msgid('Email'), msgid('Email tools.')],
  ['web', msgid('Web'), msgid('Files, domains and software tools.')],
] as const

/** /preferences/team body: team sign-in state, team list with password links, role editor. Owner only. */
export function renderAccountTeamWorkspace(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.lang)(message, values)), off = input.canManage ? '' : ' disabled'
  const container = input.canManage ? 'form' : 'div'
  const headers = [t('Username'), t('Roles'), t('Contact email'), t('State'), t('Sign-in'), t('Expires (UTC)'), t('Actions')]
  const field = (key: string, label: string, control: string, help = ''): string => `<div class="xp-field"><label for="acct-team-${key}">${label}</label>${control}${help ? `<p class="xp-help" id="acct-team-${key}-help">${help}</p>` : ''}</div>`
  return `<div class="xp-acct-tool xp-acct-team" data-acct-team-workspace data-account="${escapeHtml(input.accountId)}" data-team-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}
<style>.xp-acct-team fieldset{display:grid;gap:16px;margin:0;padding:16px;border:1px solid var(--xp-border);border-radius:8px;min-inline-size:0}.xp-acct-team legend{padding-inline:8px;font-weight:600}.xp-acct-team__role{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start}.xp-acct-team__role input{inline-size:24px;min-block-size:24px;margin:0}.xp-acct-team__role label{font-weight:600}.xp-acct-team__role p{grid-column:2}.xp-acct-team__login{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.xp-acct-team__login input{flex:1 1 160px}.xp-acct-team__loading{display:grid;gap:8px}.xp-acct-team__link{display:grid;gap:16px;padding:16px;border:1px solid var(--xp-border);border-radius:8px}.xp-acct-team__link h3{margin:0}.xp-acct-team__signin{display:grid;gap:8px;justify-items:start}.xp-acct-team label[for="acct-team-username"]{padding-inline:var(--xp-control-content-inset)}@media(min-width:601px){.xp-acct-team .xp-acct-tool__card{padding:var(--xp-space-card)}}</style>
  <section class="xp-acct-tool__card" aria-labelledby="acct-team-signin-heading">
    <h2 id="acct-team-signin-heading">${t('Team sign-in')}</h2>
    <p data-state-chip="unread" data-acct-team-signin-state>${t('Not read')}</p>
    <p class="xp-help" data-acct-team-signin>${t('The team sign-in state has not been read.')}</p>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="acct-team-list-heading">
    <h2 id="acct-team-list-heading">${t('Team members')}</h2>
    <p role="status" data-acct-team-status data-state="unread">${t('The team has not been read.')}</p>
    <div class="xp-acct-team__loading" data-acct-team-loading aria-busy="true" aria-label="${t('Loading team members')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line"></span></div>
    <dl class="xp-acct-tool__facts"><div><dt>${t('Members holding a role')}</dt><dd data-acct-team-usage><bdi dir="ltr">-</bdi></dd></div></dl>
    <div class="xp-acct-tool__table" role="region" tabindex="0" aria-label="${t('Team members')}"><table><caption class="xp-sr-only">${t('Team members and their roles')}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-acct-team-rows><tr><td colspan="7">${t('Not read')}</td></tr></tbody></table></div>
    <div data-acct-team-empty hidden><h3>${t('No team members yet')}</h3><p>${t('Add one below to record who works on this account and with which roles.')}</p></div>
    <p class="xp-help">${t('Up to 7 members can hold a role. Members without a role are not limited and can sign in but reach no account tools. A suspended member still counts toward the limit.')}</p>
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-acct-team-refresh${off}>${t('Refresh')}</button></div>
    <p role="status" data-acct-team-list-status hidden></p>
    <div class="xp-acct-team__link" data-acct-team-link hidden>
      <h3 data-acct-team-link-heading></h3>
      <p class="xp-help">${t('Send this link to the member privately. It works once and is shown only now; create a new link if it is lost. You never see the password they choose.')}</p>
      <div class="xp-field"><label for="acct-team-link-url">${t('Password link')}</label><input id="acct-team-link-url" class="xp-input" dir="ltr" readonly autocomplete="off" spellcheck="false" data-acct-team-link-url></div>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Valid until (UTC)')}</dt><dd data-acct-team-link-expires><bdi dir="ltr">-</bdi></dd></div></dl>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-acct-team-link-copy>${t('Copy link')}</button><button type="button" class="xp-btn" data-acct-team-link-done>${t('Done')}</button></div>
      <p role="status" data-acct-team-link-status hidden></p>
    </div>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="acct-team-editor-heading">
    <h2 id="acct-team-editor-heading" data-acct-team-editor-heading>${t('Add team member')}</h2>
    <${container} class="xp-acct-tool" data-acct-team-form${input.canManage ? ' novalidate' : ''}>
      <div class="xp-acct-tool__fields">
        ${field('username', t('Username'), `<div class="xp-acct-team__login"><input id="acct-team-username" class="xp-input" dir="ltr" maxlength="32" autocomplete="off" spellcheck="false" data-acct-team-input="username" aria-describedby="acct-team-username-help"${off}><bdi dir="ltr" data-acct-team-domain></bdi></div>`, t('Lowercase letters, digits, dots, hyphens and underscores. It cannot be changed later.'))}
        ${field('contact', t('Contact email'), `<input id="acct-team-contact" class="xp-input" type="email" dir="ltr" maxlength="254" autocomplete="off" data-acct-team-input="contactEmail"${off}>`)}
      </div>
      <fieldset${off}><legend>${t('Roles')}</legend>${ACCOUNT_TEAM_ROLES.map(([key, label, help]) => `<div class="xp-acct-team__role"><input type="checkbox" id="acct-team-role-${key}" value="${key}" data-acct-team-role aria-describedby="acct-team-role-${key}-help"${off}><label for="acct-team-role-${key}">${t(label)}</label><p class="xp-help" id="acct-team-role-${key}-help">${t(help)}</p></div>`).join('')}</fieldset>
      <div class="xp-acct-tool__fields">
        ${field('notes', t('Notes'), `<input id="acct-team-notes" class="xp-input" maxlength="100" autocomplete="off" dir="auto" data-acct-team-input="notes"${off}>`, t('Up to 100 characters.'))}
        ${field('expires', t('Expires (UTC)'), `<input id="acct-team-expires" class="xp-input" type="datetime-local" dir="ltr" data-acct-team-input="expiresAt" aria-describedby="acct-team-expires-help"${off}>`, t('Empty never expires.'))}
        ${field('reason', t('Expiry reason'), `<input id="acct-team-reason" class="xp-input" maxlength="100" autocomplete="off" dir="auto" data-acct-team-input="expiryReason"${off}>`)}
      </div>
      <div class="xp-acct-tool__actions"><button type="${input.canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-acct-team-save${off}>${t('Add team member')}</button><button type="button" class="xp-btn" data-acct-team-cancel hidden${off}>${t('Cancel editing')}</button></div>
      <p role="status" data-acct-team-save-status hidden></p>
    </${container}>
  </section>
${teamClientTemplates()}</div>`
}
