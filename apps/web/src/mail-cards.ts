import type { Translate } from './i18n.ts'

/**
 * The mail tools added to the existing WHM, xPanel and xMail mail pages, as data. Each theme renders the same cards with its
 * own markup and styles, and mail-cards-client.ts binds them through the same data hooks.
 */
export interface MailCardField { key: string; label: string; kind: 'text' | 'number' | 'lines' | 'select' | 'check' | 'file'; help?: string; options?: readonly (readonly [string, string])[]; min?: number; max?: number; ltr?: boolean; accept?: string }
export interface MailCardTable { key: string; caption: string; columns: readonly string[]; slots: readonly string[] }
export interface MailCardAction { key: string; label: string; tone?: 'primary' | 'danger'; write?: boolean }
export interface MailCard {
  id: string; title: string; lede: string; unread: string; canRead: boolean; canAct: boolean
  facts: readonly (readonly [string, string])[]; fields: readonly MailCardField[]; tables: readonly MailCardTable[]; actions: readonly MailCardAction[]
  notes: readonly string[]; list?: { key: string; label: string }
}
/** `domains` are the account's own domain names, already read by the page. */
export interface MailCardAccess { canRead: boolean; canAct: (tool: string) => boolean; domains?: readonly string[] }
type Base = Omit<MailCard, 'canRead' | 'canAct' | 'facts' | 'fields' | 'tables' | 'actions' | 'notes'> & Partial<Pick<MailCard, 'facts' | 'fields' | 'tables' | 'actions' | 'notes'>>

const ranges = (t: Translate): readonly (readonly [string, string])[] => [['1', t('Last hour')], ['6', t('Last 6 hours')], ['24', t('Last 24 hours')], ['72', t('Last 3 days')], ['168', t('Last 7 days')]]

export function mailCardsFor(route: string, t: Translate, access: MailCardAccess): MailCard[] {
  const card = (tool: string, base: Base): MailCard => ({ facts: [], fields: [], tables: [], actions: [], notes: [], ...base, canRead: access.canRead, canAct: access.canRead && access.canAct(tool) })
  const hosted = [['observed', t('Observed at (UTC)')], ['window', t('Window (UTC)')]] as const
  const owned = (access.domains ?? []).map(name => [name, name] as const)
  switch (route) {
    case '/whm/email/delivery': return [card('mail-troubleshooter', { id: 'mail-trace', title: t('Mail route troubleshooter'), lede: t('Traces how this server would route mail to one address and names the step that fails. No message is sent.'), unread: t('Enter an address to trace its route.'),
      fields: [{ key: 'address', label: t('Destination address'), kind: 'text', ltr: true }], actions: [{ key: 'run', label: t('Trace route'), tone: 'primary' }],
      facts: [['route', t('Route')], ['result', t('Result')], ['dnssec', t('DNSSEC')], ['relay', t('Smart host')], ['destination', t('Delivers to')]],
      tables: [{ key: 'steps', caption: t('Route steps'), columns: [t('Step'), t('Result'), t('Reason')], slots: ['step', 'state', 'reason'] }, { key: 'hosts', caption: t('Receiving hosts'), columns: [t('Host'), t('Priority'), t('Addresses'), t('Greeting')], slots: ['host', 'priority', 'addresses', 'connected'] }],
      notes: [t('DNSSEC shows what this server\'s resolver reports. A resolver that does not validate reads as not validated.')] })]
    case '/whm/email/outbound': return [
      card('view-sent-summary', { id: 'sent-summary', title: t('Sent summary'), lede: t('Mail sent from each hosted domain, read from the system journal. The current view compares the last hour with the reporting limits below.'), unread: t('The sent summary has not been read.'),
        fields: [{ key: 'view', label: t('View'), kind: 'select', options: [['history', t('Historical')], ['current', t('Current hour')]] }, { key: 'hours', label: t('Time range'), kind: 'select', options: ranges(t), help: t('The current view always reads the last hour.') }],
        actions: [{ key: 'read', label: t('Read summary'), tone: 'primary' }], facts: hosted,
        tables: [{ key: 'domains', caption: t('Sent mail by domain'), columns: [t('Domain'), t('Account'), t('Messages'), t('Delivered'), t('Deferred'), t('Failed'), t('Data sent'), t('Limits')], slots: ['domain', 'account', 'messages', 'sent', 'deferred', 'failed', 'bytes', 'limits'] }] }),
      card('view-sent-summary', { id: 'send-limits', title: t('Reporting limits'), lede: t('These limits only flag a domain in the current view. They do not stop mail; use the bulk sending limits for that.'), unread: t('The reporting limits have not been read.'),
        fields: [{ key: 'domainHourlyLimit', label: t('Messages per domain in one hour'), kind: 'number', min: 0, max: 1000000, help: t('0 turns this limit off.') }, { key: 'deferFailPercent', label: t('Deferred and failed share, in percent'), kind: 'number', min: 0, max: 100, help: t('0 turns this limit off.') }, { key: 'deferFailMinimum', label: t('Minimum deferred and failed messages'), kind: 'number', min: 0, max: 1000000, help: t('The share counts once a domain reaches this number.') }],
        actions: [{ key: 'save', label: t('Save limits'), tone: 'primary', write: true }] }),
      card('view-relayers', { id: 'relayers', title: t('Relayers'), lede: t('Who sent mail to remote servers. Authenticated users are listed by login, others by envelope sender.'), unread: t('Relayers have not been read.'),
        fields: [{ key: 'hours', label: t('Time range'), kind: 'select', options: ranges(t) }], actions: [{ key: 'read', label: t('Read relayers'), tone: 'primary' }], facts: hosted,
        tables: [{ key: 'relayers', caption: t('Relayers'), columns: [t('User'), t('Domain'), t('Account'), t('Messages'), t('Delivered'), t('Deferred'), t('Failed'), t('Data sent')], slots: ['user', 'domain', 'account', 'messages', 'sent', 'deferred', 'failed', 'bytes'] }] })]
    case '/whm/email/spam': return [
      card('incoming-mail-country-filter', { id: 'country-filter', title: t('Filter incoming mail by country'), lede: t('Refuses SMTP connections on port 25 from the chosen countries. Mail clients that sign in are never affected.'), unread: t('The country filter has not been read.'),
        facts: [['state', t('Applied on this server')], ['database', t('Country database')], ['blocked', t('Blocked countries')]], list: { key: 'countries', label: t('Countries') },
        fields: [{ key: 'search', label: t('Search countries'), kind: 'text' }], actions: [{ key: 'all', label: t('Select all'), write: true }, { key: 'none', label: t('Clear all'), write: true }, { key: 'save', label: t('Save and apply'), tone: 'primary', write: true }],
        notes: [t('Country lookups use the local GeoIP database. Its networks change monthly, so apply the filter again after the database updates.')] }),
      card('spam-daemon-startup', { id: 'spamd-startup', title: t('Spam filter startup'), lede: t('Startup options of the running spam filter. Saving restarts it with the new values.'), unread: t('The startup options have not been read.'),
        facts: [['state', t('Applied on this server')], ['engine', t('Detected filter')]],
        fields: [{ key: 'allowedIps', label: t('Allowed client addresses'), kind: 'lines', ltr: true, help: t('One address or network per line. Leave empty for any address. SpamAssassin only.') }, { key: 'children', label: t('Child processes'), kind: 'number', min: 1, max: 64 }, { key: 'maxConnPerChild', label: t('Connections per child'), kind: 'number', min: 1, max: 100000 },
          { key: 'timeoutTcp', label: t('TCP timeout in seconds'), kind: 'number', min: 0, max: 3600, help: t('0 turns the TCP timeout off. SpamAssassin only.') }, { key: 'timeoutChild', label: t('Child timeout in seconds'), kind: 'number', min: 1, max: 86400 }],
        actions: [{ key: 'save', label: t('Save and restart'), tone: 'primary', write: true }] })]
    case '/whm/email/server': return [
      card('mta-config-manager', { id: 'mta-advanced', title: t('Advanced Postfix options'), lede: t('Extra main.cf parameters applied after every other mail setting, each checked against this Postfix release and by postfix check.'), unread: t('Advanced options have not been read.'),
        facts: [['state', t('Applied on this server')]], fields: [{ key: 'overrides', label: t('Parameters'), kind: 'lines', ltr: true, help: t('One name = value per line. Removing a line returns that parameter to the Postfix default.') }],
        actions: [{ key: 'save', label: t('Save and apply'), tone: 'primary', write: true }], notes: [t('Parameters that run programs or that xPanel manages elsewhere are refused. The TLS certificate parameters are managed per domain, so overriding them would break mail SNI.')] }),
      card('mta-config-manager', { id: 'mta-backups', title: t('Configuration backups'), lede: t('Copies of the saved mail settings, kept on this server. A restore or reset first takes a safety copy, then applies through the same checks.'), unread: t('Backups have not been read.'),
        facts: [['fingerprint', t('Generated configuration')], ['limit', t('Copies kept')]], fields: [{ key: 'upload', label: t('Restore from a file'), kind: 'file', accept: '.json,application/json', help: t('A downloaded copy has no relay password, so it keeps the password saved here for the same relay user.') }],
        actions: [{ key: 'create', label: t('Back up now'), write: true }, { key: 'upload', label: t('Restore file'), write: true }, { key: 'reset-advanced', label: t('Reset advanced options'), write: true }, { key: 'reset-full', label: t('Reset to defaults'), tone: 'danger', write: true }],
        tables: [{ key: 'backups', caption: t('Stored backups'), columns: [t('Created (UTC)'), t('By'), t('Reason'), t('Generated configuration'), t('Actions')], slots: ['created', 'by', 'reason', 'fingerprint', 'actions'] }] })]
    case '/whm/email/maintenance': return [
      card('repair-mailbox-permissions', { id: 'repair-permissions', title: t('Repair mailbox permissions'), lede: t('Returns every file and folder under each account\'s mail directory to the account and removes group write and all other access.'), unread: t('Choose the accounts to repair.'),
        fields: [{ key: 'scope', label: t('Accounts'), kind: 'select', options: [['all', t('All accounts')], ['some', t('Chosen accounts')]] }, { key: 'accounts', label: t('Account names'), kind: 'lines', ltr: true, help: t('One account name per line, for chosen accounts.') }],
        actions: [{ key: 'run', label: t('Repair permissions'), tone: 'primary', write: true }], notes: [t('The repair runs as host jobs. Each job log lists every path it changed.')] }),
      card('mailbox-format-conversion', { id: 'mailbox-format', title: t('Mailbox format'), lede: t('Every mailbox on this server uses maildir. xPanel does not convert mailboxes to mdbox: maildir is the only format its quota, backup, restore and spam training paths read.'), unread: '' })]
    case '/email/forwarders': return [card('domain-forwarders', { id: 'domain-forwarders', title: t('Domain forwarders'), lede: t('Sends mail for every address of a domain to the same address at another domain. Existing mailboxes and forwarders keep their mail.'), unread: t('Domain forwarders have not been read.'),
      fields: [{ key: 'sourceDomain', label: t('Domain'), kind: 'select', options: owned }, { key: 'targetDomain', label: t('Destination domain'), kind: 'text', ltr: true }], actions: [{ key: 'add', label: t('Add domain forwarder'), tone: 'primary', write: true }],
      tables: [{ key: 'forwarders', caption: t('Domain forwarders'), columns: [t('Domain'), t('Destination domain'), t('State'), t('Actions')], slots: ['source', 'target', 'state', 'actions'] }] })]
    case '/email/deliverability': return [
      card('email-deliverability', { id: 'deliverability', title: t('Email deliverability'), lede: t('Live DNS checks for each of your domains. Repair adds the missing SPF, DKIM and DMARC records to a zone on this server.'), unread: t('Domains have not been read.'),
        actions: [{ key: 'check', label: t('Run checks'), tone: 'primary' }], facts: [['checked', t('Last check (UTC)')]],
        tables: [{ key: 'domains', caption: t('Domain delivery checks'), columns: [t('Domain'), 'MX', 'SPF', 'DKIM', 'DMARC', 'PTR', t('Actions')], slots: ['domain', 'mx', 'spf', 'dkim', 'dmarc', 'ptr', 'actions'] }], notes: [t('Checks query public DNS through this server. A record just added can take a while to appear. Reverse DNS is set by the provider of the sending address.')] }),
      card('email-routing', { id: 'email-routing', title: t('Email routing'), lede: t('Chooses where mail for each domain goes. A wrong choice can stop mail, so check the MX records first.'), unread: t('Email routing has not been read.'),
        tables: [{ key: 'routes', caption: t('Email routing'), columns: [t('Domain'), t('MX records'), t('Routing'), t('Actions')], slots: ['domain', 'mx', 'mode', 'actions'] }],
        notes: [t('Automatic reads the saved zone once and does not change when MX records change later. Local delivers here. Backup holds mail for the primary server. Remote sends mail to the MX records.')] })]
    case '/email/filters': return [card('address-importer', { id: 'address-importer', title: t('Address importer'), lede: t('Creates mailboxes or forwarders from a comma-separated or one-per-line text file, or from the first sheet of an Excel .xls file.'), unread: t('Choose a file to review it.'),
      fields: [{ key: 'kind', label: t('Import'), kind: 'select', options: [['mailboxes', t('Mailboxes')], ['forwarders', t('Forwarders')]] }, { key: 'file', label: t('File'), kind: 'file', accept: '.csv,.txt,.xls,text/csv,text/plain,application/vnd.ms-excel' }, { key: 'delimiter', label: t('Delimiter'), kind: 'text', ltr: true, help: t('One character. Leave empty for a comma.') }, { key: 'header', label: t('The first row is a header'), kind: 'check' },
        { key: 'domain', label: t('Domain for entries without one'), kind: 'select', options: [['', t('None')], ...owned] }, { key: 'quota', label: t('Default mailbox quota in MB'), kind: 'number', min: 1, max: 1048576 }],
      actions: [{ key: 'review', label: t('Review') }, { key: 'import', label: t('Import'), tone: 'primary', write: true }], facts: [['rows', t('Rows found')], ['imported', t('Imported')], ['failed', t('Not imported')]],
      tables: [{ key: 'columns', caption: t('Column mapping'), columns: [t('Column'), t('First value'), t('Use as')], slots: ['column', 'sample', 'use'] }, { key: 'results', caption: t('Rows not imported'), columns: [t('Row'), t('Reason'), t('Detail')], slots: ['row', 'code', 'detail'] }] })]
    case '/email/spam-filters': return [card('greylisting', { id: 'greylisting', title: t('Greylisting'), lede: t('Asks unknown senders to retry later. Mail from a new address, server and recipient is deferred once. Needs rspamd with Redis.'), unread: t('Greylisting has not been read.'),
      facts: [['engine', t('Detected filter')], ['state', t('Applied on this server')]], actions: [{ key: 'all', label: t('Enable all'), write: true }, { key: 'none', label: t('Disable all'), write: true }, { key: 'save', label: t('Save and apply'), tone: 'primary', write: true }],
      fields: [{ key: 'search', label: t('Search domains'), kind: 'text', ltr: true }], tables: [{ key: 'domains', caption: t('Greylisting by domain'), columns: [t('Domain'), t('Greylisting')], slots: ['domain', 'enabled'] }], notes: [t('Deferred attempts appear in Track Delivery as deferred.')] })]
    case '/metrics/logs': return [card('track-delivery', { id: 'track-delivery', title: t('Track delivery'), lede: t('Delivery events for your domains from the system journal, newest first. Addresses of other accounts are hidden.'), unread: t('Delivery events have not been read.'),
      fields: [{ key: 'recipient', label: t('Recipient contains'), kind: 'text', ltr: true }, { key: 'hours', label: t('Time range'), kind: 'select', options: ranges(t) }, { key: 'view', label: t('Show'), kind: 'select', options: [['all', t('All records')], ['problems', t('Blocked and failed only')]] }],
      actions: [{ key: 'read', label: t('Run report'), tone: 'primary' }], facts: [...hosted, ['matched', t('Matching messages')]],
      tables: [{ key: 'messages', caption: t('Delivery events'), columns: [t('Last event (UTC)'), t('Sender'), t('Recipients'), t('Status'), t('Result'), t('Size')], slots: ['when', 'sender', 'recipients', 'status', 'result', 'size'] }], notes: [t('Spam scores are not in the journal, so they are not shown. Records last as long as the server keeps its journal.')] })]
    case '/mail/later': return [card('webmail-search-index', { id: 'search-index', title: t('Search index'), lede: t('Rebuilds the full text index of every folder. Search keeps working during a rebuild and may show partial results.'), unread: t('The search index has not been read.'),
      facts: [['fts', t('Full text search')], ['job', t('Last rebuild')]], actions: [{ key: 'rebuild', label: t('Rebuild index'), tone: 'primary', write: true }] })]
    default: return []
  }
}
