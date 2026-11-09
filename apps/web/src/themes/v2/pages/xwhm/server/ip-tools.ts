import type { WhmSurfaceProps } from '../../../../contract.ts'
import { isPrivateAddress } from '@xpanel/core'
import type { AdminView } from './common.ts'

/** Root IP tools of /whm/server/ips, bound by the network client (whm-network-client.ts). */
export function renderV2WhmIpTools(h: AdminView, props: WhmSurfaceProps): string {
  const pool = h.canRead ? props.ipPool ?? [] : [], accounts = h.canRead ? props.accounts ?? [] : [], resellers = h.canRead ? props.resellers ?? [] : [], ranges = h.canRead ? props.ipv6Ranges ?? [] : []
  const off = !h.canManage
  const accountChoices: [string, string][] = [['', h.t(msgid('Choose an account'))], ...accounts.filter(a => a.status !== 'terminating').map(a => [a.id, `${a.username} (${a.ipv4}${a.ipv6 ? ', ' + a.ipv6 : ''})`] as [string, string])]
  const offered = pool.filter(ip => ip.role !== 'mail' && !ip.reserved)
  const v4: [string, string][] = [['', h.t(msgid('Keep the current IPv4'))], ...offered.filter(ip => ip.version === 4).map(ip => [ip.address, `${ip.address} (${ip.role})`] as [string, string])]
  const v6: [string, string][] = [['', h.t(msgid('Keep the current IPv6'))], ['-', h.t(msgid('No IPv6'))], ...offered.filter(ip => ip.version === 6).map(ip => [ip.address, `${ip.address} (${ip.role})`] as [string, string])]
  const change = h.section('v2-ip-change', msgid("Change a site's IP address"), h.form({ 'data-ip-change-form': true }, h.fields(
    h.field('ip-change-account', msgid('Account'), h.select('ip-change-account', accountChoices, { name: 'accountId', disabled: off }))
    + h.field('ip-change-ipv4', msgid('New IPv4 address'), h.select('ip-change-ipv4', v4, { name: 'ipv4', disabled: off }))
    + h.field('ip-change-ipv6', msgid('New IPv6 address'), h.select('ip-change-ipv6', v6, { name: 'ipv6', disabled: off })))
    + `<p>${h.text(msgid("The site's DNS A/AAAA records, domain and mail overrides move in the same change. A dedicated address it leaves stays held until the agent verifies the new binding."))}</p>`
    + h.status(msgid('Not sent'), { 'data-ip-change-status': true }, true) + h.actions(h.button(msgid('Change address'), undefined, { type: 'submit', primary: true, disabled: off }))))
  const manyRows = accounts.filter(a => a.status !== 'terminating').map(a => `<tr><td>${h.check(a.username, { name: 'accountId', value: a.id, disabled: off, hooks: { 'data-ip-account-name': a.username } })}</td><td>${h.technical(a.ipv4)}</td><td><label class="v2-sr" for="ip-many-${h.e(a.id)}">${h.text(msgid('New IPv4 address'))}</label>${h.select('ip-many-' + a.id, [['', h.t(msgid('Use the address for all'))], ...offered.filter(ip => ip.version === 4).map(ip => [ip.address, `${ip.address} (${ip.role})`] as [string, string])], { name: 'ipv4:' + a.id, disabled: off })}</td></tr>`).join('')
  const many = h.section('v2-ip-change-many', msgid("Change multiple sites' IP addresses"), h.form({ 'data-ip-change-many-form': true }, h.field('ip-many-all', msgid('Address for all selected sites'), h.select('ip-many-all', v4.slice(1), { name: 'ipv4All', disabled: off }))
    + h.table('v2-ip-change-many-table', msgid("Change multiple sites' IP addresses"), [msgid('Account'), msgid('Current IPv4'), msgid('New IPv4 address')], undefined, manyRows || undefined, msgid('No accounts were returned.'))
    + `<p>${h.text(msgid('All selected sites move in one change after a review; a refusal for any site leaves every site unchanged.'))}</p>` + h.status(msgid('Not sent'), { 'data-ip-change-many-status': true }, true) + h.actions(h.button(msgid('Review and change addresses'), undefined, { type: 'submit', disabled: off }))))
  const remote = props.remoteServiceIps
  const remoteCard = h.section('v2-ip-remote', msgid('Remote service IPs'), h.form({ 'data-remote-ips-form': true }, h.fields(
    h.field('ip-remote-smtp', msgid('Remote SMTP servers, one per line'), h.area('ip-remote-smtp', { name: 'smtp', dir: 'ltr', rows: 4, value: remote?.smtp.join('\n') ?? '', disabled: off }), msgid('Exempt from the connection and rate limits; they are never allowed to relay.'))
    + h.field('ip-remote-ns', msgid('Remote nameservers, one per line'), h.area('ip-remote-ns', { name: 'nameservers', dir: 'ltr', rows: 4, value: remote?.nameservers.join('\n') ?? '', disabled: off }), msgid('Allowed to transfer the hosted zones, beside the DNS cluster peers.')))
    + h.status(msgid('Not sent'), { 'data-remote-ips-status': true }, true) + h.actions(h.button(msgid('Review and save'), undefined, { type: 'submit', disabled: off }))))
  const usedBy = (address: string): string => [
    ...accounts.filter(a => [a.ipv4, a.ipv6, ...(a.extraIps ?? [])].includes(address)).map(a => a.username),
    ...resellers.filter(r => r.delegatedIps.includes(address) || r.sharedIp === address).map(r => `${r.username} (${h.t(msgid('reseller'))})`),
  ].join(', ')
  const reserveRows = pool.map(ip => `<tr><td>${h.technical(ip.address)}</td><td><form class="v2-admin-actions" data-ip-reserve-form data-ip-reserve-id="${h.e(ip.id)}" novalidate>${ip.isPrimary ? `<span>${h.text(msgid('Default address'))}</span>` : h.check(msgid('Reserved'), { name: 'reserved', checked: ip.reserved === true, disabled: off })}<label class="v2-sr" for="ip-ptr-${h.e(ip.id)}">${h.text(msgid('Reverse DNS (PTR / HELO)'))}</label>${h.input('ip-ptr-' + ip.id, { name: 'ptrHostname', dir: 'ltr', maxLength: 253, value: ip.ptrHostname ?? '', disabled: off })}${isPrivateAddress(ip.address) ? `<label class="v2-sr" for="ip-nat-${h.e(ip.id)}">${h.text(msgid('Public address (1:1 NAT)'))}</label>${h.input('ip-nat-' + ip.id, { name: 'publicAddress', dir: 'ltr', maxLength: 45, value: ip.publicAddress ?? '', placeholder: h.t(msgid('Public address (1:1 NAT)')), disabled: off })}` : ''}${h.button(msgid('Save'), undefined, { type: 'submit', disabled: off })}</form></td><td>${ip.releasing ? h.text(msgid('Held until the new binding is verified')) : h.text(usedBy(ip.address) ? msgid('Assigned') : msgid('Free'))}${isPrivateAddress(ip.address) ? `<br>${h.text(ip.publicAddress ? msgid('Behind 1:1 NAT; DNS publishes the public address') : msgid('Private address; its public NAT address is unknown'))}` : ''}</td></tr>`).join('')
  const reserved = h.section('v2-ip-reserved', msgid('Reserved IPs and reverse DNS'), `<p>${h.text(msgid('A reserved address is never offered for a new assignment; an account already on it keeps it. The reverse DNS name is recorded here; the address provider publishes it.'))}</p>`
    + h.table('v2-ip-reserved-table', msgid('Reserved IPs and reverse DNS'), [msgid('IP address'), msgid('Reservation and reverse DNS'), msgid('State')], undefined, reserveRows || undefined, msgid('No IP addresses are in the pool.'))
    + h.status(msgid('Not sent'), { 'data-ip-reserve-status': true }, true))
  const usageRows = pool.map(ip => `<tr><td>${h.technical(ip.address)}</td><td>${h.e(ip.role)}</td><td>${usedBy(ip.address) ? h.technical(usedBy(ip.address)) : h.text(msgid('Not used'))}</td><td><span data-ip-binding="${h.e(ip.address)}" data-state="unverified">${h.text(msgid('Not read'))}</span></td></tr>`).join('')
  const usage = h.section('v2-ip-usage', msgid('IP address usage'), h.table('v2-ip-usage-table', msgid('IP address usage'), [msgid('IP address'), msgid('Role'), msgid('Used by'), msgid('Host binding')], undefined, usageRows || undefined, msgid('No IP addresses are in the pool.'))
    + h.status(msgid('Host binding has not been read.'), { 'data-ip-usage-status': true }) + h.actions(h.button(msgid('Read host binding'), { 'data-ip-usage-refresh': true }, { disabled: off })))
  const rebuild = h.section('v2-ip-rebuild', msgid('Rebuild the IP address pool'), `<p>${h.text(msgid('Adds the hosting addresses the host reports on its interfaces that the pool lacks, as free dedicated addresses. Nothing is removed.'))}</p>`
    + h.status(msgid('Not sent'), { 'data-ip-rebuild-status': true }, true) + h.actions(h.button(msgid('Rebuild the pool'), { 'data-ip-rebuild': true }, { disabled: off })))
  const owners: [string, string][] = [['', h.t(msgid('Root (server-wide)'))], ...resellers.map(r => [r.id, `${r.username} (${h.t(msgid('reseller'))})`] as [string, string]), ...accounts.map(a => [a.id, `${a.username} (${h.t(msgid('account'))})`] as [string, string])]
  const rangeRows = ranges.map(range => `<tr><td>${h.technical(range.cidr)}</td><td>${h.technical(range.ownerKind === 'root' ? 'root' : owners.find(([id]) => id === range.ownerId)?.[1] ?? range.ownerKind)}</td><td>${h.e(range.notes)}</td><td>${h.button(msgid('Remove'), { 'data-ip-range-remove': range.id, 'data-ip-range-cidr': range.cidr }, { danger: true, disabled: off })}</td></tr>`).join('')
  const ipv6 = h.section('v2-ip-ranges', msgid('IPv6 ranges'), h.table('v2-ip-ranges-table', msgid('IPv6 ranges'), [msgid('Range'), msgid('Owner'), msgid('Notes'), msgid('Actions')], undefined, rangeRows || undefined, msgid('No IPv6 ranges are saved.'))
    + h.form({ 'data-ip-range-form': true }, h.fields(
      h.field('ip-range-cidr', msgid('IPv6 network'), h.input('ip-range-cidr', { name: 'cidr', dir: 'ltr', maxLength: 43, placeholder: '2001:db8:1::/64', disabled: off }))
      + h.field('ip-range-kind', msgid('Owner kind'), h.select('ip-range-kind', [['root', h.t(msgid('Root (server-wide)'))], ['reseller', h.t(msgid('reseller'))], ['account', h.t(msgid('account'))]], { name: 'ownerKind', disabled: off }))
      + h.field('ip-range-owner', msgid('Owner'), h.select('ip-range-owner', owners, { name: 'ownerId', disabled: off }))
      + h.field('ip-range-notes', msgid('Notes'), h.input('ip-range-notes', { name: 'notes', maxLength: 255, disabled: off }))) + h.actions(h.button(msgid('Add range'), undefined, { type: 'submit', disabled: off })))
    + h.form({ 'data-ip-assign6-form': true }, h.fields(
      h.field('ip-assign6-account', msgid('Account'), h.select('ip-assign6-account', accountChoices, { name: 'accountId', disabled: off }))
      + h.field('ip-assign6-range', msgid('Range'), h.select('ip-assign6-range', [['', h.t(msgid('Choose a range'))], ...ranges.map(range => [range.id, range.cidr] as [string, string])], { name: 'rangeId', disabled: off })))
      + `<p>${h.text(msgid('The next free address of the range becomes the account IPv6, with AAAA records beside its A records. The package must allow a dedicated IP.'))}</p>` + h.actions(h.button(msgid('Assign IPv6 address'), undefined, { type: 'submit', disabled: off })))
    + h.status(msgid('Not sent'), { 'data-ip-range-status': true }, true))
  const migrate = h.section('v2-ip-migrate', msgid('IP migration wizard'), h.form({ 'data-ip-migrate-form': true }, h.field('ip-migrate-pairs', msgid('Old and new address, one pair per line'), h.area('ip-migrate-pairs', { name: 'mappings', dir: 'ltr', rows: 4, placeholder: '192.0.2.10 198.51.100.10', disabled: off }),
    msgid('Each new address must already be in the pool and unused. It takes over the old address role, owner and default flag; every account, zone, mail and reseller reference moves with it.'))
    + h.status(msgid('Not sent'), { 'data-ip-migrate-status': true }, true) + h.actions(h.button(msgid('Review and migrate'), undefined, { type: 'submit', disabled: off }))))
  return `<div class="v2-admin-stack" data-whm-ip-tools data-network-can-read="${h.canManage}" data-network-editable="${h.canManage}">${h.status(msgid('IP tools are ready.'), { 'data-ip-tools-status': true }, true)}<div class="v2-admin-columns"><div class="v2-admin-stack">${change}${many}${reserved}${usage}</div><aside class="v2-admin-stack">${rebuild}${migrate}${remoteCard}</aside></div>${ipv6}</div>`
}
