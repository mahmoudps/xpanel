import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import { autoSslSummary, readMailCertExtra } from './mail-cert-scheduler.ts'
import { OUTBOUND_STATE, parseOutboundState, readMailOutcomes } from './outbound-spam.ts'

describe('mail and certificate scheduling', { tags: ['unit'] }, () => {
  let root = ''
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-mailcert-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  it('shows the schedule and the queue beside the saved AutoSSL policy', async () => {
    await atomicWriteJson(join(root, 'extended/tls/autossl-state.json'), { version: 1, nextRunAt: '2026-11-08T02:00:00.000Z', lastRunAt: null, pending: null, queue: [{ domain: 'a.test' }], log: [], unreported: [] })
    expect(await readMailCertExtra({ rootDir: root } as never, 'autossl')).toMatchObject({ provider: { challenge: 'http-01' }, scheduler: { state: 'active', nextRunAt: '2026-11-08T02:00:00.000Z' }, queue: [{ domain: 'a.test' }] })
    expect(await readMailCertExtra({ rootDir: root } as never, 'traceroute')).toEqual({})
  })
  it('lists holds and the busiest senders', async () => {
    await atomicWriteJson(join(root, OUTBOUND_STATE), { version: 1, cursor: null, hour: null, day: null, mailboxes: { 'a@b.test': { hourly: 5, daily: 9 } }, accounts: { alice: { hourly: 7, daily: 9 } }, holds: [{ key: 'a@b.test' }] })
    const extra = await readMailCertExtra({ rootDir: root } as never, 'outbound-spam') as { holds: unknown[]; usage: { target: string }[] }
    expect(extra.holds).toHaveLength(1); expect(extra.usage[0]!.target).toBe('alice')
    expect(parseOutboundState(await readJsonIfExists(join(root, OUTBOUND_STATE))).mailboxes['a@b.test']!.daily).toBe(9)
  })
  it('asks for a five-minute look back and counts from the cursor', async () => {
    const seen: string[] = [], call = vi.fn(async (path: string) => { seen.push(path); return new Response(JSON.stringify({ state: 'read', complete: true, usage: [], marketing: [] })) })
    const read = await readMailOutcomes(call, '2026-11-07T10:00:00Z', new Date('2026-11-07T10:01:00.500Z'))
    const url = new URL('http://x' + seen[0])
    expect([url.searchParams.get('since'), url.searchParams.get('from'), url.searchParams.get('until')]).toEqual(['2026-11-07T09:55:00Z', '2026-11-07T10:00:00Z', '2026-11-07T10:01:00Z'])
    expect(read?.until).toBe('2026-11-07T10:01:00Z')
    expect(await readMailOutcomes(vi.fn(async () => new Response('{}', { status: 503 })), null, new Date('2026-11-07T10:01:00Z'))).toBeNull()
  })
  it('keeps a report to one line per name', () => {
    expect(autoSslSummary([{ at: '', trigger: 'nightly', username: 'a', domain: 'a.test', result: 'skipped', code: 'caa_forbids', message: 'No order.' }])).toBe('a.test: skipped (caa_forbids). No order.')
  })
})
