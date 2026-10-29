import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { verifyWebhookSignature } from '../../agent/src/ops-webhooks.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { sha256Hex } from './auth.ts'
import { DeliveryFailure, readSavedDeliveryState } from './alert-delivery.ts'
import type { DeliveryTransports } from './alert-delivery.ts'
import { deliveryChannelsOf, handlePanelNotificationsRoute, NOTIFICATION_EVENTS, parseNotificationUpdate, readSavedNotificationSettings, signingKeyFingerprint } from './panel-notifications.ts'
import type { PanelNotificationsHelpers } from './panel-notifications.ts'
import { PANEL_NOTIFICATION_EVENT_LABELS } from '../../web/src/board-port/whm-panel-notifications-workspace.ts'

const root = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 's1', apiTokenId: null } as unknown as AuthenticatedCaller
const reseller = { principal: { kind: 'reseller', id: '22222222-2222-4222-8222-222222222222', username: 'res1' }, sessionId: 's2', apiTokenId: null } as unknown as AuthenticatedCaller
const ROUTE = '/api/server/panel/notifications', KEY = ROUTE + '/webhook-key', TEST = ROUTE + '/test'
const EMPTY = sha256Hex('null'), at = '2026-10-27T10:00:00.000Z'
const HOOK = 'https://hooks.example.com/xpanel'
const update = (patch: Record<string, unknown> = {}, expectedRevision = EMPTY) => ({ recipients: [], events: [], webhook: null, expectedRevision, ...patch })

const helpers = (initial: unknown = null, overrides: Partial<PanelNotificationsHelpers> = {}) => {
  const files: { saved: unknown; key: unknown; delivery: unknown } = { saved: initial, key: null, delivery: null }
  const audits: Record<string, unknown>[] = [], mail: { to: string[]; subject: string; text: string }[] = [], hooks: { url: string; body: string; headers: Record<string, string> }[] = []
  const clone = (value: unknown) => value === null ? null : JSON.parse(JSON.stringify(value))
  const transports: DeliveryTransports = { serverName: 'srv1.example.test', email: vi.fn(async message => { mail.push(message) }), webhook: vi.fn(async request => { hooks.push(request); return { status: 204 } }) }
  const base: PanelNotificationsHelpers = {
    requireCaller: vi.fn(async () => root),
    assertRoot: vi.fn(async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation') }),
    emitAudit: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry) }),
    readSaved: vi.fn(async () => clone(files.saved)), writeSaved: vi.fn(async (value: unknown) => { files.saved = clone(value); return value }),
    readSigningKey: vi.fn(async () => clone(files.key)), writeSigningKey: vi.fn(async (value: unknown) => { files.key = clone(value); return value }),
    readDelivery: vi.fn(async () => clone(files.delivery)), writeDelivery: vi.fn(async (value: unknown) => { files.delivery = clone(value); return value }),
    transports, now: () => new Date(at),
    ...overrides,
  }
  return { helpers: base, audits, files, mail, hooks }
}
const call = (method: string, h: PanelNotificationsHelpers, body?: unknown, path = ROUTE, type = 'application/json') => {
  const url = new URL('http://localhost' + path)
  return handlePanelNotificationsRoute(new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': type } }) }), url, method, h)
}
type View = { state: string; settings: Record<string, unknown> | null; revision: string; signingKey: { fingerprint: string } | null; createdSigningKey?: string; test?: { results: { channel: string; error: string | null }[] } }
const read = async (response: Response | null): Promise<View> => { expect(response!.status).toBe(200); return await response!.json() as View }

describe('notification settings grammar', () => {
  it('lists the alert event and the audit actions, matching the web labels', () => {
    expect(Object.keys(PANEL_NOTIFICATION_EVENT_LABELS).sort()).toEqual([...NOTIFICATION_EVENTS].sort())
    expect(NOTIFICATION_EVENTS[0]).toBe('monitoring.alert')
  })

  it('validates recipients, events, the webhook and the revision strictly', () => {
    expect(parseNotificationUpdate(update({ recipients: ['Ops@Example.com'], events: ['auth.lockout'] }))).toEqual({ recipients: ['ops@example.com'], events: ['auth.lockout'], webhook: null, expectedRevision: EMPTY })
    expect(parseNotificationUpdate(update({ events: ['monitoring.alert'], webhook: { url: HOOK, enabled: true } })).webhook).toEqual({ url: HOOK, enabled: true })
    for (const bad of [
      update({ recipients: ['not-an-address'] }), update({ recipients: ['a@example.com', 'A@example.com'] }), update({ recipients: Array.from({ length: 11 }, (_, i) => `ops${i}@example.com`) }),
      update({ recipients: ['ops@example.com'], events: ['auth.login'] }), update({ recipients: ['ops@example.com'], events: ['auth.lockout', 'auth.lockout'] }),
      update({ events: ['auth.lockout'] }), update({ events: ['monitoring.alert'], webhook: { url: HOOK, enabled: false } }), update({}, 'abc'), { ...update(), channel: 'sms' },
      { recipients: [], events: [], expectedRevision: EMPTY }, update({ recipients: 'ops@example.com' }),
      update({ webhook: { url: 'http://hooks.example.com/x', enabled: true } }), update({ webhook: { url: 'https://127.0.0.1/x', enabled: true } }), update({ webhook: { url: 'https://localhost/x', enabled: false } }),
      update({ webhook: { url: 'https://user:pw@hooks.example.com/x', enabled: true } }), update({ webhook: { url: HOOK, enabled: 'yes' } }), update({ webhook: { url: HOOK, enabled: true, secret: 'x' } }),
    ]) expect(() => parseNotificationUpdate(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })

  it('reads a saved file strictly and derives the delivery channels from it', () => {
    const good = { recipients: ['ops@example.com'], events: ['monitoring.alert'], webhook: { url: HOOK, enabled: true }, updatedAt: at, updatedBy: 'root' }
    expect(readSavedNotificationSettings(good)).toEqual(good)
    for (const bad of [{ ...good, extra: 1 }, { ...good, events: ['unknown'] }, { ...good, updatedAt: 'yesterday' }, { ...good, webhook: undefined }, []]) expect(readSavedNotificationSettings(bad)).toBeNull()
    const key = { key: 'whsec_' + 'a'.repeat(43), createdAt: at, createdBy: 'root' }
    expect(deliveryChannelsOf(good, key)).toEqual({ alerts: true, recipients: ['ops@example.com'], webhook: { url: HOOK, key: key.key } })
    expect(deliveryChannelsOf(good, { ...key, key: 'short' })!.webhook).toEqual({ url: HOOK, key: null })
    expect(deliveryChannelsOf({ ...good, events: [], webhook: { url: HOOK, enabled: false } }, key)).toEqual({ alerts: false, recipients: ['ops@example.com'], webhook: null })
    expect(deliveryChannelsOf({ recipients: 'x' }, key)).toBeNull()
  })
})

describe('notification settings workspace', () => {
  it('leaves unrelated routes untouched', async () => {
    const { helpers: h } = helpers()
    for (const path of [ROUTE + '/history', ROUTE + 's', '/api/server/panel/api-tokens']) expect(await call('GET', h, undefined, path)).toBeNull()
    expect(h.requireCaller).not.toHaveBeenCalled()
  })

  it('reads defaults with the delivery contract and no-store', async () => {
    const { helpers: h } = helpers()
    const response = (await call('GET', h))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ state: 'default', settings: null, revision: EMPTY, events: [...NOTIFICATION_EVENTS], signingKey: null,
      delivery: { events: ['monitoring.alert'], email: 'local_mta', webhook: 'https_signed', test: 'available' } })
  })

  it('saves under the observed revision, re-reads and audits without the webhook path', async () => {
    const { helpers: h, audits, files } = helpers()
    const body = await read(await call('PUT', h, update({ recipients: ['ops@example.com'], events: ['monitoring.alert', 'reconcile.failed'] })))
    expect(body).toMatchObject({ state: 'saved', settings: { recipients: ['ops@example.com'], events: ['monitoring.alert', 'reconcile.failed'], webhook: null, updatedBy: 'root', updatedAt: at } })
    expect(body.revision).toBe(sha256Hex(JSON.stringify(files.saved)))
    expect(audits).toEqual([expect.objectContaining({ action: 'server.notifications.updated', target: 'panel:notifications', detail: { recipients: 1, events: ['monitoring.alert', 'reconcile.failed'], webhook: null } })])
    await expect(call('PUT', h, update())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.writeSaved).toHaveBeenCalledTimes(1)
  })

  it('creates a signing key once, keeps it 0600-side only and requires one before enabling the webhook', async () => {
    const { helpers: h, audits, files } = helpers()
    await expect(call('PUT', h, update({ events: ['monitoring.alert'], webhook: { url: HOOK, enabled: true } }))).rejects.toMatchObject({ code: 'VALIDATION' })
    const created = await read(await call('POST', h, undefined, KEY))
    expect(created.createdSigningKey).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/)
    expect(created.signingKey).toEqual({ fingerprint: signingKeyFingerprint(created.createdSigningKey!), createdAt: at, createdBy: 'root' })
    expect(audits.at(-1)).toMatchObject({ action: 'server.notifications.webhook_key_created', detail: { fingerprint: signingKeyFingerprint(created.createdSigningKey!) } })
    expect(JSON.stringify(audits)).not.toContain(created.createdSigningKey)
    const saved = await read(await call('PUT', h, update({ events: ['monitoring.alert'], webhook: { url: HOOK, enabled: true } })))
    expect(saved.settings!.webhook).toEqual({ url: HOOK, enabled: true })
    const again = JSON.stringify(await read(await call('GET', h)))
    expect(again).not.toContain(created.createdSigningKey)
    expect(again).toContain(signingKeyFingerprint(created.createdSigningKey!))
    const rotated = await read(await call('POST', h, undefined, KEY))
    expect(rotated.createdSigningKey).not.toBe(created.createdSigningKey)
    expect((files.key as { key: string }).key).toBe(rotated.createdSigningKey)
  })

  it('sends a signed test on every saved channel and logs each result', async () => {
    const { helpers: h, files, mail, hooks, audits } = helpers()
    await expect(call('POST', h, undefined, TEST)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const key = (await read(await call('POST', h, undefined, KEY))).createdSigningKey!
    const view = await read(await call('PUT', h, update({ recipients: ['ops@example.com'], webhook: { url: HOOK, enabled: true } })))
    const tested = await read(await call('POST', h, undefined, TEST))
    expect(tested.test!.results).toEqual([{ channel: 'email', error: null, status: null }, { channel: 'webhook', error: null, status: 204 }])
    expect(tested.revision).toBe(view.revision)
    expect(mail).toEqual([expect.objectContaining({ to: ['ops@example.com'], subject: '[xPanel] Test notification from srv1.example.test' })])
    expect(hooks[0]!.headers['x-xpanel-event']).toBe('monitoring.alert.test')
    expect(verifyWebhookSignature(key, hooks[0]!.headers['x-xpanel-signature']!, hooks[0]!.body, Math.floor(Date.parse(at) / 1000))).toBe(true)
    expect(JSON.parse(hooks[0]!.body)).toMatchObject({ event: 'monitoring.alert.test', server: 'srv1.example.test', alert: null })
    const log = readSavedDeliveryState(files.delivery)!.log
    expect(log.map(entry => [entry.kind, entry.channel, entry.result])).toEqual([['test', 'webhook', 'sent'], ['test', 'email', 'sent']])
    expect(audits.at(-1)).toMatchObject({ action: 'server.notifications.tested', outcome: 'ok' })
  })

  it('reports a failed test channel truthfully', async () => {
    const { helpers: h, files, audits } = helpers()
    h.transports.email = vi.fn(async () => { throw new DeliveryFailure('refused', 554) })
    await call('PUT', h, update({ recipients: ['ops@example.com'] }))
    const tested = await read(await call('POST', h, undefined, TEST))
    expect(tested.test!.results).toEqual([{ channel: 'email', error: 'refused', status: 554 }])
    expect(readSavedDeliveryState(files.delivery)!.log[0]).toMatchObject({ kind: 'test', channel: 'email', result: 'failed', error: 'refused', status: 554 })
    expect(audits.at(-1)).toMatchObject({ action: 'server.notifications.tested', outcome: 'failed' })
  })

  it('reports an unreadable saved file as invalid and lets root replace it with its revision', async () => {
    const { helpers: h } = helpers({ recipients: 'nobody' })
    const view = await read(await call('GET', h))
    expect(view).toMatchObject({ state: 'invalid', settings: null })
    expect((await call('PUT', h, update({}, view.revision)))!.status).toBe(200)
  })

  it('refuses resellers with 403 and malformed requests with 400 before any write or send', async () => {
    const denied = helpers(null, { requireCaller: vi.fn(async () => reseller) })
    for (const [method, path, body] of [['GET', ROUTE, undefined], ['PUT', ROUTE, update()], ['POST', KEY, undefined], ['POST', TEST, undefined]] as const)
      await expect(call(method, denied.helpers, body, path)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const { helpers: h } = helpers()
    await expect(call('GET', h, undefined, ROUTE + '?x=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('PUT', h, '{', ROUTE)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('PUT', h, update(), ROUTE, 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('PUT', h, update({ events: ['x'] }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('POST', h, {}, TEST)).rejects.toMatchObject({ code: 'VALIDATION' })
    const post = (await call('POST', h, {}))!, getKey = (await call('GET', h, undefined, KEY))!
    expect([post.status, post.headers.get('allow'), getKey.status, getKey.headers.get('allow')]).toEqual([405, 'GET, PUT', 405, 'POST'])
    for (const { helpers: each } of [denied, { helpers: h }]) {
      expect(each.writeSaved).not.toHaveBeenCalled(); expect(each.writeSigningKey).not.toHaveBeenCalled(); expect(each.transports.email).not.toHaveBeenCalled()
    }
  })

  it('re-checks fresh root authority before writing, rotating or sending', async () => {
    const changed = { ...root, sessionId: 'other' } as unknown as AuthenticatedCaller
    const initial = { recipients: ['ops@example.com'], events: [], webhook: null, updatedAt: at, updatedBy: 'root' }
    for (const [method, path, body] of [['PUT', ROUTE, update({}, sha256Hex(JSON.stringify(initial)))], ['POST', KEY, undefined], ['POST', TEST, undefined]] as const) {
      const { helpers: h } = helpers(initial,
        { requireCaller: vi.fn<PanelNotificationsHelpers['requireCaller']>().mockResolvedValueOnce(root).mockResolvedValue(changed) })
      await expect(call(method, h, body, path)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
      expect(h.writeSaved).not.toHaveBeenCalled(); expect(h.writeSigningKey).not.toHaveBeenCalled(); expect(h.transports.email).not.toHaveBeenCalled()
    }
  })

  it('reports writes that do not read back, or a failed audit, as requiring verification', async () => {
    const verify = { code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } }
    await expect(call('PUT', helpers(null, { writeSaved: vi.fn(async () => undefined) }).helpers, update())).rejects.toMatchObject(verify)
    await expect(call('PUT', helpers(null, { emitAudit: vi.fn(async () => { throw new Error('down') }) }).helpers, update())).rejects.toMatchObject(verify)
    await expect(call('POST', helpers(null, { writeSigningKey: vi.fn(async () => undefined) }).helpers, undefined, KEY)).rejects.toMatchObject(verify)
  })
})
