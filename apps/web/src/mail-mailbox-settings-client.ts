/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export interface MailboxSettingsSnapshot { mailbox: string; addresses: string[]; loginAlerts: boolean; alertKnownRanges: boolean; plusFolders: string; senderAvailable: boolean; hostedDomain: string }

export function readMailboxSettings(raw: unknown, mailbox: string): MailboxSettingsSnapshot {
  const v = raw as { context?: { mailbox?: unknown }; settings?: Record<string, unknown>; senderAvailable?: unknown; hostedDomain?: unknown } | null, s = v?.settings
  if (!v || v.context?.mailbox !== mailbox || !s || !Array.isArray(s.addresses) || !s.addresses.every(item => typeof item === 'string') || typeof s.loginAlerts !== 'boolean' || typeof s.alertKnownRanges !== 'boolean'
    || !['off', 'create', 'existing'].includes(s.plusFolders as string) || typeof v.senderAvailable !== 'boolean' || typeof v.hostedDomain !== 'string') throw new Error('invalid_mailbox_settings')
  return { mailbox, addresses: s.addresses as string[], loginAlerts: s.loginAlerts, alertKnownRanges: s.alertKnownRanges, plusFolders: s.plusFolders as string, senderAvailable: v.senderAvailable, hostedDomain: v.hostedDomain }
}

function bindMailboxSettings(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  if (!request) return
  for (const root of document.querySelectorAll<HTMLElement>('[data-mailbox-settings]')) {
    if (root.dataset.bound === 'true') continue
    root.dataset.bound = 'true'
    const mailbox = root.dataset.mailboxSettings ?? '', status = root.querySelector<HTMLElement>('[data-mailbox-settings-status]'), save = root.querySelector<HTMLButtonElement>('[data-mailbox-settings-save]')
    const addresses = root.querySelector<HTMLTextAreaElement>('[data-mailbox-settings-addresses]'), alerts = root.querySelector<HTMLInputElement>('[data-mailbox-settings-alerts]'), ranges = root.querySelector<HTMLInputElement>('[data-mailbox-settings-ranges]')
    const plus = root.querySelector<HTMLSelectElement>('[data-mailbox-settings-plus]'), warn = root.querySelector<HTMLElement>('[data-mailbox-settings-warning]')
    if (!status || !save || !addresses || !alerts || !ranges || !plus) continue
    const note = (state: string, text: string): void => { status.dataset.state = state; status.textContent = text }
    const list = (): string[] => addresses.value.split(/[\s,]+/).map(item => item.trim()).filter(Boolean)
    let hosted = ''
    const sameServer = (): void => { if (warn) warn.hidden = !list().some(item => item.toLowerCase().endsWith('@' + hosted)) }
    const paint = (view: MailboxSettingsSnapshot): void => {
      hosted = view.hostedDomain; addresses.value = view.addresses.join('\n'); alerts.checked = view.loginAlerts; ranges.checked = view.alertKnownRanges; plus.value = view.plusFolders
      for (const control of [addresses, alerts, ranges, plus, save]) control.disabled = false
      sameServer()
    }
    addresses.addEventListener('input', sameServer)
    request('GET', '/api/webmail/mailbox-settings').then(raw => { const view = readMailboxSettings(raw, mailbox); paint(view); note('read', view.senderAvailable ? t('Settings read.') : t('Settings read. The server cannot send notices right now.')) }).catch(() => note('failed', t('Settings could not be read. Nothing was changed.')))
    save.addEventListener('click', () => {
      save.disabled = true; note('saving', t('Saving…'))
      request('PUT', '/api/webmail/mailbox-settings', { addresses: list(), loginAlerts: alerts.checked, alertKnownRanges: ranges.checked, plusFolders: plus.value }).then(raw => {
        paint(readMailboxSettings(raw, mailbox))
        note('saved', (raw as { plusApplied?: unknown }).plusApplied === false ? t('Saved. Plus addressing applies after the next server update.') : t('Saved.'))
      }).catch(() => { save.disabled = false; note('failed', t('The settings could not be saved. Check the addresses and try again.')) })
    })
  }
  if (document.documentElement.dataset.mailDateFormat === 'local') {
    const two = (value: number): string => String(value).padStart(2, '0')
    for (const node of document.querySelectorAll<HTMLTimeElement>('[data-surface="xmail"] time[datetime]')) {
      const when = new Date(node.dateTime)
      if (!Number.isNaN(when.getTime())) node.textContent = `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())} ${two(when.getHours())}:${two(when.getMinutes())}`
    }
  }
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[name="to"],input[name="cc"],input[name="bcc"]')]
  if (!inputs.length || document.getElementById('compose-contact-suggestions')) return
  // Compose autocomplete: the browser's own list keeps keyboard, RTL and screen reader behaviour.
  request('GET', '/api/webmail/contacts').then(raw => {
    const contacts = (raw as { contacts?: unknown }).contacts
    if (!Array.isArray(contacts)) return
    const list = document.createElement('datalist'); list.id = 'compose-contact-suggestions'
    for (const item of contacts.slice(0, 500) as { email?: unknown; fullName?: unknown }[]) {
      if (typeof item.email !== 'string' || !item.email) continue
      const option = document.createElement('option'); option.value = item.email
      if (typeof item.fullName === 'string') option.label = item.fullName
      list.append(option)
    }
    document.body.append(list)
    for (const input of inputs) input.setAttribute('list', list.id)
  }).catch(() => undefined)
}

export const MAILBOX_SETTINGS_CLIENT_BINDING = `(()=>{const readMailboxSettings=${readMailboxSettings.toString()};(${bindMailboxSettings.toString()})()})`
