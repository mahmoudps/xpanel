import { WHM_CLIENT_TEMPLATE_BINDING, whmClientNode as canonicalWhmClientNode, clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './whm-client-templates.ts'
const whmClientNode = canonicalWhmClientNode, clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export type JobStatusView = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type JobStepStateView = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'unknown'
export type JobView = {
  id: string; referenceCode: string | null; kind: string; status: JobStatusView; progress: number; summary: string; actor: string
  createdAt: string; startedAt: string | null; finishedAt: string | null
  steps: { id: string; title: string; titleValues?: Record<string, string>; state: JobStepStateView; exitCode: number | null }[]
  error: string | null; failureClass: 'retryable' | 'permanent' | 'unknown_outcome' | null; cancelRequested: boolean
  verification: { ok: boolean; detail: Record<string, unknown> } | null; logBytes: number
}
export type JobLogView = { id: string; available: boolean; offset: number; nextOffset: number; total: number; truncated: boolean; text: string }

export function readJobView(value: unknown): JobView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const text = (item: unknown, min: number, max: number): item is string => typeof item === 'string' && item.length >= min && item.length <= max && item.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(item)
  const time = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(item) && Number.isFinite(Date.parse(item))
  const integer = (item: unknown, min: number, max: number): item is number => Number.isSafeInteger(item) && (item as number) >= min && (item as number) <= max
  const reference = (item: unknown): item is string | null => item === null || typeof item === 'string' && item.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(item) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item) && item !== 'XP-JOB-000000'
  if (!object(value) || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id) || typeof value.kind !== 'string' || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(value.kind)
    || !reference(value.referenceCode) || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(value.status as string) || !integer(value.progress, 0, 100) || !text(value.summary, 0, 512) || !text(value.actor, 1, 255)
    || !time(value.createdAt) || value.startedAt !== null && !time(value.startedAt) || value.finishedAt !== null && !time(value.finishedAt)
    || value.error !== null && !text(value.error, 1, 16384) || ![null, 'retryable', 'permanent', 'unknown_outcome'].includes(value.failureClass as string | null)
    || typeof value.cancelRequested !== 'boolean' || !integer(value.logBytes, 0, 4 * 1024 * 1024) || !Array.isArray(value.steps) || value.steps.length > 32) throw new Error('invalid_job')
  const verification = value.verification
  if (verification !== null && (!object(verification) || typeof verification.ok !== 'boolean' || !object(verification.detail) || JSON.stringify(verification.detail).length > 16384)) throw new Error('invalid_job_verification')
  const seen = new Set<string>()
  const steps = value.steps.map(raw => {
    if (!object(raw) || typeof raw.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.id) || seen.has(raw.id) || !text(raw.title, 1, 160)
      || raw.titleValues !== undefined && (!object(raw.titleValues) || Object.keys(raw.titleValues).length > 8 || Object.entries(raw.titleValues).some(([name, item]) => !/^[a-z][A-Za-z0-9]{0,31}$/.test(name) || !text(item, 0, 160)))
      || !['pending', 'running', 'succeeded', 'failed', 'skipped', 'unknown'].includes(raw.state as string) || raw.exitCode !== null && !integer(raw.exitCode, -2147483648, 2147483647)) throw new Error('invalid_job_step')
    seen.add(raw.id)
    return { id: raw.id, title: raw.title as string, ...(raw.titleValues ? { titleValues: { ...raw.titleValues as Record<string, string> } } : {}), state: raw.state as JobStepStateView, exitCode: raw.exitCode as number | null }
  })
  return {
    id: value.id, referenceCode: value.referenceCode, kind: value.kind, status: value.status as JobStatusView, progress: value.progress, summary: value.summary, actor: value.actor,
    createdAt: value.createdAt, startedAt: value.startedAt as string | null, finishedAt: value.finishedAt as string | null, steps,
    error: value.error as string | null, failureClass: value.failureClass as JobView['failureClass'], cancelRequested: value.cancelRequested,
    verification: verification === null ? null : { ok: (verification as { ok: boolean }).ok, detail: (verification as { detail: Record<string, unknown> }).detail }, logBytes: value.logBytes,
  }
}

export function readJobListView(value: unknown): JobView[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { jobs?: unknown }).jobs) || (value as { jobs: unknown[] }).jobs.length > 100) throw new Error('invalid_job_list')
  const jobs = (value as { jobs: unknown[] }).jobs.map(readJobView)
  if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('invalid_job_list')
  return jobs
}

export function readJobLogView(value: unknown): JobLogView {
  const integer = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) <= 4 * 1024 * 1024
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_job_log')
  const log = value as Record<string, unknown>
  if (typeof log.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(log.id) || typeof log.available !== 'boolean' || typeof log.truncated !== 'boolean'
    || !integer(log.offset) || !integer(log.nextOffset) || !integer(log.total) || log.offset > log.nextOffset || log.nextOffset > log.total
    || typeof log.text !== 'string' || log.text.length > 262144 || !log.text.isWellFormed() || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(log.text)
    || !log.available && (log.total !== 0 || log.text !== '')) throw new Error('invalid_job_log')
  return { id: log.id, available: log.available, offset: log.offset, nextOffset: log.nextOffset, total: log.total, truncated: log.truncated, text: log.text }
}

function bindWhmJobs(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-jobs-workspace]').forEach(root => {
    if (root.dataset.jobsBound === 'true') return
    root.dataset.jobsBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = one<HTMLElement>('[data-whm-jobs-status]'), rows = one<HTMLElement>('[data-whm-jobs-rows]'), loading = one<HTMLElement>('[data-whm-jobs-loading]'), empty = one<HTMLElement>('[data-whm-jobs-empty]')
    const form = one<HTMLFormElement>('[data-whm-jobs-filters]'), statusFilter = one<HTMLSelectElement>('[data-whm-jobs-status-filter]'), kindFilter = one<HTMLInputElement>('[data-whm-jobs-kind-filter]')
    const refresh = one<HTMLButtonElement>('[data-whm-jobs-refresh]'), clear = one<HTMLButtonElement>('[data-whm-jobs-clear]'), apply = one<HTMLButtonElement>('[data-whm-jobs-apply]')
    const detailStatus = one<HTMLElement>('[data-whm-jobs-detail-status]'), steps = one<HTMLElement>('[data-whm-jobs-steps]'), outcome = one<HTMLElement>('[data-whm-jobs-outcome]')
    const failure = one<HTMLElement>('[data-whm-jobs-failure]'), errorText = one<HTMLElement>('[data-whm-jobs-error]'), verification = one<HTMLElement>('[data-whm-jobs-verification]'), verificationDetail = one<HTMLElement>('[data-whm-jobs-verification-detail]')
    const logView = one<HTMLElement>('[data-whm-jobs-log]'), logStatus = one<HTMLElement>('[data-whm-jobs-log-status]'), logMore = one<HTMLButtonElement>('[data-whm-jobs-log-more]')
    const cancel = one<HTMLButtonElement>('[data-whm-jobs-cancel]'), cancelStatus = one<HTMLElement>('[data-whm-jobs-cancel-status]')
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !rows || !form || !statusFilter || !kindFilter || !refresh || !clear || !apply || !detailStatus || !steps || !outcome || !failure || !errorText || !verification || !verificationDetail || !logView || !logStatus || !logMore || !cancel || !cancelStatus) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.jobsCanRead === 'true' && !root.closest(denied) && typeof request === 'function'
    const manageable = (): boolean => admitted() && root.dataset.jobsCanManage === 'true'
    const POLL_MS = 5000, LOG_PAGE = 65536, LOG_DISPLAY_MAX = 1048576, MAX_FAILURES = 3
    let jobs: JobView[] = [], selected: JobView | null = null, wanted: string | null = null, filters = { status: '', kindPrefix: '' }
    let log = { id: '', text: '', nextOffset: 0, total: 0, available: false, truncated: false }
    let timer: ReturnType<typeof setTimeout> | undefined, listBusy = false, again = false, logBusy = false, cancelling = false, failures = 0
    const active = (job: JobView): boolean => job.status === 'queued' || job.status === 'running'
    const note = (target: HTMLElement, state: string, message: string): void => { if (!target.hidden && target.dataset.state === state && target.textContent === message) return; target.hidden = false; target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const ltr = (value: string): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = value; return node }
    const utc = (value: string | null, missing: string): HTMLElement | Text => value ? ltr(formatDisplayDateTime(value)) : document.createTextNode(missing)
    const statusLabel = (value: JobStatusView): string => ({ queued: t(msgctxt('whm-jobs-client', 'Queued')), running: t('Running'), succeeded: t('Succeeded'), failed: t(msgctxt('whm-jobs-client', 'Failed')), cancelled: t(msgctxt('whm-jobs-client', 'Cancelled')) })[value]
    const stepLabel = (value: JobStepStateView): string => ({ pending: t('Pending'), running: t('Running'), succeeded: t('Succeeded'), failed: t(msgctxt('whm-jobs-client', 'Failed')), skipped: t('Did not run'), unknown: t('Outcome unknown') })[value]
    const badge = (value: JobStatusView): HTMLElement => {
      const node = whmClientNode(root, 'whm-jobs-state-' + value, 'span', statusLabel(value))
      node.dataset.status = value
      return node
    }
    const meter = (job: JobView): HTMLElement => {
      const node = cloneClientTemplate(clientTemplate(root, 'whm-jobs-progress-' + (job.status === 'failed' ? 'failed' : job.status === 'succeeded' ? 'succeeded' : 'other')), 'div', ['track', 'fill', 'content'])
      const track = clientTemplateSlot(node, 'track'), fill = clientTemplateSlot(node, 'fill')
      track.setAttribute('aria-valuenow', String(job.progress)); track.setAttribute('aria-valuetext', job.progress + '%'); track.setAttribute('aria-label', t('Progress'))
      fill.style.inlineSize = job.progress + '%'
      clientTemplateSlot(node, 'content').textContent = job.progress + '%'
      return node
    }
    const cell = (row: HTMLTableRowElement, content: Node | string): void => { const td = document.createElement('td'); td.append(content); row.append(td) }
    const placeholder = (body: HTMLElement, columns: number, message: string): void => { body.textContent = ''; const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = message; row.append(td); body.append(row) }
    const failureExplanation = (job: JobView): string => job.failureClass === 'unknown_outcome'
      ? t('A step that changes the host failed, timed out or was interrupted, or the host check did not confirm the result. The host may be partly changed. Read the log and check the host before trying again.')
      : job.failureClass === 'retryable' ? t('A temporary condition, such as another package process holding the lock, stopped a step that does not change the host. Submitting the job again later is expected to be safe.')
        : job.failureClass === 'permanent' ? t('The job could not run as reviewed, or a step that does not change the host failed. Repeating it unchanged is expected to fail the same way.')
          : job.status === 'cancelled' ? t('The job was cancelled before its next step. Steps marked "Did not run" made no change.')
            : t('The failure was not classified. Treat the host state as unverified.')
    const field = (key: string, content: Node | string): void => { const target = root.querySelector<HTMLElement>('[data-whm-jobs-field="' + key + '"]'); if (target) { target.textContent = ''; target.append(content) } }
    const lockCancel = (): void => { cancel.disabled = !selected || !active(selected) || selected.cancelRequested || cancelling || !manageable() || typeof askDialog !== 'function' }
    const paintLog = (): void => {
      logView.textContent = log.text
      logMore.disabled = !selected || logBusy || !log.available || log.nextOffset >= log.total || log.text.length >= LOG_DISPLAY_MAX || !admitted()
      logStatus.textContent = !log.id ? t('No log has been read.')
        : !log.available ? t('No log file is available for this job.')
          : t('Showing {shown} of {total} bytes.', { shown: log.nextOffset, total: log.total }) + (log.truncated ? ' ' + t('The log reached its 4 MiB limit; later output was not recorded.') : '') + (log.text.length >= LOG_DISPLAY_MAX ? ' ' + t('Display limit reached.') : '')
    }
    const paintDetail = (): void => {
      lockCancel()
      if (!selected) {
        note(detailStatus, 'none', t('Select a job to read its steps, verification and log.'))
        for (const key of ['reference', 'kind', 'summary', 'status', 'progress', 'actor', 'created', 'started', 'finished', 'cancellation']) field(key, t('Not read'))
        placeholder(steps, 4, t(msgctxt('whm-jobs-client', 'No job is selected.'))); outcome.hidden = true
        verification.textContent = t('Not read'); verificationDetail.hidden = true; verificationDetail.textContent = ''
        paintLog(); return
      }
      const job = selected
      note(detailStatus, 'read', active(job) ? t('This job is still in progress. Its state refreshes while the page is visible.') : t('This job has finished. The record below is final.'))
      field('reference', job.referenceCode === null ? t('Unnumbered') : ltr(job.referenceCode)); field('kind', ltr(job.kind)); field('summary', job.summary || t('No summary')); field('status', badge(job.status)); field('progress', meter(job)); field('actor', ltr(job.actor))
      field('created', utc(job.createdAt, t('Not read'))); field('started', utc(job.startedAt, t('Not started'))); field('finished', utc(job.finishedAt, t('Not finished')))
      field('cancellation', job.cancelRequested ? (active(job) ? t('Requested; takes effect before the next step') : t('Requested')) : t('Not requested'))
      steps.textContent = ''
      job.steps.forEach((step, index) => {
        const row = cloneClientTemplate(clientTemplate(root, 'whm-jobs-step'), 'tr', ['order', 'title', 'state', 'exit'])
        clientTemplateSlot(row, 'order').replaceChildren(ltr(String(index + 1))); clientTemplateSlot(row, 'title').textContent = t(step.title, step.titleValues)
        clientTemplateSlot(row, 'state').textContent = stepLabel(step.state); clientTemplateSlot(row, 'exit').replaceChildren(step.exitCode === null ? t('None') : ltr(String(step.exitCode)))
        row.dataset.stepState = step.state; steps.append(row)
      })
      if (!job.steps.length) placeholder(steps, 4, t('The job record has no readable steps.'))
      outcome.hidden = job.status !== 'failed' && job.status !== 'cancelled'
      failure.textContent = failureExplanation(job); failure.dataset.failureClass = job.failureClass ?? 'none'
      errorText.textContent = job.error ?? ''; errorText.hidden = !job.error
      verification.textContent = job.verification === null ? (active(job) ? t('Not run yet.') : t('No host verification was recorded for this job.'))
        : job.verification.ok ? t('The host check confirmed the expected result.') : t('The host check did not confirm the expected result.')
      verificationDetail.hidden = job.verification === null; verificationDetail.textContent = job.verification ? JSON.stringify(job.verification.detail, null, 2) : ''
      paintLog()
    }
    const paintRows = (): void => {
      rows.textContent = ''
      for (const job of jobs) {
        const row = cloneClientTemplate(clientTemplate(root, 'whm-jobs-row'), 'tr', ['reference', 'kind', 'summary', 'state', 'progress', 'created', 'started', 'finished', 'actor'])
        const select = whmClientNode(root, 'whm-jobs-select', 'button')
        select.disabled = !admitted(); select.dataset.whmJobsSelect = job.id; select.setAttribute('aria-controls', 'whm-jobs-detail'); select.setAttribute('aria-pressed', String(wanted === job.id)); select.append(ltr(job.kind))
        select.addEventListener('click', () => { if (admitted()) void choose(job.id) })
        const put = (slot: string, value: Node | string): void => clientTemplateSlot(row, slot).replaceChildren(value)
        put('reference', job.referenceCode === null ? t('Unnumbered') : ltr(job.referenceCode)); put('kind', select); put('summary', job.summary); put('state', badge(job.status)); put('progress', meter(job)); put('created', utc(job.createdAt, ''))
        put('started', utc(job.startedAt, t('Not started'))); put('finished', utc(job.finishedAt, t('Not finished'))); put('actor', ltr(job.actor))
        rows.append(row)
      }
      if (!jobs.length) placeholder(rows, 9, t('No jobs were returned.'))
      if (empty) empty.hidden = jobs.length > 0 || !filters.status && !filters.kindPrefix
    }
    const failText = (error: unknown, fallback: string): string => {
      const code = (error as { status?: number })?.status
      return code === 503 ? t('The host agent or its job runner is unavailable. No job state was read.')
        : code === 403 ? t('Root authorization is required to read host jobs.') : fallback
    }
    const schedule = (): void => {
      clearTimeout(timer); timer = undefined
      if (admitted() && document.visibilityState !== 'hidden' && failures < MAX_FAILURES && (jobs.some(active) || !!selected && active(selected))) timer = setTimeout(() => { timer = undefined; void loadList(true) }, POLL_MS)
    }
    const loadLog = async (reset: boolean): Promise<void> => {
      if (!selected || logBusy || !admitted() || !request) return
      const id = selected.id
      if (reset || log.id !== id) log = { id, text: '', nextOffset: 0, total: 0, available: false, truncated: false }
      if (log.text.length >= LOG_DISPLAY_MAX) { paintLog(); return }
      logBusy = true; paintLog()
      try {
        const page = readJobLogView(await request('GET', '/api/jobs/' + id + '/log?offset=' + log.nextOffset + '&limit=' + LOG_PAGE))
        if (selected?.id === id && log.id === id && page.id === id && page.offset === log.nextOffset) log = { id, text: (log.text + page.text).slice(0, LOG_DISPLAY_MAX), nextOffset: page.nextOffset, total: page.total, available: page.available, truncated: page.truncated }
      } catch (error) { if (selected?.id === id) logStatus.textContent = failText(error, t(msgctxt('whm-jobs-client', 'The log could not be read. Nothing was changed.'))); logBusy = false; logMore.disabled = !admitted(); return }
      logBusy = false; paintLog()
    }
    const loadDetail = async (id: string, reset: boolean): Promise<void> => {
      if (!admitted() || !request) return
      try {
        const body = await request('GET', '/api/jobs/' + id) as { job?: unknown }
        const job = readJobView(body?.job)
        if (job.id !== id) throw new Error('invalid_job')
        if (wanted !== id) return
        const caughtUp = log.id === id && log.nextOffset >= log.total
        selected = job; jobs = jobs.map(item => item.id === id ? job : item); paintRows(); paintDetail()
        if (reset || caughtUp && (active(job) || job.logBytes > log.total)) await loadLog(reset)
      } catch (error) { note(detailStatus, 'failed', failText(error, t('The selected job could not be read or verified. Nothing was changed.'))) }
    }
    const choose = async (id: string): Promise<void> => {
      if (wanted === id) return
      wanted = id; selected = jobs.find(job => job.id === id) ?? null; log = { id: '', text: '', nextOffset: 0, total: 0, available: false, truncated: false }
      cancelStatus.hidden = true; paintRows(); paintDetail()
      await loadDetail(id, true)
    }
    const loadList = async (background = false): Promise<void> => {
      if (!admitted() || !request) return
      if (listBusy) { again = true; return }
      listBusy = true
      refresh.disabled = true; root.setAttribute('aria-busy', 'true'); if (loading && !jobs.length) loading.hidden = false
      if (!background) note(status, 'reading', t('Reading host job history…'))
      const search = new URLSearchParams(); if (filters.status) search.set('status', filters.status); if (filters.kindPrefix) search.set('kindPrefix', filters.kindPrefix); search.set('limit', '50')
      try {
        const listed = readJobListView(await request('GET', '/api/jobs?' + search.toString()))
        if (!admitted()) return
        jobs = listed; failures = 0
        paintRows()
        const running = jobs.filter(active).length
        note(status, 'read', !jobs.length ? t('Job history read. No host jobs match.')
          : running ? t('Job history read. Jobs in progress: {count}.', { count: running }) : t('Job history read. No job is in progress.'))
        if (wanted) await loadDetail(wanted, false)
      } catch (error) {
        failures++
        note(status, 'failed', failText(error, t('Job history could not be read or verified. Any rows shown are from the last successful read; nothing was changed.')))
      } finally {
        listBusy = false; refresh.disabled = !admitted(); root.setAttribute('aria-busy', 'false'); if (loading) loading.hidden = true
        if (again) { again = false; void loadList() } else schedule()
      }
    }
    if (!admitted()) {
      for (const control of [statusFilter, kindFilter, refresh, clear, apply, logMore, cancel]) control.disabled = true
      note(status, 'unavailable', t('Host jobs are unavailable here. Nothing was read or changed.'))
      return
    }
    form.addEventListener('submit', event => {
      event.preventDefault()
      const kindPrefix = kindFilter.value.trim()
      if (kindPrefix && !/^[a-z][a-z0-9_.:-]{0,127}$/.test(kindPrefix)) { kindFilter.setAttribute('aria-invalid', 'true'); note(status, 'failed', t('Enter a kind such as system.packages: lowercase letters, digits and . _ : - only.')); kindFilter.focus(); return }
      kindFilter.removeAttribute('aria-invalid')
      filters = { status: ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(statusFilter.value) ? statusFilter.value : '', kindPrefix }
      failures = 0; void loadList()
    })
    clear.addEventListener('click', () => { statusFilter.value = ''; kindFilter.value = ''; kindFilter.removeAttribute('aria-invalid'); filters = { status: '', kindPrefix: '' }; failures = 0; void loadList() })
    refresh.addEventListener('click', () => { failures = 0; void loadList() })
    logMore.addEventListener('click', () => { void loadLog(false) })
    cancel.addEventListener('click', async () => {
      const job = selected
      if (!job || !active(job) || cancelling || !manageable() || !request || typeof askDialog !== 'function') return
      cancelling = true; lockCancel()
      let confirmed = false
      try {
        confirmed = await askDialog({ title: t('Cancel this job?'), danger: true, confirm: t('Cancel job'), cancel: t('Keep running'),
          body: job.status === 'queued' ? t('The job has not started. Cancelling it now means none of its steps will run.')
            : t('The step that is running now will finish. The job stops before its next step; steps already completed are not undone.') }) === true
      } catch { confirmed = false }
      if (!confirmed || selected?.id !== job.id || !manageable()) { cancelling = false; lockCancel(); return }
      note(cancelStatus, 'reading', t('Recording the cancellation…'))
      try {
        const updated = readJobView((await request('POST', '/api/jobs/' + job.id + '/cancel') as { job?: unknown })?.job)
        if (updated.id === job.id) { selected = updated; jobs = jobs.map(item => item.id === updated.id ? updated : item); paintRows(); paintDetail() }
        note(cancelStatus, 'read', updated.status === 'cancelled' ? t('The job was cancelled before it started.') : t('Cancellation recorded. The job stops before its next step.'))
      } catch (error) {
        const failed = error as { status?: number; details?: { unknownOutcome?: boolean; stateChanged?: boolean } }
        note(cancelStatus, 'failed', failed?.details?.unknownOutcome || failed?.details?.stateChanged ? t('The cancellation result could not be verified. Refresh the job before acting again.')
          : failed?.status === 412 ? t('The job can no longer be cancelled; it has already finished.') : failText(error, t('The cancellation was not recorded.')))
      }
      cancelling = false; lockCancel(); void loadList()
    })
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { clearTimeout(timer); timer = undefined } else if (!timer && root.isConnected) void loadList() })
    paintDetail()
    void loadList()
    // Submitting workspaces link here as /whm/jobs?job=<id>; the job may be older than the first page.
    const linked = new URLSearchParams(window.location.search).get('job')
    if (linked && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(linked)) void choose(linked)
  })
}

export const WHM_JOBS_CLIENT_BINDING = `(()=>{${WHM_CLIENT_TEMPLATE_BINDING}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readJobView=${readJobView.toString()};const readJobListView=${readJobListView.toString()};const readJobLogView=${readJobLogView.toString()};return ${bindWhmJobs.toString()};})()`
