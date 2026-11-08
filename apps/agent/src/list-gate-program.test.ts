import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isListGateCommand, listGateArgv } from '../../../packages/os/src/list-gate-command.ts'

const program = createRequire(import.meta.url)('./list-gate-program.cjs') as {
  main(argv: string[], fd: number, env: Record<string, string>, sendmail: (args: string[], input: string | number) => boolean, now: Date): string
}
const now = new Date('2026-11-07T10:00:00.000Z'), LIST = 'team@hosted.test'
let dir = '', store = '', maildir = '', rulesPath = '', sending = true
const mail: { args: string[]; text: string }[] = []
const sendmail = (args: string[], input: string | number): boolean => { if (!sending) return false; mail.push({ args, text: typeof input === 'string' ? input : readFileSync(input).toString() }); return true }
function rules(extra: Record<string, unknown> = {}): void {
  writeFileSync(rulesPath, JSON.stringify({ address: LIST, store, members: ['ann@member.test', 'bob@member.test'], moderators: ['mod@hosted.test'], moderatedMembers: [], posting: 'members', nonMemberAction: 'hold', memberAction: 'hold', acceptSenders: [], holdSenders: [], rejectSenders: [], discardSenders: [], maxMessageKb: 0, notifyModerators: true, notifySender: true, retentionDays: 14, ...extra }))
}
function deliver(raw: string, sender: string, at = now): string {
  const file = join(dir, 'message'), fd = (writeFileSync(file, raw), openSync(file, 'r'))
  try { return program.main(['filter', rulesPath], fd, { SENDER: sender }, sendmail, at) } finally { closeSync(fd) }
}
const message = (from: string, subject = 'Hello', extra = ''): string => `Return-Path: <${from}>\nDelivered-To: rabc@hidden.invalid\nFrom: Someone <${from}>\nTo: ${LIST}\nSubject: ${subject}\n${extra}\nbody line\n`
const review = (...argv: string[]) => JSON.parse(program.main(argv, 0, {}, sendmail, now))
const queue = () => review('queue', store, maildir) as { total: number; rows: { id: string; from: string; reason: string }[] }
const heldFiles = (): string[] => { const held = join(store, 'held'); return existsSync(held) ? readdirSync(held) : [] }
const to = (address: string) => mail.filter(item => item.args.includes(address))

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'list-gate-')); store = join(dir, 'home', 'listgate'); maildir = join(dir, 'home', 'hidden'); rulesPath = join(dir, 'rules.json'); mkdirSync(join(dir, 'home')); mail.length = 0; sending = true; rules() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('list gate delivery decisions', { tags: ['unit'] }, () => {
  it('fans a member post out to every member without the hidden delivery trace', () => {
    expect(deliver(message('ANN@member.test'), 'ann@member.test')).toBe('')
    expect(mail).toHaveLength(1)
    expect(mail[0]!.args).toEqual(['-i', '-f', 'ann@member.test', '--', 'ann@member.test', 'bob@member.test'])
    expect(mail[0]!.text).toContain('List-Id: <team.hosted.test>\nList-Post: <mailto:team@hosted.test>\nPrecedence: list\n')
    expect(mail[0]!.text).toContain('From: Someone <ANN@member.test>')
    expect(mail[0]!.text).toContain('\n\nbody line\n')
    for (const gone of ['Delivered-To', 'Return-Path', 'X-List-Release']) expect(mail[0]!.text).not.toContain(gone)
    expect(heldFiles()).toEqual([])
  })
  it('holds a non-member, tells the moderator and the sender once a day, and never fans out', () => {
    deliver(message('stranger@example.com'), 'stranger@example.com')
    deliver(message('stranger@example.com', 'Again'), 'stranger@example.com')
    expect(queue().rows.map(row => [row.from, row.reason])).toEqual([['stranger@example.com', 'non_member'], ['stranger@example.com', 'non_member']])
    expect(to('mod@hosted.test')).toHaveLength(2)
    expect(to('stranger@example.com')).toHaveLength(1)
    expect(to('mod@hosted.test')[0]!.args).toEqual(['-i', '-f', '<>', '--', 'mod@hosted.test'])
    expect(to('mod@hosted.test')[0]!.text).toContain('Subject: Message held for team@hosted.test: Hello')
    expect(to('mod@hosted.test')[0]!.text).toContain('Reason: The sender is not a member of this list.')
    expect(to('ann@member.test')).toEqual([])
  })
  it('honours the switches for notices and the non-member action', () => {
    rules({ notifyModerators: false, notifySender: false })
    deliver(message('stranger@example.com'), 'stranger@example.com')
    expect(mail).toEqual([])
    rules({ nonMemberAction: 'reject' })
    deliver(message('r@example.com', 'Nope'), 'r@example.com')
    expect(to('r@example.com')[0]!.text).toContain('Subject: Your message to team@hosted.test was not delivered')
    expect(queue().total).toBe(1)
    rules({ nonMemberAction: 'discard' })
    mail.length = 0
    deliver(message('d@example.com'), 'd@example.com')
    expect(mail).toEqual([])
    expect(queue().total).toBe(1)
  })
  it('applies the member flag, sender rules, moderated posting and the size limit in order', () => {
    rules({ moderatedMembers: ['ann@member.test'], memberAction: 'discard' })
    deliver(message('ann@member.test'), 'ann@member.test')
    expect(mail).toEqual([])
    rules({ posting: 'open', acceptSenders: ['ok@*'], holdSenders: ['*@hold.test'], rejectSenders: ['*@reject.test'], discardSenders: ['*@drop.test'], notifySender: false, notifyModerators: false })
    deliver(message('x@hold.test'), 'x@hold.test')
    expect(queue().rows[0]!.reason).toBe('sender_filter')
    deliver(message('x@drop.test'), 'x@drop.test')
    expect(queue().total).toBe(1)
    deliver(message('ok@hold.test'), 'ok@hold.test')
    expect(mail).toHaveLength(1)
    rules({ posting: 'moderated', notifyModerators: false, notifySender: false })
    deliver(message('ann@member.test'), 'ann@member.test')
    expect(queue().rows.map(row => row.reason)).toContain('moderated_list')
    rules({ posting: 'open', maxMessageKb: 1, notifyModerators: false, notifySender: false })
    deliver(message('ann@member.test', 'Big', '') + 'x'.repeat(2000), 'ann@member.test')
    expect(queue().rows.map(row => row.reason)).toContain('too_large')
  })
  it('stops notices at its time budget, so Sieve never kills a post it already held', () => {
    rules({ moderators: ['one@hosted.test', 'two@hosted.test', 'three@hosted.test'] })
    let clock = 1_000_000
    const time = vi.spyOn(Date, 'now').mockImplementation(() => clock), slow = sendmail
    try {
      const file = join(dir, 'message'), fd = (writeFileSync(file, message('stranger@example.com')), openSync(file, 'r'))
      program.main(['filter', rulesPath], fd, { SENDER: 'stranger@example.com' }, (args, input) => { clock += 11_000; return slow(args, input) }, now)
      closeSync(fd)
    } finally { time.mockRestore() }
    expect(mail.map(item => item.args.at(-1))).toEqual(['one@hosted.test'])
    expect(queue().total).toBe(1)
  })
  it('holds automated mail quietly, drops a loop of its own, and counts neither of two authors as a member', () => {
    deliver(message('ann@member.test', 'Away', 'Auto-Submitted: auto-replied\n'), 'ann@member.test')
    expect(queue().rows[0]!.reason).toBe('automated')
    expect(to('ann@member.test')).toEqual([])
    deliver(message('ann@member.test', 'Loop', 'List-Id: <team.hosted.test>\n'), 'ann@member.test')
    expect(queue().total).toBe(1)
    deliver('From: ann@member.test, stranger@example.com\nSubject: Two\n\nx\n', 'ann@member.test')
    expect(queue().rows.map(row => row.reason)).toContain('non_member')
  })
  it('keeps a failed fan-out for the queue: the script keeps the post and the queue adopts it', () => {
    sending = false
    const raw = message('ann@member.test')
    expect(() => deliver(raw, 'ann@member.test')).toThrow('fan_out_failed')
    expect(heldFiles()).toEqual([])
    sending = true
    mkdirSync(join(maildir, 'new'), { recursive: true })
    writeFileSync(join(maildir, 'new', '1.host'), raw)
    expect(queue().rows).toMatchObject([{ from: 'ann@member.test', reason: 'gate_failed' }])
    expect(readdirSync(join(maildir, 'new'))).toEqual([])
    const { rows: [row] } = queue()
    expect(review('message', store, row!.id)).toMatchObject({ found: true, truncated: false })
  })
})

describe('list gate moderation', { tags: ['unit'] }, () => {
  const held = (from = 'stranger@example.com'): string => { deliver(message(from), from); mail.length = 0; return queue().rows[0]!.id }

  it('approves through Postfix with a one-time mark that passes the check once', () => {
    const id = held()
    expect(review('act', store, LIST, 'approve', '-', id)).toEqual({ done: 1, failed: 0 })
    expect(mail[0]!.args).toEqual(['-i', '-f', 'stranger@example.com', '--', LIST])
    const released = mail[0]!.text
    expect(released.startsWith(`X-List-Release: ${id}\n`)).toBe(true)
    expect(queue().total).toBe(0)
    mail.length = 0
    deliver(released, 'stranger@example.com')
    expect(mail).toHaveLength(1)
    expect(mail[0]!.args.slice(-2)).toEqual(['ann@member.test', 'bob@member.test'])
    expect(mail[0]!.text).not.toContain('X-List-Release')
    mail.length = 0
    deliver(released, 'stranger@example.com')
    expect(queue().rows[0]!.reason).toBe('non_member')
    deliver(`X-List-Release: 20261107-${'0'.repeat(32)}\n${message('forger@example.com')}`, 'forger@example.com')
    expect(to('ann@member.test')).toEqual([])
  })
  it('stays held when the release cannot be sent', () => {
    const id = held()
    sending = false
    expect(review('act', store, LIST, 'approve', '-', id)).toEqual({ done: 0, failed: 1 })
    expect(queue().total).toBe(1)
    expect(existsSync(join(store, 'pass', id))).toBe(false)
  })
  it('rejects with the moderator reason, discards without a word, and skips unknown ids', () => {
    const id = held()
    expect(review('act', store, LIST, 'reject', Buffer.from('Off topic').toString('base64'), id)).toEqual({ done: 1, failed: 0 })
    expect(to('stranger@example.com')[0]!.text).toContain('Off topic')
    const other = held('other@example.com')
    expect(review('act', store, LIST, 'discard', '-', other, `20261107-${'f'.repeat(32)}`)).toEqual({ done: 1, failed: 0 })
    expect(mail).toEqual([])
    expect(queue().total).toBe(0)
  })
  it('expires held posts by retention at the next delivery and purges the store', () => {
    held()
    deliver(message('later@example.com'), 'later@example.com', new Date('2026-11-30T10:00:00.000Z'))
    expect(queue().total).toBe(1)
    expect(review('purge', store, maildir)).toEqual({ purged: true })
    expect(existsSync(store)).toBe(false)
  })
  it('allows only the reviewed grammar as the owning account', () => {
    const owned = '/home/alice/mail/alice.test/team/listgate', hidden = `/home/alice/mail/a${'0'.repeat(16)}.autoreply.xpanel.invalid/r${'1'.repeat(20)}`, id = `20261107-${'a'.repeat(32)}`
    expect(isListGateCommand(listGateArgv('alice', owned, { op: 'queue', maildir: hidden }))).toBe(true)
    expect(isListGateCommand(listGateArgv('alice', owned, { op: 'purge', maildir: hidden }))).toBe(true)
    expect(isListGateCommand(listGateArgv('alice', owned, { op: 'message', id }))).toBe(true)
    expect(isListGateCommand(listGateArgv('alice', owned, { op: 'act', address: 'team@alice.test', action: 'approve', reason: '-', ids: [id] }))).toBe(true)
    expect(isListGateCommand(listGateArgv('bob', owned, { op: 'message', id }))).toBe(false)
    expect(isListGateCommand(listGateArgv('alice', owned, { op: 'queue', maildir: hidden.replace('alice', 'bob') }))).toBe(false)
    expect(isListGateCommand(listGateArgv('alice', '/home/alice/mail/alice.test/team/boxtrapper', { op: 'message', id }))).toBe(false)
    expect(isListGateCommand(listGateArgv('alice', owned, { op: 'act', address: 'team@alice.test', action: 'filter' as never, reason: '-', ids: [id] }))).toBe(false)
    expect(isListGateCommand(['/usr/sbin/runuser', '-u', 'alice', '--', '/bin/sh', 'message', owned, id])).toBe(false)
  })
})
