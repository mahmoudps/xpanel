import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { sha256Hex } from './auth.ts'
import { applyTeamRequest, handleTeamRoute, parseTeamRequest, readSavedTeam, teamMemberPhase, TEAM_LIMITS } from './acct-team-workspace.ts'
import type { TeamHelpers, TeamMember } from './acct-team-workspace.ts'

const PLAN = '33333333-3333-4333-8333-333333333333', LIST = '44444444-4444-4444-8444-444444444444'
const ALICE = { id: '55555555-5555-4555-8555-555555555555', username: 'alice', primaryDomain: 'alice.example', planId: PLAN, ownerId: null, status: 'active' }
const owner = { principal: { kind: 'user', id: 'p-alice', username: 'alice', accountId: ALICE.id }, sessionId: 'u-alice', apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
const NOW = new Date('2026-10-28T12:00:00.000Z'), STAMP = NOW.toISOString(), EMPTY = sha256Hex('null')
const member = (overrides: Partial<TeamMember> = {}): TeamMember => ({
  id: '77777777-7777-4777-8777-000000000001', username: 'sam', roles: ['email'], contactEmail: 'sam@alice.example', notes: '', expiresAt: null, expiryReason: null,
  status: 'active', suspendReason: null, createdAt: '2026-10-27T10:00:00.000Z', createdBy: 'alice', updatedAt: '2026-10-27T10:00:00.000Z', updatedBy: 'alice', ...overrides,
})
const fields = (overrides: Record<string, unknown> = {}) => ({ roles: ['database'], contactEmail: 'dev@alice.example', notes: 'Contractor', expiresAt: null, expiryReason: null, ...overrides })

const helpers = (initial: unknown = null, disabled: string[] = [], callers: AuthenticatedCaller[] = [owner]) => {
  let saved: unknown = initial, calls = 0
  const audits: Record<string, unknown>[] = []
  const store = {
    getAccount: vi.fn(async (id: string) => id === ALICE.id ? ALICE : null),
    getPlan: vi.fn(async () => ({ id: PLAN, featureListId: LIST })),
    getFeatureList: vi.fn(async () => ({ id: LIST, disabled })),
  }
  const h = {
    store, requireCaller: vi.fn(async () => callers[Math.min(calls++, callers.length - 1)]!),
    emitAudit: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry) }),
    readTeam: vi.fn(async () => saved === null ? null : JSON.parse(JSON.stringify(saved))),
    writeTeam: vi.fn(async (_id: string, value: unknown) => { saved = JSON.parse(JSON.stringify(value)); return value }),
    now: () => NOW,
  } as unknown as TeamHelpers
  return { h, audits, saved: () => saved }
}
const call = (method: string, h: TeamHelpers, path = '/api/account/team', body?: unknown) => {
  const url = new URL('http://localhost' + path)
  return handleTeamRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, h)
}

describe('team grammar', () => {
  it('accepts exact bodies and refuses unknown keys, bad names and bad expiry', () => {
    expect(parseTeamRequest('create', { expectedRevision: EMPTY, username: 'dev', ...fields() })).toMatchObject({ op: 'create', username: 'dev', fields: { roles: ['database'] } })
    expect(parseTeamRequest('create', { expectedRevision: EMPTY, username: 'dev', ...fields({ roles: ['web', 'email'] }) })).toMatchObject({ fields: { roles: ['email', 'web'] } })
    for (const body of [
      { expectedRevision: EMPTY, username: 'Dev', ...fields() },
      { expectedRevision: EMPTY, username: 'dev', ...fields(), password: 'x' },
      { expectedRevision: EMPTY, username: 'dev', ...fields({ roles: ['owner'] }) },
      { expectedRevision: EMPTY, username: 'dev', ...fields({ roles: ['email', 'email'] }) },
      { expectedRevision: EMPTY, username: 'dev', ...fields({ contactEmail: 'Dev@alice.example' }) },
      { expectedRevision: EMPTY, username: 'dev', ...fields({ notes: 'x'.repeat(101) }) },
      { expectedRevision: EMPTY, username: 'dev', ...fields({ expiresAt: '2026-12-31' }) },
      { expectedRevision: EMPTY, username: 'dev', ...fields({ expiryReason: 'no expiry' }) },
      { expectedRevision: 'x', username: 'dev', ...fields() },
    ]) expect(() => parseTeamRequest('create', body)).toThrow()
    expect(() => parseTeamRequest('suspend', { expectedRevision: EMPTY, reason: '' })).toThrow()
    expect(parseTeamRequest('delete', { expectedRevision: EMPTY, confirmUsername: 'sam' })).toEqual({ op: 'delete', expectedRevision: EMPTY, confirmUsername: 'sam' })
  })
  it('reads saved files strictly', () => {
    expect(readSavedTeam(null)).toEqual([])
    expect(readSavedTeam([member()])).toHaveLength(1)
    expect(readSavedTeam([member({ status: 'suspended', suspendReason: null })])).toBeNull()
    expect(readSavedTeam([member(), member()])).toBeNull()
    expect(readSavedTeam([{ ...member(), password: 'x' }])).toBeNull()
    expect(readSavedTeam(Array.from({ length: 8 }, (_, i) => member({ id: `77777777-7777-4777-8777-00000000000${i}`, username: 'u' + i })))).toBeNull()
  })
  it('computes phases', () => {
    expect(teamMemberPhase(member({ expiresAt: '2026-10-28T11:00:00.000Z', expiryReason: null }), NOW.getTime())).toBe('expired')
    expect(teamMemberPhase(member({ status: 'suspended', suspendReason: 'leave' }), NOW.getTime())).toBe('suspended')
  })
})

describe('team transitions', () => {
  const create = (username: string, roles: string[] = ['email']) => parseTeamRequest('create', { expectedRevision: EMPTY, username, ...fields({ roles }) })
  it('enforces the role-holder limit but not for role-less members', () => {
    let list: TeamMember[] = []
    for (let i = 0; i < TEAM_LIMITS.roleHolders; i++) list = applyTeamRequest(list, create('u' + i), undefined, 'alice', STAMP, `77777777-7777-4777-8777-00000000001${i}`).next
    expect(() => applyTeamRequest(list, create('extra'), undefined, 'alice', STAMP, '77777777-7777-4777-8777-000000000099')).toThrow(/at most 7/)
    expect(applyTeamRequest(list, create('viewer', []), undefined, 'alice', STAMP, '77777777-7777-4777-8777-000000000099').next).toHaveLength(8)
    const edit = parseTeamRequest('update', { expectedRevision: EMPTY, ...fields({ roles: ['web'] }) })
    expect(applyTeamRequest(list, edit, list[0]!.id, 'alice', STAMP, 'x').changed?.roles).toEqual(['web'])
  })
  it('suspends, reinstates and deletes with exact confirmation', () => {
    const list = [member()]
    const suspended = applyTeamRequest(list, parseTeamRequest('suspend', { expectedRevision: EMPTY, reason: 'On leave' }), list[0]!.id, 'alice', STAMP, 'x').next
    expect(suspended[0]).toMatchObject({ status: 'suspended', suspendReason: 'On leave' })
    expect(() => applyTeamRequest(suspended, parseTeamRequest('suspend', { expectedRevision: EMPTY, reason: 'again' }), list[0]!.id, 'alice', STAMP, 'x')).toThrow(/already/)
    expect(applyTeamRequest(suspended, parseTeamRequest('reinstate', { expectedRevision: EMPTY }), list[0]!.id, 'alice', STAMP, 'x').next[0]).toMatchObject({ status: 'active', suspendReason: null })
    expect(() => applyTeamRequest(list, parseTeamRequest('delete', { expectedRevision: EMPTY, confirmUsername: 'sammy' }), list[0]!.id, 'alice', STAMP, 'x')).toThrow(/exactly/)
    expect(applyTeamRequest(list, parseTeamRequest('delete', { expectedRevision: EMPTY, confirmUsername: 'sam' }), list[0]!.id, 'alice', STAMP, 'x').next).toEqual([])
    expect(() => applyTeamRequest(list, parseTeamRequest('reinstate', { expectedRevision: EMPTY }), '77777777-7777-4777-8777-0000000000ff', 'alice', STAMP, 'x')).toThrow(/not found/)
  })
  it('refuses an expiry in the past', () => {
    expect(() => applyTeamRequest([], parseTeamRequest('create', { expectedRevision: EMPTY, username: 'dev', ...fields({ expiresAt: '2026-10-01T00:00:00.000Z' }) }), undefined, 'alice', STAMP, 'x')).toThrow(/future/)
  })
})

describe('team route', () => {
  it('reads the default view with honest sign-in state', async () => {
    const { h } = helpers()
    const body = await (await call('GET', h))!.json() as Record<string, unknown>
    expect(body).toMatchObject({ state: 'default', revision: EMPTY, members: [], signIn: { available: false }, account: { username: 'alice', primaryDomain: 'alice.example' }, limits: { roleHolders: 7, roleHoldersUsed: 0 } })
  })
  it('issues no password link without team sign-in storage and refuses team callers', async () => {
    const { h } = helpers([member()])
    await expect(call('POST', h, '/api/account/team/' + member().id + '/password-link', { expectedRevision: sha256Hex(JSON.stringify([member()])) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const teamCaller = { ...owner, team: { kind: 'team', id: member().id, username: 'sam', login: 'sam@alice.example', accountId: ALICE.id, roles: ['administrator'] } } as AuthenticatedCaller
    await expect(call('GET', helpers(null, [], [teamCaller]).h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('creates with CAS, verifies the readback and audits', async () => {
    const { h, audits, saved } = helpers()
    const response = await call('POST', h, '/api/account/team', { expectedRevision: EMPTY, username: 'dev', ...fields() })
    expect(response!.status).toBe(201)
    const body = await response!.json() as { members: TeamMember[]; changed: string; revision: string }
    expect(body.members[0]).toMatchObject({ username: 'dev', roles: ['database'], phase: 'active', createdBy: 'alice', signIn: { password: 'not-set', linkExpiresAt: null, lastLoginAt: null } })
    expect(body.changed).toBe(body.members[0]!.id)
    expect(audits[0]).toMatchObject({ action: 'account.team.created', target: 'team-member:alice/dev', outcome: 'ok' })
    await expect(call('POST', h, '/api/account/team', { expectedRevision: EMPTY, username: 'dev2', ...fields() })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((saved() as unknown[]).length).toBe(1)
  })
  it('refuses disabled features, selectors, wrong methods and changed authority', async () => {
    await expect(call('GET', helpers(null, ['manage-team']).h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('GET', helpers().h, '/api/account/team?account=bob')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('PATCH', helpers().h))!.status).toBe(405)
    const other = { ...owner, sessionId: 'other' } as AuthenticatedCaller
    const { h, saved } = helpers(null, [], [owner, other])
    await expect(call('POST', h, '/api/account/team', { expectedRevision: EMPTY, username: 'dev', ...fields() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(saved()).toBeNull()
    const mailbox = { principal: { kind: 'root', id: 'r', username: 'root' }, sessionId: 's', apiTokenId: null } as unknown as AuthenticatedCaller
    await expect(call('GET', helpers(null, [], [mailbox]).h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('refuses to change an unreadable saved file and reports unverified writes', async () => {
    const bad = [{ id: 'x' }]
    await expect(call('POST', helpers(bad).h, '/api/account/team', { expectedRevision: sha256Hex(JSON.stringify(bad)), username: 'dev', ...fields() })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const { h } = helpers()
    ;(h as { writeTeam: unknown }).writeTeam = vi.fn(async () => { throw new Error('disk') })
    await expect(call('POST', h, '/api/account/team', { expectedRevision: EMPTY, username: 'dev', ...fields() })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true } })
  })
})
