import { translator, type Locale, type Translate } from '../i18n.ts'
import { escapeHtml as esc } from '../tokens.ts'
import { classicSecClientTemplates } from './sec-client-templates.ts'

/**
 * Classic markup of the identity workspaces painted by the core identity client (identity-client.ts): Change Root
 * Password and the administrator group on the SSH page; security questions, the verified-address policy, identity
 * providers and linked identities beside the two-factor card. Styles are scoped to these cards.
 */
const STYLE = `<style>.xp-identity{display:flex;flex-direction:column;gap:24px;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;background:var(--xp-bg-surface);min-inline-size:0}.xp-identity h2{margin:0;font-size:18px;line-height:28px}.xp-identity p{margin:0;overflow-wrap:anywhere}.xp-identity__fields,.xp-identity__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px;margin:0}.xp-identity__field,.xp-identity__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0;text-align:start}.xp-identity__field label,.xp-identity__facts dt{font-weight:600}.xp-identity__facts dd{margin:0;overflow-wrap:anywhere}.xp-identity__field :is(input,select){inline-size:100%;box-sizing:border-box;min-block-size:44px;font:inherit;border:1px solid var(--xp-border-strong,#d0d5dd);border-radius:8px;background:var(--xp-bg-surface);color:inherit;padding:10px 12px}html[dir="rtl"] .xp-identity__field input[dir=ltr]{text-align:end}.xp-identity__check{display:flex;gap:8px;align-items:flex-start;min-block-size:44px}.xp-identity__check input{flex:none;inline-size:20px;block-size:20px;margin:3px 0 0}.xp-identity__actions,.xp-sec__actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.xp-identity__scroll{overflow-x:auto;max-inline-size:100%;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px}.xp-identity__scroll table{inline-size:100%;border-collapse:collapse}.xp-identity__scroll :is(th,td){padding:12px 16px;text-align:start;vertical-align:top;overflow-wrap:anywhere}.xp-identity__scroll tbody td{border-block-start:1px solid var(--xp-border,#e2e6ec)}.xp-identity :disabled{cursor:not-allowed;opacity:.75}@media(min-width:601px){.xp-identity{padding:24px}}.xp-identity__rows{container-type:inline-size}.xp-identity__rows table th,.xp-identity__rows table td:last-child:not(:first-child){overflow-wrap:normal;white-space:nowrap}@container(max-width:600px){.xp-identity__rows thead{display:block;block-size:0;overflow:hidden}.xp-identity__rows table,.xp-identity__rows tbody{display:block}.xp-identity__rows tbody tr{display:grid;grid-template-columns:minmax(0,1fr) fit-content(40%);gap:8px 16px;padding:12px 16px}.xp-identity__rows tbody tr+tr{border-block-start:1px solid var(--xp-border,#e2e6ec)}.xp-identity__rows tbody td{display:block;grid-column:1;height:auto;padding:0;border:0}.xp-identity__rows tbody td:last-child:not(:first-child){grid-column:2;grid-row:1}}</style>`

interface Ui { readonly t: Translate; readonly read: boolean; readonly manage: boolean }
const control = (id: string, key: string, type = 'text', extra = ''): string => `<input id="${esc(id)}" type="${esc(type)}" data-sec-input="${esc(key)}"${extra} disabled>`
const password = (id: string, key: string, autocomplete: string): string => control(id, key, 'password', ` dir="ltr" maxlength="1024" autocomplete="${autocomplete}" spellcheck="false"`)
const field = (ui: Ui, id: string, label: string, body: string, help?: string): string => `<div class="xp-identity__field"><label for="${esc(id)}">${esc(ui.t(label))}</label>${body}${help ? `<p class="xp-help">${esc(ui.t(help))}</p>` : ''}</div>`
const fields = (body: string): string => `<div class="xp-identity__fields">${body}</div>`
const actions = (body: string): string => `<div class="xp-identity__actions">${body}</div>`
const button = (ui: Ui, label: string, action: string, primary = false, enabled = false): string =>
  `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" data-sec-action="${esc(action)}"${enabled ? '' : ' disabled'}>${esc(ui.t(label))}</button>`
const help = (ui: Ui, text: string): string => `<p class="xp-help">${esc(ui.t(text))}</p>`
const check = (ui: Ui, label: string, key: string): string => `<label class="xp-identity__check"><input type="checkbox" data-sec-input="${esc(key)}" disabled><span>${esc(ui.t(label))}</span></label>`
const facts = (ui: Ui, items: readonly (readonly [string, string])[]): string =>
  `<dl class="xp-identity__facts">${items.map(([key, label]) => `<div><dt>${esc(ui.t(label))}</dt><dd><bdi data-sec-field="${esc(key)}">${esc(ui.t(msgid('Not read')))}</bdi></dd></div>`).join('')}</dl>`
const select = (ui: Ui, id: string, key: string, placeholder: string): string => `<select id="${esc(id)}" data-sec-input="${esc(key)}" disabled><option value="">${esc(ui.t(placeholder))}</option></select>`
const table = (ui: Ui, title: string, columns: readonly string[], rows: string): string =>
  `<div class="xp-identity__scroll${columns.length > 2 ? ' xp-identity__rows' : ''}" role="region" tabindex="0" aria-label="${esc(ui.t(title))}"><table class="xp-table"><caption class="xp-sr-only">${esc(ui.t(title))}</caption><thead><tr>${columns.map(label => `<th scope="col">${esc(ui.t(label))}</th>`).join('')}</tr></thead><tbody data-sec-rows="${esc(rows)}"><tr><td colspan="${columns.length}">${esc(ui.t(msgid('Not read')))}</td></tr></tbody></table></div>`
const workspace = (ui: Ui, page: string, title: string, body: string): string =>
  `<section class="xp-identity" data-sec-workspace data-sec-page="${esc(page)}" data-sec-can-read="${ui.read}" data-sec-can-manage="${ui.read && ui.manage}" aria-labelledby="xp-identity-${esc(page)}"><h2 id="xp-identity-${esc(page)}">${esc(ui.t(title))}</h2>${body}${actions(button(ui, msgid('Refresh'), 'refresh', false, ui.read))}<p class="xp-help" role="status" data-state="${ui.read ? 'unread' : 'unavailable'}" data-sec-status>${esc(ui.t(ui.read ? msgid('Nothing has been read yet.') : msgid('This page requires an authorized administrator. Nothing was read or changed.')))}</p><p role="status" data-sec-result hidden></p>${classicSecClientTemplates()}</section>`
const QUESTION_SUGGESTIONS = [msgid('What was the name of your first pet?'), msgid('In which city were you born?'), msgid('What was the name of your first school?'),
  msgid('What was the make of your first car?'), msgid('What is the name of the street you grew up on?'), msgid('What is the first name of your oldest friend?')]
const suggestions = (ui: Ui, id: string): string => `<datalist id="${esc(id)}">${QUESTION_SUGGESTIONS.map(item => `<option value="${esc(ui.t(item))}"></option>`).join('')}</datalist>`

/** WHM Change Root Password and Manage Wheel Group Users on the SSH page. */
export function renderClassicRootIdentityCards(locale: Locale, canRead: boolean): string {
  const ui: Ui = { t: translator(locale), read: canRead, manage: canRead }
  return STYLE + workspace(ui, 'root-password', msgid('Change root password'),
    help(ui, msgid('Sets the system root password used for SSH (when password sign-in is allowed) and su. Your xWHM sign-in password is changed under Password and authenticator.'))
    + facts(ui, [['host', msgid('Host agent')], ['second-factor', msgid('Second factor')], ['strength', msgid('Password strength')]])
    + fields(field(ui, 'xp-root-password-new', msgid('New root password'), password('xp-root-password-new', 'password', 'new-password'), msgid('The server password strength rule applies.'))
      + field(ui, 'xp-root-password-confirm', msgid('Confirm new root password'), password('xp-root-password-confirm', 'confirmation', 'new-password'))
      + field(ui, 'xp-root-password-current', msgid('Your current xWHM password'), password('xp-root-password-current', 'current-password', 'current-password'))
      + `<div class="xp-identity__field" data-identity-totp hidden><label for="xp-root-password-totp">${esc(ui.t(msgid('Authenticator code')))}</label>${control('xp-root-password-totp', 'totp', 'text', ' dir="ltr" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"')}</div>`)
    + actions(button(ui, msgid('Generate password'), 'generate') + button(ui, msgid('Change root password'), 'change', true)))
    + workspace(ui, 'admin-group', msgid('Administrator group'),
      help(ui, msgid('Members of wheel (AlmaLinux, Rocky Linux) or sudo (Debian, Ubuntu) can become root. Only hosting accounts are added or removed here; other members stay as they are.'))
      + facts(ui, [['group', msgid('Group')], ['observed-at', msgid('Observed at (UTC)')]])
      + table(ui, msgid('Group members'), [msgid('User'), msgid('Kind'), msgid('Action')], 'members')
      + fields(field(ui, 'xp-admin-group-account', msgid('Account'), select(ui, 'xp-admin-group-account', 'account', msgid('Select an account'))))
      + actions(button(ui, msgid('Add to group'), 'add', true)))
}

export interface ClassicIdentityProps { readonly locale: Locale; readonly principalKind: string; readonly surface: 'xwhm' | 'xpanel' | 'xmail'; readonly readOnly?: boolean; readonly identityToolsAvailable?: boolean; readonly securityPolicyDisabled?: boolean }

/** Security questions, verified addresses and external identities; root on xWHM also gets the server policy and providers. */
export function renderClassicIdentityCards(props: ClassicIdentityProps): string {
  if (props.surface === 'xmail') return ''
  const ui: Ui = { t: translator(props.locale), read: props.identityToolsAvailable === true, manage: props.readOnly !== true }
  if (props.readOnly) return `<section class="xp-card xp-account-security"><h2>${esc(ui.t(msgid('Security questions and external sign-in')))}</h2>${help(ui, msgid('These sign-in factors cannot be changed from a handed-off session.'))}</section>`
  const root = props.principalKind === 'root' && props.surface === 'xwhm'
  // One row per pair: a shared grid would split a question from its answer.
  const questions = [1, 2, 3].map(n => fields(field(ui, `xp-identity-question-${n}`, msgid('Question'), control(`xp-identity-question-${n}`, `question-${n}`, 'text', ' dir="auto" maxlength="200" list="xp-identity-question-suggestions"'))
    + field(ui, `xp-identity-answer-${n}`, msgid('Answer'), control(`xp-identity-answer-${n}`, `answer-${n}`, 'password', ' dir="auto" maxlength="200" autocomplete="off"')))).join('')
  const policy = root ? workspace(ui, 'security-policy', msgid('Verified-address sign-in'),
    help(ui, msgid('When this is on, a user who set security questions and signs in from an address they have not verified must answer them. Users with two-factor authentication are not asked.'))
    + facts(ui, [['policy-state', msgid('Policy')], ['updated', msgid('Last saved (UTC)')]])
    + check(ui, msgid('Ask security questions from unverified addresses'), 'verified-ip') + actions(button(ui, msgid('Save policy'), 'save', true))
    + fields(field(ui, 'xp-identity-reset-user', msgid('User to reset'), control('xp-identity-reset-user', 'reset-username', 'text', ' dir="ltr" maxlength="320" spellcheck="false"'), msgid('Removes the saved questions of a user who lost the answers, so they can sign in and set new ones. Answers are never shown.')))
    + actions(button(ui, msgid('Reset questions'), 'reset-user'))) : ''
  const own = workspace(ui, 'security-questions', msgid('Security questions'),
    help(ui, msgid('Choose a suggested question or write your own, and set two or three only you can answer. Answers are stored as hashes and compared without regard to case or extra spaces.'))
    + facts(ui, [['policy', msgid('Verified-address sign-in')], ['count', msgid('Your questions')], ['client', msgid('This address')]])
    + table(ui, msgid('Your security questions'), [msgid('Number'), msgid('Question')], 'questions')
    + suggestions(ui, 'xp-identity-question-suggestions') + questions + fields(field(ui, 'xp-identity-questions-password', msgid('Current password'), password('xp-identity-questions-password', 'current-password', 'current-password')))
    + actions(button(ui, msgid('Save questions'), 'save', true) + button(ui, msgid('Remove questions'), 'clear'))
    + table(ui, msgid('Verified addresses'), [msgid('Address'), msgid('Source'), msgid('Added (UTC)'), msgid('Action')], 'addresses')
    + fields(field(ui, 'xp-identity-address', msgid('Address'), control('xp-identity-address', 'address', 'text', ' dir="ltr" maxlength="45" spellcheck="false"'), msgid('An IPv4 address may end in * to cover its last part.')))
    + actions(button(ui, msgid('Add address'), 'add-address') + button(ui, msgid('Add this address'), 'add-current')))
  const providers = root ? workspace(ui, 'external-providers', msgid('Identity providers'),
    help(ui, msgid('OpenID Connect providers for sign-in to xPanel and xWHM. A provider is saved only after its discovery document passes; register the redirect addresses below with it. The client secret is never shown again.'))
    + `<dl class="xp-identity__facts"><div><dt>${esc(ui.t(msgid('Redirect addresses')))}</dt><dd><bdi dir="ltr" style="white-space:pre-line" data-sec-field="redirect-uris">${esc(ui.t(msgid('Not read')))}</bdi></dd></div></dl>`
    + table(ui, msgid('Identity providers'), [msgid('Name'), msgid('Issuer'), msgid('Client ID'), msgid('Panels'), msgid('Action')], 'providers')
    + fields(field(ui, 'xp-identity-provider-id', msgid('Provider ID'), control('xp-identity-provider-id', 'provider-id', 'text', ' dir="ltr" maxlength="32" spellcheck="false"'))
      + field(ui, 'xp-identity-provider-label', msgid('Button name'), control('xp-identity-provider-label', 'provider-label', 'text', ' dir="auto" maxlength="64"'))
      + field(ui, 'xp-identity-provider-issuer', msgid('Issuer'), control('xp-identity-provider-issuer', 'provider-issuer', 'url', ' dir="ltr" maxlength="256" spellcheck="false"'))
      + field(ui, 'xp-identity-provider-client-id', msgid('Client ID'), control('xp-identity-provider-client-id', 'provider-client-id', 'text', ' dir="ltr" maxlength="512" spellcheck="false"'))
      + field(ui, 'xp-identity-provider-client-secret', msgid('Client secret'), control('xp-identity-provider-client-secret', 'provider-client-secret', 'password', ' dir="ltr" maxlength="512" autocomplete="off"'), msgid('Leave empty to keep the saved secret.')))
    + check(ui, msgid('Offer on the xPanel sign-in page'), 'provider-xpanel') + check(ui, msgid('Offer on the xWHM sign-in page'), 'provider-xwhm')
    + actions(button(ui, msgid('Save provider'), 'save-provider', true) + button(ui, msgid('New provider'), 'new-provider'))
    + table(ui, msgid('Linked identities'), [msgid('User'), msgid('Provider'), msgid('Identity'), msgid('Linked (UTC)'), msgid('Last used (UTC)'), msgid('Action')], 'links')) : ''
  const linked = workspace(ui, 'external-identities', msgid('Linked external identities'),
    help(ui, msgid('Sign in with an identity provider the administrator configured. Linking asks for your password first; your password and two-factor sign-in keep working.'))
    + facts(ui, [['availability', msgid('External sign-in')]])
    + table(ui, msgid('Linked external identities'), [msgid('Provider'), msgid('Identity'), msgid('Linked (UTC)'), msgid('Last used (UTC)'), msgid('Action')], 'identities')
    + fields(field(ui, 'xp-identity-link-provider', msgid('Provider'), select(ui, 'xp-identity-link-provider', 'provider', msgid('Select a provider')))
      + field(ui, 'xp-identity-link-password', msgid('Current password'), password('xp-identity-link-password', 'current-password', 'current-password')))
    + actions(button(ui, msgid('Link identity'), 'link', true)))
  return STYLE + policy + (props.securityPolicyDisabled ? '' : own) + providers + linked
}
