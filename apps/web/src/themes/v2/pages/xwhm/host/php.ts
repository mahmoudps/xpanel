import { DEFAULT_FPM } from '@xpanel/core'
import { escapeHtml, xpTemplate } from '../../../html.ts'
import { tabs, tabPanel } from '../../../components/tabs.ts'
import { renderV2HostTools } from '../server/host-tools.ts'
import { formField } from '../../../components/form-field.ts'
import { kpiCard } from '../../../components/kpi-card.ts'
import { columnLabels } from '../monitoring/common.ts'
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
  const select = (name: string, label: string, choices: readonly { value: string; label: string; selected?: boolean }[] = []): string =>
    formField({ id: `v2-${name}`, label: t(label), control: { kind: 'select', name, disabled: true, dir: 'ltr', options: choices } })
  const input = (name: string, label: string, type: 'text' | 'number' = 'text', value?: string | number): string =>
    formField({ id: `v2-php-${name}`, label: t(label), control: { kind: 'input', name, type, disabled: true, mono: true, dir: 'ltr', ...(value !== undefined ? { value: String(value) } : {}) } })
  const button = (name: string, label: string, danger = false): string => hostButton(t(label), { 'data-php-action': name }, { disabled: true, danger })
  const scope = (key: string) => ({ 'data-whm-detail-section': key })
  // Phone rows name each stacked value with its column header.
  const labelled = (label: string, html: string): string => `<span data-phone-label="${escapeHtml(label)}">${html}</span>`
  const note = `<p data-php-manage-status role="status"><span data-php-status-content></span></p>`
  const templates = xpTemplate('whm-php-version-entry', `<tr><td><div class="v2-php-version-identity"><strong><bdi class="v2-mono" dir="ltr" data-xp-slot="version"></bdi></strong><span class="v2-pill v2-pill--info" data-xp-slot="default-holder" hidden><span class="v2-pill__dot" aria-hidden="true"></span><span data-xp-slot="default-label"></span></span></div></td><td><span class="v2-pill v2-pill--neutral v2-php-lifecycle"><span class="v2-pill__dot" aria-hidden="true"></span><span data-xp-slot="lifecycle"></span></span><p class="v2-muted">${escapeHtml(t(msgid('Support dates')))}: ${escapeHtml(unread)}</p></td><td><dl class="v2-php-binary"><div><dt>${escapeHtml(t(msgid('Binary')))}</dt><dd><span data-xp-slot="binary"></span></dd></div><div><dt>FPM</dt><dd><span data-xp-slot="fpm"></span></dd></div></dl></td><td><span data-xp-slot="usage"></span></td><td><div class="v2-php-packages" data-xp-slot="packages"></div></td><td><div class="v2-php-version-actions" data-xp-slot="actions"></div></td></tr>`)
    + xpTemplate('whm-php-versions-empty', '<tr><td colspan="6"><span data-xp-slot="content"></span></td></tr>')
    + xpTemplate('whm-php-status', '<p data-php-manage-status role="status"><span data-php-status-content data-xp-slot="content"></span></p>')
    + xpTemplate('whm-php-revoke', '<button type="button" class="v2-btn v2-btn--danger" disabled><span data-xp-slot="content"></span></button>')
    + xpTemplate('whm-php-extension-switch', '<div class="v2-php-extension-switch"><input type="checkbox" data-xp-slot="input" disabled><span data-xp-slot="state"></span></div>')
    + xpTemplate('whm-php-version-action', '<button type="button" class="v2-btn" disabled><span data-xp-slot="content"></span></button>')
    + xpTemplate('whm-php-version-remove', '<button type="button" class="v2-btn v2-btn--danger" disabled><span data-xp-slot="content"></span></button>')
    + xpTemplate('whm-php-version-tab', '<button type="button" role="tab" disabled><bdi class="v2-mono" dir="ltr" data-xp-slot="content"></bdi></button>')
  const poolDefaults = readable ? props.fpmPoolDefaults : undefined
  const poolCount = readable ? props.fpmPoolCount : undefined
  const summary = `<div class="v2-kpi-row">${[
    { label: t(msgid('Host')), value: readable ? props.hostname ?? unread : unread, icon: 'server' as const },
    { label: t(msgctxt('theme:v2', 'Default for new domains')), value: readable ? props.serverSettings?.defaultPhpVersion ?? unread : unread, icon: 'code' as const, valueHooks: { 'data-whm-php-default': true, 'data-php-default-known': readable && !!props.serverSettings?.defaultPhpVersion } },
    { label: t(msgid('Domains')), value: savedDomains ? String(savedDomains.length) : unread, icon: 'globe' as const },
    { label: t(msgctxt('theme:v2', 'FPM pools')), value: poolCount !== undefined ? String(poolCount) : unread, icon: 'layers' as const, valueHooks: { 'data-whm-php-pools-count': true } },
  ].map(item => kpiCard({ ...item, note: t(msgctxt('theme:v2', 'Saved configuration does not establish running pool state.')) })).join('')}</div>`
  const runtime = `<div class="v2-host__groups" data-whm-php-workspace data-php-version-layout="table" data-php-can-read="${readable}">
<div class="v2-host__actions">${hostButton(t(msgid('Read PHP inventory')), { 'data-whm-php-refresh': true }, { disabled: !readable })}</div>
<p data-whm-php-status data-state="unread" role="status">${escapeHtml(t(msgid('Installed packages and runtime binaries have not been read.')))}</p>
${hostFacts([{ label: t(msgid('Inventory source')), valueHtml: `<bdi dir="auto" data-whm-php-source>${escapeHtml(unread)}</bdi>` }, { label: t(msgid('Observed at (UTC)')), valueHtml: `<bdi dir="auto" data-whm-php-observed-at>${escapeHtml(unread)}</bdi>` }])}
${hostTable(t, 'php-versions', t(msgid('Installed PHP versions')), [t(msgid('Version')), t(msgid('Lifecycle')), t(msgid('Binary and FPM')), t(msgid('Used by')), t(msgid('Packages')), t(msgid('Actions'))], [], t(msgid('Installed packages and runtime binaries have not been read.')), { 'data-whm-php-version-entries': true })}
<p data-whm-php-binary-status>${escapeHtml(t(msgid('Binary probes ignore php.ini. Built-in CLI extensions do not establish FPM extension enablement, global defaults or a successful application request.')))}</p>
<h3>${escapeHtml(t(msgid('Saved domain assignments')))}</h3>${hostTable(t, 'php-usage', t(msgid('Saved PHP domain assignments')), [t(msgid('Version')), t(msgid('Domain')), t(msgid('Account')), t(msgid('Handler'))], [], t(msgid('No assignments have been read.')), { 'data-whm-php-usage': true })}${templates}</div>`
  const versions = hostCard('php-versions', t(msgid('Installed versions')), `${runtime}
<div class="v2-host__fields">${select('php-selected-version', msgid('Selected version'))}</div><div class="v2-host__actions">${button('set-default', msgid('Set as default'))}${button('reinstall-version', msgid('Reinstall selected version'))}${button('remove-version', msgid('Remove selected version'), true)}</div>
<details><summary>${escapeHtml(t(msgid('Confirm version removal')))}</summary><div class="v2-host__actions">${button('confirm-remove', msgid('Remove version'), true)}${button('cancel-remove', msgid('Cancel'))}</div></details>${note}`, scope('php-versions'))
  const install = hostCard('php-install', t(msgid('Install another version')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'Versions are installed side by side. Existing domains keep their version.')))}</p><ul class="v2-host__unavailable" data-whm-php-installable><li>${escapeHtml(unread)}</li></ul>${input('php-install-request', msgid('Package version'))}<div class="v2-host__actions">${button('install-version', msgid('Install selected PHP version'))}</div>${note}`, scope('php-install'))
  // The default version is the saved value at page load; installed versions arrive with the inventory read, so the change control stays in Installed versions.
  const savedDefault = readable ? props.serverSettings?.defaultPhpVersion : undefined
  const cgiDomains = savedDomains?.filter(domain => domain.php?.handler === 'cgi').length
  const defaults = hostCard('php-defaults', t(msgctxt('theme:v2', 'Defaults for new domains')), `<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'Existing domains keep their version and handler.')))}</p>
<div class="v2-php-default"><span class="v2-php-default__label" id="v2-php-default-version-label">${escapeHtml(t(msgctxt('theme:v2', 'Default version')))}</span><div class="v2-php-segment" role="group" aria-labelledby="v2-php-default-version-label" data-php-default-saved="${savedDefault ? 'saved' : 'unread'}"><span${savedDefault ? ' aria-current="true"' : ''}>${savedDefault ? technical(savedDefault) : escapeHtml(unread)}</span></div><span class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'Saved configuration when this page opened. Reload after changes to refresh this reference.')))}</span></div>
<div class="v2-php-default"><span class="v2-php-default__label">${escapeHtml(t(msgctxt('theme:v2', 'Default handler')))}</span><div class="v2-php-default__handler"><strong><bdi dir="ltr">PHP-FPM</bdi></strong><span class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'Always the default')))}</span></div><span class="v2-muted" data-php-default-cgi>${escapeHtml(savedDomains && cgiDomains !== undefined ? t(msgctxt('theme:v2', '{count} of {total} saved domains use CGI.'), { count: cgiDomains, total: savedDomains.length }) : t(msgctxt('theme:v2', 'Saved domain handlers have not been read.')))}</span></div>`)
  // The controller repaints these rows, so the phone labels come from the column headers on the wrapper.
  const handlerColumns = [msgid('Handler'), msgid('Runs as'), msgid('Where it runs'), msgid('Version'), msgid('Domains'), msgid('Offered to accounts')]
  const handlers = hostCard('php-handlers', t(msgid('Handlers')), `<div${columnLabels(t, handlerColumns)}>` + hostTable(t, 'php-handlers', t(msgid('PHP handler compatibility')), handlerColumns.map(label => t(label)), [
    ['PHP-FPM', 'Apache', t(msgid('Per-account pool'))], ['CGI / suexec', 'Apache', t(msgid('Account UID'))], ['suPHP', 'Apache', t(msgid('Account UID'))], ['lsphp', 'OpenLiteSpeed', t(msgid('Account external app'))],
  ].map(([handler, engine, identity]) => ({ cellsHtml: [technical(handler), escapeHtml(identity!), technical(engine), escapeHtml(unread), escapeHtml(unread), escapeHtml(unread)] })), t(msgid('No records have been read.')), { 'data-whm-php-handler-rows': true }) + '</div>'
  + `<p>${escapeHtml(t(msgctxt('theme:v2', 'Handler availability has not been read. A saved assignment does not establish runtime compatibility.')))}</p>`)
  const modes = [['ondemand', msgctxt('theme:v2', 'Workers start when a request arrives and stop when idle.')], ['dynamic', msgctxt('theme:v2', 'Keeps a few spare workers ready and adds more under load.')], ['static', msgctxt('theme:v2', 'Keeps a fixed number of workers in memory at all times.')]] as const
  const poolFact = (key: string, val: string | number | undefined): string =>
    val === undefined ? `<span data-whm-php-pool-fact="${key}">${escapeHtml(unread)}</span>` : `<bdi class="v2-mono" dir="ltr" data-whm-php-pool-fact="${key}">${escapeHtml(String(val))}</bdi>`
  const poolValues = poolDefaults ?? DEFAULT_FPM
  const poolFields = `<div class="v2-host__fields">${
    select('php-pool-mode', msgid('Process manager'), modes.map(([value]) => ({ value, label: value, selected: value === poolValues.mode })))
  }${input('php-pool-max-children', 'pm.max_children', 'number', poolValues.maxChildren)
  }${input('php-pool-idle-timeout', 'pm.process_idle_timeout', 'number', poolValues.processIdleTimeoutSec)
  }${input('php-pool-start-servers', 'pm.start_servers', 'number', poolValues.startServers)
  }${input('php-pool-min-spare', 'pm.min_spare_servers', 'number', poolValues.minSpareServers)
  }${input('php-pool-max-spare', 'pm.max_spare_servers', 'number', poolValues.maxSpareServers)
  }${input('php-pool-max-requests', 'pm.max_requests', 'number', poolValues.maxRequests)
  }</div><div class="v2-host__actions">${button('discard-pool', msgid('Discard'))}${button('apply-pool', msgid('Test and apply'))}</div>`
  const pool = hostCard('php-pool', t(msgctxt('theme:v2', 'PHP-FPM process manager')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'Each account pool runs inside its account slice. Inherited pools use these server-wide defaults unless overridden per domain.')))}</p>${
    hostFacts([{ label: t(msgid('Process manager')), valueHtml: poolFact('mode', poolDefaults?.mode) }])
  }<dl class="v2-php-modes__grid">${modes.map(([value, text]) => `<div class="v2-php-mode"><dt><bdi class="v2-mono" dir="ltr">${value}</bdi></dt><dd class="v2-muted">${escapeHtml(t(text))}</dd></div>`).join('')}</dl><h3>${escapeHtml(t(msgctxt('theme:v2', 'Pool settings')))}</h3>${
    hostFacts([
      { label: 'pm.max_children', valueHtml: poolFact('maxChildren', poolDefaults?.maxChildren) },
      { label: 'pm.process_idle_timeout', valueHtml: poolFact('processIdleTimeoutSec', poolDefaults ? `${poolDefaults.processIdleTimeoutSec}s` : undefined) },
      { label: 'pm.start_servers', valueHtml: poolFact('startServers', poolDefaults?.startServers) },
      { label: 'pm.min_spare_servers', valueHtml: poolFact('minSpareServers', poolDefaults?.minSpareServers) },
      { label: 'pm.max_spare_servers', valueHtml: poolFact('maxSpareServers', poolDefaults?.maxSpareServers) },
      { label: 'pm.max_requests', valueHtml: poolFact('maxRequests', poolDefaults?.maxRequests) },
    ])
  }${poolFields}${note}`, scope('php-pool'))
  const extensions = hostCard('php-extensions', t(msgid('Extensions per version')), `${select('php-extension-version', msgid('Extensions for PHP version'))}${hostTable(t, 'php-extensions', t(msgid('Extensions per version')), [t(msgid('Extension')), t(msgid('Package')), t(msgid('Purpose')), t(msgid('Enabled'))], [], t(msgid('No selected version has been read.')))}${note}`, scope('php-extensions'))
  const common = `<div class="v2-host__fields">${INI_FIELDS.map(name => input(name, name)).join('')}${formField({ id: 'v2-php-display-errors', label: 'display_errors', control: { kind: 'input', disabled: true, mono: true, dir: 'ltr', hooks: { 'data-php-display-errors': true }, placeholder: unread } })}</div><div class="v2-host__actions">${button('discard-ini', msgid('Discard'))}${button('apply-ini', msgid('Test and apply'))}</div>`
  const file = formField({ id: 'v2-php-ini', label: t(msgid('File contents')), control: { kind: 'textarea', name: 'php-ini', disabled: true, rows: 12, mono: true, dir: 'ltr' } }) + `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'The managed file has not been read.')))}</p>`
  const editor = `<div class="v2-host__groups" data-php-editor-modes data-presentation-tabs="panels">${tabs({ label: t(msgid('Editor mode')), tabs: [{ id: 'v2-php-common-tab', label: t(msgid('Common settings')), panelId: 'v2-php-common-panel', selected: true, hooks: { 'data-presentation-tab': 'common' } }, { id: 'v2-php-file-tab', label: t(msgid('Edit file')), panelId: 'v2-php-file-panel', selected: false, hooks: { 'data-presentation-tab': 'file' } }] })}${tabPanel({ id: 'v2-php-common-panel', tabId: 'v2-php-common-tab', sectionSpacing: true, bodyHtml: common })}${tabPanel({ id: 'v2-php-file-panel', tabId: 'v2-php-file-tab', sectionSpacing: true, hidden: true, bodyHtml: file })}</div>`
  const configuration = hostCard('php-configure', t(msgctxt('theme:v2', 'Global php.ini')), `<div class="v2-host__fields">${select('php-version', msgid('Version'))}</div>${editor}${note}`, scope('php-configure'))
  const effective = hostCard('php-effective', t(msgctxt('theme:v2', 'Saved and effective values')), hostTable(t, 'php-effective', t(msgctxt('theme:v2', 'Saved and effective values')), [t(msgid('Setting')), t(msgid('Saved')), t(msgctxt('theme:v2', 'Effective in pools'))], [...INI_FIELDS, 'display_errors', 'pm'].map(name => ({ cellsHtml: [
    technical(name),
    name === 'pm'
      ? (poolDefaults ? `<bdi class="v2-mono" dir="ltr" data-whm-php-saved-pm>${escapeHtml(poolDefaults.mode)}</bdi>` : `<span data-whm-php-saved-pm>${escapeHtml(unread)}</span>`)
      : `<span data-whm-php-saved-ini="${escapeHtml(name)}">${escapeHtml(unread)}</span>`,
    labelled(t(msgctxt('theme:v2', 'Effective in pools')), escapeHtml(unread)),
  ] })), unread)
    + `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Effective pool values have not been read. No php.ini setting is presented as verified in a running application.')))}</p>`)
  const preview = hostCard('php-ini-preview', t(msgid('Preview of php.ini')), `<div class="v2-php-ini-preview" role="region" tabindex="0" aria-label="${escapeHtml(t(msgid('Preview of php.ini')))}"><p>${escapeHtml(unread)}</p></div><p role="status">${escapeHtml(t(msgctxt('theme:v2', 'The managed file has not been read.')))}</p><div class="v2-host__actions">${hostButton(t(msgid('Copy php.ini')), { 'data-php-ini-copy': true }, { disabled: true })}</div>`)
  const functions = hostCard('php-functions', t(msgid('Dangerous functions')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'Only root grants per-account exceptions. Saved exceptions and active runtime policy are separate observations.')))}</p>
<div class="v2-host__choices">${FUNCTIONS.map(name => `<code>${escapeHtml(name)}</code>`).join('')}</div>
<div class="v2-host__actions">${button('add-exception', msgid('Add exception'))}</div><div class="v2-php-exceptions-layout">${hostTable(t, 'php-functions', t(msgid('Function exceptions')), [t(msgid('Account')), t(msgid('Allowed')), t(msgid('Reason')), t(msgid('Granted (UTC)')), t(msgid('Action'))], [], t(msgctxt('theme:v2', 'Function exceptions have not been read.')))}
<details class="v2-php-exception-editor"><summary>${escapeHtml(t(msgid('New exception')))}</summary><aside class="v2-host__groups" aria-label="${escapeHtml(t(msgid('New exception')))}"><div class="v2-host__fields">${select('php-exception-account', msgid('Account'), (accounts ?? []).map(account => ({ value: account.username, label: account.username })))}${formField({ id: 'v2-php-exception-reason', label: t(msgid('Reason')), control: { kind: 'textarea', name: 'php-exception-reason', disabled: true, rows: 3 } })}</div>
<fieldset><legend>${escapeHtml(t(msgid('Allow these functions')))}</legend><div class="v2-host__choices">${FUNCTIONS.map(name => `<label class="v2-host__choice"><input type="checkbox" name="php-exception-${name}" disabled><bdi dir="ltr">${name}</bdi></label>`).join('')}</div></fieldset>
<div class="v2-host__actions">${button('grant-exception', msgid('Grant exception'))}</div></aside></details></div>${note}`, scope('php-functions'))
  const subcard = (html: string): string => html.replace('<h2 ', '<h3 ').replace('</h2>', '</h3>')
  const configure = `<section class="v2-host__groups" aria-labelledby="v2-php-configure-heading"><h2 id="v2-php-configure-heading">${escapeHtml(t(msgctxt('approved-xwhm', 'Configure a version')))}</h2><div class="v2-tabs" data-php-version-tabs aria-label="${escapeHtml(t(msgid('PHP version')))}"></div><p data-php-version-tabs-status role="status">${escapeHtml(unread)}</p><div class="v2-host__groups" id="v2-php-version-panel" data-php-version-panel role="region" aria-label="${escapeHtml(t(msgctxt('approved-xwhm', 'Configure a version')))}" tabindex="0"><div class="v2-php-config-split"><div class="v2-host__stack">${subcard(extensions)}${subcard(effective)}</div><div class="v2-host__stack">${subcard(configuration)}${subcard(preview)}</div></div></div></section>`
  return hostPage(props, route, t(msgid('PHP versions and handlers')), t(msgid('Version inventory, engine compatibility, extensions and global defaults.')), `${summary}${versions}<div class="v2-php-install-split">${install}${defaults}</div>${handlers}${pool}${configure}${functions}${readable ? renderV2HostTools(t, ['php-guardian'], readable) : ''}`)
}

/** PHP-only composition rules; the route asset owner appends this to the existing host stylesheet. */
export const WHM_PHP_CSS = `.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-config-split{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:var(--space-3);align-items:stretch}
.v2-host[data-whm-detail-route="/whm/software/php"] :is(.v2-php-config-split,.v2-php-install-split)>.v2-card,.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-config-split>.v2-host__stack>.v2-card:last-child{flex:1 1 auto}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-config-split>.v2-host__stack>.v2-card:last-child>.v2-card__body{display:flex;flex-direction:column;flex:1 1 auto}
.v2-host[data-whm-detail-route="/whm/software/php"] table:has(>tbody[data-whm-php-version-entries]){min-inline-size:860px}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-config-split table{min-inline-size:0}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-config-split :is(th,td){white-space:normal;padding-inline:8px}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-binary{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-version-identity{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-binary>div,.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-packages{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-binary dt{font-size:12px;color:var(--muted)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-version-actions{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:start}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-extension-switch{display:flex;align-items:center;gap:var(--space-1);min-inline-size:var(--target);min-block-size:var(--target)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-extension-switch input{flex:none;accent-color:var(--accent-fill)}
.v2-host[data-whm-detail-route="/whm/software/php"] table bdi,.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-packages bdi{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.v2-host[data-whm-detail-route="/whm/software/php"] :is([data-whm-php-pool-fact],[data-whm-php-pools-count],.v2-kpi__value){font-variant-numeric:tabular-nums}
.v2-host[data-whm-detail-route="/whm/software/php"] [data-php-default-known]{font-family:var(--font-mono);font-variant-numeric:tabular-nums;direction:ltr;unicode-bidi:isolate}
.v2-host[data-whm-detail-route="/whm/software/php"] [data-php-version-tabs]{flex-wrap:nowrap;overflow-x:auto}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-version-actions>p{flex-basis:100%;font-size:13px;color:var(--muted)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-packages>p{font-size:13px;color:var(--warn)}
.v2-host[data-whm-detail-route="/whm/software/php"] [data-php-lifecycle=active] .v2-php-lifecycle{color:var(--ok);background:var(--ok-soft)}
.v2-host[data-whm-detail-route="/whm/software/php"] [data-php-lifecycle=security] .v2-php-lifecycle{color:var(--warn);background:var(--warn-soft)}
.v2-host[data-whm-detail-route="/whm/software/php"] [data-php-lifecycle=end-of-life] .v2-php-lifecycle{color:var(--bad);background:var(--bad-soft)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-ini-preview{flex:1 1 auto;min-block-size:160px;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--sunken)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-exceptions-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-3);align-items:start}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-exceptions-layout:has(.v2-php-exception-editor[open]){grid-template-columns:minmax(0,1.618fr) minmax(0,1fr)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-exception-editor>aside{padding-block-start:var(--space-2)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-kpi:first-child .v2-kpi__value>:first-child{font:600 16px/1.4 var(--font-mono);letter-spacing:0;overflow-wrap:anywhere;min-inline-size:0}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-install-split{display:grid;grid-template-columns:minmax(0,1.618fr) minmax(0,1fr);gap:var(--space-3);align-items:stretch}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-default{display:flex;flex-direction:column;gap:8px}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-default__label{font-size:13px;font-weight:600}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-segment{display:flex;gap:4px;padding:4px;border-radius:10px;background:var(--sunken)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-segment>span{flex:1 1 0;display:flex;align-items:center;justify-content:center;min-block-size:36px;padding-inline:12px;border-radius:8px;font-size:13px;font-weight:600;color:var(--muted)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-segment>[aria-current]{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-default__handler{display:flex;align-items:center;justify-content:space-between;gap:12px;min-block-size:44px;padding-inline:12px;border:1px solid var(--line);border-radius:10px;background:var(--subtle)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-default .v2-muted,.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-mode .v2-muted{font-size:12px;line-height:1.5}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-modes__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-mode{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-mode bdi{font-size:14px;font-weight:600}
.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-modes__grid+h3{margin-block-start:8px}
.v2-host[data-whm-detail-route="/whm/software/php"] details{padding-inline:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
.v2-host[data-whm-detail-route="/whm/software/php"] details[open]{padding-block-end:var(--space-2)}
.v2-host[data-whm-detail-route="/whm/software/php"] summary{min-block-size:var(--target);padding-block:10px;align-content:center;font-weight:600;cursor:pointer}
.v2-host[data-whm-detail-route="/whm/software/php"] input.v2-mono:placeholder-shown{font-family:inherit}
@media(max-width:960px){.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-install-split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:960px){.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-exceptions-layout:has(.v2-php-exception-editor[open]){grid-template-columns:minmax(0,1fr)}}
@media(max-width:960px){.v2-host[data-whm-detail-route="/whm/software/php"] .v2-php-config-split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-host[data-whm-detail-route="/whm/software/php"] [data-whm-php-handler-rows] td:nth-child(n+3):not([colspan]){grid-column:1/-1;display:flex;justify-content:space-between;align-items:baseline;gap:16px;text-align:end}.v2-host[data-whm-detail-route="/whm/software/php"] [data-whm-php-handler-rows] td:nth-child(n+3):not([colspan])::before{flex:none;font-size:13px;color:var(--muted);text-align:start}.v2-host[data-whm-detail-route="/whm/software/php"] [data-whm-php-handler-rows] td:nth-child(3):not([colspan])::before{content:var(--v2-col-3)}.v2-host[data-whm-detail-route="/whm/software/php"] [data-whm-php-handler-rows] td:nth-child(4):not([colspan])::before{content:var(--v2-col-4)}.v2-host[data-whm-detail-route="/whm/software/php"] [data-whm-php-handler-rows] td:nth-child(5):not([colspan])::before{content:var(--v2-col-5)}.v2-host[data-whm-detail-route="/whm/software/php"] [data-whm-php-handler-rows] td:nth-child(6):not([colspan])::before{content:var(--v2-col-6)}.v2-host[data-whm-detail-route="/whm/software/php"] .v2-kpi{min-inline-size:0}.v2-host[data-whm-detail-route="/whm/software/php"] .v2-kpi:is(:first-child,:last-child){grid-column:1/-1}.v2-host[data-whm-detail-route="/whm/software/php"] .v2-kpi__value{font-size:18px;overflow-wrap:anywhere}}`
