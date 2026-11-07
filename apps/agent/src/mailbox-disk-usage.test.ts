import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import { isMailboxExpungeCommand, mailboxExpungeArgv, parseExpungeQuery } from '../../../packages/os/src/mailbox-expunge-command.ts'
import { handleEmailDiskUsageRoute, parseCleanupRequest } from './mailbox-disk-usage.ts'
import type { EmailDiskUsageRouteDeps } from './mailbox-disk-usage.ts'

const account = { id: 'a', username: 'alice', planId: 'p', status: 'active' } as Account
const status = (bytes: number) => JSON.stringify([{ mailbox: 'INBOX', messages: '2', vsize: String(bytes) }, { mailbox: 'Sent', messages: '0', vsize: '0' }])
const deps = (over: Partial<EmailDiskUsageRouteDeps> = {}): EmailDiskUsageRouteDeps => {
  let bytes = 36 * 1024 * 1024
  return {
    caller: { role: 'user', accountId: 'a', principalId: 'u', actor: 'alice' } as EmailDiskUsageRouteDeps['caller'],
    store: { getAccountByUsername: async () => account, withAccountLifecycleLease: async (_id, operation) => operation(account), getPlan: async () => ({ featureListId: 'f' }) as never, getFeatureList: async () => ({ disabled: [] }) as never, listServiceUsers: async () => [{ login: 'bob@example.com', services: { email: true } }] as never },
    currentPrincipal: async () => ({ kind: 'user', id: 'u', username: 'alice', accountId: 'a', disabled: false }),
    run: vi.fn(async (argv: string[]) => { if (argv[1] === 'expunge') { bytes = 1024 * 1024; return { ok: true, code: 0, stdout: '' } } return { ok: true, code: 0, stdout: status(bytes) } }),
    audit: vi.fn(async () => undefined), now: () => new Date('2026-11-07T10:00:00Z'), ...over,
  }
}
const get = (ports: EmailDiskUsageRouteDeps, query = '?mailbox=bob@example.com') => { const url = new URL('http://agent/accounts/alice/email/disk-usage' + query); return handleEmailDiskUsageRoute(new Request(url), url, 'GET', ports) }
const post = (ports: EmailDiskUsageRouteDeps, body: unknown) => { const url = new URL('http://agent/accounts/alice/email/disk-usage/cleanup'); return handleEmailDiskUsageRoute(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, 'POST', ports) }
const cleanup = (over = {}) => ({ mailbox: 'bob@example.com', folder: 'INBOX', preset: 'larger-than-30mb', query: null, confirmFolder: 'INBOX', ...over })

describe('expunge grammar', () => {
  it('builds and admits only reviewed queries', () => {
    expect(parseExpungeQuery('larger 30M  before 2025-01-01')).toEqual(['LARGER', '30M', 'BEFORE', '2025-01-01'])
    for (const bad of ['', '   ', 'ALL', 'LARGER', 'LARGER x', 'DROP 1', 'OR SEEN', 'SUBJECT a;b', 'BEFORE yesterday', 'SEEN '.repeat(60)]) expect(parseExpungeQuery(bad), bad).toBeNull()
    const argv = mailboxExpungeArgv('bob@example.com', 'Archive 2024', ['LARGER', '30M'])
    expect(argv).toEqual(['/usr/bin/doveadm', 'expunge', '-u', 'bob@example.com', 'mailbox', 'Archive 2024', 'LARGER', '30M']); expect(isMailboxExpungeCommand(argv)).toBe(true)
    expect(isMailboxExpungeCommand(mailboxExpungeArgv('bob@example.com', 'INBOX', ['ALL']))).toBe(true)
    for (const bad of [['/usr/bin/doveadm', 'expunge', '-A', 'mailbox', 'INBOX', 'ALL'], ['/usr/bin/doveadm', 'expunge', '-u', '*', 'mailbox', 'INBOX', 'ALL'], ['/usr/bin/doveadm', 'expunge', '-u', 'bob@example.com', 'mailbox', '*', 'ALL'], ['/usr/bin/doveadm', 'expunge', '-u', 'bob@example.com', 'mailbox', 'INBOX']]) expect(isMailboxExpungeCommand(bad), bad.join(' ')).toBe(false)
  })
})

describe('Email Disk Usage', () => {
  it('reads folders of an owned mailbox', async () => {
    const response = await get(deps())
    expect(await response!.json()).toMatchObject({ mailbox: 'bob@example.com', folders: { state: 'read', folders: [{ name: 'INBOX', messages: 2 }, { name: 'Sent', messages: 0 }] } })
  })
  it('refuses another account, a foreign mailbox and a host without Dovecot', async () => {
    await expect(get(deps({ caller: { role: 'user', accountId: 'b', principalId: 'u', actor: 'x' } as never }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(get(deps(), '?mailbox=eve@other.test')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(get(deps({ run: null }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await handleEmailDiskUsageRoute(new Request('http://agent/x', { method: 'POST' }), new URL('http://agent/accounts/alice/email/disk-usage?mailbox=a'), 'POST', deps()))!.status).toBe(405)
  })
  it('runs the 30 MB preset, reports what was freed and audits it', async () => {
    const ports = deps(), response = await post(ports, cleanup())
    expect(vi.mocked(ports.run!).mock.calls.some(([argv]) => argv.join(' ') === '/usr/bin/doveadm expunge -u bob@example.com mailbox INBOX LARGER 30M')).toBe(true)
    expect(await response!.json()).toMatchObject({ freedBytes: 35 * 1024 * 1024 })
    expect(vi.mocked(ports.audit).mock.calls[0]![0]).toMatchObject({ action: 'email.disk_usage.cleanup', target: 'mailbox:bob@example.com', outcome: 'ok' })
  })
  it('refuses an empty custom query and a wrong confirmation with no effect', async () => {
    for (const body of [cleanup({ preset: 'custom', query: '' }), cleanup({ preset: 'custom', query: '   ' }), cleanup({ confirmFolder: 'Sent' }), cleanup({ preset: 'nope' }), cleanup({ preset: 'all', query: 'SEEN' }), { mailbox: 'bob@example.com' }]) expect(() => parseCleanupRequest(body), JSON.stringify(body)).toThrow()
    const ports = deps(); await expect(post(ports, cleanup({ preset: 'custom', query: '' }))).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(ports.run).not.toHaveBeenCalled()
  })
  it('refuses a folder the mailbox does not list and states an unknown outcome', async () => {
    const ports = deps(); await expect(post(ports, cleanup({ folder: 'Gone', confirmFolder: 'Gone' }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(vi.mocked(ports.run!).mock.calls).toHaveLength(1)
    const failing = deps({ run: vi.fn(async (argv: string[]) => argv[1] === 'expunge' ? { ok: false, code: 75, stdout: '' } : { ok: true, code: 0, stdout: status(9) }) })
    await expect(post(failing, cleanup())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    expect(vi.mocked(failing.audit).mock.calls[0]![0]).toMatchObject({ outcome: 'failed' })
  })
})
