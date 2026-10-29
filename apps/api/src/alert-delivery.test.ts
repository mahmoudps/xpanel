import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_WEBHOOK_ATTEMPTS, verifyWebhookSignature, WEBHOOK_BACKOFF_SEC } from '../../agent/src/ops-webhooks.ts'
import {
  alertMessage, createHttpsWebhookSender, createLocalMtaEmailSender, DeliveryFailure, dispatchAlertNotices, EMPTY_DELIVERY_STATE, planAlertNotices, readSavedDeliveryState,
} from './alert-delivery.ts'
import type { AlertNotice, DeliveryChannels, DeliveryState, DeliveryTransports } from './alert-delivery.ts'
import type { AlertEvaluation, AlertResult } from './monitoring-alerts.ts'

const at = '2026-10-27T10:00:00.000Z', KEY = 'whsec_' + 'k'.repeat(43)
const IDS = ['load', 'memory', 'swap', 'disk-space', 'disk-inodes', 'services', 'drift', 'certificates', 'reboot'] as const
const CHANNELS: DeliveryChannels = { alerts: true, recipients: ['ops@example.com'], webhook: { url: 'https://hooks.example.com/xpanel', key: KEY } }
const result = (id: string, patch: Partial<AlertResult> = {}): AlertResult => ({ id: id as AlertResult['id'], enabled: true, threshold: null, state: 'ok', severity: null, health: 'ok', value: null, matches: [], evidence: 'evidence', firstFiredAt: null, ...patch })
const evaluation = (patch: Partial<Record<string, Partial<AlertResult>>> = {}, when = at, quiet = false): AlertEvaluation =>
  ({ evaluatedAt: when, observedAt: when, host: 'read', rulesRevision: 'a'.repeat(64), quiet, results: IDS.map(id => result(id, patch[id])) })
const firing = (since = at): Partial<AlertResult> => ({ state: 'firing', severity: 'critical', health: 'problem', value: 96, threshold: 85, matches: ['/'], firstFiredAt: since })
const transports = (webhook: DeliveryTransports['webhook'] = vi.fn(async () => ({ status: 200 }))) => {
  const sent: { channel: string; subject?: string; headers?: Record<string, string>; body?: string }[] = []
  const value: DeliveryTransports = { serverName: 'srv1.example.test', email: vi.fn(async message => { sent.push({ channel: 'email', subject: message.subject }) }),
    webhook: vi.fn(async request => { sent.push({ channel: 'webhook', headers: request.headers, body: request.body }); return webhook(request) }) }
  return { value, sent }
}
const later = (minutes: number): Date => new Date(Date.parse(at) + minutes * 60_000)

describe('alert notice planning', () => {
  it('plans one firing notice per episode and one resolution, keeping unverified episodes open', () => {
    const one = planAlertNotices(evaluation({ 'disk-space': firing() }), {})
    expect(one.notices.map(notice => [notice.kind, notice.ruleId, notice.firstFiredAt])).toEqual([['firing', 'disk-space', at]])
    expect(one.told).toEqual({ 'disk-space': at })
    expect(planAlertNotices(evaluation({ 'disk-space': firing() }, later(5).toISOString()), one.told).notices).toEqual([])
    expect(planAlertNotices(evaluation({ 'disk-space': { state: 'unavailable' } }), one.told)).toEqual({ notices: [], told: one.told })
    const cleared = planAlertNotices(evaluation({}, later(10).toISOString()), one.told)
    expect(cleared.notices).toEqual([expect.objectContaining({ kind: 'resolved', ruleId: 'disk-space', firstFiredAt: at, severity: null, evaluatedAt: later(10).toISOString() })])
    expect(cleared.told).toEqual({})
    const again = planAlertNotices(evaluation({ 'disk-space': firing(later(20).toISOString()) }), {})
    expect(again.notices[0]!.id).not.toBe(one.notices[0]!.id)
  })

  it('closes a disabled rule silently, starts a new episode on a new firstFiredAt and plans nothing inside the quiet window', () => {
    expect(planAlertNotices(evaluation({ 'disk-space': { state: 'disabled', enabled: false } }), { 'disk-space': at })).toEqual({ notices: [], told: {} })
    expect(planAlertNotices(evaluation({ 'disk-space': firing(later(3).toISOString()) }), { 'disk-space': at }).notices[0]).toMatchObject({ kind: 'firing', firstFiredAt: later(3).toISOString() })
    expect(planAlertNotices(evaluation({ 'disk-space': firing() }, at, true), {})).toEqual({ notices: [], told: {} })
  })
})

describe('alert dispatch', () => {
  const notice = (): AlertNotice => planAlertNotices(evaluation({ 'disk-space': firing() }), {}).notices[0]!

  it('sends a signed webhook and a plain-text email, logging each attempt', async () => {
    const { value, sent } = transports()
    const state = await dispatchAlertNotices({ state: EMPTY_DELIVERY_STATE, notices: [notice()], channels: CHANNELS, transports: value, now: new Date(at), quiet: false })
    expect(state.outbox).toEqual([])
    expect(state.log.map(entry => [entry.channel, entry.result, entry.attempt])).toEqual([['webhook', 'sent', 1], ['email', 'sent', 1]])
    const hook = sent.find(item => item.channel === 'webhook')!
    expect(hook.headers).toMatchObject({ 'content-type': 'application/json', 'x-xpanel-event': 'monitoring.alert.firing', 'x-xpanel-delivery': notice().id })
    expect(verifyWebhookSignature(KEY, hook.headers!['x-xpanel-signature']!, hook.body!, Math.floor(Date.parse(at) / 1000))).toBe(true)
    expect(verifyWebhookSignature('whsec_' + 'x'.repeat(43), hook.headers!['x-xpanel-signature']!, hook.body!, Math.floor(Date.parse(at) / 1000))).toBe(false)
    expect(JSON.parse(hook.body!)).toEqual({ id: notice().id, event: 'monitoring.alert.firing', server: 'srv1.example.test',
      alert: { rule: 'disk-space', title: 'Disk space per filesystem', severity: 'critical', firstFiredAt: at, evaluatedAt: at, value: 96, threshold: 85, matches: ['/'], evidence: 'evidence' } })
    expect(readSavedDeliveryState(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })

  it('retries a failing channel on the backoff schedule without resending the delivered one, then gives up', async () => {
    const { value, sent } = transports(async () => ({ status: 503 }))
    let state: DeliveryState = await dispatchAlertNotices({ state: EMPTY_DELIVERY_STATE, notices: [notice()], channels: CHANNELS, transports: value, now: new Date(at), quiet: false })
    expect(state.outbox).toEqual([expect.objectContaining({ channel: 'webhook', attempts: 1, nextAt: new Date(Date.parse(at) + WEBHOOK_BACKOFF_SEC[1]! * 1000).toISOString() })])
    expect(state.log[0]).toMatchObject({ channel: 'webhook', result: 'failed', error: 'rejected_status', status: 503 })
    const early = await dispatchAlertNotices({ state, notices: [], channels: CHANNELS, transports: value, now: new Date(at), quiet: false })
    expect(early.outbox).toEqual(state.outbox)
    let now = Date.parse(at)
    for (let attempt = 1; attempt < MAX_WEBHOOK_ATTEMPTS; attempt++) {
      now += WEBHOOK_BACKOFF_SEC[attempt]! * 1000
      state = await dispatchAlertNotices({ state, notices: [], channels: CHANNELS, transports: value, now: new Date(now), quiet: false })
    }
    expect(state.outbox).toEqual([])
    expect(state.log[0]).toMatchObject({ channel: 'webhook', result: 'gave_up', attempt: MAX_WEBHOOK_ATTEMPTS, error: 'rejected_status' })
    expect(sent.filter(item => item.channel === 'email')).toHaveLength(1)
    expect(sent.filter(item => item.channel === 'webhook')).toHaveLength(MAX_WEBHOOK_ATTEMPTS)
  })

  it('waits inside the quiet window, drops entries whose channel was removed and records notices with no channel', async () => {
    const { value, sent } = transports()
    const held = await dispatchAlertNotices({ state: EMPTY_DELIVERY_STATE, notices: [notice()], channels: CHANNELS, transports: value, now: new Date(at), quiet: true })
    expect([held.outbox.length, sent.length]).toEqual([2, 0])
    const removed = await dispatchAlertNotices({ state: held, notices: [], channels: { ...CHANNELS, webhook: null }, transports: value, now: new Date(at), quiet: false })
    expect(removed.log.slice(0, 2).map(entry => [entry.channel, entry.result])).toEqual([['webhook', 'no_channel'], ['email', 'sent']])
    const none = await dispatchAlertNotices({ state: EMPTY_DELIVERY_STATE, notices: [notice()], channels: null, transports: value, now: new Date(at), quiet: false })
    expect(none.log).toEqual([expect.objectContaining({ channel: null, result: 'no_channel', attempt: 0 })])
  })

  it('fails a webhook with no signing key and maps transport errors to stable codes', async () => {
    const { value } = transports(async () => { throw new Error('ECONNRESET with internal detail') })
    const keyless = await dispatchAlertNotices({ state: EMPTY_DELIVERY_STATE, notices: [notice()], channels: { ...CHANNELS, recipients: [], webhook: { url: CHANNELS.webhook!.url, key: null } }, transports: value, now: new Date(at), quiet: false })
    expect(keyless.log[0]).toMatchObject({ result: 'failed', error: 'no_signing_key' })
    const broken = await dispatchAlertNotices({ state: EMPTY_DELIVERY_STATE, notices: [notice()], channels: { ...CHANNELS, recipients: [] }, transports: value, now: new Date(at), quiet: false })
    expect(broken.log[0]).toMatchObject({ result: 'failed', error: 'unreachable', status: null })
    expect(JSON.stringify(broken)).not.toContain('internal detail')
  })

  it('reads a saved delivery record strictly', () => {
    expect(readSavedDeliveryState(EMPTY_DELIVERY_STATE)).toEqual(EMPTY_DELIVERY_STATE)
    for (const bad of [{ ...EMPTY_DELIVERY_STATE, extra: 1 }, { ...EMPTY_DELIVERY_STATE, told: { nope: at } }, { ...EMPTY_DELIVERY_STATE, log: [{ at }] }, { ...EMPTY_DELIVERY_STATE, lastRun: { at, result: 'maybe' } }, null, []])
      expect(readSavedDeliveryState(bad)).toBeNull()
  })

  it('writes English system mail with the state, rule, server and UTC times', () => {
    const message = alertMessage(notice(), 'srv1.example.test')
    expect(message.subject).toBe('[xPanel] Critical: Disk space per filesystem on srv1.example.test')
    expect(message.text).toContain('Firing since: 2026-10-27 10:00 UTC')
    expect(message.text).toContain('Measured: 96 (threshold 85)')
    expect(message.text).toContain('Affected: /')
  })
})

describe('local MTA sender', () => {
  const servers: net.Server[] = []
  afterEach(() => { for (const server of servers.splice(0)) server.close() })
  const smtp = async (script: (line: string, write: (text: string) => void, state: { data: boolean; body: string }) => void, greet = true): Promise<{ port: number; lines: string[]; state: { data: boolean; body: string } }> => {
    const lines: string[] = [], state = { data: false, body: '' }
    const server = net.createServer(socket => {
      const write = (text: string) => socket.write(text + '\r\n')
      socket.on('error', () => undefined)
      if (greet) write('220 mx.test ESMTP')
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk.toString('latin1')
        for (let index = buffer.indexOf('\r\n'); index >= 0; index = buffer.indexOf('\r\n')) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 2)
          if (state.data) { if (line === '.') { state.data = false; write('250 2.0.0 Ok: queued as ABC123') } else state.body += line + '\n'; continue }
          lines.push(line); script(line, write, state)
        }
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return { port: (server.address() as net.AddressInfo).port, lines, state }
  }
  const accept = (line: string, write: (text: string) => void, state: { data: boolean }) => {
    if (line.startsWith('EHLO')) { write('250-mx.test'); write('250 PIPELINING') }
    else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) write(line.includes('blocked@') ? '550 5.1.1 no such user' : '250 2.1.0 Ok')
    else if (line === 'DATA') { state.data = true; write('354 End data with <CR><LF>.<CR><LF>') }
    else if (line === 'QUIT') write('221 Bye')
  }

  it('submits over loopback SMTP with dot-stuffing and multi-line replies', async () => {
    const server = await smtp(accept)
    const send = createLocalMtaEmailSender({ from: 'xpanel@srv1.example.test', helo: 'srv1.example.test', port: server.port, timeoutMs: 2000 })
    await send({ to: ['ops@example.com', 'blocked@example.com'], subject: 'Alert', text: 'line one\n.starts with a dot\n' })
    expect(server.lines.slice(0, 5)).toEqual(['EHLO srv1.example.test', 'MAIL FROM:<xpanel@srv1.example.test>', 'RCPT TO:<ops@example.com>', 'RCPT TO:<blocked@example.com>', 'DATA'])
    expect(server.state.body).toContain('Auto-Submitted: auto-generated')
    expect(server.state.body).toMatch(/^Subject: Alert$/m)
  })

  it('reports refusal, an unreachable MTA and a silent MTA with stable codes', async () => {
    const refusing = await smtp((line, write) => { if (line.startsWith('EHLO')) write('250 mx.test'); else if (line.startsWith('MAIL')) write('250 Ok'); else write('550 5.1.1 rejected') })
    await expect(createLocalMtaEmailSender({ from: 'xpanel@srv1.example.test', helo: 'srv1', port: refusing.port, timeoutMs: 2000 })({ to: ['ops@example.com'], subject: 's', text: 't' }))
      .rejects.toMatchObject({ code: 'refused', status: 550 })
    const closed = await smtp(() => undefined); const port = closed.port; await new Promise(resolve => servers.pop()!.close(resolve))
    await expect(createLocalMtaEmailSender({ from: 'xpanel@srv1.example.test', helo: 'srv1', port, timeoutMs: 2000 })({ to: ['ops@example.com'], subject: 's', text: 't' })).rejects.toMatchObject({ code: 'unreachable' })
    const silent = await smtp(() => undefined, false)
    await expect(createLocalMtaEmailSender({ from: 'xpanel@srv1.example.test', helo: 'srv1', port: silent.port, timeoutMs: 150 })({ to: ['ops@example.com'], subject: 's', text: 't' })).rejects.toMatchObject({ code: 'timed_out' })
  })
})

describe('webhook egress', () => {
  const send = (resolve: (host: string) => Promise<string[]>, url = 'https://hooks.example.com/x') => createHttpsWebhookSender({ resolve, timeoutMs: 500 })({ url, body: '{}', headers: {} })
  it('refuses non-https, private and mixed resolutions before connecting', async () => {
    await expect(send(async () => ['93.184.216.34'], 'http://hooks.example.com/x')).rejects.toMatchObject({ code: 'address_not_public' })
    await expect(send(async () => ['10.0.0.5'])).rejects.toMatchObject({ code: 'address_not_public' })
    await expect(send(async () => ['93.184.216.34', '169.254.169.254'])).rejects.toMatchObject({ code: 'address_not_public' })
    await expect(send(async () => ['::ffff:127.0.0.1'])).rejects.toMatchObject({ code: 'address_not_public' })
    await expect(send(async () => [])).rejects.toMatchObject({ code: 'unreachable' })
    await expect(send(async () => { throw new Error('ENOTFOUND') })).rejects.toBeInstanceOf(DeliveryFailure)
  })
})
