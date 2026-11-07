import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StateStore } from '@xpanel/state'
import { LIST_POLICY_DEFAULTS } from '../../../agent/src/list-moderation-policy.ts'
import type { AuthenticatedCaller } from '../auth.ts'
import { handleListModerationRoute, handleMailboxListModerationRoute } from './list-moderation.ts'
import { handleMailingListAdminRoute } from './mailing-list-admin.ts'

const LIST = '11111111-1111-4111-8111-111111111111', ACC = '22222222-2222-4222-8222-222222222222', SU = '33333333-3333-4333-8333-333333333333', HELD = `20261107-${'a'.repeat(32)}`
const row = { id: HELD, at: '2026-11-07T10:00:00.000Z', from: 'x@y.test', subject: 'Hello', size: 10, reason: 'non_member' }
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function fixture(options: { list?: Record<string, unknown>; ready?: boolean; host?: boolean; reply?: unknown } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'xpanel-list-moderation-')); dirs.push(rootDir)
  await mkdir(join(rootDir, 'extended', 'mail'), { recursive: true })
  const file = join(rootDir, 'extended', 'mail', 'mailing-lists.json')
  await writeFile(file, JSON.stringify([{ id: LIST, accountId: ACC, name: 'news', domain: 'alice.test', address: 'news@alice.test', members: ['a@x.test'], moderation: 'open', archiveEnabled: false, createdAt: '2026-11-07T10:00:00.000Z', ...options.list }]))
  const audits: { action: string; detail?: Record<string, unknown> }[] = [], applied: { path: string; previous: unknown }[] = [], calls: { body: Record<string, unknown>; mutation: boolean }[] = []
  const store = { rootDir, getAccount: async () => ({ id: ACC, username: 'alice', status: 'active', planId: 'p' }), getPlan: async () => ({ id: 'p', featureListId: 'f' }), getFeatureList: async () => ({ id: 'f', disabled: [] }),
    getDomainByName: async () => ({ name: 'alice.test', accountId: ACC, suspended: false }), getServiceUserByLogin: async () => ({ id: SU, accountId: ACC, login: 'mod@alice.test', services: { email: true } }),
    getWriterLock: () => ({ acquire: async () => ({ assertFencingToken: async () => undefined, release: async () => undefined }) }) } as unknown as StateStore
  const host = async (body: Record<string, unknown>, mutation: boolean): Promise<unknown> => {
    calls.push({ body, mutation })
    const call = body.call as { op: string }
    if (call.op === 'status') return { ready: options.ready ?? true, active: false }
    return options.reply ?? (call.op === 'queue' ? { total: 1, rows: [row] } : call.op === 'message' ? { found: true, ...row, headers: 'From: x', body: 'b', truncated: false } : { done: 1, failed: 0 })
  }
  const owner = { store, requireCaller: async () => ({ principal: { id: 'p-1', kind: 'root', username: 'root' }, scopes: [] }) as unknown as AuthenticatedCaller, assertCanAccessAccount: async () => undefined,
    emitAudit: async (entry: { action: string; detail?: Record<string, unknown> }) => { audits.push(entry) }, routing: { commit: async () => 9, apply: async (_r: Request, _v: number, restore: { path: string; previous: unknown }) => { applied.push(restore); return { nativeApplied: true } } },
    callHost: options.host === false ? null : async (_c: AuthenticatedCaller, _u: string, body: unknown, mutation: boolean) => host(body as Record<string, unknown>, mutation) }
  const ownerCall = async (method: string, path: string, body?: unknown) => {
    const url = 'http://p/api/mail/mailing-lists/' + LIST + path
    const response = await handleListModerationRoute(new Request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), new URL(url), method, owner as never)
    return response!.json() as Promise<Record<string, any>>
  }
  const mailbox = { store, open: async () => ({ record: { mailbox: 'mod@alice.test', accountId: ACC, serviceUserId: SU, sessionId: 's' }, password: 'x' }), audit: async (_r: Request, event: { action: string; detail?: Record<string, unknown> }) => { audits.push(event) },
    callHost: async (_r: Request, _u: string, body: unknown, mutation: boolean) => host(body as Record<string, unknown>, mutation) }
  const webmail = async (body: Record<string, unknown>) => {
    const url = 'http://m/api/webmail/mailing-lists/moderation'
    const response = await handleMailboxListModerationRoute(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ list: 'news@alice.test', password: null, op: 'queue', args: {}, ...body }) }), new URL(url), 'POST', mailbox as never)
    return response!.json() as Promise<Record<string, any>>
  }
  return { file, audits, applied, calls, ownerCall, webmail, owner }
}
const body = (revision: string, extra: Record<string, unknown> = {}) => ({ moderation: 'members', selfSubscription: 'closed', policy: LIST_POLICY_DEFAULTS, expectedRevision: revision, ...extra })

describe('list moderation policy', { tags: ['feature'] }, () => {
  it('reads defaults, saves the policy on the list record through the routing reconcile, and rolls back as one file', async () => {
    const t = await fixture()
    const before = await t.ownerCall('GET', '/moderation')
    expect(before).toMatchObject({ address: 'news@alice.test', moderation: 'open', selfSubscription: 'closed', gated: false, policy: LIST_POLICY_DEFAULTS, host: { state: 'connected', ready: true, active: false } })
    const after = await t.ownerCall('PUT', '/moderation', body(before.revision, { selfSubscription: 'open', policy: { ...LIST_POLICY_DEFAULTS, moderators: ['mod@alice.test'], moderatedMembers: ['a@x.test'], nonMemberAction: 'reject' } }))
    expect(after).toMatchObject({ moderation: 'members', selfSubscription: 'open', gated: true, stateChanged: true, nativeApplied: true })
    expect(after.revision).not.toBe(before.revision)
    const stored = JSON.parse(await readFile(t.file, 'utf8'))
    expect(stored[0]).toMatchObject({ moderation: 'members', selfSubscription: 'open', policy: { nonMemberAction: 'reject', moderators: ['mod@alice.test'] } })
    expect(t.applied[0]!.path).toBe(t.file)
    expect((t.applied[0]!.previous as { moderation: string }[])[0]!.moderation).toBe('open')
    expect(t.audits.map(entry => entry.action)).toEqual(['mail.mailing_list.policy_saved'])
    expect(await t.ownerCall('PUT', '/moderation', body(after.revision, { selfSubscription: 'open', policy: after.policy }))).toMatchObject({ stateChanged: false })
  })
  it('refuses a stale revision, an unknown moderated member, and limits the host cannot enforce', async () => {
    const t = await fixture(), { revision } = await t.ownerCall('GET', '/moderation')
    await expect(t.ownerCall('PUT', '/moderation', body('0'.repeat(64)))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(t.ownerCall('PUT', '/moderation', body(revision, { policy: { ...LIST_POLICY_DEFAULTS, moderatedMembers: ['stranger@x.test'] } }))).rejects.toMatchObject({ detail: { reason: 'list_member_unknown' } })
    await expect(t.ownerCall('PUT', '/moderation', body(revision, { moderation: 'everyone' }))).rejects.toMatchObject({ code: 'VALIDATION' })
    const missing = await fixture({ ready: false })
    await expect(missing.ownerCall('PUT', '/moderation', body((await missing.ownerCall('GET', '/moderation')).revision))).rejects.toMatchObject({ detail: { reason: 'sieve_extprograms_missing', stateChanged: false } })
    expect(JSON.parse(await readFile(missing.file, 'utf8'))[0].moderation).toBe('open')
  })
  it('reports a missing host and a saved policy it cannot read', async () => {
    expect(await (await fixture({ host: false })).ownerCall('GET', '/moderation')).toMatchObject({ host: { state: 'not-connected', ready: null, active: null } })
    await expect((await fixture({ list: { policy: { moderators: 'x' } } })).ownerCall('GET', '/moderation')).rejects.toMatchObject({ detail: { reason: 'saved_lists_review' } })
  })
})

describe('list moderation queue', { tags: ['feature'] }, () => {
  it('reads and decides through the host, re-validates the answers and audits decisions only', async () => {
    const t = await fixture()
    expect(await t.ownerCall('POST', '/moderation/queue', { op: 'queue', args: {} })).toEqual({ total: 1, rows: [row] })
    expect(await t.ownerCall('POST', '/moderation/queue', { op: 'message', args: { id: HELD } })).toMatchObject({ headers: 'From: x', truncated: false })
    expect(await t.ownerCall('POST', '/moderation/queue', { op: 'act', args: { action: 'reject', ids: [HELD], reason: 'Off topic' } })).toEqual({ done: 1, failed: 0, stateChanged: true })
    expect(t.calls.at(-1)).toEqual({ body: { address: 'news@alice.test', call: { op: 'act', action: 'reject', reason: Buffer.from('Off topic').toString('base64'), ids: [HELD] } }, mutation: true })
    expect(t.audits.map(entry => [entry.action, entry.detail?.done])).toEqual([['mail.mailing_list.moderated', 1]])
  })
  it('refuses bad decisions, a forged host row and a missing host', async () => {
    const t = await fixture()
    for (const args of [{ action: 'keep', ids: [HELD] }, { action: 'approve', ids: [] }, { action: 'approve', ids: ['../x'] }, { action: 'approve', ids: [HELD, HELD] }, { action: 'approve', ids: [HELD], reason: 'no' }, { action: 'reject', ids: [HELD], reason: 'two\nlines' }])
      await expect(t.ownerCall('POST', '/moderation/queue', { op: 'act', args }), JSON.stringify(args)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect((await fixture({ reply: { total: 1, rows: [{ ...row, id: 'x' }] } })).ownerCall('POST', '/moderation/queue', { op: 'queue', args: {} })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await expect((await fixture({ reply: { found: false } })).ownerCall('POST', '/moderation/queue', { op: 'message', args: { id: HELD } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect((await fixture({ host: false })).ownerCall('POST', '/moderation/queue', { op: 'queue', args: {} })).rejects.toMatchObject({ detail: { reason: 'host_agent_unavailable' } })
  })
})

describe('webmail moderation sign-in', { tags: ['feature'] }, () => {
  it('admits a moderator mailbox on its own session, and audits as the mailbox', async () => {
    const t = await fixture({ list: { policy: { ...LIST_POLICY_DEFAULTS, moderators: ['mod@alice.test'] } } })
    expect(await t.webmail({})).toEqual({ total: 1, rows: [row] })
    expect(await t.webmail({ op: 'act', args: { action: 'approve', ids: [HELD] } })).toMatchObject({ done: 1 })
    expect(t.audits.map(entry => entry.action)).toEqual(['webmail.mailing_list.moderated'])
  })
  it('needs the list password from anyone else, under the same lock as member administration', async () => {
    const t = await fixture()
    await expect(t.webmail({})).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { reason: 'list_moderator_required' } })
    await expect(t.webmail({ password: 'nope' })).rejects.toMatchObject({ detail: { reason: 'list_password_unset' } })
    const url = `http://p/api/mail/mailing-lists/${LIST}/password`
    await handleMailingListAdminRoute(new Request(url, { method: 'PUT', body: JSON.stringify({ password: 'first secret 1' }) }), new URL(url), 'PUT', { ...t.owner, assertRoot: async () => undefined, callAgent: null } as never)
    await expect(t.webmail({ password: 'wrong' })).rejects.toMatchObject({ detail: { reason: 'list_password_wrong' } })
    expect(await t.webmail({ password: 'first secret 1' })).toMatchObject({ total: 1 })
  })
  it('hides a list of another account', async () => {
    const t = await fixture({ list: { accountId: '44444444-4444-4444-8444-444444444444' } })
    await expect(t.webmail({})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
