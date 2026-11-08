import { randomBytes, randomUUID } from 'node:crypto'
import { safeResponse, tool } from './kit.mjs'

const secret = () => `Xq-${randomBytes(18).toString('base64url')}-9a`
const ID = '[0-9a-f-]{36}', ACC = 'xq[0-9a-f]{8}[a-z]{1,2}'
const SCRATCH = ['feature-lists', `feature-lists/${ID}`, 'plans', `plans/${ID}`, 'accounts', `accounts/${ACC}`]
const only = (...alts) => new RegExp(`^/api/(?:${alts.join('|')})$`)
const CAPS = { addonDomains: 10, aliasDomains: 10, subdomains: 20, mailboxes: 20, forwarders: 20, mailingLists: 5, ftpAccounts: 10, databases: 10, phpWorkers: 8 }
const RESOURCES = { diskMb: 2048, bandwidthMbMonth: 10240, ioReadBps: 50_000_000, ioWriteBps: 50_000_000, ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 }
const gone = response => [200, 204, 404].includes(response.status)
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const visit = async (site, host, path, options) => { try { return await site.get(host, path, options) } catch { return { status: 0, headers: {}, text: '' } } }
const workspace = async client => {
  const response = await client.get('/api/domains')
  return { response, revision: response.data?.revision, home: response.data?.context?.home, domains: response.data?.domains ?? [] }
}
const relative = (home, docRoot) => docRoot.startsWith(`${home}/`) ? docRoot.slice(home.length + 1) : docRoot

/** A second account on its own plan with the given caps, signed in as its owner. The undo steps remove it again. */
async function scratch(x, label, caps = {}) {
  const { root, tag, undo, signIn } = x
  const list = await root.post('/api/feature-lists', { name: `xq-${tag}-${label}`, ownerId: null, disabled: [] }), listId = list.data?.featureList?.id
  if (list.status !== 201 || typeof listId !== 'string') return null
  undo(`feature list ${label}`, async () => gone(await root.delete(`/api/feature-lists/${listId}`)))
  const plan = await root.post('/api/plans', { name: `xq-${tag}-${label}`, featureListId: listId, resources: RESOURCES, caps: { ...CAPS, ...caps } }), planId = plan.data?.plan?.id
  if (plan.status !== 201 || typeof planId !== 'string') return null
  undo(`plan ${label}`, async () => gone(await root.delete(`/api/plans/${planId}`)))
  const username = `xq${tag}${label}`, password = secret(), primary = `${username}.example.net`
  undo(`account ${label}`, async () => gone(await root.delete(`/api/accounts/${username}`, { confirmUsername: username })))
  const created = await root.post('/api/accounts', { username, password, primaryDomain: primary, planId }, { idempotencyKey: `xq-${tag}-${label}` })
  if (created.status !== 201 || typeof created.data?.account?.id !== 'string') return null
  const session = await signIn('owner', { username, password })
  return session.client ? { client: session.client, id: created.data.account.id, username, primary } : null
}

/** Creates a domain through the owner workspace (revision-guarded) and registers its removal. */
async function addDomain(x, client, body) {
  const space = await workspace(client)
  const response = await client.post('/api/domains', { ...body, expectedRevision: space.revision }), domain = response.data?.domain
  if ([200, 201].includes(response.status) && typeof domain?.id === 'string') x.undo(`domain ${domain.name}`, () => removeDomain(client, domain.id, domain.name))
  return { response, domain: response.status === 201 ? domain : null, home: space.home }
}
async function removeDomain(client, id, name) {
  const space = await workspace(client)
  if (space.response.status !== 200) return false
  if (!space.domains.some(item => item.id === id)) return true
  return (await client.delete(`/api/domains/${id}`, { confirmName: name, expectedRevision: space.revision })).status === 200
}

/** Writes a file under the fixture home (creating folders when the first write fails) and registers its removal. */
async function putFile(x, path, content) {
  const { owner, fixture } = x, files = `/api/accounts/${fixture.username}/files`
  let written = await owner.post(files, { op: 'write', path, content })
  if (written.status !== 200) {
    const parts = path.split('/').slice(0, -1)
    for (let index = 1; index <= parts.length; index++) await owner.post(files, { op: 'mkdir', path: parts.slice(0, index).join('/') })
    written = await owner.post(files, { op: 'write', path, content })
  }
  const dir = path.slice(0, path.lastIndexOf('/')), name = path.slice(path.lastIndexOf('/') + 1)
  if (written.status === 200) {
    x.undo(`file ${name}`, async () => {
      const listed = await owner.post(files, { op: 'list', path: dir, showHidden: false })
      if (listed.status === 404) return true
      if (listed.status !== 200) return false
      return !JSON.stringify(listed.data).includes(name) || (await owner.post(files, { op: 'trash', path })).status === 200
    })
  }
  return written
}

async function addMailbox(x, client, login, quota = 50) {
  const password = secret()
  const response = await client.post('/api/service-users', { login, password, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: quota }), id = response.data?.serviceUser?.id
  if (response.status === 201 && typeof id === 'string') x.undo(`mailbox ${login}`, async () => [200, 202, 204, 404].includes((await client.delete(`/api/service-users/${id}`)).status))
  return { response, id: typeof id === 'string' ? id : null, login, password }
}
/** The mailbox login is polled, because the mail host provisions it after the control plane accepts it. */
async function mailboxClient(x, mail) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const session = await x.signIn('mailbox', { username: mail.login, password: mail.password })
    if (session.client) return session.client
    await x.sleep(1500)
  }
  return null
}
const sendMail = (client, to, subject) => client.post('/api/webmail/send', { to, subject, text: `xq ${subject}` })
const inboxPath = folder => folder === undefined ? '/api/webmail/inbox' : `/api/webmail/inbox?folder=${folder}`
const subjects = async (client, folder) => {
  const response = await client.get(inboxPath(folder))
  return response.status === 200 && Array.isArray(response.data?.messages) ? response.data.messages.map(message => message.subject) : null
}
const countSubject = async (client, subject, folder, exact = true) => (await subjects(client, folder))?.filter(item => exact ? item === subject : item.includes(subject)).length ?? null
/** Polls a mailbox folder until at least one message matches. */
const arrives = (x, client, subject, folder, exact = true) => x.until(() => countSubject(client, subject, folder, exact), count => count !== null && count >= 1, { attempts: 8, delayMs: 2000 })

const MAIL_UNIT = { id: 'S7EAC-UNIT-1', file: 'apps/api/src/account-mutation-security.test.ts', name: 'real HTTP account mutation security returns public service-user fields after PATCH without disclosing the persisted password hash' }
const ROUTING_UNIT = { file: 'apps/api/src/completion-mail-routing-apply.test.ts', name: 'account mail routing applied on the host through the agent applies a rejecting forwarder and a forwarding default address, and reports each as applied' }
const MAIL_PATHS = ['webmail/send', 'webmail/inbox(?:\\?folder=[A-Za-z]+)?', 'service-users', `service-users/${ID}`]
const FORWARDERS_PAGE = { route: '/email/forwarders', read: '/api/domains', shows: data => [data?.domains?.find(item => item.kind === 'primary')?.name] }
const ACCOUNTS_PAGE = { route: '/email/accounts', read: '/api/auth/me', shows: data => [data?.principal?.username] }

export default [
  tool('domains', {
    prefix: 'S7DOM', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/domains(?:\/[0-9a-f-]{36}|\?reveal=1)?$/,
    requests: 40,
    unit: [{ id: 'S7DOM-UNIT-1', file: 'apps/api/src/completion-domain-workspace-security.test.ts', name: 'conditional domain workspace API with isolated real SQLite and desired state returns a coherent owned view with opaque revision, real caps and primary removal refusal' }],
    checks: ['LIST-FOUR-ENTRIES', 'TYPES-AND-DOCROOTS', 'ADDON-BACKING-HIDDEN', 'REVEAL-OPTION-SHOWS-BACKING'],
    async run(x) {
      const { owner, fixture, tag, check } = x
      const base = await workspace(owner), primary = base.domains.find(item => item.kind === 'primary')
      if (!primary) return check('LIST-FOUR-ENTRIES', false, { status: base.response.status, primary: false })
      const names = { addon: `xq${tag}-ad.example.net`, sub: `xq${tag}-sb.${fixture.domain}`, alias: `xq${tag}-al.example.net` }
      const addon = await addDomain(x, owner, { name: names.addon, kind: 'addon', siteType: 'php' })
      const sub = await addDomain(x, owner, { name: names.sub, kind: 'subdomain', parentId: primary.id, siteType: 'php' })
      const alias = await addDomain(x, owner, { name: names.alias, kind: 'alias', parentId: primary.id })
      const listed = await workspace(owner), rows = listed.domains, row = name => rows.find(item => item.name === name)
      const made = addon.domain !== null && sub.domain !== null && alias.domain !== null
      check('LIST-FOUR-ENTRIES', made && listed.response.status === 200 && rows.length === 4, { status: listed.response.status, entries: rows.length, created: made })
      check('TYPES-AND-DOCROOTS', made && row(fixture.domain)?.kind === 'primary' && row(names.addon)?.kind === 'addon' && row(names.sub)?.kind === 'subdomain' && row(names.alias)?.kind === 'alias'
        && row(names.addon)?.docRoot === `${listed.home}/domains/${names.addon}/public_html` && row(names.sub)?.docRoot === `${listed.home}/domains/${names.sub}/public_html`
        && row(names.alias)?.docRoot === row(fixture.domain)?.docRoot && typeof row(fixture.domain)?.docRoot === 'string', { entries: rows.length })
      check('ADDON-BACKING-HIDDEN', made && rows.length === 4 && rows.filter(item => item.kind === 'subdomain').length === 1, { entries: rows.length, subdomains: rows.filter(item => item.kind === 'subdomain').length })
      const revealed = await owner.get('/api/domains?reveal=1')
      check('REVEAL-OPTION-SHOWS-BACKING', revealed.status === 200 && (revealed.data?.domains?.length ?? 0) > rows.length, { ...safeResponse(revealed), entries: revealed.data?.domains?.length ?? null })
    },
  }),

  tool('create-domain', {
    prefix: 'S7CDM', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/domains',
    paths: only('domains', `domains/${ID}`, 'dns/zones', 'accounts/xq[0-9a-f]{1,13}/files', ...SCRATCH),
    requests: 90, deadlineMs: 300_000,
    unit: [{ id: 'S7CDM-UNIT-1', file: 'apps/api/src/completion-domain-workspace-security.test.ts', name: 'conditional domain workspace API with isolated real SQLite and desired state creates owned subdomains and aliases with coupled parent settings' }],
    checks: ['ADDON-LIMIT-EXCEEDED', 'DOCROOT-DOTDOT-REFUSED', 'DOCROOT-NESTED-DOTDOT-REFUSED', 'ADDON-ANSWERS-HTTP'],
    async run(x) {
      const { owner, fixture, tag, site, check, refused, until } = x
      const small = await scratch(x, 'cd', { addonDomains: 1 })
      const first = small ? await addDomain(x, small.client, { name: `xq${tag}-l1.example.net`, kind: 'addon', siteType: 'php' }) : null
      if (first?.domain) refused('ADDON-LIMIT-EXCEEDED', (await addDomain(x, small.client, { name: `xq${tag}-l2.example.net`, kind: 'addon', siteType: 'php' })).response, 'LIMIT_EXCEEDED')
      else check('ADDON-LIMIT-EXCEEDED', false, { setup: small !== null, ...(first ? safeResponse(first.response) : {}) })
      refused('DOCROOT-DOTDOT-REFUSED', (await addDomain(x, owner, { name: `xq${tag}-d1.example.net`, kind: 'addon', siteType: 'php', docRoot: '../outside' })).response, 'VALIDATION')
      refused('DOCROOT-NESTED-DOTDOT-REFUSED', (await addDomain(x, owner, { name: `xq${tag}-d2.example.net`, kind: 'addon', siteType: 'php', docRoot: 'public_html/../etc' })).response, 'VALIDATION')
      const addon = await addDomain(x, owner, { name: `xq${tag}-ok.example.net`, kind: 'addon', siteType: 'php' })
      if (!addon.domain) return check('ADDON-ANSWERS-HTTP', false, safeResponse(addon.response))
      const marker = `xq-${tag}-addon`
      await putFile(x, `${relative(addon.home, addon.domain.docRoot)}/index.html`, `${marker}\n`)
      const served = await until(() => visit(site, addon.domain.name, '/', { secure: true }), response => response.status === 200 && response.text.includes(marker), { attempts: 8, delayMs: 1500 })
      check('ADDON-ANSWERS-HTTP', served.settled, { status: served.last?.status ?? null, attempts: served.attempts })
    },
  }),

  tool('manage-domain', {
    prefix: 'S7MDM', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: only('domains', `domains/${ID}`, 'dns/zones', 'accounts/xq[0-9a-f]{1,13}/files'),
    requests: 50, deadlineMs: 240_000,
    unit: [{ id: 'S7MDM-UNIT-1', file: 'apps/api/src/completion-domain-workspace-security.test.ts', name: 'conditional domain workspace API with isolated real SQLite and desired state removes only the confirmed nonprimary leaf and its domain projection' }],
    checks: ['ADDON-REMOVED', 'ZONE-GONE', 'VHOST-GONE', 'DOCROOT-FILES-IDENTICAL', 'MAIN-DOMAIN-PROTECTED'],
    async run(x) {
      const { owner, fixture, tag, site, check, refused, until } = x
      const addon = await addDomain(x, owner, { name: `xq${tag}-rm.example.net`, kind: 'addon', siteType: 'php' })
      if (!addon.domain) return check('ADDON-REMOVED', false, safeResponse(addon.response))
      const marker = `xq-${tag}-keep\n`, dir = relative(addon.home, addon.domain.docRoot), file = `${dir}/index.html`, files = `/api/accounts/${fixture.username}/files`
      await putFile(x, file, marker)
      const before = await until(() => visit(site, addon.domain.name, '/', { secure: true }), response => response.status === 200 && response.text.includes(marker.trim()), { attempts: 8, delayMs: 1500 })
      const zones = await owner.get('/api/dns/zones'), hadZone = zones.status === 200 && zones.data?.zones?.some(zone => zone.name === addon.domain.name) === true
      const space = await workspace(owner)
      const removed = await owner.delete(`/api/domains/${addon.domain.id}`, { confirmName: addon.domain.name, expectedRevision: space.revision })
      const after = await workspace(owner)
      check('ADDON-REMOVED', removed.status === 200 && !after.domains.some(item => item.id === addon.domain.id), safeResponse(removed))
      const zonesAfter = await owner.get('/api/dns/zones')
      check('ZONE-GONE', hadZone && zonesAfter.status === 200 && !zonesAfter.data?.zones?.some(zone => zone.name === addon.domain.name), { zoneExistedBefore: hadZone, status: zonesAfter.status })
      const closed = await until(() => visit(site, addon.domain.name, '/', { secure: true }), response => !(response.status === 200 && response.text.includes(marker.trim())), { attempts: 8, delayMs: 1500 })
      check('VHOST-GONE', before.settled && closed.settled, { servedBefore: before.settled, goneAfter: closed.settled })
      const read = await owner.post(files, { op: 'read', path: file })
      check('DOCROOT-FILES-IDENTICAL', read.status === 200 && read.data?.content === marker, { status: read.status })
      const primary = after.domains.find(item => item.kind === 'primary')
      refused('MAIN-DOMAIN-PROTECTED', await owner.delete(`/api/domains/${primary?.id ?? randomUUID()}`, { confirmName: fixture.domain, expectedRevision: after.revision }), 'PRECONDITION_FAILED')
    },
  }),

  tool('redirects', {
    prefix: 'S7RDR', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: only('domains', `domains/${ID}/web-directives/redirects`),
    requests: 40,
    unit: [{ id: 'S7RDR-UNIT-1', file: 'apps/api/src/web-directives-workspace.test.ts', name: 'web directives over the checked .htaccess workspace reads a feature model and saves only its managed block with the captured revision' }],
    checks: ['PERMANENT-REDIRECT-LOCATION', 'WWW-ONLY-MODE', 'DELETE-RESTORES-RESPONSE'],
    async run(x) {
      const { owner, fixture, tag, site, check, until, undo } = x
      const space = await workspace(owner), domain = space.domains.find(item => item.name === fixture.domain)
      if (!domain) return check('PERMANENT-REDIRECT-LOCATION', false, { status: space.response.status })
      const route = `/api/domains/${domain.id}/web-directives/redirects`, original = await owner.get(route)
      if (original.status !== 200) return check('PERMANENT-REDIRECT-LOCATION', false, { status: original.status })
      undo('redirect rules', async () => {
        const now = await owner.get(route)
        if (now.status !== 200) return false
        if (sameJson(now.data.model, original.data.model)) return true
        const back = await owner.put(route, { expectedRevision: now.data.document.revision, model: original.data.model })
        return back.status === 200 && sameJson(back.data.model, original.data.model)
      })
      const path = `/xq-${tag}-old`, target = 'https://t.test/new'
      const put = async model => owner.put(route, { expectedRevision: (await owner.get(route)).data?.document?.revision, model })
      const baseline = await visit(site, fixture.domain, path, { secure: true })
      const saved = await put({ entries: [{ status: 301, path, target }] })
      const moved = saved.status === 200 ? await until(() => visit(site, fixture.domain, path, { secure: true }), response => response.status === 301 && response.headers.location === target, { attempts: 6, delayMs: 1500 }) : null
      check('PERMANENT-REDIRECT-LOCATION', saved.status === 200 && moved?.settled === true, { ...safeResponse(saved), served: moved?.last?.status ?? null })
      const www = await put({ entries: [{ status: 301, path, target, www: 'only-www' }] })
      const bare = www.status === 200 ? await visit(site, fixture.domain, path, { secure: true }) : null, withWww = www.status === 200 ? await visit(site, `www.${fixture.domain}`, path, { secure: true }) : null
      check('WWW-ONLY-MODE', www.status === 200 && bare.status !== 301 && withWww.status === 301, { ...safeResponse(www), bare: bare?.status ?? null, www: withWww?.status ?? null })
      const cleared = await put({ entries: [] })
      const restored = cleared.status === 200 ? await until(() => visit(site, fixture.domain, path, { secure: true }), response => response.status === baseline.status && !response.headers.location, { attempts: 6, delayMs: 1500 }) : null
      check('DELETE-RESTORES-RESPONSE', cleared.status === 200 && restored?.settled === true, { ...safeResponse(cleared), baseline: baseline.status, served: restored?.last?.status ?? null })
    },
  }),

  tool('dynamic-dns', {
    prefix: 'DDNS', as: 'owner', needs: ['account'], probe: '/api/account/dynamic-dns', requires_qualification_admission: true, gate: 'dns-zone-records', requests: 30,
    paths: /^\/(?:api\/account\/dynamic-dns(?:\/ddns_[A-Za-z0-9_-]{22}(?:\/rotate)?)?|api\/dns\/zones|nic\/update\?hostname=[a-z0-9.-]{1,253}&myip=203\.0\.113\.9)$/,
    unit: [
      { id: 'DDNS-UNIT-ISSUE', file: 'apps/api/src/dynamic-dns.test.ts', name: 'dynamic DNS credential management issues 32 random bytes once, persists a hash, lists only the owner and leaves DNS untouched' },
      { id: 'DDNS-UNIT-ROTATE', file: 'apps/api/src/dynamic-dns.test.ts', name: 'dynamic DNS credential management rotates immediately and removal revokes without deleting the DNS record' },
    ],
    checks: ['UPDATE-SETS-RECORD', 'UPDATE-BUMPS-LAST-CHANGE', 'SAME-ADDRESS-NOCHG', 'OLD-SECRET-BADAUTH', 'RECORD-UNCHANGED-AFTER-ROTATE'],
    async run({ owner, fixture, tag, check, undo }) {
      const base = '/api/account/dynamic-dns', address = '203.0.113.9', hostname = `ddns-${tag}.${fixture.domain}`
      const revision = async () => (await owner.get(base)).data?.revision
      const created = await owner.post(base, { expectedRevision: await revision(), zone: fixture.domain, hostname, type: 'A', description: `xq-${tag}` })
      const id = created.data?.issued?.id, secret = created.data?.issued?.secret
      if (created.status !== 201 || typeof id !== 'string' || typeof secret !== 'string') { check('UPDATE-SETS-RECORD', false, { status: created.status }); return }
      undo('dynamic DNS credential', async () => [200, 404].includes((await owner.delete(`${base}/${id}`, { expectedRevision: await revision() })).status))
      const call = key => owner.anonymous(`/nic/update?hostname=${hostname}&myip=${address}`, { basic: `${id}:${key}` })
      const record = async () => (await owner.get('/api/dns/zones')).data?.zones?.find(zone => zone.name === fixture.domain)?.records?.find(item => item.type === 'A' && `${item.name}.${fixture.domain}` === hostname)?.content
      const entry = async () => (await owner.get(base)).data?.entries?.find(item => item.id === id)
      const first = await call(secret), seen = await record(), changed = await entry()
      check('UPDATE-SETS-RECORD', first.status === 200 && first.text?.trim() === `good ${address}` && seen === address, { status: first.status, matched: seen === address })
      check('UPDATE-BUMPS-LAST-CHANGE', typeof changed?.lastChangedAt === 'string', { present: typeof changed?.lastChangedAt === 'string' })
      const second = await call(secret), after = await entry()
      check('SAME-ADDRESS-NOCHG', second.status === 200 && second.text?.trim() === `nochg ${address}` && after?.lastChangedAt === changed?.lastChangedAt, { status: second.status })
      const rotated = await owner.post(`${base}/${id}/rotate`, { expectedRevision: await revision() })
      const refused = rotated.status === 200 ? await call(secret) : null
      check('OLD-SECRET-BADAUTH', refused?.status === 401 && refused.text?.trim() === 'badauth', { rotate: rotated.status, status: refused?.status ?? null })
      check('RECORD-UNCHANGED-AFTER-ROTATE', await record() === address, {})
    },
  }),

  tool('zone-editor', {
    prefix: 'S7ZED', as: 'owner', needs: ['account'], probe: '/api/dns/zones',
    paths: /^\/api\/dns\/zones(?:\/[a-z0-9.-]{1,253})?$/,
    requests: 30,
    unit: [{ id: 'S7ZED-UNIT-1', file: 'apps/api/src/completion-whm-dns-security.test.ts', name: 'xWHM DNS revision-bound loopback HTTP acceptance refuses stale saves and deletes without a source change' }],
    checks: ['STALE-SERIAL-REFUSED', 'ZONE-UNCHANGED-AFTER-STALE', 'ADD-RECORD-RAISES-SERIAL', 'AUTHORITATIVE-ANSWERS-NEW-RECORD'],
    async run(x) {
      const { owner, fixture, tag, check, block, refused, undo } = x
      const read = async () => { const response = await owner.get('/api/dns/zones'); return { response, zone: response.data?.zones?.find(item => item.name === fixture.domain) } }
      const before = await read(), path = `/api/dns/zones/${fixture.domain}`
      if (!before.zone) return check('STALE-SERIAL-REFUSED', false, { status: before.response.status, zone: false })
      const records = before.zone.records
      undo('zone records', async () => {
        const now = await read()
        if (!now.zone) return false
        if (sameJson(now.zone.records, records)) return true
        const back = await owner.put(path, { records, expectedZoneRevision: now.zone.revision })
        return back.status === 200 && sameJson(back.data?.zone?.records, records)
      })
      refused('STALE-SERIAL-REFUSED', await owner.put(path, { records, expectedZoneRevision: 'f'.repeat(64) }), 'CONFLICT')
      const same = await read()
      check('ZONE-UNCHANGED-AFTER-STALE', same.zone?.revision === before.zone.revision && sameJson(same.zone?.records, records), { status: same.response.status })
      const record = { id: randomUUID(), zone: before.zone.name, name: `xq-${tag}`, type: 'A', ttl: 300, content: '203.0.113.7', priority: null }
      const added = await owner.put(path, { records: [...records, record], expectedZoneRevision: before.zone.revision })
      check('ADD-RECORD-RAISES-SERIAL', added.status === 200 && added.data?.zone?.serial > before.zone.serial && added.data.zone.records.some(item => item.id === record.id), { ...safeResponse(added), serialBefore: before.zone.serial, serialAfter: added.data?.zone?.serial ?? null })
      block('AUTHORITATIVE-ANSWERS-NEW-RECORD', 'A DNS query to the authoritative server is not a panel API request, so an API client cannot observe what dig returns.')
    },
  }),

  tool('dns-zone-records', {
    prefix: 'S7DZR', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/dns/zones',
    paths: only('dns/zones', 'dns/zones/[a-z0-9.-]{1,253}', ...SCRATCH),
    requests: 60, deadlineMs: 300_000,
    unit: [{ id: 'S7DZR-UNIT-1', file: 'apps/api/src/completion-whm-dns-security.test.ts', name: 'xWHM DNS revision-bound loopback HTTP acceptance saves exact records with a server serial, persisted readback and audit' }],
    checks: ['ZONE-READ', 'RECORD-ADDED', 'RECORD-EDITED', 'RECORD-REMOVED', 'UNEDITED-RECORDS-KEPT', 'FOREIGN-ZONE-REFUSED', 'FEATURE-DISABLED-REFUSED'],
    async run(x) {
      const { root, owner, fixture, tag, check, refused, undo } = x
      const read = async () => { const response = await owner.get('/api/dns/zones'); return { response, zone: response.data?.zones?.find(item => item.name === fixture.domain) } }
      const path = `/api/dns/zones/${fixture.domain}`, before = await read()
      if (!check('ZONE-READ', before.response.status === 200 && before.zone !== undefined, { status: before.response.status })) return
      const records = before.zone.records
      undo('zone records', async () => {
        const now = await read()
        if (!now.zone) return false
        if (sameJson(now.zone.records, records)) return true
        const back = await owner.put(path, { records, expectedZoneRevision: now.zone.revision })
        return back.status === 200 && sameJson(back.data?.zone?.records, records)
      })
      const record = { id: randomUUID(), zone: before.zone.name, name: `xq-${tag}`, type: 'A', ttl: 300, content: '203.0.113.7', priority: null }
      const added = await owner.put(path, { records: [...records, record], expectedZoneRevision: before.zone.revision })
      check('RECORD-ADDED', added.status === 200 && added.data?.zone?.records?.some(item => item.id === record.id) === true, safeResponse(added))
      const mid = await read()
      const edited = await owner.put(path, { records: [...records, { ...record, content: '203.0.113.8' }], expectedZoneRevision: mid.zone?.revision })
      check('RECORD-EDITED', edited.status === 200 && edited.data?.zone?.records?.find(item => item.id === record.id)?.content === '203.0.113.8', safeResponse(edited))
      const edge = await read()
      const removed = await owner.put(path, { records, expectedZoneRevision: edge.zone?.revision })
      const after = await read()
      check('RECORD-REMOVED', removed.status === 200 && after.zone?.records?.some(item => item.id === record.id) === false, safeResponse(removed))
      check('UNEDITED-RECORDS-KEPT', after.zone !== undefined && records.every(item => after.zone.records.some(saved => sameJson(saved, item))), { before: records.length, after: after.zone?.records?.length ?? null })
      const other = await scratch(x, 'dz')
      if (other) {
        const foreign = await owner.put(`/api/dns/zones/${other.primary}`, { records: [], expectedZoneRevision: 'f'.repeat(64) })
        check('FOREIGN-ZONE-REFUSED', [403, 404].includes(foreign.status), safeResponse(foreign))
      } else check('FOREIGN-ZONE-REFUSED', false, { setup: false })
      const find = async () => (await root.get('/api/feature-lists')).data?.featureLists?.find(item => item.name === `xq-${fixture.username.slice(2)}`)
      const list = await find()
      if (!list) return check('FEATURE-DISABLED-REFUSED', false, { featureList: false })
      undo('run feature list', async () => {
        const now = await find()
        if (!now) return false
        if (sameJson(now.disabled, list.disabled)) return true
        const back = await root.patch(`/api/feature-lists/${list.id}`, { disabled: list.disabled })
        return back.status === 200 && sameJson(back.data?.featureList?.disabled, list.disabled)
      })
      const changed = await root.patch(`/api/feature-lists/${list.id}`, { disabled: [...new Set([...list.disabled, 'zone-editor'])] })
      if (changed.status !== 200) return check('FEATURE-DISABLED-REFUSED', false, { ...safeResponse(changed), featureDisabled: false })
      refused('FEATURE-DISABLED-REFUSED', await owner.put(path, { records, expectedZoneRevision: after.zone?.revision }), 'FORBIDDEN')
    },
  }),

  tool('cloudflare-account', {
    prefix: 'S7CFA', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/account/sec/cloudflare',
    paths: only('account/sec/cloudflare', 'account/sec/cloudflare/zone\\?domain=[a-z0-9.-]{1,253}', ...SCRATCH),
    requests: 40, deadlineMs: 240_000,
    unit: [{ id: 'S7CFA-UNIT-1', file: 'apps/api/src/sec-cloudflare.test.ts', name: 'sec Cloudflare for account owners shows only owned domains and refuses unlinked or foreign domains' }],
    checks: ['FOREIGN-DOMAIN-NOT-FOUND', 'OWN-DOMAIN-RECOGNISED', 'LIST-ONLY-OWN-DOMAINS'],
    async run(x) {
      const { owner, fixture, check, refused } = x
      const other = await scratch(x, 'cf')
      if (other) refused('FOREIGN-DOMAIN-NOT-FOUND', await owner.get(`/api/account/sec/cloudflare/zone?domain=${other.primary}`), 'NOT_FOUND')
      else check('FOREIGN-DOMAIN-NOT-FOUND', false, { setup: false })
      const own = await owner.get(`/api/account/sec/cloudflare/zone?domain=${fixture.domain}`)
      check('OWN-DOMAIN-RECOGNISED', [200, 412].includes(own.status), safeResponse(own))
      const listed = await owner.get('/api/account/sec/cloudflare'), names = listed.data?.domains?.map(item => item.domain)
      check('LIST-ONLY-OWN-DOMAINS', listed.status === 200 && Array.isArray(names) && names.includes(fixture.domain) && (other === null || !names.includes(other.primary)), { status: listed.status, domains: names?.length ?? null })
    },
  }),

  tool('email-accounts', {
    prefix: 'S7EAC', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/service-users', page: ACCOUNTS_PAGE,
    paths: only(...MAIL_PATHS, ...SCRATCH),
    requests: 60, deadlineMs: 300_000, unit: [MAIL_UNIT],
    checks: ['MAILBOX-LIMIT-EXCEEDED', 'LIST-STILL-TWO-ROWS', 'SYSTEM-MAILBOX-DELETE-FORBIDDEN'],
    async run(x) {
      const { check, refused, block } = x
      const other = await scratch(x, 'ea', { mailboxes: 2 })
      if (!other) return check('MAILBOX-LIMIT-EXCEEDED', false, { setup: false })
      const rows = async () => { const response = await other.client.get('/api/service-users'); return response.status === 200 ? response.data?.serviceUsers?.filter(item => item.services?.email).length ?? null : null }
      const one = await addMailbox(x, other.client, `a${x.tag}@${other.primary}`), two = await addMailbox(x, other.client, `b${x.tag}@${other.primary}`)
      if (!one.id || !two.id) return check('MAILBOX-LIMIT-EXCEEDED', false, { first: one.response.status, second: two.response.status })
      refused('MAILBOX-LIMIT-EXCEEDED', (await addMailbox(x, other.client, `c${x.tag}@${other.primary}`)).response, 'LIMIT_EXCEEDED')
      const count = await rows()
      check('LIST-STILL-TWO-ROWS', count === 2, { rows: count })
      block('SYSTEM-MAILBOX-DELETE-FORBIDDEN', 'The mailbox list has no system mailbox row, so there is no object to delete and an API client cannot observe the refusal.')
    },
  }),

  tool('email-account-create', {
    prefix: 'S7EAK', as: 'owner', needs: ['account'], probe: '/api/service-users', page: ACCOUNTS_PAGE,
    paths: only(...MAIL_PATHS),
    requests: 40, unit: [MAIL_UNIT],
    checks: ['RESERVED-LOCAL-PART-VALIDATION', 'QUOTA-EXCEEDS-MAX', 'WEAK-PASSWORD-REFUSED', 'VALID-MAILBOX-IMAP-LOGIN'],
    async run(x) {
      const { owner, fixture, check, refused } = x
      const dom = fixture.domain
      refused('RESERVED-LOCAL-PART-VALIDATION', (await addMailbox(x, owner, `cpanel@${dom}`)).response, 'VALIDATION')
      refused('QUOTA-EXCEEDS-MAX', (await addMailbox(x, owner, `big@${dom}`, 900_000)).response, 'LIMIT_EXCEEDED')
      const weak = await owner.post('/api/service-users', { login: `weak@${dom}`, password: 'abc', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 50 })
      if ([200, 201].includes(weak.status) && typeof weak.data?.serviceUser?.id === 'string') x.undo('weak mailbox', async () => [200, 202, 204, 404].includes((await owner.delete(`/api/service-users/${weak.data.serviceUser.id}`)).status))
      check('WEAK-PASSWORD-REFUSED', weak.status >= 400 && weak.data?.code === 'VALIDATION', safeResponse(weak))
      const info = await addMailbox(x, owner, `info@${dom}`, 50)
      const client = info.id ? await mailboxClient(x, info) : null
      check('VALID-MAILBOX-IMAP-LOGIN', info.response.status === 201 && client !== null, { status: info.response.status, login: client !== null })
    },
  }),

  tool('forwarders', {
    prefix: 'S7FWD', as: 'owner', also: ['mailbox', 'root'], needs: ['account', 'mailbox'], probe: '/api/mail/forwarders', page: FORWARDERS_PAGE,
    paths: only('mail/forwarders', `mail/forwarders/${ID}`, ...MAIL_PATHS, ...SCRATCH),
    requests: 90, deadlineMs: 300_000, unit: [{ id: 'S7FWD-UNIT-1', file: 'apps/api/src/mail/forwarder-validation.test.ts', name: 'forwarder configuration validation canonicalizes and deduplicates addresses while retaining legacy single destinations' }, { id: 'S7FWD-UNIT-2', ...ROUTING_UNIT }],
    checks: ['FORWARDER-CREATED', 'COPY-DELIVERED-TO-EACH-TARGET', 'PIPE-OUTSIDE-HOME-REFUSED', 'FORWARDER-LIMIT-EXCEEDED'],
    async run(x) {
      const { owner, mailbox, fixture, tag, check, refused, undo } = x
      const forwarder = async (client, body) => {
        const response = await client.post('/api/mail/forwarders', body), id = response.data?.forwarder?.id
        if (response.status === 201 && typeof id === 'string') undo('forwarder', async () => gone(await client.delete(`/api/mail/forwarders/${id}`)))
        return response
      }
      const second = await addMailbox(x, owner, `b${tag}@${fixture.domain}`)
      const secondClient = second.id ? await mailboxClient(x, second) : null
      const source = `sales${tag}@${fixture.domain}`
      const created = await forwarder(owner, { sourceAddress: source, action: 'forward', destinations: [fixture.mailbox.address, second.login] })
      check('FORWARDER-CREATED', created.status === 201, safeResponse(created))
      if (created.status === 201 && secondClient) {
        const subject = `xq-${tag}-fwd`
        await sendMail(mailbox, source, subject)
        const toFirst = await arrives(x, mailbox, subject), toSecond = await arrives(x, secondClient, subject)
        const counts = [await countSubject(mailbox, subject), await countSubject(secondClient, subject)]
        check('COPY-DELIVERED-TO-EACH-TARGET', toFirst.settled && toSecond.settled && counts[0] === 1 && counts[1] === 1, { copies: counts })
      } else check('COPY-DELIVERED-TO-EACH-TARGET', false, { created: created.status === 201, secondLogin: secondClient !== null })
      refused('PIPE-OUTSIDE-HOME-REFUSED', await forwarder(owner, { sourceAddress: `pipe${tag}@${fixture.domain}`, action: 'pipe', destinations: ['/etc/passwd'] }), 'VALIDATION')
      const small = await scratch(x, 'fw', { forwarders: 1 })
      if (!small) return check('FORWARDER-LIMIT-EXCEEDED', false, { setup: false })
      const first = await forwarder(small.client, { sourceAddress: `a${tag}@${small.primary}`, action: 'forward', destinations: ['target@example.org'] })
      if (first.status !== 201) return check('FORWARDER-LIMIT-EXCEEDED', false, safeResponse(first))
      refused('FORWARDER-LIMIT-EXCEEDED', await forwarder(small.client, { sourceAddress: `b${tag}@${small.primary}`, action: 'forward', destinations: ['target@example.org'] }), 'LIMIT_EXCEEDED')
    },
  }),

  tool('domain-forwarders', {
    prefix: 'S7DFW', as: 'owner', also: ['mailbox'], needs: ['account', 'mailbox'], probe: '/api/mail/domain-forwarders', page: FORWARDERS_PAGE,
    paths: only('mail/domain-forwarders', `mail/domain-forwarders/${ID}`, 'domains', `domains/${ID}`, ...MAIL_PATHS),
    requests: 90, deadlineMs: 300_000, unit: [{ id: 'S7DFW-UNIT-1', ...ROUTING_UNIT }],
    checks: ['DOMAIN-FORWARDER-CREATED', 'UNKNOWN-ADDRESS-DELIVERED-TO-TARGET', 'EXISTING-MAILBOX-STAYS-LOCAL', 'SECOND-FORWARDER-CONFLICT'],
    async run(x) {
      const { owner, mailbox, fixture, tag, check, refused, undo } = x
      const target = await addDomain(x, owner, { name: `xq${tag}-df.example.net`, kind: 'addon', siteType: 'php' })
      if (!target.domain) return check('DOMAIN-FORWARDER-CREATED', false, safeResponse(target.response))
      const nobody = await addMailbox(x, owner, `nobody@${target.domain.name}`), nobodyClient = nobody.id ? await mailboxClient(x, nobody) : null
      const forwarder = async () => {
        const response = await owner.post('/api/mail/domain-forwarders', { sourceDomain: fixture.domain, targetDomain: target.domain.name }), id = response.data?.domainForwarder?.id
        if (response.status === 201 && typeof id === 'string') undo('domain forwarder', async () => gone(await owner.delete(`/api/mail/domain-forwarders/${id}`)))
        return response
      }
      const created = await forwarder()
      check('DOMAIN-FORWARDER-CREATED', created.status === 201, safeResponse(created))
      const unknown = `xq-${tag}-unknown`, local = `xq-${tag}-local`
      await sendMail(mailbox, `nobody@${fixture.domain}`, unknown)
      const forwarded = nobodyClient ? await arrives(x, nobodyClient, unknown) : null
      check('UNKNOWN-ADDRESS-DELIVERED-TO-TARGET', created.status === 201 && forwarded?.settled === true, { forwarded: forwarded?.settled ?? false, targetLogin: nobodyClient !== null })
      await sendMail(mailbox, fixture.mailbox.address, local)
      const stayed = await arrives(x, mailbox, local)
      check('EXISTING-MAILBOX-STAYS-LOCAL', created.status === 201 && stayed.settled, { delivered: stayed.settled })
      refused('SECOND-FORWARDER-CONFLICT', await forwarder(), 'CONFLICT')
    },
  }),

  tool('default-address', {
    prefix: 'S7DFA', as: 'owner', also: ['mailbox'], needs: ['account', 'mailbox'], probe: '/api/mail/forwarders', page: FORWARDERS_PAGE,
    paths: only('mail/default-addresses', ...MAIL_PATHS),
    requests: 60, deadlineMs: 240_000, unit: [{ id: 'S7DFA-UNIT-1', ...ROUTING_UNIT }],
    checks: ['CUSTOM-REJECT-TEXT-SAVED', 'REJECT-5XX-CARRIES-TEXT', 'FORWARD-MODE-SAVED', 'FORWARD-DELIVERS-TO-TARGET'],
    async run(x) {
      const { owner, mailbox, fixture, tag, check, ok, undo } = x
      const route = '/api/mail/default-addresses', domain = fixture.domain
      const before = await owner.get(route), entry = before.data?.defaultAddresses?.find(item => item.domain === domain)
      if (before.status !== 200 || !entry) return check('CUSTOM-REJECT-TEXT-SAVED', false, { status: before.status })
      const original = entry.kind === 'forward' ? { domain, kind: 'forward', destination: entry.destination } : { domain, kind: entry.kind }
      undo('default address', async () => {
        const back = await owner.put(route, original)
        return back.status === 200 && back.data?.defaultAddresses?.find(item => item.domain === domain)?.kind === original.kind
      })
      const gonePhrase = 'gone'
      ok('CUSTOM-REJECT-TEXT-SAVED', await owner.put(route, { domain, kind: 'reject', text: gonePhrase }))
      const rejected = await sendMail(mailbox, `missing${tag}@${domain}`, `xq-${tag}-reject`)
      check('REJECT-5XX-CARRIES-TEXT', rejected.status >= 400 && JSON.stringify(rejected.data ?? {}).includes(gonePhrase), safeResponse(rejected))
      const forward = await owner.put(route, { domain, kind: 'forward', destination: fixture.mailbox.address })
      check('FORWARD-MODE-SAVED', forward.status === 200 && forward.data?.defaultAddresses?.find(item => item.domain === domain)?.kind === 'forward', safeResponse(forward))
      const subject = `xq-${tag}-fwd`
      await sendMail(mailbox, `missing${tag}@${domain}`, subject)
      const arrived = await arrives(x, mailbox, subject)
      check('FORWARD-DELIVERS-TO-TARGET', forward.status === 200 && arrived.settled, { delivered: arrived.settled })
    },
  }),

  tool('autoresponders', {
    prefix: 'S7ARP', as: 'owner', also: ['mailbox'], needs: ['account', 'mailbox'], probe: '/api/mail/autoresponders', page: FORWARDERS_PAGE,
    paths: only('mail/autoresponders', ...MAIL_PATHS),
    requests: 80, deadlineMs: 240_000, unit: [{ id: 'S7ARP-UNIT-1', file: 'apps/api/src/completion-mail-routing-apply.test.ts', name: 'account mail routing applied on the host through the agent answers for an address without a mailbox, edits it in place and removes it, with host state' }],
    checks: ['ONE-REPLY-WITHIN-INTERVAL', 'ORIGINALS-LAND-IN-INBOX', 'SECOND-AUTORESPONDER-CONFLICT', 'STOP-BEFORE-START-VALIDATION'],
    async run(x) {
      const { owner, mailbox, fixture, tag, check, block, refused, undo } = x
      const route = '/api/mail/autoresponders'
      const remove = async address => {
        const view = await owner.get(route), row = view.data?.autoresponders?.find(item => item.address === address)
        if (view.status !== 200) return false
        return !row || (await owner.delete(route, { address, expectedRevision: row.revision })).status === 200
      }
      const body = (address, extra = {}) => ({ address, expectedRevision: null, enabled: true, subject: `xq-${tag}-auto`, body: 'xq', htmlBody: '', startDate: null, endDate: null, replyIntervalHours: 24, ...extra })
      const address = `auto${tag}@${fixture.domain}`
      undo('autoresponder', () => remove(address))
      const saved = await owner.put(route, body(address))
      const subject = `xq-${tag}-ask`
      let replies = null
      if (saved.status === 200) {
        await sendMail(mailbox, address, `${subject}-1`)
        await sendMail(mailbox, address, `${subject}-2`)
        const first = await arrives(x, mailbox, `xq-${tag}-auto`, undefined, false)
        await x.sleep(4000)
        replies = first.settled ? await countSubject(mailbox, `xq-${tag}-auto`, undefined, false) : 0
      }
      check('ONE-REPLY-WITHIN-INTERVAL', saved.status === 200 && replies === 1, { ...safeResponse(saved), replies })
      block('ORIGINALS-LAND-IN-INBOX', 'An address autoresponder has no mailbox of its own, so an API client cannot read the original messages it received.')
      refused('SECOND-AUTORESPONDER-CONFLICT', await owner.put(route, body(address)), 'CONFLICT')
      const stopped = `stop${tag}@${fixture.domain}`
      undo('autoresponder stop', () => remove(stopped))
      refused('STOP-BEFORE-START-VALIDATION', await owner.put(route, body(stopped, { startDate: '2031-01-02T00:00:00.000Z', endDate: '2031-01-01T00:00:00.000Z' })), 'VALIDATION')
    },
  }),

  tool('mailing-lists', {
    prefix: 'S7MLS', as: 'owner', also: ['mailbox', 'root'], needs: ['account', 'mailbox'], probe: '/api/mail/mailing-lists',
    paths: only('mail/mailing-lists', `mail/mailing-lists/${ID}`, `mail/mailing-lists/${ID}/moderation`, 'webmail/mailing-lists', 'webmail/mailing-lists/moderation', ...MAIL_PATHS, ...SCRATCH),
    requests: 60, deadlineMs: 300_000, unit: [{ id: 'S7MLS-UNIT-1', file: 'apps/api/src/mail/mailbox-mailing-lists.test.ts', name: 'sealed mailbox mailing-list subscriptions shows only public or current bound memberships, with no member addresses or counts' }, { id: 'S7MLS-UNIT-2', file: 'apps/api/src/mail/list-moderation.test.ts', name: 'webmail moderation sign-in admits a moderator mailbox on its own session, and audits as the mailbox' }],
    checks: ['SPACE-IN-NAME-VALIDATION', 'PRIVATE-LIST-HIDDEN-FROM-PUBLIC-INDEX', 'LIST-LIMIT-EXCEEDED', 'DELEGATE-APPROVES-HELD-POST'],
    async run(x) {
      const { owner, mailbox, fixture, tag, check, block, refused, undo } = x
      const list = async (client, body) => {
        const response = await client.post('/api/mail/mailing-lists', body), id = response.data?.mailingList?.id
        if (response.status === 201 && typeof id === 'string') undo('mailing list', async () => gone(await client.delete(`/api/mail/mailing-lists/${id}`)))
        return response
      }
      refused('SPACE-IN-NAME-VALIDATION', await list(owner, { name: 'my list', domain: fixture.domain }), 'VALIDATION')
      const address = `private${tag}@${fixture.domain}`
      const created = await list(owner, { address, private: true })
      const index = await mailbox.get('/api/webmail/mailing-lists')
      check('PRIVATE-LIST-HIDDEN-FROM-PUBLIC-INDEX', created.status === 201 && index.status === 200 && !JSON.stringify(index.data).includes(address), { created: created.status, index: index.status })
      const small = await scratch(x, 'ml', { mailingLists: 1 })
      const firstList = small ? await list(small.client, { address: `a${tag}@${small.primary}` }) : null
      if (firstList?.status === 201) refused('LIST-LIMIT-EXCEEDED', await list(small.client, { address: `b${tag}@${small.primary}` }), 'LIMIT_EXCEEDED')
      else check('LIST-LIMIT-EXCEEDED', false, { setup: small !== null, ...(firstList ? safeResponse(firstList) : {}) })
      const heldAddress = `held${tag}@${fixture.domain}`, subject = `xq-${tag}-held`, moderator = fixture.mailbox.address
      const heldList = await list(owner, { address: heldAddress, members: [moderator], moderation: 'moderated' })
      const heldId = heldList.data?.mailingList?.id, route = `/api/mail/mailing-lists/${heldId}/moderation`, read = heldId ? await owner.get(route) : heldList
      const saved = heldId && read.status === 200 ? await owner.put(route, { moderation: 'moderated', selfSubscription: 'closed', policy: { ...read.data.policy, moderators: [moderator] }, expectedRevision: read.data.revision }) : read
      await sendMail(mailbox, heldAddress, subject)
      const moderate = (op, args) => mailbox.post('/api/webmail/mailing-lists/moderation', { list: heldAddress, password: null, op, args })
      let held = null
      for (let round = 0; round < 15 && !held; round++) {
        held = (await moderate('queue', {})).data?.rows?.find(row => row.subject === subject) ?? null
        if (!held) await x.sleep(2000)
      }
      const decided = held ? await moderate('act', { action: 'approve', ids: [held.id] }) : null
      const delivered = decided?.data?.done === 1 ? await arrives(x, mailbox, subject) : null
      check('DELEGATE-APPROVES-HELD-POST', saved.status === 200 && delivered?.settled === true, { list: heldList.status, saved: saved.status, held: held !== null, decided: decided?.status ?? null })
    },
  }),

  tool('email-filters', {
    prefix: 'S7EFL', as: 'owner', needs: ['account', 'mailbox'], probe: '/api/mail/filters',
    paths: only('mail/filters', `mail/filters/${ID}`, 'mail/filters/reorder', 'mail/filters/test', 'mail/filters\\?scope=mailbox&mailbox=[A-Za-z0-9._%-]{1,254}', 'service-users', `service-users/${ID}`),
    requests: 60, deadlineMs: 240_000, unit: [{ id: 'S7EFL-UNIT-1', file: 'apps/api/src/completion-security-email-filters.test.ts', name: 'mail-filter configuration HTTP security acceptance with disposable state dry-runs a sample message through account-wide then mailbox rules without writing, hiding rules the caller may not read' }],
    checks: ['STOP-FIRST-KEEPS-MESSAGE', 'REORDER-SAVED', 'DISCARD-FIRST-DROPS-MESSAGE', 'OTHER-MAILBOX-UNAFFECTED'],
    async run(x) {
      const { owner, fixture, tag, check, undo } = x
      const a = fixture.mailbox.address, sender = 'x@y.test'
      const other = await addMailbox(x, owner, `f${tag}@${fixture.domain}`)
      const view = `/api/mail/filters?scope=mailbox&mailbox=${encodeURIComponent(a)}`
      undo('mailbox filters', async () => {
        for (let round = 0; round < 3; round++) {
          const now = await owner.get(view)
          if (now.status !== 200) return false
          const mine = now.data.filters.filter(item => String(item.name).startsWith(`xq-${tag}`))
          if (!mine.length) return true
          await owner.delete(`/api/mail/filters/${mine[0].id}`, { expectedRevision: now.data.revision })
        }
        return false
      })
      const rule = (name, action) => ({ scope: 'mailbox', mailbox: a, name: `xq-${tag}-${name}`, conditions: [{ field: 'from', comparator: 'is', value: sender }], actions: [{ type: action }] })
      const first = await owner.post('/api/mail/filters', rule('1', 'stop')), second = await owner.post('/api/mail/filters', rule('2', 'discard'))
      const trace = mailbox => owner.post('/api/mail/filters/test', { scope: 'mailbox', mailbox, message: { from: sender, to: mailbox, subject: `xq-${tag}` } })
      const kept = await trace(a)
      check('STOP-FIRST-KEEPS-MESSAGE', first.status === 201 && second.status === 201 && kept.status === 200 && kept.data?.outcome?.discarded === false && kept.data?.outcome?.stopped === true, { first: first.status, second: second.status, trace: kept.status })
      const ids = [first.data?.filter?.id, second.data?.filter?.id], current = await owner.get(view)
      const reordered = ids.every(id => typeof id === 'string') ? await owner.post('/api/mail/filters/reorder', { scope: 'mailbox', mailbox: a, orderedIds: [ids[1], ids[0]], expectedRevision: current.data?.revision }) : null
      check('REORDER-SAVED', reordered?.status === 200 && reordered.data?.filters?.[0]?.id === ids[1], { status: reordered?.status ?? null })
      const dropped = await trace(a)
      check('DISCARD-FIRST-DROPS-MESSAGE', reordered?.status === 200 && dropped.status === 200 && dropped.data?.outcome?.discarded === true, { trace: dropped.status })
      const untouched = other.id ? await trace(other.login) : null
      check('OTHER-MAILBOX-UNAFFECTED', untouched?.status === 200 && untouched.data?.outcome?.discarded === false && untouched.data?.outcome?.stopped === false, { trace: untouched?.status ?? null })
    },
  }),

  tool('global-email-filters', {
    prefix: 'S7GEF', as: 'owner', also: ['mailbox'], needs: ['account', 'mailbox'], probe: '/api/mail/filters',
    paths: only('mail/filters', `mail/filters/${ID}`, 'mail/filters/test', 'mail/filters\\?scope=global', ...MAIL_PATHS),
    requests: 60, deadlineMs: 240_000, unit: [{ id: 'S7GEF-UNIT-1', file: 'apps/api/src/completion-security-email-filters.test.ts', name: 'mail-filter configuration HTTP security acceptance with disposable state dry-runs a sample message through account-wide then mailbox rules without writing, hiding rules the caller may not read' }],
    checks: ['GLOBAL-FILTER-CREATED', 'TEST-REPORTS-CONDITION-TRUE', 'TEST-DELIVERS-NOTHING', 'MATCHING-MESSAGE-MOVED-TO-FOLDER'],
    async run(x) {
      const { owner, mailbox, tag, check, undo } = x
      const view = '/api/mail/filters?scope=global'
      undo('global filter', async () => {
        for (let round = 0; round < 3; round++) {
          const now = await owner.get(view)
          if (now.status !== 200) return false
          const mine = now.data.filters.filter(item => String(item.name).startsWith(`xq-${tag}`))
          if (!mine.length) return true
          await owner.delete(`/api/mail/filters/${mine[0].id}`, { expectedRevision: now.data.revision })
        }
        return false
      })
      const subject = `PROMO xq-${tag}`
      const created = await owner.post('/api/mail/filters', { scope: 'global', name: `xq-${tag}-promo`, conditions: [{ field: 'subject', comparator: 'contains', value: 'PROMO' }], actions: [{ type: 'fileinto', target: 'Promo' }] })
      check('GLOBAL-FILTER-CREATED', created.status === 201, safeResponse(created))
      if (created.status !== 201) return
      const before = [await countSubject(mailbox, subject), await countSubject(mailbox, subject, 'Promo')]
      const tested = await owner.post('/api/mail/filters/test', { scope: 'global', message: { from: 'a@b.test', to: 'c@d.test', subject } })
      const rule = tested.data?.rules?.[0]
      check('TEST-REPORTS-CONDITION-TRUE', tested.status === 200 && rule?.matched === true && rule?.tests?.[0]?.matched === true && tested.data.outcome?.folders?.includes('Promo') === true, { status: tested.status, matched: rule?.matched ?? null })
      const after = [await countSubject(mailbox, subject), await countSubject(mailbox, subject, 'Promo')]
      check('TEST-DELIVERS-NOTHING', tested.status === 200 && before[0] !== null && before[0] === after[0] && (before[1] ?? 0) === (after[1] ?? 0), { inbox: after[0], folder: after[1] })
      await sendMail(mailbox, x.fixture.mailbox.address, subject)
      const moved = await arrives(x, mailbox, subject, 'Promo')
      check('MATCHING-MESSAGE-MOVED-TO-FOLDER', moved.settled, { attempts: moved.attempts })
    },
  }),

  tool('spam-filters', {
    prefix: 'S7SPM', as: 'owner', also: ['mailbox'], needs: ['account', 'mailbox'], probe: '/api/mail/spam-settings',
    paths: only('mail/spam-settings', ...MAIL_PATHS),
    requests: 60, deadlineMs: 240_000, unit: [{ id: 'S7SPM-UNIT-1', file: 'apps/api/src/completion-spam-settings-security.test.ts', name: 'account spam settings HTTP security acceptance stores validated settings with an account-scoped audit and persisted readback' }],
    checks: ['THRESHOLD-FIVE-SAVED', 'GTUBE-LANDS-IN-SPAM-FOLDER', 'ALLOWED-SENDER-LANDS-IN-INBOX', 'THRESHOLD-ZERO-VALIDATION'],
    async run(x) {
      const { owner, mailbox, fixture, tag, check, refused, undo } = x
      const route = '/api/mail/spam-settings', before = await owner.get(route)
      if (before.status !== 200 || !before.data?.settings) return check('THRESHOLD-FIVE-SAVED', false, safeResponse(before))
      const { updatedAt: _stamp, ...original } = before.data.settings
      undo('spam settings', async () => {
        const back = await owner.put(route, original)
        if (back.status !== 200) return false
        const { updatedAt: _after, ...restored } = back.data.settings
        return sameJson(restored, original)
      })
      const saved = await owner.put(route, { addHeaderScore: 5, spamBoxEnabled: true, enabled: true, allowlist: [] })
      check('THRESHOLD-FIVE-SAVED', saved.status === 200 && saved.data?.settings?.addHeaderScore === 5 && saved.data.settings.spamBoxEnabled === true, safeResponse(saved))
      const gtube = 'XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X'
      const test = subject => mailbox.post('/api/webmail/send', { to: fixture.mailbox.address, subject, text: gtube })
      const flagged = `xq-${tag}-gtube`
      await test(flagged)
      const inSpam = await arrives(x, mailbox, flagged, 'spam')
      check('GTUBE-LANDS-IN-SPAM-FOLDER', saved.status === 200 && inSpam.settled, { attempts: inSpam.attempts })
      const allowed = await owner.put(route, { allowlist: [fixture.mailbox.address] })
      const trusted = `xq-${tag}-allowed`
      if (allowed.status === 200) await test(trusted)
      const inInbox = allowed.status === 200 ? await arrives(x, mailbox, trusted) : null
      check('ALLOWED-SENDER-LANDS-IN-INBOX', allowed.status === 200 && inInbox?.settled === true, { status: allowed.status, delivered: inInbox?.settled ?? false })
      refused('THRESHOLD-ZERO-VALIDATION', await owner.put(route, { addHeaderScore: 0 }), 'VALIDATION')
    },
  }),

  tool('email-account-manage', {
    prefix: 'S7EAM', as: 'owner', also: ['mailbox'], needs: ['account', 'mailbox'], probe: '/api/service-users', page: ACCOUNTS_PAGE,
    paths: only(...MAIL_PATHS),
    requests: 70, deadlineMs: 240_000, unit: [MAIL_UNIT],
    checks: ['SENDING-HOLD-SAVED', 'HELD-COUNT-ONE', 'HELD-MESSAGE-NOT-DELIVERED', 'ALLOW-DELIVERS-HELD-MESSAGE', 'HELD-COUNT-ZERO', 'LOGIN-SUSPEND-SAVED', 'SUSPENDED-IMAP-LOGIN-FAILS', 'SUSPENDED-MAILBOX-STILL-RECEIVES'],
    async run(x) {
      const { owner, mailbox, fixture, tag, check, block, undo } = x
      const row = async () => { const response = await owner.get('/api/service-users'); return { response, row: response.data?.serviceUsers?.find(item => item.login === fixture.mailbox.address) } }
      const start = await row()
      if (!start.row) return check('SENDING-HOLD-SAVED', false, { status: start.response.status })
      let changed = false
      undo('mailbox state', async () => {
        if (!changed) return true
        return (await owner.patch(`/api/service-users/${start.row.id}`, { sending: 'allow', login: 'allow' })).status === 200
      })
      const hold = await owner.patch(`/api/service-users/${start.row.id}`, { sending: 'hold' })
      changed = hold.status === 200
      check('SENDING-HOLD-SAVED', hold.status === 200 && hold.data?.serviceUser?.sending === 'hold', safeResponse(hold))
      const subject = `xq-${tag}-held`
      await sendMail(mailbox, fixture.mailbox.address, subject)
      const held = await row()
      check('HELD-COUNT-ONE', held.row?.heldCount === 1, { held: held.row?.heldCount ?? null })
      const early = await countSubject(mailbox, subject)
      check('HELD-MESSAGE-NOT-DELIVERED', held.row?.heldCount === 1 && early === 0, { held: held.row?.heldCount ?? null, inbox: early })
      const allow = await owner.patch(`/api/service-users/${start.row.id}`, { sending: 'allow' })
      const released = allow.status === 200 ? await arrives(x, mailbox, subject) : null
      check('ALLOW-DELIVERS-HELD-MESSAGE', allow.status === 200 && released?.settled === true, safeResponse(allow))
      const after = await row()
      check('HELD-COUNT-ZERO', after.row?.heldCount === 0, { held: after.row?.heldCount ?? null })
      const suspend = await owner.patch(`/api/service-users/${start.row.id}`, { login: 'suspend' })
      changed = changed || suspend.status === 200
      check('LOGIN-SUSPEND-SAVED', suspend.status === 200 && suspend.data?.serviceUser?.login === 'suspend', safeResponse(suspend))
      const login = await x.signIn('mailbox', { username: fixture.mailbox.address, password: fixture.mailbox.password })
      check('SUSPENDED-IMAP-LOGIN-FAILS', suspend.status === 200 && login.client === null, { status: login.response.status })
      block('SUSPENDED-MAILBOX-STILL-RECEIVES', 'Delivering to the suspended mailbox needs an SMTP sender outside it, and reading the result needs a login that the suspension refuses.')
    },
  }),
]
