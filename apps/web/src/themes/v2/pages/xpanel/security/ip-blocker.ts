import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, esc, field, fields, input, note, page, section, settingsContext, status, table, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'

const cell = (slot: string): string => `<td><bdi dir="ltr" class="v2-mono" data-xp-slot="${slot}"></bdi></td>`
/** Theme-owned records the account edge controller fills. */
export const v2AccountEdgeTemplates = (): string => `<template data-xp-template="ip-blocker-row"><tr>${cell('entry')}${cell('first')}${cell('last')}<td><button type="button" class="v2-btn" data-xp-action="remove" disabled><span data-xp-slot="remove-label"></span></button></td></tr></template><template data-xp-template="ip-blocker-empty"><tr><td colspan="4" data-xp-slot="message"></td></tr></template>`

/** /security/ip-blocker: addresses refused by every site of the account at the server edge (cPanel IP Blocker). */
export function renderV2IpBlockerPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = t(msgid('IP blocker')), description = t(msgid('Stop given IP addresses, ranges or host names from reaching your websites.'))
  const add = section('v2-ipb-add', t(msgid('Block an address')), note(t(msgid('Requests from these addresses get HTTP 403 on every website of this account. Mail, FTP and the panels are not affected.')))
    + fields(field('v2-ipb-input', t(msgid('Address, range or host name')), input('v2-ipb-input', '', 'text', ' class="v2-mono" dir="ltr" maxlength="255" spellcheck="false" autocomplete="off" data-ipb-input aria-describedby="v2-ipb-input-help v2-ipb-error"'),
      t(msgid('For example 192.0.2.7, 10.5.3.3-40, 192.0.2.0/24, 10. or bad.example.com. Ranges are saved as the exact CIDR blocks that cover them; a host name is saved as the addresses it resolves to now.'))))
    + '<p class="v2-field__error" id="v2-ipb-error" data-ipb-error hidden></p>'
    + status(t(msgid('The blocked addresses have not been read.')), { 'data-ipb-status': true }),
    actions(button(t(msgid('Add')), { 'data-ipb-add': true }, true, true) + button(t(msgid('Read blocked addresses')), { 'data-ipb-refresh': true })))
  const list = section('v2-ipb-list', t(msgid('Currently blocked addresses')), `<p data-ipb-count>${esc(t(msgid('Not read')))}</p>`
    + table('v2-ipb-table', t(msgid('Currently blocked addresses')), [t(msgid('Server setting')), t(msgid('First address')), t(msgid('Last address')), t(msgid('Actions'))], unreadRow(4, t(msgid('Not read.'))), { 'data-ipb-rows': true }))
  const limits = section('v2-ipb-limits', t(msgid('Limits of this page')), `<ul>${[msgid('At most 1000 blocks per account. Loopback addresses that the server uses to reach its own sites cannot be blocked.'), msgid('Behind a CDN or another proxy, the edge sees the visitor address only when the server trusts that proxy (Trusted proxies). Otherwise the proxy address is what is blocked.'), msgid('A host name is resolved once, when it is added. Later changes to its addresses are not followed.')].map(copy => `<li>${esc(t(copy))}</li>`).join('')}</ul>`)
  return page(props, authority, '/security/ip-blocker', title, description, add + list + limits + v2AccountEdgeTemplates(), { 'data-ip-blocker': true, 'data-ipb-account': c.account?.id ?? '', 'data-ipb-manage': String(c.editable) })
}

/** Cache controls for /software/optimize: the account's switch and purge for the server edge response cache. */
export function renderV2EdgeCacheSection(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c
  return section('v2-edge-cache', t(msgid('Response cache for your sites')), note(t(msgid('Purging drops every cached response of your sites at once: the next visit to each page asks your site again. Turning the cache off sends every request to your sites.')))
    + `<dl class="v2-panel-settings__facts"><div><dt>${esc(t(msgid('Cache')))}</dt><dd data-edge-cache-state>${esc(t(msgid('Not read')))}</dd></div><div><dt>${esc(t(msgid('Last purge')))}</dt><dd><bdi dir="ltr" data-edge-cache-purged>${esc(t(msgid('Not read')))}</bdi></dd></div></dl>`
    + status(t(msgid('The cache settings have not been read.')), { 'data-edge-cache-status': true }),
    actions(button(t(msgid('Purge cache')), { 'data-edge-cache-purge': true }, true, true) + button(t(msgid('Turn the cache off')), { 'data-edge-cache-toggle': true })),
    { 'data-edge-cache': true, 'data-ec-account': c.account?.id ?? '', 'data-ec-manage': String(c.editable) })
}
