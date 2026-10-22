import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultFirewallRules, isXpanelError } from '@xpanel/core'
import type { ServerSettings } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { ARGON2, seedAccount, seedPlan, sha } from '../testing.ts'
import { appendAudit, listAudit } from './audit.ts'
import {
  createDatabase,
  createDatabaseUser,
  deleteDatabaseUser,
  getDatabaseUser,
  listDatabases,
  listDatabaseUsers,
  listTrashedDatabasesBefore,
  purgeDatabase,
  restoreDatabase,
  revokeGrant,
  setGrant,
  trashDatabase,
} from './databases.ts'
import { createDomain, renameDomain } from './domains.ts'
import {
  createFirewallRule,
  deleteFirewallRule,
  deletePrefixList,
  getFirewallRule,
  getFirewallState,
  listFirewallRules,
  moveFirewallRule,
  replaceFirewall,
  savePrefixList,
  updateFirewallRule,
  type NewFirewallRule,
} from './firewall.ts'
import {
  activate,
  createGeneration,
  latestActive,
  listGenerations,
  markFailed,
  markTested,
  previousGeneration,
  rollbackTo,
} from './generations.ts'
import { createRootPrincipal, findPrincipalByUsername, getPrincipal, setPasswordHash, setTotpSecret } from './principals.ts'
import {
  createServiceUser,
  deleteServiceUser,
  getServiceUser,
  getServiceUserByLogin,
  getServiceUserHash,
  listServiceUsers,
  updateServiceUser,
} from './service-users.ts'
import { getServerSettings, isSetupComplete, markSetupComplete, saveServerSettings } from './settings.ts'
import { createUpgrade, finishUpgrade, inFlightUpgrade, latestUpgrade, listUpgrades, setUpgradePhase } from './upgrades.ts'
import { php } from '../testing.ts'

let h: TestDbHandle

beforeAll(async () => {
  h = await createTestDb()
}, 120_000)

afterAll(async () => {
  await h?.close()
})

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return isXpanelError(e) ? e.code : `raw:${(e as Error).message}`
  }
}

const NATIVE = `*${'A1'.repeat(20)}`

describe('principals', () => {
  it('root login, password change, sealed TOTP', async () => {
    const root = await createRootPrincipal(h.db, { username: 'root', passwordHash: ARGON2 })
    expect(root).toMatchObject({ kind: 'root', forcePasswordChange: true, totpEnabled: false, accountId: null })
    expect(await code(createRootPrincipal(h.db, { username: 'ROOT', passwordHash: ARGON2 }))).toBe('VALIDATION')
    expect(await code(createRootPrincipal(h.db, { username: 'root', passwordHash: ARGON2 }))).toBe('CONFLICT')
    expect(await code(createRootPrincipal(h.db, { username: 'admin2', passwordHash: 'md5:abc' }))).toBe('VALIDATION')
    const other = ARGON2.replace('c2FsdHNhbHRzYWx0', 'b3RoZXJzYWx0')
    await setPasswordHash(h.db, root.id, other)
    expect((await getPrincipal(h.db, root.id))?.forcePasswordChange).toBe(false)
    expect((await findPrincipalByUsername(h.db, 'Root'))?.passwordHash).toBe(other)
    const sealed = new Uint8Array(48).map((_, i) => i)
    await setTotpSecret(h.db, root.id, sealed)
    const p = await getPrincipal(h.db, root.id)
    expect(p?.totpEnabled).toBe(true)
    expect([...(p?.totpSecretEnc ?? [])]).toEqual([...sealed])
    expect(await code(setTotpSecret(h.db, root.id, new Uint8Array(4)))).toBe('VALIDATION')
    await setTotpSecret(h.db, root.id, null)
    expect((await getPrincipal(h.db, root.id))?.totpEnabled).toBe(false)
  })
})

describe('service users', () => {
  it('CRUD; login domain must belong to the account; follows domain renames', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id, { primaryDomain: 'mail-a.example' })
    const b = await seedAccount(h.db, plan.id, { primaryDomain: 'mail-b.example' })
    const base = { accountId: a.id, services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html', passwordHash: '{ARGON2ID}abc' }
    const u = await createServiceUser(h.db, { ...base, login: 'Info@Mail-A.example' })
    expect(u.login).toBe('info@mail-a.example')
    expect(await getServiceUser(h.db, u.id)).toEqual(u)
    expect(await getServiceUserByLogin(h.db, 'INFO@mail-a.example')).toEqual(u)
    expect(await getServiceUserHash(h.db, u.id)).toBe('{ARGON2ID}abc')

    expect(await code(createServiceUser(h.db, { ...base, login: 'info@mail-a.example' }))).toBe('CONFLICT')
    expect(await code(createServiceUser(h.db, { ...base, login: 'x@mail-b.example' }))).toBe('VALIDATION')
    expect(await code(createServiceUser(h.db, { ...base, login: 'bad user@mail-a.example' }))).toBe('VALIDATION')
    expect(await code(createServiceUser(h.db, { ...base, login: 'a..b@mail-a.example' }))).toBe('VALIDATION')
    expect(await code(createServiceUser(h.db, { ...base, login: 'x@mail-a.example', ftpDir: '../b' }))).toBe('VALIDATION')
    expect(await code(createServiceUser(h.db, { ...base, login: 'x@mail-a.example', ftpDir: '/etc' }))).toBe('VALIDATION')
    expect(await code(createServiceUser(h.db, { ...base, login: 'x@mail-a.example', passwordHash: 'a:b' }))).toBe('VALIDATION')
    expect(await code(createServiceUser(h.db, { ...base, login: 'x@mail-a.example', services: { email: false, ftp: false, webdisk: false } }))).toBe(
      'VALIDATION',
    )
    expect(await code(createServiceUser(h.db, { ...base, login: 'x@mail-a.example', mailboxQuotaMb: -1 }))).toBe('VALIDATION')

    const up = await updateServiceUser(h.db, u.id, { mailboxQuotaMb: 'unlimited', services: { email: true, ftp: false, webdisk: true } })
    expect([up.mailboxQuotaMb, up.services]).toEqual(['unlimited', { email: true, ftp: false, webdisk: true }])

    const primary = await createDomain(h.db, {
      accountId: b.id,
      name: 'extra-b.example',
      kind: 'addon',
      parentId: null,
      docRoot: `${b.home}/extra`,
      siteType: 'static',
      upstream: null,
      redirect: null,
      php: php(),
      wildcard: false,
      certificateId: null,
      suspended: false,
      expiresAt: null,
      pathQuotaMb: 'unlimited',
    })
    const bu = await createServiceUser(h.db, { ...base, accountId: b.id, login: 'ftp@extra-b.example' })
    await renameDomain(h.db, primary.id, 'renamed-b.example')
    expect((await getServiceUser(h.db, bu.id))?.login).toBe('ftp@renamed-b.example')
    expect((await listServiceUsers(h.db, a.id)).map((x) => x.login)).toEqual(['info@mail-a.example'])
    expect(await deleteServiceUser(h.db, u.id)).toBe(true)
    expect(await getServiceUser(h.db, u.id)).toBeNull()
  })
})

describe('databases', () => {
  it('prefix, trash before purge, grants stay inside the account', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id, { username: 'shopowner' })
    const b = await seedAccount(h.db, plan.id, { username: 'neighbour' })
    const d = await createDatabase(h.db, { accountId: a.id, name: 'shopowner_wp' })
    expect(d).toMatchObject({ engine: 'mariadb', name: 'shopowner_wp', trashedAt: null })
    expect(await code(createDatabase(h.db, { accountId: a.id, name: 'shopowner_wp' }))).toBe('CONFLICT')
    expect(await code(createDatabase(h.db, { accountId: a.id, name: 'neighbour_wp' }))).toBe('VALIDATION')
    expect(await code(createDatabase(h.db, { accountId: a.id, name: 'shopowner_' }))).toBe('VALIDATION')
    expect(await code(createDatabase(h.db, { accountId: a.id, name: 'shopowner_x`; DROP DATABASE y' }))).toBe('VALIDATION')
    expect(await code(createDatabase(h.db, { accountId: a.id, name: `shopowner_${'x'.repeat(60)}` }))).toBe('VALIDATION')
    const other = await createDatabase(h.db, { accountId: b.id, name: 'neighbour_db' })

    const user = await createDatabaseUser(h.db, { accountId: a.id, name: 'shopowner_app', authString: NATIVE })
    expect(await code(createDatabaseUser(h.db, { accountId: a.id, name: 'shopowner_x', authString: "x' OR 1=1" }))).toBe('VALIDATION')
    expect(await code(createDatabaseUser(h.db, { accountId: a.id, name: 'shopowner_y', authString: 'plain' }))).toBe('VALIDATION')
    expect(await code(createDatabaseUser(h.db, { accountId: a.id, name: `shopowner_${'u'.repeat(23)}`, authString: NATIVE }))).toBe('VALIDATION')
    expect(await code(createDatabaseUser(h.db, { accountId: a.id, name: 'neighbour_app', authString: NATIVE }))).toBe('VALIDATION')
    const granted = await setGrant(h.db, { databaseUserId: user.id, databaseId: d.id, privileges: ['SELECT', 'INSERT', 'SELECT'] })
    expect(granted.grants).toEqual([{ databaseId: d.id, privileges: ['INSERT', 'SELECT'] }])
    expect((await setGrant(h.db, { databaseUserId: user.id, databaseId: d.id, privileges: ['ALL PRIVILEGES', 'SELECT'] })).grants).toEqual([
      { databaseId: d.id, privileges: ['ALL PRIVILEGES'] },
    ])
    expect(await code(setGrant(h.db, { databaseUserId: user.id, databaseId: other.id, privileges: ['SELECT'] }))).toBe('FORBIDDEN')
    expect(await code(setGrant(h.db, { databaseUserId: user.id, databaseId: d.id, privileges: ['SUPER'] }))).toBe('VALIDATION')
    expect(await code(setGrant(h.db, { databaseUserId: user.id, databaseId: d.id, privileges: [] }))).toBe('VALIDATION')
    // even raw SQL cannot cross accounts: composite keys
    expect(
      await code(
        h.query(`INSERT INTO database_grants (database_user_id, database_id, account_id, privileges) VALUES ($1, $2, $3, '{SELECT}')`, [
          user.id,
          other.id,
          a.id,
        ]),
      ),
    ).toMatch(/raw:|NOT_FOUND/)

    expect(await code(purgeDatabase(h.db, d.id))).toBe('PRECONDITION_FAILED')
    const t = await trashDatabase(h.db, d.id)
    expect(t.trashedAt).not.toBeNull()
    expect(await listDatabases(h.db, a.id)).toEqual([])
    expect((await listDatabases(h.db, a.id, { includeTrashed: true })).map((x) => x.id)).toEqual([d.id])
    expect(await code(setGrant(h.db, { databaseUserId: user.id, databaseId: d.id, privileges: ['SELECT'] }))).toBe('PRECONDITION_FAILED')
    expect((await restoreDatabase(h.db, d.id)).trashedAt).toBeNull()
    await trashDatabase(h.db, d.id)
    expect((await listTrashedDatabasesBefore(h.db, new Date(Date.now() + 60_000))).map((x) => x.id)).toContain(d.id)
    expect(await purgeDatabase(h.db, d.id)).toBe(true)
    expect((await getDatabaseUser(h.db, user.id))?.grants).toEqual([])

    expect(await revokeGrant(h.db, user.id, d.id)).toBe(false)
    expect((await listDatabaseUsers(h.db, a.id)).map((u) => u.name)).toEqual(['shopowner_app'])
    expect(await deleteDatabaseUser(h.db, user.id)).toBe(true)
  })
})

describe('firewall', () => {
  const rule = (over: Partial<NewFirewallRule> = {}): NewFirewallRule => ({
    kind: 'port',
    action: 'accept',
    protocol: 'tcp',
    port: '443',
    source: null,
    forwardTo: null,
    list: null,
    comment: '',
    enabled: true,
    ...over,
  })
  const open = { lockout: null }
  const admin = { lockout: { sessionIp: '198.51.100.20', panelPort: 2087, sshPort: 22 } }

  it('validates with core rules, keeps ids and order, and replaces atomically', async () => {
    const r1 = await createFirewallRule(h.db, rule({ id: 'admin-panel', port: '2087', comment: 'xPanel' }), open)
    const r2 = await createFirewallRule(h.db, rule({ port: '22', comment: 'ssh' }), open)
    const r3 = await createFirewallRule(h.db, rule({ kind: 'ip', action: 'drop', protocol: null, port: null, source: '203.0.113.0/24' }), open)
    expect(r1.id).toBe('admin-panel')
    expect(r2.id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await listFirewallRules(h.db)).map((r) => r.id)).toEqual([r1.id, r2.id, r3.id])
    expect(await code(createFirewallRule(h.db, rule({ id: 'admin-panel' }), open))).toBe('CONFLICT')
    expect((await updateFirewallRule(h.db, r2.id, { port: '2222' }, open)).port).toBe('2222')
    expect(await code(updateFirewallRule(h.db, r2.id, { port: '22-10' }, open))).toBe('VALIDATION')
    expect(await code(updateFirewallRule(h.db, 'missing', { port: '1' }, open))).toBe('NOT_FOUND')
    expect((await moveFirewallRule(h.db, r3.id, 0, open)).map((r) => r.id)).toEqual([r3.id, r1.id, r2.id])
    expect(await code(moveFirewallRule(h.db, r3.id, 3, open))).toBe('VALIDATION')

    const bad: [string, Partial<NewFirewallRule>][] = [
      ['port 0', { port: '0' }],
      ['port 65536', { port: '65536' }],
      ['port with a leading zero', { port: '022' }],
      ['port text', { port: 'ssh' }],
      ['port injection', { port: '22 accept; flush ruleset' }],
      ['source junk', { source: '1.2.3.4; drop' }],
      ['source prefix', { source: '10.0.0.0/33' }],
      ['source host bits', { source: '10.0.0.1/8' }],
      ['comment newline', { comment: 'a\nb' }],
      ['comment quote (nft string breakout)', { comment: 'x" accept; #' }],
      ['comment over 128 bytes', { comment: 'x'.repeat(129) }],
      ['protocol', { protocol: 'icmp' as never }],
      ['action', { action: 'masquerade' as never }],
      ['forward without target', { kind: 'forward' }],
      ['forward to loopback', { kind: 'forward', port: '2200', forwardTo: '127.0.0.1:22' }],
      ['forward to metadata', { kind: 'forward', port: '2200', forwardTo: '169.254.169.254:80' }],
      ['forward with drop', { kind: 'forward', action: 'drop', port: '2200', forwardTo: '10.0.0.5:22' }],
      ['icmp with port', { kind: 'icmp' }],
      ['prefix list name', { kind: 'prefix-list', protocol: null, port: null, list: 'Bad Name' }],
      ['list on port rule', { list: 'x' }],
      ['ip without source', { kind: 'ip', protocol: null, port: null }],
      ['unknown field', { extra: 1 } as never],
      ['bad id', { id: 'no spaces' }],
    ]
    for (const [what, over] of bad) expect(await code(createFirewallRule(h.db, rule(over), open)), what).toBe('VALIDATION')
    expect(await code(createFirewallRule(h.db, rule({ kind: 'prefix-list', protocol: null, port: null, list: 'nosuchlist' }), open))).toBe('VALIDATION')

    const imported = {
      prefixLists: [{ name: 'spamhaus', entries: ['192.0.2.0/24', '2001:DB8::/32'] }],
      rules: [
        { ...rule({ port: '80' }), id: 'web' },
        { ...rule({ kind: 'forward', port: '2200', forwardTo: '[2001:db8::1]:22' }), id: 'fwd' },
        { ...rule({ kind: 'prefix-list', action: 'drop', protocol: null, port: null, list: 'spamhaus' }), id: 'block' },
        { ...rule({ kind: 'icmp', protocol: null, port: null }), id: 'ping' },
      ],
    }
    expect(await code(replaceFirewall(h.db, { ...imported, rules: [...imported.rules, { ...rule({ port: 'bad' }), id: 'x' }] }, open))).toBe('VALIDATION')
    expect(await code(replaceFirewall(h.db, { ...imported, rules: [...imported.rules, { ...rule(), id: 'web' }] }, open))).toBe('VALIDATION')
    expect(await code(replaceFirewall(h.db, { prefixLists: [], rules: imported.rules }, open))).toBe('VALIDATION')
    expect((await listFirewallRules(h.db)).length).toBe(3) // nothing replaced
    const after = await replaceFirewall(h.db, imported, open)
    expect(after.rules).toEqual(imported.rules)
    expect(after.prefixLists).toEqual([{ name: 'spamhaus', entries: ['192.0.2.0/24', '2001:db8::/32'] }])
    expect(await code(deletePrefixList(h.db, 'spamhaus', open))).toBe('CONFLICT')
    expect(await deleteFirewallRule(h.db, 'web', open)).toBe(true)
    expect(await deleteFirewallRule(h.db, 'x', open)).toBe(false)
    expect(await getFirewallRule(h.db, 'fwd')).toMatchObject({ kind: 'forward', forwardTo: '[2001:db8::1]:22' })
  })

  it('refuses any change that would lock out the saving session', async () => {
    const base = defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 })
    await replaceFirewall(h.db, { rules: base, prefixLists: [] }, admin)
    expect((await getFirewallState(h.db)).rules.map((r) => r.id)).toEqual(base.map((r) => r.id))

    const blockMe = { ...rule({ kind: 'ip', action: 'drop', protocol: null, port: null, source: '198.51.100.0/24' }), id: 'block-office' }
    expect(await code(replaceFirewall(h.db, { rules: [blockMe, ...base], prefixLists: [] }, admin))).toBe('SELF_LOCKOUT')
    const created = await createFirewallRule(h.db, blockMe, admin) // appended after the accepts: harmless
    expect(await code(moveFirewallRule(h.db, created.id, 0, admin))).toBe('SELF_LOCKOUT')
    expect(await code(updateFirewallRule(h.db, 'default-panel', { enabled: false }, admin))).toBe('SELF_LOCKOUT')
    expect(await code(deleteFirewallRule(h.db, 'default-ssh', admin))).toBe('SELF_LOCKOUT')
    const steal = { ...rule({ kind: 'forward', port: '2087', forwardTo: '10.0.0.9:2087' }), id: 'steal-panel' }
    expect(await code(createFirewallRule(h.db, steal, admin))).toBe('SELF_LOCKOUT')
    // a prefix list that would come to contain the session address, matched before the accepts
    const dropAbusers = { ...rule({ kind: 'prefix-list', action: 'drop', protocol: null, port: null, list: 'abusers' }), id: 'drop-abusers' }
    await replaceFirewall(h.db, { prefixLists: [{ name: 'abusers', entries: ['203.0.113.0/24'] }], rules: [dropAbusers, ...base] }, admin)
    expect(await code(savePrefixList(h.db, 'abusers', ['198.51.100.0/24'], admin))).toBe('SELF_LOCKOUT')
    expect((await savePrefixList(h.db, 'abusers', ['203.0.113.0/24', '192.0.2.0/24'], admin)).entries).toEqual(['203.0.113.0/24', '192.0.2.0/24'])
    // without a session the same change passes; a missing guard is refused outright
    expect(await code(deleteFirewallRule(h.db, 'default-ssh', open))).toBe('ok')
    expect(await code(createFirewallRule(h.db, rule({ port: '9000' }), undefined as never))).toBe('VALIDATION')
  })
})

describe('server settings', () => {
  const s = (): ServerSettings => ({
    hostname: 'Server.Example.NET',
    nameservers: ['ns1.example.net'],
    adminEmail: 'root@example.net',
    engine: 'apache',
    apacheMpm: 'itk',
    panelPort: 2087,
    sshPort: 22,
    nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 65535, multiAccept: false, keepaliveTimeoutSec: 65 },
    apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 },
    backendPort: 8080,
    backendTlsPort: 8443,
  })

  it('single row upsert validated by core worker rules; setup flag', async () => {
    expect(await getServerSettings(h.db)).toBeNull()
    expect(await isSetupComplete(h.db)).toBe(false)
    expect(await code(markSetupComplete(h.db))).toBe('PRECONDITION_FAILED')
    const saved = await saveServerSettings(h.db, s())
    expect(saved.hostname).toBe('server.example.net')
    const changed = await saveServerSettings(h.db, { ...s(), nginx: { ...s().nginx, workerProcesses: 4 } })
    expect(changed.nginx.workerProcesses).toBe(4)
    expect(await getServerSettings(h.db)).toEqual(changed)
    const [n] = await h.query<{ n: number }>('SELECT count(*)::int AS n FROM server_settings')
    expect(n?.n).toBe(1)
    await markSetupComplete(h.db)
    expect(await isSetupComplete(h.db)).toBe(true)

    const bad: Partial<ServerSettings>[] = [
      { panelPort: 443 },
      { backendPort: 2087 },
      { sshPort: 0 },
      { hostname: 'bad host' },
      { engine: 'iis' as never },
      { apacheMpm: 'event' as never },
      { apache: { ...s().apache, maxRequestWorkers: 500, serverLimit: 100 } },
      { apache: { ...s().apache, minSpareServers: 10, maxSpareServers: 5 } },
      { apache: { ...s().apache, minSpareServers: 6, maxSpareServers: 6, startServers: 6 } },
      { nginx: { ...s().nginx, workerConnections: 0 } },
      { nginx: { ...s().nginx, workerConnections: 40_000, workerRlimitNofile: 65535 } },
      { nginx: { ...s().nginx, extra: true } as never },
      { nameservers: ['ns1.example.net', 'bad_ns'] },
      { nameservers: ['ns1.example.net', 'NS1.example.net'] },
    ]
    for (const b of bad) expect(await code(saveServerSettings(h.db, { ...s(), ...b })), JSON.stringify(b)).toBe('VALIDATION')
    expect(await getServerSettings(h.db)).toEqual(changed)
  })
})

describe('audit', () => {
  it('appends and pages newest first; never updates', async () => {
    const e1 = await appendAudit(h.db, { actor: 'root:root', action: 'account.create', target: 'alice', outcome: 'ok', ip: '192.0.2.1', detail: { plan: 'Basic' } })
    const e2 = await appendAudit(h.db, { actor: 'reseller:res1', action: 'account.suspend', target: 'alice', outcome: 'denied' })
    expect(e1.detail).toEqual({ plan: 'Basic' })
    const page = await listAudit(h.db, { target: 'alice' })
    expect(page.map((e) => e.id)).toEqual([e2.id, e1.id])
    expect((await listAudit(h.db, { beforeId: e2.id, target: 'alice' })).map((e) => e.id)).toEqual([e1.id])
    expect((await listAudit(h.db, { actor: 'reseller:res1' })).map((e) => e.outcome)).toEqual(['denied'])
    expect(await code(appendAudit(h.db, { actor: '', action: 'x', target: '', outcome: 'ok' }))).toBe('VALIDATION')
    expect(await code(appendAudit(h.db, { actor: 'root', action: 'x y', target: '', outcome: 'ok' }))).toBe('VALIDATION')
    expect(await code(appendAudit(h.db, { actor: 'root', action: 'Account.Create', target: '', outcome: 'ok' }))).toBe('VALIDATION')
    expect(await code(appendAudit(h.db, { actor: 'root', action: 'x', target: '', outcome: 'meh' as never }))).toBe('VALIDATION')
    expect(await code(appendAudit(h.db, { actor: 'root', action: 'x', target: '', outcome: 'ok', ip: '10.0.0.0/8' }))).toBe('VALIDATION')
    expect(await code(listAudit(h.db, { limit: 0 }))).toBe('VALIDATION')
    expect(await code(listAudit(h.db, { beforeId: '0' }))).toBe('VALIDATION')
    expect(await code(h.query(`UPDATE audit_log SET actor = 'nobody'`))).toMatch(/raw:.*append-only/)
  })

  it('redacts secrets and escapes hostile text instead of dropping the entry', async () => {
    const e = await appendAudit(h.db, {
      actor: 'root:root',
      action: 'service-user.create',
      target: 'mysql://bob:hunter2@db.example/x\nFAKE LINE',
      outcome: 'ok',
      detail: { password: 'hunter2', nested: { apiToken: 'tok_123', note: 'ok' }, pem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' },
    })
    expect(JSON.stringify(e)).not.toMatch(/hunter2|tok_123|AAAA/)
    expect(e.detail).toMatchObject({ password: '[REDACTED]', nested: { apiToken: '[REDACTED]', note: 'ok' }, pem: '[REDACTED]' })
    expect(e.target).not.toContain('\n')
    expect(e.target).toContain('[REDACTED]@db.example')
    const long = await appendAudit(h.db, { actor: 'x'.repeat(1000), action: 'a.b', target: 't'.repeat(5000), outcome: 'failed' })
    expect(long.actor.length).toBeLessThanOrEqual(255)
    expect(long.target.length).toBeLessThanOrEqual(512)
  })
})

describe('config generations', () => {
  it('lifecycle keeps exactly one active generation', async () => {
    expect(await latestActive(h.db)).toBeNull()
    const g1 = await createGeneration(h.db, { checksum: sha('a') })
    expect(g1.status).toBe('pending')
    expect(await code(activate(h.db, g1.id))).toBe('PRECONDITION_FAILED') // untested
    await markTested(h.db, g1.id)
    expect((await activate(h.db, g1.id)).status).toBe('active')
    expect((await activate(h.db, g1.id)).status).toBe('active') // idempotent

    const stale = await createGeneration(h.db, { checksum: sha('9') })
    await markTested(h.db, stale.id)
    const g2 = await createGeneration(h.db, { checksum: sha('b'), actor: 'agent' })
    await markTested(h.db, g2.id)
    expect((await activate(h.db, g2.id)).status).toBe('active')
    expect((await latestActive(h.db))?.id).toBe(g2.id)
    expect((await previousGeneration(h.db))?.id).toBe(g1.id)
    // an older tested generation was rendered from older desired state
    expect(await code(activate(h.db, stale.id))).toBe('PRECONDITION_FAILED')

    // a failing test leaves g2 serving
    const g3 = await createGeneration(h.db, { checksum: sha('c') })
    const f3 = await markFailed(h.db, g3.id, 'nginx: [emerg] unknown directive "foo"\nconfiguration file test failed')
    expect(f3.status).toBe('failed')
    expect(await code(markTested(h.db, g3.id))).toBe('PRECONDITION_FAILED')
    expect(await code(activate(h.db, g3.id))).toBe('PRECONDITION_FAILED')
    expect(await code(markFailed(h.db, g2.id, 'x'))).toBe('PRECONDITION_FAILED') // active cannot fail; it rolls back
    expect(await code(markFailed(h.db, g3.id, ''))).toBe('VALIDATION')
    expect((await latestActive(h.db))?.id).toBe(g2.id)

    // reload/health check of g2 failed: back to g1
    const back = await rollbackTo(h.db, g1.id, 'health check: vhost not served')
    expect(back.id).toBe(g1.id)
    const all = await listGenerations(h.db)
    expect(Object.fromEntries(all.map((g) => [g.id, g.status]))).toEqual({
      [g1.id]: 'active',
      [stale.id]: 'tested',
      [g2.id]: 'rolled_back',
      [g3.id]: 'failed',
    })
    expect(all.find((g) => g.id === g2.id)?.error).toBe('health check: vhost not served')
    expect(await code(rollbackTo(h.db, g3.id, 'x'))).toBe('PRECONDITION_FAILED')

    // concurrent activations still end with exactly one active
    const many: number[] = []
    for (const c of ['d', 'e', 'f', '0']) {
      const g = await createGeneration(h.db, { checksum: sha(c) })
      await markTested(h.db, g.id)
      many.push(g.id)
    }
    const settled = await Promise.allSettled(many.map((id) => activate(h.db, id)))
    expect(settled.some((x) => x.status === 'fulfilled')).toBe(true)
    const [cnt] = await h.query<{ n: number }>(`SELECT count(*)::int AS n FROM config_generations WHERE status = 'active'`)
    expect(cnt?.n).toBe(1)
    expect(await code(createGeneration(h.db, { checksum: 'nothex' }))).toBe('VALIDATION')
    expect(await code(activate(h.db, 999_999))).toBe('NOT_FOUND')
    expect(await code(activate(h.db, -1))).toBe('VALIDATION')
  })
})

describe('upgrades', () => {
  it('one in flight; phases; settles with report', async () => {
    const u = await createUpgrade(h.db, { fromVersion: '1.2.0', toVersion: '1.3.0-rc.1', actor: 'root', fromSchemaVersion: 1 })
    expect(u).toMatchObject({ status: 'pending', phase: null, startedAt: null })
    expect(await code(createUpgrade(h.db, { fromVersion: '1.2.0', toVersion: '1.3.0', actor: 'root' }))).toBe('CONFLICT')
    const r = await setUpgradePhase(h.db, u.id, 'snapshot', { snapshotPath: '/var/lib/xpanel/snapshots/1.2.0' })
    expect(r).toMatchObject({ status: 'running', phase: 'snapshot', snapshotPath: '/var/lib/xpanel/snapshots/1.2.0' })
    expect(r.startedAt).not.toBeNull()
    await setUpgradePhase(h.db, u.id, 'health-check')
    expect(await code(finishUpgrade(h.db, u.id, { status: 'rolled_back' }))).toBe('VALIDATION') // needs a reason
    const done = await finishUpgrade(h.db, u.id, {
      status: 'rolled_back',
      error: 'test account not served as its uid',
      healthReport: { reconciler: 'ok', identity: 'failed', login: 'ok' },
    })
    expect(done).toMatchObject({ status: 'rolled_back', healthReport: { identity: 'failed' } })
    expect(done.finishedAt).not.toBeNull()
    expect(await code(setUpgradePhase(h.db, u.id, 'switch'))).toBe('PRECONDITION_FAILED')
    expect(await inFlightUpgrade(h.db)).toBeNull()

    const next = await createUpgrade(h.db, { fromVersion: '1.2.0', toVersion: '1.3.0', actor: 'root' })
    const ok = await finishUpgrade(h.db, next.id, { status: 'succeeded', toSchemaVersion: 2, healthReport: { all: 'ok' } })
    expect(ok).toMatchObject({ status: 'succeeded', toSchemaVersion: 2, error: null })
    expect((await latestUpgrade(h.db))?.id).toBe(next.id)
    expect((await listUpgrades(h.db)).length).toBe(2)

    for (const bad of [
      { fromVersion: '1.2', toVersion: '1.3.0' },
      { fromVersion: '1.2.0', toVersion: '1.2.0' },
      { fromVersion: 'v1.2.0', toVersion: '1.3.0' },
    ]) {
      expect(await code(createUpgrade(h.db, { ...bad, actor: 'root' })), JSON.stringify(bad)).toBe('VALIDATION')
    }
    expect(await code(createUpgrade(h.db, { fromVersion: '1.3.0', toVersion: '1.4.0', actor: 'root', snapshotPath: '../x' }))).toBe('VALIDATION')
    expect(await code(setUpgradePhase(h.db, next.id, 'nope' as never))).toBe('VALIDATION')

    // two finishers race: exactly one settles the upgrade
    const third = await createUpgrade(h.db, { fromVersion: '1.3.0', toVersion: '1.4.0', actor: 'root' })
    const settled = await Promise.allSettled([
      finishUpgrade(h.db, third.id, { status: 'succeeded' }),
      finishUpgrade(h.db, third.id, { status: 'failed', error: 'late health report' }),
    ])
    expect(settled.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const loser = settled.find((x) => x.status === 'rejected') as PromiseRejectedResult
    expect(isXpanelError(loser.reason) && loser.reason.code).toBe('PRECONDITION_FAILED')
  })
})
