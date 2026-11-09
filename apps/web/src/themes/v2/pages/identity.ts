import type { Translate } from '../../../i18n.ts'
import { card } from '../components/card.ts'
import { v2SecClientTemplates } from '../components/sec-client-templates.ts'
import { escapeHtml as esc, hookAttrs, type HookAttributes } from '../html.ts'
import { v2Messages } from '../messages.ts'

/**
 * V2 markup of the identity workspaces painted by the core identity client: Change Root Password and the
 * administrator group on the SSH page, and security questions, the verified-address policy, identity providers
 * and linked identities next to the two-factor card. Each layout keeps the classes of its owning page family.
 */
type Family = 'v2-observation' | 'v2-panel-settings'
/** On a phone a row stays two columns: its name and details, opposite its action. */
export const IDENTITY_ROWS_CSS = `.v2-identity-rows table th,.v2-identity-rows table td:last-child:not(:first-child){overflow-wrap:normal;white-space:nowrap}
@media(max-width:600px){.v2-identity-rows thead{display:block;block-size:0;overflow:hidden}.v2-identity-rows table,.v2-identity-rows tbody{display:block}.v2-identity-rows tbody tr{display:grid;grid-template-columns:minmax(0,1fr) fit-content(40%);gap:8px 16px;padding:12px 16px}.v2-identity-rows tbody tr+tr{border-block-start:1px solid var(--line)}.v2-identity-rows table tbody td{display:block;grid-column:1;padding:0;border:0}.v2-identity-rows table tbody td:last-child:not(:first-child){grid-column:2;grid-row:1}}`
interface Ui { readonly t: Translate; readonly p: Family; readonly read: boolean; readonly manage: boolean }

const control = (id: string, key: string, type = 'text', extra = ''): string => `<input id="${esc(id)}" type="${esc(type)}" data-sec-input="${esc(key)}"${extra} disabled>`
const field = (ui: Ui, id: string, label: string, body: string, help?: string): string => `<div class="v2-field"><label for="${esc(id)}">${esc(ui.t(label))}</label>${body}${help ? `<p class="v2-muted">${esc(ui.t(help))}</p>` : ''}</div>`
const fields = (ui: Ui, body: string): string => `<div class="${ui.p}__fields">${body}</div>`
const actions = (ui: Ui, body: string): string => `<div class="${ui.p}__actions">${body}</div>`
const button = (ui: Ui, label: string, action: string, primary = false, enabled = false): string =>
  `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}" data-sec-action="${esc(action)}"${enabled ? '' : ' disabled'}>${esc(ui.t(label))}</button>`
const help = (ui: Ui, text: string, hooks?: HookAttributes): string => `<p class="v2-muted"${hookAttrs(hooks)}>${esc(ui.t(text))}</p>`
const check = (ui: Ui, label: string, key: string): string => `<label class="${ui.p}__check"><input type="checkbox" data-sec-input="${esc(key)}" disabled><span>${esc(ui.t(label))}</span></label>`
const facts = (ui: Ui, items: readonly (readonly [string, string])[]): string =>
  `<dl class="${ui.p}__facts">${items.map(([key, label]) => `<div><dt>${esc(ui.t(label))}</dt><dd><bdi data-sec-field="${esc(key)}">${esc(ui.t(msgid('Not read')))}</bdi></dd></div>`).join('')}</dl>`
const select = (ui: Ui, id: string, key: string, placeholder: string): string => `<span class="v2-select"><select id="${esc(id)}" data-sec-input="${esc(key)}" disabled><option value="">${esc(ui.t(placeholder))}</option></select></span>`
const table = (ui: Ui, title: string, columns: readonly string[], rows: string): string =>
  `<div class="${ui.p === 'v2-observation' ? 'v2-observation__scroll' : 'v2-panel-settings__table'}${columns.length > 2 ? ' v2-identity-rows' : ''}" role="region" tabindex="0" aria-label="${esc(ui.t(title))}"><table><caption class="v2-sr">${esc(ui.t(title))}</caption><thead><tr>${columns.map(label => `<th scope="col">${esc(ui.t(label))}</th>`).join('')}</tr></thead><tbody data-sec-rows="${esc(rows)}"><tr><td colspan="${columns.length}">${esc(ui.t(msgid('Not read')))}</td></tr></tbody></table></div>`
const workspace = (ui: Ui, page: string, title: string, body: string): string => card({
  title: ui.t(title), titleId: `v2-identity-${page}`,
  bodyHtml: body + actions(ui, button(ui, msgid('Refresh'), 'refresh', false, ui.read))
    + `<p role="status" data-state="${ui.read ? 'unread' : 'unavailable'}" data-sec-status>${esc(ui.t(ui.read ? msgid('Nothing has been read yet.') : msgid('This page requires an authorized administrator. Nothing was read or changed.')))}</p><p role="status" data-sec-result hidden></p>` + v2SecClientTemplates(ui.p === 'v2-panel-settings' ? 'identity-panel' : 'identity-whm'),
  hooks: { 'data-sec-workspace': true, 'data-sec-page': page, 'data-sec-can-read': String(ui.read), 'data-sec-can-manage': String(ui.read && ui.manage) },
})
const password = (id: string, key: string, autocomplete: string): string => control(id, key, 'password', ` dir="ltr" maxlength="1024" autocomplete="${autocomplete}" spellcheck="false"`)
const QUESTION_SUGGESTIONS = [msgid('What was the name of your first pet?'), msgid('In which city were you born?'), msgid('What was the name of your first school?'),
  msgid('What was the make of your first car?'), msgid('What is the name of the street you grew up on?'), msgid('What is the first name of your oldest friend?')]
const suggestions = (ui: Ui, id: string): string => `<datalist id="${esc(id)}">${QUESTION_SUGGESTIONS.map(item => `<option value="${esc(ui.t(item))}"></option>`).join('')}</datalist>`

/** WHM Change Root Password and Manage Wheel Group Users on the SSH page. */
export function renderV2RootIdentityCards(t: Translate, canRead: boolean, canManage: boolean): string {
  const ui: Ui = { t, p: 'v2-observation', read: canRead, manage: canManage }
  return workspace(ui, 'root-password', msgid('Change root password'),
    help(ui, msgid('Sets the system root password used for SSH (when password sign-in is allowed) and su. Your xWHM sign-in password is changed under Password and authenticator.'))
    + facts(ui, [['host', msgid('Host agent')], ['second-factor', msgid('Second factor')], ['strength', msgid('Password strength')]])
    + fields(ui, field(ui, 'v2-root-password-new', msgid('New root password'), password('v2-root-password-new', 'password', 'new-password'), msgid('The server password strength rule applies.'))
      + field(ui, 'v2-root-password-confirm', msgid('Confirm new root password'), password('v2-root-password-confirm', 'confirmation', 'new-password'))
      + field(ui, 'v2-root-password-current', msgid('Your current xWHM password'), password('v2-root-password-current', 'current-password', 'current-password'))
      + `<div class="v2-field" data-identity-totp hidden><label for="v2-root-password-totp">${esc(t(msgid('Authenticator code')))}</label>${control('v2-root-password-totp', 'totp', 'text', ' dir="ltr" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"')}</div>`)
    + actions(ui, button(ui, msgid('Generate password'), 'generate') + button(ui, msgid('Change root password'), 'change', true)))
    + workspace(ui, 'admin-group', msgid('Administrator group'),
      help(ui, msgid('Members of wheel (AlmaLinux, Rocky Linux) or sudo (Debian, Ubuntu) can become root. Only hosting accounts are added or removed here; other members stay as they are.'))
      + facts(ui, [['group', msgid('Group')], ['observed-at', msgid('Observed at (UTC)')]])
      + table(ui, msgid('Group members'), [msgid('User'), msgid('Kind'), msgid('Action')], 'members')
      + fields(ui, field(ui, 'v2-admin-group-account', msgid('Account'), select(ui, 'v2-admin-group-account', 'account', msgid('Select an account'))))
      + actions(ui, button(ui, msgid('Add to group'), 'add', true)))
}

export interface IdentityCardsProps {
  readonly locale: string
  readonly principalKind: string
  readonly surface: 'xwhm' | 'xpanel' | 'xmail'
  readonly readOnly?: boolean
  readonly identityToolsAvailable?: boolean
  readonly securityPolicyDisabled?: boolean
}

/** Security questions, verified addresses and external identities beside the two-factor card; root on xWHM also gets the server policy and providers. */
export function renderV2IdentityCards(props: IdentityCardsProps): string {
  if (props.surface === 'xmail') return ''
  const t = v2Messages.translator(props.locale as Parameters<typeof v2Messages.translator>[0])
  // Unqualified identity tools still read the saved questions, addresses and policy, inside a read-only frame where the gate refuses writes.
  const open = props.identityToolsAvailable === true
  const ui: Ui = { t, p: props.surface === 'xpanel' ? 'v2-panel-settings' : 'v2-observation', read: true, manage: open && props.readOnly !== true }
  if (props.readOnly) return card({ title: t(msgid('Security questions and external sign-in')), titleId: 'v2-identity-readonly', bodyHtml: help(ui, msgid('These sign-in factors cannot be changed from a handed-off session.')) })
  const root = props.principalKind === 'root' && props.surface === 'xwhm'
  // One row per pair: a shared grid would split a question from its answer.
  const questions = [1, 2, 3].map(n => fields(ui, field(ui, `v2-identity-question-${n}`, msgid('Question'), control(`v2-identity-question-${n}`, `question-${n}`, 'text', ' dir="auto" maxlength="200" list="v2-identity-question-suggestions"'))
    + field(ui, `v2-identity-answer-${n}`, msgid('Answer'), control(`v2-identity-answer-${n}`, `answer-${n}`, 'password', ' dir="auto" maxlength="200" autocomplete="off"')))).join('')
  const policy = root ? workspace(ui, 'security-policy', msgid('Verified-address sign-in'),
    help(ui, msgid('When this is on, a user who set security questions and signs in from an address they have not verified must answer them. Users with two-factor authentication are not asked.'))
    + facts(ui, [['policy-state', msgid('Policy')], ['updated', msgid('Last saved (UTC)')]])
    + check(ui, msgid('Ask security questions from unverified addresses'), 'verified-ip') + actions(ui, button(ui, msgid('Save policy'), 'save', true))
    + fields(ui, field(ui, 'v2-identity-reset-user', msgid('User to reset'), control('v2-identity-reset-user', 'reset-username', 'text', ' dir="ltr" maxlength="320" spellcheck="false"'), msgid('Removes the saved questions of a user who lost the answers, so they can sign in and set new ones. Answers are never shown.')))
    + actions(ui, button(ui, msgid('Reset questions'), 'reset-user'))) : ''
  const own = workspace(ui, 'security-questions', msgid('Security questions'),
    help(ui, msgid('Choose a suggested question or write your own, and set two or three only you can answer. Answers are stored as hashes and compared without regard to case or extra spaces.'))
    + facts(ui, [['policy', msgid('Verified-address sign-in')], ['count', msgid('Your questions')], ['client', msgid('This address')]])
    + table(ui, msgid('Your security questions'), [msgid('Number'), msgid('Question')], 'questions')
    + suggestions(ui, 'v2-identity-question-suggestions') + questions + fields(ui, field(ui, 'v2-identity-questions-password', msgid('Current password'), password('v2-identity-questions-password', 'current-password', 'current-password')))
    + actions(ui, button(ui, msgid('Save questions'), 'save', true) + button(ui, msgid('Remove questions'), 'clear'))
    + table(ui, msgid('Verified addresses'), [msgid('Address'), msgid('Source'), msgid('Added (UTC)'), msgid('Action')], 'addresses')
    + fields(ui, field(ui, 'v2-identity-address', msgid('Address'), control('v2-identity-address', 'address', 'text', ' dir="ltr" maxlength="45" spellcheck="false"'), msgid('An IPv4 address may end in * to cover its last part.')))
    + actions(ui, button(ui, msgid('Add address'), 'add-address') + button(ui, msgid('Add this address'), 'add-current')))
  const providers = root ? workspace(ui, 'external-providers', msgid('Identity providers'),
    help(ui, msgid('OpenID Connect providers for sign-in to xPanel and xWHM. A provider is saved only after its discovery document passes; register the redirect addresses below with it. The client secret is never shown again.'))
    + `<dl class="${ui.p}__facts"><div><dt>${esc(t(msgid('Redirect addresses')))}</dt><dd><bdi dir="ltr" style="white-space:pre-line" data-sec-field="redirect-uris">${esc(t(msgid('Not read')))}</bdi></dd></div></dl>`
    + table(ui, msgid('Identity providers'), [msgid('Name'), msgid('Issuer'), msgid('Client ID'), msgid('Panels'), msgid('Action')], 'providers')
    + fields(ui, field(ui, 'v2-identity-provider-id', msgid('Provider ID'), control('v2-identity-provider-id', 'provider-id', 'text', ' dir="ltr" maxlength="32" spellcheck="false"'))
      + field(ui, 'v2-identity-provider-label', msgid('Button name'), control('v2-identity-provider-label', 'provider-label', 'text', ' dir="auto" maxlength="64"'))
      + field(ui, 'v2-identity-provider-issuer', msgid('Issuer'), control('v2-identity-provider-issuer', 'provider-issuer', 'url', ' dir="ltr" maxlength="256" spellcheck="false"'))
      + field(ui, 'v2-identity-provider-client-id', msgid('Client ID'), control('v2-identity-provider-client-id', 'provider-client-id', 'text', ' dir="ltr" maxlength="512" spellcheck="false"'))
      + field(ui, 'v2-identity-provider-client-secret', msgid('Client secret'), control('v2-identity-provider-client-secret', 'provider-client-secret', 'password', ' dir="ltr" maxlength="512" autocomplete="off"'), msgid('Leave empty to keep the saved secret.')))
    + check(ui, msgid('Offer on the xPanel sign-in page'), 'provider-xpanel') + check(ui, msgid('Offer on the xWHM sign-in page'), 'provider-xwhm')
    + actions(ui, button(ui, msgid('Save provider'), 'save-provider', true) + button(ui, msgid('New provider'), 'new-provider'))
    + table(ui, msgid('Linked identities'), [msgid('User'), msgid('Provider'), msgid('Identity'), msgid('Linked (UTC)'), msgid('Last used (UTC)'), msgid('Action')], 'links')) : ''
  const linked = workspace(ui, 'external-identities', msgid('Linked external identities'),
    help(ui, msgid('Sign in with an identity provider the administrator configured. Linking asks for your password first; your password and two-factor sign-in keep working.'))
    + facts(ui, [['availability', msgid('External sign-in')]])
    + table(ui, msgid('Linked external identities'), [msgid('Provider'), msgid('Identity'), msgid('Linked (UTC)'), msgid('Last used (UTC)'), msgid('Action')], 'identities')
    + fields(ui, field(ui, 'v2-identity-link-provider', msgid('Provider'), select(ui, 'v2-identity-link-provider', 'provider', msgid('Select a provider')))
      + field(ui, 'v2-identity-link-password', msgid('Current password'), password('v2-identity-link-password', 'current-password', 'current-password')))
    + actions(ui, button(ui, msgid('Link identity'), 'link', true)))
  const cards = policy + (props.securityPolicyDisabled ? '' : own) + providers + linked
  return open ? cards : '<div data-readonly="true" style="display:contents">' + cards + '</div>'
}
