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
    : h.section('v2-developer-extra', msgid('Additional capabilities'), [msgid('Hooks and callbacks'), msgid('Registered applications'), msgid('Plugin generator'), msgid('Metrics export and debug tools')].map(label => `<div class="v2-admin-subgroup"><h3>${h.text(label)}</h3><p>${h.text(msgid('Unavailable'))}</p>${h.actions(h.button(msgctxt('theme:v2', 'Configure')))}</div>`).join(''))
  const supported = surface === 'administrator' ? h.section('v2-developer-supported', msgctxt('theme:v2', 'Supported operations'), h.table('v2-developer-supported-operations', msgctxt('theme:v2', 'Supported operations'), [msgid('Operation'), msgid('Method'), msgid('API route')], undefined, [['identity', '/api/auth/me'], ['preferences', '/api/admin/preferences'], ['tokens', '/api/server/panel/api-tokens']].map(([key, path]) => `<tr><td>${h.technical(key!)}</td><td>${h.technical('GET')}</td><td>${h.technical(path!)}</td></tr>`).join('')) + h.status(msgctxt('theme:v2', 'The authenticated manifest still decides which reviewed read is available in this session. Free request URLs and request bodies are not accepted.'))) : ''
  return `<div class="v2-admin-columns" data-developer-workspace data-developer-surface="${surface}" data-developer-enabled="${h.canRead}">${v2WhmClientTemplates('developer')}<div class="v2-admin-stack">${request}${response}${supported}</div><aside class="v2-admin-stack">${authority}${extra}</aside></div>`
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
  return h.page(msgid('Integrations'), msgid('Inspect your existing API integration credentials without revealing their values.'), explorer(h, 'integrations') + webhooks(h))
}

export function renderV2WhmDeveloper(t: Translate, props: WhmSurfaceProps, authority: WhmAdminAuthority = DENIED_ADMIN_AUTHORITY): string {
  const h = adminContext(t, props, authority, '/whm/panel/developer', 'panel')
  return h.page(msgid('Developer tools'), msgid('Run supported API read requests with your current session.'), explorer(h, 'administrator'))
}
