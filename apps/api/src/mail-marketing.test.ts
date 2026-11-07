import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { applyMarketingOutcomes, handleMailMarketingRoute, handleUnsubscribeRoute, MARKETING_STATE, parseSubscriberImport, readUnsubscribeToken, renderMarketing, runMarketingTick, UNSUBSCRIBE_PATH, unsubscribeToken } from './mail-marketing.ts'
import type { MarketingRouteHelpers, MarketingTickPorts } from './mail-marketing.ts'
import { readJsonIfExists } from '@xpanel/state'

const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const USER = { ...ROOT, principal: { kind: 'user', id: '2', username: 'alice' } } as unknown as AuthenticatedCaller

describe('template rendering', { tags: ['unit'] }, () => {
  const template = { subject: 'Hi {address}', text: 'Body', html: '' }
  it('adds the unsubscribe link when the template has none', () => {
    expect(renderMarketing(template, '', 'a@b.test', 'https://x.test/u').text).toBe('Body\n\nhttps://x.test/u')
    expect(renderMarketing({ ...template, text: 'Leave: {unsubscribeUrl}' }, '', 'a@b.test', 'https://x.test/u').text).toBe('Leave: https://x.test/u')
  })
  it('escapes values into HTML and keeps the subject on one line', () => {
    const message = renderMarketing({ ...template, html: '<p>{address}</p>' }, 'A {address}', 'a&b@b.test', 'https://x.test/u?t=1&x=2')
    expect(message.html).toContain('<p>a&amp;b@b.test</p>'); expect(message.html).toContain('href="https://x.test/u?t=1&amp;x=2"')
    expect(message.subject).toBe('A a&b@b.test')
  })
})

describe('imports and tokens', { tags: ['unit'] }, () => {
  it('reads text and JSON lists and refuses a bad address', () => {
    expect(parseSubscriberImport('A@b.test\nc@d.test, a@b.test')).toEqual(['a@b.test', 'c@d.test'])
    expect(parseSubscriberImport('["a@b.test",{"address":"c@d.test"}]')).toEqual(['a@b.test', 'c@d.test'])
    expect(() => parseSubscriberImport('not an address')).toThrow()
    expect(() => parseSubscriberImport('')).toThrow()
  })
  it('refuses a changed token', () => {
    const secret = Buffer.alloc(32, 7), token = unsubscribeToken(secret, 'group', 'a@b.test')
    expect(readUnsubscribeToken(secret, token)).toEqual({ groupId: 'group', address: 'a@b.test' })
    expect(readUnsubscribeToken(secret, token.slice(0, -2) + 'xx')).toBeNull()
    expect(readUnsubscribeToken(Buffer.alloc(32, 8), token)).toBeNull()
    expect(readUnsubscribeToken(secret, 'bare')).toBeNull()
  })
})

describe('campaigns, lists and flows', { tags: ['unit'] }, () => {
  let root = ''
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-marketing-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const lease = { assertFencingToken: async () => undefined, release: async () => undefined }
  const store = () => ({ rootDir: root, getWriterLock: () => ({ acquire: async () => lease }), listDomains: async () => [{ name: 'alice.test' }] }) as unknown as MarketingRouteHelpers['store']
  function harness(caller = ROOT) {
    const email = vi.fn(async () => undefined)
    const helpers: MarketingRouteHelpers = { store: store(), publicOrigin: 'https://panel.test', email: async () => email, requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async (current: AuthenticatedCaller) => { if (current.principal.kind !== 'root') fail('FORBIDDEN', 'root required', { stateChanged: false }) }), emitAudit: vi.fn(async () => ({})) as never, resolveMx: async domain => domain !== 'dead.test' }
    const send = async (op: string, body?: Record<string, unknown>) => {
      const revision = op ? ((await (await handleMailMarketingRoute(new Request('http://api.test/api/server/mail/marketing'), new URL('http://api.test/api/server/mail/marketing'), 'GET', helpers))!.json()) as { revision: string }).revision : ''
      const url = 'http://api.test/api/server/mail/marketing' + (op ? '/' + op : '')
      const response = await handleMailMarketingRoute(new Request(url, op ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, expectedRevision: revision }) } : {}), new URL(url), op ? 'POST' : 'GET', helpers)
      return response!.json() as Promise<any>
    }
    return { helpers, send, email }
  }
  const prepared = async () => {
    const h = harness()
    await h.send('groups/add', { name: 'News' })
    await h.send('subscribers/import', { group: 'News', addresses: 'a@remote.test\nb@remote.test\nc@remote.test' })
    await h.send('templates/save', { name: 'Hello', subject: 'Hello {address}', text: 'Welcome', html: '' })
    await h.send('campaigns/save', { name: 'Launch', fromName: 'Alice', fromAddress: 'news@alice.test', subject: '', group: 'News', template: 'Hello', ratePerMinute: 2, scheduledAt: '' })
    return h
  }
  const tick = (email: MarketingTickPorts['email'], webhook: MarketingTickPorts['webhook'] = async () => ({ status: 200 })) => runMarketingTick({ store: store(), email, webhook, publicOrigin: 'https://panel.test', now: () => new Date(Date.now() + 60_000) })

  it('is root only and stores the file with the writer lock', async () => {
    await expect(harness(USER).send('')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await prepared()
    expect((await stat(join(root, MARKETING_STATE))).mode & 0o777).toBe(0o640)
  })
  it('refuses a sender outside the hosted domains, an unknown variable and a stale revision', async () => {
    const h = await prepared()
    await expect(h.send('campaigns/save', { name: 'X', fromName: 'A', fromAddress: 'a@other.test', subject: '', group: 'News', template: 'Hello', ratePerMinute: 2, scheduledAt: '' })).rejects.toMatchObject({ detail: expect.objectContaining({ reason: 'sender_not_hosted' }) })
    await expect(h.send('templates/save', { name: 'Bad', subject: 'x', text: 'Hi {firstName}', html: '' })).rejects.toMatchObject({ code: 'VALIDATION', detail: expect.objectContaining({ variable: 'firstName' }) })
    const url = 'http://api.test/api/server/mail/marketing/groups/add'
    await expect(handleMailMarketingRoute(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Y', expectedRevision: 'a'.repeat(64) }) }), new URL(url), 'POST', h.helpers)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('sends at its rate, puts a working unsubscribe link in each message and excludes who used it', async () => {
    const h = await prepared(), sent: { to: string[]; text: string; headers?: Record<string, string>; messageId?: string }[] = []
    const email = vi.fn(async (message: (typeof sent)[number]) => { sent.push(message) }) as never
    const view = await h.send('')
    await h.send('campaigns/start', { id: view.campaigns[0].id })
    await tick(email)
    expect(sent.map(item => item.to[0])).toEqual(['a@remote.test', 'b@remote.test'])
    expect(sent[0]!.messageId).toMatch(/^<xpm-c[0-9a-f]{8}-0@alice\.test>$/)
    const link = /<(.+)>/.exec(sent[1]!.headers!['List-Unsubscribe']!)![1]!
    expect(sent[1]!.text).toContain(link); expect(link.startsWith('https://panel.test' + UNSUBSCRIBE_PATH)).toBe(true)
    expect(sent[1]!.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    const url = new URL(link), shown = await handleUnsubscribeRoute(new Request(link), url, 'GET', h.helpers.store)
    expect(await shown!.text()).toContain('<form method="post"')
    expect((await h.send('')).subscribers.find((row: { address: string }) => row.address === 'b@remote.test').groups).toBe('News')
    expect((await handleUnsubscribeRoute(new Request(link, { method: 'POST' }), url, 'POST', h.helpers.store))!.status).toBe(200)
    expect((await h.send('')).subscribers.find((row: { address: string }) => row.address === 'b@remote.test').groups).toBe('')
    await tick(email)
    expect((await h.send('')).campaigns[0]).toMatchObject({ status: 'finished', sent: 3 })
    await h.send('campaigns/save', { name: 'Second', fromName: 'Alice', fromAddress: 'news@alice.test', subject: 'Again', group: 'News', template: 'Hello', ratePerMinute: 10, scheduledAt: '' })
    await h.send('campaigns/start', { id: (await h.send('')).campaigns[1].id })
    sent.length = 0
    await tick(email)
    expect(sent.map(item => item.to[0])).toEqual(['a@remote.test', 'c@remote.test'])
  })
  it('refuses a forged unsubscribe link', async () => {
    const h = await prepared(), url = new URL('https://panel.test' + UNSUBSCRIBE_PATH + '?t=abc.def')
    expect((await handleUnsubscribeRoute(new Request(url, { method: 'POST' }), url, 'POST', h.helpers.store))!.status).toBe(404)
  })
  it('skips a suppressed address until it is removed, and counts log results', async () => {
    const h = await prepared(), view = await h.send(''), id = view.campaigns[0].id
    await h.send('suppressed/add', { address: 'a@remote.test' })
    await h.send('campaigns/start', { id })
    const email = vi.fn(async () => undefined)
    await tick(email)
    expect(email).toHaveBeenCalledOnce()
    await applyMarketingOutcomes(h.helpers.store, [{ messageId: `<xpm-c${id.slice(0, 8)}-1@alice.test>`, recipient: 'b@remote.test', status: 'bounced', at: '' }, { messageId: `<xpm-c${id.slice(0, 8)}-2@alice.test>`, recipient: 'c@remote.test', status: 'sent', at: '' }], new Date('2026-11-07T10:00:00Z'))
    const after = await h.send('')
    expect(after.campaigns[0]).toMatchObject({ skipped: 1, sent: 1, bounced: 1, delivered: 1 })
    expect(after.suppressed.map((row: { address: string; reason: string }) => row.reason)).toEqual(['manual', 'bounced'])
    await h.send('suppressed/remove', { address: 'a@remote.test' })
    expect((await h.send('')).suppressedTotal).toBe(1)
  })
  it('stops a minute at an unreachable mail server and resumes the same address', async () => {
    const h = await prepared(), view = await h.send('')
    await h.send('campaigns/start', { id: view.campaigns[0].id })
    const { DeliveryFailure } = await import('./alert-delivery.ts')
    await tick(vi.fn(async () => { throw new DeliveryFailure('unreachable') }))
    expect((await h.send('')).campaigns[0]).toMatchObject({ sent: 0, lastError: 'unreachable', status: 'sending' })
    const email = vi.fn(async () => undefined)
    await tick(email)
    expect((email.mock.calls[0] as unknown as [{ to: string[] }])[0].to).toEqual(['a@remote.test'])
  })
  it('scans for dead domains', async () => {
    const h = await prepared()
    await h.send('subscribers/import', { group: 'News', addresses: 'x@dead.test' })
    expect((await h.send('suppressed/scan', {})).suppressed).toEqual([expect.objectContaining({ address: 'x@dead.test', reason: 'invalid_domain' })])
  })
  it('runs a flow for a new group member: first step after its delay, then the webhook', async () => {
    const h = await prepared()
    await h.send('flows/save', { name: 'Welcome', group: 'News', fromName: 'Alice', fromAddress: 'news@alice.test', steps: ['delay 0', 'send Hello', 'webhook https://hooks.example.test/x'] })
    await h.send('flows/toggle', { id: (await h.send('')).flows[0].id })
    await h.send('subscribers/import', { group: 'News', addresses: 'new@remote.test' })
    const email = vi.fn(async () => undefined), webhook = vi.fn(async () => ({ status: 204 }))
    await tick(email, webhook); await tick(email, webhook); await tick(email, webhook)
    expect(email).toHaveBeenCalledOnce()
    expect((email.mock.calls[0] as unknown as [{ to: string[] }])[0].to).toEqual(['new@remote.test'])
    expect(webhook).toHaveBeenCalledOnce()
    expect((await h.send('')).flows[0]).toMatchObject({ sent: 1, webhooks: 1, waiting: 0 })
  })
  it('refuses a flow step that is not one of the three forms', async () => {
    const h = await prepared()
    await expect(h.send('flows/save', { name: 'Bad', group: 'News', fromName: 'A', fromAddress: 'news@alice.test', steps: ['exec rm'] })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('previews a template without saving', async () => {
    const h = await prepared(), view = await h.send(''), before = await readJsonIfExists(join(root, MARKETING_STATE))
    expect(await h.send('templates/preview', { id: view.templates[0].id })).toMatchObject({ subject: 'Hello subscriber@example.com' })
    expect(await readJsonIfExists(join(root, MARKETING_STATE))).toEqual(before)
  })
})
