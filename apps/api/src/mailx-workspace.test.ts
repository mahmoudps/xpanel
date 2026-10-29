import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail, isXpanelError } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { MAILX_DEFAULTS, mailxRevision } from '../../agent/src/mailx-policy.ts'
import { createMailxWorkspaceRoutes, projectMailxHostStatus, type MailxWorkspaceHelpers } from './mailx-workspace.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const status = { observedAt: '2026-10-28T10:00:00.000Z', revision: 'a'.repeat(64), postfix: 'read',
  engine: { engine: 'rspamd', unit: 'rspamd.service', spamAssassinDir: null, wiring: 'not-wired', units: { 'rspamd.service': 'active', 'spamassassin.service': 'not-installed', 'spamd.service': 'not-installed' } },
  sections: { spam: 'applied', relay: 'applied', bcc: 'not-saved', marketing: 'not-saved' }, archive: { accounts: 0, state: 'not-saved', conflicts: [] } }

async function fixture(options: { host?: boolean; lists?: unknown; reconcile?: string } = {}) {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Archive', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Archive', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 5, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.41', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null, contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.41', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const own = await account('archown'), other = await account('archother')
  for (const [owner, login] of [[own, 'archive@archown.example.test'], [other, 'secret@archother.example.test']] as const)
    await state.store.createServiceUser({ accountId: owner.id, login, passwordHash: HASH, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const caller = (kind: 'root' | 'user', who = own): AuthenticatedCaller => ({ principal: kind === 'root' ? { id: 'root-id', kind: 'root', username: 'root' } : { id: 'user-' + who.id, kind: 'user', username: who.username, accountId: who.id },
    principalRecord: {}, sessionId: 's1', sessionToken: null, apiTokenId: null, scopes: [], csrfValid: true, mfaVerified: true } as unknown as AuthenticatedCaller)
  let current = caller('root')
  const audits: unknown[] = []
  const callHost = vi.fn(async (_caller: AuthenticatedCaller, path: string, body?: unknown) => {
    if (path === '/host/mailx/state') return status
    if (path.endsWith('/archive')) return { observedAt: status.observedAt, revision: 'a'.repeat(64), postfix: 'read', state: 'applied', jobsAvailable: true, domains: [{ domain: 'archown.example.test', admission: 'eligible', conflicts: [] }] }
    if (path.endsWith('/retention')) return { job: { id: 'job-1', kind: 'mail.archive.retention', status: 'queued' } }
    if (path.endsWith('/mailboxes')) return { observedAt: status.observedAt, engine: { engine: 'rspamd', wiring: 'wired' }, jobsAvailable: true,
      mailboxes: [{ mailbox: 'archive@archown.example.test', preference: 'saved', native: 'pending', effects: { allowlist: true, filtering: false, score: false, blocklist: true, spamBox: false } }] }
    if (path.endsWith('/lists')) return options.lists ?? { observedAt: status.observedAt, aliases: 'read', lists: [{ address: 'team@archown.example.test', members: 2, state: 'delivering' }, { address: 'mods@archown.example.test', members: 1, state: 'restricted' }] }
    if (path.endsWith('/learn')) return { job: { id: 'job-3', kind: 'mail.spam.learn', status: 'queued' } }
    expect(body).toMatchObject({ revision: expect.stringMatching(/^[0-9a-f]{64}$/) })
    return { outcome: 'applied', revision: (body as { revision: string }).revision, verificationRequired: false, spam: 'not-saved', mailboxes: 'not-saved', reloads: ['postfix'], reconcile: options.reconcile ?? 'applied' }
  })
  const helpers: MailxWorkspaceHelpers = { store: state.store, requireCaller: async () => current,
    assertRoot: async who => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
    assertCanAccessAccount: async (who, target) => { if (who.principal.kind !== 'root' && (who.principal as { accountId?: string }).accountId !== target.id) fail('FORBIDDEN', 'denied') },
    emitAudit: async entry => { audits.push(entry) }, ...(options.host === false ? {} : { callHost }), now: () => new Date('2026-10-28T10:00:00.000Z') }
  const routes = createMailxWorkspaceRoutes(helpers)
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const request = new Request('http://localhost' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    try { const response = await routes(request, new URL(request.url), method); return { status: response!.status, body: response!.status === 405 ? null : await response!.json() } }
    catch (error) { if (isXpanelError(error)) return { status: 0, code: error.code, detail: error.detail, body: null }; throw error }
  }
  return { state, own, other, call, audits, callHost, as: (who: AuthenticatedCaller) => { current = who }, caller, reply: options }
}

describe('server mail policy workspace', () => {
  it('projects the host status strictly', () => {
    expect(projectMailxHostStatus(status).engine.wiring).toBe('not-wired')
    for (const bad of [{ ...status, sections: { ...status.sections, relay: 'ok' } }, { ...status, engine: { ...status.engine, engine: 'amavis' } }, { ...status, revision: 'x' }, { ...status, observedAt: 'now' }])
      expect(() => projectMailxHostStatus(bad)).toThrow()
  })
  it('saves the relay with CAS, keeps the password out of every view and applies through the agent', async () => {
    const f = await fixture()
    const first = await f.call('/api/server/mailx/relay')
    expect(first.body).toMatchObject({ section: 'relay', saved: false, state: 'not-saved', host: 'connected', policy: { ...MAILX_DEFAULTS.relay, passwordSet: false } })
    const policy = { enabled: true, host: 'smtp.relay.example', port: 587, username: 'relayuser' }
    expect((await f.call('/api/server/mailx/relay', 'PUT', { policy, expectedRevision: first.body.revision, password: null })).detail).toMatchObject({ field: 'password' })
    const saved = await f.call('/api/server/mailx/relay', 'PUT', { policy, expectedRevision: first.body.revision, password: 'S3cret!' })
    expect(saved.body).toMatchObject({ stateChanged: true, saved: true, policy: { ...policy, passwordSet: true }, application: { outcome: 'applied', verificationRequired: false } })
    expect(JSON.stringify(saved.body)).not.toContain('S3cret')
    const path = join(f.state.rootDir, 'extended', 'mailx', 'relay.json')
    expect(JSON.parse(await readFile(path, 'utf8')).secret.password).toBe('S3cret!')
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(f.audits)).not.toContain('S3cret')
    expect((await f.call('/api/server/mailx/relay', 'PUT', { policy, expectedRevision: first.body.revision, password: null })).code).toBe('CONFLICT')
    const kept = await f.call('/api/server/mailx/relay', 'PUT', { policy: { ...policy, port: 2525 }, expectedRevision: saved.body.revision, password: null })
    expect(JSON.parse(await readFile(path, 'utf8')).secret.password).toBe('S3cret!')
    expect(kept.body.revision).not.toBe(saved.body.revision)
  })
  it('rejects non-root callers, selectors, unknown fields and invalid policies before any write', async () => {
    const f = await fixture()
    const revision = mailxRevision('bcc', null)
    f.as(f.caller('user'))
    expect((await f.call('/api/server/mailx/bcc')).code).toBe('FORBIDDEN')
    f.as(f.caller('root'))
    expect((await f.call('/api/server/mailx/bcc?x=1')).code).toBe('VALIDATION')
    expect((await f.call('/api/server/mailx/bcc', 'PUT', { policy: MAILX_DEFAULTS.bcc, expectedRevision: revision, extra: 1 })).code).toBe('VALIDATION')
    expect((await f.call('/api/server/mailx/bcc', 'PUT', { policy: { ...MAILX_DEFAULTS.bcc, alwaysBcc: 'not an address' }, expectedRevision: revision })).detail).toMatchObject({ field: 'alwaysBcc' })
    expect((await f.call('/api/server/mailx/spam', 'POST', {})).status).toBe(405)
    expect(f.callHost.mock.calls.some(([, path]) => path === '/host/mailx/apply')).toBe(false)
  })
  it('reports a saved policy as pending when no host agent is connected', async () => {
    const f = await fixture({ host: false })
    const saved = await f.call('/api/server/mailx/marketing', 'PUT', { policy: { ...MAILX_DEFAULTS.marketing, messageRateLimit: 200 }, expectedRevision: mailxRevision('marketing', null) })
    expect(saved.body).toMatchObject({ saved: true, host: 'not-connected', state: 'unavailable', application: { outcome: 'not-connected' } })
  })
})

describe('account email archive workspace', () => {
  it('lets the owner archive only their own domains into their own mailboxes and runs retention as a job', async () => {
    const f = await fixture()
    f.as(f.caller('user'))
    const first = await f.call('/api/account/mailx/archive')
    expect(first.body.choices).toEqual([{ domain: 'archown.example.test', mailboxes: ['archive@archown.example.test'] }])
    const row = { domain: 'archown.example.test', mailbox: 'archive@archown.example.test', incoming: true, outgoing: true, retentionDays: 90 }
    expect((await f.call('/api/account/mailx/archive', 'PUT', { policy: { domains: [{ ...row, domain: 'archother.example.test', mailbox: 'secret@archother.example.test' }] }, expectedRevision: first.body.revision })).detail).toMatchObject({ field: 'domains' })
    const saved = await f.call('/api/account/mailx/archive', 'PUT', { policy: { domains: [row] }, expectedRevision: first.body.revision })
    expect(saved.body).toMatchObject({ stateChanged: true, state: 'applied', rows: [{ domain: row.domain, admission: 'eligible' }], application: { outcome: 'applied' } })
    expect(f.callHost.mock.calls.some(([, path]) => path === '/host/mailx/accounts/archown/apply')).toBe(true)
    const job = await f.call('/api/account/mailx/archive/retention', 'POST', { domain: row.domain, expectedRevision: saved.body.revision })
    expect(job).toMatchObject({ status: 202, body: { job: { id: 'job-1' } } })
    expect((await f.call('/api/account/mailx/archive/retention', 'POST', { domain: 'archother.example.test', expectedRevision: saved.body.revision })).code).toBe('NOT_FOUND')
    f.as(f.caller('root'))
    expect((await f.call('/api/account/mailx/archive')).code).toBe('FORBIDDEN')
  })
})

describe('account mail tools workspace', () => {
  it('shows native mailbox effects and unavailable capabilities, and trains only owned mailboxes', async () => {
    const f = await fixture()
    f.as(f.caller('user'))
    const view = await f.call('/api/account/mailx/mail-tools')
    expect(view.body).toMatchObject({ host: 'connected', engine: { engine: 'rspamd' }, capabilities: { learning: true, boxTrapper: false },
      mailboxes: [{ mailbox: 'archive@archown.example.test', native: 'pending', effects: { blocklist: true } }] })
    const learn = await f.call('/api/account/mailx/mail-tools/learn', 'POST', { mailbox: 'archive@archown.example.test', direction: 'ham', expectedRevision: view.body.compositeRevision })
    expect(learn).toMatchObject({ status: 202, body: { job: { id: 'job-3' } } })
    expect((await f.call('/api/account/mailx/mail-tools/learn', 'POST', { mailbox: 'secret@archother.example.test', direction: 'ham', expectedRevision: view.body.compositeRevision })).code).toBe('NOT_FOUND')
    expect((await f.call('/api/account/mailx/mail-tools/learn', 'POST', { mailbox: 'archive@archown.example.test', direction: 'forget', expectedRevision: view.body.compositeRevision })).code).toBe('VALIDATION')
    expect((await f.call('/api/account/mailx/mail-tools/apply', 'POST', { expectedRevision: view.body.compositeRevision })).body).toMatchObject({ application: { outcome: 'applied', mailboxes: 'not-saved', reconcile: 'applied' } })
    f.as(f.caller('root'))
    expect((await f.call('/api/account/mailx/mail-tools')).code).toBe('FORBIDDEN')
  })
  it('shows list delivery from the host only, applies through a generation and keeps moderation unavailable', async () => {
    const f = await fixture()
    f.as(f.caller('user'))
    const view = await f.call('/api/account/mailx/mail-tools/lists')
    expect(view.body).toMatchObject({ host: 'connected', aliases: 'read', capabilities: { moderation: false, archive: false },
      lists: [{ address: 'team@archown.example.test', members: 2, state: 'delivering' }, { address: 'mods@archown.example.test', state: 'restricted' }] })
    const applied = await f.call('/api/account/mailx/mail-tools/lists', 'POST', { expectedRevision: view.body.compositeRevision })
    expect(applied.body).toMatchObject({ application: { outcome: 'applied', reconcile: 'applied' }, lists: [{ state: 'delivering' }, { state: 'restricted' }] })
    expect(f.audits).toContainEqual(expect.objectContaining({ action: 'mail.lists.applied', detail: { outcome: 'applied', reconcile: 'applied' } }))
    expect((await f.call('/api/account/mailx/mail-tools/lists', 'POST', { expectedRevision: '0'.repeat(64) })).code).toBe('CONFLICT')
    expect((await f.call('/api/account/mailx/mail-tools/lists?account=x')).code).toBe('VALIDATION')
    expect((await f.call('/api/account/mailx/mail-tools/lists', 'DELETE')).status).toBe(405)
    for (const lists of [{ observedAt: 'x', aliases: 'read', lists: [] }, { observedAt: '2026-10-28T10:00:00.000Z', aliases: 'read', lists: [{ address: 'a@b.test', members: 1, state: 'moderated' }] },
      { observedAt: '2026-10-28T10:00:00.000Z', aliases: 'read', lists: [], extra: 1 }]) {
      f.reply.lists = lists
      expect((await f.call('/api/account/mailx/mail-tools/lists')).body).toMatchObject({ host: 'unverified', lists: [] })
    }
    // A host reply claiming an unknown generation next to a known Postfix outcome is itself unknown.
    f.reply.reconcile = 'unknown'
    expect((await f.call('/api/account/mailx/mail-tools/lists', 'POST', { expectedRevision: view.body.compositeRevision })).body.application).toMatchObject({ outcome: 'unknown', verificationRequired: true })
    const offline = await fixture({ host: false }); offline.as(offline.caller('user'))
    expect((await offline.call('/api/account/mailx/mail-tools/lists')).body).toMatchObject({ host: 'not-connected', lists: [], observedAt: null })
    f.as(f.caller('root'))
    expect((await f.call('/api/account/mailx/mail-tools/lists')).code).toBe('FORBIDDEN')
  })
})
