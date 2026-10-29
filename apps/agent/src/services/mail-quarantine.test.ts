import { describe, expect, it } from 'vitest'
import { FakeHostExecutor } from '../executor.ts'
import type { ConfigTestResult } from '../executor.ts'
import { MailQuarantineService, parseQuarantineMutation } from './mail-quarantine.ts'
import type { QuarantineNativeProfile, QuarantineAvailable } from './mail-quarantine.ts'
import { assertMailQuarantineArgv, isMailQuarantineArgv, quarantineBayesPath, QUARANTINE_SUMMARY_FIELDS } from './mail-quarantine-commands.ts'

// Explicit host-command double. These tests do not authenticate a mailbox, run SpamAssassin,
// invoke Dovecot or qualify any native capability.
const scope = { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', mailbox: 'held@alpha.example.test' }
const sourceGuid = 'b'.repeat(32), inboxGuid = 'c'.repeat(32), messageGuid = 'd'.repeat(32)
const rawMime = 'From: sender@example.test\r\nTo: held@alpha.example.test\r\nSubject: False positive\r\n\r\nOriginal message body.\r\n'
const ok = (stdout = ''): ConfigTestResult => ({ ok: true, code: 0, stdout, stderr: '' })
interface Message { uid: number; guid: string; raw: string; received: number | null; saved: number | null }
class DeclaredQuarantineExecutor extends FakeHostExecutor {
  held = new Map<number, Message>([[10, { uid: 10, guid: messageGuid, raw: rawMime, received: 1700000000, saved: 1700000000 }]])
  inbox = new Map<number, Message>()
  uidValidity = 7
  nextUid = 11
  mode = 'normal'
  learningPayloads: string[] = []
  beforeLearn?: () => void
  override async runCommand(argv: string[]): Promise<ConfigTestResult> {
    assertMailQuarantineArgv(argv); this.executedCommands.push([...argv])
    if (argv[0] === '/usr/sbin/runuser') {
      this.beforeLearn?.(); this.learningPayloads.push(this.files.get(argv[8]!)?.content ?? '')
      if (this.mode === 'learn-error') return { ok: false, code: 1, stdout: '', stderr: 'Declared learner failure' }
      if (this.mode === 'learn-unknown') throw new Error('Declared learner timeout')
      if (this.mode === 'learn-empty') return ok()
      return ok('Learned tokens from 1 message(s) (1 message(s) examined)')
    }
    if (argv[3] === 'mailbox') {
      const inbox = argv[8] === 'INBOX', messages = inbox ? this.inbox : this.held
      return ok(JSON.stringify([{ mailbox: argv[8], guid: inbox ? inboxGuid : sourceGuid, uidvalidity: String(inbox ? 3 : this.uidValidity), uidnext: String(inbox ? 101 + this.inbox.size : this.nextUid), messages: String(messages.size) }]))
    }
    if (argv[3] === 'fetch') {
      if (this.mode === 'invalid-json') return ok('')
      const destination = argv[7] === 'mailbox', source = destination ? this.inbox : this.held
      const guid = destination ? inboxGuid : sourceGuid
      const requestedGuid = destination ? argv[10] : argv[12]
      const parts = destination ? [1, 4294967295] : argv[10]!.split(':').map(Number)
      const start = parts[0]!, end = parts[1] ?? start
      const rows = [...source.values()].filter(message => message.uid >= start && message.uid <= end && (!requestedGuid || requestedGuid === message.guid)).map(message => {
        const data: Record<string, unknown> = { 'mailbox-guid': guid, uid: String(message.uid), guid: message.guid, text: message.raw, 'date.received.unixtime': message.received === null ? null : String(message.received), 'date.saved.unixtime': message.saved === null ? null : String(message.saved), 'size.virtual': String(Buffer.byteLength(message.raw)), 'hdr.from': 'sender@example.test', 'hdr.to': scope.mailbox, 'hdr.subject': 'False positive', 'hdr.x-spam-score': '8.5', 'hdr.x-spam-status': 'Yes, score=8.5 required=5.0 tests=BAYES_50' }
        return Object.fromEntries(argv[6]!.split(' ').map(field => [field, data[field]]))
      })
      return ok(JSON.stringify(rows))
    }
    const moving = argv[1] === 'move', at = moving ? 8 : 7, uid = Number(argv[at]), message = this.held.get(uid)
    if (moving && message) {
      if (this.mode !== 'move-refused') this.inbox.set(101 + this.inbox.size, { ...message, uid: 101 + this.inbox.size })
      if (!['partial-copy', 'move-refused'].includes(this.mode)) this.held.delete(uid)
      if (this.mode === 'namespace-reset') this.uidValidity++
      return ok()
    }
    if (!moving && message && this.mode !== 'delete-refused') this.held.delete(uid)
    return ok()
  }
  override async removePath(path: string): Promise<void> { if (this.mode === 'cleanup-failed') throw new Error('Declared cleanup failure'); await super.removePath(path) }
}
const fixture = () => {
  const executor = new DeclaredQuarantineExecutor()
  let profile: QuarantineNativeProfile | null = { ...scope, serviceUserId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', accountUsername: 'alpha', uid: 20001, gid: 20001, folder: 'Spam', retentionDays: 30, activeFilterBinding: { revision: 'a'.repeat(64), bayesPath: quarantineBayesPath(scope.accountId), serviceUser: 'alpha' } }
  let authorizationCalls = 0, denyAt = 0
  const service = new MailQuarantineService({ executor, resolveProfile: async () => profile, authorize: async () => { authorizationCalls++; if (authorizationCalls === denyAt) throw Object.assign(new Error('Declared authorization change'), { code: 'FORBIDDEN', detail: { stateChanged: false } }) }, now: () => new Date('2026-10-26T12:00:00.000Z') })
  const page = async () => { const result = await service.list(scope); expect(result.state).toBe('available'); return result as QuarantineAvailable }
  const input = async () => { const message = (await page()).messages[0]!; return { locator: message.locator, expectedRevision: message.revision } }
  return { executor, service, page, input, profile: () => profile!, setProfile: (value: QuarantineNativeProfile | null) => { profile = value }, denyAfter: (count: number) => { denyAt = authorizationCalls + count } }
}

describe('native quarantine service with declared executor', () => {
  it('reports absent native profile without inventing an empty collection', async () => {
    const f = fixture(); f.setProfile(null)
    expect(await f.service.list(scope)).toEqual({ state: 'unavailable', scope, reason: 'native_profile_unavailable' })
    expect(f.executor.executedCommands).toEqual([])
    await expect(f.service.delete(scope, { locator: { mailboxGuid: sourceGuid, uidValidity: 7, uid: 10, messageGuid }, expectedRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('reads actual source count, score, received/held time and bounded UID window', async () => {
    const f = fixture(), page = await f.page()
    expect(page.totalMessages).toBe(1); expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({ score: 8.5, receivedAt: '2023-11-14T22:13:20.000Z', heldAt: '2023-11-14T22:13:20.000Z', locator: { uid: 10, uidValidity: 7, mailboxGuid: sourceGuid, messageGuid } })
    expect(page.messages[0]!.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(f.executor.executedCommands.find(argv => argv[3] === 'fetch')?.[6]).toBe(QUARANTINE_SUMMARY_FIELDS)
  })
  it('distinguishes a genuinely read empty mailbox from invalid native output', async () => {
    const f = fixture(); f.executor.held.clear(); f.executor.nextUid = 1
    expect((await f.page()).messages).toEqual([])
    f.executor.nextUid = 11; f.executor.mode = 'invalid-json'
    await expect(f.service.list(scope)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('performs exact ham learning, move and source/Inbox readback without retaining plaintext', async () => {
    const f = fixture(), input = await f.input(), result = await f.service.release(scope, input)
    expect(result).toMatchObject({ state: 'released', correction: 'applied', deliveredToInbox: true, sourcePresent: false, verificationRequired: false })
    expect(f.executor.learningPayloads).toEqual([rawMime])
    const learner = f.executor.executedCommands.find(argv => argv[0] === '/usr/sbin/runuser')!
    expect(learner.slice(0, 8)).toEqual(['/usr/sbin/runuser', '-u', 'alpha', '--', '/usr/bin/sa-learn', '--ham', '--dbpath', quarantineBayesPath(scope.accountId)])
    expect(f.executor.held.size).toBe(0); expect(f.executor.inbox.size).toBe(1); expect(f.executor.files.size).toBe(0)
  })
  it('does not duplicate an Inbox copy on a release retry', async () => {
    const f = fixture(), input = await f.input(); f.executor.inbox.set(101, { ...f.executor.held.get(10)!, uid: 101 })
    await expect(f.service.release(scope, input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(f.executor.learningPayloads).toEqual([]); expect(f.executor.held.size).toBe(1); expect(f.executor.inbox.size).toBe(1)
  })
  it.each(['learn-error', 'learn-unknown', 'learn-empty'])('never moves when %s leaves correction unverified', async mode => {
    const f = fixture(), input = await f.input(); f.executor.mode = mode
    expect(await f.service.release(scope, input)).toMatchObject({ state: 'unknown', correction: 'unknown', deliveredToInbox: false, verificationRequired: true })
    expect(f.executor.executedCommands.filter(argv => argv[1] === 'move')).toHaveLength(0)
    expect(f.executor.held.size).toBe(1)
  })
  it('reports a partial copy truthfully and refuses a later duplicate move', async () => {
    const f = fixture(), input = await f.input(); f.executor.mode = 'partial-copy'
    expect(await f.service.release(scope, input)).toMatchObject({ state: 'partial', correction: 'applied', deliveredToInbox: true, sourcePresent: true, verificationRequired: true })
    await expect(f.service.release(scope, input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(f.executor.inbox.size).toBe(1); expect(f.executor.learningPayloads).toHaveLength(1)
  })
  it('treats a namespace reset during move as unknown instead of confirming absence', async () => {
    const f = fixture(), input = await f.input(); f.executor.mode = 'namespace-reset'
    expect(await f.service.release(scope, input)).toMatchObject({ state: 'unknown', correction: 'applied', deliveredToInbox: null, sourcePresent: null, verificationRequired: true })
  })
  it('keeps cleanup failure distinct from the completed mail effect', async () => {
    const f = fixture(), input = await f.input(); f.executor.mode = 'cleanup-failed'
    expect(await f.service.release(scope, input)).toMatchObject({ state: 'partial', correction: 'applied', deliveredToInbox: true, sourcePresent: false, reason: 'cleanup_unverified', verificationRequired: true })
  })
  it('refuses stale UIDVALIDITY and stale revisions before any learning or expunge', async () => {
    const f = fixture(), input = await f.input(); f.executor.uidValidity++
    await expect(f.service.release(scope, input)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.executor.learningPayloads).toEqual([])
    const current = await f.input()
    await expect(f.service.delete(scope, { ...current, expectedRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.executor.held.size).toBe(1)
  })
  it('serializes concurrent releases so the source is consumed only once', async () => {
    const f = fixture(), input = await f.input()
    const outcomes = await Promise.allSettled([f.service.release(scope, input), f.service.release(scope, input)])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(f.executor.learningPayloads).toHaveLength(1); expect(f.executor.inbox.size).toBe(1)
  })
  it('keeps authorization changes before learning and after correction explicit', async () => {
    const before = fixture(), inputBefore = await before.input(); before.denyAfter(2)
    await expect(before.service.release(scope, inputBefore)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(before.executor.learningPayloads).toEqual([])
    const after = fixture(), inputAfter = await after.input(); after.denyAfter(3)
    expect(await after.service.release(scope, inputAfter)).toMatchObject({ state: 'partial', correction: 'applied', deliveredToInbox: false, reason: 'authorization_changed' })
  })
  it('refuses a profile rebound during staging before learning', async () => {
    const f = fixture(), input = await f.input(), write = f.executor.writeFile.bind(f.executor)
    f.executor.writeFile = async file => { await write(file); f.profile().activeFilterBinding.revision = 'b'.repeat(64) }
    await expect(f.service.release(scope, input)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.executor.learningPayloads).toEqual([])
  })
  it('deletes only the exact held source and verifies absence', async () => {
    const f = fixture(), input = await f.input()
    f.executor.held.set(11, { ...f.executor.held.get(10)!, uid: 11, guid: 'e'.repeat(32) }); f.executor.nextUid = 12
    expect(await f.service.delete(scope, input)).toMatchObject({ state: 'deleted', deleted: true, sourcePresent: false, correction: 'not_attempted', verificationRequired: false })
    expect([...f.executor.held.keys()]).toEqual([11])
    expect(f.executor.executedCommands.find(argv => argv[1] === 'expunge')).toEqual(['/usr/bin/doveadm', 'expunge', '-u', scope.mailbox, 'mailbox-guid', sourceGuid, 'uid', '10', 'guid', messageGuid])
  })
  it('expires from held time and keeps recently held or unknown-time messages', async () => {
    const f = fixture(), original = f.executor.held.get(10)!
    f.executor.held.set(11, { ...original, uid: 11, guid: 'e'.repeat(32), saved: Date.parse('2026-10-25T00:00:00Z') / 1000 })
    f.executor.held.set(12, { ...original, uid: 12, guid: 'f'.repeat(32), saved: null }); f.executor.nextUid = 13
    const page = await f.page(), result = await f.service.expire(scope, page.revision)
    expect(result).toMatchObject({ state: 'expired', removed: 1, considered: 3 })
    expect([...f.executor.held.keys()]).toEqual([11, 12])
  })
  it('binds expiry to the displayed retention policy as well as source state', async () => {
    const f = fixture(), page = await f.page(); f.profile().retentionDays = 1
    await expect(f.service.expire(scope, page.revision)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.executor.held.size).toBe(1)
  })
  it('reports completed expiry effects when authorization changes partway through a batch', async () => {
    const f = fixture(); f.executor.held.set(11, { ...f.executor.held.get(10)!, uid: 11, guid: 'e'.repeat(32) }); f.executor.nextUid = 12
    const page = await f.page(); f.denyAfter(3)
    expect(await f.service.expire(scope, page.revision)).toMatchObject({ state: 'partial', removed: 1, considered: 2, results: [{ state: 'deleted', locator: { uid: 11 }, sourcePresent: false }] })
    expect([...f.executor.held.keys()]).toEqual([10])
  })
  it('bounds queued operations instead of admitting an unbounded mailbox backlog', async () => {
    const f = fixture(), original = f.executor.runCommand.bind(f.executor)
    let entered!: () => void, release!: () => void, held = true
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    f.executor.runCommand = async argv => { if (held) { held = false; entered(); await gate }; return original(argv) }
    const first = f.service.list(scope); await started
    const waiting = Array.from({ length: 15 }, () => f.service.list(scope))
    await expect(f.service.list(scope)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', detail: { stateChanged: false } })
    release(); await Promise.all([first, ...waiting])
  })
  it.each(['before_action', 'during_staging'])('refuses a recycled mailbox lifetime %s with identical source identities', async phase => {
    const f = fixture(), message = (await f.page()).messages[0]!
    const recycle = () => { f.profile().serviceUserId = 'ffffffff-ffff-4fff-8fff-ffffffffffff' }
    if (phase === 'before_action') recycle()
    else {
      const write = f.executor.writeFile.bind(f.executor)
      f.executor.writeFile = async file => { await write(file); recycle() }
    }
    await expect(f.service.release(scope, { locator: message.locator, expectedRevision: message.revision })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(f.executor.learningPayloads).toEqual([])
    expect(f.executor.inbox.size).toBe(0); expect(f.executor.held.size).toBe(1)
  })
  it('refuses foreign Bayes paths and injected mutation metadata without side effects', async () => {
    const f = fixture(); f.profile().activeFilterBinding.bayesPath = quarantineBayesPath('ffffffff-ffff-4fff-8fff-ffffffffffff')
    await expect(f.service.list(scope)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(f.executor.executedCommands).toEqual([])
    expect(() => parseQuarantineMutation({ accountId: scope.accountId, locator: {}, expectedRevision: '0'.repeat(64) })).toThrow()
  })
})

describe('finite native quarantine command policy', () => {
  it('admits only literal fields and scoped GUID/UID commands', () => {
    const valid = ['/usr/bin/doveadm', '-f', 'json', 'fetch', '-u', scope.mailbox, QUARANTINE_SUMMARY_FIELDS, 'mailbox-guid', sourceGuid, 'uid', '1:100']
    expect(isMailQuarantineArgv(valid)).toBe(true)
    expect(isMailQuarantineArgv(valid.map((value, index) => index === 10 ? '1:101' : value))).toBe(false)
    expect(isMailQuarantineArgv(valid.map((value, index) => index === 6 ? 'mailbox-guid uid guid text' : value))).toBe(false)
    expect(isMailQuarantineArgv([...valid, 'guid', messageGuid])).toBe(false)
    expect(isMailQuarantineArgv(valid.map((value, index) => index === 10 ? '10' : value).concat('guid', messageGuid))).toBe(true)
    for (const unsafe of [valid.map((value, index) => index === 6 ? value + ';id' : value), valid.map((value, index) => index === 10 ? '*' : value), valid.map((value, index) => index === 8 ? '../../foreign' : value), ['/bin/sh', '-c', 'id'], new Array(11), [...valid, 'OR', 'ALL']]) expect(isMailQuarantineArgv(unsafe)).toBe(false)
  })
})
