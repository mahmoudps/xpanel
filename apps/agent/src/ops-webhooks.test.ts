import { describe, expect, it, vi } from 'vitest'
import {
  WEBHOOK_BACKOFF_SEC, WEBHOOK_SIGNATURE_HEADER, deliverWebhook, isWebhookUrl, parseWebhookConfig, verifyWebhookSignature, webhookConfigRevision, webhookSignature,
} from './ops-webhooks.ts'
import type { WebhookDelivery, WebhookEndpoint } from './ops-webhooks.ts'

const endpoint = (overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({ id: 'whk_' + 'a'.repeat(16), url: 'https://hooks.example.com/xpanel', events: ['account.created'], active: true, ...overrides })
const secret = 's'.repeat(40)
const delivery = (): WebhookDelivery => ({ id: 'whd_' + 'b'.repeat(24), event: 'account.created', payload: JSON.stringify({ event: 'account.created', id: 'acct-1' }), timestamp: 1_700_000_000 })

describe('webhook grammar and URL safety', () => {
  it('accepts public https URLs and rejects loopback, private ranges and reserved ports', () => {
    expect(isWebhookUrl('https://hooks.example.com/x')).toBe(true)
    for (const bad of ['http://hooks.example.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://192.168.1.1/x', 'https://172.16.0.1/x', 'https://example.com:2087/x', 'https://user:pw@example.com/x', 'ftp://example.com'])
      expect(isWebhookUrl(bad)).toBe(false)
  })
  it('parses a bounded endpoint list and round-trips a stable revision', () => {
    expect(parseWebhookConfig({ endpoints: [endpoint()] }).endpoints).toHaveLength(1)
    const mutate = (change: (value: { endpoints: unknown[] }) => void) => { const value = { endpoints: [endpoint()] }; change(value as never); return () => parseWebhookConfig(value) }
    expect(mutate(value => { (value.endpoints[0] as WebhookEndpoint).url = 'http://x' })).toThrow()
    expect(mutate(value => { (value.endpoints[0] as WebhookEndpoint).events = [] })).toThrow()
    expect(mutate(value => { (value.endpoints[0] as WebhookEndpoint).events = ['bogus' as never] })).toThrow()
    expect(mutate(value => { (value.endpoints[0] as Record<string, unknown>).extra = 1 })).toThrow()
    expect(webhookConfigRevision({ endpoints: [endpoint()] })).toBe(webhookConfigRevision({ endpoints: [endpoint({ id: 'whk_' + 'c'.repeat(16) })] }))
  })
})

describe('HMAC signatures', () => {
  it('signs and verifies within a freshness window and rejects tampering, drift and a short secret', () => {
    const header = webhookSignature(secret, 1_700_000_000, 'body')
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/)
    expect(verifyWebhookSignature(secret, header, 'body', 1_700_000_100)).toBe(true)
    expect(verifyWebhookSignature(secret, header, 'tampered', 1_700_000_100)).toBe(false)
    expect(verifyWebhookSignature(secret, header, 'body', 1_700_001_000)).toBe(false)
    expect(verifyWebhookSignature('other-secret-of-sufficient-length!!', header, 'body', 1_700_000_100)).toBe(false)
    expect(() => webhookSignature('short', 1, 'body')).toThrow()
  })
})

describe('bounded delivery with retries and a log', () => {
  it('signs every request, stops on the first 2xx and records one delivered attempt', async () => {
    const send = vi.fn(async (_input: { url: string; body: string; headers: Record<string, string> }) => ({ status: 200 }))
    const record = await deliverWebhook({ endpoint: endpoint(), secret, delivery: delivery(), send, now: () => new Date('2026-10-28T09:00:00.000Z') })
    expect(record.state).toBe('delivered'); expect(record.attempts).toHaveLength(1)
    expect(send).toHaveBeenCalledTimes(1)
    const headers = (send.mock.calls[0]![0] as { headers: Record<string, string> }).headers
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    const signedAt = Number(/^t=(\d+),/.exec(headers[WEBHOOK_SIGNATURE_HEADER]!)![1])
    expect(verifyWebhookSignature(secret, headers[WEBHOOK_SIGNATURE_HEADER]!, delivery().payload, signedAt)).toBe(true)
  })
  it('retries a non-2xx response up to the schedule and exhausts with a full log', async () => {
    const send = vi.fn(async () => ({ status: 500 }))
    const sleep = vi.fn(async () => {})
    const record = await deliverWebhook({ endpoint: endpoint(), secret, delivery: delivery(), send, sleep, now: () => new Date('2026-10-28T09:00:00.000Z') })
    expect(record.state).toBe('exhausted')
    expect(record.attempts).toHaveLength(WEBHOOK_BACKOFF_SEC.length)
    expect(record.attempts.at(-1)!.nextAttemptAt).toBeNull()
    expect(record.attempts[0]!.nextAttemptAt).not.toBeNull()
    expect(send).toHaveBeenCalledTimes(WEBHOOK_BACKOFF_SEC.length)
    expect(sleep).toHaveBeenCalledTimes(WEBHOOK_BACKOFF_SEC.length - 1)
  })
  it('treats a transport error as a failed attempt without throwing and recovers on a later success', async () => {
    let calls = 0
    const send = vi.fn(async () => { if (++calls < 3) throw new Error('ECONNREFUSED'); return { status: 204 } })
    const record = await deliverWebhook({ endpoint: endpoint(), secret, delivery: delivery(), send, sleep: async () => {} })
    expect(record.state).toBe('delivered'); expect(record.attempts).toHaveLength(3)
    expect(record.attempts.slice(0, 2).every(attempt => attempt.outcome === 'failed' && attempt.status === null)).toBe(true)
  })
})
