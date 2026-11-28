import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { frameAccess as canonicalFrameAccess, withFrameRequest } from './read-only-frame.ts'
const frameAccess = canonicalFrameAccess
const formatDisplayDateTime = sharedFormatDisplayDateTime

export const DB_TUNING_VARIABLES = ['innodb_buffer_pool_size', 'max_connections', 'tmp_table_size', 'max_heap_table_size', 'table_open_cache', 'thread_cache_size', 'slow_query_log', 'long_query_time'] as const
export const DB_TUNING_STATUS = ['Uptime', 'Uptime_since_flush_status', 'Threads_connected', 'Threads_running', 'Max_used_connections', 'Connections', 'Aborted_connects', 'Connection_errors_max_connections', 'Slow_queries', 'Questions', 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests', 'Created_tmp_disk_tables', 'Created_tmp_tables', 'Open_tables', 'Opened_tables', 'Threads_created'] as const
export const DB_TUNING_CHECKS = ['connections', 'buffer-pool', 'temporary-tables', 'slow-log', 'table-cache', 'thread-cache'] as const
export const DB_TUNING_NEXT = ['review-connections', 'sample-buffer-pool', 'sample-temporary-tables', 'review-slow-log', 'sample-table-cache', 'sample-thread-cache'] as const
export const DB_TUNING_BOUNDS = {
  innodb_buffer_pool_size: { kind: 'integer', min: 67_108_864, max: 549_755_813_888 },
  max_connections: { kind: 'integer', min: 10, max: 10_000 },
  tmp_table_size: { kind: 'integer', min: 1_048_576, max: 4_294_967_296 },
  max_heap_table_size: { kind: 'integer', min: 1_048_576, max: 4_294_967_296 },
  table_open_cache: { kind: 'integer', min: 64, max: 524_288 },
  thread_cache_size: { kind: 'integer', min: 0, max: 16_384 },
  innodb_log_file_size: { kind: 'integer', min: 16_777_216, max: 17_179_869_184 },
  query_cache_type: { kind: 'integer', min: 0, max: 2 },
  slow_query_log: { kind: 'integer', min: 0, max: 1 },
  long_query_time: { kind: 'number', min: 0.1, max: 3600 },
} as const

export interface DbTuningDropInView {
  path: string
  present: boolean
  revision: string
  content: string | null
  rollbackAvailable: boolean
}

export interface DbTuningClientView {
  engine: 'mariadb'
  state: 'read' | 'partial' | 'unavailable'
  observedAt: string | null
  version: string | null
  variables: Record<string, number | 'ON' | 'OFF'> | null
  status: Record<string, number> | null
  plan: { kind: 'advisory'; state: 'ready' | 'unavailable'; checks: { id: typeof DB_TUNING_CHECKS[number]; state: 'review' | 'observe' | 'unavailable'; evidence: { name: string; value: number | string }[]; next: typeof DB_TUNING_NEXT[number] | 'read-again' }[] }
  capabilities: { apply: boolean }
  dropIn: DbTuningDropInView
}

export interface DbTuningPreviewView {
  path: string
  currentRevision: string
  currentContent: string | null
  proposedContent: string
  diff: string
  changed: boolean
  rollbackAvailable: boolean
}

type AskDialog = (options: Record<string, unknown>) => Promise<unknown>
type RequestTransport = (method: string, path: string, body?: unknown) => Promise<unknown>

/** Reject malformed or inconsistent replies before any values reach the page. */
export function readDbTuningView(raw: unknown): DbTuningClientView {
  const bad = (): never => { throw new Error('invalid_database_tuning_view') }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const keys = (value: Record<string, unknown>, names: readonly string[]): boolean => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
  const number = (value: unknown, decimal = false): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER && (decimal || Number.isSafeInteger(value))
  if (!object(raw) || !keys(raw, ['engine', 'state', 'observedAt', 'version', 'variables', 'status', 'plan', 'capabilities', 'dropIn']) || raw.engine !== 'mariadb' || !['read', 'partial', 'unavailable'].includes(String(raw.state))) return bad()
  if (!(raw.observedAt === null || typeof raw.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw.observedAt) && Number.isFinite(Date.parse(raw.observedAt))) || raw.observedAt === null && raw.state !== 'unavailable') return bad()
  if (!(raw.version === null || typeof raw.version === 'string' && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}[0-9A-Za-z.+_~-]{0,96}$/.test(raw.version))) return bad()
  let variables: DbTuningClientView['variables'] = null, status: DbTuningClientView['status'] = null
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
  if (!object(raw.capabilities) || !keys(raw.capabilities, ['apply']) || raw.capabilities.apply !== (raw.state !== 'unavailable') || !object(raw.plan) || !keys(raw.plan, ['kind', 'state', 'checks']) || raw.plan.kind !== 'advisory' || !['ready', 'unavailable'].includes(String(raw.plan.state)) || !Array.isArray(raw.plan.checks) || raw.plan.checks.length !== DB_TUNING_CHECKS.length) return bad()
  if (!object(raw.dropIn) || !keys(raw.dropIn, ['path', 'present', 'revision', 'content', 'rollbackAvailable'])
    || typeof raw.dropIn.path !== 'string' || !/^\/etc\/(?:mysql\/mariadb\.conf\.d|my\.cnf\.d)\/90-xpanel-tuning\.cnf$/.test(raw.dropIn.path)
    || typeof raw.dropIn.present !== 'boolean' || typeof raw.dropIn.rollbackAvailable !== 'boolean'
    || typeof raw.dropIn.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.dropIn.revision)
    || !(raw.dropIn.content === null || typeof raw.dropIn.content === 'string')
    || raw.dropIn.present !== (raw.dropIn.content !== null)) return bad()
  const observed = { ...variables, ...status }
  const checks = raw.plan.checks.map((row: unknown, index: number): DbTuningClientView['plan']['checks'][number] => {
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
  return {
    engine: 'mariadb',
    state: raw.state as DbTuningClientView['state'],
    observedAt: raw.observedAt as string | null,
    version: raw.version as string | null,
    variables,
    status,
    plan: { kind: 'advisory', state: raw.plan.state as 'ready' | 'unavailable', checks },
    capabilities: { apply: raw.state !== 'unavailable' },
    dropIn: {
      path: raw.dropIn.path as string,
      present: raw.dropIn.present as boolean,
      revision: raw.dropIn.revision as string,
      content: raw.dropIn.content as string | null,
      rollbackAvailable: raw.dropIn.rollbackAvailable as boolean,
    },
  }
}

export function readDbTuningPreview(raw: unknown): DbTuningPreviewView {
  const bad = (): never => { throw new Error('invalid_database_tuning_preview') }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  if (!object(raw) || typeof raw.path !== 'string' || typeof raw.currentRevision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.currentRevision)
    || !(raw.currentContent === null || typeof raw.currentContent === 'string') || typeof raw.proposedContent !== 'string'
    || typeof raw.diff !== 'string' || typeof raw.changed !== 'boolean' || typeof raw.rollbackAvailable !== 'boolean') return bad()
  return {
    path: raw.path,
    currentRevision: raw.currentRevision,
    currentContent: raw.currentContent as string | null,
    proposedContent: raw.proposedContent,
    diff: raw.diff,
    changed: raw.changed,
    rollbackAvailable: raw.rollbackAvailable,
  }
}

export function bindWhmDbTuning(root: HTMLElement, send: RequestTransport | undefined, askDialog?: AskDialog): void {
  if (root.dataset.dbTuningBound === 'true') return
  root.dataset.dbTuningBound = 'true'
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const readNode = root.querySelector<HTMLButtonElement>('[data-db-tuning-read]')
  const feedbackNode = root.querySelector<HTMLElement>('[data-db-tuning-status]')
  const planNode = root.querySelector<HTMLElement>('[data-db-tuning-plan]')
  const variableRowsNode = root.querySelector<HTMLElement>('[data-db-tuning-rows="variables"]')
  const statusRowsNode = root.querySelector<HTMLElement>('[data-db-tuning-rows="status"]')
  if (!readNode || !feedbackNode || !planNode || !variableRowsNode || !statusRowsNode) return

  const previewButton = root.querySelector<HTMLButtonElement>('[data-db-tuning-preview]')
  const applyButton = root.querySelector<HTMLButtonElement>('[data-db-tuning-apply]')
  const rollbackButton = root.querySelector<HTMLButtonElement>('[data-db-tuning-rollback]')
  const diffNode = root.querySelector<HTMLElement>('[data-db-tuning-diff]')
  const actionStatusNode = root.querySelector<HTMLElement>('[data-db-tuning-action-status]')
  const factNodes = new Map([...root.querySelectorAll<HTMLElement>('[data-db-tuning-fact]')].map(node => [node.dataset.dbTuningFact!, node]))
  const inputNodes = new Map([...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-db-tuning-input]')].map(node => [node.dataset.dbTuningInput!, node]))

  const rowTemplate = clientTemplate(root, 'db-tuning-row')
  const checkTemplate = clientTemplate(root, 'db-tuning-check')
  const evidenceTemplate = clientTemplate(root, 'db-tuning-evidence')
  cloneClientTemplate(rowTemplate, 'tr', ['name', 'value'])
  cloneClientTemplate(checkTemplate, 'article', ['title', 'state', 'description', 'evidence'])
  cloneClientTemplate(evidenceTemplate, 'div', ['name', 'value'])

  const read = readNode, feedback = feedbackNode, plan = planNode, variableRows = variableRowsNode, statusRows = statusRowsNode
  const access = frameAccess(root, 'data-can-read', 'data-can-manage')
  const transport = send ?? access.request
  let busy = false
  let currentRevision = ''
  let rollbackAvailable = false

  const eligible = (): boolean => root.isConnected && root.dataset.canRead === 'true'
  const manageable = (): boolean => eligible() && root.dataset.canManage === 'true' && !root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[data-tool-availability="unverified"],[data-workspace-mode="read-only"],[aria-disabled="true"],fieldset:disabled')
  const note = (state: string, message: string, target: HTMLElement = feedback): void => {
    target.dataset.state = state
    target.textContent = message
    target.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status')
  }
  const text = (value: number | string | null): HTMLElement => {
    const node = document.createElement(value === null ? 'span' : 'bdi')
    if (value !== null) node.dir = 'ltr'
    node.textContent = value === null ? t('Unavailable') : String(value)
    return node
  }
  const fill = (body: HTMLElement, names: readonly string[], values: Record<string, number | string> | null): void => {
    body.replaceChildren()
    for (const name of names) {
      const row = cloneClientTemplate(rowTemplate, 'tr', ['name', 'value'])
      clientTemplateSlot(row, 'name').textContent = name
      clientTemplateSlot(row, 'value').replaceChildren(text(values?.[name] ?? null))
      body.append(row)
    }
  }
  const titles: Record<string, string> = {
    connections: msgid('Connection capacity'),
    'buffer-pool': msgid('InnoDB buffer pool'),
    'temporary-tables': msgid('Temporary tables'),
    'slow-log': msgid('Slow query logging'),
    'table-cache': msgid('Table cache'),
    'thread-cache': msgid('Thread cache'),
  }
  const next: Record<string, string> = {
    'review-connections': msgid('Review connection use and rejected connections over a representative interval before changing the limit. Check application pooling and available memory.'),
    'sample-buffer-pool': msgid('Compare buffer pool read counters across representative samples and check host memory before choosing a buffer size.'),
    'sample-temporary-tables': msgid('Compare temporary table counters across samples and investigate query plans before raising per-session memory limits.'),
    'review-slow-log': msgid('Review the slow query threshold and logging policy. Enabling logging requires checking storage capacity and sensitive query data handling.'),
    'sample-table-cache': msgid('Compare table-open counters over a representative interval and inspect file descriptor limits before changing the cache.'),
    'sample-thread-cache': msgid('Compare new thread creation with connection attempts over a representative interval before changing the thread cache.'),
    'read-again': msgid('Read MariaDB again when these settings and counters are available.'),
  }

  const parseDropInValues = (content: string | null): Record<string, string> => {
    const parsed: Record<string, string> = {}
    if (!content) return parsed
    for (const line of content.split(/\r?\n/)) {
      const match = /^([A-Za-z0-9_]+)\s*=\s*([^\s#;]+)$/.exec(line.trim())
      if (match) parsed[match[1]!] = match[2]!
    }
    return parsed
  }

  const seedInputs = (view: DbTuningClientView): void => {
    const fromDropIn = parseDropInValues(view.dropIn.content)
    for (const [key, input] of inputNodes) {
      if (Object.hasOwn(fromDropIn, key)) {
        input.value = fromDropIn[key]!
        continue
      }
      if (view.variables && Object.hasOwn(view.variables, key)) {
        const val = view.variables[key]
        if (key === 'slow_query_log') input.value = val === 'ON' ? '1' : '0'
        else input.value = String(val)
      }
    }
  }

  const collectSettings = (): Record<string, number> | null => {
    const out: Record<string, number> = {}
    for (const [key, input] of inputNodes) {
      const raw = input.value.trim()
      if (!raw) continue
      const spec = DB_TUNING_BOUNDS[key as keyof typeof DB_TUNING_BOUNDS]
      if (!spec) continue
      const num = Number(raw)
      if (!Number.isFinite(num) || (spec.kind === 'integer' && !Number.isSafeInteger(num)) || num < spec.min || num > spec.max) {
        note('failed', t('{setting} must be between {min} and {max}.', { setting: key, min: String(spec.min), max: String(spec.max) }), actionStatusNode ?? feedback)
        return null
      }
      out[key] = num
    }
    if (!Object.keys(out).length) {
      note('failed', t('Enter at least one tuning value before previewing or applying.'), actionStatusNode ?? feedback)
      return null
    }
    return out
  }

  const lock = (): void => {
    const canEdit = manageable() && !!transport && currentRevision !== ''
    read.disabled = busy || !eligible() || !transport
    for (const input of inputNodes.values()) input.disabled = busy || !canEdit
    if (previewButton) previewButton.disabled = busy || !canEdit
    if (applyButton) applyButton.disabled = busy || !canEdit
    if (rollbackButton) rollbackButton.disabled = busy || !canEdit || !rollbackAvailable
    root.setAttribute('aria-busy', String(busy))
  }

  const paint = (view: DbTuningClientView): void => {
    currentRevision = view.dropIn.revision
    rollbackAvailable = view.dropIn.rollbackAvailable
    for (const name of ['version', 'observedAt', 'Uptime', 'Uptime_since_flush_status']) {
      factNodes.get(name)?.replaceChildren(text(
        name === 'version' ? view.version
          : name === 'observedAt' ? (view.observedAt === null ? null : formatDisplayDateTime(view.observedAt))
            : view.status?.[name] ?? null,
      ))
    }
    factNodes.get('dropinPath')?.replaceChildren(text(view.dropIn.path))
    factNodes.get('dropinState')?.replaceChildren(text(view.dropIn.present ? t('Active drop-in present') : t('No drop-in file written')))
    factNodes.get('rollbackState')?.replaceChildren(text(view.dropIn.rollbackAvailable ? t('Snapshot available') : t('None saved')))
    if (diffNode) diffNode.textContent = view.dropIn.content ?? ''
    seedInputs(view)

    fill(variableRows, DB_TUNING_VARIABLES, view.variables)
    fill(statusRows, DB_TUNING_STATUS, view.status)
    plan.replaceChildren()
    for (const check of view.plan.checks) {
      const group = cloneClientTemplate(checkTemplate, 'article', ['title', 'state', 'description', 'evidence'])
      group.dataset.check = check.id
      group.dataset.state = check.state
      clientTemplateSlot(group, 'title', 'h3').textContent = t(titles[check.id]!)
      clientTemplateSlot(group, 'state').textContent = check.state === 'review' ? t('Review') : check.state === 'observe' ? t('Collect samples') : t('Unavailable')
      clientTemplateSlot(group, 'description', 'p').textContent = t(next[check.next]!)
      const evidence = clientTemplateSlot(group, 'evidence', 'dl')
      evidence.hidden = !check.evidence.length
      for (const item of check.evidence) {
        const field = cloneClientTemplate(evidenceTemplate, 'div', ['name', 'value'])
        clientTemplateSlot(field, 'name').replaceChildren(text(item.name))
        clientTemplateSlot(field, 'value').replaceChildren(text(item.value))
        evidence.append(field)
      }
      plan.append(group)
    }
    note(view.state, view.state === 'read'
      ? t('MariaDB observations and tuning plan were read. Review or preview changes before applying.')
      : view.state === 'partial'
        ? t('Some observations are unavailable. Review only the evidence shown.')
        : t('MariaDB observations are unavailable.'))
  }

  const errorMessage = (error: unknown): [string, string] => {
    const obj = error && typeof error === 'object' ? error as Record<string, unknown> : {}
    const details = obj.details && typeof obj.details === 'object' ? obj.details as Record<string, unknown> : {}
    const reason = String(details.reason ?? '')
    if (reason === 'tuning_revision_conflict' || obj.status === 409) return ['failed', t('The tuning drop-in changed since it was read. Read again before applying.')]
    if (details.restored === true) return ['failed', t('MariaDB rejected the tuning configuration and the previous drop-in was restored.')]
    if (details.unknownOutcome === true || details.verificationRequired === true) return ['uncertain', t('The tuning outcome is unknown. Read MariaDB status before retrying.')]
    return [details.stateChanged === false ? 'failed' : 'uncertain', typeof obj.message === 'string' && obj.message ? obj.message : t('The tuning operation could not be verified.')]
  }

  async function load(): Promise<void> {
    if (busy || !eligible() || !transport) return
    busy = true
    lock()
    note('reading', t('Reading MariaDB observations…'))
    try {
      const view = readDbTuningView(await transport('GET', '/api/server/databases/tuning'))
      if (eligible()) paint(view)
    } catch {
      if (eligible()) {
        currentRevision = ''
        rollbackAvailable = false
        for (const node of factNodes.values()) node.replaceChildren(text(null))
        fill(variableRows, DB_TUNING_VARIABLES, null)
        fill(statusRows, DB_TUNING_STATUS, null)
        plan.replaceChildren()
        if (diffNode) diffNode.textContent = ''
        note('failed', t('The database tuning read could not be verified. Read again to refresh the evidence.'))
      }
    } finally {
      busy = false
      lock()
    }
  }

  previewButton?.addEventListener('click', () => {
    void (async () => {
      if (busy || !manageable() || !transport) return
      const settings = collectSettings()
      if (!settings) return
      busy = true
      lock()
      note('reading', t('Generating tuning drop-in preview…'), actionStatusNode ?? feedback)
      try {
        const preview = readDbTuningPreview(await transport('POST', '/api/server/databases/tuning/preview', { settings }))
        currentRevision = preview.currentRevision
        rollbackAvailable = preview.rollbackAvailable
        if (diffNode) diffNode.textContent = preview.changed ? preview.diff : preview.proposedContent
        note('read', preview.changed ? t('Preview ready for {path}. Review the diff before applying.', { path: preview.path }) : t('The proposed tuning matches the active drop-in.'), actionStatusNode ?? feedback)
      } catch (error) {
        const [state, msg] = errorMessage(error)
        note(state, msg, actionStatusNode ?? feedback)
      } finally {
        busy = false
        lock()
      }
    })()
  })

  applyButton?.addEventListener('click', () => {
    void (async () => {
      if (busy || !manageable() || !transport || !currentRevision) return
      const settings = collectSettings()
      if (!settings) return
      const confirmed = await askDialog?.({
        title: t('Apply MariaDB tuning drop-in?'),
        body: t('Writes 90-xpanel-tuning.cnf, restarts MariaDB, and automatically rolls back if MariaDB fails to answer.'),
        confirm: t('Apply tuning'),
        danger: true,
      }).catch(() => false) === true
      if (!confirmed) return
      busy = true
      lock()
      note('reading', t('Applying tuning drop-in and checking MariaDB…'), actionStatusNode ?? feedback)
      try {
        await transport('POST', '/api/server/databases/tuning/apply', { settings, expectedRevision: currentRevision })
        busy = false
        await load()
        note('read', t('Tuning drop-in applied and MariaDB answered health check.'), actionStatusNode ?? feedback)
      } catch (error) {
        const [state, msg] = errorMessage(error)
        note(state, msg, actionStatusNode ?? feedback)
        busy = false
        lock()
      }
    })()
  })

  rollbackButton?.addEventListener('click', () => {
    void (async () => {
      if (busy || !manageable() || !transport || !currentRevision || !rollbackAvailable) return
      const confirmed = await askDialog?.({
        title: t('Roll back MariaDB tuning?'),
        body: t('Restores the previous 90-xpanel-tuning.cnf state and restarts MariaDB.'),
        confirm: t('Roll back'),
        danger: true,
      }).catch(() => false) === true
      if (!confirmed) return
      busy = true
      lock()
      note('reading', t('Rolling back tuning drop-in and checking MariaDB…'), actionStatusNode ?? feedback)
      try {
        await transport('POST', '/api/server/databases/tuning/rollback', { expectedRevision: currentRevision })
        busy = false
        await load()
        note('read', t('Previous MariaDB tuning state restored.'), actionStatusNode ?? feedback)
      } catch (error) {
        const [state, msg] = errorMessage(error)
        note(state, msg, actionStatusNode ?? feedback)
        busy = false
        lock()
      }
    })()
  })

  read.addEventListener('click', () => { void load() })
  lock()
  if (!eligible() || !transport) {
    note('unavailable', t('Database tuning observations are unavailable here.'))
    return
  }
  void load()
}

function bindWhmDbTuningPage(askDialog?: AskDialog): void {
  document.querySelectorAll<HTMLElement>('[data-whm-database-tuning]').forEach(root => {
    bindWhmDbTuning(root, frameAccess(root, 'data-can-read', 'data-can-manage').request, askDialog)
  })
}

export const WHM_DB_TUNING_CLIENT_BINDING = withFrameRequest(`(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const DB_TUNING_VARIABLES=${JSON.stringify(DB_TUNING_VARIABLES)};const DB_TUNING_STATUS=${JSON.stringify(DB_TUNING_STATUS)};const DB_TUNING_CHECKS=${JSON.stringify(DB_TUNING_CHECKS)};const DB_TUNING_NEXT=${JSON.stringify(DB_TUNING_NEXT)};const DB_TUNING_BOUNDS=${JSON.stringify(DB_TUNING_BOUNDS)};const readDbTuningView=${readDbTuningView.toString()};const readDbTuningPreview=${readDbTuningPreview.toString()};const bindWhmDbTuning=${bindWhmDbTuning.toString()};return ${bindWhmDbTuningPage.toString()};})()`)
