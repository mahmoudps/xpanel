/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export type AccountBulkOutcome = 'applied' | 'refused' | 'review-required' | 'not-attempted'
export interface AccountBulkItem { accountId: string; outcome: AccountBulkOutcome; code: string | null; reason: string | null }
export interface AccountBulkView { status: 'completed' | 'stopped' | 'interrupted'; replay: boolean; results: AccountBulkItem[] }
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>

/** Strict reader for /api/accounts/bulk-actions: exactly the submitted accounts, in order, each with a known outcome. */
export function readAccountBulkResult(value: unknown, accountIds: readonly string[], operationId: string): AccountBulkView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const outcomes = ['applied', 'refused', 'review-required', 'not-attempted']
  const code = (item: unknown): boolean => item === null || typeof item === 'string' && /^[A-Z][A-Z_]{0,39}$/.test(item)
  const reason = (item: unknown): boolean => item === null || typeof item === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(item)
  if (!object(value) || !object(value.operation) || value.operation.id !== operationId || !['completed', 'stopped', 'interrupted'].includes(String(value.operation.status))
    || typeof value.operation.replay !== 'boolean' || !Array.isArray(value.results) || value.results.length !== accountIds.length) throw new Error('invalid_account_bulk_result')
  const results = value.results.map((item: unknown, index: number): AccountBulkItem => {
    if (!object(item) || item.accountId !== accountIds[index] || !outcomes.includes(String(item.outcome)) || !code(item.code) || !reason(item.reason)
      || item.outcome === 'applied' && (item.code !== null || item.reason !== null)) throw new Error('invalid_account_bulk_result')
    return { accountId: item.accountId as string, outcome: item.outcome as AccountBulkOutcome, code: item.code as string | null, reason: item.reason as string | null }
  })
  return { status: value.operation.status as AccountBulkView['status'], replay: value.operation.replay, results }
}

function bindWhmAccountBulk(askDialog: Ask | undefined): void {
  // The API's ACCOUNT_BULK_LIMIT; the server refuses a larger selection before any change.
  const LIMIT = 25
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-accounts-workspace]').forEach(workspace => {
    const bar = workspace.querySelector<HTMLElement>('[data-approved-account-bulk]')
    if (!bar || bar.dataset.accountBulkBound === 'true') return
    bar.dataset.accountBulkBound = 'true'
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    const selectAll = bar.querySelector<HTMLInputElement>('[data-account-select-all]'), count = bar.querySelector<HTMLElement>('[data-account-selected-count]')
    const status = bar.querySelector<HTMLElement>('[data-account-bulk-status]'), list = bar.querySelector<HTMLElement>('[data-account-bulk-results]')
    const planChoice = bar.querySelector<HTMLSelectElement>('[data-account-bulk-plan-choice]'), ownerChoice = bar.querySelector<HTMLSelectElement>('[data-account-bulk-owner-choice]')
    const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>('[data-account-bulk-control]'))
    const can = { suspend: bar.dataset.accountBulkSuspend === 'true', plan: bar.dataset.accountBulkPlan === 'true' && !!planChoice, owner: bar.dataset.accountBulkOwner === 'true' && !!ownerChoice }
    // Without a session transport, a confirmation dialog or any permitted action the server-rendered controls stay disabled.
    if (!selectAll || !count || !status || !list || !request || !askDialog || !(can.suspend || can.plan || can.owner)) return
    const rows = (): HTMLElement[] => Array.from(workspace.querySelectorAll<HTMLElement>('[data-account-row][data-account-id]'))
    const selected = new Set<string>()
    let busy = false, review = false
    const note = (state: string, message: string): void => { status.hidden = !message; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const paint = (): void => {
      const all = rows(), visible = all.filter(row => !row.hidden), locked = busy || review
      for (const row of all) {
        const box = row.querySelector<HTMLInputElement>('[data-account-selection]')
        if (box) { box.disabled = locked; box.checked = selected.has(row.dataset.accountId ?? '') }
      }
      count.textContent = t('{n} selected', { n: selected.size })
      selectAll.disabled = locked || !visible.length
      selectAll.checked = visible.length > 0 && visible.every(row => selected.has(row.dataset.accountId ?? ''))
      for (const button of buttons) {
        const name = button.dataset.accountBulkControl
        const permitted = name === 'clear' || (name === 'plan' ? can.plan && !!planChoice?.value : name === 'owner' ? can.owner : can.suspend) && selected.size <= LIMIT
        button.disabled = locked || !permitted || selected.size === 0
      }
      if (planChoice) planChoice.disabled = locked || !can.plan
      if (ownerChoice) ownerChoice.disabled = locked || !can.owner
      bar.setAttribute('aria-busy', String(busy))
      if (!locked && selected.size > LIMIT) note('idle', t('Select at most {limit} accounts for one bulk change.', { limit: LIMIT }))
      else if (status.dataset.state === 'idle') note('idle', '')
    }
    const nameOf = (id: string): string => rows().find(row => row.dataset.accountId === id)?.dataset.accountRow ?? id
    const describe = (item: AccountBulkItem): string => {
      if (item.outcome === 'applied') return t('Changed. Hosting verification is still required.')
      if (item.outcome === 'not-attempted') return t('Not attempted.')
      if (item.outcome === 'review-required') return t('Outcome unknown. Review this account before retrying.')
      if (item.code === 'FORBIDDEN') return t('Not changed: you do not have permission for this account.')
      if (item.code === 'NOT_FOUND') return t('Not changed: this account is no longer available.')
      if (item.code === 'CONFLICT') return t('Not changed: the account is not in a state for this change.')
      if (item.code === 'LIMIT_EXCEEDED' || item.code === 'OVERSELL_BLOCKED') return t('Not changed: plan or owner limits do not allow it.')
      return t('Not changed.')
    }
    const confirm = async (title: string, body: string, label: string, reason = false): Promise<string | boolean | null> => {
      const answer = await askDialog(reason ? { title, body, input: true, label: t('Suspension reason'), confirm: label } : { title, body, confirm: label })
      return typeof answer === 'string' ? answer : answer === true
    }
    const run = async (name: string): Promise<void> => {
      if (busy || review) return
      const ids = rows().map(row => row.dataset.accountId ?? '').filter(id => selected.has(id))
      if (!ids.length || ids.length > LIMIT) return
      const who = ids.map(nameOf).join(', '), n = ids.length
      const extra: Record<string, unknown> = {}
      let path = ''
      if (name === 'suspend' && can.suspend) {
        const reason = await confirm(t('{n, plural, one {Suspend {n} account?} other {Suspend {n} accounts?}}', { n }), who + '\n' + t('Each account is changed in turn with the same checks as its own action.'), t('Suspend'), true)
        if (typeof reason !== 'string' || !reason) return
        extra.reason = reason; path = '/suspend'
      } else if (name === 'unsuspend' && can.suspend) {
        if (await confirm(t('{n, plural, one {Unsuspend {n} account?} other {Unsuspend {n} accounts?}}', { n }), who + '\n' + t('Each account is changed in turn with the same checks as its own action.'), t('Unsuspend')) !== true) return
        path = '/unsuspend'
      } else if (name === 'plan' && can.plan && planChoice?.value) {
        const plan = planChoice.selectedOptions[0]?.textContent ?? ''
        if (await confirm(t('{n, plural, one {Change {n} account to plan {plan}?} other {Change {n} accounts to plan {plan}?}}', { n, plan }), who + '\n' + t('Each account is changed in turn with the same checks as its own action.'), t('Change plan')) !== true) return
        extra.planId = planChoice.value; path = '/plan'
      } else if (name === 'owner' && can.owner && ownerChoice) {
        const owner = ownerChoice.selectedOptions[0]?.textContent ?? ''
        if (await confirm(t('{n, plural, one {Move {n} account to owner {owner}?} other {Move {n} accounts to owner {owner}?}}', { n, owner }), who + '\n' + t('Each account is changed in turn with the same checks as its own action.'), t('Change owner')) !== true) return
        extra.ownerId = ownerChoice.value === '' ? null : ownerChoice.value; path = '/owner'
      } else return
      if (busy || review || !bar.isConnected) return
      const operationId = crypto.randomUUID()
      busy = true; list.replaceChildren(); list.hidden = true; paint(); note('loading', t('Submitting…'))
      try {
        const view = readAccountBulkResult(await request('POST', '/api/accounts/bulk-actions' + path, { operationId, accounts: ids.map(id => ({ id })), ...extra }), ids, operationId)
        for (const item of view.results) {
          const entry = document.createElement('li'), label = document.createElement('bdi')
          entry.dataset.outcome = item.outcome; label.dir = 'ltr'; label.textContent = nameOf(item.accountId)
          entry.append(label, ' ', describe(item)); list.append(entry)
          if (item.outcome !== 'applied') continue
          selected.delete(item.accountId)
          const row = rows().find(candidate => candidate.dataset.accountId === item.accountId)
          const cell = row?.querySelector<HTMLElement>('[data-account-status]'), pending = row?.querySelector<HTMLTemplateElement>('template[data-account-status-pending]')
          if (cell && pending) { cell.replaceChildren(pending.content.cloneNode(true)); cell.setAttribute('data-state', 'verification-required') }
        }
        list.hidden = false
        const tally = (outcome: AccountBulkOutcome): number => view.results.filter(item => item.outcome === outcome).length
        review = tally('review-required') > 0
        note(review ? 'failed' : 'pending', t('Bulk change finished: {applied} changed, {refused} not changed, {review} need review, {skipped} not attempted.', { applied: tally('applied'), refused: tally('refused'), review: tally('review-required'), skipped: tally('not-attempted') })
          + (review ? ' ' + t('Reload accounts and review them before another bulk change.') : ''))
      } catch (error) {
        const problem = error && typeof error === 'object' ? error as { status?: number; details?: Record<string, unknown> } : {}
        const details = problem.details && typeof problem.details === 'object' ? problem.details : {}
        if (details.stateChanged !== false) { review = true; note('failed', t('The bulk result could not be verified. Reload accounts and review them before retrying.')) }
        else note('failed', problem.status === 403 ? t('You do not have permission for this action.') : problem.status === 401 ? t('Your session expired. Sign in again.') : t('Bulk change unavailable. No changes were made.'))
      } finally { busy = false; paint() }
    }
    workspace.addEventListener('change', event => {
      const box = event.target instanceof HTMLInputElement && event.target.matches('[data-account-selection]') ? event.target : null
      const id = box?.closest<HTMLElement>('[data-account-row]')?.dataset.accountId
      if (!box || !id || busy || review) return
      if (box.checked) selected.add(id); else selected.delete(id)
      paint()
    })
    selectAll.addEventListener('change', () => {
      if (busy || review) return
      for (const row of rows()) if (!row.hidden && row.dataset.accountId) { if (selectAll.checked) selected.add(row.dataset.accountId); else selected.delete(row.dataset.accountId) }
      paint()
    })
    // Filters and the pager change which rows are visible; repaint so select-all reflects the current page.
    workspace.addEventListener('input', () => { if (!busy) paint() })
    workspace.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-account-bulk-control]') : null
      if (!button || !bar.contains(button) || button.disabled) { if (!busy) paint(); return }
      if (button.dataset.accountBulkControl === 'clear') { selected.clear(); paint(); return }
      void run(button.dataset.accountBulkControl ?? '')
    })
    planChoice?.addEventListener('change', paint)
    paint()
  })
}

export const WHM_ACCOUNT_BULK_CLIENT_BINDING = `(()=>{const readAccountBulkResult=${readAccountBulkResult.toString()};return ${bindWhmAccountBulk.toString()};})()`
