/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime

export interface ForwarderConfiguration { id: string; sourceAddress: string; destinations: string[]; createdAt?: string }
export function forwarderConfigurationOnly(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const application = (value as Record<string, unknown>).application as Record<string, unknown> | undefined
  return application?.status === 'configuration_only' && application.nativeApplied === false
}
export function readForwarderConfigurations(value: unknown): ForwarderConfiguration[] {
  if (!forwarderConfigurationOnly(value)) throw new Error('unverified_configuration_state')
  const rows = (value as Record<string, unknown>).forwarders
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || !row.id || typeof row.sourceAddress !== 'string' || !Array.isArray(row.destinations) || !row.destinations.length || row.destinations.some((item: unknown) => typeof item !== 'string'))) throw new Error('invalid_forwarder_read')
  return rows.map(row => ({ id: row.id, sourceAddress: row.sourceAddress, destinations: [...row.destinations], ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}) }))
}
export function forwarderWriteUncertain(error: unknown): boolean {
  const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const details = failure.details && typeof failure.details === 'object' ? failure.details as Record<string, unknown> : {}
  if (['verificationRequired', 'stateChanged', 'unknownOutcome', 'needsAttention'].some(key => failure[key] === true || details[key] === true)) return true
  return !(details.stateChanged === false || (typeof failure.status === 'number' && failure.status >= 400 && failure.status < 500 && failure.status !== 408))
}

function bindAccountForwarders(askDialog?: (options: Record<string, unknown>) => Promise<string | boolean | null>): void {
  document.querySelectorAll<HTMLElement>('[data-forwarder-workspace]').forEach(root => {
    if (root.dataset.forwarderBound === 'true') return
    root.dataset.forwarderBound = 'true'
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const copy = (message: string, values?: MessageValues) => xpT(message, values)
    const status = root.querySelector<HTMLElement>('[data-forwarder-status]')
    const rows = root.querySelector<HTMLTableSectionElement>('[data-forwarder-rows]')
    const empty = root.querySelector<HTMLElement>('[data-forwarder-empty]')
    const form = root.querySelector<HTMLFormElement>('[data-forwarder-create]')
    const refresh = root.querySelector<HTMLButtonElement>('[data-forwarder-refresh]')
    let busy = false, reviewRequired = false, hasRead = false
    const canManage = root.dataset.forwarderManage === 'true'
    const unavailable = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const note = (text: string, state: string) => { if (status) { status.textContent = text; status.dataset.state = state; status.setAttribute('role', state === 'uncertain' || state === 'failed' ? 'alert' : 'status') } }
    const controls = () => {
      root.setAttribute('aria-busy', String(busy))
      root.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = Boolean(root.closest(unavailable)) || busy || (button !== refresh && (!canManage || !hasRead || reviewRequired)) })
      form?.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.readOnly = busy })
    }
    const paint = (items: ForwarderConfiguration[]) => {
      if (!rows) return
      rows.textContent = ''
      for (const item of items) {
        const row = document.createElement('tr')
        for (const values of [[item.sourceAddress], item.destinations]) {
          const cell = document.createElement('td')
          values.forEach((value, index) => { if (index) cell.appendChild(document.createElement('br')); const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.className = 'xp-mono'; bdi.textContent = value; cell.appendChild(bdi) })
          row.appendChild(cell)
        }
        const created = document.createElement('td'); const date = document.createElement('bdi'); date.dir = 'ltr'; date.className = 'xp-mono'; date.textContent = item.createdAt === undefined ? copy(msgctxt('account-forwarders-client', 'Not read')) : displayDateTime(item.createdAt); created.appendChild(date); row.appendChild(created)
        const state = document.createElement('td'); state.textContent = copy('Configuration only'); row.appendChild(state)
        const action = document.createElement('td')
        if (canManage) { const button = document.createElement('button'); button.type = 'button'; button.className = 'xp-btn'; button.dataset.forwarderDelete = item.id; button.dataset.forwarderSource = item.sourceAddress; button.textContent = copy('Remove configuration'); action.appendChild(button) }
        else action.textContent = copy(msgctxt('account-forwarders-client', 'Read only'))
        row.appendChild(action); rows.appendChild(row)
      }
      if (empty) { empty.hidden = items.length > 0; empty.textContent = copy('No saved records.') }
    }
    const read = async () => {
      if (!request) throw new Error('transport_unavailable')
      const items = readForwarderConfigurations(await request('GET', '/api/mail/forwarders'))
      paint(items); hasRead = true
      return items
    }
    const load = async () => {
      if (busy || root.closest(unavailable)) return
      busy = true; controls(); note(copy('Reading saved configuration…'), 'pending')
      try { await read(); reviewRequired = false; note(copy('Saved records read. Native forwarding has not been applied.'), 'read') }
      catch { hasRead = false; note(copy('Records could not be read. Editing is unavailable.'), 'failed') }
      finally { busy = false; controls() }
    }
    const mutate = async (method: 'POST' | 'DELETE', path: string, body: unknown) => {
      if (!request || busy || !canManage || !hasRead || reviewRequired || root.closest(unavailable)) return
      busy = true; controls(); note(copy('Saving configuration…'), 'pending')
      let acknowledged = false
      try {
        const result = await request(method, path, body)
        if (!forwarderConfigurationOnly(result)) throw new Error('unverified_configuration_state')
        acknowledged = true
        const items = await read()
        if (method === 'DELETE' && items.some(item => path.endsWith('/' + encodeURIComponent(item.id)))) throw new Error('removal_not_observed')
        if (method === 'POST') {
          const wanted = body as { sourceAddress: string; destinations: string[]; createdAt?: string }
          if (!items.some(item => item.sourceAddress === wanted.sourceAddress && item.destinations.length === wanted.destinations.length && wanted.destinations.every(address => item.destinations.includes(address)))) throw new Error('save_not_observed')
          form?.reset()
        }
        note(copy('Configuration saved and read back. Native forwarding has not been applied.'), 'saved')
      } catch (error) {
        reviewRequired = acknowledged || forwarderWriteUncertain(error)
        note(reviewRequired ? copy('The saved state is uncertain. Refresh and review records before another change. Your input is kept.') : copy('The request was refused. Your input is kept.'), reviewRequired ? 'uncertain' : 'failed')
      } finally { busy = false; controls() }
    }
    refresh?.addEventListener('click', () => { void load() })
    form?.addEventListener('submit', event => {
      event.preventDefault()
      if (!form.reportValidity()) return
      const source = form.elements.namedItem('source') as HTMLInputElement
      const destinations = form.elements.namedItem('destinations') as HTMLInputElement
      const values = [...new Set(destinations.value.split(',').map(value => value.trim().toLowerCase()).filter(Boolean))]
      void mutate('POST', '/api/mail/forwarders', { sourceAddress: source.value.trim().toLowerCase(), destinations: values })
    })
    root.addEventListener('click', async event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-forwarder-delete]') : null
      if (!button || button.disabled || !root.contains(button) || busy || reviewRequired || !canManage) return
      const message = copy('Remove this saved forwarding configuration? Native mail service settings will not change.') + '\n' + (button.dataset.forwarderSource ?? '')
      const accepted = askDialog ? await askDialog({ title: copy('Remove configuration'), body: message, confirm: copy('Remove configuration'), danger: true }) : window.confirm(message)
      if (accepted !== true) return
      void mutate('DELETE', '/api/mail/forwarders/' + encodeURIComponent(button.dataset.forwarderDelete ?? ''), {})
    })
    controls(); void load()
  })
}

export const ACCOUNT_FORWARDERS_CLIENT_BINDING = `(function(askDialog) { const displayDateTime=${DISPLAY_DATETIME_BINDING};${forwarderConfigurationOnly.toString()}; ${readForwarderConfigurations.toString()}; ${forwarderWriteUncertain.toString()}; (${bindAccountForwarders.toString()})(askDialog); })`
