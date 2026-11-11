import { effectivePlan } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import { formatAsciiBytes, formatAsciiRate } from '../../../../../display-format.ts'
import { ACCOUNT_PACKAGE_LIMIT_FIELDS } from '../../../../../models/plan-fields.ts'
import type { SurfaceAuthority } from '../../../../../models/theme-surface.ts'
import type { Translate } from '../../../../../i18n.ts'
import { accountListModel, type AccountListModel } from '../../../../../models/account-list.ts'
import type { MeasuredTotal } from '../../../../../models/reseller-usage.ts'
import { accountFor, allowed, canCreate, principalOf, qualified, readableAccounts } from '../../../../../models/whm-account-access.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/card.ts'
import { formField } from '../../../components/form-field.ts'
import { notice } from '../../../components/notice.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { rowMenu, type RowMenuItem } from '../../../components/row-menu.ts'
import { stateTones } from '../../../components/status-pill.ts'
import { escapeHtml, hookAttrs } from '../../../html.ts'
import { factList } from '../../../layouts/common.ts'
import { filterBar } from '../../../components/filter-bar.ts'

const ltr = (value: string | number): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`

function filters(t: Translate, model: AccountListModel): string {
  const choices = (items: readonly { value: string; label: string }[], all: string) => [{ value: '', label: all, selected: true }, ...items.map(item => ({ ...item, value: item.value === '' ? 'root' : item.value }))]
  return `<div class="v2-whm-accounts__filters" data-account-list-controls data-list-page-size="20">${formField({ id: 'account-list-search', label: t('Search loaded accounts'), control: { kind: 'input', type: 'search', autocomplete: 'off', hooks: { 'data-list-search-input': true } } })}${formField({ id: 'account-list-owner', label: t('Owner'), control: { kind: 'select', options: choices(model.owners, t('All owners')), hooks: { 'data-list-owner-filter': true } } })}${formField({ id: 'account-list-plan', label: t('Plan'), control: { kind: 'select', options: choices(model.plans, t('All plans')), hooks: { 'data-list-plan-filter': true } } })}${formField({ id: 'account-list-state', label: t('Status'), control: { kind: 'select', options: [{ value: '', label: t('All statuses'), selected: true }, { value: 'active', label: t('Active') }, { value: 'suspended', label: t('Suspended') }, { value: 'terminating', label: t('Terminating') }], hooks: { 'data-list-state-filter': true } } })}<a class="v2-btn v2-whm-accounts__clear" href="/whm/accounts">${escapeHtml(t(msgctxt('theme:v2', 'Clear filters')))}</a><p class="v2-muted" data-list-count role="status" aria-live="polite"></p><div class="v2-whm-accounts__empty" data-list-empty hidden><p>${escapeHtml(t('No accounts match these filters.'))}</p><a class="v2-btn" href="/whm/accounts">${escapeHtml(t(msgctxt('theme:v2', 'Clear filters')))}</a></div><nav class="v2-whm-accounts__pager" data-list-pages aria-label="${escapeHtml(t('Loaded account pages'))}" hidden><button type="button" class="v2-btn" data-list-previous>${escapeHtml(t('Previous'))}</button><span class="v2-num" data-list-page></span><button type="button" class="v2-btn" data-list-next>${escapeHtml(t('Next'))}</button></nav></div>`
}

/** A closed group of one native form; the form stays in the document with its saved values. */
const fold = (title: string, body: string, section?: string): string => `<details class="v2-whm-accounts__fold"${section ? ` data-account-detail-section="${section}"` : ''}><summary>${escapeHtml(title)}</summary>${body}</details>`

function planOwnerForms(t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean): string {
  const principal = principalOf(props)!
  const editable = canManage && qualified(props, 'modify-account') && allowed(props, 'edit-account') && account.status !== 'terminating'
  const plans = props.plans?.filter(plan => principal.kind === 'root' || plan.ownerId === null || plan.ownerId === principal.id)
  const current = plans?.find(plan => plan.id === account.planId)
  const planEditable = editable && (principal.kind === 'root' || allowed(props, 'change-plan')) && current !== undefined && plans !== undefined && plans.length > 0
  const planField = formField({ id: `v2-${account.username}-plan`, label: t('Plan'), control: { kind: 'select', name: 'planId', disabled: !planEditable, options: [...(!current ? [{ value: '', label: t('Current plan not read') }] : []), ...(plans ?? []).map(plan => ({ value: plan.id, label: plan.name, selected: plan.id === account.planId }))] } })
  const planBody = `${planField}<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'The server checks capacity, permissions and host reconciliation.')))}</p><p data-account-plan-status role="status" hidden></p><button class="v2-btn" type="${planEditable ? 'submit' : 'button'}"${planEditable ? '' : ' disabled'}>${escapeHtml(t('Change plan'))}</button>`
  const planForm = planEditable ? `<form class="v2-form" data-account-plan-form data-account-username="${escapeHtml(account.username)}">${planBody}</form>` : `<div class="v2-form" data-account-plan-readonly>${planBody}</div>`
  const owners = principal.kind === 'root' && props.resellers !== undefined ? [{ id: '', username: 'root' }, ...props.resellers] : undefined
  const ownerKnown = owners?.some(owner => owner.id === (account.ownerId ?? '')) === true
  const ownerEditable = principal.kind === 'root' && editable && ownerKnown
  const ownerField = formField({ id: `v2-${account.username}-owner`, label: t('New owner'), control: { kind: 'select', name: 'ownerId', disabled: !ownerEditable, options: [...(!ownerKnown ? [{ value: '', label: t('Owner choices not read') }] : []), ...(owners ?? []).map(owner => ({ value: owner.id, label: owner.username, selected: owner.id === (account.ownerId ?? '') }))] } })
  const ownerBody = `${ownerField}<p class="v2-muted">${escapeHtml(t('Only root may change account ownership.'))}</p><p data-reseller-owner-status role="status" hidden></p><button class="v2-btn" type="${ownerEditable ? 'submit' : 'button'}"${ownerEditable ? '' : ' disabled'}>${escapeHtml(t('Change owner'))}</button>`
  return `<div class="v2-whm-accounts__mutation" data-approved-account-mutations><h4 class="v2-sr">${escapeHtml(t('Plan and ownership'))}</h4>${fold(t('Change plan'), planForm, 'plan')}${fold(t('Change owner'), ownerEditable ? `<form class="v2-form" data-reseller-owner-form data-account-username="${escapeHtml(account.username)}">${ownerBody}</form>` : `<div class="v2-form" data-account-owner-readonly>${ownerBody}</div>`, 'owner')}</div>`
}

/** The account's package with its own overrides applied: what the server enforces. */
const accountPlan = (props: WhmSurfaceProps, account: Account): Plan | undefined => {
  const principal = principalOf(props)!
  const plan = props.plans?.find(item => item.id === account.planId && (principal.kind === 'root' || item.ownerId === null || item.ownerId === principal.id))
  return plan && effectivePlan(plan, account)
}
const LIMIT_FIELDS = [['diskMb', msgid('Disk space (MB)'), 'quota-modification'], ['bandwidthMbMonth', msgid('Monthly bandwidth (MB)'), 'limit-bandwidth-usage']] as const

/** WHM Modify Account / Quota Modification / Limit Bandwidth Usage: only the fields this caller may change are editable. */
function limitsForm(t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean): string {
  const editable = canManage && allowed(props, 'edit-account') && account.status !== 'terminating'
  const on = LIMIT_FIELDS.filter(([, , tool]) => editable && qualified(props, tool))
  const fields = on.map(([key, label]) => {
    const value = account.limits?.resources?.[key], id = `v2-${account.username}-limit-${key}`
    return `<div class="v2-field"><label for="${id}">${escapeHtml(t(label))}</label><input id="${id}" type="text" inputmode="numeric" dir="ltr" autocomplete="off" data-account-limit="${key}" value="${typeof value === 'number' ? value : ''}" placeholder="${escapeHtml(t('Package value'))}"${value === 'unlimited' ? ' disabled' : ''}><label class="v2-whm-accounts__selection"><input type="checkbox" data-account-limit-unlimited="${key}"${value === 'unlimited' ? ' checked' : ''}><span>${escapeHtml(t('Unlimited'))}</span></label></div>`
  }).join('')
  const packageEditable = editable && qualified(props, 'modify-account')
  const packageFields = !packageEditable ? '' : `<div class="v2-whm-account-limit-grid">` + ACCOUNT_PACKAGE_LIMIT_FIELDS.map(({ key, label, group, scale }) => {
    const value = (account.limits?.[group] as Record<string, number | 'unlimited' | null> | undefined)?.[key], id = `v2-${account.username}-limit-${key}`
    return `<div class="v2-field"><label for="${id}">${escapeHtml(t(label))}</label><input id="${id}" type="text" inputmode="numeric" dir="ltr" autocomplete="off" data-account-limit="${key}" data-account-limit-group="${group}" data-account-limit-scale="${scale}" value="${typeof value === 'number' ? value / scale : ''}" placeholder="${escapeHtml(t('Package value'))}"${value === 'unlimited' ? ' disabled' : ''}><label class="v2-whm-accounts__selection"><input type="checkbox" data-account-limit-unlimited="${key}"${value === 'unlimited' ? ' checked' : ''}><span>${escapeHtml(t('Unlimited'))}</span></label></div>`
  }).join('') + `</div><div class="v2-field"><label for="v2-${account.username}-limit-resolution">${escapeHtml(t('When a value differs from the package'))}</label><select id="v2-${account.username}-limit-resolution" data-account-limit-resolution><option value="">${escapeHtml(t('Keep it on this account'))}</option><option value="create">${escapeHtml(t('Create a package for this account'))}</option><option value="switch">${escapeHtml(t('Switch to a matching package'))}</option><option value="update">${escapeHtml(t('Update the package for all its accounts'))}</option><option value="detach" disabled>${escapeHtml(t('Detach from the package (unavailable: every account keeps a package)'))}</option></select></div>`
  const note = `<p class="v2-muted">${escapeHtml(t('Leave a field empty to use the package value. Changing the package replaces these limits.'))}</p>`
  return on.length || packageFields
    ? fold(t('Account limits'), `<form class="v2-form" data-account-limits-form data-account-id="${escapeHtml(account.id)}"><h4 class="v2-sr">${escapeHtml(t('Account limits'))}</h4><div class="v2-whm-account-limit-grid">${fields}</div>${packageFields}${note}<p data-account-limits-status role="status" hidden></p><button class="v2-btn" type="submit">${escapeHtml(t('Save limits'))}</button></form>`)
    : `<div class="v2-form" data-account-limits-readonly><h4>${escapeHtml(t('Account limits'))}</h4><p class="v2-muted">${escapeHtml(t('Changing account limits is not qualified on this host or not permitted. Nothing can be saved here.'))}</p></div>`
}

/** A measured byte total; undefined when the host did not read or report it. */
const usedBytes = (total: MeasuredTotal | undefined): number | undefined => total?.state === 'read' && total.bytes !== null ? total.bytes : undefined

// Used / limit under its label. The bar is drawn only for a measured value against a finite limit; 80% warns, 95% is a problem.
function quota(t: Translate, label: string, used: MeasuredTotal | undefined, value: number | 'unlimited' | undefined, custom: boolean): string {
  // Limits are stored in MiB; both sides use the product byte format.
  const bytes = usedBytes(used), shown = bytes === undefined ? undefined : formatAsciiBytes(bytes), limit = typeof value === 'number' ? formatAsciiBytes(value * 1048576) : undefined
  const percent = bytes !== undefined && typeof value === 'number' && value > 0 ? Math.min(100, Math.round(bytes / (value * 1048576) * 1000) / 10) : undefined
  const bar = percent === undefined ? '' : `<div class="v2-bar" role="meter" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${escapeHtml(`${shown} / ${limit}`)}"><span class="v2-bar__fill v2-bar--${percent >= 95 ? 'bad' : percent >= 80 ? 'warn' : 'info'}" style="inline-size:${percent}%"></span></div>`
  return `<small class="v2-muted">${escapeHtml(label)}</small><span>${shown === undefined ? escapeHtml(t('Not read')) : ltr(shown)} / ${value === undefined ? escapeHtml(t('Not read')) : value === 'unlimited' ? escapeHtml(t('Unlimited')) : ltr(limit!)}</span>${bar}${custom ? `<small class="v2-muted">${escapeHtml(bytes === undefined ? t('Usage / the account’s own limit. Usage has not been read.') : t(msgctxt('theme:v2', 'Usage / the account’s own limit.')))}</small>` : ''}`
}

function details(t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean): string {
  const principal = principalOf(props)!
  const plan = accountPlan(props, account)
  const owner = account.ownerId === null ? 'root' : principal.kind === 'reseller' && account.ownerId === principal.id ? principal.username : props.resellers?.find(item => item.id === account.ownerId)?.username
  const key = 'v2-account-detail-' + encodeURIComponent(account.username)
  const missing = t('Not read')
  const usage = props.accountUsage?.[account.id]
  const limit = (value: number | 'unlimited' | undefined, unit = ''): string => value === 'unlimited' ? t('Unlimited')
    : typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) + unit : missing
  const ioWrite = plan?.resources.ioWriteBps
  const ioWriteCap = ioWrite === 'unlimited' ? t('Unlimited')
    : typeof ioWrite === 'number' && Number.isFinite(ioWrite) && ioWrite >= 0 ? formatAsciiRate(ioWrite) : missing
  const mutation = (kind: 'contact' | 'password'): string => {
    const contact = kind === 'contact'
    const field = contact
      ? formField({ id: `v2-${account.username}-contact`, label: t('Contact email'), control: { kind: 'input', name: 'contactEmail', type: 'email', required: true, value: account.contactEmail, dir: 'ltr', disabled: !canManage } })
      : `<div class="v2-field"><label for="v2-${escapeHtml(account.username)}-password">${escapeHtml(t('New password'))}</label><input id="v2-${escapeHtml(account.username)}-password" name="password" type="password" required minlength="8" autocomplete="new-password"${canManage ? '' : ' disabled'}></div>`
    return `<${canManage ? 'form' : 'div'} class="v2-form"${canManage ? ` data-account-${kind}-form data-account-id="${escapeHtml(account.id)}"` : ' data-account-readonly-fields'}>${field}<p data-account-${kind}-status role="status" hidden></p><button class="v2-btn" type="${canManage ? 'submit' : 'button'}"${canManage ? '' : ' disabled'}>${escapeHtml(t(contact ? 'Save email' : 'Change password'))}</button></${canManage ? 'form' : 'div'}>`
  }
  const group = (suffix: string, title: string, body: string): string => `<section class="v2-whm-accounts__detail-group" aria-labelledby="${key}-${suffix}"><h3 id="${key}-${suffix}">${escapeHtml(title)}</h3>${body}</section>`
  const identity = group('identity', t(msgctxt('theme:v2', 'Identity and plan')), factList([
    { label: t('Account'), value: account.username, mono: true }, { label: t('Primary domain'), value: account.primaryDomain, mono: true },
    { label: t('Plan'), value: plan?.name ?? missing }, { label: t('Owner'), value: owner ?? missing, ltr: owner !== undefined },
    { label: 'UID', value: String(account.uid), mono: true }, { label: t('Resource unit'), value: `xpanel-${account.uid}.slice`, mono: true },
    { label: 'IPv4', value: account.ipv4, mono: true }, ...(account.ipv6 ? [{ label: 'IPv6', value: account.ipv6, mono: true }] : []),
    { label: t('Shell'), value: account.shell, mono: true },
  ]))
  const limits = group('limits', t(msgctxt('theme:v2', 'Limits and usage')),
    `<p class="v2-muted">${escapeHtml(usage ? t(msgctxt('theme:v2', 'Usage / limit in force: the package value or the account’s own limit. Only disk and bandwidth usage are read.')) : t('Usage / limit in force: the package value or the account’s own limit. Usage has not been read.'))}</p>` + `<div class="v2-whm-accounts__usage"><div class="v2-whm-accounts__quota">${quota(t, t('Disk'), usage?.disk, plan?.resources.diskMb, account.limits?.resources?.diskMb !== undefined)}</div><div class="v2-whm-accounts__quota">${quota(t, t('Bandwidth per month'), usage?.traffic, plan?.resources.bandwidthMbMonth, account.limits?.resources?.bandwidthMbMonth !== undefined)}</div></div>` + factList([
      { label: t('Memory'), value: `${missing} / ${limit(plan?.resources.memoryMb, ' MiB')}` },
      { label: 'CPU', value: `${missing} / ${limit(plan?.resources.cpuPercent, '%')}` },
      { label: t('Processes'), value: `${missing} / ${limit(plan?.resources.maxProcesses)}` },
      { label: t('PHP workers'), value: `${missing} / ${limit(plan?.caps.phpWorkers)}` },
      { label: t('IO write cap'), value: ioWriteCap, ltr: typeof ioWrite === 'number' && Number.isFinite(ioWrite) && ioWrite >= 0 },
    ]).replace(/\/ (\d+(?: MiB|%)?)/g, '/ <bdi dir="ltr">$1</bdi>'))
  const contact = group('contact', t('Contact'), factList([{ label: t('Contact email'), value: account.contactEmail, mono: true }]) + (allowed(props, 'edit-account') ? fold(t(msgctxt('theme:v2', 'Edit account')), mutation('contact'), 'modify') : ''))
  const edit = group('actions', t('Actions'), `${allowed(props, 'change-password') ? fold(t('Change password'), mutation('password'), 'password') : ''}${(!canManage || accountFor(props, account.username)) ? planOwnerForms(t, props, account, canManage) + limitsForm(t, props, account, canManage) : ''}${stateActions(t, props, account, canManage)}`)
  return `<section class="v2-whm-accounts__detail-body" data-account-detail-for="${escapeHtml(account.username)}" aria-label="${escapeHtml(account.username)}" hidden><div class="v2-whm-accounts__detail-summary"><span class="v2-whm-accounts__avatar" aria-hidden="true">${escapeHtml(account.username.charAt(0).toUpperCase())}</span><div><p class="v2-mono">${ltr(account.username)}</p><p class="v2-muted v2-mono">${ltr(account.primaryDomain)}</p></div></div>${handoff(t, props, account, canManage, 'panel')}${identity}${limits}${contact}${edit}</section>`
}

function detailAside(t: Translate, props: WhmSurfaceProps, accounts: readonly Account[], canManage: boolean): string {
  return `<aside id="v2-account-detail" class="v2-whm-accounts__detail-aside" data-account-details data-account-detail-panel aria-labelledby="v2-account-detail-title" hidden><div class="v2-whm-accounts__detail-header"><h2 id="v2-account-detail-title">${escapeHtml(t(msgctxt('theme:v2', 'Account details')))}</h2><button type="button" class="v2-btn v2-whm-accounts__detail-close" data-account-detail-close aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Close account details')))}"><span aria-hidden="true">×</span></button></div>${accounts.map(account => details(t, props, account, canManage)).join('')}</aside>`
}

const handoff = (t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean, place: 'panel' | 'menu'): string => canManage && allowed(props, 'edit-account') && account.status === 'active'
  ? `<span class="v2-whm-accounts__handoff" data-handoff-control><button type="button" ${place === 'menu' ? 'role="menuitem" class="v2-menu__item"' : 'class="v2-btn v2-btn--primary"'} data-handoff="xpanel" data-handoff-account="${escapeHtml(account.id)}" data-handoff-state="idle">${escapeHtml(t('Log in to xPanel'))}</button><span data-handoff-status role="status" aria-live="polite" hidden></span></span>` : ''

/** Suspend / Unsuspend and Delete carry the account they act on; the core action client opens its dialog from either place. */
function stateItems(t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean): RowMenuItem[] {
  if (!canManage || account.status === 'terminating') return []
  const attrs = { 'data-account-id': account.id, 'data-username': account.username, 'data-domain': account.primaryDomain } as const
  return [
    ...(allowed(props, 'suspend-account') ? [{ label: t(account.status === 'suspended' ? 'Unsuspend' : 'Suspend'), hooks: { 'data-action': account.status === 'suspended' ? 'unsuspend-account' : 'suspend-account', ...attrs } }] : []),
    ...(allowed(props, 'terminate-account') ? [{ label: t('Delete'), danger: true, hooks: { 'data-action': 'terminate-account', ...attrs } }] : []),
  ]
}

const stateActions = (t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean): string => {
  const items = stateItems(t, props, account, canManage)
  return items.length ? `<div class="v2-whm-accounts__state-actions">${items.map(item => `<button type="button" class="v2-btn${item.danger ? ' v2-btn--danger' : ''}"${hookAttrs(item.hooks)}>${escapeHtml(item.label)}</button>`).join('')}</div>` : ''
}

/** The parts of the details panel a row-menu item opens; only parts the panel renders are offered. */
function sectionOpeners(t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean): readonly (readonly [string, string])[] {
  const forms = Boolean(accountFor(props, account.username))
  return [
    ...(allowed(props, 'edit-account') ? [['modify', t(msgctxt('theme:v2', 'Edit account'))] as const] : []),
    ...(allowed(props, 'change-password') ? [['password', t('Change password')] as const] : []),
    ...(forms ? [['plan', t('Change plan')] as const, ['owner', t('Change owner')] as const] : []),
  ]
}

function actions(t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean): string {
  if (!canManage) return `<span class="v2-muted">${escapeHtml(t('Read only'))}</span>`
  const id = `v2-account-${account.username}-menu`
  const items = stateItems(t, props, account, canManage)
  // Log in sits first in the row menu, as on the board; its status line stays inside the open menu.
  const login = handoff(t, props, account, canManage, 'menu')
  // Section openers open this account's details at that part; popovertargetaction closes the menu on the way.
  const openers = sectionOpeners(t, props, account, canManage).map(([section, label]) => `<li role="none"><button type="button" role="menuitem" class="v2-menu__item" data-account-detail-open="${escapeHtml(account.username)}" data-account-detail-section="${section}" aria-controls="v2-account-detail" aria-expanded="false" popovertarget="${escapeHtml(id)}" popovertargetaction="hide">${escapeHtml(label)}</button></li>`).join('')
  if (!items.length && !login && !openers) return `<span class="v2-muted">${escapeHtml(t('Read only'))}</span>`
  const menu = rowMenu({ id, label: t(msgctxt('theme:v2', 'Actions for {username}'), { username: account.username }), items: items.map((item, index) => index === 0 && openers ? { ...item, separatorBefore: true } : item) })
  return menu.replace(' popover>', () => ` popover>${login ? `<li role="none">${login}</li>` : ''}${openers}`)
}

function row(t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean): string {
  const principal = principalOf(props)!
  const plan = accountPlan(props, account)
  const owner = account.ownerId === null ? 'root' : principal.kind === 'reseller' && account.ownerId === principal.id ? principal.username : props.resellers?.find(item => item.id === account.ownerId)?.username
  const phoneLabel = (text: string): string => ` data-phone-label="${escapeHtml(text)}"`
  const usage = props.accountUsage?.[account.id]
  const ioWrite = plan?.resources.ioWriteBps
  const ioWriteCap = ioWrite === 'unlimited' ? escapeHtml(t('Unlimited'))
    : typeof ioWrite === 'number' && Number.isFinite(ioWrite) && ioWrite >= 0 ? ltr(formatAsciiRate(ioWrite)) : escapeHtml(t('Not read'))
  const status = account.status === 'active' ? t('Active') : account.status === 'suspended' ? t('Suspended') : t('Terminating')
  const fields = hookAttrs({ 'data-account-row': account.username, 'data-account-id': account.id, 'data-list-search': `${account.username} ${account.primaryDomain}`.toLowerCase(), 'data-list-owner': account.ownerId ?? '', 'data-list-plan': account.planId, 'data-list-state': account.status })
  const select = `<td><label class="v2-whm-accounts__selection"><input type="checkbox" value="${escapeHtml(account.username)}" data-account-selection disabled><span class="v2-sr">${escapeHtml(t('Select account'))} ${ltr(account.username)}</span></label></td>`
  const opener = `<td><button type="button" class="v2-whm-accounts__opener" data-account-detail-open="${escapeHtml(account.username)}" aria-controls="v2-account-detail" aria-expanded="false" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Account details')) + ': ' + account.username)}"><span class="v2-whm-accounts__avatar" aria-hidden="true">${escapeHtml(account.username.charAt(0).toUpperCase())}</span><span><strong class="v2-mono">${ltr(account.username)}</strong><small class="v2-muted v2-mono">UID ${ltr(account.uid)}</small></span></button></td>`
  // Secondary values sit under their primary cell: the addresses under the domain, the owner under the plan.
  const domain = `<td><div class="v2-whm-accounts__stack"><span class="v2-mono">${ltr(account.primaryDomain)}</span><small class="v2-muted v2-mono" data-account-table-value="ip">${ltr(account.ipv4)}${account.ipv6 ? ` ${ltr(account.ipv6)}` : ''}</small></div></td>`
  const used = `<td><div class="v2-whm-accounts__stack"><div class="v2-whm-accounts__quota" data-account-table-value="disk">${quota(t, t('Disk'), usage?.disk, plan?.resources.diskMb, account.limits?.resources?.diskMb !== undefined)}</div><div class="v2-whm-accounts__quota" data-account-table-value="bandwidth">${quota(t, t('Bandwidth per month'), usage?.traffic, plan?.resources.bandwidthMbMonth, account.limits?.resources?.bandwidthMbMonth !== undefined)}</div></div></td>`
  const state = `<td><span data-account-status data-state="${account.status}"><span class="v2-pill v2-pill--state"><span class="v2-pill__dot" aria-hidden="true"></span><span data-account-status-label>${escapeHtml(status)}</span></span></span><template data-account-status-pending><span class="v2-pill v2-pill--warn"><span class="v2-pill__dot" aria-hidden="true"></span><span data-account-status-label>${escapeHtml(t('Verification required'))}</span></span></template></td>`
  const planCell = `<td${phoneLabel(t('Plan'))}><div class="v2-whm-accounts__stack"><span>${escapeHtml(plan?.name ?? t('Not read'))}</span><small class="v2-muted" data-account-table-value="owner">${escapeHtml(t('Owner'))} ${owner ? ltr(owner) : escapeHtml(t('Not read'))}</small></div></td>`
  return `<tr${fields}>${select}${opener}${domain}${used}${state}${planCell}<td data-account-table-value="io-write"${phoneLabel(t('IO write cap'))}>${ioWriteCap}</td><td class="v2-whm-accounts__actions">${actions(t, props, account, canManage)}</td></tr>`
}

function actionDialog(t: Translate, root: boolean): string {
  return `<dialog class="v2-whm-accounts__dialog" data-account-dialog aria-labelledby="v2-account-dialog-title" aria-describedby="v2-account-dialog-description"><form class="v2-form" method="dialog" data-account-action-form novalidate><h2 id="v2-account-dialog-title" data-account-dialog-title>${escapeHtml(t('Account action'))}</h2><p id="v2-account-dialog-description" data-account-dialog-description></p><dl class="v2-whm-accounts__identity"><div><dt>${escapeHtml(t('Account'))}</dt><dd><bdi dir="ltr" data-account-dialog-username></bdi></dd></div><div><dt>${escapeHtml(t('Primary domain'))}</dt><dd><bdi dir="ltr" data-account-dialog-domain></bdi></dd></div></dl><div class="v2-field" data-account-confirm-field hidden><label for="v2-terminate-confirm-user">${escapeHtml(t('Type the username to confirm'))}</label><input id="v2-terminate-confirm-user" name="confirmUsername" type="text" dir="ltr" autocomplete="off" spellcheck="false" data-type-to-confirm aria-describedby="v2-account-confirm-help"><span id="v2-account-confirm-help" class="v2-field__help">${escapeHtml(t('Must exactly match the account above.'))}</span></div><div class="v2-field" data-account-reason-field hidden><label for="v2-account-suspend-reason">${escapeHtml(t('Suspension reason'))}</label><textarea id="v2-account-suspend-reason" name="reason" rows="2" maxlength="500"></textarea></div>${root ? `<label class="v2-whm-accounts__selection" data-account-lock-field hidden><input type="checkbox" name="lock"><span>${escapeHtml(t('Prevent resellers from unsuspending this account'))}</span></label>` : ''}<p data-account-action-status role="status" aria-live="polite" tabindex="-1" hidden></p><div class="v2-whm-accounts__actions"><button type="button" class="v2-btn" data-account-action-cancel>${escapeHtml(t('Cancel'))}</button><button type="submit" class="v2-btn v2-btn--primary" data-account-action-submit disabled>${escapeHtml(t('Confirm'))}</button></div></form></dialog>`
}

export function renderV2WhmAccountList(t: Translate, props: WhmSurfaceProps, authority?: SurfaceAuthority): string {
  const canManage = authority ? authority.presentation === 'live' && authority.canManage : props.capabilityUnavailable !== true
  const principal = principalOf(props)
  const list: AccountListModel = principal ? accountListModel({ principal, activeReseller: props.activeReseller, accounts: readableAccounts(props, authority?.presentation === 'read-only' ? authority : undefined), plans: props.plans, resellers: props.resellers }) : { state: 'forbidden', accounts: [], owners: [], plans: [] }
  const empty = list.state === 'forbidden' ? t('Account listing is not permitted.') : list.state === 'unavailable' ? t('The account list is unavailable.') : t('No accounts.')
  // The bulk bar renders disabled; the bulk client enables only the actions this caller may run through the bulk API.
  const root = principal?.kind === 'root', listed = list.state === 'ready' || list.state === 'empty'
  const canSuspend = listed && canManage && allowed(props, 'suspend-account')
  const canPlan = listed && canManage && qualified(props, 'modify-account') && allowed(props, 'edit-account') && (root || allowed(props, 'change-plan'))
  const canOwner = listed && canManage && root && qualified(props, 'modify-account') && props.resellers !== undefined
  const plans = canPlan ? (props.plans ?? []).filter(plan => root || plan.ownerId === null || plan.ownerId === principal?.id) : []
  const owners = canOwner ? [{ id: '', username: 'root' }, ...(props.resellers ?? [])] : []
  const choices = `<div class="v2-whm-accounts__bulk-choices">${formField({ id: 'v2-account-bulk-plan', label: t('Plan for selected accounts'), control: { kind: 'select', disabled: true, options: plans.map(plan => ({ value: plan.id, label: plan.name })), hooks: { 'data-account-bulk-plan-choice': true } } })}${formField({ id: 'v2-account-bulk-owner', label: t('Owner for selected accounts'), control: { kind: 'select', disabled: true, options: owners.map(owner => ({ value: owner.id, label: owner.username })), hooks: { 'data-account-bulk-owner-choice': true } } })}</div>`
  const bulk = `<div class="v2-whm-accounts__bulk" data-approved-account-bulk${hookAttrs({ 'data-account-bulk-suspend': String(canSuspend), 'data-account-bulk-plan': String(canPlan), 'data-account-bulk-owner': String(canOwner) })}><label class="v2-whm-accounts__selection"><input type="checkbox" data-account-select-all disabled><span>${escapeHtml(t('Select loaded accounts'))}</span></label><output data-account-selected-count>${escapeHtml(t('0 selected'))}</output>${([['suspend', 'Suspend'], ['unsuspend', 'Unsuspend'], ['plan', 'Change plan'], ['owner', 'Change owner'], ['clear', 'Clear selection']] as const).map(([name, label]) => `<button type="button" class="v2-btn" data-account-bulk-control="${name}" disabled>${escapeHtml(t(label))}</button>`).join('')}${choices}<p class="v2-muted">${escapeHtml(t('Selected accounts change one at a time with the same checks as each account’s own action, up to 25 per request. Each result is listed here; nothing is retried automatically.'))}</p><p data-account-bulk-status role="status" hidden></p><ol class="v2-whm-accounts__bulk-results" data-account-bulk-results hidden></ol></div>`
  const statsLock = (engine: string, label: string): string => formField({ id: `v2-web-stats-lock-${engine}`, label, control: { kind: 'select', disabled: true, options: [{ value: '', label: t(msgid('Users choose')) }, { value: 'on', label: t(msgid('Locked on')) }, { value: 'off', label: t(msgid('Locked off')) }], hooks: { 'data-web-stats-lock': engine } } })
  const statsLocks = principal?.kind === 'reseller' ? `<section class="v2-whm-accounts__bulk" data-web-stats-locks${hookAttrs({ 'data-web-stats-enabled': String(listed && canManage && qualified(props, 'metrics-editor')) })} aria-labelledby="v2-web-stats-locks-heading"><h2 id="v2-web-stats-locks-heading">${escapeHtml(t(msgid('Statistics engine locks')))}</h2><p>${escapeHtml(t(msgid('A lock holds an engine on or off for every account you own, and account owners cannot change it. An engine root has not made available stays off.')))}</p><div class="v2-whm-accounts__lock-choices">${statsLock('analog', 'Analog')}${statsLock('awstats', 'AWStats')}${statsLock('webalizer', 'Webalizer')}</div><button type="button" class="v2-btn v2-btn--primary" data-web-stats-locks-save disabled>${escapeHtml(t(msgid('Save')))}</button><p data-web-stats-locks-status role="status" data-state="unread">${escapeHtml(t(msgid('The statistics locks have not been read.')))}</p></section>` : ''
  // Status quick filters: the account list client binds data-list-state-chip to its status filter.
  const quick = filterBar({ segments: { label: t('Status'), options: ([['', 'All'], ['active', 'Active'], ['suspended', 'Suspended'], ['terminating', 'Terminating']] as const).map(([value, label]) => ({ label: t(label), count: value ? list.accounts.filter(account => account.status === value).length : list.accounts.length, pressed: value === '', hooks: { 'data-list-state-chip': value } })) } })
  const columns = [t('Select'), t('Account'), t('Primary domain'), t('Usage'), t('Status'), t('Plan'), t('IO write cap'), t('Actions')]
  const table = `<div class="v2-table-scroll" role="region" aria-labelledby="v2-whm-accounts-list" tabindex="0"><table class="v2-table v2-whm-accounts__table"><caption class="v2-sr">${escapeHtml(t('Accounts'))}</caption><thead><tr>${columns.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${list.accounts.map(account => row(t, props, account, canManage)).join('') || `<tr><td colspan="${columns.length}"><p role="status">${escapeHtml(empty)}</p></td></tr>`}</tbody></table></div><p class="v2-muted v2-whm-accounts__note">${escapeHtml(props.accountUsage ? t(msgctxt('theme:v2', 'Usage / configured plan limit. An account the host did not report shows Not read.')) : t('Usage / configured plan limit. Usage has not been read.'))}</p>`
  return `<div class="v2-layout v2-whm-accounts" data-accounts-workspace data-account-detail-workspace="/whm/accounts" tabindex="-1">${pageHeader(t, { breadcrumb: [{ label: t('Home'), href: '/whm' }, { label: t('Accounts') }], route: '/whm/accounts', title: t('Accounts'), description: t(msgctxt('theme:v2', 'Hosting accounts, their configured plans and authorized actions.')), ...(root || (canManage && canCreate(props)) ? { actionsHtml: `${root ? `<a href="/whm/plans" class="v2-btn">${escapeHtml(t('Plans'))}</a>` : ''}${canManage && canCreate(props) ? `<a href="/whm/accounts/new" class="v2-btn v2-btn--primary">${escapeHtml(t('Create account'))}</a>` : ''}` } : {}) })}${root && listed ? notice(t, { tone: 'info', text: t(msgctxt('theme:v2', 'Resellers see only the accounts they own.')) }) : ''}<div class="v2-whm-accounts__body">${card({ title: t(msgctxt('theme:v2', 'Account list')), titleId: 'v2-whm-accounts-list', ...(listed ? { description: `${t(msgctxt('theme:v2', '{count, plural, one {# account in total.} other {# accounts in total.}}'), { count: list.accounts.length })} ${t(msgctxt('theme:v2', 'Newest first.'))}`, actionsHtml: quick } : {}), flush: true, bodyHtml: `<div class="v2-inset">${listed ? filters(t, list) : ''}${bulk}${statsLocks}</div>${table}` })}${detailAside(t, props, list.accounts, canManage)}</div>${actionDialog(t, principal?.kind === 'root')}</div>`
}

// The fold chevron is drawn from the inline-end border, the left edge in RTL, so RTL turns it the other way to keep pointing down (up when open).
export const WHM_ACCOUNTS_CSS = `${stateTones('.v2-whm-accounts [data-account-status]', 'data-state', { active: 'ok', suspended: 'warn', terminating: 'bad', 'verification-required': 'warn' })}
.v2-whm-accounts .v2-btn,.v2-whm-accounts .v2-segmented>button,.v2-whm-accounts__opener{min-inline-size:var(--target);min-block-size:var(--target)}
.v2-whm-accounts :is(.v2-btn,.v2-segmented>button,.v2-whm-accounts__opener,.v2-whm-accounts__fold>summary){transition:background-color 140ms ease-out,border-color 140ms ease-out,color 140ms ease-out,box-shadow 140ms ease-out,opacity 140ms ease-out,transform 140ms ease-out}
.v2-whm-accounts__table tbody tr{transition:background-color 140ms ease-out}
.v2-whm-accounts__table tbody tr:hover{background:var(--subtle)}
@media(prefers-reduced-motion:reduce){.v2-whm-accounts :is(.v2-btn,.v2-segmented>button,.v2-whm-accounts__opener,.v2-whm-accounts__fold>summary),.v2-whm-accounts__table tbody tr{transition:none}}
.v2-whm-accounts__filters{display:grid;grid-template-columns:2fr repeat(3,minmax(0,1fr)) auto;align-items:end;gap:var(--space-2)}
.v2-whm-accounts__filters>[data-list-count]{font-size:13px}
.v2-whm-accounts__filters>[data-list-count],.v2-whm-accounts [data-account-selected-count],.v2-whm-accounts__pager [data-list-page],.v2-whm-accounts [data-list-state-chip] .v2-count,.v2-whm-accounts__opener small,.v2-whm-accounts [data-account-table-value=ip],.v2-whm-accounts [data-account-table-value=io-write],.v2-whm-accounts__detail-body .v2-facts dd,.v2-whm-accounts__identity dd,.v2-whm-account-limit-grid input[type=text]{font-variant-numeric:tabular-nums}
.v2-whm-accounts__empty{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;gap:var(--space-2);padding:var(--space-4) var(--space-3);border:1px dashed var(--line-strong);border-radius:var(--radius-notice);background:var(--subtle);text-align:center}
.v2-whm-accounts__empty[hidden]{display:none}
.v2-whm-accounts__empty>p{margin:0;font-weight:600}
.v2-whm-accounts__filters>:is(p,nav){grid-column:1/-1}
.v2-whm-accounts__bulk,.v2-whm-accounts__pager,.v2-whm-accounts__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-whm-accounts__bulk{margin-block-start:var(--space-3)}
.v2-whm-accounts [data-approved-account-bulk]:has(:is([data-account-selection],[data-account-select-all]):checked),.v2-whm-accounts [data-web-stats-locks]{padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
.v2-whm-accounts__bulk>h2{margin:0;font-size:16px;line-height:1.4;font-weight:600}
.v2-whm-accounts [data-account-selected-count]{font-size:13px;font-weight:600;color:var(--text)}
.v2-page:not(:has(:is([data-account-selection],[data-account-select-all]):checked)) [data-approved-account-bulk]>:is([data-account-bulk-control],.v2-whm-accounts__bulk-choices,p.v2-muted){display:none}
.v2-whm-accounts__note{margin:0;padding:var(--space-2) var(--space-3);border-block-start:1px solid var(--line);font-size:13px}
@media(min-width:601px){.v2-whm-accounts__quota>span{white-space:nowrap}.v2-whm-accounts__table td.v2-whm-accounts__actions{display:table-cell;text-align:end;white-space:nowrap}.v2-whm-accounts__table td.v2-whm-accounts__actions>*{vertical-align:middle;margin-inline-start:var(--space-1)}.v2-whm-accounts__table th:last-child{text-align:end}.v2-whm-accounts__table :is(th,td):first-child{inline-size:48px;padding-inline-end:0}}
@media(max-width:600px){.v2-whm-accounts__table [data-phone-label]{grid-column:1/-1;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px var(--space-2)}.v2-whm-accounts__table [data-phone-label]::before{content:attr(data-phone-label);margin-inline-end:auto;color:var(--muted)}.v2-whm-accounts__table [data-phone-label]>*{text-align:end}.v2-whm-accounts__table tr>td:first-child{grid-column:auto}.v2-whm-accounts__table tr>td:nth-child(3):not([data-phone-label]){grid-column:1/-1;grid-row:auto;justify-self:start;text-align:start;overflow-wrap:anywhere}.v2-whm-accounts__table tr>td:nth-child(4){grid-column:1/-1}.v2-whm-accounts__table td .v2-whm-accounts__quota{flex-direction:row;flex-wrap:wrap;justify-content:space-between;align-items:baseline}.v2-whm-accounts__table td .v2-whm-accounts__quota>.v2-bar{flex-basis:100%}.v2-whm-accounts__table [data-phone-label]>.v2-whm-accounts__stack{align-items:flex-end}.v2-whm-accounts__table tr>td:has([data-account-status]){grid-column:2;grid-row:1;justify-self:end;align-self:center}}
.v2-whm-accounts__bulk>:is(h2,p,ol,.v2-whm-accounts__bulk-choices,.v2-whm-accounts__lock-choices){flex-basis:100%}
.v2-whm-accounts__lock-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:var(--space-2)}
.v2-whm-accounts__bulk-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-whm-accounts__bulk-results{display:flex;flex-direction:column;gap:var(--space-1);margin:0;padding:0;list-style:none}
.v2-whm-accounts__bulk-results>li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-2)}
.v2-whm-accounts__table :is(th,td){text-align:start;vertical-align:middle}
.v2-whm-accounts__table{inline-size:100%}
.v2-whm-accounts__table :is(th,td){padding-inline:12px}
@media(min-width:601px) and (max-width:1439px){.v2-whm-accounts__table :is(th,td){padding-inline:6px}.v2-whm-accounts__table :is(th,td):first-child{padding-inline-start:12px}.v2-whm-accounts__table :is(th,td):last-child{padding-inline-end:12px}.v2-whm-accounts__table th{white-space:normal}}
@media(min-width:601px){.v2-whm-accounts__table :is(th,td):nth-child(3){inline-size:22%}}
.v2-whm-accounts__table td .v2-whm-accounts__quota{gap:2px}
.v2-whm-accounts__table td .v2-mono{overflow-wrap:anywhere}
@media(min-width:601px){.v2-whm-accounts__table td:nth-child(3) .v2-whm-accounts__stack>span.v2-mono{overflow-wrap:normal}}
.v2-whm-accounts__opener strong{white-space:nowrap}
.v2-whm-accounts__opener:hover strong{color:var(--accent)}
.v2-menu__list .v2-whm-accounts__handoff{align-items:stretch;inline-size:100%}
.v2-menu__list [data-handoff-status]{padding:0 12px 8px;font-size:12px;color:var(--muted)}
.v2-menu__list [data-handoff-status][hidden]{display:none}
.v2-whm-accounts__stack{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-whm-accounts__stack>small,.v2-whm-accounts__quota>small,.v2-whm-accounts__opener small{font-size:12px}
.v2-whm-accounts__usage{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-whm-accounts__usage>.v2-whm-accounts__quota>span{font-weight:600;font-variant-numeric:tabular-nums}
.v2-whm-accounts__selection{display:inline-flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);min-inline-size:var(--target)}
.v2-whm-accounts__table td:first-child .v2-whm-accounts__selection{justify-content:center}
.v2-whm-accounts__quota>.v2-bar{align-self:stretch;min-inline-size:72px;max-inline-size:160px}
.v2-whm-accounts__usage .v2-bar{max-inline-size:none}
.v2-whm-accounts__quota>span{font-size:13px;font-variant-numeric:tabular-nums}
.v2-whm-accounts__quota,.v2-whm-accounts__handoff{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1)}
.v2-whm-accounts__body{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:var(--space-3);min-inline-size:0}
@media(min-width:1700px){.v2-whm-accounts[data-account-detail-selected] .v2-whm-accounts__body{grid-template-columns:minmax(0,1fr) minmax(360px,440px)}}
@media(max-width:1699px){.v2-whm-accounts .v2-whm-accounts__detail-aside{position:fixed;inset-block:0;inset-inline-end:0;z-index:75;inline-size:min(440px,100%);overflow-y:auto;overscroll-behavior:contain;border-radius:0;border-block:0;border-inline-end:0;box-shadow:0 0 0 100vmax var(--scrim),0 0 32px rgba(0,0,0,.24)}}
.v2-whm-accounts__body>*,.v2-whm-accounts__detail-body,.v2-whm-accounts__detail-summary>div{min-inline-size:0}
.v2-whm-accounts__opener{display:inline-flex;align-items:center;gap:var(--space-2);min-block-size:var(--target);max-inline-size:100%;padding:0;border:0;background:transparent;color:var(--text);font:inherit;text-align:start;cursor:pointer}
.v2-whm-accounts__opener>span:last-child{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-whm-accounts__opener[aria-expanded=true]{color:var(--accent)}
.v2-whm-accounts__avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;inline-size:40px;block-size:40px;border-radius:var(--radius-control);background:var(--accent-soft);color:var(--accent);font-family:var(--font-mono);font-weight:600}
.v2-whm-accounts__detail-aside{border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow)}
.v2-whm-accounts__detail-header{position:sticky;inset-block-start:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:var(--space-1);padding-block:var(--space-2);padding-inline:var(--space-3) var(--space-2);border-block-end:1px solid var(--line);border-start-start-radius:inherit;border-start-end-radius:inherit;background:var(--surface)}
.v2-whm-accounts__fold{border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--surface)}
.v2-whm-accounts__fold[open]{border-color:var(--line-strong)}
.v2-whm-accounts__fold>summary{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);min-block-size:var(--target);padding-inline:var(--space-2);font-size:14px;font-weight:600;cursor:pointer;list-style:none;border-radius:inherit}
.v2-whm-accounts__fold>summary::-webkit-details-marker{display:none}
.v2-whm-accounts__fold>summary::after{content:"";flex:none;inline-size:8px;block-size:8px;border-inline-end:2px solid var(--muted);border-block-end:2px solid var(--muted);transform:rotate(45deg);margin-block-end:4px}
.v2-whm-accounts__fold[open]>summary::after{transform:rotate(225deg);margin-block:4px 0}
.v2-whm-accounts__fold>summary:dir(rtl)::after{transform:rotate(-45deg)}
.v2-whm-accounts__fold[open]>summary:dir(rtl)::after{transform:rotate(135deg)}
.v2-whm-accounts__fold>summary:hover{background:var(--subtle)}
.v2-whm-accounts__fold>summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.v2-whm-accounts__fold[open]>summary{border-block-end:1px solid var(--line);border-end-start-radius:0;border-end-end-radius:0}
.v2-whm-accounts__fold>:not(summary){padding:var(--space-2)}
.v2-whm-accounts__fold .v2-btn{align-self:flex-start}
.v2-whm-account-limit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-whm-account-limit-grid .v2-field{min-inline-size:0}
.v2-whm-account-limit-grid input[type=text]{inline-size:100%;min-inline-size:0}
.v2-whm-accounts__detail-body>.v2-whm-accounts__handoff{align-items:stretch}
.v2-whm-accounts__detail-body>.v2-whm-accounts__handoff>[hidden]{display:none}
.v2-whm-accounts__detail-header h2,.v2-whm-accounts__dialog h2{margin:0;font-size:18px;line-height:1.35;font-weight:600}
.v2-whm-accounts__dialog [data-account-dialog-description]{margin:0;font-size:14px;line-height:1.55;color:var(--muted)}
.v2-whm-accounts__detail-group h3,.v2-whm-accounts__mutation h4,.v2-whm-accounts [data-account-limits-readonly]>h4{margin:0;font-size:14px;line-height:1.45;font-weight:600}
.v2-whm-accounts__detail-summary .v2-whm-accounts__avatar{inline-size:48px;block-size:48px;font-size:20px;border-radius:var(--radius-control)}
.v2-whm-accounts__detail-close{flex:none;inline-size:var(--target);padding:0;font-size:24px}
.v2-whm-accounts__detail-body,.v2-whm-accounts__detail-group,.v2-whm-accounts__mutation{display:flex;flex-direction:column;gap:var(--space-3)}
.v2-whm-accounts__mutation{gap:var(--space-2)}
.v2-whm-accounts__state-actions{display:flex;flex-wrap:wrap;gap:var(--space-1)}
.v2-whm-accounts__state-actions>.v2-btn{flex:1 1 auto}
.v2-whm-accounts__state-actions>[data-action$=suspend-account]{border-color:var(--warn);color:var(--warn)}
.v2-whm-accounts__state-actions>.v2-btn--danger{background:var(--bad-soft);color:var(--bad)}
.v2-whm-accounts__detail-body{padding:var(--space-3)}
.v2-whm-accounts__detail-group{gap:var(--space-2)}
.v2-whm-accounts__detail-summary{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
.v2-whm-accounts__detail-summary p{margin:0;overflow-wrap:anywhere}
.v2-whm-accounts__detail-summary p:first-child{font-size:15px;font-weight:600}
.v2-whm-accounts__detail-summary p+p{font-size:13px}
.v2-whm-accounts__detail-body .v2-facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:0 var(--space-2)}
.v2-whm-accounts__detail-body .v2-facts>div{display:flex;flex-direction:column;gap:2px;min-inline-size:0;padding-block:var(--space-1);border-block-start:1px solid var(--line);text-align:start}
.v2-whm-accounts__detail-body .v2-facts dt{font-size:12px}
.v2-whm-accounts__detail-body .v2-facts>div:only-child{grid-column:1/-1}
.v2-whm-accounts__detail-body .v2-facts dd{margin:0;font-size:13px;overflow-wrap:anywhere;unicode-bidi:plaintext}
.v2-whm-accounts [data-account-detail-panel][hidden],.v2-whm-accounts [data-account-detail-for][hidden]{display:none!important}
.v2-whm-accounts__dialog{inline-size:min(560px,calc(100% - 32px));padding:var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-card);background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.v2-whm-accounts__dialog::backdrop{background:var(--scrim)}
.v2-whm-accounts__identity{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);margin:0;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
.v2-whm-accounts__identity>div{display:flex;flex-direction:column;gap:var(--space-1);text-align:start}
.v2-whm-accounts__identity dd{margin:0;overflow-wrap:anywhere;font-family:var(--font-mono);font-size:13px}
.v2-whm-accounts__identity dt{font-size:12px;color:var(--muted)}
.v2-whm-accounts .v2-field>label,.v2-whm-accounts__identity dt,.v2-whm-accounts__detail-body .v2-facts dt{text-box-trim:trim-end;text-box-edge:text}
.v2-whm-accounts__identity dd,.v2-whm-accounts__detail-body .v2-facts dd{text-box-trim:trim-start;text-box-edge:text}
.v2-whm-accounts__dialog .v2-whm-accounts__actions{justify-content:flex-end}
.v2-whm-accounts__dialog:has([data-account-confirm-field]:not([hidden])) [data-account-action-submit]:not(:disabled){border-color:var(--bad);background:var(--bad);color:var(--surface)}
@media(max-width:1000px){.v2-whm-accounts__filters{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-whm-accounts__clear{justify-self:start}}
@media(max-width:640px){.v2-whm-accounts .v2-inset,.v2-whm-accounts__note,.v2-whm-accounts__dialog,.v2-whm-accounts__detail-header,.v2-whm-accounts__detail-body{padding:var(--space-2)}}
@media(max-width:600px){.v2-whm-accounts__filters,.v2-whm-accounts__identity,.v2-whm-accounts__bulk-choices{grid-template-columns:1fr}.v2-whm-account-limit-grid{grid-template-columns:1fr}}
`
