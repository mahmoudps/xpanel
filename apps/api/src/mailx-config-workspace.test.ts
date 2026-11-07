import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail, isXpanelError } from '@xpanel/core'
import { atomicWriteJson } from '@xpanel/state'
import { createTestStateStore } from '@xpanel/state'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuthenticatedCaller } from './auth.ts'
import { MAILX_BACKUPS_MAX, createMailxConfigRoutes, mailxGeneratedFingerprint, mailxReleasedKeys } from './mailx-config-workspace.ts'
import { readMailxSaved } from '../../agent/src/mailx-routes.ts'
import { mailxCompositeRevision, mailxStatePath } from '../../agent/src/mailx-policy.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const task of cleanup.splice(0)) await task() })
const root = { principal: { id: 'root-id', kind: 'root', username: 'root' }, sessionId: 's1' } as unknown as AuthenticatedCaller
const at = { updatedAt: '2026-11-07T10:00:00.000Z', updatedBy: 'root' }
const server = (size: string) => ({ section: 'server', policy: { postfix: { message_size_limit: size }, dovecot: {}, rbl: ['zen.example.test'], certificates: { smtp: null, submission: null, imap: null } }, ...at })
const relay = { section: 'relay', policy: { enabled: true, host: 'smtp.relay.test', port: 587, username: 'sender' }, secret: { password: 'relay-pass', version: '11111111-1111-4111-8111-111111111111' }, ...at }

async function fixture(options: { host?: boolean; applyError?: unknown } = {}) {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const dir = join(state.store.rootDir, 'extended', 'mailx')
  const put = (name: string, value: unknown) => atomicWriteJson(join(dir, name + '.json'), value, 0o640)
  let current = root
  const audits: { action: string }[] = []
  const callHost = vi.fn(async (_caller: AuthenticatedCaller, _path: string, _body?: unknown) => { if (options.applyError) throw options.applyError; return { outcome: 'applied', verificationRequired: false } })
  const routes = createMailxConfigRoutes({ store: state.store, requireCaller: async () => current, assertRoot: async who => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
    emitAudit: async entry => { audits.push(entry as { action: string }) }, ...(options.host === false ? {} : { callHost }), now: () => new Date() })
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const request = new Request('http://localhost' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    try { const response = await routes(request, new URL(request.url), method); return { status: response?.status ?? 404, body: response && response.status !== 405 ? await response.json() as Record<string, any> : {} } }
    catch (error) { if (isXpanelError(error)) return { status: 0, code: error.code, detail: error.detail, body: {} as Record<string, any> }; throw error }
  }
  const revision = async () => mailxCompositeRevision(await readMailxSaved(state.store.rootDir))
  return { state, put, call, callHost, audits, revision, as: (who: AuthenticatedCaller) => { current = who } }
}

describe('mail configuration backups', () => {
  it('backup, change, then restore gives back the generated configuration byte for byte', async () => {
    const f = await fixture()
    await f.put('server', server('10485760'))
    const original = mailxGeneratedFingerprint((await readMailxSaved(f.state.store.rootDir)).sections)
    const created = await f.call('/api/server/mailx-config/backups', 'POST')
    expect(created.status).toBe(201)
    await f.put('server', server('20971520'))
    expect(mailxGeneratedFingerprint((await readMailxSaved(f.state.store.rootDir)).sections)).not.toBe(original)
    const restored = await f.call('/api/server/mailx-config/restore', 'POST', { backup: created.body.backup.id, expectedRevision: await f.revision() })
    expect(restored).toMatchObject({ status: 200, body: { fingerprint: original, application: { outcome: 'applied' } } })
    expect(mailxGeneratedFingerprint((await readMailxSaved(f.state.store.rootDir)).sections)).toBe(original)
    expect(f.audits.map(item => item.action)).toEqual(['server.mail_policy.backup_created', 'server.mail_policy.restored'])
  })
  it('removes a section the backup did not have and takes a safety copy first', async () => {
    const f = await fixture()
    const created = await f.call('/api/server/mailx-config/backups', 'POST')
    await f.put('advanced', { section: 'advanced', policy: { postfix: { smtp_connect_timeout: '10s' } }, ...at })
    const restored = await f.call('/api/server/mailx-config/restore', 'POST', { backup: created.body.backup.id, expectedRevision: await f.revision() })
    expect((await readMailxSaved(f.state.store.rootDir)).sections.advanced).toBeNull()
    expect(f.callHost.mock.calls[0]![2]).toMatchObject({ unset: ['smtp_connect_timeout'] })
    expect((await f.call('/api/server/mailx-config/backups')).body.backups.map((item: { id: string }) => item.id)).toContain(restored.body.safetyBackup)
  })
  it('never lets the relay password leave in a download or a listing', async () => {
    const f = await fixture()
    await atomicWriteJson(join(f.state.store.rootDir, 'extended', 'mailx', 'relay.json'), relay, 0o600)
    const created = await f.call('/api/server/mailx-config/backups', 'POST')
    const download = await f.call('/api/server/mailx-config/backups/' + created.body.backup.id)
    expect(JSON.stringify(download.body)).not.toContain('relay-pass')
    expect(JSON.stringify(await f.call('/api/server/mailx-config/backups'))).not.toContain('relay-pass')
    expect(download.body.sections.relay.policy.username).toBe('sender')
  })
  it('restores an uploaded copy with the saved relay password, and refuses another relay user', async () => {
    const f = await fixture()
    await atomicWriteJson(join(f.state.store.rootDir, 'extended', 'mailx', 'relay.json'), relay, 0o600)
    const created = await f.call('/api/server/mailx-config/backups', 'POST')
    const document = (await f.call('/api/server/mailx-config/backups/' + created.body.backup.id)).body
    expect((await f.call('/api/server/mailx-config/restore', 'POST', { backup: document, expectedRevision: await f.revision() })).status).toBe(200)
    expect((await readMailxSaved(f.state.store.rootDir)).sections.relay?.secret?.password).toBe('relay-pass')
    document.sections.relay.policy.username = 'other'
    expect(await f.call('/api/server/mailx-config/restore', 'POST', { backup: document, expectedRevision: await f.revision() })).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'relay_password_required' } })
  })
  it('refuses a malformed upload, a stale revision and an unknown backup without changing anything', async () => {
    const f = await fixture()
    const revision = await f.revision()
    expect(await f.call('/api/server/mailx-config/restore', 'POST', { backup: { sections: { server: { section: 'server', policy: {} } } }, expectedRevision: revision })).toMatchObject({ code: 'VALIDATION' })
    expect(await f.call('/api/server/mailx-config/restore', 'POST', { backup: { sections: {} }, expectedRevision: 'f'.repeat(64) })).toMatchObject({ code: 'CONFLICT' })
    expect(await f.call('/api/server/mailx-config/restore', 'POST', { backup: '11111111-1111-4111-8111-111111111111', expectedRevision: revision })).toMatchObject({ code: 'NOT_FOUND' })
    expect(f.callHost).not.toHaveBeenCalled()
  })
  it('keeps the newest copies only', async () => {
    const f = await fixture()
    await f.call('/api/server/mailx-config/backups', 'POST')
    // Older copies are seeded on disk, so the rule is proved by one more save instead of twenty.
    const dir = join(f.state.store.rootDir, ...mailxStatePath('backups')), [name] = await readdir(dir), copy = JSON.parse(await readFile(join(dir, name!), 'utf8')) as object
    for (let index = 0; index < MAILX_BACKUPS_MAX; index++) { const id = randomUUID(); await writeFile(join(dir, `2000-01-01T00-00-${String(index).padStart(2, '0')}-000Z-${id}.json`), JSON.stringify({ ...copy, id })) }
    const newest = await f.call('/api/server/mailx-config/backups', 'POST')
    const { backups } = (await f.call('/api/server/mailx-config/backups')).body
    expect(backups).toHaveLength(MAILX_BACKUPS_MAX)
    expect(backups[0].id).toBe(newest.body.backup.id)
  })
  it('is root only', async () => {
    const f = await fixture()
    f.as({ principal: { id: 'u', kind: 'user', username: 'alice', accountId: 'a' }, sessionId: 's2' } as unknown as AuthenticatedCaller)
    expect(await f.call('/api/server/mailx-config/backups')).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('mail configuration reset', () => {
  it('resets advanced options alone and hands their keys back to Postfix', async () => {
    const f = await fixture()
    await f.put('server', server('10485760'))
    await f.put('advanced', { section: 'advanced', policy: { postfix: { smtp_connect_timeout: '10s' } }, ...at })
    expect((await f.call('/api/server/mailx-config/reset', 'POST', { type: 'advanced', expectedRevision: await f.revision() })).status).toBe(200)
    const saved = await readMailxSaved(f.state.store.rootDir)
    expect(saved.sections.advanced).toBeNull()
    expect(saved.sections.server?.policy.postfix.message_size_limit).toBe('10485760')
    expect(f.callHost.mock.calls[0]![2]).toEqual({ revision: await f.revision(), unset: ['smtp_connect_timeout'] })
  })
  it('a full reset keeps every saved section managed with defaults, clears its keys and takes a safety copy', async () => {
    const f = await fixture()
    await f.put('server', server('10485760'))
    await atomicWriteJson(join(f.state.store.rootDir, 'extended', 'mailx', 'relay.json'), relay, 0o600)
    const reply = await f.call('/api/server/mailx-config/reset', 'POST', { type: 'full', expectedRevision: await f.revision() })
    const saved = await readMailxSaved(f.state.store.rootDir)
    expect(saved.sections.server?.policy.postfix).toEqual({})
    expect(saved.sections.server?.policy.certificates.smtp).toBeNull()
    expect(saved.sections.relay).toMatchObject({ policy: { enabled: false, username: null }, secret: null })
    expect(saved.sections.spam).toBeNull()
    expect(f.callHost.mock.calls[0]![2]).toMatchObject({ unset: expect.arrayContaining(['message_size_limit', 'mailbox_size_limit', 'smtpd_client_restrictions']) })
    expect(reply.body.safetyBackup).toEqual(expect.any(String))
  })
  it('reports a refused or lost apply truthfully', async () => {
    const lost = await fixture({ applyError: new Error('lost') })
    expect((await lost.call('/api/server/mailx-config/reset', 'POST', { type: 'full', expectedRevision: await lost.revision() })).body.application).toEqual({ outcome: 'unknown', verificationRequired: true })
    const none = await fixture({ host: false })
    expect((await none.call('/api/server/mailx-config/reset', 'POST', { type: 'full', expectedRevision: await none.revision() })).body.application).toEqual({ outcome: 'not-connected', verificationRequired: false })
  })
  it('refuses an unknown reset type', async () => {
    const f = await fixture()
    expect(await f.call('/api/server/mailx-config/reset', 'POST', { type: 'acls', expectedRevision: await f.revision() })).toMatchObject({ code: 'VALIDATION' })
  })
})

describe('released keys', () => {
  it('lists only keys the next configuration stops setting', () => {
    const before = { advanced: { section: 'advanced', policy: { postfix: { a_key: '1', b_key: '2' } }, ...at } } as never, after = { advanced: { section: 'advanced', policy: { postfix: { b_key: '3' } }, ...at } } as never
    expect(mailxReleasedKeys(before, after)).toEqual(['a_key'])
  })
})
