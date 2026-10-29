import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { mailfxSpamMilter, readMailForwardingConfiguration, readMailfxRenderInput } from './mailfx-render.ts'
import type { MailfxRun, MailxSnapshot } from './mailfx-render.ts'

const ACCOUNT = '00000000-0000-4000-8000-000000000002'
const snapshot: MailxSnapshot = {
  accounts: [{ id: ACCOUNT, username: 'alice', status: 'active', home: '/home/alice', uid: 1001, gid: 1001, planId: 'p1' }],
  domains: [{ id: 'd1', name: 'shop.example', accountId: ACCOUNT }],
  serviceUsers: [{ id: 'su-1', accountId: ACCOUNT, login: 'info@shop.example', domainId: 'd1', localPart: 'info', services: { email: true } }],
  plans: [{ id: 'p1', featureListId: 'f1' }], featureLists: [{ id: 'f1', disabled: [] }],
}
let root = ''
const put = async (path: string[], value: unknown) => { await mkdir(join(root, ...path.slice(0, -1)), { recursive: true }); await writeFile(join(root, ...path), JSON.stringify(value)) }
const spam = (enabled: boolean) => put(['extended', 'mailx', 'spam.json'], { section: 'spam', policy: { enabled, rejectScore: 15, headerScore: 6, greylistScore: 4, blockedDomains: [] }, updatedAt: '2026-10-28T09:00:00.000Z', updatedBy: 'root' })
/** systemctl show answers per unit; every call is recorded. */
const units = (states: Record<string, 'active' | 'inactive' | 'not-found'>) => {
  const calls: string[] = []
  const run: MailfxRun = async argv => { const unit = argv[argv.length - 1]!; calls.push(unit); const state = states[unit] ?? 'not-found'
    return { ok: true, code: 0, stdout: `LoadState=${state === 'not-found' ? 'not-found' : 'loaded'}\nActiveState=${state === 'active' ? 'active' : 'inactive'}\n` } }
  return { run, calls }
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mailfx-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('spam filter milter decision', () => {
  it('asks systemd nothing while no spam policy is enabled', async () => {
    const host = units({ 'rspamd.service': 'active' })
    expect(await mailfxSpamMilter(root, 'debian', host.run)).toBeNull()
    await spam(false)
    expect(await mailfxSpamMilter(root, 'debian', host.run)).toBeNull()
    expect(host.calls).toEqual([])
  })
  it('prefers a running rspamd, then running SpamAssassin through spamass-milter, then an installed rspamd', async () => {
    await spam(true)
    expect(await mailfxSpamMilter(root, 'debian', units({ 'rspamd.service': 'active', 'spamd.service': 'active' }).run)).toBe('inet:localhost:11332')
    expect(await mailfxSpamMilter(root, 'debian', units({ 'rspamd.service': 'inactive', 'spamd.service': 'active', 'spamass-milter.service': 'inactive' }).run)).toBe('local:spamass/spamass.sock')
    expect(await mailfxSpamMilter(root, 'rhel', units({ 'spamassassin.service': 'active', 'spamass-milter.service': 'active' }).run)).toBe('unix:/run/spamass-milter/postfix/sock')
    expect(await mailfxSpamMilter(root, 'debian', units({ 'rspamd.service': 'inactive', 'spamd.service': 'active' }).run)).toBeNull()
    expect(await mailfxSpamMilter(root, 'debian', units({ 'rspamd.service': 'inactive' }).run)).toBe('inet:localhost:11332')
    expect(await mailfxSpamMilter(root, 'debian', units({}).run)).toBeNull()
    expect(await mailfxSpamMilter(root, 'debian', async () => ({ ok: false, code: 1, stdout: '' }))).toBeNull()
  })
  it('leaves the milter off for a saved policy that needs review instead of failing the reconcile', async () => {
    await put(['extended', 'mailx', 'spam.json'], { section: 'spam', policy: { enabled: true }, updatedAt: 'x', updatedBy: 'root' })
    expect(await mailfxSpamMilter(root, 'debian', units({ 'rspamd.service': 'active' }).run)).toBeNull()
  })
})

describe('reconciler mail inputs', () => {
  const pref = (mailbox: string, extra: Record<string, unknown> = {}) => ({ inherit: false, enabled: true, addHeaderScore: 6, spamBoxEnabled: true, allowlist: [], blocklist: ['bad@spam.example'],
    mailbox, ownerAuthority: { accountId: ACCOUNT, serviceUserId: 'su-1', mailbox }, updatedAt: '2026-10-28T09:00:00.000Z', ...extra })
  it('renders Sieve inputs only for admitted mailboxes with a Sieve effect', async () => {
    await put(['extended', 'webmail', 'spam-preferences', encodeURIComponent('info@shop.example') + '.json'], pref('info@shop.example'))
    await put(['extended', 'webmail', 'spam-preferences', encodeURIComponent('ghost@shop.example') + '.json'], pref('ghost@shop.example'))
    const input = await readMailfxRenderInput(root, snapshot, 'debian', units({}).run)
    expect(input).toEqual({ spamMilter: null, sieve: [{ address: 'info@shop.example', account: { username: 'alice', uid: 1001, gid: 1001, home: '/home/alice' }, blockedSenders: ['bad@spam.example'], spamToJunk: true }] })
    await put(['extended', 'webmail', 'spam-preferences', encodeURIComponent('info@shop.example') + '.json'], pref('info@shop.example', { inherit: true, blocklist: [] }))
    expect((await readMailfxRenderInput(root, snapshot, 'debian', units({}).run)).sieve).toEqual([])
  })
  it('adds admitted lists to the forwarding configuration and keeps refused ones out', async () => {
    await put(['extended', 'mail', 'forwarders.json'], [{ id: 'f1', accountId: ACCOUNT, sourceAddress: 'sales@shop.example', destinations: ['team@shop.example'], createdAt: '2026-10-28T09:00:00.000Z' }])
    const list = (n: number, extra: Record<string, unknown> = {}) => ({ id: `00000000-0000-4000-8000-00000000010${n}`, accountId: ACCOUNT, name: 'l', domain: 'shop.example', address: `l${n}@shop.example`,
      members: ['Info@shop.example', 'x@remote.example'], moderation: 'open', archiveEnabled: true, createdAt: '2026-10-28T09:00:00.000Z', selfSubscription: 'closed', ...extra })
    await put(['extended', 'mail', 'mailing-lists.json'], [list(1), list(2, { address: 'team@shop.example', members: ['sales@shop.example'] }), list(3, { moderation: 'moderated' })])
    const forwarding = await readMailForwardingConfiguration(root, snapshot)
    expect(forwarding.lists).toEqual([{ accountId: ACCOUNT, address: 'l1@shop.example', members: ['info@shop.example', 'x@remote.example'] }])
    await put(['extended', 'mail', 'mailing-lists.json'], { lists: [] })
    const error = await readMailForwardingConfiguration(root, snapshot).then(() => null, (caught: unknown) => caught)
    expect(isXpanelError(error) && error.code).toBe('PRECONDITION_FAILED')
  })
})

describe('server routing and submission certificate input', () => {
  const at = { updatedAt: '2026-10-28T09:00:00.000Z', updatedBy: 'root' }
  const certs = { ...snapshot, certificates: [{ id: 'live', source: 'acme', notAfter: '2027-01-01T00:00:00.000Z' }, { id: 'old', source: 'acme', notAfter: '2026-01-01T00:00:00.000Z' }] }
  const server = (submission: string | null) => put(['extended', 'mailx', 'server.json'], { section: 'server', policy: { postfix: {}, dovecot: {}, rbl: null, certificates: { smtp: null, submission, imap: null } }, ...at })
  const now = new Date('2026-10-28T10:00:00.000Z')
  it('passes routed domains and an unexpired chosen certificate to the reconciler, and nothing when unsaved', async () => {
    expect(await readMailfxRenderInput(root, certs, 'debian', null, now)).toEqual({ spamMilter: null, sieve: [] })
    await put(['extended', 'mailx', 'routing.json'], { section: 'routing', policy: { domains: [{ domain: 'shop.example', mode: 'remote' }] }, ...at })
    await server('live')
    const input = await readMailfxRenderInput(root, certs, 'debian', null, now)
    expect([...input.routing!]).toEqual([['shop.example', 'remote']])
    expect(input.submissionTls).toEqual({ certFile: '/etc/xpanel/ssl/live/fullchain.pem', keyFile: '/etc/xpanel/ssl/live/privkey.pem' })
    await server('old')
    expect((await readMailfxRenderInput(root, certs, 'debian', null, now)).submissionTls).toBeUndefined()
  })
  it('never fails a reconcile on a saved routing file that needs review', async () => {
    await put(['extended', 'mailx', 'routing.json'], { section: 'routing', policy: { domains: [{ domain: 'shop.example', mode: 'local' }] }, ...at })
    expect((await readMailfxRenderInput(root, snapshot, 'debian', null, now)).routing).toBeUndefined()
  })
})
