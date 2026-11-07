import { createHash } from 'node:crypto'
import { assertEmail, fail } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { mailboxJson, methodNotAllowed } from './folder-admin.ts'

export interface DeviceSetupPorts {
  /** The sealed mailbox for this request (feature webmail-mail-client-setup); never request input. */
  open: (request: Request) => Promise<{ mailbox: string }>
  /** Saved server settings hostname (trusted configuration), or null when none was saved. */
  readHostname: () => Promise<unknown>
  sendEmail: (message: { to: string[]; subject: string; text: string }) => Promise<void>
  now?: () => number
}
export type MailClientEndpoint = edge.MailClientEndpoint
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

// The edge's autoconfig documents and this page describe the same rendered listeners.
export const MAIL_CLIENT_ENDPOINTS = edge.MAIL_CLIENT_ENDPOINTS
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

type ProfileValue = string | number | boolean
const profileEntry = (key: string, value: ProfileValue): string => `\t\t\t<key>${key}</key>\n\t\t\t${typeof value === 'boolean' ? (value ? '<true/>' : '<false/>') : typeof value === 'number' ? `<integer>${value}</integer>` : `<string>${xml(value)}</string>`}`
/** Unsigned Apple configuration profile; its payloads are the caller's and no password key is ever written. */
const appleProfile = (name: string, id: string, uuid: Buffer, payloads: readonly (readonly [string, ProfileValue][])[]): string => {
  const top = (key: string, value: ProfileValue): string => profileEntry(key, value).replace(/^\t\t/gm, '')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
${payloads.map(payload => `\t\t<dict>\n${payload.map(([key, value]) => profileEntry(key, value)).join('\n')}\n\t\t</dict>`).join('\n')}
\t</array>
${[top('PayloadDisplayName', name), top('PayloadIdentifier', id), top('PayloadRemovalDisallowed', false), top('PayloadType', 'Configuration'),
  top('PayloadUUID', profileUuid(uuid)), top('PayloadVersion', 1)].join('\n')}
</dict>
</plist>
`
}

/** One com.apple.mail.managed payload. */
export function renderAppleMailProfile(mailbox: string, hostname: string): string {
  const incoming = MAIL_CLIENT_ENDPOINTS.incoming[0]!, outgoing = MAIL_CLIENT_ENDPOINTS.outgoing[0]!
  const id = 'xpanel.mail.' + digest('identifier', mailbox, hostname).toString('hex').slice(0, 32), name = 'Mail: ' + mailbox
  return appleProfile(name, id, digest('profile', mailbox, hostname), [[
    ['EmailAccountDescription', mailbox], ['EmailAccountType', 'EmailTypeIMAP'], ['EmailAddress', mailbox],
    ['IncomingMailServerAuthentication', 'EmailAuthPassword'], ['IncomingMailServerHostName', hostname], ['IncomingMailServerPortNumber', incoming.port],
    ['IncomingMailServerUseSSL', true], ['IncomingMailServerUsername', mailbox],
    ['OutgoingMailServerAuthentication', 'EmailAuthPassword'], ['OutgoingMailServerHostName', hostname], ['OutgoingMailServerPortNumber', outgoing.port],
    ['OutgoingMailServerUseSSL', true], ['OutgoingMailServerUsername', mailbox], ['OutgoingPasswordSameAsIncomingPassword', true],
    ['PayloadDisplayName', name], ['PayloadIdentifier', id + '.account'], ['PayloadType', 'com.apple.mail.managed'],
    ['PayloadUUID', profileUuid(digest('account', mailbox, hostname))], ['PayloadVersion', 1],
  ]])
}

export const APPLE_PROFILE_TYPE = APPLE.contentType
/** One CalDAV and one CardDAV payload, for iPhone, iPad and macOS, on the login's own principal. */
export function renderAppleDavProfile(login: string, hostname: string, port: number, principal: string): string {
  const id = 'xpanel.dav.' + digest('dav-identifier', login, hostname).toString('hex').slice(0, 32), name = 'Calendars and contacts: ' + login
  const payload = (kind: 'CalDAV' | 'CardDAV'): [string, ProfileValue][] => {
    const lower = kind.toLowerCase()
    return [[`${kind}AccountDescription`, login], [`${kind}HostName`, hostname], [`${kind}Port`, port], [`${kind}PrincipalURL`, principal], [`${kind}UseSSL`, true], [`${kind}Username`, login],
      ['PayloadDisplayName', kind + ': ' + login], ['PayloadIdentifier', `${id}.${lower}`], ['PayloadType', `com.apple.${lower}.account`], ['PayloadUUID', profileUuid(digest('dav-' + lower, login, hostname))], ['PayloadVersion', 1]]
  }
  return appleProfile(name, id, digest('dav-profile', login, hostname), [payload('CalDAV'), payload('CardDAV')])
}

const SEND_INSTRUCTIONS_PATH = '/api/webmail/connect-devices/send-instructions'
const INSTRUCTIONS_PER_HOUR = 5
const instructionsSent = new Map<string, number[]>()

/** Fixed text with the mailbox name and no password, so this route cannot carry a caller's message. */
export const mailClientInstructions = (mailbox: string, hostname: string): { subject: string; text: string } => ({
  subject: 'Mail client settings for ' + mailbox,
  text: ['Use these settings in your mail client.', '', 'Username: ' + mailbox, 'Password: your mailbox password', 'Incoming mail (IMAP): ' + hostname + ', port 993, SSL/TLS', 'Outgoing mail (SMTP): ' + hostname + ', port 465, SSL/TLS'].join('\n'),
})

async function sendInstructions(request: Request, url: URL, method: string, ports: DeviceSetupPorts): Promise<Response> {
  if (method !== 'POST') return methodNotAllowed(['POST'])
  if (url.search) return fail('VALIDATION', 'mail client setup accepts no query selectors', { stateChanged: false })
  const mailbox = mailboxOf((await ports.open(request)).mailbox)
  let body: unknown
  try { body = await request.json() } catch { return fail('VALIDATION', 'a JSON body with one email address is required', { stateChanged: false }) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'email')) return fail('VALIDATION', 'a JSON body with one email address is required', { stateChanged: false })
  const email = assertEmail((body as { email: unknown }).email, 'email'), hostname = hostnameOf(await ports.readHostname())
  if (!hostname) return fail('PRECONDITION_FAILED', 'the server hostname has not been saved, so no instructions can be sent', { stateChanged: false, reason: 'hostname_unavailable' })
  // shortcut: counted in this process, so a restart forgets; one API process sends and Postfix limits still apply.
  const now = (ports.now ?? Date.now)(), recent = (instructionsSent.get(mailbox) ?? []).filter(at => now - at < 3_600_000)
  if (recent.length >= INSTRUCTIONS_PER_HOUR) return fail('LIMIT_EXCEEDED', 'at most ' + INSTRUCTIONS_PER_HOUR + ' instruction messages can be sent per hour', { stateChanged: false })
  const message = mailClientInstructions(mailbox, hostname)
  await ports.sendEmail({ to: [email], ...message })
  instructionsSent.set(mailbox, [...recent, now])
  return mailboxJson({ sent: true })
}

/** /api/webmail/connect-devices: client settings from trusted configuration, plus server-generated setup files. */
export async function handleMailDeviceSetupRoute(request: Request, url: URL, method: string, ports: DeviceSetupPorts): Promise<Response | null> {
  if (url.pathname === SEND_INSTRUCTIONS_PATH) return sendInstructions(request, url, method, ports)
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
