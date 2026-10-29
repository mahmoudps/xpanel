import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRootPrincipal, createTestDb, createUserPrincipal, setPrincipalDisabled } from '@xpanel/db'
import type { Account, ServiceUser } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { tools } from '../../../packages/catalog/src/index.ts'
import { FakeHostExecutor } from './executor.ts'
import type { HostReconciler } from './reconciler.ts'
import { AGENT_QUARANTINE_FEATURE_POLICY, agentCallerHeaders, createAgentApp } from './server.ts'

// Actual Agent Request/authentication dispatch and disposable DB, with an
// explicitly declared metadata port and memory-only host. No socket peer,
// Dovecot/SSH service, recovery or native qualification is exercised.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const handles: Awaited<ReturnType<typeof createTestDb>>[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const handle of handles.splice(0)) await handle.close() })
async function fixture(options: { gate?: boolean; quarantineGate?: boolean } = {}) {
  const handle = await createTestDb(); handles.push(handle)
  const account = { id: randomUUID(), username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', status: 'active', planId: randomUUID(), ownerId: null } as Account
  const mailbox: ServiceUser = { id: randomUUID(), accountId: account.id, login: 'alice@example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' }
  const root = await createRootPrincipal(handle.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const owner = await createUserPrincipal(handle.db, { username: account.username, accountId: account.id, passwordHash: HASH })
  const sealed = await createUserPrincipal(handle.db, { username: 'mbx_fixture', accountId: account.id, passwordHash: HASH })
  const disabled: string[] = [], getMailbox = vi.fn(async (login: string) => login === mailbox.login ? mailbox : null)
  const store = { getAccount: async (id: string) => id === account.id ? account : null, getServiceUserByLogin: getMailbox,
    getPlan: async () => ({ id: account.planId, featureListId: 'features' }), getFeatureList: async () => ({ disabled }), getReseller: async () => null } as unknown as StateStore
  const executor = new FakeHostExecutor(), token = randomBytes(32).toString('hex'), rollback = vi.fn(async () => { throw new Error('unqualified rollback must not run') })
  executor.files.set('/etc/os-release', { path: '/etc/os-release', content: 'ID=ubuntu\nVERSION_ID="24.04"\nID_LIKE=debian\n', mode: 0o644 })
  let revokeOnGate = false
  const gate = vi.fn(async () => { if (revokeOnGate) await setPrincipalDisabled(handle.db, root.id, true) })
  const quarantineGate = vi.fn(async () => {})
  const app = createAgentApp({ db: handle.db, store, executor, reconciler: { rollbackToGeneration: rollback } as unknown as HostReconciler,
    os: { id: 'ubuntu', versionId: '24.04', family: 'debian' }, agentToken: token,
    ...(options.gate ? { assertKeyMutationQualified: gate } : {}), ...(options.quarantineGate ? { quarantineQualification: quarantineGate } : {}) })
  const request = (path: string, method = 'GET', body?: unknown, principalId = root.id, authenticated = true) => app.fetch(new Request('http://agent.local' + path,
    { method, headers: { ...(authenticated ? agentCallerHeaders({ principalId, token }) : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  return { handle, root, owner, sealed, account, mailbox, getMailbox, disabled, executor, gate, quarantineGate, rollback, request, revokeOnGate: () => { revokeOnGate = true } }
}
const keyIntent = () => ({ publicKey: 'bounded-public-key-input', expectedRevision: 'a'.repeat(64) })
const mutation = () => ({ locator: { mailboxGuid: 'a'.repeat(32), uidValidity: 1, uid: 1, messageGuid: 'b'.repeat(32) }, expectedRevision: 'a'.repeat(64) })

describe('functional Agent authentication and default native refusal', () => {
  it('keeps the independent feature guard equivalent to authoritative current catalog metadata', () => {
    expect(AGENT_QUARANTINE_FEATURE_POLICY).toEqual(AGENT_QUARANTINE_FEATURE_POLICY.map(policy => { const tool = tools.find(candidate => candidate.id === policy.id); expect(tool).toBeDefined(); return { id: policy.id, featureKey: tool!.featureKey } }))
    expect(Object.isFrozen(AGENT_QUARANTINE_FEATURE_POLICY)).toBe(true)
  })
  it('requires service credentials and root for SSH observations', async () => {
    const f = await fixture()
    expect((await f.request('/host/security/ssh', 'GET', undefined, f.root.id, false)).status).toBe(401)
    expect((await f.request('/host/security/ssh', 'GET', undefined, f.owner.id)).status).toBe(403)
    expect(f.executor.executedCommands).toHaveLength(0)
  })
  it('reads only fixed SSH observations, preserves the range and shares one lazy service instance', async () => {
    const f = await fixture(), read = vi.spyOn(f.executor, 'readFile')
    for (const path of ['/host/security/ssh', '/host/security/ssh?window=7d']) {
      const response = await f.request(path); expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ policy: { state: 'unavailable' }, service: { state: 'unavailable' }, failedLogins: { state: 'unavailable', window: path.includes('7d') ? '7d' : '24h' } })
    }
    expect(read.mock.calls.filter(call => call[0] === '/etc/os-release')).toHaveLength(1)
    expect(f.executor.executedCommands.at(-1)).toEqual(['/usr/bin/journalctl', '--unit', 'ssh.service', '--since', '-7d', '--no-pager', '--output=json', '--lines=500'])
    expect(f.executor.executedActions).toHaveLength(0)
  })
  it('defaults SSH key admission to refusal and refuses request-selected profile fields', async () => {
    const f = await fixture()
    expect((await f.request('/host/security/ssh/keys', 'POST', keyIntent())).status).toBe(412)
    expect((await f.request('/host/security/ssh/keys', 'POST', { ...keyIntent(), qualified: true })).status).toBe(422)
    expect((await f.request('/host/security/ssh?window=7d&window=24h')).status).toBe(422)
    expect(f.executor.executedCommands).toHaveLength(0); expect(f.executor.executedActions).toHaveLength(0)
  })
  it('rechecks current root after the trusted SSH gate and never promotes a fake host', async () => {
    const f = await fixture({ gate: true }); f.revokeOnGate()
    expect((await f.request('/host/security/ssh/keys', 'POST', keyIntent())).status).toBe(401)
    expect(f.gate).toHaveBeenCalledTimes(1); expect(f.executor.executedActions).toHaveLength(0)
    const other = await fixture({ gate: true })
    expect((await other.request('/host/security/ssh/keys', 'POST', keyIntent())).status).toBe(412)
    expect(other.executor.executedCommands).toHaveLength(0)
  })
  it('keeps a missing native quarantine profile explicitly unavailable for the actual hosting owner', async () => {
    const f = await fixture(), scope = { accountId: f.account.id, mailbox: f.mailbox.login }
    const response = await f.request('/host/mail/quarantine/list', 'POST', { scope }, f.owner.id)
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ state: 'unavailable', scope, reason: 'native_profile_unavailable' })
    expect(f.executor.executedCommands).toHaveLength(0)
    expect((await f.request('/host/mail/quarantine/release', 'POST', { scope, input: mutation() }, f.owner.id)).status).toBe(412)
    expect(f.executor.executedActions).toHaveLength(0)
  })
  it('independently denies sealed mailbox-shaped user identities for hosting-owner RPCs', async () => {
    const f = await fixture(), scope = { accountId: f.account.id, mailbox: f.mailbox.login }
    expect((await f.request('/host/mail/quarantine/list', 'POST', { scope }, f.sealed.id)).status).toBe(403)
    expect((await f.request('/accounts/alice/backup-workspace', 'GET', undefined, f.sealed.id)).status).toBe(403)
    expect(f.executor.executedCommands).toHaveLength(0)
  })
  it.each(['spam-quarantine', 'email-accounts', 'popaccts (Email Accounts)'])('enforces the current feature key %s before native profile resolution', async key => {
    const f = await fixture(); f.disabled.push(key)
    expect((await f.request('/host/mail/quarantine/list', 'POST', { scope: { accountId: f.account.id, mailbox: f.mailbox.login } }, f.owner.id)).status).toBe(403)
    expect(f.executor.executedCommands).toHaveLength(0)
  })
  it('pins the stored mailbox lifetime across one queued native call', async () => {
    const f = await fixture(), replacement = { ...f.mailbox, id: randomUUID() }
    f.getMailbox.mockResolvedValueOnce(f.mailbox).mockResolvedValue(replacement)
    const response = await f.request('/host/mail/quarantine/list', 'POST', { scope: { accountId: f.account.id, mailbox: f.mailbox.login } }, f.owner.id)
    expect(response.status).toBe(409); expect(f.executor.executedCommands).toHaveLength(0)
  })
  it('rejects quarantine profile/cursor injection and refuses a fake even behind a trusted write gate', async () => {
    const f = await fixture({ quarantineGate: true }), scope = { accountId: f.account.id, mailbox: f.mailbox.login }
    for (const body of [{ scope, profile: {} }, { scope, options: null }, { scope, options: { beforeUid: 0 } }, { scope: { ...scope, serviceUserId: f.mailbox.id } }]) expect((await f.request('/host/mail/quarantine/list', 'POST', body, f.owner.id)).status).toBe(422)
    expect((await f.request('/host/mail/quarantine/release', 'POST', { scope, input: mutation() }, f.owner.id)).status).toBe(412)
    expect(f.quarantineGate).toHaveBeenCalled(); expect(f.executor.executedCommands).toHaveLength(0)
  })
  it('keeps PHP inventory and default-site observations root-only with no selector-driven reads', async () => {
    const f = await fixture()
    for (const path of ['/host/php/inventory', '/host/default-site/requests']) expect((await f.request(path, 'GET', undefined, f.owner.id)).status).toBe(403)
    expect((await f.request('/host/php/inventory')).status).toBe(404)
    expect((await f.request('/host/php/inventory?source=dpkg')).status).toBe(422)
    expect((await f.request('/host/default-site/requests?path=/etc/passwd')).status).toBe(422)
    expect(f.executor.executedCommands).toHaveLength(0)
  })
  it('requires sealed canonical rollback intent and never invokes recovery on an unqualified fake', async () => {
    const f = await fixture(), intent = { expectedCurrentGenerationId: 9, expectedCurrentStateRevision: 0, expectedTargetChecksum: '7'.repeat(64), confirmation: '7' }
    const read = await f.request('/generations/rollback-admission')
    expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ executor: 'fake', canRollback: false, eligibleTargets: [] })
    expect((await f.request('/generations/7/rollback', 'POST', intent)).status).toBe(412)
    for (const [path, body] of [['/generations/7/rollback', { ...intent, force: true }], ['/generations/07/rollback', intent], ['/generations/7/rollback?force=true', intent], ['/generations/7/rollback', {}]] as const) expect((await f.request(path, 'POST', body)).status).toBe(422)
    expect((await f.request('/generations/rollback-admission', 'GET', undefined, f.owner.id)).status).toBe(403)
    expect(f.rollback).not.toHaveBeenCalled(); expect(f.executor.executedActions).toHaveLength(0)
  })
})
