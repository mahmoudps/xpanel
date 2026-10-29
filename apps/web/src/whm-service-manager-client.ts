/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export interface ServiceManagerClientRow { unit: string; load: string | null; active: string | null; sub: string | null; boot: string | null; restart: boolean; bootEditable: boolean }
export interface ServiceManagerClientView { state: 'read' | 'unavailable'; observedAt: string; revision: string | null; bootTime: number | null; units: ServiceManagerClientRow[]; manage: boolean }

/** Self-contained projection; serialized with the binding and never trusts action flags on malformed rows. */
export function readServiceManagerView(value: unknown): ServiceManagerClientView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_service_manager_view') }
  const unit = (item: unknown): item is string => typeof item === 'string' && item.length <= 200 && /^[A-Za-z0-9](?:[A-Za-z0-9_.:@-]|\\x[0-9a-fA-F]{2})*\.service$/.test(item)
  const state = (item: unknown): item is string | null => item === null || typeof item === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item)
  if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || typeof value.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))
    || value.revision !== null && !(typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision)) || value.bootTime !== null && !(typeof value.bootTime === 'number' && Number.isSafeInteger(value.bootTime) && value.bootTime > 0 && value.bootTime < 8640000000000)
    || !Array.isArray(value.units) || value.units.length > 4096 || typeof value.manage !== 'boolean') return bad()
  const seen = new Set<string>(), bootUnits = ['atd.service', 'chrony.service', 'chronyd.service', 'memcached.service', 'rsyslog.service']
  const units = value.units.map(raw => {
    if (!object(raw) || !unit(raw.unit) || seen.has(raw.unit) || !state(raw.load) || !state(raw.active) || !state(raw.sub) || !state(raw.boot) || typeof raw.restart !== 'boolean' || typeof raw.bootEditable !== 'boolean') return bad()
    if ([raw.load, raw.active, raw.sub].some(item => item === null) && ![raw.load, raw.active, raw.sub].every(item => item === null)
      || raw.restart && !(raw.load === 'loaded' && /^(?:ssh|sshd|php-fpm|php(?:7\.4|8\.[0-4])-fpm)\.service$/.test(raw.unit))
      || raw.bootEditable && !(raw.load === 'loaded' && bootUnits.includes(raw.unit) && ['enabled', 'disabled'].includes(String(raw.boot)))) return bad()
    seen.add(raw.unit)
    return { unit: raw.unit, load: raw.load, active: raw.active, sub: raw.sub, boot: raw.boot, restart: raw.restart, bootEditable: raw.bootEditable }
  })
  if (value.state === 'read' && (value.revision === null || units.length === 0) || value.state === 'unavailable' && (value.revision !== null || units.length !== 0 || value.manage)) return bad()
  return { state: value.state as ServiceManagerClientView['state'], observedAt: value.observedAt, revision: value.revision as string | null, bootTime: value.bootTime as number | null, units, manage: value.manage }
}

export function readServiceManagerSubmission(value: unknown, action: string, unit: string | null): { job: { id: string; kind: string; status: string }; outcome: 'submitted' | 'attempted' } {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const outcome = action === 'reboot' ? 'attempted' : 'submitted'
  if (!object(value) || value.action !== action || value.unit !== unit || value.outcome !== outcome || value.verificationRequired !== true || !object(value.job)
    || typeof value.job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.job.id) || value.job.kind !== 'services.manager.' + action || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(value.job.status))) throw new Error('invalid_service_manager_submission')
  return { outcome, job: { id: value.job.id, kind: String(value.job.kind), status: String(value.job.status) } }
}

function bindWhmServiceManager(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-service-manager]').forEach(root => {
    if (root.dataset.smBound === 'true') return
    root.dataset.smBound = 'true'
    const q = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = q<HTMLElement>('[data-sm-status]'), result = q<HTMLElement>('[data-sm-result]'), refresh = q<HTMLButtonElement>('[data-sm-refresh]'), rows = q<HTMLElement>('[data-sm-rows]')
    const search = q<HTMLInputElement>('[data-sm-search]'), filter = q<HTMLSelectElement>('[data-sm-filter]'), confirmation = q<HTMLInputElement>('[data-sm-confirm]'), reboot = q<HTMLButtonElement>('[data-sm-reboot]'), jobNote = q<HTMLElement>('[data-sm-job]'), jobLink = q<HTMLAnchorElement>('[data-sm-job-link]')
    if (!status || !result || !refresh || !rows || !search || !filter || !confirmation || !reboot || !jobNote || !jobLink) return
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof request === 'function' && root.isConnected && root.dataset.smCanRead === 'true' && !root.closest(denied)
    let view: ServiceManagerClientView | null = null, busy = false, review = false, rebootBefore: number | null = null
    const manageable = (): boolean => admitted() && root.dataset.smCanManage === 'true' && view?.state === 'read' && view.manage && typeof askDialog === 'function' && !review
    const note = (state: string, text: string): void => { status.dataset.state = state; status.textContent = text }
    const outcome = (state: string, text: string): void => { result.dataset.state = state; result.textContent = text; result.hidden = false }
    const technical = (text: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = text; return bdi }
    const date = (seconds: number | null): string => seconds === null ? t('Unavailable') : formatDisplayDateTime(new Date(seconds * 1000))
    const controls = (): void => {
      refresh.disabled = busy || !admitted()
      search.disabled = busy || !admitted() || view?.state !== 'read'; filter.disabled = search.disabled
      confirmation.disabled = busy || !manageable() || view?.bootTime == null; reboot.disabled = confirmation.disabled || confirmation.value !== 'REBOOT SERVER'
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy || !manageable() })
    }
    const paint = (): void => {
      const fact = (key: string, value: string) => { const node = q<HTMLElement>('[data-sm-fact="' + key + '"]'); if (node) node.textContent = value }
      fact('services', view?.state === 'read' ? String(view.units.length) : t('Unavailable'))
      fact('active', view?.state === 'read' ? String(view.units.filter(row => row.active === 'active').length) : t('Unavailable'))
      fact('boot-time', date(view?.bootTime ?? null)); fact('observed-at', view ? formatDisplayDateTime(view.observedAt) : t('Unavailable'))
      rows.replaceChildren()
      const query = search.value.trim().toLowerCase()
      const visible = (view?.units ?? []).filter(row => row.unit.toLowerCase().includes(query) && (filter.value === 'active' ? row.active === 'active' : filter.value === 'attention' ? row.active === 'failed' || row.load !== 'loaded' : filter.value === 'editable' ? row.bootEditable : true))
      for (const row of visible) {
        const tr = document.createElement('tr')
        for (const value of [row.unit, row.load, row.active, row.sub, row.boot]) { const td = document.createElement('td'); td.append(value === null ? document.createTextNode(t('Not observed')) : technical(value)); tr.append(td) }
        const actions = document.createElement('td'), group = document.createElement('div'); group.className = 'xp-whm-service-manager__actions'
        const button = (action: string, label: string) => { const control = document.createElement('button'); control.type = 'button'; control.className = 'xp-btn'; control.dataset.smAction = action; control.dataset.smUnit = row.unit; control.textContent = label; control.disabled = true; group.append(control) }
        if (row.restart) button('restart', t(msgctxt('whm-service-manager-client', 'Restart')))
        if (row.bootEditable) button(row.boot === 'enabled' ? 'disable' : 'enable', row.boot === 'enabled' ? t('Disable at boot') : t('Enable at boot'))
        if (!row.restart && !row.bootEditable) group.textContent = t('Protected or not reviewed')
        actions.append(group); tr.append(actions); rows.append(tr)
      }
      if (!visible.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 6; td.textContent = view?.state === 'read' ? t('No services match these filters.') : t('No service state is available.'); tr.append(td); rows.append(tr) }
      controls()
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls(); note('reading', t('Reading system service state…'))
      try {
        const next = readServiceManagerView(await request!('GET', '/api/server/service-manager'))
        if (!admitted()) { view = null; return }
        view = next; review = false; result.hidden = true; jobNote.hidden = true; confirmation.value = ''
        note(next.state, next.state === 'read' ? t('Service state read from this host.') + (next.manage ? '' : ' ' + t('Host changes are unavailable.')) : t('System service state could not be verified. Actions are unavailable.'))
        if (rebootBefore !== null && next.bootTime !== null) {
          outcome(next.bootTime > rebootBefore ? 'verified' : 'unverified', next.bootTime > rebootBefore ? t('The observed server boot time changed after the reboot request.') : t('The observed server boot time has not changed. The reboot remains unverified.'))
          if (next.bootTime > rebootBefore) rebootBefore = null
        }
      } catch { view = null; note('failed', t('Service state could not be read. Refresh before submitting an action.')) }
      finally { busy = false; paint() }
    }
    const submit = async (action: 'restart' | 'enable' | 'disable' | 'reboot', unit: string | null): Promise<void> => {
      if (busy || !manageable() || !view?.revision || action === 'reboot' && (view.bootTime === null || confirmation.value !== 'REBOOT SERVER')) return
      const snapshot = view, selected = unit === null ? null : view.units.find(row => row.unit === unit)
      if (action !== 'reboot' && (!selected || (action === 'restart' ? !selected.restart : !selected.bootEditable || action !== (selected.boot === 'enabled' ? 'disable' : 'enable')))) return
      busy = true; controls()
      const title = action === 'reboot' ? t('Reboot server') : action === 'restart' ? t('Restart service') : action === 'enable' ? t('Enable service at boot') : t('Disable service at boot')
      const detail = action === 'reboot' ? t('Active sessions disconnect and services stop temporarily. Confirm the changed boot time after reconnecting.') : action === 'restart' && /^sshd?\.service$/.test(unit!) ? t('A failed SSH restart can prevent new logins. Configuration is tested first. Keep an alternate recovery connection available.') : action === 'restart' ? t('Configuration is tested first. The job confirms the service is active after restarting.') : t('This changes future boot behavior without starting or stopping the service now.')
      let approved = false
      try { approved = await askDialog!({ title, body: (unit ? unit + '\n' : '') + detail, confirm: t('Submit host job'), danger: action !== 'enable' }) === true } catch { approved = false }
      if (!approved || !manageable() || snapshot !== view || action === 'reboot' && confirmation.value !== 'REBOOT SERVER') { busy = false; controls(); return }
      note('submitting', t('Submitting the reviewed host action…'))
      try {
        const body = action === 'reboot' ? { action, confirmation: 'REBOOT SERVER', expectedRevision: snapshot.revision } : { action, unit, expectedRevision: snapshot.revision }
        const accepted = readServiceManagerSubmission(await request!('POST', '/api/server/service-manager/action', body), action, unit)
        review = true; if (action === 'reboot') rebootBefore = snapshot.bootTime
        jobLink.href = '/whm/jobs?job=' + encodeURIComponent(accepted.job.id); jobNote.hidden = false
        outcome(accepted.outcome, action === 'reboot' ? t('Reboot attempt submitted. Reconnect and read the server boot time; completion is not yet verified.') : t('Host job submitted. Review the job result and refresh service state before another action.'))
        note('submitted', t('Awaiting host-job verification.'))
      } catch (error) {
        const raw = error && typeof error === 'object' ? error as { status?: number; detail?: Record<string, unknown>; details?: Record<string, unknown> } : null
        const detail = raw?.details ?? raw?.detail
        const refused = detail?.stateChanged === false && detail?.unknownOutcome !== true && detail?.verificationRequired !== true
        review = !refused || raw?.status === 409
        jobLink.href = '/whm/jobs'; jobNote.hidden = refused
        outcome(refused ? 'refused' : 'unknown', refused ? raw?.status === 409 ? t('Service state changed. Refresh and review it before trying again.') : t('The host action was refused. Nothing was changed.') : t('The submission outcome is unknown. Review host jobs before retrying; actions stay locked until a fresh read.'))
      } finally { busy = false; controls() }
    }
    rows.addEventListener('click', event => { const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-sm-action]'); if (button && !button.disabled && rows.contains(button) && ['restart', 'enable', 'disable'].includes(button.dataset.smAction ?? '')) void submit(button.dataset.smAction as 'restart' | 'enable' | 'disable', button.dataset.smUnit ?? '') })
    search.addEventListener('input', paint); filter.addEventListener('change', paint); confirmation.addEventListener('input', controls); refresh.addEventListener('click', () => { void load() }); reboot.addEventListener('click', () => { void submit('reboot', null) })
    if (!admitted()) { controls(); note('unavailable', t('The service manager is unavailable here. Nothing was read or changed.')); return }
    void load()
  })
}

export const WHM_SERVICE_MANAGER_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readServiceManagerView=${readServiceManagerView.toString()};const readServiceManagerSubmission=${readServiceManagerSubmission.toString()};return ${bindWhmServiceManager.toString()};})()`
