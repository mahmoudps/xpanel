import { afterEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { createTestDb, findPrincipalByAccountId } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { planAddonConversion } from './acct-convert-addon.ts'
import type { ConvertAddonSnapshot } from './acct-convert-addon.ts'
import { executeAddonConversion, readConversionJournal } from './lifecycle-convert-addon.ts'
import type { ConvertAddonExecutionPorts } from './lifecycle-convert-addon.ts'
import type { AuthenticatedCaller } from './auth.ts'

// Synthetic store, host apply and agent file ports; the store hunk itself is checked on a scratch copy of store.ts.
const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
const ADDON = id(1), SUB = id(2), PRIMARY = id(3), PLAN = id(4), ACCOUNT = id(5), NEW = id(6)
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const snapshot = (): ConvertAddonSnapshot => ({
  revision: 7, plans: [{ id: PLAN, name: 'gold', caps: { subdomains: 5, aliasDomains: 5, mailboxes: 5 } }] as never,
  accounts: [{ id: ACCOUNT, username: 'alice', home: '/home/alice', status: 'active' }] as never,
  domains: [
    { id: PRIMARY, accountId: ACCOUNT, name: 'alice.example.test', kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', certificateId: null },
    { id: ADDON, accountId: ACCOUNT, name: 'shop.example.test', kind: 'addon', parentId: null, docRoot: '/home/alice/domains/shop.example.test/public_html', certificateId: null },
    { id: SUB, accountId: ACCOUNT, name: 'blog.shop.example.test', kind: 'subdomain', parentId: ADDON, docRoot: '/home/alice/domains/shop.example.test/public_html/blog', certificateId: null },
  ] as never,
  serviceUsers: [{ login: 'info@shop.example.test', domainId: ADDON, services: { email: true } }] as never,
  zones: [{ name: 'shop.example.test', records: [{}] }] as never,
})
const caller = { principal: { kind: 'root', id: id(7), username: 'root' }, sessionId: 's', apiTokenId: null } as unknown as AuthenticatedCaller
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const handles: TestDbHandle[] = []
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close() })

const fixture = async (files: (op: string, body: Record<string, unknown>) => Response | Promise<Response>, overrides: Partial<ConvertAddonExecutionPorts> = {}) => {
  const database = await createTestDb(); handles.push(database)
  const calls: unknown[][] = []
  let journal: unknown = null, revision = 7
  const account = { id: NEW, username: 'shop', home: '/home/shop', primaryDomain: 'shop.example.test', status: 'active' } as never
  const ports: ConvertAddonExecutionPorts = {
    db: database.db,
    store: {
      convertAddonDomain: async (input, opts) => { calls.push(['convert', input.username, input.domainId, opts.expectedRevision]); revision++; return { account, domains: ['shop.example.test', 'blog.shop.example.test'], serviceUsers: ['info@shop.example.test'], zones: ['shop.example.test'], certificates: [] } },
      revertAddonConversion: async input => { calls.push(['revert', input.accountId, input.domains.map(domain => domain.id)]); revision++; return { domains: [] } },
      getRevision: async () => revision,
      getAccount: async () => snapshot().accounts[0] as never,
    },
    hashPassword: async () => HASH,
    applyConfiguration: async (_caller, target, action, expected) => { calls.push(['apply', target.username, action, expected]) },
    callFiles: async (_caller, op, body) => { calls.push([op, body]); return files(op, body) },
    readJournal: async () => journal, writeJournal: async value => { journal = JSON.parse(JSON.stringify(value)) },
    emitAudit: async entry => { calls.push(['audit', entry.action]) },
    ...overrides,
  }
  const plan = planAddonConversion(snapshot(), { domainId: ADDON, username: 'shop', planId: PLAN }, false)
  return { ports, calls, plan, journal: () => readConversionJournal(journal), run: () => executeAddonConversion(caller, plan, snapshot(), ports), principal: () => findPrincipalByAccountId(database.db, NEW) }
}

describe('journaled addon conversion', () => {
  it('moves state, applies the host, copies with readback, trashes the source trees and journals each stage', async () => {
    const f = await fixture(op => op === 'copy' ? reply(200, { files: 3, bytes: 300, directories: 2, skipped: ['mail/blog.shop.example.test'], created: [], digest: 'a'.repeat(64) }) : reply(200, { trashed: 2, failed: [], complete: true }))
    const response = await f.run()
    expect(await response.json()).toMatchObject({ converted: true, account: { username: 'shop' }, files: { files: 3, bytes: 300 }, sourceCleanup: 'moved-to-trash', passwordResetRequired: true })
    expect(f.calls.filter(call => call[0] !== 'audit')).toEqual([
      ['convert', 'shop', ADDON, 7],
      ['apply', 'shop', 'create', 8],
      ['copy', { source: 'alice', target: 'shop', items: [{ from: 'domains/shop.example.test/public_html', to: 'public_html' }, { from: 'mail/shop.example.test', to: 'mail/shop.example.test' }, { from: 'mail/blog.shop.example.test', to: 'mail/blog.shop.example.test' }] }],
      ['cleanup', { source: 'alice', paths: ['domains/shop.example.test/public_html', 'mail/shop.example.test'] }],
    ])
    expect(await f.principal()).toMatchObject({ username: 'shop', forcePasswordChange: true })
    expect(f.journal()).toEqual([expect.objectContaining({ stage: 'source-cleaned', outcome: 'completed', accountId: NEW, files: { files: 3, bytes: 300, digest: 'a'.repeat(64) } })])
  })
  it('reverts the state move, the panel identity and the host when the confined copy is refused cleanly', async () => {
    const f = await fixture(() => reply(412, { code: 'PRECONDITION_FAILED', details: { stateChanged: false, reason: 'a file is larger than the 2 MiB limit' } }))
    await expect(f.run()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { rolledBack: true, stateChanged: true, verificationRequired: true, hostResidue: '/home/shop' } })
    expect(f.calls.filter(call => call[0] === 'revert' || call[0] === 'apply')).toEqual([['apply', 'shop', 'create', 8], ['revert', NEW, [ADDON, SUB]], ['apply', 'alice', 'update', 9]])
    expect(await f.principal()).toBeNull()
    expect(f.journal()[0]).toMatchObject({ stage: 'host-applied', outcome: 'rolled-back', reason: 'file_copy_refused' })
  })
  it('reverts before any file is touched when the host apply fails', async () => {
    const applied: string[] = []
    const f = await fixture(() => reply(500, {}), { applyConfiguration: async (_caller, target, action) => { applied.push(action + ':' + target.username); if (action === 'create') fail('SERVICE_UNAVAILABLE', 'account configuration requires verification before further action') } })
    await expect(f.run()).rejects.toMatchObject({ detail: { rolledBack: true, reason: 'host_apply_failed' } })
    expect(applied).toEqual(['create:shop', 'update:alice'])
    expect(f.calls.some(call => call[0] === 'copy')).toBe(false)
    const stuck = await fixture(() => reply(500, {}), { applyConfiguration: async () => fail('SERVICE_UNAVAILABLE', 'host apply refused') })
    await expect(stuck.run()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, reason: 'host_apply_failed; rollback_unproven' } })
  })
  it('reports unknown, never a rollback, when a copy or cleanup outcome cannot be proven', async () => {
    const lost = await fixture(() => { throw new Error('agent connection lost') })
    await expect(lost.run()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, stage: 'host-applied', reason: 'file_copy_transport_unknown' } })
    expect(lost.calls.some(call => call[0] === 'revert')).toBe(false)
    const partial = await fixture(op => op === 'copy' ? reply(200, { files: 1, bytes: 1, directories: 0, skipped: [], created: [], digest: 'b'.repeat(64) }) : reply(200, { trashed: 1, failed: ['mail/shop.example.test'], complete: false }))
    await expect(partial.run()).rejects.toMatchObject({ detail: { unknownOutcome: true, stage: 'files-copied', reason: 'source_cleanup_incomplete' } })
    expect(partial.journal()[0]).toMatchObject({ outcome: 'unknown' })
  })
  it('journals a store refusal as refused and touches nothing else; an unreadable journal stops before the store', async () => {
    const f = await fixture(() => reply(200, {}), { store: { convertAddonDomain: async () => fail('CONFLICT', 'revision conflict'), revertAddonConversion: async () => ({ domains: [] }), getRevision: async () => 7, getAccount: async () => null } })
    await expect(f.run()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.journal()[0]).toMatchObject({ stage: 'prepared', outcome: 'refused', reason: 'CONFLICT' })
    expect(f.calls).toEqual([])
    let converted = false
    const broken = await fixture(() => reply(200, {}), { readJournal: async () => ({ version: 2 }), store: { convertAddonDomain: async () => { converted = true; return null as never }, revertAddonConversion: async () => ({ domains: [] }), getRevision: async () => 7, getAccount: async () => null } })
    await expect(broken.run()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(converted).toBe(false)
  })
})
