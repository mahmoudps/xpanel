import type { PanelSurfaceProps } from '../../../../contract.ts'
import { card, statusPill, tabPanel, tabs } from '../../../components/index.ts'
import { esc, facts, field, fields, input, note, page, phoneLabels, select, settingsContext, split, technical, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'

/** PanelPhp board: status strip, tabbed settings, save bar and the running-configuration rail. Core's form controller is bound to the selects and field names. */
export function renderV2PanelPhpPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = 'PHP', description = t(msgid('Select the domain runtime, worker pool and per-site INI values.'))
  const php = c.selected?.php, editable = c.editable && !!php
  const notRead = esc(t(msgid('Not read')))
  const value = (raw: unknown) => raw === undefined || raw === null ? '' : String(raw)
  const number = (name: string, label: string, raw: unknown, unit?: string) => field(`v2-php-${name.replaceAll('.', '-')}`, label,
    `<span class="v2-panel-php-unit">${input(`v2-php-${name.replaceAll('.', '-')}`, name, 'number', ` min="0" step="1" dir="ltr" value="${esc(value(raw))}" required`, !editable)}${unit ? `<span>${esc(unit)}</span>` : ''}</span>`)
  const plain = (name: string, label: string, raw: unknown, help?: string) => field(`v2-php-${name.replaceAll('.', '-')}`, label,
    input(`v2-php-${name.replaceAll('.', '-')}`, name, 'text', ` dir="ltr" value="${esc(value(raw))}"`, !editable), help)
  const heading = (id: string, text: string, sub?: string, pill?: string) => `<div class="v2-panel-php-head"><div><h2 id="${id}">${esc(text)}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${pill ?? ''}</div>`
  const unreadPill = statusPill({ tone: 'neutral', label: t(msgid('Not read')), hollow: true })

  // Status strip: the domain's stored runtime beside the domain, version and handler controls; running facts below.
  const stored = php ? `PHP ${php.version} · ${php.handler === 'fpm' ? 'PHP-FPM' : php.handler === 'cgi' ? 'CGI' : php.handler}` : t(msgid('Not read'))
  const status = `<section class="v2-card v2-card--flush v2-panel-php-status" aria-labelledby="v2-php-domain-heading" id="v2-php-domain">
<div class="v2-panel-php-status__top"><div class="v2-panel-php-status__tile"><div><span aria-hidden="true"></span><h2 id="v2-php-domain-heading">${c.selected ? technical(c.selected.name) : esc(t(msgid('Domain and version')))}</h2></div><p>${esc(t(msgid('Saved')))}: ${technical(stored)}</p><p>${esc(t(msgctxt('theme:v2', 'The form shows stored settings. It does not claim that a pool is running or that saved and running values match.')))}</p></div>
<div class="v2-panel-php-status__fields">${field('v2-php-domain-select', t(msgid('Domain')), select('v2-php-domain-select', 'domainId', (c.domains ?? []).map(domain => [domain.id, domain.name]), ' data-domain-php-select dir="ltr" required', !editable, c.selected?.id))}${plain('version', t(msgid('PHP version')), php?.version)}${field('v2-php-handler', t(msgid('Handler')), `<span class="v2-select"><select id="v2-php-handler" name="handler"${!editable ? ' disabled' : ''}><option value="fpm"${php?.handler === 'fpm' ? ' selected' : ''}>PHP-FPM</option><option value="cgi"${php?.handler === 'cgi' ? ' selected' : ''}>CGI</option><option value="suphp"${php?.handler === 'suphp' ? ' selected' : ''} disabled>suPHP</option><option value="lsphp"${php?.handler === 'lsphp' ? ' selected' : ''} disabled>lsphp</option></select></span>`, t(msgid('The server validates runtime availability and handler compatibility before saving.')))}</div></div>
<div class="v2-panel-php-status__running" id="v2-php-running"><h3 id="v2-php-running-heading">${esc(t(msgid('Running now')))}</h3>${facts([{ label: t(msgid('Version')), valueHtml: notRead }, { label: t(msgctxt('theme:v2', 'Runs as')), valueHtml: c.account ? technical(c.account.username) : notRead }, { label: t(msgctxt('theme:v2', 'Socket')), valueHtml: notRead }, { label: t(msgctxt('theme:v2', 'Last reload')), valueHtml: notRead }])}</div></section>`

  const handlers = ([['fpm', 'PHP-FPM', true], ['cgi', 'CGI', true], ['suphp', 'suPHP', false], ['lsphp', 'lsphp', false]] as const).map(([id, label, offered]) =>
    `<li${php?.handler === id ? ' data-current="true"' : ''}${offered ? '' : ' data-offered="false"'}><strong>${label}</strong>${php?.handler === id ? statusPill({ tone: 'info', label: t(msgid('Saved')) }) : ''}<span>${esc(offered ? t(msgctxt('theme:v2', 'Checked when submitted')) : t(msgctxt('theme:v2', 'Requires server configuration')))}</span></li>`).join('')
  const runtime = heading('v2-php-runtime-heading', t(msgid('Domain and version')))
    + `<div class="v2-panel-php-box">${facts([{ label: t(msgid('Binary')), valueHtml: notRead }, { label: t(msgid('Extensions')), valueHtml: notRead }, { label: t(msgid('Support')), valueHtml: notRead }])}</div>`
    + `<div class="v2-field"><h3>${esc(t(msgid('Handler')))}</h3><ul class="v2-panel-php-handlers">${handlers}</ul></div>`
    + note(t(msgctxt('theme:v2', 'PHP-FPM keeps a pool for the domain. CGI starts a process for each request. Other handlers require server configuration and are not offered as account changes here.')))
  const pool = heading('v2-php-pool-heading', t(msgid('PHP-FPM pool')), c.selected ? technical(c.selected.name) : undefined, unreadPill)
    + field('v2-php-mode', t(msgid('Process manager')), select('v2-php-mode', 'fpm.mode', [['ondemand', 'ondemand'], ['dynamic', 'dynamic'], ['static', 'static']], ' dir="ltr" required', !editable, php?.fpm.mode))
    + fields(number('fpm.maxChildren', 'pm.max_children', php?.fpm.maxChildren, t(msgctxt('theme:v2', 'children')))
      + number('fpm.startServers', 'pm.start_servers', php?.fpm.startServers, t(msgctxt('theme:v2', 'servers')))
      + number('fpm.minSpareServers', 'pm.min_spare_servers', php?.fpm.minSpareServers, t(msgctxt('theme:v2', 'servers')))
      + number('fpm.maxSpareServers', 'pm.max_spare_servers', php?.fpm.maxSpareServers, t(msgctxt('theme:v2', 'servers')))
      + number('fpm.maxRequests', 'pm.max_requests', php?.fpm.maxRequests, t(msgctxt('theme:v2', 'requests')))
      + number('fpm.processIdleTimeoutSec', t(msgid('Idle timeout (seconds)')), php?.fpm.processIdleTimeoutSec))
    + `<div class="v2-panel-php-box v2-panel-php-memory"><div><strong>${esc(t(msgctxt('theme:v2', 'Memory at full load')))}</strong><span>${esc(t(msgid('Not measured')))}</span></div><div class="v2-bar" aria-hidden="true"></div><p>${esc(t(msgctxt('theme:v2', 'The server checks pool values against the account plan. Worker memory and active process counts have not been measured here.')))}</p></div>`
  const ini = heading('v2-php-ini-heading', t(msgid('INI values')), esc(t(msgid('Leave an INI override blank to inherit the runtime default. Clearing a saved override removes it.'))))
    + fields(plain('ini.memory_limit', 'memory_limit', php?.ini.memory_limit)
      + plain('ini.upload_max_filesize', 'upload_max_filesize', php?.ini.upload_max_filesize)
      + plain('ini.post_max_size', 'post_max_size', php?.ini.post_max_size)
      + plain('ini.max_execution_time', 'max_execution_time', php?.ini.max_execution_time)
      + field('v2-php-max-input', 'max_input_vars', input('v2-php-max-input', '', 'text', ` dir="ltr" value="${esc(value(php?.ini.max_input_vars))}"`))
      + field('v2-php-display-errors', 'display_errors', input('v2-php-display-errors', '', 'text', ` dir="ltr" value="${esc(value(php?.ini.display_errors))}"`))
      + field('v2-php-timezone', 'date.timezone', input('v2-php-timezone', '', 'text', ` dir="ltr" value="${esc(value(php?.ini['date.timezone']))}"`)))
    + note(t(msgctxt('theme:v2', 'Only the four enabled INI overrides are submitted. Additional saved values remain visible and are preserved by the existing update operation.')))
  const tabItems = [['runtime', t(msgid('Runtime')), runtime], ['pool', t(msgid('PHP-FPM pool')), pool], ['ini', t(msgid('INI values')), ini]] as const
  const settings = `<section class="v2-card v2-card--flush v2-panel-php-tabs" aria-label="${esc(t(msgid('Save PHP settings')))}" data-presentation-tabs="panels">${tabs({ label: t(msgid('Save PHP settings')), tabs: tabItems.map(([key, label]) => ({ id: `v2-php-tab-${key}`, label, panelId: `v2-php-${key}`, selected: key === 'pool', hooks: { 'data-presentation-tab': key } })) })}${tabItems.map(([key, , body]) => tabPanel({ id: `v2-php-${key}`, tabId: `v2-php-tab-${key}`, bodyHtml: body, hidden: key !== 'pool' })).join('')}</section>`
  const save = `<div class="v2-card v2-panel-php-save"><div><strong>${c.selected ? technical(c.selected.name) : title}</strong><p>${esc(t(msgid('Saved')))}: ${technical(stored)}</p><p role="status" data-domain-php-status hidden></p></div><div class="v2-panel-settings__actions"><button type="reset" class="v2-btn"${!editable ? ' disabled' : ''}>${esc(t(msgid('Reset')))}</button><button type="submit" class="v2-btn v2-btn--primary"${!editable ? ' disabled' : ''}>${esc(t(msgid('Save PHP settings')))}</button></div></div>`

  const compareRows = php ? [['PHP', php.version], [t(msgid('Handler')), php.handler], ['pm', php.fpm.mode], ['pm.max_children', php.fpm.maxChildren], ['memory_limit', php.ini.memory_limit ?? '—']].map(([key, saved], index) => `<tr><th scope="row">${index === 1 ? esc(String(key)) : technical(key!)}</th><td>${technical(saved!)}</td><td>${notRead}</td></tr>`).join('') : unreadRow(3, t(msgid('Not read')))
  const compare = card({ id: 'v2-php-comparison', title: t(msgctxt('theme:v2', 'Saved and running')), titleId: 'v2-php-comparison-heading', flush: true, actionsHtml: unreadPill,
    bodyHtml: `<div class="v2-panel-settings__table" role="region" tabindex="0" aria-labelledby="v2-php-comparison-table-caption"><table id="v2-php-comparison-table"${phoneLabels([t(msgid('Setting')), t(msgid('Saved')), t(msgid('Running'))])}><caption id="v2-php-comparison-table-caption" class="v2-sr">${esc(t(msgctxt('theme:v2', 'Saved and running')))}</caption><thead><tr>${[t(msgid('Setting')), t(msgid('Saved')), t(msgid('Running'))].map(head => `<th scope="col">${esc(head)}</th>`).join('')}</tr></thead><tbody>${compareRows}</tbody></table></div>` })
  const blank = (text: string) => `<p class="v2-panel-php-blank" role="status">${esc(text)}</p>`
  const preview = card({ id: 'v2-php-config', title: t(msgctxt('theme:v2', 'Configuration preview')), titleId: 'v2-php-config-heading', bodyHtml: blank(t(msgctxt('theme:v2', 'A generated pool or .user.ini file has not been read.'))) })
  const disabled = card({ id: 'v2-php-disabled-functions', title: t(msgctxt('theme:v2', 'Disabled functions')), titleId: 'v2-php-disabled-functions-heading', actionsHtml: unreadPill, bodyHtml: blank(t(msgctxt('theme:v2', 'The active disabled-function list has not been read.'))) })
  const form = `<form class="v2-panel-php" data-domain-php-form${c.selected ? ` data-domain-id="${esc(c.selected.id)}"` : ''}${!editable ? ' data-readonly="true"' : ''}>${status}${split(settings + save, compare + preview + disabled)}</form>`
  return page(props, authority, '/software/php', title, description, form)
}
