import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PERSONAL_PREFERENCES, handlePersonalPreferencesRoute, parsePersonalPreferencesUpdate, readPersonalPreferenceValues } from './personal-preferences.ts'
import type { UiPreferenceAuthority } from './ui-preferences.ts'

const OWNER = '11111111-1111-4111-8111-111111111111', ACCOUNT = '22222222-2222-4222-8222-222222222222', MEMBER = '33333333-3333-4333-8333-333333333333', REV = 'a'.repeat(64)
const session = 'session-1'
const owner = { caller: { apiTokenId: null, sessionId: session, principal: { kind: 'user', id: OWNER, username: 'alice', accountId: ACCOUNT } }, surface: 'xpanel' } as unknown as UiPreferenceAuthority
const team = { caller: { apiTokenId: null, sessionId: session, principal: { kind: 'user', id: OWNER, username: 'alice', accountId: ACCOUNT }, team: { kind: 'team', id: MEMBER, accountId: ACCOUNT, username: 'alice+sam', login: 'sam', roles: [] } }, surface: 'xpanel' } as unknown as UiPreferenceAuthority
const body = (revision: string, over: object = {}): string => JSON.stringify({ ...DEFAULT_PERSONAL_PREFERENCES, expectedRevision: revision, ...over })

describe('personal preferences', () => {
  let rootDir: string
  const emitAudit = vi.fn(async () => undefined)
  const ports = (authority: UiPreferenceAuthority) => ({ open: async () => authority, emitAudit, locales: () => ['en', 'ar'], store: { rootDir, getWriterLock: () => ({ acquire: async () => ({ assertFencingToken: async () => undefined, release: async () => undefined }) }) } }) as never
  const call = async (authority: UiPreferenceAuthority, method: string, text?: string): Promise<{ status: number; body: Record<string, any> }> => {
    const url = new URL('http://panel/api/auth/personal-preferences')
    try {
      const response = await handlePersonalPreferencesRoute(new Request(url, { method, ...(text ? { body: text } : {}) }), url, method, ports(authority))
      return { status: response!.status, body: await response!.json() as Record<string, any> }
    } catch (error) { return { status: 0, body: { code: (error as { code?: string }).code, detail: (error as { detail?: unknown }).detail } } }
  }
  beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'xp-personal-')); emitAudit.mockClear() })
  afterEach(() => rm(rootDir, { recursive: true, force: true }))

  it('saves language, position and switches, and reads them for rendering', async () => {
    const first = await call(owner, 'GET')
    expect(first.body).toMatchObject({ state: 'default', locale: null, noticePosition: 'bottom-right' })
    const saved = await call(owner, 'PUT', body(first.body.revision, { locale: 'ar', noticePosition: 'bottom-left', notifications: { disk: false, bandwidth: true, announcements: true } }))
    expect(saved.body).toMatchObject({ state: 'saved', locale: 'ar', noticePosition: 'bottom-left' })
    expect((await readPersonalPreferenceValues(rootDir, owner))?.notifications.disk).toBe(false)
    expect(emitAudit).toHaveBeenCalledOnce()
  })

  it('refuses an unknown language and a stale revision', async () => {
    expect(() => parsePersonalPreferencesUpdate({ ...DEFAULT_PERSONAL_PREFERENCES, locale: 'xx', expectedRevision: REV }, ['en', 'ar'])).toThrow(/not offered/)
    expect((await call(owner, 'PUT', body(REV))).body.code).toBe('CONFLICT')
  })

  it('keeps a dismissal permanent', async () => {
    const first = await call(owner, 'GET')
    const dismissed = await call(owner, 'PUT', body(first.body.revision, { onboardingDismissed: true }))
    expect(dismissed.body.onboardingDismissed).toBe(true)
    expect((await call(owner, 'PUT', body(dismissed.body.revision, { onboardingDismissed: false }))).body.onboardingDismissed).toBe(true)
  })

  it('lets a team user inherit the owner language until they choose one', async () => {
    const first = await call(owner, 'GET')
    await call(owner, 'PUT', body(first.body.revision, { locale: 'ar' }))
    expect((await readPersonalPreferenceValues(rootDir, team))?.locale).toBe('ar')
    const own = await call(team, 'GET')
    expect(own.body).toMatchObject({ locale: null, inheritedLocale: 'ar' })
    await call(team, 'PUT', body(own.body.revision, { locale: 'en' }))
    expect((await readPersonalPreferenceValues(rootDir, team))?.locale).toBe('en')
  })

  it('treats a damaged record as unreadable for rendering and refuses to overwrite it', async () => {
    const first = await call(owner, 'GET')
    await call(owner, 'PUT', body(first.body.revision))
    const dir = join(rootDir, 'extended/personal-preferences/xpanel/principal'), [file] = await readdir(dir)
    await writeFile(join(dir, file!), '{"schema":9}')
    expect(await readPersonalPreferenceValues(rootDir, owner)).toBeNull()
    const damaged = await call(owner, 'GET')
    expect(damaged.body.state).toBe('invalid')
    expect((await call(owner, 'PUT', body(damaged.body.revision))).body.code).toBe('PRECONDITION_FAILED')
  })
})
