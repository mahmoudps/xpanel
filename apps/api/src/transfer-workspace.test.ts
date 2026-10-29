import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, isXpanelError } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import { buildTar } from '../../../packages/lifecycle/src/testing/tar.ts'
import { cpmoveEntries } from '../../../packages/lifecycle/src/testing/cpanel-fixture.ts'
import { readCpanelArchive } from '@xpanel/lifecycle'
import { countPersistedActiveTransfers, createTransferWorkspaceRoutes } from './transfer-workspace.ts'
import type { CpanelImportPorts, TransferWorkspacePorts } from './transfer-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

// Actual loopback HTTP and StateStore writer leases; authentication/discovery/execution ports are
// explicit synthetic test adapters. These tests do not qualify a remote source or native import.
const cleanup: Array<() => Promise<unknown>> = []
const auth = () => ({ kind: 'ssh-key', host: 'source.example.test', port: 22, user: 'root', keyId: randomUUID(), hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43) })
const discovered = () => ({ source: { hostname: 'source.example.test', version: '1.4.2' }, accounts: [{ username: 'alice', uid: 20001, primaryDomain: 'alice.example.test', domains: ['alice.example.test'], plan: 'gold', diskBytes: 64, databases: [], mailboxes: 0, phpVersions: ['8.3'] }], plans: [{ name: 'gold' }] })
const PLAN_ID = randomUUID()
const rootCaller = { principal: { kind: 'root', id: 'synthetic-principal', username: 'synthetic-root' } } as unknown as AuthenticatedCaller
const background: TransferWorkspacePorts = { callerFor: async () => rootCaller }
/** Synthetic host tasks: inspect parses the uploaded bytes with the real reader, fetch reports a fetched archive. */
const cpanelPorts = () => {
  const tasks: Record<string, unknown>[] = [], applied: string[] = [], byId = new Map<string, Record<string, unknown>>()
  const box = { failApply: false }
  const uploadDir = join(tmpdir(), 'xp-cpanel-' + randomUUID())
  cleanup.push(() => rm(uploadDir, { recursive: true, force: true }))
  const ports: CpanelImportPorts = {
    uploadDir, maxBytes: 512 * 1024,
    startTask: async (_caller, body) => { const id = randomUUID(); tasks.push(body); byId.set(id, body); return id },
    readTask: async (_caller, id) => {
      const body = byId.get(id)!
      if (body.kind === 'cpanel-fetch') return { state: 'succeeded', result: { archive: id, bytes: 10, sha256: 'f'.repeat(64) }, error: null }
      const bytes = await readFile(join(uploadDir, String(body.archive) + '.tar.gz')).catch(() => null)
      if (!bytes) return { state: 'running', result: null, error: null }
      const plan = await readCpanelArchive((async function* () { yield bytes })(), { now: new Date('2027-01-01T00:00:00Z') })
      return { state: 'succeeded', result: { archive: body.archive, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), plan: JSON.parse(JSON.stringify(plan)) }, error: null }
    },
    apply: async (_caller, _record, input) => { applied.push(input.planId); if (box.failApply) fail('PRECONDITION_FAILED', 'synthetic import failure; the partial account was removed'); return { username: 'bob' } },
    recover: async () => false,
    discard: async (_caller, record) => { await rm(join(uploadDir, record.id + '.tar.gz'), { force: true }) },
    sshKey: async () => ({ publicKey: 'ssh-ed25519 AAAA xpanel-transfer', fingerprint: 'SHA256:key' }),
  }
  return { ports, tasks, applied, get failApply() { return box.failApply }, set failApply(value: boolean) { box.failApply = value } }
}
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
      const body = Buffer.concat(chunks), req = new Request(url, { method: incoming.method, headers: incoming.headers as HeadersInit, ...(body.length ? { body: new Uint8Array(body) } : {}) })
      const response = await handle(req, url, incoming.method ?? 'GET') ?? new Response('not found', { status: 404 })
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text())
    } catch (error) {
      const code = isXpanelError(error) ? error.code : 'INTERNAL'
      const statuses: Record<string, number> = { LIMIT_EXCEEDED: 413, VALIDATION: 422, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PRECONDITION_FAILED: 412 }
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
  const upload = async (archive: Buffer, filename = 'cpmove-bob.tar.gz', chunk = archive.length, from = 0) => {
    const created = await request('/api/transfers/cpanel-imports', 'POST', { filename, bytes: archive.length })
    if (created.status !== 201) return created
    const { cpanelImport } = await created.json() as { cpanelImport: { id: string } }
    let last = created
    for (let offset = from; offset < archive.length; offset += chunk) last = await request('/api/transfers/cpanel-imports/' + cpanelImport.id, 'PUT', { offset, data: archive.subarray(offset, offset + chunk).toString('base64') })
    return last
  }
  const poll = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
    for (let i = 0; i < 200; i++) { const value = await read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
    throw new Error('condition not reached')
  }
  type Saved = { session: Record<string, unknown> & { id: string; state: string; progress: Record<string, unknown>; selection: unknown; local: unknown }; revision: string; digest: string | null; results: Record<string, unknown>; running: boolean }
  const until = (id: string, done: (value: Saved) => boolean) => poll(async () => await (await request('/api/transfers/sessions/' + id)).json() as Saved, done)
  const untilImport = (id: string, done: (value: Record<string, unknown>) => boolean) => poll(async () => ((await (await request()).json()) as { cpanelImports: Record<string, unknown>[] }).cpanelImports.find(item => item.id === id)!, done)
  return { state, audits, request, bytes, create, patch, step, upload, until, untilImport, restart: () => { handle = createTransferWorkspaceRoutes(helpers, ports) }, revoke: () => { revokeNext = true } }
}

describe('strict persisted transfer workspace loopback boundary', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => { vi.restoreAllMocks(); const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close())); const errors = results.filter(result => result.status === 'rejected').map(result => result.reason); if (errors.length) throw new AggregateError(errors, 'transfer fixture cleanup failed') })

  it('reads empty state without inventing a source or allocating metadata', async () => {
    const response = await f.request()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sessions: [], cpanelImports: [], capabilities: { discover: false, execute: false, cpanelImport: false } })
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
    f = await fixture({ ...background, discover: async () => discovered(), execution: { admit: async () => fail('PRECONDITION_FAILED', 'synthetic native admission remains closed'), recover: async () => false, run: async () => { runCalls++ } } })
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
  it('runs an admitted review in the background, journals each account and reads back completion', async () => {
    let admitted = 0, ran = 0
    f = await fixture({ ...background, discover: async () => discovered(), execution: { admit: async () => { admitted++ }, recover: async () => false, run: async (_caller, _session, _review, emit) => { ran++; await emit({ type: 'progress', account: 'alice', phase: 'exporting' }); await emit({ type: 'progress', account: 'alice', phase: 'done', bytes: 64 }, { mailboxes: 2, rolledBack: false }) } } })
    let current = await f.create()
    expect((await f.patch(current, 'run', { digest: '0'.repeat(64) })).status).toBe(409); expect(admitted).toBe(0)
    current = await f.step(current, 'discover'); current = await f.step(current, 'select', { accounts: ['alice'], plans: ['gold'] }); current = await f.step(current, 'review')
    const started = await f.patch(current, 'run', { digest: current.digest })
    expect(started.status).toBe(202); expect(await started.json()).toMatchObject({ session: { state: 'applying' }, running: true })
    const done = await f.until(current.session.id, value => value.session.state === 'completed' && !value.running)
    expect(admitted).toBe(1); expect(ran).toBe(1)
    expect(done).toMatchObject({ session: { progress: { alice: { phase: 'done', bytes: 64 } } }, results: { alice: { mailboxes: 2, rolledBack: false } }, running: false })
    expect(f.audits).toEqual(expect.arrayContaining(['transfer.execution.started', 'transfer.execution.completed']))
  })
  it('stops after the current account and skips the rest', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    f = await fixture({ ...background, discover: async () => ({ ...discovered(), accounts: [...discovered().accounts, { ...discovered().accounts[0]!, username: 'bob', uid: 20002, primaryDomain: 'bob.example.test', domains: ['bob.example.test'] }] }),
      execution: { admit: async () => undefined, recover: async () => false, run: async (_caller, _session, review, emit, shouldStop) => {
        for (const account of review.accounts) { if (await shouldStop()) return; await emit({ type: 'progress', account: account.source, phase: 'exporting' }); await gate; await emit({ type: 'progress', account: account.source, phase: 'done' }) }
      } } })
    let current = await f.create(); current = await f.step(current, 'discover'); current = await f.step(current, 'select', { accounts: ['alice', 'bob'], plans: ['gold'] }); current = await f.step(current, 'review')
    expect((await f.patch(current, 'run', { digest: current.digest })).status).toBe(202)
    const running = await f.until(current.session.id, value => (value.session.progress as Record<string, { phase: string }>).alice?.phase === 'exporting')
    expect((await f.patch(running as never, 'cancel')).status).toBe(412)
    const stopped = await f.patch(running as never, 'stop'); expect(stopped.status).toBe(200); expect(await stopped.json()).toMatchObject({ stopRequested: true })
    release()
    const done = await f.until(current.session.id, value => value.session.state === 'cancelled' && !value.running)
    expect(done.session.progress).toMatchObject({ alice: { phase: 'done' }, bob: { phase: 'skipped' } })
  })
  it('records a failing runner as a failed transfer and keeps the stages already saved', async () => {
    f = await fixture({ ...background, discover: async () => discovered(), execution: { admit: async () => undefined, recover: async () => false, run: async (_caller, _session, _review, emit) => { await emit({ type: 'progress', account: 'alice', phase: 'exporting' }); throw new Error('host lost') } } })
    let current = await f.create(); current = await f.step(current, 'discover'); current = await f.step(current, 'select', { accounts: ['alice'], plans: ['gold'] }); current = await f.step(current, 'review')
    expect((await f.patch(current, 'run', { digest: current.digest })).status).toBe(202)
    const failed = await f.until(current.session.id, value => value.session.state === 'failed' && !value.running)
    expect(failed.session).toMatchObject({ progress: { alice: { phase: 'exporting' } }, error: expect.stringMatching(/stopped unexpectedly/) })
  })
  it('after a restart rolls back the account that was in flight and finishes the run', async () => {
    const recovered: string[] = []
    let hang = true
    f = await fixture({ ...background, discover: async () => discovered(), execution: { admit: async () => undefined, recover: async (_caller, progress) => { recovered.push(progress.targetUsername); return true },
      run: async (_caller, session, _review, emit) => { if (hang) { await emit({ type: 'progress', account: 'alice', phase: 'importing' }); await new Promise(() => undefined) } expect(session.progress.alice?.phase).toBe('failed') } } })
    let current = await f.create(); current = await f.step(current, 'discover'); current = await f.step(current, 'select', { accounts: ['alice'], plans: ['gold'] }); current = await f.step(current, 'review')
    expect((await f.patch(current, 'run', { digest: current.digest })).status).toBe(202)
    await f.until(current.session.id, value => (value.session.progress as Record<string, { phase: string }>).alice?.phase === 'importing')
    hang = false; f.restart()
    const done = await f.until(current.session.id, value => value.session.state === 'completed' && !value.running)
    expect(recovered).toEqual(['alice'])
    expect(done).toMatchObject({ session: { progress: { alice: { phase: 'failed', error: 'Interrupted by a restart; the partial account was removed.' } } }, results: { alice: { rolledBack: true } } })
  })
  it('streams an uploaded cPanel archive to disk, reviews it on the host and lists what is not imported', async () => {
    const cpanel = cpanelPorts()
    f = await fixture({ ...background, cpanel: cpanel.ports })
    const archive = await buildTar(cpmoveEntries(), { gzip: true })
    const uploaded = await f.upload(archive, 'cpmove-bob.tar.gz', 1000)
    expect(uploaded.status).toBe(200)
    const record = (await uploaded.json() as { cpanelImport: { id: string; state: string; sha256: string; bytes: number } }).cpanelImport
    expect(record).toMatchObject({ state: 'inspecting', bytes: archive.length })
    expect(createHash('sha256').update(await readFile(join(cpanel.ports.uploadDir, record.id + '.tar.gz'))).digest('hex')).toBe(record.sha256)
    expect(cpanel.tasks[0]).toEqual({ kind: 'cpanel-inspect', archive: record.id })
    const listing = await (await f.request()).json() as { cpanelImports: Array<Record<string, unknown>> }
    expect(listing.cpanelImports[0]).toMatchObject({ state: 'review', conflicts: [], plan: { account: { username: 'bob' } } })
    expect((listing.cpanelImports[0]!.unmapped as Array<{ tag: string; code: string }>).map(item => item.tag + ':' + item.code)).toEqual(expect.arrayContaining(['paused:cron-paused', 'reset:password-not-kept', 'skipped:forwarders-not-imported']))
    expect((await f.upload(Buffer.alloc(600 * 1024), 'big.tar.gz')).status).toBe(413)
    expect((await f.upload(archive, '../x.tar.gz')).status).toBe(422)
    expect((await f.upload(archive, 'cpmove-bob.tar.gz', 1000, 1000)).status).toBe(409)
  })
  it('imports a reviewed archive in the background and reports failure with the rollback outcome', async () => {
    const cpanel = cpanelPorts()
    f = await fixture({ ...background, cpanel: cpanel.ports })
    const archive = await buildTar(cpmoveEntries(), { gzip: true })
    const { cpanelImport } = await (await f.upload(archive)).json() as { cpanelImport: { id: string } }
    const reviewed = (await (await f.request()).json() as { cpanelImports: Array<{ id: string; revision: string }> }).cpanelImports[0]!
    expect((await f.request('/api/transfers/cpanel-imports/' + cpanelImport.id, 'PATCH', { action: 'import', expectedRevision: reviewed.revision })).status).toBe(422)
    const started = await f.request('/api/transfers/cpanel-imports/' + cpanelImport.id, 'PATCH', { action: 'import', expectedRevision: reviewed.revision, planId: PLAN_ID })
    expect(started.status).toBe(202)
    const imported = await f.untilImport(cpanelImport.id, value => value.state === 'imported' && !value.running)
    expect(imported).toMatchObject({ result: { username: 'bob' } }); expect(cpanel.applied).toEqual([PLAN_ID])
    cpanel.failApply = true
    const second = await (await f.upload(archive)).json() as { cpanelImport: { id: string } }
    const again = (await (await f.request()).json() as { cpanelImports: Array<{ id: string; revision: string }> }).cpanelImports.find(item => item.id === second.cpanelImport.id)!
    await f.request('/api/transfers/cpanel-imports/' + again.id, 'PATCH', { action: 'import', expectedRevision: again.revision, planId: PLAN_ID })
    expect(await f.untilImport(again.id, value => value.state === 'failed' && !value.running)).toMatchObject({ error: 'synthetic import failure; the partial account was removed' })
    const failed = (await (await f.request()).json() as { cpanelImports: Array<{ id: string; revision: string }> }).cpanelImports.find(item => item.id === again.id)!
    expect((await f.request('/api/transfers/cpanel-imports/' + again.id, 'PATCH', { action: 'discard', expectedRevision: failed.revision })).status).toBe(200)
    await expect(readFile(join(cpanel.ports.uploadDir, again.id + '.tar.gz'))).rejects.toThrow()
    expect(f.audits).toEqual(expect.arrayContaining(['transfer.cpanel.uploaded', 'transfer.cpanel.imported', 'transfer.cpanel.failed', 'transfer.cpanel.discarded']))
  })
  it('starts an SSH fetch from a cPanel source and inspects the fetched archive', async () => {
    const cpanel = cpanelPorts()
    f = await fixture({ ...background, cpanel: cpanel.ports })
    const response = await f.request('/api/transfers/cpanel-imports/ssh', 'POST', { host: 'cpanel.example.test', port: 22, hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43), cpanelUser: 'bob' })
    expect(response.status).toBe(201)
    expect(cpanel.tasks[0]).toEqual({ kind: 'cpanel-fetch', username: 'bob', host: 'cpanel.example.test', port: 22, hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43) })
    const listing = await (await f.request()).json() as { cpanelImports: Array<Record<string, unknown>> }
    expect(listing.cpanelImports[0]).toMatchObject({ origin: 'ssh', state: 'inspecting', sha256: 'f'.repeat(64) })
    expect((await (await f.request('/api/transfers/ssh-key')).json())).toEqual({ publicKey: 'ssh-ed25519 AAAA xpanel-transfer', fingerprint: 'SHA256:key' })
  })
})
