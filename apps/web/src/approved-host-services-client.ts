import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
type ConfirmRestart = (options: Record<string, unknown>) => Promise<string | boolean | null>
type HostRow = { id: string; label: string; unit: string | null; state: string }

function bindApprovedHostServices(confirmRestart?: ConfirmRestart): void {
  const root = document.querySelector<HTMLElement>('[data-host-services]')
  const unavailable = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  if (!root || root.dataset.serviceBinding === 'true' || root.closest(unavailable)) return
  const rows = root.querySelector<HTMLElement>('[data-host-service-rows]')
  const status = root.querySelector<HTMLElement>('[data-host-service-status]')
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  if (!rows || !status || typeof request !== 'function') return
  root.dataset.serviceBinding = 'true'
  const copy = (message: string, values?: MessageValues) => xpT(message, values)
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
  const parseRows = (value: unknown): HostRow[] => {
    if (!record(value) || !Array.isArray(value.services)) throw new Error('unread')
    const seen = new Set<string>()
    return value.services.map(row => {
      if (!record(row) || typeof row.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(row.id) || seen.has(row.id) || typeof row.label !== 'string' || (row.unit !== null && typeof row.unit !== 'string') || typeof row.state !== 'string' || !['active', 'inactive', 'failed', 'not-installed', 'unchecked'].includes(row.state)) throw new Error('unread')
      seen.add(row.id)
      return { id: row.id, label: row.label, unit: row.unit, state: row.state }
    })
  }
  const note = (message: string, state: string) => {
    status.textContent = message; status.hidden = false; status.dataset.state = state
    status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status')
  }
  const definiteRefusal = (error: unknown): boolean => {
    if (!record(error)) return false
    const details = record(error.details) ? error.details : {}
    if ([error, details].some(value => value.stateChanged === true || value.verificationRequired === true || value.unknownOutcome === true || value.needsAttention === true)) return false
    return details.stateChanged === false || (typeof error.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 408)
  }
  let busy = false
  const review = new Set<string>()
  const lockButtons = () => rows.querySelectorAll<HTMLButtonElement>('button[data-service-id]').forEach(button => { button.disabled = busy || review.has(button.dataset.serviceId ?? '') })
  const paint = (services: HostRow[]) => {
    rows.replaceChildren()
    services.forEach(service => {
      const row = document.createElement('tr')
      for (const value of [service.label, service.unit || copy('Not installed'), service.state]) {
        const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell)
      }
      const action = document.createElement('td')
      if (service.unit) {
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'xp-btn'; button.dataset.serviceId = service.id
        button.textContent = copy('Restart')
        button.addEventListener('click', async () => {
          if (busy || review.has(service.id) || button.disabled || root.closest(unavailable)) return
          if (typeof confirmRestart !== 'function') { note(copy('Restart confirmation is unavailable. No restart was sent.'), 'failed'); return }
          busy = true; lockButtons()
          let mutationStarted = false, verificationPending = false
          try {
            const confirmed = await confirmRestart({ title: copy('Restart service'), body: copy('Restart this service? Active connections may be interrupted: {service}', { service: service.label }), confirm: copy('Restart'), danger: true })
            if (!confirmed) { note(copy('Restart cancelled. No restart request was sent.'), 'cancelled'); return }
            note(copy('Restarting the selected service…'), 'pending')
            mutationStarted = true
            const result = await request('POST', '/api/server/services/' + service.id + '/restart', {})
            verificationPending = true
            if (!record(result) || !record(result.service) || result.service.id !== service.id || typeof result.service.unit !== 'string' || !result.service.unit || result.service.state !== 'active') throw new Error('unverified')
            const services = parseRows(await request('GET', '/api/server/services'))
            const observed = services.find(item => item.id === service.id)
            if (!observed?.unit || observed.state !== 'active') throw new Error('unverified')
            paint(services)
            note(copy('The restart completed and the service was read back as active.'), 'active')
          } catch (error) {
            const uncertain = mutationStarted && (verificationPending || !definiteRefusal(error))
            if (uncertain) review.add(service.id)
            note(uncertain ? copy('The restart outcome is unverified. Inspect the service before retrying.') : copy('The restart was refused or could not be prepared. No automatic retry was sent.'), uncertain ? 'uncertain' : 'failed')
          } finally { busy = false; lockButtons() }
        })
        action.appendChild(button)
      }
      row.appendChild(action); rows.appendChild(row)
    })
    lockButtons()
  }
  request('GET', '/api/server/services').then(value => {
    const services = parseRows(value)
    paint(services)
    if (!services.length) note(copy('No services were reported by the host.'), 'empty')
  }).catch(() => { rows.replaceChildren(); note(copy('Service status could not be read.'), 'failed') })
}

export const APPROVED_HOST_SERVICES_CLIENT = bindApprovedHostServices.toString()
