import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { hashPasswordArgon2id, type AuthenticatedCaller } from '../auth.ts'
import { handleMailboxListAdminRoute, handleMailingListAdminRoute } from './mailing-list-admin.ts'

const LIST = '11111111-1111-4111-8111-111111111111', ACC = '22222222-2222-4222-8222-222222222222', SU = '33333333-3333-4333-8333-333333333333'
let fastListHash = ''
beforeAll(async () => { fastListHash = await hashPasswordArgon2id('first secret 1', { timeCost: 1, parallelism: 1 }) })
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function fixture(options: { kind?: 'user' | 'root'; ownsList?: boolean } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'xpanel-list-admin-')); dirs.push(rootDir)
  await mkdir(join(rootDir, 'extended', 'mail'), { recursive: true })
  await writeFile(join(rootDir, 'extended', 'mail', 'mailing-lists.json'), JSON.stringify([{ id: LIST, accountId: ACC, name: 'news', domain: 'alice.test', address: 'news@alice.test', members: ['a@x.test'], moderation: 'open', archiveEnabled: false, createdAt: '2026-11-01T00:00:00.000Z' }]))
  let clock = Date.parse('2026-11-07T10:00:00.000Z')
  const audits: string[] = [], applied: number[] = []
  const store = { rootDir, getAccount: async () => ({ id: ACC, username: 'alice', status: 'active' }), listAccounts: async () => [{ id: ACC, username: 'alice' }],
    getDomainByName: async () => ({ name: 'alice.test', accountId: options.ownsList === false ? '44444444-4444-4444-8444-444444444444' : ACC, suspended: false }),
    getWriterLock: () => ({ acquire: async () => ({ assertFencingToken: async () => undefined, release: async () => undefined }) }) } as unknown as StateStore
  const caller = { principal: { id: 'p-1', kind: options.kind ?? 'user', username: 'alice' } } as unknown as AuthenticatedCaller
  const admin = { store, requireCaller: async () => caller, assertRoot: async (c: AuthenticatedCaller) => { if (c.principal.kind !== 'root') fail('FORBIDDEN', 'root') },
    assertCanAccessAccount: async () => undefined, emitAudit: async (entry: { action: string }) => { audits.push(entry.action) }, callAgent: null, now: () => new Date(clock) }
  const authority = { accountId: ACC, serviceUserId: SU, mailbox: 'bob@alice.test' }
  const mailbox = { store: { ...store, getServiceUserByLogin: async () => ({ id: SU, accountId: ACC, login: 'bob@alice.test', services: { email: true } }) } as unknown as StateStore,
    open: async () => ({ record: { mailbox: 'bob@alice.test', accountId: ACC, serviceUserId: SU, sessionId: 's' }, password: 'x' }), audit: async (_r: Request, event: { action: string }) => { audits.push(event.action) },
    routing: { commit: async () => 7, apply: async (_r: Request, revision: number) => { applied.push(revision); return { nativeApplied: true } } }, now: () => new Date(clock) }
  const password = (path: string, value: string) => handleMailingListAdminRoute(new Request('http://p' + path, { method: 'PUT', body: JSON.stringify({ password: value }) }), new URL('http://p' + path), 'PUT', admin)
  const listAdmin = (body: Record<string, unknown>) => handleMailboxListAdminRoute(new Request('http://m/api/webmail/mailing-lists/admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ list: 'news@alice.test', ...body }) }),
    new URL('http://m/api/webmail/mailing-lists/admin'), 'POST', mailbox as never)
  return { rootDir, audits, applied, password, listAdmin, authority, advance: (ms: number) => { clock += ms }, admin }
}

describe('mailing list administrator password', () => {
  it('lets the owner set a password that then unlocks member administration from webmail, and a root reset replaces it', { tags: ['slow'] }, async () => {
    const t = await fixture()
    expect(await (await t.password(`/api/mail/mailing-lists/${LIST}/password`, 'first secret 1'))!.json()).toEqual({ id: LIST, address: 'news@alice.test', passwordSet: true })
    const stored = await readFile(join(t.rootDir, 'extended', 'mail', 'mailing-list-passwords.json'), 'utf8')
    expect(stored).toContain('$argon2id$')
    expect(stored).not.toContain('first secret 1')
    expect(await (await t.listAdmin({ password: 'first secret 1', op: 'read', member: null }))!.json()).toMatchObject({ members: ['a@x.test'], stateChanged: false })
    const added = await (await t.listAdmin({ password: 'first secret 1', op: 'add', member: 'c@y.test' }))!.json()
    expect(added).toMatchObject({ members: ['a@x.test', 'c@y.test'], stateChanged: true, nativeApplied: true })
    expect(t.applied).toEqual([7])
    const root = await fixture({ kind: 'root' })
    void root
    expect(await (await handleMailingListAdminRoute(new Request('http://w/api/server/mailing-lists'), new URL('http://w/api/server/mailing-lists'), 'GET', { ...t.admin, requireCaller: async () => ({ principal: { id: 'r', kind: 'root', username: 'root' } }) as unknown as AuthenticatedCaller }))!.json())
      .toEqual({ lists: [{ id: LIST, address: 'news@alice.test', account: 'alice', passwordSet: true, members: 2 }] })
    await handleMailingListAdminRoute(new Request(`http://w/api/server/mailing-lists/${LIST}/password`, { method: 'PUT', body: JSON.stringify({ password: 'second secret 2' }) }), new URL(`http://w/api/server/mailing-lists/${LIST}/password`), 'PUT',
      { ...t.admin, requireCaller: async () => ({ principal: { id: 'r', kind: 'root', username: 'root' } }) as unknown as AuthenticatedCaller })
    await expect(t.listAdmin({ password: 'first secret 1', op: 'read', member: null })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { reason: 'list_password_wrong' } })
    expect(await (await t.listAdmin({ password: 'second secret 2', op: 'read', member: null }))!.json()).toMatchObject({ address: 'news@alice.test' })
    expect(t.audits).toEqual(['mail.mailing_list.password_changed', 'webmail.mailing_list.member_added', 'mail.mailing_list.password_reset'])
  })
  it('locks webmail list sign-in after five wrong passwords and refuses another account, a short password and a reseller on the root routes', async () => {
    const t = await fixture()
    await writeFile(join(t.rootDir, 'extended', 'mail', 'mailing-list-passwords.json'), JSON.stringify({ [LIST]: { hash: fastListHash, failures: 0, lockedUntil: null, updatedAt: '2026-11-07T10:00:00.000Z' } }))
    for (let i = 0; i < 4; i++) await expect(t.listAdmin({ password: 'wrong', op: 'read', member: null })).rejects.toMatchObject({ detail: { reason: 'list_password_wrong' } })
    await expect(t.listAdmin({ password: 'wrong', op: 'read', member: null })).rejects.toMatchObject({ detail: { reason: 'list_admin_locked' } })
    await expect(t.listAdmin({ password: 'first secret 1', op: 'read', member: null })).rejects.toMatchObject({ detail: { reason: 'list_admin_locked' } })
    t.advance(15 * 60_000 + 1)
    expect((await t.listAdmin({ password: 'first secret 1', op: 'read', member: null }))!.status).toBe(200)
    await expect((await fixture({ ownsList: false })).listAdmin({ password: 'x', op: 'read', member: null })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(t.password(`/api/mail/mailing-lists/${LIST}/password`, 'short')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(t.password(`/api/server/mailing-lists/${LIST}/password`, 'long enough 1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('refuses a restart with no saved list and without the host agent', async () => {
    const t = await fixture({ kind: 'root' })
    const restart = () => handleMailingListAdminRoute(new Request('http://w/api/server/mailing-lists/restart', { method: 'POST', body: '{}' }), new URL('http://w/api/server/mailing-lists/restart'), 'POST', t.admin)
    await expect(restart()).rejects.toMatchObject({ detail: { reason: 'host_agent_unavailable' } })
    await writeFile(join(t.rootDir, 'extended', 'mail', 'mailing-lists.json'), '[]')
    await expect(restart()).rejects.toMatchObject({ detail: { reason: 'no_mailing_lists', stateChanged: false } })
  })
})
