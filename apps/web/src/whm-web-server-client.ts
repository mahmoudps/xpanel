/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export const WHM_WEB_SETTING_FIELDS = ['engine', 'apacheMpm', 'backendPort', 'backendTlsPort', 'nginx.workerProcesses', 'nginx.workerConnections', 'nginx.workerRlimitNofile', 'nginx.keepaliveTimeoutSec', 'nginx.multiAccept', 'apache.startServers', 'apache.minSpareServers', 'apache.maxSpareServers', 'apache.maxRequestWorkers', 'apache.serverLimit', 'apache.maxConnectionsPerChild'] as const
type WebValues = Record<string, string | number | boolean>
export interface WhmWebGeneration { id: number; createdAt: string; status: string; checksum: string; filesCount?: number }
export interface WhmWebDesiredState { revision: number; checksum: string; pending: boolean }
export interface WhmWebGenerationRead { generations: WhmWebGeneration[]; currentGeneration: WhmWebGeneration | null; desiredState: WhmWebDesiredState | null; canRollback: boolean; rollbackEligibleGenerationIds: number[] }
interface WhmWebService { id: string; label: string; unit: string | null; state: string }
export function whmWebObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function readWhmWebGeneration(value: unknown): WhmWebGeneration {
  if (!whmWebObject(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.status !== 'string' || !['pending', 'tested', 'active', 'superseded', 'failed', 'rolled_back'].includes(value.status) || typeof value.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(value.checksum)) throw new Error('invalid_generation')
  if (value.filesCount !== undefined && (typeof value.filesCount !== 'number' || !Number.isSafeInteger(value.filesCount) || value.filesCount < 0)) throw new Error('invalid_generation')
  return { id: value.id, createdAt: value.createdAt, status: value.status, checksum: value.checksum, ...(typeof value.filesCount === 'number' ? { filesCount: value.filesCount } : {}) }
}
export function readWhmWebGenerations(value: unknown): WhmWebGenerationRead {
  if (!whmWebObject(value) || !Array.isArray(value.generations) || value.generations.length > 10000 || value.currentGeneration === undefined) throw new Error('invalid_generations')
  const generations = value.generations.map(readWhmWebGeneration)
  if (new Set(generations.map(item => item.id)).size !== generations.length) throw new Error('duplicate_generation')
  const currentGeneration = value.currentGeneration === null ? null : readWhmWebGeneration(value.currentGeneration)
  if (currentGeneration && currentGeneration.status !== 'active') throw new Error('invalid_active_generation')
  let desiredState: WhmWebDesiredState | null = null
  if (value.desiredState !== undefined && value.desiredState !== null) {
    const state = value.desiredState
    if (!whmWebObject(state) || typeof state.revision !== 'number' || !Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(state.checksum) || typeof state.pending !== 'boolean') throw new Error('invalid_desired_state')
    desiredState = { revision: state.revision, checksum: state.checksum, pending: state.pending }
  }
  if (value.canRollback !== undefined && typeof value.canRollback !== 'boolean') throw new Error('invalid_rollback_admission')
  const eligible = value.rollbackEligibleGenerationIds === undefined ? [] : value.rollbackEligibleGenerationIds
  const superseded = new Set(generations.filter(item => item.status === 'superseded').map(item => item.id))
  if (!Array.isArray(eligible) || eligible.length > 10000 || eligible.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || !superseded.has(id)) || new Set(eligible).size !== eligible.length) throw new Error('invalid_rollback_targets')
  return { generations, currentGeneration, desiredState, canRollback: value.canRollback === true, rollbackEligibleGenerationIds: eligible }
}
export function readWhmWebServices(value: unknown): WhmWebService[] {
  if (!whmWebObject(value) || !Array.isArray(value.services) || value.services.length > 256) throw new Error('invalid_services')
  const seen = new Set<string>()
  return value.services.map(raw => {
    if (!whmWebObject(raw) || typeof raw.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(raw.id) || seen.has(raw.id) || typeof raw.label !== 'string' || raw.label.length > 128 || /[\u0000-\u001f\u007f]/.test(raw.label) || raw.unit !== null && (typeof raw.unit !== 'string' || !/^[a-zA-Z0-9@_.-]{1,128}$/.test(raw.unit)) || typeof raw.state !== 'string' || !['active', 'inactive', 'failed', 'not-installed', 'unchecked'].includes(raw.state) || ['active', 'inactive', 'failed'].includes(raw.state) && raw.unit === null) throw new Error('invalid_service')
    seen.add(raw.id)
    return { id: raw.id, label: raw.label, unit: raw.unit as string | null, state: raw.state }
  })
}
export function readWhmWebSettings(value: unknown): WebValues {
  if (!whmWebObject(value) || !whmWebObject(value.settings)) throw new Error('invalid_saved_settings')
  const values: WebValues = {}
  for (const key of WHM_WEB_SETTING_FIELDS) {
    let current: unknown = value.settings
    for (const part of key.split('.')) current = whmWebObject(current) ? current[part] : undefined
    if (key === 'engine' ? !['apache', 'openlitespeed'].includes(String(current)) : key === 'apacheMpm' ? !['itk', 'prefork'].includes(String(current)) : key === 'nginx.multiAccept' ? typeof current !== 'boolean' : key === 'nginx.workerProcesses' && current === 'auto' ? false : typeof current !== 'number' || !Number.isSafeInteger(current) || current < (key === 'backendPort' || key === 'backendTlsPort' ? 1 : 0) || current > (key === 'backendPort' || key === 'backendTlsPort' ? 65535 : Number.MAX_SAFE_INTEGER)) throw new Error('invalid_saved_setting')
    values[key] = current as string | number | boolean
  }
  return values
}
export function buildWhmWebRollbackRequest(current: WhmWebGeneration, target: WhmWebGeneration, desiredState: WhmWebDesiredState, confirmation: unknown): { expectedCurrentGenerationId: number; expectedCurrentStateRevision: number; expectedTargetChecksum: string; confirmation: string } {
  const selected = readWhmWebGeneration(target), active = readWhmWebGeneration(current)
  if (active.status !== 'active' || selected.status !== 'superseded' || selected.id === active.id || confirmation !== String(selected.id)) throw new Error('invalid_rollback_confirmation')
  if (!whmWebObject(desiredState) || typeof desiredState.revision !== 'number' || !Number.isSafeInteger(desiredState.revision) || desiredState.revision < 0 || typeof desiredState.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(desiredState.checksum) || desiredState.pending !== false) throw new Error('unreviewed_desired_state')
  return { expectedCurrentGenerationId: active.id, expectedCurrentStateRevision: desiredState.revision, expectedTargetChecksum: selected.checksum, confirmation: String(selected.id) }
}
export function readWhmWebRollbackAck(value: unknown, target: WhmWebGeneration): WhmWebGeneration {
  if (!whmWebObject(value) || value.status !== 'applied' || value.rollbackTargetGenerationId !== target.id || value.rollbackTargetChecksum !== target.checksum) throw new Error('unverified_rollback')
  const details = whmWebObject(value.details) ? value.details : {}
  if ([value, details].some(part => part.unknownOutcome === true || part.verificationRequired === true || part.needsAttention === true)) throw new Error('unverified_rollback')
  const generation = readWhmWebGeneration(value.generation)
  if (generation.status !== 'active') throw new Error('unverified_rollback')
  return generation
}

function bindWhmWebServer(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-web-readback]').forEach(root => {
    if (root.dataset.webBound === 'true') return
    root.dataset.webBound = 'true'
    const page = root.closest<HTMLElement>('[data-whm-detail-route="/whm/services/web"]')
    const status = root.querySelector<HTMLElement>('[data-whm-web-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-whm-web-refresh]')
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!page || !status || !refresh) return
    const form = page.querySelector<HTMLFormElement>('[data-server-settings-form]')
    const targetSelect = page.querySelector<HTMLSelectElement>('[data-whm-web-generation]')
    const restore = page.querySelector<HTMLButtonElement>('[data-whm-web-rollback]')
    const discardButton = page.querySelector<HTMLButtonElement>('[data-whm-detail-section="web-pending"] button')
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = () => root.isConnected && root.dataset.webCanRead === 'true' && !root.closest(denied)
    const rollbackAdmitted = () => admitted() && root.dataset.webCanRollback === 'true' && generations.canRollback && generations.desiredState?.pending === false
    let busy = false, loaded = false, review = false, queuedRead = false, saved: WebValues | null = null
    let generations: WhmWebGenerationRead = { generations: [], currentGeneration: null, desiredState: null, canRollback: false, rollbackEligibleGenerationIds: [] }
    const priorDisabled = new Map<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement, boolean>()
    const formControls = () => [...(form?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button') ?? [])]
    const lockForm = (): void => { for (const control of formControls()) { if (!priorDisabled.has(control)) priorDisabled.set(control, control.disabled); control.disabled = true } }
    const unlockForm = (): void => { if (review) return; for (const [control, disabled] of priorDisabled) control.disabled = disabled; priorDisabled.clear() }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const control = (key: string) => [...(form?.elements ?? [])].find(element => (element as HTMLInputElement).name === key) as HTMLInputElement | HTMLSelectElement | undefined
    const draft = (): WebValues => {
      const result: WebValues = {}
      for (const key of WHM_WEB_SETTING_FIELDS) { const element = control(key); if (element) result[key] = element instanceof HTMLInputElement && element.type === 'checkbox' ? element.checked : element.value }
      return result
    }
    const different = () => { const current = draft(); return saved ? Object.keys(current).filter(key => String(current[key]) !== String(saved![key])) : [] }
    const sync = (): void => {
      refresh.disabled = busy || !admitted()
      if (targetSelect) targetSelect.disabled = busy || review || !loaded || !admitted()
      if (restore) restore.disabled = busy || review || !loaded || !rollbackAdmitted() || !targetSelect?.value || !generations.currentGeneration || !generations.rollbackEligibleGenerationIds.includes(Number(targetSelect.value))
      if (discardButton) discardButton.disabled = busy || review || !saved || different().length === 0 || !admitted()
      root.setAttribute('aria-busy', String(busy))
    }
    const cell = (row: HTMLTableRowElement, value: string, technical = false): void => { const td = document.createElement('td'), content = document.createElement(technical ? 'bdi' : 'span'); if (technical) content.dir = 'ltr'; content.textContent = value; td.append(content); row.append(td) }
    const empty = (body: HTMLElement | null, count: number, message: string): void => { if (!body) return; body.textContent = ''; const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = count; td.textContent = message; row.append(td); body.append(row) }
    const preview = (): void => {
      const body = page.querySelector<HTMLElement>('[data-whm-detail-section="web-pending"] tbody'), current = draft(), keys = different()
      if (!body) { sync(); return }
      body.textContent = ''
      for (const key of keys) { const row = document.createElement('tr'), element = control(key), label = element && [...(form?.querySelectorAll<HTMLLabelElement>('label') ?? [])].find(item => item.htmlFor === element.id)?.textContent; cell(row, label?.trim() || key); cell(row, String(saved![key]), true); cell(row, String(current[key]), true); cell(row, t('Draft only')); body.append(row) }
      if (!keys.length) empty(body, 4, saved ? t('No draft differences from the last saved-settings read.') : t('Saved settings have not been read.'))
      sync()
    }
    const paintGenerations = (value: WhmWebGenerationRead): void => {
      generations = value
      const admission = page.querySelector<HTMLElement>('[data-whm-web-rollback-admission]')
      if (admission) admission.textContent = rollbackAdmitted() ? t('Restore requires fresh current/target checks, the current desired-state revision and typing the persisted target generation number. Saved pending changes prevent restoration.') : value.desiredState?.pending ? t('Saved desired changes differ from the active snapshot. Restoration is blocked to preserve them.') : t('Guarded restore admission or authoritative desired-state metadata is unavailable. History remains readable.')
      const current = root.querySelector<HTMLElement>('[data-whm-web-current]')
      if (current) current.textContent = value.currentGeneration ? String(value.currentGeneration.id) : t('Not read')
      if (targetSelect) {
        const previous = targetSelect.value; targetSelect.textContent = ''
        for (const generation of value.generations.filter(item => item.status === 'superseded' && item.id !== value.currentGeneration?.id)) { const option = document.createElement('option'); option.value = String(generation.id); option.textContent = t('Generation {id}', { id: generation.id }); targetSelect.append(option) }
        if ([...targetSelect.options].some(option => option.value === previous)) targetSelect.value = previous
      }
      const body = page.querySelector<HTMLElement>('[data-whm-detail-section="web-generations"] tbody')
      if (body) { body.textContent = ''; for (const generation of value.generations) { const row = document.createElement('tr'); cell(row, String(generation.id), true); cell(row, formatDisplayDateTime(generation.createdAt), true); cell(row, generation.status); cell(row, generation.filesCount === undefined ? t('Not read') : String(generation.filesCount), true); body.append(row) }; if (!value.generations.length) empty(body, 4, t('The generation read returned no records.')) }
    }
    const paintServices = (services: WhmWebService[]): void => {
      const body = root.querySelector<HTMLElement>('[data-whm-web-services]')
      if (!body) return
      body.textContent = ''
      const names: Record<string, string> = { active: t(msgctxt('whm-web-server-client', 'Active')), inactive: t('Inactive'), failed: t(msgctxt('whm-web-server-client', 'Failed')), 'not-installed': t('Not installed'), unchecked: t('Not read') }
      for (const service of services.filter(item => ['nginx', 'apache', 'php-fpm', 'openlitespeed'].includes(item.id))) { const row = document.createElement('tr'); cell(row, service.label); cell(row, service.unit ?? (service.state === 'not-installed' ? t('Not installed') : t('Not read')), true); cell(row, names[service.state]!); body.append(row) }
      if (!body.childElementCount) empty(body, 3, t('No web-service observation was returned. Availability is not assumed.'))
    }
    const load = async (explicit = false): Promise<void> => {
      if (busy || !admitted() || !request) return
      if (review) {
        if (!explicit || !askDialog || await askDialog({ title: t('Review the current server state?'), body: t('Read saved settings, services and generations. No previous restore request is retried and your settings draft is kept.'), confirm: t('Read and review') }) !== true) return
      }
      if (busy || !admitted()) return
      busy = true; sync(); note('reading', t('Reading saved settings and observed server state…'))
      const results = await Promise.allSettled([request('GET', '/api/server/settings').then(readWhmWebSettings), request('GET', '/api/server/services').then(readWhmWebServices), request('GET', '/api/generations').then(readWhmWebGenerations)])
      if (admitted()) {
        const [settings, services, history] = results
        if (settings.status === 'fulfilled') { saved = settings.value; const engine = root.querySelector<HTMLElement>('[data-whm-web-engine]'); if (engine) engine.textContent = String(saved.engine) }
        if (services.status === 'fulfilled') paintServices(services.value)
        if (history.status === 'fulfilled') paintGenerations(history.value)
        loaded = results.every(item => item.status === 'fulfilled')
        if (loaded && explicit) review = false
        note(loaded ? 'read' : 'failed', loaded ? t('Saved settings, service observations and generations read. Serving, tenant identity and application health remain unverified.') : t('Some reads failed. Retained values are from their last successful read; a restore stays unavailable.'))
        preview()
      }
      busy = false; unlockForm(); sync()
      if (queuedRead && !review) { queuedRead = false; void load() }
    }
    const discard = async (): Promise<void> => {
      if (busy || review || !saved || !form || form.getAttribute('aria-busy') === 'true' || !admitted() || !askDialog || !request) return
      busy = true; lockForm(); sync()
      try {
        if (await askDialog({ title: t('Discard the settings draft?'), body: t('Read the current saved settings and replace this unsaved draft. No host change is sent.'), confirm: t('Discard and read'), danger: true }) !== true || !admitted()) return
        const observed = readWhmWebSettings(await request('GET', '/api/server/settings'))
        for (const key of WHM_WEB_SETTING_FIELDS) { const element = control(key); if (element) { if (element instanceof HTMLInputElement && element.type === 'checkbox') element.checked = observed[key] === true; else element.value = String(observed[key]) } }
        saved = observed; preview(); note('read', t('The draft was replaced with freshly read saved settings. No host change was sent.'))
      } catch { note('failed', t('Saved settings could not be read. The draft is preserved.')) }
      finally { busy = false; unlockForm(); sync() }
    }
    const rollback = async (): Promise<void> => {
      if (busy || review || !loaded || !rollbackAdmitted() || !restore || restore.disabled || !targetSelect || !generations.currentGeneration || !request || form?.getAttribute('aria-busy') === 'true') return
      const target = generations.generations.find(item => String(item.id) === targetSelect.value), current = generations.currentGeneration, desiredState = generations.desiredState
      if (!target || !desiredState || !askDialog) { note('failed', t('A verified target, desired state and confirmation are required; nothing was sent.')); return }
      busy = true; lockForm(); sync(); let wrote = false
      try {
        const confirmation = await askDialog({ title: t('Restore a server generation'), body: t('This restores a server-wide desired-state snapshot and reconciles it. Review all affected accounts. Type the persisted target generation number: {id}', { id: target.id }), input: true, label: t('Target generation number'), confirm: t('Restore generation'), danger: true })
        if (confirmation === null || confirmation === false || confirmation === undefined) return
        const body = buildWhmWebRollbackRequest(current, target, desiredState, confirmation)
        if (!rollbackAdmitted()) throw { status: 403, details: { stateChanged: false } }
        const fresh = readWhmWebGenerations(await request('GET', '/api/generations'))
        const freshTarget = fresh.generations.find(item => item.id === target.id)
        if (!fresh.canRollback || !fresh.rollbackEligibleGenerationIds.includes(target.id) || !fresh.desiredState || fresh.desiredState.pending || fresh.desiredState.revision !== desiredState.revision || fresh.desiredState.checksum !== desiredState.checksum || fresh.currentGeneration?.id !== current.id || fresh.currentGeneration.checksum !== current.checksum || !freshTarget || freshTarget.checksum !== target.checksum || freshTarget.status !== 'superseded') { review = true; note('stale', t('Current state, admission or the target changed. Saved changes are preserved; read and review before restoring.')); return }
        wrote = true
        const acknowledged = readWhmWebRollbackAck(await request('POST', '/api/generations/' + String(target.id) + '/rollback', body), target)
        const results = await Promise.allSettled([request('GET', '/api/generations').then(readWhmWebGenerations), request('GET', '/api/server/settings').then(readWhmWebSettings), request('GET', '/api/server/services').then(readWhmWebServices)])
        const [history, settings, services] = results
        if (history.status !== 'fulfilled' || settings.status !== 'fulfilled' || services.status !== 'fulfilled') throw new Error('rollback_readback_unavailable')
        const observed = history.value
        if (observed.currentGeneration?.id !== acknowledged.id || observed.currentGeneration.checksum !== acknowledged.checksum || !observed.desiredState || observed.desiredState.pending || observed.desiredState.revision < desiredState.revision) throw new Error('rollback_readback_mismatch')
        paintGenerations(observed); saved = settings.value; paintServices(services.value); loaded = true
        const engine = root.querySelector<HTMLElement>('[data-whm-web-engine]'); if (engine) engine.textContent = String(saved.engine)
        preview()
        note('restored', t('The requested snapshot restore was acknowledged and its resulting active generation was read back. Application health is not verified here.'))
      } catch (error) {
        const value = whmWebObject(error) ? error : {}, details = whmWebObject(value.details) ? value.details : {}
        const uncertain = wrote && ([value, details].some(part => part.unknownOutcome === true || part.verificationRequired === true || part.needsAttention === true || part.stateChanged === true) || !(details.stateChanged === false || typeof value.status === 'number' && value.status >= 400 && value.status < 500 && value.status !== 408))
        review = uncertain || value.status === 409
        note(review ? 'uncertain' : 'failed', review ? t('The restore outcome requires review. No retry was sent; read current state before continuing.') : t('Restore was refused or confirmation did not match. No automatic retry was sent.'))
      } finally { busy = false; unlockForm(); sync() }
    }
    if (!request || !admitted()) { refresh.disabled = true; if (restore) restore.disabled = true; if (targetSelect) targetSelect.disabled = true; note('unavailable', t('Server state is unavailable here. Nothing was read or changed.')); return }
    form?.addEventListener('input', preview); form?.addEventListener('change', preview)
    discardButton?.addEventListener('click', () => { void discard() })
    refresh.addEventListener('click', () => { void load(true) })
    targetSelect?.addEventListener('change', sync)
    restore?.addEventListener('click', () => { void rollback() })
    window.addEventListener('xpanel:workspace-stored', event => { if (event instanceof CustomEvent && whmWebObject(event.detail) && event.detail.form === 'server-settings' && !review) { if (busy) queuedRead = true; else void load() } })
    void load()
  })
}

export const WHM_WEB_SERVER_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const WHM_WEB_SETTING_FIELDS=${JSON.stringify([...WHM_WEB_SETTING_FIELDS])};const whmWebObject=${whmWebObject.toString()};const readWhmWebGeneration=${readWhmWebGeneration.toString()};const readWhmWebGenerations=${readWhmWebGenerations.toString()};const readWhmWebServices=${readWhmWebServices.toString()};const readWhmWebSettings=${readWhmWebSettings.toString()};const buildWhmWebRollbackRequest=${buildWhmWebRollbackRequest.toString()};const readWhmWebRollbackAck=${readWhmWebRollbackAck.toString()};return ${bindWhmWebServer.toString()};})()`
