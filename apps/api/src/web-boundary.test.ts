import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canOpenRegisteredRoute, registeredDocumentAliases, tools, visibleTools } from '@xpanel/catalog'
import {
  createApiToken, createResellerPrincipal, createRootPrincipal, createSession, createTestDb, createUserPrincipal, setTotpSecret,
} from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { SESSION_COOKIE_NAME, principalRecordToPrincipal, sha256Hex } from './auth.ts'
import { createDefaultWebRenderer } from './main.ts'
import { createApiApp, listenApiServer } from './server.ts'
import type { HostCatalogSource } from './host-catalog.ts'
import { parseMarkup, type MarkupNode } from '../../web/src/html.ts'
import { renderUserMenu } from '../../web/src/chrome.ts'
import { LOGIN_CLIENT_SCRIPT } from '../../web/src/login-client.ts'
import { renderAccountSecurityCard } from '../../web/src/surfaces/account-security.ts'

const hydration = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock('../../web/src/index.ts', async (importOriginal) => {
  const web = await importOriginal<typeof import('../../web/src/index.ts')>()
  return {
    ...web,
    serveWebUi: async (req: Request, provider?: () => Promise<Record<string, unknown>>) => {
      if (!provider) return web.serveWebUi(req)
      const state = await provider()
      hydration.push(state)
      return web.serveWebUi(req, () => state as unknown as import('../../web/src/app.ts').WebAppRenderState)
    },
  }
})

const PUBLIC_VECTOR = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SERVER_SECRET = 'web-boundary-fixture-secret-for-tests-only'
const PUBLIC_DB_AUTH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'
const observations: Record<string, unknown>[] = []
const future = () => new Date(Date.now() + 60_000).toISOString()
const protectedPaths = ['/', '/whm', '/panel', '/mail', '/home', '/resources', '/files/manager', '/panel/files/manager', '/whm/accounts', '/whm/security/sign-in', '/mail/inbox']

const accountSecurityControls = (html: string) =>
  parseMarkup(html).filter(node => node.attrs.get('data-account-security') === 'two-factor')

const expectNoAccountSecurityControls = (html: string): void => {
  expect(accountSecurityControls(html)).toHaveLength(0)
}

describe('account-security document boundary assertions', () => {
  it('ignores bootstrap selector text and example markup inside scripts', () => {
    const html = '<script>' + LOGIN_CLIENT_SCRIPT + '</script><script>const example = \'<section data-account-security="two-factor"><input type="password"></section>\';</script><p>Access denied</p>'
    expectNoAccountSecurityControls(html)
  })

  it.each(['live', 'disabled', 'hidden', 'template'] as const)('rejects a genuine %s enrollment card on a denied page', presentation => {
    const card = renderAccountSecurityCard({ locale: 'en', totpEnabled: false, principalKind: 'reseller', surface: 'xwhm' })
    const html = presentation === 'disabled' ? '<fieldset disabled>' + card + '</fieldset>'
      : presentation === 'hidden' ? '<div hidden>' + card + '</div>'
        : presentation === 'template' ? '<template>' + card + '</template>' : card
    expect(accountSecurityControls(html)).toHaveLength(1)
    expect(() => expectNoAccountSecurityControls(html)).toThrow()
  })
})

// An owned account ID is legitimate only as the selected account of a local link.
// Count raw occurrences as well, so text, scripts and unrelated attributes cannot hide behind that exception.
const expectOwnedAccountContextLinks = (html: string, accountId: string): void => {
  const links = parseMarkup(html).filter(node => node.namespace === 'html' && node.tag === 'a' && node.template < 0 && node.attrs.get('href')?.includes(accountId))
  expect(links.length).toBeGreaterThan(0)
  expect(html.split(accountId).length - 1).toBe(links.length)
  for (const link of links) {
    const href = link.attrs.get('href')
    if (href === undefined) throw new Error('missing owned context href')
    expect(href.startsWith('/') && !href.startsWith('//')).toBe(true)
    const url = new URL(href, 'https://xpanel.invalid')
    expect(url.origin).toBe('https://xpanel.invalid')
    expect(url.searchParams.getAll('accountId')).toEqual([accountId])
    url.searchParams.delete('accountId')
    expect(url.href).not.toContain(accountId)
  }
}

const expectUnselectedAccountContextLinks = (html: string, accountId: string, origin: string): void => {
  const links = parseMarkup(html).filter(node => node.namespace === 'html' && node.tag === 'a' && node.template < 0 && node.attrs.has('href'))
  expect(html).not.toContain(accountId)
  let localLinks = 0
  for (const link of links) {
    const href = link.attrs.get('href')
    if (href === undefined) throw new Error('missing unselected context href')
    const url = new URL(href, origin)
    if (url.origin !== new URL(origin).origin) continue
    localLinks++
    expect(url.searchParams.getAll('accountId')).toEqual([])
  }
  expect(localLinks).toBeGreaterThan(0)
}

const within = (nodes: readonly MarkupNode[], index: number, ancestor: number): boolean => {
  for (let at = index; at >= 0;) {
    if (at === ancestor) return true
    const node = nodes[at]
    if (node === undefined) return false
    at = node.parent
  }
  return false
}

const expectPersonalPreferenceBoundary = (nodes: readonly MarkupNode[], menuCount: number, writable: boolean): void => {
  const menus = nodes.flatMap((node, index) => node.template < 0 && node.tag === 'details' && node.attrs.has('data-user-menu') ? [index] : [])
  expect(menus).toHaveLength(menuCount)
  const preferences = nodes.flatMap((node, index) => node.attrs.has('data-ui-theme-preferences') ? [index] : [])
  const choosers = nodes.flatMap((node, index) => node.attrs.has('data-ui-theme-form') ? [index] : [])
  expect(preferences).toHaveLength(menuCount)
  expect(choosers).toHaveLength(menuCount)
  const choiceIds = new Set<string>()
  for (const menu of menus) {
    const owners = preferences.filter(index => within(nodes, index, menu))
    expect(owners).toHaveLength(1)
    const owner = owners[0]
    if (owner === undefined) throw new Error('missing personal preference owner')
    expect(nodes[owner]?.template).toBe(-1)
    expect(nodes[owner]?.attrs.has('hidden')).toBe(true)
    const ownedChoosers = choosers.filter(index => within(nodes, index, owner))
    expect(ownedChoosers).toHaveLength(1)
    const chooser = ownedChoosers[0]
    if (chooser === undefined) throw new Error('missing personal preference chooser')
    expect(nodes[chooser]?.tag).toBe(writable ? 'form' : 'div')
    expect(nodes[chooser]?.template).toBe(-1)
    expect(nodes[chooser]?.attrs.has('hidden')).toBe(true)
    const fields = nodes.filter((_node, index) => within(nodes, index, chooser))
    const choices = fields.filter(node => node.tag === 'select' && node.attrs.get('name') === 'uiTheme' && node.attrs.has('data-ui-theme-choice'))
    expect(choices).toHaveLength(1)
    const choice = choices[0]
    const id = choice?.attrs.get('id')
    if (choice === undefined || id === undefined || id === '') throw new Error('missing personal preference field identity')
    expect(choice.attrs.has('disabled')).toBe(true)
    expect(choiceIds.has(id)).toBe(false)
    choiceIds.add(id)
    expect(fields.filter(node => node.tag === 'label' && node.attrs.get('for') === id)).toHaveLength(1)
    const saves = fields.filter(node => node.tag === 'button' && node.attrs.has('data-ui-theme-save'))
    expect(saves).toHaveLength(1)
    expect(saves[0]?.attrs.get('type')).toBe(writable ? 'submit' : 'button')
    expect(saves[0]?.attrs.has('disabled')).toBe(true)
  }
  const forms = nodes.flatMap((node, index) => node.tag === 'form' ? [index] : [])
  expect(forms.filter(index => nodes[index]?.template === -1)).toHaveLength(writable ? menuCount : 0)
  expect(forms.filter(index => (nodes[index]?.template ?? -1) >= 0)).toHaveLength(1)
  for (const index of forms) {
    const form = nodes[index]
    if (form === undefined) throw new Error('missing form')
    if (form.template < 0) {
      expect(choosers.includes(index)).toBe(true)
      continue
    }
    const template = nodes[form.template]
    expect(template?.tag).toBe('template')
    expect(template?.attrs.get('data-xp-template')).toBe('prompt-dialog')
    expect(form.attrs.get('method')).toBe('dialog')
    expect(form.attrs.get('data-xp-slot')).toBe('form')
    expect(form.attrs.has('action')).toBe(false)
  }
}

// Read-only WHM documents carry the first page of each saved list; this fixture saves none.
const EMPTY_SAVED_LISTS = { accounts: [], plans: [], featureLists: [], resellers: [], domains: [], dnsZones: [], ipPool: [] }
const expectReadOnlyUnqualifiedWorkspace = (html: string, preferenceWritable = true): void => {
  const nodes = parseMarkup(html)
  const roots = nodes.flatMap((node, index) => node.template < 0 && node.attrs.get('data-tool-availability') === 'unverified' ? [index] : [])
  expect(roots).toHaveLength(1)
  const root = roots[0]
  if (root === undefined) throw new Error('missing unqualified workspace')
  const workspace = nodes.filter((_node, index) => within(nodes, index, root))
  const controls = workspace.filter(node => ['button', 'input', 'select', 'textarea'].includes(node.tag))
  expect(controls.length).toBeGreaterThan(0)
  for (const control of controls) expect(control.attrs.has('disabled')).toBe(true)
  for (const node of workspace) {
    expect(node.tag).not.toBe('form')
    expect(node.attrs.get('contenteditable')?.toLowerCase()).not.toBe('true')
    if (node.tag === 'a') for (const attribute of ['data-action', 'onclick', 'onsubmit']) expect(node.attrs.has(attribute)).toBe(false)
    expect(node.attrs.has('data-user-menu')).toBe(false)
    expect(node.attrs.has('data-ui-theme-preferences')).toBe(false)
  }
  // Personal preference admission is independent of the unavailable hosting workspace.
  expectPersonalPreferenceBoundary(nodes, 1, preferenceWritable)
}

describe('bounded document ownership assertions', () => {
  const chooser = (writable = false) => renderUserMenu({ locale: 'en', theme: 'dark', density: 'comfortable', path: '/whm/accounts', surface: 'xwhm', username: 'administrator7', role: 'root', signedIn: true, themeChooserWritable: writable })
  const prompt = '<template data-xp-template="prompt-dialog"><dialog><form method="dialog" data-xp-slot="form"><input id="xp-prompt-input"><button>OK</button></form></dialog></template>'
  const workspace = '<section data-tool-availability="unverified"><input disabled><button disabled>Unavailable</button></section>'

  it('recognizes both personal chooser modes outside the exact workspace', { tags: ['unit'] }, () => {
    for (const writable of [false, true]) {
      expectReadOnlyUnqualifiedWorkspace(chooser(writable) + workspace + prompt + '<script>const sample = "<form><input>"</script>', writable)
    }
  })

  const invalidWorkspaces: Array<[string, string]> = [
    ['enabled workspace field', chooser() + '<section data-tool-availability="unverified"><input hidden><button disabled>Unavailable</button></section>' + prompt],
    ['native workspace form', chooser() + '<section data-tool-availability="unverified"><form hidden><button disabled>Apply</button></form></section>' + prompt],
    ['unowned live form', chooser() + workspace + prompt + '<form hidden><button disabled>Apply</button></form>'],
    ['unrecognized inert form', chooser() + workspace + '<template><form method="dialog" data-xp-slot="form"><input></form></template>'],
    ['relocated personal owner', '<section data-tool-availability="unverified">' + chooser() + '<button disabled>Unavailable</button></section>' + prompt],
  ]
  it.each(invalidWorkspaces)('rejects %s without weakening workspace or form ownership', { tags: ['unit'] }, (_kind, html) => {
    expect(() => expectReadOnlyUnqualifiedWorkspace(html, false)).toThrow()
  })

  it('permits an owned account context only in its correct local URL query', { tags: ['unit'] }, () => {
    const accountId = 'owned-context-7'
    const link = '<a href="/home?lang=en&amp;accountId=' + accountId + '">Home</a>'
    expectOwnedAccountContextLinks(link, accountId)
    for (const html of [link + '<span>' + accountId + '</span>', '<a href="https://foreign.example/home?accountId=' + accountId + '">Home</a>', '<a href="/home?other=' + accountId + '">Home</a>', link + '<script>const account = "' + accountId + '"</script>', link + '<p>href="/home?lang=en&amp;accountId=' + accountId + '"</p>', link + '<p>&lt;a href="/home?lang=en&amp;accountId=' + accountId + '"&gt;Home&lt;/a&gt;</p>', '<svg><a href="/home?accountId=' + accountId + '">Home</a></svg>']) {
      expect(() => expectOwnedAccountContextLinks(html, accountId)).toThrow()
    }
  })
})


afterAll(async () => {
  const path = process.env.XPANEL_WEB_BOUNDARY_EVIDENCE
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  const source = await readFile(new URL('./main.ts', import.meta.url))
  await writeFile(path, `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    proof: 'In-process production HTML renderer with real SQLite session authentication and an isolated state store; no host services or browser execution.',
    nodeVersion: process.version,
    mainSha256: createHash('sha256').update(source).digest('hex'),
    verifiedCatalogTools: tools.filter(tool => tool.status === 'verified' && tool.delivery.status === 'verified').length,
    observations,
  }, null, 2)}\n`)
})

describe('production web renderer boundary regressions', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  let snapshotReads: number

  beforeEach(async () => {
    db = await createTestDb()
    state = await createTestStateStore()
    snapshotReads = 0
    hydration.length = 0
    const readSnapshot = state.store.readSnapshot.bind(state.store)
    state.store.readSnapshot = async () => { snapshotReads++; return readSnapshot() }
  })

  afterEach(async () => { await state.close(); await db.close() })

  const renderer = () => createDefaultWebRenderer({ store: state.store, db: db.db, serverSecret: SERVER_SECRET })
  const request = (path: string, cookie?: string, authorization?: string) => new Request(`http://localhost${path}`, {
    headers: { ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) },
  })
  const session = async (principalId: string, mfaVerified = true) => {
    const token = 'web-boundary-session-fixture'
    await createSession(db.db, { principalId, tokenHash: sha256Hex(token), expiresAt: future(), mfaVerified })
    return `${SESSION_COOKIE_NAME}=${token}`
  }
  const root = async (opts: { enrolled?: boolean; forcePasswordChange?: boolean } = {}) => {
    const principal = await createRootPrincipal(db.db, { username: 'root', passwordHash: PUBLIC_VECTOR, forcePasswordChange: opts.forcePasswordChange ?? false })
    if (opts.enrolled !== false) await setTotpSecret(db.db, principal.id, new Uint8Array(32))
    return principal
  }
  const expectUnqualifiedCatalog = (value: unknown) => {
    expect(Array.isArray(value)).toBe(true)
    if (!Array.isArray(value)) throw new Error('The trusted catalog must remain explicit')
    expect(value).toHaveLength(tools.length)
    expect(value.every(tool => tool.status !== 'verified' && tool.delivery.status !== 'verified')).toBe(true)
  }
  const observe = async (id: string, response: Response, expectedStatus: number, expectedLocation?: string) => {
    const html = await response.text()
    const observation = {
      id,
      status: response.status,
      location: response.headers.get('location'),
      expectedStatus,
      ...(expectedLocation ? { expectedLocation } : {}),
      statusPassed: response.status === expectedStatus,
      ...(expectedLocation ? { locationPassed: response.headers.get('location') === expectedLocation } : {}),
      snapshotReads,
      unavailableWorkspace: html.includes('data-tool-availability="unverified"'),
      sampleDataPresent: /alice-shop\.com|srv1\.xpanel\.test/.test(html),
    }
    observations.push(observation)
    expect.soft(response.status, id).toBe(expectedStatus)
    if (expectedLocation) expect.soft(response.headers.get('location'), id).toBe(expectedLocation)
    return html
  }

  it('redirects anonymous surface requests without reading hosting state', async () => {
    const render = await renderer()
    for (const path of protectedPaths) {
      await observe(`anonymous:${path}`, await render(request(path)), 303, '/login')
    }
    expect(snapshotReads).toBe(0)
  })

  it('rejects forged UI cookies, including substring matches', async () => {
    const render = await renderer()
    for (const cookie of ['xpanel_ui_session=1', 'unrelated=xpanel_ui_session=1']) {
      for (const path of protectedPaths) {
        await observe(`forged-ui-cookie:${cookie.startsWith('unrelated') ? 'substring' : 'exact'}:${path}`, await render(request(path, cookie)), 303, '/login')
      }
    }
    expect(snapshotReads).toBe(0)
  })

  it('does not publish prototype boards or their runtime from the production renderer', async () => {
    const render = await renderer()
    for (const path of ['/reference-a.dc.html', '/reference-b.dc.html', '/reference-c.dc.html', '/reference-d.dc.html', '/support.js', '/assets/support.js']) {
      await observe(`prototype:${path}`, await render(request(path)), 404)
    }
    expect(snapshotReads).toBe(0)
  })

  it('refuses an account owner on the administrative surface before reading state', async () => {
    const principal = await createUserPrincipal(db.db, { username: 'owner', passwordHash: PUBLIC_VECTOR, accountId: '10000000-0000-4000-8000-000000000001' })
    const render = await renderer()
    const cookie = await session(principal.id)
    for (const path of ['/whm', '/whm/accounts', '/whm/security/sign-in']) {
      await observe(`owner-crosses-whm:${path}`, await render(request(path, cookie)), 403)
    }
    expect(snapshotReads).toBe(0)
  })

  it.each(['no-acl', 'root-only', 'route-acl'] as const)('denies reseller document admission before a hosting snapshot: %s', async condition => {
    const reseller = await state.store.createReseller({ username: 'boundaryreseller', passwordHash: PUBLIC_VECTOR,
      acl: condition === 'no-acl' ? [] : ['list-accounts'], maxAccounts: 2, totalDiskMb: 1024,
      totalBandwidthMb: 2048, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [],
    })
    const principal = await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash: PUBLIC_VECTOR })
    const cookie = await session(principal.id)
    const render = await renderer()
    const path = condition === 'no-acl' ? '/whm/accounts' : condition === 'root-only' ? '/whm/accounts/health' : '/whm/accounts/new'
    snapshotReads = 0
    const html = await observe(`reseller-admission:${condition}:${path}`, await render(request(path, cookie)), 403)
    expect(html).toContain('data-status-page="403"')
    expect(html).not.toContain('data-tool-availability="unverified"')
    const supplied = hydration.at(-1)
    expect(supplied?.error).toMatchObject({ status: 403 })
    for (const key of ['whm', 'panel', 'mail', 'generationId', 'workspaceSummary']) expect(supplied).not.toHaveProperty(key)
    expect(snapshotReads).toBe(0)
  })

  it.each([false, true])('hydrates only the authenticated reseller security model with list-accounts=%s', async listAccounts => {
    const reseller = await state.store.createReseller({ username: 'selfreseller', passwordHash: PUBLIC_VECTOR,
      acl: listAccounts ? ['list-accounts'] : [], maxAccounts: 2, totalDiskMb: 1024,
      totalBandwidthMb: 2048, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [],
    })
    const principal = await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash: PUBLIC_VECTOR })
    if (listAccounts) await setTotpSecret(db.db, principal.id, new Uint8Array(32))
    const other = await root({ enrolled: !listAccounts })
    const getSettings = vi.spyOn(state.store, 'getServerSettings')
    const readWorkspace = vi.spyOn(state.store, 'readAccountWorkspace')
    const hostFetch = vi.fn(async () => new Response(null, { status: 503 }))
    const render = await createDefaultWebRenderer({ store: state.store, db: db.db, serverSecret: SERVER_SECRET, agent: { fetch: hostFetch, token: 'synthetic-agent-token' } })
    const cookie = await session(principal.id)
    const html = await observe(`reseller-self-security:${listAccounts}`, await render(request(`/whm/security/sign-in?principalId=${other.id}&accountId=foreign-account-marker&surface=xpanel`, cookie)), 200)
    expect(hydration.at(-1)).toEqual({
      surface: 'xwhm', mfaRuntimeMode: 'optional', activeRoute: '/whm/security/sign-in',
      security: { totpEnabled: listAccounts },
      visibility: { principal: { kind: 'reseller', id: principal.id, username: principal.username } },
      noticePosition: 'bottom-right', personal: { notifications: { announcements: true, bandwidth: true, disk: true }, onboardingDismissed: false },
    })
    expect(accountSecurityControls(html)).toHaveLength(1)
    expect(html).toContain(listAccounts ? 'data-mfa-enabled="true"' : 'data-auth-state="optional"')
    expect(html).not.toMatch(/data-mfa-recommendation|data-realtime-enabled="true"|data-workspace-account-overview=|data-account-row=|data-service-row=|data-cmdk-item=/)
    for (const marker of [other.id, 'Multi-factor enrollment is required']) expect(html).not.toContain(marker)
    // Account URL context may persist in links; it never selects a self-service actor or read model.
    expect(html).toContain('accountId=foreign-account-marker')
    expect(html.replace(/href="[^"]*"/g, '')).not.toContain('foreign-account-marker')
    expect(getSettings).not.toHaveBeenCalled()
    expect(readWorkspace).not.toHaveBeenCalled()
    expect(hostFetch).not.toHaveBeenCalled()
    expect(snapshotReads).toBe(0)
    // This self-service exception does not grant the global operator document role.
    expect(canOpenRegisteredRoute('/whm/security/sign-in', { principal: { kind: 'reseller', id: principal.id, username: principal.username }, reseller })).toBe(false)
    for (const path of ['/whm/security/firewall', '/whm/server/setup', '/whm/accounts/health']) {
      expect((await render(request(path, cookie))).status).toBe(403)
    }
    expect(snapshotReads).toBe(0)
  })

  it.each(['missing', 'mismatched', 'disabled', 'password-change', 'revoked', 'expired', 'mfa-pending', 'api-token'] as const)('does not open reseller self security for a %s actor or session', async condition => {
    const reseller = condition === 'missing' ? undefined : await state.store.createReseller({ username: 'guardreseller', passwordHash: PUBLIC_VECTOR,
      acl: [], maxAccounts: 2, totalDiskMb: 1024, totalBandwidthMb: 2048, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [],
    })
    const principal = await createResellerPrincipal(db.db, {
      ...(reseller ? { id: reseller.id } : {}), username: condition === 'mismatched' ? 'differentactor' : 'guardreseller', passwordHash: PUBLIC_VECTOR,
      disabled: condition === 'disabled', forcePasswordChange: condition === 'password-change',
    })
    if (condition === 'mfa-pending') await setTotpSecret(db.db, principal.id, new Uint8Array(32))
    const cookie = await session(principal.id, condition !== 'mfa-pending')
    let authorization: string | undefined
    if (condition === 'api-token') {
      const token = 'reseller-self-security-api-token-fixture'
      await createApiToken(db.db, { principalId: principal.id, name: 'Self security fixture', tokenHash: sha256Hex(token), scopes: ['*'], expiresAt: future() })
      authorization = `Bearer ${token}`
    }
    if (condition === 'revoked') await db.db.query('UPDATE sessions SET revoked_at = $1 WHERE principal_id = $2', [new Date().toISOString(), principal.id])
    if (condition === 'expired') await db.db.query('UPDATE sessions SET last_seen_at = $1 WHERE principal_id = $2', [new Date(Date.now() - 2 * 3600_000).toISOString(), principal.id])
    const getSettings = vi.spyOn(state.store, 'getServerSettings')
    const readWorkspace = vi.spyOn(state.store, 'readAccountWorkspace')
    const render = await renderer()
    const expectedStatus = condition === 'missing' || condition === 'mismatched' ? 403 : 303
    const html = await observe(`reseller-self-security-rejected:${condition}`, await render(request('/whm/security/sign-in', condition === 'api-token' ? undefined : cookie, authorization)), expectedStatus, expectedStatus === 303 ? '/login' : undefined)
    expectNoAccountSecurityControls(html)
    if (expectedStatus === 303) expect(hydration).toEqual([])
    else expect(hydration.at(-1)).not.toHaveProperty('security')
    expect(getSettings).not.toHaveBeenCalled()
    expect(readWorkspace).not.toHaveBeenCalled()
    expect(snapshotReads).toBe(0)
  })

  it('requires a real active account for account owners', async () => {
    const principal = await createUserPrincipal(db.db, { username: 'owner', passwordHash: PUBLIC_VECTOR, accountId: '10000000-0000-4000-8000-000000000001' })
    const cookie = await session(principal.id)
    const render = await renderer()
    for (const path of ['/panel', '/mail']) await observe(`missing-owner-account:${path}`, await render(request(path, cookie)), 403)
  })

  it.each(['mfa-pending', 'password-change', 'revoked', 'api-token'] as const)('requires a completed interactive session: %s', async (condition) => {
    const principal = await root({ forcePasswordChange: condition === 'password-change' })
    let cookie = 'xpanel_ui_session=1'
    let authorization: string | undefined
    if (condition === 'api-token') {
      const token = 'web-boundary-api-token-fixture'
      await createApiToken(db.db, { principalId: principal.id, name: 'Web boundary fixture', tokenHash: sha256Hex(token), scopes: ['*'], expiresAt: future() })
      authorization = `Bearer ${token}`
    } else {
      cookie = `${await session(principal.id, condition !== 'mfa-pending')}; ${cookie}`
      if (condition === 'revoked') await db.db.query('UPDATE sessions SET revoked_at = $1 WHERE principal_id = $2', [new Date().toISOString(), principal.id])
    }
    const render = await renderer()
    await observe(`interactive-session:${condition}`, await render(request('/whm', cookie, authorization)), 303, '/login')
    expect(snapshotReads).toBe(0)
  })

  it('opens administrative HTML for root when two-factor authentication is not enrolled', async () => {
    const principal = await root({ enrolled: false })
    const render = await renderer()
    const cookie = await session(principal.id)
    const home = await observe('root-mfa-unenrolled:/whm', await render(request('/whm', cookie)), 200)
    expect(home).toContain('data-mfa-optional-link')
    expect(home).not.toMatch(/Multi-factor enrollment is required|must complete enrollment/)
    const accounts = await observe('root-mfa-unenrolled:/whm/accounts', await render(request('/whm/accounts', cookie)), 200)
    expect(accounts).toContain('data-tool-availability="unverified"')
    expectReadOnlyUnqualifiedWorkspace(accounts)
    expect(accounts).not.toContain('data-status-page="404"')
    expect(accounts).not.toMatch(/Multi-factor enrollment is required|must complete enrollment/)
    const security = await observe('root-mfa-unenrolled:security', await render(request('/whm/security/sign-in', cookie)), 200)
    expect(security).toContain('data-mfa-recommendation')
    expect(security).toContain('data-auth-setup-form')
    expect(security).not.toContain('data-mfa-optional-link')
    expect(snapshotReads).toBe(0)
  })

  it('preserves the real catalog qualification state', async () => {
    const principal = await root()
    const cookie = await session(principal.id)
    const render = await renderer()
    expect(tools.some(tool => tool.status === 'verified' && tool.delivery.status === 'verified')).toBe(false)
    const home = await observe('unverified-catalog:/whm', await render(request('/whm', cookie)), 200)
    expect.soft(home.includes('data-tool-availability="unverified"')).toBe(true)
    expect.soft(/alice-shop\.com|srv1\.xpanel\.test/.test(home)).toBe(false)
    const accounts = await observe('unverified-catalog:/whm/accounts', await render(request('/whm/accounts', cookie)), 200)
    expect.soft(accounts.includes('data-status-page="404"')).toBe(false)
    expect.soft(accounts.includes('data-tool-availability="unverified"')).toBe(true)
    expectReadOnlyUnqualifiedWorkspace(accounts)
    expect(hydration.at(-1)?.workspaceSummary).toEqual({})
    expect(hydration.at(-1)?.whm).toEqual({ principal: principalRecordToPrincipal(principal), activeReseller: null, ...EMPTY_SAVED_LISTS })
    for (const key of ['panel', 'mail', 'generationId']) expect(hydration.at(-1)).not.toHaveProperty(key)
    expect.soft(/alice-shop\.com|srv1\.xpanel\.test/.test(accounts)).toBe(false)
    expect(snapshotReads).toBe(0)
  })

  it('hydrates only a bounded identity summary while tools remain unqualified', async () => {
    const principal = await root()
    const cookie = await session(principal.id)
    const render = await renderer()
    await observe('empty-state:/whm', await render(request('/whm', cookie)), 200)
    const workspace = hydration.at(-1)
    expect(workspace).toBeDefined()
    expect((workspace!.visibility as { principal: { kind: string } }).principal.kind).toBe('root')
    expectUnqualifiedCatalog(workspace!.catalog)
    expect(workspace!.workspaceSummary).toEqual({})
    expect(workspace?.whm).toEqual({ principal: principalRecordToPrincipal(principal), activeReseller: null, ...EMPTY_SAVED_LISTS })
    for (const key of ['panel', 'mail', 'generationId']) expect(workspace).not.toHaveProperty(key)
    for (const path of ['/whm/accounts', '/whm/accounts/health', ...registeredDocumentAliases.filter(row => row.parentRoute === '/whm/software/site-software').map(row => row.route)]) {
      const html = await observe(`empty-state:${path}`, await render(request(path, cookie)), 200)
      expect(html).toContain('data-tool-availability="unverified"')
      expectReadOnlyUnqualifiedWorkspace(html)
      const supplied = hydration.at(-1)
      expect(supplied).toBeDefined()
      if (!supplied) throw new Error('Missing bounded WHM identity state')
      const visibility = supplied.visibility as { principal: { kind: string } }
      const whm = supplied.whm
      const whmKeys = whm !== null && typeof whm === 'object' && !Array.isArray(whm) ? Object.keys(whm) : []
      observations.push({ id: `hydration:${path}`, visibilityPrincipalKind: visibility.principal.kind,
        catalogOverridden: supplied.catalog !== undefined,
        fullStateSupplied: ['panel', 'mail', 'generationId'].some(key => key in supplied)
          || whmKeys.some(key => !['principal', 'activeReseller', ...Object.keys(EMPTY_SAVED_LISTS)].includes(key)),
        workspaceSummaryKeys: Object.keys(supplied.workspaceSummary as Record<string, unknown>),
      })
      expect(visibility.principal.kind).toBe('root')
      expectUnqualifiedCatalog(supplied!.catalog)
      expect(supplied!.activeRoute).toBe(path)
      expect(supplied!.workspaceSummary).toEqual({})
      expect(supplied).not.toHaveProperty('error')
      expect(supplied.whm).toEqual({ principal: principalRecordToPrincipal(principal), activeReseller: null, ...EMPTY_SAVED_LISTS })
      for (const key of ['panel', 'mail', 'generationId']) expect(supplied).not.toHaveProperty(key)
    }
    expect(snapshotReads).toBe(0)
  })

  it('distinguishes unknown documents from role-denied pages and unqualified registered workspaces', async () => {
    const principal = await root()
    const cookie = await session(principal.id)
    const render = await renderer()
    const unknown = await observe('route-404:anonymous-email', await render(request('/panel/email')), 404)
    expect(unknown).toContain('data-status-page="404"')
    expect(unknown).not.toContain('data-tool-availability="unverified"')
    expect(unknown).toContain('Sign in')
    const signedUnknown = await observe('route-404:signed-in-unknown', await render(request('/not-a-real-page', cookie)), 404)
    expect(signedUnknown).toContain('data-status-page="404"')
    expect(signedUnknown).toContain('data-user-menu')
    expect(signedUnknown).toContain('data-action="logout"')
    expect(signedUnknown).not.toContain('>Sign in<')
    for (const path of ['/panel', '/panel/domains', '/panel/files/manager', '/mail', '/mail/inbox']) {
      const denied = await observe(`root-owner-only:${path}`, await render(request(path, cookie)), 403)
      expect(denied).toContain('data-status-page="403"')
      expect(denied).not.toContain('data-tool-availability="unverified"')
      expect(hydration.at(-1)).not.toHaveProperty('workspaceSummary')
    }
    const home = await observe('route-home:/whm', await render(request('/whm', cookie)), 200)
    expect(home).toContain('data-tool-availability="unverified"')
    expect(home).toContain('Coming soon')
    const crossedRender = await createDefaultWebRenderer({
      store: state.store, db: db.db, serverSecret: SERVER_SECRET, entryPoint: 'xpanel', publicOrigin: 'https://panel.example.test:2083',
    })
    // A listener renders no other panel: the 404 names neither another origin nor a switch to it.
    const crossed = await observe('route-404:cross-whm', await crossedRender(request('/whm')), 404)
    expect(crossed).not.toMatch(/whm\.example\.test|mail\.example\.test|data-panel-link|data-panel-switch/)
    expect(crossed).not.toContain('href="/whm')
    expect(snapshotReads).toBe(0)
  })

  it.each([false, true])('serves a scoped account overview over HTTP with populated owner database state: %s', async (populated) => {
    const featureList = await state.store.createFeatureList({ name: 'Summary fixture features', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({
      name: 'Summary plan7', ownerId: null, featureListId: featureList.id,
      resources: { diskMb: 1000, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
      caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 },
      dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
    })
    const accountInput = { passwordHash: PUBLIC_VECTOR, planId: plan.id, ownerId: null, contactEmail: 'private-summary-contact@example.test', ipv4: '192.0.2.199', shell: 'none' as const,
      php: { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
    }
    await state.store.saveServerIp({ address: '192.0.2.199', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const owner = await state.store.createAccount({ ...accountInput, username: 'owner7', primaryDomain: 'owner7.example.test' })
    const other = await state.store.createAccount({ ...accountInput, username: 'other7', primaryDomain: 'private-other-account.example.test' })
    const trashedDatabase = await state.store.createDatabase({ accountId: owner.id, name: 'owner7_trashed' })
    await state.store.trashDatabase(trashedDatabase.id)
    const databases = populated ? [await state.store.createDatabase({ accountId: owner.id, name: 'owner7_live' })] : []
    const databaseUsers = populated ? await Promise.all(['app', 'reader'].map(name => state.store.createDatabaseUser({
      accountId: owner.id, name: `owner7_${name}`, authPlugin: 'ed25519', authString: PUBLIC_DB_AUTH,
    }))) : []
    const otherDatabase = await state.store.createDatabase({ accountId: other.id, name: 'other7_private' })
    const otherDatabaseUser = await state.store.createDatabaseUser({
      accountId: other.id, name: 'other7_private', authPlugin: 'ed25519', authString: PUBLIC_DB_AUTH,
    })
    const principal = await createUserPrincipal(db.db, { username: owner.username, accountId: owner.id, passwordHash: PUBLIC_VECTOR })
    const cookie = await session(principal.id)
    const app = createApiApp({ store: state.store, db: db.db, serverSecret: SERVER_SECRET, webRenderer: await renderer() })
    const server = await listenApiServer(app, { host: '127.0.0.1', port: 0 })
    snapshotReads = 0
    try {
      const origin = `http://127.0.0.1:${server.port}`
      for (const locale of ['en', 'ar']) {
        const response = await fetch(`${origin}/panel?lang=${locale}`, { headers: { cookie }, redirect: 'manual' })
        const html = await observe(`scoped-summary-http:${populated ? 'database-populated' : 'database-empty'}:${locale}`, response, 200)
        for (const value of [owner.username, owner.primaryDomain, plan.name, owner.home, owner.ipv4]) expect(html).toContain(value)
        expect(html).toContain('data-board-port="xpanel-home"')
        expect(html).toContain(locale === 'ar' ? 'الرئيسية' : 'Home')
        expect(html).toContain('data-action="logout"')
        expect(html).not.toContain('data-tool-availability="unverified"')
        expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
        expectPersonalPreferenceBoundary(parseMarkup(html), 2, true)
        expectUnselectedAccountContextLinks(html, owner.id, origin)
        const panel = hydration.at(-1)?.panel as { databases: Array<{ id: string; name: string }>; databaseUsers: Array<{ id: string; name: string; grants: unknown[] }> }
        expect(panel.databases.map(database => database.name)).toEqual(databases.map(database => database.name))
        expect(panel.databaseUsers).toEqual(databaseUsers.map(user => ({ id: user.id, name: user.name, grants: user.grants })))
        const databaseLabel = locale === 'ar' ? 'قواعد البيانات' : 'Databases'
        const databaseMeter = new RegExp(`#475467[^"]*">${databaseLabel}</span>([\\s\\S]*?)</div>`).exec(html)?.[1]
        expect(databaseMeter?.replace(/<[^>]*>/g, '').trim()).toBe(`${databases.length} / 1`)
        for (const value of [otherDatabase.id, otherDatabase.name, otherDatabaseUser.id, otherDatabaseUser.name, trashedDatabase.id, trashedDatabase.name, PUBLIC_DB_AUTH]) {
          expect(JSON.stringify(panel)).not.toContain(value)
          expect(html).not.toContain(value)
        }
        for (const value of [other.id, principal.id, plan.id, featureList.id, owner.contactEmail, other.primaryDomain, PUBLIC_VECTOR]) expect(html).not.toContain(value)
      }
      for (const [path, canonicalRoute] of [
        ['/domains', '/domains'], ['/panel/domains', '/domains'],
        ['/files/manager', '/files/manager'], ['/panel/files/manager', '/files/manager'],
        ...registeredDocumentAliases.filter(row => row.parentRoute === '/software/installer').map(row => [row.route, row.route] as const),
      ] as const) {
        const html = await observe(`registered-unqualified-owner:${path}`, await fetch(`${origin}${path}`, { headers: { cookie }, redirect: 'manual' }), 200)
        expect(html).toContain('data-tool-availability="unverified"')
        expectReadOnlyUnqualifiedWorkspace(html)
        expect(html).not.toContain('data-status-page="404"')
        const supplied = hydration.at(-1)
        expect(supplied).toMatchObject({ surface: 'xpanel', activeRoute: canonicalRoute })
        expect(supplied?.workspaceSummary).toEqual({
          account: { id: owner.id, ownerId: owner.ownerId, username: owner.username, primaryDomain: owner.primaryDomain, status: owner.status, planId: owner.planId },
          plan: { id: plan.id, name: plan.name },
        })
        expectUnqualifiedCatalog(supplied?.catalog)
        expect(supplied).not.toHaveProperty('error')
        expect(supplied?.panel).toEqual({ account: owner, plan, domains: expect.any(Array) })
        expect((supplied?.panel as { domains: Array<{ accountId: string }> }).domains.every(domain => domain.accountId === owner.id)).toBe(true)
        for (const key of ['whm', 'mail', 'generationId']) expect(supplied).not.toHaveProperty(key)
        // The saved document root and IPv4 binding of the owner's own domain may show in closed fields.
        for (const value of [owner.contactEmail, other.primaryDomain, PUBLIC_VECTOR, PUBLIC_DB_AUTH,
          otherDatabase.id, otherDatabase.name, otherDatabaseUser.id, otherDatabaseUser.name,
          ...databases.map(database => database.name), ...databaseUsers.map(user => user.name),
        ]) {
          expect(JSON.stringify(supplied?.workspaceSummary)).not.toContain(value)
          expect(html).not.toContain(value)
        }
        for (const value of [owner.username, owner.primaryDomain, plan.name]) expect(html).toContain(value)
        for (const value of [owner.id, other.id, principal.id, plan.id, featureList.id]) expect(html).not.toContain(value)
      }
      await observe('scoped-summary-http:other-account', await fetch(`${origin}/panel?accountId=${other.id}`, { headers: { cookie }, redirect: 'manual' }), 404)
      await observe('scoped-summary-http:anonymous', await fetch(`${origin}/panel`, { redirect: 'manual' }), 303, '/login')
      expect(snapshotReads).toBe(0)
    } finally { await server.close() }
  })
  it('preserves one provider snapshot for unqualified documents, status pages, preferences and API reads', async () => {
    const principal = await root({ enrolled: false })
    const cookie = await session(principal.id)
    // A deliberately narrow, unaccepted provider snapshot must never expand to default tools.
    const snapshot = Object.freeze(tools.slice(0, 1))
    expect(snapshot.some(tool => tool.status === 'verified')).toBe(false)
    const load = vi.fn(async (_source: HostCatalogSource | null) => snapshot)
    const catalogProvider = { acceptanceIdentity: 'synthetic-unaccepted-snapshot', load, reset: () => {}, qualificationMode: () => false }
    const render = await createDefaultWebRenderer({ store: state.store, db: db.db, serverSecret: SERVER_SECRET, catalogProvider })
    for (const [path, status] of [['/whm/accounts', 200], ['/whm/not-a-registered-page', 404], ['/whm/preferences', 200]] as const) {
      const response = await render(request(path, cookie))
      expect(response.status).toBe(status)
      await response.body?.cancel()
      expect(hydration.at(-1)?.catalog).toBe(snapshot)
    }
    const app = createApiApp({ store: state.store, db: db.db, serverSecret: SERVER_SECRET, catalogProvider })
    const response = await app.fetch(request('/api/catalog', cookie), { remoteAddress: '192.0.2.40' })
    expect(response.status).toBe(200)
    const body = await response.json() as { tools: unknown[] }
    expect(body.tools).toEqual(visibleTools(snapshot, { principal: principalRecordToPrincipal(principal) }))
    expect(body.tools).toEqual([])
    expect(load).toHaveBeenCalledTimes(4)
    expect(load.mock.calls.every(call => call[0] === null)).toBe(true)
    expect(snapshot).toHaveLength(1)
  })
})
