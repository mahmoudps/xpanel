import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { fillNotification, handleNotificationTemplateRoute, notificationText, sendNotification } from './notification-templates.ts'
import type { NotificationTemplateHelpers } from './notification-templates.ts'

const ROOT = { principal: { kind: 'root', id: '1', username: 'root' } } as unknown as AuthenticatedCaller
const BASE = 'http://api.test/api/server/notification-templates'
const version = { subject: 'Suspended {account}', body: 'Account {account} on {server}' }

describe('notification templates', { tags: ['unit'] }, () => {
  let root = ''
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-notify-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const lease = { assertFencingToken: async () => undefined, release: async () => undefined }
  function harness() {
    const email = vi.fn(async () => undefined)
    const helpers = { store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) }, requireCaller: vi.fn(async () => ROOT), assertRoot: vi.fn(async () => undefined), emitAudit: vi.fn(async () => ({})), email: async () => email, adminEmail: async () => 'root@server.test' } as unknown as NotificationTemplateHelpers
    const call = async (op = '', body?: unknown) => {
      const url = BASE + (op ? '/' + op : ''), response = await handleNotificationTemplateRoute(new Request(url, op ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), new URL(url), op ? 'POST' : 'GET', helpers)
      return response!.json() as Promise<any>
    }
    return { helpers, call, email }
  }
  it('lists each event with its variables and the product text in both languages', async () => {
    const { events } = await harness().call()
    expect(events.map((row: { event: string }) => row.event)).toContain('account.suspended')
    expect(events[0]).toMatchObject({ state: 'default', variables: '{account} {domain} {server}' })
    expect(events[0].en.subject).toContain('{account}'); expect(events[0].ar.subject.length).toBeGreaterThan(0)
  })
  it('refuses an unknown variable with its name and keeps the saved text', async () => {
    const h = harness(), { revision } = await h.call()
    await expect(h.call('save', { event: 'account.suspended', en: { subject: 'x', body: 'Hi {nickname}' }, ar: version, expectedRevision: revision })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('{nickname}') })
    expect((await h.call()).events.find((row: { event: string }) => row.event === 'account.suspended').state).toBe('default')
  })
  it('previews with sample values, sends the saved text and returns to the product text', async () => {
    const h = harness(), { revision } = await h.call()
    const saved = await h.call('save', { event: 'account.suspended', en: version, ar: version, expectedRevision: revision })
    expect(saved.events.find((row: { event: string }) => row.event === 'account.suspended').state).toBe('custom')
    expect(await h.call('preview', { event: 'account.suspended', locale: 'en' })).toMatchObject({ subject: 'Suspended alice', body: 'Account alice on server.example.com' })
    expect(await h.call('test', { event: 'account.suspended', locale: 'en' })).toMatchObject({ sentTo: 'root@server.test' })
    expect(h.email).toHaveBeenCalledWith({ to: ['root@server.test'], subject: 'Suspended alice', text: 'Account alice on server.example.com' })
    await sendNotification({ store: { rootDir: root }, email: h.email as never }, { event: 'account.suspended', to: 'a@b.test', locale: 'ar', values: { account: 'bob', server: 's' } })
    expect(h.email).toHaveBeenLastCalledWith({ to: ['a@b.test'], subject: 'Suspended bob', text: 'Account bob on s' })
    await h.call('reset', { event: 'account.suspended', locale: 'en', expectedRevision: saved.revision })
    expect((await notificationText({ rootDir: root }, 'account.suspended', 'en', { account: 'bob' })).subject).toContain('suspended')
  })
  it('refuses a test without an administrator address', async () => {
    const h = harness()
    h.helpers.adminEmail = async () => null
    await expect(h.call('test', { event: 'account.suspended' })).rejects.toMatchObject({ detail: expect.objectContaining({ reason: 'contact_unavailable' }) })
  })
  it('never lets a value add a header line', () => {
    expect(fillNotification({ subject: 'Hi {account}', body: '{account}' }, { account: 'a\r\nBcc: x@y' }).subject).toBe('Hi a Bcc: x@y')
  })
})
