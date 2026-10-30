import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { mailboxPrincipalUsername } from './mail/inbox.ts'
import {
  handleUiPreferencesRoute, parseUiPreferencesUpdate, readSavedUiPreferences, readUiPreferenceValue,
  uiPreferenceOwner, uiPreferencesRevision,
} from './ui-preferences.ts'
import type { UiPreferenceAuthority, UiPreferencesPorts, UiPreferencesRecord, UiPreferencesView } from './ui-preferences.ts'

const faults = vi.hoisted(() => ({ corruptAfterWrite: false }))
vi.mock('@xpanel/state', async importOriginal => {
  const actual = await importOriginal<typeof import('@xpanel/state')>()
  return { ...actual, atomicWriteJson: async (...args: Parameters<typeof actual.atomicWriteJson>) => {
    await actual.atomicWriteJson(...args)
    if (faults.corruptAfterWrite) await writeFile(args[0], '{}')
  } }
})

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const MEMBER_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_MEMBER_ID = '44444444-4444-4444-8444-444444444444'
const SERVICE_ID = '55555555-5555-4555-8555-555555555555'
const OTHER_SERVICE_ID = '66666666-6666-4666-8666-666666666666'
const ROOT_ID = '77777777-7777-4777-8777-777777777777'
const stamp = '2026-10-29T20:00:00.000Z'
const config = { choices: ['classic', 'v2'], defaultUiTheme: 'classic' } as const
const caller = (principal: AuthenticatedCaller['principal'], options: Partial<AuthenticatedCaller> = {}): AuthenticatedCaller => ({
  principal, sessionId: 'session', apiTokenId: null, ...options,
}) as AuthenticatedCaller
const OWNER: UiPreferenceAuthority = { surface: 'xpanel', caller: caller({ kind: 'user', id: OWNER_ID, username: 'alice', accountId: ACCOUNT_ID }) }
const ROOT: UiPreferenceAuthority = { surface: 'xwhm', caller: caller({ kind: 'root', id: ROOT_ID, username: 'root' }) }
const TEAM: UiPreferenceAuthority = { ...OWNER, caller: { ...OWNER.caller, team: {
  kind: 'team', id: MEMBER_ID, accountId: ACCOUNT_ID, username: 'bob', login: 'bob@example.test', roles: ['web'],
} } }
const OTHER_TEAM: UiPreferenceAuthority = { ...TEAM, caller: { ...TEAM.caller, team: { ...TEAM.caller.team!, id: OTHER_MEMBER_ID, username: 'carol' } } }
const MAIL: UiPreferenceAuthority = { surface: 'xmail', caller: caller({ kind: 'user', id: OWNER_ID, username: 'mail@example.test', accountId: ACCOUNT_ID }),
  mailbox: { sessionId: 'session', accountId: ACCOUNT_ID, serviceUserId: SERVICE_ID, mailbox: 'mail@example.test' } }
let root = ''
const file = (authority = OWNER): string => {
  const owner = uiPreferenceOwner(authority)
  return join(root, 'extended', 'ui-preferences', authority.surface, owner.kind, createHash('sha256').update(JSON.stringify(owner)).digest('hex') + '.json')
}
const record = (authority = OWNER, uiTheme = 'v2'): UiPreferencesRecord => ({ schema: 1, surface: authority.surface, owner: uiPreferenceOwner(authority), uiTheme, updatedAt: stamp })
const write = async (raw: unknown, authority = OWNER): Promise<void> => { const path = file(authority); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(raw)) }

function harness(authority = OWNER, overrides: Partial<UiPreferencesPorts> = {}) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const ports = { ...config, open: vi.fn(async () => authority), emitAudit: vi.fn(async () => undefined), now: () => new Date(stamp),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) }, ...overrides } as unknown as UiPreferencesPorts
  const send = (method = 'GET', body?: unknown, path = '/api/auth/ui-preferences', contentType = 'application/json') => handleUiPreferencesRoute(
    new Request('https://panel.test' + path, { method, ...(body === undefined ? {} : {
      body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': contentType },
    }) }), new URL('https://panel.test' + path), method, ports)
  const read = async (): Promise<UiPreferencesView> => (await (await send())!.json()) as UiPreferencesView
  const save = (revision = uiPreferencesRevision(undefined, authority), uiTheme = 'v2') => send('PUT', { uiTheme, expectedRevision: revision })
  return { ports, lease, send, read, save }
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-ui-prefs-')); faults.corruptAfterWrite = false })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('personal UI preference authority', () => {
  it('derives separate owner, team member and mailbox lifetimes', () => {
    expect(uiPreferenceOwner(OWNER)).toEqual({ kind: 'principal', principalKind: 'user', principalId: OWNER_ID })
    expect(uiPreferenceOwner(TEAM)).toEqual({ kind: 'team', ownerPrincipalId: OWNER_ID, accountId: ACCOUNT_ID, memberId: MEMBER_ID })
    expect(uiPreferenceOwner(MAIL)).toEqual({ kind: 'mailbox', accountId: ACCOUNT_ID, serviceUserId: SERVICE_ID, mailbox: 'mail@example.test' })
    expect(new Set([file(OWNER), file(TEAM), file(OTHER_TEAM), file(MAIL)]).size).toBe(4)
    expect(uiPreferencesRevision(undefined, OWNER)).not.toEqual(uiPreferencesRevision(undefined, TEAM))
    expect(uiPreferencesRevision(undefined, MAIL)).not.toEqual(uiPreferencesRevision(undefined, { ...MAIL, mailbox: { ...MAIL.mailbox!, serviceUserId: OTHER_SERVICE_ID } }))
  })

  it('refuses bearer, missing sessions and a role on the wrong listener', () => {
    const invalidAuthorities: UiPreferenceAuthority[] = [
      { ...OWNER, caller: { ...OWNER.caller, apiTokenId: 'token' } },
      { ...OWNER, caller: { ...OWNER.caller, sessionId: null } },
      { ...OWNER, surface: 'xwhm' }, { ...ROOT, surface: 'xpanel' },
      { ...TEAM, caller: { ...TEAM.caller, team: { ...TEAM.caller.team!, accountId: OTHER_SERVICE_ID } } },
      { ...OWNER, caller: { ...OWNER.caller, principal: { ...OWNER.caller.principal, id: '../owner' } } },
    ]
    for (const authority of invalidAuthorities) expect(() => uiPreferenceOwner(authority)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })

  it('requires a current sealed mailbox tuple on xMail', () => {
    const invalidAuthorities: UiPreferenceAuthority[] = [
      { surface: 'xmail', caller: MAIL.caller },
      { ...MAIL, mailbox: { ...MAIL.mailbox!, sessionId: 'old-session' } },
      { ...MAIL, mailbox: { ...MAIL.mailbox!, accountId: OTHER_SERVICE_ID } },
      { ...MAIL, mailbox: { ...MAIL.mailbox!, mailbox: 'other@example.test' } },
      { ...MAIL, caller: { ...MAIL.caller, team: TEAM.caller.team } },
      { ...OWNER, mailbox: MAIL.mailbox },
    ]
    for (const authority of invalidAuthorities) expect(() => uiPreferenceOwner(authority)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })

  it('accepts the actual persisted mailbox principal only for its exact sealed address', async () => {
    const username = mailboxPrincipalUsername(MAIL.mailbox!.mailbox)
    const authority = { ...MAIL, caller: { ...MAIL.caller, principal: { ...MAIL.caller.principal, username } } }
    expect(uiPreferenceOwner(authority)).toEqual(uiPreferenceOwner(MAIL))
    expect((await harness(authority).save())!.status).toBe(200)
    const wrongAddress = { ...authority, mailbox: { ...authority.mailbox!, mailbox: 'other@example.test' } }
    expect(() => uiPreferenceOwner(wrongAddress)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => uiPreferenceOwner({ surface: 'xpanel', caller: authority.caller })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })

  it('parses only exact registered choices and an observed revision', () => {
    const input = { uiTheme: 'v2', expectedRevision: uiPreferencesRevision(undefined, OWNER) }
    expect(parseUiPreferencesUpdate(input, config.choices)).toEqual(input)
    for (const extra of [{ uiTheme: 'unknown' }, { expectedRevision: 'wrong' }, { owner: OWNER_ID }, { theme: 'dark' }, { surface: 'xwhm' }]) {
      expect(() => parseUiPreferencesUpdate({ ...input, ...extra }, config.choices)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    }
    expect(() => parseUiPreferencesUpdate(input, ['classic'])).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })
})

describe('personal UI preferences API', () => {
  it('leaves unrelated routes alone and rejects selectors, bodies and unsupported methods', async () => {
    const h = harness()
    expect(await h.send('GET', undefined, '/api/auth/ui-preferences/other')).toBeNull()
    expect(h.ports.open).not.toHaveBeenCalled()
    await expect(h.send('GET', undefined, '/api/auth/ui-preferences?owner=' + OWNER_ID)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', '{')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', '{}', '/api/auth/ui-preferences', 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', ' '.repeat(4097))).rejects.toMatchObject({ code: 'VALIDATION' })
    const response = (await h.send('POST', {}))!
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, PUT')
  })

  it('returns default and registered choices without exposing storage identities', async () => {
    const h = harness(), response = (await h.send())!, view = await response.json() as UiPreferencesView
    expect(view).toEqual({ state: 'default', uiTheme: 'classic', choices: ['classic', 'v2'], revision: uiPreferencesRevision(undefined, OWNER), updatedAt: null, application: 'next_navigation' })
    expect(JSON.stringify(view)).not.toContain(OWNER_ID)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('saves under the writer lease, verifies readback and audits the personal scope', async () => {
    const h = harness(ROOT), response = (await h.save())!, view = await response.json() as UiPreferencesView
    expect(view).toMatchObject({ state: 'saved', uiTheme: 'v2', updatedAt: stamp })
    expect(JSON.parse(await readFile(file(ROOT), 'utf8'))).toEqual(record(ROOT))
    expect(h.lease.assertFencingToken).toHaveBeenCalled()
    expect(h.lease.release).toHaveBeenCalledOnce()
    expect(h.ports.open).toHaveBeenCalledTimes(6)
    expect(h.ports.emitAudit).toHaveBeenCalledWith({ actor: 'root', action: 'auth.ui-preferences.updated', target: 'personal-ui-preferences',
      principalId: ROOT_ID, outcome: 'ok', detail: { uiTheme: 'v2', surface: 'xwhm', ownerKind: 'principal' } })
    expect(await readUiPreferenceValue(root, ROOT, config)).toBe('v2')
  })

  it('keeps each team member independent of the owner and other members', async () => {
    await write(record(OWNER, 'classic'), OWNER)
    expect((await harness(TEAM).save())!.status).toBe(200)
    expect(await harness(OTHER_TEAM).read()).toMatchObject({ state: 'default', uiTheme: 'classic' })
    expect(JSON.parse(await readFile(file(OWNER), 'utf8'))).toEqual(record(OWNER, 'classic'))
    expect(JSON.parse(await readFile(file(TEAM), 'utf8'))).toEqual(record(TEAM))
    expect((await harness(OTHER_TEAM).save(undefined, 'classic'))!.status).toBe(200)
    expect(await readUiPreferenceValue(root, TEAM, config)).toBe('v2')
    expect(await readUiPreferenceValue(root, OTHER_TEAM, config)).toBe('classic')
  })

  it('keeps a recreated mailbox address independent of its previous service lifetime', async () => {
    await write(record(MAIL), MAIL)
    const recreated: UiPreferenceAuthority = { ...MAIL, mailbox: { ...MAIL.mailbox!, serviceUserId: OTHER_SERVICE_ID } }
    expect(await harness(recreated).read()).toMatchObject({ state: 'default', uiTheme: 'classic' })
    expect((await harness(recreated).save(undefined, 'classic'))!.status).toBe(200)
    expect(JSON.parse(await readFile(file(MAIL), 'utf8'))).toEqual(record(MAIL))
    expect(await readUiPreferenceValue(root, recreated, config)).toBe('classic')
  })

  it('allows handed-off reads but denies permanent preference writes', async () => {
    const authority = { ...OWNER, caller: { ...OWNER.caller, impersonator: { principalId: ROOT_ID, login: 'root' } } }
    const h = harness(authority)
    expect(await h.read()).toMatchObject({ state: 'default', uiTheme: 'classic' })
    await expect(h.save()).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(h.lease.assertFencingToken).not.toHaveBeenCalled()
    await expect(readFile(file(OWNER))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses stale revisions and preserves current values', async () => {
    await write(record())
    const h = harness()
    await expect(h.save()).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(record())
    expect(h.lease.release).toHaveBeenCalledOnce()
    expect(h.ports.emitAudit).not.toHaveBeenCalled()
  })

  it('preserves malformed or foreign bound records even when their revision is known', async () => {
    const foreign = record(TEAM)
    await write(foreign)
    const h = harness(), view = await h.read()
    expect(view).toMatchObject({ state: 'invalid', uiTheme: null, updatedAt: null })
    await expect(h.save(view.revision)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(foreign)
    expect(await readUiPreferenceValue(root, OWNER, config)).toBeNull()
    for (const raw of [{ ...record(), updatedAt: 'yesterday' }, { ...record(), extra: true }, { ...record(), uiTheme: 'unknown' }]) {
      expect(readSavedUiPreferences(raw, OWNER, config)).toBeNull()
    }
  })

  it('does not overwrite unreadable JSON or use it as a saved document preference', async () => {
    await write(record()); await writeFile(file(), '{')
    const h = harness()
    await expect(h.read()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(h.save()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(await readFile(file(), 'utf8')).toBe('{')
    expect(await readUiPreferenceValue(root, OWNER, config)).toBeNull()
  })

  it('preserves an existing literal JSON null as invalid metadata instead of treating it as absence', async () => {
    const absent = await harness().read()
    await write(null)
    const h = harness(), view = await h.read()
    expect(view).toMatchObject({ state: 'invalid', uiTheme: null, updatedAt: null })
    expect(view.revision).not.toBe(absent.revision)
    await expect(h.save(view.revision)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(await readFile(file(), 'utf8')).toBe('null')
    expect(await readUiPreferenceValue(root, OWNER, config)).toBeNull()
    expect(h.ports.emitAudit).not.toHaveBeenCalled()
  })

  it('refuses team member, role and mailbox lifetime changes before the write', async () => {
    const changes: [UiPreferenceAuthority, UiPreferenceAuthority][] = [
      [TEAM, OTHER_TEAM], [TEAM, { ...TEAM, caller: { ...TEAM.caller, team: { ...TEAM.caller.team!, roles: ['database'] } } }],
      [MAIL, { ...MAIL, mailbox: { ...MAIL.mailbox!, serviceUserId: OTHER_SERVICE_ID } }],
      [OWNER, { ...OWNER, caller: { ...OWNER.caller, sessionId: 'new-session' } }],
    ]
    for (const [initial, changed] of changes) {
      const open = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(changed), h = harness(initial, { open })
      await expect(h.save()).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
      await expect(readFile(file(initial))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(h.lease.release).toHaveBeenCalledOnce()
    }
  })

  it('revalidates identity after reads instead of returning another session its state', async () => {
    const open = vi.fn().mockResolvedValueOnce(TEAM).mockResolvedValue(OTHER_TEAM)
    await expect(harness(TEAM, { open }).read()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('revalidates the session at the atomic publication boundary', async () => {
    const changed = { ...OWNER, caller: { ...OWNER.caller, sessionId: 'new-session' } }
    const open = vi.fn().mockResolvedValueOnce(OWNER).mockResolvedValueOnce(OWNER).mockResolvedValueOnce(OWNER).mockResolvedValue(changed)
    const h = harness(OWNER, { open })
    await expect(h.save()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.ports.emitAudit).not.toHaveBeenCalled()
    expect(h.lease.release).toHaveBeenCalledOnce()
  })

  it('refuses a lost writer fence and reports release uncertainty after a save', async () => {
    const fenced = harness()
    fenced.lease.assertFencingToken.mockRejectedValueOnce(new Error('lost fence'))
    await expect(fenced.save()).rejects.toThrow('lost fence')
    await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' })
    const released = harness()
    released.lease.release.mockRejectedValueOnce(new Error('release failed'))
    await expect(released.save()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(record())
    expect(released.ports.emitAudit).not.toHaveBeenCalled()
  })

  it('fails closed when the registry has no valid default or duplicate choices', async () => {
    await expect(harness(OWNER, { choices: ['classic'], defaultUiTheme: 'v2' }).read()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await expect(harness(OWNER, { choices: ['classic', 'classic'] }).read()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('reports unverified persistence or audit failures without claiming success', async () => {
    faults.corruptAfterWrite = true
    const h = harness()
    await expect(h.save()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect(h.lease.release).toHaveBeenCalledOnce()
    faults.corruptAfterWrite = false
    await write(record())
    const h2 = harness(OWNER, { emitAudit: async () => fail('SERVICE_UNAVAILABLE', 'audit unavailable') })
    await expect(h2.save(uiPreferencesRevision(record(), OWNER), 'classic')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect(JSON.parse(await readFile(file(), 'utf8')).uiTheme).toBe('classic')
  })
})
