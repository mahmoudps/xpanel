import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultFirewallRules, isXpanelError } from '@xpanel/core'
import type { Account, Id, PhpSettings, Plan, ServerSettings } from '@xpanel/core'
import { createTestStateStore, type TestStateStoreHandle } from './store.ts'
import type { NewAccount, NewDomain, NewFirewallRule, NewPlan, NewReseller } from './types.ts'

export const ARGON2 =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

const NATIVE = `*${'A1'.repeat(20)}`

let seq = 0
const next = (): number => ++seq

const php = (over: Partial<PhpSettings> = {}): PhpSettings => ({
  version: '8.3',
  handler: 'fpm',
  fpm: {
    mode: 'ondemand',
    maxChildren: 8,
    startServers: 2,
    minSpareServers: 1,
    maxSpareServers: 4,
    maxRequests: 500,
    processIdleTimeoutSec: 10,
  },
  ini: {},
  ...over,
})

const planInput = (featureListId: Id, over: Partial<NewPlan> = {}): NewPlan => ({
  name: `Plan ${next()}`,
  ownerId: null,
  featureListId,
  resources: {
    diskMb: 10_240,
    bandwidthMbMonth: 102_400,
    ioReadBps: 52_428_800,
    ioWriteBps: 52_428_800,
    ioReadIops: 2000,
    ioWriteIops: 2000,
    memoryMb: 1024,
    maxProcesses: 64,
    cpuPercent: 100,
  },
  caps: {
    addonDomains: 5,
    aliasDomains: 5,
    subdomains: 20,
    mailboxes: 20,
    forwarders: 20,
    mailingLists: 2,
    ftpAccounts: 5,
    databases: 10,
    phpWorkers: 8,
  },
  dedicatedIp: false,
  shell: 'none',
  defaultMailboxQuotaMb: 512,
  ...over,
})

const resellerInput = (username: string, over: Partial<NewReseller> = {}): NewReseller => ({
  username,
  passwordHash: ARGON2,
  acl: ['create-account', 'list-accounts'],
  maxAccounts: 10,
  totalDiskMb: 100_000,
  totalBandwidthMb: 'unlimited',
  oversell: false,
  nameservers: [],
  delegatedIps: [],
  ...over,
})

const accountInput = (planId: Id, over: Partial<NewAccount> = {}): NewAccount => {
  const n = next()
  return {
    username: `user${n}`,
    passwordHash: ARGON2,
    primaryDomain: `site${n}.example.com`,
    planId,
    ownerId: null,
    contactEmail: `admin@site${n}.example.com`,
    ipv4: '192.0.2.10',
    shell: 'none',
    php: php(),
    ...over,
  }
}

const domainInput = (account: Account, name: string, over: Partial<NewDomain> = {}): NewDomain => ({
  accountId: account.id,
  name,
  kind: 'addon',
  parentId: null,
  docRoot: `${account.home}/${name.split('.')[0]}`,
  siteType: 'php',
  upstream: null,
  redirect: null,
  php: php(),
  wildcard: false,
  certificateId: null,
  suspended: false,
  expiresAt: null,
  pathQuotaMb: 'unlimited',
  ...over,
})

let h: TestStateStoreHandle

beforeAll(async () => {
  h = await createTestStateStore()
})

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

const seedPlan = async (over: Partial<NewPlan> = {}): Promise<Plan> => {
  const fl = await h.store.createFeatureList({ name: `Features ${next()}`, ownerId: over.ownerId ?? null, disabled: [] })
  return h.store.createPlan(planInput(fl.id, over))
}

const seedAccount = (planId: Id, over: Partial<NewAccount> = {}): Promise<Account> =>
  h.store.createAccount(accountInput(planId, over))

describe('state files on disk and atomic snapshot validation', () => {
  it('writes canonical JSON per entity and re-validates on readSnapshot', async () => {
    const fl = await h.store.createFeatureList({ name: 'No Shell', ownerId: null, disabled: ['terminal', 'ssh-access', 'terminal'] })
    expect(fl.disabled).toEqual(['ssh-access', 'terminal'])
    const rawFl = JSON.parse(await readFile(join(h.rootDir, 'feature-lists', `${fl.id}.json`), 'utf8'))
    expect(rawFl).toEqual(fl)

    const plan = await h.store.createPlan(planInput(fl.id, { name: 'Starter' }))
    const acc = await h.store.createAccount(accountInput(plan.id, { username: 'alice', primaryDomain: 'Alice.Example.COM' }))
    expect(acc).toMatchObject({ username: 'alice', primaryDomain: 'alice.example.com', home: '/home/alice', status: 'active' })
    expect(acc.uid).toBeGreaterThanOrEqual(20000)

    const rawAcc = JSON.parse(await readFile(join(h.rootDir, 'accounts', 'alice', 'account.json'), 'utf8'))
    expect(rawAcc.username).toBe('alice')
    const rawDom = JSON.parse(await readFile(join(h.rootDir, 'accounts', 'alice', 'domains', 'alice.example.com.json'), 'utf8'))
    expect(rawDom.kind).toBe('primary')

    const snap = await h.store.readSnapshot()
    expect(snap.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(snap.accounts.map((a) => a.username)).toContain('alice')

    // Corrupting a file on disk is caught when the agent re-validates the state tree
    const planFile = join(h.rootDir, 'plans', `${plan.id}.json`)
    const goodPlanJson = await readFile(planFile, 'utf8')
    await writeFile(planFile, JSON.stringify({ ...plan, resources: { ...plan.resources, memoryMb: -5 } }), 'utf8')
    expect(await code(h.store.readSnapshot())).toBe('VALIDATION')
    await writeFile(planFile, goodPlanJson, 'utf8')
    expect((await h.store.readSnapshot()).checksum).toBe(snap.checksum)
  })
})

describe('accounts, plans, resellers and UID allocator invariants', () => {
  it('rolls everything back when username clashes with a reseller, keeping the UID burnt', async () => {
    const plan = await seedPlan()
    const ok = await seedAccount(plan.id, { primaryDomain: 'taken.example.com' })
    await h.store.createReseller(resellerInput('bobx'))
    const before = await h.store.countAccounts()
    expect(await code(h.store.createAccount(accountInput(plan.id, { username: 'bobx' })))).toBe('CONFLICT')
    expect(await h.store.countAccounts()).toBe(before)
    expect(await h.store.getAccountByUsername('bobx')).toBeNull()
    const bob = await h.store.createAccount(accountInput(plan.id, { username: 'bob' }))
    expect(bob.uid).toBeGreaterThan(ok.uid + 1)
  })

  it('refuses a primary domain that overlaps another account before any UID is burnt', async () => {
    const plan = await seedPlan()
    const owner = await seedAccount(plan.id, { primaryDomain: 'victim.example.net' })
    const topBefore = await h.store.maxAllocatedUid()
    for (const name of ['VICTIM.example.net', 'shop.victim.example.net', 'www.victim.example.net', 'example.net']) {
      expect(await code(h.store.createAccount(accountInput(plan.id, { primaryDomain: name }))), name).toBe('CONFLICT')
    }
    expect(await h.store.maxAllocatedUid()).toBe(topBefore)
    expect((await h.store.getAccount(owner.id))?.primaryDomain).toBe('victim.example.net')
  })

  it('allocates unique monotonic UIDs across concurrent creations and never reuses them', async () => {
    const plan = await seedPlan()
    const maxBefore = (await h.store.maxAllocatedUid()) ?? 0
    const made = await Promise.all(Array.from({ length: 8 }, (_, i) => seedAccount(plan.id, { username: `conc${i}` })))
    const uids = made.map((a) => a.uid).sort((a, b) => a - b)
    expect(new Set(uids).size).toBe(uids.length)
    expect(uids[0]).toBeGreaterThan(maxBefore)
    expect(uids).toEqual(uids.map((_, i) => (uids[0] as number) + i))

    const gone = made[0] as Account
    await h.store.markTerminating(gone.id)
    await h.store.deleteAccount(gone.id)
    const again = await seedAccount(plan.id, { username: gone.username })
    expect(again.uid).toBeGreaterThan(uids[uids.length - 1] as number)
    expect(again.uid).not.toBe(gone.uid)
  })

  it('enforces reseller capacity, overselling rules, and plan ownership', async () => {
    const r = await h.store.createReseller(resellerInput(`tot${next()}`, { totalDiskMb: 12_000, totalBandwidthMb: 'unlimited', maxAccounts: 2 }))
    const small = await seedPlan({ ownerId: r.id, resources: { ...planInput('x').resources, diskMb: 5000 } })
    const big = await seedPlan({ ownerId: r.id, resources: { ...planInput('x').resources, diskMb: 11_000 } })
    const a = await h.store.createAccount(accountInput(small.id, { ownerId: r.id }))
    await h.store.createAccount(accountInput(small.id, { ownerId: r.id }))
    expect(await code(h.store.createAccount(accountInput(small.id, { ownerId: r.id })))).toBe('LIMIT_EXCEEDED')
    expect(await code(h.store.changePlan(a.id, big.id))).toBe('OVERSELL_BLOCKED')
    expect(await code(h.store.updatePlan(small.id, { resources: { diskMb: 8000 } }))).toBe('OVERSELL_BLOCKED')
    expect((await h.store.updatePlan(small.id, { resources: { diskMb: 6000 } })).resources.diskMb).toBe(6000)
    expect(await h.store.resellerUsage(r.id)).toMatchObject({ accounts: 2, diskMb: 12_000 })
  })
})

describe('domains, service users, databases, certificates, DNS zones, cron and firewall', () => {
  it('renames domains, updates service user logins, enforces database trash/grants and firewall lockout', async () => {
    const plan = await seedPlan()
    const a = await seedAccount(plan.id, { username: 'shopowner', primaryDomain: 'old-shop.example' })
    const primary = await h.store.getDomainByName('old-shop.example')
    const sub = await h.store.createDomain(
      domainInput(a, 'blog.old-shop.example', { kind: 'subdomain', parentId: primary?.id ?? null }),
    )
    const su = await h.store.createServiceUser({
      accountId: a.id,
      login: 'info@old-shop.example',
      services: { email: true, ftp: true, webdisk: false },
      mailboxQuotaMb: 512,
      ftpDir: 'public_html',
      passwordHash: '{ARGON2ID}abc',
    })
    const renamed = await h.store.renameDomain(primary!.id, 'new-shop.example')
    expect(renamed.name).toBe('new-shop.example')
    expect((await h.store.getDomain(sub.id))?.name).toBe('blog.new-shop.example')
    expect((await h.store.getServiceUser(su.id))?.login).toBe('info@new-shop.example')

    const db = await h.store.createDatabase({ accountId: a.id, name: 'shopowner_wp' })
    const dbu = await h.store.createDatabaseUser({ accountId: a.id, name: 'shopowner_app', authString: NATIVE })
    const granted = await h.store.setGrant({ databaseUserId: dbu.id, databaseId: db.id, privileges: ['SELECT', 'INSERT'] })
    expect(granted.grants).toEqual([{ databaseId: db.id, privileges: ['INSERT', 'SELECT'] }])
    expect(await code(h.store.purgeDatabase(db.id))).toBe('PRECONDITION_FAILED')
    await h.store.trashDatabase(db.id)
    expect(await h.store.purgeDatabase(db.id)).toBe(true)
    expect((await h.store.getDatabaseUser(dbu.id))?.grants).toEqual([])

    const cert = await h.store.createCertificate({
      accountId: a.id,
      names: ['new-shop.example', '*.new-shop.example'],
      source: 'acme',
      challenge: 'dns-01',
      notAfter: '2027-06-01T00:00:00.000Z',
      autoRenew: true,
      certPath: '/etc/xpanel/ssl/new-shop.crt',
      keyPath: '/etc/xpanel/ssl/new-shop.key',
    })
    expect((await h.store.listCertificates(a.id)).map((c) => c.id)).toEqual([cert.id])

    const zone = await h.store.saveDnsZone({
      id: '11111111-2222-4333-8444-555555555555',
      accountId: a.id,
      name: 'new-shop.example',
      serial: 2026102201,
      records: [
        { id: '22222222-2222-4333-8444-555555555555', zone: 'new-shop.example', name: '@', type: 'A', ttl: 3600, content: '192.0.2.10', priority: null },
      ],
    })
    expect((await h.store.getDnsZone('new-shop.example'))?.serial).toBe(zone.serial)

    const cron = await h.store.saveCronJobs(a.id, [
      { id: '33333333-2222-4333-8444-555555555555', accountId: a.id, schedule: '0 * * * *', command: '/usr/bin/php /home/shopowner/artisan schedule:run', comment: 'hourly', enabled: true },
    ])
    expect(cron).toHaveLength(1)

    const admin = { lockout: { sessionIp: '198.51.100.20', panelPort: 2087, sshPort: 22 } }
    const baseRules = defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 })
    await h.store.replaceFirewall({ rules: baseRules, prefixLists: [] }, admin)
    const blockRule: NewFirewallRule = {
      id: 'block-office',
      kind: 'ip',
      action: 'drop',
      protocol: null,
      port: null,
      source: '198.51.100.0/24',
      forwardTo: null,
      list: null,
      comment: '',
      enabled: true,
    }
    expect(await code(h.store.replaceFirewall({ rules: [blockRule, ...baseRules], prefixLists: [] }, admin))).toBe('SELF_LOCKOUT')
  })

  it('saves and restores generation snapshots while keeping burnt UIDs monotonic', async () => {
    const settings: ServerSettings = {
      hostname: 'srv.example.net',
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
    }
    await h.store.saveServerSettings(settings)
    const snap1 = await h.store.saveGenerationSnapshot(1)
    const plan = await seedPlan()
    const tempAcc = await seedAccount(plan.id, { username: 'tempuser' })
    const snap2 = await h.store.readSnapshot()
    expect(snap2.checksum).not.toBe(snap1.checksum)

    const restored = await h.store.restoreGenerationSnapshot(1)
    expect(restored.checksum).toBe(snap1.checksum)
    expect(await h.store.getAccount(tempAcc.id)).toBeNull()
    // Burnt UID of tempuser is never reused after rollback
    expect(await h.store.maxAllocatedUid()).toBeGreaterThanOrEqual(tempAcc.uid)
  })
})
