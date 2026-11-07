/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export type DomainBulkOutcome = 'applied' | 'refused' | 'review-required' | 'not-attempted'
export interface DomainBulkItem { domainId: string; outcome: DomainBulkOutcome; code: string | null; reason: string | null }
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>

/** Strict reader for /api/domains/bulk-actions: exactly the submitted sites, in order. */
export function readDomainBulkResult(value: unknown, ids: readonly string[]): DomainBulkItem[] {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const outcomes = ['applied', 'refused', 'review-required', 'not-attempted']
  if (!object(value) || !Array.isArray(value.results) || value.results.length !== ids.length) throw new Error('invalid_domain_bulk_result')
  return value.results.map((item: unknown, index: number): DomainBulkItem => {
    if (!object(item) || item.domainId !== ids[index] || !outcomes.includes(String(item.outcome))) throw new Error('invalid_domain_bulk_result')
    return { domainId: item.domainId as string, outcome: item.outcome as DomainBulkOutcome, code: typeof item.code === 'string' ? item.code : null, reason: typeof item.reason === 'string' ? item.reason : null }
  })
}

function bindWhmDomainBulk(askDialog: Ask | undefined): void {
  // The API's DOMAIN_BULK_LIMIT; the server refuses a larger selection before any change.
  const LIMIT = 25
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-domain-bulk]').forEach(bar => {
    if (bar.dataset.domainBulkBound === 'true') return
    bar.dataset.domainBulkBound = 'true'
    const workspace = bar.closest<HTMLElement>('[data-whm-table-workspace]') ?? bar.parentElement!
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    const action = bar.querySelector<HTMLSelectElement>('[data-domain-bulk-action]'), value = bar.querySelector<HTMLInputElement>('[data-domain-bulk-value]'), run = bar.querySelector<HTMLButtonElement>('[data-domain-bulk-run]')
    const status = bar.querySelector<HTMLElement>('[data-domain-bulk-status]'), list = bar.querySelector<HTMLElement>('[data-domain-bulk-results]'), count = bar.querySelector<HTMLElement>('[data-domain-bulk-count]')
    if (!action || !value || !run || !status || !list || !count || !request || !askDialog) return
    const boxes = (): HTMLInputElement[] => Array.from(workspace.querySelectorAll<HTMLInputElement>('[data-domain-select]'))
    const chosen = (): HTMLInputElement[] => boxes().filter(box => box.checked && !box.closest('[hidden]'))
    let busy = false, review = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const needsValue = (): boolean => ['expiry', 'php', 'category'].includes(action.value)
    const paint = (): void => {
      const size = chosen().length
      count.textContent = t('{n} selected', { n: size })
      for (const box of boxes()) box.disabled = busy || review
      action.disabled = busy || review
      value.disabled = busy || review || !needsValue(); value.type = action.value === 'expiry' ? 'date' : 'text'
      run.disabled = busy || review || !size || size > LIMIT || (action.value === 'php' && !value.value.trim()) || (action.value === 'category' && !value.value.trim())
    }
    const submit = async (): Promise<void> => {
      const selected = chosen(), ids = selected.map(box => box.dataset.domainSelect ?? ''), names = selected.map(box => box.dataset.domainName ?? '')
      const verb = action.value, extra: Record<string, unknown> = verb === 'expiry' ? { expiresAt: value.value ? value.value + 'T00:00:00.000Z' : null } : verb === 'php' ? { version: value.value.trim() } : verb === 'category' ? { category: value.value.trim() || null } : {}
      if (!ids.length || busy || review) return
      const dangerous = verb === 'delete' || verb === 'stop'
      const body = names.join('\n') + '\n' + (verb === 'delete' ? t('Back the sites up first. Deleting removes each site from the server and keeps its files in the account home.') : t('Each site is changed in turn, with the same checks as a single change.'))
      const typed = verb === 'delete' ? await askDialog!({ title: t('Delete {n} sites?', { n: ids.length }), danger: true, confirm: t('Delete'), body, input: true, label: t('Type delete to confirm') }).then(answer => answer === 'delete').catch(() => false) : await askDialog!({ title: t('Apply this change to {n} sites?', { n: ids.length }), danger: dangerous, confirm: t('Apply'), body }).catch(() => false)
      if (!typed) return
      busy = true; list.replaceChildren(); paint(); note('loading', t('Submitting…'))
      try {
        const results = readDomainBulkResult(await request!('POST', '/api/domains/bulk-actions', { action: verb, ...extra, domains: ids.map((id, index) => ({ id, ...(verb === 'delete' && { confirmName: names[index] }) })) }), ids)
        const tally = (outcome: DomainBulkOutcome): number => results.filter(item => item.outcome === outcome).length
        for (const [index, item] of results.entries()) {
          const entry = document.createElement('li'), label = document.createElement('bdi')
          entry.dataset.outcome = item.outcome; label.dir = 'ltr'; label.textContent = names[index]!
          entry.append(label, ' ', item.outcome === 'applied' ? t('Changed') : item.outcome === 'refused' ? t('Not changed: {reason}', { reason: item.reason ?? item.code ?? t('refused') }) : item.outcome === 'review-required' ? t('Needs review') : t('Not attempted'))
          list.append(entry)
        }
        review = tally('review-required') > 0
        note(review ? 'failed' : 'pending', t('Bulk change finished: {applied} changed, {refused} not changed, {review} need review, {skipped} not attempted.', { applied: tally('applied'), refused: tally('refused'), review: tally('review-required'), skipped: tally('not-attempted') }) + ' ' + t('Reload the page to read the saved sites.'))
      } catch (error) {
        const details = error && typeof error === 'object' ? (error as { details?: Record<string, unknown> }).details : null
        if (details?.stateChanged !== false) { review = true; note('failed', t('The bulk result could not be verified. Reload the page and review the sites before retrying.')) }
        else note('failed', t('Bulk change unavailable. No changes were made.'))
      } finally { busy = false; paint() }
    }
    workspace.addEventListener('change', event => { if (event.target instanceof Element && event.target.matches('[data-domain-select],[data-domain-select-all]')) { if (event.target.matches('[data-domain-select-all]')) for (const box of boxes()) if (!box.closest('[hidden]')) box.checked = (event.target as HTMLInputElement).checked; paint() } })
    action.addEventListener('change', paint); value.addEventListener('input', paint)
    run.addEventListener('click', () => { if (!run.disabled) void submit() })
    paint()
  })
}

export const WHM_DOMAIN_BULK_CLIENT_BINDING = `(()=>{const readDomainBulkResult=${readDomainBulkResult.toString()};return ${bindWhmDomainBulk.toString()}})()`
