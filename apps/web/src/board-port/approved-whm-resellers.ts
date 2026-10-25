import { canOpenRegisteredRoute, type CatalogTool } from '@xpanel/catalog'
import { canSeeAccount, type Account, type Limit, type Plan, type ResellerAcl } from '@xpanel/core'
import { escapeHtml, renderLtrValue, renderStatusBadge, renderThresholdMeter } from '../tokens.ts'
import type { WhmSurfaceProps } from '../surfaces/xwhm.ts'

const ACL_GROUPS: readonly { title: readonly [string, string]; items: readonly [ResellerAcl, string, string][] }[] = [
  { title: ['Accounts', 'الحسابات'], items: [['list-accounts', 'List accounts', 'عرض الحسابات'], ['create-account', 'Create accounts', 'إنشاء الحسابات'], ['edit-account', 'Modify accounts', 'تعديل الحسابات'], ['suspend-account', 'Suspend accounts', 'تعليق الحسابات'], ['terminate-account', 'Terminate accounts', 'حذف الحسابات'], ['change-plan', 'Change plan', 'تغيير الخطة'], ['change-password', 'Change passwords', 'تغيير كلمات المرور']] },
  { title: ['Plans', 'الخطط'], items: [['manage-plans', 'Manage plans', 'إدارة الخطط'], ['manage-feature-lists', 'Feature lists', 'قوائم الميزات'], ['allow-unlimited-plans', 'Allow unlimited plans', 'السماح بخطط غير محدودة'], ['allow-oversell', 'Allow overselling', 'السماح بالبيع الزائد']] },
  { title: ['Domains and transfers', 'النطاقات والنقل'], items: [['manage-dns', 'Manage DNS', 'إدارة DNS'], ['manage-ssl', 'Manage SSL/TLS', 'إدارة SSL/TLS'], ['transfer', 'Transfer accounts', 'نقل الحسابات']] },
]

const STYLES = `<style>
.xp-reseller-reference{display:flex;flex-direction:column;gap:var(--xp-space-section,32px);min-inline-size:0}
.xp-reseller-reference .xp-reseller-select{border:1px solid var(--xp-border);border-radius:var(--xp-radius-lg,12px);background:var(--xp-bg-surface);min-inline-size:0}
.xp-reseller-reference .xp-reseller-select>summary{padding:var(--xp-space-card,24px);cursor:pointer;font-weight:600;overflow-wrap:anywhere}
.xp-reseller-reference .xp-reseller-select[open]>summary{border-block-end:1px solid var(--xp-border)}
.xp-reseller-reference .xp-reseller-detail{padding:var(--xp-space-card,24px);display:flex;flex-direction:column;gap:var(--xp-space-section,32px);min-inline-size:0}
.xp-reseller-reference .xp-reseller-header{display:flex;flex-direction:column;gap:var(--xp-space-group,24px)}
.xp-reseller-reference .xp-reseller-header h2,.xp-reseller-reference h3,.xp-reseller-reference h4{margin:0}
.xp-reseller-reference .xp-reseller-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:var(--xp-space-field,16px);margin:0}
.xp-reseller-reference .xp-reseller-facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}
.xp-reseller-reference .xp-reseller-facts dd{margin:0;overflow-wrap:anywhere}
.xp-reseller-reference .xp-reseller-form,.xp-reseller-reference .xp-reseller-groups{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);min-inline-size:0}
.xp-reseller-reference .xp-reseller-columns{display:grid;grid-template-columns:minmax(0,1.618fr) minmax(260px,1fr);align-items:start;gap:var(--xp-space-group,24px)}
.xp-reseller-reference .xp-reseller-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:var(--xp-space-field,16px);min-inline-size:0}
.xp-reseller-reference .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}
.xp-reseller-reference fieldset{margin:0;padding:0;border:0;min-inline-size:0}
.xp-reseller-reference legend{padding:0;margin-block-end:var(--xp-space-field,16px);font-weight:600}
.xp-reseller-reference .xp-reseller-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:var(--xp-space-field,16px)}
.xp-reseller-reference .xp-reseller-choice{display:flex;align-items:center;gap:8px;min-block-size:44px}
.xp-reseller-reference .xp-reseller-group{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);padding:var(--xp-space-card,24px);border:1px solid var(--xp-border);border-radius:var(--xp-radius-lg,12px);background:var(--xp-bg-surface)}
.xp-reseller-reference .xp-reseller-group p{margin:0}
.xp-reseller-reference .xp-reseller-technical{direction:ltr;text-align:start;unicode-bidi:plaintext;align-self:stretch}
.xp-reseller-reference[dir="rtl"] .xp-reseller-technical{text-align:right}
.xp-reseller-reference .xp-reseller-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--xp-space-field,16px)}
.xp-reseller-reference .xp-reseller-meter{display:flex;flex-direction:column;gap:8px}
.xp-reseller-reference .xp-table th,.xp-reseller-reference .xp-table td{text-align:start}
@media(max-width:959px){.xp-reseller-reference .xp-reseller-columns{grid-template-columns:minmax(0,1fr)}}
@media(max-width:639px){.xp-reseller-reference .xp-reseller-select>summary,.xp-reseller-reference .xp-reseller-detail,.xp-reseller-reference .xp-reseller-group{padding:var(--xp-space-field,16px)}}
</style>`

const qualified = (catalog: readonly CatalogTool[] | undefined, id: string): boolean => catalog?.some(tool => tool.id === id && tool.status === 'verified' && tool.delivery.status === 'verified') === true

/** Plan allocation is desired state; it is never presented as measured resource use. */
const allocated = (accounts: readonly Account[] | undefined, plans: readonly Plan[] | undefined, kind: 'diskMb' | 'bandwidthMbMonth'): Limit | undefined => {
  if (accounts === undefined || plans === undefined) return undefined
  let total = 0
  for (const account of accounts) {
    const value = plans.find(plan => plan.id === account.planId)?.resources[kind]
    if (value === undefined) return undefined
    if (value === 'unlimited') return 'unlimited'
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}

/* Production document authentication and route qualification precede this renderer.
 * It also checks its own role and capability boundary to remain safe as a direct helper.
 * No prototype data or simulated operation result is used. */
export const renderApprovedWhmResellers = (props: WhmSurfaceProps, nativeHtml = ''): string => {
  const ar = props.locale === 'ar'
  const text = (en: string, arabic: string): string => ar ? arabic : en
  const principal = props.visibility?.principal ?? props.principal
  const admitted = principal?.kind === 'root' && canOpenRegisteredRoute('/whm/resellers', { ...props.visibility, principal })
  const readOnly = props.capabilityUnavailable === true || !qualified(props.catalog, 'reseller-center')
  if (!readOnly && !admitted) return `<section class="xp-card" data-reseller-admission="denied"><h1>${text('Resellers', 'الموزعون')}</h1><p>${text('Root authorization is required for reseller administration.', 'تتطلب إدارة الموزعين صلاحية مدير الخادم.')}</p></section>`
  const readable = admitted && !readOnly
  const resellers = readable ? props.resellers : undefined
  const accounts = readable ? props.accounts : undefined
  const plans = readable ? props.plans : undefined
  const pool = readable ? props.ipPool : undefined
  const all = resellers?.length ? resellers : [undefined]
  const notRead = text('Not read', 'غير مقروء')
  const value = (content: string | number | undefined): string => content === undefined ? `<span class="xp-help">${notRead}</span>` : escapeHtml(String(content))
  const fact = (label: string, content: string): string => `<div><dt class="xp-label">${label}</dt><dd>${content}</dd></div>`
  const status = (content: string): string => `<p class="xp-help" role="status">${content}</p>`
  const heading = (id: string, label: string): string => `<h3 id="${id}">${label}</h3>`
  const unavailable = (label: string): string => `<button class="xp-btn" type="button" disabled data-wiring="soon">${label}</button>`
  const html = all.map((reseller, index) => {
    const prefix = `whm-reseller-detail-${index}`
    const owned = reseller && accounts !== undefined ? accounts.filter(account => account.ownerId === reseller.id && principal && canSeeAccount(principal, account)) : undefined
    const ownPlans = reseller && plans !== undefined ? plans.filter(plan => plan.ownerId === reseller.id) : undefined
    const canEdit = readable && reseller !== undefined
    const canMove = canEdit && qualified(props.catalog, 'modify-account') && owned !== undefined && owned.length > 0
    const disabled = canEdit ? '' : ' disabled data-wiring="soon"'
    const limits = ([['maxAccounts', text('Maximum accounts', 'الحد الأقصى للحسابات'), reseller?.maxAccounts, owned?.length, text('accounts', 'حسابات')], ['totalDiskMb', text('Total disk', 'إجمالي القرص'), reseller?.totalDiskMb, allocated(owned, plans, 'diskMb'), 'MiB'], ['totalBandwidthMb', text('Total bandwidth per month', 'إجمالي النقل الشهري'), reseller?.totalBandwidthMb, allocated(owned, plans, 'bandwidthMbMonth'), 'MiB']] as const).map(([name, label, limit, assigned, unit]) => {
      const unlimited = limit === 'unlimited'
      const numericDisabled = !canEdit || unlimited ? ' disabled' : ''
      return `<div class="xp-reseller-groups"><div class="xp-field"><label class="xp-label" for="${prefix}-${name}">${label} (${unit})</label><input class="xp-input xp-reseller-technical" id="${prefix}-${name}" name="${name}" type="number" min="0" step="1" inputmode="numeric" value="${typeof limit === 'number' ? escapeHtml(String(limit)) : ''}"${numericDisabled}${!canEdit ? ' data-wiring="soon"' : ''}${unlimited ? ` placeholder="${text('Unlimited', 'غير محدود')}"` : ''}/><label class="xp-reseller-choice" for="${prefix}-${name}-unlimited"><input type="checkbox" id="${prefix}-${name}-unlimited" name="${name}Unlimited" data-reseller-unlimited-field="${name}"${unlimited ? ' checked' : ''}${disabled}/>${text('Unlimited', 'غير محدود')}</label></div><div class="xp-reseller-meter">${renderThresholdMeter(typeof assigned === 'number' ? assigned : undefined, limit, { locale: ar ? 'ar' : 'en', unit, label: name === 'maxAccounts' ? text('Owned accounts', 'الحسابات المملوكة') : text('Assigned plan limits', 'حدود الخطط المخصصة'), configuredLimit: limit !== undefined })}${assigned === 'unlimited' ? status(text('Assigned plans include an unlimited allocation.', 'تتضمن الخطط المخصصة حصة غير محدودة.')) : ''}</div>${name === 'maxAccounts' ? status(text('Creation is refused when the configured account cap is reached.', 'يُرفض الإنشاء عند بلوغ حد الحسابات المضبوط.')) : status(text('Allocated plan limits are shown above. Actual disk use and current-month traffic have not been read.', 'تظهر أعلاه حدود الخطط المخصصة. لم تُقرأ مساحة القرص المستخدمة فعليًا أو حركة الشهر الحالي.'))}</div>`
    }).join('')
    const acl = ACL_GROUPS.map(group => `<fieldset><legend>${escapeHtml(group.title[ar ? 1 : 0])}</legend><div class="xp-reseller-checks">${group.items.map(([key, en, arabic]) => `<label class="xp-reseller-choice" for="${prefix}-acl-${key}"><input type="checkbox" id="${prefix}-acl-${key}" name="acl" value="${key}"${reseller?.acl.includes(key) ? ' checked' : ''}${disabled}/><span>${escapeHtml(text(en, arabic))}</span></label>`).join('')}</div></fieldset>`).join('')
    const nameservers = `<div class="xp-field"><label class="xp-label" for="${prefix}-nameservers">${text('Nameservers, one per line', 'خوادم الأسماء، واحد في كل سطر')}</label><textarea class="xp-input xp-reseller-technical" id="${prefix}-nameservers" name="nameservers" rows="3"${disabled}>${escapeHtml(reseller?.nameservers.join('\n') ?? '')}</textarea></div>${status(text('Resolution has not been probed. Existing zones keep their current NS records; use DNS zones to change them.', 'لم يُفحص حل الأسماء. تحتفظ المناطق الموجودة بسجلات NS الحالية؛ استخدم مناطق DNS لتغييرها.'))}`
    const assignedIps = reseller?.delegatedIps.map(address => {
      const assignedAccounts = owned?.filter(account => [account.ipv4, account.ipv6, ...(account.extraIps ?? [])].includes(address))
      const knownPool = pool?.some(item => item.address === address)
      const assignment = assignedAccounts?.length ? assignedAccounts.map(account => account.username).join(', ') : knownPool && owned !== undefined ? text('No owned account assignment is recorded', 'لا يوجد توزيع مسجل لحساب مملوك') : notRead
      return `<li>${renderLtrValue(address)}<span>${escapeHtml(assignment)}</span></li>`
    }).join('')
    const ips = `${reseller ? `<ul class="xp-reseller-groups" style="list-style:none;margin:0;padding:0">${assignedIps || `<li>${text('No delegated addresses are configured.', 'لا توجد عناوين مفوضة مضبوطة.')}</li>`}</ul>` : status(notRead)}<div class="xp-field"><label class="xp-label" for="${prefix}-delegatedIps">${text('Delegated IP addresses, one per line', 'عناوين IP المفوضة، واحد في كل سطر')}</label><textarea class="xp-input xp-reseller-technical" id="${prefix}-delegatedIps" name="delegatedIps" rows="3"${disabled}>${escapeHtml(reseller?.delegatedIps.join('\n') ?? '')}</textarea></div>${status(text('Saving validates existing account assignments. This list does not prove an address is routed or free on the host.', 'يتحقق الحفظ من توزيعات الحسابات الحالية. لا تثبت هذه القائمة أن العنوان موجّه أو حر على المضيف.'))}`
    const group = (key: string, label: string, content: string): string => `<section class="xp-reseller-group" aria-labelledby="${prefix}-${key}">${heading(`${prefix}-${key}`, label)}${content}</section>`
    const formOpen = canEdit ? `<form class="xp-reseller-form" data-reseller-update-form="true" data-reseller-id="${escapeHtml(reseller.id)}">` : '<div class="xp-reseller-form" data-reseller-editor="unavailable">'
    const formClose = canEdit ? '</form>' : '</div>'
    const edit = `${formOpen}<div class="xp-reseller-columns"><div class="xp-reseller-groups">${group('privileges', text('Privileges', 'الصلاحيات'), `<p>${text('Privileges are scoped to owned accounts. Server administration remains root-only.', 'تقتصر الصلاحيات على الحسابات المملوكة. تبقى إدارة الخادم للمدير فقط.')}</p>${acl}${reseller ? '' : status(text('No privilege assignment has been read.', 'لم يُقرأ توزيع الصلاحيات.'))}`)}${group('nameservers-heading', text('Nameservers', 'خوادم الأسماء'), nameservers)}${group('delegated-heading', text('Delegated IP addresses', 'عناوين IP المفوضة'), ips)}</div><div class="xp-reseller-groups">${group('limits', text('Capacity and usage', 'السعة والاستخدام'), limits)}${group('overselling', text('Overselling', 'البيع الزائد'), `<label class="xp-reseller-choice" for="${prefix}-oversell"><input type="checkbox" id="${prefix}-oversell" name="oversell"${reseller?.oversell ? ' checked' : ''}${disabled}/>${text('Allow overselling', 'السماح بالبيع الزائد')}</label>${status(reseller ? reseller.oversell ? text('Overselling is configured on. Actual current resource usage has not been read; it cannot be inferred from plan allocations.', 'البيع الزائد مضبوط على التفعيل. لم يُقرأ الاستخدام الفعلي الحالي للموارد، ولا يمكن استنتاجه من حصص الخطط.') : text('Overselling is configured off. Assigned plan limits are constrained by the reseller totals when accounts or plans change.', 'البيع الزائد مضبوط على الإيقاف. تُقيّد حدود الخطط المخصصة بإجماليات الموزع عند تغيير الحسابات أو الخطط.') : notRead)}`)}</div></div><div class="xp-reseller-actions">${canEdit ? `<button type="reset" class="xp-btn">${text('Discard changes', 'تجاهل التغييرات')}</button><button type="submit" class="xp-btn xp-btn--primary">${text('Save reseller', 'حفظ الموزع')}</button><p class="xp-help" data-reseller-update-status role="status"></p>` : unavailable(text('Save reseller', 'حفظ الموزع'))}</div>${formClose}`
    const tableRows = owned?.map(account => {
      const plan = plans?.find(item => item.id === account.planId)
      return `<tr><th scope="row">${renderLtrValue(account.username)}<span class="xp-help">${text('Linux UID', 'UID لينكس')}: ${value(account.uid)}</span></th><td>${renderLtrValue(account.primaryDomain)}</td><td>${plan ? escapeHtml(plan.name) : notRead}</td><td>${plan ? plan.resources.diskMb === 'unlimited' ? text('Unlimited allocation', 'حصة غير محدودة') : `${value(plan.resources.diskMb)} MiB` : notRead}<span class="xp-help">${text('Actual use not read', 'الاستخدام الفعلي غير مقروء')}</span></td><td>${renderStatusBadge(account.status === 'active' ? 'ok' : 'suspended', escapeHtml(account.status === 'active' ? text('Active', 'نشط') : text('Suspended', 'معلق')))}</td></tr>`
    }).join('')
    const ownership = owned?.map(account => `<form class="xp-reseller-fields" data-reseller-owner-form="true" data-account-username="${escapeHtml(account.username)}"><div class="xp-field"><label class="xp-label" for="${prefix}-owner-${escapeHtml(account.username)}">${text('New owner of', 'المالك الجديد لـ')} ${renderLtrValue(account.username)}</label><select class="xp-input" id="${prefix}-owner-${escapeHtml(account.username)}" name="ownerId"${canMove ? '' : ' disabled data-wiring="soon"'}><option value="">${text('Root', 'مدير الخادم')}</option>${resellers?.map(item => `<option value="${escapeHtml(item.id)}"${item.id === reseller?.id ? ' selected' : ''}>${escapeHtml(item.username)}</option>`).join('') ?? ''}</select></div><div class="xp-reseller-actions"><button type="submit" class="xp-btn"${canMove ? '' : ' disabled data-wiring="soon"'}>${text('Change ownership', 'تغيير الملكية')}</button><p class="xp-help" data-reseller-owner-status role="status"></p></div></form>`).join('')
    const ownerBody = canMove ? ownership : `<div class="xp-reseller-fields"><div class="xp-field"><label class="xp-label" for="${prefix}-owner-account">${text('Account', 'الحساب')}</label><select id="${prefix}-owner-account" class="xp-input" disabled data-wiring="soon"><option>${text('Select an account', 'اختر حسابًا')}</option>${owned?.map(account => `<option>${escapeHtml(account.username)}</option>`).join('') ?? ''}</select></div><div class="xp-field"><label class="xp-label" for="${prefix}-owner-target">${text('New owner', 'المالك الجديد')}</label><select id="${prefix}-owner-target" class="xp-input" disabled data-wiring="soon"><option>${text('Not qualified', 'غير مثبت الجاهزية')}</option></select></div>${unavailable(text('Change ownership', 'تغيير الملكية'))}</div>`
    const accountList = group('owned', text('Owned accounts', 'الحسابات المملوكة'), `<div class="xp-reseller-actions"><strong>${owned === undefined ? notRead : `${owned.length} ${text('accounts', 'حسابات')}`}</strong>${readable ? `<a class="xp-btn" href="/whm/accounts">${text('Open in Accounts', 'فتح في الحسابات')}</a>` : ''}</div><div class="xp-table-wrap"><table class="xp-table"><thead><tr>${[text('Account', 'الحساب'), text('Domain', 'النطاق'), text('Plan', 'الخطة'), text('Disk allocation', 'حصة القرص'), text('Status', 'الحالة')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${tableRows || `<tr><td colspan="5">${owned === undefined ? notRead : text('No accounts are owned by this reseller.', 'لا يملك هذا الموزع أي حسابات.')}</td></tr>`}</tbody></table></div><details><summary>${text('Change ownership', 'تغيير الملكية')}</summary><div class="xp-reseller-groups">${ownerBody}${status(text('The server validates the destination capacity, plan access and current account configuration. No transfer has been performed by this view.', 'يتحقق الخادم من سعة الوجهة وإتاحة الخطة وإعدادات الحساب الحالية. لم تنفذ هذه الواجهة أي نقل.'))}</div></details>`)
    return `<details class="xp-reseller-select" name="whm-reseller-selected"${index === 0 ? ' open' : ''} data-reseller-detail="${index}"><summary>${reseller ? renderLtrValue(reseller.username) : text('Select a reseller', 'اختر موزعًا')}</summary><section class="xp-reseller-detail" aria-labelledby="${prefix}-heading"><header class="xp-reseller-header"><h2 id="${prefix}-heading">${reseller ? renderLtrValue(reseller.username) : text('Reseller details', 'تفاصيل الموزع')}</h2><div class="xp-reseller-actions">${reseller ? renderStatusBadge(reseller.oversell ? 'warn' : 'ok', reseller.oversell ? text('Overselling on', 'البيع الزائد مفعّل') : text('Overselling off', 'البيع الزائد متوقف')) : ''}<span class="xp-help">${text('Sign-in state not read', 'حالة تسجيل الدخول غير مقروءة')}</span>${unavailable(text('Suspend reseller', 'تعليق الموزع'))}</div><dl class="xp-reseller-facts">${fact(text('Contact', 'جهة الاتصال'), notRead)}${fact(text('Created', 'تاريخ الإنشاء'), notRead)}${fact(text('Owns', 'يملك'), value(owned?.length))}${fact(text('Own plans', 'الخطط المملوكة'), ownPlans ? ownPlans.map(plan => escapeHtml(plan.name)).join(', ') || text('None', 'لا يوجد') : notRead)}${fact(text('Last sign-in', 'آخر تسجيل دخول'), notRead)}</dl></header>${accountList}${edit}</section></details>`
  }).join('')
  return `<div class="xp-reseller-reference" data-approved-whm-resellers="true" data-workspace-mode="${readable ? 'qualified' : 'read-only'}"${ar ? ' dir="rtl"' : ''}>${STYLES}${readable && nativeHtml ? nativeHtml : `<header><h1>${text('Resellers', 'الموزعون')}</h1><p class="xp-help">${resellers ? text('Select a reseller to review its accounts, privileges and limits.', 'اختر موزعًا لمراجعة حساباته وصلاحياته وحدوده.') : text('Reseller data has not been read. Unavailable actions are disabled.', 'لم تُقرأ بيانات الموزعين. الإجراءات غير المتاحة معطلة.')}</p></header>`}${html}</div>`
}
