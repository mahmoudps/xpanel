/**
 * Theme-neutral description of the runtime, developer and panel-data cards. A theme turns one card into its own markup
 * with its own components; the hooks here are the contract the shared panel-tools client binds to in either theme.
 */
export type ToolHooks = Readonly<Record<string, string | true>>
export type ToolField =
  | { kind: 'input'; id: string; label: string; hooks: ToolHooks; type?: string; ltr?: boolean; help?: string; placeholder?: string; autocomplete?: string }
  | { kind: 'area'; id: string; label: string; hooks: ToolHooks; ltr?: boolean; help?: string; rows?: number }
  | { kind: 'select'; id: string; label: string; hooks: ToolHooks; options: readonly (readonly [string, string])[]; help?: string }
  | { kind: 'check'; id: string; label: string; hooks: ToolHooks }
  | { kind: 'file'; id: string; label: string; hooks: ToolHooks; accept?: string }
export type ToolBlock =
  | { kind: 'note'; text: string }
  | { kind: 'warning'; text: string }
  | { kind: 'facts'; rows: readonly { label: string; hooks: ToolHooks; technical?: boolean }[] }
  | { kind: 'fields'; fields: readonly ToolField[] }
  | { kind: 'table'; label: string; columns: readonly string[]; hooks: ToolHooks; empty: string }
  | { kind: 'actions'; buttons: readonly { label: string; hooks: ToolHooks; primary?: boolean; danger?: boolean }[] }
  | { kind: 'status'; text: string; hooks: ToolHooks }
  | { kind: 'output'; label: string; hooks: ToolHooks; hidden?: boolean }
  | { kind: 'tree'; hooks: ToolHooks }
export interface ToolCard { id: string; title: string; root: ToolHooks; blocks: readonly ToolBlock[] }

const UNREAD = msgid('Nothing has been read yet.')

export const metricsExportCard: ToolCard = { id: 'metrics-export', title: msgid('Metrics endpoint'), root: { 'data-metrics-export': true }, blocks: [
  { kind: 'note', text: msgid('Prometheus and OpenMetrics scrapers read server, service and per-account samples with a token limited to metrics:read. A scrape reads saved samples and adds no collection.') },
  { kind: 'facts', rows: [{ label: msgid('Scrape address'), hooks: { 'data-metrics-fact': 'path' }, technical: true }, { label: msgid('Token scope'), hooks: { 'data-metrics-fact': 'scope' }, technical: true }] },
  { kind: 'fields', fields: [
    { kind: 'check', id: 'metrics-enabled', label: msgid('Serve the metrics endpoint'), hooks: { 'data-metrics-enabled': true } },
    { kind: 'area', id: 'metrics-allow', label: msgid('Allowed source addresses'), hooks: { 'data-metrics-allow': true }, ltr: true, rows: 3, help: msgid('One address per line. Empty allows any address that holds the token.') },
  ] },
  { kind: 'actions', buttons: [{ label: msgid('Save'), hooks: { 'data-metrics-save': true }, primary: true }, { label: msgid('Refresh'), hooks: { 'data-metrics-refresh': true } }] },
  { kind: 'status', text: UNREAD, hooks: { 'data-metrics-status': true } },
] }

export const errorReportingCard: ToolCard = { id: 'error-reporting', title: msgid('Error reporting'), root: { 'data-error-reporting': true }, blocks: [
  { kind: 'note', text: msgid('Off until a DSN is saved. Reports leave through the reviewed HTTPS path, and passwords, tokens, cookies, email addresses and IP addresses are replaced before sending.') },
  { kind: 'fields', fields: [
    { kind: 'input', id: 'error-dsn', label: msgid('Sentry-compatible DSN'), hooks: { 'data-error-dsn': true }, ltr: true, placeholder: 'https://key@sentry.example.com/1' },
    { kind: 'input', id: 'error-environment', label: msgid('Environment'), hooks: { 'data-error-environment': true }, ltr: true },
    { kind: 'input', id: 'error-rate', label: msgid('Sample rate (0 to 1)'), hooks: { 'data-error-rate': true }, type: 'number', ltr: true },
  ] },
  { kind: 'actions', buttons: [{ label: msgid('Save'), hooks: { 'data-error-save': true }, primary: true }, { label: msgid('Send test event'), hooks: { 'data-error-test': true } }, { label: msgid('Refresh'), hooks: { 'data-error-refresh': true } }] },
  { kind: 'status', text: UNREAD, hooks: { 'data-error-status': true } },
] }

export const configAsCodeCard: ToolCard = { id: 'config-as-code', title: msgid('Configuration as code'), root: { 'data-config-code': true }, blocks: [
  { kind: 'note', text: msgid('Export server settings, feature lists, packages, resellers and accounts as YAML without secrets. An import changes only what its files name and removes nothing.') },
  { kind: 'fields', fields: [{ kind: 'file', id: 'config-file', label: msgid('Exported configuration file'), hooks: { 'data-config-file': true }, accept: '.yaml,.yml,.txt' }] },
  { kind: 'actions', buttons: [{ label: msgid('Export configuration'), hooks: { 'data-config-export': true } }, { label: msgid('Preview import'), hooks: { 'data-config-preview': true } }, { label: msgid('Apply import'), hooks: { 'data-config-apply': true }, primary: true }] },
  { kind: 'status', text: msgid('No import has been previewed.'), hooks: { 'data-config-status': true } },
  { kind: 'table', label: msgid('Changes in this import'), columns: [msgid('File'), msgid('Field'), msgid('Current'), msgid('Imported'), msgid('Result')], hooks: { 'data-config-changes': true }, empty: msgid('No import has been previewed.') },
] }

export const panelBackupsCard: ToolCard = { id: 'panel-backups', title: msgid('Panel data backups'), root: { 'data-panel-backups': true }, blocks: [
  { kind: 'note', text: msgid('A snapshot holds the saved desired state and a copy of the index database. A restore copies the desired state back and reconciles the server. Sign-in principals and the audit log stay as they are.') },
  { kind: 'facts', rows: [{ label: msgid('Restore folder'), hooks: { 'data-panel-backup-folder': true }, technical: true }] },
  { kind: 'table', label: msgid('Panel snapshots'), columns: [msgid('Snapshot'), msgid('Created (UTC)'), msgid('Size')], hooks: { 'data-panel-backup-rows': true }, empty: msgid('Not read') },
  { kind: 'fields', fields: [
    { kind: 'select', id: 'panel-backup-select', label: msgid('Snapshot'), hooks: { 'data-panel-backup-select': true }, options: [['', msgid('Select a snapshot')]] },
    { kind: 'file', id: 'panel-backup-file', label: msgid('Upload a snapshot'), hooks: { 'data-panel-backup-file': true }, accept: '.gz,.zst' },
    { kind: 'check', id: 'panel-backup-overwrite', label: msgid('Overwrite items that have the same name'), hooks: { 'data-panel-backup-overwrite': true } },
  ] },
  { kind: 'actions', buttons: [
    { label: msgid('Create snapshot'), hooks: { 'data-panel-backup-action': 'create' }, primary: true }, { label: msgid('Upload'), hooks: { 'data-panel-backup-action': 'upload' } }, { label: msgid('Download'), hooks: { 'data-panel-backup-action': 'download' } },
    { label: msgid('Restore'), hooks: { 'data-panel-backup-action': 'restore' } }, { label: msgid('Delete'), hooks: { 'data-panel-backup-action': 'delete' }, danger: true }, { label: msgid('Refresh'), hooks: { 'data-panel-backup-action': 'refresh' } },
  ] },
  { kind: 'status', text: UNREAD, hooks: { 'data-panel-backup-status': true } },
  { kind: 'output', label: msgid('Skipped items'), hooks: { 'data-panel-backup-report': true }, hidden: true },
] }

export const apiShellCard = (surface: 'account' | 'administrator'): ToolCard => ({ id: 'api-shell-' + surface, title: msgid('API shell'), root: { 'data-api-shell': true, 'data-api-shell-surface': surface }, blocks: [
  { kind: 'warning', text: msgid('Calls run on live data with your current permissions. A write here is a real write.') },
  { kind: 'fields', fields: [
    { kind: 'select', id: `shell-function-${surface}`, label: msgid('Function'), hooks: { 'data-shell-function': true }, options: [['', msgid('Read the function list first')]] },
    { kind: 'area', id: `shell-params-${surface}`, label: msgid('Parameters'), hooks: { 'data-shell-params': true }, ltr: true, rows: 3, help: msgid('One name=value per line.') },
    { kind: 'input', id: `shell-start-${surface}`, label: msgid('First result'), hooks: { 'data-shell-start': true }, type: 'number', ltr: true },
    { kind: 'input', id: `shell-limit-${surface}`, label: msgid('Results per page (0 means all)'), hooks: { 'data-shell-limit': true }, type: 'number', ltr: true },
    { kind: 'input', id: `shell-filter-column-${surface}`, label: msgid('Filter column'), hooks: { 'data-shell-filter-column': true }, ltr: true },
    { kind: 'select', id: `shell-filter-type-${surface}`, label: msgid('Filter type'), hooks: { 'data-shell-filter-type': true }, options: [['contains', msgid('Contains')], ['begins', msgid('Begins with')], ['equals', msgid('Equals')], ['gt', msgid('Greater than')], ['lt', msgid('Less than')]] },
    { kind: 'input', id: `shell-filter-value-${surface}`, label: msgid('Filter value'), hooks: { 'data-shell-filter-value': true }, ltr: true },
    { kind: 'input', id: `shell-sort-column-${surface}`, label: msgid('Sort column'), hooks: { 'data-shell-sort-column': true }, ltr: true },
    { kind: 'select', id: `shell-sort-method-${surface}`, label: msgid('Sort as'), hooks: { 'data-shell-sort-method': true }, options: [['text', msgid('Text')], ['numeric', msgid('Number')], ['numeric_zero_max', msgid('Number, zero as highest')], ['ipv4', msgid('IPv4 address')]] },
    { kind: 'check', id: `shell-sort-reverse-${surface}`, label: msgid('Reverse the order'), hooks: { 'data-shell-sort-reverse': true } },
    { kind: 'input', id: `shell-columns-${surface}`, label: msgid('Columns'), hooks: { 'data-shell-columns': true }, ltr: true, help: msgid('Comma-separated. Empty keeps every column.') },
    { kind: 'input', id: `shell-token-${surface}`, label: msgid('API token (optional)'), hooks: { 'data-shell-token': true }, type: 'password', ltr: true, autocomplete: 'off', help: msgid('Sends the call with this token instead of your session. It stays on this page.') },
  ] },
  { kind: 'facts', rows: [{ label: msgid('Request'), hooks: { 'data-shell-preview': true }, technical: true }, { label: msgid('Command line'), hooks: { 'data-shell-cli': true }, technical: true }, { label: 'curl', hooks: { 'data-shell-curl': true }, technical: true }] },
  { kind: 'actions', buttons: [{ label: msgid('Run call'), hooks: { 'data-shell-run': true }, primary: true }, { label: msgid('Read functions'), hooks: { 'data-shell-refresh': true } }, { label: msgid('Download OpenAPI'), hooks: { 'data-shell-openapi': true } }] },
  { kind: 'status', text: msgid('The function list has not been read.'), hooks: { 'data-shell-status': true } },
  { kind: 'fields', fields: [{ kind: 'select', id: `shell-view-${surface}`, label: msgid('Show the result as'), hooks: { 'data-shell-view': true }, options: [['tree', msgid('Tree')], ['table', msgid('Table')], ['raw', msgid('Raw')]] }] },
  { kind: 'tree', hooks: { 'data-shell-tree': true } },
  { kind: 'table', label: msgid('Result table'), columns: [msgid('Value')], hooks: { 'data-shell-table': true }, empty: msgid('No call has run.') },
  { kind: 'output', label: msgid('Response headers'), hooks: { 'data-shell-headers': true }, hidden: true },
  { kind: 'output', label: msgid('Response body'), hooks: { 'data-shell-raw': true }, hidden: true },
] })

export const projectsCard: ToolCard = { id: 'application-projects', title: msgid('Go & Java projects'), root: { 'data-sw-projects-manager': true }, blocks: [
  { kind: 'note', text: msgid('Each project is one service in the account slice with the account limits. It listens on a private port only its owner can reach, and Nginx reaches it through a root-owned socket.') },
  { kind: 'table', label: msgid('Go & Java projects'), columns: [msgid('Project'), msgid('Account'), msgid('Runtime'), msgid('Port'), msgid('Address'), msgid('State')], hooks: { 'data-sw-projects-rows': true }, empty: msgid('Not read') },
  { kind: 'fields', fields: [{ kind: 'select', id: 'sw-project-select', label: msgid('Project'), hooks: { 'data-sw-project-select': true }, options: [['', msgid('Select a project')]] }] },
  { kind: 'actions', buttons: [
    { label: msgid('Start'), hooks: { 'data-sw-project-action': 'app.start' } }, { label: msgid('Stop'), hooks: { 'data-sw-project-action': 'app.stop' } }, { label: msgid('Restart'), hooks: { 'data-sw-project-action': 'app.restart' } },
    { label: msgid('Remove'), hooks: { 'data-sw-project-action': 'app.remove' }, danger: true }, { label: msgid('Read log'), hooks: { 'data-sw-project-log-read': true } }, { label: msgid('Refresh'), hooks: { 'data-sw-project-refresh': true } },
  ] },
  { kind: 'output', label: msgid('Runtime log'), hooks: { 'data-sw-project-log': true }, hidden: true },
  { kind: 'fields', fields: [
    { kind: 'select', id: 'sw-project-account', label: msgid('Account'), hooks: { 'data-sw-project-account': true }, options: [['', msgid('Read projects first')]] },
    { kind: 'input', id: 'sw-project-name', label: msgid('Project name'), hooks: { 'data-sw-project-name': true }, ltr: true },
    { kind: 'select', id: 'sw-project-runtime', label: msgid('Runtime'), hooks: { 'data-sw-project-runtime': true }, options: [['go', 'Go'], ['java', 'Java']] },
    { kind: 'select', id: 'sw-project-jdk', label: msgid('JDK'), hooks: { 'data-sw-project-jdk': true }, options: [['', msgid('System default')], ['17', 'OpenJDK 17'], ['21', 'OpenJDK 21']] },
    { kind: 'input', id: 'sw-project-root', label: msgid('Project folder (relative to home)'), hooks: { 'data-sw-project-root': true }, ltr: true, placeholder: 'apps/service' },
    { kind: 'input', id: 'sw-project-startup', label: msgid('Executable or JAR file'), hooks: { 'data-sw-project-startup': true }, ltr: true, placeholder: 'server' },
    { kind: 'input', id: 'sw-project-command', label: msgid('Start command (optional)'), hooks: { 'data-sw-project-command': true }, ltr: true },
    { kind: 'select', id: 'sw-project-domain', label: msgid('Domain'), hooks: { 'data-sw-project-domain': true }, options: [['', msgid('Select an account first')]] },
    { kind: 'input', id: 'sw-project-path', label: msgid('URL path'), hooks: { 'data-sw-project-path': true }, ltr: true, placeholder: '/' },
    { kind: 'input', id: 'sw-project-port', label: msgid('Port (empty picks one)'), hooks: { 'data-sw-project-port': true }, type: 'number', ltr: true },
    { kind: 'area', id: 'sw-project-env', label: msgid('Environment variables'), hooks: { 'data-sw-project-env': true }, ltr: true, rows: 3, help: msgid('One NAME=value per line.') },
    { kind: 'check', id: 'sw-project-open', label: msgid('Open this port in the firewall'), hooks: { 'data-sw-project-open': true } },
  ] },
  { kind: 'actions', buttons: [{ label: msgid('Save project'), hooks: { 'data-sw-project-save': true }, primary: true }] },
  { kind: 'status', text: UNREAD, hooks: { 'data-sw-project-status': true } },
] }

export const pythonRuntimesCard: ToolCard = { id: 'python-runtimes', title: msgid('Python versions and environments'), root: { 'data-python-runtimes': true }, blocks: [
  { kind: 'note', text: msgid('Interpreter versions come from the distribution packages listed on this page. A named environment belongs to one account, under python-envs in its home, and a Python application of that account can run in it.') },
  { kind: 'table', label: msgid('Interpreters on this server'), columns: [msgid('Version'), msgid('State'), msgid('Installed version')], hooks: { 'data-python-versions': true }, empty: msgid('Not read') },
  { kind: 'table', label: msgid('Named environments'), columns: [msgid('Environment'), msgid('Account'), msgid('Python'), msgid('State')], hooks: { 'data-python-envs': true }, empty: msgid('Not read') },
  { kind: 'fields', fields: [
    { kind: 'select', id: 'python-env-select', label: msgid('Environment'), hooks: { 'data-python-env-select': true }, options: [['', msgid('Select an environment')]] },
    { kind: 'select', id: 'python-env-account', label: msgid('Account'), hooks: { 'data-python-env-account': true }, options: [['', msgid('Read environments first')]] },
    { kind: 'input', id: 'python-env-name', label: msgid('Environment name'), hooks: { 'data-python-env-name': true }, ltr: true },
    { kind: 'select', id: 'python-env-version', label: msgid('Python version'), hooks: { 'data-python-env-version': true }, options: [['', msgid('Read environments first')]] },
  ] },
  { kind: 'actions', buttons: [{ label: msgid('Create environment'), hooks: { 'data-python-env-create': true }, primary: true }, { label: msgid('Remove environment'), hooks: { 'data-python-env-remove': true }, danger: true }, { label: msgid('Refresh'), hooks: { 'data-python-refresh': true } }] },
  { kind: 'status', text: UNREAD, hooks: { 'data-python-status': true } },
] }

export const pearPackagesCard = (accountId: string): ToolCard => ({ id: 'pear-packages', title: msgid('PHP PEAR packages'), root: { 'data-account-packages': true, 'data-account': accountId }, blocks: [
  { kind: 'note', text: msgid('Packages install into your private PEAR library. The installer runs as your account and writes only inside your home directory.') },
  { kind: 'facts', rows: [{ label: msgid('Library path'), hooks: { 'data-packages-library': true }, technical: true }, { label: msgid('PHP version'), hooks: { 'data-packages-php': true }, technical: true }, { label: msgid('Add this line to a PHP script'), hooks: { 'data-packages-snippet': true }, technical: true }] },
  { kind: 'table', label: msgid('Installed packages'), columns: [msgid('Package'), msgid('Version')], hooks: { 'data-packages-installed': true }, empty: msgid('Not read') },
  { kind: 'fields', fields: [{ kind: 'select', id: 'packages-select', label: msgid('Package'), hooks: { 'data-packages-select': true }, options: [['', msgid('Select a package')]] }] },
  { kind: 'actions', buttons: [{ label: msgid('Update'), hooks: { 'data-package-op': 'update' } }, { label: msgid('Reinstall'), hooks: { 'data-package-op': 'reinstall' } }, { label: msgid('Uninstall'), hooks: { 'data-package-op': 'remove' }, danger: true }, { label: msgid('Package documentation'), hooks: { 'data-packages-docs': true } }, { label: msgid('Refresh'), hooks: { 'data-packages-refresh': true } }] },
  { kind: 'fields', fields: [
    { kind: 'input', id: 'packages-name', label: msgid('Install by exact name'), hooks: { 'data-packages-name': true }, ltr: true, placeholder: 'Config_Lite' },
    { kind: 'input', id: 'packages-search', label: msgid('Search the PEAR channel'), hooks: { 'data-packages-search': true }, ltr: true },
  ] },
  { kind: 'actions', buttons: [{ label: msgid('Install'), hooks: { 'data-package-op': 'install' }, primary: true }, { label: msgid('Search'), hooks: { 'data-packages-search-run': true } }] },
  { kind: 'table', label: msgid('Search results'), columns: [msgid('Package'), msgid('Version'), msgid('Description')], hooks: { 'data-packages-results': true }, empty: msgid('No search has run.') },
  { kind: 'table', label: msgid('System packages'), columns: [msgid('Package'), msgid('Version')], hooks: { 'data-packages-system': true }, empty: msgid('Not read') },
  { kind: 'status', text: msgid('Packages have not been read.'), hooks: { 'data-packages-status': true } },
] })

export const pluginImportCard: ToolCard = { id: 'plugin-import', title: msgid('Import a plugin package'), root: { 'data-plugin-import': true }, blocks: [
  { kind: 'note', text: msgid('Upload a plugin package file from a third party. It is checked first; a package installs only as links and icons on the account home page, and nothing in it runs.') },
  { kind: 'fields', fields: [
    { kind: 'file', id: 'plugin-import-file', label: msgid('Plugin package file'), hooks: { 'data-plugin-import-file': true }, accept: 'application/json,.json' },
    { kind: 'check', id: 'plugin-import-overwrite', label: msgid('Replace an installed plugin of the same name'), hooks: { 'data-plugin-import-overwrite': true } },
  ] },
  { kind: 'actions', buttons: [{ label: msgid('Import plugin'), hooks: { 'data-plugin-import-run': true }, primary: true }] },
  { kind: 'status', text: msgid('No package has been chosen.'), hooks: { 'data-plugin-import-status': true } },
] }
