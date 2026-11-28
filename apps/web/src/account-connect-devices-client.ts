import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

type AccountDevicesTransport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Endpoint = { protocol: 'imap' | 'smtp'; port: number; security: 'implicit-tls' | 'starttls' }

export interface AccountConnectDevicesView {
  context: { username: string; mailboxes: string[] }
  mailbox: string | null
  hostname: string | null
  incoming: Endpoint[]
  outgoing: Endpoint[]
  downloads: { kind: 'autoconfig' | 'apple'; path: string; filename: string }[]
}

/** Strict reader for GET /api/account/email/connect-devices responses. */
export function readAccountConnectDevicesView(raw: unknown, expectedMailbox?: string): AccountConnectDevicesView {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const bad = (): never => { throw new Error('invalid_account_connect_devices') }
  const address = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 254 && /^[^\s@/\\<>]+@[a-z0-9.-]+$/i.test(value)
  const endpoints = (item: unknown, protocol: 'imap' | 'smtp', ports: number[]): Endpoint[] => Array.isArray(item) && item.length === ports.length
    ? item.map((entry, index) => {
      if (!object(entry) || entry.protocol !== protocol || entry.port !== ports[index] || !['implicit-tls', 'starttls'].includes(String(entry.security)) || Object.keys(entry).length !== 3) return bad()
      return { protocol, port: entry.port as number, security: entry.security as Endpoint['security'] }
    }) : bad()

  if (!object(raw) || !object(raw.context) || typeof raw.context.username !== 'string' || !Array.isArray(raw.context.mailboxes)
    || raw.context.mailboxes.length > 1000 || !raw.context.mailboxes.every(address)
    || raw.pop3 !== 'not-offered' || raw.passwordIncluded !== false || raw.authentication !== 'password'
    || raw.certificate !== 'not-verified-by-this-page' || 'password' in raw || !Array.isArray(raw.downloads)) return bad()

  const mailbox = raw.mailbox === null ? null : address(raw.mailbox) && raw.username === raw.mailbox && raw.context.mailboxes.includes(raw.mailbox) ? raw.mailbox : bad()
  if (expectedMailbox && mailbox !== null && mailbox.toLowerCase() !== expectedMailbox.toLowerCase()) return bad()
  const hostname = raw.hostname === null ? null : typeof raw.hostname === 'string' && raw.hostname.length <= 253 && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(raw.hostname) ? raw.hostname : bad()
  const prefixes: Record<string, string> = {
    autoconfig: '/api/account/email/connect-devices/autoconfig.xml?mailbox=',
    apple: '/api/account/email/connect-devices/apple.mobileconfig?mailbox=',
  }
  const downloads = raw.downloads.map(entry => {
    if (!object(entry) || typeof entry.kind !== 'string' || !prefixes[entry.kind]
      || typeof entry.path !== 'string' || !entry.path.startsWith(prefixes[entry.kind]!)
      || typeof entry.filename !== 'string' || !/^[a-z0-9.-]{1,64}$/.test(entry.filename)) return bad()
    return { kind: entry.kind as 'autoconfig' | 'apple', path: entry.path, filename: entry.filename }
  })
  if ((hostname === null || mailbox === null) !== (downloads.length === 0) || new Set(downloads.map(item => item.kind)).size !== downloads.length) return bad()
  return {
    context: { username: raw.context.username, mailboxes: raw.context.mailboxes },
    mailbox,
    hostname,
    incoming: endpoints(raw.incoming, 'imap', [993, 143]),
    outgoing: endpoints(raw.outgoing, 'smtp', [465, 587]),
    downloads,
  }
}

function bindAccountConnectDevices(readView: typeof readAccountConnectDevicesView): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-connect-devices]').forEach(root => {
    if (root.dataset.accountDevicesBound === 'true') return
    root.dataset.accountDevicesBound = 'true'

    const send = (window as Window & { xpanelSessionRequest?: AccountDevicesTransport }).xpanelSessionRequest
    const mailboxField = root.querySelector<HTMLElement>('[data-account-devices-mailbox-field]')
    const mailboxSelect = root.querySelector<HTMLSelectElement>('[data-account-devices-mailbox]')
    const refresh = root.querySelector<HTMLButtonElement>('[data-account-devices-refresh]')
    const status = root.querySelector<HTMLElement>('[data-account-devices-status]')
    const hostnameNode = root.querySelector<HTMLElement>('[data-account-devices-hostname]')
    const rows = root.querySelector<HTMLElement>('[data-account-devices-rows]')
    const downloadNote = root.querySelector<HTMLElement>('[data-account-devices-download-note]')
    const autoconfigLink = root.querySelector<HTMLAnchorElement>('[data-account-devices-download="autoconfig"]')
    const appleLink = root.querySelector<HTMLAnchorElement>('[data-account-devices-download="apple"]')
    const sendForm = root.querySelector<HTMLElement>('[data-account-devices-send-form]')
    const sendEmail = root.querySelector<HTMLInputElement>('[data-account-devices-send-email]')
    const sendButton = root.querySelector<HTMLButtonElement>('[data-account-devices-send]')
    const sendStatus = root.querySelector<HTMLElement>('[data-account-devices-send-status]')
    if (!mailboxSelect || !refresh || !status || !rows || !downloadNote) return

    try {
      cloneClientTemplate(clientTemplate(root, 'account-device-row'), 'tr', ['service', 'server', 'port', 'security', 'username'])
      cloneClientTemplate(clientTemplate(root, 'account-device-empty'), 'tr', ['message'])
    } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      status.dataset.state = 'unavailable'
      status.textContent = t('Mail client setup is unavailable here. Nothing was read.')
      return
    }

    const canRead = (): boolean => root.isConnected
      && root.dataset.accountDevicesCanRead === 'true'
      && typeof send === 'function'
      && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const canManage = (): boolean => canRead() && root.dataset.accountDevicesManage === 'true'

    let view: AccountConnectDevicesView | null = null
    let busy = false

    const announce = (state: string, message: string): void => {
      status.dataset.state = state
      status.textContent = message
      status.setAttribute('role', state === 'failed' ? 'alert' : 'status')
    }

    const sendAnnounce = (state: string, message: string): void => {
      if (!sendStatus) return
      sendStatus.hidden = false
      sendStatus.dataset.state = state
      sendStatus.textContent = message
      sendStatus.setAttribute('role', state === 'failed' ? 'alert' : 'status')
    }

    const updateDownloadLink = (link: HTMLAnchorElement | null, file: { path: string; filename: string } | undefined): void => {
      if (!link) return
      if (file) {
        link.href = file.path
        link.setAttribute('download', file.filename)
        link.hidden = false
        link.removeAttribute('aria-disabled')
      } else {
        link.removeAttribute('href')
        link.hidden = true
        link.setAttribute('aria-disabled', 'true')
      }
    }

    const emptyRows = (message: string): void => {
      const tr = cloneClientTemplate(clientTemplate(root, 'account-device-empty'), 'tr', ['message'])
      clientTemplateSlot(tr, 'message').textContent = message
      rows.replaceChildren(tr)
    }

    const syncControls = (): void => {
      const readable = canRead()
      const hasMailboxes = (view?.context.mailboxes.length ?? mailboxSelect.options.length) > 0
      mailboxSelect.disabled = busy || !readable || !hasMailboxes
      if (mailboxField) mailboxField.hidden = !hasMailboxes
      refresh.disabled = busy || !readable
      const sendReady = !busy && canManage() && !!view?.mailbox && !!view?.hostname
      if (sendForm) sendForm.hidden = !canManage() || !view?.mailbox || !view?.hostname
      if (sendEmail) sendEmail.disabled = !sendReady
      if (sendButton) sendButton.disabled = !sendReady
      root.setAttribute('aria-busy', String(busy))
    }

    const paint = (next: AccountConnectDevicesView): void => {
      view = next
      const prior = mailboxSelect.value
      mailboxSelect.replaceChildren(...next.context.mailboxes.map(addr => {
        const option = document.createElement('option')
        option.value = addr
        option.textContent = addr
        return option
      }))
      if (next.mailbox) mailboxSelect.value = next.mailbox
      else if (prior && next.context.mailboxes.includes(prior)) mailboxSelect.value = prior

      if (hostnameNode) hostnameNode.textContent = next.hostname ?? t('Server hostname not saved')
      updateDownloadLink(autoconfigLink, next.downloads.find(item => item.kind === 'autoconfig'))
      updateDownloadLink(appleLink, next.downloads.find(item => item.kind === 'apple'))

      if (!next.mailbox) {
        emptyRows(t('No service users were returned.'))
        downloadNote.textContent = t('Create an email mailbox to view client setup downloads.')
        syncControls()
        return
      }

      const securityLabels = { 'implicit-tls': t('SSL/TLS'), starttls: t('STARTTLS') }
      const renderedRows: HTMLElement[] = []
      for (const [label, endpoint] of [
        ...next.incoming.map(item => [t('Incoming (IMAP)'), item] as const),
        ...next.outgoing.map(item => [t('Outgoing (SMTP)'), item] as const),
      ]) {
        const tr = cloneClientTemplate(clientTemplate(root, 'account-device-row'), 'tr', ['service', 'server', 'port', 'security', 'username'])
        clientTemplateSlot(tr, 'service').textContent = label
        clientTemplateSlot(tr, 'server', 'bdi').textContent = next.hostname ?? t('Not saved')
        clientTemplateSlot(tr, 'port', 'bdi').textContent = String(endpoint.port)
        clientTemplateSlot(tr, 'security', 'bdi').textContent = securityLabels[endpoint.security]
        clientTemplateSlot(tr, 'username', 'bdi').textContent = next.mailbox
        renderedRows.push(tr)
      }
      rows.replaceChildren(...renderedRows)
      downloadNote.textContent = next.hostname
        ? t('Files contain the server, ports and username only. Your password is never included.')
        : t('Setup files need a saved server hostname. Ask your provider to save it.')
      syncControls()
    }

    const load = async (targetMailbox?: string): Promise<void> => {
      if (busy || !canRead()) return
      busy = true
      syncControls()
      announce('reading', t('Reading mail client settings…'))
      const chosen = (targetMailbox ?? mailboxSelect.value ?? '').trim()
      const query = chosen ? '?mailbox=' + encodeURIComponent(chosen) : ''
      try {
        const next = readView(await send!('GET', '/api/account/email/connect-devices' + query), chosen || undefined)
        if (!canRead()) return
        paint(next)
        announce(next.mailbox ? (next.hostname ? 'read' : 'warning') : 'empty', next.mailbox
          ? (next.hostname ? t('Settings read from the server configuration.') : t('The server hostname has not been saved, so the server name is unavailable.'))
          : t('No service users were returned.'))
      } catch {
        updateDownloadLink(autoconfigLink, undefined)
        updateDownloadLink(appleLink, undefined)
        emptyRows(t('Settings could not be read. Nothing is shown.'))
        announce('failed', t('Settings could not be read or verified. Nothing is shown.'))
      } finally {
        busy = false
        syncControls()
      }
    }

    if (sendForm instanceof HTMLFormElement) {
      sendForm.addEventListener('submit', event => {
        event.preventDefault()
        if (busy || !canManage() || !view?.mailbox || !sendEmail || sendEmail.disabled) return
        const email = sendEmail.value.trim()
        if (!email) { sendAnnounce('failed', t('Enter an email address.')); return }
        const mailbox = view.mailbox
        busy = true
        syncControls()
        sendAnnounce('reading', t('Sending…'))
        void send!('POST', '/api/account/email/connect-devices/send-instructions', { mailbox, email })
          .then(reply => {
            if ((reply as { sent?: unknown } | null)?.sent !== true) throw new Error('invalid_send_reply')
            sendAnnounce('read', t('Instructions sent to {address}. Delivery is not confirmed.', { address: email }))
          })
          .catch((error: { code?: string; details?: { stateChanged?: boolean } }) => {
            sendAnnounce('failed', error?.code === 'LIMIT_EXCEEDED'
              ? t('At most 5 instruction messages can be sent per hour. Nothing was sent.')
              : error?.code === 'VALIDATION'
                ? t('Enter a valid email address. Nothing was sent.')
                : error?.details?.stateChanged === false
                  ? t('The instructions were refused. Nothing was sent.')
                  : t('The result could not be confirmed. Check the mailbox before sending again.'))
          })
          .finally(() => {
            busy = false
            syncControls()
          })
      })
    }

    if (!canRead()) {
      syncControls()
      announce('unavailable', t('Mail client setup is unavailable here. Nothing was read.'))
      return
    }
    mailboxSelect.addEventListener('change', () => { void load(mailboxSelect.value) })
    refresh.addEventListener('click', () => { void load(mailboxSelect.value) })
    void load(mailboxSelect.value)
  })
}

export const ACCOUNT_CONNECT_DEVICES_CLIENT_BINDING = `(function(){const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const readAccountConnectDevicesView=${readAccountConnectDevicesView.toString()};return (${bindAccountConnectDevices.toString()})(readAccountConnectDevicesView);})()`
