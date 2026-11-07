import { releaseNotes } from '@xpanel/catalog'
import { escapeHtml } from '../html.ts'
import { releasePackages } from './release-packages-panel.ts'
import { MAIL_CERT_PANELS } from './mail-cert-panels.ts'
export { AUTOSSL_SETTINGS_PANEL } from './mail-cert-panels.ts'

/**
 * Services and security centre panels: what each tool shows and sends, independent of any theme. Each theme draws these
 * sections with its own components and the same data-svc-* hooks; ../svc-panels-client.ts binds them, so the two themes cannot drift.
 */
export type SvcFormat = 'text' | 'time' | 'yes-no' | 'octal' | 'on-off'
export interface SvcFact { path: string; label: string; format?: SvcFormat; labels?: Readonly<Record<string, string>> }
export interface SvcColumn extends SvcFact { technical?: boolean }
export type SvcRowOp = { op: 'remove'; path: string; key: string; label: string } | { op: 'toggle'; path: string; key: string; field: string; label: string } | { op: 'waf-file'; label: string }
  | { op: 'post'; url: string; key: string; arg: string; label: string; confirm?: string; revision?: boolean; extra?: Readonly<Record<string, string>> } | { op: 'fill'; label: string; fields: readonly string[] }
export interface SvcTable { title: string; rows: string; columns: readonly SvcColumn[]; empty: string; ops?: readonly SvcRowOp[] }
export interface SvcInput { key: string; label: string; kind: 'check' | 'number' | 'text' | 'select' | 'lines' | 'area'; choices?: readonly (readonly [string, string])[]; help?: string; technical?: boolean; min?: number; max?: number }
export interface SvcForm { inputs: readonly SvcInput[]; role: 'policy' | 'arg' | 'new' | 'query' }
export type SvcButton = { label: string; op: 'save' | 'refresh'; primary?: boolean } | { label: string; op: 'add'; path: string; primary?: boolean; defaults?: Readonly<Record<string, unknown>> }
  | { label: string; op: 'post'; url: string; primary?: boolean; revision?: boolean; confirm?: string; reset?: readonly string[]; extra?: Readonly<Record<string, string>> }
export interface SvcSection { id: string; title: string; help?: string; facts?: readonly SvcFact[]; forms?: readonly SvcForm[]; tables?: readonly SvcTable[]; buttons?: readonly SvcButton[] }
export interface SvcPanel { id: string; tool: string; read: string; put?: string; sections: readonly SvcSection[] }

const STATES = { applied: msgid('Applied'), drift: msgid('Drift: the host differs from the saved choice'), unmanaged: msgid('Not managed; the distribution modes stay as they are'), not_installed: msgid('Not installed'), unavailable: msgid('Unavailable'), read: msgid('Read'), pam_missing: msgid('Saved, but PAM does not load pam_limits for SSH, so the limits do nothing') }
const refresh: SvcButton = { label: msgid('Refresh'), op: 'refresh' }
const save: SvcButton = { label: msgid('Save'), op: 'save', primary: true }
const check = (key: string, label: string, help?: string): SvcInput => ({ key, label, kind: 'check', ...(help ? { help } : {}) })
const number = (key: string, label: string, min: number, max: number, help?: string): SvcInput => ({ key, label, kind: 'number', min, max, ...(help ? { help } : {}) })
const onOff: readonly (readonly [string, string])[] = [['', msgid('Not set')], ['On', 'On'], ['Off', 'Off']]
const PHP_VERSIONS = (['7.4', '8.0', '8.1', '8.2', '8.3', '8.4'] as const).map(version => [version, version] as const)

const processLog: SvcPanel = { id: 'process-log', tool: 'daily-process-log', read: '/api/server/services/process-log', sections: [{
  id: 'process-log', title: msgid('Daily process log'), help: msgid('Sampled every 5 minutes as root and kept for today and yesterday (UTC). Averages cover the whole day so far, so a user seen once counts as low.'),
  forms: [{ role: 'query', inputs: [{ key: 'day', label: msgid('Day'), kind: 'select', choices: [['today', msgid('Today (UTC)')], ['yesterday', msgid('Yesterday (UTC)')]] }] }],
  facts: [{ path: 'day', label: msgid('Day') }, { path: 'report.samples', label: msgid('Samples') }],
  tables: [
    { title: msgid('Usage by user'), rows: 'report.users', empty: msgid('No usage has been recorded.'), columns: [{ path: 'user', label: msgid('User'), technical: true }, { path: 'domain', label: msgid('Domain'), technical: true }, { path: 'cpuPercent', label: msgid('Average CPU %') }, { path: 'memoryPercent', label: msgid('Average memory %') }, { path: 'dbProcesses', label: msgid('Average database processes') }] },
    { title: msgid('Top processes'), rows: 'report.top', empty: msgid('No processes have been recorded.'), columns: [{ path: 'user', label: msgid('User'), technical: true }, { path: 'domain', label: msgid('Domain'), technical: true }, { path: 'comm', label: msgid('Process'), technical: true }, { path: 'peakCpuPercent', label: msgid('Peak CPU %') }] },
  ], buttons: [refresh] }] }

const processKiller: SvcPanel = { id: 'process-killer', tool: 'background-process-killer', read: '/api/server/sec/process-killer', put: '/api/server/sec/process-killer', sections: [{
  id: 'process-killer', title: msgid('Background process killer'), help: msgid('During the nightly run, forbidden processes owned by hosting accounts are stopped. System users and the trusted users below are never touched. A report goes to the notification recipients when something was stopped.'),
  forms: [{ role: 'policy', inputs: [check('policy.enabled', msgid('Run during nightly maintenance')), { key: 'policy.names', label: msgid('Forbidden process names'), kind: 'lines', technical: true, help: msgid('One per line, from: BitchX, bnc, eggdrop, generic-sniffers, guardservices, ircd, psyBNC, ptlink, services.') }, { key: 'policy.trustedUsers', label: msgid('Trusted users'), kind: 'lines', technical: true, help: msgid('One account username per line.') }] }],
  tables: [{ title: msgid('Recent runs'), rows: 'observation.runs', empty: msgid('No run has been recorded.'), columns: [{ path: 'at', label: msgid('Time (UTC)'), format: 'time' }, { path: 'trigger', label: msgid('Started by'), labels: { nightly: msgid('Nightly run'), manual: msgid('Administrator') } }, { path: 'killed.length', label: msgid('Stopped') }, { path: 'trustedSkipped', label: msgid('Trusted, skipped') }, { path: 'mailed', label: msgid('Report sent'), format: 'yes-no' }] }],
  buttons: [save, { label: msgid('Run now'), op: 'post', url: '/api/server/sec/process-killer/run', confirm: msgid('Stop every forbidden process of untrusted accounts now?') }, refresh] }] }

const webStatus: SvcPanel = { id: 'web-status', tool: 'web-server-status', read: '/api/server/services/web-status', sections: [{
  id: 'web-status', title: msgid('Web server status'), help: msgid('Live Apache mod_status and nginx stub_status, read over loopback by the agent. The status path is secret because the scoreboard shows other accounts requests.'),
  facts: [{ path: 'apache.state', label: msgid('Apache status'), labels: { read: msgid('Read'), unsupported_engine: msgid('Another web server replaces Apache'), unavailable: msgid('Unavailable') } }, { path: 'apache.summary.serverVersion', label: msgid('Server version') }, { path: 'apache.summary.restartTime', label: msgid('Last restart') }, { path: 'apache.summary.generation', label: msgid('Restart generation') }, { path: 'apache.summary.uptimeSeconds', label: msgid('Uptime (seconds)') }, { path: 'apache.summary.totalAccesses', label: msgid('Total requests') }, { path: 'apache.summary.totalKb', label: msgid('Total traffic (KB)') }, { path: 'apache.summary.cpuLoad', label: msgid('CPU load') }, { path: 'apache.summary.requestsPerSecond', label: msgid('Requests per second') }, { path: 'apache.summary.bytesPerSecond', label: msgid('Bytes per second') }, { path: 'apache.summary.bytesPerRequest', label: msgid('Bytes per request') }, { path: 'apache.summary.busyWorkers', label: msgid('Busy workers') }, { path: 'apache.summary.idleWorkers', label: msgid('Idle workers') }, { path: 'nginx.activeConnections', label: msgid('nginx active connections') }, { path: 'nginx.requests', label: msgid('nginx requests') }, { path: 'observedAt', label: msgid('Observed at (UTC)'), format: 'time' }],
  tables: [{ title: msgid('Busy workers'), rows: 'apache.workers', empty: msgid('No worker is busy.'), columns: [{ path: 'slot', label: msgid('Slot'), technical: true }, { path: 'pid', label: 'PID', technical: true }, { path: 'mode', label: msgid('Mode') }, { path: 'cpu', label: 'CPU' }, { path: 'secondsSinceRequest', label: msgid('Seconds since request') }, { path: 'client', label: msgid('Client'), technical: true }, { path: 'vhost', label: msgid('Virtual host'), technical: true }, { path: 'request', label: msgid('Request'), technical: true }, { path: 'internal', label: msgid('Internal'), format: 'yes-no' }] }],
  buttons: [refresh] }, {
  id: 'piped-logging', title: msgid('Piped logging'), help: msgid('Not applicable: nginx writes each site log, so Apache holds no per-site log handles, and KeepAlive stays off because mpm-itk serves each request as its account.') }] }

const phpFpm: SvcPanel = { id: 'php-fpm-defaults', tool: 'php-fpm-service', read: '/api/server/sec/php-fpm-defaults', put: '/api/server/sec/php-fpm-defaults', sections: [{
  id: 'php-fpm-defaults', title: msgid('System PHP-FPM defaults'), help: msgid('Applied to every pool of a domain that has not chosen its own values, within its plan worker limit. Each save rebuilds those pools and tests them before reload. A locked INI value cannot be overridden by a domain.'),
  forms: [{ role: 'policy', inputs: [{ key: 'policy.pool.mode', label: msgid('Process manager'), kind: 'select', technical: true, choices: [['ondemand', 'ondemand'], ['dynamic', 'dynamic'], ['static', 'static']] }, number('policy.pool.maxChildren', msgid('Max children'), 1, 10000), number('policy.pool.maxRequests', msgid('Max requests'), 1, 10000000), number('policy.pool.processIdleTimeoutSec', msgid('Process idle timeout (seconds)'), 1, 86400), number('policy.pool.startServers', msgid('Start servers (dynamic)'), 0, 10000), number('policy.pool.minSpareServers', msgid('Minimum spare servers (dynamic)'), 0, 10000), number('policy.pool.maxSpareServers', msgid('Maximum spare servers (dynamic)'), 0, 10000),
    { key: 'policy.ini.allow_url_fopen.value', label: 'allow_url_fopen', kind: 'select', technical: true, choices: onOff }, check('policy.ini.allow_url_fopen.locked', msgid('Lock allow_url_fopen')), { key: 'policy.ini.short_open_tag.value', label: 'short_open_tag', kind: 'select', technical: true, choices: onOff }, check('policy.ini.short_open_tag.locked', msgid('Lock short_open_tag')), { key: 'policy.ini.log_errors.value', label: 'log_errors', kind: 'select', technical: true, choices: onOff }, check('policy.ini.log_errors.locked', msgid('Lock log_errors')), { key: 'policy.ini.error_reporting.value', label: 'error_reporting', kind: 'text', technical: true }, check('policy.ini.error_reporting.locked', msgid('Lock error_reporting'))] }],
  facts: [{ path: 'observation.pools', label: msgid('Pools') }, { path: 'observation.poolsAtLimit', label: msgid('Pools that hit max children') }, { path: 'observation.hits', label: msgid('Max children hits in the current logs') }],
  tables: [{ title: msgid('Pool use'), rows: 'observation.items', empty: msgid('No pool has been read.'), columns: [{ path: 'account', label: msgid('Account'), technical: true }, { path: 'version', label: msgid('PHP version'), technical: true }, { path: 'maxChildrenHits', label: msgid('Max children hits') }, { path: 'lastHit', label: msgid('Last hit'), technical: true }] }],
  buttons: [save, refresh] }] }

const phpDomains: SvcPanel = { id: 'php-domains', tool: 'php-manager-domains', read: '/api/server/php/manage', sections: [{
  id: 'php-domains', title: msgid('Domains'), help: msgid('One pool serves an account for each PHP version, and it takes its values from the first domain on that version. Returning a domain to the server defaults clears its own pool values.'),
  tables: [{ title: msgid('PHP domains'), rows: 'domains', empty: msgid('No PHP domain has been read.'), columns: [{ path: 'name', label: msgid('Domain'), technical: true }, { path: 'account', label: msgid('Account'), technical: true }, { path: 'version', label: msgid('PHP version'), technical: true }, { path: 'handler', label: msgid('Handler'), technical: true }, { path: 'fpm.maxChildren', label: msgid('Max children') }, { path: 'fpm.maxRequests', label: msgid('Max requests') }, { path: 'inherited', label: msgid('Follows server defaults'), format: 'yes-no' }], ops: [{ op: 'fill', label: msgid('Edit'), fields: ['name', 'version', 'fpm.mode', 'fpm.maxChildren', 'fpm.maxRequests', 'fpm.processIdleTimeoutSec', 'fpm.startServers', 'fpm.minSpareServers', 'fpm.maxSpareServers'] }] }],
  forms: [{ role: 'arg', inputs: [{ key: 'domain', label: msgid('Domain'), kind: 'text', technical: true }, { key: 'version', label: msgid('PHP version'), kind: 'text', technical: true }, { key: 'fpm.mode', label: msgid('Process manager'), kind: 'select', technical: true, choices: [['ondemand', 'ondemand'], ['dynamic', 'dynamic'], ['static', 'static']] }, number('fpm.maxChildren', msgid('Max children'), 1, 10000), number('fpm.maxRequests', msgid('Max requests'), 1, 10000000), number('fpm.processIdleTimeoutSec', msgid('Process idle timeout (seconds)'), 1, 86400), number('fpm.startServers', msgid('Start servers (dynamic)'), 0, 10000), number('fpm.minSpareServers', msgid('Minimum spare servers (dynamic)'), 0, 10000), number('fpm.maxSpareServers', msgid('Maximum spare servers (dynamic)'), 0, 10000)] }],
  buttons: [{ label: msgid('Save this domain'), op: 'post', url: '/api/server/php/domain', primary: true, revision: true }, { label: msgid('Return to server defaults'), op: 'post', url: '/api/server/php/domain', revision: true, reset: ['fpm'] }, refresh] }] }

const pear: SvcPanel = { id: 'pear', tool: 'pear-packages', read: '/api/server/services/pear', sections: [{
  id: 'pear', title: msgid('PHP PEAR packages'), help: msgid('Each PHP version keeps its own library, added to the include path of its pools. PEAR packages come from the PEAR channel and carry no signature, so install only what you trust.'),
  forms: [{ role: 'query', inputs: [{ key: 'version', label: msgid('PHP version'), kind: 'select', technical: true, choices: PHP_VERSIONS }] }],
  facts: [{ path: 'state', label: msgid('State'), labels: { read: msgid('Read'), not_installed: msgid('Not installed'), unavailable: msgid('Unavailable') } }, { path: 'library', label: msgid('Include path') }, { path: 'requiredPackage', label: msgid('Required system package') }],
  tables: [{ title: msgid('Installed packages'), rows: 'packages', empty: msgid('No package is installed for this version.'), columns: [{ path: 'name', label: msgid('Package'), technical: true }, { path: 'version', label: msgid('Version'), technical: true }, { path: 'state', label: msgid('State'), technical: true }], ops: [{ op: 'post', url: '/api/server/services/pear/change', key: 'name', arg: 'name', label: msgid('Update'), extra: { operation: 'upgrade' } }, { op: 'post', url: '/api/server/services/pear/change', key: 'name', arg: 'name', label: msgid('Uninstall'), extra: { operation: 'uninstall' }, confirm: msgid('Uninstall this PEAR package for this PHP version?') }] }],
  buttons: [{ label: msgid('Install PEAR'), op: 'post', url: '/api/server/services/pear/change', extra: { operation: 'setup', name: 'PEAR' } }, refresh] }, {
  id: 'pear-search', title: msgid('Find a package'),
  forms: [{ role: 'arg', inputs: [{ key: 'name', label: msgid('Package name'), kind: 'text', technical: true }] }],
  buttons: [{ label: msgid('Search'), op: 'post', url: '/api/server/services/pear/search', primary: true }, { label: msgid('Install'), op: 'post', url: '/api/server/services/pear/change', extra: { operation: 'install' } }],
  tables: [{ title: msgid('Search results'), rows: 'results', empty: msgid('No search has been run.'), columns: [{ path: 'name', label: msgid('Package'), technical: true }, { path: 'version', label: msgid('Version'), technical: true }, { path: 'summary', label: msgid('Summary') }] }] }] }

const forkBomb: SvcPanel = { id: 'fork-bomb', tool: 'fork-bomb-protection', read: '/api/server/sec/fork-bomb', put: '/api/server/sec/fork-bomb', sections: [{
  id: 'fork-bomb', title: msgid('Shell fork bomb protection'), help: msgid('Limits every SSH and terminal session of accounts with shell access through pam_limits and the terminal unit. Root is not affected. Processes count across the whole account, including its PHP workers. The plan process limit on the account slice applies either way.'),
  forms: [{ role: 'policy', inputs: [check('policy.enabled', msgid('Enable protection'))] }],
  facts: [{ path: 'observation.application', label: msgid('Host state'), labels: STATES }, { path: 'observation.pam', label: msgid('pam_limits in the SSH session'), format: 'yes-no' }, { path: 'observation.expectedUsers', label: msgid('Shell accounts') }, { path: 'observation.limitedUsers', label: msgid('Accounts limited on the host') }, { path: 'observation.limits.nproc', label: msgid('Processes') }, { path: 'observation.limits.nofile', label: msgid('Open files') }, { path: 'observation.limits.data', label: msgid('Data segment (KB)') }, { path: 'observation.limits.stack', label: msgid('Stack (KB)') }, { path: 'observation.limits.core', label: msgid('Core files (KB)') }],
  buttons: [save, refresh] }] }

const traceroute: SvcPanel = { id: 'traceroute', tool: 'traceroute-toggle', read: '/api/server/sec/traceroute', put: '/api/server/sec/traceroute', sections: [{
  id: 'traceroute', title: msgid('Traceroute access'), help: msgid('Sets traceroute and tracepath to root only (mode 0700) or open to all users (0755). A package update can reset the mode; it then shows as drift and returns on the next apply. The panel network tools run as root and stay available.'),
  forms: [{ role: 'policy', inputs: [check('policy.allowed', msgid('Allow all users to run traceroute'))] }],
  facts: [{ path: 'observation.state', label: msgid('Host state'), labels: STATES }, { path: 'updatedAt', label: msgid('Last saved (UTC)'), format: 'time' }],
  tables: [{ title: msgid('Traceroute programs'), rows: 'observation.binaries', empty: msgid('No traceroute program is installed.'), columns: [{ path: 'path', label: msgid('Path'), technical: true }, { path: 'mode', label: msgid('Mode'), format: 'octal', technical: true }] }],
  buttons: [save, refresh] }] }

const smtp: SvcPanel = { id: 'smtp-restrictions', tool: 'smtp-restrictions', read: '/api/server/sec/smtp-restrictions', put: '/api/server/sec/smtp-restrictions', sections: [{
  id: 'smtp-restrictions', title: msgid('Outbound SMTP restrictions'), help: msgid('Refuses connections from hosting accounts to remote SMTP ports 25, 465 and 587 in the firewall, so scripts send through the local mail server, where limits and logging apply. Root, the mail server and local delivery are not affected.'),
  forms: [{ role: 'policy', inputs: [check('policy.enabled', msgid('Enable restrictions'))] }],
  facts: [{ path: 'observation.application', label: msgid('Host state'), labels: STATES }, { path: 'observation.active', label: msgid('Rule in the running firewall'), format: 'yes-no' }, { path: 'observation.observedAt', label: msgid('Observed at (UTC)'), format: 'time' }],
  buttons: [save, refresh] }] }

const antivirus: SvcPanel = { id: 'antivirus-scope', tool: 'antivirus-scanner-config', read: '/api/server/sec/antivirus-scope', put: '/api/server/sec/antivirus-scope', sections: [{
  id: 'antivirus-scope', title: msgid('Scanner configuration'), help: msgid('What an antivirus scan may read. A user added below keeps its own choices; everyone else follows the server choices.'),
  forms: [{ role: 'policy', inputs: [check('policy.global.home', msgid('Whole home directory')), check('policy.global.mail', msgid('Mail folders')), check('policy.global.publicFtp', msgid('Public FTP area')), check('policy.global.publicWeb', msgid('Public web area'))] }],
  buttons: [save, refresh] }, {
  id: 'antivirus-users', title: msgid('Per-user choices'),
  tables: [{ title: msgid('Configured users'), rows: 'policy.users', empty: msgid('No user has its own choices.'), columns: [{ path: 'key', label: msgid('User'), technical: true }, { path: 'value.home', label: msgid('Whole home directory'), format: 'yes-no' }, { path: 'value.mail', label: msgid('Mail folders'), format: 'yes-no' }, { path: 'value.publicFtp', label: msgid('Public FTP area'), format: 'yes-no' }, { path: 'value.publicWeb', label: msgid('Public web area'), format: 'yes-no' }], ops: [{ op: 'remove', path: 'policy.users', key: 'key', label: msgid('Remove') }] }],
  forms: [{ role: 'new', inputs: [{ key: 'key', label: msgid('User'), kind: 'text', technical: true }, check('value.home', msgid('Whole home directory')), check('value.mail', msgid('Mail folders')), check('value.publicFtp', msgid('Public FTP area')), check('value.publicWeb', msgid('Public web area'))] }],
  buttons: [{ label: msgid('Add user'), op: 'add', path: 'policy.users' }] }] }

const wafRules: SvcPanel = { id: 'waf-rules', tool: 'waf-rules', read: '/api/server/sec/waf-rules', put: '/api/server/sec/waf-rules', sections: [{
  id: 'waf-rules', title: msgid('Custom rules'), help: msgid('Rules stay staged and do nothing until you deploy them. A rule blocks only while the rule engine is On; in detection mode it logs. Deploy tests the web server configuration first, and a refused rule leaves the previous rules active.'),
  forms: [{ role: 'policy', inputs: [{ key: 'policy.engine', label: msgid('Rule engine'), kind: 'select', technical: true, choices: [['inherit', msgid('Distribution setting')], ['On', 'On'], ['DetectionOnly', 'DetectionOnly']] }] }],
  facts: [{ path: 'engineLive.active.modsecurity', label: msgid('ModSecurity active'), format: 'yes-no' }, { path: 'engineLive.engineConf.ruleEngine', label: msgid('Distribution rule engine') }, { path: 'policy.deployedEngine', label: msgid('Deployed rule engine') }],
  tables: [{ title: msgid('Staged rules'), rows: 'policy.staged', empty: msgid('No rule is staged.'), columns: [{ path: 'id', label: msgid('Rule ID'), technical: true }, { path: 'note', label: msgid('Note') }, { path: 'text', label: msgid('Rule'), technical: true }, { path: 'enabled', label: msgid('Enabled'), format: 'yes-no' }], ops: [{ op: 'toggle', path: 'policy.staged', key: 'id', field: 'enabled', label: msgid('Enable or disable') }, { op: 'remove', path: 'policy.staged', key: 'id', label: msgid('Remove') }] },
    { title: msgid('Deployed rules'), rows: 'policy.deployed', empty: msgid('No rule is deployed.'), columns: [{ path: 'id', label: msgid('Rule ID'), technical: true }, { path: 'note', label: msgid('Note') }, { path: 'enabled', label: msgid('Enabled'), format: 'yes-no' }] }],
  buttons: [save, { label: msgid('Deploy and test'), op: 'post', url: '/api/server/sec/waf-rules/deploy', primary: true, revision: true, confirm: msgid('Deploy the staged rules to the web server?') }, { label: msgid('Discard staged changes'), op: 'post', url: '/api/server/sec/waf-rules/discard', revision: true }, refresh] }, {
  id: 'waf-rules-new', title: msgid('Add a rule'), help: msgid('One SecRule or SecAction with its own id from 1 to 99999. Rules that run programs or read other files are refused.'),
  forms: [{ role: 'new', inputs: [number('id', msgid('Rule ID'), 1, 99999), { key: 'note', label: msgid('Note'), kind: 'text' }, { key: 'text', label: msgid('Rule'), kind: 'area', technical: true }] }],
  buttons: [{ label: msgid('Stage rule'), op: 'add', path: 'policy.staged', defaults: { enabled: true } }] }, {
  id: 'waf-hits', title: msgid('Hits'), help: msgid('The most relevant message of each flagged request, newest first, from the ModSecurity audit log.'),
  tables: [{ title: msgid('Hits'), rows: 'observation.hits', empty: msgid('No hit has been recorded.'), columns: [{ path: 'at', label: msgid('Time'), technical: true }, { path: 'clientIp', label: msgid('Client'), technical: true }, { path: 'host', label: msgid('Host'), technical: true }, { path: 'uri', label: msgid('Request'), technical: true }, { path: 'ruleId', label: msgid('Rule ID'), technical: true }, { path: 'message', label: msgid('Message') }, { path: 'disruptive', label: msgid('Blocked'), format: 'yes-no' }] }] }] }

const wafVendors: SvcPanel = { id: 'waf-vendors', tool: 'waf-vendors', read: '/api/server/sec/waf-vendors', put: '/api/server/sec/waf-vendors', sections: [{
  id: 'waf-vendors', title: msgid('Rule vendors'), help: msgid('A vendor is added by the HTTPS URL of its metadata document: a cPanel meta_<vendor>.yaml file with a SHA512 digest, or a JSON document with a SHA-256 digest. The digest pins one archive. Every rule file is checked before it is written, and rules that run programs are refused. Auto-update runs during nightly maintenance.'),
  tables: [{ title: msgid('Vendors'), rows: 'observation.vendorRows', empty: msgid('No vendor has been added.'), columns: [{ path: 'id', label: msgid('Vendor'), technical: true }, { path: 'name', label: msgid('Name') }, { path: 'version', label: msgid('Version'), technical: true }, { path: 'enabled', label: msgid('Enabled'), format: 'yes-no' }, { path: 'autoUpdate', label: msgid('Auto-update'), format: 'yes-no' }], ops: [{ op: 'toggle', path: 'policy.vendors', key: 'id', field: 'enabled', label: msgid('Enable or disable') }, { op: 'toggle', path: 'policy.vendors', key: 'id', field: 'autoUpdate', label: msgid('Auto-update on or off') }, { op: 'post', url: '/api/server/sec/waf-vendors/install', key: 'metadataUrl', arg: 'url', label: msgid('Update now'), revision: true }, { op: 'post', url: '/api/server/sec/waf-vendors/remove', key: 'id', arg: 'id', label: msgid('Remove'), revision: true, confirm: msgid('Remove this vendor and its rule files?') }] },
    { title: msgid('Rule files'), rows: 'observation.files', empty: msgid('No rule file has been read.'), columns: [{ path: 'vendor', label: msgid('Vendor'), technical: true }, { path: 'file', label: msgid('File'), technical: true }, { path: 'enabled', label: msgid('Enabled'), format: 'yes-no' }], ops: [{ op: 'waf-file', label: msgid('Enable or disable') }] }],
  forms: [{ role: 'arg', inputs: [{ key: 'url', label: msgid('Metadata URL'), kind: 'text', technical: true }] }],
  facts: [{ path: 'preview.name', label: msgid('Name') }, { path: 'preview.description', label: msgid('Description') }, { path: 'preview.version', label: msgid('Version') }, { path: 'preview.docsUrl', label: msgid('Documentation') }, { path: 'preview.archiveSha256', label: msgid('Archive SHA-256') }, { path: 'preview.archiveSha512', label: msgid('Archive SHA-512') }],
  buttons: [{ label: msgid('Load preview'), op: 'post', url: '/api/server/sec/waf-vendors/preview' }, { label: msgid('Add vendor'), op: 'post', url: '/api/server/sec/waf-vendors/install', primary: true, revision: true }, refresh] }] }

const changeLog: SvcPanel = { id: 'change-log', tool: 'panel-change-log', read: '/api/server/services/change-log', sections: [{
  id: 'change-log', title: msgid('Change log'), help: msgid('Release notes ship inside the signed release, so these are the notes of the installed version and the versions before it.'),
  facts: [{ path: 'installed', label: msgid('Installed version') }],
  tables: [{ title: msgid('Changes by version'), rows: 'entries', empty: msgid('No release notes are published.'), columns: [{ path: 'version', label: msgid('Version'), technical: true }, { path: 'installed', label: msgid('Installed'), format: 'yes-no' }, { path: 'notes', label: msgid('Changes'), labels: Object.fromEntries(releaseNotes.flatMap(entry => entry.notes).map(note => [note, note])) }] }],
  buttons: [refresh] }] }

const packageCheck: SvcPanel = { id: 'package-check', tool: 'tweak-software', read: '/api/server/services/package-check', sections: [{
  id: 'package-check', title: msgid('Panel file check'), help: msgid('The nightly maintenance run compares the installed panel files with the digests of the signed release manifest. Turn it off under Tweak Settings.'),
  facts: [{ path: 'state', label: msgid('Result'), labels: { clean: msgid('All files match'), modified: msgid('Files differ from the release'), unavailable: msgid('Unavailable') } }, { path: 'release', label: msgid('Release') }, { path: 'checked', label: msgid('Files checked') }, { path: 'at', label: msgid('Checked at (UTC)'), format: 'time' }],
  tables: [{ title: msgid('Modified files'), rows: 'modifiedRows', empty: msgid('No file differs.'), columns: [{ path: 'path', label: msgid('Path'), technical: true }, { path: 'kind', label: msgid('Change'), labels: { modified: msgid('Modified'), missing: msgid('Missing') } }] }],
  buttons: [refresh] }] }

const sourceBuilds: SvcPanel = { id: 'source-builds', tool: 'tweak-software', read: '/api/server/services/source-builds', sections: [{
  id: 'source-builds', title: msgid('Source-built modules'), help: msgid('No Enterprise Linux repository ships these, so the installer builds them from pinned source. After a package update the server rebuilds any that no longer match. While a rebuild is pending or has failed, mail and web keep running: full text search stays off and Apache keeps the module it has. A failed rebuild is tried again every 6 hours.'),
  facts: [{ path: 'hook', label: msgid('Package update hook installed'), format: 'yes-no' }],
  tables: [{ title: msgid('Modules'), rows: 'modules', empty: msgid('Nothing on this server is built from source.'), columns: [{ path: 'id', label: msgid('Module'), labels: { 'mpm-itk': 'Apache mpm-itk', 'fts-xapian': msgid('Dovecot search index plugin'), webalizer: 'Webalizer', awstats: 'AWStats' } },
    { path: 'state', label: msgid('State'), labels: { current: msgid('Matches the installed package'), stale: msgid('Rebuild pending'), rebuilding: msgid('Rebuilding'), rebuild_failed: msgid('Rebuild failed') } },
    { path: 'builtAgainst', label: msgid('Built against'), technical: true }, { path: 'installed', label: msgid('Installed package'), technical: true }, { path: 'failedAt', label: msgid('Last failure (UTC)'), format: 'time' }] }],
  buttons: [refresh] }] }

/** Copy both themes draw around the schema. */
export const SVC_COPY = { notRead: msgid('Not read'), actions: msgid('Actions'), unread: msgid('Nothing has been read yet.') }

/** Panels per route, in page order. A route without an entry draws nothing. */
export const SVC_PANELS: Readonly<Record<string, readonly SvcPanel[]>> = {
  '/whm/monitoring/processes': [processLog, processKiller],
  '/whm/services/web': [webStatus],
  '/whm/software/php': [phpFpm, phpDomains],
  '/whm/software/modules': [pear],
  '/whm/security/isolation': [forkBomb, traceroute],
  '/whm/email/outbound': [smtp, MAIL_CERT_PANELS.outboundSpam],
  '/whm/email/marketing': [MAIL_CERT_PANELS.subscribers, MAIL_CERT_PANELS.campaigns, MAIL_CERT_PANELS.automation],
  '/whm/ssl': [MAIL_CERT_PANELS.autoSsl],
  '/whm/services/certificates': [MAIL_CERT_PANELS.webdiskTls],
  '/whm/dns/providers': [MAIL_CERT_PANELS.providerRecords, MAIL_CERT_PANELS.autoDns],
  '/whm/accounts/templates': [MAIL_CERT_PANELS.notificationTemplates],
  '/whm/security/antivirus': [antivirus],
  '/whm/security/waf': [wafRules, wafVendors],
  '/whm/server/upgrade': [releasePackages, changeLog],
  '/whm/panel/settings': [packageCheck, sourceBuilds],
}

export type SvcTranslate = (text: string) => string
const attr = (name: string, value: string): string => ` ${name}="${escapeHtml(value)}"`
const labels = (t: SvcTranslate, item: SvcFact): string => item.labels ? attr('data-svc-labels', JSON.stringify(Object.fromEntries(Object.entries(item.labels).map(([key, text]) => [key, t(text)])))) : ''
const format = (item: SvcFact): string => item.format ? attr('data-svc-format', item.format) : ''

/** The hooks each theme puts on its own elements. */
export const svcHooks = {
  panel: (panel: SvcPanel, canRead: boolean, canManage: boolean): string => attr('data-svc-panel', panel.id) + attr('data-svc-read', panel.read) + (panel.put ? attr('data-svc-put', panel.put) : '') + attr('data-svc-can-read', String(canRead)) + attr('data-svc-can-manage', String(canRead && canManage)),
  fact: (t: SvcTranslate, fact: SvcFact): string => attr('data-svc-field', fact.path) + format(fact) + labels(t, fact),
  rows: (t: SvcTranslate, table: SvcTable): string => attr('data-svc-rows', table.rows) + attr('data-svc-columns', JSON.stringify(table.columns.map(column => ({ path: column.path, format: column.format ?? 'text', labels: column.labels ? Object.fromEntries(Object.entries(column.labels).map(([key, text]) => [key, t(text)])) : null, technical: column.technical === true }))))
    + attr('data-svc-empty', t(table.empty)) + (table.ops?.length ? attr('data-svc-ops', JSON.stringify(table.ops.map(op => ({ ...op, label: t(op.label), ...('confirm' in op && op.confirm ? { confirm: t(op.confirm) } : {}) })))) : ''),
  input: (form: SvcForm, input: SvcInput): string => attr('data-svc-input', input.key) + attr('data-svc-role', form.role) + attr('data-svc-kind', input.kind),
  button: (t: SvcTranslate, button: SvcButton): string => attr('data-svc-op', button.op) + ('url' in button ? attr('data-svc-url', button.url) : '') + ('path' in button ? attr('data-svc-path', button.path) : '') + ('revision' in button && button.revision ? attr('data-svc-revision', 'true') : '')
    + ('confirm' in button && button.confirm ? attr('data-svc-confirm', t(button.confirm)) : '') + ('reset' in button && button.reset ? attr('data-svc-reset', button.reset.join(',')) : '') + ('extra' in button && button.extra ? attr('data-svc-extra', JSON.stringify(button.extra)) : '') + ('defaults' in button && button.defaults ? attr('data-svc-defaults', JSON.stringify(button.defaults)) : ''),
}
