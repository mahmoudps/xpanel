import type { MessageValues } from './i18n.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
import { serviceArea as canonicalServiceArea } from './service-area.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction
const serviceArea = canonicalServiceArea
/// <reference lib="dom" />
type ConfirmRestart = (options: Record<string, unknown>) => Promise<string | boolean | null>
type FpmVersion = { version: string; masters: number; running: number; failed: number }
type HostRow = { id: string; label: string; unit: string | null; state: string; fpm: FpmVersion | null }

function bindApprovedHostServices(confirmRestart?: ConfirmRestart): void {
  document.querySelectorAll<HTMLElement>('[data-host-services]').forEach(root => {
    if (root.dataset.serviceBinding === 'true') return
    const own = <T extends HTMLElement>(selector: string): T | null => {
      const nodes = [...root.querySelectorAll<T>(selector)].filter(node => node.closest('[data-host-services]') === root)
      return nodes.length === 1 ? nodes[0]! : null
    }
    const rows = own<HTMLElement>('[data-host-service-rows]'), status = own<HTMLElement>('[data-host-service-status]')
    if (!rows || !status) return
    root.dataset.serviceBinding = 'true'
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const unavailable = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = () => typeof request === 'function' && root.isConnected && root.dataset.hostCanRead !== 'false' && !root.closest(unavailable)
    const copy = (message: string, values?: MessageValues) => xpT(message, values)
    const unread = () => copy('Not read')
    const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
    const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    const parseFpm = (row: Record<string, unknown>): FpmVersion | null => {
      if (row.fpm === undefined) return null
      const fpm = row.fpm
      // The agent derives a version row's state from its master counts; a row where they disagree is not shown.
      if (!record(fpm) || typeof fpm.version !== 'string' || !/^[0-9]\.[0-9]$/.test(fpm.version) || row.id !== 'php-fpm-' + fpm.version.replace('.', '') || row.unit !== null
        || !count(fpm.masters) || !count(fpm.running) || !count(fpm.failed) || fpm.running + fpm.failed > fpm.masters
        || row.state !== (fpm.masters > 0 && fpm.running === fpm.masters ? 'active' : fpm.failed > 0 ? 'failed' : 'inactive')) throw new Error('unread')
      return { version: fpm.version, masters: fpm.masters, running: fpm.running, failed: fpm.failed }
    }
    const parseRows = (value: unknown): HostRow[] => {
      if (!record(value) || !Array.isArray(value.services)) throw new Error('unread')
      const seen = new Set<string>()
      return value.services.map(row => {
        if (!record(row) || typeof row.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(row.id) || seen.has(row.id) || typeof row.label !== 'string' || (row.unit !== null && typeof row.unit !== 'string') || typeof row.state !== 'string' || !['active', 'inactive', 'failed', 'not-installed', 'unchecked'].includes(row.state)) throw new Error('unread')
        seen.add(row.id)
        return { id: row.id, label: row.label, unit: row.unit, state: row.state, fpm: parseFpm(row) }
      })
    }
    const fpmState = (fpm: FpmVersion): string => fpm.masters === 0 ? copy('No account masters')
      : fpm.running === fpm.masters ? copy('Running: {running} of {total} masters', { running: fpm.running, total: fpm.masters })
      : fpm.failed === fpm.masters ? copy('Failed: {failed} of {total} masters', { failed: fpm.failed, total: fpm.masters })
      : fpm.failed > 0 ? copy('Partly failed: {failed} of {total} masters failed', { failed: fpm.failed, total: fpm.masters })
      : copy('Stopped: {stopped} of {total} masters', { stopped: fpm.masters - fpm.running, total: fpm.masters })
    const note = (message: string, state: string) => {
      status.textContent = message; status.hidden = false; status.dataset.state = state
      status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status')
    }
    type Facts = { role: string; version: string; memory: string; boot: string }
    const snapshots = new Map<string, Facts[]>(), initial = [...rows.querySelectorAll<HTMLElement>('[data-service-snapshot]')]
    for (const row of initial) {
      const unit = row.dataset.serviceUnit
      if (!unit) continue
      const value = { role: row.dataset.healthRole || unread(), version: row.dataset.healthVersion || unread(), memory: row.dataset.healthMemory || unread(), boot: row.dataset.healthBoot || unread() }
      snapshots.set(unit, [...(snapshots.get(unit) ?? []), value])
    }
    let busy = false, quarantined = false, selected: string | null = null, area = ''
    const review = new Set<string>()
    const search = own<HTMLInputElement>('[data-host-service-search]')
    const displayed = () => [...rows.querySelectorAll<HTMLElement>('[data-service-key]')]
    const showSelection = () => {
      const row = displayed().find(item => item.dataset.serviceKey === selected)
      rows.querySelectorAll<HTMLButtonElement>('[data-service-select]').forEach(button => button.setAttribute('aria-pressed', String(button.closest<HTMLElement>('[data-service-key]') === row)))
      const values: Record<string, string> = {
        name: row?.dataset.serviceLabel || copy('No service is selected.'), unit: row?.dataset.serviceUnit || unread(),
        state: row?.dataset.serviceState || unread(), role: row?.dataset.healthRole || unread(), version: row?.dataset.healthVersion || unread(),
        memory: row?.dataset.healthMemory || unread(), boot: row?.dataset.healthBoot || unread(), uptime: unread(), test: unread(),
      }
      root.querySelectorAll<HTMLElement>('[data-host-detail]').forEach(node => { if (node.closest('[data-host-services]') === root) node.textContent = values[node.dataset.hostDetail ?? ''] ?? unread() })
    }
    const filterRows = () => {
      const query = search?.value.trim().toLowerCase() ?? ''
      const list = displayed()
      for (const row of list) row.hidden = !!(area && row.dataset.serviceArea !== area) || !!(query && !((row.dataset.serviceUnit ?? '') + ' ' + (row.dataset.serviceLabel ?? '')).toLowerCase().includes(query))
      root.querySelectorAll<HTMLElement>('[data-service-area-count]').forEach(node => { const key = node.dataset.serviceAreaCount ?? ''; node.textContent = String(list.filter(row => !key || row.dataset.serviceArea === key).length) })
      const empty = rows.querySelector<HTMLElement>('[data-service-filter-empty]')
      if (empty) empty.hidden = list.some(row => !row.hidden)
    }
    root.querySelectorAll<HTMLButtonElement>('button[data-service-area]').forEach(button => {
      if (button.closest('[data-host-services]') !== root) return
      button.addEventListener('click', () => {
        area = button.dataset.serviceArea ?? ''
        root.querySelectorAll<HTMLButtonElement>('button[data-service-area]').forEach(item => item.setAttribute('aria-pressed', String(item === button)))
        filterRows()
      })
    })
    search?.addEventListener('input', filterRows)
    rows.addEventListener('click', event => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-service-select]')
      const row = button?.closest<HTMLElement>('[data-service-key]')
      if (!button || !row || !rows.contains(row)) return
      selected = row.dataset.serviceKey ?? null; showSelection()
    })
    const lockButtons = () => rows.querySelectorAll<HTMLButtonElement>('button[data-service-id]').forEach(button => { button.disabled = quarantined || busy || !admitted() || root.dataset.hostCanManage === 'false' || review.has(button.dataset.serviceId ?? '') })
    const values = { service: '', unit: '', state: '', role: '', version: '', uptime: '', memory: '', 'reload-label': '', 'restart-label': '' }
    const preflight = () => {
      if (quarantined) return false
      try {
        const example = cloneViewRecord(root, 'host-service-row', 'tr', values)
        viewAction(example, 'restart'); viewAction(example, 'select')
        cloneViewRecord(root, 'host-service-empty', 'tr', { message: '' })
        return true
      } catch { quarantined = true; lockButtons(); note(copy('Unavailable'), 'unavailable'); return false }
    }
    const definiteRefusal = (error: unknown): boolean => {
      if (!record(error)) return false
      const details = record(error.details) ? error.details : {}
      if ([error, details].some(value => value.stateChanged === true || value.verificationRequired === true || value.unknownOutcome === true || value.needsAttention === true)) return false
      return details.stateChanged === false || (typeof error.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 408)
    }
    const paint = (services: HostRow[]) => {
      if (!preflight()) return
      const unitCount = new Map<string, number>()
      for (const service of services) if (service.unit) unitCount.set(service.unit, (unitCount.get(service.unit) ?? 0) + 1)
      const nextRows = services.map(service => {
        const fpm = service.fpm
        const unique = !!service.unit && unitCount.get(service.unit) === 1
        const identityKnown = serviceArea(service.id, service.unit) !== 'unread'
        const source = unique && identityKnown && service.state !== 'unchecked' ? snapshots.get(service.unit!) : undefined
        const facts = fpm ? { role: fpm.masters === 0 ? copy('No account uses this PHP version') : copy('PHP pools: {count} account masters, each in its slice', { count: fpm.masters }), version: fpm.version, memory: unread(), boot: unread() }
          : source?.length === 1 ? source[0]! : { role: unread(), version: unread(), memory: unread(), boot: unread() }
        const knownState = identityKnown && (service.state === 'not-installed' ? service.unit === null : unique)
        const state = fpm && identityKnown ? fpmState(fpm) : !knownState ? unread() : service.state === 'active' ? copy('Running') : service.state === 'inactive' ? copy('Stopped') : service.state === 'failed' ? copy('Failed') : service.state === 'not-installed' ? copy('Not installed') : unread()
        // The systemd pattern that selects exactly this version's account masters.
        const unit = fpm ? 'xpanel-php-fpm-*-' + fpm.version + '.service' : service.unit
        const row = cloneViewRecord(root, 'host-service-row', 'tr', { service: service.label, unit: unit || unread(), state, role: facts.role, version: facts.version, uptime: unread(), memory: facts.memory, 'reload-label': copy('Reload'), 'restart-label': copy('Restart') })
        row.dataset.serviceKey = service.id; row.dataset.serviceLabel = service.label; row.dataset.serviceUnit = unit ?? ''; row.dataset.serviceState = state; row.dataset.serviceArea = serviceArea(service.id, service.unit)
        row.dataset.healthRole = facts.role; row.dataset.healthVersion = facts.version; row.dataset.healthMemory = facts.memory; row.dataset.healthBoot = facts.boot
        const select = viewAction(row, 'select'); select.dataset.serviceSelect = ''; select.setAttribute('aria-pressed', 'false')
        const detail = own<HTMLElement>('[data-host-service-details]'); if (detail?.id) select.setAttribute('aria-controls', detail.id)
        const button = viewAction(row, 'restart')
        if (fpm ? identityKnown && fpm.masters > 0 : service.unit && unique && identityKnown && service.state !== 'unchecked' && service.state !== 'not-installed') {
          button.dataset.serviceId = service.id
          button.addEventListener('click', async () => {
            if (busy || review.has(service.id) || button.disabled || !admitted() || root.dataset.hostCanManage === 'false' || !preflight()) return
            if (typeof confirmRestart !== 'function') { note(copy('Restart confirmation is unavailable. No restart was sent.'), 'failed'); return }
            busy = true; lockButtons()
            let mutationStarted = false, verificationPending = false
            try {
              const confirmed = await confirmRestart({ title: copy('Restart service'), body: fpm ? copy('Restart all {count} PHP-FPM {version} account masters? PHP requests in progress fail.', { count: fpm.masters, version: fpm.version }) : copy('Restart this service? Active connections may be interrupted: {service}', { service: service.label }), confirm: copy('Restart'), danger: true })
              if (!confirmed) { note(copy('Restart cancelled. No restart request was sent.'), 'cancelled'); return }
              if (!admitted() || !button.isConnected || root.dataset.hostCanManage === 'false' || !preflight()) return
              note(copy('Restarting the selected service…'), 'pending')
              mutationStarted = true
              const result = await request!('POST', '/api/server/services/' + service.id + '/restart', {})
              verificationPending = true
              if (service.unit) snapshots.delete(service.unit)
              if (!admitted() || !preflight()) { review.add(service.id); return }
              if (!record(result) || !record(result.service) || result.service.id !== service.id || result.service.unit !== service.unit || result.service.state !== 'active') throw new Error('unverified')
              const fresh = parseRows(await request!('GET', '/api/server/services'))
              if (!admitted() || !preflight()) { review.add(service.id); return }
              const observed = fresh.filter(item => item.id === service.id && item.unit === service.unit)
              if (observed.length !== 1 || observed[0]!.state !== 'active' || service.unit !== null && fresh.filter(item => item.unit === service.unit).length !== 1) throw new Error('unverified')
              paint(fresh)
              note(copy('The restart completed and the service was read back as active.'), 'active')
            } catch (error) {
              const uncertain = mutationStarted && (verificationPending || !definiteRefusal(error))
              if (uncertain) review.add(service.id)
              if (!quarantined) note(uncertain ? copy('The restart outcome is unverified. Inspect the service before retrying.') : copy('The restart was refused or could not be prepared. No automatic retry was sent.'), uncertain ? 'uncertain' : 'failed')
            } finally { busy = false; lockButtons() }
          })
        } else button.remove()
        return row
      })
      const empty = cloneViewRecord(root, 'host-service-empty', 'tr', { message: services.length ? copy('No services match these filters.') : copy('No services were reported by the host.') })
      empty.dataset.serviceFilterEmpty = ''; rows.replaceChildren(...nextRows, empty)
      lockButtons(); filterRows(); showSelection()
    }
    filterRows(); showSelection()
    if (!preflight() || !admitted()) { lockButtons(); return }
    request!('GET', '/api/server/services').then(value => {
      if (!admitted() || !preflight()) return
      const services = parseRows(value); paint(services)
      if (!services.length) note(copy('No services were reported by the host.'), 'empty')
    }).catch(() => { if (!quarantined) note(copy('Service status could not be read.'), 'failed'); lockButtons() })
  })
}

export const APPROVED_HOST_SERVICES_CLIENT = `(function(confirmRestart){${VIEW_RECORD_HELPERS}const serviceArea=${serviceArea.toString()};return (${bindApprovedHostServices.toString()})(confirmRestart);})`
