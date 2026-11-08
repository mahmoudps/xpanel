import { describe, expect, it } from 'vitest'
import { observeMailLog } from './mail-log.ts'
import { ACCOUNT_DELIVERY_MAX, buildMailOutcomes, buildMailReport, handleMailReportRoute, projectAccountMailLog } from './mail-log-reports.ts'

const at = (index: number): string => String(Date.parse('2026-11-07T10:00:00Z') * 1000 + index * 1_000_000)
const line = (service: string, message: string, index: number): string => JSON.stringify({ MESSAGE: message, SYSLOG_IDENTIFIER: 'postfix/' + service, _EXE: '/usr/lib/postfix/sbin/' + service, __REALTIME_TIMESTAMP: at(index) })
const outbound = (id: string, base: number, to: string, status = 'sent', size = 1000): string[] => [
  line('smtpd', `${id}: client=host[192.0.2.9], sasl_method=PLAIN, sasl_username=info@alice.test`, base),
  line('qmgr', `${id}: from=<info@alice.test>, size=${size}, nrcpt=1 (queue active)`, base + 1),
  line('smtp', `${id}: to=<${to}>, relay=mx.remote.test[198.51.100.1]:25, delay=1, delays=0/0/0/1, dsn=${status === 'sent' ? '2.0.0' : '4.4.1'}, status=${status} (result text)`, base + 2),
  ...(status === 'sent' ? [line('qmgr', `${id}: removed`, base + 3)] : []),
]
const local = (id: string, base: number): string[] => [
  line('qmgr', `${id}: from=<friend@remote.test>, size=500, nrcpt=2 (queue active)`, base),
  line('lmtp', `${id}: to=<info@alice.test>, relay=mail[private/dovecot-lmtp], delay=1, delays=0/0/0/1, dsn=2.0.0, status=sent (saved for other@bob.test)`, base + 1),
  line('lmtp', `${id}: to=<boss@bob.test>, relay=mail[private/dovecot-lmtp], delay=1, delays=0/0/0/1, dsn=2.0.0, status=sent (saved)`, base + 2),
  line('qmgr', `${id}: removed`, base + 3),
]
const observe = (lines: string[]) => observeMailLog({ run: async () => ({ ok: true, code: 0, stdout: lines.join('\n'), stderr: '' }), since: '2026-11-07T00:00:00Z', until: '2026-11-07T23:00:00Z', now: () => new Date('2026-11-07T23:00:00Z') })
const snapshot = { accounts: [{ id: 'a', username: 'alice' }, { id: 'b', username: 'bob' }], domains: [{ name: 'alice.test', accountId: 'a' }, { name: 'bob.test', accountId: 'b' }] }

describe('mail reports', () => {
  it('lists a user who relayed three messages to remote domains with totals and leaves local delivery out', async () => {
    const report = buildMailReport(await observe([...outbound('AAAA1111', 0, 'a@remote.test'), ...outbound('BBBB2222', 10, 'b@remote.test'), ...outbound('CCCC3333', 20, 'c@remote.test', 'deferred'), ...local('DDDD4444', 30)]), snapshot)
    expect(report.relayers).toEqual([{ user: 'info@alice.test', domain: 'alice.test', account: 'alice', messages: 3, recipients: 3, sent: 2, deferred: 1, failed: 0, bytes: 3000 }])
    expect(report.complete).toBe(true)
  })
  it('summarises only hosted sender domains', async () => {
    const report = buildMailReport(await observe([...outbound('AAAA1111', 0, 'a@remote.test'), ...local('DDDD4444', 30)]), snapshot)
    expect(report.domains).toEqual([{ domain: 'alice.test', account: 'alice', messages: 1, sent: 1, deferred: 0, failed: 0, bytes: 1000 }])
  })
  it('stays unavailable, with no rows, when the journal cannot be read', async () => {
    const report = buildMailReport(await observeMailLog({ run: null, since: '2026-11-07T00:00:00Z', until: '2026-11-07T23:00:00Z' }), snapshot)
    expect(report).toMatchObject({ state: 'unavailable', reason: 'journal_unavailable', complete: false, relayers: [], domains: [] })
  })
})

describe('account track delivery', () => {
  it('shows another account only as a count and redacts its addresses', async () => {
    const view = projectAccountMailLog(await observe(local('DDDD4444', 30)), 'alice', ['alice.test'])
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({ direction: 'received', otherRecipients: 1, senderUser: null })
    expect(JSON.stringify(view)).not.toContain('boss@bob.test')
    expect(JSON.stringify(view)).not.toContain('other@bob.test')
  })
  it('leaves out messages of other accounts entirely and filters by status and recipient', async () => {
    const observed = await observe([...outbound('AAAA1111', 0, 'a@remote.test'), ...outbound('CCCC3333', 20, 'c@remote.test', 'deferred')])
    expect(projectAccountMailLog(observed, 'bob', ['bob.test']).matched).toBe(0)
    expect(projectAccountMailLog(observed, 'alice', ['alice.test'], { statuses: ['deferred'] }).messages.map(item => item.queueId)).toEqual(['CCCC3333'])
    expect(projectAccountMailLog(observed, 'alice', ['alice.test'], { recipient: 'a@remote' }).messages.map(item => item.queueId)).toEqual(['AAAA1111'])
  })
  it('bounds the report to the newest records', async () => {
    const lines = Array.from({ length: ACCOUNT_DELIVERY_MAX + 3 }, (_, index) => outbound('E' + String(100000 + index), index * 5, 'a@remote.test')).flat()
    const view = projectAccountMailLog(await observe(lines), 'alice', ['alice.test'])
    expect(view.messages).toHaveLength(ACCOUNT_DELIVERY_MAX)
    expect(view.matched).toBe(ACCOUNT_DELIVERY_MAX + 3)
  })
})

describe('mail report route', () => {
  const caller = { principalId: 'p', actor: 'root', role: 'root' } as never
  const ctx = { authenticateCaller: async () => caller, assertRootCaller: async () => {}, assertAccount: async () => ({ domains: ['alice.test'] }), readSnapshot: async () => snapshot, run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }), now: () => new Date('2026-11-07T23:00:00Z') }
  const query = '?since=2026-11-07T00:00:00Z&until=2026-11-07T23:00:00Z'
  const call = (path: string, method = 'GET', overrides = {}) => handleMailReportRoute(new Request('http://agent' + path, { method }), new URL('http://agent' + path), method, { ...ctx, ...overrides })
  it('ignores other paths and refuses other methods', async () => {
    expect(await call('/host/mail/log')).toBeNull()
    expect((await call('/host/mail/log/report' + query, 'POST'))!.status).toBe(405)
  })
  it('refuses an open window, an unknown selector and an unknown status', async () => {
    await expect(call('/host/mail/log/report')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/host/mail/log/report' + query + '&domain=x.test')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/host/mail/log/account/alice' + query + '&statuses=lost')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('requires root for the report and the account authority for the account view', async () => {
    const denied = async () => { throw new Error('denied') }
    await expect(call('/host/mail/log/report' + query, 'GET', { assertRootCaller: denied })).rejects.toThrow('denied')
    await expect(call('/host/mail/log/account/alice' + query, 'GET', { assertAccount: denied })).rejects.toThrow('denied')
  })
  it('stops when the caller changes during the read', async () => {
    let reads = 0
    await expect(call('/host/mail/log/report' + query, 'GET', { authenticateCaller: async () => ({ ...(caller as object), principalId: 'p' + reads++ }) as never })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('mail outcomes', () => {
  it('counts remote recipients from the window start, keeps campaign mail apart and needs the root route', async () => {
    const campaign = [line('cleanup', 'EEEE5555: message-id=<xpm-cabcdef01-0@alice.test>', 30), line('qmgr', 'EEEE5555: from=<news@alice.test>, size=9, nrcpt=1 (queue active)', 31), line('smtp', 'EEEE5555: to=<Reader@remote.test>, relay=mx.remote.test[198.51.100.1]:25, delay=1, delays=0/0/0/1, dsn=5.1.1, status=bounced (no such user)', 32)]
    const observation = await observe([...outbound('AAAA1111', 0, 'old@remote.test'), ...outbound('BBBB2222', 10, 'b@remote.test'), ...outbound('CCCC3333', 20, 'c@remote.test', 'deferred'), ...campaign, ...local('DDDD4444', 40)])
    const result = buildMailOutcomes(observation, new Date(Date.parse('2026-11-07T10:00:00Z') + 5000).toISOString())
    expect(result.usage).toEqual([{ user: 'info@alice.test', domain: 'alice.test', recipients: 1 }])
    expect(result.marketing).toEqual([expect.objectContaining({ messageId: '<xpm-cabcdef01-0@alice.test>', recipient: 'reader@remote.test', status: 'bounced' })])
  })
})
