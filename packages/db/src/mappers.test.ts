import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import type { Account, Domain, FirewallRule, Plan, ServerSettings, ServiceUser } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from './client.ts'
import {
  accountFromRow,
  accountToRow,
  auditFromRow,
  auditToRow,
  domainFromRow,
  domainToRow,
  firewallRuleFromRow,
  firewallRuleToRow,
  limitFromDb,
  limitToDb,
  planFromRow,
  planToRow,
  serverSettingsFromRow,
  serverSettingsToRow,
  serviceUserFromRow,
  serviceUserToRow,
  type AccountRow,
} from './mappers.ts'
import { createReseller, getReseller } from './repos/resellers.ts'
import { auditLog, domains, firewallPrefixLists, firewallRules, plans, serverSettings, serviceUsers } from './schema.ts'
import { ARGON2, php, planInput, seedAccount, seedPlan } from './testing.ts'

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
    return 'ok'
  } catch (e) {
    return isXpanelError(e) ? e.code : 'raw'
  }
}

describe('Limit <-> SQL', () => {
  it('maps NULL to unlimited and back', () => {
    expect(limitFromDb(null)).toBe('unlimited')
    expect(limitFromDb(0)).toBe(0)
    expect(limitToDb('unlimited')).toBeNull()
    expect(limitToDb(0)).toBe(0)
    expect(limitToDb(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it.each([-1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '5', null, undefined, 'Unlimited', ''])(
    'rejects %s',
    (v) => {
      expect(codeOf(() => limitToDb(v as never))).toBe('VALIDATION')
    },
  )
})

describe('pure mappers', () => {
  it('account row round-trip', () => {
    const a: Account = {
      id: '00000000-0000-4000-8000-000000000001',
      username: 'alice',
      uid: 20001,
      gid: 20001,
      home: '/home/alice',
      primaryDomain: 'alice.example',
      planId: '00000000-0000-4000-8000-000000000002',
      ownerId: null,
      status: 'suspended',
      suspendReason: 'billing',
      contactEmail: 'a@example.com',
      ipv4: '192.0.2.1',
      shell: 'jailed',
      createdAt: '2026-10-01T10:00:00.000Z',
    }
    const at = new Date('2026-10-02T08:00:00.000Z')
    const row = { ...accountToRow(a, { suspendedAt: at }), updatedAt: new Date() } as AccountRow
    expect(row.suspendedAt).toEqual(at)
    expect(accountFromRow(row)).toEqual(a)
    // the core type has no suspension time, so none is invented
    expect(codeOf(() => accountToRow(a))).toBe('VALIDATION')
    expect(accountToRow({ ...a, status: 'active', suspendReason: null }).suspendedAt).toBeNull()
  })

  it('service user rows take the local part by core login rules', () => {
    const u = { accountId: 'a', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 'unlimited' as const, ftpDir: '' }
    expect(serviceUserToRow({ ...u, login: 'Info@Example.com' }, 'd', 'h').localPart).toBe('info')
    for (const bad of ['@example.com', 'info@', 'info', 'a@b@example.com', 'a+b@example.com', 'a..b@example.com']) {
      expect(codeOf(() => serviceUserToRow({ ...u, login: bad }, 'd', 'h')), bad).toBe('VALIDATION')
    }
  })

  it("maps nginx workerProcesses NULL <-> 'auto' and rejects junk", () => {
    const s = settings()
    expect(serverSettingsToRow(s).nginxWorkerProcesses).toBeNull()
    expect(serverSettingsToRow({ ...s, nginx: { ...s.nginx, workerProcesses: 4 } }).nginxWorkerProcesses).toBe(4)
    expect(codeOf(() => serverSettingsToRow({ ...s, nginx: { ...s.nginx, workerProcesses: 0 } }))).toBe('VALIDATION')
    expect(codeOf(() => serverSettingsToRow({ ...s, nginx: { ...s.nginx, workerProcesses: 'max' as never } }))).toBe('VALIDATION')
  })
})

const settings = (): ServerSettings => ({
  hostname: 'host.example.net',
  nameservers: ['ns1.example.net', 'ns2.example.net'],
  adminEmail: 'admin@example.net',
  engine: 'apache',
  apacheMpm: 'itk',
  panelPort: 2087,
  sshPort: 22,
  nginx: { workerProcesses: 'auto', workerConnections: 4096, workerRlimitNofile: 65535, multiAccept: true, keepaliveTimeoutSec: 30 },
  apache: { startServers: 4, minSpareServers: 2, maxSpareServers: 8, maxRequestWorkers: 150, maxConnectionsPerChild: 0, serverLimit: 256 },
  backendPort: 8080,
  backendTlsPort: 8443,
})

describe('database round-trips', () => {
  let h: TestDbHandle

  beforeAll(async () => {
    h = await createTestDb()
  }, 120_000)

  afterAll(async () => {
    await h?.close()
  })

  const planRoundTrip = async (p: Omit<Plan, 'id'>): Promise<Plan> => {
    const [row] = await h.db.insert(plans).values(planToRow(p)).returning()
    return planFromRow(row as typeof plans.$inferSelect)
  }

  it('plan: all unlimited, all capped, mixed, and the 2^53-1 boundary survive', async () => {
    const seed = await seedPlan(h.db)
    const allUnlimited = planInput(seed.featureListId, { name: 'Everything' })
    for (const k of Object.keys(allUnlimited.resources) as (keyof Plan['resources'])[]) allUnlimited.resources[k] = 'unlimited'
    for (const k of Object.keys(allUnlimited.caps) as (keyof Plan['caps'])[]) allUnlimited.caps[k] = 'unlimited'
    const capped = planInput(seed.featureListId, { name: 'Tiny', defaultMailboxQuotaMb: 512 })
    for (const k of Object.keys(capped.resources) as (keyof Plan['resources'])[]) capped.resources[k] = 1
    for (const k of Object.keys(capped.caps) as (keyof Plan['caps'])[]) capped.caps[k] = k === 'phpWorkers' ? 1 : 0
    const boundary = planInput(seed.featureListId, { name: 'Huge' })
    boundary.resources.diskMb = Number.MAX_SAFE_INTEGER

    for (const p of [allUnlimited, capped, planInput(seed.featureListId, { name: 'Mixed' }), boundary]) {
      const back = await planRoundTrip(p)
      expect(back).toEqual({ ...p, id: back.id })
    }
    const [raw] = await h.query<{ disk_mb: unknown; cpu_percent: unknown }>(`SELECT disk_mb, cpu_percent FROM plans WHERE name = 'Everything'`)
    expect(raw).toEqual({ disk_mb: null, cpu_percent: null })
  })

  it('reseller: unlimited totals and arrays', async () => {
    const r = await createReseller(h.db, {
      username: 'res1',
      passwordHash: ARGON2,
      acl: ['create-account', 'list-accounts'],
      maxAccounts: 'unlimited',
      totalDiskMb: 0,
      totalBandwidthMb: 500_000,
      oversell: false,
      nameservers: ['ns1.res.example', 'ns2.res.example'],
      delegatedIps: ['192.0.2.50', '2001:db8::5'],
    })
    expect(await getReseller(h.db, r.id)).toEqual(r)
    expect(r.maxAccounts).toBe('unlimited')
    expect(r.totalDiskMb).toBe(0)
    expect(r.delegatedIps).toEqual(['192.0.2.50', '2001:db8::5'])
  })

  it('domain: redirect, php, unlimited path quota, expiry', async () => {
    const plan = await seedPlan(h.db)
    const acc = await seedAccount(h.db, plan.id)
    const d: Omit<Domain, 'id'> = {
      accountId: acc.id,
      name: 'shop.example.org',
      kind: 'addon',
      parentId: null,
      docRoot: `${acc.home}/shop`,
      siteType: 'proxy',
      upstream: 'http://127.0.0.1:3000',
      redirect: { to: 'https://www.example.org/', code: 302 },
      php: php({ ini: { upload_max_filesize: '64M', 'opcache.enable': '1' } }),
      wildcard: true,
      certificateId: null,
      suspended: false,
      expiresAt: '2027-01-31T00:00:00.000Z',
      pathQuotaMb: 'unlimited',
    }
    const [row] = await h.db.insert(domains).values(domainToRow(d)).returning()
    const back = domainFromRow(row as typeof domains.$inferSelect)
    expect(back).toEqual({ ...d, id: back.id })
    const [plain] = await h.db
      .insert(domains)
      .values(domainToRow({ ...d, name: 'plain.example.org', siteType: 'static', upstream: null, redirect: null, expiresAt: null, pathQuotaMb: 100 }))
      .returning()
    const p = domainFromRow(plain as typeof domains.$inferSelect)
    expect([p.redirect, p.expiresAt, p.pathQuotaMb, p.upstream]).toEqual([null, null, 100, null])
  })

  it('service user: login is rebuilt from local part + domain', async () => {
    const plan = await seedPlan(h.db)
    const acc = await seedAccount(h.db, plan.id)
    const [dom] = await h.db.select().from(domains).where(eq(domains.accountId, acc.id))
    const u: Omit<ServiceUser, 'id'> = {
      accountId: acc.id,
      login: `info@${acc.primaryDomain}`,
      services: { email: true, ftp: false, webdisk: true },
      mailboxQuotaMb: 'unlimited',
      ftpDir: 'public_html/uploads',
    }
    const [row] = await h.db.insert(serviceUsers).values(serviceUserToRow(u, dom?.id as string, '{ARGON2ID}x')).returning()
    const back = serviceUserFromRow({ ...(row as typeof serviceUsers.$inferSelect), domainName: dom?.name as string })
    expect(back).toEqual({ ...u, id: back.id })
  })

  it('firewall rule: every kind, ids kept, host sources in core canonical form', async () => {
    await h.db.insert(firewallPrefixLists).values({ name: 'blocklist', entries: ['203.0.113.0/24'] })
    const rules: FirewallRule[] = [
      { id: 'default-ssh', kind: 'port', action: 'accept', protocol: 'tcp', port: '22', source: null, forwardTo: null, list: null, comment: 'ssh', enabled: true },
      { id: 'r2', kind: 'port', action: 'drop', protocol: 'both', port: '8000-8100', source: '198.51.100.0/24', forwardTo: null, list: null, comment: '', enabled: false },
      { id: 'r3', kind: 'ip', action: 'reject', protocol: null, port: null, source: '2001:db8::/32', forwardTo: null, list: null, comment: 'v6', enabled: true },
      { id: 'r4', kind: 'ip', action: 'accept', protocol: null, port: null, source: '192.0.2.7', forwardTo: null, list: null, comment: 'one host', enabled: true },
      { id: 'r5', kind: 'forward', action: 'accept', protocol: 'tcp', port: '2222', source: null, forwardTo: '10.0.0.5:22', list: null, comment: '', enabled: true },
      { id: 'r6', kind: 'icmp', action: 'accept', protocol: null, port: null, source: null, forwardTo: null, list: null, comment: '', enabled: true },
      { id: 'r7', kind: 'prefix-list', action: 'drop', protocol: null, port: null, source: null, forwardTo: null, list: 'blocklist', comment: '', enabled: true },
    ]
    for (const [i, r] of rules.entries()) {
      const [row] = await h.db.insert(firewallRules).values(firewallRuleToRow(r, i)).returning()
      expect(firewallRuleFromRow(row as typeof firewallRules.$inferSelect)).toEqual(r)
    }
    const [raw] = await h.query<{ source: string }>(`SELECT source::text AS source FROM firewall_rules WHERE id = 'r4'`)
    expect(raw?.source).toBe('192.0.2.7/32')
  })

  it('server settings: auto and fixed worker counts', async () => {
    for (const s of [settings(), { ...settings(), nginx: { ...settings().nginx, workerProcesses: 8 as const } }]) {
      const { id: _id, ...values } = serverSettingsToRow(s)
      const [row] = await h.db
        .insert(serverSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: serverSettings.id, set: values })
        .returning()
      expect(serverSettingsFromRow(row as typeof serverSettings.$inferSelect)).toEqual(s)
    }
  })

  it('audit entry', async () => {
    const e = { actor: 'root', action: 'plan.update', target: 'plan:Basic', detail: { diff: { diskMb: [1, 'unlimited'] } }, outcome: 'denied' as const }
    const [row] = await h.db.insert(auditLog).values(auditToRow(e)).returning()
    const back = auditFromRow(row as typeof auditLog.$inferSelect)
    expect(back).toEqual({ ...e, id: back.id, at: back.at })
    expect(back.id).toMatch(/^[0-9]+$/)
    expect(Number.isNaN(Date.parse(back.at))).toBe(false)
  })
})
