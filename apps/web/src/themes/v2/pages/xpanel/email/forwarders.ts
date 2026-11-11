import { accountRoutingClientTemplates } from '../email-tools/routing-client-templates.ts'
import { mailCardsFor } from '../../../../../mail-cards.ts'
import { renderV2MailCards } from '../../mail-cards.ts'
import { localeDirection, type Translate } from '../../../../../i18n.ts'
import { card } from '../../../components/card.ts'
import { dataTable, type DataTableRow } from '../../../components/data-table.ts'
import { layoutRoot } from '../../../layouts/common.ts'
import { escapeHtml } from '../../../html.ts'
import { icon } from '../../../icons.ts'
import { phoneLabels } from '../settings/common.ts'

export interface EmailForwarderRow {
  readonly id: string
  readonly source: string
  readonly destinations: readonly string[]
  readonly createdAtLabel?: string
}

/** Core supplies only the current account's domains, mailboxes and admitted mutation capability. */
export interface EmailForwardersPageProps {
  readonly domainsObserved?: boolean
  readonly mailboxesObserved?: boolean
  readonly domains: readonly { readonly name: string }[]
  readonly mailboxes: readonly string[]
  readonly canManage: boolean
  readonly readOnly?: boolean
  readonly forwarders?: readonly EmailForwarderRow[]
}

const technical = (text: string): string => `<bdi class="v2-mono" dir="ltr">${escapeHtml(text)}</bdi>`
const field = (id: string, label: string, control: string, help?: string, hooks = ''): string =>
  `<div class="v2-field"${hooks}><label for="${id}">${escapeHtml(label)}</label>${control}${help ? `<p id="${id}-help" class="v2-field__help">${escapeHtml(help)}</p>` : ''}</div>`
const textInput = (id: string, name: string, attributes = ''): string => `<input id="${id}" name="${name}"${attributes}>`
const choice = (name: string, value: string, label: string, checked = false, hint?: string): string =>
  `<label class="v2-email-routing-choice"><input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}><span>${escapeHtml(label)}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</span></label>`
const submit = (label: string, hooks = ''): string => `<button type="submit" class="v2-btn v2-btn--primary"${hooks}>${escapeHtml(label)}</button>`

function routingTable(t: Translate, props: {
  id: string; title: string; headers: readonly string[]; rowHook: string; emptyHook: string; rows?: readonly DataTableRow[]; emptyText: string
}): string {
  const table = dataTable(t, {
    id: props.id, caption: props.title, columns: props.headers.map(label => ({ label })),
    rows: props.rows ?? [], state: 'ready', minWidth: 920,
    bodyHooks: { [`data-${props.rowHook}-rows`]: true },
  })
  // Rows come from a generic cell template in core, so the column names reach the phone rows as custom properties.
  return `<div class="v2-email-routing-table"${phoneLabels(props.headers)}>${table}<p class="v2-muted" data-${props.emptyHook}-empty${props.rows?.length ? ' hidden' : ''}>${escapeHtml(props.emptyText)}</p></div>`
}

function forwarderForm(t: Translate): string {
  const source = field('forwarder-source', t('Address'), textInput('forwarder-source', 'source', ' type="email" autocomplete="off" required maxlength="254" dir="ltr" aria-describedby="forwarder-source-help"'), t('The address must belong to one of your domains. A forwarder needs no mailbox.'))
  const modes = `<fieldset class="v2-email-routing-choices"><legend>${escapeHtml(t('What happens to the mail'))}</legend>${choice('forwarder-mode', 'forward', t('Forward to an address'), true)}${choice('forwarder-mode', 'reject', t('Reject it with an error to the sender'))}</fieldset>`
  const destinations = field('forwarder-destinations', t('Forward to'), textInput('forwarder-destinations', 'destinations', ' type="email" multiple autocomplete="off" required dir="ltr" aria-describedby="forwarder-destinations-help"'), t('Separate addresses with commas.'), ' data-forwarder-destination-field')
  const rejection = field('forwarder-reject', t('Error message to the sender'), textInput('forwarder-reject', 'rejectMessage', ' type="text" maxlength="200" autocomplete="off" dir="ltr" pattern="[ -~]{1,200}" aria-describedby="forwarder-reject-help"'), t('Up to 200 English letters, digits and punctuation. Senders receive it with a 550 error.'), ' data-forwarder-reject-field hidden')
  return `<form class="v2-form" data-forwarder-create><div class="v2-fields">${source}</div>${modes}<div class="v2-fields">${destinations}${rejection}</div><div class="v2-email-routing-actions">${submit(t('Add forwarder'))}</div></form>`
}

function forwarders(t: Translate, props: EmailForwardersPageProps): string {
  const rows = props.forwarders?.map(row => ({ cellsHtml: [technical(row.source), row.destinations.map(technical).join('<br>'), row.createdAtLabel ? technical(row.createdAtLabel) : escapeHtml(t('Not read')), escapeHtml(t('Not read')), props.canManage ? `<button type="button" class="v2-btn" data-forwarder-delete="${escapeHtml(row.id)}" data-forwarder-source="${escapeHtml(row.source)}">${escapeHtml(t('Delete forwarder'))}</button>` : escapeHtml(t('Read only'))] }))
  const table = routingTable(t, {
    id: 'v2-forwarders-table', title: t('Forwarders'), headers: [t('Address'), t('Forwards to'), t('Created'), t('Mail server'), t('Actions')],
    rowHook: 'forwarder', emptyHook: 'forwarder', ...(rows ? { rows } : {}), emptyText: props.forwarders === undefined ? t('Not read') : t('No forwarders.'),
  })
  const domains = props.domainsObserved === false ? escapeHtml(t('Not read')) : props.domains.length ? props.domains.map(domain => technical(domain.name)).join(', ') : escapeHtml(t('No domains read'))
  return card({ title: t('Forwarders'), titleId: 'v2-forwarders-title', bodyHtml: `<div class="v2-email-routing-workspace" data-forwarder-workspace data-forwarder-can-read="${props.canManage}" data-forwarder-manage="${props.canManage}">${accountRoutingClientTemplates()}<p>${escapeHtml(t('Mail to an address is copied to another address. Each row shows whether the mail server runs it.'))}</p><dl><dt>${escapeHtml(t('Source domains'))}</dt><dd>${domains}</dd></dl><div class="v2-email-routing-actions"><button type="button" class="v2-btn" data-forwarder-refresh${props.readOnly === true ? ' disabled' : ''}>${escapeHtml(t('Refresh'))}</button></div><p role="status" aria-live="polite" data-forwarder-status>${props.forwarders === undefined ? escapeHtml(t('Records have not been read.')) : ''}</p>${table}${props.canManage ? forwarderForm(t) : props.readOnly === true ? `<fieldset disabled>${forwarderForm(t)}</fieldset>` : ''}</div>` })
}

function autoresponderForm(t: Translate, props: EmailForwardersPageProps): string {
  const datalist = `<datalist id="autoresponder-mailboxes">${props.mailboxes.map(mailbox => `<option value="${escapeHtml(mailbox)}"></option>`).join('')}</datalist>`
  const address = field('autoresponder-address', t('Address'), textInput('autoresponder-address', 'address', ' type="email" required maxlength="254" autocomplete="off" dir="ltr" list="autoresponder-mailboxes" aria-describedby="autoresponder-address-help"') + datalist, t('A mailbox answers with its own autoresponder. Any other address of your domains answers without a mailbox, and its forwarders still deliver.'))
  const subject = field('autoresponder-subject', t('Subject'), textInput('autoresponder-subject', 'subject', ' type="text" required maxlength="256" autocomplete="off"'))
  const body = field('autoresponder-body', t('Message'), '<textarea id="autoresponder-body" name="body" required rows="4" maxlength="65536"></textarea>')
  const interval = field('autoresponder-interval', t('Reply to the same sender at most once every (hours)'), textInput('autoresponder-interval', 'interval', ' type="number" min="1" max="8760" step="1" value="24" required dir="ltr" inputmode="numeric"'))
  const starts = field('autoresponder-start', t('Starts (UTC)'), textInput('autoresponder-start', 'start', ' type="text" dir="ltr" pattern="\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}( UTC)?" placeholder="YYYY-MM-DD HH:mm" autocomplete="off" spellcheck="false"'))
  const ends = field('autoresponder-end', t('Ends (UTC)'), textInput('autoresponder-end', 'end', ' type="text" dir="ltr" pattern="\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}( UTC)?" placeholder="YYYY-MM-DD HH:mm" autocomplete="off" spellcheck="false"'))
  return `<form class="v2-form" data-autoresponder-form><h3 data-autoresponder-form-title>${escapeHtml(t('Add an autoresponder'))}</h3>${address}${subject}${body}<div class="v2-fields">${interval}${starts}${ends}</div><label class="v2-email-routing-choice"><input type="checkbox" name="noEnd" checked><span>${escapeHtml(t('No end date'))}</span></label><div class="v2-email-routing-actions">${submit(t('Add autoresponder'), ' data-autoresponder-submit')}<button type="button" class="v2-btn" data-autoresponder-cancel hidden>${escapeHtml(t('Cancel editing'))}</button></div></form>`
}

function autoresponders(t: Translate, props: EmailForwardersPageProps): string {
  const table = routingTable(t, { id: 'v2-autoresponders-table', title: t('Autoresponders'), headers: [t('Address'), t('Subject'), t('When'), t('Mail server'), t('Actions')], rowHook: 'autoresponder', emptyHook: 'autoresponder', emptyText: t('Not read') })
  return card({ title: t('Autoresponders'), titleId: 'v2-autoresponders-title', bodyHtml: `<div class="v2-email-routing-workspace" data-autoresponder-workspace data-autoresponder-can-read="${props.canManage}" data-autoresponder-manage="${props.canManage}">${accountRoutingClientTemplates()}<p>${escapeHtml(t('An automatic reply sent once per sender within the interval, so two autoresponders never answer each other in a loop.'))}</p><p role="status" aria-live="polite" data-autoresponder-status>${escapeHtml(t('Records have not been read.'))}</p>${table}${props.canManage && props.domains.length ? autoresponderForm(t, props) : props.readOnly === true ? `<fieldset disabled>${autoresponderForm(t, props)}</fieldset>` : ''}</div>` })
}

function defaultAddress(t: Translate, props: EmailForwardersPageProps): string {
  const domains = field('default-domain', t('Domain'), `<span class="v2-select"><select id="default-domain" name="domain" dir="ltr">${props.domains.map(domain => `<option value="${escapeHtml(domain.name)}">${escapeHtml(domain.name)}</option>`).join('')}</select>${icon('chevDown', 16)}</span>`)
  const modes = `<fieldset class="v2-email-routing-choices"><legend>${escapeHtml(t('Unknown addresses'))}</legend>${choice('default-kind', 'reject', t('Reject with an error'), true, t('Recommended. The sender learns the address is wrong. No spam is stored.'))}${choice('default-kind', 'forward', t('Forward to an address'), false, t('Catches typos, but also every spam guess at your domain.'))}${choice('default-kind', 'discard', t('Discard silently'), false, t('The sender is not told. Real mail can be lost without anyone noticing.'))}</fieldset>`
  const destination = field('default-destination', t('Forward to'), textInput('default-destination', 'destination', ' type="email" autocomplete="off" dir="ltr"'), undefined, ' data-default-destination-field hidden')
  const form = (props.canManage && props.domains.length) || props.readOnly === true ? `<form class="v2-form" data-default-form>${domains}${modes}${destination}<p data-default-current role="status"></p><div class="v2-email-routing-actions">${submit(t('Save default address'))}</div></form>` : ''
  return card({ title: t('Default address'), titleId: 'v2-default-address-title', bodyHtml: `<div class="v2-email-routing-workspace" data-default-workspace data-default-can-read="${props.canManage}" data-default-manage="${props.canManage}"><p>${escapeHtml(t('What happens to mail sent to an address that does not exist on a domain.'))}</p><p role="status" aria-live="polite" data-default-status>${escapeHtml(t('Records have not been read.'))}</p>${props.readOnly === true ? `<fieldset disabled>${form}</fieldset>` : form}</div>` })
}

/** All three workspaces share the existing core routing controller and its serialized write/readback policy. */
export function renderV2EmailForwardersPage(t: Translate, props: EmailForwardersPageProps): string {
  if (props.readOnly === true) props = { ...props, canManage: false }
  return `<div class="v2-email-routing"${props.readOnly === true ? ' data-readonly="true"' : ''} lang="${t.locale}" dir="${localeDirection(t.locale)}">${layoutRoot(t, {
    header: { breadcrumb: [{ label: t('Home'), href: '/home' }, { label: t('Email accounts'), href: '/email/accounts' }, { label: t('Forwarders') }], route: '/email/forwarders', title: t('Forwarders') },
  }, `<div class="v2-stack">${forwarders(t, props)}${autoresponders(t, props)}${defaultAddress(t, props)}${renderV2MailCards(mailCardsFor('/email/forwarders', t, { canRead: props.readOnly !== true && props.domainsObserved === true, canAct: () => props.canManage === true, domains: props.domains.map(domain => domain.name) }), t.locale)}</div>`)}</div>`
}

export const EMAIL_ROUTING_CSS = `.v2-email-routing .v2-layout>.v2-stack{gap:var(--space-4)}
.v2-email-routing h1{font-size:26px;line-height:1.2}
.v2-email-routing .v2-card h2{font-size:16px;line-height:1.3}
.v2-email-routing .v2-field{gap:var(--space-1)}
.v2-email-routing .v2-field>label{padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600;text-box-trim:trim-end;text-box-edge:text}
.v2-email-routing .v2-field__help{font-size:13px;line-height:1.5;color:var(--muted)}
.v2-email-routing .v2-btn{min-inline-size:44px;min-block-size:44px;transition-property:background-color,border-color,color,box-shadow,opacity,transform;transition-duration:140ms;transition-timing-function:ease-out}
.v2-email-routing-workspace{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-email-routing-workspace .v2-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:var(--space-2) var(--space-3);align-items:start;padding-block-start:var(--space-3);border-block-start:1px solid var(--line)}
.v2-email-routing-workspace .v2-form>:is(h3,.v2-fields,.v2-email-routing-actions,[role=status]){grid-column:1/-1}
.v2-email-routing-workspace .v2-form>h3{font-size:14px}
.v2-email-routing-workspace>fieldset{margin:0;padding:0;border:0;min-inline-size:0}
.v2-email-routing-workspace>p:not([data-state=failed]){font-size:13px;line-height:1.6;color:var(--text-2)}
.v2-email-routing-workspace [role=status]:empty{display:none}
.v2-email-routing-workspace>[role=status]:not([data-state=failed]){padding:10px 14px;border:1px solid var(--line);border-radius:12px;background:var(--subtle);font-weight:500}
.v2-email-routing-workspace>[role=status][data-state=uncertain]{border-color:var(--bad-line);background:var(--bad-soft)}
.v2-email-routing-workspace .v2-table{min-inline-size:720px!important}
.v2-email-routing-workspace>.v2-table-scroll{border:1px solid var(--line);border-radius:12px}
.v2-email-routing-workspace>.v2-table-scroll+p{margin-block-start:calc(var(--space-2)*-1);font-size:13px;text-align:center}
.v2-email-routing-workspace dl{display:flex;flex-direction:column;gap:var(--space-1);margin:0}
.v2-email-routing-workspace dt{font-size:12px;color:var(--muted);text-box-trim:trim-end;text-box-edge:text}
.v2-email-routing-workspace dd{margin:0;font-size:13px;overflow-wrap:anywhere;text-box-trim:trim-start;text-box-edge:text}
.v2-email-routing-workspace :is(dd,td,.v2-num){font-variant-numeric:tabular-nums}
.v2-email-routing-workspace [data-forwarder-create]{display:flex;flex-direction:column;gap:var(--space-3);max-inline-size:640px}
.v2-email-routing-workspace [data-forwarder-create] .v2-fields{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-email-routing-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-email-routing-choices{display:flex;flex-direction:column;gap:var(--space-2);border:0;padding:0;margin:0;min-inline-size:0}
.v2-email-routing-choices legend{padding:0;margin-block-end:var(--space-1);font-size:13px;font-weight:600}
.v2-email-routing-choice{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-email-routing-choice>input{flex:none}
.v2-email-routing-choice:has(small){align-items:flex-start}.v2-email-routing-choice:has(small)>input{margin-block-start:3px}
.v2-email-routing-choice>span{display:flex;flex-direction:column;gap:var(--space-1)}
.v2-email-routing-choice small{font-size:13px;line-height:1.5;color:var(--muted)}
.v2-email-routing .v2-field :is(input,select,textarea)[dir=ltr]{text-align:start}
.v2-email-routing .v2-field :is(input,select,textarea)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-email-routing-workspace [data-state=uncertain]{color:var(--bad)}
.v2-email-routing-workspace td bdi{overflow-wrap:anywhere}
.v2-email-routing:dir(rtl) *,[data-ui-theme="v2"] [dir=rtl] .v2-email-routing *{letter-spacing:0}
@media(prefers-reduced-motion:reduce){.v2-email-routing .v2-btn{transition-duration:0ms}}
@media(max-width:640px){.v2-email-routing .v2-card:not(.v2-card--flush){padding:var(--space-2)}}
@media(min-width:601px){.v2-email-routing-workspace td .v2-btn{padding-inline:10px;font-size:13px}}
.v2-email-routing-table{display:contents}
@media(max-width:600px){.v2-email-routing-table td:is(:nth-child(3),:nth-child(4)):not(:last-child,[colspan],:empty)::before{display:block;font-size:12px;color:var(--muted)}.v2-email-routing-table td:nth-child(3):not(:last-child,[colspan],:empty)::before{content:var(--v2-pl3)}.v2-email-routing-table td:nth-child(4):not(:last-child,[colspan],:empty)::before{content:var(--v2-pl4)}.v2-email-routing-workspace .v2-table tr>td:is(:first-child,:nth-child(2),:nth-child(3),:nth-child(4):not(:last-child)):not([colspan]){grid-column:1/-1!important;grid-row:auto!important;justify-self:start!important;text-align:start!important}.v2-email-routing-workspace .v2-table tr>td:first-child{font-weight:600}.v2-email-routing-actions>.v2-btn{flex:1 1 auto}.v2-email-routing-workspace .v2-table{min-inline-size:0!important}.v2-email-routing-workspace .v2-table thead{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}}
@media(min-width:601px){.v2-email-routing-workspace #v2-forwarders-table{table-layout:fixed;inline-size:100%;min-inline-size:0!important}.v2-email-routing-workspace #v2-forwarders-table th:nth-child(1){inline-size:24%}.v2-email-routing-workspace #v2-forwarders-table th:nth-child(2){inline-size:28%}.v2-email-routing-workspace #v2-forwarders-table th:nth-child(3){inline-size:18%}.v2-email-routing-workspace #v2-forwarders-table th:nth-child(4){inline-size:13%}.v2-email-routing-workspace #v2-forwarders-table th:nth-child(5){inline-size:17%}.v2-email-routing-workspace #v2-forwarders-table td:nth-child(-n+3) bdi{white-space:nowrap}}@media(min-width:601px){.v2-email-routing-workspace #v2-autoresponders-table{table-layout:fixed;inline-size:100%;min-inline-size:0!important}.v2-email-routing-workspace #v2-autoresponders-table th:nth-child(1){inline-size:24%}.v2-email-routing-workspace #v2-autoresponders-table th:nth-child(2){inline-size:20%}.v2-email-routing-workspace #v2-autoresponders-table th:nth-child(3){inline-size:22%}.v2-email-routing-workspace #v2-autoresponders-table th:nth-child(4){inline-size:13%}.v2-email-routing-workspace #v2-autoresponders-table th:nth-child(5){inline-size:21%}}

`
