import { tools } from '@xpanel/catalog'
import { canManagePlan, type Account, type Plan, type ResellerAcl } from '@xpanel/core'
import type { WhmSurfaceProps } from '../surfaces/xwhm.ts'
import { escapeHtml, normalizeAsciiDigits, renderLtrValue } from '../tokens.ts'

type Copy = readonly [string, string]
type ImpactAccount = Pick<Account, 'username' | 'primaryDomain'>
export interface ApprovedWhmPlanImpact {
  state: 'read' | 'unread'
  accountsRead: boolean
  rows: readonly { name: string; accountCount: number | undefined; accounts: readonly ImpactAccount[] }[]
}

const style = `<style>
.xp-whm-plan-supplement{display:flex;flex-direction:column;gap:var(--xp-space-section,32px);min-inline-size:0}.xp-whm-plan-card{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);padding:16px;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface);min-inline-size:0}.xp-whm-plan-card :is(h2,h3,p,dl,dd){margin:0}.xp-whm-plan-card h2{font-size:18px;line-height:1.6}.xp-whm-plan-card h3{font-size:16px;line-height:1.6}.xp-whm-plan-card p{line-height:1.8;overflow-wrap:anywhere}.xp-whm-plan-field{display:flex;flex-direction:column;gap:8px;text-align:start;min-inline-size:0}.xp-whm-plan-field label{font-weight:600}.xp-whm-plan-field input{inline-size:100%;box-sizing:border-box;min-block-size:44px;border:1px solid var(--xp-border-strong);border-radius:8px;background:var(--xp-bg-surface);color:inherit;font:inherit;padding:10px 12px}.xp-whm-plan-actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.xp-whm-plan-form{display:flex;flex-direction:column;gap:24px}.xp-whm-plan-choices{display:flex;flex-direction:column;gap:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;padding:16px;margin:0}.xp-whm-plan-choices legend{font-weight:600;padding-inline:8px}.xp-whm-plan-choice{display:flex;gap:8px;align-items:flex-start;min-block-size:44px;line-height:1.8}.xp-whm-plan-choice input{flex:none;inline-size:20px;block-size:20px;margin:3px 0 0}.xp-whm-plan-scroll{max-inline-size:100%;overflow-x:auto;border:1px solid var(--xp-border);border-radius:8px}.xp-whm-plan-table{inline-size:100%;border-collapse:collapse;text-align:start}.xp-whm-plan-table :is(th,td){padding:12px 16px;text-align:start;vertical-align:top;overflow-wrap:anywhere}.xp-whm-plan-table thead{background:var(--xp-bg-elevated)}.xp-whm-plan-table tbody tr td{border-block-start:1px solid var(--xp-border)}.xp-whm-plan-duplicate{display:flex;flex-direction:column;gap:24px}.xp-whm-plan-duplicate summary{font-weight:600;cursor:pointer;min-block-size:44px;align-content:center}.xp-whm-plan-duplicate[open]>:not(summary){margin-block-start:24px}.xp-whm-plan-supplement :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}.xp-whm-plan-supplement :disabled{cursor:not-allowed;opacity:.75}.xp-whm-plan-field input[dir=ltr]{text-align:start}html[dir=rtl] .xp-whm-plan-field input[dir=ltr]{text-align:end}@media(min-width:801px){.xp-whm-plan-card{padding:24px}}
</style>`
const text = (props: WhmSurfaceProps, copy: Copy): string => escapeHtml(normalizeAsciiDigits(copy[props.locale === 'ar' ? 1 : 0]))
const display = (raw: string): string => escapeHtml(normalizeAsciiDigits(raw))
const principalOf = (props: WhmSurfaceProps) => props.visibility?.principal ?? props.principal
const aclsOf = (props: WhmSurfaceProps): readonly ResellerAcl[] => props.visibility?.reseller?.acl ?? props.activeReseller?.acl ?? []
const admitted = (props: WhmSurfaceProps, acl: ResellerAcl): boolean => {
  const principal = principalOf(props)
  return principal?.kind === 'root' || (principal?.kind === 'reseller' && aclsOf(props).includes(acl))
}
const qualified = (props: WhmSurfaceProps, ids: readonly string[]): boolean => props.capabilityUnavailable !== true && props.catalog?.some(tool => ids.includes(tool.id) && tool.status === 'verified' && tool.delivery.status === 'verified') === true
const card = (props: WhmSurfaceProps, key: string, title: Copy, body: string): string => `<section class="xp-whm-plan-card" data-whm-plan-component="${key}" aria-labelledby="whm-plan-${key}"><h2 id="whm-plan-${key}">${text(props, title)}</h2>${body}</section>`
const note = (props: WhmSurfaceProps, copy: Copy): string => `<p class="xp-help" role="status">${text(props, copy)}</p>`
const disabledButton = (props: WhmSurfaceProps, copy: Copy): string => `<button type="button" class="xp-btn" disabled>${text(props, copy)}</button>`
const table = (props: WhmSurfaceProps, title: Copy, columns: readonly Copy[], rows: readonly (readonly string[])[], empty: Copy): string => `<div class="xp-whm-plan-scroll" role="region" tabindex="0" aria-label="${text(props, title)}"><table class="xp-whm-plan-table"><caption class="sr-only">${text(props, title)}</caption><thead><tr>${columns.map(column => `<th scope="col">${text(props, column)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length}">${text(props, empty)}</td></tr>`}</tbody></table></div>`

/** Counts only authorized assignments in the supplied snapshot; no resource use is inferred. */
export const approvedWhmPlanImpact = (props: WhmSurfaceProps): ApprovedWhmPlanImpact => {
  if (!admitted(props, 'manage-plans') || !qualified(props, ['add-package', 'edit-package']) || props.plans === undefined) return { state: 'unread', accountsRead: false, rows: [] }
  const principal = principalOf(props)!
  let plans: readonly Plan[] = props.plans.filter(plan => canManagePlan(principal, plan))
  if (props.planEditorState?.kind === 'edit') {
    const selected = props.planEditorState.plan
    plans = canManagePlan(principal, selected) ? plans.filter(plan => plan.id === selected.id) : []
  }
  const accountsRead = props.accounts !== undefined && (principal.kind === 'root' || aclsOf(props).includes('list-accounts'))
  const accounts = accountsRead ? props.accounts!.filter(account => principal.kind === 'root' || account.ownerId === principal.id) : []
  return { state: 'read', accountsRead, rows: plans.map(plan => {
    const assigned = accounts.filter(account => account.planId === plan.id).map(({ username, primaryDomain }) => ({ username, primaryDomain }))
    return { name: plan.name, accountCount: accountsRead ? assigned.length : undefined, accounts: assigned }
  }) }
}

/** Body only: the existing plan list/editor supplies its heading, forms and real save binding. */
export const renderApprovedWhmPlanSupplement = (props: WhmSurfaceProps): string => {
  if (props.capabilityUnavailable !== true && !admitted(props, 'manage-plans')) return ''
  const impact = approvedWhmPlanImpact(props)
  const notRead: Copy = ['Not read', 'غير مقروء']
  const rows = impact.rows.map(row => [display(row.name), row.accountCount === undefined ? text(props, notRead) : renderLtrValue(String(row.accountCount)), text(props, ['Not read', 'غير مقروء'])])
  const affected = impact.rows.flatMap(row => row.accounts.map(account => [display(row.name), renderLtrValue(account.username), renderLtrValue(account.primaryDomain)]))
  const impactHtml = table(props, ['Plan impact', 'أثر الخطة'], [['Plan', 'الخطة'], ['Assigned accounts in the authorized snapshot', 'الحسابات المعيّنة في اللقطة المصرّح بها'], ['Observed cap compliance', 'الالتزام بالحدود المقاس']], rows, impact.state === 'unread' ? ['Plan assignments have not been read.', 'لم تُقرأ تعيينات الخطط.'] : ['No plans are available in this authorized snapshot.', 'لا توجد خطط في هذه اللقطة المصرّح بها.'])
    + note(props, ['Assignments are desired state. Current usage and over-cap accounts have not been observed; no account is reported as within its caps or scheduled for a host change.', 'التعيينات حالة مطلوبة. لم يُقَس الاستخدام الحالي أو الحسابات المتجاوزة؛ ولا يُعرض أي حساب على أنه ضمن حدوده أو مجدول لتغيير على المضيف.'])
    + table(props, ['Assigned accounts', 'الحسابات المعيّنة'], [['Plan', 'الخطة'], ['Account', 'الحساب'], ['Primary domain', 'النطاق الأساسي']], affected, impact.accountsRead ? ['No assigned accounts were returned in this snapshot.', 'لم تُرجع اللقطة حسابات معيّنة.'] : ['Account assignments have not been read.', 'لم تُقرأ تعيينات الحسابات.'])
  const unsaved = table(props, ['Unsaved plan changes', 'تغييرات الخطة غير المحفوظة'], [['Field', 'الحقل'], ['Saved', 'المحفوظ'], ['Draft', 'المسودة']], [], ['No browser draft comparison is available in this server-rendered summary.', 'لا تتوافر مقارنة لمسودة المتصفح في هذا الملخص المعروض من الخادم.'])
    + note(props, ['Review the existing plan editor before saving. This summary does not assert that its current browser values match the saved plan; discarding a draft from here is unavailable.', 'راجع محرر الخطة القائم قبل الحفظ. لا يؤكد هذا الملخص تطابق قيم المتصفح الحالية مع الخطة المحفوظة؛ ولا يتاح تجاهل المسودة من هنا.'])
    + `<div class="xp-whm-plan-actions">${disabledButton(props, ['Discard changes', 'تجاهل التغييرات'])}</div>`
  const applying = `<p>${text(props, ['Saving records desired plan state and an audit event. Changes to host resource limits require the reconciler and host evidence; a stored plan alone does not establish that slices were updated.', 'يسجل الحفظ حالة الخطة المطلوبة وحدث تدقيق. تتطلب تغييرات حدود موارد المضيف عملية المواءمة ودليلًا من المضيف؛ حفظ الخطة وحده لا يثبت تحديث الشرائح.'])}</p><p>${text(props, ['Caps govern later create requests. Lowering a cap must not remove existing files, sites, mailboxes or databases. A saved limit is separate from measured consumption.', 'تضبط الحدود طلبات الإنشاء اللاحقة. يجب ألا يؤدي خفض الحد إلى حذف الملفات أو المواقع أو صناديق البريد أو قواعد البيانات القائمة. الحد المحفوظ منفصل عن الاستهلاك المقاس.'])}</p>`
  return `${style}<div class="xp-whm-plan-supplement" data-approved-whm-plan-supplement>${card(props, 'impact', ['Impact', 'الأثر'], impactHtml)}${card(props, 'unsaved', ['Unsaved changes', 'تغييرات غير محفوظة'], unsaved)}${card(props, 'saving', ['How saving applies', 'كيفية تطبيق الحفظ'], applying)}</div>`
}

/** Uses the existing create contract. Exact persisted disabled keys are copied, never inferred. */
export const renderApprovedWhmFeatureListSupplement = (props: WhmSurfaceProps): string => {
  if (props.capabilityUnavailable !== true && !admitted(props, 'manage-feature-lists')) return ''
  const principal = principalOf(props)
  const ready = admitted(props, 'manage-feature-lists') && qualified(props, ['feature-list-crud'])
  const lists = ready ? (props.featureLists ?? []).filter(list => principal?.kind === 'root' || list.ownerId === null || list.ownerId === principal?.id) : []
  const knownKeys = new Set(tools.flatMap(tool => tool.featureKey ? [tool.featureKey] : []))
  const duplicates = lists.map((list, index) => {
    const keys = list.disabled === undefined ? undefined : [...new Set(list.disabled)]
    const supported = keys !== undefined && keys.every(key => knownKeys.has(key))
    const disabled = supported ? '' : ' disabled'
    const prefix = `whm-feature-duplicate-${index}`
    const fields = `<div class="xp-whm-plan-field"><label for="${prefix}-name">${text(props, ['New list name', 'اسم القائمة الجديدة'])}</label><input id="${prefix}-name" name="name" type="text" value="" required maxlength="128" autocomplete="off"${disabled}></div><fieldset class="xp-whm-plan-choices"${disabled}><legend>${text(props, ['Copied disabled feature keys', 'مفاتيح الميزات المعطلة المنسوخة'])}</legend>${keys?.length ? keys.map((key, keyIndex) => `<label class="xp-whm-plan-choice" for="${prefix}-key-${keyIndex}"><input id="${prefix}-key-${keyIndex}" name="disabled" type="checkbox" value="${escapeHtml(key)}" checked${disabled}><span>${renderLtrValue(key)}</span></label>`).join('') : note(props, keys === undefined ? ['Feature membership has not been read.', 'لم تُقرأ عضوية الميزات.'] : ['The saved list has no disabled feature keys.', 'لا تحتوي القائمة المحفوظة على مفاتيح ميزات معطلة.'])}</fieldset><div class="xp-whm-plan-actions"><button type="submit" class="xp-btn xp-btn--primary"${disabled}>${text(props, ['Duplicate list', 'نسخ القائمة'])}</button><button type="reset" class="xp-btn"${disabled}>${text(props, ['Discard duplicate draft', 'تجاهل مسودة النسخة'])}</button></div>`
    const reason = supported ? note(props, ['Enter a new name. Creating this copy does not modify the source list or reassign a plan. The server applies ownership and validates the request.', 'أدخل اسمًا جديدًا. لا يعدل إنشاء النسخة القائمة الأصلية أو يعيد تعيين خطة. يطبق الخادم الملكية ويتحقق من الطلب.']) : note(props, keys === undefined ? ['Read the saved membership before copying this list. No enabled or disabled state has been assumed.', 'اقرأ العضوية المحفوظة قبل نسخ القائمة. لم تُفترض حالة تفعيل أو تعطيل.'] : ['This list contains a legacy feature key that the create operation does not support. Copying is unavailable so the saved restriction cannot be silently dropped.', 'تحتوي القائمة على مفتاح ميزة قديم لا تدعمه عملية الإنشاء. النسخ غير متاح حتى لا يسقط القيد المحفوظ دون بيان.'])
    return `<details class="xp-whm-plan-duplicate" data-feature-list-duplicate="${index}"><summary>${display(list.name)}</summary>${supported ? `<form class="xp-whm-plan-form" data-feature-list-create-form data-feature-list-duplicate-form>${fields}<p class="xp-help" data-feature-list-status role="status" hidden></p></form>` : `<div class="xp-whm-plan-form" data-readonly="true">${fields}</div>`}${reason}</details>`
  }).join('')
  const duplicateBody = duplicates || note(props, ready && props.featureLists !== undefined ? ['No accessible source list was returned. Create a list with the existing form before duplicating it.', 'لم تُرجع قائمة أصلية متاحة. أنشئ قائمة بالنموذج القائم قبل نسخها.'] : ['Accessible feature lists and membership have not been read. Copying is unavailable until the authorized operation and saved list are available.', 'لم تُقرأ قوائم الميزات المتاحة وعضويتها. النسخ غير متاح حتى تتوافر العملية المصرّح بها والقائمة المحفوظة.'])
  const unsaved = table(props, ['Unsaved feature-list changes', 'تغييرات قوائم الميزات غير المحفوظة'], [['List', 'القائمة'], ['Feature', 'الميزة'], ['Saved', 'المحفوظ'], ['Draft', 'المسودة']], [], ['A comparison with current browser edits has not been calculated. Review and save each list in its existing form.', 'لم تُحسب مقارنة مع تعديلات المتصفح الحالية. راجع كل قائمة واحفظها في نموذجها القائم.'])
    + `<div class="xp-whm-plan-actions">${disabledButton(props, ['Discard', 'تجاهل'])}</div>`
    + note(props, ['Global draft discard is unavailable. The reset control in a duplicate form discards only that unsent copy draft and does not change saved lists.', 'تجاهل جميع المسودات غير متاح. يعيد زر الضبط في نموذج النسخة مسودتها غير المرسلة فقط ولا يغير القوائم المحفوظة.'])
  return `${style}<div class="xp-whm-plan-supplement" data-approved-whm-feature-supplement>${card(props, 'feature-duplicate', ['Duplicate a list', 'نسخ قائمة'], duplicateBody)}${card(props, 'feature-unsaved', ['Unsaved changes', 'تغييرات غير محفوظة'], unsaved)}</div>`
}
