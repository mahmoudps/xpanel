import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, isXpanelError } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import { buildTar } from '../../../packages/lifecycle/src/testing/tar.ts'
import { cpmoveEntries } from '../../../packages/lifecycle/src/testing/cpanel-fixture.ts'
import { countPersistedActiveTransfers, createTransferWorkspaceRoutes, TRANSFER_ARCHIVE_REVIEW_MAX_BYTES } from './transfer-workspace.ts'
import type { TransferWorkspacePorts } from './transfer-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

// Actual loopback HTTP and StateStore writer leases; authentication/discovery/execution ports are
// explicit synthetic test adapters. These tests do not qualify a remote source or native import.
const cleanup: Array<() => Promise<unknown>> = []
const auth = () => ({ kind: 'ssh-key', host: 'source.example.test', port: 22, user: 'root', keyId: randomUUID(), hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43) })
const discovered = () => ({ source: { hostname: 'source.example.test', version: '1.4.2' }, accounts: [{ username: 'alice', uid: 20001, primaryDomain: 'alice.example.test', domains: ['alice.example.test'], plan: 'gold', diskBytes: 64, databases: [], mailboxes: 0, phpVersions: ['8.3'] }], plans: [{ name: 'gold' }] })
const fixture = async (ports: TransferWorkspacePorts = {}) => {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const audits: string[] = []
  let revokeNext = false
  const helpers = {
    store: state.store,
    requireCaller: async (req: Request) => {
      const token = req.headers.get('authorization')
      if (!token || token === 'Bearer revoked' || revokeNext) return fail('UNAUTHENTICATED', 'synthetic credential refused')
      return { principal: { kind: token === 'Bearer owner' ? 'user' : 'root', id: 'synthetic-principal', username: 'synthetic-root', accountId: 'synthetic-account' } } as unknown as AuthenticatedCaller
    },
    assertRoot: async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
    emitAudit: async (input: { action: string }) => { audits.push(input.action) },
  } as Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'assertRoot' | 'emitAudit'>
  let handle = createTransferWorkspaceRoutes(helpers, ports)
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    try {
      const url = new URL(incoming.url ?? '/', 'http://localhost')
      const body = Buffer.concat(chunks), req = new Request(url, { method: incoming.method, headers: incoming.headers as HeadersInit, ...(body.length ? { body: body.toString('utf8') } : {}) })
      const response = await handle(req, url, incoming.method ?? 'GET') ?? new Response('not found', { status: 404 })
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text())
    } catch (error) {
      const code = isXpanelError(error) ? error.code : 'INTERNAL'
      const statuses: Record<string, number> = { VALIDATION: 422, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PRECONDITION_FAILED: 412 }
      outgoing.writeHead(statuses[code] ?? 500, { 'content-type': 'application/problem+json' }); outgoing.end(JSON.stringify({ code, status: statuses[code] ?? 500, details: isXpanelError(error) ? error.detail : {} }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeIdleConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback address unavailable')
  const request = (path = '/api/transfers/sessions', method = 'GET', body?: unknown, token: string | null = 'root') => fetch('http://127.0.0.1:' + address.port + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const bytes = () => readFile(join(state.rootDir, 'extended', 'transfers', 'workspace.json'), 'utf8').catch(() => '')
  const create = async () => { const response = await request(undefined, 'POST', { auth: auth() }); expect(response.status).toBe(201); return response.json() as Promise<{ session: { id: string; state: string; selection: unknown; local: unknown }; revision: string; digest: string | null }> }
  const patch = async (current: Awaited<ReturnType<typeof create>>, action: string, input: Record<string, unknown> = {}) => request('/api/transfers/sessions/' + current.session.id, 'PATCH', { action, expectedRevision: current.revision, ...input })
  const step = async (current: Awaited<ReturnType<typeof create>>, action: string, input: Record<string, unknown> = {}) => { const response = await patch(current, action, input); expect(response.status).toBe(200); return response.json() as ReturnType<typeof create> }
  return { state, audits, request, bytes, create, patch, step, restart: () => { handle = createTransferWorkspaceRoutes(helpers, ports) }, revoke: () => { revokeNext = true } }
}

describe('strict persisted transfer workspace loopback boundary', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => { vi.restoreAllMocks(); const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close())); const errors = results.filter(result => result.status === 'rejected').map(result => result.reason); if (errors.length) throw new AggregateError(errors, 'transfer fixture cleanup failed') })

  it('reads empty state without inventing a source or allocating metadata', async () => {
    const response = await f.request()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sessions: [], archiveReviews: [], capabilities: { discover: false, execute: false, archiveReview: true } })
    expect(await countPersistedActiveTransfers(f.state.store)).toBe(0)
    expect(await f.bytes()).toBe('')
  })
  it('reads upgrade activity from the durable session predicate across restart without allocating on read', async () => {
    f = await fixture({ discover: async () => discovered() })
    let current = await f.create()
    expect(await countPersistedActiveTransfers(f.state.store)).toBe(0)
    current = await f.step(current, 'discover')
    const observed = await f.bytes()
    expect(await countPersistedActiveTransfers(f.state.store)).toBe(1)
    f.restart()
    expect(await countPersistedActiveTransfers(f.state.store)).toBe(1)
    expect(await f.bytes()).toBe(observed)
    await f.step(current, 'cancel')
    const cancelled = await f.bytes()
    expect(await countPersistedActiveTransfers(f.state.store)).toBe(0)
    expect(await f.bytes()).toBe(cancelled)
  })
  it('refuses corrupt persisted activity instead of reporting no active transfers', async () => {
    await f.create()
    const document = JSON.parse(await f.bytes()) as { sessions: Array<{ events: unknown[] }> }
    document.sessions[0]!.events.push({ at: '2026-10-26T15:00:00.000Z', event: { type: 'complete' } })
    const corrupt = JSON.stringify(document)
    await writeFile(join(f.state.rootDir, 'extended', 'transfers', 'workspace.json'), corrupt)
    await expect(countPersistedActiveTransfers(f.state.store)).rejects.toThrow()
    expect(await f.bytes()).toBe(corrupt)
  })
  it.each([{}, { events: [{ type: 'complete' }] }, { auth: { ...auth(), privateKey: 'forbidden raw key' } }])('rejects invented/default auth and client event injection', async body => {
    expect((await f.request(undefined, 'POST', body)).status).toBe(422)
    expect(await f.bytes()).toBe('')
  })
  it('persists real draft metadata across route-factory restart and keeps the exact revision', async () => {
    const current = await f.create(), before = await f.bytes()
    expect(current.session.state).toBe('created'); expect(current.revision).toMatch(/^[0-9a-f]{64}$/)
    f.restart()
    const response = await f.request('/api/transfers/sessions/' + current.session.id)
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject(current)
    expect(await f.bytes()).toBe(before)
    expect(f.audits).toEqual(['transfer.session.created'])
  })
  it('allows exactly one concurrent action to consume a saved revision', async () => {
    const current = await f.create()
    const results = await Promise.all([f.patch(current, 'cancel'), f.patch(current, 'cancel')])
    expect(results.map(response => response.status).sort()).toEqual([200, 409])
    expect(f.audits.filter(action => action === 'transfer.session.cancel')).toHaveLength(1)
  })
  it('rejects browser-authored connection/completion and caller-authored local inventory', async () => {
    const current = await f.create(), before = await f.bytes()
    for (const [action, input] of [['connected', {}], ['complete', {}], ['select', { accounts: ['alice'], plans: ['gold'], local: { usernames: [] } }]] as const) expect((await f.patch(current, action, input)).status).toBe(422)
    expect(await f.bytes()).toBe(before)
    expect((await f.patch(current, 'discover')).status).toBe(412)
    expect((await f.patch(current, 'run', { digest: '0'.repeat(64) })).status).toBe(412)
    expect(await f.bytes()).toBe(before)
  })
  it('derives source observations from the trusted port and destination inventory from StateStore', async () => {
    f = await fixture({ discover: async () => discovered() })
    let current = await f.create()
    current = await f.step(current, 'discover')
    current = await f.step(current, 'select', { accounts: ['alice'], plans: ['gold'] })
    expect(current.session.local).toEqual({ usernames: [], domains: [], uids: [], plans: [] })
    current = await f.step(current, 'review')
    expect(current.session.state).toBe('reviewed'); expect(current.digest).toMatch(/^[0-9a-f]{64}$/)
    const before = await f.bytes(); expect((await f.patch(current, 'run', { digest: current.digest })).status).toBe(412); expect(await f.bytes()).toBe(before)
  })
  it('leaves reviewed state unchanged when native admission rejects execution', async () => {
    let runCalls = 0
    f = await fixture({ discover: async () => discovered(), execution: { admit: async () => fail('PRECONDITION_FAILED', 'synthetic native admission remains closed'), run: async () => { runCalls++ } } })
    let current = await f.create(); current = await f.step(current, 'discover'); current = await f.step(current, 'select', { accounts: ['alice'], plans: ['gold'] }); current = await f.step(current, 'review')
    const before = await f.bytes(); expect((await f.patch(current, 'run', { digest: current.digest })).status).toBe(412)
    expect(await f.bytes()).toBe(before); expect(runCalls).toBe(0)
  })
  it('keeps authentication and root authorization mandatory without exposing stored source details', async () => {
    const current = await f.create(), before = await f.bytes()
    expect((await f.request(undefined, 'GET', undefined, null)).status).toBe(401)
    expect((await f.request(undefined, 'GET', undefined, 'owner')).status).toBe(403)
    f.revoke(); expect((await f.patch(current, 'cancel')).status).toBe(401); expect(await f.bytes()).toBe(before)
  })
  it('reauthorizes after acquiring the actual writer lease', async () => {
    const current = await f.create(), before = await f.bytes(), lock = f.state.store.getWriterLock(), acquire = lock.acquire.bind(lock)
    vi.spyOn(lock, 'acquire').mockImplementationOnce(async () => { const lease = await acquire(); f.revoke(); return lease })
    expect((await f.patch(current, 'cancel')).status).toBe(401)
    expect(await f.bytes()).toBe(before)
  })
  it('accepts execution facts only from an admitted trusted runner', async () => {
    let admitted = 0, ran = 0
    f = await fixture({ discover: async () => discovered(), execution: { admit: async () => { admitted++ }, run: async (_caller, _session, _review, emit) => { ran++; await emit({ type: 'progress', account: 'alice', phase: 'exporting' }); await emit({ type: 'progress', account: 'alice', phase: 'done', bytes: 64 }) } } })
    let current = await f.create()
    expect((await f.patch(current, 'run', { digest: '0'.repeat(64) })).status).toBe(409); expect(admitted).toBe(0)
    current = await f.step(current, 'discover'); current = await f.step(current, 'select', { accounts: ['alice'], plans: ['gold'] }); current = await f.step(current, 'review')
    current = await f.step(current, 'run', { digest: current.digest })
    expect(current.session.state).toBe('completed'); expect(admitted).toBe(1); expect(ran).toBe(1)
    expect((current.session as unknown as { progress: unknown }).progress).toMatchObject({ alice: { phase: 'done', bytes: 64 } })
  })
  it('journals each runner stage and reports an interrupted run as unknown, keeping the stages already saved', async () => {
    f = await fixture({ discover: async () => discovered(), execution: { admit: async () => undefined, run: async (_caller, _session, _review, emit) => { await emit({ type: 'progress', account: 'alice', phase: 'exporting' }); throw new Error('host lost') } } })
    let current = await f.create(); current = await f.step(current, 'discover'); current = await f.step(current, 'select', { accounts: ['alice'], plans: ['gold'] }); current = await f.step(current, 'review')
    const response = await f.patch(current, 'run', { digest: current.digest })
    expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { unknownOutcome: true, verificationRequired: true } })
    const saved = await (await f.request('/api/transfers/sessions/' + current.session.id)).json() as { session: { state: string; progress: Record<string, { phase: string }> } }
    expect(saved.session).toMatchObject({ state: 'applying', progress: { alice: { phase: 'exporting' } } })
    expect((await f.patch(saved as never, 'cancel')).status).toBe(412)
  })
  it('parses actual cPanel bytes, drops credential material and saves a read-only review', async () => {
    const archive = await buildTar(cpmoveEntries(), { gzip: true })
    const response = await f.request('/api/transfers/cpanel-review', 'POST', { filename: 'cpmove-bob.tar.gz', archiveBase64: archive.toString('base64'), expectedSourceUsername: 'bob' })
    expect(response.status).toBe(201)
    const body = await response.json() as { archiveReview: { id: string; archiveRetained: boolean; nativeApplied: boolean; plan: { account: { username: string; passwordResetRequired: boolean }; certificates: unknown[]; databases: unknown[] } } }
    expect(body.archiveReview).toMatchObject({ archiveRetained: false, nativeApplied: false, plan: { account: { username: 'bob', passwordResetRequired: true } } })
    expect(JSON.stringify(body)).not.toContain('BEGIN PRIVATE KEY')
    expect(body.archiveReview.plan.databases.every(database => !Object.hasOwn(database as object, 'sql'))).toBe(true)
    expect(await f.state.store.listAccounts()).toEqual([])
    f.restart(); const listing = await (await f.request()).json() as { archiveReviews: Array<{ id: string }> }
    expect(listing.archiveReviews.some(review => review.id === body.archiveReview.id)).toBe(true)
    expect(f.audits).toContain('transfer.archive.reviewed')
  })
  it('rejects corrupt, foreign and oversized archives without account or document writes', async () => {
    const archive = await buildTar(cpmoveEntries(), { gzip: true })
    for (const body of [
      { filename: 'cpmove-bob.tar.gz', archiveBase64: archive.toString('base64'), expectedSourceUsername: 'victim' },
      { filename: 'corrupt.tar.gz', archiveBase64: Buffer.from('corrupt archive').toString('base64') },
      { filename: '../escape.tar.gz', archiveBase64: archive.toString('base64') },
      { filename: 'oversized.tar.gz', archiveBase64: Buffer.alloc(TRANSFER_ARCHIVE_REVIEW_MAX_BYTES + 1).toString('base64') },
    ]) { expect((await f.request('/api/transfers/cpanel-review', 'POST', body)).status).toBe(422); expect(await f.bytes()).toBe('') }
    expect(await f.state.store.listAccounts()).toEqual([])
  })
  it('refuses compressed expansion beyond the inspection budget without persisting a review', async () => {
    const entries = cpmoveEntries().filter(entry => !entry.name.includes('homedir/'))
    entries.push({ name: 'cpmove-bob/homedir/big.bin', type: 'file', content: Buffer.alloc(17 * 1024 * 1024) })
    const archive = await buildTar(entries, { gzip: true })
    expect(archive.length).toBeLessThan(TRANSFER_ARCHIVE_REVIEW_MAX_BYTES)
    expect((await f.request('/api/transfers/cpanel-review', 'POST', { filename: 'cpmove-bob.tar.gz', archiveBase64: archive.toString('base64') })).status).toBe(422)
    expect(await f.bytes()).toBe('')
  })
})
