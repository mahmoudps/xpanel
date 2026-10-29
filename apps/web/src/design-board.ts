import { canOpenRegisteredRoute, navigation, registeredDocumentAliases, visibleRegisteredNavigation, type VisibilityContext } from '@xpanel/catalog'
import { translator, type Locale, type MessageValues } from './i18n.ts'
import { escapeHtml } from './tokens.ts'
import { renderBoardCanvas } from './board-canvas.ts'
import { getSurfaceNavigationLabel } from './shell.ts'

type Copy = string

export interface DesignPage {
  readonly route: string
  readonly surface: 'xpanel' | 'xwhm' | 'xmail'
  readonly group: Copy
  readonly label: Copy
  readonly title: Copy
  readonly lede: Copy
  readonly emptyTitle: Copy
  readonly emptyBody: Copy
  readonly columns: readonly Copy[]
  readonly action: Copy
  /** A qualified catalog page already has a renderer. Unqualified visits still use the empty board. */
  readonly live: boolean
}

export interface DesignPageData<T> {
  readonly wired: boolean
  readonly records: readonly T[]
}

const empty = <T>(): DesignPageData<T> => ({ wired: false, records: [] })

/** One function per unwired board. Replace the body when that tool is connected. */
export const readBackupPage = (): DesignPageData<never> => empty()
export const readDirectoryPrivacyPage = (): DesignPageData<never> => empty()
export const readPanelPhpPage = (): DesignPageData<never> => empty()
export const readHtaccessPage = (): DesignPageData<never> => empty()
export const readCronPage = (): DesignPageData<never> => empty()
export const readDesignSystemPage = (): DesignPageData<never> => empty()
export const readComponentsPage = (): DesignPageData<never> => empty()
export const readNavigationMapPage = (): DesignPageData<never> => empty()
export const readSetupPage = (): DesignPageData<never> => empty()
export const readFeatureListsPage = (): DesignPageData<never> => empty()
export const readWhmDomainsPage = (): DesignPageData<never> => empty()
export const readDnsZonesPage = (): DesignPageData<never> => empty()
export const readWhmSslPage = (): DesignPageData<never> => empty()
export const readWebServerPage = (): DesignPageData<never> => empty()
export const readWhmPhpPage = (): DesignPageData<never> => empty()
export const readSecurityAdvisorPage = (): DesignPageData<never> => empty()
export const readSshPage = (): DesignPageData<never> => empty()
export const readBackupsPage = (): DesignPageData<never> => empty()

const adapters: Readonly<Record<string, () => DesignPageData<never>>> = {
  '/files/backup': readBackupPage,
  '/files/directory-privacy': readDirectoryPrivacyPage,
  '/software/php': readPanelPhpPage,
  '/software/htaccess': readHtaccessPage,
  '/advanced/cron': readCronPage,
  '/design/system': readDesignSystemPage,
  '/design/components': readComponentsPage,
  '/design/navigation': readNavigationMapPage,
  '/whm/server/setup': readSetupPage,
  '/whm/plans/features': readFeatureListsPage,
  '/whm/domains': readWhmDomainsPage,
  '/whm/dns': readDnsZonesPage,
  '/whm/ssl': readWhmSslPage,
  '/whm/services/web': readWebServerPage,
  '/whm/software/php': readWhmPhpPage,
  '/whm/security': readSecurityAdvisorPage,
  '/whm/security/ssh': readSshPage,
  '/whm/backups': readBackupsPage,
}

export const readDesignAdapter = (route: string): DesignPageData<never> => (adapters[route] ?? empty)()

const soon: Copy = msgctxt('design-board', 'Coming soon')
const noneBody: Copy = msgid('This screen is on the server. It stays empty until its tool is connected.')

interface BoardSection {
  readonly title: Copy
  readonly body: Copy
  readonly kind: 'note' | 'table' | 'fields' | 'empty'
  readonly columns?: readonly Copy[]
  readonly fields?: readonly Copy[]
  readonly action?: Copy
}

const section = (
  title: Copy,
  body: Copy,
  kind: BoardSection['kind'],
  extra: { columns?: readonly Copy[]; fields?: readonly Copy[]; action?: Copy } = {},
): BoardSection => ({ title, body, kind, ...extra })

const boardSections: Readonly<Record<string, readonly BoardSection[]>> = {
  '/files/backup': [
    section(msgctxt('design-board', 'What to include'), msgid('Choose home files, databases, mailboxes or mail config. Nothing is selected, and nothing is archived from this screen.'), 'fields', { fields: [msgid('Home directory files'), msgid('Databases'), msgid('Mailboxes'), msgid('Mail config')] }),
    section(msgid('What a restore never does'), msgid('A restore shows the difference first and never deletes a file that is missing from the archive.'), 'note'),
    section(msgid('Where archives live'), msgid('No destination is stored until the backup tool is connected.'), 'empty'),
    section(msgid('Archives'), msgid('No archives yet'), 'table', { columns: [msgid('Archive'), msgid('Created')], action: msgid('Create backup') }),
  ],
  '/files/directory-privacy': [
    section(msgid('Protect a folder'), msgid('No protected directories'), 'fields', { fields: [msgid('Path'), msgid('User'), msgid('Password')], action: msgid('Protect a directory') }),
    section(msgid('Protected directories'), msgid('Protected paths appear here when the tool is connected.'), 'table', { columns: [msgid('Path'), msgid('Users')] }),
  ],
  '/software/php': [
    section(msgid('Domain and version'), msgid('No PHP selection yet'), 'fields', { fields: [msgid('Domain'), msgid('Version'), msgid('Handler')], action: msgid('Save PHP settings') }),
    section(msgctxt('design-board', 'PHP-FPM pool'), msgid('The pool stays unset until a domain has a version.'), 'fields', { fields: [msgid('Mode'), msgid('Max children')] }),
    section(msgid('INI values'), msgid('No directives are stored for this site.'), 'table', { columns: [msgid('Directive'), msgid('Value')] }),
    section(msgid('Running now'), msgid('No process is reporting this selection.'), 'empty'),
    section(msgid('Disabled functions'), msgid('No function list is stored.'), 'table', { columns: [msgid('Function')] }),
  ],
  '/software/htaccess': [
    section('.htaccess', msgid('No .htaccess yet'), 'empty', { action: msgid('Save .htaccess') }),
    section(msgid('PHP settings in .htaccess'), msgid('The editor stays blank until the file tool can read that path.'), 'fields', { fields: ['memory_limit', 'max_execution_time'] }),
    section(msgid('Versions'), msgid('No saved versions yet.'), 'table', { columns: [msgid('Version'), msgid('Saved')] }),
    section(msgid('What a save does'), msgid('Saving writes that one file. It does not run from this empty editor.'), 'note'),
  ],
  '/advanced/cron': [
    section(msgid('How a job runs'), msgid('Each job runs as this account, inside its slice, through its own timer. Jobs share the plan limits.'), 'note'),
    section(msgid('Scheduled jobs'), msgid('No cron jobs yet'), 'table', { columns: [msgid('Job'), msgid('Schedule'), msgid('Command'), msgid('Last run'), msgid('Next run')] }),
    section(msgid('Add a cron job'), msgid('Pick a schedule and a command. Nothing is stored from this empty form.'), 'fields', { fields: [msgid('Common schedules'), msgid('Minute'), msgid('Hour'), msgid('Day'), msgid('Month'), msgid('Weekday'), msgid('Command')], action: msgid('Add a cron job') }),
    section(msgid('Output email'), msgid('No output address is stored.'), 'empty'),
  ],
  '/whm/server/setup': [
    section(msgid('Detected on this host'), msgid('Setup has not run'), 'table', { columns: [msgid('Check'), msgid('Result')], action: msgid('Continue setup') }),
    section(msgid('PHP handlers by engine'), msgid('Handlers appear when the setup tool is connected.'), 'table', { columns: [msgid('Engine'), msgid('Handler')] }),
  ],
  '/whm/plans/features': [
    section(msgid('Lists and the plans that use them'), msgid('No feature lists yet'), 'table', { columns: [msgid('List'), msgid('Plans')], action: msgid('Create list') }),
    section(msgid('Tools by list'), msgid('No tools are assigned until a list exists.'), 'empty'),
    section(msgid('Unsaved changes'), msgid('Nothing is waiting to be saved.'), 'empty'),
    section(msgid('How lists apply'), msgid('Saving a list does not change account data until the tool is connected.'), 'note'),
  ],
  '/whm/domains': [
    section(msgid('Domains'), msgid('No server domains yet'), 'table', { columns: [msgid('Domain'), msgid('Account')], action: msgid('Add domain') }),
    section(msgid('Default site for unbound names'), msgid('The default site is not set from this empty screen.'), 'empty'),
    section(msgid('How a name finds its site'), msgid('No route is stored until the domain tool is connected.'), 'note'),
  ],
  '/whm/services/web': [
    section(msgid('Engine'), msgid('No web server selection is stored.'), 'fields', { fields: [msgid('Engine')] }),
    section('Apache MPM', msgid('No MPM is selected.'), 'empty'),
    section(msgid('Backend connection'), msgid('No backend is stored.'), 'empty'),
    section(msgid('Nginx edge'), msgid('No edge setting is stored.'), 'empty'),
    section(msgctxt('design-board', 'Apache workers'), msgid('No worker row is reported.'), 'table', { columns: [msgid('Setting'), msgid('Value')] }),
    section(msgid('Pending change'), msgid('No pending change'), 'empty', { action: msgid('Apply web server change') }),
    section(msgid('Generations'), msgid('No generations are recorded for the web server.'), 'table', { columns: [msgid('Generation'), msgid('Result')] }),
  ],
  '/whm/software/php': [
    section(msgid('Installed versions'), msgid('No PHP versions reported'), 'table', { columns: [msgid('Version'), msgid('Domains'), msgid('Life')], action: msgid('Install PHP') }),
    section(msgid('Handlers'), msgid('Handlers stay blank until the package tool is connected.'), 'table', { columns: [msgid('Handler'), msgid('Version')] }),
    section(msgid('Configure a version'), msgid('No version is selected.'), 'empty'),
    section(msgid('Dangerous functions'), msgid('No function list is stored.'), 'table', { columns: [msgid('Function')] }),
  ],
  '/whm/ssl': [
    section('AutoSSL', msgid('AutoSSL does not run from this empty queue.'), 'empty', { action: msgid('Queue renewal') }),
    section(msgid('Panel hostname certificate'), msgid('No hostname certificate is stored.'), 'empty'),
    section(msgid('Certificates'), msgid('No certificates yet'), 'table', { columns: [msgid('Certificate'), msgid('Expires')] }),
    section(msgid('Renewal queue'), msgid('The queue is empty.'), 'table', { columns: [msgid('Certificate'), msgid('When')] }),
    section(msgid('Renewal log'), msgid('No renewal has been recorded.'), 'table', { columns: [msgid('When'), msgid('Result')] }),
  ],
  '/whm/dns': [
    section(msgid('Zones'), msgid('No zones yet'), 'table', { columns: [msgid('Zone'), msgid('Serial')], action: msgid('Add a record') }),
    section(msgid('Add a record'), msgid('The record form stays blank until a zone exists.'), 'fields', { fields: [msgid('Name'), msgid('Type'), msgid('Value')] }),
    section(msgid('SOA serial'), msgid('No serial until a zone is stored.'), 'empty'),
    section(msgid('PowerDNS API'), msgid('The DNS tool is not connected.'), 'note'),
  ],
  '/whm/security': [
    section(msgid('Access'), msgid('No panel security policy yet'), 'empty', { action: msgid('Save panel security') }),
    section(msgid('Two-factor for root'), msgid('No second factor is stored for root.'), 'empty'),
    section(msgid('Sign-in lockout'), msgid('No lockout rule is stored.'), 'fields', { fields: [msgid('Attempts'), msgid('Window')] }),
    section(msgid('Locked right now'), msgid('Nobody is locked.'), 'table', { columns: [msgid('Account'), msgid('Until')] }),
    section(msgid('API tokens'), msgid('No tokens are stored.'), 'table', { columns: [msgid('Token'), msgid('State')] }),
    section(msgid('Dangerous PHP functions'), msgid('No function list is stored.'), 'table', { columns: [msgid('Function')] }),
    section(msgid('Compiler lock'), msgid('No compiler exception is stored.'), 'empty'),
  ],
  '/whm/security/ssh': [
    section(msgid('Sign-in settings'), msgid('No SSH policy is stored.'), 'fields', { fields: [msgid('Port'), msgid('Root login'), msgid('Password login')], action: msgid('Save SSH settings') }),
    section(msgid('Effective config'), msgid('The effective file is not loaded.'), 'empty'),
    section(msgctxt('design-board', 'Authorized keys for root'), msgid('No keys are stored.'), 'table', { columns: [msgid('Key'), msgid('Comment')] }),
    section(msgctxt('design-board', 'Failed sign-ins'), msgid('No failed sign-ins are recorded.'), 'table', { columns: [msgid('Address'), msgid('When')] }),
    section(msgid('Banned by SSH'), msgid('No addresses banned by SSH'), 'table', { columns: [msgid('Address'), msgid('State')] }),
  ],
  '/whm/backups': [
    section(msgid('Runs'), msgid('No backup runs yet'), 'table', { columns: [msgid('Run'), msgid('Result')], action: msgid('Start backup') }),
    section(msgctxt('design-board', 'Restore'), msgid('A restore is not offered from an empty history.'), 'empty'),
    section(msgid('What a restore does'), msgid('A restore shows the difference first.'), 'note'),
    section(msgid('Configuration'), msgid('No backup destination is stored.'), 'fields', { fields: [msgctxt('design-board', 'Destination'), msgid('Schedule')] }),
  ],
}

const page = (
  route: string,
  surface: DesignPage['surface'],
  group: Copy,
  label: Copy,
  title: Copy,
  lede: Copy,
  emptyTitle: Copy,
  emptyBody: Copy,
  columns: readonly Copy[],
  action: Copy,
  live = false,
): DesignPage => ({ route, surface, group, label, title, lede, emptyTitle, emptyBody, columns, action, live })

const general: Copy = msgid('General')
const files: Copy = msgid('Files')
const domains: Copy = msgid('Domains')
const databases: Copy = msgid('Databases')
const email: Copy = msgctxt('design-board', 'Email')
const software: Copy = msgid('Software')
const advanced: Copy = msgid('Advanced')
const security: Copy = msgid('Security')
const foundations: Copy = msgid('Foundations')
const server: Copy = msgid('Server')
const accounts: Copy = msgid('Accounts')
const web: Copy = msgid('Web')
const operations: Copy = msgid('Operations')
const mail: Copy = msgid('Mail')

export const designPages: readonly DesignPage[] = [
  page('/home', 'xpanel', general, msgid('Home'), msgid('Home'), msgid('Tools for this account. The plan’s feature list decides which tools appear here.'), msgid('No tools to list yet'), msgid('Tool groups appear when this account’s plan can run them.'), [], msgid('Open a tool'), true),
  page('/resources', 'xpanel', general, msgid('Resources & quotas'), msgid('Resources & quotas'), msgid('Limits on this account’s slice.'), msgid('No measurements yet'), msgid('CPU, memory, IO and process samples appear when the slice reports them.'), [msgid('Limit'), msgid('Value')], msgid('Refresh'), true),
  page('/files/manager', 'xpanel', files, msgid('File manager'), msgid('File manager'), msgid('Files in this account’s home.'), msgid('This directory is empty'), msgid('Nothing is listed until the file tool returns a directory.'), [msgid('Name'), msgid('Size'), msgid('Modified')], msgid('New file'), true),
  page('/files/backup', 'xpanel', files, msgid('Backup wizard'), msgid('Backup wizard'), msgid('Archives for this account.'), msgid('No archives yet'), msgid('A restore never invents files that were not in an archive.'), [msgid('Archive'), msgid('Created')], msgid('Create backup')),
  page('/files/directory-privacy', 'xpanel', files, msgid('Directory privacy'), msgid('Directory privacy'), msgid('Password protection for a directory.'), msgid('No protected directories'), msgid('Protected paths appear here when the tool is connected.'), [msgid('Path'), msgid('Users')], msgid('Protect a directory')),
  page('/domains', 'xpanel', domains, msgid('Domains'), msgid('Domains'), msgid('Names this account serves.'), msgid('No domains yet'), msgid('The primary domain is shown only when the account record includes it.'), [msgid('Domain'), msgid('Kind')], msgid('Create a domain'), true),
  page('/domains/site-settings', 'xpanel', domains, msgid('Site settings'), msgid('Site settings'), msgid('How this name is served.'), msgid('No site configuration yet'), msgid('Document root and handlers appear when a domain is selected.'), [msgid('Setting'), msgid('Value')], msgid('Save'), true),
  page('/domains/zone-editor', 'xpanel', domains, msgid('Zone editor'), msgid('Zone editor'), msgid('DNS records for this account’s zones.'), msgid('No records yet'), msgid('The zone stays empty until a record is stored.'), [msgid('Name'), msgid('Type'), msgid('Value')], msgid('Add a record'), true),
  page('/databases/mariadb', 'xpanel', databases, 'MariaDB', 'MariaDB', msgid('Databases owned by this account.'), msgid('No databases yet'), msgid('Users and privileges appear with the databases that exist.'), [msgid('Database'), msgid('Users')], msgctxt('design-board', 'Create a database'), true),
  page('/email/accounts', 'xpanel', email, msgid('Email & users'), msgctxt('design-board', 'Email and service users'), msgid('Mailboxes and service logins for this account.'), msgid('No service users yet'), msgid('Forwarders and quotas stay blank until a user exists.'), [msgid('Login'), msgid('Services')], msgid('Create a user'), true),
  page('/software/php', 'xpanel', software, 'PHP', 'PHP', msgid('The PHP version and handler for this site.'), msgid('No PHP selection yet'), msgid('Version, pool and ini values appear when the runtime is connected.'), [msgid('Domain'), msgid('Version'), msgid('Handler')], msgid('Save PHP settings')),
  page('/software/htaccess', 'xpanel', software, '.htaccess', msgid('.htaccess editor'), msgid('The .htaccess file for this site.'), msgid('No .htaccess yet'), msgid('The editor stays blank until the file tool can read that path.'), [msgid('Version'), msgid('Saved')], msgid('Save .htaccess')),
  page('/advanced/cron', 'xpanel', advanced, msgctxt('design-board', 'Cron jobs'), msgctxt('design-board:4', 'Cron jobs'), msgid('Scheduled commands for this account.'), msgid('No scheduled jobs'), msgid('A job appears only after it is stored. Nothing runs from this empty list.'), [msgid('Schedule'), msgid('Command')], msgid('Add a cron job')),
  page('/metrics/traffic', 'xpanel', advanced, msgctxt('design-board', 'Metrics'), msgctxt('design-board', 'Metrics'), msgid('Traffic for this account’s sites.'), msgid('No requests logged for this selection yet'), msgid('Visitors, errors and bandwidth stay at zero until logs exist.'), [msgid('Path'), msgid('Requests')], msgid('Refresh'), true),
  page('/security/ssl', 'xpanel', security, 'SSL/TLS', 'SSL/TLS', msgid('Certificates stored for this account.'), msgid('No certificates installed'), msgid('Issuing a certificate needs an ACME client, and that client is not connected yet.'), [msgid('Domain'), msgid('Certificate')], msgid('Run certificate wizard'), true),
  page('/security/account', 'xpanel', security, msgid('Security'), msgid('Account security'), msgid('Sign-in, tokens and site protection for this account.'), msgid('No extra protection yet'), msgid('Tokens and directory rules appear when they are stored.'), [msgid('Item'), msgid('State')], msgid('Add a token'), true),
  page('/design/system', 'xpanel', foundations, msgid('Design system'), msgid('xPanel design system'), msgid('Color, type, buttons, status and fields used by every screen.'), msgid('Reference only'), msgid('These samples are the system. They are not account data.'), [msgid('Token'), msgid('Use')], msgid('Copy token')),
  page('/design/components', 'xpanel', foundations, msgid('Premium components'), msgctxt('design-board', 'Premium components'), msgid('Shared controls: search, progress, skeleton, toast and menus.'), msgid('No live example data'), msgid('Progress and lists stay empty here. Motion still uses the component timings.'), [], msgid('Open quick bar')),
  page('/design/navigation', 'xpanel', foundations, msgid('Navigation map'), msgid('Navigation map'), msgid('The screen index. Opening a row goes to that route.'), msgid('Map'), msgid('Only the screens in this product are linked. Counts are not invented.'), [msgid('Screen'), msgid('Route')], msgid('Filter screens')),
  page('/whm', 'xwhm', server, msgid('Dashboard'), msgid('Server dashboard'), msgid('What this server is doing.'), msgid('No server sample yet'), msgid('CPU, memory, disk and service rows appear when the host reports them.'), [msgid('Resource'), msgid('Value')], msgid('Refresh'), true),
  page('/whm/server/setup', 'xwhm', server, msgid('Setup wizard'), msgid('Set up this server'), msgid('Host detection and the services this panel will manage.'), msgid('Setup has not run'), msgid('Nothing is written until the setup tool is connected.'), [msgid('Check'), msgid('Result')], msgid('Continue setup')),
  page('/whm/accounts', 'xwhm', accounts, msgid('Accounts'), msgid('Accounts'), msgid('Hosting accounts on this server.'), msgid('No accounts yet'), msgid('The list stays empty until an account is stored.'), [msgid('Username'), msgid('Domain'), msgid('Plan')], msgid('Create account'), true),
  page('/whm/accounts/new', 'xwhm', accounts, msgid('Create account'), msgid('Create account'), msgid('Username, primary domain, contact email and plan.'), msgid('Waiting for input'), msgid('Nothing is created from an empty form.'), [], msgid('Create account'), true),
  page('/whm/plans', 'xwhm', accounts, msgid('Plans'), msgid('Plans'), msgid('Hosting plans and the limits they apply.'), msgid('No plans yet'), msgid('Accounts cannot be assigned a plan that is not stored.'), [msgid('Plan'), msgid('Accounts')], msgid('Create plan'), true),
  page('/whm/plans/features', 'xwhm', accounts, msgid('Feature lists'), msgid('Feature lists'), msgid('Which tools a plan shows.'), msgid('No feature lists yet'), msgid('Saving a list does not change account data until the tool is connected.'), [msgid('List'), msgid('Plans')], msgid('Create list')),
  page('/whm/resellers', 'xwhm', accounts, msgid('Resellers'), msgid('Resellers'), msgid('Reseller privileges and the accounts they own.'), msgid('No resellers yet'), msgid('Privileges stay off until a reseller record exists.'), [msgid('Reseller'), msgid('Accounts')], msgid('Create reseller'), true),
  page('/whm/domains', 'xwhm', accounts, msgid('Domains'), msgid('Domains'), msgid('How a name finds its site on this server.'), msgid('No server domains yet'), msgid('The default site for unbound names is not set from this empty screen.'), [msgid('Domain'), msgid('Account')], msgid('Add domain')),
  page('/whm/services/web', 'xwhm', web, msgid('Web server'), msgid('Web server'), msgid('The edge and the backend that serve sites.'), msgid('No pending change'), msgid('Engine, MPM and worker rows appear when the web server tool is connected.'), [msgid('Setting'), msgid('Value')], msgid('Apply web server change')),
  page('/whm/software/php', 'xwhm', web, 'PHP', msgid('PHP versions and handlers'), msgid('Versions installed for this server.'), msgid('No PHP versions reported'), msgid('Handlers and disabled functions stay blank until the package tool is connected.'), [msgid('Version'), msgid('Domains'), msgid('Life')], msgid('Install PHP')),
  page('/whm/ssl', 'xwhm', web, 'SSL/TLS', 'SSL/TLS', msgid('Certificates this server can issue and renew.'), msgid('No certificates yet'), msgid('AutoSSL does not run from this empty queue.'), [msgid('Certificate'), msgid('Expires')], msgid('Queue renewal')),
  page('/whm/dns', 'xwhm', web, msgid('DNS zones'), msgid('DNS zones'), msgid('Zones served by this server.'), msgid('No zones yet'), msgid('Serial and records appear when a zone is stored.'), [msgid('Zone'), msgid('Serial')], msgid('Add a record'), true),
  page('/whm/services', 'xwhm', web, msgid('Services'), msgid('Services'), msgid('Units this panel is allowed to reload.'), msgid('No service report yet'), msgid('A reload is not offered until a unit is observed.'), [msgid('Service'), msgid('State')], msgid('Reload service'), true),
  page('/whm/security/firewall', 'xwhm', security, msgctxt('design-board', 'Firewall'), msgctxt('design-board', 'Firewall'), msgid('The packet rules on this host.'), msgid('No firewall rules yet'), msgid('Saving does nothing until the firewall tool is connected.'), [msgid('Action'), msgid('Port')], msgid('Add a port rule'), true),
  page('/whm/security', 'xwhm', security, msgid('Panel security'), msgid('Panel security'), msgid('Who can reach this panel, and how sign-in is limited.'), msgid('No panel security policy yet'), msgid('Lockouts and tokens stay empty until the advisor is connected.'), [msgid('Check'), msgid('State')], msgid('Save panel security')),
  page('/whm/security/ssh', 'xwhm', security, 'SSH', 'SSH', msgid('Sign-in settings for the host shell.'), msgid('No addresses banned by SSH'), msgid('Keys and failed sign-ins appear when the SSH tool is connected.'), [msgid('Address'), msgid('State')], msgid('Save SSH settings')),
  page('/whm/backups', 'xwhm', operations, msgctxt('design-board', 'Backups'), msgid('Server backups'), msgid('Backup runs for this server.'), msgid('No backup runs yet'), msgid('A restore is not offered from an empty history.'), [msgid('Run'), msgid('Result')], msgid('Start backup'), true),
  page('/whm/monitoring/server-info', 'xwhm', server, msgid('Server information'), msgid('Server information'), msgid('Load, memory and disk from this host.'), msgid('No host sample yet'), msgid('Readings appear when the host answers.'), [], msgid('Refresh'), true),
  page('/whm/transfers', 'xwhm', operations, msgid('Transfer tool'), msgid('Transfer tool'), msgid('Move an account from another server or a backup.'), msgid('No transfer is running'), msgid('Import stays disabled until the transfer tool is connected.'), [msgid('Source'), msgid('State')], msgid('Start transfer'), true),
  page('/whm/server/upgrade', 'xwhm', operations, msgid('Upgrade'), msgid('Upgrade'), msgid('A newer panel build, when one is published.'), msgid('No upgrade is queued'), msgid('Preflight stays unread until the upgrade tool reports a version.'), [msgid('Version'), msgid('Result')], msgid('Check upgrade'), true),
  page('/whm/audit', 'xwhm', operations, msgid('Audit log'), msgid('Audit log'), msgid('Actions recorded for this server.'), msgid('No audit entries yet'), msgid('Generations appear beside the entries that produced them.'), [msgid('When'), msgid('Actor'), msgid('Action')], msgid('Refresh'), true),
  page('/mail/inbox', 'xmail', mail, msgid('Inbox'), msgctxt('design-board', 'Inbox'), msgid('Messages observed for this mailbox.'), msgid('No messages in this folder.'), msgid('Folders and unread counts are not invented.'), [msgid('From'), msgid('Subject')], msgid('Refresh'), true),
  page('/mail/compose', 'xmail', mail, msgctxt('design-board', 'Compose'), msgid('New message'), msgid('Write a message from this mailbox.'), msgid('Sending is not connected'), msgid('This screen does not submit a message.'), [], msgid('Send'), true),
]

const byRoute = new Map(designPages.map(item => [item.route, item]))

/** Specimen routes. They stay out of the product sidebar unless a development checkout sets this flag. Release builds leave it unset. */
const REFERENCE_DESIGN_ROUTES = new Set(['/design/system', '/design/components', '/design/navigation'])

export const designReferenceRoutesEnabled = (): boolean => process.env.XPANEL_DESIGN_PAGES === '1'

const productDesignPages = (): readonly DesignPage[] =>
  designReferenceRoutesEnabled() ? designPages : designPages.filter(item => !REFERENCE_DESIGN_ROUTES.has(item.route))

export const designPage = (route: string): DesignPage | undefined => byRoute.get(route)

export const designHeading = (route: string, locale: Locale): string | undefined => {
  const item = byRoute.get(route)
  if (!item || item.live) return undefined
  return translator(locale)(item.title)
}

const copy = (value: Copy, locale: Locale): string => translator(locale)(value)

export const renderDesignNav = (surface: DesignPage['surface'], locale: Locale, activeRoute: string, qualifiedRoutes: ReadonlySet<string>, visibility?: VisibilityContext): string => {
  const admittedRoutes = new Set(visibleRegisteredNavigation(visibility).filter(item => item.surface === surface).flatMap(item => item.sections.flatMap(section => section.pages.map(page => page.route))))
  const pages = productDesignPages().filter(item => item.surface === surface && admittedRoutes.has(item.route))
  const groups: { name: string; id: string; items: DesignPage[] }[] = []
  for (const item of pages) {
    const name = copy(item.group, locale)
    const existing = groups.find(group => group.name === name)
    if (existing) existing.items.push(item)
    else groups.push({ name, id: `${surface}-${groups.length}`, items: [item] })
  }
  const soonLabel = copy(soon, locale)
  return `<nav class="xp-nav-groups" aria-label="${escapeHtml(surface === 'xwhm' ? 'xWHM' : surface === 'xmail' ? 'xMail' : 'xPanel')}">${groups.map(group => `<div class="xp-nav-group" data-nav-section="${escapeHtml(group.id)}"><span class="xp-nav-group__label" id="${escapeHtml(group.id)}">${escapeHtml(group.name)}</span><ul class="xp-nav-group__items" aria-labelledby="${escapeHtml(group.id)}">${group.items.map(item => {
    const current = item.route === activeRoute
    const live = item.live && qualifiedRoutes.has(item.route)
    const label = copy(item.label, locale)
    const security = item.route === '/security/account' || item.route === '/whm/security'
    return `<li><a class="xp-nav-item${current ? ' xp-nav-item--active' : ''}${item.route === '/mail/compose' ? ' xp-mail-compose-link' : ''}" href="${escapeHtml(item.route)}" data-nav-route="${escapeHtml(item.route)}" data-nav-wiring="${live ? 'live' : 'soon'}"${security ? ' data-security-link="true"' : ''}${current ? ' aria-current="page"' : ''}><span>${escapeHtml(label)}</span>${live ? '' : `<span class="xp-nav-soon">${escapeHtml(soonLabel)}</span>`}</a></li>`
  }).join('')}</ul></div>`).join('')}</nav>`
}

const disabledControl = (id: string, label: string): string => `<div class="xp-field"><label for="${escapeHtml(id)}">${escapeHtml(label)}</label><input id="${escapeHtml(id)}" type="text" value="" disabled data-wiring="soon"></div>`

/** Empty document for a registered route without a dedicated data adapter. */
export const renderDisabledScreen = (title: string, locale: Locale): string => {
  const label = copy(soon, locale), body = copy(noneBody, locale)
  return `<section class="xp-design-page" data-wiring="soon" data-catalog-screen="true"><header class="xp-board-head"><div><h1 class="xp-page-title">${escapeHtml(title)}</h1><p class="xp-prose xp-design-page__lede">${escapeHtml(body)}</p></div><div class="xp-board-actions"><button type="button" class="xp-btn xp-btn--primary" disabled data-wiring="soon">${escapeHtml(label)}</button><p class="xp-help" data-wiring-hint="soon">${escapeHtml(label)}</p></div></header><div class="xp-design-empty" role="status"><h2>${escapeHtml(label)}</h2><p class="xp-prose">${escapeHtml(body)}</p></div></section>`
}

const renderBoardSection = (route: string, block: BoardSection, index: number, locale: Locale): string => {
  const title = copy(block.title, locale)
  const headingId = `${route.replace(/[^a-z0-9]+/gi, '-')}-s${index}`
  const action = block.action
    ? `<button type="button" class="xp-btn xp-btn--primary" disabled data-wiring="soon">${escapeHtml(copy(block.action, locale))}</button><p class="xp-help" data-wiring-hint="soon">${escapeHtml(copy(soon, locale))}</p>`
    : ''
  if (block.kind === 'note') {
    return `<aside class="xp-board-note" role="note"><h2 id="${escapeHtml(headingId)}">${escapeHtml(title)}</h2><p class="xp-prose">${escapeHtml(copy(block.body, locale))}</p></aside>`
  }
  const columns = block.columns ?? []
  const table = block.kind === 'table'
    ? `<div class="xp-table-wrap"><table class="xp-table" aria-labelledby="${escapeHtml(headingId)}"><thead><tr>${columns.map(column => `<th>${escapeHtml(copy(column, locale))}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${Math.max(columns.length, 1)}">${escapeHtml(copy(block.body, locale))}</td></tr></tbody></table></div>`
    : ''
  const fields = block.kind === 'fields'
    ? `<div class="xp-board-fields">${(block.fields ?? []).map((field, fieldIndex) => disabledControl(`${headingId}-f${fieldIndex}`, copy(field, locale))).join('')}</div>`
    : ''
  const empty = block.kind === 'empty' || block.kind === 'fields'
    ? `<div class="xp-design-empty" role="status"><h3>${escapeHtml(copy(block.body, locale))}</h3>${action}</div>`
    : action ? `<div class="xp-board-actions">${action}</div>` : ''
  return `<section class="xp-board-section" aria-labelledby="${escapeHtml(headingId)}"><header class="xp-board-section__head"><h2 id="${escapeHtml(headingId)}">${escapeHtml(title)}</h2></header><div class="xp-board-section__body">${table}${fields}${empty}</div></section>`
}

const renderTokenBoard = (locale: Locale): string => {
  const swatches: readonly [string, string, string][] = [
    ['#F5F6F8', translator(locale)('Canvas'), 'canvas'],
    ['#101828', translator(locale)('Text'), 'text'],
    ['#1D5BD6', translator(locale)('Accent'), 'accent'],
    ['#0E7A4E', translator(locale)('Ok'), 'ok'],
    ['#B54708', translator(locale)('Warn'), 'warn'],
    ['#B42318', translator(locale)('Critical'), 'critical'],
  ]
  return `<section class="xp-board-section" aria-labelledby="design-color"><header class="xp-board-section__head"><h2 id="design-color">${escapeHtml(translator(locale)('Color'))}</h2></header><div class="xp-board-section__body"><ul class="xp-swatches">${swatches.map(([color, name, id]) => `<li><span class="xp-swatch" style="background:${color}" data-token="${id}"></span><span>${escapeHtml(name)}</span><code><bdi dir="ltr">${color}</bdi></code></li>`).join('')}</ul></div></section>
  <section class="xp-board-section" aria-labelledby="design-type"><header class="xp-board-section__head"><h2 id="design-type">${escapeHtml(translator(locale)(msgctxt('design-board', 'Type')))}</h2></header><div class="xp-board-section__body"><p class="xp-type-sample xp-type-sample--page">${escapeHtml(translator(locale)('Page title'))}</p><p class="xp-type-sample">${escapeHtml(translator(locale)(msgctxt('design-board', 'Body')))}</p><p class="xp-mono">IBM Plex Mono</p></div></section>
  <section class="xp-board-section" aria-labelledby="design-buttons"><header class="xp-board-section__head"><h2 id="design-buttons">${escapeHtml(translator(locale)('Buttons'))}</h2></header><div class="xp-board-section__body xp-board-actions"><button type="button" class="xp-btn xp-btn--primary">${escapeHtml(translator(locale)('Primary'))}</button><button type="button" class="xp-btn">${escapeHtml(translator(locale)('Secondary'))}</button><button type="button" class="xp-btn" disabled data-wiring="soon">${escapeHtml(translator(locale)('Disabled'))}</button></div></section>
  <section class="xp-board-section" aria-labelledby="design-meter"><header class="xp-board-section__head"><h2 id="design-meter">${escapeHtml(translator(locale)('Progress'))}</h2></header><div class="xp-board-section__body"><div class="xp-meter__track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="${escapeHtml(translator(locale)('Empty'))}"><span class="xp-meter__fill" style="width:0%"></span></div><div class="xp-meter__track" aria-hidden="true"><span class="xp-meter__indet"></span></div><div class="xp-skeleton" aria-hidden="true"></div></div></section>`
}

const renderReferenceDetails = (locale: Locale): string => {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(locale)(message, values))
  const specimen = (id: string, title: string, body: string): string => `<section class="xp-board-section" data-component-specimen="${id}" aria-labelledby="comp-${id}"><header class="xp-board-section__head"><h2 id="comp-${id}">${t(title)}</h2></header><div class="xp-board-section__body">${body}</div></section>`
  const disabledButton = (message: string): string => `<button type="button" class="xp-btn" disabled>${t(message)}</button>`
  const quickPages = navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.filter(page => ['/whm/accounts', '/domains', '/software/php'].includes(page.route)).map(page => ({ surface: surface.surface, page }))))
  return `<aside class="xp-board-note" role="note"><h2>${t('Component specimens')}</h2><p>${t('These examples describe interface states. They do not authenticate, write a file, transfer data, or report a real host operation.')}</p></aside>
  ${specimen('quickbar', 'Quick bar, favorites and recents', `<div class="xp-field"><label for="spec-quickbar">${t('Search tools, accounts and domains')}</label><input class="xp-input" id="spec-quickbar" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="spec-quickbar-results" type="search" disabled></div><div id="spec-quickbar-results" role="listbox" aria-label="${t('Registered pages')}">${quickPages.map(({ surface, page }) => `<div role="option" aria-selected="false"><span>${escapeHtml(getSurfaceNavigationLabel(surface, 'page', page, locale))}</span> <bdi dir="ltr">${escapeHtml(page.route)}</bdi></div>`).join('')}</div><p><kbd>↑</kbd> <kbd>↓</kbd> ${t(msgctxt('design-board', 'move'))} · <kbd>Enter</kbd> ${t(msgctxt('design-board', 'open'))} · <kbd>Esc</kbd> ${t('close')}</p><dl class="xp-board-stats"><div><dt>${t('Favorites')}</dt><dd>${t('Saved by the user')}</dd></div><div><dt>${t('Recent pages')}</dt><dd>${t('Recorded after navigation')}</dd></div></dl>`)}
  ${specimen('verification', 'Verification code and recovery', `<div class="xp-field"><label for="spec-otp">${t('Verification code')}</label><input class="xp-input" id="spec-otp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" disabled aria-describedby="spec-otp-note"><p id="spec-otp-note" class="xp-help">${t('Paste and password managers remain available in the actual sign-in flow. Enrollment is optional.')}</p></div>${disabledButton('Use a recovery code')}`)}
  ${specimen('steps', 'Tabs and workflow steps', `<div class="xp-board-actions" role="tablist" aria-label="${t('Site configuration')}">${[msgid('Domains'), msgid('Rewrite'), msgctxt('design-board', 'Proxy')].map((label, index) => `<button type="button" class="xp-btn" role="tab" aria-selected="${index === 0}" disabled>${t(label)}</button>`).join('')}</div><ol class="xp-board-steps"><li><span>1</span><span>${t('Source')}</span></li><li aria-current="step"><span>2</span><span>${t('Names and type')}</span></li><li><span>3</span><span>${t('Validation')}</span></li></ol>`)}
  ${specimen('table', 'Dense table and selection', `<div class="xp-table-wrap"><table class="xp-table"><caption class="sr-only">${t('Table structure')}</caption><thead><tr><th scope="col"><input type="checkbox" disabled aria-label="${t('Select all')}"></th><th scope="col">${t('Account')}</th><th scope="col">${t('Domain')}</th><th scope="col">${t('Plan')}</th><th scope="col">${t('Status')}</th></tr></thead><tbody><tr><td colspan="5">${t('No host records are loaded in this specimen.')}</td></tr></tbody></table></div><div class="xp-board-actions">${disabledButton('Previous')}${disabledButton('Next')}</div>`)}
  ${specimen('upload', 'Upload, progress and cancellation', `<div class="xp-dropzone"><p>${t('Drop files here or use the file picker.')}</p><label for="spec-upload">${t('Choose files')}</label><input id="spec-upload" type="file" disabled></div><p role="status">${t('No upload is in progress.')}</p><div class="xp-meter__track" role="progressbar" aria-label="${t('Upload progress specimen')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="xp-meter__fill" style="width:0%"></span></div>${disabledButton('Cancel upload')}`)}
  ${specimen('drawer', 'Drawer and confirmation', `<details><summary>${t('Open drawer specimen')}</summary><div class="xp-board-section__body"><h3>${t('Review the selected record')}</h3><p>${t('The real drawer preserves context, keyboard focus and a close action. No record is selected here.')}</p><div class="xp-field"><label for="spec-confirm">${t('Type the account name to confirm')}</label><input class="xp-input" id="spec-confirm" disabled></div><div class="xp-board-actions">${disabledButton('Keep account')}${disabledButton('Confirm action')}</div></div></details>`)}
  ${specimen('errors', 'Validation and operation feedback', `<div class="xp-field"><label for="spec-invalid">${t('Primary domain')}</label><input class="xp-input" id="spec-invalid" aria-invalid="true" aria-describedby="spec-invalid-help" disabled><p id="spec-invalid-help" class="xp-help">${t('A validation error identifies the affected field and explains how to correct it.')}</p></div><aside role="note"><p>${t('Pending work remains pending until its target is verified. A transport failure does not imply that the action completed.')}</p></aside>`)}
  ${specimen('code', 'Configuration block and technical values', `<pre class="xp-board-code"><code><bdi dir="ltr"># ${t('Configuration appears after an authorized read.')}</bdi></code></pre><p>${t('Paths, addresses and references keep their own direction inside the surrounding locale.')}</p>`)}
  ${specimen('shortcuts', 'Keyboard shortcuts', `<dl class="xp-board-stats"><div><dt>${t('Find a page')}</dt><dd><kbd>Ctrl</kbd> + <kbd>K</kbd></dd></div><div><dt>${t('Close a panel')}</dt><dd><kbd>Esc</kbd></dd></div><div><dt>${t('Move through controls')}</dt><dd><kbd>Tab</kbd></dd></div></dl>`)} `
}


const renderComponentBoard = (locale: Locale): string => {
  const t = (message: string, values?: MessageValues) => escapeHtml(translator(locale)(message, values))
  const spinner = `<svg class="xp-status-icon xp-status-icon--spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1D5BD6" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9"></path></svg>`
  return `<section class="xp-board-section" aria-labelledby="comp-buttons"><header class="xp-board-section__head"><h2 id="comp-buttons">${t('Buttons')}</h2></header><div class="xp-board-section__body xp-board-actions"><button type="button" class="xp-btn xp-btn--primary">${t('Primary')}</button><button type="button" class="xp-btn">${t('Secondary')}</button><button type="button" class="xp-btn xp-btn--danger">${t('Danger')}</button><button type="button" class="xp-btn xp-btn--quiet">${t('View log')}</button><button type="button" class="xp-btn" disabled>${t('Disabled')}</button></div></section>
  <section class="xp-board-section" aria-labelledby="comp-pressed"><header class="xp-board-section__head"><h2 id="comp-pressed">${t('Pressed, switch, and segmented')}</h2></header><div class="xp-board-section__body"><div class="xp-board-actions"><button type="button" class="xp-chip" aria-pressed="true">${t('Pressed')}</button><button type="button" class="xp-chip" aria-pressed="false">${t('Idle')}</button></div><div class="xp-board-actions"><button type="button" class="xp-switch" role="switch" aria-checked="true" aria-label="${t('On')}"></button><button type="button" class="xp-switch" role="switch" aria-checked="false" aria-label="${t('Off')}"></button></div><div class="xp-segment" role="radiogroup" aria-label="${t('Segmented control')}"><button type="button" role="radio" aria-checked="false">${t('First')}</button><button type="button" role="radio" aria-checked="true">${t('Selected')}</button><button type="button" role="radio" aria-checked="false">${t('Last')}</button></div></div></section>
  <section class="xp-board-section" aria-labelledby="comp-choice"><header class="xp-board-section__head"><h2 id="comp-choice">${t('Radio cards')}</h2></header><div class="xp-board-section__body"><label class="xp-radio-card"><input type="radio" name="specimen-choice" checked>${t('Selected')}</label><label class="xp-radio-card"><input type="radio" name="specimen-choice">${t('Unselected')}</label><label class="xp-radio-card"><input type="radio" name="specimen-choice" disabled>${t('Unavailable')}</label></div></section>
  <section class="xp-board-section" aria-labelledby="comp-fields"><header class="xp-board-section__head"><h2 id="comp-fields">${t('Empty, disabled, error, and focus')}</h2></header><div class="xp-board-section__body"><label for="specimen-empty">${t('Empty')}</label><input id="specimen-empty" class="xp-specimen" value=""><label for="specimen-disabled">${t('Disabled')}</label><input id="specimen-disabled" class="xp-specimen" value="" disabled placeholder="${t('Disabled')}"><label for="specimen-error">${t('Error')}</label><input id="specimen-error" class="xp-specimen" value="" aria-invalid="true" aria-describedby="specimen-error-text"><p id="specimen-error-text" class="xp-field-error">${t('This value is not valid.')}</p><div class="xp-focus-sample">${t('Focus')}</div></div></section>
  <section class="xp-board-section" aria-labelledby="comp-tabs"><header class="xp-board-section__head"><h2 id="comp-tabs">${t('Tabs')}</h2></header><div class="xp-board-section__body"><div class="xp-tabs" role="tablist"><button type="button" role="tab" aria-selected="true">${t('Selected')}</button><button type="button" role="tab" aria-selected="false">${t(msgctxt('design-board', 'Idle'))}</button></div></div></section>
  <section class="xp-board-section" aria-labelledby="comp-progress"><header class="xp-board-section__head"><h2 id="comp-progress">${t('Progress, quota, and loading')}</h2></header><div class="xp-board-section__body"><div class="xp-meter__track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="${t('Empty')}"><span class="xp-meter__fill" style="width:0%"></span></div><div class="xp-meter__track" role="progressbar" aria-label="${t('Below 80%')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40"><span class="xp-meter__fill xp-meter__fill--ok" style="width:40%"></span></div><div class="xp-meter__track" role="progressbar" aria-label="${t('At 80%')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="80"><span class="xp-meter__fill xp-meter__fill--warn" style="width:80%"></span></div><div class="xp-meter__track" role="progressbar" aria-label="${t('At 95%')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="95"><span class="xp-meter__fill xp-meter__fill--critical" style="width:95%"></span></div><div class="xp-meter__track" role="progressbar" aria-busy="true" aria-label="${t('Indeterminate')}"><span class="xp-meter__indet"></span></div><div class="xp-meter__track xp-meter__track--compact" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="${t('Empty')}"><span class="xp-meter__fill" style="width:0%"></span></div><p role="status">${spinner} ${t('Saving')}</p></div></section>
  <section class="xp-board-section" aria-labelledby="comp-skeleton"><header class="xp-board-section__head"><h2 id="comp-skeleton">${t('Skeleton loading')}</h2></header><div class="xp-board-section__body"><div class="xp-skeleton-stack" aria-busy="true" aria-label="${t('Loading')}">${[0, 1, 2].map(() => `<div class="xp-skeleton-row"><span class="xp-skeleton xp-skeleton-avatar"></span><span class="xp-skeleton-copy"><span class="xp-skeleton xp-skeleton-line"></span><span class="xp-skeleton xp-skeleton-line xp-skeleton-line--short"></span></span><span class="xp-skeleton xp-skeleton-pill"></span></div>`).join('')}</div></div></section>
  <section class="xp-board-section" aria-labelledby="comp-toast"><header class="xp-board-section__head"><h2 id="comp-toast">${t('Toasts')}</h2></header><div class="xp-board-section__body"><div class="xp-card xp-toast" role="status"><div class="xp-toast__body xp-toast__row"><span class="xp-toast__mark xp-toast__mark--ok" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 12l5 5 9-10"></path></svg></span><p>${t('No success notice is waiting.')}</p></div></div><div class="xp-card xp-toast" role="alert" data-toast-level="critical"><div class="xp-toast__body xp-toast__row"><span class="xp-toast__mark xp-toast__mark--critical" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 7v6M12 17h.01"></path></svg></span><p>${t('No error notice is waiting.')}</p></div></div><div class="xp-card xp-toast xp-toast--undo" role="status"><p class="xp-toast__body">${t('No action is waiting to undo.')}</p><span class="xp-toast__drain" aria-hidden="true"></span></div></div></section>
  <section class="xp-board-section" aria-labelledby="comp-empty"><header class="xp-board-section__head"><h2 id="comp-empty">${t('Empty and drop zone')}</h2></header><div class="xp-board-section__body"><div class="xp-design-empty" role="status"><h3>${t('Nothing here yet')}</h3><p>${t('This region stays empty until a tool is connected.')}</p></div><div class="xp-dropzone"><span>${t('Drop files here')}</span><button type="button" class="xp-btn xp-btn--quiet">${t('Browse')}</button></div></div></section>${renderReferenceDetails(locale)}`
}

// A reference map lists every panel's routes as text: one panel's page never links to another panel's routes.
const renderNavigationMap = (locale: Locale): string => {
  const title = (message: string, values?: MessageValues): string => escapeHtml(translator(locale)(message, values))
  const count = navigation.reduce((total, surface) => total + surface.sections.reduce((subtotal, section) => subtotal + section.pages.length, 0), 0)
  const notice = `<aside class="xp-board-note" role="note"><h2>${title('Registered navigation')}</h2><p>${count} ${title('registered pages. Route registration does not grant access or certify that its host capability is available.')}</p></aside>`
  const groups = navigation.map(surface => `<section class="xp-board-section" data-reference-surface="${surface.surface}"><header class="xp-board-section__head"><h2>${surface.surface === 'xwhm' ? 'xWHM' : surface.surface === 'xmail' ? 'xMail' : 'xPanel'}</h2></header><div class="xp-board-section__body">${surface.sections.map(section => `<section aria-labelledby="map-${surface.surface}-${escapeHtml(section.id)}"><h3 id="map-${surface.surface}-${escapeHtml(section.id)}">${escapeHtml(getSurfaceNavigationLabel(surface.surface, 'section', section, locale))}</h3><div class="xp-table-wrap"><table class="xp-table"><thead><tr><th scope="col">${title('Page')}</th><th scope="col">${title('Route')}</th><th scope="col">${title('Layout')}</th><th scope="col">${title('Required roles')}</th></tr></thead><tbody>${section.pages.map(page => `<tr data-reference-route="${escapeHtml(page.route)}"><td>${escapeHtml(getSurfaceNavigationLabel(surface.surface, 'page', page, locale))}</td><td><bdi dir="ltr">${escapeHtml(page.route)}</bdi></td><td><bdi dir="ltr">${escapeHtml(page.template)}</bdi></td><td><bdi dir="ltr">${escapeHtml(page.roles.join(', '))}</bdi></td></tr>`).join('')}</tbody></table></div></section>`).join('')}</div></section>`).join('')
  const aliases = `<section class="xp-board-section"><header class="xp-board-section__head"><h2>${title('Additional document destinations')}</h2></header><div class="xp-table-wrap"><table class="xp-table"><thead><tr><th scope="col">${title('Route')}</th><th scope="col">${title('Parent page')}</th></tr></thead><tbody>${registeredDocumentAliases.map(alias => `<tr><td><bdi dir="ltr">${escapeHtml(alias.route)}</bdi></td><td><bdi dir="ltr">${escapeHtml(alias.parentRoute)}</bdi></td></tr>`).join('')}</tbody></table></div></section>`
  return `${notice}${groups}${aliases}`
}

export const renderHomeToolGrid = (locale: Locale, qualifiedRoutes: ReadonlySet<string>): string => {
  const pages = productDesignPages().filter(item => item.surface === 'xpanel' && item.route !== '/home' && item.group[0] !== 'Foundations')
  const groups: { name: string; items: DesignPage[] }[] = []
  for (const item of pages) {
    const name = copy(item.group, locale)
    const existing = groups.find(group => group.name === name)
    if (existing) existing.items.push(item)
    else groups.push({ name, items: [item] })
  }
  const soonLabel = copy(soon, locale)
  return `<div class="xp-home-tools">${groups.map(group => `<section class="xp-board-section xp-tool-card" data-tool-card="true"><header class="xp-board-section__head"><h3>${escapeHtml(group.name)}</h3></header><ul class="xp-home-tool-list">${group.items.map(item => {
    const wired = item.live && qualifiedRoutes.has(item.route)
    return `<li><a class="xp-home-tool" href="${escapeHtml(item.route)}"><span>${escapeHtml(copy(item.label, locale))}</span>${wired ? '' : `<span class="xp-nav-soon">${escapeHtml(soonLabel)}</span>`}</a></li>`
  }).join('')}</ul></section>`).join('')}</div>`
}

export const renderDesignMain = (route: string, locale: Locale): string => {
  if (REFERENCE_DESIGN_ROUTES.has(route) && !designReferenceRoutesEnabled()) return ''
  const item = byRoute.get(route)
  if (!item) return ''
  const data = readDesignAdapter(route)
  const records = data.wired ? data.records : []
  const canvas = renderBoardCanvas(route, locale)
  const sections = canvas ? [] : (boardSections[route] ?? [])
  const crumb = `<nav class="xp-board-crumb" aria-label="${escapeHtml(translator(locale)('Breadcrumb'))}"><ol><li>${escapeHtml(copy(item.group, locale))}</li><li aria-current="page">${escapeHtml(copy(item.label, locale))}</li></ol></nav>`
  const mapped = route === '/design/navigation' ? renderNavigationMap(locale) : ''
  const foundation = route === '/design/system' ? renderTokenBoard(locale) : route === '/design/components' ? renderComponentBoard(locale) : ''
  const blocks = canvas || sections.map((block, index) => renderBoardSection(route, block, index, locale)).join('')
  const fallback = canvas || sections.length || mapped || foundation ? '' : `<div class="xp-design-empty" role="status"><h2>${escapeHtml(copy(item.emptyTitle, locale))}</h2><p class="xp-prose">${escapeHtml(copy(records.length ? noneBody : item.emptyBody, locale))}</p><button type="button" class="xp-btn xp-btn--primary" disabled data-wiring="soon">${escapeHtml(copy(item.action, locale))}</button><p class="xp-help" data-wiring-hint="soon">${escapeHtml(copy(soon, locale))}</p></div>`
  const headerAction = canvas || sections.some(block => block.action) ? '' : `<button type="button" class="xp-btn xp-btn--primary" disabled data-wiring="soon">${escapeHtml(copy(item.action, locale))}</button><p class="xp-help" data-wiring-hint="soon">${escapeHtml(copy(soon, locale))}</p>`
  return `<section class="xp-design-page" data-design-page="${escapeHtml(route)}" data-design-adapter="${escapeHtml(route)}" data-wiring="${data.wired && records.length ? 'live' : 'soon'}">
    <header class="xp-board-head">
      <div>
        ${crumb}
        <h1 class="xp-page-title">${escapeHtml(copy(item.title, locale))}</h1>
        <p class="xp-prose xp-design-page__lede">${escapeHtml(copy(item.lede, locale))}</p>
      </div>
      <div class="xp-board-actions">${headerAction}</div>
    </header>
    ${foundation}${mapped}${blocks}${fallback}
  </section>`
}
