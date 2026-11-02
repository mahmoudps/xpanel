/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction

export type EndpointView = { id: string; url: string; events: string[]; active: boolean; secretPresent: boolean }
export type DeliveryView = { id: string; endpointId: string; event: string; createdAt: string; state: string; attempts: number; lastStatus: number | null }
export type IntegrationsView = {
  endpoints: EndpointView[]; events: string[]; signatureScheme: string; secretsLocation: string; savedRevision: string; activeRevision: string; invalid: boolean
  egress: { state: 'available' | 'unavailable'; reason: string | null }; deliveries: DeliveryView[]
}

export function readIntegrationsView(value: unknown): IntegrationsView {
  const WEBHOOK_EVENTS = ['account.created', 'account.suspended', 'account.deleted', 'backup.completed', 'ssl.renewed', 'job.failed']
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const hash = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const endpoint = (raw: unknown): EndpointView => {
    if (!object(raw) || typeof raw.id !== 'string' || !/^whk_[0-9a-f]{16}$/.test(raw.id) || typeof raw.url !== 'string' || !/^https:\/\//.test(raw.url) || raw.url.length > 2048 || typeof raw.active !== 'boolean' || typeof raw.secretPresent !== 'boolean'
      || !Array.isArray(raw.events) || raw.events.length < 1 || raw.events.length > WEBHOOK_EVENTS.length || !raw.events.every(event => WEBHOOK_EVENTS.includes(String(event)))) throw new Error('invalid_endpoint')
    return { id: raw.id, url: raw.url, events: raw.events as string[], active: raw.active, secretPresent: raw.secretPresent }
  }
  const delivery = (raw: unknown): DeliveryView => {
    if (!object(raw) || typeof raw.id !== 'string' || raw.id.length > 64 || typeof raw.endpointId !== 'string' || !/^whk_[0-9a-f]{16}$/.test(raw.endpointId) || !WEBHOOK_EVENTS.includes(String(raw.event)) || typeof raw.createdAt !== 'string'
      || !['delivered', 'failed', 'exhausted'].includes(String(raw.state)) || !Number.isInteger(raw.attempts) || (raw.lastStatus !== null && (!Number.isInteger(raw.lastStatus) || (raw.lastStatus as number) < 100 || (raw.lastStatus as number) > 599))) throw new Error('invalid_delivery')
    return { id: raw.id, endpointId: raw.endpointId, event: raw.event as string, createdAt: raw.createdAt, state: raw.state as string, attempts: raw.attempts as number, lastStatus: raw.lastStatus as number | null }
  }
  if (!object(value) || !Array.isArray(value.endpoints) || value.endpoints.length > 50 || !Array.isArray(value.events) || !hash(value.savedRevision) || !hash(value.activeRevision) || typeof value.invalid !== 'boolean'
    || value.signatureScheme !== 'hmac-sha256-t-v1' || typeof value.secretsLocation !== 'string' || !object(value.egress) || !['available', 'unavailable'].includes(String(value.egress.state)) || !Array.isArray(value.deliveries) || value.deliveries.length > 100) throw new Error('invalid_integrations')
  return {
    endpoints: value.endpoints.map(endpoint), events: value.events.filter((event): event is string => WEBHOOK_EVENTS.includes(String(event))), signatureScheme: 'hmac-sha256-t-v1', secretsLocation: value.secretsLocation,
    savedRevision: value.savedRevision, activeRevision: value.activeRevision, invalid: value.invalid,
    egress: { state: value.egress.state as 'available' | 'unavailable', reason: value.egress.reason === null ? null : String(value.egress.reason) }, deliveries: value.deliveries.map(delivery),
  }
}

export const randomWebhookId = (): string => {
  const bytes = new Uint8Array(8); (globalThis.crypto ?? { getRandomValues: (array: Uint8Array) => { for (let index = 0; index < array.length; index++) array[index] = Math.floor(Math.random() * 256); return array } }).getRandomValues(bytes)
  return 'whk_' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function bindOpsIntegrations(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-ops-integrations-workspace]').forEach(root => {
    if (root.dataset.intBound === 'true') return
    root.dataset.intBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-ops-int-status]'), rows = root.querySelector<HTMLElement>('[data-ops-int-rows]'), logBody = root.querySelector<HTMLElement>('[data-ops-int-log]')
    const editor = root.querySelector<HTMLElement>('[data-ops-int-editor]'), urlInput = root.querySelector<HTMLInputElement>('[data-ops-int-url]'), eventsFieldset = root.querySelector<HTMLFieldSetElement>('[data-ops-int-events]')
    const addButton = root.querySelector<HTMLButtonElement>('[data-ops-int-add]'), saveButton = root.querySelector<HTMLButtonElement>('[data-ops-int-save]')
    const button = (key: string): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>('[data-ops-int-action="' + key + '"]')
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !rows || !logBody || !editor || !urlInput || !eventsFieldset || !addButton || !saveButton) return
    const denied = '[data-wiring="unavailable"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.intCanRead === 'true' && !root.closest(denied)
    const manageable = (): boolean => admitted() && root.dataset.intCanManage === 'true'
    // Reject an incomplete selected-theme contract before any authorized provider read.
    try {
      const template0 = cloneViewRecord(root, 'ops-endpoint-row', 'tr', { 'url': '', 'events': '', 'secret': '', 'active': '', 'test-label': '', 'remove-label': '' })
      viewAction(template0, 'test')
      viewAction(template0, 'remove')
      cloneViewRecord(root, 'ops-endpoint-empty', 'tr', { 'message': '' })
      cloneViewRecord(root, 'ops-delivery-row', 'tr', { 'reference': '', 'event': '', 'state': '', 'attempts': '', 'status': '' })
      cloneViewRecord(root, 'ops-delivery-empty', 'tr', { 'message': '' })
      const template4 = cloneViewRecord(root, 'ops-event', 'label', { 'event': '' })
      viewAction(template4, 'select', 'input')
    } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      status.dataset.state = 'unavailable'; status.textContent = t('Unavailable'); return
    }
    let view: IntegrationsView | null = null, draft: EndpointView[] = [], dirty = false, busy = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'conflict'].includes(state) ? 'alert' : 'status') }
    const fact = (key: string, value: string): void => { const target = root.querySelector<HTMLElement>('[data-ops-int-fact="' + key + '"]'); if (target) target.textContent = value }
    const eventCheckboxes = (): HTMLInputElement[] => Array.from(eventsFieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    const buildEvents = (): void => {
      eventsFieldset.querySelectorAll('label').forEach(node => node.remove())
      for (const event of view?.events ?? []) {
        const label = cloneViewRecord(root, 'ops-event', 'label', { event }), input = viewAction<HTMLInputElement>(label, 'select', 'input')
        input.value = event; input.disabled = busy || !manageable(); eventsFieldset.append(label)
      }
    }
    const lock = (): void => {
      const can = manageable() && !busy
      urlInput.disabled = !can; eventsFieldset.disabled = !can; addButton.disabled = !can; saveButton.disabled = !can || !dirty
      const read = button('read'); if (read) read.disabled = busy || !admitted()
      root.querySelectorAll<HTMLButtonElement>('[data-ops-int-test]').forEach(element => { element.disabled = busy || !manageable() || dirty || view?.egress.state !== 'available' })
      eventCheckboxes().forEach(input => { input.disabled = !can })
      rows.querySelectorAll<HTMLButtonElement>('[data-xp-action="remove"]').forEach(control => { control.disabled = !can })
      root.setAttribute('aria-busy', String(busy))
    }
    const paintLog = (): void => {
      logBody.textContent = ''
      if (!view?.deliveries.length) { logBody.append(cloneViewRecord(root, 'ops-delivery-empty', 'tr', { message: t('No deliveries have been recorded.') })); return }
      // Delivery IDs are transport identities; this contract has no issued public reference.
      for (const delivery of view.deliveries.slice().reverse()) logBody.append(cloneViewRecord(root, 'ops-delivery-row', 'tr', { reference: t('Not issued'), event: delivery.event, state: delivery.state === 'delivered' ? t('Delivered') : delivery.state === 'exhausted' ? t('Exhausted') : t('Failed'), attempts: delivery.attempts, status: delivery.lastStatus === null ? t('None') : String(delivery.lastStatus) }))
    }
    const paint = (): void => {
      rows.textContent = ''
      if (!draft.length) rows.append(cloneViewRecord(root, 'ops-endpoint-empty', 'tr', { message: view ? t('No webhook endpoints are configured.') : t('No webhook configuration has been read.') }))
      for (const endpoint of draft) {
        const row = cloneViewRecord(root, 'ops-endpoint-row', 'tr', { url: endpoint.url, events: endpoint.events.join(', '), secret: dirty && !endpoint.secretPresent ? t('Generated on save') : endpoint.secretPresent ? t('Stored') : t('Generated on save'), active: endpoint.active ? t('Yes') : t('No'), 'test-label': t('Send test'), 'remove-label': t('Remove') })
        const test = viewAction<HTMLButtonElement>(row, 'test'), remove = viewAction<HTMLButtonElement>(row, 'remove')
        test.hidden = !manageable() || dirty || !endpoint.secretPresent; test.dataset.opsIntTest = endpoint.id
        remove.hidden = !manageable(); remove.disabled = busy || !manageable()
        test.disabled = busy || !manageable() || dirty || !endpoint.secretPresent || view?.egress.state !== 'available'
        test.addEventListener('click', () => { if (!test.disabled) void sendTest(endpoint.id) })
        remove.addEventListener('click', () => { if (busy || !manageable()) return; draft = draft.filter(item => item.id !== endpoint.id); dirty = true; paint(); lock() })
        rows.append(row)
      }
    }
    const render = (value: IntegrationsView): void => {
      view = value; draft = value.endpoints.map(endpoint => ({ ...endpoint })); dirty = false
      fact('scheme', value.signatureScheme); fact('egress', value.egress.state === 'available' ? t('Available') : t('Unavailable')); fact('secrets', String(value.endpoints.filter(endpoint => endpoint.secretPresent).length))
      editor.hidden = !manageable(); buildEvents(); paint(); paintLog()
      if (value.invalid) note('conflict', t('The saved webhook configuration could not be read and is shown as empty. Saving will replace it.'))
      else note('read', t('Webhook configuration read. Secrets are stored on the server and never shown.'))
      lock()
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); note('reading', t('Reading webhooks…'))
      try { render(readIntegrationsView(await transport!('GET', '/api/server/integrations'))) }
      catch { if (admitted()) note('failed', t('The webhook configuration could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    const save = async (): Promise<void> => {
      if (busy || !manageable() || !view || !dirty) return
      busy = true; lock(); note('saving', t('Saving webhooks…'))
      try { render(readIntegrationsView(await transport!('PUT', '/api/server/integrations', { config: { endpoints: draft.map(endpoint => ({ id: endpoint.id, url: endpoint.url, events: endpoint.events, active: endpoint.active })) }, expectedSavedRevision: view.savedRevision }))); note('saved', t('Webhooks saved. A signing secret was generated for each new endpoint.')) }
      catch (error) { const code = (error as { status?: number }).status; note(code === 409 ? 'conflict' : 'failed', code === 409 ? t('The webhook configuration changed since it was read. Reload before saving.') : t('The webhooks could not be saved. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    const sendTest = async (id: string): Promise<void> => {
      if (busy || !manageable() || dirty) return
      busy = true; lock(); note('testing', t('Sending a signed test delivery…'))
      try { const result = await transport!('POST', '/api/server/integrations/test', { id }) as { delivery?: { state?: string } }; await load(); note(result.delivery?.state === 'delivered' ? 'read' : 'failed', result.delivery?.state === 'delivered' ? t('The test delivery was accepted by the endpoint.') : t('The test delivery was not accepted. See the delivery log.')) }
      catch (error) { const reason = (error as { details?: Record<string, unknown> }).details?.reason; note('failed', reason === 'no_reviewed_webhook_egress' ? t('Outbound delivery is unavailable on this server; nothing was sent.') : t('The test delivery could not be sent. Nothing was changed.')); busy = false; lock() }
      finally { busy = false; lock() }
    }
    addButton.addEventListener('click', () => {
      if (!manageable()) return
      const url = urlInput.value.trim(), events = eventCheckboxes().filter(box => box.checked).map(box => box.value)
      if (!/^https:\/\/[^\s/]+\.[^\s/]+/.test(url)) { note('failed', t('Enter a valid https payload URL.')); return }
      if (!events.length) { note('failed', t('Choose at least one event.')); return }
      if (draft.some(endpoint => endpoint.url === url)) { note('failed', t('That URL is already configured.')); return }
      draft = [...draft, { id: randomWebhookId(), url, events, active: true, secretPresent: false }]
      dirty = true; urlInput.value = ''; eventCheckboxes().forEach(box => { box.checked = false }); paint(); lock(); note('read', t('Endpoint added to the draft. Save to store it and generate its secret.'))
    })
    saveButton.addEventListener('click', () => { void save() })
    button('read')?.addEventListener('click', () => { void load() })
    if (!admitted()) note('unavailable', t('Integrations are unavailable here. Nothing was read or changed.'))
    lock()
  })
}

export const OPS_INTEGRATIONS_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const readIntegrationsView=${readIntegrationsView.toString()};const randomWebhookId=${randomWebhookId.toString()};return ${bindOpsIntegrations.toString()};})()`
