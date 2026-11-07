import { msgid } from './i18n/translator.ts'

/** The WHM server operation cards as data: one description, rendered by each theme and bound by whm-server-ops-client.ts. */
export type ServerOpsCardId = 'hostname' | 'resolvers' | 'hostname-record' | 'dns-cleanup' | 'domain-forwards' | 'mail-auth' | 'dns-server' | 'ftp-server' | 'panel-tls' | 'system-mail' | 'role-profile' | 'maintenance' | 'updates'

export interface ServerOpsField {
  name: string
  label: string
  help?: string
  kind: 'text' | 'select' | 'check'
  /** Hosts, addresses, URLs and cron fields stay left to right inside Arabic pages. */
  technical?: boolean
  choices?: readonly (readonly [string, string])[]
  maxLength?: number
  placeholder?: string
}
export interface ServerOpsCard {
  id: ServerOpsCardId
  title: string
  lede: string
  fields: readonly ServerOpsField[]
  submit: string
  danger?: boolean
  /** Column titles of a table the client fills from the API reply. */
  columns?: readonly string[]
  jobLink?: boolean
}

const text = (name: string, label: string, help?: string, placeholder?: string, maxLength = 253): ServerOpsField => ({ name, label, kind: 'text', technical: true, maxLength, ...(help ? { help } : {}), ...(placeholder ? { placeholder } : {}) })
const cron = msgid('Five cron fields in UTC: minute, hour, day of month, month, weekday (0 is Sunday, 6 is Saturday).')

export const SERVER_OPS_CARDS: Readonly<Record<ServerOpsCardId, ServerOpsCard>> = {
  hostname: { id: 'hostname', title: msgid('Change hostname'), lede: msgid('Renames this server: a lowercase fully qualified name of at most 60 characters that does not start with www or a digit. Services that embed the name reload; add an A record for the new name afterwards. The panel addresses keep their names until you change them under Panel access.'),
    fields: [text('hostname', msgid('New hostname'), undefined, 'server1.example.com', 60)], submit: msgid('Review and change hostname') },
  resolvers: { id: 'resolvers', title: msgid('Resolver configuration'), lede: msgid('The recursive DNS servers this server uses. Public open resolvers can break DNS blocklist lookups in the mail server.'),
    fields: [text('primary', msgid('Primary resolver'), undefined, undefined, 45), text('secondary', msgid('Secondary resolver'), undefined, undefined, 45), text('tertiary', msgid('Tertiary resolver (optional)'), undefined, undefined, 45)], submit: msgid('Review and save resolvers') },
  'hostname-record': { id: 'hostname-record', title: msgid('Add an A record for the hostname'), lede: msgid('Adds the record to the parent zone when this server holds one; otherwise creates a zone named after the hostname. The local nameserver is then asked for the name.'),
    fields: [text('ip', msgid('IPv4 address (empty uses the main address)'), undefined, undefined, 15)], submit: msgid('Add A record') },
  'dns-cleanup': { id: 'dns-cleanup', title: msgid('DNS cleanup'), lede: msgid('Removes duplicate and unsaved zone entries from the PowerDNS catalog and zone files no saved zone renders, then reloads PowerDNS.'),
    fields: [], submit: msgid('Run cleanup'), danger: true },
  'domain-forwards': { id: 'domain-forwards', title: msgid('Domain forwarding'), lede: msgid('Each forward takes the next free pool address and answers on it with a 301 to the target URL. Point the A record of the domain at that address.'),
    fields: [text('domain', msgid('Domain')), text('url', msgid('Target URL'), undefined, 'https://example.net/', 2000)], submit: msgid('Add forward'), columns: [msgid('Domain'), msgid('Target URL'), msgid('Forwarder address'), msgid('Actions')] },
  'mail-auth': { id: 'mail-auth', title: msgid('Enable DKIM and SPF for all'), lede: msgid('A background job adds the main server address to the SPF record of every hosted zone, keeping its other terms, and creates a DKIM key for domains without one. Existing DKIM keys stay as they are.'),
    fields: [], submit: msgid('Start job') },
  'dns-server': { id: 'dns-server', title: msgid('DNS server selection'), lede: msgid('PowerDNS is the authoritative daemon. Disable it when this server does not answer for its zones: zones stay saved and return when it is enabled again.'),
    fields: [{ name: 'dnsServer', label: msgid('DNS server'), kind: 'select', choices: [['powerdns', msgid('PowerDNS')], ['disabled', msgid('Disabled')]] }], submit: msgid('Review and apply'), jobLink: true },
  'ftp-server': { id: 'ftp-server', title: msgid('FTP server selection'), lede: msgid('Pure-FTPd is the FTP daemon. Disabled stops it, closes port 21 and removes FTP accounts from user menus. FTP sends passwords in clear text unless the client uses TLS.'),
    fields: [{ name: 'ftpServer', label: msgid('FTP server'), kind: 'select', choices: [['pure-ftpd', msgid('Pure-FTPd')], ['disabled', msgid('Disabled')]] }], submit: msgid('Review and apply'), jobLink: true },
  'panel-tls': { id: 'panel-tls', title: msgid('Panel services TLS'), lede: msgid('Protocols and ciphers of the panel, admin and webmail ports 2083, 2087 and 2096. nginx tests the change before it reloads; a refused change leaves the previous policy running.'),
    fields: [{ name: 'protocols', label: 'TLS 1.2', kind: 'check' }, { name: 'protocols13', label: 'TLS 1.3', kind: 'check', help: msgid('TLS 1.3 needs a recent OpenSSL.') }, text('ciphers', msgid('OpenSSL cipher list'), undefined, undefined, 1024)], submit: msgid('Review and save TLS policy') },
  'system-mail': { id: 'system-mail', title: msgid('System mailbox forwarding'), lede: msgid('Where mail for the system users goes: an email address, or a hosting username for its default mailbox. Chain nobody and the panel user to root, and root to an outside address.'),
    fields: [text('root', msgid('Mail for root'), msgid('Server alerts.')), text('nobody', msgid('Mail for nobody'), msgid('Bounces from scripts.')), text('xpanel', msgid('Mail for the panel user'), msgid('Quota and bandwidth alerts.'))], submit: msgid('Save forwards') },
  'role-profile': { id: 'role-profile', title: msgid('Server profile'), lede: msgid('Which roles this server runs. nginx stays on every profile because it carries the panel. A change is reviewed first and runs as a background job; roles that hosted accounts use are refused.'),
    fields: [{ name: 'profile', label: msgid('Profile'), kind: 'select', choices: [['full', msgid('Full hosting')], ['dns-only', msgid('DNS only')], ['mail-only', msgid('Mail only')], ['database', msgid('Database')]] },
      { name: 'role-postgresql', label: 'PostgreSQL', kind: 'check' }, { name: 'role-mysql', label: 'MariaDB', kind: 'check' }, { name: 'role-mail', label: msgid('Mail'), kind: 'check' },
      { name: 'role-dns', label: 'DNS', kind: 'check', help: msgid('Only the optional roles of the chosen profile are accepted.') }],
    submit: msgid('Review and activate'), columns: [msgid('Role'), msgid('State')], jobLink: true },
  maintenance: { id: 'maintenance', title: msgid('Panel job schedule'), lede: msgid('When the panel runs its own nightly jobs. A job that would run more than once a day is flagged.'),
    fields: [text('updater', msgid('Updater'), cron, undefined, 100), text('backup', msgid('Backup run'), msgid('Empty until a backup configuration is saved.'), undefined, 100)], submit: msgid('Save schedule') },
  updates: { id: 'updates', title: msgid('Update preferences'), lede: msgid('How far the updater may move from the current release. It takes only verified staged releases, signed by a trusted key, and acts as the root user who saved these preferences.'),
    fields: [{ name: 'tier', label: msgid('Release tier'), kind: 'select', choices: [['long-term', msgid('Long-term: patches only')], ['stable', msgid('Stable: same major version')], ['release', msgid('Release: same major version')], ['current', msgid('Current: any newer release')], ['edge', msgid('Edge: any newer release, not for production')]] },
      { name: 'updates', label: msgid('Automatic updates'), kind: 'select', choices: [['manual', msgid('Manual')], ['automatic', msgid('Automatic')]] },
      text('majorDelayDays', msgid('Major upgrade delay (days)'), msgid('A release of another major version waits this long after it is first seen. 0 means no wait.'), undefined, 3),
      { name: 'securityPatches', label: msgid('Install security patches every hour'), kind: 'check', help: msgid('Newer patches of the current minor version only, even while updates are manual. Never a new major version.') },
      { name: 'sendToCluster', label: msgid('Send to the configuration cluster'), kind: 'check', help: msgid('Also pushes these preferences to every cluster member. Each member keeps its own update owner.') }], submit: msgid('Save preferences') },
}

export const SERVER_OPS_API: Readonly<Record<ServerOpsCardId, string>> = {
  hostname: '/api/server/hostname', resolvers: '/api/server/resolvers', 'hostname-record': '/api/server/dns-ops/hostname-a-record', 'dns-cleanup': '/api/server/dns-ops/cleanup',
  'domain-forwards': '/api/server/domain-forwards', 'mail-auth': '/api/server/dns-ops/mail-auth', 'dns-server': '/api/server/service-selection', 'ftp-server': '/api/server/service-selection',
  'panel-tls': '/api/server/panel-tls', 'system-mail': '/api/server/system-mail', 'role-profile': '/api/server/role-profile', maintenance: '/api/server/maintenance-schedule', updates: '/api/server/update-preferences',
}
