import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export const DB_TUNING_VARIABLES = ['innodb_buffer_pool_size', 'max_connections', 'tmp_table_size', 'max_heap_table_size', 'table_open_cache', 'thread_cache_size', 'slow_query_log', 'long_query_time'] as const
export const DB_TUNING_STATUS = ['Uptime', 'Uptime_since_flush_status', 'Threads_connected', 'Threads_running', 'Max_used_connections', 'Connections', 'Aborted_connects', 'Connection_errors_max_connections', 'Slow_queries', 'Questions', 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests', 'Created_tmp_disk_tables', 'Created_tmp_tables', 'Open_tables', 'Opened_tables', 'Threads_created'] as const
export const DB_TUNING_CHECKS = ['connections', 'buffer-pool', 'temporary-tables', 'slow-log', 'table-cache', 'thread-cache'] as const
export const DB_TUNING_NEXT = ['review-connections', 'sample-buffer-pool', 'sample-temporary-tables', 'review-slow-log', 'sample-table-cache', 'sample-thread-cache'] as const
export interface DatabaseTuningClientView {
  engine: 'mariadb'; state: 'read' | 'partial' | 'unavailable'; observedAt: string | null; version: string | null
  variables: Record<string, number | 'ON' | 'OFF'> | null; status: Record<string, number> | null
  plan: { kind: 'advisory'; state: 'ready' | 'unavailable'; checks: { id: typeof DB_TUNING_CHECKS[number]; state: 'review' | 'observe' | 'unavailable'; evidence: { name: string; value: number | string }[]; next: typeof DB_TUNING_NEXT[number] | 'read-again' }[] }
  capabilities: { apply: false }
}

/** Reject malformed or inconsistent replies before any values reach the page. */
export function readDatabaseTuningView(raw: unknown): DatabaseTuningClientView {
  const bad = (): never => { throw new Error('invalid_database_tuning_view') }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const keys = (value: Record<string, unknown>, names: readonly string[]): boolean => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
  const number = (value: unknown, decimal = false): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER && (decimal || Number.isSafeInteger(value))
  if (!object(raw) || !keys(raw, ['engine', 'state', 'observedAt', 'version', 'variables', 'status', 'plan', 'capabilities']) || raw.engine !== 'mariadb' || !['read', 'partial', 'unavailable'].includes(String(raw.state))) return bad()
  if (!(raw.observedAt === null || typeof raw.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw.observedAt) && Number.isFinite(Date.parse(raw.observedAt))) || raw.observedAt === null && raw.state !== 'unavailable') return bad()
  if (!(raw.version === null || typeof raw.version === 'string' && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}[0-9A-Za-z.+_~-]{0,96}$/.test(raw.version))) return bad()
  let variables: DatabaseTuningClientView['variables'] = null, status: DatabaseTuningClientView['status'] = null
  if (raw.variables !== null) {
    if (!object(raw.variables) || !keys(raw.variables, DB_TUNING_VARIABLES)) return bad()
    variables = {}
    for (const name of DB_TUNING_VARIABLES) {
      const value = raw.variables[name]
      if (name === 'slow_query_log' ? value !== 'ON' && value !== 'OFF' : !number(value, name === 'long_query_time')) return bad()
      variables[name] = value as number | 'ON' | 'OFF'
    }
    if (typeof variables.max_connections !== 'number' || variables.max_connections <= 0) return bad()
  }
  if (raw.status !== null) {
    if (!object(raw.status) || !keys(raw.status, DB_TUNING_STATUS)) return bad()
    status = {}
    for (const name of DB_TUNING_STATUS) { const value = raw.status[name]; if (!number(value)) return bad(); status[name] = value }
  }
  const present = [raw.version, variables, status].filter(value => value !== null).length
  if (raw.state !== (present === 3 ? 'read' : present === 0 ? 'unavailable' : 'partial')) return bad()
  if (!object(raw.capabilities) || !keys(raw.capabilities, ['apply']) || raw.capabilities.apply !== false || !object(raw.plan) || !keys(raw.plan, ['kind', 'state', 'checks']) || raw.plan.kind !== 'advisory' || !['ready', 'unavailable'].includes(String(raw.plan.state)) || !Array.isArray(raw.plan.checks) || raw.plan.checks.length !== DB_TUNING_CHECKS.length) return bad()
  const observed = { ...variables, ...status }
  const checks = raw.plan.checks.map((row: unknown, index: number): DatabaseTuningClientView['plan']['checks'][number] => {
    if (!object(row) || !keys(row, ['id', 'state', 'evidence', 'next']) || row.id !== DB_TUNING_CHECKS[index] || !['review', 'observe', 'unavailable'].includes(String(row.state)) || !Array.isArray(row.evidence) || row.evidence.length > 5) return bad()
    if (row.state === 'unavailable' ? row.next !== 'read-again' || row.evidence.length !== 0 : row.next !== DB_TUNING_NEXT[index] || row.evidence.length === 0) return bad()
    const names = new Set<string>()
    const evidence = row.evidence.map((item: unknown) => {
      if (!object(item) || !keys(item, ['name', 'value']) || typeof item.name !== 'string' || !Object.hasOwn(observed, item.name) || names.has(item.name) || item.value !== observed[item.name]) return bad()
      names.add(item.name); return { name: item.name, value: item.value as number | string }
    })
    return { id: row.id as typeof DB_TUNING_CHECKS[number], state: row.state as 'review' | 'observe' | 'unavailable', evidence, next: row.next as typeof DB_TUNING_NEXT[number] | 'read-again' }
  })
  if (raw.plan.state !== (checks.some(row => row.state !== 'unavailable') ? 'ready' : 'unavailable')) return bad()
  return { engine: 'mariadb', state: raw.state as DatabaseTuningClientView['state'], observedAt: raw.observedAt as string | null, version: raw.version as string | null, variables, status, plan: { kind: 'advisory', state: raw.plan.state as 'ready' | 'unavailable', checks }, capabilities: { apply: false } }
}

export function bindWhmDatabaseTuning(root: HTMLElement, send: ((method: string, path: string) => Promise<unknown>) | undefined): void {
  if (root.dataset.dbTuningBound === 'true') return
  root.dataset.dbTuningBound = 'true'
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const readNode = root.querySelector<HTMLButtonElement>('[data-db-tuning-read]'), feedbackNode = root.querySelector<HTMLElement>('[data-db-tuning-status]'), planNode = root.querySelector<HTMLElement>('[data-db-tuning-plan]')
  const variableRowsNode = root.querySelector<HTMLElement>('[data-db-tuning-rows="variables"]'), statusRowsNode = root.querySelector<HTMLElement>('[data-db-tuning-rows="status"]')
  if (!readNode || !feedbackNode || !planNode || !variableRowsNode || !statusRowsNode) return
  const rowTemplate=clientTemplate(root,'db-tuning-row'),checkTemplate=clientTemplate(root,'db-tuning-check'),evidenceTemplate=clientTemplate(root,'db-tuning-evidence')
  cloneClientTemplate(rowTemplate,'tr',['name','value']);cloneClientTemplate(checkTemplate,'article',['title','state','description','evidence']);cloneClientTemplate(evidenceTemplate,'div',['name','value'])
  const read = readNode, feedback = feedbackNode, plan = planNode, variableRows = variableRowsNode, statusRows = statusRowsNode
  let busy = false
  const eligible = (): boolean => root.isConnected && root.dataset.canRead === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
  const note = (state: string, message: string): void => { feedback.dataset.state = state; feedback.textContent = message; feedback.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
  const text = (value: number | string | null): HTMLElement => { const node = document.createElement(value === null ? 'span' : 'bdi'); if (value !== null) node.dir = 'ltr'; node.textContent = value === null ? t(msgctxt('whm-database-tuning-client', 'Not observed')) : String(value); return node }
  const fill = (body: HTMLElement, names: readonly string[], values: Record<string, number | string> | null): void => {
    body.replaceChildren()
    for(const name of names){const row=cloneClientTemplate(rowTemplate,'tr',['name','value']);clientTemplateSlot(row,'name').textContent=name;clientTemplateSlot(row,'value').replaceChildren(text(values?.[name]??null));body.append(row)}
  }
  const titles: Record<string, string> = { connections: msgid('Connection capacity'), 'buffer-pool': msgid('InnoDB buffer pool'), 'temporary-tables': msgid('Temporary tables'), 'slow-log': msgid('Slow query logging'), 'table-cache': msgid('Table cache'), 'thread-cache': msgid('Thread cache') }
  const next: Record<string, string> = {
    'review-connections': msgid('Review connection use and rejected connections over a representative interval before changing the limit. Check application pooling and available memory.'),
    'sample-buffer-pool': msgid('Compare buffer pool read counters across representative samples and check host memory before choosing a buffer size.'),
    'sample-temporary-tables': msgid('Compare temporary table counters across samples and investigate query plans before raising per-session memory limits.'),
    'review-slow-log': msgid('Review the slow query threshold and logging policy. Enabling logging requires checking storage capacity and sensitive query data handling.'),
    'sample-table-cache': msgid('Compare table-open counters over a representative interval and inspect file descriptor limits before changing the cache.'),
    'sample-thread-cache': msgid('Compare new thread creation with connection attempts over a representative interval before changing the thread cache.'),
    'read-again': msgid('Read MariaDB again when these settings and counters are available.'),
  }
  const paint = (view: DatabaseTuningClientView): void => {
    for (const name of ['version', 'observedAt', 'Uptime', 'Uptime_since_flush_status']) { const node = root.querySelector<HTMLElement>('[data-db-tuning-fact="' + name + '"]'); node?.replaceChildren(text(name === 'version' ? view.version : name === 'observedAt' ? view.observedAt === null ? null : formatDisplayDateTime(view.observedAt) : view.status?.[name] ?? null)) }
    fill(variableRows, DB_TUNING_VARIABLES, view.variables); fill(statusRows, DB_TUNING_STATUS, view.status); plan.replaceChildren()
    for (const check of view.plan.checks) {
      const group=cloneClientTemplate(checkTemplate,'article',['title','state','description','evidence']);group.dataset.check=check.id;group.dataset.state=check.state
      clientTemplateSlot(group,'title','h3').textContent=t(titles[check.id]!);clientTemplateSlot(group,'state').textContent=check.state==='review'?t(msgctxt('whm-database-tuning-client','Review')):check.state==='observe'?t('Collect samples'):t('Unavailable')
      clientTemplateSlot(group,'description','p').textContent=t(next[check.next]!);const evidence=clientTemplateSlot(group,'evidence','dl');evidence.hidden=!check.evidence.length
      for(const item of check.evidence){const field=cloneClientTemplate(evidenceTemplate,'div',['name','value']);clientTemplateSlot(field,'name').replaceChildren(text(item.name));clientTemplateSlot(field,'value').replaceChildren(text(item.value));evidence.append(field)}
      plan.append(group)
    }
    note(view.state, view.state === 'read' ? t('MariaDB observations and the advisory plan were read. No settings were changed.') : view.state === 'partial' ? t('Some observations are unavailable. Review only the evidence shown; no settings were changed.') : t('MariaDB observations are unavailable. No settings were changed.'))
  }
  const lock = (): void => { read.disabled = busy || !eligible() || !send; root.setAttribute('aria-busy', String(busy)) }
  async function load(): Promise<void> {
    if (busy || !eligible() || !send) return
    busy = true; lock(); note('reading', t('Reading MariaDB observations…'))
    try { const view = readDatabaseTuningView(await send('GET', '/api/server/databases/tuning')); if (eligible()) paint(view) }
    catch { if (eligible()) { root.querySelectorAll<HTMLElement>('[data-db-tuning-fact]').forEach(node => node.replaceChildren(text(null))); fill(variableRows, DB_TUNING_VARIABLES, null); fill(statusRows, DB_TUNING_STATUS, null); plan.replaceChildren(); note('failed', t('The database tuning read could not be verified. Read again to refresh the evidence.')) } }
    finally { busy = false; lock() }
  }
  read.addEventListener('click', () => { void load() }); lock()
  if (!eligible() || !send) { note('unavailable', t('Database tuning observations are unavailable here.')); return }
  void load()
}

function bindWhmDatabaseTuningPage(): void {
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-whm-database-tuning]').forEach(root => bindWhmDatabaseTuning(root, send))
}
export const WHM_DATABASE_TUNING_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const DB_TUNING_VARIABLES=${JSON.stringify(DB_TUNING_VARIABLES)};const DB_TUNING_STATUS=${JSON.stringify(DB_TUNING_STATUS)};const DB_TUNING_CHECKS=${JSON.stringify(DB_TUNING_CHECKS)};const DB_TUNING_NEXT=${JSON.stringify(DB_TUNING_NEXT)};const readDatabaseTuningView=${readDatabaseTuningView.toString()};const bindWhmDatabaseTuning=${bindWhmDatabaseTuning.toString()};return ${bindWhmDatabaseTuningPage.toString()};})()`
