import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, deniedPage, esc, facts, field, fields, input, note, page, section, select, settingsContext, split, table, technical, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'

export function renderV2PanelPhpPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = 'PHP', description = t(msgid('Select the domain runtime, worker pool and per-site INI values.'))
  const php = c.selected?.php, editable = c.editable && !!php
  const value = (raw: unknown) => raw === undefined || raw === null ? '' : String(raw)
  const number = (name: string, label: string, raw: unknown, help?: string) => field(`v2-php-${name.replaceAll('.', '-')}`, label,
    input(`v2-php-${name.replaceAll('.', '-')}`, name, 'number', ` min="0" step="1" dir="ltr" value="${esc(value(raw))}" required`, !editable), help)
  const plain = (name: string, label: string, raw: unknown, help?: string) => field(`v2-php-${name.replaceAll('.', '-')}`, label,
    input(`v2-php-${name.replaceAll('.', '-')}`, name, 'text', ` dir="ltr" value="${esc(value(raw))}"`, !editable), help)
  const context = section('v2-php-domain', t(msgid('Domain and version')), fields(field('v2-php-domain-select', t(msgid('Domain')), select('v2-php-domain-select', 'domainId', (c.domains ?? []).map(domain => [domain.id, domain.name]), ' data-domain-php-select required', !editable, c.selected?.id))
    + plain('version', t(msgid('PHP version')), php?.version))
    + field('v2-php-handler', t(msgid('Handler')), `<span class="v2-select"><select id="v2-php-handler" name="handler"${!editable ? ' disabled' : ''}><option value="fpm"${php?.handler === 'fpm' ? ' selected' : ''}>PHP-FPM</option><option value="cgi"${php?.handler === 'cgi' ? ' selected' : ''}>CGI</option><option value="suphp"${php?.handler === 'suphp' ? ' selected' : ''} disabled>suPHP</option><option value="lsphp"${php?.handler === 'lsphp' ? ' selected' : ''} disabled>lsphp</option></select></span>`, t(msgid('The server validates runtime availability and handler compatibility before saving.')))
    + note(t(msgctxt('theme:v2', 'PHP-FPM keeps a pool for the domain. CGI starts a process for each request. Other handlers require server configuration and are not offered as account changes here.'))))
  const pool = section('v2-php-pool', t(msgid('PHP-FPM pool')), field('v2-php-mode', t(msgid('Process manager')), select('v2-php-mode', 'fpm.mode', [['ondemand', 'ondemand'], ['dynamic', 'dynamic'], ['static', 'static']], ' dir="ltr" required', !editable, php?.fpm.mode))
    + fields(number('fpm.maxChildren', 'pm.max_children', php?.fpm.maxChildren)
      + number('fpm.startServers', 'pm.start_servers', php?.fpm.startServers)
      + number('fpm.minSpareServers', 'pm.min_spare_servers', php?.fpm.minSpareServers)
      + number('fpm.maxSpareServers', 'pm.max_spare_servers', php?.fpm.maxSpareServers)
      + number('fpm.maxRequests', 'pm.max_requests', php?.fpm.maxRequests)
      + number('fpm.processIdleTimeoutSec', t(msgid('Idle timeout (seconds)')), php?.fpm.processIdleTimeoutSec))
    + note(t(msgctxt('theme:v2', 'The server checks pool values against the account plan. Worker memory and active process counts have not been measured here.'))))
  const ini = section('v2-php-ini', t(msgid('INI values')), fields(plain('ini.memory_limit', 'memory_limit', php?.ini.memory_limit)
    + plain('ini.upload_max_filesize', 'upload_max_filesize', php?.ini.upload_max_filesize)
    + plain('ini.post_max_size', 'post_max_size', php?.ini.post_max_size)
    + plain('ini.max_execution_time', 'max_execution_time', php?.ini.max_execution_time))
    + fields(field('v2-php-max-input', 'max_input_vars', input('v2-php-max-input', '', 'text', ` dir="ltr" value="${esc(value(php?.ini.max_input_vars))}"`))
      + field('v2-php-display-errors', 'display_errors', input('v2-php-display-errors', '', 'text', ` dir="ltr" value="${esc(value(php?.ini.display_errors))}"`))
      + field('v2-php-timezone', 'date.timezone', input('v2-php-timezone', '', 'text', ` dir="ltr" value="${esc(value(php?.ini['date.timezone']))}"`)))
    + note(t(msgctxt('theme:v2', 'Only the four enabled INI overrides are submitted. Additional saved values remain visible and are preserved by the existing update operation.')))
    + note(t(msgid('Leave an INI override blank to inherit the runtime default. Clearing a saved override removes it.')))
    + '<p role="status" data-domain-php-status hidden></p>'
    + actions(`<button type="reset" class="v2-btn"${!editable ? ' disabled' : ''}>${esc(t(msgid('Reset')))}</button><button type="submit" class="v2-btn v2-btn--primary"${!editable ? ' disabled' : ''}>${esc(t(msgid('Save PHP settings')))}</button>`))
  const running = section('v2-php-running', t(msgid('Running now')), facts([{ label: t(msgid('Version')), valueHtml: esc(t(msgid('Not read'))) }, { label: t(msgctxt('theme:v2', 'Runs as')), valueHtml: technical((c.account?.username ?? '')) }, { label: t(msgctxt('theme:v2', 'Socket')), valueHtml: esc(t(msgid('Not read'))) }, { label: t(msgctxt('theme:v2', 'Last reload')), valueHtml: esc(t(msgid('Not read'))) }]) + note(t(msgctxt('theme:v2', 'The form shows stored settings. It does not claim that a pool is running or that saved and running values match.'))))
  const compare = section('v2-php-comparison', t(msgctxt('theme:v2', 'Saved and running')), table('v2-php-comparison-table', t(msgctxt('theme:v2', 'Saved and running')), [t(msgid('Setting')), t(msgid('Saved')), t(msgid('Running'))], php ? [['PHP', php.version], [t(msgid('Handler')), php.handler], ['pm.max_children', php.fpm.maxChildren]].map(([key, saved]) => `<tr><th scope="row">${technical(key!)}</th><td>${technical(saved!)}</td><td>${esc(t(msgid('Not read')))}</td></tr>`).join('') : unreadRow(3, t(msgid('Not read')))))
  const preview = section('v2-php-config', t(msgctxt('theme:v2', 'Configuration preview')), `<pre class="v2-panel-settings__preview v2-mono" dir="ltr">${esc(t(msgctxt('theme:v2', 'A generated pool or .user.ini file has not been read.')))}</pre>`)
    + section('v2-php-disabled-functions', t(msgctxt('theme:v2', 'Disabled functions')), note(t(msgctxt('theme:v2', 'The active disabled-function list has not been read.'))))
  const form = `<form data-domain-php-form${c.selected ? ` data-domain-id="${esc(c.selected.id)}"` : ''}${!editable ? ' data-readonly="true"' : ''}>${context}${pool}${ini}</form>`
  return page(props, authority, '/software/php', title, description, split(form, running + compare + preview))
}
