import { describe, expect, it } from 'vitest'
import { buildMailReindexPlan, handleMailMailboxActionRoute, learnMessage, parseFetchedMessage, readSpamStoreOwner } from './mail-mailbox-actions.ts'
import { isMailMailboxActionCommand, isMailReindexCommand, mailFetchTextArgv, mailIndexAllArgv, mailLearnFileArgv } from '../../../packages/os/src/mail-mailbox-actions-command.ts'
import type { HostJobPlan } from './host-job-contract.ts'

const active = (unit: string) => (argv: string[]) => argv.includes(unit) && argv[1] === 'show' ? { ok: true, code: 0, stdout: 'LoadState=loaded\nActiveState=active\n' } : argv[1] === 'show' ? { ok: true, code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\n' } : null
const runner = (unit: string, calls: string[][] = [], overrides: (argv: string[]) => { ok: boolean; code: number; stdout: string } | null = () => null) => async (argv: string[]) => {
  calls.push(argv)
  return overrides(argv) ?? active(unit)(argv) ?? (argv[1] === 'fetch' ? { ok: true, code: 0, stdout: 'text:\nSubject: x\n\nbody\n\f\n' } : { ok: true, code: 0, stdout: '' })
}

describe('single message training', () => {
  it('reads the message by uid and teaches the running filter', async () => {
    const calls: string[][] = []
    expect(await learnMessage(runner('rspamd.service', calls), { address: 'info@alice.test', folder: 'Junk', uid: 7, direction: 'spam' })).toEqual({ learned: true, reason: null })
    expect(calls.find(argv => argv[0] === '/usr/bin/doveadm')).toEqual(mailFetchTextArgv('info@alice.test', 'Junk', 7))
    const learn = calls.find(argv => argv[0] === '/usr/bin/rspamc')!
    expect(learn[1]).toBe('learn_spam')
    expect(isMailMailboxActionCommand(learn)).toBe(true)
  })
  it('trains SpamAssassin as the account that owns the store, never as root', async () => {
    const calls: string[][] = [], owner = { uid: 118, gid: 124, home: '/var/lib/spamass-milter' }
    expect(await learnMessage(runner('spamd.service', calls), { address: 'info@alice.test', folder: 'INBOX', uid: 7, direction: 'ham' }, async () => owner)).toEqual({ learned: true, reason: null })
    const learn = calls.find(argv => argv.includes('/usr/bin/sa-learn'))!
    expect(learn.slice(0, 3)).toEqual(['/usr/bin/setpriv', '--reuid=118', '--regid=124'])
    expect(learn).toContain('HOME=/var/lib/spamass-milter')
    expect(learn.at(-2)).toBe('--ham')
    expect(isMailMailboxActionCommand(learn)).toBe(true)
    expect(isMailMailboxActionCommand(['/usr/bin/sa-learn', '--ham', learn.at(-1)!])).toBe(false)
    expect(isMailMailboxActionCommand(learn.map(value => value === '--reuid=118' ? '--reuid=0' : value))).toBe(false)
  })
  it('learns nothing while no store owner exists on the host', async () => {
    expect(await learnMessage(runner('spamd.service'), { address: 'a@b.test', folder: 'Junk', uid: 1, direction: 'spam' }, async () => null)).toEqual({ learned: false, reason: 'no_store_owner' })
  })
  it('picks the scanner account whose home holds the store', async () => {
    const passwd = 'debian-spamd:x:115:120::/var/lib/spamassassin:/bin/sh\nspamass-milter:x:118:124::/var/lib/spamass-milter:/usr/sbin/nologin\n'
    expect(await readSpamStoreOwner(async () => passwd, async path => path === '/var/lib/spamassassin/.spamassassin/bayes_toks')).toEqual({ uid: 115, gid: 120, home: '/var/lib/spamassassin' })
    expect(await readSpamStoreOwner(async () => passwd, async () => false)).toEqual({ uid: 118, gid: 124, home: '/var/lib/spamass-milter' })
    expect(await readSpamStoreOwner(async () => 'root:x:0:0::/root:/bin/sh\n', async () => false)).toBeNull()
  })
  it('reports why nothing was learned', async () => {
    expect(await learnMessage(runner('none'), { address: 'a@b.test', folder: 'Junk', uid: 1, direction: 'spam' })).toEqual({ learned: false, reason: 'no_spam_filter' })
    const empty = runner('rspamd.service', [], argv => argv[1] === 'fetch' ? { ok: true, code: 0, stdout: '' } : null)
    expect(await learnMessage(empty, { address: 'a@b.test', folder: 'Junk', uid: 1, direction: 'spam' })).toEqual({ learned: false, reason: 'message_unreadable' })
    const failing = runner('rspamd.service', [], argv => argv[0] === '/usr/bin/rspamc' ? { ok: false, code: 1, stdout: '' } : null)
    expect(await learnMessage(failing, { address: 'a@b.test', folder: 'Junk', uid: 1, direction: 'spam' })).toEqual({ learned: false, reason: 'learner_failed' })
  })
  it('parses only the doveadm pager form', () => {
    expect(parseFetchedMessage('text:\nA: b\n\nc\n\f\n')).toBe('A: b\n\nc')
    expect(parseFetchedMessage('hdr:\nA: b\n')).toBeNull()
    expect(parseFetchedMessage('text:\n\f\n')).toBeNull()
  })
})

describe('mailbox action grammar', () => {
  it('refuses a mask, other folders and other sample paths', () => {
    expect(isMailMailboxActionCommand(['/usr/bin/doveadm', 'fetch', '-u', '*', 'text', 'mailbox', 'Junk', 'uid', '1'])).toBe(false)
    expect(isMailMailboxActionCommand(['/usr/bin/doveadm', 'fetch', '-u', 'a@b.test', 'text', 'mailbox', 'Secret', 'uid', '1'])).toBe(false)
    expect(isMailMailboxActionCommand(['/usr/bin/rspamc', 'learn_spam', '/etc/shadow'])).toBe(false)
    expect(() => mailLearnFileArgv('rspamd', 'spam', '/tmp/xpanel-learn-abc/../../etc/shadow')).toThrow()
    expect(isMailReindexCommand(mailIndexAllArgv('a@b.test'))).toBe(true)
    expect(isMailReindexCommand(['/usr/bin/doveadm', 'index', '-A', '*'])).toBe(false)
  })
})

describe('mailbox action route', () => {
  const caller = { principalId: 'p', actor: 'mbx', role: 'user', accountId: 'a' } as never
  const plugins = (value: string) => runner('rspamd.service', [], argv => argv[1] === '-h' ? { ok: true, code: 0, stdout: value + '\n' } : null)
  const ctx = (overrides = {}) => ({ authenticateCaller: async () => caller, assertMailbox: async () => {}, run: plugins('quota fts fts_xapian'), submitJob: async (plan: HostJobPlan) => ({ job: { id: 'j1', kind: plan.kind, status: 'queued' } as never, deduplicated: false }), listJobs: async () => [], ...overrides })
  const call = (path: string, method: string, body: unknown, overrides = {}) => { const req = new Request('http://agent' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return handleMailMailboxActionRoute(req, new URL(req.url), method, ctx(overrides)) }
  it('queues one rebuild and answers a second one with REINDEX_IN_PROGRESS', async () => {
    expect((await call('/host/mail/search-index', 'POST', { address: 'a@b.test' }))!.status).toBe(202)
    await expect(call('/host/mail/search-index', 'POST', { address: 'a@b.test' }, { submitJob: async () => ({ job: {}, deduplicated: true }) })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'REINDEX_IN_PROGRESS' } })
  })
  it('refuses a rebuild without full text search and shows the state truthfully', async () => {
    await expect(call('/host/mail/search-index', 'POST', { address: 'a@b.test' }, { run: plugins('quota') })).rejects.toMatchObject({ detail: { reason: 'fts_not_configured' } })
    expect(await (await call('/host/mail/search-index?address=a@b.test', 'GET', undefined, { run: plugins('quota') }))!.json()).toMatchObject({ fts: 'not_configured', job: null })
  })
  it('stops when the mailbox authority fails', async () => {
    await expect(call('/host/mail/learn-message', 'POST', { address: 'a@b.test', folder: 'Junk', uid: 1, direction: 'spam' }, { assertMailbox: async () => { throw new Error('denied') } })).rejects.toThrow('denied')
  })
  it('validates the learn request', async () => {
    await expect(call('/host/mail/learn-message', 'POST', { address: 'a@b.test', folder: 'Trash', uid: 1, direction: 'spam' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/host/mail/learn-message', 'POST', { address: 'a@b.test', folder: 'Junk', uid: 1, direction: 'spam', extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('names both job steps with the mailbox', () => {
    const plan = buildMailReindexPlan('a@b.test')
    expect(plan.steps.map(step => step.id)).toEqual(['rescan', 'index'])
    for (const step of plan.steps) expect(plan.policy(step.argv)).toBe(true)
  })
})
