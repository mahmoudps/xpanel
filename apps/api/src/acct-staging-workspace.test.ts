import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { handleStagingWorkspaceRoute, nextStagingRecords, readStagingRecords } from './acct-staging-workspace.ts'
type Ports = Parameters<typeof handleStagingWorkspaceRoute>[3]

const account = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice', status: 'active', planId: 'p', home: '/home/alice' } as unknown as Account
const DOMAIN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', REVISION = 'a'.repeat(64)
const domain = { id: DOMAIN_ID, accountId: account.id, name: 'alice.example.test', kind: 'primary', redirect: null, suspended: false } as unknown as Domain
const alias = { ...domain, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'alias.example.test', kind: 'alias' } as unknown as Domain
const owner = { principal: { kind: 'user', id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', username: 'alice', accountId: account.id }, sessionId: 's', apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
const context = { accountId: account.id, username: 'alice', domainId: DOMAIN_ID, domain: domain.name }
const side = { path: 'public_html', files: 3, bytes: 30, links: 0 }
const agentReplies: Record<string, unknown> = {
  inspect: { context, live: side, staging: { ...side, path: 'staging/alice.example.test', exists: false }, limits: {} },
  review: { context, live: side, staging: { ...side, path: 'staging/alice.example.test', exists: true }, rows: [{ path: 'index.html', change: 'change', bytes: 10 }], revision: REVISION, limits: {} },
  copy: { context, outcome: 'copied', counts: { files: 3, copied: 3, failed: 0, notAttempted: 0 }, verificationRequired: false },
  promote: { context, outcome: 'promoted', results: [], counts: { applied: 1, failed: 0, 'not-attempted': 0 }, revision: REVISION, verificationRequired: false },
  discard: { context, outcome: 'discarded', trashId: null, verificationRequired: false },
}
const setup = (reply: (op: string) => unknown = op => agentReplies[op], disabled: string[] = []) => {
  let saved: unknown = null
  const forwarded: { path: string; body?: unknown }[] = []
  const store = { getAccount: async () => account, listDomains: async () => [domain, alias], getPlan: async () => ({ featureListId: 'f' }), getFeatureList: async () => ({ disabled }) } as unknown as StateStore
  const ports: Ports = { store, requireCaller: vi.fn(async () => owner), readSaved: async () => saved, writeSaved: async (_id, value) => { saved = structuredClone(value) },
    callAgent: vi.fn(async (path, options) => { forwarded.push({ path, body: options.body }); return Response.json(reply(path.split('/').at(-1)!.length === 36 ? 'inspect' : path.split('/').at(-1)!)) }), now: () => new Date('2026-10-28T10:00:00.000Z') }
  return { ports, forwarded, saved: () => saved }
}
const call = async (ports: Ports, suffix = '', body?: unknown): Promise<any> => {
  const url = new URL('http://localhost/api/account/staging' + suffix), method = body === undefined ? 'GET' : 'POST'
  const response = await handleStagingWorkspaceRoute(new Request(url, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, method, ports)
  expect(response?.status).toBe(200)
  return response!.json()
}
const code = async (promise: Promise<unknown>): Promise<string> => promise.then(() => 'ok', (error: { code?: string }) => error.code ?? 'error')

describe('staging records', () => {
  it('reads only exact saved records and applies verified outcomes', () => {
    expect(readStagingRecords(null)).toEqual([])
    expect(readStagingRecords([{ domainId: DOMAIN_ID }])).toBeNull()
    const ready = nextStagingRecords([], 'copy', domain, 'copied', 3, 'alice', '2026-10-28T10:00:00.000Z')
    expect(ready).toEqual([{ domainId: DOMAIN_ID, domain: domain.name, state: 'ready', files: 3, createdAt: '2026-10-28T10:00:00.000Z', createdBy: 'alice', promotedAt: null }])
    expect(readStagingRecords(ready)).toEqual(ready)
    expect(nextStagingRecords(ready, 'promote', domain, 'promoted', 3, 'alice', '2026-10-28T11:00:00.000Z')[0]!.promotedAt).toBe('2026-10-28T11:00:00.000Z')
    expect(nextStagingRecords(ready, 'promote', domain, 'unknown', 3, 'alice', '2026-10-28T11:00:00.000Z')[0]!.state).toBe('unknown')
    expect(nextStagingRecords(ready, 'discard', domain, 'discarded', 0, 'alice', 'x')).toEqual([])
    expect(nextStagingRecords([], 'copy', domain, 'incomplete', 1, 'alice', 'x')[0]!.state).toBe('incomplete')
  })
})

describe('staging API', () => {
  it('lists stageable owned domains and runs copy, review, promote and discard with record CAS', async () => {
    const f = setup()
    const listed = await call(f.ports)
    expect(listed.domains).toEqual([{ id: DOMAIN_ID, name: domain.name, kind: 'primary' }])
    expect(listed.records).toEqual([])
    const copied = await call(f.ports, '/' + DOMAIN_ID + '/copy', { expectedRecordsRevision: listed.revision })
    expect(copied.records[0]).toMatchObject({ state: 'ready', files: 3 })
    expect(await code(call(f.ports, '/' + DOMAIN_ID + '/copy', { expectedRecordsRevision: listed.revision }))).toBe('CONFLICT')
    const reviewed = await call(f.ports, '/' + DOMAIN_ID + '/review', {})
    const promoted = await call(f.ports, '/' + DOMAIN_ID + '/promote', { expectedRevision: reviewed.revision, expectedRecordsRevision: copied.recordsRevision })
    expect(promoted.records[0].promotedAt).toBe('2026-10-28T10:00:00.000Z')
    expect(f.forwarded.at(-1)).toEqual({ path: '/accounts/alice/staging/' + DOMAIN_ID + '/promote', body: { expectedRevision: REVISION } })
    expect((await call(f.ports, '/' + DOMAIN_ID + '/discard', { expectedRecordsRevision: promoted.recordsRevision })).records).toEqual([])
    expect(f.ports.requireCaller).toHaveBeenCalled()
  })
  it('records an unverifiable host outcome as unknown and requires review', async () => {
    const f = setup(op => op === 'copy' ? { context, outcome: 'copied' } : agentReplies[op])
    const listed = await call(f.ports)
    const error = await call(f.ports, '/' + DOMAIN_ID + '/copy', { expectedRecordsRevision: listed.revision }).catch(failure => failure)
    expect(error).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, verificationRequired: true } })
    expect((f.saved() as { state: string }[])[0]!.state).toBe('unknown')
  })
  it('refuses aliases, extra fields, stale records, missing agent, other roles and a plan without the tool', async () => {
    const f = setup()
    const listed = await call(f.ports)
    expect(await code(call(f.ports, '/' + alias.id + '/copy', { expectedRecordsRevision: listed.revision }))).toBe('NOT_FOUND')
    expect(await code(call(f.ports, '/' + DOMAIN_ID + '/copy', { expectedRecordsRevision: listed.revision, path: 'x' }))).toBe('VALIDATION')
    expect(await code(call(f.ports, '/' + DOMAIN_ID + '/copy', { expectedRecordsRevision: 'b'.repeat(64) }))).toBe('CONFLICT')
    expect(await code(call(f.ports, '/' + DOMAIN_ID + '/promote', { expectedRevision: REVISION, expectedRecordsRevision: listed.revision }))).toBe('PRECONDITION_FAILED')
    expect(await code(call({ ...f.ports, callAgent: undefined }, '/' + DOMAIN_ID + '/review', {}))).toBe('PRECONDITION_FAILED')
    expect(await code(call({ ...f.ports, requireCaller: async () => ({ ...owner, principal: { kind: 'root', id: 'r', username: 'root' } }) as unknown as AuthenticatedCaller }))).toBe('FORBIDDEN')
    expect(await code(call(setup(undefined, ['site-staging']).ports))).toBe('FORBIDDEN')
    expect(f.forwarded).toEqual([])
  })
})
