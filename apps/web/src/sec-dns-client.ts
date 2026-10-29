/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { readSecSavedView, secKit } from './sec-security-client.ts'
import type { SecSavedView } from './sec-security-client.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
// Local aliases: serialized bindings must not reference imported names (test transforms rewrite them).
const kitOf = secKit, readSaved = readSecSavedView
type Ask = (options: Record<string, unknown>) => Promise<unknown>
export interface SecProvidersView { revision: string; accounts: { id: string; provider: string; label: string; tokenId: string; createdAt: string; verifiedAt: string }[]; links: { domain: string; accountId: string; zoneId: string; zoneName: string; linkedAt: string }[]; domains: string[] }
export interface SecZoneView { domain: string; zoneId: string; status: string; paused: boolean; nameServers: string[]; sslMode: string; localZone: boolean; truncated: boolean; observedAt: string; records: { name: string; type: string; local: string[]; cloudflare: string[]; proxied: boolean | null; state: string }[] }

/** Strict readers: provider accounts never carry a token field. */
export function readSecProvidersView(value: unknown): SecProvidersView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const hex = (item: unknown, size: number): item is string => typeof item === 'string' && item.length === size && /^[0-9a-f]+$/.test(item)
  const domain = (item: unknown): item is string => typeof item === 'string' && /^[a-z0-9.-]{1,253}$/.test(item)
  if (!object(value) || Object.keys(value).sort().join() !== 'accounts,domains,links,revision' || !hex(value.revision, 64) || !Array.isArray(value.accounts) || value.accounts.length > 16 || !Array.isArray(value.links) || value.links.length > 2000 || !Array.isArray(value.domains) || value.domains.length > 5000 || !value.domains.every(domain)) throw new Error('invalid_sec_providers')
  const accounts = value.accounts.map(item => { if (!object(item) || Object.keys(item).sort().join() !== 'createdAt,id,label,provider,tokenId,verifiedAt' || item.provider !== 'cloudflare' || typeof item.id !== 'string' || typeof item.label !== 'string' || item.label.length > 64 || !hex(item.tokenId, 32) || typeof item.verifiedAt !== 'string' || typeof item.createdAt !== 'string') throw new Error('invalid_sec_provider_account'); return { id: item.id, provider: item.provider, label: item.label, tokenId: item.tokenId, createdAt: item.createdAt, verifiedAt: item.verifiedAt } })
  const links = value.links.map(item => { if (!object(item) || !domain(item.domain) || !hex(item.zoneId, 32) || typeof item.accountId !== 'string' || !accounts.some(account => account.id === item.accountId) || typeof item.linkedAt !== 'string') throw new Error('invalid_sec_provider_link'); return { domain: item.domain, accountId: item.accountId, zoneId: item.zoneId, zoneName: String(item.zoneName), linkedAt: item.linkedAt } })
  return { revision: value.revision, accounts, links, domains: [...value.domains as string[]] }
}
export function readSecZoneView(value: unknown, domain: string): SecZoneView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const strings = (item: unknown): item is string[] => Array.isArray(item) && item.length <= 64 && item.every(entry => typeof entry === 'string' && entry.length <= 4096)
  if (!object(value) || value.domain !== domain || typeof value.zoneId !== 'string' || typeof value.status !== 'string' || !['off', 'flexible', 'full', 'strict'].includes(String(value.sslMode)) || !strings(value.nameServers) || typeof value.localZone !== 'boolean' || typeof value.truncated !== 'boolean' || typeof value.observedAt !== 'string' || !Array.isArray(value.records) || value.records.length > 500) throw new Error('invalid_sec_zone')
  const records = value.records.map(row => { if (!object(row) || typeof row.name !== 'string' || typeof row.type !== 'string' || !strings(row.local) || !strings(row.cloudflare) || !['match', 'differs', 'missing_at_cloudflare', 'only_at_cloudflare'].includes(String(row.state))) throw new Error('invalid_sec_zone_record'); return { name: row.name, type: row.type, local: row.local, cloudflare: row.cloudflare, proxied: row.proxied === true ? true : row.proxied === false ? false : null, state: String(row.state) } })
  return { domain, zoneId: value.zoneId, status: value.status, paused: value.paused === true, nameServers: value.nameServers, sslMode: String(value.sslMode), localZone: value.localZone, truncated: value.truncated, observedAt: value.observedAt, records }
}

function bindSecDns(askDialog: Ask | undefined): void {
  document.querySelectorAll<HTMLElement>('[data-sec-workspace]').forEach(root => {
    const page = root.dataset.secPage ?? ''
    if (root.dataset.secBound === 'true' || !['dns-providers', 'dns-cluster', 'account-cloudflare'].includes(page)) return
    root.dataset.secBound = 'true'
    const k = kitOf(root, askDialog, displayDateTime), t = k.t
    const refresh = k.q<HTMLButtonElement>('[data-sec-action="refresh"]')
    if (!k.admitted()) { if (refresh) refresh.disabled = true; k.note('unavailable', t('This page is unavailable here. Nothing was read or changed.')); return }
    const editors = k.all<HTMLInputElement | HTMLSelectElement>('[data-sec-input]'), buttons = k.all<HTMLButtonElement>('[data-sec-action]:not([data-sec-action="refresh"])')
    let loaded = false
    k.controls.push(() => { if (refresh) refresh.disabled = k.isBusy(); const editable = loaded && !k.isBusy() && k.manageable(); for (const node of [...editors, ...buttons]) node.disabled = !editable })
    const value = (key: string): string => k.input(key)?.value.trim() ?? ''
    const zoneStates: Record<string, string> = { match: t('Matches'), differs: t('Differs'), missing_at_cloudflare: t('Missing at Cloudflare'), only_at_cloudflare: t('Only at Cloudflare') }
    const paintZone = (zone: SecZoneView | null): void => {
      k.field('zone-domain', zone?.domain ?? null); k.field('zone-status', zone ? zone.paused ? t('{status} (paused)', { status: zone.status }) : zone.status : null); k.field('zone-ssl', zone?.sslMode ?? null)
      k.field('zone-ns', zone ? zone.nameServers.join(', ') : null); k.field('zone-at', k.when(zone?.observedAt))
      const truncated = k.q('[data-sec-zone-truncated]'); if (truncated) truncated.hidden = !zone?.truncated
      k.rows('records', (zone?.records ?? []).map(row => [k.technical(row.name), k.technical(row.type), k.technical(row.local.join('\n') || '-'), k.technical(row.cloudflare.join('\n') || '-'), row.proxied === null ? '-' : row.proxied ? t('Yes') : t('No'), zoneStates[row.state] ?? row.state]),
        zone ? (zone.localZone ? t('No comparable records.') : t('This server has no saved zone for the domain.')) : t('Select Inspect for a linked domain.'), 6)
    }
    const inspect = (path: string, domain: string): Promise<void> => k.guarded(async () => {
      k.show('reading', t('Reading the zone from Cloudflare…'))
      try { paintZone(readSecZoneView(await k.send('GET', path + '?domain=' + encodeURIComponent(domain)), domain)); k.show('read', t('Zone read from Cloudflare.')) } catch (error) { paintZone(null); k.show(k.outcome(error), k.failure(k.outcome(error))) }
    })
    const purge = (path: string, domain: string): Promise<void> => k.guarded(async () => {
      if (!await k.confirm({ title: t('Purge the Cloudflare cache?'), body: domain + '\n' + t('Cloudflare removes every cached file for this zone. Visitors are served from this server until the cache fills again.'), confirm: t('Purge cache') })) return
      try { const ack = await k.send('POST', path, { domain }) as { domain?: unknown; outcome?: unknown }; if (ack?.domain !== domain || ack.outcome !== 'accepted') throw new Error('purge'); k.show('read', t('Cloudflare accepted the purge request for {domain}.', { domain })) } catch (error) { k.show(k.outcome(error), k.failure(k.outcome(error))) }
    })

    if (page === 'account-cloudflare') {
      const load = (): Promise<void> => k.guarded(async () => {
        k.note('reading', t('Reading…'))
        try {
          const raw = await k.send('GET', '/api/account/sec/cloudflare') as { domains?: unknown }
          if (!Array.isArray(raw?.domains) || raw.domains.length > 5000) throw new Error('invalid')
          const domains = raw.domains.map(item => { const row = item as { domain?: unknown; linked?: unknown }; if (typeof row.domain !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(row.domain) || typeof row.linked !== 'boolean') throw new Error('invalid'); return { domain: row.domain, linked: row.linked } })
          loaded = true
          k.rows('domains', domains.map(row => [k.technical(row.domain), row.linked ? t(msgctxt('sec-dns-client', 'Connected')) : t('Not connected'), row.linked ? k.group(k.actionButton(t('Inspect'), t('Inspect {domain}', { domain: row.domain }), () => void inspect('/api/account/sec/cloudflare/zone', row.domain), false), k.actionButton(t('Purge cache'), t('Purge the cache of {domain}', { domain: row.domain }), () => void purge('/api/account/sec/cloudflare/purge', row.domain), !k.manageable())) : '-']), t('You have no domains.'), 3)
          k.note('read', t('Read from this server.'))
        } catch (error) { k.note('failed', k.failure(k.outcome(error))) }
      })
      refresh?.addEventListener('click', () => void load()); void load(); return
    }

    if (page === 'dns-providers') {
      let view: SecProvidersView | null = null
      const fill = (key: string, items: [string, string][]): void => { const select = k.input<HTMLSelectElement>(key); if (!select) return; const current = select.value, first = select.options[0]; select.textContent = ''; if (first) select.append(first); for (const [v, label] of items) { const option = document.createElement('option'); option.value = v; option.textContent = label; select.append(option) }; select.value = items.some(([v]) => v === current) ? current : '' }
      const paint = (next: SecProvidersView): void => {
        view = next; loaded = true
        const labelOf = (id: string): string => next.accounts.find(account => account.id === id)?.label ?? id
        k.rows('accounts', next.accounts.map(account => [account.label, 'Cloudflare', k.technical(account.tokenId), k.technical(displayDateTime(account.verifiedAt)), k.group(k.actionButton(t('Remove'), t('Remove {name}', { name: account.label }), () => void remove(account.id, account.label), !k.manageable()))]), t('No provider accounts are connected.'), 5)
        k.rows('links', next.links.map(link => [k.technical(link.domain), k.technical(link.zoneId), labelOf(link.accountId), k.technical(displayDateTime(link.linkedAt)), k.group(
          k.actionButton(t('Inspect'), t('Inspect {domain}', { domain: link.domain }), () => void inspect('/api/server/sec/dns-providers/zone', link.domain), false),
          k.actionButton(t('Purge cache'), t('Purge the cache of {domain}', { domain: link.domain }), () => void purge('/api/server/sec/dns-providers/purge', link.domain), !k.manageable()),
          k.actionButton(t('Unlink'), t('Unlink {domain}', { domain: link.domain }), () => void unlink(link.domain), !k.manageable()))]), t('No domains are linked.'), 5)
        fill('link-domain', next.domains.filter(domain => !next.links.some(link => link.domain === domain)).map(domain => [domain, domain]))
        fill('link-account', next.accounts.map(account => [account.id, account.label]))
        k.note('read', t('Read from this server.'))
      }
      const write = async (path: string, body: Record<string, unknown>, done: string): Promise<void> => {
        try { const ack = readSecProvidersView(await k.send('POST', path, body)); const again = readSecProvidersView(await k.send('GET', '/api/server/sec/dns-providers')); if (again.revision !== ack.revision) throw new Error('readback'); paint(again); k.show('read', done) }
        catch (error) { k.show(k.outcome(error), k.failure(k.outcome(error))) }
      }
      const load = (): Promise<void> => k.guarded(async () => { k.note('reading', t('Reading…')); try { paint(readSecProvidersView(await k.send('GET', '/api/server/sec/dns-providers'))) } catch (error) { view = null; loaded = false; k.note('failed', k.failure(k.outcome(error))) } })
      const remove = (id: string, label: string): Promise<void> => k.guarded(async () => { if (!view || !await k.confirm({ title: t('Remove provider account?'), body: label + '\n' + t('Its saved token and every domain link that uses it are removed from this server. Nothing changes at Cloudflare.'), confirm: t('Remove') })) return; await write('/api/server/sec/dns-providers/accounts/remove', { accountId: id, expectedRevision: view.revision }, t('Provider account removed.')) })
      const unlink = (domain: string): Promise<void> => k.guarded(async () => { if (!view || !await k.confirm({ title: t('Unlink domain?'), body: domain, confirm: t('Unlink') })) return; await write('/api/server/sec/dns-providers/links/remove', { domain, expectedRevision: view.revision }, t('Domain unlinked.')) })
      k.q('[data-sec-action="connect"]')?.addEventListener('click', () => void k.guarded(async () => {
        const token = k.input('token'), label = value('label')
        if (!view || !token) return
        if (!/^[A-Za-z0-9_-]{40}$/.test(token.value) || !label) { k.show('invalid', t('Enter a name and a Cloudflare API token of 40 characters.')); return }
        const secret = token.value; token.value = ''
        k.show('reading', t('Checking the token with Cloudflare…'))
        await write('/api/server/sec/dns-providers/accounts', { label, token: secret, expectedRevision: view.revision }, t('Cloudflare verified the token and it was saved.'))
      }))
      k.q('[data-sec-action="link"]')?.addEventListener('click', () => void k.guarded(async () => {
        const domain = value('link-domain'), accountId = value('link-account')
        if (!view || !domain || !accountId) { k.show('invalid', t('Select a domain and a provider account.')); return }
        k.show('reading', t('Looking up the zone at Cloudflare…'))
        await write('/api/server/sec/dns-providers/links', { domain, accountId, expectedRevision: view.revision }, t('Domain linked to its Cloudflare zone.'))
      }))
      refresh?.addEventListener('click', () => void load()); void load(); return
    }

    let view: SecSavedView | null = null
    const peersOf = (next: SecSavedView | null): { name: string; address: string }[] => (next?.policy?.peers as { name: string; address: string }[] | undefined) ?? []
    const paint = (next: SecSavedView): void => {
      view = next; loaded = next.state !== 'invalid'
      const o = next.observation as { state?: string; application?: string; settings?: { launch: string | null; primary: boolean | null; includeDir: string | null; allowAxfrIps: string[] } | null; peers?: { name: string; transferAllowed: boolean | null; notified: boolean | null }[] } | null
      const states: Record<string, string> = { single_node: t('Single server. No peers are saved.'), applied: t('Applied: every saved peer can transfer zones and is notified.'), drift: t('Not applied: the running PowerDNS settings differ from the saved peers.'), unavailable: t('PowerDNS settings could not be read.') }
      k.field('application', o?.state === 'not_installed' ? t('PowerDNS is not installed') : o?.application ? states[o.application] ?? null : null, o?.application === 'applied' || o?.application === 'single_node' ? 'good' : 'warn')
      k.field('launch', o?.settings?.launch ?? null); k.field('primary', o?.settings ? k.yesNo(o.settings.primary) : null); k.field('include-dir', o?.settings ? o.settings.includeDir ?? t('Not set') : null)
      k.field('axfr', o?.settings ? o.settings.allowAxfrIps.join(', ') : null); k.field('updated', next.updatedAt ? k.when(next.updatedAt) : t('Never saved'))
      k.rows('peers', peersOf(next).map(peer => { const live = o?.peers?.find(item => item.name === peer.name); return [k.technical(peer.name), k.technical(peer.address), k.yesNo(live?.transferAllowed), k.yesNo(live?.notified),
        k.group(k.actionButton(t('Verify'), t('Verify {name}', { name: peer.name }), () => void verify(peer.name), false), k.actionButton(t('Remove'), t('Remove {name}', { name: peer.name }), () => void savePeers(peersOf(view).filter(item => item.name !== peer.name), t('Peer removed from the saved list.')), !k.manageable()))] }),
        t('No peers are saved. This server works as a single nameserver.'), 5)
      k.note(next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid' ? t('The saved configuration could not be verified. Editing is locked pending review.') : next.observation ? t('Read from this server.') : t('Saved configuration read. The host observation is unavailable.'))
    }
    const load = (): Promise<void> => k.guarded(async () => { k.note('reading', t('Reading…')); try { paint(readSaved(await k.send('GET', '/api/server/sec/dns-cluster'), 'dns-cluster')) } catch (error) { view = null; loaded = false; k.note('failed', k.failure(k.outcome(error))) } })
    const savePeers = (peers: { name: string; address: string }[], done: string): Promise<void> => k.guarded(async () => {
      if (!view) return
      try {
        const ack = readSaved(await k.send('PUT', '/api/server/sec/dns-cluster', { policy: { peers }, expectedRevision: view.revision }), 'dns-cluster')
        const again = readSaved(await k.send('GET', '/api/server/sec/dns-cluster'), 'dns-cluster')
        if (again.revision !== ack.revision || JSON.stringify(peersOf(again)) !== JSON.stringify(peers)) throw new Error('readback')
        paint(again); k.show('read', done)
      } catch (error) { k.show(k.outcome(error), k.failure(k.outcome(error))) }
    })
    const verify = (name: string): Promise<void> => k.guarded(async () => {
      k.field('verify-peer', name)
      try {
        const raw = await k.send('GET', '/api/server/sec/dns-cluster/verify?peer=' + encodeURIComponent(name)) as { observedAt?: unknown; zones?: unknown; counts?: Record<string, unknown>; truncated?: unknown }
        if (!Array.isArray(raw?.zones) || raw.zones.length > 200 || typeof raw.observedAt !== 'string' || !raw.counts) throw new Error('invalid')
        const labels: Record<string, string> = { in_sync: t('In sync'), behind: t('Behind'), ahead: t('Ahead'), not_served: t('Not served by the peer'), refused: t('Refused by the peer'), unreachable: t('Peer unreachable'), local_unavailable: t('Not answered by this server') }
        k.rows('transfers', raw.zones.map(item => { const row = item as { zone: string; localSerial: number | null; peerSerial: number | null; state: string }; return [k.technical(String(row.zone)), k.technical(row.localSerial === null ? '-' : String(row.localSerial)), k.technical(row.peerSerial === null ? '-' : String(row.peerSerial)), labels[row.state] ?? String(row.state)] }), t('No zones are hosted.'), 4)
        k.field('verify-counts', t('{synced} of {total} zones in sync', { synced: Number(raw.counts.in_sync ?? 0), total: raw.zones.length })); k.field('verify-at', k.when(raw.observedAt))
      } catch (error) { k.show(k.outcome(error), k.failure(k.outcome(error))) }
    })
    k.q('[data-sec-action="add-peer"]')?.addEventListener('click', () => {
      const name = value('peer-name').toLowerCase(), address = value('peer-address').toLowerCase()
      if (!/^[a-z0-9.-]{1,253}$/.test(name) || !name.includes('.') || !/^[0-9a-f:.]{2,45}$/.test(address)) { k.show('invalid', t('Enter a full host name and one IP address for the peer.')); return }
      void savePeers([...peersOf(view), { name, address }], t('Peer saved. Apply to PowerDNS to use it.'))
    })
    k.q('[data-sec-action="apply"]')?.addEventListener('click', () => void k.guarded(async () => {
      if (!view || view.state !== 'saved' || !await k.confirm({ title: t('Apply cluster settings to PowerDNS?'), body: t('PowerDNS restarts and answers no queries for a few seconds. If the new settings cannot be confirmed, the previous file is restored.'), confirm: t('Apply to PowerDNS') })) return
      try {
        const ack = await k.send('POST', '/api/server/sec/dns-cluster/apply', { expectedRevision: view.revision }) as { outcome?: unknown }
        if (ack?.outcome !== 'applied' && ack?.outcome !== 'unchanged') throw new Error('apply')
        paint(readSaved(await k.send('GET', '/api/server/sec/dns-cluster'), 'dns-cluster'))
        k.show('read', ack.outcome === 'applied' ? t('PowerDNS restarted and the running settings match the saved peers.') : t('The running settings already match the saved peers.'))
      } catch (error) { k.show(k.outcome(error), k.failure(k.outcome(error))) }
    }))
    refresh?.addEventListener('click', () => void load()); void load()
  })
}
export const SEC_DNS_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const readSaved=${readSecSavedView.toString()};const readSecProvidersView=${readSecProvidersView.toString()};const readSecZoneView=${readSecZoneView.toString()};const kitOf=${secKit.toString()};return ${bindSecDns.toString()};})()`
