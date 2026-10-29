import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { JOURNALCTL, MAIL_LOG_IDENTIFIERS, isMailLogCommand, mailLogArgv, parseMailLogFilters } from '../../../packages/os/src/mail-log-command.ts'
import { assertMailLogMailboxCaller, clipMailLogText, handleMailLogRoute, observeMailLog, projectMailboxMailLog, projectServerMailLog } from './mail-log.ts'
import type { MailLogRouteContext } from './mail-log.ts'
import type { AgentCallerIdentity } from './server.ts'

const SINCE = '2026-10-27T00:00:00Z', UNTIL = '2026-10-27T12:00:00Z'
const exe = (identifier: string) => '/usr/lib/postfix/sbin/' + identifier.slice('postfix/'.length)
const rec = (identifier: string, message: unknown, at = '2026-10-27T10:00:00.000Z', path: string | null = exe(identifier)) =>
  JSON.stringify({ __CURSOR: 's=1;i=2', __REALTIME_TIMESTAMP: String(Date.parse(at) * 1000 + 123), __MONOTONIC_TIMESTAMP: '1', _BOOT_ID: 'b', MESSAGE: message, SYSLOG_IDENTIFIER: identifier, ...(path === null ? {} : { _EXE: path }) })
const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })
const observe = (lines: string[], extra: { limit?: number } = {}) => observeMailLog({ run: async () => ok(lines.join('\n') + '\n'), since: SINCE, until: UNTIL, now: () => new Date('2026-10-27T12:00:00Z'), ...extra })
const t = (minute: number) => `2026-10-27T10:${String(minute).padStart(2, '0')}:00.000Z`
const sent = [
  rec('postfix/smtpd', '4F2A1B3C9D: client=mail.example.net[203.0.113.5], sasl_method=PLAIN, sasl_username=alice@example.com', t(0)),
  rec('postfix/cleanup', '4F2A1B3C9D: message-id=<m1@example.com>', t(0)),
  rec('postfix/qmgr', '4F2A1B3C9D: from=<alice@example.com>, size=1234, nrcpt=2 (queue active)', t(0)),
  rec('postfix/smtp', '4F2A1B3C9D: to=<bob@example.org>, relay=mx.example.org[198.51.100.7]:25, delay=1.2, delays=0.1/0.01/0.5/0.6, dsn=2.0.0, status=sent (250 2.0.0 OK 1730000000 q1)', t(1)),
  rec('postfix/smtp', '4F2A1B3C9D: to=<carol@example.net>, relay=none, delay=30, delays=30/0/0/0, dsn=4.4.1, status=deferred (connect to mx.example.net[192.0.2.9]:25: Connection timed out)', t(1)),
]
const lmtp = [
  rec('postfix/qmgr', '7A8B9C0D1E: from=<dave@remote.test>, size=900, nrcpt=2 (queue active)', t(2)),
  rec('postfix/lmtp', '7A8B9C0D1E: to=<alice@example.com>, orig_to=<sales@example.com>, relay=mail.example.com[private/dovecot-lmtp], delay=0.03, delays=0.01/0/0.01/0.01, dsn=2.0.0, status=sent (250 2.0.0 <alice@example.com> k9 Saved)', t(2), '/usr/lib/postfix/sbin/smtp'),
  rec('postfix/lmtp', '7A8B9C0D1E: to=<erin@example.com>, orig_to=<sales@example.com>, relay=mail.example.com[private/dovecot-lmtp], delay=0.03, delays=0.01/0/0.01/0.01, dsn=2.0.0, status=sent (250 2.0.0 <erin@example.com> k9 Saved)', t(2)),
  rec('postfix/qmgr', '7A8B9C0D1E: removed', t(2)),
]
const bounced = [
  rec('postfix/qmgr', 'B1C2D3E4F5: from=<alice@example.com>, size=500, nrcpt=1 (queue active)', t(3)),
  rec('postfix/smtp', 'B1C2D3E4F5: to=<nobody@example.org>, relay=mx.example.org[198.51.100.7]:25, delay=0.4, delays=0.1/0/0.1/0.2, dsn=5.1.1, status=bounced (host mx.example.org[198.51.100.7] said: 550 5.1.1 <nobody@example.org>: Recipient address rejected (in reply to RCPT TO command))', t(3)),
  rec('postfix/bounce', 'B1C2D3E4F5: sender non-delivery notification: C9D8E7F6A5', t(3)),
  rec('postfix/qmgr', 'B1C2D3E4F5: removed', t(3)),
]
const expired = [
  rec('postfix/qmgr', 'D0D1D2D3D4: from=<frank@example.com>, size=700, nrcpt=1 (queue active)', t(4)),
  rec('postfix/smtp', 'D0D1D2D3D4: to=<gina@far.test>, relay=none, delay=432000, delays=431999/0/1/0, dsn=4.4.1, status=deferred (connect to far.test[192.0.2.44]:25: Connection refused)', t(4)),
  rec('postfix/qmgr', 'D0D1D2D3D4: from=<frank@example.com>, status=expired, returned to sender', t(5)),
]
const rejected = rec('postfix/smtpd', 'NOQUEUE: reject: RCPT from unknown[203.0.113.9]: 554 5.7.1 <harry@example.com>: Relay access denied; from=<spam@bad.test> to=<harry@example.com> proto=ESMTP helo=<bad.test>', t(6))
const caller = (extra: Partial<AgentCallerIdentity> = {}): AgentCallerIdentity => ({ principalId: '00000000-0000-4000-8000-000000000001', actor: 'root', role: 'root', accountId: null, resellerId: null, ...extra })

describe('mail log command grammar', () => {
  it('builds and admits only the exact reviewed journalctl argv', () => {
    const argv = mailLogArgv(SINCE, UNTIL, 20000)
    expect(argv.slice(0, 11)).toEqual([JOURNALCTL, '--no-pager', '-o', 'json', '--output-fields=MESSAGE,SYSLOG_IDENTIFIER,_EXE', '--since', '2026-10-27 00:00:00 UTC', '--until', '2026-10-27 12:00:00 UTC', '-n', '20000'])
    expect(argv.slice(11)).toEqual(MAIL_LOG_IDENTIFIERS.flatMap(id => ['-t', id]))
    expect(isMailLogCommand(argv)).toBe(true)
    expect(isMailLogCommand(mailLogArgv(SINCE, '2026-11-03T00:00:00Z', 1))).toBe(true)
  })
  it('refuses identifier, time, limit and flag injection', () => {
    const base = mailLogArgv(SINCE, UNTIL, 100)
    const variants: unknown[][] = [
      [], base.slice(0, -1), [...base, '-t', 'sshd'], [...base, '--file=/tmp/x'], base.map(v => v === 'postfix/pipe' ? 'sshd' : v),
      base.map(v => v === '100' ? '0' : v), base.map(v => v === '100' ? '20001' : v), base.map(v => v === '100' ? '0100' : v), base.map(v => v === '100' ? '1e3' : v),
      base.map(v => v === '2026-10-27 00:00:00 UTC' ? '2026-10-27 00:00:00 UTC; id' : v), base.map(v => v === '2026-10-27 00:00:00 UTC' ? '-1d' : v),
      base.map(v => v === '2026-10-27 00:00:00 UTC' ? '2026-10-19 00:00:00 UTC' : v), base.map(v => v === '2026-10-27 12:00:00 UTC' ? '2026-10-26 12:00:00 UTC' : v),
      base.map(v => v === '2026-10-27 00:00:00 UTC' ? '2026-02-30 00:00:00 UTC' : v), base.map(v => v === 'json' ? 'export' : v), base.map(v => v === JOURNALCTL ? 'journalctl' : v),
      base.map(v => v.startsWith('--output-fields') ? '--output-fields=MESSAGE' : v), [...base.slice(0, 11), ...base.slice(13), '-t', 'postfix/smtp'], base.map((v, i) => i === 3 ? 7 : v),
    ]
    for (const argv of variants) expect(isMailLogCommand(argv)).toBe(false)
    expect(() => mailLogArgv('2026-10-27T00:00:00.000Z', UNTIL, 1)).toThrow()
    expect(() => mailLogArgv(SINCE, '2026-11-03T00:00:01Z', 1)).toThrow()
    expect(() => mailLogArgv(UNTIL, SINCE, 1)).toThrow()
    expect(() => mailLogArgv(SINCE, UNTIL, 1.5)).toThrow()
  })
  it('parses strict search filters and refuses unsafe values', () => {
    const map = (values: Record<string, string>) => (key: string) => values[key] ?? null
    expect(parseMailLogFilters(map({ sender: 'Alice@Example.com', domain: 'Example.ORG', status: 'deferred', dsn: '4.4' }))).toEqual({ sender: 'alice@example.com', domain: 'example.org', status: 'deferred', dsn: '4.4' })
    for (const bad of [{ sender: 'a b' }, { sender: '<x>' }, { recipient: 'x'.repeat(255) }, { domain: '-x.test' }, { status: 'ok' }, { dsn: '2.0.0.0' }, { dsn: '3.1.1' }, { sender: 'a\u0000' }] as Record<string, string>[]) expect(() => parseMailLogFilters(map(bad))).toThrow()
  })
})

describe('Postfix journal parser and correlation', () => {
  it('correlates sent, deferred, local LMTP, bounced, expired and rejected deliveries by queue id', async () => {
    const view = projectServerMailLog(await observe([...sent, ...lmtp, ...bounced, ...expired, rejected]), {})
    expect(view).toMatchObject({ scope: 'server', state: 'read', counts: { records: 17, events: 17, skipped: 0, unparsed: 0, untrusted: 0 }, lineLimitReached: false, matched: 5, omittedMessages: 0 })
    const byId = new Map(view.messages.map(message => [message.queueId, message]))
    expect(byId.get('4F2A1B3C9D')).toMatchObject({ sender: 'alice@example.com', size: 1234, recipientCount: 2, messageId: '<m1@example.com>', client: 'mail.example.net[203.0.113.5]', saslUsername: 'alice@example.com', status: 'deferred', dsn: '4.4.1', firstSeen: t(0), lastSeen: t(1) })
    expect(byId.get('4F2A1B3C9D')!.recipients).toEqual([
      { address: 'bob@example.org', originalAddress: null, status: 'sent', dsn: '2.0.0', relay: 'mx.example.org[198.51.100.7]:25', response: '250 2.0.0 OK 1730000000 q1', at: t(1), attempts: 1 },
      { address: 'carol@example.net', originalAddress: null, status: 'deferred', dsn: '4.4.1', relay: 'none', response: 'connect to mx.example.net[192.0.2.9]:25: Connection timed out', at: t(1), attempts: 1 },
    ])
    expect(byId.get('7A8B9C0D1E')).toMatchObject({ status: 'sent', recipients: [{ address: 'alice@example.com', originalAddress: 'sales@example.com', relay: 'mail.example.com[private/dovecot-lmtp]' }, { address: 'erin@example.com' }] })
    expect(byId.get('B1C2D3E4F5')).toMatchObject({ status: 'bounced', dsn: '5.1.1' })
    expect(byId.get('B1C2D3E4F5')!.events.map(event => event.kind)).toEqual(['queued', 'delivery', 'notification', 'removed'])
    expect(byId.get('D0D1D2D3D4')).toMatchObject({ status: 'expired', dsn: '4.4.1', sender: 'frank@example.com' })
    expect(byId.get(null)).toMatchObject({ status: 'rejected', sender: 'spam@bad.test', recipients: [{ address: 'harry@example.com', status: 'rejected', dsn: '5.7.1', response: '554 5.7.1 <harry@example.com>: Relay access denied' }] })
    expect(view.messages[0]!.queueId).toBeNull()
    expect(view.summary).toMatchObject({ messages: 5, statuses: { sent: 1, deferred: 1, bounced: 1, expired: 1, rejected: 1, queued: 0 }, deliveries: { sent: 3, deferred: 2, bounced: 1, expired: 0 } })
    expect(view.summary.topSenders).toEqual([{ address: 'alice@example.com', messages: 2 }, { address: 'dave@remote.test', messages: 1 }, { address: 'frank@example.com', messages: 1 }, { address: 'spam@bad.test', messages: 1 }])
    expect(view.summary.topRecipientDomains[0]).toEqual({ domain: 'example.com', recipients: 2 })
    expect(view.summary.deferralReasons).toEqual([{ dsn: '4.4.1', reason: 'Connection refused', count: 1 }, { dsn: '4.4.1', reason: 'Connection timed out', count: 1 }])
  })
  it('counts deferred-then-sent retries on one recipient and splits a reused queue id after removal', async () => {
    const view = projectServerMailLog(await observe([
      rec('postfix/qmgr', 'A1A1A1A1A1: from=<x@example.com>, size=1, nrcpt=1 (queue active)', t(0)),
      rec('postfix/smtp', 'A1A1A1A1A1: to=<y@example.org>, relay=none, delay=1, delays=1/0/0/0, dsn=4.4.1, status=deferred (connect to y[192.0.2.1]:25: Connection timed out)', t(1)),
      rec('postfix/smtp', 'A1A1A1A1A1: to=<y@example.org>, relay=y[192.0.2.1]:25, delay=61, delays=60/0/0.5/0.5, dsn=2.0.0, status=sent (250 ok)', t(2)),
      rec('postfix/qmgr', 'A1A1A1A1A1: removed', t(2)),
      rec('postfix/qmgr', 'A1A1A1A1A1: from=<z@example.com>, size=2, nrcpt=1 (queue active)', t(3)),
    ]), {})
    expect(view.messages.map(message => [message.sender, message.status])).toEqual([['z@example.com', 'queued'], ['x@example.com', 'sent']])
    expect(view.messages[1]!.recipients[0]).toMatchObject({ status: 'sent', attempts: 2 })
  })
  it('counts malformed and forged lines instead of dropping them, and skips non-delivery Postfix lines', async () => {
    const view = projectServerMailLog(await observe([
      '{not json', rec('postfix/smtp', [1, 2, 3]), rec('postfix/smtp', null), rec('sshd', 'Accepted password'),
      rec('postfix/smtp', 'ABCDEF1234: to=<a@b.test>, relay=none, delay=x, dsn=4.4.1, status=deferred (bad)'),
      rec('postfix/qmgr', 'ABCDEF1234: from=<a@b.test>, size=, nrcpt=1 (queue active)'),
      rec('postfix/smtpd', 'NOQUEUE: reject: RCPT from x[192.0.2.1]: no code here'),
      rec('postfix/smtp', 'ABCDEF1234: to=<a@b.test>, relay=none, delay=1, delays=1/0/0/0, dsn=2.0.0, status=sent (ok)', t(0), '/usr/bin/logger'),
      rec('postfix/smtp', 'ABCDEF1234: to=<a@b.test>, relay=none, delay=1, delays=1/0/0/0, dsn=2.0.0, status=sent (ok)', t(0), null),
      rec('postfix/smtpd', 'connect from unknown[192.0.2.1]'), rec('postfix/smtp', 'ABCDEF1234: host x[192.0.2.1] said: 451 try later'), rec('postfix/smtpd', 'NOQUEUE: filter: RCPT from x[192.0.2.1]: <a@b.test>: Recipient address triggers FILTER'),
      '-- No entries --',
    ]), {})
    expect(view.counts).toEqual({ records: 12, events: 0, skipped: 3, unparsed: 7, untrusted: 2 })
    expect(view.messages).toEqual([])
  })
  it('bounds remote text to 1 KiB, neutralizes controls and reports the line limit', async () => {
    const long = 'é'.repeat(900) + '\u202E\u0007'
    const view = projectServerMailLog(await observe([rec('postfix/smtp', `ABCDEF1234: to=<a@b.test>, relay=none, delay=1, delays=1/0/0/0, dsn=4.4.1, status=deferred (${long})`), rec('postfix/smtpd', 'connect from x')], { limit: 2 }), {})
    const recipient = view.messages[0]!.recipients[0]!
    expect(Buffer.byteLength(recipient.response!)).toBeLessThanOrEqual(1024)
    expect(recipient.response).not.toMatch(/[\u202E\u0007]/)
    expect(Buffer.byteLength(view.messages[0]!.events[0]!.text)).toBeLessThanOrEqual(1024)
    expect(view.lineLimitReached).toBe(true)
    expect(clipMailLogText('a\u0000bc', 2)).toBe('a ')
    expect(clipMailLogText('aé', 2)).toBe('a')
  })
  it('keeps every response under 1 MiB and reports omitted messages', async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => rec('postfix/smtp', `${(0xA00000 + i).toString(16).toUpperCase()}: to=<user${i}@example.org>, relay=none, delay=1, delays=1/0/0/0, dsn=4.4.1, status=deferred (${'x'.repeat(600)})`))
    const view = projectServerMailLog(await observe(lines), {})
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(1024 * 1024)
    expect(view.omittedMessages).toBeGreaterThan(0)
    expect(view.messages.length + view.omittedMessages).toBe(4000)
  })
  it('reports a truthful unavailable journal state and never runs another command', async () => {
    expect(await observeMailLog({ run: null, since: SINCE, until: UNTIL })).toMatchObject({ state: 'unavailable', reason: 'journal_unavailable', messages: [] })
    expect(await observeMailLog({ run: async () => ({ ok: false, code: 1, stdout: '', stderr: 'No journal files were found.' }), since: SINCE, until: UNTIL })).toMatchObject({ state: 'unavailable', reason: 'journal_unavailable' })
    expect(await observeMailLog({ run: async () => { throw new Error('spawn') }, since: SINCE, until: UNTIL })).toMatchObject({ state: 'unavailable' })
    expect(await observeMailLog({ run: async () => ok('x'.repeat(16 * 1024 * 1024 + 1)), since: SINCE, until: UNTIL })).toMatchObject({ state: 'unavailable', reason: 'output_limit' })
    const run = vi.fn(async (_argv: string[]) => ok(''))
    expect(await observeMailLog({ run, since: SINCE, until: UNTIL })).toMatchObject({ state: 'read', messages: [], counts: { records: 0 } })
    expect(run).toHaveBeenCalledTimes(1); expect(isMailLogCommand(run.mock.calls[0]![0])).toBe(true)
  })
  it('applies sender, recipient, domain, status and dsn filters before the response budget', async () => {
    const observation = await observe([...sent, ...lmtp, ...bounced, ...expired, rejected])
    const ids = (filters: Parameters<typeof projectServerMailLog>[1]) => projectServerMailLog(observation, filters).messages.map(message => message.queueId)
    expect(ids({ sender: 'alice@' })).toEqual(['B1C2D3E4F5', '4F2A1B3C9D'])
    expect(ids({ recipient: 'sales@example.com' })).toEqual(['7A8B9C0D1E'])
    expect(ids({ domain: 'far.test' })).toEqual(['D0D1D2D3D4'])
    expect(ids({ status: 'rejected' })).toEqual([null])
    expect(ids({ dsn: '5' })).toEqual([null, 'B1C2D3E4F5'])
    expect(ids({ dsn: '4.4.1', status: 'deferred' })).toEqual(['4F2A1B3C9D'])
  })
})

describe('mailbox-scoped delivery tracking', () => {
  const lines = [...sent, ...lmtp, ...bounced, ...expired, rejected]
  it('returns only the sealed mailbox events and redacts every other recipient to a count', async () => {
    const view = projectMailboxMailLog(await observe(lines), 'alice@example.com')
    expect(view).toMatchObject({ scope: 'mailbox', mailbox: 'alice@example.com', state: 'read', complete: true, omittedMessages: 0 })
    expect(view.messages.map(message => [message.queueId, message.role, message.status, message.otherRecipients])).toEqual([['B1C2D3E4F5', 'sender', 'bounced', 1], ['7A8B9C0D1E', 'recipient', 'sent', 1], ['4F2A1B3C9D', 'sender', 'deferred', 2]])
    const received = view.messages[1]!
    expect(received.sender).toBe('dave@remote.test')
    expect(received.recipients).toEqual([{ address: 'alice@example.com', status: 'sent', dsn: '2.0.0', relay: 'mail.example.com[private/dovecot-lmtp]', response: '250 2.0.0 <alice@example.com> k9 Saved', at: t(2), attempts: 1 }])
    expect(received.events).toEqual([{ at: t(2), kind: 'queued' }, { at: t(2), kind: 'delivery', status: 'sent', dsn: '2.0.0' }, { at: t(2), kind: 'removed' }])
    const text = JSON.stringify(view)
    for (const foreign of ['bob@example.org', 'carol@example.net', 'erin@example.com', 'sales@example.com', 'nobody@example.org', 'harry@example.com', 'spam@bad.test', 'frank@example.com', 'gina@far.test', 'm1@example.com', '203.0.113.5', 'sasl']) expect(text).not.toContain(foreign)
  })
  it('matches case-insensitively, includes self-addressed mail once and redacts foreign addresses inside own responses', async () => {
    const view = projectMailboxMailLog(await observe([
      rec('postfix/qmgr', 'E1E2E3E4E5: from=<Alice@Example.com>, size=10, nrcpt=2 (queue active)', t(7)),
      rec('postfix/lmtp', 'E1E2E3E4E5: to=<ALICE@example.com>, relay=mail.example.com[private/dovecot-lmtp], delay=0.1, delays=0/0/0/0.1, dsn=5.2.2, status=bounced (host said: 552 <alice@example.com> quota exceeded; also bob@example.org)', t(7)),
      rec('postfix/smtp', 'E1E2E3E4E5: to=<bob@example.org>, relay=none, delay=1, delays=1/0/0/0, dsn=4.4.1, status=deferred (connect to bob@example.org: refused)', t(7)),
    ]), 'alice@example.com')
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({ role: 'both', status: 'bounced', dsn: '5.2.2', otherRecipients: 1 })
    expect(view.messages[0]!.recipients[0]!.response).toBe('host said: 552 <alice@example.com> quota exceeded; also [address]')
    expect(JSON.stringify(view)).not.toContain('bob@example.org')
  })
  it('includes rejections addressed to the mailbox and marks incomplete reads', async () => {
    const view = projectMailboxMailLog(await observe([rejected, '{bad'], {}), 'harry@example.com')
    expect(view.complete).toBe(false)
    expect(view.messages).toMatchObject([{ queueId: null, role: 'recipient', status: 'rejected', sender: 'spam@bad.test', recipients: [{ address: 'harry@example.com', response: '554 5.7.1 <harry@example.com>: Relay access denied' }] }])
    expect(projectMailboxMailLog(await observe(lines), 'nobody-here@example.com').messages).toEqual([])
    expect(projectMailboxMailLog(await observeMailLog({ run: null, since: SINCE, until: UNTIL }), 'a@example.com')).toMatchObject({ state: 'unavailable', complete: false, messages: [] })
  })
})

describe('agent mail log route', () => {
  const context = (overrides: Partial<MailLogRouteContext> = {}) => {
    const events: string[] = []
    const ctx: MailLogRouteContext = {
      authenticateCaller: vi.fn(async () => { events.push('auth'); return caller() }),
      assertRootCaller: vi.fn(async () => { events.push('root') }),
      assertMailboxCaller: vi.fn(async () => { events.push('mailbox') }),
      run: vi.fn(async (argv: string[]) => { events.push('run'); expect(isMailLogCommand(argv)).toBe(true); return ok([...sent, ...lmtp].join('\n')) }),
      ...overrides,
    }
    return { ctx, events }
  }
  const call = (path: string, ctx: MailLogRouteContext, method = 'GET') => { const url = new URL('http://agent.local' + path); return handleMailLogRoute(new Request(url, { method }), url, method, ctx) }
  it('serves the root view after root authorization and re-checks authority after the read', async () => {
    const { ctx, events } = context()
    const response = await call(`/host/mail/log?since=${SINCE}&until=${UNTIL}&sender=alice`, ctx)
    expect(events).toEqual(['auth', 'root', 'run', 'auth', 'root'])
    expect(response!.headers.get('cache-control')).toBe('no-store')
    const body = await response!.json() as { scope: string; messages: { queueId: string }[] }
    expect(body.scope).toBe('server'); expect(body.messages.map(message => message.queueId)).toEqual(['4F2A1B3C9D'])
    expect(ctx.assertMailboxCaller).not.toHaveBeenCalled()
  })
  it('refuses a non-root caller before reading the journal', async () => {
    const { ctx } = context({ assertRootCaller: vi.fn(async () => { throw Object.assign(new Error('denied'), { code: 'FORBIDDEN' }) }) })
    await expect(call(`/host/mail/log?since=${SINCE}&until=${UNTIL}`, ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(ctx.run).not.toHaveBeenCalled()
  })
  it.each([
    `/host/mail/log?since=${SINCE}`, `/host/mail/log?since=${SINCE}&until=${UNTIL}&unit=sshd`, `/host/mail/log?since=${SINCE}&until=${UNTIL}&since=${SINCE}`,
    `/host/mail/log?since=2026-10-01T00:00:00Z&until=${UNTIL}`, `/host/mail/log?since=${SINCE}&until=${UNTIL}&limit=20001`, `/host/mail/log?since=${SINCE}&until=${UNTIL}&status=all`,
    `/host/mail/log/mailbox?since=${SINCE}&until=${UNTIL}`, `/host/mail/log/mailbox?address=Alice@Example.com&since=${SINCE}&until=${UNTIL}`, `/host/mail/log/mailbox?address=a@example.com&since=${SINCE}&until=${UNTIL}&sender=x`,
  ])('refuses %s with a validation error and no journal read', async path => {
    const { ctx } = context()
    await expect(call(path, ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(ctx.run).not.toHaveBeenCalled()
  })
  it('scopes the mailbox route to the asserted sealed address and never uses root authority', async () => {
    const { ctx, events } = context()
    const response = await call(`/host/mail/log/mailbox?address=alice@example.com&since=${SINCE}&until=${UNTIL}`, ctx)
    expect(events).toEqual(['auth', 'mailbox', 'run', 'auth', 'mailbox'])
    expect(ctx.assertMailboxCaller).toHaveBeenCalledWith(expect.anything(), 'alice@example.com')
    expect(ctx.assertRootCaller).not.toHaveBeenCalled()
    const text = await response!.text()
    expect(JSON.parse(text)).toMatchObject({ scope: 'mailbox', mailbox: 'alice@example.com' })
    expect(text).not.toContain('bob@example.org'); expect(text).not.toContain('erin@example.com')
  })
  it('discards the read when the caller changes during observation', async () => {
    let n = 0
    const { ctx } = context({ authenticateCaller: vi.fn(async () => caller(n++ ? { principalId: '00000000-0000-4000-8000-000000000002' } : {})) })
    await expect(call(`/host/mail/log?since=${SINCE}&until=${UNTIL}`, ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('answers only GET and ignores unrelated paths', async () => {
    const { ctx } = context()
    expect(await call('/host/mail/queue', ctx)).toBeNull()
    expect((await call(`/host/mail/log?since=${SINCE}&until=${UNTIL}`, ctx, 'POST'))!.status).toBe(405)
    expect(ctx.authenticateCaller).not.toHaveBeenCalled()
  })
})

describe('sealed mailbox caller authority', () => {
  const address = 'alice@example.com', accountId = '00000000-0000-4000-8000-0000000000aa'
  const mbx = 'mbx' + createHash('sha256').update('xpanel-mailbox:' + address).digest('hex').slice(0, 28)
  const ports = (overrides: { principal?: object | null; mailbox?: object | null; account?: object | null; disabled?: string[] } = {}) => ({
    principal: async () => (overrides.principal === undefined ? { id: user.principalId, kind: 'user', username: mbx, accountId, disabled: false } : overrides.principal) as never,
    store: {
      getServiceUserByLogin: async () => (overrides.mailbox === undefined ? { id: 's', accountId, login: address, services: { email: true, ftp: false, webdisk: false } } : overrides.mailbox) as never,
      getAccount: async () => (overrides.account === undefined ? { id: accountId, status: 'active', planId: 'p' } : overrides.account) as never,
      getPlan: async () => ({ featureListId: 'f' }) as never,
      getFeatureList: async () => ({ disabled: overrides.disabled ?? [] }) as never,
    },
  })
  const user = caller({ role: 'user', actor: mbx, accountId })
  it('accepts only the mailbox principal bound to the active mailbox', async () => {
    await expect(assertMailLogMailboxCaller(ports(), user, address)).resolves.toBeUndefined()
    await expect(assertMailLogMailboxCaller(ports({ principal: { id: user.principalId, kind: 'user', username: address, accountId, disabled: false } }), { ...user, actor: address }, address)).resolves.toBeUndefined()
  })
  it.each([
    ['account owner principal', ports({ principal: { id: caller().principalId, kind: 'user', username: 'owner1', accountId, disabled: false } }), { ...user, actor: 'owner1' }],
    ['another mailbox', ports(), user, 'bob@example.com'],
    ['root caller', ports(), caller()],
    ['disabled principal', ports({ principal: { id: user.principalId, kind: 'user', username: mbx, accountId, disabled: true } }), user],
    ['foreign account mailbox', ports({ mailbox: { id: 's', accountId: 'other', login: address, services: { email: true } } }), user],
    ['mailbox without email', ports({ mailbox: { id: 's', accountId, login: address, services: { email: false } } }), user],
    ['suspended account', ports({ account: { id: accountId, status: 'suspended', planId: 'p' } }), user],
    ['disabled feature', ports({ disabled: ['emailtrace'] }), user],
  ])('refuses %s', async (_label, port, who, target = address) => {
    await expect(assertMailLogMailboxCaller(port, who as AgentCallerIdentity, target as string)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
