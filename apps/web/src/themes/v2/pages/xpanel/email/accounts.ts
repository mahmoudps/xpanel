import type { Domain, Plan, ServiceUser } from '@xpanel/core'
import type { Translate } from '../../../../../i18n.ts'
import { card } from '../../../components/card.ts'
import { dataTable } from '../../../components/data-table.ts'
import { filterBar } from '../../../components/filter-bar.ts'
import { kpiStrip, layoutRoot } from '../../../layouts/common.ts'
import { drawer } from '../../../components/drawer.ts'
import { notice } from '../../../components/notice.ts'
import { statusPill } from '../../../components/status-pill.ts'
import { escapeHtml } from '../../../html.ts'
import { icon } from '../../../icons.ts'

/** Collections and capabilities have already been resolved for the signed-in account by core. */
export type EmailCollection<T> =
  | { readonly state: 'read'; readonly items: readonly T[] }
  | { readonly state: 'unread' | 'failed' }

export interface EmailAccountsPageProps {
  readonly account?: { readonly username: string; readonly primaryDomain: string }
  readonly plan?: Pick<Plan, 'name' | 'defaultMailboxQuotaMb'> & { readonly caps: Pick<Plan['caps'], 'mailboxes'> }
  readonly domains: EmailCollection<Pick<Domain, 'id' | 'name'>>
  readonly users: EmailCollection<ServiceUser>
  readonly canManage: boolean
  readonly readOnly?: boolean
}

const technical = (value: string | number): string => `<bdi class="v2-mono v2-num" dir="ltr">${escapeHtml(value)}</bdi>`

const field = (id: string, label: string, controlHtml: string, help?: string): string =>
  `<div class="v2-field"><label for="${id}">${escapeHtml(label)}</label>${controlHtml}${help ? `<span class="v2-field__help" id="${id}-help">${escapeHtml(help)}</span>` : ''}</div>`

function handoff(t: Translate, login: string, disabled = false): string {
  return `<span class="v2-email-handoff" data-handoff-control><button type="button" class="v2-btn" data-handoff="xmail" data-handoff-mailbox="${escapeHtml(login)}" data-handoff-state="idle"${disabled ? ' disabled' : ''}>${icon('external', 16)}${escapeHtml(t('Open webmail'))}</button><span data-handoff-status role="status" aria-live="polite" hidden></span></span>`
}

function rowActions(t: Translate, user: ServiceUser, canManage: boolean, readOnly = false): string {
  if (!user.services.email) return `<span class="v2-muted">${escapeHtml(t('Read only'))}</span>`
  return `<div class="v2-email-row-actions">${handoff(t, user.login, readOnly)}${canManage ? `<button type="button" class="v2-btn" data-mailbox-password="${escapeHtml(user.id)}">${escapeHtml(t('Password'))}</button><button type="button" class="v2-btn" data-mailbox-quota="${escapeHtml(user.id)}"${typeof user.mailboxQuotaMb === 'number' ? ` data-mailbox-quota-value="${user.mailboxQuotaMb}"` : ''}>${escapeHtml(t('Quota'))}</button><button type="button" class="v2-btn v2-btn--ghost" data-remove-mailbox="${escapeHtml(user.id)}">${escapeHtml(t('Delete'))}</button>` : ''}</div>`
}

function mailboxDialogs(t: Translate): string {
  return (['password', 'quota'] as const).map(kind => {
    const password = kind === 'password'
    const id = `v2-mailbox-${kind}`
    const title = password ? t('New mailbox password') : t('Mailbox quota (MiB)')
    const control = `<input id="${id}-next" name="${password ? 'password' : 'mailboxQuotaMb'}" type="${password ? 'password' : 'number'}" dir="ltr" ${password ? 'minlength="8" autocomplete="new-password"' : 'min="1" step="1" inputmode="numeric"'} required>`
    // The controller requires native showModal()/close(), not a role-only dialog element.
    return `<dialog class="v2-email-dialog" data-mailbox-${kind}-dialog aria-labelledby="${id}-title"><form method="dialog" class="v2-form"><header><h2 id="${id}-title">${escapeHtml(title)}</h2></header>${field(`${id}-next`, title, control)}<p data-dialog-status role="status" hidden></p><footer class="v2-email-actions"><button type="button" class="v2-btn" data-dialog-cancel>${escapeHtml(t('Cancel'))}</button><button type="submit" class="v2-btn v2-btn--primary">${escapeHtml(t('Save'))}</button></footer></form></dialog>`
  }).join('')
}

function createMailbox(t: Translate, props: EmailAccountsPageProps): string {
  const domains = props.domains.state === 'read' ? props.domains.items : []
  const disabled = domains.length ? '' : ' disabled'
  const defaultQuota = props.plan?.defaultMailboxQuotaMb
  const quota = typeof defaultQuota === 'number' ? defaultQuota : 1024
  const local = field('mailbox-local', t('Local name'), '<input id="mailbox-local" name="localPart" type="text" dir="ltr" required pattern="[a-z0-9][a-z0-9._-]{0,31}" maxlength="32" autocomplete="off">')
  const domain = field('mailbox-domain', t('Domain'), `<span class="v2-select"><select id="mailbox-domain" name="domainId" required${disabled}>${domains.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('')}</select>${icon('chevDown', 16)}</span>`)
  const password = field('mailbox-password', t('Password'), `<div class="v2-email-password"><input id="mailbox-password" name="password" type="password" required minlength="8" autocomplete="new-password"><button type="button" class="v2-btn" data-password-generate data-password-target="mailbox-password"${disabled}>${escapeHtml(t('Generate password'))}</button></div>`)
  const quotaField = field('mailbox-quota', t('Requested quota (MiB)'), `<input id="mailbox-quota" name="mailboxQuotaMb" type="number" dir="ltr" min="1" step="1" value="${quota}" required inputmode="numeric">`)
  const services = `<fieldset class="v2-email-services-choice" aria-describedby="v2-mailbox-services-note"><legend>${escapeHtml(t('Services'))}</legend><label><input type="checkbox" checked disabled><span>${escapeHtml(t('Email'))}</span></label><label><input type="checkbox" disabled><span>FTP</span></label><label><input type="checkbox" disabled><span>Web Disk</span></label><p class="v2-field__help" id="v2-mailbox-services-note">${escapeHtml(t('Creates an email mailbox using the existing account service. FTP and Web Disk creation are not configured here.'))}</p></fieldset>`
  const domainNote = domains.length ? '' : notice(t, { tone: 'warn', text: t('No authorized domain was read. Creation is unavailable.') })
  return drawer(t, {
    id: 'v2-mailbox-create', title: t('Create mailbox'),
    bodyHtml: `<form class="v2-form" data-mailbox-form="true">${local}${domain}${services}${password}${quotaField}${domainNote}<p data-mailbox-status role="status" hidden></p><div class="v2-email-actions"><button type="submit" class="v2-btn v2-btn--primary"${disabled}>${icon('plus', 16)}${escapeHtml(t('Create mailbox'))}</button></div></form>`,
  })
}

function accountFacts(t: Translate, props: EmailAccountsPageProps): string {
  const facts = [
    { label: t('Account'), value: props.account?.username ?? t('Not read'), technical: true },
    { label: t('Primary domain'), value: props.account?.primaryDomain ?? t('Not read'), technical: true },
    { label: t('Plan'), value: props.plan?.name ?? t('Not read'), technical: false },
  ]
  return card({ title: t('Account and plan'), titleId: 'v2-email-account-title', bodyHtml: `<dl class="v2-email-facts">${facts.map(item => `<div><dt>${escapeHtml(item.label)}</dt><dd>${item.technical ? technical(item.value) : escapeHtml(item.value)}</dd></div>`).join('')}</dl>` })
}

const serviceKeys = (user: ServiceUser): string[] => [user.services.email ? 'email' : '', user.services.ftp ? 'ftp' : '', user.services.webdisk ? 'webdisk' : ''].filter(Boolean)

/** Quick filter by service. The stylesheet hides the rows that lack the checked service, so it needs no controller. */
function serviceFilter(t: Translate, users: readonly ServiceUser[]): string {
  const options = [['all', t('All')], ['email', t('Email')], ['ftp', 'FTP'], ['webdisk', 'Web Disk']] as const
  return `<div class="v2-email-filter" role="radiogroup" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Show users with')))}" data-email-service-filter>${options.map(([key, label], index) => `<label><input type="radio" name="v2-email-service-filter" value="${key}"${index === 0 ? ' checked' : ''}><span>${escapeHtml(label)}</span><span class="v2-count v2-num">${key === 'all' ? users.length : users.filter(user => serviceKeys(user).includes(key)).length}</span></label>`).join('')}</div>`
}

function usersTable(t: Translate, props: EmailAccountsPageProps): string {
  const users = props.users.state === 'read' ? props.users.items : []
  const labels = [t('Login'), t('Services'), t('Mailbox quota (MiB)'), t('File directory'), t('Last sign-in')]
  const columns = labels.map(label => ({ label }))
  // On a phone the column header is not shown, so each fact carries its own label.
  const fact = (index: number, valueHtml: string): string => `<span class="v2-email-fact" data-label="${escapeHtml(labels[index]!)}">${valueHtml}</span>`
  const table = dataTable(t, {
    id: 'v2-email-users', caption: t('Service users'), columns, actions: true, minWidth: 900,
    state: props.users.state === 'failed' ? 'error' : props.users.state === 'unread' ? 'empty' : users.length ? 'ready' : 'empty',
    emptyText: props.users.state === 'unread' ? t('Not read') : t('No service users were returned.'),
    ...(props.users.state === 'failed' ? { error: { lead: t(msgctxt('theme:v2', 'This list could not be read.')) } } : {}),
    rows: users.map(user => ({
      cellsHtml: [
        `<div class="v2-cell-lead"><span class="v2-cell-lead__mark" aria-hidden="true">${escapeHtml(user.login.charAt(0))}</span><span class="v2-cell-lead__text">${technical(user.login)}</span></div>`,
        `<div class="v2-email-services">${[user.services.email ? t('Email') : '', user.services.ftp ? 'FTP' : '', user.services.webdisk ? 'Web Disk' : ''].filter(Boolean).map(label => statusPill({ tone: 'neutral', hollow: true, label })).join('')}</div>`,
        fact(2, user.services.email ? user.mailboxQuotaMb === 'unlimited' ? escapeHtml(t('Unlimited')) : technical(user.mailboxQuotaMb) : escapeHtml(t('No mailbox'))),
        fact(3, user.services.ftp || user.services.webdisk ? technical(user.ftpDir) : escapeHtml(t('No file access'))),
        fact(4, `<span class="v2-muted">${escapeHtml(t('Not read'))}</span>`),
      ],
      hooks: { 'data-email-services': serviceKeys(user).join(' '), 'data-list-row': true, 'data-list-search': user.login.toLowerCase() },
      actionsHtml: rowActions(t, user, props.canManage, props.readOnly === true),
    })),
  })
  // Board search by login: the shared list filter reads each row's data-list-search; the service chips stay CSS-only.
  const search = users.length ? filterBar({ search: { id: 'v2-email-user-filter', label: t(msgctxt('theme:v2', 'Filter users by login')), placeholder: t(msgctxt('theme:v2', 'Filter by login')), hooks: { 'data-list-filter-search': true } } }) : ''
  return card({ title: t('Service users'), titleId: 'v2-email-users-title', flush: true, ...(users.length ? { actionsHtml: serviceFilter(t, users), hooks: { 'data-list-filter': true } } : {}),
    bodyHtml: `<div data-collection-state="${props.users.state === 'read' ? users.length ? 'read' : 'empty' : props.users.state}">${search}${table}${users.length ? `<p class="v2-email-filter-empty">${escapeHtml(t(msgctxt('theme:v2', 'No service users match this filter.')))}</p><p class="v2-email-search-empty" data-list-filter-empty hidden>${escapeHtml(t(msgctxt('theme:v2', 'No service users match this filter.')))}</p>` : ''}</div>` })
}

/** Static explanation of the service-user contract; it states no account value. */
function howServiceUsersWork(t: Translate): string {
  const items = [
    ['user', msgctxt('theme:v2', 'One login'), msgctxt('theme:v2', 'The same user@domain and password for every service you turn on.')],
    ['shield', msgctxt('theme:v2', 'Not a Linux user'), msgctxt('theme:v2', 'A service user runs as your account, has no shell and cannot sign in to xPanel.')],
    ['folder', msgctxt('theme:v2', 'Locked to a directory'), msgctxt('theme:v2', 'FTP and Web Disk never see anything outside the directory you choose.')],
    ['disk', msgctxt('theme:v2', 'Counts toward your disk'), msgctxt('theme:v2', 'Mailboxes and uploads use the disk quota of your account.')],
  ] as const
  return card({ title: t('How service users work'), titleId: 'v2-email-how-title', description: t('Email, FTP and Web Disk credentials are separate from account control-panel access.'),
    bodyHtml: `<dl class="v2-email-how">${items.map(([name, title, text]) => `<div><dt><span class="v2-email-how__mark" aria-hidden="true">${icon(name, 16)}</span>${escapeHtml(t(title))}</dt><dd>${escapeHtml(t(text))}</dd></div>`).join('')}</dl>` })
}

/** Page body only. The active surface supplies the shell and core supplies the shared mutation controllers. */
export function renderV2EmailAccountsPage(t: Translate, props: EmailAccountsPageProps): string {
  if (!props.account) props = { ...props, canManage: false, domains: { state: 'unread' }, users: { state: 'unread' }, plan: undefined }
  else if (props.readOnly === true) props = { ...props, canManage: false }
  const users = props.users.state === 'read' ? props.users.items : undefined
  const counts = users ? { email: users.filter(user => user.services.email).length, ftp: users.filter(user => user.services.ftp).length, webdisk: users.filter(user => user.services.webdisk).length } : undefined
  const summaries = kpiStrip({ label: t('Service users'), items: [
    { label: t('Mailboxes'), value: counts ? String(counts.email) : t('Not read'), ...(props.plan ? { unit: `/ ${props.plan.caps.mailboxes === 'unlimited' ? t('Unlimited') : props.plan.caps.mailboxes}` } : {}) },
    { label: t('FTP accounts'), value: counts ? String(counts.ftp) : t('Not read') },
    { label: t('Web Disk'), value: counts ? String(counts.webdisk) : t('Not read') },
  ] })
  const connection = card({ title: t('Connection information'), titleId: 'v2-email-connection-title', bodyHtml: `<p class="v2-muted">${escapeHtml(t('Connection hosts, ports, mailbox usage and delivery health were not read.'))}</p>` })
  const main = `<div class="v2-stack">${usersTable(t, props)}${connection}${howServiceUsersWork(t)}</div>`
  const create = props.canManage ? createMailbox(t, props) : props.readOnly === true || !props.account ? `<div data-readonly="true"><fieldset disabled>${createMailbox(t, props)}</fieldset></div>` : ''
  const body = `${summaries}${accountFacts(t, props)}<div class="v2-split">${main}${create}</div>${props.canManage ? mailboxDialogs(t) : ''}`
  return `<div class="v2-email-accounts"${props.readOnly === true ? ' data-readonly="true"' : ''}>${layoutRoot(t, {
    header: {
      breadcrumb: [{ label: t('Home'), href: '/home' }, { label: t('Email accounts') }], route: '/email/accounts',
      title: t('Email accounts'), description: t('Service users'),
      ...(props.canManage ? { actionsHtml: `<a class="v2-btn v2-btn--primary" href="#v2-mailbox-create">${icon('plus', 16)}${escapeHtml(t('Create mailbox'))}</a>` } : {}),
    },
  }, body)}</div>`
}

export const EMAIL_ACCOUNTS_CSS = `.v2-email-accounts{min-inline-size:0}
.v2-email-accounts .v2-email-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:var(--space-2)}
.v2-email-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-email-accounts .v2-field>label,.v2-email-facts dt{text-box-trim:trim-end;text-box-edge:text}
.v2-email-facts dt{font-size:12px;color:var(--muted)}
.v2-email-facts dd{margin:0;font-size:13px;overflow-wrap:anywhere;text-box-trim:trim-start;text-box-edge:text}
@media(min-width:601px){.v2-email-accounts #v2-email-users{min-inline-size:880px!important}.v2-email-accounts #v2-email-users th{white-space:normal}.v2-email-accounts #v2-email-users :is(th,td):not(:first-child){padding-inline-start:8px}.v2-email-accounts #v2-email-users :is(th,td):not(:last-child){padding-inline-end:8px}.v2-email-accounts .v2-email-row-actions .v2-btn{padding-inline:10px;font-size:13px}}
.v2-email-accounts .v2-email-row-actions{display:grid;grid-template-columns:repeat(2,max-content);justify-content:start;gap:var(--space-1)}
.v2-email-accounts .v2-split{flex-direction:column;align-items:stretch}.v2-email-accounts .v2-split>*{flex:none;align-self:stretch;inline-size:100%;min-inline-size:0}
.v2-email-accounts .v2-drawer{flex:none;max-width:none}
.v2-email-accounts [data-readonly]>fieldset{margin:0;padding:0;border:0;min-inline-size:0}
.v2-email-accounts .v2-drawer .v2-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:var(--space-2) var(--space-3);align-items:start}
.v2-email-accounts .v2-drawer .v2-form>:is(.v2-email-actions,[data-mailbox-status],.v2-notice){grid-column:1/-1}
.v2-email-accounts .v2-card p.v2-muted{font-size:13px;line-height:1.6}
.v2-email-filter{display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:10px;background:var(--sunken)}
.v2-email-filter>label{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-block-size:var(--target);min-inline-size:var(--target);padding:0 12px;border:1px solid transparent;border-radius:8px;font-size:13px;color:var(--text-2);cursor:pointer}
.v2-email-filter input{position:absolute;inset:0;inline-size:100%;block-size:100%;margin:0;opacity:0;cursor:pointer}
.v2-email-filter>label:has(input:checked){border-color:var(--line);background:var(--surface);color:var(--text);font-weight:600;box-shadow:var(--shadow)}
.v2-email-filter>label:has(input:focus-visible){outline:2px solid var(--accent-fill);outline-offset:2px}
.v2-email-accounts:has(.v2-email-filter input[value=email]:checked) #v2-email-users tbody tr:not([data-email-services~=email]),.v2-email-accounts:has(.v2-email-filter input[value=ftp]:checked) #v2-email-users tbody tr:not([data-email-services~=ftp]),.v2-email-accounts:has(.v2-email-filter input[value=webdisk]:checked) #v2-email-users tbody tr:not([data-email-services~=webdisk]){display:none!important}
.v2-email-accounts .v2-filter__search{flex:0 1 360px}.v2-email-filter-empty,.v2-email-search-empty{display:none;margin:0;padding:var(--space-3);text-align:center;font-size:13px;color:var(--muted)}.v2-email-search-empty:not([hidden]){display:block}.v2-email-accounts #v2-email-users tbody tr[hidden]{display:none!important}
.v2-email-accounts:has(.v2-email-filter input[value=email]:checked):not(:has(tr[data-email-services~=email]:not([hidden]))):not(:has(.v2-email-search-empty:not([hidden]))) .v2-email-filter-empty,.v2-email-accounts:has(.v2-email-filter input[value=ftp]:checked):not(:has(tr[data-email-services~=ftp]:not([hidden]))):not(:has(.v2-email-search-empty:not([hidden]))) .v2-email-filter-empty,.v2-email-accounts:has(.v2-email-filter input[value=webdisk]:checked):not(:has(tr[data-email-services~=webdisk]:not([hidden]))):not(:has(.v2-email-search-empty:not([hidden]))) .v2-email-filter-empty{display:block}
.v2-email-how{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2) var(--space-3);margin:0;font-size:13px;line-height:1.6}
.v2-email-how>div{position:relative;padding-inline-start:40px;display:flex;flex-direction:column;gap:2px;min-inline-size:0}
.v2-email-how__mark{position:absolute;inset-inline-start:0;inset-block-start:0;display:flex;align-items:center;justify-content:center;inline-size:28px;block-size:28px;border-radius:8px;background:var(--sunken);color:var(--text-2)}
.v2-email-how dt{font-weight:600}.v2-email-how dd{margin:0;color:var(--muted)}
.v2-email-fact{display:contents}
.v2-email-services,.v2-email-row-actions,.v2-email-actions{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-2)}
.v2-email-services{gap:var(--space-1)}
.v2-email-accounts .v2-table__actions{text-align:start}
.v2-email-handoff{display:inline-flex;align-items:flex-start;flex-direction:column;gap:var(--space-1)}
.v2-email-handoff [data-handoff-status]{max-inline-size:32ch;white-space:normal;overflow-wrap:anywhere}
.v2-email-password{display:grid;gap:var(--space-2);min-inline-size:0}
.v2-email-services-choice{display:flex;flex-flow:row wrap;gap:0 var(--space-3);margin:0;padding:0;border:0;min-inline-size:0}
.v2-email-services-choice legend{padding:0;margin-block-end:var(--space-1);font-size:13px;font-weight:600}.v2-email-services-choice>p{flex-basis:100%}
.v2-email-services-choice label{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-email-accounts .v2-field :is(input,select)[dir=ltr],.v2-email-dialog .v2-field input[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-email-actions{justify-content:flex-end}
.v2-email-dialog{padding:var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-card);background:var(--surface);color:var(--text);inline-size:min(560px,calc(100% - 32px));max-block-size:calc(100dvh - 32px);overflow:auto}
.v2-email-dialog::backdrop{background:var(--scrim)}
.v2-email-dialog .v2-form{gap:var(--space-3)}
.v2-email-dialog [data-dialog-status]:not([hidden]),.v2-email-accounts [data-mailbox-status]:not([hidden]){padding:var(--space-2);border:1px solid var(--bad-line);border-radius:var(--radius-control);background:var(--bad-soft);color:var(--bad);overflow-wrap:anywhere}
.v2-email-accounts #v2-email-users th:nth-child(3){min-inline-size:104px}.v2-email-accounts #v2-email-users th:nth-child(5){min-inline-size:80px}
@media(min-width:1760px){.v2-email-accounts .v2-split{flex-direction:row;align-items:flex-start}.v2-email-accounts .v2-split>:first-child{flex:1 1 0;inline-size:auto}.v2-email-accounts .v2-split>:not(:first-child){flex:0 0 400px;inline-size:400px;align-self:flex-start}}
@media(max-width:600px){.v2-email-accounts .v2-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-email-accounts .v2-kpi-row>.v2-kpi:last-child:nth-child(odd){grid-column:1/-1}.v2-email-how{grid-template-columns:minmax(0,1fr)}.v2-email-filter{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.v2-email-filter>label{min-block-size:var(--target);justify-content:center}.v2-email-accounts #v2-email-users tr>td:is(:first-child,:nth-child(2)):not([colspan]),.v2-email-accounts #v2-email-users tr>td:has(>.v2-email-fact){grid-column:1/-1!important;grid-row:auto!important;justify-self:stretch!important;text-align:start!important}.v2-email-fact{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-2)}.v2-email-fact::before{content:attr(data-label);font-size:12px;color:var(--muted)}.v2-email-accounts .v2-email-row-actions{display:flex}.v2-email-accounts .v2-cell-lead,.v2-email-accounts .v2-cell-lead__text{min-inline-size:0}.v2-email-accounts .v2-cell-lead__text>bdi{white-space:normal;overflow-wrap:anywhere}.v2-email-dialog{padding:var(--space-2)}.v2-email-accounts .v2-email-actions>.v2-btn{flex:1 1 auto}}
@media(min-width:901px){.v2-email-accounts #v2-email-users{table-layout:fixed;min-inline-size:0!important}.v2-email-accounts #v2-email-users th:nth-child(1){inline-size:27%}.v2-email-accounts #v2-email-users th:nth-child(2){inline-size:12%}.v2-email-accounts #v2-email-users th:nth-child(3){inline-size:9%}.v2-email-accounts #v2-email-users th:nth-child(4){inline-size:14%}.v2-email-accounts #v2-email-users th:nth-child(5){inline-size:9%}.v2-email-accounts #v2-email-users th:nth-child(6){inline-size:29%}}
@media(min-width:901px){.v2-email-accounts #v2-email-users td{overflow-wrap:anywhere}.v2-email-accounts #v2-email-users .v2-cell-lead{min-inline-size:0}}
`
