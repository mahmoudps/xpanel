import { randomBytes, randomUUID } from 'node:crypto'
import { safeResponse, tool } from './kit.mjs'

const secret = () => `Xq-${randomBytes(18).toString('base64url')}-9a`
const CAPS = { addonDomains: 10, aliasDomains: 10, subdomains: 20, mailboxes: 20, forwarders: 20, mailingLists: 5, ftpAccounts: 10, databases: 10, phpWorkers: 8 }
const resources = (diskMb, bandwidthMbMonth) => ({ diskMb, bandwidthMbMonth, ioReadBps: 50_000_000, ioWriteBps: 50_000_000, ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 })
const ACL = ['create-account', 'edit-account', 'suspend-account', 'terminate-account', 'change-plan', 'manage-plans', 'manage-feature-lists', 'change-password', 'list-accounts']
const NAME = 'xq[0-9a-f]{8}[a-z]{1,2}', ID = '[0-9a-f-]{36}'
const P = { account: `accounts/${NAME}`, plan: `plans/${ID}`, list: `feature-lists/${ID}`, reseller: `resellers/${ID}`, domain: `domains/${ID}` }
const only = (...alts) => new RegExp(`^/api/(?:${alts.join('|')})$`)
const gone = response => [200, 404].includes(response.status)
const accountIds = response => Array.isArray(response.data?.accounts) ? response.data.accounts.map(item => item.id) : null
const planOf = (response, id) => Array.isArray(response.data?.plans) ? response.data.plans.find(item => item.id === id) : undefined

async function visit(site, domain) {
  try {
    const plain = await site.get(domain, '/')
    return plain.status >= 300 && plain.status < 400 ? await site.get(domain, '/', { secure: true }) : plain
  } catch { return { status: 0, headers: {} } }
}

async function newList(x, label, disabled = [], client = x.root) {
  const response = await client.post('/api/feature-lists', { name: `xq-${x.tag}-${label}`, ownerId: null, disabled })
  const id = response.status === 201 && typeof response.data?.featureList?.id === 'string' ? response.data.featureList.id : null
  if (id) x.undo(`feature list ${label}`, async () => gone(await x.root.delete(`/api/feature-lists/${id}`)))
  return { response, id }
}

async function newPlan(x, label, listId, { client = x.root, ownerId, disk = 2048, bandwidth = 10240, caps = {}, name = `xq-${x.tag}-${label}`, ...rest } = {}) {
  const response = await client.post('/api/plans', { name, featureListId: listId, ...(ownerId && { ownerId }), resources: resources(disk, bandwidth), caps: { ...CAPS, ...caps }, ...rest })
  const id = response.status === 201 && typeof response.data?.plan?.id === 'string' ? response.data.plan.id : null
  if (id) x.undo(`plan ${label}`, async () => gone(await x.root.delete(`/api/plans/${id}`)))
  return { response, id, name }
}

/** The undo is registered before the request, so a created account is never left behind by a lost reply. */
async function newAccount(x, suffix, planId, { client = x.root, ownerId, extra = {} } = {}) {
  const username = `xq${x.tag}${suffix}`, password = secret(), primary = `${username}.example.net`
  x.undo(`account ${suffix}`, async () => gone(await x.root.delete(`/api/accounts/${username}`, { confirmUsername: username })))
  const response = await client.post('/api/accounts', { username, password, primaryDomain: primary, planId, ...(ownerId && { ownerId }), ...extra }, { idempotencyKey: `xq-${x.tag}-${suffix}` })
  const account = response.data?.account
  return { response, username, password, primary, account, id: account?.id ?? null, domainId: response.data?.primaryDomain?.id ?? null, ok: response.status === 201 && typeof account?.id === 'string' }
}

/** A request the product should refuse; if it creates the account anyway, the account is removed again. */
async function probeAccount(x, body) {
  const response = await x.root.post('/api/accounts', { password: secret(), ...body })
  if ([200, 201].includes(response.status) && typeof body.username === 'string') {
    x.undo(`probe account ${body.username}`, async () => gone(await x.root.delete(`/api/accounts/${body.username}`, { confirmUsername: body.username })))
  }
  return response
}

async function newReseller(x, suffix, patch = {}, login = true) {
  const username = `xq${x.tag}${suffix}`, password = secret()
  const response = await x.root.post('/api/resellers', { username, password, acl: ACL, maxAccounts: 'unlimited', totalDiskMb: 'unlimited', totalBandwidthMb: 'unlimited', oversell: { disk: true, bandwidth: true }, nameservers: ['ns1.example.net', 'ns2.example.net'], delegatedIps: [], ...patch })
  const id = response.data?.reseller?.id
  if (response.status !== 201 || typeof id !== 'string') return { ok: false, response }
  x.undo(`reseller ${suffix}`, async () => gone(await x.root.delete(`/api/resellers/${id}`)))
  const session = login ? await x.signIn('reseller', { username, password }) : { client: null }
  return { ok: !login || session.client !== null, id, username, password, client: session.client, response, loginResponse: session.response }
}

/** A reseller session the driver closes itself, for runs that delete the reseller before the undo steps. */
async function manualSession(x, credentials) {
  const login = await x.root.anonymous('/api/auth/login', { method: 'POST', body: credentials })
  const cookie = login.setCookie?.find(value => value.startsWith('__Host-xwhm_session='))?.split(';')[0]
  if (login.status !== 200 || cookie === undefined) return { login, client: null, close: async () => 200 }
  const csrf = login.data?.csrfToken
  let closed = null
  const close = async () => (closed ??= (await x.root.anonymous('/api/auth/logout', { method: 'POST', cookie, csrf, body: {} })).status)
  x.undo('reseller session', async () => [200, 401].includes(await close()))
  return { login, client: { get: path => x.root.anonymous(path, { cookie }) }, close }
}

export default [
  tool('list-accounts', {
    prefix: 'W1LA', needs: ['account'], probe: '/api/accounts',
    paths: only('accounts', P.account, 'accounts\\?by=package&q=gold', 'accounts\\?by=package&q=gold&format=csv', 'feature-lists', P.list, 'plans', P.plan, 'resellers', P.reseller),
    requests: 40, deadlineMs: 240000,
    page: { route: '/whm/accounts', read: '/api/accounts', shows: data => [data?.accounts?.[0]?.username] },
    unit: [{ id: 'W1LA-UNIT-SCOPE', file: 'apps/api/src/completion-reseller-security.test.ts', name: 'real HTTP reseller-owned account scope scopes GET /api/accounts to each reseller current ownership' }],
    checks: ['RESELLER-OWN-ONLY', 'FILTER-BY-PACKAGE', 'CSV-SAME-ROWS'],
    async run(x) {
      const { fixture, check } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const gold = await newPlan(x, 'gold', list.id), silver = await newPlan(x, 'silver', list.id)
      if (!gold.id || !silver.id) return
      const reseller = await newReseller(x, 'r')
      if (!reseller.ok) return
      const a = await newAccount(x, 'a', gold.id, { ownerId: reseller.id }), b = await newAccount(x, 'b', silver.id, { ownerId: reseller.id })
      if (!a.ok || !b.ok) return
      const own = await reseller.client.get('/api/accounts'), ownIds = accountIds(own)
      check('RESELLER-OWN-ONLY', own.status === 200 && ownIds !== null && ownIds.length === 2 && ownIds.includes(a.id) && ownIds.includes(b.id) && !ownIds.includes(fixture.accountId), { status: own.status, count: ownIds?.length ?? null })
      const filtered = await reseller.client.get('/api/accounts?by=package&q=gold'), filteredIds = accountIds(filtered)
      check('FILTER-BY-PACKAGE', filtered.status === 200 && filteredIds !== null && filteredIds.length === 1 && filteredIds[0] === a.id, { status: filtered.status, count: filteredIds?.length ?? null })
      const csv = await reseller.client.get('/api/accounts?by=package&q=gold&format=csv')
      const rows = typeof csv.text === 'string' ? csv.text : ''
      check('CSV-SAME-ROWS', csv.status === 200 && typeof csv.text === 'string' && rows.includes(a.username) && !rows.includes(b.username), { status: csv.status, text: typeof csv.text === 'string' })
    },
  }),

  tool('create-account', {
    prefix: 'W1CA', probe: '/api/accounts',
    paths: only('accounts', `accounts/(?:${NAME}|1abc|testsite)`, 'dns/zones', 'feature-lists', P.list, 'plans', P.plan, 'resellers', P.reseller),
    requests: 60, deadlineMs: 300000,
    page: { route: '/whm/accounts/new', read: '/api/plans', shows: data => [data?.plans?.[0]?.name] },
    unit: [
      { id: 'W1CA-UNIT-LIMIT', file: 'apps/api/src/completion-reseller-security.test.ts', name: 'real HTTP reseller-owned account scope refuses account creation over the reseller account cap without creating state' },
      { id: 'W1CA-UNIT-CREATE', file: 'apps/api/src/account-mutation-security.test.ts', name: 'account mutation outcomes and race boundaries creates through the dedicated bound protocol and enables sign-in only after its strict account receipt' },
    ],
    checks: ['LIMIT-EXCEEDED', 'USERNAME-INVALID', 'DMARC-REQUIRES-SPF-DKIM', 'VALID-CREATES-HOST-OBJECTS'],
    async run(x) {
      const { root, tag, site, check, refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const reseller = await newReseller(x, 'r', { maxAccounts: 2 })
      if (!reseller.ok) return
      const bad = []
      for (const [username, label] of [['1abc', 'u1'], ['testsite', 'u2']]) bad.push(await probeAccount(x, { username, primaryDomain: `xq${tag}${label}.example.net`, planId: plan.id }))
      check('USERNAME-INVALID', bad.every(response => response.status >= 400 && response.data?.code === 'VALIDATION'), { responses: bad.map(safeResponse) })
      refused('DMARC-REQUIRES-SPF-DKIM', await probeAccount(x, { username: `xq${tag}m`, primaryDomain: `xq${tag}m.example.net`, planId: plan.id, dmarc: 1, spf: 0 }), 'VALIDATION')
      const a = await newAccount(x, 'a', plan.id, { client: reseller.client })
      if (a.ok) {
        const detail = await root.get(`/api/accounts/${a.username}`), zones = await root.get('/api/dns/zones'), served = await visit(site, a.primary)
        const domain = detail.data?.domains?.some(item => item.name === a.primary) === true, zone = zones.data?.zones?.some(item => item.name === a.primary) === true
        check('VALID-CREATES-HOST-OBJECTS', a.response.data?.execution?.targetVerified === true && Number.isInteger(a.account.uid) && typeof a.account.home === 'string' && domain && zone && served.status > 0 && served.status < 500,
          { status: a.response.status, verified: a.response.data?.execution?.targetVerified === true, domain, zone, siteStatus: served.status })
      }
      const b = await newAccount(x, 'b', plan.id, { client: reseller.client })
      if (!a.ok || !b.ok) return
      const c = await newAccount(x, 'c', plan.id, { client: reseller.client })
      refused('LIMIT-EXCEEDED', c.response, 'LIMIT_EXCEEDED')
    },
  }),

  tool('modify-account', {
    prefix: 'W1MA', probe: '/api/accounts',
    paths: only('accounts', P.account, 'feature-lists', P.list, 'plans', P.plan),
    requests: 40, deadlineMs: 240000,
    page: { route: '/whm/accounts', read: '/api/accounts', shows: data => [data?.accounts?.[0]?.username] },
    unit: [
      { id: 'W1MA-UNIT-UPDATE', file: 'apps/api/src/account-mutation-security.test.ts', name: 'account mutation outcomes and race boundaries rejects an ownership change after authorization through revision CAS before side effects' },
      { id: 'W1MA-UNIT-LIMITS', file: 'apps/api/src/account-limits-workspace.test.ts', name: 'a limit that diverges from the assigned package takes every WHM limit name and every package field, with resources and caps together' },
    ],
    checks: ['PACKAGE-CONFLICT', 'FIVE-RESOLUTIONS', 'CREATE-RESOLUTION-NEW-PACKAGE', 'OTHERS-UNCHANGED', 'OTHER-LIMIT-CONFLICT', 'KEEP-HOLDS-ACCOUNT-LIMIT', 'DETACH-REFUSED'],
    async run(x) {
      const { root, check, refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const basic = await newPlan(x, 'basic', list.id)
      if (!basic.id) return
      const u1 = await newAccount(x, 'a', basic.id), u2 = await newAccount(x, 'b', basic.id)
      if (!u1.ok || !u2.ok) return
      const conflict = await root.patch(`/api/accounts/${u1.username}`, { maxaddon: 3 })
      refused('PACKAGE-CONFLICT', conflict, 'CONFLICT')
      refused('OTHER-LIMIT-CONFLICT', await root.patch(`/api/accounts/${u2.username}`, { maxsub: 7 }), 'CONFLICT')
      refused('DETACH-REFUSED', await root.patch(`/api/accounts/${u2.username}`, { maxsub: 7, resolution: 'detach' }), 'PRECONDITION_FAILED')
      const kept = await root.patch(`/api/accounts/${u2.username}`, { maxsub: 7, resolution: 'keep' })
      check('KEEP-HOLDS-ACCOUNT-LIMIT', kept.status === 200 && kept.data?.account?.limits?.caps?.subdomains === 7 && kept.data?.account?.planId === basic.id, { status: kept.status })
      const resolutions = conflict.data?.details?.resolutions ?? conflict.data?.resolutions
      check('FIVE-RESOLUTIONS', conflict.status >= 400 && Array.isArray(resolutions) && resolutions.length === 5, { status: conflict.status, count: Array.isArray(resolutions) ? resolutions.length : null })
      const created = await root.patch(`/api/accounts/${u1.username}`, { maxaddon: 3, resolution: 'create' })
      const plans = await root.get('/api/plans'), fresh = plans.data?.plans?.find(item => item.name === `${basic.name}_${u1.username}`)
      if (fresh) x.undo('derived package', async () => { await root.delete(`/api/accounts/${u1.username}`, { confirmUsername: u1.username }); return gone(await root.delete(`/api/plans/${fresh.id}`)) })
      const mine = await root.get(`/api/accounts/${u1.username}`), other = await root.get(`/api/accounts/${u2.username}`)
      check('CREATE-RESOLUTION-NEW-PACKAGE', created.status === 200 && fresh !== undefined && mine.data?.account?.planId === fresh.id && fresh.caps?.addonDomains === 3, { status: created.status, derived: fresh !== undefined })
      check('OTHERS-UNCHANGED', created.status === 200 && fresh !== undefined && other.status === 200 && other.data?.account?.planId === basic.id, { status: created.status, other: other.status })
    },
  }),

  tool('upgrade-downgrade-account', {
    prefix: 'W1UD', probe: '/api/accounts',
    paths: only('accounts', P.account, 'feature-lists', P.list, 'plans', P.plan, 'resellers', P.reseller),
    requests: 50, deadlineMs: 300000,
    unit: [{ id: 'W1UD-UNIT-PLAN', file: 'apps/api/src/completion-reseller-security.test.ts', name: 'real HTTP reseller-owned account scope refuses plan upgrades beyond the reseller allocation and without the change-plan ACL' }],
    checks: ['UPGRADE-LIMITS-EQUAL', 'IP-UNCHANGED', 'FORBIDDEN-PACKAGE', 'PER-PACKAGE-LIMIT-EXCEEDED'],
    async run(x) {
      const { root, check, refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const basic = await newPlan(x, 'basic', list.id), pro = await newPlan(x, 'pro', list.id, { disk: 4096 }), other = await newPlan(x, 'other', list.id)
      if (!basic.id || !pro.id || !other.id) return
      const reseller = await newReseller(x, 'r', { packageLimits: [{ planId: basic.id, maxAccounts: 1 }, { planId: pro.id, maxAccounts: 5 }] })
      if (!reseller.ok) return
      const a = await newAccount(x, 'a', basic.id, { ownerId: reseller.id }), b = await newAccount(x, 'b', pro.id, { ownerId: reseller.id })
      if (!a.ok || !b.ok) return
      const before = await root.get(`/api/accounts/${a.username}`)
      refused('FORBIDDEN-PACKAGE', await reseller.client.patch(`/api/accounts/${a.username}`, { planId: other.id }), 'FORBIDDEN')
      refused('PER-PACKAGE-LIMIT-EXCEEDED', await reseller.client.patch(`/api/accounts/${b.username}`, { planId: basic.id }), 'LIMIT_EXCEEDED')
      const moved = await root.patch(`/api/accounts/${a.username}`, { planId: pro.id })
      const after = await root.get(`/api/accounts/${a.username}`), limits = after.data?.account?.limits
      check('UPGRADE-LIMITS-EQUAL', moved.status === 200 && after.data?.account?.planId === pro.id && (limits === undefined || limits === null || Object.keys(limits).length === 0), { status: moved.status, planMoved: after.data?.account?.planId === pro.id })
      check('IP-UNCHANGED', moved.status === 200 && typeof before.data?.account?.ipv4 === 'string' && after.data?.account?.ipv4 === before.data.account.ipv4, { status: moved.status })
    },
  }),

  tool('manage-account-suspension', {
    prefix: 'W1SU', probe: '/api/accounts',
    paths: only('accounts', P.account, `${P.account}/(?:suspend|unsuspend|password)`, 'feature-lists', P.list, 'plans', P.plan),
    requests: 40, deadlineMs: 300000,
    page: { route: '/whm/accounts', read: '/api/accounts', shows: data => [data?.accounts?.[0]?.username] },
    unit: [
      { id: 'W1SU-UNIT-SUSPEND', file: 'apps/api/src/account-mutation-security.test.ts', name: 'account mutation outcomes and race boundaries revokes all linked aliases and tokens during suspension without changing disabled flags or neighbor access' },
      { id: 'W1SU-UNIT-CREDENTIALS', file: 'apps/api/src/authorization-security.test.ts', name: 'HTTP authorization security regressions suspended account credentials cannot read or write protected resources' },
    ],
    checks: ['SUSPENDED-SITE-TEMPLATE', 'PANEL-LOGIN-FAILS', 'PASSWORD-CHANGE-ACCOUNT-SUSPENDED', 'UNSUSPEND-ORIGINAL-PASSWORD-WORKS'],
    async run(x) {
      const { root, site, check, refused, signIn, until } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const a = await newAccount(x, 'a', plan.id)
      if (!a.ok) return
      const base = await visit(site, a.primary)
      const suspend = await root.post(`/api/accounts/${a.username}/suspend`, { reason: 'Nonpayment' }), suspended = suspend.status === 200
      const settled = suspended ? await until(() => visit(site, a.primary), seen => seen.status === 503, { attempts: 5, delayMs: 1500 }) : null
      check('SUSPENDED-SITE-TEMPLATE', suspended && base.status > 0 && base.status !== 503 && settled.settled === true && settled.last.headers?.['retry-after'] !== undefined, { suspend: suspend.status, before: base.status, after: settled?.last?.status ?? null })
      const login = await signIn('owner', { username: a.username, password: a.password })
      check('PANEL-LOGIN-FAILS', suspended && login.client === null && login.response.status >= 400 && login.response.status < 500, { status: login.response.status })
      refused('PASSWORD-CHANGE-ACCOUNT-SUSPENDED', await root.post(`/api/accounts/${a.username}/password`, { password: secret() }), 'FORBIDDEN')
      const resume = await root.post(`/api/accounts/${a.username}/unsuspend`, {})
      const back = resume.status === 200 ? await signIn('owner', { username: a.username, password: a.password }) : { client: null }
      check('UNSUSPEND-ORIGINAL-PASSWORD-WORKS', suspended && resume.status === 200 && back.client !== null, { unsuspend: resume.status, login: back.client !== null })
    },
  }),

  tool('terminate-accounts', {
    prefix: 'W1TE', probe: '/api/accounts',
    paths: only('accounts', P.account, 'dns/zones', `dns/zones/${NAME}\\.example\\.net`, 'feature-lists', P.list, 'plans', P.plan),
    requests: 40, deadlineMs: 300000,
    page: { route: '/whm/accounts', read: '/api/accounts', shows: data => [data?.accounts?.[0]?.username] },
    unit: [
      { id: 'W1TE-UNIT-PURGE', file: 'apps/api/src/account-mutation-security.test.ts', name: 'account mutation outcomes and race boundaries terminates an account only after the target-bound purge contract succeeds' },
      { id: 'W1TE-UNIT-CONFIRM', file: 'apps/api/src/account-bulk-actions.test.ts', name: 'WHM bulk account actions terminates only accounts whose typed username confirmation matches' },
    ],
    checks: ['CONFIRMATION-REQUIRED', 'KEEPDNS-TERMINATES', 'KEEPDNS-ZONE-RESOLVES', 'BACKUPS-REMAIN'],
    async run(x) {
      const { root, check, block, refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const a = await newAccount(x, 'a', plan.id)
      if (!a.ok) return
      refused('CONFIRMATION-REQUIRED', await root.delete(`/api/accounts/${a.username}`, {}), 'VALIDATION')
      const kept = await root.delete(`/api/accounts/${a.username}`, { confirmUsername: a.username, keepdns: 1 })
      if (kept.status === 200) x.undo('kept zone', async () => gone(await root.delete(`/api/dns/zones/${a.primary}`)))
      const after = await root.get(`/api/accounts/${a.username}`), zones = await root.get('/api/dns/zones')
      check('KEEPDNS-TERMINATES', kept.status === 200 && after.status === 404, { delete: kept.status, read: after.status })
      check('KEEPDNS-ZONE-RESOLVES', kept.status === 200 && zones.status === 200 && zones.data?.zones?.some(item => item.name === a.primary) === true, { delete: kept.status, zones: zones.status })
      block('BACKUPS-REMAIN', 'No panel read lists the backups of an account that no longer exists, and the driver may not read host files.')
    },
  }),

  tool('add-package', {
    prefix: 'W1AP', probe: '/api/plans',
    paths: only('plans', P.plan, 'feature-lists', P.list, 'resellers', P.reseller, 'accounts', P.account, 'domains', P.domain),
    requests: 40, deadlineMs: 240000,
    page: { route: '/whm/plans', read: '/api/plans', shows: data => [data?.plans?.[0]?.name] },
    unit: [
      { id: 'W1AP-UNIT-UNLIMITED', file: 'packages/core/src/rules/plans.test.ts', name: 'validatePlan blocks unlimited fields for resellers without allow-unlimited-plans' },
      { id: 'W1AP-UNIT-CREATE', file: 'apps/api/src/api.test.ts', name: '@xpanel/api HTTP integration with explicit fake host execution 2. Feature list + Plan creation + Account creation (alice and bob) with host reconciliation and search index' },
    ],
    checks: ['UNLIMITED-FORBIDDEN', 'ADDON-LIMIT-ZERO', 'NAME-RESERVED'],
    async run(x) {
      const { root, tag, refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const reseller = await newReseller(x, 'r')
      if (reseller.ok) refused('UNLIMITED-FORBIDDEN', (await newPlan(x, 'u', list.id, { client: reseller.client, disk: 'unlimited' })).response, 'FORBIDDEN')
      refused('NAME-RESERVED', (await newPlan(x, 'e', list.id, { name: 'extensions' })).response, 'VALIDATION')
      const gold = await newPlan(x, 'gold', list.id, { caps: { addonDomains: 0 } })
      if (!gold.id) return
      const a = await newAccount(x, 'a', gold.id)
      if (!a.ok) return
      const added = await root.post('/api/domains', { accountId: a.id, name: `xq${tag}ad.example.net`, kind: 'addon' })
      const addedId = added.data?.domain?.id
      if ([200, 201].includes(added.status) && typeof addedId === 'string') x.undo('addon domain', async () => gone(await root.delete(`/api/domains/${addedId}`)))
      refused('ADDON-LIMIT-ZERO', added, 'LIMIT_EXCEEDED')
    },
  }),

  tool('edit-package', {
    prefix: 'W1EP', probe: '/api/plans',
    paths: only('plans', P.plan, 'feature-lists', P.list, 'accounts', P.account),
    requests: 40, deadlineMs: 240000,
    page: { route: '/whm/plans', read: '/api/plans', shows: data => [data?.plans?.[0]?.name] },
    unit: [{ id: 'W1EP-UNIT-VALIDATE', file: 'packages/core/src/rules/plans.test.ts', name: 'validatePlan rejects unknown top-level fields' }],
    checks: ['MAXPOP-RAISED', 'NAME-IMMUTABLE', 'DEDICATED-IP-IMMUTABLE'],
    async run(x) {
      const { root, check, refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const gold = await newPlan(x, 'gold', list.id, { caps: { mailboxes: 10 } }), spare = await newPlan(x, 'spare', list.id)
      if (!gold.id || !spare.id) return
      const a = await newAccount(x, 'a', gold.id)
      if (!a.ok) return
      const raised = await root.patch(`/api/plans/${gold.id}`, { caps: { mailboxes: 20 } })
      const plans = await root.get('/api/plans'), account = await root.get(`/api/accounts/${a.username}`)
      check('MAXPOP-RAISED', raised.status === 200 && planOf(plans, gold.id)?.caps?.mailboxes === 20 && account.data?.account?.planId === gold.id, { status: raised.status, read: plans.status })
      refused('NAME-IMMUTABLE', await root.patch(`/api/plans/${gold.id}`, { name: `${gold.name}-renamed` }), 'VALIDATION')
      refused('DEDICATED-IP-IMMUTABLE', await root.patch(`/api/plans/${spare.id}`, { dedicatedIp: true }), 'VALIDATION')
    },
  }),

  tool('delete-package', {
    prefix: 'W1DP', probe: '/api/plans',
    paths: only('plans', P.plan, 'feature-lists', P.list, 'accounts', P.account),
    requests: 40, deadlineMs: 240000,
    page: { route: '/whm/plans', read: '/api/plans', shows: data => [data?.plans?.[0]?.name] },
    unit: [{ id: 'W1DP-UNIT-PLANS', file: 'packages/state/src/store.test.ts', name: 'accounts, plans, resellers and UID allocator invariants enforces reseller capacity, overselling rules, and plan ownership' }],
    checks: ['IN-USE-REFUSED', 'IN-USE-COUNT', 'UNUSED-REMOVED'],
    async run(x) {
      const { root, check, refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const used = await newPlan(x, 'used', list.id), free = await newPlan(x, 'free', list.id)
      if (!used.id || !free.id) return
      const a = await newAccount(x, 'a', used.id)
      if (!a.ok) return
      const refusal = await root.delete(`/api/plans/${used.id}`)
      refused('IN-USE-REFUSED', refusal, 'CONFLICT')
      const count = refusal.data?.details?.count ?? refusal.data?.count
      check('IN-USE-COUNT', refusal.status >= 400 && count === 1, { status: refusal.status, count: Number.isInteger(count) ? count : null })
      const removed = await root.delete(`/api/plans/${free.id}`), plans = await root.get('/api/plans')
      check('UNUSED-REMOVED', removed.status === 200 && plans.status === 200 && Array.isArray(plans.data?.plans) && planOf(plans, free.id) === undefined, { delete: removed.status, read: plans.status })
    },
  }),

  tool('feature-manager', {
    prefix: 'W1FM', needs: ['account'], probe: '/api/feature-lists',
    paths: only('feature-lists', P.list, 'plans', P.plan, 'accounts', P.account, `${P.account}/files`),
    requests: 40, deadlineMs: 240000,
    page: { route: '/whm/plans/features', read: '/api/feature-lists', shows: data => [data?.featureLists?.[0]?.name] },
    unit: [
      { id: 'W1FM-UNIT-POLICY', file: 'apps/api/src/authorization-security.test.ts', name: 'HTTP authorization security regressions owned resources remain protected by reseller ACL and account feature policy' },
      { id: 'W1FM-UNIT-PLAN', file: 'apps/api/src/api.test.ts', name: '@xpanel/api HTTP integration with explicit fake host execution 2. Feature list + Plan creation + Account creation (alice and bob) with host reconciliation and search index' },
    ],
    checks: ['FEATURE-HIDDEN-FOR-ACCOUNT', 'LIST-DELETE-REASSIGNS-DEFAULT'],
    async run(x) {
      const { root, check, signIn } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const a = await newAccount(x, 'a', plan.id)
      if (!a.ok) return
      const owner = await signIn('owner', { username: a.username, password: a.password })
      if (owner.client) {
        const files = () => owner.client.post(`/api/accounts/${a.username}/files`, { op: 'list', path: '/' })
        const before = await files(), disabled = await root.patch(`/api/feature-lists/${list.id}`, { disabled: ['file-manager'] }), after = await files()
        check('FEATURE-HIDDEN-FOR-ACCOUNT', before.status < 500 && before.status !== 403 && disabled.status === 200 && after.status === 403 && after.data?.code === 'FORBIDDEN', { before: before.status, patch: disabled.status, after: after.status })
      }
      const pro = await newList(x, 'pro'), spare = pro.id ? await newPlan(x, 'spare', pro.id) : { id: null }
      if (!pro.id || !spare.id) return
      const removed = await root.delete(`/api/feature-lists/${pro.id}`), plans = await root.get('/api/plans'), lists = await root.get('/api/feature-lists')
      const moved = planOf(plans, spare.id), target = Array.isArray(lists.data?.featureLists) ? lists.data.featureLists.find(item => item.id === moved?.featureListId) : undefined
      check('LIST-DELETE-REASSIGNS-DEFAULT', removed.status === 200 && moved !== undefined && moved.featureListId !== pro.id && String(target?.name).toLowerCase() === 'default', { delete: removed.status, plans: plans.status, lists: lists.status })
    },
  }),

  tool('feature-list-crud', {
    prefix: 'W1FL', probe: '/api/feature-lists',
    paths: only('feature-lists', P.list, 'plans', P.plan, 'resellers', P.reseller),
    requests: 50, deadlineMs: 240000,
    page: { route: '/whm/plans/features', read: '/api/feature-lists', shows: data => [data?.featureLists?.[0]?.name] },
    unit: [
      { id: 'W1FL-UNIT-ACL', file: 'apps/api/src/approved-workspace-projection.test.ts', name: 'approved workspace hydration projection allows feature-list management without list-accounts while withholding domains and server settings' },
      { id: 'W1FL-UNIT-OWNED', file: 'apps/api/src/authorization-security.test.ts', name: 'HTTP authorization security regressions owned resources remain protected by reseller ACL and account feature policy' },
    ],
    checks: ['CREATE', 'READ-BACK', 'UPDATE', 'DELETE-UNUSED', 'NO-ACL-REFUSED', 'OTHER-OWNER-REFUSED', 'IN-USE-CONFLICT'],
    async run(x) {
      const { root, tag, check, refused } = x
      const rootList = await newList(x, 'root')
      const r1 = await newReseller(x, 'r'), r2 = await newReseller(x, 's', { acl: ['list-accounts'] })
      if (!rootList.id || !r1.ok || !r2.ok) return
      const own = await newList(x, 'own', ['file-manager'], r1.client)
      check('CREATE', own.id !== null, { status: own.response.status })
      if (!own.id) return
      const read = await r1.client.get('/api/feature-lists'), found = Array.isArray(read.data?.featureLists) ? read.data.featureLists.find(item => item.id === own.id) : undefined
      check('READ-BACK', read.status === 200 && found?.disabled?.length === 1 && found.disabled[0] === 'file-manager', { status: read.status })
      const patched = await r1.client.patch(`/api/feature-lists/${own.id}`, { disabled: ['file-manager', 'domain-php-settings'] }), again = await r1.client.get('/api/feature-lists')
      const updated = Array.isArray(again.data?.featureLists) ? again.data.featureLists.find(item => item.id === own.id) : undefined
      check('UPDATE', patched.status === 200 && updated?.disabled?.length === 2 && updated.disabled.includes('domain-php-settings'), { patch: patched.status, read: again.status })
      const denied = await r2.client.post('/api/feature-lists', { name: `xq-${tag}-deny`, disabled: [] })
      const deniedId = denied.data?.featureList?.id
      if (denied.status === 201 && typeof deniedId === 'string') x.undo('feature list deny', async () => gone(await root.delete(`/api/feature-lists/${deniedId}`)))
      refused('NO-ACL-REFUSED', denied, 403)
      refused('OTHER-OWNER-REFUSED', await r1.client.patch(`/api/feature-lists/${rootList.id}`, { disabled: ['file-manager'] }), 403)
      const plan = await newPlan(x, 'p', own.id, { client: r1.client })
      if (plan.id) {
        const inUse = await r1.client.delete(`/api/feature-lists/${own.id}`), kept = planOf(await root.get('/api/plans'), plan.id)
        check('IN-USE-CONFLICT', inUse.status >= 400 && inUse.data?.code === 'CONFLICT' && kept?.featureListId === own.id, { status: inUse.status, code: safeResponse(inUse).code })
      }
      const free = await newList(x, 'free', [], r1.client)
      if (!free.id) return
      const removed = await r1.client.delete(`/api/feature-lists/${free.id}`), final = await r1.client.get('/api/feature-lists')
      check('DELETE-UNUSED', removed.status === 200 && final.status === 200 && Array.isArray(final.data?.featureLists) && !final.data.featureLists.some(item => item.id === free.id), { delete: removed.status, read: final.status })
    },
  }),

  tool('reseller-center', {
    prefix: 'W1RC', probe: '/api/resellers',
    paths: only('resellers', P.reseller, 'accounts', P.account, 'feature-lists', P.list, 'plans', P.plan),
    requests: 40, deadlineMs: 240000,
    page: { route: '/whm/resellers', read: '/api/resellers', shows: data => [data?.resellers?.[0]?.username] },
    unit: [
      { id: 'W1RC-UNIT-CREATE', file: 'apps/api/src/completion-reseller-security.test.ts', name: 'real HTTP reseller administration security creates a reseller as root with exact StateStore readback and a principal-bound audit entry' },
      { id: 'W1RC-UNIT-EDIT', file: 'apps/api/src/completion-reseller-security.test.ts', name: 'real HTTP reseller administration security applies a root edit with exact PATCH readback and a bound reseller.updated audit entry' },
    ],
    checks: ['GRANT-WITH-MAKEOWNER', 'OWNER-IS-SELF', 'INITIAL-PRIVILEGES', 'REVOKED-ADMIN-LOGIN-FORBIDDEN', 'USER-LOGIN-STILL-WORKS'],
    async run(x) {
      const { root, check, block, signIn } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const a = await newAccount(x, 'a', plan.id)
      if (!a.ok) return
      const grant = await root.post('/api/resellers', { username: a.username, password: a.password, makeowner: 1, acl: ACL, maxAccounts: 'unlimited', totalDiskMb: 'unlimited', totalBandwidthMb: 'unlimited', oversell: { disk: true, bandwidth: true }, nameservers: ['ns1.example.net', 'ns2.example.net'], delegatedIps: [] })
      const resellerId = grant.data?.reseller?.id, granted = grant.status === 201 && typeof resellerId === 'string'
      if (granted) x.undo('granted reseller', async () => { await root.patch(`/api/accounts/${a.username}`, { ownerId: null }); return gone(await root.delete(`/api/resellers/${resellerId}`)) })
      check('GRANT-WITH-MAKEOWNER', granted, { status: grant.status, code: safeResponse(grant).code })
      const read = await root.get(`/api/accounts/${a.username}`)
      check('OWNER-IS-SELF', granted && read.data?.account?.ownerId === resellerId, { status: read.status })
      block('INITIAL-PRIVILEGES', 'The criterion does not name the initial privilege set and the API offers no default set to compare with, so no client observation can decide it.')
      const revoked = granted ? await root.delete(`/api/resellers/${resellerId}`) : null
      const admin = await signIn('reseller', { username: a.username, password: a.password }), user = await signIn('owner', { username: a.username, password: a.password })
      check('REVOKED-ADMIN-LOGIN-FORBIDDEN', revoked?.status === 200 && admin.client === null && admin.response.data?.code === 'FORBIDDEN', { revoke: revoked?.status ?? null, admin: safeResponse(admin.response) })
      check('USER-LOGIN-STILL-WORKS', revoked?.status === 200 && user.client !== null, { revoke: revoked?.status ?? null, user: user.client !== null })
    },
  }),

  tool('reseller-privileges', {
    prefix: 'W1RP', needs: ['account'], probe: '/api/resellers',
    paths: only('resellers', P.reseller, 'accounts', P.account, 'feature-lists', P.list, 'plans', P.plan),
    requests: 40, deadlineMs: 240000,
    page: { route: '/whm/resellers/privileges', read: '/api/resellers', shows: data => [data?.resellers?.[0]?.username] },
    unit: [{ id: 'W1RP-UNIT-ACL', file: 'apps/api/src/completion-reseller-security.test.ts', name: 'real HTTP reseller-owned account scope re-applies root ACL changes so a reseller gains and then loses account creation' }],
    checks: ['CREATE-DENIED-FORBIDDEN-ACL', 'LIST-STILL-WORKS', 'ALL-LISTS-FOREIGN-ACCOUNTS'],
    async run(x) {
      const { root, tag, fixture, check, refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const reseller = await newReseller(x, 'r')
      if (!reseller.ok) return
      const stripped = await root.patch(`/api/resellers/${reseller.id}`, { acl: ACL.filter(item => item !== 'create-account') })
      const username = `xq${tag}p`
      const denied = await reseller.client.post('/api/accounts', { username, password: secret(), primaryDomain: `${username}.example.net`, planId: plan.id })
      if ([200, 201].includes(denied.status)) x.undo('denied account', async () => gone(await root.delete(`/api/accounts/${username}`, { confirmUsername: username })))
      refused('CREATE-DENIED-FORBIDDEN-ACL', denied, 'FORBIDDEN')
      const listed = await reseller.client.get('/api/accounts')
      check('LIST-STILL-WORKS', stripped.status === 200 && listed.status === 200, { patch: stripped.status, read: listed.status })
      const widened = await root.patch(`/api/resellers/${reseller.id}`, { acl: [...ACL, 'all'] }), wide = await reseller.client.get('/api/accounts')
      check('ALL-LISTS-FOREIGN-ACCOUNTS', widened.status === 200 && wide.status === 200 && accountIds(wide)?.includes(fixture.accountId) === true, { patch: widened.status, read: wide.status })
    },
  }),

  tool('reseller-account-limits', {
    prefix: 'W1RL', probe: '/api/resellers',
    paths: only('resellers', P.reseller, 'accounts', P.account, 'feature-lists', P.list, 'plans', P.plan),
    requests: 100, deadlineMs: 600000,
    page: { route: '/whm/resellers/more', read: '/api/resellers', shows: data => [data?.resellers?.[0]?.username] },
    unit: [
      { id: 'W1RL-UNIT-CAP', file: 'apps/api/src/completion-reseller-security.test.ts', name: 'real HTTP reseller-owned account scope refuses account creation over the reseller account cap without creating state' },
      { id: 'W1RL-UNIT-OVERSELL', file: 'apps/api/src/completion-reseller-security.test.ts', name: 'real HTTP reseller-owned account scope refuses account creation that would oversell the reseller disk total without creating state' },
    ],
    checks: ['OVERSELL-OFF-LIMIT-EXCEEDED', 'OVERSELL-ON-SUCCEEDS', 'SIXTH-ACCOUNT-REFUSED'],
    async run(x) {
      const { root, check, refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const big = await newPlan(x, 'big', list.id, { disk: 6000 }), mid = await newPlan(x, 'mid', list.id, { disk: 4500 }), small = await newPlan(x, 'small', list.id, { disk: 100 })
      if (!big.id || !mid.id || !small.id) return
      const reseller = await newReseller(x, 'r', { maxAccounts: 5, totalDiskMb: 10000, oversell: { disk: false, bandwidth: true } })
      if (!reseller.ok) return
      const a = await newAccount(x, 'a', big.id, { client: reseller.client })
      if (!a.ok) return
      const b = await newAccount(x, 'b', mid.id, { client: reseller.client })
      refused('OVERSELL-OFF-LIMIT-EXCEEDED', b.response, 'OVERSELL_BLOCKED')
      const turned = await root.patch(`/api/resellers/${reseller.id}`, { oversell: { disk: true, bandwidth: true } })
      const c = await newAccount(x, 'c', mid.id, { client: reseller.client })
      check('OVERSELL-ON-SUCCEEDS', turned.status === 200 && c.ok, { patch: turned.status, create: c.response.status })
      let owned = accountIds(await reseller.client.get('/api/accounts'))?.length ?? 0
      for (const suffix of ['d', 'e', 'f']) {
        if (owned >= 5) break
        if ((await newAccount(x, suffix, small.id, { client: reseller.client })).ok) owned++
      }
      const g = await newAccount(x, 'g', small.id, { client: reseller.client })
      check('SIXTH-ACCOUNT-REFUSED', owned === 5 && g.response.status >= 400 && g.response.data?.code === 'OVERSELL_BLOCKED', { owned, status: g.response.status })
    },
  }),

  tool('reseller-package-limits', {
    prefix: 'W1PL', probe: '/api/resellers',
    paths: only('resellers', P.reseller, 'accounts', P.account, 'feature-lists', P.list, 'plans', P.plan),
    requests: 60, deadlineMs: 600000,
    page: { route: '/whm/resellers/more', read: '/api/resellers', shows: data => [data?.resellers?.[0]?.username] },
    unit: [{ id: 'W1PL-UNIT-ALLOCATION', file: 'apps/api/src/completion-reseller-security.test.ts', name: 'real HTTP reseller-owned account scope refuses plan upgrades beyond the reseller allocation and without the change-plan ACL' }],
    checks: ['FOURTH-BY-CREATE', 'FOURTH-BY-UPGRADE', 'NOT-ALLOWED-FORBIDDEN-PACKAGE'],
    async run(x) {
      const { refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const gold = await newPlan(x, 'gold', list.id), silver = await newPlan(x, 'silver', list.id), other = await newPlan(x, 'other', list.id)
      if (!gold.id || !silver.id || !other.id) return
      const reseller = await newReseller(x, 'r', { packageLimits: [{ planId: gold.id, maxAccounts: 3 }, { planId: silver.id, maxAccounts: 5 }] })
      if (!reseller.ok) return
      const made = []
      for (const [suffix, planId] of [['a', gold.id], ['b', gold.id], ['c', gold.id], ['e', silver.id]]) made.push(await newAccount(x, suffix, planId, { client: reseller.client }))
      if (!made.every(item => item.ok)) return
      refused('FOURTH-BY-CREATE', (await newAccount(x, 'd', gold.id, { client: reseller.client })).response, 'LIMIT_EXCEEDED')
      refused('FOURTH-BY-UPGRADE', await reseller.client.patch(`/api/accounts/${made[3].username}`, { planId: gold.id }), 'LIMIT_EXCEEDED')
      refused('NOT-ALLOWED-FORBIDDEN-PACKAGE', (await newAccount(x, 'f', other.id, { client: reseller.client })).response, 'FORBIDDEN')
    },
  }),

  tool('change-ownership-multiple-accounts', {
    prefix: 'W1CO', probe: '/api/resellers',
    paths: only('resellers', P.reseller, 'accounts', P.account, 'accounts/bulk-actions/owner', 'feature-lists', P.list, 'plans', P.plan),
    requests: 50, deadlineMs: 300000,
    page: { route: '/whm/resellers/more', read: '/api/resellers', shows: data => [data?.resellers?.[0]?.username] },
    unit: [
      { id: 'W1CO-UNIT-BULK', file: 'apps/api/src/account-bulk-actions.test.ts', name: 'WHM bulk account actions runs each account through the single-account authorization: a reseller cannot act on another reseller account' },
      { id: 'W1CO-UNIT-OWNER', file: 'apps/api/src/completion-reseller-security.test.ts', name: 'real HTTP reseller-owned account scope refuses a root-only account owner change by a reseller and records the denial' },
    ],
    checks: ['BOTH-IN-NEW-OWNER-LIST', 'GONE-FROM-PREVIOUS-OWNER', 'ACCOUNT-COUNT-PLUS-TWO'],
    async run(x) {
      const { root, check } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const previous = await newReseller(x, 'p'), next = await newReseller(x, 'q')
      if (!previous.ok || !next.ok) return
      const a = await newAccount(x, 'a', plan.id, { ownerId: previous.id }), b = await newAccount(x, 'b', plan.id, { ownerId: previous.id })
      if (!a.ok || !b.ok) return
      const count = async () => {
        const entry = (await root.get('/api/resellers')).data?.resellers?.find(item => item.id === next.id)
        const value = entry?.accounts ?? entry?.accountCount
        return Number.isInteger(value) ? value : null
      }
      const before = await count()
      const moved = await root.post('/api/accounts/bulk-actions/owner', { operationId: randomUUID(), accounts: [{ id: a.id }, { id: b.id }], ownerId: next.id })
      const applied = moved.status === 200 && moved.data?.summary?.applied === 2
      const now = await next.client.get('/api/accounts'), nowIds = accountIds(now), old = await previous.client.get('/api/accounts'), oldIds = accountIds(old)
      check('BOTH-IN-NEW-OWNER-LIST', applied && nowIds?.includes(a.id) === true && nowIds.includes(b.id), { bulk: moved.status, read: now.status })
      check('GONE-FROM-PREVIOUS-OWNER', applied && oldIds !== null && !oldIds.includes(a.id) && !oldIds.includes(b.id), { bulk: moved.status, read: old.status })
      const after = await count()
      check('ACCOUNT-COUNT-PLUS-TWO', applied && before !== null && after === before + 2, { before, after })
    },
  }),

  tool('show-reseller-accounts', {
    prefix: 'W1SR', needs: ['account'], probe: '/api/resellers',
    paths: only('resellers', P.reseller, 'accounts', P.account, 'feature-lists', P.list, 'plans', P.plan),
    requests: 40, deadlineMs: 240000,
    page: { route: '/whm/resellers/more', read: '/api/resellers', shows: data => [data?.resellers?.[0]?.username] },
    unit: [{ id: 'W1SR-UNIT-SCOPE', file: 'apps/api/src/completion-reseller-security.test.ts', name: 'real HTTP reseller-owned account scope scopes GET /api/accounts to each reseller current ownership' }],
    checks: ['EXACTLY-ONCE-UNDER-OWNER', 'ROOT-OWNED-UNDER-ROOT'],
    async run(x) {
      const { root, fixture, check } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const reseller = await newReseller(x, 'r', {}, false)
      if (!reseller.ok) return
      const a = await newAccount(x, 'a', plan.id, { ownerId: reseller.id })
      if (!a.ok) return
      const all = await root.get('/api/accounts'), rows = Array.isArray(all.data?.accounts) ? all.data.accounts : null
      const mine = rows?.filter(item => item.id === a.id), foreign = rows?.filter(item => item.id === fixture.accountId)
      check('EXACTLY-ONCE-UNDER-OWNER', all.status === 200 && mine?.length === 1 && mine[0].ownerId === reseller.id, { status: all.status, rows: mine?.length ?? null })
      check('ROOT-OWNED-UNDER-ROOT', all.status === 200 && foreign?.length === 1 && foreign[0].ownerId === null, { status: all.status, rows: foreign?.length ?? null })
    },
  }),

  tool('view-reseller-usage-and-account-status', {
    prefix: 'W1RU', probe: '/api/resellers',
    paths: only('resellers', P.reseller, 'accounts', P.account, 'accounts/bulk-actions/suspend', 'accounts/bulk-actions', 'feature-lists', P.list, 'plans', P.plan),
    requests: 60, deadlineMs: 300000,
    page: { route: '/whm/resellers/more', read: '/api/resellers', shows: data => [data?.resellers?.[0]?.username] },
    unit: [
      { id: 'W1RU-UNIT-BULK', file: 'apps/api/src/account-bulk-actions.test.ts', name: 'WHM bulk account actions reports partial failure truthfully and stops after an outcome that needs review' },
      { id: 'W1RU-UNIT-TERMINATE', file: 'apps/api/src/account-bulk-actions.test.ts', name: 'WHM bulk account actions terminates only accounts whose typed username confirmation matches' },
    ],
    checks: ['SUSPEND-ALL-KEEPS-RESELLER-LOGIN', 'TERMINATE-ALL-DELETES-RESELLER'],
    async run(x) {
      const { root, check } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const reseller = await newReseller(x, 'r', {}, false)
      if (!reseller.ok) return
      const a = await newAccount(x, 'a', plan.id, { ownerId: reseller.id }), b = await newAccount(x, 'b', plan.id, { ownerId: reseller.id })
      if (!a.ok || !b.ok) return
      const session = await manualSession(x, { username: reseller.username, password: reseller.password })
      if (!session.client) return
      const suspended = await root.post('/api/accounts/bulk-actions/suspend', { operationId: randomUUID(), accounts: [{ id: a.id }, { id: b.id }], reason: 'xq' })
      const read = await root.get('/api/accounts'), rows = Array.isArray(read.data?.accounts) ? read.data.accounts : []
      const states = [a.id, b.id].map(id => rows.find(item => item.id === id)?.status)
      const mine = await session.client.get('/api/accounts')
      check('SUSPEND-ALL-KEEPS-RESELLER-LOGIN', suspended.status === 200 && suspended.data?.summary?.applied === 2 && states.every(state => state === 'suspended') && mine.status === 200, { bulk: suspended.status, states, reseller: mine.status })
      await session.close()
      const terminated = await root.delete('/api/accounts/bulk-actions', { operationId: randomUUID(), accounts: [{ id: a.id, confirmUsername: a.username }, { id: b.id, confirmUsername: b.username }] })
      const removed = terminated.status === 200 && terminated.data?.summary?.applied === 2 ? await root.delete(`/api/resellers/${reseller.id}`) : null
      const resellers = await root.get('/api/resellers'), left = accountIds(await root.get('/api/accounts'))
      check('TERMINATE-ALL-DELETES-RESELLER', removed?.status === 200 && Array.isArray(resellers.data?.resellers) && !resellers.data.resellers.some(item => item.id === reseller.id) && left !== null && !left.includes(a.id) && !left.includes(b.id), { bulk: terminated.status, reseller: removed?.status ?? null })
    },
  }),

  tool('password-modification', {
    prefix: 'W1PW', probe: '/api/accounts',
    paths: only('accounts', P.account, `${P.account}/password`, 'feature-lists', P.list, 'plans', P.plan),
    requests: 40, deadlineMs: 240000,
    page: { route: '/whm/accounts', read: '/api/accounts', shows: data => [data?.accounts?.[0]?.username] },
    unit: [{ id: 'W1PW-UNIT-LOGINS', file: 'apps/api/src/account-mutation-security.test.ts', name: 'account mutation outcomes and race boundaries changes every login for the account and leaves the neighbor untouched' }],
    checks: ['PANEL-LOGIN-WITH-NEW-PASSWORD', 'MYSQL-LOGIN-WITH-NEW-PASSWORD', 'WEAK-PASSWORD'],
    async run(x) {
      const { root, check, block, refused, signIn } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const a = await newAccount(x, 'a', plan.id)
      if (!a.ok) return
      refused('WEAK-PASSWORD', await root.post(`/api/accounts/${a.username}/password`, { password: 'abc', db_pass_update: 1 }), 'VALIDATION')
      const next = secret(), changed = await root.post(`/api/accounts/${a.username}/password`, { password: next, db_pass_update: 1 })
      const login = changed.status === 200 ? await signIn('owner', { username: a.username, password: next }) : { client: null }
      check('PANEL-LOGIN-WITH-NEW-PASSWORD', changed.status === 200 && login.client !== null, { change: changed.status, login: login.client !== null })
      block('MYSQL-LOGIN-WITH-NEW-PASSWORD', 'No panel API opens a database session with an account password, and the driver may not run a MySQL client.')
    },
  }),

  tool('list-suspended-accounts', {
    prefix: 'W1LS', probe: '/api/accounts',
    paths: only('accounts', P.account, `${P.account}/(?:suspend|unsuspend)`, 'resellers', P.reseller, 'feature-lists', P.list, 'plans', P.plan),
    requests: 40, deadlineMs: 300000,
    unit: [{ id: 'W1LS-UNIT-SUSPEND', file: 'apps/api/src/account-mutation-security.test.ts', name: 'account mutation outcomes and race boundaries revokes all linked aliases and tokens during suspension without changing disabled flags or neighbor access' }],
    checks: ['LOCKED-LISTED', 'RESELLER-UNSUSPEND-FORBIDDEN', 'ROOT-UNSUSPEND-SUCCEEDS'],
    async run(x) {
      const { root, check, refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const reseller = await newReseller(x, 'r')
      if (!reseller.ok) return
      const a = await newAccount(x, 'a', plan.id, { ownerId: reseller.id })
      if (!a.ok) return
      const suspend = await root.post(`/api/accounts/${a.username}/suspend`, { reason: 'xq', lock: true })
      const listed = await root.get('/api/accounts'), row = Array.isArray(listed.data?.accounts) ? listed.data.accounts.find(item => item.id === a.id) : undefined
      check('LOCKED-LISTED', suspend.status === 200 && row?.status === 'suspended' && row.suspendLocked === true, { suspend: suspend.status, listed: listed.status })
      refused('RESELLER-UNSUSPEND-FORBIDDEN', await reseller.client.post(`/api/accounts/${a.username}/unsuspend`, {}), 'FORBIDDEN')
      const resume = await root.post(`/api/accounts/${a.username}/unsuspend`, {})
      check('ROOT-UNSUSPEND-SUCCEEDS', suspend.status === 200 && resume.status === 200, { suspend: suspend.status, unsuspend: resume.status })
    },
  }),

  tool('list-subdomains', {
    prefix: 'W1SD', needs: ['account'], probe: '/api/domains',
    paths: only('resellers', P.reseller, 'accounts', P.account, 'domains', P.domain, `domains\\?accountId=${ID}`, 'search\\?q=shop&kind=domain', 'feature-lists', P.list, 'plans', P.plan),
    requests: 60, deadlineMs: 300000,
    page: { route: '/whm/domains', read: '/api/domains', shows: data => [data?.domains?.[0]?.name] },
    unit: [{ id: 'W1SD-UNIT-SUBDOMAINS', file: 'apps/api/src/completion-domain-workspace-security.test.ts', name: 'conditional domain workspace API with isolated real SQLite and desired state creates owned subdomains and aliases with coupled parent settings' }],
    checks: ['SEARCH-NAME-MATCH', 'SEARCH-EXCLUDES-NON-MATCH', 'RESELLER-OWN-ONLY'],
    async run(x) {
      const { root, fixture, check } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const reseller = await newReseller(x, 'r')
      if (!reseller.ok) return
      const a = await newAccount(x, 'a', plan.id, { ownerId: reseller.id })
      if (!a.ok || !a.domainId) return
      const owned = await root.get(`/api/domains?accountId=${fixture.accountId}`), primary = Array.isArray(owned.data?.domains) ? owned.data.domains.find(item => item.kind === 'primary') : undefined
      if (!primary) return
      const make = async (name, accountId, parentId) => {
        const response = await root.post('/api/domains', { accountId, name, kind: 'subdomain', parentId }), id = response.data?.domain?.id
        if ([200, 201].includes(response.status) && typeof id === 'string') x.undo(`subdomain ${name}`, async () => gone(await root.delete(`/api/domains/${id}`)))
        return response.status === 201 && typeof id === 'string' ? id : null
      }
      const shop = await make(`shop.${a.primary}`, a.id, a.domainId), blog = await make(`blog.${a.primary}`, a.id, a.domainId), foreign = await make(`shop.${fixture.domain}`, fixture.accountId, primary.id)
      if (!shop || !blog || !foreign) return
      const idsOf = response => Array.isArray(response.data?.hits) ? response.data.hits.map(hit => hit.entityId) : null
      const asRoot = await root.get('/api/search?q=shop&kind=domain'), rootIds = idsOf(asRoot)
      const asReseller = await reseller.client.get('/api/search?q=shop&kind=domain'), resellerIds = idsOf(asReseller)
      check('SEARCH-NAME-MATCH', asRoot.status === 200 && rootIds !== null && rootIds.includes(shop) && rootIds.includes(foreign), { status: asRoot.status, hits: rootIds?.length ?? null })
      check('SEARCH-EXCLUDES-NON-MATCH', asRoot.status === 200 && rootIds !== null && rootIds.includes(shop) && !rootIds.includes(blog), { status: asRoot.status })
      check('RESELLER-OWN-ONLY', asReseller.status === 200 && resellerIds !== null && resellerIds.includes(shop) && !resellerIds.includes(foreign) && !resellerIds.includes(blog), { status: asReseller.status, hits: resellerIds?.length ?? null })
    },
  }),

  tool('list-parked-domains', {
    prefix: 'W1PD', probe: '/api/domains',
    paths: only('accounts', P.account, 'domains', P.domain, `domains\\?accountId=${ID}`, 'dns/zones', 'feature-lists', P.list, 'plans', P.plan),
    requests: 40, deadlineMs: 300000,
    page: { route: '/whm/domains', read: '/api/domains', shows: data => [data?.domains?.[0]?.name] },
    unit: [{ id: 'W1PD-UNIT-ALIASES', file: 'apps/api/src/completion-domain-workspace-security.test.ts', name: 'conditional domain workspace API with isolated real SQLite and desired state creates owned subdomains and aliases with coupled parent settings' }],
    checks: ['UNPARK-REMOVES-FROM-LIST', 'UNPARK-DELETES-ZONE', 'BLOCKED-DOMAIN-REJECTED'],
    async run(x) {
      const { root, tag, check, refused } = x
      const list = await newList(x, 'f')
      if (!list.id) return
      const plan = await newPlan(x, 'p', list.id)
      if (!plan.id) return
      const a = await newAccount(x, 'a', plan.id)
      if (!a.ok || !a.domainId) return
      const park = async name => {
        const response = await root.post('/api/domains', { accountId: a.id, name, kind: 'alias', parentId: a.domainId }), id = response.data?.domain?.id
        if ([200, 201].includes(response.status) && typeof id === 'string') x.undo(`alias ${name}`, async () => gone(await root.delete(`/api/domains/${id}`)))
        return { response, id: typeof id === 'string' ? id : null }
      }
      const alias = `xq${tag}al.example.net`, parked = await park(alias)
      if (parked.id) {
        const zones = await root.get('/api/dns/zones'), hadZone = zones.data?.zones?.some(item => item.name === alias) === true
        const unparked = await root.delete(`/api/domains/${parked.id}`)
        const domains = await root.get(`/api/domains?accountId=${a.id}`), after = await root.get('/api/dns/zones')
        check('UNPARK-REMOVES-FROM-LIST', parked.response.status === 201 && unparked.status === 200 && Array.isArray(domains.data?.domains) && !domains.data.domains.some(item => item.name === alias), { park: parked.response.status, unpark: unparked.status })
        check('UNPARK-DELETES-ZONE', hadZone && unparked.status === 200 && Array.isArray(after.data?.zones) && !after.data.zones.some(item => item.name === alias), { hadZone, unpark: unparked.status })
      }
      refused('BLOCKED-DOMAIN-REJECTED', (await park('gmail.com')).response, 'FORBIDDEN')
    },
  }),
]
