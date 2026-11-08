import { escapeHtml, xpTemplate } from '../../../html.ts'
import { tabs, tabPanel } from '../../../components/tabs.ts'
import { renderV2HostTools } from '../server/host-tools.ts'
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
  const note = `<p data-php-manage-status role="status"><span data-php-status-content></span></p>`
  const templates = xpTemplate('whm-php-version-entry', `<tr><td><div class="v2-php-version-identity"><strong><bdi class="v2-mono" dir="ltr" data-xp-slot="version"></bdi></strong><span class="v2-pill v2-pill--info" data-xp-slot="default-holder" hidden><span class="v2-pill__dot" aria-hidden="true"></span><span data-xp-slot="default-label"></span></span></div></td><td><span class="v2-pill v2-pill--neutral v2-php-lifecycle"><span class="v2-pill__dot" aria-hidden="true"></span><span data-xp-slot="lifecycle"></span></span><p class="v2-muted">${escapeHtml(t(msgid('Support dates')))}: ${escapeHtml(unread)}</p></td><td><dl class="v2-php-binary"><div><dt>${escapeHtml(t(msgid('Binary')))}</dt><dd><span data-xp-slot="binary"></span></dd></div><div><dt>FPM</dt><dd><span data-xp-slot="fpm"></span></dd></div></dl></td><td><span data-xp-slot="usage"></span></td><td><div class="v2-php-packages" data-xp-slot="packages"></div></td><td><div class="v2-php-version-actions" data-xp-slot="actions"></div></td></tr>`)
    + xpTemplate('whm-php-versions-empty', '<tr><td colspan="6"><span data-xp-slot="content"></span></td></tr>')
    + xpTemplate('whm-php-status', '<p data-php-manage-status role="status"><span data-php-status-content data-xp-slot="content"></span></p>')
    + xpTemplate('whm-php-revoke', '<button type="button" class="v2-btn v2-btn--danger" disabled><span data-xp-slot="content"></span></button>')
    + xpTemplate('whm-php-extension-switch', '<div class="v2-php-extension-switch"><input type="checkbox" data-xp-slot="input" disabled><span data-xp-slot="state"></span></div>')
    + xpTemplate('whm-php-version-action', '<button type="button" class="v2-btn" disabled><span data-xp-slot="content"></span></button>')
    + xpTemplate('whm-php-version-remove', '<button type="button" class="v2-btn v2-btn--danger" disabled><span data-xp-slot="content"></span></button>')
    + xpTemplate('whm-php-version-tab', '<button type="button" role="tab" disabled><bdi class="v2-mono" dir="ltr" data-xp-slot="content"></bdi></button>')
  const summary = `<div class="v2-kpi-row">${[
    { label: t(msgid('Host')), value: readable ? props.hostname ?? unread : unread, icon: 'server' as const },
    { label: t(msgctxt('theme:v2', 'Default for new domains')), value: readable ? props.serverSettings?.defaultPhpVersion ?? unread : unread, icon: 'code' as const, valueHooks: { 'data-whm-php-default': true, 'data-php-default-known': readable && !!props.serverSettings?.defaultPhpVersion } },
    { label: t(msgid('Domains')), value: savedDomains ? String(savedDomains.length) : unread, icon: 'globe' as const },
    { label: t(msgctxt('theme:v2', 'FPM pools')), value: unread, icon: 'layers' as const },
  ].map(item => kpiCard({ ...item, note: t(msgctxt('theme:v2', 'Saved configuration does not establish running pool state.')) })).join('')}</div>`
  const runtime = `<div class="v2-host__groups" data-whm-php-workspace data-php-version-layout="table" data-php-can-read="${readable}">
<div class="v2-host__actions">${hostButton(t(msgid('Read PHP inventory')), { 'data-whm-php-refresh': true }, { disabled: !readable })}</div>
<p data-whm-php-status data-state="unread" role="status">${escapeHtml(t(msgid('Installed packages and runtime binaries have not been read.')))}</p>
${hostFacts([{ label: t(msgid('Inventory source')), valueHtml: `<span data-whm-php-source>${escapeHtml(unread)}</span>` }, { label: t(msgid('Observed at (UTC)')), valueHtml: `<span data-whm-php-observed-at>${escapeHtml(unread)}</span>` }])}
${hostTable(t, 'php-versions', t(msgid('Installed PHP versions')), [t(msgid('Version')), t(msgid('Lifecycle')), t(msgid('Binary and FPM')), t(msgid('Used by')), t(msgid('Packages')), t(msgid('Actions'))], [], t(msgid('Installed packages and runtime binaries have not been read.')), { 'data-whm-php-version-entries': true })}
<p data-whm-php-binary-status>${escapeHtml(t(msgid('Binary probes ignore php.ini. Built-in CLI extensions do not establish FPM extension enablement, global defaults or a successful application request.')))}</p>
<h3>${escapeHtml(t(msgid('Saved domain assignments')))}</h3>${hostTable(t, 'php-usage', t(msgid('Saved PHP domain assignments')), [t(msgid('Version')), t(msgid('Domain')), t(msgid('Account')), t(msgid('Handler'))], [], t(msgid('No assignments have been read.')), { 'data-whm-php-usage': true })}${templates}</div>`
  const versions = hostCard('php-versions', t(msgid('Installed versions')), `${runtime}
<div class="v2-host__fields">${select('php-selected-version', msgid('Selected version'))}</div><div class="v2-host__actions">${button('set-default', msgid('Set as default'))}${button('reinstall-version', msgid('Reinstall selected version'))}${button('remove-version', msgid('Remove selected version'), true)}</div>
<details><summary>${escapeHtml(t(msgid('Confirm version removal')))}</summary><div class="v2-host__actions">${button('confirm-remove', msgid('Remove version'), true)}${button('cancel-remove', msgid('Cancel'))}</div></details>${note}`, scope('php-versions'))
  const install = hostCard('php-install', t(msgid('Install another version')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'Versions are installed side by side. Existing domains keep their version.')))}</p><ul class="v2-host__unavailable" data-whm-php-installable><li>${escapeHtml(unread)}</li></ul>${input('php-install-request', msgid('Package version'))}<div class="v2-host__actions">${button('install-version', msgid('Install selected PHP version'))}</div>${note}`, scope('php-install'))
  const handlers = hostCard('php-handlers', t(msgid('Handlers')), hostTable(t, 'php-handlers', t(msgid('PHP handler compatibility')), [t(msgid('Handler')), t(msgid('Runs as')), t(msgid('Where it runs')), t(msgid('Version')), t(msgid('Domains')), t(msgid('Offered to accounts'))], [
    ['PHP-FPM', 'Apache', t(msgid('Per-account pool'))], ['CGI / suexec', 'Apache', t(msgid('Account UID'))], ['suPHP', 'Apache', t(msgid('Account UID'))], ['lsphp', 'OpenLiteSpeed', t(msgid('Account external app'))],
  ].map(([handler, engine, identity]) => ({ cellsHtml: [technical(handler), escapeHtml(identity!), technical(engine), escapeHtml(unread), escapeHtml(unread), escapeHtml(unread)] })), t(msgid('No records have been read.')), { 'data-whm-php-handler-rows': true })
  + `<p>${escapeHtml(t(msgctxt('theme:v2', 'Handler availability has not been read. A saved assignment does not establish runtime compatibility.')))}</p>`)
  const pool = hostCard('php-pool', t(msgctxt('theme:v2', 'PHP-FPM process manager')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'Each account pool runs inside its account slice. The server pool defaults are further down this page.')))}</p><div class="v2-host__fields">${select('v2-php-pool-mode', msgid('Process manager'), ['ondemand', 'dynamic', 'static'].map(value => ({ value, label: value })))}${input('v2-php-pool-max-children', 'pm.max_children', 'number')}${input('v2-php-pool-idle', 'pm.process_idle_timeout', 'number')}${input('v2-php-pool-start', 'pm.start_servers', 'number')}${input('v2-php-pool-min-spare', 'pm.min_spare_servers', 'number')}${input('v2-php-pool-max-spare', 'pm.max_spare_servers', 'number')}${input('v2-php-pool-max-requests', 'pm.max_requests', 'number')}</div><p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Global pool settings have no connected write operation in this workspace.')))}</p>`)
  const extensions = hostCard('php-extensions', t(msgid('Extensions per version')), `${select('php-extension-version', msgid('Extensions for PHP version'))}${hostTable(t, 'php-extensions', t(msgid('Extensions per version')), [t(msgid('Extension')), t(msgid('Package')), t(msgid('Purpose')), t(msgid('Enabled'))], [], t(msgid('No selected version has been read.')))}${note}`, scope('php-extensions'))
  const common = `<div class="v2-host__fields">${INI_FIELDS.map(name => input(name, name)).join('')}${formField({ id: 'v2-php-display-errors', label: 'display_errors', control: { kind: 'input', disabled: true, mono: true, dir: 'ltr', hooks: { 'data-php-display-errors': true }, placeholder: unread } })}</div><div class="v2-host__actions">${button('discard-ini', msgid('Discard'))}${button('apply-ini', msgid('Test and apply'))}</div>`
  const file = formField({ id: 'v2-php-ini', label: t(msgid('File contents')), control: { kind: 'textarea', name: 'php-ini', disabled: true, rows: 12, mono: true, dir: 'ltr' } }) + `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'The managed file has not been read.')))}</p>`
  const editor = `<div class="v2-host__groups" data-php-editor-modes data-presentation-tabs="panels">${tabs({ label: t(msgid('Editor mode')), tabs: [{ id: 'v2-php-common-tab', label: t(msgid('Common settings')), panelId: 'v2-php-common-panel', selected: true, hooks: { 'data-presentation-tab': 'common' } }, { id: 'v2-php-file-tab', label: t(msgid('Edit file')), panelId: 'v2-php-file-panel', selected: false, hooks: { 'data-presentation-tab': 'file' } }] })}${tabPanel({ id: 'v2-php-common-panel', tabId: 'v2-php-common-tab', sectionSpacing: true, bodyHtml: common })}${tabPanel({ id: 'v2-php-file-panel', tabId: 'v2-php-file-tab', sectionSpacing: true, hidden: true, bodyHtml: file })}</div>`
  const configuration = hostCard('php-configure', t(msgctxt('theme:v2', 'Global php.ini')), `<div class="v2-host__fields">${select('php-version', msgid('Version'))}</div>${editor}${note}`, scope('php-configure'))
  const effective = hostCard('php-effective', t(msgctxt('theme:v2', 'Saved and effective values')), hostTable(t, 'php-effective', t(msgctxt('theme:v2', 'Saved and effective values')), [t(msgid('Setting')), t(msgid('Saved')), t(msgctxt('theme:v2', 'Effective in pools'))], [...INI_FIELDS, 'display_errors', 'pm'].map(name => ({ cellsHtml: [technical(name), escapeHtml(unread), escapeHtml(unread)] })), unread)
    + `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Effective pool values have not been read. No php.ini setting is presented as verified in a running application.')))}</p>`)
  const preview = hostCard('php-ini-preview', t(msgid('Preview of php.ini')), `<div class="v2-php-ini-preview" role="region" tabindex="0" aria-label="${escapeHtml(t(msgid('Preview of php.ini')))}"><p>${escapeHtml(unread)}</p></div><p role="status">${escapeHtml(t(msgctxt('theme:v2', 'The managed file has not been read.')))}</p><div class="v2-host__actions">${hostButton(t(msgid('Copy php.ini')), { 'data-php-ini-copy': true }, { disabled: true })}</div>`)
  const functions = hostCard('php-functions', t(msgid('Dangerous functions')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'Only root grants per-account exceptions. Saved exceptions and active runtime policy are separate observations.')))}</p>
<div class="v2-host__choices">${FUNCTIONS.map(name => `<code>${escapeHtml(name)}</code>`).join('')}</div>
<div class="v2-host__actions">${button('add-exception', msgid('Add exception'))}</div><div class="v2-php-exceptions-layout">${hostTable(t, 'php-functions', t(msgid('Function exceptions')), [t(msgid('Account')), t(msgid('Allowed')), t(msgid('Reason')), t(msgid('Granted (UTC)')), t(msgid('Action'))], [], t(msgctxt('theme:v2', 'Function exceptions have not been read.')))}
<details class="v2-php-exception-editor"><summary>${escapeHtml(t(msgid('New exception')))}</summary><aside class="v2-host__groups" aria-label="${escapeHtml(t(msgid('New exception')))}"><div class="v2-host__fields">${select('php-exception-account', msgid('Account'), (accounts ?? []).map(account => ({ value: account.username, label: account.username })))}${formField({ id: 'v2-php-exception-reason', label: t(msgid('Reason')), control: { kind: 'textarea', name: 'php-exception-reason', disabled: true, rows: 3 } })}</div>
<fieldset><legend>${escapeHtml(t(msgid('Allow these functions')))}</legend><div class="v2-host__choices">${FUNCTIONS.map(name => `<label class="v2-host__choice"><input type="checkbox" name="php-exception-${name}" disabled><bdi dir="ltr">${name}</bdi></label>`).join('')}</div></fieldset>
<div class="v2-host__actions">${button('grant-exception', msgid('Grant exception'))}</div></aside></details></div>${note}`, scope('php-functions'))
  const subcard = (html: string): string => html.replace('<h2 ', '<h3 ').replace('</h2>', '</h3>')
  const configure = `<section class="v2-host__groups" aria-labelledby="v2-php-configure-heading"><h2 id="v2-php-configure-heading">${escapeHtml(t(msgctxt('approved-xwhm', 'Configure a version')))}</h2><div class="v2-tabs" data-php-version-tabs aria-label="${escapeHtml(t(msgid('PHP version')))}"></div><p data-php-version-tabs-status role="status">${escapeHtml(unread)}</p><div class="v2-host__groups" id="v2-php-version-panel" data-php-version-panel role="region" aria-label="${escapeHtml(t(msgctxt('approved-xwhm', 'Configure a version')))}" tabindex="0"><div class="v2-php-config-split">${subcard(extensions)}<div class="v2-host__stack">${subcard(configuration)}${subcard(effective)}${subcard(preview)}</div></div></div></section>`
  return hostPage(props, route, t(msgid('PHP versions and handlers')), t(msgid('Version inventory, engine compatibility, extensions and global defaults.')), `${summary}${versions}${install}${handlers}${pool}${configure}${functions}${readable ? renderV2HostTools(t, ['php-guardian'], readable) : ''}`)
}

/** PHP-only composition rules; the route asset owner appends this to the existing host stylesheet. */
export const WHM_PHP_CSS = `.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-config-split{display:grid;grid-template-columns:minmax(0,1.618fr) minmax(0,1fr);gap:var(--space-3);align-items:start}
.v2-host[data-whm-detail-route="/whm/software/php"] table:has(>tbody[data-whm-php-version-entries]){min-inline-size:1000px}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-binary{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-version-identity{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-binary>div,.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-packages{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-binary dt{font-size:12px;color:var(--muted)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-version-actions{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:start}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-extension-switch{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-extension-switch input{inline-size:18px;block-size:18px;accent-color:var(--accent-fill)}
.v2-host[data-whm-detail-route="/whm/software/php"] table bdi,.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-packages bdi{font-family:var(--font-mono)}
.v2-host[data-whm-detail-route="/whm/software/php"] [data-php-default-known]{font-family:var(--font-mono);direction:ltr;unicode-bidi:isolate}
.v2-host[data-whm-detail-route="/whm/software/php"] [data-php-version-tabs]{flex-wrap:nowrap;overflow-x:auto}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-version-actions>p{flex-basis:100%;font-size:13px;color:var(--muted)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-packages>p{font-size:13px;color:var(--warn)}
.v2-host[data-whm-detail-route="/whm/software/php"] [data-php-lifecycle=active] .v2-php-lifecycle{color:var(--ok);background:var(--ok-soft)}
.v2-host[data-whm-detail-route="/whm/software/php"] [data-php-lifecycle=security] .v2-php-lifecycle{color:var(--warn);background:var(--warn-soft)}
.v2-host[data-whm-detail-route="/whm/software/php"] [data-php-lifecycle=end-of-life] .v2-php-lifecycle{color:var(--bad);background:var(--bad-soft)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-ini-preview{min-block-size:160px;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--sunken)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-exceptions-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-3);align-items:start}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-exceptions-layout:has(.v2-php-exception-editor[open]){grid-template-columns:minmax(0,1.618fr) minmax(0,1fr)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-exception-editor>aside{padding-block-start:var(--space-2)}
@media(max-width:960px){.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-exceptions-layout:has(.v2-php-exception-editor[open]){grid-template-columns:minmax(0,1fr)}}
@media(max-width:960px){.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-config-split{grid-template-columns:minmax(0,1fr)}}`
