import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { ARGON2, accountInput, php, planInput, resellerInput, seedAccount, seedPlan } from '../testing.ts'
import {
  allocateUid,
  changeOwner,
  changePlan,
  countAccounts,
  createAccount,
  deleteAccount,
  getAccount,
  getAccountByUsername,
  listAccounts,
  markTerminating,
  suspendAccount,
  unsuspendAccount,
  updateAccount,
} from './accounts.ts'
import {
  countDomainsByKind,
  createDomain,
  deleteDomain,
  getDomain,
  getDomainByName,
  listDomains,
  renameDomain,
  updateDomain,
  type NewDomain,
} from './domains.ts'
import { createFeatureList, deleteFeatureList, getFeatureList, listFeatureLists, updateFeatureList } from './feature-lists.ts'
import { countAccountsOnPlan, createPlan, deletePlan, getPlan, listPlans, updatePlan } from './plans.ts'
import { findPrincipalByUsername } from './principals.ts'
import { createReseller, deleteReseller, getResellerByUsername, listResellers, resellerUsage, updateReseller } from './resellers.ts'

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

describe('feature lists', () => {
  it('CRUD with key validation', async () => {
    const fl = await createFeatureList(h.db, { name: 'No Shell', ownerId: null, disabled: ['terminal', 'ssh-access', 'terminal'] })
    expect(fl.disabled).toEqual(['ssh-access', 'terminal'])
    expect(await getFeatureList(h.db, fl.id)).toEqual(fl)
    expect((await updateFeatureList(h.db, fl.id, { disabled: [] })).disabled).toEqual([])
    expect(await code(createFeatureList(h.db, { name: 'no shell', ownerId: null, disabled: [] }))).toBe('CONFLICT')
    expect(await code(createFeatureList(h.db, { name: 'x', ownerId: null, disabled: ['Bad Key'] }))).toBe('VALIDATION')
    expect(await code(createFeatureList(h.db, { name: '../etc', ownerId: null, disabled: [] }))).toBe('VALIDATION')
    expect((await listFeatureLists(h.db, { ownerId: null })).map((f) => f.id)).toContain(fl.id)
    expect(await deleteFeatureList(h.db, fl.id)).toBe(true)
    expect(await getFeatureList(h.db, fl.id)).toBeNull()
    expect(await getFeatureList(h.db, 'not-a-uuid')).toBeNull()
  })
})

describe('plans', () => {
  it('create / get / list / update / delete', async () => {
    const fl = await createFeatureList(h.db, { name: 'Default', ownerId: null, disabled: [] })
    const plan = await createPlan(h.db, planInput(fl.id, { name: 'Starter' }))
    expect(await getPlan(h.db, plan.id)).toEqual(plan)
    expect((await listPlans(h.db, { ownerId: null })).map((p) => p.name)).toContain('Starter')

    const up = await updatePlan(h.db, plan.id, {
      name: 'Starter Plus',
      resources: { diskMb: 'unlimited', memoryMb: 2048 },
      caps: { addonDomains: 'unlimited' },
      shell: 'jailed',
      defaultMailboxQuotaMb: 1024,
    })
    expect(up.name).toBe('Starter Plus')
    expect(up.resources).toEqual({ ...plan.resources, diskMb: 'unlimited', memoryMb: 2048 })
    expect(up.caps).toEqual({ ...plan.caps, addonDomains: 'unlimited' })
    expect(up.shell).toBe('jailed')
    expect(up.defaultMailboxQuotaMb).toBe(1024)
    expect(await updatePlan(h.db, plan.id, {})).toEqual(up)

    expect(await code(createPlan(h.db, planInput(fl.id, { name: 'starter plus' })))).toBe('CONFLICT')
    expect(await code(updatePlan(h.db, plan.id, { resources: { diskMb: -1 } }))).toBe('VALIDATION')
    expect(await code(updatePlan(h.db, plan.id, { resources: { memoryMb: 0 } }))).toBe('VALIDATION')
    expect(await code(createPlan(h.db, planInput('00000000-0000-4000-8000-000000000000')))).toBe('NOT_FOUND')
    expect(await code(createPlan(h.db, { ...planInput(fl.id, { name: 'NoCaps' }), caps: undefined as never }))).toBe('VALIDATION')
    expect(await code(updatePlan(h.db, '00000000-0000-4000-8000-000000000000', { name: 'x' }))).toBe('NOT_FOUND')

    // in use: the feature list and the plan cannot go
    await seedAccount(h.db, plan.id)
    expect(await countAccountsOnPlan(h.db, plan.id)).toBe(1)
    expect(await code(deletePlan(h.db, plan.id))).toBe('CONFLICT')
    expect(await code(deleteFeatureList(h.db, fl.id))).toBe('CONFLICT')

    const spare = await createPlan(h.db, planInput(fl.id, { name: 'Spare' }))
    expect(await deletePlan(h.db, spare.id)).toBe(true)
    expect(await deletePlan(h.db, spare.id)).toBe(false)
  })
})

describe('accounts', () => {
  it('creates account, primary domain and owner login in one transaction', async () => {
    const plan = await seedPlan(h.db)
    const acc = await createAccount(h.db, accountInput(plan.id, { username: 'alice', primaryDomain: 'Alice.Example.COM' }))
    expect(acc).toMatchObject({ username: 'alice', primaryDomain: 'alice.example.com', home: '/home/alice', status: 'active', ownerId: null })
    expect(acc.uid).toBeGreaterThanOrEqual(20000)
    expect(acc.gid).toBe(acc.uid)
    expect(await getAccount(h.db, acc.id)).toEqual(acc)
    expect(await getAccountByUsername(h.db, 'ALICE')).toEqual(acc)
    const primary = await getDomainByName(h.db, 'alice.example.com')
    expect(primary).toMatchObject({ kind: 'primary', accountId: acc.id, docRoot: '/home/alice/public_html', parentId: null })
    const login = await findPrincipalByUsername(h.db, 'alice')
    expect(login).toMatchObject({ kind: 'user', accountId: acc.id, passwordHash: ARGON2 })
  })

  it('rolls everything back when any part fails, without reusing the burnt UID', async () => {
    const plan = await seedPlan(h.db)
    const ok = await seedAccount(h.db, plan.id, { primaryDomain: 'taken.example.com' })
    await createReseller(h.db, resellerInput('bobx'))
    const before = await countAccounts(h.db)
    // the owner login clashes with the reseller login after the UID, account and domain rows were written
    expect(await code(createAccount(h.db, accountInput(plan.id, { username: 'bobx' })))).toBe('CONFLICT')
    expect(await countAccounts(h.db)).toBe(before)
    expect(await getAccountByUsername(h.db, 'bobx')).toBeNull()
    const bob = await createAccount(h.db, accountInput(plan.id, { username: 'bob' }))
    expect(bob.uid).toBeGreaterThan(ok.uid + 1)
  })

  it('refuses a primary domain that overlaps another account, before any UID is used', async () => {
    const plan = await seedPlan(h.db)
    const owner = await seedAccount(h.db, plan.id, { primaryDomain: 'victim.example.net' })
    const [top] = await h.query<{ m: number }>('SELECT max(uid) AS m FROM uid_allocator')
    for (const name of ['VICTIM.example.net', 'shop.victim.example.net', 'www.victim.example.net', 'example.net']) {
      expect(await code(createAccount(h.db, accountInput(plan.id, { primaryDomain: name }))), name).toBe('CONFLICT')
    }
    const [after] = await h.query<{ m: number }>('SELECT max(uid) AS m FROM uid_allocator')
    expect(after?.m).toBe(top?.m)
    expect((await getAccount(h.db, owner.id))?.primaryDomain).toBe('victim.example.net')
  })

  it('allocates unique, monotonic UIDs across concurrent creations and never reuses them', async () => {
    const plan = await seedPlan(h.db)
    const [top] = await h.query<{ m: number }>('SELECT max(uid) AS m FROM uid_allocator')
    const maxBefore = Number(top?.m ?? 0)
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => seedAccount(h.db, plan.id, { username: `conc${i}` })))
    const uids = made.map((a) => a.uid).sort((a, b) => a - b)
    expect(new Set(uids).size).toBe(uids.length)
    expect(uids[0]).toBeGreaterThan(maxBefore)
    // no failures in the batch, so the block is contiguous
    expect(uids).toEqual(uids.map((_, i) => (uids[0] as number) + i))

    const seq = []
    for (const n of ['seqa', 'seqb', 'seqc']) seq.push((await seedAccount(h.db, plan.id, { username: n })).uid)
    expect(seq).toEqual([...seq].sort((a, b) => a - b))
    expect(seq[0]).toBeGreaterThan(uids[uids.length - 1] as number)

    const gone = made[0] as { id: string; username: string; uid: number }
    await markTerminating(h.db, gone.id)
    await deleteAccount(h.db, gone.id)
    const again = await seedAccount(h.db, plan.id, { username: gone.username })
    expect(again.uid).toBeGreaterThan(seq[2] as number)
    expect(again.uid).not.toBe(gone.uid)
    const raw = await allocateUid(h.db, 'loose')
    expect(raw).toBeGreaterThan(again.uid)
  })

  it.each([
    ['username', { username: 'Root' }],
    ['reserved username', { username: 'root' }],
    ['test* username', { username: 'testing' }],
    ['long username', { username: 'a'.repeat(17) }],
    ['username with dash', { username: 'a-b' }],
    ['injection in username', { username: 'a;rm -rf' }],
    ['domain', { primaryDomain: 'bad_domain.com' }],
    ['single-label domain', { primaryDomain: 'localhost' }],
    ['wildcard domain', { primaryDomain: '*.example.com' }],
    ['email', { contactEmail: 'not-an-email' }],
    ['ipv4', { ipv4: '999.1.1.1' }],
    ['ipv4 cidr', { ipv4: '192.0.2.0/24' }],
    ['ipv4 v6', { ipv4: '::1' }],
    ['shell', { shell: 'bash' as never }],
    ['homeBase traversal', { homeBase: '/home/../etc' }],
    ['homeBase relative', { homeBase: 'home' }],
    ['homeBase in a system tree', { homeBase: '/etc' }],
    ['homeBase under /var/lib', { homeBase: '/var/lib/mysql' }],
    ['argon2i hash', { passwordHash: ARGON2.replace('argon2id', 'argon2i') }],
    ['php ini server-owned', { php: php({ ini: { open_basedir: '/' } }) }],
    ['php memory above the plan', { php: php({ ini: { memory_limit: '2G' } }) }],
    ['plain password', { passwordHash: 'hunter2' }],
    ['plan id', { planId: 'x' }],
    ['php version', { php: php({ version: '8.3; rm' }) }],
    ['php handler', { php: php({ handler: 'mod_php' as never }) }],
    ['php ini key', { php: php({ ini: { 'memory_limit\n': '1' } }) }],
    ['php ini value', { php: php({ ini: { memory_limit: '1"\nextension=evil.so' } }) }],
  ])('rejects invalid %s', async (_what, over) => {
    const plan = await seedPlan(h.db)
    expect(await code(createAccount(h.db, accountInput(plan.id, over)))).toBe('VALIDATION')
  })

  it('rejects duplicate usernames case-insensitively, including against reseller logins', async () => {
    const plan = await seedPlan(h.db)
    await seedAccount(h.db, plan.id, { username: 'carol' })
    expect(await code(seedAccount(h.db, plan.id, { username: 'carol' }))).toBe('CONFLICT')
    await createReseller(h.db, {
      username: 'dave',
      passwordHash: ARGON2,
      acl: [],
      maxAccounts: 1,
      totalDiskMb: 'unlimited',
      totalBandwidthMb: 'unlimited',
      oversell: false,
      nameservers: [],
      delegatedIps: [],
    })
    expect(await code(seedAccount(h.db, plan.id, { username: 'dave' }))).toBe('CONFLICT')
  })

  it('suspend / unsuspend / terminate / delete', async () => {
    const plan = await seedPlan(h.db)
    const acc = await seedAccount(h.db, plan.id)
    const s = await suspendAccount(h.db, acc.id, 'abuse report #12')
    expect([s.status, s.suspendReason]).toEqual(['suspended', 'abuse report #12'])
    expect(await code(suspendAccount(h.db, acc.id, 'line\nbreak'))).toBe('VALIDATION')
    const u = await unsuspendAccount(h.db, acc.id)
    expect([u.status, u.suspendReason]).toEqual(['active', null])
    expect(await code(unsuspendAccount(h.db, acc.id))).toBe('PRECONDITION_FAILED')
    const t = await markTerminating(h.db, acc.id)
    expect(t.status).toBe('terminating')
    expect(await code(suspendAccount(h.db, acc.id, 'late'))).toBe('PRECONDITION_FAILED')
    expect(await code(suspendAccount(h.db, acc.id, ''))).toBe('VALIDATION')
    expect(await deleteAccount(h.db, acc.id)).toBe(true)
    expect(await getAccount(h.db, acc.id)).toBeNull()
    expect(await getDomainByName(h.db, acc.primaryDomain)).toBeNull()
    expect(await findPrincipalByUsername(h.db, acc.username)).toBeNull()
    expect(await code(suspendAccount(h.db, acc.id, 'gone'))).toBe('NOT_FOUND')
    expect(await deleteAccount(h.db, 'garbage')).toBe(false)
  })

  it('changes plan, owner and contact; lists by owner', async () => {
    const p1 = await seedPlan(h.db)
    const p2 = await seedPlan(h.db)
    const res = await createReseller(h.db, {
      username: 'eve',
      passwordHash: ARGON2,
      acl: ['create-account'],
      maxAccounts: 10,
      totalDiskMb: 100_000,
      totalBandwidthMb: 'unlimited',
      oversell: false,
      nameservers: [],
      delegatedIps: [],
    })
    const acc = await seedAccount(h.db, p1.id)
    expect((await changePlan(h.db, acc.id, p2.id)).planId).toBe(p2.id)
    expect(await code(changePlan(h.db, acc.id, '00000000-0000-4000-8000-000000000000'))).toBe('NOT_FOUND')
    expect((await changeOwner(h.db, acc.id, res.id)).ownerId).toBe(res.id)
    expect((await listAccounts(h.db, { ownerId: res.id })).map((a) => a.id)).toEqual([acc.id])
    expect((await listAccounts(h.db, { ownerId: null })).map((a) => a.id)).not.toContain(acc.id)
    const upd = await updateAccount(h.db, acc.id, { contactEmail: 'new@example.org', shell: 'jailed', ipv4: '198.51.100.7' })
    expect([upd.contactEmail, upd.shell, upd.ipv4]).toEqual(['new@example.org', 'jailed', '198.51.100.7'])
    expect(await code(updateAccount(h.db, acc.id, { ipv4: '198.51.100.7\n' }))).toBe('VALIDATION')
  })
})

describe('resellers', () => {
  it('CRUD, usage sums and delete protection', async () => {
    const r = await createReseller(h.db, {
      username: 'frank',
      passwordHash: ARGON2,
      acl: ['list-accounts', 'create-account', 'create-account'],
      maxAccounts: 3,
      totalDiskMb: 50_000,
      totalBandwidthMb: 'unlimited',
      oversell: false,
      nameservers: ['NS1.Frank.example'],
      delegatedIps: ['203.0.113.9'],
    })
    expect(r.acl).toEqual(['create-account', 'list-accounts'])
    expect(r.nameservers).toEqual(['ns1.frank.example'])
    expect(await getResellerByUsername(h.db, 'Frank')).toEqual(r)
    expect((await listResellers(h.db)).map((x) => x.username)).toContain('frank')
    expect(await code(createReseller(h.db, { ...r, username: 'frank2', passwordHash: ARGON2, acl: ['root-everything' as never] }))).toBe('VALIDATION')
    expect(await code(createReseller(h.db, { ...r, username: 'frank3', passwordHash: ARGON2, delegatedIps: ['10.0.0.0/8'] }))).toBe('VALIDATION')
    expect(await code(createReseller(h.db, { ...r, username: 'frank4', passwordHash: ARGON2, maxAccounts: -1 }))).toBe('VALIDATION')
    expect(await code(createReseller(h.db, { ...r, username: 'frank5', passwordHash: ARGON2, oversell: 'yes' as never }))).toBe('VALIDATION')
    expect(await code(createReseller(h.db, { ...r, username: 'Frank', passwordHash: ARGON2 }))).toBe('VALIDATION')
    expect(await code(createReseller(h.db, { ...r, username: 'frank', passwordHash: ARGON2 }))).toBe('CONFLICT')
    expect(await findPrincipalByUsername(h.db, 'frank5')).toBeNull() // nothing half-created

    const up = await updateReseller(h.db, r.id, { oversell: true, maxAccounts: 'unlimited', acl: ['allow-oversell'] })
    expect([up.oversell, up.maxAccounts, up.acl, up.username]).toEqual([true, 'unlimited', ['allow-oversell'], 'frank'])

    const small = await seedPlan(h.db, { ownerId: r.id, resources: { ...planInput('x').resources, diskMb: 1000, bandwidthMbMonth: 5000 } })
    const big = await seedPlan(h.db, { ownerId: r.id, resources: { ...planInput('x').resources, diskMb: 'unlimited' } })
    expect(await resellerUsage(h.db, r.id)).toEqual({ accounts: 0, diskMb: 0, bandwidthMb: 0 })
    await seedAccount(h.db, small.id, { ownerId: r.id })
    await seedAccount(h.db, small.id, { ownerId: r.id })
    expect(await resellerUsage(h.db, r.id)).toEqual({ accounts: 2, diskMb: 2000, bandwidthMb: 10_000 })
    const last = await seedAccount(h.db, big.id, { ownerId: r.id })
    expect(await resellerUsage(h.db, r.id)).toEqual({ accounts: 3, diskMb: 'unlimited', bandwidthMb: 'unlimited' })

    expect(await code(deleteReseller(h.db, r.id))).toBe('CONFLICT')
    for (const a of await listAccounts(h.db, { ownerId: r.id })) {
      await markTerminating(h.db, a.id)
      await deleteAccount(h.db, a.id)
    }
    expect(last.ownerId).toBe(r.id)
    expect(await deleteReseller(h.db, r.id)).toBe(true)
    expect(await getPlan(h.db, small.id)).toBeNull() // owned plans go with the reseller
    expect(await findPrincipalByUsername(h.db, 'frank')).toBeNull()
  })
})

describe('domains', () => {
  const addon = (accountId: string, home: string, name: string, over: Partial<NewDomain> = {}): NewDomain => ({
    accountId,
    name,
    kind: 'addon',
    parentId: null,
    docRoot: `${home}/${name.split('.')[0]}`,
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

  it('CRUD for addon, subdomain and alias', async () => {
    const plan = await seedPlan(h.db)
    const acc = await seedAccount(h.db, plan.id, { primaryDomain: 'main.example' })
    const shop = await createDomain(h.db, addon(acc.id, acc.home, 'Shop.Example'))
    expect(shop.name).toBe('shop.example')
    expect(await getDomain(h.db, shop.id)).toEqual(shop)
    const sub = await createDomain(h.db, addon(acc.id, acc.home, 'blog.shop.example', { kind: 'subdomain', parentId: shop.id, docRoot: `${acc.home}/blog` }))
    const primary = await getDomainByName(h.db, 'main.example')
    const alias = await createDomain(h.db, addon(acc.id, acc.home, 'main-alias.example', { kind: 'alias', parentId: primary?.id ?? null, docRoot: `${acc.home}/public_html` }))
    expect(await countDomainsByKind(h.db, acc.id)).toEqual({ primary: 1, addon: 1, alias: 1, subdomain: 1 })
    expect((await listDomains(h.db, { accountId: acc.id })).map((d) => d.name)).toEqual([
      'blog.shop.example',
      'main-alias.example',
      'main.example',
      'shop.example',
    ])

    const upd = await updateDomain(h.db, shop.id, {
      siteType: 'node',
      upstream: 'http://127.0.0.1:3000',
      wildcard: true,
      redirect: { to: 'https://shop.example/new', code: 301 },
      pathQuotaMb: 500,
      expiresAt: '2027-06-01T00:00:00.000Z',
    })
    expect(upd).toMatchObject({ siteType: 'node', upstream: 'http://127.0.0.1:3000', wildcard: true, pathQuotaMb: 500 })
    expect(await code(updateDomain(h.db, shop.id, { siteType: 'static' }))).toBe('VALIDATION') // still has an upstream
    expect((await updateDomain(h.db, shop.id, { siteType: 'static', upstream: null })).upstream).toBeNull()

    expect(await deleteDomain(h.db, shop.id)).toBe(true)
    expect(await getDomain(h.db, sub.id)).toBeNull() // children follow
    expect(await getDomain(h.db, alias.id)).not.toBeNull()
  })

  it('enforces case-insensitive server-wide uniqueness', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id)
    const b = await seedAccount(h.db, plan.id)
    await createDomain(h.db, addon(a.id, a.home, 'unique.example'))
    expect(await code(createDomain(h.db, addon(b.id, b.home, 'UNIQUE.Example')))).toBe('CONFLICT')
    expect(await code(createDomain(h.db, addon(a.id, a.home, 'unique.EXAMPLE')))).toBe('CONFLICT')
    expect(await code(createDomain(h.db, addon(b.id, b.home, a.primaryDomain.toUpperCase())))).toBe('CONFLICT')
    expect((await getDomainByName(h.db, 'UNIQUE.EXAMPLE'))?.accountId).toBe(a.id)
  })

  it.each([
    ['docRoot outside home', { docRoot: '/etc' }],
    ['docRoot is the home', { docRoot: '/home/HOME' }],
    ['docRoot traversal', { docRoot: '/home/HOME/../other' }],
    ['docRoot sibling prefix', { docRoot: '/home/HOMEx/site' }],
    ['primary via createDomain', { kind: 'primary' as const }],
    ['addon with parent', { parentId: '00000000-0000-4000-8000-000000000000' }],
    ['proxy without upstream', { siteType: 'proxy' as const }],
    ['php with upstream', { upstream: 'http://127.0.0.1:3000' }],
    ['upstream injection', { siteType: 'proxy' as const, upstream: 'http://127.0.0.1:3000; include /etc/passwd' }],
    ['upstream bad scheme', { siteType: 'proxy' as const, upstream: 'file:///etc/passwd' }],
    ['upstream bad port', { siteType: 'proxy' as const, upstream: 'http://127.0.0.1:99999' }],
    ['redirect injection', { redirect: { to: 'https://x.example/"\nreturn 200', code: 301 as const } }],
    ['redirect code', { redirect: { to: 'https://x.example/', code: 307 as never } }],
    ['redirect relative', { redirect: { to: '/path', code: 301 as const } }],
    ['negative quota', { pathQuotaMb: -1 }],
    ['bad expiry', { expiresAt: 'tomorrow' }],
  ])('rejects %s', async (_w, over) => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id)
    const fixed = Object.fromEntries(
      Object.entries(over).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/\/home\/HOME/g, a.home) : v]),
    )
    expect(await code(createDomain(h.db, addon(a.id, a.home, `r${Date.now()}${Math.floor(Math.random() * 1e6)}.example`, fixed)))).toMatch(
      /VALIDATION/,
    )
  })

  it('subdomain and alias parents are checked', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id, { primaryDomain: 'parent.example' })
    const b = await seedAccount(h.db, plan.id)
    const parent = await getDomainByName(h.db, 'parent.example')
    const pid = parent?.id ?? null
    expect(await code(createDomain(h.db, addon(a.id, a.home, 'blog.other.example', { kind: 'subdomain', parentId: pid })))).toBe('VALIDATION')
    expect(await code(createDomain(h.db, addon(b.id, b.home, 'x.parent.example', { kind: 'subdomain', parentId: pid })))).toBe('FORBIDDEN')
    expect(await code(createDomain(h.db, addon(a.id, a.home, 'x.parent.example', { kind: 'subdomain', parentId: null })))).toBe('VALIDATION')
    const sub = await createDomain(h.db, addon(a.id, a.home, 'x.parent.example', { kind: 'subdomain', parentId: pid }))
    expect(await code(createDomain(h.db, addon(a.id, a.home, 'alias-of-sub.example', { kind: 'alias', parentId: sub.id })))).toBe('VALIDATION')
  })

  it('renames the primary domain with its account and subdomains; refuses deleting it', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id, { primaryDomain: 'old-name.example' })
    const primary = await getDomainByName(h.db, 'old-name.example')
    const pid = primary?.id as string
    const sub = await createDomain(h.db, addon(a.id, a.home, 'blog.old-name.example', { kind: 'subdomain', parentId: pid }))
    const renamed = await renameDomain(h.db, pid, 'New-Name.example')
    expect(renamed.name).toBe('new-name.example')
    expect((await getAccount(h.db, a.id))?.primaryDomain).toBe('new-name.example')
    expect((await getDomain(h.db, sub.id))?.name).toBe('blog.new-name.example')
    expect(await code(renameDomain(h.db, sub.id, 'blog.elsewhere.example'))).toBe('VALIDATION')
    expect(await code(deleteDomain(h.db, pid))).toBe('PRECONDITION_FAILED')
    const other = await seedAccount(h.db, plan.id)
    expect(await code(renameDomain(h.db, pid, other.primaryDomain))).toBe('CONFLICT')
    expect(await getDomain(h.db, 'nope')).toBeNull()
  })

  it('rejects malformed and unknown account ids', async () => {
    expect(await code(createDomain(h.db, addon('not-a-uuid', '/home/x', 'q.example')))).toBe('VALIDATION')
    expect(await code(createDomain(h.db, addon('00000000-0000-4000-8000-000000000000', '/home/x', 'q.example')))).toBe('NOT_FOUND')
  })
})
