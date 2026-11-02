import { whmStoredFacts, type WhmStoredFactAuthority } from '../stored-facts.ts'
import { canOpenRegisteredRoute } from '@xpanel/catalog'
import { resolveResourceUsage, type Limit, type Reseller, type ResellerAcl } from '@xpanel/core'
import type { Translate } from '../../../../../i18n.ts'
import { allocated } from '../../../../../models/reseller-allocation.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { escapeHtml } from '../../../html.ts'
import { card } from '../../../components/card.ts'
import { statusPill } from '../../../components/status-pill.ts'
import { meter } from '../../../components/meter.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { dataTable } from '../../../components/data-table.ts'
import { renderV2WhmResellerRecords } from './records.ts'

export interface WhmResellerAuthority extends WhmStoredFactAuthority {
  readonly canRead: boolean
  readonly canManage: boolean
  readonly canChangeOwner: boolean
}
const denied: WhmResellerAuthority = Object.freeze({ canRead: false, canManage: false, canChangeOwner: false })
const aclGroups: readonly { title: string; items: readonly (readonly [ResellerAcl, string])[] }[] = [
  { title: msgid('Accounts'), items: [['list-accounts', msgid('List accounts')], ['create-account', msgid('Create accounts')], ['edit-account', msgid('Modify accounts')], ['suspend-account', msgid('Suspend accounts')], ['terminate-account', msgid('Terminate accounts')], ['change-plan', msgid('Change plan')], ['change-password', msgid('Change passwords')]] },
  { title: msgid('Plans'), items: [['manage-plans', msgid('Manage plans')], ['manage-feature-lists', msgid('Feature lists')], ['allow-unlimited-plans', msgid('Allow unlimited plans')], ['allow-oversell', msgid('Allow overselling')]] },
  { title: msgid('Domains and transfers'), items: [['manage-dns', msgid('Manage DNS')], ['manage-ssl', msgid('Manage SSL/TLS')], ['transfer', msgid('Transfer accounts')]] },
]
const technical = (value: string | number) => `<bdi class="v2-mono v2-num" dir="ltr">${escapeHtml(value)}</bdi>`
const button = (label: string, disabled = false, type: 'button' | 'submit' | 'reset' = 'button') => `<button class="v2-btn${type === 'submit' ? ' v2-btn--primary' : ''}" type="${type}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`
const factList = (rows: readonly { label: string; value: string }[]) => `<dl class="v2-reseller-facts">${rows.map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd>${row.value}</dd></div>`).join('')}</dl>`
const group = (id: string, title: string, bodyHtml: string) => card({ title, titleId: id, bodyHtml })
const anchor = (id: string) => 'v2-reseller-' + id.replace(/[^A-Za-z0-9-]/g, character => '_' + character.codePointAt(0)!.toString(16) + '_')
const value = (t: Translate, limit: Limit | undefined, unit = '') => limit === undefined ? escapeHtml(t('Not read')) : limit === 'unlimited' ? escapeHtml(t('Unlimited')) : technical(`${limit}${unit ? ' ' + unit : ''}`)

function createForm(t: Translate, editable: boolean): string {
  const field = (key: string, label: string, type = 'text', initial = '', min?: number) => `<div class="v2-reseller-field"><label for="reseller-${key}">${escapeHtml(label)}</label><input id="reseller-${key}" name="${key}" type="${type}"${key !== 'password' ? ' dir="ltr"' : ''}${key === 'username' ? ' maxlength="16" autocomplete="off"' : key === 'password' ? ' autocomplete="new-password"' : ' step="1"'}${min === undefined ? '' : ` min="${min}"`} value="${initial}" required${editable ? '' : ' disabled'}></div>`
  const body = `<div class="v2-reseller-fields">${field('username', t('Username'))}${field('password', t('Password'), 'password')}${field('maxAccounts', t('Account limit'), 'number', '10', 0)}${field('totalDiskMb', t('Disk limit (MiB)'), 'number', '10240', 1)}${field('totalBandwidthMb', t('Bandwidth limit (MiB)'), 'number', '102400', 1)}</div><label class="v2-reseller-choice"><input type="checkbox" name="oversell"${editable ? '' : ' disabled'}>${escapeHtml(t('Allow overselling'))}</label><fieldset><legend>${escapeHtml(t('Permissions'))}</legend><div class="v2-reseller-checks">${aclGroups.flatMap(group => group.items).map(([key, label]) => `<label class="v2-reseller-choice"><input type="checkbox" name="acl" value="${key}"${editable ? '' : ' disabled'}>${escapeHtml(t(label))}</label>`).join('')}</div></fieldset><p data-reseller-status role="status" hidden></p>${button(t('Create reseller'), !editable, editable ? 'submit' : 'button')}`
  return editable ? `<form class="v2-reseller-stack" data-reseller-create-form>${body}</form>` : `<div class="v2-reseller-stack" data-whm-readonly-fields>${body}</div>`
}

function detail(t: Translate, props: WhmSurfaceProps, reseller: Reseller | undefined, index: number, readable: boolean, authority: WhmResellerAuthority): string {
  const prefix = `v2-reseller-detail-${index}`, editable = readable && authority.canManage && reseller !== undefined
  const owned = readable && reseller ? props.accounts?.filter(account => account.ownerId === reseller.id) : undefined
  const plans = readable ? props.plans : undefined
  const canMove = editable && authority.canChangeOwner && owned !== undefined && owned.length > 0
  const limits = ([['maxAccounts', msgid('Maximum accounts'), reseller?.maxAccounts, owned?.length, msgid('accounts')], ['totalDiskMb', msgid('Total disk'), reseller?.totalDiskMb, allocated(owned, plans, 'diskMb'), 'MiB'], ['totalBandwidthMb', msgid('Total bandwidth per month'), reseller?.totalBandwidthMb, allocated(owned, plans, 'bandwidthMbMonth'), 'MiB']] as const).map(([name, label, saved, assigned, unit]) => {
    const unlimited = saved === 'unlimited'
    const usage = resolveResourceUsage(assigned, saved)
    const meterProps = usage.kind === 'bounded' ? { percent: usage.fillPercent, tone: usage.threshold === 'critical' ? 'bad' as const : usage.threshold }
      : { tone: usage.kind === 'unbounded-allocation' || usage.kind === 'zero-limit' && usage.exceeded ? 'bad' as const : 'neutral' as const }
    const plain = (amount: Limit | undefined) => amount === undefined ? t('Not read') : amount === 'unlimited' ? t('Unlimited') : String(amount)
    const allocationMeter = meter({ label: t(name === 'maxAccounts' ? msgid('Owned accounts') : msgid('Assigned plan limits')), valueText: plain(assigned) + ' / ' + plain(saved), unit: t(unit), ...meterProps, note: assigned === 'unlimited' ? t('Assigned plans include an unlimited allocation.') : t(name === 'maxAccounts' ? msgid('Creation is refused when the configured account cap is reached.') : msgid('Allocated plan limits are shown above. Actual disk use and current-month traffic have not been read.')) })
    return `<div class="v2-reseller-stack"><div class="v2-reseller-field"><label for="${prefix}-${name}">${escapeHtml(t(label))} (${escapeHtml(t(unit))})</label><input id="${prefix}-${name}" name="${name}" type="number" min="0" step="1" inputmode="numeric" dir="ltr" value="${typeof saved === 'number' ? saved : ''}"${!editable || unlimited ? ' disabled' : ''}><label class="v2-reseller-choice" for="${prefix}-${name}-unlimited"><input id="${prefix}-${name}-unlimited" name="${name}Unlimited" type="checkbox" data-reseller-unlimited-field="${name}"${unlimited ? ' checked' : ''}${editable ? '' : ' disabled'}>${escapeHtml(t('Unlimited'))}</label></div>${allocationMeter}</div>`
  }).join('')
  const privileges = aclGroups.map(group => `<fieldset><legend>${escapeHtml(t(group.title))}</legend><div class="v2-reseller-checks">${group.items.map(([key, label]) => `<label class="v2-reseller-choice"><input name="acl" value="${key}" type="checkbox"${reseller?.acl.includes(key) ? ' checked' : ''}${editable ? '' : ' disabled'}><span>${escapeHtml(t(label))}</span></label>`).join('')}</div></fieldset>`).join('')
  const nameservers = `<div class="v2-reseller-field"><label for="${prefix}-nameservers">${escapeHtml(t('Nameservers, one per line'))}</label><textarea id="${prefix}-nameservers" name="nameservers" rows="3" dir="ltr"${editable ? '' : ' disabled'}>${escapeHtml(reseller?.nameservers.join('\n') ?? '')}</textarea></div>`
  const assignedIps = reseller?.delegatedIps.map(address => {
    const accounts = owned?.filter(account => [account.ipv4, account.ipv6, ...(account.extraIps ?? [])].includes(address))
    const inPool = readable ? props.ipPool?.some(item => item.address === address) : undefined
    const assignment = accounts?.length ? accounts.map(account => account.username).join(', ') : inPool && owned !== undefined ? t('No owned account assignment is recorded') : t('Not read')
    return { cellsHtml: [technical(address), technical(assignment)] }
  }) ?? []
  const delegatedFacts = dataTable(t, { id: prefix + '-ip-assignment', caption: t('Delegated IP addresses'), columns: [t('IP address'), t('Assigned accounts')].map(label => ({ label })), rows: assignedIps, emptyText: t(reseller ? msgid('No delegated addresses are configured.') : msgid('Not read')) })
  const delegated = `${delegatedFacts}<div class="v2-reseller-field"><label for="${prefix}-delegated">${escapeHtml(t('Delegated IP addresses, one per line'))}</label><textarea id="${prefix}-delegated" name="delegatedIps" rows="3" dir="ltr"${editable ? '' : ' disabled'}>${escapeHtml(reseller?.delegatedIps.join('\n') ?? '')}</textarea></div><p>${escapeHtml(t(msgctxt('theme:v2', 'Only stored delegations are shown. Address availability and routing have not been observed.')))}</p>`
  const settings = `<div class="v2-reseller-columns"><div class="v2-reseller-stack">${group(`${prefix}-acl`, t('Privileges'), privileges)}${group(`${prefix}-limits`, t('Capacity and usage'), `<div class="v2-reseller-fields">${limits}</div>`)}</div><aside class="v2-reseller-stack">${group(`${prefix}-oversell`, t('Overselling'), `<label class="v2-reseller-choice"><input name="oversell" type="checkbox"${reseller?.oversell ? ' checked' : ''}${editable ? '' : ' disabled'}>${escapeHtml(t('Allow overselling'))}</label><p>${escapeHtml(t('With overselling off, account creation is refused if total plan limits exceed the reseller’s disk or bandwidth cap.'))}</p>`)}${group(`${prefix}-ns`, t('Nameservers'), nameservers)}${group(`${prefix}-ips`, t('Delegated IP addresses'), delegated)}</aside></div><div class="v2-reseller-savebar">${button(t('Suspend reseller'), true)}<p role="status" data-wiring="soon">${escapeHtml(t(msgctxt('theme:v2', 'Reseller suspension is unavailable. No suspension request has been sent.')))}</p><div class="v2-reseller-actions">${editable ? `<p data-reseller-update-status role="status"></p>${button(t('Discard changes'), false, 'reset')}${button(t('Save reseller'), false, 'submit')}` : `${button(t('Discard changes'), true)}${button(t('Save reseller'), true)}`}</div></div>`
  const update = editable ? `<form class="v2-reseller-stack" data-reseller-update-form data-reseller-id="${escapeHtml(reseller.id)}">${settings}</form>` : `<div class="v2-reseller-stack" data-readonly="true">${settings}</div>`
  const ownerForms = owned?.map(account => `<form class="v2-reseller-fields" data-reseller-owner-form data-account-username="${escapeHtml(account.username)}"><div class="v2-reseller-field"><label for="${prefix}-owner-${escapeHtml(account.username)}">${escapeHtml(t('New owner of'))} ${technical(account.username)}</label><select id="${prefix}-owner-${escapeHtml(account.username)}" name="ownerId"${canMove ? '' : ' disabled'}><option value="">${escapeHtml(t('Root'))}</option>${props.resellers?.map(owner => `<option value="${escapeHtml(owner.id)}"${owner.id === reseller?.id ? ' selected' : ''}>${escapeHtml(owner.username)}</option>`).join('') ?? ''}</select></div><div class="v2-reseller-actions">${button(t('Change owner'), !canMove, 'submit')}<p data-reseller-owner-status role="status"></p></div></form>`).join('')
  const ownership = `<section id="${prefix}-ownership" class="v2-reseller-stack" data-reseller-ownership><h3>${escapeHtml(t('Change ownership'))}</h3><p>${escapeHtml(t('Moves an account to another owner. Only who manages the account changes.'))}</p>${canMove ? ownerForms : `<div class="v2-reseller-fields"><div class="v2-reseller-field"><label for="${prefix}-owner-account">${escapeHtml(t('Account'))}</label><select id="${prefix}-owner-account" disabled><option>${escapeHtml(t('Select an account'))}</option></select></div>${button(t('Change owner'), true)}</div>`}<p>${escapeHtml(t('The server validates the destination capacity, plan access and current account configuration. No transfer has been performed by this view.'))}</p></section>`
  const accountRows = (owned ?? []).map(account => {
    const plan = plans?.find(plan => plan.id === account.planId)
    return { cellsHtml: [technical(account.username), technical(account.primaryDomain), escapeHtml(plan?.name ?? t('Not read')), `${value(t, plan?.resources.diskMb, 'MiB')}<span class="v2-muted">${escapeHtml(t('Actual use not read'))}</span>`, statusPill({ tone: account.status === 'active' ? 'ok' : 'warn', label: t(account.status === 'active' ? msgid('Active') : msgid('Suspended')) })] }
  })
  const accountTable = dataTable(t, { id: `${prefix}-accounts`, caption: t('Owned accounts'), columns: [t('Account'), t('Domain'), t('Plan'), t('Disk allocation'), t('Status')].map(label => ({ label })), rows: accountRows, emptyText: t(owned === undefined ? msgid('Not read') : msgid('No accounts are owned by this reseller.')) })
  const ownedPlans = readable && reseller ? props.plans?.filter(plan => plan.ownerId === reseller.id) : undefined
  const header = `<header class="v2-reseller-header"><h2 id="${prefix}-heading">${reseller ? technical(reseller.username) : escapeHtml(t('Reseller details'))}</h2>${reseller ? statusPill({ tone: reseller.oversell ? 'warn' : 'ok', label: t(reseller.oversell ? msgid('Overselling on') : msgid('Overselling off')) }) : ''}<span class="v2-muted">${escapeHtml(t('Sign-in state not read'))}</span>${factList([{ label: t('Contact'), value: escapeHtml(t('Not read')) }, { label: t('Created'), value: escapeHtml(t('Not read')) }, { label: t('Owns'), value: value(t, owned?.length) }, { label: t('Own plans'), value: ownedPlans === undefined ? escapeHtml(t('Not read')) : ownedPlans.map(plan => escapeHtml(plan.name)).join(', ') || escapeHtml(t('None')) }, { label: t('Last sign-in'), value: escapeHtml(t('Not read')) }])}</header>`
  return `<section class="v2-reseller-detail" id="${reseller ? anchor(reseller.id) : 'v2-reseller-empty'}" data-reseller-detail="${index}" aria-labelledby="${prefix}-heading"${index === 0 ? ' data-reseller-default' : ''}>${header}${group(`${prefix}-owned`, t('Owned accounts'), ownership + accountTable)}${update}</section>`
}

export function renderV2WhmResellers(t: Translate, props: WhmSurfaceProps, authority: WhmResellerAuthority = denied): string {
  const route = props.activeRoute === '/whm/resellers/privileges' ? props.activeRoute : '/whm/resellers'
  const principal = props.visibility?.principal ?? props.principal
  const nativeRead = authority.presentation !== 'read-only' && authority.canRead && props.capabilityUnavailable !== true
  const readable = (nativeRead || whmStoredFacts(props, authority, ['reseller-center'], route)) && principal?.kind === 'root'
    && canOpenRegisteredRoute(route, { ...props.visibility, principal })
  // A reseller record grant never grants account, plan or IP-pool collections.
  if (authority.presentation === 'read-only') {
    props = { ...props, accounts: whmStoredFacts(props, authority, ['list-accounts'], route) ? props.accounts : undefined,
      plans: whmStoredFacts(props, authority, ['edit-package', 'add-package'], route) ? props.plans : undefined,
      ipPool: undefined }
    authority = { ...authority, canManage: false, canChangeOwner: false }
  }
  const resellers = readable ? props.resellers : undefined
  const rows = (resellers ?? []).map(reseller => {
    const owned = props.accounts?.filter(account => account.ownerId === reseller.id)
    return { cellsHtml: [technical(reseller.username), `${value(t, owned?.length)} / ${value(t, reseller.maxAccounts)}`, `${value(t, allocated(owned, props.plans, 'diskMb'), 'MiB')} / ${value(t, reseller.totalDiskMb, 'MiB')}`, `${value(t, allocated(owned, props.plans, 'bandwidthMbMonth'), 'MiB')} / ${value(t, reseller.totalBandwidthMb, 'MiB')}`, statusPill({ tone: reseller.oversell ? 'warn' : 'ok', label: t(reseller.oversell ? msgid('Overselling on') : msgid('Overselling off')) }), reseller.nameservers.map(technical).join('<br>'), escapeHtml(t('Sign-in state not read')), `<a class="v2-btn" href="#${anchor(reseller.id)}" data-reseller-open="${anchor(reseller.id)}">${escapeHtml(t('Open'))}</a>`] }
  })
  const list = dataTable(t, { id: 'v2-reseller-list', caption: t(msgctxt('theme:v2', 'All resellers')), columns: [t('Reseller'), t('Accounts'), t(msgctxt('theme:v2', 'Disk allocated')), t(msgctxt('theme:v2', 'Bandwidth allocated')), t('Overselling'), t('Nameservers'), t('Status'), t('Actions')].map(label => ({ label })), rows, emptyText: t(resellers === undefined ? msgid('Reseller data has not been read. Unavailable actions are disabled.') : msgctxt('theme:v2', 'No resellers were returned.')) })
  const totals = factList([{ label: t('Resellers'), value: resellers === undefined ? escapeHtml(t('Not read')) : technical(resellers.length) }, { label: t('Owned accounts'), value: readable && props.accounts !== undefined ? technical(props.accounts.filter(account => account.ownerId !== null).length) : escapeHtml(t('Not read')) }, { label: t(msgctxt('theme:v2', 'Actual disk use')), value: escapeHtml(t('Not read')) }, { label: t(msgctxt('theme:v2', 'Current-month traffic')), value: escapeHtml(t('Not read')) }])
  const clean = readable ? props : { ...props, accounts: undefined, plans: undefined, resellers: undefined, ipPool: undefined }
  return `<section class="v2-resellers" data-approved-whm-resellers data-workspace-mode="${nativeRead ? 'qualified' : 'read-only'}">${pageHeader(t, { title: t(route.endsWith('privileges') ? msgid('Reseller privileges') : msgid('Resellers')), route, description: t('With overselling off, account creation is refused if total plan limits exceed the reseller’s disk or bandwidth cap.'), breadcrumb: [{ label: t('Home'), href: '/whm' }, { label: t('Resellers') }] })}${!readable ? `<p role="status">${escapeHtml(t('Reseller data has not been read. Unavailable actions are disabled.'))}</p>` : ''}${totals}${group('v2-reseller-list-heading', t(msgctxt('theme:v2', 'All resellers')), list)}${group('v2-reseller-create-heading', t('New reseller'), createForm(t, readable && authority.canManage))}<div class="v2-reseller-details">${(resellers?.length ? resellers : [undefined]).map((reseller, index) => detail(t, clean, reseller, index, readable, authority)).join('')}</div></section>`
}

export { renderV2WhmResellerRecords } from './records.ts'
export { WHM_RESELLERS_CSS } from './styles.ts'

export function renderV2WhmResellerPage(t: Translate, props: WhmSurfaceProps, authority: WhmResellerAuthority = denied): string | undefined {
  if (props.activeRoute === '/whm/resellers' || props.activeRoute === '/whm/resellers/privileges') return renderV2WhmResellers(t, props, authority)
  return renderV2WhmResellerRecords(t, props, authority)
}
