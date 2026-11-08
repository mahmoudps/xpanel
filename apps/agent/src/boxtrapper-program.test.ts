import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isBoxTrapperCommand, boxTrapperArgv } from '../../../packages/os/src/boxtrapper-command.ts'

const program = createRequire(import.meta.url)('./boxtrapper-program.cjs') as {
  main(argv: string[], fd: number, env: Record<string, string>, sendmail: (args: string[], input: string | number) => boolean, now: Date): string
  parseRule(line: string): { field: string; pattern: string } | null
  wildcard(pattern: string, text: string): boolean
  addresses(value: string): string[]
  decodeWords(value: string): string
  parseHead(value: Buffer): Map<string, string[]>
}
const now = new Date('2026-11-07T10:00:00.000Z')
const templates = Object.fromEntries(['verify', 'released', 'failed', 'deny'].map(kind => [kind, { subject: `${kind} {token}`, body: `${kind} {sender} {subject}` }]))
let dir = '', store = '', rulesPath = ''
const mail: { args: string[]; text: string }[] = []
const sendmail = (args: string[], input: string | number): boolean => { mail.push({ args, text: typeof input === 'string' ? input : readFileSync(input).toString() }); return true }
function rules(extra: Record<string, unknown> = {}): void {
  writeFileSync(rulesPath, JSON.stringify({ mailbox: 'me@hosted.test', store, extraAddresses: ['alias@hosted.test'], displayName: '', retentionDays: 15, spamBypass: null, autoAllowSent: true, allowByAssociation: true, dailyNotices: 100, templates, ...extra }))
}
function deliver(raw: string, sender: string, at = now): string {
  const file = join(dir, 'message'), fd = (writeFileSync(file, raw), openSync(file, 'r'))
  try { return program.main(['filter', rulesPath], fd, { SENDER: sender }, sendmail, at) } finally { closeSync(fd) }
}
const message = (from: string, subject = 'Hello', extra = ''): string => `From: Someone <${from}>\nTo: me@hosted.test\nSubject: ${subject}\n${extra}\nbody\n`
const held = (): string[] => { const day = join(store, 'queue', '20261107'); return existsSync(day) ? readdirSync(day).filter(name => name.endsWith('.eml')) : [] }
const list = (name: string): string => { const file = join(store, name + '.txt'); return existsSync(file) ? readFileSync(file, 'utf8') : '' }
const review = (...argv: string[]) => JSON.parse(program.main(argv, 0, {}, sendmail, now))
const token = (): string => /verify ([0-9a-f-]+)/.exec(mail[0]!.text)![1]!

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boxtrapper-')); store = join(dir, 'box', 'boxtrapper'); rulesPath = join(dir, 'rules.json'); mkdirSync(join(dir, 'box')); mail.length = 0; rules() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('BoxTrapper delivery decisions', { tags: ['unit'] }, () => {
  it('parses rules, globs, addresses and encoded subjects', () => {
    expect(program.parseRule('from *@Example.com')).toEqual({ field: 'from', pattern: '*@example.com' })
    expect(program.parseRule('Subject invoice *')).toEqual({ field: 'subject', pattern: 'invoice *' })
    expect(program.parseRule('a@example.com')).toEqual({ field: 'from', pattern: 'a@example.com' })
    expect(program.parseRule('two words')).toBeNull()
    expect(program.wildcard('*@example.com', 'a@example.com')).toBe(true)
    expect(program.wildcard('a?c', 'abc')).toBe(true)
    expect(program.wildcard('*@example.com', 'a@example.org')).toBe(false)
    expect(program.wildcard('*a*a*a*a*a*a*a*a*b', 'a'.repeat(300))).toBe(false)
    expect(program.addresses('"Doe, J" <J@Example.com>, b@example.org (B), not an address')).toEqual(['j@example.com', 'b@example.org'])
    expect(program.decodeWords('=?UTF-8?B?2YXYsdit2KjYpw==?=')).toBe('مرحبا')
    expect(program.parseHead(Buffer.from('Subject: a\r\n b\r\n\r\nIgnored: x\r\n')).get('subject')).toEqual(['a b'])
  })

  it('queues an unknown sender, sends one challenge a day, and releases on the token', () => {
    expect(deliver(message('stranger@example.com'), 'stranger@example.com')).toBe('hold')
    expect(held()).toHaveLength(1)
    expect(mail).toHaveLength(1)
    expect(mail[0]!.args).toEqual(['-i', '-f', '<>', '--', 'stranger@example.com'])
    expect(mail[0]!.text).toContain('Auto-Submitted: auto-replied')
    expect(deliver(message('stranger@example.com', 'Second'), 'stranger@example.com')).toBe('hold')
    expect(held()).toHaveLength(2)
    expect(mail).toHaveLength(1)

    const reply = Buffer.from(`Re: verify#${token()}`).toString('base64')
    expect(deliver(message('stranger@example.com', `=?UTF-8?B?${reply}?=`), 'stranger@example.com')).toBe('hold')
    expect(held()).toHaveLength(0)
    expect(list('allow')).toBe('from stranger@example.com\n')
    const released = mail.filter(item => item.args.at(-1) === 'me@hosted.test')
    expect(released).toHaveLength(2)
    expect(released[0]!.args).toEqual(['-i', '-f', 'stranger@example.com', '--', 'me@hosted.test'])
    expect(mail.at(-1)!.text).toContain('released')

    // Re-entry through normal delivery spends the one-time mark, and a replay of the same id is an ordinary message.
    const id = /^X-BoxTrapper-Release: (\S+)$/m.exec(released[0]!.text)![1]!
    expect(existsSync(join(store, 'pass', id))).toBe(true)
    expect(deliver(released[0]!.text, 'stranger@example.com')).toBe('allow')
    expect(existsSync(join(store, 'pass', id))).toBe(false)
    expect(deliver(message('stranger@example.com', 'Third'), 'stranger@example.com')).toBe('allow')
  })

  it('answers a wrong token with the failed notice and releases nothing', () => {
    deliver(message('stranger@example.com'), 'stranger@example.com')
    const before = mail.length
    expect(deliver(message('other@example.com', `Re: verify#${token()}`), 'other@example.com')).toBe('hold')
    expect(held()).toHaveLength(1)
    expect(mail).toHaveLength(before + 1)
    expect(mail.at(-1)!.text).toContain('failed')
    expect(list('allow')).toBe('')
  })

  it('never releases on an automatic reply, even with the right token', () => {
    deliver(message('stranger@example.com'), 'stranger@example.com')
    expect(deliver(message('stranger@example.com', `Re: verify#${token()}`, 'Auto-Submitted: auto-replied\n'), 'stranger@example.com')).toBe('hold')
    expect(list('allow')).toBe('')
    expect(held()).toHaveLength(2)
  })

  it('ignore beats allow and stays silent; deny notifies; deny beats allow', () => {
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'allow.txt'), 'from both@example.com\nfrom denied@example.com\n')
    writeFileSync(join(store, 'ignore.txt'), 'from both@example.com\n')
    writeFileSync(join(store, 'deny.txt'), 'from *@denied.example\nfrom denied@example.com\n')
    expect(deliver(message('both@example.com'), 'both@example.com')).toBe('hold')
    expect(mail).toHaveLength(0)
    expect(held()).toHaveLength(0)
    expect(deliver(message('denied@example.com'), 'denied@example.com')).toBe('hold')
    expect(mail).toHaveLength(1)
    expect(mail[0]!.text).toContain('deny denied@example.com')
    expect(held()).toHaveLength(0)
  })

  it('holds without a challenge for automatic, flagged, undirected or self-addressed mail', () => {
    for (const [raw, sender] of [
      [message('list@example.com', 'News', 'List-Id: <news.example.com>\n'), 'list@example.com'],
      [message('bulk@example.com', 'Sale', 'Precedence: bulk\n'), 'bulk@example.com'],
      [message('robot@example.com', 'Bot', 'Auto-Submitted: auto-generated\n'), 'robot@example.com'],
      [message('bounce@example.com'), ''],
      [message('spam@example.com', 'Pills', 'X-Spam: Yes\n'), 'spam@example.com'],
      ['From: x@example.com\nTo: someone@else.test\nSubject: bcc\n\nb\n', 'x@example.com'],
      [message('me@hosted.test', 'Forged'), 'forged@example.com'],
    ] as const) expect(deliver(raw, sender)).toBe('hold')
    expect(mail).toHaveLength(0)
    expect(held()).toHaveLength(7)
  })

  it('challenges mail sent to an extra address and caps notices per mailbox', () => {
    rules({ dailyNotices: 1 })
    deliver('From: a@example.com\nTo: alias@hosted.test\nSubject: s\n\nb\n', 'a@example.com')
    deliver('From: b@example.com\nCc: Me <me@hosted.test>\nSubject: s\n\nb\n', 'b@example.com')
    expect(mail.map(item => item.args.at(-1))).toEqual(['a@example.com'])
  })

  it('reads the score only while a filter rewrites it, and below the bypass only', () => {
    const scored = (score: string): string => message('s@example.com', 'x', `X-Spam-Status: No, score=${score} required=5.0\n`)
    expect(deliver(scored('-5.0'), 's@example.com')).toBe('hold')
    rules({ spamBypass: -2.5 })
    expect(deliver(scored('-1.0'), 's@example.com')).toBe('hold')
    expect(deliver(scored('-5.0'), 's@example.com')).toBe('allow')
    expect(list('allow')).toBe('')
  })

  it('allows a sender the mailbox wrote to, recorded from the Sent folder, only with the setting on', () => {
    mkdirSync(join(dir, 'box', '.Sent', 'cur'), { recursive: true })
    writeFileSync(join(dir, 'box', '.Sent', 'cur', '1762500000.M1.host:2,S'), 'To: Friend <friend@example.com>\nSubject: hi\n\nbody\n')
    rules({ autoAllowSent: false })
    expect(deliver(message('friend@example.com'), 'friend@example.com')).toBe('hold')
    rules()
    expect(deliver(message('friend@example.com'), 'friend@example.com')).toBe('allow')
    expect(list('allow')).toBe('from friend@example.com\n')
  })

  it('allows by association only the other recipients of allowed mail', () => {
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'allow.txt'), 'from friend@example.com\n')
    expect(deliver('From: friend@example.com\nTo: me@hosted.test, colleague@example.com\nCc: alias@hosted.test\nSubject: s\n\nb\n', 'friend@example.com')).toBe('allow')
    expect(list('allow')).toBe('from friend@example.com\nfrom colleague@example.com\n')
    rules({ allowByAssociation: false })
    expect(deliver('From: friend@example.com\nTo: me@hosted.test, third@example.com\nSubject: s\n\nb\n', 'friend@example.com')).toBe('allow')
    expect(list('allow')).not.toContain('third@example.com')
  })

  it('leaves the message in normal delivery when the rules cannot be read', () => {
    rmSync(rulesPath)
    expect(() => deliver(message('a@example.com'), 'a@example.com')).toThrow()
    rules()
    writeFileSync(join(dir, 'box', 'boxtrapper'), 'in the way')
    expect(() => deliver(message('a@example.com'), 'a@example.com')).toThrow()
  })

  it('purges queue, log and notice days past retention once a day', () => {
    deliver(message('old@example.com'), 'old@example.com', new Date('2026-10-01T00:00:00.000Z'))
    expect(existsSync(join(store, 'queue', '20261001'))).toBe(true)
    deliver(message('new@example.com'), 'new@example.com')
    expect(existsSync(join(store, 'queue', '20261001'))).toBe(false)
    expect(existsSync(join(store, 'log', '2026-10-01.log'))).toBe(false)
    expect(existsSync(join(store, 'sent', '20261001'))).toBe(false)
  })
})

describe('BoxTrapper review', { tags: ['unit'] }, () => {
  it('lists the queue by day, shows one message and acts on it', () => {
    deliver(message('a@example.com', 'First'), 'a@example.com')
    deliver(message('a@example.com', '=?UTF-8?B?2YXYsdit2KjYpw==?='), 'a@example.com')
    deliver(message('b@example.com', 'Other'), 'b@example.com')
    const queue = review('queue', store, 'latest')
    expect(queue.day).toBe('2026-11-07')
    expect(queue.days).toEqual([{ day: '2026-11-07', count: 3 }])
    expect(queue.rows.map((row: { subject: string }) => row.subject).sort()).toEqual(['First', 'Other', 'مرحبا'].sort())
    const first = queue.rows.find((row: { subject: string }) => row.subject === 'First'), other = queue.rows.find((row: { subject: string }) => row.subject === 'Other')
    const shown = review('message', store, first.id)
    expect(shown).toMatchObject({ found: true, from: 'a@example.com', truncated: false })
    expect(shown.headers).toContain('Subject: First')
    expect(shown.headers).not.toContain('X-BoxTrapper-Release')
    expect(shown.body).toBe('body\n')
    expect(review('message', store, '20261107-' + 'a'.repeat(32))).toEqual({ found: false })
    // allow delivers every held message of that sender; deny drops and lists.
    expect(review('act', store, 'me@hosted.test', 'allow', first.id)).toEqual({ done: 2, failed: 0 })
    expect(list('allow')).toBe('from a@example.com\n')
    expect(review('act', store, 'me@hosted.test', 'deny', other.id)).toEqual({ done: 1, failed: 0 })
    expect(list('deny')).toBe('from b@example.com\n')
    expect(held()).toHaveLength(0)
    expect(review('log', store, 'latest').lines.join('\n')).toContain('challenge a@example.com First')
  })

  it('keeps a held message when sendmail refuses it', () => {
    deliver(message('a@example.com'), 'a@example.com')
    const id = review('queue', store, 'latest').rows[0].id
    const reply = JSON.parse(program.main(['act', store, 'me@hosted.test', 'deliver', id], 0, {}, () => false, now))
    expect(reply).toEqual({ done: 0, failed: 1 })
    expect(held()).toHaveLength(1)
    expect(existsSync(join(store, 'pass', id))).toBe(false)
  })

  it('saves lists against the read revision and refuses invalid rules', () => {
    const read = review('lists', store), encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64')
    const lists = { allow: ['from *@example.com'], ignore: [], deny: ['subject casino*'] }
    const saved = review('lists-set', store, read.revision, encode(lists))
    expect(saved).toMatchObject({ saved: true, lists })
    expect(review('lists-set', store, read.revision, encode(lists))).toEqual({ saved: false, reason: 'lists_changed' })
    expect(review('lists-set', store, saved.revision, encode({ ...lists, allow: ['two words here'] }))).toEqual({ saved: false, reason: 'lists_invalid' })
  })

  it('admits only the reviewed account calls', () => {
    const box = '/home/alice/mail/hosted.test/me/boxtrapper', id = '20261107-' + 'a'.repeat(32)
    expect(isBoxTrapperCommand(boxTrapperArgv('alice', box, { op: 'queue', day: 'latest' }))).toBe(true)
    expect(isBoxTrapperCommand(boxTrapperArgv('alice', box, { op: 'message', id }))).toBe(true)
    expect(isBoxTrapperCommand(boxTrapperArgv('alice', box, { op: 'act', mailbox: 'me@hosted.test', action: 'allow', ids: [id] }))).toBe(true)
    expect(isBoxTrapperCommand(boxTrapperArgv('bob', box, { op: 'queue', day: 'latest' }))).toBe(false)
    expect(isBoxTrapperCommand(boxTrapperArgv('alice', '/home/alice/mail/hosted.test/me/../../x/boxtrapper', { op: 'lists' }))).toBe(false)
    expect(isBoxTrapperCommand(boxTrapperArgv('alice', box, { op: 'message', id: '../x' }))).toBe(false)
    expect(isBoxTrapperCommand(boxTrapperArgv('alice', box, { op: 'act', mailbox: 'me@hosted.test', action: 'allow', ids: [] }))).toBe(false)
    expect(isBoxTrapperCommand(['/usr/sbin/runuser', '-u', 'alice', '--', '/bin/sh', 'queue', box, 'latest'])).toBe(false)
  })
})
