import { msgid } from './i18n/translator.ts'

/** The scheduler and host tool cards as data: one description, rendered by each theme and bound by whm-host-tools-client.ts. */
export type HostToolCardId = 'tasks' | 'chains' | 'triggers' | 'scripts' | 'hooks' | 'saved-commands' | 'daemons' | 'daemon-profile' | 'watchdog' | 'php-guardian' | 'log-cleanup'
  | 'timezone' | 'swap' | 'ram-disks' | 'hosts-file' | 'system-password' | 'diagnostics' | 'frp-server' | 'frp-client' | 'frp-tunnels' | 'ddns-settings' | 'ddns'

export type HostToolAction = 'run' | 'toggle' | 'edit' | 'log' | 'clear-log' | 'delete' | 'send' | 'start' | 'stop' | 'restart' | 'rotate' | 'mount'
export interface HostToolField {
  name: string
  label: string
  help?: string
  kind: 'text' | 'select' | 'check' | 'area' | 'password'
  /** Paths, hosts and commands stay left to right inside Arabic pages. */
  technical?: boolean
  choices?: readonly (readonly [string, string])[]
  /** Options read from a list in the API reply. */
  from?: 'tasks' | 'scripts'
  maxLength?: number
  placeholder?: string
  /** Shown only while another field holds one of these values. */
  when?: readonly [string, readonly string[]]
}
export interface HostToolCard {
  id: HostToolCardId
  title: string
  lede: string
  api: string
  fields: readonly HostToolField[]
  /** Column title and row key; `@last`, `@unit`, `@ddns`, `task:`, `script:` and `bytes:` read beside the row. */
  columns?: readonly (readonly [string, string])[]
  actions?: readonly HostToolAction[]
  submit?: string
  /** PUT the fields to the api itself instead of adding a row. */
  single?: boolean
  /** POST the fields once, nothing is saved on the page. */
  once?: boolean
  /** Rows are edited, never added. */
  editOnly?: boolean
  danger?: boolean
  /** Sent with every save; rows are filtered on these values too. */
  fixed?: Readonly<Record<string, boolean>>
  /** Reply values shown as facts. */
  facts?: readonly (readonly [string, string])[]
  /** Secondary buttons: label and a path below the api, posted empty. */
  tools?: readonly (readonly [string, string])[]
  link?: readonly [string, string]
  log?: boolean
  jobLink?: boolean
}

const text = (name: string, label: string, extra: Partial<HostToolField> = {}): HostToolField => ({ name, label, kind: 'text', technical: true, maxLength: 253, ...extra })
const plain = (name: string, label: string, extra: Partial<HostToolField> = {}): HostToolField => ({ name, label, kind: 'text', maxLength: 200, ...extra })
const check = (name: string, label: string, extra: Partial<HostToolField> = {}): HostToolField => ({ name, label, kind: 'check', ...extra })
const area = (name: string, label: string, extra: Partial<HostToolField> = {}): HostToolField => ({ name, label, kind: 'area', technical: true, ...extra })
const select = (name: string, label: string, choices: readonly (readonly [string, string])[], extra: Partial<HostToolField> = {}): HostToolField => ({ name, label, kind: 'select', choices, ...extra })

const cycles = [['manual', msgid('Only when run')], ['seconds', msgid('Every few seconds')], ['minutes', msgid('Every few minutes')], ['hourly', msgid('Hourly')], ['hours', msgid('Every few hours')], ['daily', msgid('Daily')], ['days', msgid('Every few days')], ['weekly', msgid('Weekly')], ['monthly', msgid('Monthly')]] as const
const weekdays = [['0', msgid('Sunday')], ['1', msgid('Monday')], ['2', msgid('Tuesday')], ['3', msgid('Wednesday')], ['4', msgid('Thursday')], ['5', msgid('Friday')], ['6', msgid('Saturday')]] as const
const cycleFields: readonly HostToolField[] = [
  select('cycle', msgid('Cycle'), cycles, { help: msgid('Times are in UTC.') }),
  text('every', msgid('Every'), { maxLength: 4, when: ['cycle', ['seconds', 'minutes', 'hours', 'days']], help: msgid('Seconds: 10 to 3600. Minutes: 1 to 59. Hours: 1 to 23. Days: 2 to 30.') }),
  select('weekday', msgid('Weekday'), weekdays, { when: ['cycle', ['weekly']] }),
  text('day', msgid('Day of month'), { maxLength: 2, when: ['cycle', ['monthly']] }),
  text('hour', msgid('Hour'), { maxLength: 2, when: ['cycle', ['daily', 'days', 'weekly', 'monthly']] }),
  text('minute', msgid('Minute'), { maxLength: 2, when: ['cycle', ['hourly', 'hours', 'daily', 'days', 'weekly', 'monthly']] }),
]
const commandHelp = msgid('The absolute path of the program on the first line, then one argument per line. It runs as root without a shell.')
const taskTypes = [['command', msgid('Command')], ['script', msgid('Shell or Python script')], ['site-backup', msgid('Site backup')], ['database-backup', msgid('Database backup')], ['directory-backup', msgid('Directory backup')], ['log-rotation', msgid('Log rotation')], ['time-sync', msgid('Time sync')], ['memory-release', msgid('Memory release')], ['url', msgid('URL request')]] as const
const nameField = plain('name', msgid('Name'), { maxLength: 80 })
const remark = plain('remark', msgid('Remark'))
const enabled = check('enabled', msgid('Enabled'))
const when = (field: string, ...values: string[]): readonly [string, readonly string[]] => [field, values]

export const HOST_TOOL_CARDS: Readonly<Record<HostToolCardId, HostToolCard>> = {
  tasks: { id: 'tasks', title: msgid('Server tasks'), lede: msgid('Each task is a systemd timer that runs as root. A backup keeps its newest copies in /var/lib/xpanel/task-backups. A run that overlaps the previous one is skipped by systemd.'), api: '/api/server/host-tools/tasks',
    fields: [nameField, select('type', msgid('Task type'), taskTypes), ...cycleFields, area('command', msgid('Command'), { help: commandHelp, when: when('type', 'command') }), select('scriptId', msgid('Library script'), [], { from: 'scripts', when: when('type', 'script') }),
      text('target', msgid('Target'), { maxLength: 2000, help: msgid('A URL, a hosted domain, a MariaDB database or an absolute directory, by task type.'), when: when('type', 'url', 'site-backup', 'database-backup', 'directory-backup') }), text('keep', msgid('Copies to keep'), { maxLength: 3, when: when('type', 'site-backup', 'database-backup', 'directory-backup') }),
      area('exclude', msgid('Exclusion rules'), { help: msgid('One tar pattern per line.'), when: when('type', 'site-backup', 'directory-backup') }), remark, check('alert', msgid('Email root when a run fails')), enabled],
    columns: [[msgid('Name'), 'name'], [msgid('Task type'), 'type'], [msgid('Cycle'), 'cycle'], [msgid('Enabled'), 'enabled'], [msgid('Last run'), '@last']], actions: ['run', 'toggle', 'edit', 'log', 'clear-log', 'delete'], fixed: { chained: false }, submit: msgid('Save task'), log: true },
  chains: { id: 'chains', title: msgid('Task chaining'), lede: msgid('A chained task records its output in its log and hands that output to its event triggers.'), api: '/api/server/host-tools/tasks',
    fields: [nameField, select('type', msgid('Runs'), taskTypes.slice(0, 2)), ...cycleFields, area('command', msgid('Command'), { help: commandHelp, when: when('type', 'command') }), select('scriptId', msgid('Library script'), [], { from: 'scripts', when: when('type', 'script') }), remark, enabled],
    columns: [[msgid('Name'), 'name'], [msgid('Runs'), 'type'], [msgid('Cycle'), 'cycle'], [msgid('Last run'), '@last']], actions: ['run', 'edit', 'log', 'clear-log', 'delete'], fixed: { chained: true }, submit: msgid('Save chained task'), log: true },
  triggers: { id: 'triggers', title: msgid('Event triggers'), lede: msgid('When a task ends cleanly its output is matched here, and a match starts the target task. Triggers cannot form a loop.'), api: '/api/server/host-tools/triggers',
    fields: [nameField, select('taskId', msgid('Watch task'), [], { from: 'tasks' }), select('match', msgid('Match'), [['include', msgid('Output includes')], ['exclude', msgid('Output excludes')], ['equal', msgid('Output equals')], ['not-equal', msgid('Output differs from')]]), text('value', msgid('Text'), { maxLength: 1024 }), select('targetId', msgid('Run task'), [], { from: 'tasks' }), remark],
    columns: [[msgid('Name'), 'name'], [msgid('Watch task'), 'task:taskId'], [msgid('Match'), 'match'], [msgid('Text'), 'value'], [msgid('Run task'), 'task:targetId'], [msgid('Last check'), '@last']], actions: ['edit', 'log', 'delete'], submit: msgid('Save trigger'), log: true },
  scripts: { id: 'scripts', title: msgid('Script library'), lede: msgid('Scripts run as root from a root-only file. A script that declares a number and prints something else is flagged TYPE_MISMATCH in its log.'), api: '/api/server/host-tools/scripts',
    fields: [nameField, select('language', msgid('Script type'), [['bash', 'Bash'], ['python', 'Python 3']]), select('returns', msgid('Return type'), [['string', msgid('String')], ['integer', msgid('Integer')], ['float', msgid('Float')]]), area('args', msgid('Arguments'), { help: msgid('One argument per line.') }), remark, area('content', msgid('Script'))],
    columns: [[msgid('Name'), 'name'], [msgid('Script type'), 'language'], [msgid('Return type'), 'returns'], [msgid('Last run'), '@last']], actions: ['run', 'edit', 'log', 'clear-log', 'delete'], submit: msgid('Save script'), log: true },
  hooks: { id: 'hooks', title: msgid('Webhooks'), lede: msgid('A POST to the hook URL with its access key runs the script once. A wrong key returns 403 and runs nothing. The body of the request never reaches the script.'), api: '/api/server/host-tools/hooks',
    fields: [nameField, select('scriptId', msgid('Library script'), [], { from: 'scripts' })],
    columns: [[msgid('Name'), 'name'], [msgid('Library script'), 'script:scriptId'], [msgid('Last run'), '@last']], actions: ['rotate', 'log', 'delete'], submit: msgid('Create hook'), log: true },
  'saved-commands': { id: 'saved-commands', title: msgid('Saved commands'), lede: msgid('Send types the command into the open terminal session once and presses Enter.'), api: '/api/server/host-tools/saved-commands',
    fields: [nameField, area('content', msgid('Command'), { maxLength: 4000 })], columns: [[msgid('Name'), 'name'], [msgid('Command'), 'content']], actions: ['send', 'edit', 'delete'], submit: msgid('Save command') },
  daemons: { id: 'daemons', title: msgid('Supervised daemons'), lede: msgid('Each daemon is a systemd service, so no extra supervisor stays in memory. A process that dies starts again under the restart policy.'), api: '/api/server/host-tools/daemons',
    fields: [text('name', msgid('Name'), { maxLength: 31, help: msgid('Lowercase letters, digits and hyphens.') }), area('command', msgid('Command'), { help: msgid('The absolute path of the program on the first line, then one argument per line.') }), text('user', msgid('Run as'), { maxLength: 16, help: msgid('root or a hosting account.') }), text('directory', msgid('Working directory'), { maxLength: 1024 }), select('restart', msgid('Restart policy'), [['always', msgid('Always')], ['on-failure', msgid('On failure')]]), remark, enabled],
    columns: [[msgid('Name'), 'name'], [msgid('Run as'), 'user'], [msgid('Restart policy'), 'restart'], [msgid('Enabled'), 'enabled'], [msgid('State'), '@unit']], actions: ['start', 'stop', 'restart', 'edit', 'log', 'delete'], submit: msgid('Save daemon'), log: true },
  'daemon-profile': { id: 'daemon-profile', title: msgid('Supervisor profile'), lede: msgid('Restart limits every supervised daemon shares. systemd stops restarting a daemon that fails more often than this.'), api: '/api/server/host-tools/daemon-profile', single: true,
    fields: [text('restartSec', msgid('Restart delay (seconds)'), { maxLength: 3 }), text('burst', msgid('Restarts allowed'), { maxLength: 3 }), text('windowSec', msgid('Within (seconds)'), { maxLength: 5 })], submit: msgid('Save profile') },
  watchdog: { id: 'watchdog', title: msgid('Service watchdog'), lede: msgid('Checks each watched service with a real protocol probe from the panel agent. A failed probe tests the configuration, then restarts. When the hourly budget is spent, root gets an email instead of another restart.'), api: '/api/server/host-tools/watchdog', editOnly: true,
    fields: [check('enabled', msgid('Watch this service')), check('autoRestart', msgid('Restart on failure')), text('intervalSec', msgid('Probe interval (seconds)'), { maxLength: 4 }), text('budgetPerHour', msgid('Restarts per hour (all services)'), { maxLength: 2 })],
    columns: [[msgid('Service'), 'name'], [msgid('Probe'), 'probe'], [msgid('Port'), 'port'], [msgid('Enabled'), 'enabled'], [msgid('Restart on failure'), 'autoRestart'], [msgid('Interval'), 'intervalSec']], actions: ['edit'], submit: msgid('Save service'), log: true },
  'php-guardian': { id: 'php-guardian', title: msgid('PHP-FPM guardian'), lede: msgid('Asks every active pool for its status over the FastCGI socket and restarts a pool that does not answer. Each check wakes one worker of an on-demand pool.'), api: '/api/server/host-tools/php-guardian', single: true,
    fields: [check('enabled', msgid('Check pools')), text('intervalSec', msgid('Check interval (seconds)'), { maxLength: 4 }), text('timeoutSec', msgid('Answer within (seconds)'), { maxLength: 2 })], submit: msgid('Save guardian'), log: true },
  'log-cleanup': { id: 'log-cleanup', title: msgid('Log cleanup'), lede: msgid('Rotated logs are deleted; live logs stay. Site logs are emptied in place without restarting the web server, so traffic not yet counted in the last minute is lost.'), api: '/api/server/host-tools/log-cleanup', once: true, danger: true,
    fields: [check('web', msgid('Web server rotated logs')), check('mail', msgid('Mail rotated logs')), check('system', msgid('System rotated logs')), check('site', msgid('Site logs')), check('journal', msgid('Journal, down to 64 MB'))],
    columns: [[msgid('Category'), 'name'], [msgid('Files'), 'files'], [msgid('Space that would be freed'), 'bytes:bytes']], submit: msgid('Delete chosen logs') },
  timezone: { id: 'timezone', title: msgid('Time zone'), lede: msgid('The zone of the server clock, as tz database names such as Europe/Paris. Panel dates and task cycles stay in UTC.'), api: '/api/server/host-tools/timezone', single: true,
    fields: [text('timezone', msgid('Time zone'), { maxLength: 64 })], facts: [['observedTimezone', msgid('Reported by the server')]], submit: msgid('Set time zone') },
  swap: { id: 'swap', title: msgid('Swap file'), lede: msgid('Creates or resizes /var/swapfile as a host job and keeps it across reboots. 0 removes it. Shrinking fails while the swap in use does not fit in memory.'), api: '/api/server/host-tools/swap', single: true, jobLink: true,
    fields: [text('swapMb', msgid('Size (MB)'), { maxLength: 5 })], facts: [['swapTotalMb', msgid('Swap reported by the OS (MB)')]], submit: msgid('Apply swap size') },
  'ram-disks': { id: 'ram-disks', title: msgid('RAM disks'), lede: msgid('A tmpfs mounted at /mnt/ram-<name>. It uses memory while it fills, and its contents and mount are lost on reboot. Mount it again from this table.'), api: '/api/server/host-tools/ram-disks',
    fields: [text('name', msgid('Name'), { maxLength: 31 }), text('sizeMb', msgid('Size (MB)'), { maxLength: 5 })], columns: [[msgid('Name'), 'name'], [msgid('Size (MB)'), 'sizeMb'], [msgid('Mounted'), 'mounted']], actions: ['mount', 'delete'], submit: msgid('Create RAM disk') },
  'hosts-file': { id: 'hosts-file', title: msgid('Hosts file'), lede: msgid('Entries live in one managed block of /etc/hosts. Lines outside the block stay as they are.'), api: '/api/server/host-tools/hosts-file',
    fields: [text('ip', msgid('Address'), { maxLength: 45 }), text('names', msgid('Host names'), { maxLength: 1024, help: msgid('Separated by spaces.') })], columns: [[msgid('Address'), 'ip'], [msgid('Host names'), 'names']], actions: ['edit', 'delete'], submit: msgid('Save entry') },
  'system-password': { id: 'system-password', title: msgid('System user password'), lede: msgid('For a regular system user outside the hosting accounts. Root has its own page, and an account changes its password on its own pages.'), api: '/api/server/host-tools/password', once: true, danger: true,
    fields: [text('user', msgid('System user'), { maxLength: 32 }), { name: 'password', label: msgid('New password'), kind: 'password' }, { name: 'currentPassword', label: msgid('Your current password'), kind: 'password' }, text('totpCode', msgid('Two-factor code'), { maxLength: 6, help: msgid('Only when you enrolled two-factor sign-in.') })], submit: msgid('Change password') },
  diagnostics: { id: 'diagnostics', title: msgid('Diagnostic tools'), lede: msgid('htop, strace, lsof, tcpdump, mtr, iotop and ncdu are installed and removed from the Software Center, with a dry run first.'), api: '', fields: [], link: ['/whm/software/catalog', msgid('Open Software Center')] },
  'frp-server': { id: 'frp-server', title: msgid('frp server'), lede: msgid('Accepts tunnels from frp clients. The service port and the tunnel range open in the firewall while the server is enabled.'), api: '/api/server/host-tools/frp-server', single: true,
    fields: [enabled, text('bindPort', msgid('Service port'), { maxLength: 5 }), { name: 'token', label: msgid('Token'), kind: 'password', help: msgid('At least 16 characters. Leave empty to keep the saved token.') }, text('portMin', msgid('First tunnel port'), { maxLength: 5 }), text('portMax', msgid('Last tunnel port'), { maxLength: 5 })],
    facts: [['installed', msgid('Installed')], ['version', msgid('Reviewed version')], ['unitState', msgid('State')]], tools: [[msgid('Install frp'), '../frp-install']], submit: msgid('Save server'), log: true },
  'frp-client': { id: 'frp-client', title: msgid('frp client'), lede: msgid('Connects this server to an frp server and publishes the tunnels below on its ports.'), api: '/api/server/host-tools/frp-client', single: true,
    fields: [enabled, text('serverAddr', msgid('Server address')), text('serverPort', msgid('Server port'), { maxLength: 5 }), { name: 'token', label: msgid('Token'), kind: 'password', help: msgid('Leave empty to keep the saved token.') }], facts: [['unitState', msgid('State')]], submit: msgid('Save client'), log: true },
  'frp-tunnels': { id: 'frp-tunnels', title: msgid('frp tunnels'), lede: msgid('Each tunnel publishes one local TCP port on the frp server.'), api: '/api/server/host-tools/frp-tunnels',
    fields: [text('name', msgid('Name'), { maxLength: 31 }), text('localPort', msgid('Local port'), { maxLength: 5 }), text('remotePort', msgid('Remote port'), { maxLength: 5 })], columns: [[msgid('Name'), 'name'], [msgid('Local port'), 'localPort'], [msgid('Remote port'), 'remotePort']], actions: ['edit', 'delete'], submit: msgid('Save tunnel') },
  'ddns-settings': { id: 'ddns-settings', title: msgid('Dynamic DNS check'), lede: msgid('How often the public address of this server is read, and from where. The source answers with the address as plain text.'), api: '/api/server/host-tools/ddns-settings', single: true,
    fields: [text('intervalMinutes', msgid('Check interval (minutes)'), { maxLength: 4 }), text('ipSource', msgid('Address source'), { maxLength: 2000 })], submit: msgid('Save check') },
  ddns: { id: 'ddns', title: msgid('Dynamic DNS records'), lede: msgid('A record is sent only when the detected address changes. A zone on this server is edited directly; other providers use the credentials saved here, which are never shown again.'), api: '/api/server/host-tools/ddns',
    fields: [text('hostname', msgid('Host name')), select('provider', msgid('Provider'), [['local', msgid('Zone on this server')], ['cloudflare', 'Cloudflare'], ['dyndns2', msgid('DynDNS-compatible service')]]), text('server', msgid('Update URL'), { maxLength: 2000, when: when('provider', 'dyndns2'), placeholder: 'https://example.net/nic/update' }), text('username', msgid('User name'), { maxLength: 128, when: when('provider', 'dyndns2') }), { name: 'secret', label: msgid('Password or API token'), kind: 'password', when: when('provider', 'cloudflare', 'dyndns2'), help: msgid('Leave empty to keep the saved value.') }],
    columns: [[msgid('Host name'), 'hostname'], [msgid('Provider'), 'provider'], [msgid('Last update'), '@ddns']], actions: ['edit', 'delete'], tools: [[msgid('Check now'), 'check']], submit: msgid('Save record') },
}

/** What the shared client needs of a card, with choice labels already translated. */
export const hostToolSpec = (card: HostToolCard, t: (message: string) => string): string => JSON.stringify({
  columns: (card.columns ?? []).map(([, key]) => key), actions: card.actions ?? [], fixed: card.fixed ?? {}, single: card.single === true, once: card.once === true, editOnly: card.editOnly === true,
  labels: {
    ...Object.fromEntries(card.fields.filter(field => field.choices?.length).map(field => [field.name, Object.fromEntries(field.choices!.map(([value, label]) => [value, t(label)]))])),
    ...card.once ? { name: Object.fromEntries(card.fields.map(field => [field.name, t(field.label)])) } : {},
  },
})
