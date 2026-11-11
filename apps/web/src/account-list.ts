import { type MessageValues, translator, type Locale } from './i18n.ts'
/// <reference lib="dom" />
import type { Account } from '@xpanel/core'
import { escapeHtml } from './tokens.ts'
import type { AccountListModel, AccountPlanPreview } from './models/account-list.ts'
export { accountListModel, accountPlanPreviewModel, type AccountListInput, type AccountListModel, type AccountPlanPreview } from './models/account-list.ts'

/** These attributes are routing/filter keys, never displayed reference numbers. */
export function accountListRowAttributes(account: Account): string {
  return `data-list-search="${escapeHtml(`${account.username} ${account.primaryDomain}`.toLowerCase())}" data-list-owner="${escapeHtml(account.ownerId ?? '')}" data-list-plan="${escapeHtml(account.planId)}" data-list-state="${escapeHtml(account.status)}"`
}

export function renderAccountListControls(model: AccountListModel, locale: Locale = 'en'): string {
  const copy = (message: string, values?: MessageValues) => escapeHtml(translator(locale)(message, values))
  if (model.state === 'forbidden') return `<p class="xp-help">${copy('Account listing is not permitted.')}</p>`
  if (model.state === 'unavailable') return `<p class="xp-help">${copy('The account list is unavailable.')}</p>`
  const options = (items: readonly { value: string; label: string }[]) => items.map(item => `<option value="${escapeHtml(item.value === '' ? 'root' : item.value)}">${escapeHtml(item.label)}</option>`).join('')
  return `<div class="xp-form-group" data-account-list-controls data-list-page-size="20">
    <div class="xp-field"><label class="xp-label" for="account-list-search">${copy('Search loaded accounts')}</label><input id="account-list-search" class="xp-input" type="search" data-list-search-input autocomplete="off" /></div>
    <div class="xp-field"><label class="xp-label" for="account-list-owner">${copy('Owner')}</label><select id="account-list-owner" class="xp-select" data-list-owner-filter><option value="" selected>${copy('All owners')}</option>${options(model.owners)}</select></div>
    <div class="xp-field"><label class="xp-label" for="account-list-plan">${copy('Plan')}</label><select id="account-list-plan" class="xp-select" data-list-plan-filter><option value="" selected>${copy('All plans')}</option>${options(model.plans)}</select></div>
    <div class="xp-field"><label class="xp-label" for="account-list-state">${copy('Status')}</label><select id="account-list-state" class="xp-select" data-list-state-filter><option value="" selected>${copy('All statuses')}</option><option value="active">${copy('Active')}</option><option value="suspended">${copy('Suspended')}</option><option value="terminating">${copy('Terminating')}</option></select></div>
    <p class="xp-help" data-list-count role="status" aria-live="polite"></p>
    <p class="xp-help" data-list-empty hidden>${copy('No accounts match these filters.')}</p>
    <nav class="xp-plan-editor-actions" data-list-pages aria-label="${copy('Loaded account pages')}" hidden><button type="button" class="xp-btn" data-list-previous>${copy('Previous')}</button><span class="xp-tabular" data-list-page></span><button type="button" class="xp-btn" data-list-next>${copy('Next')}</button></nav>
  </div>`
}

export function renderAccountPlanPreview(model: AccountPlanPreview, locale: Locale = 'en'): string {
  const copy = (message: string, values?: MessageValues) => escapeHtml(translator(locale)(message, values))
  const json = JSON.stringify(model).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
  return `<section class="xp-card xp-form-group" style="gap:var(--xp-space-group,24px)" data-create-plan-preview><h2 class="xp-section-title" style="margin:0">${copy('Selected plan')}</h2><script type="application/json" data-plan-preview-model>${json}</script><dl class="xp-accounts__technical" style="margin:0"><div class="xp-field"><dt>${copy('Plan')}</dt><dd data-preview-plan-name></dd></div><div class="xp-field"><dt>${copy('Disk (MiB)')}</dt><dd><bdi dir="ltr" data-preview-plan-disk></bdi></dd></div><div class="xp-field"><dt>${copy('Memory (MiB)')}</dt><dd><bdi dir="ltr" data-preview-plan-memory></bdi></dd></div><div class="xp-field"><dt>${copy('CPU (%)')}</dt><dd><bdi dir="ltr" data-preview-plan-cpu></bdi></dd></div></dl><p class="xp-help" data-preview-plan-capacity role="status" aria-live="polite"></p><p class="xp-help">${copy('Preview only. The server checks capacity, permissions and address availability when submitted.')}</p></section>`
}

function bindAccountPlanPreviews(): void {
  document.querySelectorAll<HTMLElement>('[data-create-plan-preview]').forEach(preview => {
    const form = preview.closest('form[data-create-account-form]')
    // The plan is one list or a group of choices: read the checked choice, or the single control.
    const fields = Array.from(form?.querySelectorAll<HTMLSelectElement | HTMLInputElement>('[name="planId"]') ?? [])
    const source = preview.querySelector('[data-plan-preview-model]')
    if (!fields.length || !source) return
    let model: AccountPlanPreview
    try { model = JSON.parse(source.textContent || '{}') as AccountPlanPreview } catch { return }
    if (!Array.isArray(model.plans)) return
    const refresh = () => {
      const selected = fields.find(field => field.type !== 'radio' || (field as HTMLInputElement).checked)?.value
      const plan = model.plans.find(item => item.id === selected)
      const text = (selector: string, value: string) => { const node = preview.querySelector(selector); if (node) node.textContent = value }
      text('[data-preview-plan-name]', plan?.name ?? (xpT('Unavailable')))
      for (const key of ['disk', 'memory', 'cpu'] as const) text('[data-preview-plan-' + key + ']', plan?.[key] === 'unlimited' ? (xpT('Unlimited')) : plan?.[key] ?? '—')
      const message = plan?.capacity === 'fits' ? (xpT('Fits the loaded capacity. Checked again when submitted.'))
        : plan?.capacity === 'exceeds' ? (xpT('Exceeds the loaded capacity. Review the plan before submitting.'))
        : plan?.capacity === 'server-check' ? (xpT('The server checks capacity when submitted.'))
        : (xpT('Capacity preview is unavailable.'))
      text('[data-preview-plan-capacity]', message)
    }
    fields.forEach(field => field.addEventListener('change', refresh))
    form?.addEventListener('reset', () => setTimeout(refresh, 0))
    refresh()
  })
}

/**
 * Mirrors named form fields into review cells. A password is never mirrored.
 * The account form fills data-create-review cells of its workspace. Any other page marks a scope with
 * data-form-review: its data-form-review-field="<name>" cells follow the controls of that name inside the scope.
 */
function bindAccountCreateReviews(): void {
  const mirror = (host: HTMLElement, cell: HTMLElement, name: string): void => {
    const blank = cell.textContent ?? ''
    const text = (field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string | undefined => field instanceof HTMLSelectElement ? field.selectedOptions[0]?.textContent ?? ''
      : field instanceof HTMLInputElement && field.type === 'checkbox' ? (field.checked ? field.dataset.reviewLabel ?? field.value : field.dataset.reviewOff ?? '')
        : field.dataset.reviewLabel ?? field.value
    const refresh = () => {
      const fields = Array.from(host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input[name], select[name], textarea[name]')).filter(field => field.name === name)
      if (!fields.length || fields.some(field => field.type === 'password')) return
      const chosen = fields.some(field => field.type === 'radio') ? fields.filter(field => field.type === 'radio' && (field as HTMLInputElement).checked) : fields
      cell.textContent = chosen.map(field => text(field)?.trim()).filter(Boolean).join(', ') || blank
    }
    host.addEventListener('input', refresh); host.addEventListener('change', refresh)
    host.addEventListener('reset', () => setTimeout(refresh, 0))
    refresh()
  }
  document.querySelectorAll<HTMLElement>('[data-create-review]').forEach(cell => {
    const form = cell.closest('[data-accounts-workspace]')?.querySelector<HTMLFormElement>('form[data-create-account-form]')
    if (form) mirror(form, cell, cell.dataset.createReview ?? '')
  })
  document.querySelectorAll<HTMLElement>('[data-form-review]').forEach(scope => {
    scope.querySelectorAll<HTMLElement>('[data-form-review-field]').forEach(cell => mirror(scope, cell, cell.dataset.formReviewField ?? ''))
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
    // Optional quick chips set the status filter; data-list-state-chip holds the status, empty for all.
    const chips = Array.from(workspace.querySelectorAll<HTMLButtonElement>('button[data-list-state-chip]'))
    const pageSize = Math.min(100, Math.max(1, Number(controls.dataset.listPageSize) || 20))
    let page = 1
    const paint = () => {
      const term = search.value.trim().toLowerCase()
      const matched = rows.filter(row => (!term || (row.dataset.listSearch || '').includes(term)) && (!owner.value || (row.dataset.listOwner || 'root') === owner.value) && (!plan.value || row.dataset.listPlan === plan.value) && (!state.value || row.dataset.listState === state.value))
      const totalPages = Math.max(1, Math.ceil(matched.length / pageSize))
      page = Math.min(Math.max(1, page), totalPages)
      const start = (page - 1) * pageSize
      const visible = new Set(matched.slice(start, start + pageSize))
      rows.forEach(row => { row.hidden = !visible.has(row) })
      chips.forEach(chip => chip.setAttribute('aria-pressed', String((chip.dataset.listStateChip ?? '') === state.value)))
      empty.hidden = matched.length !== 0
      pages.hidden = totalPages < 2
      previous.disabled = page === 1; next.disabled = page === totalPages
      current.textContent = `${page} / ${totalPages}`
      count.textContent = xpT('Showing {value}-{value2} of {length} loaded accounts', { value: matched.length ? start + 1 : 0, value2: Math.min(start + pageSize, matched.length), length: matched.length })
    }
    search.addEventListener('input', () => { page = 1; paint() })
    ;[owner, plan, state].forEach(control => control.addEventListener('change', () => { page = 1; paint() }))
    chips.forEach(chip => chip.addEventListener('click', () => { state.value = chip.dataset.listStateChip ?? ''; page = 1; paint() }))
    previous.addEventListener('click', () => { page -= 1; paint() })
    next.addEventListener('click', () => { page += 1; paint() })
    paint()
  })
}

export const ACCOUNT_LIST_CLIENT_SCRIPT = `(${bindAccountLists.toString()})(); (${bindAccountPlanPreviews.toString()})(); (${bindAccountCreateReviews.toString()})();`
