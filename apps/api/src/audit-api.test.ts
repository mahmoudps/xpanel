import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultPlan, type AuditEntry } from '@xpanel/core'
import { createApiToken, createResellerPrincipal, createRootPrincipal, createSession, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { createApiApp } from './server.ts'
import { createDefaultWebRenderer } from './main.ts'
import { SESSION_COOKIE_NAME, sha256Hex } from './auth.ts'

const hash = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'

describe('authenticated audit query HTTP contract', () => {
  let database: Awaited<ReturnType<typeof createTestDb>>
  let state: Awaited<ReturnType<typeof createTestStateStore>>
  let app: ReturnType<typeof createApiApp>
  let rootToken: string, ownerToken: string, resellerToken: string, deniedToken: string, expiredToken: string
  let wanted: string, owned: string, delegated: string, foreign: string
  const principalIds = new Map<string, string>()
  const tokenFor = async (principalId: string, scopes = ['audit:read']) => {
    const raw = 'xp_' + randomUUID()
    const tokenHash = createHash('sha256').update(raw).digest('hex')
    await createApiToken(database.db, { principalId, name: 'Audit HTTP fixture', tokenHash, scopes, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    return { raw, tokenHash }
  }
  const add = async (at: string, actor: string, target: string, outcome: AuditEntry['outcome']) => {
    const [row] = await database.db.query<{ id: number }>(
      'INSERT INTO audit_log (at,actor,principal_id,ip,action,target,detail,outcome) VALUES ($1,$2,NULL,NULL,$3,$4,$5,$6) RETURNING id',
      [at, actor, 'account.test', target, '{}', outcome],
    )
    return String(row!.id)
  }
  const call = (query: Record<string, string> = {}, token?: string) => app.fetch(new Request('http://localhost/api/audit?' + new URLSearchParams(query), {
    headers: token ? { authorization: 'Bearer ' + token } : {},
  }))
  const entries = async (response: Response): Promise<AuditEntry[]> => {
    expect(response.status, await response.clone().text()).toBe(200)
    return (await response.json() as { entries: AuditEntry[] }).entries
  }

  beforeAll(async () => {
    database = await createTestDb(); state = await createTestStateStore()
    const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: hash, forcePasswordChange: false })
    rootToken = (await tokenFor(root.id)).raw
    deniedToken = (await tokenFor(root.id, ['accounts:read'])).raw
    const expired = await tokenFor(root.id); expiredToken = expired.raw
    await database.db.query('UPDATE api_tokens SET created_at=$1,expires_at=$2 WHERE token_hash=$3', [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 1000).toISOString(), expired.tokenHash])
    const feature = await state.store.createFeatureList({ name: 'Audit fixture', ownerId: null, disabled: [] })
    const { id: _id, ...seed } = defaultPlan({ name: 'Audit fixture plan', featureListId: feature.id })
    const plan = await state.store.createPlan(seed)
    await state.store.saveServerIp({ address: '192.0.2.42', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const reseller = await state.store.createReseller({ username: 'reseller7', passwordHash: hash, acl: ['list-accounts'], maxAccounts: 10, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] })
    const resellerPrincipal = await createResellerPrincipal(database.db, { id: reseller.id, username: reseller.username, passwordHash: hash })
    resellerToken = (await tokenFor(resellerPrincipal.id)).raw
    const php = { version: '8.3' as const, handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
    for (const [username, ownerId] of [['owner7', null], ['child7', reseller.id], ['owner70', null], ['child70', null]] as const) {
      const account = await state.store.createAccount({ username, passwordHash: hash, primaryDomain: username + '.example.test', planId: plan.id, ownerId, contactEmail: 'fixture@example.test', ipv4: '192.0.2.42', shell: 'none', php })
      const principal = await createUserPrincipal(database.db, { username, accountId: account.id, passwordHash: hash })
      principalIds.set(username, principal.id)
      if (username === 'owner7') ownerToken = (await tokenFor(principal.id)).raw
    }
    // Read fixtures only, without audit-write or durable-chain assertions.
    wanted = await add('2026-10-25T00:00:00.000Z', 'root', 'account:owner7', 'failed')
    for (let i = 0; i < 60; i++) await add('2026-10-25T00:30:00.000Z', 'root', 'server:fixture', 'ok')
    owned = await add('2026-10-25T01:00:00Z', 'owner7', 'account:owner7', 'denied')
    delegated = await add('2026-10-25T01:00:00.000Z', 'child7', 'account:child7', 'denied')
    foreign = await add('2026-10-25T01:00:00.000Z', 'other7', 'account:other7', 'denied')
    app = createApiApp({ db: database.db, store: state.store, serverSecret: 'audit-http-fixture-secret-at-least-32-bytes' })
  })
  afterAll(async () => { await state?.close(); await database?.close() })

  it('filters outcome and inclusive UTC dates before applying a one-row page', async () => {
    expect((await entries(await call({ outcome: 'failed', from: '2026-10-25T00:00', to: '2026-10-25T00:00', limit: '1' }, rootToken))).map(e => e.id)).toEqual([wanted])
    expect((await entries(await call({ actor: 'owner7', action: 'account.test', target: 'account:owner7', outcome: 'denied', from: '2026-10-25T01:00', to: '2026-10-25T04:00+03:00' }, rootToken))).map(e => e.id)).toEqual([owned])
  })

  it('retains descending exclusive keyset pagination with all filters', async () => {
    const query = { outcome: 'denied', from: '2026-10-25T01:00', to: '2026-10-25T01:00', limit: '1' }
    expect((await entries(await call(query, rootToken))).map(e => e.id)).toEqual([foreign])
    expect((await entries(await call({ ...query, before: foreign }, rootToken))).map(e => e.id)).toEqual([delegated])
    expect((await entries(await call({ ...query, before: delegated }, rootToken))).map(e => e.id)).toEqual([owned])
  })

  it('keeps owner and reseller visibility scoped after filtering', async () => {
    expect((await entries(await call({ outcome: 'denied' }, ownerToken))).map(e => e.id)).toEqual([owned])
    expect((await entries(await call({ outcome: 'denied' }, resellerToken))).map(e => e.id)).toEqual([delegated])
    expect(await entries(await call({ actor: 'other7', outcome: 'denied' }, ownerToken))).toEqual([])
    expect(await entries(await call({ target: 'account:owner7', outcome: 'failed' }, resellerToken))).toEqual([])
  })

  const invalidQueryCases: Record<string, string>[] = [
    { from: '2026-02-30T00:00' }, { from: '2026-10-26T00:00', to: '2026-10-25T00:00' },
    { outcome: 'success' }, { limit: '0' }, { before: 'invalid' },
    { from: "2026-10-25T00:00Z' OR 1=1 --" },
  ]
  it.each(invalidQueryCases)('returns HTTP 400 Problem Details for invalid query %j', async query => {
    const response = await call(query, rootToken)
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.json()).toMatchObject({ code: 'VALIDATION', status: 400 })
  })

  it('requires an authenticated, unexpired caller with audit read scope before parsing filters', async () => {
    expect((await call({ from: 'invalid' })).status).toBe(401)
    expect((await call({}, expiredToken)).status).toBe(401)
    expect((await call({ from: 'invalid' }, deniedToken)).status).toBe(403)
  })

  it('does not interpret actor/target SQL syntax as a query', async () => {
    expect(await entries(await call({ actor: "root' OR 1=1 --" }, rootToken))).toEqual([])
    expect(await entries(await call({ target: "account:owner7' OR 1=1 --" }, rootToken))).toEqual([])
  })

  it.each([
    { username: 'owner7', unrelated: 'owner70', role: 'owner' },
    { username: 'child7', unrelated: 'child70', role: 'reseller' },
  ])('restricts $role account targets to the full $username segment', async ({ username, unrelated, role }) => {
    const at = role === 'owner' ? '2026-10-25T05:00:00.000Z' : '2026-10-25T06:00:00.000Z'
    const validTargets = [
      `account:${username}`,
      `account:${username}:git:example`,
      `account:${username}:cache`,
      `account:${username}:container:web`,
      `account:${username}:app:node`,
      `account:${username}:/public_html/index.php`,
    ]
    const excludedTargets = [
      `account:${unrelated}`,
      `account:${unrelated}:git:example`,
      `account:${username}evil`,
      `account:${username}.example`,
      `prefix:account:${username}`,
      `notaccount:${username}:cache`,
    ]
    const allowed: string[] = []
    // Actor root isolates target authorization from the intentional exact-actor grant.
    for (const target of validTargets) allowed.push(await add(at, 'root', target, 'failed'))
    for (const target of excludedTargets) await add(at, 'root', target, 'failed')
    const token = role === 'owner' ? ownerToken : resellerToken
    const listed = await entries(await call({ outcome: 'failed', from: at, to: at }, token))
    expect(listed.map(entry => entry.id)).toEqual(allowed.reverse())
    expect(listed.map(entry => entry.target).sort()).toEqual([...validTargets].sort())
    const all = await entries(await call({ outcome: 'failed', from: at, to: at }, rootToken))
    expect(all).toHaveLength(validTargets.length + excludedTargets.length)
    expect(all.some(entry => entry.target === `account:${unrelated}`)).toBe(true)
  })


  it('preserves the exact actor visibility grants for owners, resellers and delegated accounts', async () => {
    const at = '2026-10-25T07:00:00.000Z'
    const ownerEntry = await add(at, 'owner7', 'server:owner-actor-grant', 'ok')
    const resellerEntry = await add(at, 'reseller7', 'server:reseller-actor-grant', 'ok')
    const childEntry = await add(at, 'child7', 'server:child-actor-grant', 'ok')
    await add(at, 'owner70', 'server:unrelated-owner-actor', 'ok')
    await add(at, 'child70', 'server:unrelated-child-actor', 'ok')
    expect((await entries(await call({ from: at, to: at }, ownerToken))).map(entry => entry.id)).toEqual([ownerEntry])
    expect((await entries(await call({ from: at, to: at }, resellerToken))).map(entry => entry.id)).toEqual([childEntry, resellerEntry])
  })

  it.each(['owner7', 'child7'])('does not expose sibling-prefix audit activity in the authenticated %s home HTML', async username => {
    const at = '2026-10-25T08:00:00.000Z'
    const ownMarker = `${username}-owned-scope-marker`
    const actorMarker = `${username}-actor-scope-marker`
    const siblingMarker = `${username}0-private-scope-marker`
    const embeddedMarker = `${username}-embedded-private-marker`
    await add(at, 'root', `account:${username}:git:${ownMarker}`, 'ok')
    await add(at, username, `server:${actorMarker}`, 'ok')
    await add(at, 'root', `account:${username}0:git:${siblingMarker}`, 'ok')
    await add(at, 'root', `prefix:account:${username}:${embeddedMarker}`, 'ok')
    const raw = 'audit-home-scope-' + randomUUID()
    await createSession(database.db, { principalId: principalIds.get(username)!, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + 60_000).toISOString(), mfaVerified: true })
    const renderer = await createDefaultWebRenderer({ db: database.db, store: state.store, serverSecret: 'audit-http-fixture-secret-at-least-32-bytes' })
    const response = await renderer(new Request('http://localhost/panel?lang=en', { headers: { cookie: `${SESSION_COOKIE_NAME}=${raw}` } }))
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('data-board-port="xpanel-home"')
    expect(html).toContain(ownMarker)
    expect(html).toContain(actorMarker)
    expect(html).not.toContain(siblingMarker)
    expect(html).not.toContain(embeddedMarker)
  })

})
