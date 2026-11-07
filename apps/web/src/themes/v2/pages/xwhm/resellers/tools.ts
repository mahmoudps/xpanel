import type { Reseller, ResellerAcl } from '@xpanel/core'
import type { Translate } from '../../../../../i18n.ts'
import { measuredTotalText } from '../../../../../models/reseller-usage.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { escapeHtml } from '../../../html.ts'
import { card } from '../../../components/card.ts'
import { dataTable } from '../../../components/data-table.ts'

const technical = (value: string | number) => `<bdi class="v2-mono v2-num" dir="ltr">${escapeHtml(value)}</bdi>`
const button = (label: string, editable: boolean, attrs = '', type: 'button' | 'submit' = 'button', danger = false) => `<button class="v2-btn${type === 'submit' ? ' v2-btn--primary' : ''}${danger ? ' v2-btn--danger' : ''}" type="${type}"${attrs}${editable ? '' : ' disabled'}>${escapeHtml(label)}</button>`
const status = (hook: string) => `<p ${hook} role="status" hidden></p>`

/** Saved privilege lists and Reset Resellers (apply one list to many) for /whm/resellers/privileges. */
export function renderV2ResellerAclLists(t: Translate, props: WhmSurfaceProps, editable: boolean, acls: readonly (readonly [ResellerAcl, string])[]): string {
  const lists = props.aclLists ?? [], resellers = props.resellers ?? [], off = editable ? '' : ' disabled'
  const rows = lists.map(list => ({ cellsHtml: [technical(list.name), escapeHtml(list.acl.map(key => t(acls.find(([id]) => id === key)?.[1] ?? key)).join(', ') || t('None')), button(t('Delete'), editable, ` data-acl-list-delete="${escapeHtml(list.name)}"`, 'button', true)] }))
  const table = dataTable(t, { id: 'v2-acl-lists', caption: t('Saved privilege lists'), columns: [t('List'), t('Privileges'), t('Actions')].map(label => ({ label })), rows, emptyText: t('No privilege lists are saved.') })
  const save = `<form class="v2-reseller-stack" data-acl-list-form novalidate><div class="v2-reseller-field"><label for="v2-acl-list-name">${escapeHtml(t('List name'))}</label><input id="v2-acl-list-name" name="name" dir="ltr" maxlength="64" autocomplete="off"${off}></div><fieldset><legend>${escapeHtml(t('Privileges'))}</legend><div class="v2-reseller-checks">${acls.map(([key, label]) => `<label class="v2-reseller-choice"><input type="checkbox" name="acl" value="${key}"${off}><span>${escapeHtml(t(label))}</span></label>`).join('')}</div></fieldset><div class="v2-reseller-actions">${button(t('Save list'), editable, '', 'submit')}</div></form>`
  const apply = `<form class="v2-reseller-stack" data-acl-list-apply-form novalidate><div class="v2-reseller-field"><label for="v2-acl-list-apply">${escapeHtml(t('Privilege list'))}</label><select id="v2-acl-list-apply" name="list"${off}><option value="">${escapeHtml(t('Choose a list'))}</option>${lists.map(list => `<option value="${escapeHtml(list.name)}">${escapeHtml(list.name)}</option>`).join('')}</select></div><fieldset><legend>${escapeHtml(t('Resellers'))}</legend><div class="v2-reseller-checks">${resellers.map(reseller => `<label class="v2-reseller-choice"><input type="checkbox" name="resellerId" value="${escapeHtml(reseller.id)}"${off}><span>${technical(reseller.username)}</span></label>`).join('') || `<p>${escapeHtml(t('No resellers were returned.'))}</p>`}</div></fieldset><p>${escapeHtml(t('Each chosen reseller takes exactly the privileges of the list; privileges outside it are removed.'))}</p><div class="v2-reseller-actions">${button(t('Reset resellers'), editable, '', 'submit')}</div></form>`
  return `<div class="v2-reseller-columns" data-whm-reseller-lists data-network-editable="${editable}"><div class="v2-reseller-stack">${card({ title: t('Saved privilege lists'), titleId: 'v2-acl-lists-heading', bodyHtml: table + save })}</div><aside class="v2-reseller-stack">${card({ title: t('Reset resellers'), titleId: 'v2-acl-apply-heading', bodyHtml: apply })}${status('data-acl-list-status')}</aside></div>`
}

/** Email All Resellers: one message to each reseller contact address. */
export function renderV2ResellerEmail(t: Translate, props: WhmSurfaceProps, editable: boolean): string {
  const off = editable ? '' : ' disabled', resellers = props.resellers ?? [], reachable = resellers.filter(reseller => reseller.contactEmail).length
  return `<div class="v2-reseller-stack" data-whm-reseller-email data-network-editable="${editable}">${card({ title: t('Email all resellers'), titleId: 'v2-reseller-email-heading', bodyHtml: `<p>${escapeHtml(t('{count, plural, one {{count} reseller has} other {{count} resellers have}} a contact address; resellers without one are reported and skipped.', { count: reachable }))}</p><form class="v2-reseller-stack" data-reseller-email-form novalidate><div class="v2-reseller-field"><label for="v2-reseller-email-subject">${escapeHtml(t('Subject'))}</label><input id="v2-reseller-email-subject" name="subject" maxlength="200" autocomplete="off"${off}></div><div class="v2-reseller-field"><label for="v2-reseller-email-body">${escapeHtml(t('Message'))}</label><textarea id="v2-reseller-email-body" name="body" rows="6" maxlength="20000"${off}></textarea></div><div class="v2-reseller-actions">${button(t('Send to all resellers'), editable, '', 'submit')}</div></form>${status('data-reseller-email-status')}` })}</div>`
}

/** Measured disk and traffic totals of each reseller's accounts, with their observation time. */
export function renderV2ResellerUsage(t: Translate, props: WhmSurfaceProps): string {
  const rows = (props.resellers ?? []).map(reseller => {
    const usage = props.resellerUsage?.[reseller.id]
    return { cellsHtml: [technical(reseller.username), usage ? technical(usage.accounts) : escapeHtml(t('Not read')), escapeHtml(measuredTotalText(t, usage?.disk)), escapeHtml(measuredTotalText(t, usage?.traffic))] }
  })
  return card({ title: t('Reseller usage'), titleId: 'v2-reseller-usage-heading', bodyHtml: dataTable(t, { id: 'v2-reseller-usage', caption: t('Reseller usage'), columns: [t('Reseller'), t('Accounts'), t('Disk use'), t('Traffic this month')].map(label => ({ label })), rows, emptyText: t('No resellers were returned.') }) + `<p>${escapeHtml(t('Disk use is the user quota report of the home filesystem; traffic is the bandwidth meter of this UTC month.'))}</p>` })
}

/** Delegated IPs, main shared IP and nameservers per reseller, saved through the reseller update form. */
export function renderV2ResellerIpsNameservers(t: Translate, props: WhmSurfaceProps, editable: boolean): string {
  const pool = props.ipPool ?? [], off = editable ? '' : ' disabled'
  return (props.resellers ?? []).map((reseller: Reseller, index) => {
    const id = `v2-reseller-ns-${index}`
    const shared = pool.filter(ip => ip.version === 4 && ip.role === 'shared' && !ip.reserved)
    const body = `<div class="v2-reseller-fields"><div class="v2-reseller-field"><label for="${id}-delegated">${escapeHtml(t('IPs this reseller may assign, one per line'))}</label><textarea id="${id}-delegated" name="delegatedIps" rows="3" dir="ltr"${off}>${escapeHtml(reseller.delegatedIps.join('\n'))}</textarea></div><div class="v2-reseller-field"><label for="${id}-shared">${escapeHtml(t('Shared IP for new accounts'))}</label><select id="${id}-shared" name="sharedIp" dir="ltr"${off}><option value="">${escapeHtml(t('Server default'))}</option>${shared.map(ip => `<option value="${escapeHtml(ip.address)}"${reseller.sharedIp === ip.address ? ' selected' : ''}>${escapeHtml(ip.address)}</option>`).join('')}</select></div><div class="v2-reseller-field"><label for="${id}-ns">${escapeHtml(t('Nameservers, one per line'))}</label><textarea id="${id}-ns" name="nameservers" rows="3" dir="ltr"${off}>${escapeHtml(reseller.nameservers.join('\n'))}</textarea></div></div><div class="v2-reseller-actions"><p data-reseller-update-status role="status"></p>${button(t('Save'), editable, '', 'submit')}</div>`
    return card({ title: reseller.username, titleId: `${id}-heading`, bodyHtml: editable ? `<form class="v2-reseller-stack" data-reseller-update-form data-reseller-id="${escapeHtml(reseller.id)}" novalidate>${body}</form>` : `<div class="v2-reseller-stack" data-readonly="true">${body}</div>` })
  }).join('')
}

/** Package limits inside the reseller update form: off means every visible package; on lists each allowed package with its account count. */
export function renderV2PackageLimits(t: Translate, props: WhmSurfaceProps, reseller: Reseller | undefined, prefix: string, editable: boolean): string {
  const off = editable ? '' : ' disabled', plans = (props.plans ?? []).filter(plan => plan.ownerId === null || plan.ownerId === reseller?.id)
  const limits = reseller?.packageLimits
  const rows = plans.map(plan => {
    const limit = limits?.find(item => item.planId === plan.id)
    return `<div class="v2-reseller-field"><label for="${prefix}-pkg-${escapeHtml(plan.id)}">${escapeHtml(plan.name)}</label><input id="${prefix}-pkg-${escapeHtml(plan.id)}" name="packageLimit:${escapeHtml(plan.id)}" type="number" min="0" step="1" dir="ltr" value="${typeof limit?.maxAccounts === 'number' ? limit.maxAccounts : ''}"${off}><label class="v2-reseller-choice"><input type="checkbox" name="packageLimitUnlimited:${escapeHtml(plan.id)}"${limit?.maxAccounts === 'unlimited' ? ' checked' : ''}${off}>${escapeHtml(t('Unlimited'))}</label></div>`
  }).join('')
  return `<label class="v2-reseller-choice"><input type="checkbox" name="packageLimitsEnabled"${limits ? ' checked' : ''}${off}>${escapeHtml(t('Limit the packages this reseller may use'))}</label><div class="v2-reseller-fields">${rows || `<p>${escapeHtml(t('No packages were returned.'))}</p>`}</div><p>${escapeHtml(t('With limits on, only packages with a count or Unlimited may be assigned, each up to its count of accounts.'))}</p>`
}
