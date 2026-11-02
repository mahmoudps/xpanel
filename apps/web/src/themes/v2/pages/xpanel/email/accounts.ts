import type { Domain, Plan, ServiceUser } from '@xpanel/core'
import type { Translate } from '../../../../../i18n.ts'
import { card } from '../../../components/card.ts'
import { dataTable } from '../../../components/data-table.ts'
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
    const title = password ? t('New mailbox password') : t('Mailbox quota (MB)')
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
  const quotaField = field('mailbox-quota', t('Requested quota (MB)'), `<input id="mailbox-quota" name="mailboxQuotaMb" type="number" dir="ltr" min="1" step="1" value="${quota}" required inputmode="numeric">`)
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

function usersTable(t: Translate, props: EmailAccountsPageProps): string {
  const users = props.users.state === 'read' ? props.users.items : []
  const columns = [t('Login'), t('Services'), t('Mailbox quota (MB)'), t('File directory'), t('Last sign-in')].map(label => ({ label }))
  const table = dataTable(t, {
    id: 'v2-email-users', caption: t('Service users'), columns, actions: true, minWidth: 1040,
    state: props.users.state === 'failed' ? 'error' : props.users.state === 'unread' ? 'empty' : users.length ? 'ready' : 'empty',
    emptyText: props.users.state === 'unread' ? t('Not read') : t('No service users were returned.'),
    ...(props.users.state === 'failed' ? { error: { lead: t(msgctxt('theme:v2', 'This list could not be read.')) } } : {}),
    rows: users.map(user => ({
      cellsHtml: [
        `<div class="v2-cell-lead"><span class="v2-cell-lead__mark" aria-hidden="true">${escapeHtml(user.login.charAt(0))}</span><span class="v2-cell-lead__text">${technical(user.login)}</span></div>`,
        `<div class="v2-email-services">${[user.services.email ? t('Email') : '', user.services.ftp ? 'FTP' : '', user.services.webdisk ? 'Web Disk' : ''].filter(Boolean).map(label => statusPill({ tone: 'neutral', hollow: true, label })).join('')}</div>`,
        user.services.email ? user.mailboxQuotaMb === 'unlimited' ? escapeHtml(t('Unlimited')) : technical(user.mailboxQuotaMb) : escapeHtml(t('No mailbox')),
        user.services.ftp || user.services.webdisk ? technical(user.ftpDir) : escapeHtml(t('No file access')),
        `<span class="v2-muted">${escapeHtml(t('Not read'))}</span>`,
      ],
      actionsHtml: rowActions(t, user, props.canManage, props.readOnly === true),
    })),
  })
  return card({ title: t('Service users'), titleId: 'v2-email-users-title', flush: true, bodyHtml: `<div data-collection-state="${props.users.state === 'read' ? users.length ? 'read' : 'empty' : props.users.state}">${table}</div>` })
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
  const main = `<div class="v2-stack">${usersTable(t, props)}${connection}</div>`
  const create = props.canManage ? createMailbox(t, props) : props.readOnly === true || !props.account ? `<div data-readonly="true"><fieldset disabled>${createMailbox(t, props)}</fieldset></div>` : ''
  const body = `${summaries}${accountFacts(t, props)}<div class="v2-split">${main}${create}</div>${props.canManage ? mailboxDialogs(t) : ''}`
  return `<div class="v2-email-accounts"${props.readOnly === true ? ' data-readonly="true"' : ''}>${layoutRoot(t, {
    header: {
      breadcrumb: [{ label: 'xPanel', href: '/home' }, { label: t('Email accounts') }], route: '/email/accounts',
      title: t('Email accounts'), description: t('Service users'),
      ...(props.canManage ? { actionsHtml: `<a class="v2-btn v2-btn--primary" href="#v2-mailbox-create">${icon('plus', 16)}${escapeHtml(t('Create mailbox'))}</a>` } : {}),
    },
  }, body)}</div>`
}

export const EMAIL_ACCOUNTS_CSS = `.v2-email-accounts{min-inline-size:0}
.v2-email-accounts .v2-email-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:var(--space-2)}
.v2-email-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-email-facts dt{font-size:13px;color:var(--muted)}
.v2-email-facts dd{margin:0;overflow-wrap:anywhere}
.v2-email-services,.v2-email-row-actions,.v2-email-actions{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-2)}
.v2-email-services{gap:var(--space-1)}
.v2-email-accounts .v2-table__actions{text-align:start}
.v2-email-handoff{display:inline-flex;align-items:flex-start;flex-direction:column;gap:var(--space-1)}
.v2-email-handoff [data-handoff-status]{max-inline-size:32ch;white-space:normal;overflow-wrap:anywhere}
.v2-email-password{display:grid;gap:var(--space-2);min-inline-size:0}
.v2-email-services-choice{display:flex;flex-direction:column;gap:var(--space-2);margin:0;padding:0;border:0;min-inline-size:0}
.v2-email-services-choice legend{padding:0;margin-block-end:var(--space-1);font-weight:600}
.v2-email-services-choice label{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-email-accounts .v2-field :is(input,select)[dir=ltr],.v2-email-dialog .v2-field input[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-email-actions{justify-content:flex-end}
.v2-email-dialog{padding:var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-card);background:var(--surface);color:var(--text);inline-size:min(560px,calc(100% - 32px));max-block-size:calc(100dvh - 32px);overflow:auto}
.v2-email-dialog::backdrop{background:var(--scrim)}
.v2-email-dialog .v2-form{gap:var(--space-3)}
.v2-email-dialog [data-dialog-status]:not([hidden]),.v2-email-accounts [data-mailbox-status]:not([hidden]){padding:var(--space-2);border:1px solid var(--bad-line);border-radius:var(--radius-control);background:var(--bad-soft);color:var(--bad);overflow-wrap:anywhere}
@media(max-width:600px){.v2-email-dialog{padding:var(--space-2)}.v2-email-accounts .v2-email-actions>.v2-btn{flex:1 1 auto}}
`
