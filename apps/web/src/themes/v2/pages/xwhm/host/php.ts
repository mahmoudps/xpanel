import { escapeHtml } from '../../../html.ts'
import { formField } from '../../../components/form-field.ts'
import { kpiCard } from '../../../components/kpi-card.ts'
import { hostButton, hostCard, hostContext, hostFacts, hostPage, hostTable, technical, type HostPageProps } from './common.ts'

const FUNCTIONS = ['exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen'] as const
const INI_FIELDS = ['memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_vars'] as const

/** Runtime inventory, saved assignments, and effective pool values remain separate facts. */
export function renderV2WhmPhp(props: HostPageProps): string {
  const route = '/whm/software/php'
  const { t, readable } = hostContext(props, route)
  const unread = t(msgid('Not read'))
  const savedDomains = readable ? props.domains : undefined
  const accounts = readable ? props.accounts : undefined
  const select = (name: string, label: string, choices: readonly { value: string; label: string }[] = []): string =>
    formField({ id: `v2-${name}`, label: t(label), control: { kind: 'select', name, disabled: true, dir: 'ltr', options: choices } })
  const input = (name: string, label: string, type: 'text' | 'number' = 'text'): string =>
    formField({ id: `v2-php-${name}`, label: t(label), control: { kind: 'input', name, type, disabled: true, mono: true, dir: 'ltr' } })
  const button = (name: string, label: string, danger = false): string => hostButton(t(label), { 'data-php-action': name }, { disabled: true, danger })
  const scope = (key: string) => ({ 'data-whm-detail-section': key })
  const note = `<p data-php-manage-status role="status"></p>`
  const summary = `<div class="v2-kpi-row">${[
    { label: t(msgid('Host')), value: readable ? props.hostname ?? unread : unread, icon: 'server' as const },
    { label: t(msgctxt('theme:v2', 'Default for new domains')), value: readable ? props.serverSettings?.defaultPhpVersion ?? unread : unread, icon: 'code' as const },
    { label: t(msgid('Domains')), value: savedDomains ? String(savedDomains.length) : unread, icon: 'globe' as const },
    { label: t(msgctxt('theme:v2', 'FPM pools')), value: unread, icon: 'layers' as const },
  ].map(item => kpiCard({ ...item, note: t(msgctxt('theme:v2', 'Saved configuration does not establish running pool state.')) })).join('')}</div>`
  const runtime = `<div class="v2-host__groups" data-whm-php-workspace data-php-can-read="${readable}">
<div class="v2-host__actions">${hostButton(t(msgid('Read PHP inventory')), { 'data-whm-php-refresh': true }, { disabled: !readable })}</div>
<p data-whm-php-status data-state="unread" role="status">${escapeHtml(t(msgid('Installed packages and runtime binaries have not been read.')))}</p>
${hostFacts([{ label: t(msgid('Inventory source')), valueHtml: `<span data-whm-php-source>${escapeHtml(unread)}</span>` }, { label: t(msgid('Observed at (UTC)')), valueHtml: `<span data-whm-php-observed-at>${escapeHtml(unread)}</span>` }])}
<p data-whm-php-binary-status>${escapeHtml(t(msgid('Binary probes ignore php.ini. Built-in CLI extensions do not establish FPM extension enablement, global defaults or a successful application request.')))}</p>
<h3>${escapeHtml(t(msgid('Saved domain assignments')))}</h3>${hostTable(t, 'php-usage', t(msgid('Saved PHP domain assignments')), [t(msgid('Version')), t(msgid('Domain')), t(msgid('Account')), t(msgid('Handler'))], [], t(msgid('No assignments have been read.')), { 'data-whm-php-usage': true })}</div>`
  const versions = hostCard('php-versions', t(msgid('Installed versions')), `${hostTable(t, 'php-versions', t(msgid('Installed PHP versions')), [t(msgid('Version')), t(msgid('Default')), t(msgid('State'))], [], t(msgid('Installed packages and runtime binaries have not been read.')))}${runtime}
<div class="v2-host__fields">${select('php-selected-version', msgid('Selected version'))}</div><div class="v2-host__actions">${button('set-default', msgid('Set as default'))}${button('reinstall-version', msgid('Reinstall selected version'))}${button('remove-version', msgid('Remove selected version'), true)}</div>
<details><summary>${escapeHtml(t(msgid('Confirm version removal')))}</summary><div class="v2-host__actions">${button('confirm-remove', msgid('Remove version'), true)}${button('cancel-remove', msgid('Cancel'))}</div></details>${note}`, scope('php-versions'))
  const install = hostCard('php-install', t(msgid('Install another version')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'Versions are installed side by side. Existing domains keep their version.')))}</p>${input('php-install-request', msgid('Package version'))}<div class="v2-host__actions">${button('install-version', msgid('Install selected PHP version'))}</div>${note}`, scope('php-install'))
  const handlers = hostCard('php-handlers', t(msgid('Handlers')), hostTable(t, 'php-handlers', t(msgid('PHP handler compatibility')), [t(msgid('Handler')), t(msgid('Engine')), t(msgid('Identity')), t(msgid('Availability'))], [
    ['PHP-FPM', 'Apache', t(msgid('Per-account pool'))], ['CGI / suexec', 'Apache', t(msgid('Account UID'))], ['suPHP', 'Apache', t(msgid('Account UID'))], ['lsphp', 'OpenLiteSpeed', t(msgid('Account external app'))],
  ].map(([handler, engine, identity]) => ({ cellsHtml: [technical(handler), technical(engine), escapeHtml(identity!), escapeHtml(unread)] })), t(msgid('No records have been read.')))
  + `<p>${escapeHtml(t(msgctxt('theme:v2', 'Handler availability has not been read. A saved assignment does not establish runtime compatibility.')))}</p>`)
  const pool = hostCard('php-pool', t(msgctxt('theme:v2', 'PHP-FPM process manager')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'Each account pool runs inside its account slice. Global pool defaults and effective worker counts have not been read.')))}</p><div class="v2-host__fields">${select('v2-php-pool-mode', msgid('Process manager'), ['ondemand', 'dynamic', 'static'].map(value => ({ value, label: value })))}${input('v2-php-pool-max-children', 'pm.max_children', 'number')}${input('v2-php-pool-idle', 'pm.process_idle_timeout', 'number')}${input('v2-php-pool-start', 'pm.start_servers', 'number')}${input('v2-php-pool-min-spare', 'pm.min_spare_servers', 'number')}${input('v2-php-pool-max-spare', 'pm.max_spare_servers', 'number')}${input('v2-php-pool-max-requests', 'pm.max_requests', 'number')}</div><p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Global pool settings have no connected write operation in this workspace.')))}</p>`)
  const extensions = hostCard('php-extensions', t(msgid('Extensions per version')), `${select('php-extension-version', msgid('Extensions for PHP version'))}${hostTable(t, 'php-extensions', t(msgid('Extensions per version')), [t(msgid('Extension')), t(msgid('Package')), t(msgid('Enabled')), t(msgid('State'))], [], t(msgid('No selected version has been read.')))}${note}`, scope('php-extensions'))
  const configuration = hostCard('php-configure', t(msgctxt('theme:v2', 'Global php.ini')), `<div class="v2-host__fields">${select('php-version', msgid('Version'))}${INI_FIELDS.map(name => input(name, name)).join('')}</div>
<details><summary>${escapeHtml(t(msgid('File contents')))}</summary>${formField({ id: 'v2-php-ini', label: t(msgid('File contents')), control: { kind: 'textarea', name: 'php-ini', disabled: true, rows: 12, mono: true, dir: 'ltr' } })}<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'The managed file has not been read.')))}</p></details>
<div class="v2-host__actions">${button('discard-ini', msgid('Discard'))}${button('apply-ini', msgid('Test and apply'))}</div>${note}`, scope('php-configure'))
  const effective = hostCard('php-effective', t(msgctxt('theme:v2', 'Saved and effective values')), hostTable(t, 'php-effective', t(msgctxt('theme:v2', 'Saved and effective values')), [t(msgid('Setting')), t(msgid('Saved')), t(msgctxt('theme:v2', 'Effective in pools'))], [...INI_FIELDS, 'display_errors', 'pm'].map(name => ({ cellsHtml: [technical(name), escapeHtml(unread), escapeHtml(unread)] })), unread)
    + `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Effective pool values have not been read. No php.ini setting is presented as verified in a running application.')))}</p>`)
  const functions = hostCard('php-functions', t(msgid('Dangerous functions')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'Only root grants per-account exceptions. Saved exceptions and active runtime policy are separate observations.')))}</p>
<div class="v2-host__choices">${FUNCTIONS.map(name => `<code>${escapeHtml(name)}</code>`).join('')}</div>
${hostTable(t, 'php-functions', t(msgid('Function exceptions')), [t(msgid('Account')), t(msgid('Functions')), t(msgid('Reason')), t(msgid('Action'))], [], t(msgctxt('theme:v2', 'Function exceptions have not been read.')))}
<details><summary>${escapeHtml(t(msgid('New exception')))}</summary><div class="v2-host__groups"><div class="v2-host__fields">${select('php-exception-account', msgid('Account'), (accounts ?? []).map(account => ({ value: account.username, label: account.username })))}${formField({ id: 'v2-php-exception-reason', label: t(msgid('Reason')), control: { kind: 'textarea', name: 'php-exception-reason', disabled: true, rows: 3 } })}</div>
<fieldset><legend>${escapeHtml(t(msgid('Allow these functions')))}</legend><div class="v2-host__choices">${FUNCTIONS.map(name => `<label class="v2-host__choice"><input type="checkbox" name="php-exception-${name}" disabled><bdi dir="ltr">${name}</bdi></label>`).join('')}</div></fieldset>
<div class="v2-host__actions">${button('grant-exception', msgid('Grant exception'))}</div></div></details>${note}`, scope('php-functions'))
  return hostPage(props, route, t(msgid('PHP versions and handlers')), t(msgid('Version inventory, engine compatibility, extensions and global defaults.')), `${summary}${versions}${install}${handlers}${pool}${extensions}<div class="v2-host__split"><div class="v2-host__stack">${configuration}</div><aside aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Saved and effective values')))}">${effective}</aside></div>${functions}`)
}
