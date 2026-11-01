import type { Account } from '@xpanel/core'
import { formatAsciiBytes } from '../../../../../display-format.ts'
import type { SurfaceAuthority } from '../../../../../models/theme-surface.ts'
import type { Translate } from '../../../../../i18n.ts'
import { accountListModel, type AccountListModel } from '../../../../../models/account-list.ts'
import { accountFor, allowed, canCreate, principalOf, qualified, readableAccounts } from '../../../../../models/whm-account-access.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/card.ts'
import { formField } from '../../../components/form-field.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { rowMenu, type RowMenuItem } from '../../../components/row-menu.ts'
import { stateTones } from '../../../components/status-pill.ts'
import { escapeHtml, hookAttrs } from '../../../html.ts'
import { factList } from '../../../layouts/common.ts'

const ltr = (value: string | number): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`

function filters(t: Translate, model: AccountListModel): string {
  const choices = (items: readonly { value: string; label: string }[], all: string) => [{ value: '', label: all }, ...items.map(item => ({ ...item, value: item.value === '' ? 'root' : item.value }))]
  return `<div class="v2-whm-accounts__filters" data-account-list-controls data-list-page-size="20">${formField({ id: 'account-list-search', label: t('Search loaded accounts'), control: { kind: 'input', type: 'search', autocomplete: 'off', hooks: { 'data-list-search-input': true } } })}${formField({ id: 'account-list-owner', label: t('Owner'), control: { kind: 'select', options: choices(model.owners, t('All owners')), hooks: { 'data-list-owner-filter': true } } })}${formField({ id: 'account-list-plan', label: t('Plan'), control: { kind: 'select', options: choices(model.plans, t('All plans')), hooks: { 'data-list-plan-filter': true } } })}${formField({ id: 'account-list-state', label: t('Status'), control: { kind: 'select', options: [{ value: '', label: t('All statuses') }, { value: 'active', label: t('Active') }, { value: 'suspended', label: t('Suspended') }, { value: 'terminating', label: t('Terminating') }], hooks: { 'data-list-state-filter': true } } })}<p class="v2-muted" data-list-count role="status" aria-live="polite"></p><p class="v2-muted" data-list-empty hidden>${escapeHtml(t('No accounts match these filters.'))}</p><nav class="v2-whm-accounts__pager" data-list-pages aria-label="${escapeHtml(t('Loaded account pages'))}" hidden><button type="button" class="v2-btn" data-list-previous>${escapeHtml(t('Previous'))}</button><span class="v2-num" data-list-page></span><button type="button" class="v2-btn" data-list-next>${escapeHtml(t('Next'))}</button></nav></div>`
}

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
  const ownerField = formField({ id: `v2-${account.username}-owner`, label: t('Owner'), control: { kind: 'select', name: 'ownerId', disabled: !ownerEditable, options: [...(!ownerKnown ? [{ value: '', label: t('Owner choices not read') }] : []), ...(owners ?? []).map(owner => ({ value: owner.id, label: owner.username, selected: owner.id === (account.ownerId ?? '') }))] } })
  const ownerBody = `${ownerField}<p class="v2-muted">${escapeHtml(t('Only root may change account ownership.'))}</p><p data-reseller-owner-status role="status" hidden></p><button class="v2-btn" type="${ownerEditable ? 'submit' : 'button'}"${ownerEditable ? '' : ' disabled'}>${escapeHtml(t('Change owner'))}</button>`
  return `<div class="v2-whm-accounts__mutation" data-approved-account-mutations><h4>${escapeHtml(t('Plan and ownership'))}</h4>${planForm}${ownerEditable ? `<form class="v2-form" data-reseller-owner-form data-account-username="${escapeHtml(account.username)}">${ownerBody}</form>` : `<div class="v2-form" data-account-owner-readonly>${ownerBody}</div>`}</div>`
}

function details(t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean): string {
  const principal = principalOf(props)!
  const plan = props.plans?.find(item => item.id === account.planId && (principal.kind === 'root' || item.ownerId === null || item.ownerId === principal.id))
  const owner = account.ownerId === null ? 'root' : principal.kind === 'reseller' && account.ownerId === principal.id ? principal.username : props.resellers?.find(item => item.id === account.ownerId)?.username
  const key = 'v2-account-detail-' + encodeURIComponent(account.username)
  const missing = t('Not read')
  const limit = (value: number | 'unlimited' | undefined, unit = ''): string => value === 'unlimited' ? t('Unlimited')
    : typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) + unit : missing
  const ioWrite = plan?.resources.ioWriteBps
  const ioWriteCap = ioWrite === 'unlimited' ? t('Unlimited')
    : typeof ioWrite === 'number' && Number.isFinite(ioWrite) && ioWrite >= 0 ? `${formatAsciiBytes(ioWrite)}/s` : missing
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
    `<p class="v2-muted">${escapeHtml(t('Usage / configured plan limit. Usage has not been read.'))}</p>` + factList([
      { label: t('Disk'), value: `${missing} / ${limit(plan?.resources.diskMb, ' MiB')}` },
      { label: t('Bandwidth per month'), value: `${missing} / ${limit(plan?.resources.bandwidthMbMonth, ' MiB')}` },
      { label: t('Memory'), value: `${missing} / ${limit(plan?.resources.memoryMb, ' MiB')}` },
      { label: 'CPU', value: `${missing} / ${limit(plan?.resources.cpuPercent, '%')}` },
      { label: t('Processes'), value: `${missing} / ${limit(plan?.resources.maxProcesses)}` },
      { label: t('PHP workers'), value: `${missing} / ${limit(plan?.caps.phpWorkers)}` },
      { label: t('IO write cap'), value: ioWriteCap, ltr: typeof ioWrite === 'number' && Number.isFinite(ioWrite) && ioWrite >= 0 },
    ]))
  const contact = group('contact', t('Contact'), factList([{ label: t('Contact email'), value: account.contactEmail, mono: true }]) + (allowed(props, 'edit-account') ? mutation('contact') : ''))
  const edit = group('actions', t('Actions'), `${allowed(props, 'change-password') ? mutation('password') : ''}${(!canManage || accountFor(props, account.username)) ? planOwnerForms(t, props, account, canManage) : ''}`)
  return `<section class="v2-whm-accounts__detail-body" data-account-detail-for="${escapeHtml(account.username)}" aria-label="${escapeHtml(account.username)}" hidden><div class="v2-whm-accounts__detail-summary"><span class="v2-whm-accounts__avatar" aria-hidden="true">${escapeHtml(account.username.charAt(0).toUpperCase())}</span><div><p class="v2-mono">${ltr(account.username)}</p><p class="v2-muted v2-mono">${ltr(account.primaryDomain)}</p></div></div>${identity}${limits}${contact}${edit}</section>`
}

function detailAside(t: Translate, props: WhmSurfaceProps, accounts: readonly Account[], canManage: boolean): string {
  return `<aside id="v2-account-detail" class="v2-whm-accounts__detail-aside" data-account-details data-account-detail-panel aria-labelledby="v2-account-detail-title" hidden><div class="v2-whm-accounts__detail-header"><h2 id="v2-account-detail-title">${escapeHtml(t(msgctxt('theme:v2', 'Account details')))}</h2><button type="button" class="v2-btn v2-whm-accounts__detail-close" data-account-detail-close aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Close account details')))}"><span aria-hidden="true">×</span></button></div>${accounts.map(account => details(t, props, account, canManage)).join('')}</aside>`
}

function actions(t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean): string {
  if (!canManage) return `<span class="v2-muted">${escapeHtml(t('Read only'))}</span>`
  const attrs = { 'data-account-id': account.id, 'data-username': account.username, 'data-domain': account.primaryDomain } as const
  const items: RowMenuItem[] = []
  if (allowed(props, 'suspend-account') && account.status !== 'terminating') items.push({ label: t(account.status === 'suspended' ? 'Unsuspend' : 'Suspend'), hooks: { 'data-action': account.status === 'suspended' ? 'unsuspend-account' : 'suspend-account', ...attrs } })
  if (allowed(props, 'terminate-account') && account.status !== 'terminating') items.push({ label: t('Delete'), danger: true, hooks: { 'data-action': 'terminate-account', ...attrs } })
  const handoff = allowed(props, 'edit-account') && account.status === 'active'
    ? `<span class="v2-whm-accounts__handoff" data-handoff-control><button type="button" class="v2-btn" data-handoff="xpanel" data-handoff-account="${escapeHtml(account.id)}" data-handoff-state="idle">${escapeHtml(t('Log in to xPanel'))}</button><span data-handoff-status role="status" aria-live="polite" hidden></span></span>` : ''
  return `${handoff}${items.length ? rowMenu({ id: `v2-account-${account.username}-menu`, label: t(msgctxt('theme:v2', 'Actions for {username}'), { username: account.username }), items }) : !handoff ? `<span class="v2-muted">${escapeHtml(t('Read only'))}</span>` : ''}`
}

function row(t: Translate, props: WhmSurfaceProps, account: Account, canManage: boolean): string {
  const principal = principalOf(props)!
  const plan = props.plans?.find(item => item.id === account.planId && (principal.kind === 'root' || item.ownerId === null || item.ownerId === principal.id))
  const owner = account.ownerId === null ? 'root' : principal.kind === 'reseller' && account.ownerId === principal.id ? principal.username : props.resellers?.find(item => item.id === account.ownerId)?.username
  const quota = (value: number | 'unlimited' | undefined): string => `<span>${escapeHtml(t('Not read'))} / ${value === undefined ? escapeHtml(t('Not read')) : value === 'unlimited' ? escapeHtml(t('Unlimited')) : ltr(`${value} MiB`)}</span><small class="v2-muted">${escapeHtml(t('Usage / configured plan limit. Usage has not been read.'))}</small>`
  const ioWrite = plan?.resources.ioWriteBps
  const ioWriteCap = ioWrite === 'unlimited' ? escapeHtml(t('Unlimited'))
    : typeof ioWrite === 'number' && Number.isFinite(ioWrite) && ioWrite >= 0 ? ltr(`${formatAsciiBytes(ioWrite)}/s`) : escapeHtml(t('Not read'))
  const status = account.status === 'active' ? t('Active') : account.status === 'suspended' ? t('Suspended') : t('Terminating')
  const fields = hookAttrs({ 'data-account-row': account.username, 'data-list-search': `${account.username} ${account.primaryDomain}`.toLowerCase(), 'data-list-owner': account.ownerId ?? '', 'data-list-plan': account.planId, 'data-list-state': account.status })
  return `<tr${fields}><td><label class="v2-whm-accounts__selection"><input type="checkbox" value="${escapeHtml(account.username)}" data-account-selection disabled><span class="v2-sr">${escapeHtml(t('Select account'))} ${ltr(account.username)}</span></label></td><td><button type="button" class="v2-whm-accounts__opener" data-account-detail-open="${escapeHtml(account.username)}" aria-controls="v2-account-detail" aria-expanded="false" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Account details')) + ': ' + account.username)}"><span class="v2-whm-accounts__avatar" aria-hidden="true">${escapeHtml(account.username.charAt(0).toUpperCase())}</span><span><strong class="v2-mono">${ltr(account.username)}</strong><small class="v2-muted v2-mono">UID ${ltr(account.uid)}</small></span></button></td><td class="v2-mono">${ltr(account.primaryDomain)}</td><td>${escapeHtml(plan?.name ?? t('Not read'))}</td><td data-account-table-value="owner">${owner ? ltr(owner) : escapeHtml(t('Not read'))}</td><td data-account-table-value="ip">${ltr(account.ipv4)}${account.ipv6 ? `<br>${ltr(account.ipv6)}` : ''}</td><td data-account-table-value="disk"><div class="v2-whm-accounts__quota">${quota(plan?.resources.diskMb)}</div></td><td data-account-table-value="bandwidth"><div class="v2-whm-accounts__quota">${quota(plan?.resources.bandwidthMbMonth)}</div></td><td data-account-table-value="io-write">${ioWriteCap}</td><td><span data-account-status data-state="${account.status}"><span class="v2-pill v2-pill--state"><span class="v2-pill__dot" aria-hidden="true"></span><span data-account-status-label>${escapeHtml(status)}</span></span></span><template data-account-status-pending><span class="v2-pill v2-pill--warn"><span class="v2-pill__dot" aria-hidden="true"></span><span data-account-status-label>${escapeHtml(t('Verification required'))}</span></span></template></td><td class="v2-whm-accounts__actions">${actions(t, props, account, canManage)}</td></tr>`
}

function actionDialog(t: Translate): string {
  return `<dialog class="v2-whm-accounts__dialog" data-account-dialog aria-labelledby="v2-account-dialog-title" aria-describedby="v2-account-dialog-description"><form class="v2-form" method="dialog" data-account-action-form novalidate><h2 id="v2-account-dialog-title" data-account-dialog-title>${escapeHtml(t('Account action'))}</h2><p id="v2-account-dialog-description" data-account-dialog-description></p><dl class="v2-whm-accounts__identity"><div><dt>${escapeHtml(t('Account'))}</dt><dd><bdi dir="ltr" data-account-dialog-username></bdi></dd></div><div><dt>${escapeHtml(t('Primary domain'))}</dt><dd><bdi dir="ltr" data-account-dialog-domain></bdi></dd></div></dl><div class="v2-field" data-account-confirm-field hidden><label for="v2-terminate-confirm-user">${escapeHtml(t('Type the username to confirm'))}</label><input id="v2-terminate-confirm-user" name="confirmUsername" type="text" dir="ltr" autocomplete="off" spellcheck="false" data-type-to-confirm aria-describedby="v2-account-confirm-help"><span id="v2-account-confirm-help">${escapeHtml(t('Must exactly match the account above.'))}</span></div><div class="v2-field" data-account-reason-field hidden><label for="v2-account-suspend-reason">${escapeHtml(t('Suspension reason'))}</label><textarea id="v2-account-suspend-reason" name="reason" rows="2" maxlength="500"></textarea></div><p data-account-action-status role="status" aria-live="polite" tabindex="-1" hidden></p><div class="v2-whm-accounts__actions"><button type="button" class="v2-btn" data-account-action-cancel>${escapeHtml(t('Cancel'))}</button><button type="submit" class="v2-btn v2-btn--primary" data-account-action-submit disabled>${escapeHtml(t('Confirm'))}</button></div></form></dialog>`
}

export function renderV2WhmAccountList(t: Translate, props: WhmSurfaceProps, authority?: SurfaceAuthority): string {
  const canManage = authority ? authority.presentation === 'live' && authority.canManage : props.capabilityUnavailable !== true
  const principal = principalOf(props)
  const list: AccountListModel = principal ? accountListModel({ principal, activeReseller: props.activeReseller, accounts: readableAccounts(props, authority?.presentation === 'read-only' ? authority : undefined), plans: props.plans, resellers: props.resellers }) : { state: 'forbidden', accounts: [], owners: [], plans: [] }
  const empty = list.state === 'forbidden' ? t('Account listing is not permitted.') : list.state === 'unavailable' ? t('The account list is unavailable.') : t('No accounts.')
  const bulk = `<div class="v2-whm-accounts__bulk" data-approved-account-bulk><label class="v2-whm-accounts__selection"><input type="checkbox" data-account-select-all disabled><span>${escapeHtml(t('Select loaded accounts'))}</span></label><output data-account-selected-count>${escapeHtml(t('0 selected'))}</output>${['Suspend', 'Unsuspend', 'Change plan', 'Change owner', 'Clear selection'].map((label, index) => `<button type="button" class="v2-btn" data-account-bulk-control="${index}" disabled>${escapeHtml(t(label))}</button>`).join('')}<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'Use each account’s actions and review its result before continuing.')))}</p></div>`
  const columns = [t('Select'), t('Account'), t('Primary domain'), t('Plan'), t('Owner'), t('IP address'), t('Disk'), t('Bandwidth per month'), t('IO write cap'), t('Status'), t('Actions')]
  const table = `<div class="v2-table-scroll" role="region" aria-labelledby="v2-whm-accounts-list" tabindex="0"><table class="v2-table v2-whm-accounts__table"><caption class="v2-sr">${escapeHtml(t('Accounts'))}</caption><thead><tr>${columns.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${list.accounts.map(account => row(t, props, account, canManage)).join('') || `<tr><td colspan="${columns.length}"><p role="status">${escapeHtml(empty)}</p></td></tr>`}</tbody></table></div>`
  return `<div class="v2-layout v2-whm-accounts" data-accounts-workspace data-account-detail-workspace="/whm/accounts" tabindex="-1">${pageHeader(t, { breadcrumb: [{ label: t('Home'), href: '/whm' }, { label: t('Accounts') }], route: '/whm/accounts', title: t('Accounts'), description: t(msgctxt('theme:v2', 'Hosting accounts, their configured plans and authorized actions.')), ...(canManage && canCreate(props) ? { actionsHtml: `<a href="/whm/accounts/new" class="v2-btn v2-btn--primary">${escapeHtml(t('Create account'))}</a>` } : {}) })}<div class="v2-whm-accounts__body">${card({ title: t('Accounts'), titleId: 'v2-whm-accounts-list', flush: true, bodyHtml: `${list.state === 'ready' || list.state === 'empty' ? `<div class="v2-inset">${filters(t, list)}${bulk}</div>` : ''}${table}` })}${detailAside(t, props, list.accounts, canManage)}</div>${actionDialog(t)}</div>`
}

export const WHM_ACCOUNTS_CSS = `${stateTones('.v2-whm-accounts [data-account-status]', 'data-state', { active: 'ok', suspended: 'warn', terminating: 'bad', 'verification-required': 'warn' })}
.v2-whm-accounts__filters{display:grid;grid-template-columns:2fr repeat(3,minmax(0,1fr));gap:var(--space-2)}
.v2-whm-accounts__filters>:is(p,nav){grid-column:1/-1}
.v2-whm-accounts__bulk,.v2-whm-accounts__pager,.v2-whm-accounts__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-whm-accounts__bulk{margin-block-start:var(--space-3)}
.v2-whm-accounts__bulk>p{flex-basis:100%}
.v2-whm-accounts__table{min-inline-size:1200px}
.v2-whm-accounts__table :is(th,td){text-align:start;vertical-align:top}
.v2-whm-accounts__selection{display:inline-flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-whm-accounts__quota,.v2-whm-accounts__handoff{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1)}
.v2-whm-accounts__body{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:var(--space-3);min-inline-size:0}
.v2-whm-accounts[data-account-detail-selected] .v2-whm-accounts__body{grid-template-columns:minmax(0,1fr) minmax(320px,400px)}
.v2-whm-accounts__body>*,.v2-whm-accounts__detail-body,.v2-whm-accounts__detail-summary>div{min-inline-size:0}
.v2-whm-accounts__opener{display:inline-flex;align-items:center;gap:var(--space-2);min-block-size:var(--target);max-inline-size:100%;padding:0;border:0;background:transparent;color:var(--text);font:inherit;text-align:start;cursor:pointer}
.v2-whm-accounts__opener>span:last-child{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-whm-accounts__opener[aria-expanded=true]{color:var(--accent)}
.v2-whm-accounts__avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;inline-size:40px;block-size:40px;border-radius:var(--radius-control);background:var(--accent-soft);color:var(--accent);font-family:var(--font-mono);font-weight:600}
.v2-whm-accounts__detail-aside{border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);overflow:hidden}
.v2-whm-accounts__detail-header{display:flex;align-items:center;justify-content:space-between;gap:var(--space-1);padding:var(--space-3);border-block-end:1px solid var(--line)}
.v2-whm-accounts__detail-header h2{margin:0;font-size:16px;line-height:1.5}
.v2-whm-accounts__detail-group h3,.v2-whm-accounts__mutation h4{margin:0;font-size:14px;line-height:1.5}
.v2-whm-accounts__detail-summary .v2-whm-accounts__avatar{inline-size:52px;block-size:52px;font-size:22px;border-radius:var(--radius-card)}
.v2-whm-accounts__detail-close{flex:none;inline-size:var(--target);padding:0;font-size:24px}
.v2-whm-accounts__detail-body,.v2-whm-accounts__detail-group,.v2-whm-accounts__mutation{display:flex;flex-direction:column;gap:var(--space-3)}
.v2-whm-accounts__detail-body{padding:var(--space-3)}
.v2-whm-accounts__detail-group{gap:var(--space-2)}
.v2-whm-accounts__detail-summary{display:flex;align-items:center;gap:var(--space-2)}
.v2-whm-accounts__detail-summary p{overflow-wrap:anywhere}
.v2-whm-accounts__detail-body .v2-facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-whm-accounts__detail-body .v2-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-whm-accounts__detail-body .v2-facts dd{margin:0;overflow-wrap:anywhere}
.v2-whm-accounts [data-account-detail-panel][hidden],.v2-whm-accounts [data-account-detail-for][hidden]{display:none!important}
@media(max-width:1100px){.v2-whm-accounts[data-account-detail-selected] .v2-whm-accounts__body{grid-template-columns:minmax(0,1fr)}}
.v2-whm-accounts__dialog{inline-size:min(560px,calc(100% - 32px));padding:var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-card);background:var(--surface);color:var(--text)}
.v2-whm-accounts__dialog::backdrop{background:var(--scrim)}
.v2-whm-accounts__identity{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-whm-accounts__identity>div{display:flex;flex-direction:column;gap:var(--space-1);text-align:start}
.v2-whm-accounts__identity dd{margin:0;overflow-wrap:anywhere}
@media(max-width:800px){.v2-whm-accounts__filters{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.v2-whm-accounts__filters,.v2-whm-accounts__identity{grid-template-columns:1fr}.v2-whm-accounts__dialog,.v2-whm-accounts__detail-header,.v2-whm-accounts__detail-body{padding:var(--space-2)}.v2-whm-accounts__detail-body .v2-facts{grid-template-columns:1fr}}
`
