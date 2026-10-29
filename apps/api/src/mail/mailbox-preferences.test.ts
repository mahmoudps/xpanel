import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { profileFor } from '@xpanel/os'
import { services as render } from '@xpanel/render'
import type { SealedMailboxSession } from './folder-admin.ts'
import { handleMailboxPreferencesRoute, mailboxPreferencesRevision, plusAddressingFromMain } from './mailbox-preferences.ts'
import type { MailboxPreferencesPorts } from './mailbox-preferences.ts'

const MAILBOX = 'alice@example.test', ACCOUNT = '11111111-1111-4111-8111-111111111111', SERVICE = '22222222-2222-4222-8222-222222222222'
const IDENTITY = '33333333-3333-4333-8333-333333333333', FOREIGN_IDENTITY = '44444444-4444-4444-8444-444444444444'
const authority = { accountId: ACCOUNT, serviceUserId: SERVICE, mailbox: MAILBOX }
const session = (over: Partial<SealedMailboxSession['record']> = {}): SealedMailboxSession => ({ record: { sessionId: 's1', mailbox: MAILBOX, accountId: ACCOUNT, serviceUserId: SERVICE, ...over }, password: 'sealed' })
const fields = { density: 'compact', messagesPerPage: 100, replyIdentityId: null, dateFormat: 'local' }
let root = ''
const prefsPath = () => join(root, 'extended', 'webmail', 'preferences', encodeURIComponent(MAILBOX) + '.json')
const write = async (target: string, value: unknown) => { await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, JSON.stringify(value)) }
const identity = (id: string, mailbox: string, owner = authority) => ({ id, mailbox, ownerAuthority: owner, displayName: 'Alice Sales', email: mailbox, replyTo: '', textSignature: '', htmlSignature: '', isDefault: false, createdAt: '2026-10-27T10:00:00.000Z' })

function harness(options: { sessions?: SealedMailboxSession[]; serviceUserId?: string; audit?: MailboxPreferencesPorts['audit']; os?: boolean } = {}) {
  let call = 0
  const audit = vi.fn(options.audit ?? (async () => undefined))
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const ports: MailboxPreferencesPorts = {
    open: async () => options.sessions?.[Math.min(call++, options.sessions.length - 1)] ?? session(),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }),
      getServiceUserByLogin: async () => ({ id: options.serviceUserId ?? SERVICE, accountId: ACCOUNT, login: MAILBOX, services: { email: true } }),
      getAccount: async () => ({ id: ACCOUNT, status: 'active' }) } as unknown as MailboxPreferencesPorts['store'],
    audit, now: () => new Date('2026-10-27T12:00:00.000Z'),
    ...(options.os === false ? {} : { os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\n') }),
  }
  const send = (method = 'GET', body?: unknown, query = '') => handleMailboxPreferencesRoute(new Request('http://api.test/api/webmail/preferences' + query, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    new URL('http://api.test/api/webmail/preferences' + query), method, ports)
  const read = async () => (await (await send())!.json()) as Record<string, any>
  return { audit, lease, send, read }
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-mbx-prefs-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('mailbox preferences view', () => {
  it('starts empty with bound identities and the rendered plus-addressing state', async () => {
    await write(join(root, 'extended', 'webmail', 'identities.json'), [identity(IDENTITY, MAILBOX), identity(FOREIGN_IDENTITY, 'bob@example.test', { ...authority, mailbox: 'bob@example.test' })])
    const view = await harness().read()
    expect(view).toMatchObject({ context: { mailbox: MAILBOX }, preferences: null, review: null, identities: [{ id: IDENTITY, displayName: 'Alice Sales', email: MAILBOX }],
      application: { status: 'saved_only', applied: false }, revision: mailboxPreferencesRevision(null, null) })
    // The rendered Postfix local-delivery block decides; Dovecot's own delimiter does not make Postfix accept user+tag.
    const rendered = render.localDeliveryMainBlock(profileFor('ID=ubuntu\nVERSION_ID="24.04"\n'))
    expect(view.plusAddressing.state).toBe(/^recipient_delimiter = \S/m.test(rendered) ? 'supported' : 'not-supported')
    expect((await harness({ os: false }).read()).plusAddressing).toEqual({ state: 'unknown', delimiter: null, source: 'rendered-postfix-local-delivery' })
  })
  it('maps a rendered recipient_delimiter to an explained supported state', () => {
    expect(plusAddressingFromMain(new Map([['recipient_delimiter', '+']]))).toEqual({ state: 'supported', delimiter: '+', source: 'rendered-postfix-local-delivery' })
    expect(plusAddressingFromMain(new Map([['recipient_delimiter', '']])).state).toBe('not-supported')
  })
  it('hides a record of an earlier mailbox lifetime and refuses to overwrite it', async () => {
    await write(prefsPath(), { mailbox: MAILBOX, ownerAuthority: { ...authority, serviceUserId: FOREIGN_IDENTITY }, ...fields, updatedAt: '2026-10-27T10:00:00.000Z' })
    const h = harness(), view = await h.read()
    expect(view).toMatchObject({ preferences: null, review: 'mailbox_metadata_binding_unverified' })
    await expect(h.send('PUT', { ...fields, expectedRevision: view.revision })).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { stateChanged: false } })
  })
  it('refuses selectors, other methods and a session whose mailbox lifetime changed', async () => {
    await expect(harness().send('GET', undefined, '?mailbox=bob@example.test')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await harness().send('DELETE'))!.status).toBe(405)
    await expect(harness({ serviceUserId: FOREIGN_IDENTITY }).read()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('mailbox preferences writes', () => {
  it('saves exact fields with ownerAuthority, audits and reads them back', async () => {
    await write(join(root, 'extended', 'webmail', 'identities.json'), [identity(IDENTITY, MAILBOX)])
    const h = harness(), before = await h.read()
    const saved = await (await h.send('PUT', { ...fields, replyIdentityId: IDENTITY, expectedRevision: before.revision }))!.json()
    expect(saved).toMatchObject({ stateChanged: true, preferences: { mailbox: MAILBOX, density: 'compact', messagesPerPage: 100, replyIdentityId: IDENTITY, dateFormat: 'local', updatedAt: '2026-10-27T12:00:00.000Z' } })
    expect(saved.preferences.ownerAuthority).toBeUndefined()
    expect(JSON.parse(await readFile(prefsPath(), 'utf8'))).toEqual({ mailbox: MAILBOX, ownerAuthority: authority, ...fields, replyIdentityId: IDENTITY, updatedAt: '2026-10-27T12:00:00.000Z' })
    expect(saved.revision).not.toBe(before.revision)
    expect(h.audit).toHaveBeenCalledWith(expect.any(Request), { action: 'webmail.preferences.updated', mailbox: MAILBOX, detail: { ...fields, replyIdentityId: IDENTITY } })
    expect(h.lease.release).toHaveBeenCalledTimes(1)
  })
  it('returns 409 for a stale revision without writing', async () => {
    await write(prefsPath(), { mailbox: MAILBOX, ownerAuthority: authority, ...fields, updatedAt: '2026-10-27T10:00:00.000Z' })
    const h = harness()
    await expect(h.send('PUT', { ...fields, density: 'comfortable', expectedRevision: mailboxPreferencesRevision(null, null) })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(JSON.parse(await readFile(prefsPath(), 'utf8')).density).toBe('compact')
  })
  it('validates exact keys, allowed values and the reply identity of this mailbox', async () => {
    await write(join(root, 'extended', 'webmail', 'identities.json'), [identity(FOREIGN_IDENTITY, 'bob@example.test', { ...authority, mailbox: 'bob@example.test' })])
    const h = harness(), revision = (await h.read()).revision
    for (const patch of [{ density: 'tiny' }, { messagesPerPage: 30 }, { messagesPerPage: '50' }, { dateFormat: 'iso' }, { replyIdentityId: 'x' }, { expectedRevision: 'abc' }, { mailbox: 'bob@example.test' }])
      await expect(h.send('PUT', { ...fields, expectedRevision: revision, ...patch })).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    const { replyIdentityId: _omit, ...partial } = fields
    await expect(h.send('PUT', { ...partial, expectedRevision: revision })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', { ...fields, replyIdentityId: FOREIGN_IDENTITY, expectedRevision: revision })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'identity_unavailable' } })
    await expect(readFile(prefsPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('re-checks the sealed session before writing and reports an unrecorded save as unverified', async () => {
    const changed = harness({ sessions: [session(), session(), session({ sessionId: 's2' })] })
    await expect(changed.send('PUT', { ...fields, expectedRevision: mailboxPreferencesRevision(null, null) })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    const unaudited = harness({ audit: async () => { throw new Error('audit down') } })
    await expect(unaudited.send('PUT', { ...fields, expectedRevision: mailboxPreferencesRevision(null, null) })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
  })
})
