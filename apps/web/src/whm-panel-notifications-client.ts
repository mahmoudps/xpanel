import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export type DeliveryErrorView = 'unreachable' | 'timed_out' | 'refused' | 'rejected_status' | 'address_not_public' | 'no_signing_key'
export type PanelNotificationsView = {
  state: 'default' | 'saved' | 'invalid'
  settings: { recipients: string[]; events: string[]; webhook: { url: string; enabled: boolean } | null; updatedAt: string; updatedBy: string } | null
  revision: string; events: string[]; delivery: { events: string[]; email: 'local_mta'; webhook: 'https_signed'; test: 'available' }
  signingKey: { fingerprint: string; createdAt: string; createdBy: string } | null
  createdSigningKey: string | null
  test: { at: string; results: { channel: 'email' | 'webhook'; error: DeliveryErrorView | null; status: number | null }[] } | null
}

export function readPanelNotificationsView(value: unknown): PanelNotificationsView {
  const bad = (): never => { throw new Error('invalid_notification_settings') }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const eventKey = (item: unknown): item is string => typeof item === 'string' && /^[a-z][a-z0-9_]{0,31}\.[a-z0-9_.]{1,63}$/.test(item)
  const iso = (item: unknown): string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) ? item : bad()
  const actor = (item: unknown): string => typeof item === 'string' && /^[A-Za-z0-9_.@-]{1,64}$/.test(item) ? item : bad()
  const url = (item: unknown): string => typeof item === 'string' && item.length <= 2048 && /^https:\/\/[^\s<>"]+$/.test(item) ? item : bad()
  if (!object(value) || !['default', 'saved', 'invalid'].includes(value.state as string) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || !Array.isArray(value.events) || value.events.length > 32 || new Set(value.events).size !== value.events.length || !value.events.every(eventKey)
    || !object(value.delivery) || !Array.isArray(value.delivery.events) || !value.delivery.events.every(item => (value.events as unknown[]).includes(item))
    || value.delivery.email !== 'local_mta' || value.delivery.webhook !== 'https_signed' || value.delivery.test !== 'available'
    || (value.state === 'saved') !== (value.settings !== null)) return bad()
  const known = value.events as string[]
  let settings: PanelNotificationsView['settings'] = null
  if (value.settings !== null) {
    const raw = value.settings
    if (!object(raw) || !Array.isArray(raw.recipients) || raw.recipients.length > 10 || new Set(raw.recipients).size !== raw.recipients.length
      || !raw.recipients.every(item => typeof item === 'string' && item.length <= 254 && /^[A-Za-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}$/.test(item))
      || !Array.isArray(raw.events) || new Set(raw.events).size !== raw.events.length || !raw.events.every(item => known.includes(item as string))
      || raw.webhook !== null && !(object(raw.webhook) && typeof raw.webhook.enabled === 'boolean')) return bad()
    const webhook = raw.webhook === null ? null : { url: url((raw.webhook as Record<string, unknown>).url), enabled: (raw.webhook as Record<string, unknown>).enabled as boolean }
    settings = { recipients: [...raw.recipients as string[]], events: [...raw.events as string[]], webhook, updatedAt: iso(raw.updatedAt), updatedBy: actor(raw.updatedBy) }
  }
  const key = value.signingKey === null || value.signingKey === undefined ? null : object(value.signingKey) && typeof value.signingKey.fingerprint === 'string' && /^[0-9a-f]{16}$/.test(value.signingKey.fingerprint)
    ? { fingerprint: value.signingKey.fingerprint, createdAt: iso(value.signingKey.createdAt), createdBy: actor(value.signingKey.createdBy) } : bad()
  const created = value.createdSigningKey === undefined ? null : typeof value.createdSigningKey === 'string' && /^whsec_[A-Za-z0-9_-]{43}$/.test(value.createdSigningKey) ? value.createdSigningKey : bad()
  const errors = ['unreachable', 'timed_out', 'refused', 'rejected_status', 'address_not_public', 'no_signing_key']
  const test = value.test === undefined ? null : object(value.test) && Array.isArray(value.test.results) && value.test.results.length <= 2 ? {
    at: iso(value.test.at),
    results: value.test.results.map(item => object(item) && (item.channel === 'email' || item.channel === 'webhook') && (item.error === null || errors.includes(item.error as string))
      && (item.status === null || Number.isInteger(item.status) && (item.status as number) >= 0 && (item.status as number) <= 999)
      ? { channel: item.channel as 'email' | 'webhook', error: item.error as DeliveryErrorView | null, status: item.status as number | null } : bad()),
  } : bad()
  return { state: value.state as PanelNotificationsView['state'], settings, revision: value.revision, events: [...known],
    delivery: { events: [...value.delivery.events as string[]], email: 'local_mta', webhook: 'https_signed', test: 'available' }, signingKey: key, createdSigningKey: created, test }
}

function bindWhmPanelNotifications(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-panel-notifications-workspace]').forEach(root => {
    if (root.dataset.notificationsBound === 'true') return
    root.dataset.notificationsBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = one<HTMLElement>('[data-whm-notifications-status]'), loading = one<HTMLElement>('[data-whm-notifications-loading]'), form = one<HTMLFormElement>('[data-whm-notifications-form]')
    const recipients = one<HTMLTextAreaElement>('[data-whm-notifications-recipients]'), save = one<HTMLButtonElement>('[data-whm-notifications-save]'), reload = one<HTMLButtonElement>('[data-whm-notifications-reload]')
    const saveStatus = one<HTMLElement>('[data-whm-notifications-save-status]'), test = one<HTMLButtonElement>('[data-whm-notifications-test]'), testStatus = one<HTMLElement>('[data-whm-notifications-test-status]')
    const hookOn = one<HTMLInputElement>('[data-whm-notifications-webhook-enabled]'), hookUrl = one<HTMLInputElement>('[data-whm-notifications-webhook-url]')
    const keyButton = one<HTMLButtonElement>('[data-whm-notifications-key]'), keyStatus = one<HTMLElement>('[data-whm-notifications-key-status]')
    const boxes = Array.from(root.querySelectorAll<HTMLInputElement>('[data-whm-notifications-event]'))
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !form || !recipients || !save || !reload || !saveStatus || !test || !testStatus || !hookOn || !hookUrl || !keyButton || !keyStatus || !boxes.length) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.notificationsCanManage === 'true' && !root.closest(denied) && form.tagName === 'FORM' && typeof request === 'function'
    let view: PanelNotificationsView | null = null, busy = false
    const note = (target: HTMLElement, state: string, message: string | (string | Node)[]): void => { target.hidden = false; target.dataset.state = state; target.replaceChildren(...(typeof message === 'string' ? [message] : message)); target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const technical = (content: string, tag = 'bdi'): HTMLElement => { const node = document.createElement(tag); node.dir = 'ltr'; node.textContent = content; return node }
    const field = (key: string, content: string | Node): void => { root.querySelector<HTMLElement>('[data-whm-notifications-field="' + key + '"]')?.replaceChildren(content) }
    const channelCount = (next: PanelNotificationsView | null): number => !next?.settings ? 0 : (next.settings.recipients.length ? 1 : 0) + (next.settings.webhook?.enabled ? 1 : 0)
    const controls = (): (HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement)[] => [recipients, save, reload, hookOn, hookUrl, keyButton, ...boxes]
    const lock = (locked: boolean): void => {
      for (const control of controls()) control.disabled = locked || !admitted()
      save.disabled ||= !view; keyButton.disabled ||= !view
      test.disabled = locked || !admitted() || channelCount(view) === 0
      root.setAttribute('aria-busy', String(locked))
    }
    const errorText = (error: DeliveryErrorView | null, status: number | null): string => error === null ? t('sent')
      : error === 'rejected_status' ? t('not sent: the receiver answered with status {status}', { status: status ?? '-' })
        : error === 'refused' ? (status === null ? t('not sent: the mail server refused the message') : t('not sent: the mail server refused the message ({status})', { status }))
          : error === 'timed_out' ? t('not sent: no answer in time') : error === 'address_not_public' ? t('not sent: the address is not a public HTTPS address')
            : error === 'no_signing_key' ? t('not sent: no signing key exists') : t('not sent: the receiver could not be reached')
    const paint = (next: PanelNotificationsView): void => {
      view = next
      recipients.value = next.settings ? next.settings.recipients.join('\n') : ''
      for (const box of boxes) box.checked = !!next.settings?.events.includes(box.value)
      hookOn.checked = !!next.settings?.webhook?.enabled; hookUrl.value = next.settings?.webhook?.url ?? ''
      field('updated', next.settings ? technical(formatDisplayDateTime(next.settings.updatedAt)) : t('Never saved'))
      field('updatedBy', next.settings ? technical(next.settings.updatedBy) : t('Nobody'))
      const key = next.signingKey, keyText = document.createDocumentFragment()
      if (key) keyText.append(...t('Fingerprint {fingerprint}, created {createdAt} by {createdBy}').split(/(\{\w+\})/).filter(Boolean).map(part => part === '{fingerprint}' ? technical(key.fingerprint)
        : part === '{createdAt}' ? technical(formatDisplayDateTime(key.createdAt)) : part === '{createdBy}' ? technical(key.createdBy) : part))
      field('signingKey', key ? keyText : t('None. Create one before enabling the webhook.'))
      keyButton.textContent = key ? t('Replace signing key') : t('Create signing key')
      field('test', channelCount(next) ? t('Available for the saved channels.') : t('Save at least one recipient or an enabled webhook first.'))
      note(status, next.state === 'invalid' ? 'failed' : 'read', next.state === 'saved' ? t('Saved settings read.')
        : next.state === 'default' ? t('No settings have been saved. Nothing is selected and nothing is sent.')
          : t('The saved settings file could not be verified, so it is not shown and nothing is sent. Saving here replaces it.'))
    }
    const failText = (error: unknown, fallback: string): string => {
      const failed = error as { status?: number; details?: { verificationRequired?: boolean; stateChanged?: boolean } }
      return failed?.details?.verificationRequired || failed?.details?.stateChanged ? t('The change could not be verified. Reload the settings before trying again.')
        : failed?.status === 409 ? t('The settings changed since they were read. Reload them before saving.')
          : failed?.status === 403 ? t('Root authorization is required for notification settings.')
            : failed?.status === 412 ? t('Save at least one recipient or an enabled webhook before sending a test.')
              : failed?.status === 400 ? t('The server refused these values. Check the addresses, the webhook URL and the events.') : fallback
    }
    const run = async (target: HTMLElement, reading: string, task: () => Promise<void>, fallback: string): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; lock(true); note(target, 'reading', reading)
      try { await task() } catch (error) { note(target, 'failed', failText(error, fallback)) } finally { busy = false; lock(false) }
    }
    const load = async (): Promise<void> => {
      if (loading) loading.hidden = false
      await run(status, t('Reading notification settings…'), async () => { view = null; paint(readPanelNotificationsView(await request!('GET', '/api/server/panel/notifications'))) },
        t('Notification settings could not be read or verified. Nothing was changed.'))
      if (loading) loading.hidden = true
    }
    if (!admitted()) {
      for (const control of [...controls(), test]) control.disabled = true
      note(status, 'unavailable', t('Notification settings are unavailable here. Nothing was read or changed.'))
      return
    }
    reload.addEventListener('click', () => { saveStatus.hidden = true; keyStatus.hidden = true; void load() })
    keyButton.addEventListener('click', () => {
      if (view?.signingKey && !window.confirm(t('Replace the signing key? Receivers that check the signature must be given the new key.'))) return
      void run(keyStatus, t('Creating a signing key…'), async () => {
        const next = readPanelNotificationsView(await request!('POST', '/api/server/panel/notifications/webhook-key'))
        if (!next.createdSigningKey) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        paint(next)
        note(keyStatus, 'read', [t('Copy this signing key now. It is not shown again.'), technical(next.createdSigningKey, 'code')])
        keyStatus.querySelector('code')?.classList.add('xp-whm-notifications__secret')
      }, t('No signing key was created.'))
    })
    test.addEventListener('click', () => {
      void run(testStatus, t('Sending a test message…'), async () => {
        const next = readPanelNotificationsView(await request!('POST', '/api/server/panel/notifications/test'))
        paint(next)
        const results = next.test?.results ?? []
        note(testStatus, results.every(item => !item.error) ? 'read' : 'failed', results.map(item => (item.channel === 'email' ? t('Email: {result}.', { result: errorText(item.error, item.status) }) : t('Webhook: {result}.', { result: errorText(item.error, item.status) }))).join(' '))
      }, t('The test message could not be sent. Nothing was delivered.'))
    })
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (busy || !view || !admitted() || !request) return
      const current = view
      const list = recipients.value.split(/[\s,;]+/).filter(Boolean)
      const events = boxes.filter(box => box.checked).map(box => box.value)
      const address = hookUrl.value.trim()
      for (const control of [recipients, hookUrl]) control.removeAttribute('aria-invalid')
      if (list.length > 10 || new Set(list.map(item => item.toLowerCase())).size !== list.length || !list.every(item => /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]+$/.test(item))) { recipients.setAttribute('aria-invalid', 'true'); note(saveStatus, 'failed', t('Enter up to 10 different email addresses.')); recipients.focus(); return }
      if ((hookOn.checked || address) && !/^https:\/\/[^\s<>"]+$/.test(address)) { hookUrl.setAttribute('aria-invalid', 'true'); note(saveStatus, 'failed', t('Enter an https:// webhook URL, or clear it.')); hookUrl.focus(); return }
      if (hookOn.checked && !current.signingKey) { note(saveStatus, 'failed', t('Create a signing key before enabling the webhook.')); keyButton.focus(); return }
      if (events.length && !list.length && !hookOn.checked) { recipients.setAttribute('aria-invalid', 'true'); note(saveStatus, 'failed', t('Add at least one recipient or enable the webhook for the selected events.')); recipients.focus(); return }
      void run(saveStatus, t('Saving notification settings…'), async () => {
        const next = readPanelNotificationsView(await request!('PUT', '/api/server/panel/notifications', { recipients: list, events, webhook: address ? { url: address, enabled: hookOn.checked } : null, expectedRevision: current.revision }))
        if (next.state !== 'saved') throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        paint(next)
        note(saveStatus, 'read', next.settings!.events.includes('monitoring.alert') && channelCount(next) ? t('Settings saved. Monitoring alerts are sent to the saved channels from the next evaluation.') : t('Settings saved. No monitoring alert is sent with these settings.'))
      }, t('The settings were not saved.'))
    })
    void load()
  })
}

export const WHM_PANEL_NOTIFICATIONS_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readPanelNotificationsView=${readPanelNotificationsView.toString()};return ${bindWhmPanelNotifications.toString()};})()`
