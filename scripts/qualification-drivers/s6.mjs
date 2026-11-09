import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { blocked, check, safeResponse, signInThroughForm, tool } from './kit.mjs'

const AUDIT_FIELDS = ['id', 'at', 'actor', 'action', 'target', 'outcome']
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const ids = rows => rows?.map(row => row.id) ?? null

/** Newest-first audit rows reduced to their public fields, or null when the response is not a valid page. */
export function auditRows(response) {
  if (response?.status !== 200 || !Array.isArray(response.data?.entries) || response.data.entries.length > 1000) return null
  const rows = response.data.entries.map(entry => Object.fromEntries(AUDIT_FIELDS.map(field => [field, entry?.[field]])))
  const valid = rows.every(row => /^[1-9][0-9]{0,14}$/.test(row.id) && AUDIT_FIELDS.slice(1).every(field => typeof row[field] === 'string'))
  return valid && rows.every((row, index) => index === 0 || Number(rows[index - 1].id) > Number(row.id)) ? rows : null
}

const after = id => String(Number(id) + 1)

/**
 * The audit-log criterion through one authenticated reader: rows are listed, an action filter keeps only that action,
 * and the older page is the next keyset page. `stored` is the independent store oracle (host slot only).
 */
export async function auditLogChecks(read, prefix, stored) {
  const checks = []
  const listed = auditRows(await read({ limit: '4' }))
  checks.push(check(`${prefix}-ROWS`, listed !== null && listed.length > 0, { rows: listed?.length ?? null, ids: ids(listed) }))
  if (stored) {
    const oracle = listed?.length ? stored({ maxId: listed[0].id, limit: listed.length }) : null
    checks.push(check(`${prefix}-STORED-ROWS`, listed !== null && listed.length > 0 && same(listed, oracle), { api: ids(listed), store: ids(oracle), comparison: 'id, at, actor, action, target and outcome of each row' }))
  }
  if (!listed?.length) {
    checks.push(blocked(`${prefix}-ACTION-FILTER`, 'No listed audit row supplies an action.'), blocked(`${prefix}-OLDER-PAGE`, 'No listed audit rows.'))
    return checks
  }
  const action = listed[0].action
  const filtered = auditRows(await read({ action, limit: '4' }))
  const filterOracle = stored && filtered?.length ? stored({ maxId: filtered[0].id, action, limit: filtered.length }) : undefined
  checks.push(check(`${prefix}-ACTION-FILTER`, filtered !== null && filtered.length > 0 && filtered.every(row => row.action === action) && (filterOracle === undefined || same(filtered, filterOracle)),
    { action, ids: ids(filtered), otherActions: filtered?.filter(row => row.action !== action).length ?? null, ...(stored ? { store: ids(filterOracle ?? null) } : {}) }))
  const first = auditRows(await read({ limit: '2', before: after(listed[0].id) }))
  const older = first?.length === 2 ? auditRows(await read({ limit: '2', before: first[1].id })) : null
  const span = first?.length === 2 ? auditRows(await read({ limit: '4', before: after(listed[0].id) })) : null
  if (first !== null && (first.length < 2 || older?.length === 0)) checks.push(blocked(`${prefix}-OLDER-PAGE`, 'Fewer than three audit rows exist; an older page cannot be observed.'))
  else checks.push(check(`${prefix}-OLDER-PAGE`, older !== null && older.length > 0 && older.every(row => Number(row.id) < Number(first[1].id)) && same(ids([...first, ...older]), ids(span?.slice(0, 2 + older.length) ?? null)),
    { firstPage: ids(first), olderPage: ids(older), continuous: ids(span) }))
  return checks
}

/** Independent read of the stored audit rows with the pinned runtime's own SQLite, read-only. */
export function auditStore(path) {
  return ({ maxId, action, limit }) => {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const rows = action === undefined
        ? db.prepare('SELECT id, at, actor, action, target, outcome FROM audit_log WHERE id <= ? ORDER BY id DESC LIMIT ?').all(Number(maxId), limit)
        : db.prepare('SELECT id, at, actor, action, target, outcome FROM audit_log WHERE id <= ? AND action = ? ORDER BY id DESC LIMIT ?').all(Number(maxId), action, limit)
      return rows.map(row => ({ ...Object.fromEntries(AUDIT_FIELDS.map(field => [field, row[field]])), id: String(row.id) }))
    } finally { db.close() }
  }
}

/** Real Chromium against the installed origin, signed in through the login form; the API reads use the same browser session. */
export async function auditLogBrowserChecks({ page, origin, credentials }) {
  const checks = [], api = async params => {
    const response = await page.request.get(`${origin}/api/audit?${new URLSearchParams(params)}`, { failOnStatusCode: false, maxRedirects: 0 })
    return { status: response.status(), data: await response.json().catch(() => null) }
  }
  const shown = () => page.locator('tr[data-audit-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-audit-id')))
  const matches = async displayed => displayed.length > 0 && same(displayed, ids(auditRows(await api({ limit: String(displayed.length), before: after(displayed[0]) }))))
  const login = await signInThroughForm(page, origin, credentials)
  checks.push(check('AL-BROWSER-SIGN-IN', login.status() === 200, { status: login.status() }))
  await page.goto(`${origin}/whm/audit?lang=en`)
  const listed = await shown()
  checks.push(check('AL-BROWSER-ROWS', await matches(listed), { displayed: listed.length, ids: listed }))
  const action = auditRows(await api({ limit: '1', before: after(listed[0] ?? '0') }))?.[0]?.action
  if (action === undefined) checks.push(blocked('AL-BROWSER-ACTION-FILTER', 'No displayed audit row supplies an action.'))
  else {
    await page.goto(`${origin}/whm/audit?${new URLSearchParams({ lang: 'en', action })}`)
    const filtered = await shown()
    const rows = filtered.length ? auditRows(await api({ action, limit: String(filtered.length), before: after(filtered[0]) })) : null
    checks.push(check('AL-BROWSER-ACTION-FILTER', rows !== null && filtered.length > 0 && same(filtered, ids(rows)) && rows.every(row => row.action === action), { action, ids: filtered }))
  }
  await page.goto(`${origin}/whm/audit?lang=en`)
  const pager = page.locator('[data-audit-pager] a[href*="before="]')
  const oldest = listed.at(-1)
  const beyond = oldest === undefined ? null : auditRows(await api({ limit: '1', before: oldest }))
  if (await pager.count() === 0 && beyond?.length === 0) checks.push(blocked('AL-BROWSER-OLDER-PAGE', 'Every audit row fits on the first page; an older page cannot be observed.'))
  else {
    const before = await pager.count() === 1 ? new URL(await pager.getAttribute('href'), origin).searchParams.get('before') : null
    if (before !== null) await Promise.all([page.waitForURL(url => url.searchParams.get('before') === before), pager.click()])
    const older = before === null ? [] : await shown()
    checks.push(check('AL-BROWSER-OLDER-PAGE', before === oldest && older.every(id => Number(id) < Number(oldest)) && await matches(older), { before, ids: older }))
  }
  const [logout] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout' && response.request().method() === 'POST'),
    page.evaluate(() => document.querySelector('[data-action="logout"]')?.click()),
  ])
  const revoked = await api({ limit: '1' })
  const signedOut = logout.status() === 200 && revoked.status === 401
  checks.push(check('AL-BROWSER-SIGNED-OUT', signedOut, { logoutStatus: logout.status(), subsequentRead: revoked.status }))
  return { checks, signedOut }
}

const secret = () => `Xq-${randomBytes(18).toString('base64url')}-9a`
const LANGUAGES = '/api/server/panel/languages'
const SETTINGS = '/api/server/settings'
const NEWS = '/api/server/announcements'
const bare = settings => { const { defaultSite, ...rest } = settings ?? {}; return rest }
const list = value => Array.isArray(value) ? value : []

/** A run-scoped reseller with a throwaway credential; removed again by its own undo step. */
async function makeReseller(root, tag, undo, acl = ['list-accounts']) {
  const username = `xr${tag}`, password = secret()
  const created = await root.post('/api/resellers', { username, password, acl, maxAccounts: 4, totalDiskMb: 8192, totalBandwidthMb: 51200, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] })
  const id = created.data?.reseller?.id
  if (created.status !== 201 || typeof id !== 'string') return null
  undo('reseller', async () => [200, 404].includes((await root.delete(`/api/resellers/${id}`)).status))
  return { id, username, password }
}

/** Reads server settings and registers the restore, so a later save is always undone and verified. */
async function guardSettings(root, undo) {
  const read = await root.get(SETTINGS)
  const settings = read.data?.settings
  if (read.status !== 200 || !settings || typeof settings !== 'object') return { read, settings: null, body: null }
  const body = bare(settings)
  undo('server settings', async () => {
    const restored = await root.put(SETTINGS, { ...body, markSetupComplete: false })
    const again = await root.get(SETTINGS)
    return restored.status === 200 && same(bare(again.data?.settings), body)
  })
  return { read, settings, body }
}

async function archiveNews(root, id) {
  const rev = (await root.get(NEWS)).data?.revision
  if (typeof rev !== 'string') return false
  const done = await root.post(`${NEWS}/${id}/archive`, { expectedRevision: rev })
  return done.status === 404 || (done.status === 200 && list(done.data?.announcements).find(item => item.id === id)?.phase === 'archived')
}

async function publishNews(root, tag, undo, label, audience) {
  const rev = (await root.get(NEWS)).data?.revision
  const text = { en: `xq-${tag} ${label}`, ar: `xq-${tag} ${label}` }
  const made = await root.post(NEWS, { title: text, body: text, severity: 'info', audience, startsAt: null, endsAt: null, expectedRevision: rev })
  const id = made.status === 200 && typeof made.data?.changed === 'string' ? made.data.changed : null
  if (id !== null) undo(`announcement ${label}`, () => archiveNews(root, id))
  return { id, status: made.status }
}

const BRANDING = '/api/server/panel/branding'
const BRANDING_FIELDS = ['companyName', 'productName', 'footerText', 'hidePoweredBy', 'primaryColor', 'accentColor', 'supportUrl', 'supportEmail', 'defaultTheme', 'defaultDensity']
const BRANDING_DEFAULTS = { companyName: '', productName: '', footerText: '', hidePoweredBy: false, primaryColor: '', accentColor: '', supportUrl: '', supportEmail: '', defaultTheme: 'light', defaultDensity: 'comfortable' }

export default [
  Object.freeze({
    toolId: 'audit-log',
    inventory: Object.freeze({
      unit: Object.freeze([
        { id: 'AL-UNIT-QUERY-CONTRACT', file: 'apps/api/src/audit-filters.test.ts', name: 'audit URL query contract returns bounded exact fields, exclusive cursor, page size and normalized inclusive UTC bounds' },
        { id: 'AL-UNIT-CLEARED-FILTERS', file: 'apps/api/src/audit-filters.test.ts', name: 'audit URL query contract treats cleared form controls as absent and ignores unrelated presentation parameters' },
        { id: 'AL-UNIT-STORE-FILTER-CURSOR', file: 'packages/db/src/repos/audit-query.test.ts', name: 'audit read query filters combines exact filters, inclusive dates, exclusive keyset cursor and limit' },
        { id: 'AL-UNIT-STORE-LITERAL-VALUES', file: 'packages/db/src/repos/audit-query.test.ts', name: 'audit read query filters binds hostile SQL strings as exact values and preserves literal wildcard characters' },
      ]),
      host: Object.freeze(['AL-OS-PROFILE', 'AL-ANONYMOUS-DENIED', 'AL-ROWS', 'AL-STORED-ROWS', 'AL-ACTION-FILTER', 'AL-OLDER-PAGE', 'AL-SESSION-REVOKED']),
      browser: Object.freeze(['AL-BROWSER-SIGN-IN', 'AL-BROWSER-ROWS', 'AL-BROWSER-ACTION-FILTER', 'AL-BROWSER-OLDER-PAGE', 'AL-BROWSER-SIGNED-OUT']),
      external: Object.freeze(['AL-EXTERNAL-DNS', 'AL-EXTERNAL-TLS', 'AL-EXTERNAL-ROWS', 'AL-EXTERNAL-ACTION-FILTER', 'AL-EXTERNAL-OLDER-PAGE', 'AL-EXTERNAL-SESSION-REVOKED']),
    }),
    driver: Object.freeze({
      prefix: 'AL', as: 'root', also: Object.freeze([]), needs: Object.freeze([]), probe: '/api/audit?limit=1', paths: /^\/api\/audit\?[A-Za-z0-9=&._%-]{1,512}$/, requests: 20, deadlineMs: 120_000, gate: 'audit-log', restores: Object.freeze([]), hostOnly: Object.freeze([]), requires_qualification_admission: false,
      page: Object.freeze({ route: '/whm/audit', actor: 'root', read: '/api/audit?limit=1' }),
      host: (read, context) => auditLogChecks(read, 'AL', auditStore(context.db)),
      external: read => auditLogChecks(read, 'AL-EXTERNAL'),
      browser: auditLogBrowserChecks,
    }),
  }),
  tool('locale-list', {
    prefix: 'LL', probe: LANGUAGES, paths: /^\/api\/server\/panel\/languages$/,
    unit: [{ id: 'LL-UNIT-LISTS-REGISTRY', file: 'apps/api/src/panel-languages.test.ts', name: 'panel languages policy lists every registry locale with release defaults and no-store' }],
    checks: ['INCLUDES-AR', 'AR-DIRECTION-RTL'],
    async run({ root, check }) {
      const view = await root.get(LANGUAGES)
      const ar = list(view.data?.locales).find(item => item.tag === 'ar')
      check('INCLUDES-AR', view.status === 200 && ar !== undefined, { status: view.status, locales: list(view.data?.locales).length })
      check('AR-DIRECTION-RTL', view.status === 200 && ar?.dir === 'rtl', { status: view.status, direction: ar?.dir ?? null })
    },
  }),
  tool('locale-xml-export', {
    prefix: 'LXE', probe: LANGUAGES, paths: /^\/api\/server\/panel\/languages(?:\/ar\/catalog)?$/,
    unit: [{ id: 'LXE-UNIT-CATALOG-DOWNLOAD', file: 'apps/api/src/panel-languages.test.ts', name: 'panel language catalogs uploads a valid catalog, reports restart required, downloads it merged and applies it at start' }],
    checks: ['EXPORT-DOWNLOAD', 'REIMPORT-UNCHANGED'],
    async run({ root, check, block }) {
      const first = await root.get(`${LANGUAGES}/ar/catalog`), second = await root.get(`${LANGUAGES}/ar/catalog`)
      const catalog = first.data?.catalog
      check('EXPORT-DOWNLOAD', first.status === 200 && first.data?.locale === 'ar' && typeof catalog === 'string' && catalog.includes('msgid') && second.data?.catalog === catalog, { status: first.status, repeatStatus: second.status, bytes: typeof catalog === 'string' ? catalog.length : null })
      block('REIMPORT-UNCHANGED', 'The qualification transport sends JSON bodies only and the product accepts a catalog only as raw gettext text, so an exported file cannot be uploaded again by an API client.')
    },
  }),
  tool('locale-xml-import', {
    prefix: 'LXI', restores: ['/api/server/panel/languages'], probe: LANGUAGES, paths: /^\/api\/server\/panel\/languages(?:\/ar\/catalog\?expectedRevision=[0-9a-f]{64})?$/,
    unit: [{ id: 'LXI-UNIT-INVALID-CATALOG', file: 'apps/api/src/panel-languages.test.ts', name: 'panel language catalogs refuses invalid catalogs with field errors and changes nothing' }],
    checks: ['MALFORMED-INVALID-FORMAT', 'LOCALE-UNCHANGED'],
    async run({ root, check, refused }) {
      const before = await root.get(LANGUAGES), revision = before.data?.revision
      if (before.status !== 200 || typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)) {
        check('MALFORMED-INVALID-FORMAT', false, { status: before.status }); check('LOCALE-UNCHANGED', false, { status: before.status })
        return
      }
      refused('MALFORMED-INVALID-FORMAT', await root.put(`${LANGUAGES}/ar/catalog?expectedRevision=${revision}`, '<?xml version="1.0"?><locale><string id="x">'), 'VALIDATION')
      const after = await root.get(LANGUAGES)
      const ar = view => list(view.data?.locales).find(item => item.tag === 'ar')
      check('LOCALE-UNCHANGED', after.status === 200 && after.data?.revision === revision && ar(before) !== undefined && same(ar(before), ar(after)), { status: after.status, sameRevision: after.data?.revision === revision })
    },
  }),
  tool('locale-delete', {
    prefix: 'LD', restores: ['/api/server/panel/languages'], probe: LANGUAGES, paths: /^\/api\/server\/panel\/languages(?:\/[a-z]{2}\/catalog)?$/,
    unit: [{ id: 'LD-UNIT-REMOVE-UPLOAD', file: 'apps/api/src/panel-languages.test.ts', name: 'panel language catalogs removes an upload bound to the observed revision' }],
    checks: ['DEFAULT-LOCALE-PROTECTED', 'USERS-FALL-BACK-TO-DEFAULT'],
    async run({ root, check, block, refused }) {
      const view = await root.get(LANGUAGES), fallback = view.data?.defaultLocale
      const entry = list(view.data?.locales).find(item => item.tag === fallback)
      // A default locale that holds an upload would really be deleted, so only an upload-free default is tried.
      if (view.status !== 200 || !/^[a-z]{2}$/.test(fallback ?? '') || entry === undefined || entry.override !== null) {
        check('DEFAULT-LOCALE-PROTECTED', false, { status: view.status, hasUpload: entry?.override != null })
      } else refused('DEFAULT-LOCALE-PROTECTED', await root.delete(`${LANGUAGES}/${fallback}/catalog`, { expectedRevision: view.data.revision }), 'CONFLICT')
      block('USERS-FALL-BACK-TO-DEFAULT', 'Observing the fallback needs a real delete of a locale that users hold, and a deleted catalog cannot be uploaded again through the JSON-only transport.')
    },
  }),
  tool('locale-edit', {
    prefix: 'LE', restores: ['/api/server/panel/languages'], probe: LANGUAGES, paths: /^\/api\/server\/panel\/languages$/,
    unit: [{ id: 'LE-UNIT-CATALOG-UPLOAD', file: 'apps/api/src/panel-languages.test.ts', name: 'panel language catalogs uploads a valid catalog, reports restart required, downloads it merged and applies it at start' }],
    checks: ['OVERRIDE-SHOWN-IN-INTERFACE', 'REVERT-RESTORES-ORIGINAL'],
    async run({ block }) {
      block('OVERRIDE-SHOWN-IN-INTERFACE', 'The product takes an override only as a raw gettext upload and shows it after the next panel start; the JSON-only transport cannot upload it and a run cannot restart the panel.')
      block('REVERT-RESTORES-ORIGINAL', 'There is no override to revert, because none can be uploaded by an API client.')
    },
  }),
  tool('whm-global-search', {
    prefix: 'WGS', needs: ['account'], probe: '/api/search?q=xq', requests: 40,
    paths: /^\/api\/(?:search\?q=[a-z0-9]{1,32}|resellers(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'WGS-UNIT-SEARCH-INDEX', file: 'apps/api/src/api.test.ts', name: '@xpanel/api HTTP integration with explicit fake host execution 2. Feature list + Plan creation + Account creation (alice and bob) with host reconciliation and search index' }],
    checks: ['RESELLER-UNOWNED-NO-RESULT', 'ROOT-EXACT-USERNAME-FIRST'],
    async run({ root, fixture, tag, check, undo, until, signIn }) {
      const query = `/api/search?q=${fixture.username}`
      const found = await until(() => root.get(query), response => list(response.data?.hits).length > 0, { attempts: 5, delayMs: 1000 })
      const first = list(found.last.data?.hits)[0]
      check('ROOT-EXACT-USERNAME-FIRST', found.last.status === 200 && first?.kind === 'account' && first?.entityId === fixture.accountId, { status: found.last.status, kind: first?.kind ?? null, firstIsFixture: first?.entityId === fixture.accountId })
      const reseller = await makeReseller(root, tag, undo)
      const { client } = reseller ? await signIn('reseller', { username: reseller.username, password: reseller.password }) : { client: null }
      const hits = client ? await client.get(query) : null
      check('RESELLER-UNOWNED-NO-RESULT', hits !== null && hits.status === 200 && Array.isArray(hits.data?.hits) && hits.data.hits.length === 0, { signedIn: client !== null, status: hits?.status ?? null, hits: hits?.data?.hits?.length ?? null })
    },
  }),
  tool('server-settings-edit', {
    prefix: 'SSE', restores: ['/api/server/settings'], needs: ['account'], also: ['owner'], probe: SETTINGS, paths: /^\/api\/(?:server\/settings|resellers(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'SSE-UNIT-SETTINGS-SAVE', file: 'apps/api/src/api.test.ts', name: '@xpanel/api HTTP integration with explicit fake host execution 2. Feature list + Plan creation + Account creation (alice and bob) with host reconciliation and search index' }],
    checks: ['ROOT-READS-SETTINGS', 'EDITED-VALUE-SAVED', 'OTHER-SETTINGS-PRESERVED', 'READS-BACK-EDITED-VALUE', 'RESELLER-REFUSED', 'ACCOUNT-REFUSED'],
    async run({ root, owner, tag, check, undo, refused, signIn }) {
      const { read, settings, body } = await guardSettings(root, undo)
      if (!check('ROOT-READS-SETTINGS', settings !== null && typeof settings.adminEmail === 'string', { status: read.status })) return
      const edited = `xq-${tag}@example.net`
      const saved = await root.put(SETTINGS, { ...body, adminEmail: edited, markSetupComplete: false })
      check('EDITED-VALUE-SAVED', saved.status === 200 && saved.data?.settings?.adminEmail === edited, { status: saved.status })
      const again = await root.get(SETTINGS)
      check('READS-BACK-EDITED-VALUE', again.status === 200 && again.data?.settings?.adminEmail === edited, { status: again.status })
      check('OTHER-SETTINGS-PRESERVED', again.status === 200 && same(bare(again.data?.settings), { ...body, adminEmail: edited }), { status: again.status })
      const reseller = await makeReseller(root, tag, undo)
      const { client } = reseller ? await signIn('reseller', { username: reseller.username, password: reseller.password }) : { client: null }
      if (client) refused('RESELLER-REFUSED', await client.put(SETTINGS, { ...body, markSetupComplete: false }), 'FORBIDDEN')
      else check('RESELLER-REFUSED', false, { signedIn: false })
      const account = await owner.put(SETTINGS, { ...body, markSetupComplete: false })
      check('ACCOUNT-REFUSED', [403, 404].includes(account.status), { status: account.status })
    },
  }),
  tool('basic-server-setup', {
    prefix: 'BSS', restores: ['/api/server/settings'], probe: SETTINGS, paths: /^\/api\/server\/settings$/,
    unit: [{ id: 'BSS-UNIT-SETUP-CONTRACT', file: 'apps/api/src/setup-primary-ip.test.ts', name: 'setup primary IP HTTP contract rejects an omitted IPv4 without a current primary before any configuration write' }],
    checks: ['TTL-MINUS-ONE-VALIDATION', 'SHARED-IPV6-INSIDE-RANGE-VALIDATION', 'NAMESERVERS-NOT-CONFIGURED'],
    async run({ root, check, block, undo, refused }) {
      const { read, body } = await guardSettings(root, undo)
      if (body === null) check('TTL-MINUS-ONE-VALIDATION', false, { status: read.status })
      else refused('TTL-MINUS-ONE-VALIDATION', await root.put(SETTINGS, { ...body, defaultTtl: -1, markSetupComplete: false }), 'VALIDATION')
      block('SHARED-IPV6-INSIDE-RANGE-VALIDATION', 'Saving a shared address inside an existing range means changing the host IP inventory, which a run on a shared host must not do.')
      block('NAMESERVERS-NOT-CONFIGURED', 'It needs the nameservers saved empty and an account created meanwhile, which would leave the host without zone nameservers if the product accepted it.')
    },
  }),
  tool('initial-setup-wizard', {
    prefix: 'ISW', probe: '/api/setup/wizard', paths: /^\/api\/setup\/wizard(?:\/complete)?$/,
    unit: [{ id: 'ISW-UNIT-WIZARD-CONTRACT', file: 'apps/api/src/setup-primary-ip.test.ts', name: 'setup primary IP HTTP contract reuses the current primary IPv4 and leaves omitted IPv6 inventory exactly intact' }],
    checks: ['FRESH-INSTALL-REDIRECTS-TO-WIZARD', 'ALREADY-COMPLETED-AFTER-WIZARD'],
    async run({ root, check, block, refused }) {
      block('FRESH-INSTALL-REDIRECTS-TO-WIZARD', 'This host finished setup at install time, so the redirect of root routes on a fresh install cannot be observed on it.')
      const state = await root.get('/api/setup/wizard')
      if (state.status !== 200 || state.data?.setupComplete !== true) check('ALREADY-COMPLETED-AFTER-WIZARD', false, { status: state.status, setupComplete: state.data?.setupComplete ?? null })
      else refused('ALREADY-COMPLETED-AFTER-WIZARD', await root.post('/api/setup/wizard/complete', {}), 'CONFLICT')
    },
  }),
  tool('root-web-terminal', {
    prefix: 'RWT', probe: '/api/server/terminal', paths: /^\/api\/(?:server\/terminal|resellers(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'RWT-UNIT-ROOT-ONLY', file: 'apps/api/src/ops-terminal-workspace.test.ts', name: 'server terminal API workspace is root-only server policy on the xWHM listener only' }],
    checks: ['RESELLER-FORBIDDEN', 'SESSION-CLOSED-WITHIN-60S-AFTER-LOGOUT'],
    async run({ root, tag, check, block, undo, refused, signIn }) {
      const reseller = await makeReseller(root, tag, undo)
      const { client } = reseller ? await signIn('reseller', { username: reseller.username, password: reseller.password }) : { client: null }
      if (client) refused('RESELLER-FORBIDDEN', await client.get('/api/server/terminal'), 'FORBIDDEN')
      else check('RESELLER-FORBIDDEN', false, { signedIn: false })
      block('SESSION-CLOSED-WITHIN-60S-AFTER-LOGOUT', 'A shell needs the root password for a ticket and a websocket the API transport does not speak, so a session cannot be opened or watched after logout.')
    },
  }),
  tool('support-center', {
    prefix: 'SUC', restores: ['/api/server/panel/branding'], probe: '/api/server/support', paths: /^\/api\/server\/(?:panel\/branding|support)$/,
    unit: [{ id: 'SUC-UNIT-OWNER-CONTACTS', file: 'apps/api/src/support-workspace.test.ts', name: 'API support workspace shows only owner-saved support contacts and never the built-in placeholders' }],
    checks: ['EMPTY-URL-CARD-HIDDEN', 'SHOWN-LINK-IS-CONFIGURED-URL'],
    async run({ root, tag, check, undo }) {
      const first = await root.get(BRANDING), saved = first.data?.branding ?? BRANDING_DEFAULTS
      const fields = Object.fromEntries(BRANDING_FIELDS.map(name => [name, saved[name]]))
      if (first.status !== 200 || first.data?.state === 'invalid' || typeof first.data?.revision !== 'string' || BRANDING_FIELDS.some(name => fields[name] === undefined)) {
        check('EMPTY-URL-CARD-HIDDEN', false, { status: first.status, state: first.data?.state ?? null }); check('SHOWN-LINK-IS-CONFIGURED-URL', false, { status: first.status })
        return
      }
      undo('branding', async () => {
        const current = await root.get(BRANDING)
        const restored = await root.put(BRANDING, { ...fields, expectedRevision: current.data?.revision })
        const again = await root.get(BRANDING)
        return restored.status === 200 && BRANDING_FIELDS.every(name => again.data?.branding?.[name] === fields[name])
      })
      const contactAfter = async patch => {
        const revision = (await root.get(BRANDING)).data?.revision
        const put = await root.put(BRANDING, { ...fields, ...patch, expectedRevision: revision })
        return { put, support: put.status === 200 ? await root.get('/api/server/support') : null }
      }
      const empty = await contactAfter({ supportUrl: '', supportEmail: '' })
      const hidden = empty.support?.data?.contact
      check('EMPTY-URL-CARD-HIDDEN', empty.support?.status === 200 && hidden?.state === 'not-configured' && hidden?.url == null, { saveStatus: empty.put.status, status: empty.support?.status ?? null, state: hidden?.state ?? null })
      const url = `https://xq-${tag}.example.net/help`
      const shown = await contactAfter({ supportUrl: url, supportEmail: '' })
      const contact = shown.support?.data?.contact
      check('SHOWN-LINK-IS-CONFIGURED-URL', shown.support?.status === 200 && contact?.state === 'configured' && contact.url === url, { saveStatus: shown.put.status, status: shown.support?.status ?? null, state: contact?.state ?? null, urlMatches: contact?.url === url })
    },
  }),
  tool('panel-news', {
    prefix: 'PNW', needs: ['account'], also: ['owner'], probe: NEWS, requests: 40,
    paths: /^\/api\/(?:server\/announcements(?:\/[0-9a-f-]{36}\/archive)?|account\/announcements|accounts\/[0-9a-f-]{36}|resellers(?:\/[0-9a-f-]{36})?)$/,
    unit: [
      { id: 'PNW-UNIT-AUDIENCES', file: 'apps/api/src/announcements-workspace.test.ts', name: 'announcement grammar matches audiences and windows exactly' },
      { id: 'PNW-UNIT-OWNER-FEED', file: 'apps/api/src/announcements-workspace.test.ts', name: 'account owner announcements returns only live announcements targeted at the session account, never the audience' },
    ],
    checks: ['RESELLER-NEWS-ONLY-OWNED-ACCOUNTS', 'GLOBAL-NEWS-EVERY-ACCOUNT'],
    async run({ root, owner, fixture, tag, check, undo }) {
      const reseller = await makeReseller(root, tag, undo)
      const everyone = await publishNews(root, tag, undo, 'global', { kind: 'all' })
      const theirs = reseller ? await publishNews(root, tag, undo, 'reseller', { kind: 'reseller', resellerId: reseller.id }) : { id: null, status: null }
      const seen = async () => { const feed = await owner.get('/api/account/announcements'); return { status: feed.status, ids: list(feed.data?.announcements).map(item => item.id) } }
      const before = await seen()
      const accountUrl = `/api/accounts/${fixture.accountId}`
      const previous = (await root.get(accountUrl)).data?.account
      let moved = null
      if (previous !== undefined && reseller) {
        undo('account owner', async () => { await root.patch(accountUrl, { ownerId: previous.ownerId ?? null }); return ((await root.get(accountUrl)).data?.account?.ownerId ?? null) === (previous.ownerId ?? null) })
        moved = await root.patch(accountUrl, { ownerId: reseller.id })
      }
      const after = await seen()
      const live = (state, id) => id !== null && state.ids.includes(id)
      check('RESELLER-NEWS-ONLY-OWNED-ACCOUNTS', live(before, everyone.id) && !live(before, theirs.id) && moved?.status === 200 && live(after, theirs.id), { created: [everyone.status, theirs.status], moveStatus: moved?.status ?? null, otherOwnerSeesIt: live(before, theirs.id), ownerSeesIt: live(after, theirs.id) })
      check('GLOBAL-NEWS-EVERY-ACCOUNT', live(before, everyone.id) && live(after, everyone.id), { feedStatus: [before.status, after.status] })
    },
  }),
  tool('traffic-monitor', {
    prefix: 'TRM', needs: ['account'], probe: '/api/server/monitoring/traffic', paths: /^\/api\/server\/monitoring\/traffic$/, requests: 40, deadlineMs: 240_000,
    unit: [{ id: 'TRM-UNIT-BOUNDARY', file: 'apps/api/src/traffic-workspace.test.ts', name: 'traffic API boundary strips unrelated host data and preserves unavailable state' }],
    checks: ['REQUESTS-APPEAR-IN-DOMAIN-ROW', 'COUNTS-MATCH-LOG-LINES'],
    async run({ root, fixture, tag, site, check, until }) {
      const rowOf = response => list(response.data?.http?.rows).find(row => row.domain === fixture.domain)
      const start = await root.get('/api/server/monitoring/traffic'), base = rowOf(start)?.requests ?? 0, sent = 5
      for (let index = 0; index < sent; index++) await site.get(fixture.domain, `/xq-${tag}-${index}`)
      const seen = await until(() => root.get('/api/server/monitoring/traffic'), response => (rowOf(response)?.requests ?? 0) - base >= sent, { attempts: 12, delayMs: 5000 })
      const delta = (rowOf(seen.last)?.requests ?? 0) - base
      check('REQUESTS-APPEAR-IN-DOMAIN-ROW', start.status === 200 && seen.last.status === 200 && delta > 0, { status: seen.last.status, delta, polls: seen.attempts })
      check('COUNTS-MATCH-LOG-LINES', start.status === 200 && seen.last.status === 200 && delta === sent, { delta, sent })
    },
  }),
  tool('io-monitor', {
    prefix: 'IOM', probe: '/api/analytics/io', paths: /^\/api\/analytics\/io$/,
    unit: [{ id: 'IOM-UNIT-IO-MONITOR', file: 'apps/api/src/api.test.ts', name: '@xpanel/api HTTP integration with explicit fake host execution 7. Server IO Monitor & Website Analytics ingestion/querying + real-time WebSocket RBAC event filtering' }],
    checks: ['WRITE-RATE-AT-OR-BELOW-CAP', 'THROTTLED-TIME-NONZERO'],
    async run({ block }) {
      block('WRITE-RATE-AT-OR-BELOW-CAP', 'An API client cannot start a write loop inside the account slice, so a rate against a 10 MB/s cap cannot be observed.')
      block('THROTTLED-TIME-NONZERO', 'Throttled time only grows under such a loop, which an API client cannot run.')
    },
  }),
  tool('trusted-proxies', {
    prefix: 'TPX', probe: '/api/server/trusted-proxies', paths: /^\/api\/server\/trusted-proxies$/,
    unit: [{ id: 'TPX-UNIT-SAVED-ONLY', file: 'apps/api/src/trusted-proxies-workspace.test.ts', name: 'saved-only trusted proxy workspace does not activate saved metadata without a protected agent provider' }],
    checks: ['CLOUDFLARE-HEADER-HONOURED', 'UNTRUSTED-HEADER-IGNORED'],
    async run({ block }) {
      block('CLOUDFLARE-HEADER-HONOURED', 'The transport cannot connect from a Cloudflare range or send CF-Connecting-IP, and the logged or rate-limited client address is not readable through the API.')
      block('UNTRUSTED-HEADER-IGNORED', 'The transport does not send forwarding headers, and trusting a range is a change that could cut management access.')
    },
  }),
  tool('api-explorer', {
    prefix: 'APX', probe: '/api/server/panel/developer', paths: /^\/api\/server\/panel\/(?:developer|api-tokens)$/,
    unit: [{ id: 'APX-UNIT-FINITE-EXPLORER', file: 'apps/api/src/developer-workspace.test.ts', name: 'finite interactive API explorer ignores unrelated paths, lists only fixed GET operations and rejects every selector/body extension' }],
    checks: ['INVALID-BODY-REJECTED-IDENTICALLY'],
    async run({ root, check }) {
      const explorer = await root.post('/api/server/panel/developer', { operation: 'tokens', extra: true })
      const api = await root.post('/api/server/panel/api-tokens', {})
      const left = safeResponse(explorer), right = safeResponse(api)
      check('INVALID-BODY-REJECTED-IDENTICALLY', left.status >= 400 && left.status < 500 && left.code !== null && same(left, right), { explorer: left, api: right })
    },
  }),
  tool('xwhm-api-shell', {
    prefix: 'XSH', needs: ['account'], also: ['owner'], probe: '/api/server/panel/developer', requests: 40,
    paths: /^\/api\/(?:accounts\/[0-9a-f-]{36}|plans|feature-lists(?:\/[0-9a-f-]{36})?|account\/developer|server\/panel\/developer)$/,
    unit: [{ id: 'XSH-UNIT-FINITE-EXPLORER', file: 'apps/api/src/developer-workspace.test.ts', name: 'finite interactive API explorer projects own-root token metadata only; integrations cannot dispatch identity, preferences or external URLs' }],
    checks: ['FEATURE-DISABLED-WHEN-OFF', 'LIST-PAGE-SIZE-10-WITH-PAGINATION'],
    async run({ root, owner, fixture, check, undo, refused }) {
      const account = await root.get(`/api/accounts/${fixture.accountId}`), plans = await root.get('/api/plans'), lists = await root.get('/api/feature-lists')
      const plan = list(plans.data?.plans).find(item => item.id === account.data?.account?.planId)
      const featureList = list(lists.data?.featureLists).find(item => item.id === plan?.featureListId)
      if (featureList === undefined || !Array.isArray(featureList.disabled)) check('FEATURE-DISABLED-WHEN-OFF', false, { status: [account.status, plans.status, lists.status] })
      else {
        const target = `/api/feature-lists/${featureList.id}`, original = featureList.disabled
        undo('feature list', async () => {
          const restored = await root.patch(target, { disabled: original })
          const again = list((await root.get('/api/feature-lists')).data?.featureLists).find(item => item.id === featureList.id)
          return restored.status === 200 && same(again?.disabled, original)
        })
        const off = await root.patch(target, { disabled: [...new Set([...original, 'api-shell'])] })
        if (off.status !== 200) check('FEATURE-DISABLED-WHEN-OFF', false, { status: off.status })
        else refused('FEATURE-DISABLED-WHEN-OFF', await owner.post('/api/account/developer', { operation: 'identity' }), 'FORBIDDEN')
      }
      const read = await root.post('/api/server/panel/developer', { operation: 'tokens' })
      check('LIST-PAGE-SIZE-10-WITH-PAGINATION', read.status === 200 && list(read.data?.tokens).length <= 10 && typeof read.data?.pagination === 'object' && read.data.pagination !== null, { status: read.status, rows: list(read.data?.tokens).length, hasPagination: read.data?.pagination != null })
    },
  }),
  tool('xwhm-api-tokens', {
    prefix: 'XAT', probe: '/api/server/panel/api-tokens', requests: 40,
    paths: /^\/api\/(?:server\/panel\/api-tokens(?:\/[0-9a-f-]{36}\/revoke)?|server\/settings|resellers(?:\/[0-9a-f-]{36})?)$/,
    unit: [
      { id: 'XAT-UNIT-RESELLER-REFUSED', file: 'apps/api/src/panel-tokens-workspace.test.ts', name: 'API tokens workspace refuses resellers and bearer-token callers with 403 before any write' },
      { id: 'XAT-UNIT-REVOKE', file: 'apps/api/src/panel-tokens-workspace.test.ts', name: 'API tokens workspace revokes one owned token with audit and re-read, then answers 409 and 404' },
    ],
    checks: ['PRIVILEGE-LACKED-FORBIDDEN', 'IP-RESTRICTED-TOKEN-DENIED', 'REVOKED-TOKEN-401'],
    async run({ root, tag, check, undo, refused, signIn }) {
      const reseller = await makeReseller(root, tag, undo)
      const { client } = reseller ? await signIn('reseller', { username: reseller.username, password: reseller.password }) : { client: null }
      if (client) refused('PRIVILEGE-LACKED-FORBIDDEN', await client.post('/api/server/panel/api-tokens', { name: `xq-${tag}`, scopes: ['accounts:write'], expiresInDays: 1, allowedIps: [] }), 'FORBIDDEN')
      else check('PRIVILEGE-LACKED-FORBIDDEN', false, { signedIn: false })
      const issue = async (suffix, allowedIps) => {
        const made = await root.post('/api/server/panel/api-tokens', { name: `xq-${tag}-${suffix}`, scopes: ['server:read'], expiresInDays: 1, allowedIps })
        const id = made.data?.token?.id, raw = made.data?.secret
        if (made.status !== 201 || typeof id !== 'string' || typeof raw !== 'string') return null
        undo(`API token ${suffix}`, async () => [200, 404, 409].includes((await root.post(`/api/server/panel/api-tokens/${id}/revoke`, {})).status))
        return { id, raw }
      }
      const limited = await issue('ip', ['198.51.100.0/24'])
      if (limited) refused('IP-RESTRICTED-TOKEN-DENIED', await root.anonymous(SETTINGS, { bearer: limited.raw }), 'FORBIDDEN')
      else check('IP-RESTRICTED-TOKEN-DENIED', false, { issued: false })
      const open = await issue('open', [])
      if (!open) { check('REVOKED-TOKEN-401', false, { issued: false }); return }
      const working = await root.anonymous(SETTINGS, { bearer: open.raw })
      await root.post(`/api/server/panel/api-tokens/${open.id}/revoke`, {})
      const revoked = await root.anonymous(SETTINGS, { bearer: open.raw })
      check('REVOKED-TOKEN-401', working.status === 200 && revoked.status === 401, { beforeRevoke: working.status, afterRevoke: revoked.status })
    },
  }),
]
