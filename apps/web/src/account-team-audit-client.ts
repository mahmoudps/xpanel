/// <reference lib="dom" />
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate, formatDisplayDateTime = canonicalFormatDisplayDateTime

export interface TeamAuditRowView { id: string; at: string; caller: string; kind: string; action: string; target: string; outcome: string }
export function readTeamAudit(raw: unknown, accountId: string): { rows: TeamAuditRowView[]; nextBefore: string | null } {
  const v = raw as { context?: { accountId?: unknown }; rows?: unknown; nextBefore?: unknown } | null
  if (!v || v.context?.accountId !== accountId || !Array.isArray(v.rows) || v.rows.length > 50 || !(v.nextBefore === null || typeof v.nextBefore === 'string')
    || v.rows.some(row => !row || ['id', 'at', 'caller', 'kind', 'action', 'target', 'outcome'].some(key => typeof (row as Record<string, unknown>)[key] !== 'string'))) throw new Error('invalid_team_audit')
  return { rows: v.rows as TeamAuditRowView[], nextBefore: v.nextBefore }
}

function bindTeamAudit(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  for (const root of document.querySelectorAll<HTMLElement>('[data-team-audit]')) {
    if (!request || root.dataset.bound === 'true' || root.closest('[data-readonly="true"]')) continue
    root.dataset.bound = 'true'
    const accountId = root.dataset.teamAudit ?? '', body = root.querySelector<HTMLElement>('[data-team-audit-rows]'), status = root.querySelector<HTMLElement>('[data-team-audit-status]')
    const search = root.querySelector<HTMLInputElement>('[data-team-audit-search]'), read = root.querySelector<HTMLButtonElement>('[data-team-audit-read]'), more = root.querySelector<HTMLButtonElement>('[data-team-audit-more]')
    if (!body || !status || !search || !read || !more) continue
    let next: string | null = null
    const load = (append: boolean): void => {
      const query = new URLSearchParams({ ...(search.value.trim() ? { q: search.value.trim() } : {}), ...(append && next ? { before: next } : {}) }).toString()
      read.disabled = true; more.disabled = true; status.dataset.state = 'reading'; status.textContent = t('Reading…')
      request('GET', '/api/account/team-audit' + (query ? '?' + query : '')).then(raw => {
        const view = readTeamAudit(raw, accountId), rows = view.rows.map(row => {
          const node = cloneClientTemplate(clientTemplate(root, 'team-audit-row'), 'tr', ['at', 'caller', 'action', 'target', 'outcome'])
          clientTemplateSlot(node, 'at').textContent = formatDisplayDateTime(row.at); clientTemplateSlot(node, 'caller').textContent = row.kind === 'team' ? row.caller : t('Owner: {name}', { name: row.caller })
          clientTemplateSlot(node, 'action').textContent = row.action; clientTemplateSlot(node, 'target').textContent = row.target; clientTemplateSlot(node, 'outcome').textContent = row.outcome === 'ok' ? t('Succeeded') : t('Failed')
          return node
        })
        if (append) body.append(...rows); else body.replaceChildren(...rows)
        next = view.nextBefore; more.hidden = next === null; more.disabled = false
        status.dataset.state = 'read'; status.textContent = rows.length || append ? t('Team activity read.') : t('No activity matches.')
      }).catch(() => { status.dataset.state = 'failed'; status.textContent = t('Team activity could not be read.') }).finally(() => { read.disabled = false })
    }
    search.disabled = false; read.disabled = false
    read.addEventListener('click', () => load(false))
    more.addEventListener('click', () => load(true))
  }
}

export const TEAM_AUDIT_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const readTeamAudit=${readTeamAudit.toString()};(${bindTeamAudit.toString()})()})`
