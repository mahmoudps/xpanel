import { generateKeyPairSync, sign } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultPlan, validateUsername, type Account, type PhpSettings } from '@xpanel/core'
import { createResellerPrincipal, createRootPrincipal, createTestDb, createUserPrincipal } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { backupFileName, assertBackupFileName } from './account-backup.ts'
import { FakeHostExecutor } from './executor.ts'
import type { AccountFileRunner } from './file-manager.ts'
import { HostReconciler } from './reconciler.ts'
import { agentCallerHeaders, createAgentApp } from './server.ts'

const names = ['a', 'ab', 'abc', 'abcdefghijklmnop'] as const
const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts), length: number[] = []
  if (body.length > 127) for (let value = body.length; value; value >>>= 8) length.unshift(value & 255)
  return Buffer.concat([Buffer.from([tag]), Buffer.from(length.length ? [128 | length.length, ...length] : [body.length]), body])
}
const seq = (...parts: Buffer[]) => der(0x30, ...parts), oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'))
/** Runtime-generated self-signed EC P-256 leaf for the given DNS names; a portable fixture only. */
const selfSigned = (...hosts: string[]) => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), alg = seq(oid('2a8648ce3d040302'))
  const name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from('Portable upload fixture')))))
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([5])), alg, name, seq(der(0x17, Buffer.from('250101000000Z')), der(0x17, Buffer.from('280101000000Z'))),
    name, pair.publicKey.export({ format: 'der', type: 'spki' }), der(0xa3, seq(seq(oid('551d11'), der(0x04, seq(...hosts.map(host => der(0x82, Buffer.from(host)))))))))
  const bytes = seq(tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, pair.privateKey)])))
  return { fullchainPem: '-----BEGIN CERTIFICATE-----\n' + bytes.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n',
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }
}
const hash = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const token = 'a'.repeat(64)
const php: PhpSettings = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }

describe('short username agent dispatch retains target and privilege authority', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let state: Awaited<ReturnType<typeof createTestStateStore>>
  let app: ReturnType<typeof createAgentApp>
  let executor: FakeHostExecutor, rootId: string, resellerId: string
  const principalIds = new Map<string, string>()
  const accounts = new Map<string, Account>()
  const fileTargets: { username: string; uid: number; home: string }[] = []
  const call = (principalId: string, path: string, method = 'POST', body?: unknown) => app.fetch(new Request('http://agent.local' + path, {
    method, headers: { ...agentCallerHeaders({ principalId, token }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  beforeAll(async () => {
    db = await createTestDb(); state = await createTestStateStore(); executor = new FakeHostExecutor()
    rootId = (await createRootPrincipal(db.db, { username: 'root', passwordHash: hash, forcePasswordChange: false })).id
    const reseller = await state.store.createReseller({ username: 'reseller7', passwordHash: hash, acl: ['list-accounts', 'edit-account', 'manage-ssl', 'transfer'], maxAccounts: 10, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] })
    resellerId = (await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash: hash })).id
    const feature = await state.store.createFeatureList({ name: 'Short agent tools', ownerId: null, disabled: [] })
    const { id: _id, ...seed } = defaultPlan({ name: 'Short agent plan', featureListId: feature.id })
    const plan = await state.store.createPlan({ ...seed, shell: 'jailed' })
    await state.store.saveServerIp({ address: '192.0.2.42', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    for (const username of names) {
      const account = await state.store.createAccount({ username, passwordHash: hash, primaryDomain: username + '.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.42', shell: 'jailed', php })
      accounts.set(username, account)
      principalIds.set(username, (await createUserPrincipal(db.db, { username, accountId: account.id, passwordHash: hash })).id)
    }
    const runner: AccountFileRunner = { run: async context => { fileTargets.push({ username: context.account.username, uid: context.account.uid, home: context.account.home }); return [] } }
    const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os })
    app = createAgentApp({ db: db.db, store: state.store, executor, reconciler, agentToken: token, accountFileRunner: runner, os: { id: os.id, family: os.family, versionId: os.versionId } })
  })
  beforeEach(() => { fileTargets.length = 0; executor.executedCommands.length = 0 })
  afterAll(async () => { await state?.close(); await db?.close() })

  it.each(names)('routes owned files and portable shell for %s using stored UID/home', async username => {
    const principalId = principalIds.get(username)!, account = accounts.get(username)!
    expect((await call(principalId, `/accounts/${username}/files`, 'POST', { op: 'list', path: '' })).status).toBe(200)
    expect(fileTargets).toEqual([{ username, uid: account.uid, home: '/home/' + username }])
    const shell = await call(principalId, `/accounts/${username}/shell`, 'POST', { command: 'whoami' })
    expect(shell.status).toBe(200)
    expect(executor.executedCommands).toHaveLength(1)
    expect(executor.executedCommands[0]!.join(' ')).toContain('/home/' + username)
    expect(executor.executedCommands[0]!.join(' ')).toContain(String(account.uid))
  })
  it.each(names)('routes certificate validation and preserves root-only backup/purge for %s', async username => {
    const principalId = principalIds.get(username)!
    const certificate = await call(principalId, `/accounts/${username}/certificates`, 'POST', {})
    expect(certificate.status).toBe(422)
    expect(await certificate.text()).toContain('domain is required')
    for (const suffix of ['backups', 'purge']) {
      expect((await call(principalId, `/accounts/${username}/${suffix}`, 'GET')).status).toBe(403)
      expect((await call(resellerId, `/accounts/${username}/${suffix}`, 'GET')).status).toBe(403)
      const portable = await call(rootId, `/accounts/${username}/${suffix}`, 'GET')
      expect(portable.status).toBe(404)
      expect(await portable.json()).toEqual({ available: false })
    }
    expect(executor.executedCommands).toEqual([])
  })
  it('rejects neighboring targets before confined execution or any shell command', async () => {
    for (const suffix of ['files', 'shell', 'certificates']) {
      const response = await call(principalIds.get('a')!, '/accounts/ab/' + suffix, 'POST', suffix === 'files' ? { op: 'list', path: '' } : suffix === 'shell' ? { command: 'whoami' } : {})
      expect(response.status).toBe(403)
    }
    expect(fileTargets).toEqual([]); expect(executor.executedCommands).toEqual([])
  })
  it('lets an account owner write manual certificate candidates for an owned domain only', async () => {
    const own = await call(principalIds.get('abc')!, '/accounts/abc/certificates', 'POST', { operation: 'install', domain: 'abc.example.test', ...selfSigned('abc.example.test') })
    const text = await own.text()
    expect(own.status, text).toBe(200)
    expect(text).not.toContain('PRIVATE KEY')
    expect(JSON.parse(text)).toMatchObject({ certificate: { source: 'upload', autoRenew: false, names: ['abc.example.test'] }, application: { status: 'candidate_files_written', nativeApplied: false } })
    const written = executor.files.size
    expect((await call(principalIds.get('a')!, '/accounts/ab/certificates', 'POST', { operation: 'install', domain: 'ab.example.test', ...selfSigned('ab.example.test') })).status).toBe(403)
    expect((await call(principalIds.get('abc')!, '/accounts/abc/certificates', 'POST', { operation: 'install', domain: 'abc.example.test', ...selfSigned('abc.example.test', 'ab.example.test') })).status).toBe(403)
    expect(executor.files.size).toBe(written)
  })
  it.each(names)('keeps archive names account-bound for %s', username => {
    const file = backupFileName(username, '20261024T120000Z')
    expect(file).toBe(`xpanel-backup-${username}-20261024T120000Z.tar.gz`)
    expect(assertBackupFileName(username, file)).toBe(file)
    expect(() => assertBackupFileName(username, '../' + file)).toThrow()
    expect(() => assertBackupFileName(username, backupFileName(username === 'a' ? 'ab' : 'a', '20261024T120000Z'))).toThrow()
  })
  it.each(['abcdefghijklmnopq', 'A', 'a_', 'a-b', 'root'])('keeps invalid/reserved names out of account dispatch: %s', async username => {
    expect(() => validateUsername(username)).toThrow()
    expect((await call(rootId, `/accounts/${username}/files`, 'POST', { op: 'list', path: '' })).status).toBe(404)
    expect(fileTargets).toEqual([]); expect(executor.executedCommands).toEqual([])
  })
})
