import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from '../auth.ts'
import { BOXTRAPPER_DEFAULTS } from '../../../agent/src/boxtrapper-policy.ts'
import { handleMailboxBoxTrapperRoute, handleOwnerBoxTrapperRoute } from './boxtrapper.ts'

const ACC = '22222222-2222-4222-8222-222222222222', SU = '33333333-3333-4333-8333-333333333333', FOREIGN = '44444444-4444-4444-8444-444444444444'
const MAILBOX = 'me@alice.test', ID = `20261107-${'a'.repeat(32)}`
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const json = (url: string, method: string, body?: unknown) => [new Request('http://p' + url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), new URL('http://p' + url), method] as const

async function fixture(options: { kind?: string; host?: 'connected' | 'none' | 'failing' | 'hostile'; ready?: boolean; applied?: boolean } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'xpanel-boxtrapper-')); dirs.push(rootDir)
  const audits: { action: string; detail?: Record<string, unknown> }[] = [], calls: { username: string; body: { mailbox: string; call: Record<string, unknown> }; mutation: boolean }[] = [], applied: number[] = []
  let owner = ACC
  const service = async (login: string) => login === MAILBOX ? { id: SU, accountId: owner, login, services: { email: true } } : null
  const store = { rootDir, getAccount: async (id: string) => id === ACC ? { id: ACC, username: 'alice', status: 'active', planId: 'p' } : null, getServiceUserByLogin: service, getDomainByName: async () => null, listServiceUsers: async () => [{ accountId: ACC, login: MAILBOX, services: { email: true } }],
    getPlan: async () => ({ featureListId: 'f' }), getFeatureList: async () => ({ disabled: [] }), getWriterLock: () => ({ acquire: async () => ({ assertFencingToken: async () => undefined, release: async () => undefined }) }) }
  const host = async (username: string, body: { mailbox: string; call: Record<string, unknown> }, mutation: boolean): Promise<unknown> => {
    calls.push({ username, body, mutation })
    if (options.host === 'failing') return fail('SERVICE_UNAVAILABLE', 'down', { stateChanged: false })
    const call = body.call
    if (options.host === 'hostile') return { days: [], day: null, rows: [{ id: '../x', at: 'now', from: 'a', subject: 's', size: 1 }] }
    switch (call.op) {
      case 'status': return { ready: options.ready ?? true, script: true }
      case 'lists': return { lists: { allow: ['from a@b.test'], ignore: [], deny: [] }, revision: 'b'.repeat(64) }
      case 'queue': return { day: '2026-11-07', days: [{ day: '2026-11-07', count: 1 }], rows: [{ id: ID, at: '2026-11-07T10:00:00.000Z', from: 'x@y.test', subject: 'Hello', size: 10 }] }
      case 'lists-set': return { saved: true, lists: JSON.parse(Buffer.from(call.encoded as string, 'base64').toString()), revision: 'c'.repeat(64) }
      case 'act': return { done: 1, failed: 0 }
      default: return null
    }
  }
  const callHost = options.host === 'none' ? null : host
  const routing = { commit: async () => 7, apply: async (_r: Request, revision: number) => { if (options.applied === false) return fail('CONFIG_TEST_FAILED', 'refused', { stateChanged: false }); applied.push(revision); return { nativeApplied: true } } }
  const mailbox = { store, open: async () => ({ record: { mailbox: MAILBOX, accountId: ACC, serviceUserId: SU, sessionId: 's' }, password: 'x' }), audit: async (_r: Request, event: { action: string; detail: Record<string, unknown> }) => { audits.push(event) }, routing,
    callHost: callHost && ((_r: Request, username: string, body: unknown, mutation: boolean) => callHost(username, body as never, mutation)), now: () => new Date('2026-11-07T10:00:00.000Z') }
  const caller = { principal: { id: 'p-1', kind: options.kind ?? 'user', username: 'alice', accountId: ACC }, scopes: [] } as unknown as AuthenticatedCaller
  const ownerPorts = { store, requireCaller: async () => caller, assertCanAccessAccount: async () => undefined, emitAudit: async (entry: { action: string; detail?: Record<string, unknown> }) => { audits.push(entry) }, routing,
    callHost: callHost && ((_c: AuthenticatedCaller, username: string, body: unknown, mutation: boolean) => callHost(username, body as never, mutation)), now: () => new Date('2026-11-07T10:00:00.000Z') }
  return { rootDir, audits, calls, applied, moveMailbox: () => { owner = FOREIGN },
    web: (...args: readonly [Request, URL, string]) => handleMailboxBoxTrapperRoute(...args, mailbox as never),
    own: (...args: readonly [Request, URL, string]) => handleOwnerBoxTrapperRoute(...args, ownerPorts as never) }
}
const enabled = { ...BOXTRAPPER_DEFAULTS, enabled: true }
const owned = `/api/mail/boxtrapper/${encodeURIComponent(MAILBOX)}`

describe('BoxTrapper API', { tags: ['feature'] }, () => {
  it('reads defaults with the host state, saves through the mail routing apply and refuses a stale revision', async () => {
    const t = await fixture(), first = await (await t.web(...json('/api/webmail/boxtrapper', 'GET')))!.json()
    expect(first).toMatchObject({ context: { mailbox: MAILBOX }, saved: false, config: { enabled: false, retentionDays: 15, spamBypass: -2.5 }, host: { state: 'connected', ready: true, active: true }, lists: { allow: ['from a@b.test'] } })
    const saved = await (await t.web(...json('/api/webmail/boxtrapper', 'PUT', { config: enabled, expectedRevision: first.revision })))!.json()
    expect(saved).toMatchObject({ saved: true, stateChanged: true, nativeApplied: true, config: { enabled: true } })
    expect(t.applied).toEqual([7])
    expect(t.audits.map(item => item.action)).toEqual(['webmail.boxtrapper.updated'])
    expect(JSON.parse(await readFile(join(t.rootDir, 'extended', 'webmail', 'boxtrapper', encodeURIComponent(MAILBOX) + '.json'), 'utf8'))).toMatchObject({ enabled: true, mailbox: MAILBOX, ownerAuthority: { accountId: ACC, serviceUserId: SU } })
    await expect(t.web(...json('/api/webmail/boxtrapper', 'PUT', { config: { ...enabled, displayName: 'x' }, expectedRevision: first.revision }))).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a forward loop, a broken verify subject and unknown fields', async () => {
    const t = await fixture(), revision = (await (await t.web(...json('/api/webmail/boxtrapper', 'GET')))!.json()).revision
    const put = (config: unknown) => t.web(...json('/api/webmail/boxtrapper', 'PUT', { config, expectedRevision: revision }))
    await expect(put({ ...enabled, forward: [MAILBOX] })).rejects.toMatchObject({ detail: expect.objectContaining({ reason: 'boxtrapper_forward_loop' }) })
    await expect(put({ ...enabled, templates: { ...enabled.templates, verify: { subject: 'Please verify', body: 'x' } } })).rejects.toMatchObject({ detail: expect.objectContaining({ reason: 'boxtrapper_token_required' }) })
    await expect(put({ ...enabled, retentionDays: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(put({ ...enabled, forward: ['a@b.test', 'c@b.test', 'd@b.test', 'e@b.test', 'f@b.test'] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(t.web(...json('/api/webmail/boxtrapper?mailbox=other@alice.test', 'GET'))).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('keeps saved settings truthful when no host agent answers', async () => {
    const none = await fixture({ host: 'none' }), failing = await fixture({ host: 'failing' })
    expect(await (await none.web(...json('/api/webmail/boxtrapper', 'GET')))!.json()).toMatchObject({ host: { state: 'not-connected', ready: null, active: null }, lists: null })
    expect(await (await failing.web(...json('/api/webmail/boxtrapper', 'GET')))!.json()).toMatchObject({ host: { state: 'unverified', ready: null }, lists: null })
    await expect(none.web(...json('/api/webmail/boxtrapper/queue', 'POST', { op: 'queue', args: { day: 'latest' } }))).rejects.toMatchObject({ detail: expect.objectContaining({ reason: 'host_agent_unavailable' }) })
  })

  it('passes queue operations to the host as the account, audits changes and refuses a hostile answer', async () => {
    const t = await fixture()
    const op = (body: unknown) => t.own(...json(`${owned}/queue`, 'POST', body))
    expect(await (await op({ op: 'queue', args: { day: '2026-11-07' } }))!.json()).toMatchObject({ rows: [{ id: ID, from: 'x@y.test' }] })
    expect(t.calls.at(-1)).toMatchObject({ username: 'alice', mutation: false, body: { mailbox: MAILBOX, call: { op: 'queue', day: '20261107' } } })
    expect(await (await op({ op: 'act', args: { action: 'allow', ids: [ID] } }))!.json()).toEqual({ done: 1, failed: 0, stateChanged: true })
    expect(t.calls.at(-1)).toMatchObject({ mutation: true, body: { call: { op: 'act', action: 'allow', ids: [ID] } } })
    const lists = { allow: ['from *@ok.test', 'friend@ok.test'], ignore: ['subject casino*'], deny: [] }
    expect(await (await op({ op: 'lists', args: { lists, revision: 'b'.repeat(64) } }))!.json()).toMatchObject({ lists, listsRevision: 'c'.repeat(64), stateChanged: true })
    expect(t.audits.map(item => item.action)).toEqual(['mail.boxtrapper.queue_action', 'mail.boxtrapper.lists_saved'])
    await expect(op({ op: 'act', args: { action: 'wipe', ids: [ID] } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(op({ op: 'act', args: { action: 'allow', ids: ['../etc'] } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(op({ op: 'lists', args: { lists: { ...lists, deny: ['two loose words'] }, revision: 'b'.repeat(64) } })).rejects.toMatchObject({ detail: expect.objectContaining({ reason: 'boxtrapper_rule_invalid' }) })
    await expect(op({ op: 'invented', args: {} })).rejects.toMatchObject({ code: 'VALIDATION' })
    const hostile = await fixture({ host: 'hostile' })
    await expect(hostile.web(...json('/api/webmail/boxtrapper/queue', 'POST', { op: 'queue', args: { day: 'latest' } }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('serves only the hosting account owner and only its own mailboxes', async () => {
    const t = await fixture(), root = await fixture({ kind: 'root' })
    expect(await (await t.own(...json('/api/mail/boxtrapper', 'GET')))!.json()).toEqual({ mailboxes: [{ mailbox: MAILBOX, enabled: false }] })
    await expect(root.own(...json('/api/mail/boxtrapper', 'GET'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(t.own(...json(`/api/mail/boxtrapper/${encodeURIComponent('other@alice.test')}`, 'GET'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    t.moveMailbox()
    await expect(t.own(...json(owned, 'GET'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(t.own(...json('/api/mail/boxtrapper', 'POST'))).resolves.toMatchObject({ status: 405 })
  })
})
