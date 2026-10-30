import type { PanelSurfaceProps } from '../../../../contract.ts'
import { escapeHtml } from '../../../html.ts'
import { domainButton, domainCard, domainContext, domainFacts, domainHeader, domainTable, missingDomainAccount, NO_DOMAIN_AUTHORITY, type DomainPageAuthority } from './common.ts'

/** The account owner inspects linked zones and purges cache; provider credentials remain administrative. */
export function renderV2CloudflarePage(props: PanelSurfaceProps, authority: DomainPageAuthority = NO_DOMAIN_AUTHORITY): string {
  const { t, account, canManage } = domainContext(props, authority)
  const unread = t(msgid('Not read'))
  const domains = domainCard('cf-domains', t(msgid('Your domains on Cloudflare')), `<p data-sec-status data-state="unread" role="status">${escapeHtml(t(msgid('Nothing has been read yet.')))}</p>${domainTable(t(msgid('Your domains on Cloudflare')), [t(msgid('Domain')), t(msgid('Cloudflare')), t(msgid('Actions'))], `<tr><td colspan="3">${escapeHtml(t(msgid('No domains have been read.')))}</td></tr>`, { 'data-sec-rows': 'domains' })}<p>${escapeHtml(t(msgid('Your hosting provider connects domains to Cloudflare. For a connected domain you can inspect the zone and purge its cache.')))}</p><p data-sec-result role="status" hidden></p>`, domainButton(t(msgid('Refresh')), { 'data-sec-action': 'refresh' }, false))
  const zone = domainCard('cf-zone', t(msgid('Zone details')), `${domainFacts([
    { label: t(msgid('Domain')), key: 'zone-domain' }, { label: t(msgid('Zone status')), key: 'zone-status' },
    { label: t(msgid('SSL/TLS mode')), key: 'zone-ssl' }, { label: t(msgid('Cloudflare nameservers')), key: 'zone-ns' }, { label: t(msgid('Observed at (UTC)')), key: 'zone-at' },
  ].map(item => ({ label: item.label, valueHtml: `<bdi dir="ltr" data-sec-field="${item.key}">${escapeHtml(unread)}</bdi>` })))}<p data-sec-zone-truncated hidden>${escapeHtml(t(msgid('Only the first 500 Cloudflare records were compared.')))}</p>${domainTable(t(msgid('Records compared with this server')), [t(msgid('Name')), t(msgid('Type')), t(msgid('This server')), t(msgid('Cloudflare')), t(msgid('Proxied')), t(msgid('State'))], `<tr><td colspan="6">${escapeHtml(t(msgid('Select Inspect for a linked domain.')))}</td></tr>`, { 'data-sec-rows': 'records' })}`)
  return `<section class="v2-domain-page"${authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-sec-workspace data-sec-page="account-cloudflare" data-sec-can-read="${authority.canRead && authority.presentation !== 'read-only'}" data-sec-can-manage="${canManage}">${domainHeader(t, '/domains/cloudflare', t(msgid('Cloudflare')), t(msgid('Inspect the Cloudflare zone of your connected domains and purge their cache.')))}${domains}${zone}</section>`
}
