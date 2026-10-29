import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import { mailboxJson, methodNotAllowed } from './folder-admin.ts'

export interface DeviceSetupPorts {
  /** The sealed mailbox for this request (feature webmail-mail-client-setup); never request input. */
  open: (request: Request) => Promise<{ mailbox: string }>
  /** Saved server settings hostname (trusted configuration), or null when none was saved. */
  readHostname: () => Promise<unknown>
}
export interface MailClientEndpoint { protocol: 'imap' | 'smtp'; port: number; security: 'implicit-tls' | 'starttls' }
export interface DeviceSetupView {
  mailbox: string
  username: string
  hostname: string | null
  incoming: MailClientEndpoint[]
  outgoing: MailClientEndpoint[]
  pop3: 'not-offered'
  authentication: 'password'
  passwordIncluded: false
  certificate: 'not-verified-by-this-page'
  downloads: { kind: 'autoconfig' | 'apple'; path: string; filename: string; contentType: string }[]
}

// What xPanel renders: Dovecot's imap (143, STARTTLS with ssl = required) and imaps (993) listeners, and
// packages/render/src/services/mail.ts postfixClientServices 465 (wrapper mode) and 587 (STARTTLS), RFC 8314.
// No rendered Dovecot configuration enables pop3, so POP3 is not offered here.
export const MAIL_CLIENT_ENDPOINTS: { incoming: readonly MailClientEndpoint[]; outgoing: readonly MailClientEndpoint[] } = Object.freeze({
  incoming: Object.freeze([{ protocol: 'imap', port: 993, security: 'implicit-tls' }, { protocol: 'imap', port: 143, security: 'starttls' }] as const),
  outgoing: Object.freeze([{ protocol: 'smtp', port: 465, security: 'implicit-tls' }, { protocol: 'smtp', port: 587, security: 'starttls' }] as const),
})
const AUTOCONFIG = { path: '/api/webmail/connect-devices/autoconfig.xml', filename: 'config-v1.1.xml', contentType: 'application/xml; charset=utf-8' }
const APPLE = { path: '/api/webmail/connect-devices/apple.mobileconfig', filename: 'mail-account.mobileconfig', contentType: 'application/x-apple-aspen-config' }

const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const hostnameOf = (value: unknown): string | null => {
  const host = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.$/, '') : ''
  return host.length <= 253 && /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(host) ? host : null
}
const mailboxOf = (value: unknown): string => {
  const mailbox = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return mailbox.length <= 254 && /^[a-z0-9._%+-]{1,64}@(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(mailbox)
    ? mailbox : fail('PRECONDITION_FAILED', 'the mailbox address is unavailable', { stateChanged: false })
}

/** Thunderbird autoconfig (config-v1.1); the password is never part of the file. */
export function renderMailAutoconfig(mailbox: string, hostname: string): string {
  const domain = mailbox.slice(mailbox.indexOf('@') + 1)
  const server = (kind: 'incomingServer' | 'outgoingServer', type: string, endpoint: MailClientEndpoint): string => `    <${kind} type="${type}">
      <hostname>${xml(hostname)}</hostname>
      <port>${endpoint.port}</port>
      <socketType>${endpoint.security === 'implicit-tls' ? 'SSL' : 'STARTTLS'}</socketType>
      <authentication>password-cleartext</authentication>
      <username>${xml(mailbox)}</username>
    </${kind}>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${xml(domain)}">
    <domain>${xml(domain)}</domain>
    <displayName>${xml(mailbox)}</displayName>
    <displayShortName>${xml(domain)}</displayShortName>
${[...MAIL_CLIENT_ENDPOINTS.incoming.map(item => server('incomingServer', 'imap', item)), ...MAIL_CLIENT_ENDPOINTS.outgoing.map(item => server('outgoingServer', 'smtp', item))].join('\n')}
  </emailProvider>
</clientConfig>
`
}

const digest = (label: string, mailbox: string, hostname: string): Buffer => createHash('sha256').update('xpanel-mail-profile:' + label + '\0' + hostname + '\0' + mailbox).digest()
/** Deterministic RFC 9562 version 8 UUID, so re-installing replaces the same profile. */
const profileUuid = (bytes: Buffer): string => {
  const value = Buffer.from(bytes.subarray(0, 16)); value[6] = (value[6]! & 0x0f) | 0x80; value[8] = (value[8]! & 0x3f) | 0x80
  const hex = value.toString('hex').toUpperCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Unsigned Apple configuration profile with one com.apple.mail.managed payload; no password key is ever written. */
export function renderAppleMailProfile(mailbox: string, hostname: string): string {
  const incoming = MAIL_CLIENT_ENDPOINTS.incoming[0]!, outgoing = MAIL_CLIENT_ENDPOINTS.outgoing[0]!
  const id = 'xpanel.mail.' + digest('identifier', mailbox, hostname).toString('hex').slice(0, 32)
  const entry = (key: string, value: string | number | boolean): string => `\t\t\t<key>${key}</key>\n\t\t\t${typeof value === 'boolean' ? (value ? '<true/>' : '<false/>') : typeof value === 'number' ? `<integer>${value}</integer>` : `<string>${xml(value)}</string>`}`
  const top = (key: string, value: string | number | boolean): string => entry(key, value).replace(/^\t\t/gm, '')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
\t\t<dict>
${[
  entry('EmailAccountDescription', mailbox), entry('EmailAccountType', 'EmailTypeIMAP'), entry('EmailAddress', mailbox),
  entry('IncomingMailServerAuthentication', 'EmailAuthPassword'), entry('IncomingMailServerHostName', hostname), entry('IncomingMailServerPortNumber', incoming.port),
  entry('IncomingMailServerUseSSL', true), entry('IncomingMailServerUsername', mailbox),
  entry('OutgoingMailServerAuthentication', 'EmailAuthPassword'), entry('OutgoingMailServerHostName', hostname), entry('OutgoingMailServerPortNumber', outgoing.port),
  entry('OutgoingMailServerUseSSL', true), entry('OutgoingMailServerUsername', mailbox), entry('OutgoingPasswordSameAsIncomingPassword', true),
  entry('PayloadDisplayName', 'Mail: ' + mailbox), entry('PayloadIdentifier', id + '.account'), entry('PayloadType', 'com.apple.mail.managed'),
  entry('PayloadUUID', profileUuid(digest('account', mailbox, hostname))), entry('PayloadVersion', 1),
].join('\n')}
\t\t</dict>
\t</array>
${[top('PayloadDisplayName', 'Mail: ' + mailbox), top('PayloadIdentifier', id), top('PayloadRemovalDisallowed', false), top('PayloadType', 'Configuration'),
  top('PayloadUUID', profileUuid(digest('profile', mailbox, hostname))), top('PayloadVersion', 1)].join('\n')}
</dict>
</plist>
`
}

/** /api/webmail/connect-devices: client settings from trusted configuration, plus server-generated setup files. */
export async function handleMailDeviceSetupRoute(request: Request, url: URL, method: string, ports: DeviceSetupPorts): Promise<Response | null> {
  const route = ({ '/api/webmail/connect-devices': 'view', [AUTOCONFIG.path]: 'autoconfig', [APPLE.path]: 'apple' } as Record<string, string | undefined>)[url.pathname]
  if (!route) return null
  if (method !== 'GET') return methodNotAllowed(['GET'])
  if (url.search) return fail('VALIDATION', 'mail client setup accepts no query selectors', { stateChanged: false })
  const mailbox = mailboxOf((await ports.open(request)).mailbox), hostname = hostnameOf(await ports.readHostname())
  if (route === 'view') {
    const view: DeviceSetupView = { mailbox, username: mailbox, hostname, incoming: [...MAIL_CLIENT_ENDPOINTS.incoming], outgoing: [...MAIL_CLIENT_ENDPOINTS.outgoing],
      pop3: 'not-offered', authentication: 'password', passwordIncluded: false, certificate: 'not-verified-by-this-page',
      downloads: hostname ? [{ kind: 'autoconfig', ...AUTOCONFIG }, { kind: 'apple', ...APPLE }] : [] }
    return mailboxJson(view)
  }
  if (!hostname) return fail('PRECONDITION_FAILED', 'the server hostname has not been saved, so no setup file can be generated', { stateChanged: false, reason: 'hostname_unavailable' })
  const file = route === 'autoconfig' ? AUTOCONFIG : APPLE
  if ((await ports.open(request)).mailbox.trim().toLowerCase() !== mailbox) return fail('FORBIDDEN', 'mailbox session changed; sign in again', { stateChanged: false })
  return new Response(route === 'autoconfig' ? renderMailAutoconfig(mailbox, hostname) : renderAppleMailProfile(mailbox, hostname), {
    headers: { 'content-type': file.contentType, 'content-disposition': `attachment; filename="${file.filename}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  })
}
