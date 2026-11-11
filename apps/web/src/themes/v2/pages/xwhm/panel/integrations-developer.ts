import { apiShellCard, errorReportingCard, metricsExportCard } from '../../../../../models/tool-cards.ts'
import { renderV2ToolCard } from '../../../tool-card-view.ts'
import { v2OpsClientTemplates } from '../../../ops-client-templates.ts'
import { v2WhmClientTemplates } from '../../../whm-client-templates.ts'
import type { Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { adminContext, DENIED_ADMIN_AUTHORITY, type AdminView, type WhmAdminAuthority } from '../server/common.ts'

function explorer(h: AdminView, surface: 'administrator' | 'integrations'): string {
  const prefix = `developer-${surface}`, fact = (key: string, label: string) => ({ label, hooks: { 'data-dev-fact': key } })
  const request = h.section(`v2-${prefix}-request`, surface === 'integrations' ? msgid('Inspect this integration') : msgid('API request explorer'), `<p>${h.text(msgid('Read live data using your current signed-in session. Choose a supported operation; its method and route are fixed. No server setting is changed.'))}</p>`
    + h.form({ 'data-dev-form': true }, h.field(`${prefix}-operation`, msgid('Operation'), h.select(`${prefix}-operation`, [['', msgid('Read supported operations first')]], { hooks: { 'data-dev-operation': true } })) + h.facts([fact('method', msgid('Method')), fact('path', msgid('API route'))])
      + h.actions(h.button(msgid('Run read request'), { 'data-dev-run': true }, { type: h.canRead ? 'submit' : 'button', primary: true }) + h.button(msgid('Read supported operations'), { 'data-dev-refresh': true }, { disabled: !h.canRead })), h.canRead)
    + h.status(h.canRead ? msgid('Supported operations have not been read.') : msgid('This session has not qualified this workspace. Its controls remain unavailable.'), { 'data-dev-status': true }))
  const response = h.section(`v2-${prefix}-response`, msgid('Response'), `<p>${h.text(msgid('Only reviewed response fields are shown. Credential values, session information and internal identifiers are omitted.'))}</p>` + h.facts([fact('status', msgid('HTTP status')), fact('observed', msgid('Read at (UTC)'))])
    + `<dl class="v2-admin-fields" data-dev-result-fields><div class="v2-admin-field"><dt>${h.text(msgid('Result'))}</dt><dd>${h.text(msgid('No read request has run.'))}</dd></div></dl><div data-dev-token-table hidden>${h.table(`v2-${prefix}-token-table`, msgid('Your API token metadata'), [msgid('Name'), msgid('Scopes'), msgid('Expires (UTC)'), msgid('State')], { 'data-dev-token-rows': true }, '')}</div>`
    + h.actions(h.button(msgid('Copy reviewed response'), { 'data-dev-copy': true })) + h.status(msgid('Not read'), { 'data-dev-copy-status': true }, true))
  const authority = h.section(`v2-${prefix}-authority`, msgid('Current authority'), `<p>${h.text(msgid('The account and principal come from this session. Every selected read repeats its normal API authentication and permissions. API tokens cannot operate this console.'))}</p>` + (surface === 'integrations' ? `<a class="v2-btn" href="/whm/panel/api-tokens">${h.text(msgid('Manage your API tokens'))}</a>` : ''))
  const extra = surface === 'integrations'
    ? h.section('v2-integrations-related', msgid('Additional capabilities'), `<ul class="v2-admin-list">${[['/whm/panel/whmcs', 'WHMCS'], ['/whm/panel/notifications', msgid('Notification delivery')], ['/whm/backups/destinations', msgctxt('theme:v2', 'Backup storage')], ['/whm/dns/providers', msgctxt('theme:v2', 'DNS providers')]].map(([href, label]) => `<li><a href="${href}">${h.text(label!)}</a></li>`).join('')}</ul><p>${h.text(msgctxt('theme:v2', 'Each integration uses its own authorized workspace and qualification. This explorer does not establish its connection or delivery state.'))}</p>`)
    : renderV2ToolCard(h.t, metricsExportCard, h.canManage)
  const supported = surface === 'administrator' ? h.section('v2-developer-supported', msgctxt('theme:v2', 'Supported operations'), h.table('v2-developer-supported-operations', msgctxt('theme:v2', 'Supported operations'), [msgid('Operation'), msgid('Method'), msgid('API route')], undefined, [['identity', '/api/auth/me'], ['preferences', '/api/admin/preferences'], ['tokens', '/api/server/panel/api-tokens']].map(([key, path]) => `<tr><td>${h.technical(key!)}</td><td>${h.technical('GET')}</td><td>${h.technical(path!)}</td></tr>`).join('')) + h.status(msgctxt('theme:v2', 'The authenticated manifest still decides which reviewed read is available in this session. Free request URLs and request bodies are not accepted.'))) : ''
  return `<div class="v2-admin-stack" data-developer-workspace data-developer-surface="${surface}" data-developer-can-read="${h.canRead}" data-developer-enabled="${h.canRead}">${v2WhmClientTemplates('developer')}<div class="v2-admin-columns"><div class="v2-admin-stack">${request}${response}${supported}</div><aside class="v2-admin-stack">${authority}${extra}</aside></div>${surface === 'administrator' ? renderV2ToolCard(h.t, apiShellCard('administrator'), h.canManage) : ''}</div>`
}

function webhooks(h: AdminView): string {
  const state = h.section('v2-integrations-webhooks', msgid('Webhooks'), h.status(h.canRead ? msgid('No webhook configuration has been read.') : msgid('Integrations require an authorized root administrator. Nothing was read or changed.'), { 'data-ops-int-status': true }) + h.facts([
    { label: msgid('Signature scheme'), technical: true, hooks: { 'data-ops-int-fact': 'scheme' } }, { label: msgid('Outbound delivery'), hooks: { 'data-ops-int-fact': 'egress' } }, { label: msgid('Signing secrets'), technical: true, hooks: { 'data-ops-int-fact': 'secrets' } },
  ]) + h.actions(h.button(msgid('Read webhooks'), { 'data-ops-int-action': 'read' }, { disabled: !h.canRead, primary: true })) + `<p>${h.text(msgid('Each endpoint is signed with HMAC-SHA256 over a timestamped body. Secrets are stored on the server and never shown here. Failed deliveries are retried on a fixed schedule and recorded in the delivery log.'))}</p>`)
  const list = h.section('v2-integrations-endpoints', msgid('Endpoints'), h.table('v2-integrations-endpoint-table', msgid('Webhook endpoints'), [msgid('Endpoint'), msgid('Events'), msgid('Signing secret'), msgid('Active'), msgid('Actions')], { 'data-ops-int-rows': true }, undefined, msgid('No webhook configuration has been read.')))
  const edit = `<section class="v2-card" data-ops-int-editor hidden aria-labelledby="v2-integrations-add"><h2 id="v2-integrations-add">${h.text(msgid('Add an endpoint'))}</h2>${h.field('ops-int-url', msgid('Payload URL (https)'), h.input('ops-int-url', { type: 'url', dir: 'ltr', hooks: { 'data-ops-int-url': true } }))}<fieldset data-ops-int-events disabled><legend>${h.text(msgid('Events'))}</legend></fieldset>${h.actions(h.button(msgid('Add endpoint'), { 'data-ops-int-add': true }) + h.button(msgid('Save webhooks'), { 'data-ops-int-save': true }))}<p>${h.text(msgid('A signing secret is generated when you save a new endpoint. Rotate a secret by removing and re-adding the endpoint.'))}</p></section>`
  const log = h.section('v2-integrations-log', msgid('Delivery log'), h.table('v2-integrations-log-table', msgid('Webhook delivery log'), [msgid('Delivery'), msgid('Event'), msgid('Result'), msgid('Attempts'), msgid('Last status')], { 'data-ops-int-log': true }, undefined, msgctxt('theme:v2', 'No webhook delivery log has been read.')))
  return `<div class="v2-admin-stack" data-ops-integrations-workspace data-int-can-read="${h.canRead}" data-int-can-manage="${h.canManage}">${state}${list}${edit}${log}${v2OpsClientTemplates('integrations')}</div>`
}

export function renderV2WhmIntegrations(t: Translate, props: WhmSurfaceProps, authority: WhmAdminAuthority = DENIED_ADMIN_AUTHORITY): string {
  const h = adminContext(t, props, authority, '/whm/panel/integrations', 'panel')
  return h.page(msgid('Integrations'), msgid('Inspect your existing API integration credentials without revealing their values.'), explorer(h, 'integrations') + renderV2ToolCard(h.t, errorReportingCard, h.canManage) + webhooks(h))
}

function hooks(h: AdminView): string {
  const action = (label: string, key: string) => h.button(label, { 'data-hooks-action': key })
  return h.section('v2-developer-hooks', msgid('Hooks'), `<p>${h.text(msgid('A hook runs a reviewed program when an account is created, suspended, unsuspended or terminated. It runs as the unprivileged nobody user without a shell, receives the event and the account enhancements as JSON on its input and is stopped at its timeout. A blocking hook that fails before an action stops that action. Each run is written to the audit log.'))}</p>`
    + h.facts([{ label: msgid('Reviewed hook directory'), technical: true, hooks: { 'data-hooks-directory': true } }])
    + h.table('v2-developer-hooks-table', msgid('Registered hooks, in run order'), [msgid('Event'), msgid('Hook stage'), msgid('Executable'), msgid('Attributes'), msgid('Review')], { 'data-hooks-rows': true })
    + h.fields(h.field('v2-developer-hooks-select', msgid('Hook'), h.select('v2-developer-hooks-select', [['', msgid('Select a hook')]], { hooks: { 'data-hooks-select': true } })))
    + h.actions(action(msgid('Enable'), 'enable') + action(msgid('Disable'), 'disable') + action(msgid('Move up'), 'up') + action(msgid('Move down'), 'down') + action(msgid('Delete hook'), 'delete') + action(msgid('Refresh'), 'refresh'))
    + `<p>${h.text(msgid('Register a hook with xwhmapi hooks register: the agent pins the file digest, and a changed file does not run until it is registered again.'))}</p>`
    + h.status(h.canManage ? msgid('Nothing has been read yet.') : msgid('This page requires an authorized administrator. Nothing was read or changed.'), { 'data-hooks-status': true }) + h.status(msgid('Not read'), { 'data-hooks-result': true }, true),
    { 'data-hooks-workspace': true, 'data-hooks-can-manage': String(h.canManage) })
}

function registeredApps(h: AdminView): string {
  return h.section('v2-developer-apps', msgid('Registered applications'), `<p>${h.text(msgid('Applications registered with this panel by their registration file. Removing a file removes its registration. Nothing here is fetched or run.'))}</p>`
    + h.table('v2-developer-apps-table', msgid('Registered applications'), [msgid('Application'), msgid('Interface'), msgid('Required privileges'), msgid('Entry address'), msgid('Origin'), msgid('State')], { 'data-registered-apps-rows': true })
    + h.actions(h.button(msgid('Refresh'), { 'data-registered-apps-refresh': true }, { disabled: !h.canRead }))
    + h.status(h.canRead ? msgid('Nothing has been read yet.') : msgid('This page requires an authorized administrator. Nothing was read or changed.'), { 'data-registered-apps-status': true }),
    { 'data-registered-apps-workspace': true, 'data-registered-apps-can-read': String(h.canRead) })
}

function plugins(h: AdminView): string {
  const action = (label: string, key: string, primary = false) => h.button(label, { 'data-plugin-packages-action': key }, { primary })
  const text = (key: string, label: string, options: { ltr?: boolean; maxLength: number; help?: string }) => h.field('v2-plugin-generator-' + key, label, h.input('v2-plugin-generator-' + key, { maxLength: options.maxLength, ...(options.ltr ? { dir: 'ltr' as const } : {}), hooks: { 'data-plugin-generator-input': key } }), options.help)
  return h.section('v2-developer-plugins', msgid('Plugins'), `<p>${h.text(msgid('A plugin adds icons to the home page of account owners. It is a list of links with a group, a priority and a 48 by 48 icon, and it contains no code. An item with a plan feature shows only to accounts whose plan has that feature.'))}</p>`
    + h.table('v2-developer-plugins-table', msgid('Installed plugins'), [msgid('Plugin'), msgid('Items'), msgid('Installed (UTC)'), msgid('State')], { 'data-plugin-packages-rows': true })
    + h.fields(h.field('v2-plugin-packages-select', msgid('Plugin'), h.select('v2-plugin-packages-select', [['', msgid('Select a plugin')]], { hooks: { 'data-plugin-packages-select': true } }))
      + h.field('v2-plugin-packages-file', msgid('Plugin package file'), h.input('v2-plugin-packages-file', { type: 'file', hooks: { 'data-plugin-packages-file': true } }).replace('<input ', '<input accept="application/json,.json,.gz,.tgz" '), msgid('An xpanel-plugin-package-v1 JSON file of up to 384 KiB, or a cPanel plugin .tar.gz archive of up to 1 MiB. A link into a cPanel plugin is refused, because this panel runs no plugin code.')))
    + h.actions(h.check(msgid('Replace a plugin with the same name'), { hooks: { 'data-plugin-packages-overwrite': true }, disabled: true }) + action(msgid('Install package'), 'install', true) + action(msgid('Download'), 'download') + action(msgid('Delete plugin'), 'delete') + action(msgid('Refresh'), 'refresh'))
    + `<div class="v2-admin-subgroup"><h3>${h.text(msgid('Plugin generator'))}</h3><p>${h.text(msgid('Build a package here, then install it on this server or another one.'))}</p>`
    + h.fields(text('name', msgid('Plugin name'), { ltr: true, maxLength: 64, help: msgid('Lowercase letters, digits, hyphens and underscores.') }) + text('id', msgid('Item id'), { ltr: true, maxLength: 64 }) + text('item', msgid('Item name'), { maxLength: 80 })
      + text('group', msgid('Group'), { maxLength: 40, help: msgid('An existing group or a new one.') }) + text('priority', msgid('Priority'), { ltr: true, maxLength: 2, help: msgid('1 to 99. Lower numbers come first.') })
      + text('uri', msgid('Address'), { ltr: true, maxLength: 512, help: msgid('A panel path such as /files or an https address.') }) + text('feature', msgid('Plan feature'), { ltr: true, maxLength: 64, help: msgid('Optional. An xPanel tool id, or plugin: and a new key for the Feature Manager.') })
      + h.field('v2-plugin-generator-icon', msgid('Icon'), h.input('v2-plugin-generator-icon', { type: 'file', hooks: { 'data-plugin-generator-icon': true } }).replace('<input ', '<input accept="image/png,image/svg+xml" '), msgid('A PNG or plain SVG of exactly 48 by 48 pixels, up to 16 KiB.')))
    + h.actions(action(msgid('Add item'), 'add') + action(msgid('Clear items'), 'clear') + action(msgid('Generate package'), 'generate', true))
    + h.table('v2-developer-plugin-items-table', msgid('Package items'), [msgid('Item id'), msgid('Item name'), msgid('Group'), msgid('Priority'), msgid('Address')], { 'data-plugin-generator-rows': true }, undefined, msgid('No items have been added.')) + `</div>`
    + h.status(h.canManage ? msgid('Nothing has been read yet.') : msgid('This page requires an authorized administrator. Nothing was read or changed.'), { 'data-plugin-packages-status': true }) + h.status(msgid('Not read'), { 'data-plugin-packages-result': true }, true),
    { 'data-plugin-packages-workspace': true, 'data-plugin-packages-can-manage': String(h.canManage) })
}

export function renderV2WhmDeveloper(t: Translate, props: WhmSurfaceProps, authority: WhmAdminAuthority = DENIED_ADMIN_AUTHORITY): string {
  const h = adminContext(t, props, authority, '/whm/panel/developer', 'panel')
  return h.page(msgid('Developer tools'), msgid('Run API functions, read the OpenAPI description and configure the metrics endpoint with your current session.'), explorer(h, 'administrator') + hooks(h) + registeredApps(h) + plugins(h))
}
