import { describe, expect, it } from 'vitest'
import type { PhpSettings } from '@xpanel/core'
import type { Body } from '../archive/reader.ts'
import type { ImportSink, SinkItem } from '../archive/sink.ts'
import { exportAccountArchive, importAccountArchive } from './archive.ts'
import type { AccountExportSource, AccountImportOptions } from './archive.ts'

// Real archive serialization/parser with an explicit disposable staging sink. No host executor,
// account publication, service state, live database or native recovery is exercised.
const source: AccountExportSource = {
  manifest: { format: 'xpanel-account', version: 1, createdAt: '2026-10-26T12:00:00.000Z', source: { hostname: 'source.example.test', panelVersion: '1.4.2' },
    account: { username: 'alice', primaryDomain: 'alice.example.test', contactEmail: 'owner@alice.example.test', plan: 'gold', shell: 'none', ipv4: '192.0.2.1' },
    domains: [{ name: 'alice.example.test', kind: 'primary', parent: null, docRoot: 'public_html', siteType: 'static', phpVersion: '8.3', wildcard: false, upstream: null }],
    databases: [], dbUsers: [], mailboxes: [], mail: { domains: [], mailboxes: [] }, zones: [] },
  zones: {}, dumps: {}, home: [{ path: 'public_html/index.html', type: 'file', content: Buffer.from('Reviewed synthetic account content\n') }],
}
const archiveBytes = async (): Promise<Buffer> => {
  const { stream, done } = exportAccountArchive(source), chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  await done
  return Buffer.concat(chunks)
}
class StagingSink implements ImportSink {
  readonly staged = new Map<string, Buffer>()
  puts = 0
  aborts = 0
  onFirstPut: (() => void) | undefined
  async put(item: SinkItem, body: Body): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of body) chunks.push(Buffer.from(chunk))
    const ref = 'synthetic-staged-' + item.part + '-' + ++this.puts
    this.staged.set(ref, Buffer.concat(chunks)); this.onFirstPut?.(); this.onFirstPut = undefined
    return ref
  }
  async abort(): Promise<void> { this.aborts++; this.staged.clear() }
}
const defaultPhp: PhpSettings = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }

describe('transfer staging interruption and identity recovery boundary', () => {
  it('compensates staged bytes and allocates no target identities when the source is interrupted', async () => {
    const bytes = await archiveBytes(), sink = new StagingSink()
    let allocated = 0, staged!: () => void
    const firstPut = new Promise<void>(resolve => { staged = resolve })
    sink.onFirstPut = staged
    const options: AccountImportOptions = { local: { usernames: [], domains: [], uids: [20000], plans: ['gold'] }, uidRange: { min: 20000, max: 20002 }, planId: 'plan-gold', ownerId: null, ipv4: '192.0.2.2', now: '2026-10-26T13:00:00.000Z', ids: () => 'synthetic-id-' + ++allocated, defaultPhp, sink }
    async function* interrupted() { yield bytes.subarray(0, bytes.length - 8); await firstPut; throw new Error('Synthetic interrupted archive transport') }
    await expect(importAccountArchive(interrupted(), options)).rejects.toThrow()
    expect(sink.puts).toBeGreaterThan(0)
    expect(sink.aborts).toBe(1)
    expect(sink.staged.size).toBe(0)
    expect(allocated).toBe(0)
    const retrySink = new StagingSink()
    const retry = await importAccountArchive((async function* () { yield bytes })(), { ...options, sink: retrySink })
    expect(retry.account.username).toBe('alice')
    expect(retry.account.id).toBe('synthetic-id-1')
    expect(retry.account.uid).toBe(20001)
    expect(retrySink.aborts).toBe(0)
    expect(retrySink.staged.size).toBeGreaterThan(0)
  })
  it('refuses a conflicting destination identity without publishing or allocating a replacement', async () => {
    const bytes = await archiveBytes(), sink = new StagingSink()
    let allocated = 0
    await expect(importAccountArchive((async function* () { yield bytes })(), { local: { usernames: ['alice'], domains: [], uids: [20000], plans: ['gold'] }, planId: 'plan-gold', ownerId: null, ipv4: '192.0.2.2', now: '2026-10-26T13:00:00.000Z', ids: () => 'synthetic-id-' + ++allocated, defaultPhp, sink })).rejects.toThrow()
    expect(allocated).toBe(0)
    expect(sink.staged.size).toBe(0)
  })
})
