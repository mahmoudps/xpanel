import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
const CRON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CRON_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u
export interface AccountCronJob {
  id: string; accountId: string; schedule: string; command: string; comment: string; enabled: boolean; maxRuntimeSec: number | null
  onCalendar: string[]; scheduleSupported: boolean; unitPreview: { service: string; timer: string } | null
}
export interface AccountCronDraft { schedule: string; command: string; comment: string; enabled: boolean; maxRuntimeSec: number | null }
export interface AccountCronView {
  context: { accountId: string; username: string; home: string }; revision: string; jobs: AccountCronJob[]
  capacity: { maxJobs: number; used: number; maxRuntimeSec: number }
  capabilities: { runNow: boolean; observation: boolean }
}
export interface AccountCronObservation { timerEnabled: boolean; timerActive: boolean; serviceRunning: boolean; lastTriggerAt: string | null; lastStartedAt: string | null; nextRunAt: string | null; durationMs: number | null; lastExitCode: number | null; lastResult: string }
export function cronObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
const cronText = (value: unknown, max: number, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || CRON_UNSAFE.test(value) || !empty && !value.trim()) throw new Error('invalid_cron_text')
  return value
}
export function cronStable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(cronStable).join(',') + ']'
  if (cronObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + cronStable(value[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'undefined'
}
export const cronDraftOf = (job: AccountCronJob): AccountCronDraft => ({ schedule: job.schedule, command: job.command, comment: job.comment, enabled: job.enabled, maxRuntimeSec: job.maxRuntimeSec })
export function cronExpandedSchedule(schedule: string): string {
  const macros: Record<string, string> = { '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' }
  return macros[schedule.toLowerCase()] ?? schedule.trim().replace(/[ \t]+/g, ' ')
}
export function readAccountCronView(value: unknown, accountId: string): AccountCronView {
  if (!CRON_ID.test(accountId) || !cronObject(value) || !cronObject(value.context) || value.context.accountId !== accountId || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)) throw new Error('invalid_cron_scope')
  if (!cronObject(value.application) || value.application.status !== 'configuration_only' || value.application.nativeApplied !== false) throw new Error('invalid_cron_application')
  if ([value, cronObject(value.details) ? value.details : {}].some(part => part.unknownOutcome === true || part.verificationRequired === true || part.needsAttention === true)) throw new Error('uncertain_cron_reply')
  if (!Array.isArray(value.jobs) || value.jobs.length > 10000 || !cronObject(value.capacity)) throw new Error('invalid_cron_collection')
  const capacity = value.capacity
  for (const key of ['maxJobs', 'used', 'maxRuntimeSec']) if (typeof capacity[key] !== 'number' || !Number.isSafeInteger(capacity[key]) || Number(capacity[key]) < (key === 'used' ? 0 : 1)) throw new Error('invalid_cron_capacity')
  const ids = new Set<string>()
  const jobs = value.jobs.map(raw => {
    if (!cronObject(raw) || typeof raw.id !== 'string' || !CRON_ID.test(raw.id) || ids.has(raw.id) || raw.accountId !== accountId || typeof raw.enabled !== 'boolean') throw new Error('invalid_cron_job')
    ids.add(raw.id)
    const runtime = raw.maxRuntimeSec
    if (runtime !== null && (typeof runtime !== 'number' || !Number.isSafeInteger(runtime) || runtime < 1 || runtime > Number(capacity.maxRuntimeSec))) throw new Error('invalid_cron_runtime')
    if (!Array.isArray(raw.onCalendar) || raw.onCalendar.length > 2 || raw.onCalendar.length === 0 && raw.scheduleSupported !== false || raw.onCalendar.length > 0 && raw.scheduleSupported === false || raw.onCalendar.some(text => typeof text !== 'string' || text.length > 512 || CRON_UNSAFE.test(text))) throw new Error('invalid_cron_calendar')
    let unitPreview: AccountCronJob['unitPreview'] = null
    if (raw.unitPreview !== null) {
      if (!cronObject(raw.unitPreview) || typeof raw.unitPreview.service !== 'string' || typeof raw.unitPreview.timer !== 'string' || raw.unitPreview.service.length > 32768 || raw.unitPreview.timer.length > 32768) throw new Error('invalid_cron_unit_preview')
      unitPreview = { service: raw.unitPreview.service, timer: raw.unitPreview.timer }
    }
    return { id: raw.id, accountId, schedule: cronText(raw.schedule, 128), command: cronText(raw.command, 4096), comment: cronText(raw.comment, 255, true), enabled: raw.enabled, maxRuntimeSec: runtime as number | null, onCalendar: raw.onCalendar as string[], scheduleSupported: raw.onCalendar.length > 0, unitPreview }
  })
  if (capacity.used !== jobs.length) throw new Error('invalid_cron_count')
  return { context: { accountId, username: cronText(value.context.username, 64), home: cronText(value.context.home, 4096) }, revision: value.revision,
    jobs, capacity: { maxJobs: Number(capacity.maxJobs), used: jobs.length, maxRuntimeSec: Number(capacity.maxRuntimeSec) }, capabilities: { runNow: cronObject(value.capabilities) && value.capabilities.runNow === true, observation: cronObject(value.capabilities) && value.capabilities.observation === true } }
}
export function readAccountCronObservation(value: unknown, view: AccountCronView, job: AccountCronJob, running: boolean): AccountCronObservation {
  if (!cronObject(value) || !cronObject(value.context) || value.context.accountId !== view.context.accountId || value.context.jobId !== job.id || value.revision !== view.revision || value.status !== (running ? 'accepted' : 'observed') || running && (value.requested !== true || value.completed !== false) || !cronObject(value.observation)) throw new Error('invalid_cron_host_scope')
  if ([value, cronObject(value.details) ? value.details : {}].some(part => part.unknownOutcome === true || part.verificationRequired === true || part.needsAttention === true)) throw new Error('uncertain_cron_host_reply')
  const observation = value.observation
  if (observation.username !== view.context.username || ['timerEnabled', 'timerActive', 'serviceRunning'].some(key => typeof observation[key] !== 'boolean')) throw new Error('invalid_cron_host_observation')
  const timestamp = (key: string): string | null => observation[key] === null ? null : cronText(observation[key], 512)
  const duration = observation.durationMs, exit = observation.lastExitCode
  if (duration !== null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) || exit !== null && (typeof exit !== 'number' || !Number.isInteger(exit) || exit < 0 || exit > 255)) throw new Error('invalid_cron_host_result')
  return { timerEnabled: observation.timerEnabled as boolean, timerActive: observation.timerActive as boolean, serviceRunning: observation.serviceRunning as boolean, lastTriggerAt: timestamp('lastTriggerAt'), lastStartedAt: timestamp('lastStartedAt'), nextRunAt: timestamp('nextRunAt'), durationMs: duration as number | null, lastExitCode: exit as number | null, lastResult: cronText(observation.lastResult, 128) }
}
export function cronLatinDigits(value: string): string { return value.replace(/[\u0660-\u0669\u06f0-\u06f9]/gu, digit => String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x6f0 ? 0x6f0 : 0x660))) }
export function accountCronDraft(input: { fields: string[]; command: string; comment: string; enabled: boolean; unlimited: boolean; runtime: string }, maxRuntimeSec: number): AccountCronDraft {
  if (input.fields.length !== 5 || input.fields.some(field => !/^[a-zA-Z0-9*,/\-]{1,32}$/.test(field.trim()))) throw new Error('invalid_cron_schedule')
  let runtime: number | null = null
  if (!input.unlimited) {
    if (!/^[0-9]{1,6}$/.test(input.runtime.trim())) throw new Error('invalid_cron_runtime')
    runtime = Number(input.runtime.trim())
    if (!Number.isSafeInteger(runtime) || runtime < 1 || runtime > maxRuntimeSec) throw new Error('invalid_cron_runtime')
  }
  return { schedule: input.fields.map(field => field.trim()).join(' '), command: cronText(input.command, 4096), comment: cronText(input.comment, 255, true), enabled: input.enabled, maxRuntimeSec: runtime }
}
export function accountCronWriteUncertain(error: unknown): boolean {
  const value = cronObject(error) ? error : {}, details = cronObject(value.details) ? value.details : {}
  if ([value, details].some(part => part.stateChanged === true || part.unknownOutcome === true || part.verificationRequired === true || part.needsAttention === true)) return true
  if ([value, details].some(part => part.stateChanged === false)) return false
  return typeof value.status !== 'number' || value.status >= 500
}

function bindAccountCron(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-cron]').forEach(root => {
    if (root.dataset.cronBound === 'true') return
    root.dataset.cronBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const accountId = root.dataset.account ?? ''
    const eligible = (): boolean => root.isConnected && root.dataset.cronManage === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const status = root.querySelector<HTMLElement>('[data-cron-status]')!, rows = root.querySelector<HTMLElement>('[data-cron-jobs]')!
    const preset = root.querySelector<HTMLSelectElement>('[data-cron-preset]')!, unlimited = root.querySelector<HTMLInputElement>('[data-cron-unlimited]')!, enabled = root.querySelector<HTMLInputElement>('[data-cron-enabled]')!
    const field = (key: string): HTMLInputElement | HTMLTextAreaElement => root.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-cron-field="' + key + '"]')!
    const action = (key: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-cron-' + key + ']')!
    const scheduleKeys = ['minute', 'hour', 'day', 'month', 'weekday']
    if (!status || !rows || !preset || !unlimited || !enabled || [...scheduleKeys, 'command', 'comment', 'runtime'].some(key => !field(key)) || ['refresh', 'new', 'save', 'reset', 'run', 'observe'].some(key => !action(key))) return
    const rowSlots = ['name', 'schedule', 'command', 'last-run', 'duration', 'next-run', 'actions'] as const
    const rowTemplate = clientTemplate(root, 'account-cron-row'), emptyTemplate = clientTemplate(root, 'account-cron-empty'), actionTemplate = clientTemplate(root, 'account-cron-action')
    cloneClientTemplate(rowTemplate, 'tr', rowSlots); cloneClientTemplate(emptyTemplate, 'tr', ['message']); cloneClientTemplate(actionTemplate, 'button', ['label'])
    let view: AccountCronView | null = null, selectedId: string | null = null, busy = false, confirming = false, review = false
    const observations = new Map<string, AccountCronObservation>()
    const selected = (): AccountCronJob | undefined => view?.jobs.find(job => job.id === selectedId)
    const readDraft = (): AccountCronDraft => {
      const draft = accountCronDraft({ fields: scheduleKeys.map(key => field(key).value), command: field('command').value, comment: field('comment').value, enabled: enabled.checked, unlimited: unlimited.checked, runtime: field('runtime').value }, view?.capacity.maxRuntimeSec ?? 604800)
      const current = selected()
      return current && cronExpandedSchedule(current.schedule) === draft.schedule ? { ...draft, schedule: current.schedule } : draft
    }
    const emptyDraft = (): AccountCronDraft => ({ schedule: '*/5 * * * *', command: '', comment: '', enabled: true, maxRuntimeSec: null })
    const dirty = (): boolean => {
      const baseline = selected() ? cronDraftOf(selected()!) : emptyDraft()
      try { return cronStable(readDraft()) !== cronStable(baseline) } catch { return selectedId !== null || field('command').value !== '' || field('comment').value !== '' || scheduleKeys.map(key => field(key).value).join(' ') !== baseline.schedule || !unlimited.checked || !enabled.checked }
    }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const lock = (): void => {
      const blocked = !eligible() || !view || busy || confirming || review
      for (const key of [...scheduleKeys, 'command', 'comment', 'runtime']) field(key).disabled = blocked || key === 'runtime' && unlimited.checked
      unlimited.disabled = blocked; enabled.disabled = blocked; preset.disabled = blocked
      action('save').disabled = blocked || !dirty() || selectedId === null && view!.capacity.used >= view!.capacity.maxJobs
      action('new').disabled = !eligible() || !view || busy || confirming
      action('reset').disabled = !eligible() || !view || busy || confirming
      action('refresh').disabled = !eligible() || busy || confirming
      action('run').disabled = blocked || dirty() || !selected()?.enabled || selected()?.scheduleSupported !== true || view?.capabilities.runNow !== true
      action('observe').disabled = blocked || dirty() || !selected() || view?.capabilities.observation !== true
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = blocked })
      root.setAttribute('aria-busy', String(busy || confirming))
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!send || !eligible()) return Promise.reject({ stateChanged: false })
      return body === undefined ? send(method, path) : send(method, path, body)
    }
    const preview = (job?: AccountCronJob): void => {
      const text = root.querySelector<HTMLElement>('[data-cron-preview]')!, hint = root.querySelector<HTMLElement>('[data-cron-preview-state]')!
      text.textContent = job?.unitPreview ? job.unitPreview.service + '\n' + job.unitPreview.timer : job ? job.onCalendar.map(calendar => 'OnCalendar=' + calendar).join('\n') : ''
      hint.textContent = !job ? t('No job is selected.') : job.unitPreview ? t('Source generated by the configured host renderer. Installation and execution are unverified.') : t('Schedule conversion only. The configured host profile is unavailable for a full unit preview.')
      if (job && !job.scheduleSupported) hint.textContent = t('This saved schedule is unsupported by the host renderer. Edit or delete it before execution; no unit preview is assumed.')
    }
    const fill = (job?: AccountCronJob): void => {
      const draft = job ? cronDraftOf(job) : emptyDraft()
      const parts = cronExpandedSchedule(draft.schedule).split(' ')
      scheduleKeys.forEach((key, index) => { field(key).value = parts[index] ?? '*' })
      field('command').value = draft.command; field('comment').value = draft.comment
      field('runtime').value = String(draft.maxRuntimeSec ?? 300); unlimited.checked = draft.maxRuntimeSec === null; enabled.checked = draft.enabled
      preset.value = Array.from(preset.options).some(option => option.value === parts.join(' ')) ? parts.join(' ') : ''
      root.querySelector<HTMLElement>('[data-cron-editor-title]')!.textContent = job ? t('Edit cron job') : t('Add a cron job')
      preview(job)
    }
    const ask = async (title: string, body: string, danger = false): Promise<boolean> => {
      if (!askDialog || confirming) { note('failed', t('Confirmation is unavailable. Nothing was sent.')); return false }
      confirming = true; lock()
      try { return await askDialog({ title, body, danger, confirm: t('Confirm') }) === true } catch { return false }
      finally { confirming = false; lock() }
    }
    const discard = (): Promise<boolean> => !dirty() && !review ? Promise.resolve(true) : ask(t('Discard draft and read saved jobs?'), t('Unsaved edits will be discarded. No previous request is retried.'), true)
    const paintRows = (): void => {
      rows.textContent = ''
      for (const job of view?.jobs ?? []) {
        const row = cloneClientTemplate(rowTemplate, 'tr', rowSlots)
        const observed = observations.get(job.id), unknown = t('Not observed')
        for (const [slot, text] of [['name', job.comment || t('Scheduled command')], ['schedule', job.schedule], ['command', job.command], ['last-run', cronLatinDigits(observed?.lastStartedAt ?? observed?.lastTriggerAt ?? unknown)], ['duration', observed?.durationMs === null || observed?.durationMs === undefined ? unknown : String(observed.durationMs) + ' ms'], ['next-run', cronLatinDigits(observed?.nextRunAt ?? unknown)]] as const) clientTemplateSlot(row, slot).textContent = text
        const actions = clientTemplateSlot(row, 'actions')
        const button = (label: string, callback: () => void): void => { const button = cloneClientTemplate(actionTemplate, 'button', ['label']) as HTMLButtonElement; clientTemplateSlot(button, 'label').textContent = label; button.setAttribute('aria-label', label + ': ' + (job.comment || job.command)); button.addEventListener('click', () => { if (!button.disabled && eligible()) callback() }); actions.append(button) }
        button(t('Edit'), () => { void refresh(job.id) })
        button(t('View unit'), () => preview(job))
        button(t('Delete'), () => { void mutate('delete', job) })
        rows.append(row)
      }
      if (!view?.jobs.length) { const row = cloneClientTemplate(emptyTemplate, 'tr', ['message']); clientTemplateSlot(row, 'message', 'td').textContent = t('The saved list contains no cron jobs.'); rows.append(row) }
    }
    const install = (next: AccountCronView, id: string | null): void => {
      view = next; selectedId = next.jobs.some(job => job.id === id) ? id : null; review = false; observations.clear()
      field('runtime').setAttribute('min', '1'); field('runtime').setAttribute('max', String(next.capacity.maxRuntimeSec)); field('runtime').setAttribute('step', '1')
      root.querySelector<HTMLElement>('[data-cron-capacity]')!.textContent = t('{used} / {max} saved jobs', { used: next.capacity.used, max: next.capacity.maxJobs })
      root.querySelector<HTMLElement>('[data-cron-username]')!.textContent = next.context.username
      root.querySelector<HTMLElement>('[data-cron-home]')!.textContent = next.context.home
      fill(selected()); paintRows()
    }
    async function refresh(id: string | null = selectedId): Promise<void> {
      if (!eligible() || busy || confirming || !await discard() || busy || confirming || !eligible()) return
      busy = true; lock(); note('reading', t('Reading saved cron jobs…'))
      try { install(readAccountCronView(await request('GET', '/api/account/cron'), accountId), id); note('read', t('Saved cron configuration read. Installation and execution are unverified.')) }
      catch { note('failed', t('Saved cron jobs could not be read. Your draft is preserved.')) }
      finally { busy = false; lock() }
    }
    async function mutate(mode: 'save' | 'delete', target = selected()): Promise<void> {
      if (!eligible() || !view || busy || confirming || review) return
      let draft: AccountCronDraft | null = null
      if (mode === 'save') {
        try { draft = readDraft() } catch { note('failed', t('Review the five schedule fields, command and runtime limit. Nothing was sent.')); return }
        if (!dirty() || !target && view.capacity.used >= view.capacity.maxJobs) return
      } else if (!target) return
      const before = view, command = mode === 'delete' ? target!.command : draft!.command
      const discardNotice = dirty() ? '\n' + t('This action replaces the current unsaved draft after success.') : ''
      if (!await ask(mode === 'delete' ? t('Delete scheduled command?') : t('Save scheduled command?'), command + '\n' + t('Saved configuration is reconciled as the account user. Execution is not verified here.') + discardNotice, mode === 'delete')) return
      if (!eligible() || busy || view !== before) return
      busy = true; lock(); note('saving', t('Saving and verifying the saved readback…'))
      try {
        const path = '/api/account/cron' + (target ? '/' + encodeURIComponent(target.id) : '')
        const payload = mode === 'delete' ? { expectedRevision: before.revision, confirmation: target!.command } : { ...draft!, expectedRevision: before.revision }
        const acknowledged = readAccountCronView(await request(mode === 'delete' ? 'DELETE' : target ? 'PATCH' : 'POST', path, payload), accountId)
        const expectedIds = new Set(before.jobs.filter(job => mode !== 'delete' || job.id !== target!.id).map(job => job.id))
        let savedId = target?.id ?? null
        if (mode === 'save' && !target) {
          const created = acknowledged.jobs.filter(job => !expectedIds.has(job.id))
          if (created.length !== 1 || cronStable(cronDraftOf(created[0]!)) !== cronStable(draft)) throw new Error('wrong_cron_create_ack')
          savedId = created[0]!.id; expectedIds.add(savedId)
        }
        if (acknowledged.jobs.length !== expectedIds.size || acknowledged.jobs.some(job => !expectedIds.has(job.id))) throw new Error('wrong_cron_collection_ack')
        for (const old of before.jobs) {
          const saved = acknowledged.jobs.find(job => job.id === old.id)
          if (old.id === target?.id) {
            if (mode === 'delete' ? !!saved : !saved || cronStable(cronDraftOf(saved)) !== cronStable(draft)) throw new Error('wrong_cron_target_ack')
          } else if (!saved || cronStable(cronDraftOf(saved)) !== cronStable(cronDraftOf(old))) throw new Error('unrelated_cron_changed')
        }
        const observed = readAccountCronView(await request('GET', '/api/account/cron'), accountId)
        if (observed.revision !== acknowledged.revision || cronStable(observed.jobs) !== cronStable(acknowledged.jobs)) throw new Error('cron_readback_mismatch')
        install(observed, mode === 'delete' ? null : savedId)
        note(mode === 'delete' ? 'deleted' : 'saved', t('Cron configuration saved and read back. Installation and execution remain unverified.'))
      } catch (error) {
        const stale = cronObject(error) && error.status === 409
        review = stale || accountCronWriteUncertain(error)
        note(review ? stale ? 'stale' : 'uncertain' : 'failed', review ? t('The outcome requires review. Your draft is kept and no retry was sent. Read saved jobs before continuing.') : t('The request was refused. Your draft is kept and no retry was sent.'))
      } finally { busy = false; lock() }
    }
    async function readHost(running: boolean): Promise<void> {
      const target = selected(), before = view
      if (!eligible() || !before || !target || busy || confirming || review || dirty() || (running ? !before.capabilities.runNow || !target.enabled || !target.scheduleSupported : !before.capabilities.observation)) return
      if (running && !await ask(t('Run this saved command now?'), target.command + '\n' + t('This starts work as your account user. Request acceptance does not mean the job completed.'), true)) return
      if (!eligible() || busy || confirming || view !== before || selectedId !== target.id || dirty()) return
      busy = true; lock(); note('observing', running ? t('Requesting execution and reading host state…') : t('Reading the selected job from the host…'))
      try {
        const path = '/api/account/cron/' + encodeURIComponent(target.id) + (running ? '/run' : '/status')
        const raw = await request(running ? 'POST' : 'GET', path, running ? { expectedRevision: before.revision, confirmation: target.command } : undefined)
        const observed = readAccountCronObservation(raw, before, target, running)
        observations.set(target.id, observed); paintRows()
        const state = observed.serviceRunning ? t('The service is currently running.') : t('The service is not currently running.')
        const result = observed.lastResult === 'unknown' ? t('No completed result has been observed.') : t('Last observed result: {result}', { result: observed.lastResult })
        const timer = t('Timer: {enabled, select, yes {enabled} other {disabled}}, {active, select, yes {active} other {inactive}}.', { enabled: observed.timerEnabled ? 'yes' : 'no', active: observed.timerActive ? 'yes' : 'no' })
        const exit = observed.lastExitCode === null ? [] : [t('Last observed exit code: {code}', { code: observed.lastExitCode })]
        note(running ? 'requested' : 'observed', [running ? t('The run request was accepted. Completion has not been confirmed.') : t('Host state was read.'), state, timer, result, ...exit].join(' '))
      } catch (error) {
        const stale = cronObject(error) && error.status === 409
        review = stale || accountCronWriteUncertain(error)
        note(review ? stale ? 'stale' : 'uncertain' : 'failed', review ? t('The host outcome requires review. No retry was sent. Read saved jobs before continuing.') : t('The host request was refused or observation is unavailable. No retry was sent.'))
      } finally { busy = false; lock() }
    }
    if (!send || !eligible() || !CRON_ID.test(accountId)) {
      for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')) control.disabled = true
      note('unavailable', t('Cron configuration is unavailable here. Nothing was read or changed.')); return
    }
    const edited = (): void => { if (!busy && !review && !confirming) { note('editing', t('Unsaved cron draft.')); lock() } }
    for (const key of [...scheduleKeys, 'command', 'comment', 'runtime']) field(key).addEventListener('input', edited)
    unlimited.addEventListener('change', edited); enabled.addEventListener('change', edited)
    preset.addEventListener('change', () => { if (preset.disabled || !preset.value) return; const values = preset.value.split(' '); scheduleKeys.forEach((key, index) => { field(key).value = values[index] ?? '*' }); edited() })
    action('refresh').addEventListener('click', () => { void refresh() })
    action('new').addEventListener('click', () => { void refresh(null) })
    action('reset').addEventListener('click', () => { void refresh(selectedId) })
    action('save').addEventListener('click', () => { void mutate('save') })
    action('run').addEventListener('click', () => { void readHost(true) })
    action('observe').addEventListener('click', () => { void readHost(false) })
    window.addEventListener('beforeunload', event => { if (dirty() || review) { event.preventDefault(); event.returnValue = '' } })
    lock(); void refresh(null)
  })
}

export const ACCOUNT_CRON_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const CRON_ID=${CRON_ID.toString()};const CRON_UNSAFE=${CRON_UNSAFE.toString()};const cronObject=${cronObject.toString()};const cronText=${cronText.toString()};const cronStable=${cronStable.toString()};const cronDraftOf=${cronDraftOf.toString()};const cronExpandedSchedule=${cronExpandedSchedule.toString()};const readAccountCronView=${readAccountCronView.toString()};const readAccountCronObservation=${readAccountCronObservation.toString()};const cronLatinDigits=${cronLatinDigits.toString()};const accountCronDraft=${accountCronDraft.toString()};const accountCronWriteUncertain=${accountCronWriteUncertain.toString()};return ${bindAccountCron.toString()};})()`
