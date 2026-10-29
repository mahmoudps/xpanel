import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { adminPreferencesRevision, DEFAULT_ADMIN_PREFERENCES, handleAdminPreferencesRoute, parseAdminPreferencesUpdate, readAdminPreferenceValues, readSavedAdminPreferences } from './admin-preferences.ts'
import type { AdminPreferencesHelpers, AdminPreferencesView } from './admin-preferences.ts'

const faults = vi.hoisted(() => ({ corruptAfterWrite: false }))
vi.mock('@xpanel/state', async importOriginal => {
  const actual = await importOriginal<typeof import('@xpanel/state')>()
  return { ...actual, atomicWriteJson: async (...args: Parameters<typeof actual.atomicWriteJson>) => {
    await actual.atomicWriteJson(...args)
    if (faults.corruptAfterWrite) await writeFile(args[0], '{}')
  } }
})
const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' }, sessionId: 'one', apiTokenId: null } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'reseller1' }, sessionId: 'two', apiTokenId: null } as AuthenticatedCaller
const USER = { principal: { id: '33333333-3333-4333-8333-333333333333', kind: 'user', username: 'owner', accountId: '44444444-4444-4444-8444-444444444444' }, sessionId: 'three', apiTokenId: null } as AuthenticatedCaller
const fields = { language: 'ar', theme: 'dark', density: 'compact' } as const
const stamp = '2026-10-27T12:00:00.000Z'
let root = ''
const file = (caller = ROOT) => join(root, 'extended', 'preferences', caller.principal.id + '.json')
const write = async (value: unknown, caller = ROOT) => { await mkdir(join(root, 'extended', 'preferences'), { recursive: true }); await writeFile(file(caller), JSON.stringify(value)) }
const record = (caller = ROOT) => ({ version: 1, principalId: caller.principal.id, ...fields, updatedAt: stamp })
function harness(caller = ROOT, overrides: Partial<AdminPreferencesHelpers> = {}) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = { requireCaller: vi.fn(async () => caller), emitAudit: vi.fn(async () => undefined), now: () => new Date(stamp),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) }, ...overrides } as unknown as AdminPreferencesHelpers
  const send = (method = 'GET', body?: unknown, path = '/api/admin/preferences', contentType = 'application/json') => handleAdminPreferencesRoute(new Request('http://api.test' + path, { method,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': contentType } }) }), new URL('http://api.test' + path), method, helpers)
  const read = async () => (await (await send())!.json()) as AdminPreferencesView
  const save = (revision = adminPreferencesRevision(null, caller.principal)) => send('PUT', { ...fields, expectedRevision: revision })
  return { helpers, lease, send, read, save }
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-admin-prefs-')); faults.corruptAfterWrite = false })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('administrator preferences grammar and read projection', () => {
  it('accepts only the exact bounded three choices and revision', () => {
    const input = { ...fields, expectedRevision: adminPreferencesRevision(null, ROOT.principal) }
    expect(parseAdminPreferencesUpdate(input)).toEqual(input)
    for (const extra of [{ language: 'fr' }, { theme: 'auto' }, { density: 'dense' }, { expectedRevision: 'x' }, { principalId: ROOT.principal.id }, { mfaRequired: true }])
      expect(() => parseAdminPreferencesUpdate({ ...input, ...extra })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => parseAdminPreferencesUpdate({ theme: 'dark', density: 'compact', expectedRevision: input.expectedRevision })).toThrow()
  })
  it('binds the record to the trusted principal and refuses malformed records', async () => {
    expect(readSavedAdminPreferences(record(), ROOT.principal)).toEqual(record())
    expect(readSavedAdminPreferences(record(), RESELLER.principal)).toBeNull()
    expect(readSavedAdminPreferences({ ...record(), extra: true }, ROOT.principal)).toBeNull()
    expect(readSavedAdminPreferences({ ...record(), updatedAt: 'yesterday' }, ROOT.principal)).toBeNull()
    await write(record())
    expect(await readAdminPreferenceValues(root, ROOT.principal)).toEqual(fields)
    expect(await readAdminPreferenceValues(root, RESELLER.principal)).toBeNull()
    expect(await readAdminPreferenceValues(root, USER.principal)).toBeNull()
  })
})

describe('administrator preferences API', () => {
  it('leaves unrelated routes alone', async () => {
    const h = harness()
    expect(await h.send('GET', undefined, '/api/admin/preferences/other')).toBeNull()
    expect(h.helpers.requireCaller).not.toHaveBeenCalled()
  })
  it('returns explicit defaults without exposing the principal ID and with no-store', async () => {
    const h = harness(), response = (await h.send())!, view = await response.json() as AdminPreferencesView
    expect(view).toEqual({ state: 'default', preferences: DEFAULT_ADMIN_PREFERENCES, revision: adminPreferencesRevision(null, ROOT.principal), updatedAt: null, application: 'next_navigation' })
    expect(JSON.stringify(view)).not.toContain(ROOT.principal.id)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(adminPreferencesRevision(null, ROOT.principal)).not.toEqual(adminPreferencesRevision(null, RESELLER.principal))
  })
  it('saves root own preferences under the writer lease, re-reads and audits', async () => {
    const h = harness(), response = (await h.save())!, view = await response.json() as AdminPreferencesView
    expect(view).toMatchObject({ state: 'saved', preferences: fields, updatedAt: stamp })
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(record())
    expect(view.revision).toBe(adminPreferencesRevision(record(), ROOT.principal))
    expect(h.lease.assertFencingToken).toHaveBeenCalled()
    expect(h.lease.release).toHaveBeenCalledOnce()
    expect(h.helpers.requireCaller).toHaveBeenCalledTimes(4)
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.preferences.updated', target: 'personal-preferences', principalId: ROOT.principal.id, detail: fields }))
  })
  it('permits reseller own preferences independently and never modifies root values', async () => {
    await write(record())
    const h = harness(RESELLER)
    expect((await h.save())!.status).toBe(200)
    expect(JSON.parse(await readFile(file(RESELLER), 'utf8'))).toEqual(record(RESELLER))
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(record())
  })
  it('refuses user roles, principal selectors, unsupported methods and malformed bodies', async () => {
    await expect(harness(USER).read()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const h = harness()
    await expect(h.send('GET', undefined, '/api/admin/preferences?principalId=' + RESELLER.principal.id)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', '{')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', '{}', '/api/admin/preferences', 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', ' '.repeat(4097))).rejects.toMatchObject({ code: 'VALIDATION' })
    const result = (await h.send('POST', {}))!
    expect(result.status).toBe(405); expect(result.headers.get('allow')).toBe('GET, PUT')
  })
  it('refuses a stale revision and preserves the current file', async () => {
    await write(record())
    const h = harness()
    await expect(h.save()).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(record())
    expect(h.lease.release).toHaveBeenCalledOnce()
    expect(h.helpers.emitAudit).not.toHaveBeenCalled()
  })
  it('does not overwrite invalid or foreign saved metadata', async () => {
    await write(record(RESELLER))
    const h = harness(), view = await h.read()
    expect(view).toMatchObject({ state: 'invalid', preferences: null, updatedAt: null })
    await expect(h.save(view.revision)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(record(RESELLER))
  })
  it('refuses unreadable JSON and uses no saved defaults from it', async () => {
    await write(record()); await writeFile(file(), '{')
    await expect(harness().read()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await readAdminPreferenceValues(root, ROOT.principal)).toBeNull()
  })
  it('rechecks identity immediately before writing and after a read', async () => {
    const changed = { ...ROOT, sessionId: 'changed' }
    const requireCaller = vi.fn().mockResolvedValueOnce(ROOT).mockResolvedValueOnce(ROOT).mockResolvedValue(changed)
    const h = harness(ROOT, { requireCaller })
    await expect(h.save()).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' })
    const readH = harness(ROOT, { requireCaller: vi.fn().mockResolvedValueOnce(ROOT).mockResolvedValue(RESELLER) })
    await expect(readH.read()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('reports unverified writes and audit failures as requiring review', async () => {
    faults.corruptAfterWrite = true
    const h = harness()
    await expect(h.save()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect(h.lease.release).toHaveBeenCalledOnce()
    faults.corruptAfterWrite = false
    await write(record())
    const h2 = harness(ROOT, { emitAudit: async () => fail('SERVICE_UNAVAILABLE', 'audit unavailable') })
    await expect(h2.save(adminPreferencesRevision(record(), ROOT.principal))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
  })
})
