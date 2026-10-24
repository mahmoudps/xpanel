/// <reference lib="dom" />
import { assertResellerCapacity, hasAcl, isXpanelError, type Account, type Plan, type Principal, type Reseller } from '@xpanel/core'
import { escapeHtml } from './tokens.ts'
import { formatDisplayName } from './display-name.ts'

export interface AccountListInput {
  principal: Principal
  activeReseller?: Reseller | null
  accounts?: readonly Account[]
  plans?: readonly Plan[]
  resellers?: readonly Reseller[]
}
export interface AccountListModel {
  state: 'forbidden' | 'unavailable' | 'empty' | 'ready'
  accounts: readonly Account[]
  owners: readonly { value: string; label: string }[]
  plans: readonly { value: string; label: string }[]
}

/** Projects only supplied, authorized account rows; this never reads or mutates a store. */
export function accountListModel(input: AccountListInput): AccountListModel {
  const allowed = input.principal.kind !== 'user' && hasAcl(input.principal, input.activeReseller ?? null, 'list-accounts')
  if (!allowed) return { state: 'forbidden', accounts: [], owners: [], plans: [] }
  if (input.accounts === undefined) return { state: 'unavailable', accounts: [], owners: [], plans: [] }
  const accounts = input.accounts.filter(account => input.principal.kind === 'root' || account.ownerId === input.principal.id).sort((a, b) => {
    const at = Date.parse(a.createdAt), bt = Date.parse(b.createdAt)
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
    if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? -1 : 1
    return a.username < b.username ? -1 : a.username > b.username ? 1 : 0
  })
  const ownerIds = new Set(accounts.map(account => account.ownerId ?? ''))
  const planIds = new Set(accounts.map(account => account.planId))
  const owners = [...ownerIds].flatMap(value => {
    const name = value === '' ? 'root' : input.resellers?.find(reseller => reseller.id === value)?.username
    return name ? [{ value, label: name }] : []
  })
  const plans = (input.plans ?? []).filter(plan => planIds.has(plan.id)).map(plan => ({ value: plan.id, label: formatDisplayName(plan.name) }))
  return { state: accounts.length ? 'ready' : 'empty', accounts, owners, plans }
}

/** These attributes are routing/filter keys, never displayed reference numbers. */
export function accountListRowAttributes(account: Account): string {
  return `data-list-search="${escapeHtml(`${account.username} ${account.primaryDomain}`.toLowerCase())}" data-list-owner="${escapeHtml(account.ownerId ?? '')}" data-list-plan="${escapeHtml(account.planId)}" data-list-state="${escapeHtml(account.status)}"`
}

export function renderAccountListControls(model: AccountListModel, locale: 'en' | 'ar' = 'en'): string {
  const ar = locale === 'ar'
  const copy = (en: string, arabic: string) => escapeHtml(ar ? arabic : en)
  if (model.state === 'forbidden') return `<p class="xp-help">${copy('Account listing is not permitted.', 'عرض الحسابات غير مسموح.')}</p>`
  if (model.state === 'unavailable') return `<p class="xp-help">${copy('The account list is unavailable.', 'قائمة الحسابات غير متاحة.')}</p>`
  const options = (items: readonly { value: string; label: string }[]) => items.map(item => `<option value="${escapeHtml(item.value === '' ? 'root' : item.value)}">${escapeHtml(item.label)}</option>`).join('')
  return `<div class="xp-form-group" data-account-list-controls data-list-page-size="20">
    <div class="xp-field"><label class="xp-label" for="account-list-search">${copy('Search loaded accounts', 'بحث في الحسابات المحملة')}</label><input id="account-list-search" class="xp-input" type="search" data-list-search-input autocomplete="off" /></div>
    <div class="xp-field"><label class="xp-label" for="account-list-owner">${copy('Owner', 'المالك')}</label><select id="account-list-owner" class="xp-select" data-list-owner-filter><option value="">${copy('All owners', 'كل المالكين')}</option>${options(model.owners)}</select></div>
    <div class="xp-field"><label class="xp-label" for="account-list-plan">${copy('Plan', 'الخطة')}</label><select id="account-list-plan" class="xp-select" data-list-plan-filter><option value="">${copy('All plans', 'كل الخطط')}</option>${options(model.plans)}</select></div>
    <div class="xp-field"><label class="xp-label" for="account-list-state">${copy('Status', 'الحالة')}</label><select id="account-list-state" class="xp-select" data-list-state-filter><option value="">${copy('All statuses', 'كل الحالات')}</option><option value="active">${copy('Active', 'نشط')}</option><option value="suspended">${copy('Suspended', 'معلق')}</option><option value="terminating">${copy('Terminating', 'قيد الإنهاء')}</option></select></div>
    <p class="xp-help" data-list-count role="status" aria-live="polite"></p>
    <p class="xp-help" data-list-empty hidden>${copy('No accounts match these filters.', 'لا توجد حسابات تطابق التصفية.')}</p>
    <nav class="xp-plan-editor-actions" data-list-pages aria-label="${copy('Loaded account pages', 'صفحات الحسابات المحملة')}" hidden><button type="button" class="xp-btn" data-list-previous>${copy('Previous', 'السابق')}</button><span class="xp-tabular" data-list-page></span><button type="button" class="xp-btn" data-list-next>${copy('Next', 'التالي')}</button></nav>
  </div>`
}

export interface AccountPlanPreview {
  plans: readonly { id: string; name: string; disk: string; memory: string; cpu: string; capacity: 'server-check' | 'fits' | 'exceeds' | 'unavailable' }[]
}

/** A preview of supplied desired state, never permission to create or allocate an address. */
export function accountPlanPreviewModel(input: AccountListInput): AccountPlanPreview {
  if (!hasAcl(input.principal, input.activeReseller ?? null, 'create-account')) return { plans: [] }
  const actor = input.activeReseller
  const owned = input.accounts?.filter(account => account.ownerId === input.principal.id)
  const knownPlans = new Map(input.plans?.map(plan => [plan.id, plan]))
  const ownedPlans = owned?.map(account => knownPlans.get(account.planId))
  const canReadOwned = hasAcl(input.principal, actor ?? null, 'list-accounts')
  return { plans: (input.plans ?? []).map(plan => {
    let capacity: AccountPlanPreview['plans'][number]['capacity'] = input.principal.kind === 'root' ? 'server-check' : 'unavailable'
    if (input.principal.kind === 'reseller' && actor?.id === input.principal.id && canReadOwned && ownedPlans?.every(item => item !== undefined)) {
      try { assertResellerCapacity({ reseller: actor, ownedAccounts: ownedPlans.map(item => ({ plan: item! })), newPlan: plan }); capacity = 'fits' }
      catch (error) { capacity = isXpanelError(error) && error.code === 'LIMIT_EXCEEDED' ? 'exceeds' : 'unavailable' }
    }
    return { id: plan.id, name: formatDisplayName(plan.name), disk: String(plan.resources.diskMb), memory: String(plan.resources.memoryMb), cpu: String(plan.resources.cpuPercent), capacity }
  }) }
}

export function renderAccountPlanPreview(model: AccountPlanPreview, locale: 'en' | 'ar' = 'en'): string {
  const ar = locale === 'ar'
  const copy = (en: string, arabic: string) => escapeHtml(ar ? arabic : en)
  const json = JSON.stringify(model).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
  return `<section class="xp-card xp-form-group" data-create-plan-preview><h2 class="xp-section-title">${copy('Selected plan', 'الخطة المختارة')}</h2><script type="application/json" data-plan-preview-model>${json}</script><dl class="xp-accounts__technical"><div class="xp-field"><dt>${copy('Plan', 'الخطة')}</dt><dd data-preview-plan-name></dd></div><div class="xp-field"><dt>${copy('Disk (MiB)', 'القرص (MiB)')}</dt><dd><bdi dir="ltr" data-preview-plan-disk></bdi></dd></div><div class="xp-field"><dt>${copy('Memory (MiB)', 'الذاكرة (MiB)')}</dt><dd><bdi dir="ltr" data-preview-plan-memory></bdi></dd></div><div class="xp-field"><dt>${copy('CPU (%)', 'المعالج (%)')}</dt><dd><bdi dir="ltr" data-preview-plan-cpu></bdi></dd></div></dl><p class="xp-help" data-preview-plan-capacity role="status" aria-live="polite"></p><p class="xp-help">${copy('Preview only. The server checks capacity, permissions and address availability when submitted.', 'هذه معاينة فقط. يفحص الخادم السعة والصلاحيات وتوفر العنوان عند الإرسال.')}</p></section>`
}

function bindAccountPlanPreviews(): void {
  document.querySelectorAll<HTMLElement>('[data-create-plan-preview]').forEach(preview => {
    const form = preview.closest('form[data-create-account-form]')
    const select = form?.querySelector<HTMLSelectElement>('[name="planId"]')
    const source = preview.querySelector('[data-plan-preview-model]')
    if (!select || !source) return
    let model: AccountPlanPreview
    try { model = JSON.parse(source.textContent || '{}') as AccountPlanPreview } catch { return }
    if (!Array.isArray(model.plans)) return
    const ar = document.documentElement.lang === 'ar'
    const refresh = () => {
      const plan = model.plans.find(item => item.id === select.value)
      const text = (selector: string, value: string) => { const node = preview.querySelector(selector); if (node) node.textContent = value }
      text('[data-preview-plan-name]', plan?.name ?? (ar ? 'غير متاح' : 'Unavailable'))
      for (const key of ['disk', 'memory', 'cpu'] as const) text('[data-preview-plan-' + key + ']', plan?.[key] === 'unlimited' ? (ar ? 'غير محدود' : 'Unlimited') : plan?.[key] ?? '—')
      const message = plan?.capacity === 'fits' ? (ar ? 'تناسب الخطة السعة المحملة. يُعاد الفحص عند الإرسال.' : 'Fits the loaded capacity. Checked again when submitted.')
        : plan?.capacity === 'exceeds' ? (ar ? 'تتجاوز الخطة السعة المحملة. راجع الخطة قبل الإرسال.' : 'Exceeds the loaded capacity. Review the plan before submitting.')
        : plan?.capacity === 'server-check' ? (ar ? 'يفحص الخادم السعة عند الإرسال.' : 'The server checks capacity when submitted.')
        : (ar ? 'فحص السعة غير متاح.' : 'Capacity preview is unavailable.')
      text('[data-preview-plan-capacity]', message)
    }
    select.addEventListener('change', refresh); refresh()
  })
}

function bindAccountLists(): void {
  document.querySelectorAll<HTMLElement>('[data-account-list-controls]').forEach(controls => {
    const workspace = controls.closest('[data-accounts-workspace]')
    if (!workspace) return
    const rows = Array.from(workspace.querySelectorAll<HTMLElement>('[data-account-row][data-list-search]'))
    const search = controls.querySelector<HTMLInputElement>('[data-list-search-input]')
    const owner = controls.querySelector<HTMLSelectElement>('[data-list-owner-filter]')
    const plan = controls.querySelector<HTMLSelectElement>('[data-list-plan-filter]')
    const state = controls.querySelector<HTMLSelectElement>('[data-list-state-filter]')
    const count = controls.querySelector<HTMLElement>('[data-list-count]')
    const empty = controls.querySelector<HTMLElement>('[data-list-empty]')
    const pages = controls.querySelector<HTMLElement>('[data-list-pages]')
    const previous = controls.querySelector<HTMLButtonElement>('[data-list-previous]')
    const next = controls.querySelector<HTMLButtonElement>('[data-list-next]')
    const current = controls.querySelector<HTMLElement>('[data-list-page]')
    if (!search || !owner || !plan || !state || !count || !empty || !pages || !previous || !next || !current) return
    const pageSize = Math.min(100, Math.max(1, Number(controls.dataset.listPageSize) || 20))
    const ar = document.documentElement.lang === 'ar'
    let page = 1
    const paint = () => {
      const term = search.value.trim().toLowerCase()
      const matched = rows.filter(row => (!term || (row.dataset.listSearch || '').includes(term)) && (!owner.value || (row.dataset.listOwner || 'root') === owner.value) && (!plan.value || row.dataset.listPlan === plan.value) && (!state.value || row.dataset.listState === state.value))
      const totalPages = Math.max(1, Math.ceil(matched.length / pageSize))
      page = Math.min(Math.max(1, page), totalPages)
      const start = (page - 1) * pageSize
      const visible = new Set(matched.slice(start, start + pageSize))
      rows.forEach(row => { row.hidden = !visible.has(row) })
      empty.hidden = matched.length !== 0
      pages.hidden = totalPages < 2
      previous.disabled = page === 1; next.disabled = page === totalPages
      current.textContent = `${page} / ${totalPages}`
      count.textContent = ar ? `عرض ${matched.length ? start + 1 : 0}-${Math.min(start + pageSize, matched.length)} من ${matched.length} حساب محمل` : `Showing ${matched.length ? start + 1 : 0}-${Math.min(start + pageSize, matched.length)} of ${matched.length} loaded accounts`
    }
    search.addEventListener('input', () => { page = 1; paint() })
    ;[owner, plan, state].forEach(control => control.addEventListener('change', () => { page = 1; paint() }))
    previous.addEventListener('click', () => { page -= 1; paint() })
    next.addEventListener('click', () => { page += 1; paint() })
    paint()
  })
}

export const ACCOUNT_LIST_CLIENT_SCRIPT = `(${bindAccountLists.toString()})(); (${bindAccountPlanPreviews.toString()})();`
