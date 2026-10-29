import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
type Endpoint = { protocol: 'imap' | 'smtp'; port: number; security: 'implicit-tls' | 'starttls' }
export type DeviceSetupView = { mailbox: string; hostname: string | null; incoming: Endpoint[]; outgoing: Endpoint[]; downloads: { kind: 'autoconfig' | 'apple'; path: string; filename: string }[] }

/** Strict reader: the sealed mailbox is the username, only rendered ports appear, and no password is ever present. */
export function readDeviceSetupView(value: unknown, mailbox: string): DeviceSetupView {
  const record = value as Record<string, unknown> | null
  const bad = (): never => { throw new Error('invalid_device_setup') }
  const paths: Record<string, string> = { autoconfig: '/api/webmail/connect-devices/autoconfig.xml', apple: '/api/webmail/connect-devices/apple.mobileconfig' }
  const endpoints = (item: unknown, protocol: 'imap' | 'smtp', ports: number[]): Endpoint[] => Array.isArray(item) && item.length === ports.length ? item.map((raw, index) => {
    const entry = raw as Record<string, unknown> | null
    if (!entry || entry.protocol !== protocol || entry.port !== ports[index] || !['implicit-tls', 'starttls'].includes(entry.security as string) || Object.keys(entry).length !== 3) return bad()
    return { protocol, port: entry.port as number, security: entry.security as Endpoint['security'] }
  }) : bad()
  if (!record || typeof record !== 'object' || record.mailbox !== mailbox || record.username !== mailbox || record.pop3 !== 'not-offered' || record.passwordIncluded !== false
    || record.authentication !== 'password' || record.certificate !== 'not-verified-by-this-page' || 'password' in record || !Array.isArray(record.downloads)) return bad()
  const hostname = record.hostname === null ? null : typeof record.hostname === 'string' && record.hostname.length <= 253 && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(record.hostname) ? record.hostname : bad()
  const downloads = record.downloads.map(raw => {
    const entry = raw as Record<string, unknown> | null
    if (!entry || typeof entry.kind !== 'string' || paths[entry.kind] === undefined || entry.path !== paths[entry.kind] || typeof entry.filename !== 'string' || !/^[a-z0-9.-]{1,64}$/.test(entry.filename)) return bad()
    return { kind: entry.kind as 'autoconfig' | 'apple', path: entry.path as string, filename: entry.filename }
  })
  if ((hostname === null) !== (downloads.length === 0) || new Set(downloads.map(item => item.kind)).size !== downloads.length) return bad()
  return { mailbox, hostname, incoming: endpoints(record.incoming, 'imap', [993, 143]), outgoing: endpoints(record.outgoing, 'smtp', [465, 587]), downloads }
}

function bindMailConnectDevices(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
  const bdi = (value: string): HTMLElement => { const item = document.createElement('bdi'); item.dir = 'ltr'; item.textContent = value; return item }
  document.querySelectorAll<HTMLElement>('[data-mail-connect-devices]').forEach(root => {
    if (root.dataset.devicesBound === 'true') return
    root.dataset.devicesBound = 'true'
    const mailbox = root.dataset.devicesMailbox ?? ''
    const status = root.querySelector<HTMLElement>('[data-mail-devices-status]'), rows = root.querySelector<HTMLElement>('[data-mail-devices-rows]'), downloadNote = root.querySelector<HTMLElement>('[data-mail-devices-download-note]')
    if (!status || !rows || !downloadNote) return
    const admitted = (): boolean => root.isConnected && root.dataset.devicesCanRead === 'true' && root.dataset.devicesMailbox === mailbox && !!mailbox && !root.closest(denied) && !!send
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const links = (view: DeviceSetupView | null): void => root.querySelectorAll<HTMLAnchorElement>('[data-mail-devices-download]').forEach(link => {
      const file = view?.downloads.find(item => item.kind === link.dataset.mailDevicesDownload)
      if (file) { link.href = file.path; link.setAttribute('download', file.filename); link.hidden = false; link.removeAttribute('aria-disabled') }
      else { link.removeAttribute('href'); link.hidden = true; link.setAttribute('aria-disabled', 'true') }
    })
    const empty = (message: string): void => { rows.textContent = ''; const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = message; row.append(cell); rows.append(row) }
    const paint = (view: DeviceSetupView): void => {
      const host = root.querySelector<HTMLElement>('[data-mail-devices-fact="hostname"]')
      if (host) host.textContent = view.hostname ?? t('Server hostname not saved')
      rows.textContent = ''
      const security = { 'implicit-tls': t('SSL/TLS'), starttls: t('STARTTLS') }
      for (const [label, endpoint] of [...view.incoming.map(item => [t('Incoming (IMAP)'), item] as const), ...view.outgoing.map(item => [t('Outgoing (SMTP)'), item] as const)]) {
        const row = document.createElement('tr'), cell = (value: string | Node): void => { const td = document.createElement('td'); td.append(value); row.append(td) }
        cell(label); cell(view.hostname ? bdi(view.hostname) : t('Not saved')); cell(bdi(String(endpoint.port))); cell(bdi(security[endpoint.security])); cell(bdi(view.mailbox)); rows.append(row)
      }
      const pop = document.createElement('tr'), name = document.createElement('td'), state = document.createElement('td')
      name.textContent = t('POP3'); state.colSpan = 4; state.textContent = t('Not offered by this server'); pop.append(name, state); rows.append(pop)
      links(view)
      downloadNote.textContent = view.hostname ? t('Files contain the server, ports and username only. Your password is never included.')
        : t('Setup files need a saved server hostname. Ask your provider to save it.')
    }
    const load = async (): Promise<void> => {
      if (!admitted() || !send) return
      root.setAttribute('aria-busy', 'true'); note('reading', t('Reading mail client settings…'))
      try {
        const view = readDeviceSetupView(await send('GET', '/api/webmail/connect-devices'), mailbox)
        if (!admitted()) { links(null); empty(t('Nothing is shown.')); note('unavailable', t('Mail client setup is unavailable for this mailbox session. Nothing is shown.')); return }
        paint(view)
        note('read', view.hostname ? t('Settings read from the server configuration.') : t('The server hostname has not been saved, so the server name is unavailable.'))
      } catch (error) {
        links(null); empty(t('Settings could not be read. Nothing is shown.'))
        note('failed', (error as { status?: unknown })?.status === 403 ? t('Mail client setup is not available for this mailbox. Nothing is shown.') : t('Settings could not be read or verified. Nothing is shown.'))
      } finally { root.setAttribute('aria-busy', 'false') }
    }
    if (!admitted()) { links(null); note('unavailable', t('Mail client setup is unavailable for this mailbox session. Nothing was read.')); return }
    void load()
  })
}

export const MAIL_CONNECT_DEVICES_CLIENT_BINDING = `(()=>{const readDeviceSetupView=${readDeviceSetupView.toString()};return ${bindMailConnectDevices.toString()};})()`
