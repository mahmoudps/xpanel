import { randomUUID } from 'node:crypto'
import { tool } from './kit.mjs'

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const record = (zone, name, type, content, extra = {}) => ({ id: randomUUID(), zone, name, type, ttl: 3600, content, priority: null, ...extra })
const listZones = async root => { const response = await root.get('/api/dns/zones'); return response.status === 200 && Array.isArray(response.data?.zones) ? response.data.zones : null }
const zoneOf = async (root, name) => (await listZones(root))?.find(zone => zone.name === name) ?? null
const putZone = (root, name, records, revision, accountId = null) => root.put(`/api/dns/zones/${name}`, { records, accountId, expectedZoneRevision: revision })
/** Undo for a zone the driver made: the delete is revision-bound and the readback must show it gone. */
const dropZone = (root, name) => async () => {
  const zones = await listZones(root)
  if (!zones) return false
  const row = zones.find(zone => zone.name === name)
  if (!row) return true
  const gone = await root.delete(`/api/dns/zones/${name}`, { expectedZoneRevision: row.revision })
  return gone.status === 200 && (await zoneOf(root, name)) === null
}
/** Undo for a zone that existed before the driver changed it: the saved records come back, or the zone goes if there was none. */
const restoreZone = (root, name, original) => async () => {
  if (!original) return dropZone(root, name)()
  const zones = await listZones(root)
  if (!zones) return false
  const now = zones.find(zone => zone.name === name)
  if (now && same(now.records, original.records)) return true
  const back = await putZone(root, name, original.records, now?.revision ?? null, original.accountId)
  return back.status === 200 && same(back.data?.zone?.records, original.records)
}
const zonePath = '(?:dns\\/zones(?:\\/xq[a-z0-9-]*(?:\\.[a-z0-9-]+)+)?)'
const cluster = '/api/server/sec/dns-cluster'
const txtAt = (zone, name) => (zone?.records ?? []).filter(item => item.type === 'TXT' && item.name === name)

export default [
  tool('add-dns-zone', {
    prefix: 'ADZ', as: 'root', probe: '/api/dns/zones',
    paths: new RegExp(`^\\/api\\/(?:${zonePath}(?:\\/zone-file)?|server\\/settings)$`),
    unit: [{ id: 'ADZ-UNIT-1', file: 'apps/api/src/completion-whm-dns-security.test.ts', name: 'xWHM DNS revision-bound loopback HTTP acceptance creates an unassigned root zone only when the expected state is absent' }],
    checks: ['ZONE-EXISTS', 'ZONE-HAS-SOA', 'ZONE-HAS-CONFIGURED-NS', 'ZONE-HAS-GIVEN-A'],
    async run({ root, tag, check, refused, undo }) {
      const name = `xq-${tag}.example.net`, records = [record(name, '@', 'A', '192.0.2.77')]
      undo('DNS zone', dropZone(root, name))
      const settings = await root.get('/api/server/settings')
      const created = await putZone(root, name, records, null)
      refused('ZONE-EXISTS', await putZone(root, name, records, null), 'CONFLICT')
      const stored = created.status === 200 && Array.isArray(created.data?.zone?.records) ? created.data.zone.records : []
      const nameservers = settings.data?.settings?.nameservers
      // The SOA is rendered when the zone is published and is never a stored record; the zone file shows what is served.
      const file = await root.get(`/api/dns/zones/${name}/zone-file`), lines = typeof file.data?.text === 'string' ? file.data.text.split('\n') : []
      // Apex rows of the export: `@ <ttl> IN <type> <data>` under `$ORIGIN <zone>.`
      const served = type => lines.map(line => line.trim().split(/\s+/)).filter(fields => fields[0] === '@' && fields[2] === 'IN' && fields[3] === type)
      check('ZONE-HAS-SOA', file.status === 200 && served('SOA').length === 1, { status: file.status, soa: served('SOA').length })
      check('ZONE-HAS-CONFIGURED-NS', file.status === 200 && Array.isArray(nameservers) && nameservers.length > 0 && nameservers.every(server => served('NS').some(fields => fields.at(-1).replace(/\.$/, '') === String(server).replace(/\.$/, ''))), { status: file.status, nameservers: Array.isArray(nameservers) ? nameservers.length : null, ns: served('NS').length })
      check('ZONE-HAS-GIVEN-A', stored.some(item => item.type === 'A' && item.content === '192.0.2.77'), { status: created.status })
    },
  }),

  tool('delete-dns-zone', {
    prefix: 'DDZ', as: 'root', probe: '/api/dns/zones',
    paths: new RegExp(`^\\/api\\/${zonePath}$`),
    unit: [{ id: 'DDZ-UNIT-1', file: 'apps/api/src/completion-whm-dns-security.test.ts', name: 'xWHM DNS revision-bound loopback HTTP acceptance deletes only the exact reviewed zone and leaves other zones intact' }],
    checks: ['AUTHORITATIVE-GONE', 'SECOND-DELETE-NOT-FOUND'],
    async run({ root, tag, block, refused, undo }) {
      const name = `xq-${tag}.example.net`
      block('AUTHORITATIVE-GONE', 'An API client cannot send a DNS query to the local nameserver, so it cannot observe whether the zone is still answered authoritatively.')
      undo('DNS zone', dropZone(root, name))
      const created = await putZone(root, name, [record(name, '@', 'A', '192.0.2.78')], null), body = { expectedZoneRevision: created.data?.revision ?? null }
      await root.delete(`/api/dns/zones/${name}`, body)
      refused('SECOND-DELETE-NOT-FOUND', await root.delete(`/api/dns/zones/${name}`, body), 'NOT_FOUND')
    },
  }),

  tool('dns-zone-manager', {
    prefix: 'DZM', as: 'root', probe: '/api/dns/zones',
    paths: new RegExp(`^\\/api\\/${zonePath}$`),
    unit: [{ id: 'DZM-UNIT-1', file: 'apps/api/src/completion-whm-dns-security.test.ts', name: 'xWHM DNS revision-bound loopback HTTP acceptance saves exact records with a server serial, persisted readback and audit' }],
    checks: ['CNAME-CONFLICT', 'SOA-ADD-NOT-ALLOWED', 'SOA-NOT-A-RECORD', 'SERIAL-INCREMENTS-ON-EDIT'],
    async run({ root, tag, check, refused, undo }) {
      const name = `xq-${tag}.example.net`, www = record(name, 'www', 'A', '192.0.2.10')
      undo('DNS zone', dropZone(root, name))
      const created = await putZone(root, name, [www], null), base = created.data?.zone?.records ?? []
      const edited = await putZone(root, name, [...base, record(name, 'ftp', 'A', '192.0.2.11')], created.data?.revision ?? null)
      check('SERIAL-INCREMENTS-ON-EDIT', created.status === 200 && edited.status === 200 && Number.isInteger(created.data?.zone?.serial) && edited.data?.zone?.serial === created.data.zone.serial + 1, { created: created.status, edited: edited.status })
      const current = edited.data?.zone?.records ?? [], revision = edited.data?.revision ?? null
      refused('CNAME-CONFLICT', await putZone(root, name, [...current, record(name, 'www', 'CNAME', `www2.${name}`)], revision), 'CONFLICT')
      refused('SOA-ADD-NOT-ALLOWED', await putZone(root, name, [...current, record(name, '@', 'SOA', 'ns1.example.net hostmaster.example.net 1 3600 600 86400 300')], revision), 'VALIDATION')
      check('SOA-NOT-A-RECORD', current.length > 0 && current.every(item => item.type !== 'SOA'), { records: current.length })
    },
  }),

  tool('zone-ttl-bulk', {
    prefix: 'ZTB', as: 'root', probe: '/api/dns/zones', requests: 40,
    paths: new RegExp(`^\\/api\\/(?:${zonePath}|server\\/dns-tools\\/ttl\\/apply)$`),
    unit: [{ id: 'ZTB-UNIT-1', file: 'apps/api/src/dns-tools-workspace.test.ts', name: 'API DNS tools workspace previews and applies a TTL per zone with each zone revision, proving every write by re-read' }],
    checks: ['TTL-300-EVERY-RECORD', 'TTL-ZERO-REFUSED', 'TTL-FRACTION-REFUSED'],
    async run({ root, tag, check, refused, undo }) {
      const names = [`xq-${tag}-a.example.net`, `xq-${tag}-b.example.net`]
      for (const name of names) undo('DNS zone', dropZone(root, name))
      for (const name of names) await putZone(root, name, [record(name, '@', 'A', '192.0.2.20'), record(name, '@', 'NS', 'ns1.example.net'), record(name, '@', 'TXT', 'xq', { ttl: 600 })], null)
      const rows = async () => (await listZones(root))?.filter(zone => names.includes(zone.name)) ?? []
      const request = (ttl, found) => ({ ttl, zones: found.map(zone => ({ zone: zone.name, expectedZoneRevision: zone.revision })) })
      const before = await rows(), applied = await root.post('/api/server/dns-tools/ttl/apply', request(300, before))
      const after = await rows()
      check('TTL-300-EVERY-RECORD', applied.status === 200 && after.length === 2 && after.every(zone => zone.records.length === 3 && zone.records.every(item => item.ttl === 300)), { status: applied.status, zones: after.length })
      refused('TTL-ZERO-REFUSED', await root.post('/api/server/dns-tools/ttl/apply', request(0, after)), 'VALIDATION')
      refused('TTL-FRACTION-REFUSED', await root.post('/api/server/dns-tools/ttl/apply', request(1.5, after)), 'VALIDATION')
    },
  }),

  tool('zone-templates', {
    prefix: 'ZTM', restores: ['/api/dns/templates'], as: 'root', needs: ['account'], probe: '/api/dns/templates', requests: 40,
    paths: new RegExp(`^\\/api\\/(?:dns\\/templates(?:\\/apply)?|${zonePath})$`),
    unit: [{ id: 'ZTM-UNIT-1', file: 'apps/api/src/authorization-security.test.ts', name: 'HTTP authorization security regressions owned resources remain protected by reseller ACL and account feature policy' }],
    checks: ['TEMPLATE-LINE-IN-NEW-ZONE', 'EXISTING-ZONES-UNCHANGED', 'UNKNOWN-PLACEHOLDER-REFUSED'],
    async run({ root, fixture, tag, check, refused, undo }) {
      const bystander = `xq-${tag}-keep.example.net`, original = await zoneOf(root, fixture.domain), saved = await root.get('/api/dns/templates')
      const templates = saved.data?.templates
      if (!Array.isArray(templates)) { check('TEMPLATE-LINE-IN-NEW-ZONE', false, { status: saved.status }); check('EXISTING-ZONES-UNCHANGED', false, { status: saved.status }); check('UNKNOWN-PLACEHOLDER-REFUSED', false, { status: saved.status }); return }
      undo('DNS templates', async () => {
        const back = await root.put('/api/dns/templates', { templates })
        return back.status === 200 && same((await root.get('/api/dns/templates')).data?.templates, templates)
      })
      undo('fixture zone', restoreZone(root, fixture.domain, original))
      undo('bystander zone', dropZone(root, bystander))
      const kept = await putZone(root, bystander, [record(bystander, '@', 'A', '192.0.2.30')], null)
      const edit = line => templates.map(item => item.id === 'standard' ? { ...item, records: [...item.records, line] } : item)
      const line = { name: '@', type: 'TXT', ttl: 300, contentTemplate: `xq-${tag}`, priority: null }
      await root.put('/api/dns/templates', { templates: edit(line) })
      const applied = await root.post('/api/dns/templates/apply', { template: 'standard', domain: fixture.domain })
      check('TEMPLATE-LINE-IN-NEW-ZONE', applied.status === 200 && applied.data?.zone?.records?.some(item => item.type === 'TXT' && item.content === `xq-${tag}`) === true, { status: applied.status })
      const now = await zoneOf(root, bystander)
      check('EXISTING-ZONES-UNCHANGED', kept.status === 200 && now?.revision === kept.data?.revision, { status: kept.status })
      refused('UNKNOWN-PLACEHOLDER-REFUSED', await root.put('/api/dns/templates', { templates: edit({ ...line, contentTemplate: '{{xq_unknown}}' }) }), 'VALIDATION')
    },
  }),

  tool('email-dns-records', {
    prefix: 'EDR', as: 'root', needs: ['account'], probe: '/api/dns/zones',
    paths: new RegExp(`^\\/api\\/(?:${zonePath}|dns\\/email-auth\\/batch)$`),
    unit: [{ id: 'EDR-UNIT-1', file: 'apps/api/src/dkim-provisioning.test.ts', name: 'DNS email-auth public key provisioning keeps existing SPF, DMARC and overlapping selectors' }],
    checks: ['DMARC-ADDED-WHEN-MISSING', 'EXISTING-DMARC-UNCHANGED'],
    async run({ root, fixture, tag, check, undo }) {
      const domain = fixture.domain, original = await zoneOf(root, domain)
      undo('fixture zone', restoreZone(root, domain, original))
      if (original) await putZone(root, domain, original.records.filter(item => !(item.type === 'TXT' && item.name === '_dmarc')), original.revision, original.accountId)
      const first = await root.post('/api/dns/email-auth/batch', { domains: [domain] }), added = await zoneOf(root, domain)
      check('DMARC-ADDED-WHEN-MISSING', first.status === 200 && txtAt(added, '_dmarc').length === 1 && /^v=DMARC1/.test(txtAt(added, '_dmarc')[0].content), { status: first.status })
      const custom = added?.records.map(item => item.type === 'TXT' && item.name === '_dmarc' ? { ...item, content: `v=DMARC1; p=none; xq=${tag}` } : item)
      const saved = custom ? await putZone(root, domain, custom, added.revision, added.accountId) : null
      const second = await root.post('/api/dns/email-auth/batch', { domains: [domain] }), kept = txtAt(await zoneOf(root, domain), '_dmarc'), wanted = txtAt(saved?.data?.zone, '_dmarc')
      check('EXISTING-DMARC-UNCHANGED', saved?.status === 200 && second.status === 200 && wanted.length === 1 && same(kept, wanted), { saved: saved?.status ?? null, status: second.status })
    },
  }),

  tool('dkim-spf-bulk', {
    prefix: 'DSB', as: 'root', needs: ['account'], probe: '/api/dns/zones',
    paths: new RegExp(`^\\/api\\/(?:${zonePath}|dns\\/email-auth\\/batch|ips)$`),
    unit: [{ id: 'DSB-UNIT-1', file: 'apps/api/src/dkim-provisioning.test.ts', name: 'DNS email-auth public key provisioning publishes the actual public key and active selector without leaking a private key' }],
    checks: ['SPF-HAS-MAIN-IPV4', 'SPF-KEEPS-INCLUDE', 'DKIM-SELECTOR-TXT-ADDED'],
    async run({ root, fixture, check, undo }) {
      const domain = fixture.domain, original = await zoneOf(root, domain)
      undo('fixture zone', restoreZone(root, domain, original))
      const kept = (original?.records ?? []).filter(item => !(item.type === 'TXT' && (item.name === '@' && /^v=spf1/i.test(item.content) || item.name.endsWith('._domainkey'))))
      await putZone(root, domain, [...kept, record(domain, '@', 'TXT', 'v=spf1 include:x ~all')], original?.revision ?? null, original?.accountId ?? fixture.accountId)
      const pool = await root.get('/api/ips'), main = pool.data?.ips?.find(item => item.version === 4 && item.isPrimary)?.address
      const batch = await root.post('/api/dns/email-auth/batch', { domains: [domain] }), zone = await zoneOf(root, domain)
      const spf = txtAt(zone, '@').find(item => /^v=spf1/i.test(item.content))?.content ?? ''
      check('SPF-HAS-MAIN-IPV4', batch.status === 200 && typeof main === 'string' && spf.includes(main), { status: batch.status, pool: pool.status })
      check('SPF-KEEPS-INCLUDE', batch.status === 200 && spf.includes('include:x'), { status: batch.status })
      check('DKIM-SELECTOR-TXT-ADDED', batch.status === 200 && (zone?.records ?? []).some(item => item.type === 'TXT' && item.name.endsWith('._domainkey')), { status: batch.status })
    },
  }),

  tool('change-hostname', {
    prefix: 'CHN', restores: ['/api/server/settings'], as: 'root', probe: '/api/server/settings',
    paths: /^\/api\/server\/(?:settings|hostname)$/,
    unit: [{ id: 'CHN-UNIT-1', file: 'packages/state/src/hostname-consistency.test.ts', name: 'canonical hostname mutation authority advances canonical authority once and preserves unrelated server settings' }],
    checks: ['INVALID-LEADING-WWW', 'INVALID-LEADING-DIGIT', 'INVALID-TRAILING-HYPHEN', 'INVALID-61-CHARACTERS', 'VALID-NAME-RETURNED', 'VALID-NAME-USED-BY-MTA'],
    async run({ root, check, block, refused, undo }) {
      const before = await root.get('/api/server/settings'), hostname = before.data?.settings?.hostname
      block('VALID-NAME-USED-BY-MTA', 'The MTA primary host name is a Postfix setting on the host, which an API client cannot read.')
      if (typeof hostname !== 'string') { check('VALID-NAME-RETURNED', false, { status: before.status }); return }
      undo('host name', async () => {
        const back = await root.post('/api/server/hostname', { hostname })
        return back.status === 200 && (await root.get('/api/server/settings')).data?.settings?.hostname === hostname
      })
      refused('INVALID-LEADING-WWW', await root.post('/api/server/hostname', { hostname: 'www.example.com' }), 'VALIDATION')
      refused('INVALID-LEADING-DIGIT', await root.post('/api/server/hostname', { hostname: '1host.example.com' }), 'VALIDATION')
      refused('INVALID-TRAILING-HYPHEN', await root.post('/api/server/hostname', { hostname: 'host-' }), 'VALIDATION')
      refused('INVALID-61-CHARACTERS', await root.post('/api/server/hostname', { hostname: `${'a'.repeat(49)}.example.com` }), 'VALIDATION')
      const set = await root.post('/api/server/hostname', { hostname }), read = await root.get('/api/server/settings')
      check('VALID-NAME-RETURNED', set.status === 200 && set.data?.hostname === hostname && read.data?.settings?.hostname === hostname, { set: set.status, read: read.status })
    },
  }),

  tool('ip-addresses-list', {
    prefix: 'IPL', restores: ['/api/ips'], as: 'root', needs: ['account'], probe: '/api/ips',
    paths: /^\/api\/(?:ips(?:\/[0-9a-f-]{36})?|accounts)$/,
    unit: [{ id: 'IPL-UNIT-1', file: 'apps/api/src/ip-allocation.test.ts', name: 'IP API router and desired-state allocation diagnostics returns 404 for an absent pool ID and does not reconcile or audit successful deletion' }],
    checks: ['ACCOUNT-IP-DELETE-IN-USE', 'SHARED-IP-DELETE-IN-USE', 'TWO-LOCAL-TO-ONE-PUBLIC-CONFLICT'],
    async run({ root, fixture, check, block, refused, undo }) {
      block('TWO-LOCAL-TO-ONE-PUBLIC-CONFLICT', 'Building two local addresses behind one public address needs new addresses on the host interface, which a qualification run must not add.')
      const pool = await root.get('/api/ips'), accounts = await root.get('/api/accounts')
      const ips = Array.isArray(pool.data?.ips) ? pool.data.ips : [], address = accounts.data?.accounts?.find(item => item.id === fixture.accountId)?.ipv4
      // Only an entry that is referenced or primary is ever offered to the delete, so a missing guard cannot remove a free address.
      const used = ips.find(item => item.address === address), shared = ips.find(item => item.role === 'shared' && (item.isPrimary || item.address === address))
      for (const entry of new Map([used, shared].filter(Boolean).map(item => [item.id, item])).values()) undo('IP pool entry', async () => {
        const now = await root.get('/api/ips')
        if (now.status !== 200) return false
        return now.data.ips.some(item => item.id === entry.id) || (await root.post('/api/ips', entry)).status === 201
      })
      const attempt = async entry => entry ? root.delete(`/api/ips/${entry.id}`) : { status: null, data: null }
      const first = await attempt(used), second = shared && shared.id === used?.id ? first : await attempt(shared)
      if (used) refused('ACCOUNT-IP-DELETE-IN-USE', first, 'CONFLICT'); else check('ACCOUNT-IP-DELETE-IN-USE', false, { pool: pool.status, accounts: accounts.status })
      if (shared) refused('SHARED-IP-DELETE-IN-USE', second, 'CONFLICT'); else check('SHARED-IP-DELETE-IN-USE', false, { pool: pool.status })
    },
  }),

  tool('dns-cluster-sync', {
    prefix: 'DCS', as: 'root', probe: cluster,
    paths: /^\/api\/server\/sec\/dns-cluster(?:\/verify\?peer=[a-z0-9.-]{1,253})?$/,
    unit: [{ id: 'DCS-UNIT-1', file: 'apps/api/src/sec-workspace.test.ts', name: 'sec server workspaces verifies peers and applies the exact saved cluster revision through the host only' }],
    checks: ['EVERY-PEER-SAME-SOA-SERIAL'],
    async run({ root, check, block }) {
      const view = await root.get(cluster), peers = [view.data?.peers, view.data?.policy?.peers, view.data?.observation?.peers].find(Array.isArray) ?? []
      if (view.status !== 200 || peers.length === 0) { block('EVERY-PEER-SAME-SOA-SERIAL', 'No cluster peer is configured, and a second lab host to act as a peer does not exist yet, so no peer can return a serial.'); return }
      const reports = []
      for (const peer of peers.slice(0, 8)) reports.push(await root.get(`${cluster}/verify?peer=${encodeURIComponent(peer.name)}`))
      check('EVERY-PEER-SAME-SOA-SERIAL', reports.every(item => item.status === 200 && item.data?.zones?.length > 0 && item.data.zones.every(zone => Number.isInteger(zone.peerSerial) && zone.peerSerial === zone.localSerial)), { peers: reports.length, statuses: reports.map(item => item.status) })
    },
  }),

  tool('dns-cluster', {
    prefix: 'DCL', as: 'root', probe: cluster,
    paths: /^\/api\/server\/sec\/dns-cluster$/,
    unit: [{ id: 'DCL-UNIT-1', file: 'apps/api/src/sec-workspace.test.ts', name: 'sec server workspaces verifies peers and applies the exact saved cluster revision through the host only' }],
    checks: ['MEMBER-DISABLED-AFTER-10-FAILURES', 'ADMIN-NOTIFICATION-ON-DISABLE', 'WRITE-ONLY-NEVER-PULLS'],
    async run({ block }) {
      const reason = 'A cluster member that fails commands needs a second lab host acting as a peer, which does not exist yet.'
      block('MEMBER-DISABLED-AFTER-10-FAILURES', reason)
      block('ADMIN-NOTIFICATION-ON-DISABLE', reason)
      block('WRITE-ONLY-NEVER-PULLS', reason)
    },
  }),
]
