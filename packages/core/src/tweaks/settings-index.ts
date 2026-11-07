import { msgid } from '../i18n/translator.ts'
import { TWEAKS } from './index.ts'

/** Where a setting is stored: the Tweak Settings file, server.json, its web block or the sign-in policy. */
export type SettingSource = 'tweak' | 'server' | 'web' | 'sign-in'

/** One row of the Advanced Settings Browser: a setting, the page that changes it and how its label is shown. */
export interface SettingsIndexEntry {
  key: string
  source: SettingSource
  /** msgid, or a configuration directive name shown as is */
  label: string
  technical: boolean
  page: string
  /** section id and its msgid heading; rows of one section are listed together */
  group: string
  groupLabel: string
}

const GROUPS: Readonly<Record<string, string>> = {
  logs: msgid('Logs'), server: msgid('System'), compression: msgid('Compression'), ssl: msgid('SSL/TLS'), sql: msgid('SQL'), domains: msgid('Domains'),
  logging: msgid('Logging'), security: msgid('Security'), status: msgid('Status'), support: msgid('Support'), software: msgid('Software'),
  'server-settings': msgid('Server'), web: msgid('Web server'), 'sign-in': msgid('Sign-in security'),
  packages: msgid('Packages'), redirection: msgid('Redirection'),
}
const groupOf = (source: SettingSource, key: string): string => source === 'tweak' ? key.split('.')[0]! : source === 'server' ? 'server-settings' : source
const row = (source: SettingSource, page: string) => (key: string, label: string, technical = false): SettingsIndexEntry =>
  ({ key, source, label, technical, page, group: groupOf(source, key), groupLabel: GROUPS[groupOf(source, key)]! })
const setup = row('server', '/whm/server/setup'), web = row('server', '/whm/services/web'), directive = row('web', '/whm/services/web')
const lockout = row('sign-in', '/whm/security'), signIn = row('sign-in', '/whm/security/sign-in')

/** Every server-wide setting with its source page; tweak keys come from the registry. Values are read by key. */
export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  ...TWEAKS.map(d => row('tweak', d.consumer)(d.key, d.label)),
  setup('hostname', msgid('Server hostname')), setup('adminEmail', msgid('Admin email')), setup('nameservers', msgid('Nameservers')),
  row('server', '/whm/security')('panelPort', msgid('Panel port')), row('server', '/whm/security/ssh')('sshPort', msgid('SSH port')),
  row('server', '/whm/software/php')('defaultPhpVersion', msgid('Default PHP version')),
  web('engine', msgid('Web engine')), web('apacheMpm', 'Apache MPM', true), web('backendPort', msgid('Backend HTTP port')), web('backendTlsPort', msgid('Backend TLS port')),
  web('nginx.workerProcesses', 'worker_processes', true), web('nginx.workerConnections', 'worker_connections', true), web('nginx.workerRlimitNofile', 'worker_rlimit_nofile', true),
  web('nginx.keepaliveTimeoutSec', 'keepalive_timeout', true), web('nginx.multiAccept', 'multi_accept', true),
  web('apache.startServers', 'StartServers', true), web('apache.minSpareServers', 'MinSpareServers', true), web('apache.maxSpareServers', 'MaxSpareServers', true),
  web('apache.maxRequestWorkers', 'MaxRequestWorkers', true), web('apache.serverLimit', 'ServerLimit', true), web('apache.maxConnectionsPerChild', 'MaxConnectionsPerChild', true),
  directive('web.timeoutSec', msgid('Request timeout (seconds)')), directive('web.clientMaxBodyMb', msgid('Largest request body (MB)')),
  directive('web.tlsProtocols', msgid('TLS protocols')), directive('web.tlsCiphers', msgid('TLS 1.2 cipher list')),
  directive('web.gzip.enabled', msgid('Compress responses')), directive('web.gzip.level', msgid('Compression level')),
  directive('web.directoryIndex', 'DirectoryIndex', true), directive('web.rlimitMemMb', 'RLimitMEM (MB)', true), directive('web.rlimitCpuSec', 'RLimitCPU', true),
  directive('web.includes.apachePreMain', msgid('Apache include before the main configuration')), directive('web.includes.apachePreVhost', msgid('Apache include before the virtual hosts')),
  directive('web.includes.apachePostVhost', msgid('Apache include after the virtual hosts')), directive('web.includes.nginxHttp', msgid('Nginx include in the http block')),
  lockout('lockout.username.attempts', msgid('Failed attempts before a username is locked')), lockout('lockout.username.windowMin', msgid('Username counting window (minutes)')),
  lockout('lockout.username.durationMin', msgid('Username lock duration (minutes)')), lockout('lockout.ip.attempts', msgid('Failed attempts before an address is blocked')),
  lockout('lockout.ip.windowMin', msgid('Address counting window (minutes)')), lockout('lockout.ip.durationMin', msgid('Address block duration (minutes)')),
  lockout('lockout.ipAllow', msgid('Addresses never locked')), lockout('lockout.ipDeny', msgid('Addresses always refused')),
  signIn('passwordStrength.default', msgid('Default required password strength')),
  signIn('passwordStrength.perService.panel', msgid('Password strength for panel sign-in')), signIn('passwordStrength.perService.mail', msgid('Password strength for email accounts')),
  signIn('passwordStrength.perService.ftp', msgid('Password strength for FTP accounts')), signIn('passwordStrength.perService.database', msgid('Password strength for database users')),
  signIn('passwordStrength.perService.webdisk', msgid('Password strength for Web Disk')), signIn('passwordStrength.perService.directory', msgid('Password strength for protected directories')),
  signIn('session.idleMin', msgid('Idle session timeout (minutes)')), signIn('session.absoluteHours', msgid('Session lifetime (hours)')),
]

/** The value at a dotted key of a stored object; absent keys read as null. */
export const settingValue = (source: unknown, key: string): unknown => {
  let value = source
  for (const part of key.split('.')) value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[part] : undefined
  return value === undefined ? null : value
}
