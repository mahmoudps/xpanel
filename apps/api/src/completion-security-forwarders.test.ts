import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiToken, createTestDb, createUserPrincipal } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'

const fixture = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  const features = await state.store.createFeatureList({ name: 'Forwarder policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Forwarder plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 10, forwarders: 2, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const accounts = []
  for (const username of ['owner7', 'other7']) accounts.push(await state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } }))
  const [owner, other] = accounts
  const principal = await createUserPrincipal(database.db, { username: owner!.username, accountId: owner!.id, passwordHash: HASH })
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: 'forwarder-synthetic-server-secret-at-least-32-bytes' })
  const token = async (scopes: string[]) => {
    const raw = `xp_${randomUUID()}`
    await createApiToken(database.db, { principalId: principal.id, name: 'Synthetic forwarder test', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const request = (raw: string, path: string, method = 'GET', body?: unknown) => app.fetch(new Request(`http://localhost${path}`, { method,
    headers: { authorization: `Bearer ${raw}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  return { database, state, features, owner: owner!, other: other!, token, request }
}

describe('forwarder configuration security acceptance with synthetic state', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let credential: string
  const route = '/api/mail/forwarders'
  const source = () => `team@${f.owner.primaryDomain}`
  beforeEach(async () => { f = await fixture(); credential = await f.token(['mail:read', 'mail:write']) })
  afterEach(async () => { await f.state.close(); await f.database.close() })
  const create = (body: unknown, raw = credential) => f.request(raw, route, 'POST', body)
  const records = async () => (await (await f.request(credential, route)).json() as { forwarders: unknown[] }).forwarders

  it('requires write scope even when the same token can read configuration', async () => {
    const raw = await f.token(['mail:read'])
    expect((await f.request(raw, route)).status).toBe(200)
    expect((await create({ sourceAddress: source(), destinations: ['out@example.test'] }, raw)).status).toBe(403)
    expect(await records()).toEqual([])
  })

  it('keeps saved configuration intact when a read-only token attempts removal', async () => {
    const created = await create({ sourceAddress: source(), destinations: ['out@example.test'] })
    expect(created.status).toBe(201)
    const receipt = await created.json() as { forwarder: { id: string; sourceAddress: string } }
    // no host agent in this fixture: the record is saved and truthfully pending
    expect(receipt).toMatchObject({ forwarder: { action: 'forward', application: { state: 'pending', reason: expect.stringContaining('not applied') } }, revision: expect.any(Number) })
    const { forwarder } = receipt
    const raw = await f.token(['mail:read'])
    expect((await f.request(raw, `${route}/${forwarder.id}`, 'DELETE', {})).status).toBe(403)
    expect(await records()).toMatchObject([{ id: forwarder.id, sourceAddress: source() }])
    const removed = await f.request(credential, `${route}/${forwarder.id}`, 'DELETE', {})
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ ok: true, revision: expect.any(Number) })
    expect(await records()).toEqual([])
  })

  it.each([null, [], { csv: 42 }, { csv: 'a@example.test,b@example.test', kind: 'invalid' }, { csv: 'a@example.test,b@example.test', accountId: 42 }])('rejects malformed CSV request primitives before writes: %j', async body => {
    expect((await f.request(credential, '/api/mail/import-csv', 'POST', body)).status).toBe(422)
    expect(await records()).toEqual([])
  })

  it('preserves both independently saved records when CSV and POST run concurrently', async () => {
    const domain = f.owner.primaryDomain
    const responses = await Promise.all([
      create({ sourceAddress: `direct@${domain}`, destinations: ['out@example.test'] }),
      f.request(credential, '/api/mail/import-csv', 'POST', { kind: 'forwarders', accountId: f.owner.id, csv: `imported@${domain},out@example.test` }),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200, 201])
    const saved = await records() as { sourceAddress: string }[]
    expect(saved.map(record => record.sourceAddress).sort()).toEqual([`direct@${domain}`, `imported@${domain}`])
  })
  it('canonicalizes addresses and rejects duplicate sources without overwriting the original', async () => {
    const created = await create({ sourceAddress: `  ${source().toUpperCase()}  `, destinations: ['OUT@example.test', 'out@EXAMPLE.test'] })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ forwarder: { sourceAddress: source(), destinations: ['out@example.test'], application: { state: 'pending', reason: expect.stringContaining('not applied') } } })
    expect((await create({ sourceAddress: source().toUpperCase(), destinations: ['replacement@example.test'] })).status).toBe(409)
    expect(await records()).toMatchObject([{ sourceAddress: source(), destinations: ['out@example.test'] }])
    const listed = await f.request(credential, route)
    expect(await listed.json()).toMatchObject({ forwarders: [{ application: { state: 'pending', reason: expect.stringContaining('not applied') } }], generationId: null })
  })

  it('rejects direct self-forwarding before changing saved configuration', async () => {
    expect((await create({ sourceAddress: source(), destinations: [source().toUpperCase()] })).status).toBe(422)
    expect(await records()).toEqual([])
  })

  it('enforces the account plan cap without removing existing forwarders', async () => {
    for (const local of ['first', 'second']) expect((await create({ sourceAddress: `${local}@${f.owner.primaryDomain}`, destinations: ['out@example.test'] })).status).toBe(201)
    expect((await create({ sourceAddress: `third@${f.owner.primaryDomain}`, destinations: ['out@example.test'] })).status).toBe(409)
    expect(await records()).toHaveLength(2)
  })

  it('serializes concurrent duplicate source creation without overwriting the saved record', async () => {
    const responses = await Promise.all(['first', 'second'].map(local => create({ sourceAddress: source(), destinations: [`${local}@example.test`] })))
    expect(responses.map(response => response.status).sort()).toEqual([201, 409])
    expect(await records()).toHaveLength(1)
  })

  it('rechecks the remaining plan capacity inside concurrent configuration mutations', async () => {
    expect((await create({ sourceAddress: source(), destinations: ['out@example.test'] })).status).toBe(201)
    const responses = await Promise.all(['first', 'second'].map(local => create({ sourceAddress: `${local}@${f.owner.primaryDomain}`, destinations: ['out@example.test'] })))
    expect(responses.map(response => response.status).sort()).toEqual([201, 409])
    expect(await records()).toHaveLength(2)
  })

  it('deletes only the authorized legacy source-alias record when another tenant has the same source', async () => {
    const foreign = { id: randomUUID(), accountId: f.other.id, sourceAddress: source(), destinations: ['foreign@example.test'], createdAt: new Date().toISOString() }
    const own = { ...foreign, id: randomUUID(), accountId: f.owner.id, destinations: ['owner@example.test'] }
    const path = join(f.state.rootDir, 'extended', 'mail', 'forwarders.json')
    await atomicWriteJson(path, [foreign, own])
    expect((await f.request(credential, `${route}/${foreign.id}`, 'DELETE', {})).status).toBe(404)
    expect((await f.request(credential, `${route}/${source()}`, 'DELETE', {})).status).toBe(200)
    expect(await records()).toEqual([])
    const { readFile } = await import('node:fs/promises')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([foreign])
  })

  it('rejects a foreign source and a supplied foreign account before persisting', async () => {
    for (const body of [
      { sourceAddress: `team@${f.other.primaryDomain}`, accountId: f.owner.id, destinations: ['out@example.test'] },
      { sourceAddress: source(), accountId: f.other.id, destinations: ['out@example.test'] },
    ]) expect([403, 404]).toContain((await create(body)).status)
    expect(await records()).toEqual([])
  })

  it('applies the same address, uniqueness and plan rules to forwarder CSV rows', async () => {
    const domain = f.owner.primaryDomain
    const response = await f.request(credential, '/api/mail/import-csv', 'POST', {
      kind: 'forwarders', accountId: f.owner.id,
      csv: ['source,destination', `TEAM@${domain.toUpperCase()},OUT@example.test`, `team@${domain},replacement@example.test`,
        `bad@${domain},|command`, `extra@${domain}@outside.example.test,out@example.test`, `self@${domain},SELF@${domain.toUpperCase()}`,
        `second@${domain},out@example.test`, `third@${domain},out@example.test`].join('\n'),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ summary: { forwardersImported: 2, errorCount: 5 }, application: { state: 'pending', revision: expect.any(Number) } })
    expect(await records()).toMatchObject([
      { sourceAddress: `team@${domain}`, destinations: ['out@example.test'] },
      { sourceAddress: `second@${domain}`, destinations: ['out@example.test'] },
    ])
  })

  it.each(['forwarders', 'auto'])('does not bypass a disabled forwarders feature through %s CSV import', async kind => {
    await f.state.store.updateFeatureList(f.features.id, { disabled: ['forwarders'] })
    const response = await f.request(credential, '/api/mail/import-csv', 'POST', {
      kind, accountId: f.owner.id, csv: `${source()},out@example.test`,
    })
    expect([200, 403]).toContain(response.status)
    if (response.status === 200) expect(await response.json()).toMatchObject({ summary: { forwardersImported: 0, errorCount: 1 } })
    await f.state.store.updateFeatureList(f.features.id, { disabled: [] })
    expect(await records()).toEqual([])
  })

  it('rejects a forbidden mixed CSV before creating an earlier mailbox row', async () => {
    await f.state.store.updateFeatureList(f.features.id, { disabled: ['forwarders'] })
    const before = (await f.state.store.readSnapshot()).serviceUsers
    const response = await f.request(credential, '/api/mail/import-csv', 'POST', {
      kind: 'auto', accountId: f.owner.id,
      csv: [`inbox@${f.owner.primaryDomain},SyntheticMailboxPassword!2026,100`, `${source()},out@example.test`].join('\n'),
    })
    expect(response.status).toBe(403)
    expect((await f.state.store.readSnapshot()).serviceUsers).toEqual(before)
    await f.state.store.updateFeatureList(f.features.id, { disabled: [] })
    expect(await records()).toEqual([])
  })

  it('rechecks plan policy when an already loaded workspace submits a mutation', async () => {
    expect((await f.request(credential, route)).status).toBe(200)
    await f.state.store.updateFeatureList(f.features.id, { disabled: ['forwarders'] })
    expect((await create({ sourceAddress: source(), destinations: ['out@example.test'] })).status).toBe(403)
    await f.state.store.updateFeatureList(f.features.id, { disabled: [] })
    expect(await records()).toEqual([])
  })

  it('rechecks account suspension before mutating saved mail configuration', async () => {
    expect((await f.request(credential, route)).status).toBe(200)
    await f.state.store.suspendAccount(f.owner.id, 'Synthetic acceptance hold')
    expect((await create({ sourceAddress: source(), destinations: ['out@example.test'] })).status).toBe(403)
    await f.state.store.unsuspendAccount(f.owner.id)
    expect(await records()).toEqual([])
  })

  it.each([
    { sourceAddress: 'team\n@owner7.example.test', destinations: ['out@example.test'] },
    { sourceAddress: 'team@owner7.example.test@outside.example.test', destinations: ['out@example.test'] },
    { sourceAddress: 'team name@owner7.example.test', destinations: ['out@example.test'] },
    { sourceAddress: 'team@owner7.example.test', destinations: ['out@example.test\n|command'] },
    { sourceAddress: 'team@owner7.example.test', destinations: ['|command'] },
    { sourceAddress: 'team@owner7.example.test', destinations: [42] },
  ])('rejects malformed envelope values without changing configuration: %j', async body => {
    expect((await create(body)).status).toBe(422)
    expect(await records()).toEqual([])
  })
})
