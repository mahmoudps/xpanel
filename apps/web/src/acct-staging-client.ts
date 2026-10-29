/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
export type StagingRecordView = { domainId: string; domain: string; state: 'ready' | 'incomplete' | 'unknown'; files: number; createdAt: string; createdBy: string; promotedAt: string | null }
export type StagingListView = { domains: { id: string; name: string; kind: string }[]; records: StagingRecordView[]; revision: string; agent: boolean }
export type StagingReviewView = { liveFiles: number; stagingFiles: number; stagingExists: boolean; links: number; rows: { path: string; change: 'add' | 'change' | 'remove'; bytes: number }[]; revision: string }
export type StagingChangeView = { outcome: string; verificationRequired: boolean; results: { path: string; change: string; result: 'applied' | 'failed' | 'not-attempted'; verificationRequired: boolean }[]; records: StagingRecordView[]; recordsRevision: string }

/** Strict reply contract for /api/account/staging (apps/api/src/acct-staging-workspace.ts), bound to the account and domain. */
export function readStagingReply(kind: 'list', value: unknown, expected: { accountId: string }): StagingListView
export function readStagingReply(kind: 'review', value: unknown, expected: { accountId: string; domainId: string }): StagingReviewView
export function readStagingReply(kind: 'copy' | 'promote' | 'discard', value: unknown, expected: { accountId: string; domainId: string; revision?: string }): StagingChangeView
export function readStagingReply(kind: string, value: unknown, expected: { accountId: string; domainId?: string; revision?: string }): unknown {
  const bad = (): never => { throw new Error('invalid_staging_' + kind) }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const count = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0
  const digest = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const uuid = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const stamp = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item)
  const host = (item: unknown): item is string => typeof item === 'string' && /^[a-z0-9.-]{1,253}$/.test(item)
  const path = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 4096 && !/[\u0000-\u001f\u007f\\]/.test(item) && !item.startsWith('/') && item.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  const records = (item: unknown): StagingRecordView[] => Array.isArray(item) && item.length <= 100 ? item.map(record => object(record) && uuid(record.domainId) && host(record.domain) && ['ready', 'incomplete', 'unknown'].includes(record.state as string) && count(record.files) && stamp(record.createdAt)
    && typeof record.createdBy === 'string' && (record.promotedAt === null || stamp(record.promotedAt)) ? { domainId: record.domainId, domain: record.domain, state: record.state as StagingRecordView['state'], files: record.files, createdAt: record.createdAt, createdBy: record.createdBy, promotedAt: record.promotedAt as string | null } : bad()) : bad()
  if (!object(value) || !object(value.context) || value.context.accountId !== expected.accountId) return bad()
  if (kind === 'list') {
    if (!Array.isArray(value.domains) || value.domains.length > 1000 || !digest(value.revision) || !object(value.capabilities) || typeof value.capabilities.agent !== 'boolean') return bad()
    return { domains: value.domains.map(item => object(item) && uuid(item.id) && host(item.name) && typeof item.kind === 'string' ? { id: item.id, name: item.name, kind: item.kind } : bad()), records: records(value.records), revision: value.revision, agent: value.capabilities.agent }
  }
  if (value.context.domainId !== expected.domainId) return bad()
  if (kind === 'review') {
    const live = value.live, staging = value.staging
    if (!object(live) || !object(staging) || !count(live.files) || !count(staging.files) || !count(staging.links) || typeof staging.exists !== 'boolean' || !digest(value.revision) || !Array.isArray(value.rows) || value.rows.length > 1000) return bad()
    return { liveFiles: live.files, stagingFiles: staging.files, stagingExists: staging.exists, links: staging.links, revision: value.revision,
      rows: value.rows.map(row => object(row) && path(row.path) && ['add', 'change', 'remove'].includes(row.change as string) && count(row.bytes) ? { path: row.path, change: row.change as 'add', bytes: row.bytes } : bad()) }
  }
  if (typeof value.outcome !== 'string' || typeof value.verificationRequired !== 'boolean' || !digest(value.recordsRevision) || (kind === 'promote' && value.revision !== expected.revision)) return bad()
  const results = kind === 'promote' ? (Array.isArray(value.results) && value.results.length <= 1000 ? value.results : bad()).map(row => object(row) && path(row.path) && typeof row.change === 'string' && ['applied', 'failed', 'not-attempted'].includes(row.result as string) && typeof row.verificationRequired === 'boolean'
    ? { path: row.path, change: row.change, result: row.result as 'applied', verificationRequired: row.verificationRequired } : bad()) : []
  return { outcome: value.outcome, verificationRequired: value.verificationRequired, results, records: records(value.records), recordsRevision: value.recordsRevision }
}

function bindAccountStaging(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-staging]').forEach(root => {
    if (root.dataset.stagingBound === 'true') return
    root.dataset.stagingBound = 'true'
    const find = <T extends HTMLElement>(name: string): T | null => root.querySelector<T>('[data-staging-' + name + ']')
    const status = find('status'), rowsBody = find('rows'), refresh = find<HTMLButtonElement>('refresh'), reviewBody = find('review'), ack = find<HTMLInputElement>('ack'), promote = find<HTMLButtonElement>('promote'), resultsBody = find('results')
    if (!status || !rowsBody || !refresh || !reviewBody || !ack || !promote || !resultsBody) return
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const accountId = root.dataset.account ?? ''
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.stagingManage === 'true' && !!accountId && !root.closest(denied)
    if (!admitted()) return
    let busy = false, list: StagingListView | null = null, reviewed: (StagingReviewView & { domainId: string }) | null = null
    const STATES: Record<string, string> = { ready: msgid('Ready'), incomplete: msgid('Incomplete: discard and copy again'), unknown: msgid('Needs inspection: discard and copy again') }
    const CHANGES: Record<string, string> = { add: msgid('Added'), change: msgid('Changed'), remove: msgid('Removed') }
    const RESULTS: Record<string, string> = { applied: msgid('Applied and verified'), failed: msgid('Failed'), 'not-attempted': msgctxt('acct-staging-client', 'Not attempted yet') }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const failure = (error: unknown): string => {
      const problem = (error ?? {}) as { code?: unknown; message?: unknown; details?: { verificationRequired?: unknown } }
      if (problem.details?.verificationRequired === true) return t('The staging outcome could not be verified. Inspect the site and the staging folder before trying again.')
      if (typeof problem.message === 'string' && problem.message.startsWith('invalid_staging_')) return t('The server response could not be verified. Nothing is assumed.')
      const known: Record<string, string> = { FORBIDDEN: msgid('You are not authorized for this account or action.'), NOT_FOUND: msgid('The domain or staging copy no longer exists.'), CONFLICT: msgid('The site or staging copy changed. Read it again.'),
        LIMIT_EXCEEDED: msgid('This site is larger than a staging copy can hold.'), VALIDATION: msgid('The request was refused as invalid.'), PRECONDITION_FAILED: msgid('The server cannot do this now.') }
      const copy = known[String(problem.code)], detail = typeof problem.message === 'string' ? ' ' + problem.message : ''
      return (copy ? t(copy) : t('The request failed.')) + detail
    }
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, value?: string): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; return node }
    const technical = (value: string): HTMLElement => { const node = element('bdi', value); node.dir = 'ltr'; return node }
    const size = (bytes: number): string => bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / 1048576).toFixed(1) + ' MiB'
    const cell = (...nodes: (Node | string)[]): HTMLTableCellElement => { const td = element('td'); td.append(...nodes); return td }
    const fill = (body: HTMLElement, rows: HTMLTableRowElement[], empty: string, columns: number): void => { if (rows.length) { body.replaceChildren(...rows); return }; const row = element('tr'), td = cell(empty); td.colSpan = columns; row.append(td); body.replaceChildren(row) }
    const fact = (name: string, value: Node | string): void => { find(name)?.replaceChildren(value) }
    const button = (label: string, action: string, domainId: string, name: string): HTMLButtonElement => { const node = element('button', label); node.type = 'button'; node.className = 'xp-btn'; node.dataset.action = action; node.dataset.domain = domainId; node.setAttribute('aria-label', label + ' ' + name); return node }
    const sync = (): void => {
      refresh.disabled = busy
      rowsBody.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(node => { node.disabled = busy || !list?.agent || (node.dataset.action === 'discard' && typeof askDialog !== 'function') })
      const ready = !!reviewed && reviewed.rows.length > 0 && reviewed.links === 0
      if (!ready) ack.checked = false
      ack.disabled = busy || !ready; promote.disabled = busy || !ready || !ack.checked
    }
    const invalidate = (): void => { reviewed = null; ack.checked = false; fill(reviewBody, [], t('No changes have been reviewed.'), 3); ['domain', 'live', 'staging', 'changes'].forEach(name => fact(name, t('Not read'))) }
    const paint = (view: StagingListView): void => {
      list = view
      fill(rowsBody, view.domains.map(domain => {
        const record = view.records.find(item => item.domainId === domain.id), row = element('tr'), actions = element('div')
        actions.className = 'xp-account-staging__actions'
        if (!record) actions.append(button(t('Create staging copy'), 'copy', domain.id, domain.name))
        else { if (record.state === 'ready') actions.append(button(t('Review changes'), 'review', domain.id, domain.name)); actions.append(button(t('Discard'), 'discard', domain.id, domain.name)) }
        row.append(cell(technical(domain.name)), cell(record ? technical('staging/' + domain.name) : t('None')), cell(record ? t(STATES[record.state]!) : t('No staging copy')), cell(record ? technical(String(record.files)) : ''),
          cell(record ? technical(displayDateTime(record.createdAt)) : ''), cell(record?.promotedAt ? technical(displayDateTime(record.promotedAt)) : record ? t('Never') : ''), cell(actions))
        return row
      }), t('This account has no site that can be staged.'), 7)
      sync()
    }
    const run = async (loading: string, operation: () => Promise<void>): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; sync(); note('loading', loading)
      try { await operation() } catch (error) { note('failed', failure(error)); if ((error as { code?: unknown } | null)?.code === 'CONFLICT') invalidate() } finally { busy = false; sync() }
    }
    const read = (): Promise<void> => run(t('Reading staging copies…'), async () => {
      const view = readStagingReply('list', await transport!('GET', '/api/account/staging'), { accountId })
      paint(view)
      note(view.agent ? 'read' : 'unavailable', view.agent ? t('Staging copies were read.') : t('The host agent is not connected; staging copies cannot be created or changed.'))
    })
    const changed = (view: StagingChangeView, message: string): void => {
      if (list) paint({ ...list, records: view.records, revision: view.recordsRevision })
      note(view.verificationRequired ? 'failed' : 'read', view.verificationRequired ? t('The outcome requires inspection of the site and the staging folder.') : message)
    }
    rowsBody.addEventListener('click', event => {
      const node = (event.target as Element).closest<HTMLButtonElement>('button[data-action]')
      if (!node || node.disabled || !list) return
      const domainId = node.dataset.domain!, name = list.domains.find(item => item.id === domainId)?.name ?? '', base = '/api/account/staging/' + domainId
      if (node.dataset.action === 'copy') void run(t('Copying the site files…'), async () => {
        const view = readStagingReply('copy', await transport!('POST', base + '/copy', { expectedRecordsRevision: list!.revision }), { accountId, domainId })
        changed(view, view.outcome === 'copied' ? t('The staging copy of {domain} is ready.', { domain: name }) : t('The staging copy is incomplete. Discard it and copy again.'))
      })
      if (node.dataset.action === 'review') void run(t('Comparing the live site with the staging copy…'), async () => {
        const view = readStagingReply('review', await transport!('POST', base + '/review', {}), { accountId, domainId })
        reviewed = { ...view, domainId }; ack.checked = false
        fill(reviewBody, view.rows.map(row => { const line = element('tr'); line.append(cell(technical(row.path)), cell(t(CHANGES[row.change]!)), cell(technical(size(row.bytes)))); return line }), t('The staging copy matches the live site.'), 3)
        fact('domain', technical(name)); fact('live', technical(String(view.liveFiles))); fact('staging', technical(String(view.stagingFiles))); fact('changes', technical(String(view.rows.length)))
        note('read', view.links ? t('The staging copy contains links; remove them before promoting.') : view.rows.length ? t('Review the changes, confirm them, then promote.') : t('The staging copy matches the live site.'))
      })
      if (node.dataset.action === 'discard' && typeof askDialog === 'function') void (async () => {
        let confirmed = false
        try { confirmed = await askDialog({ title: t('Discard this staging copy?'), danger: true, confirm: t('Discard'), cancel: t('Keep it'), body: t('The staging folder of {domain} moves to the trash. The live site does not change.', { domain: name }) }) === true } catch { confirmed = false }
        if (!confirmed) return
        await run(t('Discarding the staging copy…'), async () => {
          const view = readStagingReply('discard', await transport!('POST', base + '/discard', { expectedRecordsRevision: list!.revision }), { accountId, domainId })
          if (reviewed?.domainId === domainId) invalidate()
          changed(view, t('The staging copy was moved to the trash.'))
        })
      })()
    })
    ack.addEventListener('change', () => sync())
    promote.addEventListener('click', () => {
      const current = reviewed
      if (promote.disabled || !current || !list) return
      void run(t('Promoting the changes to the live site…'), async () => {
        const view = readStagingReply('promote', await transport!('POST', '/api/account/staging/' + current.domainId + '/promote', { expectedRevision: current.revision, expectedRecordsRevision: list!.revision }), { accountId, domainId: current.domainId, revision: current.revision })
        fill(resultsBody, view.results.map(row => { const line = element('tr'); line.dataset.result = row.result; line.append(cell(technical(row.path)), cell(t(CHANGES[row.change] ?? row.change)), cell(t(RESULTS[row.result]!) + (row.verificationRequired ? ' ' + t('Verification required.') : ''))); return line }), t('No change has run.'), 3)
        invalidate()
        changed(view, view.outcome === 'promoted' ? t('The changes are live. Replaced and removed files are in the trash.') : t('Some changes were not applied. Review the changes again.'))
      })
    })
    refresh.addEventListener('click', () => { void read() })
    void read()
  })
}

export const ACCT_STAGING_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const readStagingReply=${readStagingReply.toString()};return ${bindAccountStaging.toString()};})()`
