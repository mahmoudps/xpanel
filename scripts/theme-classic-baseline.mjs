#!/usr/bin/env node
// Capture exact classic HTML and HTTP/asset behavior before and after presentation refactoring.
// Run outside the fast unit lane, with the shared heavy-job lock and a clean, committed source.
// No browser, network request, screenshot, data mutation or normalization is performed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const FIXTURE_AT = '2026-01-15T12:00:00.000Z'
const RECIPE = 'classic-document-equivalence-v1'
const sha = value => createHash('sha256').update(value).digest('hex')
const json = value => JSON.stringify(value, (_key, item) => item instanceof Set ? { set: [...item].sort() } : item)
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
const inside = (root, path) => {
  const rel = relative(root, path)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}
const outputPath = (root, value, mayExist = false) => {
  assert.ok(typeof value === 'string' && value.length > 0, 'A private ignored output path is required')
  const path = resolve(value)
  assert.ok(inside(root, path), 'Output and lock must be inside the repository')
  assert.ok(!relative(root, path).split(sep).includes('.git'), 'Git metadata is not an output directory')
  const parent = realpathSync(dirname(path))
  const folded = value => process.platform === 'win32' ? value.toLowerCase() : value
  assert.ok(inside(root, parent), 'Output parent must stay inside the repository')
  assert.equal(folded(parent), folded(dirname(path)), 'Output parents cannot redirect through symlinks')
  assert.equal(execFileSync('git', ['-C', root, 'check-ignore', '--no-index', '--quiet', '--', relative(root, path)]).length, 0)
  assert.ok(mayExist || !existsSync(path), 'Refusing to replace existing output')
  if (mayExist) assert.ok(existsSync(path), 'Baseline does not exist')
  if (existsSync(path)) assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Baseline must be an ordinary file')
  return path
}
const cleanSource = root => {
  assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=normal'), '', 'Source must be clean and committed')
  const names = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean).sort()
  const files = names.map(path => {
    const absolute = join(root, path)
    assert.ok(lstatSync(absolute).isFile() && !lstatSync(absolute).isSymbolicLink(), 'Tracked input is not an ordinary file: ' + path)
    const content = readFileSync(absolute)
    return { path, bytes: content.length, sha256: sha(content) }
  })
  return { head: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'), files, filesSha256: sha(json(files)) }
}

export function classicScenarios({ navigation, registeredDocumentAliases, tools, defaultPlan, createInitialLiveEventState }) {
  const canonical = navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => ({ route: page.route, surface: surface.surface }))))
  const byRoute = new Map(canonical.map(row => [row.route, row]))
  const aliases = registeredDocumentAliases.map(row => {
    const parent = byRoute.get(row.parentRoute)
    assert.ok(parent, 'Alias has no canonical parent: ' + row.route)
    return { route: row.route, surface: parent.surface, parentRoute: row.parentRoute }
  })
  const documents = [...canonical, ...aliases].sort((a, b) => a.route.localeCompare(b.route))
  assert.equal(new Set(documents.map(row => row.route)).size, documents.length, 'Duplicate registered document')
  assert.ok(canonical.length > 0 && aliases.length > 0, 'Canonical and alias documents must both be covered')
  const qualified = tools.map(tool => tool.status === 'out-of-scope' ? tool : {
    ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Synthetic renderer input.', evidence: [] },
  })
  const featureKeys = new Set(tools.map(tool => tool.featureKey).filter(Boolean))
  const resellerAcl = [...new Set(tools.map(tool => tool.resellerAcl).filter(Boolean))]
  const plan = { ...defaultPlan({ id: '22222222-2222-4222-8222-222222222222', name: 'Synthetic plan' }), shell: 'jailed' }
  const account = {
    id: '11111111-1111-4111-8111-111111111111', username: 'synthetic-owner', uid: 20001, gid: 20001,
    home: '/home/synthetic-owner', primaryDomain: 'site.example.test', planId: plan.id, ownerId: null,
    status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10',
    shell: 'jailed', createdAt: FIXTURE_AT,
  }
  const root = { kind: 'root', id: '33333333-3333-4333-8333-333333333333', username: 'synthetic-root' }
  const owner = { kind: 'user', id: account.id, accountId: account.id, username: account.username }
  const reseller = { kind: 'reseller', id: '44444444-4444-4444-8444-444444444444', username: 'synthetic-reseller' }
  const domain = {
    id: '55555555-5555-4555-8555-555555555555', accountId: account.id, name: account.primaryDomain,
    kind: 'primary', parentId: null, docRoot: account.home + '/public_html', siteType: 'php',
    upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} },
    wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: account.ipv4,
  }
  const live = createInitialLiveEventState()
  live.reconcile = {
    ...live.reconcile, generationId: 7, status: 'applied', stages: { render: 'passed', test: 'passed', switch: 'passed', reload: 'passed', verify: 'passed' },
    stateChecksum: '9f86d081884c7d659a2feaa0c55ad015', filesCount: 12, durationMs: 100, updatedAt: FIXTURE_AT,
  }
  const branding = {
    companyName: 'Synthetic company', productName: 'Synthetic control panel', footerText: 'Synthetic footer',
    hidePoweredBy: false, primaryColor: '#1255aa', accentColor: '#008866', supportUrl: 'https://support.example.test',
    supportEmail: 'support@example.test', logoUrl: '/branding/logo?v=1111111111111111', faviconUrl: '/branding/favicon?v=2222222222222222',
  }
  const base = (surface, route, locale, theme) => ({
    surface, activeRoute: route, locale, theme, density: 'comfortable', mfaRuntimeMode: 'optional', generationId: 7,
    accountId: surface === 'xpanel' || surface === 'xmail' ? account.id : undefined, realtimeEnabled: true, catalog: qualified,
    visibility: { principal: surface === 'xwhm' ? root : owner, disabledFeatures: new Set() }, liveState: live,
    security: { totpEnabled: false }, supportEmail: 'support@example.test',
    panel: {
      account, plan, domains: [domain],
      files: [{ name: 'fixture.txt', path: account.home + '/public_html/fixture.txt', kind: 'file', sizeBytes: 128, modeOctal: '0640', modifiedAt: FIXTURE_AT }],
      serviceUsers: [{ id: '66666666-6666-4666-8666-666666666666', accountId: account.id, login: 'mailbox@example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' }],
      databases: [], dnsRecords: [],
    },
    whm: { principal: root, hostname: 'server.example.test', adminSessionIp: '192.0.2.20', accounts: [account], plans: [plan], domains: [domain], services: [], auditEntries: [] },
    mail: { mailbox: 'mailbox@example.test', domain: 'example.test', quotaUsedMb: 1, quotaLimitMb: 100, messages: [], sieveRules: [] },
  })
  const cases = []
  const add = (key, state) => cases.push({ key, state })
  for (const locale of ['en', 'ar']) for (const theme of ['light', 'dark']) {
    const context = locale + '/' + theme
    for (const document of documents) {
      const state = base(document.surface, document.route, locale, theme)
      add('document/qualified/' + context + document.route, state)
      add('document/unqualified/' + context + document.route, { ...state, catalog: [], realtimeEnabled: false, liveState: undefined })
    }
    for (const surface of ['xpanel', 'xwhm', 'xmail']) {
      const route = surface === 'xpanel' ? '/home' : surface === 'xwhm' ? '/whm' : '/mail/inbox'
      const state = base(surface, route, locale, theme)
      add('representative/compact/' + context + '/' + surface, { ...state, density: 'compact' })
      add('representative/explicit-classic/' + context + '/' + surface, { ...state, uiTheme: 'classic' })
      add('representative/unknown-theme-fallback/' + context + '/' + surface, { ...state, uiTheme: 'unknown-theme' })
      add('representative/branded/' + context + '/' + surface, { ...state, branding })
      add('representative/impersonation/' + context + '/' + surface, { ...state, impersonation: { target: account.username, issuer: root.username } })
      add('representative/feature-disabled/' + context + '/' + surface, { ...state, visibility: { ...state.visibility, disabledFeatures: featureKeys, allowedToolIds: new Set() } })
      add('representative/role-denied/' + context + '/' + surface, { ...state, visibility: { principal: surface === 'xwhm' ? owner : root, disabledFeatures: new Set() } })
      add('representative/no-principal/' + context + '/' + surface, { ...state, visibility: undefined })
    }
    const home = base('xpanel', '/home', locale, theme)
    add('representative/no-account/' + context, { ...home, panel: undefined, workspaceSummary: { plan }, visibility: { principal: { ...owner, accountId: '' }, disabledFeatures: new Set() } })
    add('representative/suspended-account/' + context, { ...home, panel: { ...home.panel, account: { ...account, status: 'suspended', suspendReason: 'Synthetic suspension' } } })
    for (const document of documents.filter(row => row.surface === 'xwhm')) {
      const state = base('xwhm', document.route, locale, theme)
      add('document/reseller/' + context + document.route, { ...state, visibility: { principal: reseller, reseller: { acl: resellerAcl }, disabledFeatures: new Set() }, whm: { ...state.whm, principal: reseller, accounts: [{ ...account, ownerId: reseller.id }] } })
    }
    for (const [surface, route] of [['xwhm', '/whm/security/sign-in'], ['xpanel', '/security/account'], ['xmail', '/mail/settings/security']]) {
      for (const mfaRuntimeMode of ['disabled', 'optional']) for (const totpEnabled of [false, true]) {
        add('security/' + context + '/' + surface + '/' + mfaRuntimeMode + '/' + totpEnabled, { ...base(surface, route, locale, theme), mfaRuntimeMode, security: { totpEnabled } })
      }
    }
    for (const audience of ['xpanel', 'xwhm', 'xmail']) {
      const login = { audience, targetSurface: audience, username: audience === 'xmail' ? 'mailbox@example.test' : account.username, publicOrigin: 'https://' + audience + '.example.test:2083' }
      const state = { surface: 'login', activeRoute: '/login', locale, theme, mfaRuntimeMode: 'optional', login, supportEmail: 'support@example.test' }
      add('login/normal/' + context + '/' + audience, state)
      add('login/development-mfa-disabled/' + context + '/' + audience, { ...state, mfaRuntimeMode: 'disabled' })
      add('login/error/' + context + '/' + audience, { ...state, login: { ...login, errorMessage: 'Synthetic sign-in error' } })
      add('login/locked/' + context + '/' + audience, { ...state, login: { ...login, lockout: { locked: true, lockedUntil: '2026-01-15T12:05:00.000Z', retryAfterSec: 300 } } })
      add('login/handoff-failed/' + context + '/' + audience, { ...state, login: { ...login, handoffFailed: true } })
      add('login/branded/' + context + '/' + audience, { ...state, branding })
    }
    for (const surface of ['xpanel', 'xwhm', 'xmail']) for (const status of [400, 403, 404, 421, 500, 503]) {
      const route = surface === 'xpanel' ? '/home' : surface === 'xwhm' ? '/whm' : '/mail/inbox'
      add('status/' + context + '/' + surface + '/' + status, { ...base(surface, route, locale, theme), error: { status, surface, notice: 'Synthetic status notice.' } })
    }
  }
  assert.equal(new Set(cases.map(row => row.key)).size, cases.length, 'Duplicate scenario')
  return { documents, canonicalCount: canonical.length, aliasCount: aliases.length, cases }
}

async function capture(root, helperSha256) {
  const sourceBefore = cleanSource(root)
  const actualDate = globalThis.Date
  const previousTz = process.env.TZ
  const fixtureMs = actualDate.parse(FIXTURE_AT)
  class FixtureDate extends actualDate {
    constructor(...args) { super(...(args.length ? args : [fixtureMs])) }
    static now() { return fixtureMs }
  }
  let result
  try {
    globalThis.Date = FixtureDate
    process.env.TZ = 'UTC'
    const load = path => import(pathToFileURL(join(root, path)).href)
    const [catalog, core, runtime, app, terminal] = await Promise.all([
      load('packages/catalog/src/index.ts'), load('packages/core/src/index.ts'), load('apps/web/src/ws-client.ts'),
      load('apps/web/src/app.ts'), load('apps/web/src/ops-terminal-client.ts'),
    ])
    const matrix = classicScenarios({ ...catalog, defaultPlan: core.defaultPlan, createInitialLiveEventState: runtime.createInitialLiveEventState })
    const documents = []
    for (const row of matrix.cases) {
      const direct = app.renderWebApp(structuredClone(row.state))
      assert.ok(direct.startsWith('<!doctype html>'), 'Invalid document for ' + row.key)
      const url = new URL(row.state.activeRoute, 'https://panel.example.test')
      url.searchParams.set('lang', row.state.locale)
      url.searchParams.set('theme', row.state.theme)
      url.searchParams.set('density', row.state.density ?? 'comfortable')
      const response = await app.serveWebUi(new Request(url), () => structuredClone(row.state))
      const httpBody = Buffer.from(await response.arrayBuffer())
      assert.equal(Buffer.from(direct).compare(httpBody), 0, 'Direct/HTTP output differs or is nondeterministic for ' + row.key)
      assert.equal(response.status, row.state.error?.status ?? 200, 'HTTP status differs for ' + row.key)
      documents.push({ key: row.key, bytes: httpBody.length, sha256: sha(httpBody), status: response.status, headers: [...response.headers].sort((a, b) => a[0].localeCompare(b[0])) })
    }
    const assetPaths = [
      '/favicon.ico', '/assets/favicon.svg', '/assets/favicon-xpanel.svg', '/assets/favicon-xwhm.svg', '/assets/favicon-xmail.svg',
      '/assets/login.js', '/assets/login-client.js', '/assets/ws.js', '/assets/ws-client.js', '/assets/tokens.css',
      '/assets/i18n-en.js', '/assets/i18n-ar.js', ...Object.values(terminal.TERMINAL_EMULATOR_PATHS),
      '/assets/unknown.js', '/assets/../private', '/assets/ws-client.js/extra',
    ]
    const assets = []
    const deniedAssets = new Set(['/assets/unknown.js', '/assets/../private', '/assets/ws-client.js/extra'])
    for (const path of [...new Set(assetPaths)].sort()) {
      const first = app.serveStaticAsset(path)
      const second = app.serveStaticAsset(path)
      assert.ok(first && second, 'Expected an asset response for ' + path)
      assert.equal(first.status, deniedAssets.has(path) ? 404 : 200, 'Unexpected asset status for ' + path)
      const body = Buffer.from(await first.arrayBuffer())
      assert.equal(body.compare(Buffer.from(await second.arrayBuffer())), 0, 'Nondeterministic asset: ' + path)
      assets.push({ path, bytes: body.length, sha256: sha(body), status: first.status, headers: [...first.headers].sort((a, b) => a[0].localeCompare(b[0])) })
    }
    for (const path of ['/api/auth/session', '/home', '/login'])
      assert.equal(app.serveStaticAsset(path), null, 'Asset handler captured a document/API route: ' + path)
    result = {
      schemaVersion: 1, purpose: 'classic-document-byte-equivalence', recipe: RECIPE, fixtureAt: FIXTURE_AT, helperSha256,
      environment: { node: process.versions.node, icu: process.versions.icu, platform: process.platform, arch: process.arch, locale: Intl.DateTimeFormat().resolvedOptions().locale, fixtureTimezone: 'UTC' },
      scenarioSha256: sha(json(matrix.cases)), canonicalCount: matrix.canonicalCount, aliasCount: matrix.aliasCount,
      registeredDocuments: matrix.documents, documents, assets,
    }
  } finally {
    globalThis.Date = actualDate
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
  const sourceAfter = cleanSource(root)
  assert.equal(json(sourceBefore), json(sourceAfter), 'Tracked source or HEAD changed during capture')
  return { ...result, source: sourceBefore, sourceUnchanged: true }
}

function differences(baseline, current) {
  for (const key of ['schemaVersion', 'purpose', 'recipe', 'fixtureAt', 'helperSha256', 'environment', 'scenarioSha256', 'canonicalCount', 'aliasCount', 'registeredDocuments'])
    assert.equal(json(baseline[key]), json(current[key]), 'Comparison inputs drifted: ' + key)
  assert.equal(baseline.sourceUnchanged, true, 'Baseline source was not frozen')
  const result = []
  for (const group of ['documents', 'assets']) {
    const key = group === 'documents' ? 'key' : 'path'
    const before = new Map(baseline[group].map(row => [row[key], row]))
    const after = new Map(current[group].map(row => [row[key], row]))
    assert.equal(json([...before.keys()]), json([...after.keys()]), 'Comparison cases drifted: ' + group)
    for (const [name, row] of before) {
      const next = after.get(name)
      for (const field of ['bytes', 'sha256', 'status', 'headers']) if (json(row[field]) !== json(next[field]))
        result.push({ group, key: name, field, before: row[field], after: next[field] })
    }
  }
  return result
}

async function main() {
  const mode = process.argv[2]
  assert.ok(mode === 'capture' || mode === 'compare', 'Usage: theme-classic-baseline.mjs capture|compare --output <ignored.json> --lock <shared-ignored-directory> [--baseline <ignored.json> --baseline-sha256 <digest>]')
  const args = new Map()
  for (let i = 3; i < process.argv.length; i += 2) {
    const name = process.argv[i], value = process.argv[i + 1]
    assert.ok(['--output', '--lock', '--baseline', '--baseline-sha256'].includes(name) && value && !args.has(name), 'Invalid or duplicate option')
    args.set(name, value)
  }
  assert.equal(mode === 'compare', args.has('--baseline'), 'Compare requires one baseline; capture accepts none')
  assert.equal(mode === 'compare', args.has('--baseline-sha256'), 'Compare requires the original baseline digest')
  const root = realpathSync(git(process.cwd(), 'rev-parse', '--show-toplevel'))
  assert.equal(process.versions.node, readFileSync(join(root, '.node-version'), 'utf8').trim(), 'Use the pinned Node version')
  const output = outputPath(root, args.get('--output'))
  const baselinePath = mode === 'compare' ? outputPath(root, args.get('--baseline'), true) : undefined
  const baselineBytes = baselinePath ? readFileSync(baselinePath) : undefined
  if (baselineBytes) assert.equal(sha(baselineBytes), args.get('--baseline-sha256'), 'Baseline content differs from its recorded digest')
  const baseline = baselineBytes ? JSON.parse(baselineBytes.toString('utf8')) : undefined
  const lock = outputPath(root, args.get('--lock'))
  assert.notEqual(output, lock, 'Output and lock must be different paths')
  const disk = statfsSync(root, { bigint: true })
  assert.ok(Number(disk.bavail) / Number(disk.blocks) >= 0.03, 'Free disk is below 3%; no capture was started')
  const helperSha256 = sha(readFileSync(new URL(import.meta.url)))
  const owner = json({ pid: process.pid, helperSha256, startedAt: new Date().toISOString() })
  mkdirSync(lock)
  const ownerPath = join(lock, 'owner.json')
  try {
    writeFileSync(ownerPath, owner, { flag: 'wx', mode: 0o600 })
    const startedAt = new Date().toISOString()
    const snapshot = await capture(root, helperSha256)
    const completedAt = new Date().toISOString()
    if (baselinePath) assert.equal(sha(readFileSync(baselinePath)), sha(baselineBytes), 'Baseline changed during comparison')
    const changed = baseline ? differences(baseline, snapshot) : []
    const report = {
      ...snapshot, startedAt, completedAt,
      ...(baseline ? { baselineSha256: sha(baselineBytes), baselineSource: baseline.source, differences: changed, equivalent: changed.length === 0 } : {}),
    }
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ mode, sourceHead: snapshot.source.head, canonical: snapshot.canonicalCount, aliases: snapshot.aliasCount, cases: snapshot.documents.length, assets: snapshot.assets.length, differences: changed.length, reportSha256: sha(readFileSync(output)) }))
    if (changed.length) process.exitCode = 1
  } finally {
    // Uncertain ownership leaves the lock in place for the job owner to inspect.
    if (existsSync(ownerPath) && readFileSync(ownerPath, 'utf8') === owner && readdirSync(lock).length === 1) {
      unlinkSync(ownerPath)
      rmdirSync(lock)
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Classic baseline failed'); process.exitCode = 1 })
