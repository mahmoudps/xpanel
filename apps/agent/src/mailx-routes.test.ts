import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { MAILX_DEFAULTS, mailxCompositeRevision } from './mailx-policy.ts'
import { handleMailxRoute, readMailxSaved } from './mailx-routes.ts'
import type { MailxCommandResult, MailxHostFiles, MailxRouteContext } from './mailx-routes.ts'
import { parseMailxEngineShow } from './mailfx-render.ts'
import type { MailxSnapshot } from './mailfx-render.ts'

const ACCOUNT = '00000000-0000-4000-8000-000000000002'
const ok = (stdout = ''): MailxCommandResult => ({ ok: true, code: 0, stdout, stderr: '' })
const failed: MailxCommandResult = { ok: false, code: 1, stdout: '', stderr: 'x' }
const snapshot: MailxSnapshot = { accounts: [{ id: ACCOUNT, username: 'alice', status: 'active', home: '/home/alice', uid: 1001, gid: 1001, planId: 'p1' }], domains: [{ id: 'd1', name: 'shop.example', accountId: ACCOUNT }],
  serviceUsers: [{ id: 'su-1', accountId: ACCOUNT, login: 'archive@shop.example', domainId: 'd1', localPart: 'archive', services: { email: true } }],
  plans: [{ id: 'p1', featureListId: 'f1' }], featureLists: [{ id: 'f1', disabled: [] }] }
let root = ''
const save = async (name: string, value: unknown) => { const path = join(root, 'extended', 'mailx', name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)) }

/** A host whose main.cf is a map; postconf -e/-X edit it, and `failCheckAfterEdit` makes postfix check fail once a parameter changes. */
function host(options: { failCheckAfterEdit?: boolean; engine?: 'rspamd' | null; unmanaged?: string; milters?: string } = {}) {
  const main = new Map<string, string>([['myhostname', 'mail.example'], ['relayhost', '[old.example]:25']]), disk = new Map<string, string>()
  if (options.milters) for (const key of ['smtpd_milters', 'non_smtpd_milters']) main.set(key, options.milters)
  if (options.unmanaged) disk.set(options.unmanaged, 'admin rules\n')
  let edited = false
  const calls: string[][] = []
  const run = vi.fn(async (argv: string[]): Promise<MailxCommandResult> => {
    calls.push(argv)
    const command = argv.join(' ')
    if (command === '/usr/sbin/postconf -n') return ok([...main].map(([key, value]) => value ? `${key} = ${value}` : `${key} =`).join('\n') + '\n')
    if (argv[1] === '-e') { for (const pair of argv.slice(2)) main.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)); edited = true; return ok() }
    if (argv[1] === '-X') { for (const key of argv.slice(2)) main.delete(key); return ok() }
    if (command === '/usr/sbin/postfix check') return options.failCheckAfterEdit && edited && main.get('relayhost') !== '[old.example]:25' ? failed : ok()
    if (command === '/usr/sbin/postfix reload' || argv[1] === 'reload' || command === '/usr/bin/rspamadm configtest') return ok()
    if (argv[1] === 'show') return ok(argv[5] === 'rspamd.service' && options.engine === 'rspamd' ? 'LoadState=loaded\nActiveState=active\n' : 'LoadState=not-found\nActiveState=inactive\n')
    return failed
  })
  const files: MailxHostFiles = { read: async path => disk.get(path) ?? null, write: async file => { disk.set(file.path, file.content) }, remove: async path => { disk.delete(path) }, ensureMapDir: async () => {} }
  return { run, files, main, disk, calls }
}
const context = (h: ReturnType<typeof host>, extra: Partial<MailxRouteContext> = {}): MailxRouteContext => ({
  assertRoot: async () => ({ actor: 'root' }), assertAccount: async () => ({ actor: 'alice', accountId: ACCOUNT }), stateRoot: root,
  run: h.run, files: h.files, readSnapshot: async () => snapshot, submitJob: null, now: () => new Date('2026-10-28T10:00:00.000Z'), ...extra })
const call = async (path: string, ctx: MailxRouteContext, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; json(): Promise<any> } | null> =>
  handleMailxRoute(new Request('http://agent' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), new URL('http://agent' + path), method, ctx)
const relay = { section: 'relay', policy: { enabled: true, host: 'smtp.relay.example', port: 587, username: 'u' }, secret: { password: 'S3cret', version: '00000000-0000-4000-8000-000000000001' }, updatedAt: '2026-10-28T09:00:00.000Z', updatedBy: 'root' }
const revision = async () => mailxCompositeRevision(await readMailxSaved(root))
const rejects = async (promise: Promise<unknown>, code: string, detail: Record<string, unknown> = {}) => {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(isXpanelError(error) && error.code).toBe(code)
  if (isXpanelError(error)) expect(error.detail).toMatchObject(detail)
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mailx-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('mail policy agent routes', () => {
  it('parses systemctl show strictly', () => {
    expect(parseMailxEngineShow('LoadState=loaded\nActiveState=active\n')).toBe('active')
    expect(parseMailxEngineShow('LoadState=not-found\nActiveState=inactive\n')).toBe('not-installed')
    for (const text of [null, 'LoadState=loaded\n', 'garbage', 'LoadState=loaded\nActiveState=active\nExtra=1\n']) expect(parseMailxEngineShow(text)).toBe('unknown')
  })
  it('applies the saved relay, reads it back and never leaks the password in the response', async () => {
    await save('relay.json', relay)
    const h = host(), response = await call('/host/mailx/apply', context(h), { revision: await revision() })
    const body = await response!.json()
    expect(body).toMatchObject({ outcome: 'applied', verificationRequired: false, reloads: ['postfix'] })
    expect(h.main.get('relayhost')).toBe('[smtp.relay.example]:587')
    expect(JSON.stringify(body)).not.toContain('S3cret')
    expect([...h.disk.values()].some(text => text.includes('u:S3cret'))).toBe(true)
    const state = await (await call('/host/mailx/state', context(h)))!.json()
    expect(state.sections).toMatchObject({ relay: 'applied', bcc: 'not-saved', spam: 'not-saved' })
  })
  it('rolls back parameters and files when postfix check fails after the change', async () => {
    await save('relay.json', relay)
    const h = host({ failCheckAfterEdit: true })
    const body = await (await call('/host/mailx/apply', context(h), { revision: await revision() }))!.json()
    expect(body.outcome).toBe('rolled-back')
    expect(h.main.get('relayhost')).toBe('[old.example]:25')
    expect(h.main.has('smtp_sasl_auth_enable')).toBe(false)
    expect(h.disk.size).toBe(0)
  })
  it('refuses stale revisions, unmanaged files, foreign selectors and missing executors without changing anything', async () => {
    await save('relay.json', relay)
    const h = host({ unmanaged: '/etc/postfix/xpanel/mailx/relay_sasl' })
    await rejects(call('/host/mailx/apply', context(h), { revision: '0'.repeat(64) }), 'CONFLICT', { stateChanged: false })
    await rejects(call('/host/mailx/apply', context(h), { revision: await revision() }), 'CONFLICT', { reason: 'unmanaged_file' })
    await rejects(call('/host/mailx/apply', context(h), { revision: await revision(), extra: 1 }), 'VALIDATION')
    await rejects(call('/host/mailx/state?x=1', context(h)), 'VALIDATION')
    await rejects(call('/host/mailx/state', context(h, { run: null })), 'PRECONDITION_FAILED')
    expect(h.calls.some(argv => argv[1] === '-e')).toBe(false)
    await save('bcc.json', { section: 'bcc', policy: { alwaysBcc: 'bad', recipient: [], sender: [] }, updatedAt: '2026-10-28T09:00:00.000Z', updatedBy: 'root' })
    await rejects(call('/host/mailx/state', context(h)), 'PRECONDITION_FAILED', { reason: 'saved_policy_review' })
  })
  it('re-checks authority before mutating and keeps root routes root-only', async () => {
    await save('relay.json', relay)
    const h = host(), roots = vi.fn().mockResolvedValueOnce({ actor: 'root' }).mockResolvedValueOnce({ actor: 'other' })
    await rejects(call('/host/mailx/apply', context(h, { assertRoot: roots }), { revision: await revision() }), 'FORBIDDEN')
    expect(h.calls.some(argv => argv[1] === '-e')).toBe(false)
  })
  it('applies rspamd thresholds, reports Postfix wiring and archive admission for the owner', async () => {
    await save('spam.json', { section: 'spam', policy: MAILX_DEFAULTS.spam, updatedAt: '2026-10-28T09:00:00.000Z', updatedBy: 'root' })
    await save(`archive/${ACCOUNT}.json`, { accountId: ACCOUNT, policy: { domains: [{ domain: 'shop.example', mailbox: 'archive@shop.example', incoming: true, outgoing: false, retentionDays: 30 }] }, updatedAt: '2026-10-28T09:00:00.000Z', updatedBy: 'alice' })
    const h = host({ engine: 'rspamd' })
    const body = await (await call('/host/mailx/accounts/alice/apply', context(h), { revision: await revision() }))!.json()
    expect(body).toMatchObject({ outcome: 'applied', spam: 'applied', reloads: ['postfix', 'rspamd'], reconcile: 'unavailable' })
    expect(h.disk.get('/etc/postfix/xpanel/mailx/recipient_bcc')).toContain('@shop.example archive@shop.example')
    const state = await (await call('/host/mailx/state', context(h)))!.json()
    expect(state.engine).toMatchObject({ engine: 'rspamd', wiring: 'not-wired' })
    // Wired only when both milter lists carry the rendered rspamd proxy address, not a look-alike.
    const wired = host({ engine: 'rspamd', milters: 'local:opendkim/opendkim.sock, inet:localhost:11332' })
    expect((await (await call('/host/mailx/state', context(wired)))!.json()).engine.wiring).toBe('wired')
    const lookalike = host({ engine: 'rspamd', milters: 'inet:localhost:113320' })
    expect((await (await call('/host/mailx/state', context(lookalike)))!.json()).engine.wiring).toBe('not-wired')
    const own = await (await call('/host/mailx/accounts/alice/archive', context(h)))!.json()
    expect(own).toMatchObject({ state: 'applied', domains: [{ domain: 'shop.example', admission: 'eligible', conflicts: [] }] })
  })
  it('submits archive retention as one reviewed host job and refuses unlimited retention', async () => {
    await save(`archive/${ACCOUNT}.json`, { accountId: ACCOUNT, policy: { domains: [{ domain: 'shop.example', mailbox: 'archive@shop.example', incoming: true, outgoing: true, retentionDays: 30 }] }, updatedAt: '2026-10-28T09:00:00.000Z', updatedBy: 'alice' })
    const h = host(), submitJob = vi.fn(async (plan: { steps: readonly { argv: readonly string[] }[]; policy: (argv: readonly string[]) => boolean }) => {
      expect(plan.steps.map(step => step.argv)).toEqual([['/usr/bin/doveadm', 'expunge', '-u', 'archive@shop.example', 'mailbox', 'INBOX', 'savedbefore', '30d']])
      expect(plan.policy(plan.steps[0]!.argv)).toBe(true)
      return { id: 'job-1', kind: 'mail.archive.retention', status: 'queued' }
    })
    const response = await call('/host/mailx/accounts/alice/retention', context(h, { submitJob: submitJob as never }), { revision: await revision(), domain: 'shop.example' })
    expect(response!.status).toBe(202)
    await rejects(call('/host/mailx/accounts/alice/retention', context(h, { submitJob: submitJob as never }), { revision: await revision(), domain: 'other.example' }), 'NOT_FOUND')
  })
  it('renders mailbox preferences as rspamd settings and a reconciled Sieve script, reports their effect and refuses foreign bindings', async () => {
    const pref = (mailbox: string, extra: Record<string, unknown> = {}) => ({ inherit: false, enabled: true, addHeaderScore: 7, spamBoxEnabled: true, allowlist: ['friend@partner.example'], blocklist: ['bad@spam.example'],
      mailbox, ownerAuthority: { accountId: ACCOUNT, serviceUserId: 'su-1', mailbox }, updatedAt: '2026-10-28T09:00:00.000Z', ...extra })
    const dir = join(root, 'extended', 'webmail', 'spam-preferences')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, encodeURIComponent('archive@shop.example') + '.json'), JSON.stringify(pref('archive@shop.example')))
    await writeFile(join(dir, encodeURIComponent('other@shop.example') + '.json'), JSON.stringify(pref('other@shop.example')))
    const h = host({ engine: 'rspamd' }), sieve = '/etc/dovecot/xpanel/sieve/shop.example/archive.sieve'
    let before = await (await call('/host/mailx/accounts/alice/mailboxes', context(h)))!.json()
    expect(before.mailboxes[0].native).toBe('pending')
    // The reconciler renders the Sieve script; this double writes what the render produces for the saved row.
    const { services } = await import('@xpanel/render')
    const reconcile = vi.fn(async () => { h.disk.set(sieve, services.renderMailboxPolicySieveScript({ blockedSenders: ['bad@spam.example'], spamToJunk: true })!); return { status: 'applied' as const } })
    const body = await (await call('/host/mailx/accounts/alice/apply', context(h, { reconcile }), { revision: await revision() }))!.json()
    expect(body).toMatchObject({ outcome: 'applied', mailboxes: 'applied', reloads: ['postfix', 'rspamd'], reconcile: 'applied' })
    expect(reconcile).toHaveBeenCalledWith('alice')
    expect(h.disk.get(sieve)).toContain('"bad@spam.example"')
    const settings = h.disk.get('/etc/rspamd/local.d/settings.conf')!
    expect(settings).toContain(['  rcpt = "archive@shop.example";', '  from = ["friend@partner.example"];', '  want_spam = yes;'].join(String.fromCharCode(10)))
    expect(settings).toContain('apply { actions { add_header = 7.0; } }')
    expect(settings).not.toContain('other@shop.example')
    const state = await (await call('/host/mailx/accounts/alice/mailboxes', context(h)))!.json()
    expect(state.mailboxes).toEqual([{ mailbox: 'archive@shop.example', preference: 'saved', native: 'applied', effects: { allowlist: true, filtering: false, score: true, blocklist: true, spamBox: true } }])
    h.disk.set(sieve, 'stale')
    before = await (await call('/host/mailx/accounts/alice/mailboxes', context(h)))!.json()
    expect(before.mailboxes[0].native).toBe('pending')
  })
  it('reports an unknown reconcile as an unknown outcome and a refused one as failed', async () => {
    await save('relay.json', relay)
    const thrown = await (await call('/host/mailx/apply', context(host(), { reconcile: async () => { throw new Error('lost') } }), { revision: await revision() }))!.json()
    expect(thrown).toMatchObject({ outcome: 'unknown', verificationRequired: true, reconcile: 'unknown' })
    const refused = await (await call('/host/mailx/apply', context(host(), { reconcile: async () => ({ status: 'failed' as const }) }), { revision: await revision() }))!.json()
    expect(refused).toMatchObject({ outcome: 'applied', verificationRequired: false, reconcile: 'failed' })
  })
  it('reports each owned list with its delivery state, delivering only when the live alias table holds its line', async () => {
    const lists = async (rows: Record<string, unknown>[]) => { await mkdir(join(root, 'extended', 'mail'), { recursive: true }); await writeFile(join(root, 'extended', 'mail', 'mailing-lists.json'), JSON.stringify(rows)) }
    const list = (n: number, extra: Record<string, unknown> = {}) => ({ id: `00000000-0000-4000-8000-00000000010${n}`, accountId: ACCOUNT, name: 'l', domain: 'shop.example', address: `l${n}@shop.example`,
      members: ['a@remote.example'], moderation: 'open', archiveEnabled: false, createdAt: '2026-10-28T09:00:00.000Z', ...extra })
    await lists([list(1), list(2, { moderation: 'members' }), list(3, { members: [] }), list(4, { address: 'archive@shop.example' }), list(5, { members: ['not an address'] }),
      list(6, { accountId: '00000000-0000-4000-8000-000000000009' }), list(7)])
    const h = host()
    h.disk.set('/etc/postfix/xpanel/virtual_aliases', '# managed by xPanel: forwarders and default addresses\nl1@shop.example\ta@remote.example\n')
    const body = await (await call('/host/mailx/accounts/alice/lists', context(h)))!.json()
    expect(body).toEqual({ observedAt: '2026-10-28T10:00:00.000Z', aliases: 'read', lists: [
      { address: 'l1@shop.example', members: 1, state: 'delivering' }, { address: 'l2@shop.example', members: 1, state: 'restricted' }, { address: 'l3@shop.example', members: 0, state: 'empty' },
      { address: 'archive@shop.example', members: 1, state: 'conflict' }, { address: 'l5@shop.example', members: 1, state: 'review' }, { address: 'l7@shop.example', members: 1, state: 'pending' }] })
    const off = await (await call('/host/mailx/accounts/alice/lists', context(h, { readSnapshot: async () => ({ ...snapshot, featureLists: [{ id: 'f1', disabled: ['Mailing Lists'] }] }) })))!.json()
    expect(off.lists.map((row: { state: string }) => row.state)).toEqual(['disabled', 'disabled', 'disabled', 'disabled', 'disabled', 'disabled'])
    await lists([{ ...list(1), unexpected: true }])
    await rejects(call('/host/mailx/accounts/alice/lists', context(h)), 'PRECONDITION_FAILED')
  })
  it('submits per-mailbox training through the detected filter as one reviewed job', async () => {
    const h = host({ engine: 'rspamd' })
    const submitJob = vi.fn(async (plan: { steps: readonly { argv: readonly string[] }[]; policy: (argv: readonly string[]) => boolean }) => {
      expect(plan.steps[0]!.argv).toEqual(['/usr/bin/rspamc', 'learn_spam', '/home/alice/mail/shop.example/archive/.Junk/cur'])
      expect(plan.policy(plan.steps[0]!.argv)).toBe(true)
      return { id: 'job-2', kind: 'mail.spam.learn', status: 'queued' }
    })
    expect((await call('/host/mailx/accounts/alice/learn', context(h, { submitJob: submitJob as never }), { mailbox: 'archive@shop.example', direction: 'spam' }))!.status).toBe(202)
    await rejects(call('/host/mailx/accounts/alice/learn', context(h, { submitJob: submitJob as never }), { mailbox: 'nobody@shop.example', direction: 'spam' }), 'NOT_FOUND')
    await rejects(call('/host/mailx/accounts/alice/learn', context(h, { submitJob: submitJob as never }), { mailbox: 'archive@shop.example', direction: 'forget' }), 'VALIDATION')
    await rejects(call('/host/mailx/accounts/alice/learn', context(host(), { submitJob: submitJob as never }), { mailbox: 'archive@shop.example', direction: 'ham' }), 'PRECONDITION_FAILED', { reason: 'no_spam_filter' })
    expect(submitJob).toHaveBeenCalledTimes(1)
  })
})
