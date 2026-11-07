/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>
type Json = Record<string, any>

/** Dotted path into a JSON view; `length` of an array and index-free objects only. */
export function svcGet(value: unknown, path: string): unknown {
  let current: any = value
  for (const part of path.split('.')) { if (current === null || current === undefined) return undefined; current = current[part] }
  return current
}
/** Sets a dotted path on a plain clone. */
export function svcSet(target: Json, path: string, value: unknown): void {
  const parts = path.split('.'), last = parts.pop()!
  let current = target
  for (const part of parts) { if (!current[part] || typeof current[part] !== 'object') current[part] = {}; current = current[part] }
  current[last] = value
}
/** Text for one value; a value the server did not send stays "Not read", never zero or empty. */
export function svcShow(value: unknown, format: string, labels: Record<string, string> | null, words: { none: string; yes: string; no: string }, when: (value: string) => string): string {
  if (value === null || value === undefined) return words.none
  if (Array.isArray(value)) return value.map(item => labels?.[item] ?? item).join('; ')
  if (format === 'yes-no') return value === true ? words.yes : value === false ? words.no : words.none
  if (format === 'time' && typeof value === 'string') return when(value)
  if (format === 'octal' && typeof value === 'number') return '0' + value.toString(8)
  return labels && typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value]! : String(value)
}
/** A row source that is an object (per-user choices) lists as key and value. */
export function svcRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value && typeof value === 'object' ? Object.entries(value).map(([key, item]) => ({ key, value: item })) : []
}
export function svcWafFiles(view: Json): Json {
  const policy = view.policy ?? {}, observed = view.observation ?? {}
  const rows: Json[] = (observed.crs ?? []).map((file: string) => ({ vendor: 'crs', file, enabled: !(policy.crsDisabledFiles ?? []).includes(file) }))
  for (const vendor of policy.vendors ?? []) for (const file of observed.vendors?.[vendor.id] ?? []) rows.push({ vendor: vendor.id, file, enabled: !vendor.disabledFiles.includes(file) })
  // A nightly update changes what is installed without changing the saved vendor.
  const vendorRows = (policy.vendors ?? []).map((vendor: Json) => ({ ...vendor, version: observed.installed?.[vendor.id]?.version ?? vendor.version }))
  return { ...observed, files: rows, vendorRows }
}

function bindSvcPanels(askDialog: Ask | undefined): void {
  document.querySelectorAll<HTMLElement>('[data-svc-panel]').forEach(root => {
    if (root.dataset.svcBound === 'true') return
    root.dataset.svcBound = 'true'
    const t = (message: string, values?: MessageValues): string => xpT(message, values)
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    const canRead = (): boolean => root.isConnected && root.dataset.svcCanRead === 'true' && !root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled') && typeof request === 'function'
    const canManage = (): boolean => canRead() && root.dataset.svcCanManage === 'true'
    const status = root.querySelector<HTMLElement>('[data-svc-status]')
    const note = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'unknown'].includes(state) ? 'alert' : 'status') }
    const words = { none: t('Not read'), yes: t('Yes'), no: t('No') }
    const show = (value: unknown, format: string, labels: Record<string, string> | null): string => svcShow(value, format, labels, words, stamp => displayDateTime(stamp))
    const inputs = [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-svc-input]')]
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-svc-op]')]
    const rowButton = root.querySelector<HTMLTemplateElement>('template[data-svc-row-button]')
    let view: Json | null = null, busy = false
    const sync = (): void => {
      root.setAttribute('aria-busy', String(busy))
      for (const input of inputs) input.disabled = busy || !(input.dataset.svcRole === 'query' ? canRead() : canManage()) || input.dataset.svcRole === 'policy' && !view
      for (const button of buttons) button.disabled = busy || !(button.dataset.svcOp === 'refresh' ? canRead() : canManage())
    }
    const readInput = (input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): unknown => {
      const kind = input.dataset.svcKind
      if (kind === 'check') return (input as HTMLInputElement).checked
      if (kind === 'number') return input.value.trim() === '' ? null : Number(input.value)
      if (kind === 'lines') return input.value.split('\n').map(line => line.trim()).filter(Boolean)
      return input.value
    }
    const paintInput = (input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: unknown): void => {
      if (input.dataset.svcKind === 'check') (input as HTMLInputElement).checked = value === true
      else input.value = Array.isArray(value) ? value.join('\n') : value === null || value === undefined ? '' : String(value)
    }
    const failure = (error: unknown): void => {
      const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details ?? {}
      if (problem.status === 409) note('refused', t('The saved configuration changed before this action. Nothing was changed; reload and review.'))
      else if (details.unknownOutcome === true || details.verificationRequired === true) note('unknown', t('The outcome is unknown. Reload and review before trying again.'))
      else if (details.reason === 'waf_connector_unavailable') note('refused', t('ModSecurity is not active on this server, so nothing was deployed.'))
      else if (details.rolledBack === true) note('failed', t('The web server refused these rules. The previous rules stay active.'))
      else if (problem.status === 422 || problem.code === 'VALIDATION') note('refused', t('The server refused the values. Nothing was changed; check the fields and try again.'))
      else if (problem.status === 401 || problem.status === 403) note('refused', t('Authorization is no longer valid. Nothing was changed.'))
      else if (details.stateChanged === false) note('refused', t('The request was refused. Nothing was changed.'))
      else note('unknown', t('The outcome is unknown. Reload and review before trying again.'))
    }
    const query = (): string => {
      const params = new URLSearchParams()
      for (const input of inputs) if (input.dataset.svcRole === 'query' && input.value) params.set(input.dataset.svcInput ?? '', input.value)
      return params.size ? '?' + params.toString() : ''
    }
    const revisionOf = (): string | null => typeof view?.revision === 'string' ? view.revision : null
    const put = async (policy: unknown): Promise<void> => {
      if (!request || !root.dataset.svcPut) return
      const saved = await request('PUT', root.dataset.svcPut, { expectedRevision: revisionOf(), policy }) as Json
      await load(saved.reconcile === 'requested' ? t('Saved. The server was asked to apply it; refresh to read the running configuration.') : saved.reconcile === 'not_connected' ? t('Saved. No host agent is connected, so nothing was applied.')
        : saved.reconcile === 'failed' ? t('Saved, but the server reported that applying it failed. The previous generation stays active.') : t('Saved.'))
    }
    const guarded = async (work: () => Promise<void>): Promise<void> => {
      if (busy || !canRead()) return
      busy = true; sync()
      try { await work() } catch (error) { failure(error) } finally { busy = false; sync() }
    }
    const paint = (next: Json): void => {
      view = root.dataset.svcPanel === 'waf-vendors' ? { ...next, observation: svcWafFiles(next) }
        : root.dataset.svcPanel === 'package-check' ? { ...next, modifiedRows: [...(next.modified ?? []).map((path: string) => ({ path, kind: 'modified' })), ...(next.missing ?? []).map((path: string) => ({ path, kind: 'missing' }))] } : next
      for (const node of root.querySelectorAll<HTMLElement>('[data-svc-field]')) node.textContent = show(svcGet(view, node.dataset.svcField ?? ''), node.dataset.svcFormat ?? 'text', node.dataset.svcLabels ? JSON.parse(node.dataset.svcLabels) as Record<string, string> : null)
      for (const input of inputs) if (input.dataset.svcRole === 'policy') paintInput(input, svcGet(view, input.dataset.svcInput ?? ''))
      for (const body of root.querySelectorAll<HTMLElement>('[data-svc-rows]')) paintRows(body)
    }
    const paintRows = (body: HTMLElement): void => {
      const columns = JSON.parse(body.dataset.svcColumns ?? '[]') as { path: string; format: string; labels: Record<string, string> | null; technical: boolean }[]
      const ops = JSON.parse(body.dataset.svcOps ?? '[]') as Json[], rows = svcRows(svcGet(view, body.dataset.svcRows ?? ''))
      body.textContent = ''
      for (const row of rows) {
        const tr = document.createElement('tr')
        for (const column of columns) {
          const td = document.createElement('td'), text = show(svcGet(row, column.path), column.format, column.labels)
          if (column.technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = text; td.append(bdi) } else td.textContent = text
          tr.append(td)
        }
        if (ops.length) {
          const td = document.createElement('td')
          for (const op of ops) {
            const button = rowButton?.content.firstElementChild?.cloneNode(true) as HTMLButtonElement | undefined
            if (!button) continue
            button.textContent = op.label; button.disabled = !canManage()
            button.addEventListener('click', () => void guarded(() => runRowOp(op, row as Json)))
            td.append(button)
          }
          tr.append(td)
        }
        body.append(tr)
      }
      if (!rows.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns.length + (ops.length ? 1 : 0); td.textContent = body.dataset.svcEmpty ?? ''; tr.append(td); body.append(tr) }
    }
    const confirmed = async (message: unknown): Promise<boolean> => {
      if (!message) return true
      if (!askDialog) { note('refused', t('Confirmation is unavailable; nothing was changed.')); return false }
      try { return await askDialog({ title: String(message), body: String(message), confirm: t('Continue') }) === true } catch { return false }
    }
    const runRowOp = async (op: Json, row: Json): Promise<void> => {
      if (!view || !request) return
      const policy = view.policy ? structuredClone(view.policy) as Json : null
      if (op.op === 'fill') { for (const field of op.fields as string[]) { const input = inputs.find(item => item.dataset.svcRole === 'arg' && item.dataset.svcInput === (field === 'name' ? 'domain' : field)); if (input) paintInput(input, svcGet(row, field)) } return }
      if (op.op === 'post') {
        if (!await confirmed(op.confirm)) return
        const body: Json = { ...(op.extra ?? {}), [op.arg]: row[op.key], ...(op.revision ? { expectedRevision: revisionOf() } : {}), ...(view.version ? { version: view.version } : {}) }
        for (const input of inputs) if (input.dataset.svcRole === 'query') body[input.dataset.svcInput ?? ''] = input.value
        await request('POST', op.url, body)
        await load(t('Done.'))
        return
      }
      if (!policy) return
      if (op.op === 'waf-file') {
        const list = row.vendor === 'crs' ? policy.crsDisabledFiles as string[] : (policy.vendors as Json[]).find(item => item.id === row.vendor)!.disabledFiles as string[]
        const at = list.indexOf(row.file)
        if (at >= 0) list.splice(at, 1); else list.push(row.file)
        await put(policy)
        return
      }
      const path = String(op.path).replace(/^policy\./, ''), holder = svcGet(policy, path)
      if (Array.isArray(holder)) {
        const item = holder.find((entry: Json) => entry[op.key] === row[op.key]) as Json
        if (op.op === 'toggle') item[op.field] = !item[op.field]
        else holder.splice(holder.indexOf(item), 1)
      } else delete (holder as Json)[row.key]
      await put(policy)
    }
    const load = async (done?: string): Promise<void> => {
      if (!canRead() || !request) return
      note('reading', t('Reading…'))
      try { paint((await request('GET', (root.dataset.svcRead ?? '') + query()) ?? {}) as Json); note('read', done ?? t('Read from the server.')) }
      catch (error) { failure(error) }
    }
    for (const button of buttons) button.addEventListener('click', () => void guarded(async () => {
      if (!request) return
      const op = button.dataset.svcOp
      if (op === 'refresh') { await load(); return }
      if (op === 'save') {
        if (!view?.policy) return
        const policy = structuredClone(view.policy) as Json, wrapped = { policy }
        for (const input of inputs) if (input.dataset.svcRole === 'policy') {
          const key = input.dataset.svcInput ?? ''
          // An INI default left empty means "not set", which the policy stores as null.
          if (/^policy\.ini\.[a-z_]+\.value$/.test(key) && input.value.trim() === '') { svcSet(wrapped, key.replace(/\.value$/, ''), null); continue }
          if (/^policy\.ini\.[a-z_]+\.locked$/.test(key) && svcGet(wrapped, key.replace(/\.locked$/, '')) === null) continue
          svcSet(wrapped, key, readInput(input))
        }
        await put(wrapped.policy)
        return
      }
      if (op === 'add') {
        if (!view?.policy) return
        const policy = structuredClone(view.policy) as Json, item: Json = JSON.parse(button.dataset.svcDefaults ?? '{}') as Json
        const scope = button.closest('[data-svc-section]') ?? root
        for (const input of scope.querySelectorAll<HTMLInputElement>('[data-svc-role="new"]')) svcSet(item, input.dataset.svcInput ?? '', readInput(input))
        const path = (button.dataset.svcPath ?? '').replace(/^policy\./, ''), holder = svcGet(policy, path)
        if (Array.isArray(holder)) holder.push(item); else (holder as Json)[String(item.key)] = item.value
        await put(policy)
        return
      }
      if (!await confirmed(button.dataset.svcConfirm)) return
      const scope = button.closest('[data-svc-section]') ?? root, body: Json = {}, reset = (button.dataset.svcReset ?? '').split(',').filter(Boolean)
      for (const input of scope.querySelectorAll<HTMLInputElement>('[data-svc-role="arg"]')) if (!reset.some(key => (input.dataset.svcInput ?? '').startsWith(key + '.'))) svcSet(body, input.dataset.svcInput ?? '', readInput(input))
      for (const key of reset) body[key] = null
      for (const input of inputs) if (input.dataset.svcRole === 'query') body[input.dataset.svcInput ?? ''] = input.value
      Object.assign(body, JSON.parse(button.dataset.svcExtra ?? '{}') as Json)
      if (button.dataset.svcRevision === 'true') body.expectedRevision = revisionOf()
      const result = await request('POST', button.dataset.svcUrl ?? '', body) as Json
      if (button.dataset.svcUrl?.endsWith('/preview')) { paint({ ...view, preview: result }); note('read', t('Read from the server.')); return }
      if (button.dataset.svcUrl?.endsWith('/search')) { paint({ ...view, results: result.results }); note('read', t('Read from the server.')); return }
      await load(t('Done.'))
    }))
    for (const input of inputs) if (input.dataset.svcRole === 'query') input.addEventListener('change', () => void guarded(() => load()))
    sync()
    if (!canRead()) { note('unavailable', t('This tool is not available here. Nothing was read or changed.')); return }
    void guarded(() => load())
  })
}

export const SVC_PANELS_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const svcGet=${svcGet.toString()};const svcSet=${svcSet.toString()};const svcShow=${svcShow.toString()};const svcRows=${svcRows.toString()};const svcWafFiles=${svcWafFiles.toString()};return ${bindSvcPanels.toString()};})()`
