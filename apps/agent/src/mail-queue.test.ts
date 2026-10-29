import { describe, expect, it, vi } from 'vitest'
import { applyMailQueueAction, readMailQueue } from './mail-queue.ts'
import type { MailQueueCommandResult } from './mail-queue.ts'
import { isMailQueueCommand } from '../../../packages/os/src/mail-queue-command.ts'

const now = () => new Date('2026-10-27T10:00:00Z')
const ok = (stdout: string): MailQueueCommandResult => ({ ok: true, code: 0, stdout, stderr: '' })
const line = (queue: string, id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ queue_name: queue, queue_id: id, arrival_time: 1793095200, message_size: 2048, forced_expire: false, sender: 'sender@example.test', recipients: [{ address: 'rcpt@example.net', delay_reason: 'connect to mx.example.net[192.0.2.10]:25: Connection timed out' }], ...extra }) + '\n'
const deferred = line('deferred', '4F2A1B3C9D'), held = line('hold', '4F2A1B3C9D'), active = line('active', '3wbzPq1Ttkz5Zfx', { recipients: [{ address: 'a@example.org' }, { address: 'b@example.org' }] })
const revision = 'a'.repeat(64)
const scripted = (...outputs: (MailQueueCommandResult | Error)[]) => {
  const calls: string[][] = []
  const run = vi.fn(async (argv: string[]) => {
    expect(isMailQueueCommand(argv)).toBe(true)
    calls.push(argv)
    const next = outputs.shift()
    if (!next) throw new Error('unexpected command')
    if (next instanceof Error) throw next
    return next
  })
  return { run, calls }
}

describe('Postfix queue observation', () => {
  it('parses multiple queues, recipients and optional delay reasons', async () => {
    const view = await readMailQueue({ run: async () => ok(deferred + active + line('incoming', 'B0C1D2E3F4', { forced_expire: true }) + line('maildrop', 'C0FFEE12')), now })
    expect(view).toMatchObject({ state: 'read', observedAt: '2026-10-27T10:00:00.000Z', truncated: false, counts: { maildrop: 1, incoming: 1, active: 1, deferred: 1, hold: 0 } })
    expect(view.messages[0]).toEqual({ queueId: '4F2A1B3C9D', queue: 'deferred', arrivalTime: '2026-10-27T10:00:00.000Z', sizeBytes: 2048, sender: 'sender@example.test', recipients: [{ address: 'rcpt@example.net', delayReason: 'connect to mx.example.net[192.0.2.10]:25: Connection timed out' }], recipientCount: 1, forcedExpire: false })
    expect(view.messages[1]!.recipients).toEqual([{ address: 'a@example.org', delayReason: null }, { address: 'b@example.org', delayReason: null }])
    expect(view.messages[2]!.forcedExpire).toBe(true)
    expect(JSON.stringify(view)).not.toMatch(/body|subject|header/i)
  })
  it('reads an empty queue as zero messages, not unavailable', async () => {
    expect(await readMailQueue({ run: async () => ok(''), now })).toMatchObject({ state: 'read', messages: [], truncated: false, counts: { deferred: 0 } })
  })
  it('refuses partial success on malformed lines, wrong types, unknown queues and bad ids', async () => {
    for (const stdout of [deferred + '{"queue_name":"deferred"\n', deferred + 'not json\n', line('corrupt', '4F2A1B3C9D'), line('deferred', 'ALL'), line('deferred', '4F2A1B3C9D', { arrival_time: '1793095200' }),
      line('deferred', '4F2A1B3C9D', { recipients: [{ address: 7 }] }), line('deferred', '4F2A1B3C9D', { forced_expire: 'no' }), line('deferred', '4F2A1B3C9D', { recipients: null }), '[]\n']) {
      const view = await readMailQueue({ run: async () => ok(stdout), now })
      expect(view).toMatchObject({ state: 'unavailable', reason: 'malformed_output', messages: [], revision: null })
    }
    expect(await readMailQueue({ run: async () => ({ ok: false, code: 69, stdout: '', stderr: 'postqueue: fatal' }), now })).toMatchObject({ state: 'unavailable', reason: 'command_failed' })
    expect(await readMailQueue({ run: async () => { throw new Error('spawn failed') }, now })).toMatchObject({ state: 'unavailable', reason: 'command_failed' })
  })
  it('bounds output, messages, recipients and remote-controlled text', async () => {
    expect(await readMailQueue({ run: async () => ok('x'.repeat(16 * 1024 * 1024 + 1)), now })).toMatchObject({ state: 'unavailable', reason: 'output_limit' })
    const many = Array.from({ length: 5 }, (_, index) => line('deferred', 'ABCDEF0' + index)).join('')
    expect(await readMailQueue({ run: async () => ok(many + 'garbage beyond the bound\n'), now, maxMessages: 5 })).toMatchObject({ state: 'read', truncated: true, messages: { length: 5 } })
    const recipients = Array.from({ length: 150 }, (_, index) => ({ address: `r${index}@example.org`, delay_reason: 'x'.repeat(2000) }))
    const view = await readMailQueue({ run: async () => ok(line('deferred', '4F2A1B3C9D', { recipients, sender: 'evil\u202e\u0000@example.test' })), now })
    expect(view.messages[0]!.recipients).toHaveLength(100)
    expect(view.messages[0]!.recipientCount).toBe(150)
    expect(view.messages[0]!.recipients[0]!.delayReason).toHaveLength(512)
    expect(view.messages[0]!.sender).toBe('evil  @example.test')
    await expect(readMailQueue({ run: async () => ok(''), maxMessages: 0 })).rejects.toThrow()
  })
  it('truncates by serialized size so the listing fits the protected host response bound', async () => {
    const heavy = Array.from({ length: 40 }, (_, index) => line('deferred', 'ABCDEF' + String(index).padStart(2, '0'), { recipients: Array.from({ length: 100 }, () => ({ address: 'r@example.org', delay_reason: 'x'.repeat(400) })) })).join('')
    const view = await readMailQueue({ run: async () => ok(heavy), now })
    expect(view).toMatchObject({ state: 'read', truncated: true })
    expect(view.messages.length).toBeGreaterThan(0)
    expect(view.messages.length).toBeLessThan(40)
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(1024 * 1024)
    expect(view.counts.deferred).toBe(view.messages.length)
  })
  it('keeps the first sighting of a message listed twice while the queue moves', async () => {
    const view = await readMailQueue({ run: async () => ok(line('incoming', '4F2A1B3C9D') + deferred), now })
    expect(view.messages.map(item => item.queue)).toEqual(['incoming'])
  })
  it('derives a stable revision from queue identity, independent of listing order and observation time', async () => {
    const first = await readMailQueue({ run: async () => ok(deferred + active), now })
    const second = await readMailQueue({ run: async () => ok(active + deferred), now: () => new Date('2026-10-27T11:00:00Z') })
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(second.revision).toBe(first.revision)
    expect((await readMailQueue({ run: async () => ok(held + active), now })).revision).not.toBe(first.revision)
    expect((await readMailQueue({ run: async () => ok(line('deferred', '4F2A1B3C9D', { message_size: 4096 }) + active), now })).revision).not.toBe(first.revision)
  })
})

describe('Postfix queue actions', () => {
  const base = { action: 'delete' as const, queueId: '4F2A1B3C9D', expectedQueue: 'deferred' as const, observedRevision: revision, now }
  it('confirms delete only when the re-read proves the id is absent', async () => {
    const { run, calls } = scripted(ok(deferred + active), ok(''), ok(active))
    const authorize = vi.fn(async () => {})
    expect(await applyMailQueueAction({ ...base, run, authorize })).toMatchObject({ outcome: 'confirmed', verificationRequired: false, after: { present: false, queue: null }, observedRevision: revision })
    expect(calls).toEqual([['/usr/sbin/postqueue', '-j'], ['/usr/sbin/postsuper', '-d', '4F2A1B3C9D', 'deferred'], ['/usr/sbin/postqueue', '-j']])
    expect(authorize).toHaveBeenCalledTimes(1)
  })
  it('confirms hold and release by the observed queue', async () => {
    expect(await applyMailQueueAction({ ...base, action: 'hold', run: scripted(ok(deferred), ok(''), ok(held)).run })).toMatchObject({ outcome: 'confirmed', after: { present: true, queue: 'hold' } })
    expect(await applyMailQueueAction({ ...base, action: 'release', expectedQueue: 'hold', run: scripted(ok(held), ok(''), ok(deferred)).run })).toMatchObject({ outcome: 'confirmed', after: { queue: 'deferred' } })
    expect(await applyMailQueueAction({ ...base, action: 'requeue', run: scripted(ok(deferred), ok(''), ok(line('maildrop', '4F2A1B3C9D'))).run })).toMatchObject({ outcome: 'confirmed', after: { queue: 'maildrop' } })
  })
  it('reports deliver as attempted with the current queue, never delivered', async () => {
    const { run, calls } = scripted(ok(deferred), ok(''), ok(deferred))
    const result = await applyMailQueueAction({ ...base, action: 'deliver', run })
    expect(result).toMatchObject({ outcome: 'attempted', verificationRequired: false, after: { present: true, queue: 'deferred' } })
    expect(calls[1]).toEqual(['/usr/sbin/postqueue', '-i', '4F2A1B3C9D'])
    expect(JSON.stringify(result)).not.toContain('delivered')
  })
  it('returns 409 without running a command when the message is gone or moved', async () => {
    for (const listing of ['', held]) {
      const { run, calls } = scripted(ok(listing))
      await expect(applyMailQueueAction({ ...base, run })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
      expect(calls).toHaveLength(1)
    }
    const { run } = scripted({ ok: false, code: 1, stdout: '', stderr: '' })
    await expect(applyMailQueueAction({ ...base, run })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('reports unknown when the command fails after dispatch unless the re-read proves no change', async () => {
    await expect(applyMailQueueAction({ ...base, run: scripted(ok(deferred), { ok: false, code: 1, stdout: '', stderr: 'postsuper: fatal' }, ok(deferred)).run })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(await applyMailQueueAction({ ...base, run: scripted(ok(deferred), new Error('timeout'), ok('')).run })).toMatchObject({ outcome: 'unknown', verificationRequired: true, after: { present: false } })
    expect(await applyMailQueueAction({ ...base, run: scripted(ok(deferred), new Error('timeout'), { ok: false, code: 1, stdout: '', stderr: '' }).run })).toMatchObject({ outcome: 'unknown', after: { present: null, queue: null }, revision: null })
    expect(await applyMailQueueAction({ ...base, run: scripted(ok(deferred), ok(''), ok(deferred)).run })).toMatchObject({ outcome: 'unknown', verificationRequired: true, after: { queue: 'deferred' } })
    expect(await applyMailQueueAction({ ...base, run: scripted(ok(deferred), ok(''), ok('bad\n')).run })).toMatchObject({ outcome: 'unknown', after: { present: null } })
  })
  it('stops before the mutating command when fresh authorization fails', async () => {
    const { run, calls } = scripted(ok(deferred))
    await expect(applyMailQueueAction({ ...base, run, authorize: async () => { throw new Error('denied') } })).rejects.toThrow('denied')
    expect(calls).toHaveLength(1)
  })
  it('refuses invalid or inapplicable requests before reading', async () => {
    const run = vi.fn()
    for (const input of [{ queueId: 'ALL' }, { queueId: '-' }, { expectedQueue: 'maildrop' }, { observedRevision: 'x' }, { action: 'flush' }, { action: 'deliver', expectedQueue: 'hold' }, { action: 'release', expectedQueue: 'deferred' }, { action: 'hold', expectedQueue: 'hold' }]) {
      await expect(applyMailQueueAction({ ...base, run, ...input } as never)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    }
    expect(run).not.toHaveBeenCalled()
  })
})
