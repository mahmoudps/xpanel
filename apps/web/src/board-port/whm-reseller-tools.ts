import '../i18n.ts'
import type { Reseller, ResellerAcl } from '@xpanel/core'
import { translator, type Locale, type MessageValues } from '../i18n.ts'
import { measuredTotalText } from '../models/reseller-usage.ts'
import { escapeHtml, renderLtrValue } from '../tokens.ts'
import type { WhmSurfaceProps } from '../surfaces/xwhm.ts'

const STYLE = `<style>
.xp-reseller-tools{display:flex;flex-direction:column;gap:var(--xp-space-section,32px);min-inline-size:0}
.xp-reseller-tools .xp-reseller-tools__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:var(--xp-space-group,24px);align-items:start}
.xp-reseller-tools .xp-card{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);min-inline-size:0}
.xp-reseller-tools :is(h2,p,fieldset){margin:0}
.xp-reseller-tools fieldset{border:0;padding:0;min-inline-size:0}
.xp-reseller-tools legend{padding:0;margin-block-end:var(--xp-space-field,16px);font-weight:600}
.xp-reseller-tools .xp-reseller-tools__fields,.xp-reseller-tools .xp-reseller-tools__checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:var(--xp-space-field,16px)}
.xp-reseller-tools .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}
.xp-reseller-tools .xp-reseller-tools__choice{display:flex;align-items:center;gap:8px;min-block-size:44px}
.xp-reseller-tools .xp-reseller-tools__row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--xp-space-field,16px)}
.xp-reseller-tools .xp-table th,.xp-reseller-tools .xp-table td{text-align:start;vertical-align:top}
</style>`

const tr = (locale: Locale) => (message: string, values?: MessageValues): string => escapeHtml(translator(locale)(message, values))
const table = (caption: string, columns: string[], rows: string[][], empty: string): string => `<div class="xp-table-wrap" role="region" tabindex="0" aria-label="${caption}"><table class="xp-table"><caption class="xp-sr-only">${caption}</caption><thead><tr>${columns.map(column => `<th scope="col">${column}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}">${empty}</td></tr>`}</tbody></table></div>`
const card = (id: string, title: string, body: string): string => `<section class="xp-card" aria-labelledby="${id}"><h2 id="${id}">${title}</h2>${body}</section>`

/** Saved privilege lists and Reset Resellers for /whm/resellers/privileges. */
export function renderClassicResellerAclLists(props: WhmSurfaceProps, editable: boolean, acls: readonly (readonly [ResellerAcl, string])[]): string {
  const locale = props.locale ?? 'en', t = tr(locale), off = editable ? '' : ' disabled', lists = props.aclLists ?? [], resellers = props.resellers ?? []
  const rows = lists.map(list => [renderLtrValue(list.name), escapeHtml(list.acl.map(key => translator(locale)(acls.find(([id]) => id === key)?.[1] ?? key)).join(', ')) || t('None'), `<button type="button" class="xp-btn xp-btn--danger" data-acl-list-delete="${escapeHtml(list.name)}"${off}>${t('Delete')}</button>`])
  const checks = (name: string, items: readonly (readonly [string, string])[]): string => `<div class="xp-reseller-tools__checks">${items.map(([value, label]) => `<label class="xp-reseller-tools__choice"><input type="checkbox" name="${name}" value="${escapeHtml(value)}"${off} /><span>${label}</span></label>`).join('')}</div>`
  const save = `<form class="xp-form-group" data-acl-list-form novalidate><div class="xp-field"><label class="xp-label" for="whm-acl-list-name">${t('List name')}</label><input id="whm-acl-list-name" name="name" class="xp-input xp-mono" dir="ltr" maxlength="64" autocomplete="off"${off} /></div><fieldset><legend>${t('Privileges')}</legend>${checks('acl', acls.map(([key, label]) => [key, t(label)]))}</fieldset><div class="xp-reseller-tools__row"><button type="submit" class="xp-btn xp-btn--primary"${off}>${t('Save list')}</button></div></form>`
  const apply = `<form class="xp-form-group" data-acl-list-apply-form novalidate><div class="xp-field"><label class="xp-label" for="whm-acl-list-apply">${t('Privilege list')}</label><select id="whm-acl-list-apply" name="list" class="xp-select"${off}><option value="">${t('Choose a list')}</option>${lists.map(list => `<option value="${escapeHtml(list.name)}">${escapeHtml(list.name)}</option>`).join('')}</select></div><fieldset><legend>${t('Resellers')}</legend>${resellers.length ? checks('resellerId', resellers.map(reseller => [reseller.id, renderLtrValue(reseller.username)])) : `<p class="xp-help">${t('No resellers were returned.')}</p>`}</fieldset><p class="xp-help">${t('Each chosen reseller takes exactly the privileges of the list; privileges outside it are removed.')}</p><div class="xp-reseller-tools__row"><button type="submit" class="xp-btn"${off}>${t('Reset resellers')}</button></div></form>`
  return `${STYLE}<div class="xp-reseller-tools" data-whm-reseller-lists data-network-editable="${editable}"><div class="xp-reseller-tools__grid">${card('whm-acl-lists-heading', t('Saved privilege lists'), table(t('Saved privilege lists'), [t('List'), t('Privileges'), t('Actions')], rows, t('No privilege lists are saved.')) + save)}${card('whm-acl-apply-heading', t('Reset resellers'), apply)}</div><p class="xp-help" data-acl-list-status role="status" hidden></p></div>`
}

/** Measured usage and Email All Resellers for /whm/resellers/more. */
export function renderClassicResellerMore(props: WhmSurfaceProps, showEmail: boolean, editable: boolean): string {
  const locale = props.locale ?? 'en', t = tr(locale), off = editable ? '' : ' disabled', resellers = props.resellers ?? []
  const plain = (message: string, values?: MessageValues) => translator(locale)(message, values)
  const rows = resellers.map(reseller => { const usage = props.resellerUsage?.[reseller.id]; return [renderLtrValue(reseller.username), usage ? renderLtrValue(usage.accounts) : t('Not read'), escapeHtml(measuredTotalText(plain, usage?.disk)), escapeHtml(measuredTotalText(plain, usage?.traffic))] })
  const usage = card('whm-reseller-usage-heading', t('Reseller usage'), table(t('Reseller usage'), [t('Reseller'), t('Accounts'), t('Disk use'), t('Traffic this month')], rows, t('No resellers were returned.')) + `<p class="xp-help">${t('Disk use is the user quota report of the home filesystem; traffic is the bandwidth meter of this UTC month.')}</p>`)
  const reachable = resellers.filter(reseller => reseller.contactEmail).length
  const email = `<div data-whm-reseller-email data-network-editable="${editable}">${card('whm-reseller-email-heading', t('Email all resellers'), `<p class="xp-help">${t('{count, plural, one {{count} reseller has} other {{count} resellers have}} a contact address; resellers without one are reported and skipped.', { count: reachable })}</p><${editable ? 'form' : 'div'} class="xp-form-group" data-reseller-email-form${editable ? ' novalidate' : ' data-readonly="true"'}><div class="xp-field"><label class="xp-label" for="whm-reseller-email-subject">${t('Subject')}</label><input id="whm-reseller-email-subject" name="subject" class="xp-input" maxlength="200" autocomplete="off"${off} /></div><div class="xp-field"><label class="xp-label" for="whm-reseller-email-body">${t('Message')}</label><textarea id="whm-reseller-email-body" name="body" class="xp-textarea" rows="6" maxlength="20000"${off}></textarea></div><div class="xp-reseller-tools__row"><button type="submit" class="xp-btn xp-btn--primary"${off}>${t('Send to all resellers')}</button></div></${editable ? 'form' : 'div'}><p class="xp-help" data-reseller-email-status role="status" hidden></p>`)}</div>`
  return `${STYLE}<div class="xp-reseller-tools">${usage}${showEmail ? email : ''}</div>`
}

/** Delegated IPs, main shared IP and nameservers per reseller for /whm/resellers/ips-nameservers. */
export function renderClassicResellerIpsNameservers(props: WhmSurfaceProps, editable: boolean): string {
  const locale = props.locale ?? 'en', t = tr(locale), off = editable ? '' : ' disabled', pool = props.ipPool ?? []
  const forms = (props.resellers ?? []).map((reseller: Reseller, index) => {
    const id = `whm-reseller-ns-${index}`, shared = pool.filter(ip => ip.version === 4 && ip.role === 'shared' && !ip.reserved)
    const body = `<div class="xp-reseller-tools__fields"><div class="xp-field"><label class="xp-label" for="${id}-delegated">${t('IPs this reseller may assign, one per line')}</label><textarea id="${id}-delegated" name="delegatedIps" class="xp-textarea xp-mono" dir="ltr" rows="3"${off}>${escapeHtml(reseller.delegatedIps.join('\n'))}</textarea></div><div class="xp-field"><label class="xp-label" for="${id}-shared">${t('Shared IP for new accounts')}</label><select id="${id}-shared" name="sharedIp" class="xp-select xp-mono" dir="ltr"${off}><option value="">${t('Server default')}</option>${shared.map(ip => `<option value="${escapeHtml(ip.address)}"${reseller.sharedIp === ip.address ? ' selected' : ''}>${escapeHtml(ip.address)}</option>`).join('')}</select></div><div class="xp-field"><label class="xp-label" for="${id}-ns">${t('Nameservers, one per line')}</label><textarea id="${id}-ns" name="nameservers" class="xp-textarea xp-mono" dir="ltr" rows="3"${off}>${escapeHtml(reseller.nameservers.join('\n'))}</textarea></div></div><div class="xp-reseller-tools__row"><button type="submit" class="xp-btn xp-btn--primary"${off}>${t('Save')}</button><p class="xp-help" data-reseller-update-status role="status"></p></div>`
    return card(`${id}-heading`, renderLtrValue(reseller.username), editable ? `<form class="xp-form-group" data-reseller-update-form="true" data-reseller-id="${escapeHtml(reseller.id)}" novalidate>${body}</form>` : `<div class="xp-form-group" data-readonly="true">${body}</div>`)
  }).join('')
  return `${STYLE}<div class="xp-reseller-tools">${forms || `<p class="xp-help">${t('No resellers were returned.')}</p>`}</div>`
}

/** Package limits inside the classic reseller update form. */
export function renderClassicPackageLimits(props: WhmSurfaceProps, reseller: Reseller | undefined, prefix: string, editable: boolean): string {
  const locale = props.locale ?? 'en', t = tr(locale), off = editable ? '' : ' disabled'
  const plans = (props.plans ?? []).filter(plan => plan.ownerId === null || plan.ownerId === reseller?.id), limits = reseller?.packageLimits
  const rows = plans.map(plan => {
    const limit = limits?.find(item => item.planId === plan.id)
    return `<div class="xp-field"><label class="xp-label" for="${prefix}-pkg-${escapeHtml(plan.id)}">${escapeHtml(plan.name)}</label><input class="xp-input xp-reseller-technical" id="${prefix}-pkg-${escapeHtml(plan.id)}" name="packageLimit:${escapeHtml(plan.id)}" type="number" min="0" step="1" value="${typeof limit?.maxAccounts === 'number' ? limit.maxAccounts : ''}"${off}/><label class="xp-reseller-choice"><input type="checkbox" name="packageLimitUnlimited:${escapeHtml(plan.id)}"${limit?.maxAccounts === 'unlimited' ? ' checked' : ''}${off}/>${t('Unlimited')}</label></div>`
  }).join('')
  return `<label class="xp-reseller-choice"><input type="checkbox" name="packageLimitsEnabled"${limits ? ' checked' : ''}${off}/>${t('Limit the packages this reseller may use')}</label><div class="xp-reseller-fields">${rows || `<p class="xp-help">${t('No packages were returned.')}</p>`}</div><p class="xp-help" role="status">${t('With limits on, only packages with a count or Unlimited may be assigned, each up to its count of accounts.')}</p>`
}
