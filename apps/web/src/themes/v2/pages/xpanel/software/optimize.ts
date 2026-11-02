import { v2SoftwareOperationTemplates } from '../../xwhm/software/operation-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, deniedPage, esc, facts, note, page, section, settingsContext, status, table, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'

export function renderV2OptimizePage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = t(msgid('Optimize website')), description = t(msgid('See the compression and response cache that serve your sites.'))
  const policy = section('v2-optimize-policy', t(msgid('Compression')), note(t(msgid('Your sites are served through the server edge. This shows the compression and response cache it actually applies, read from its managed configuration.')))
    + facts([['compression', msgid('Compression')], ['min', msgid('Minimum response size')], ['proxied', msgid('Compress proxied responses')], ['cache', msgid('Response cache')]].map(([key, copy]) => ({ label: t(copy!), valueHtml: `<bdi dir="ltr" data-human data-sw-optimize-${key}>${esc(t(msgid('Not read')))}</bdi>` })))
    + `<div class="v2-field"><h3>${esc(t(msgid('Compressed content types')))}</h3><p data-sw-optimize-types>${esc(t(msgid('Not read')))}</p></div>`
    + status(t(msgid('The optimization policy has not been read.')), { 'data-sw-optimize-status': true }), actions(button(t(msgid('Read policy')), { 'data-sw-optimize-refresh': true }, !c.readable)))
  const sites = section('v2-optimize-sites', t(msgid('Your sites')), table('v2-optimize-table', t(msgid('Your sites')), [t(msgid('Domain')), t(msgid('Compression')), t(msgid('Response cache'))], unreadRow(3, t(msgid('Not read.'))), { 'data-sw-optimize-domains': true })
    + note(t(msgid('The cache stores GET and HEAD responses that carry no cookies or authorization. Redirected and suspended domains are not cached.'))))
  const controls = section('v2-optimize-controls', t(msgid('Per-site rules and cache purge')), note(t(msgid('Per-site compression choices, cache rules and purging cached pages are unavailable: no reviewed per-site edge setting or confined purge operation is connected. Nothing is changed here.'))), actions(button(t(msgid('Review & apply')), undefined, true, true) + button(t(msgid('Purge cache')))))
  return page(props, authority, '/software/optimize', title, description, policy + sites + controls + v2SoftwareOperationTemplates('optimize'), { 'data-sw-optimize': true, 'data-sw-can-read': String(c.readable) })
}
