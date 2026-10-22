// Business rules the repositories enforce atomically, under locks, with core's rule functions:
// plan caps, reseller capacity, plan/feature-list ownership, domain name ownership, docroots,
// upstream targets, PHP caps and certificate ownership.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import type { Plan, ServerSettings } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { accountInput, domainInput, php, planInput, resellerInput, seedAccount, seedPlan } from '../testing.ts'
import { changeOwner, changePlan, createAccount, deleteAccount, getAccount, markTerminating, suspendAccount } from './accounts.ts'
import { createDatabase, createDatabaseUser, restoreDatabase, trashDatabase } from './databases.ts'
import { createDomain, getDomain, getDomainByName, renameDomain, updateDomain } from './domains.ts'
import { createFeatureList } from './feature-lists.ts'
import { createPlan, getPlan, updatePlan } from './plans.ts'
import { createReseller } from './resellers.ts'
import { createServiceUser, updateServiceUser } from './service-users.ts'
import { saveServerSettings } from './settings.ts'

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

let n = 0
const uniq = (prefix: string): string => `${prefix}${++n}`

const withCaps = (caps: Partial<Plan['caps']>, resources: Partial<Plan['resources']> = {}) => ({
  caps: { ...planInput('x').caps, ...caps },
  resources: { ...planInput('x').resources, ...resources },
})

describe('plans follow core rules and feature-list ownership', () => {
  it.each([
    ['memory below 64 MB', { resources: { ...planInput('x').resources, memoryMb: 32 } }],
    ['I/O below 1 MiB/s', { resources: { ...planInput('x').resources, ioReadBps: 1000 } }],
    ['CPU 0 %', { resources: { ...planInput('x').resources, cpuPercent: 0 } }],
    ['PHP workers above 1024', { caps: { ...planInput('x').caps, phpWorkers: 2000 } }],
    ['mailbox quota above the disk', { defaultMailboxQuotaMb: 20_000 }],
    ['unknown resource', { resources: { ...planInput('x').resources, gpu: 1 } as never }],
    ['name with a trailing space', { name: 'Basic ' }],
    ['negative cap', { caps: { ...planInput('x').caps, mailboxes: -1 } }],
  ])('refuses %s', async (_w, over) => {
    const fl = await createFeatureList(h.db, { name: uniq('FL '), ownerId: null, disabled: [] })
    expect(await code(createPlan(h.db, planInput(fl.id, { name: uniq('P'), ...over })))).toBe('VALIDATION')
  })

  it('a plan uses a root feature list or one of its own owner', async () => {
    const ra = await createReseller(h.db, resellerInput(uniq('fla')))
    const rb = await createReseller(h.db, resellerInput(uniq('flb')))
    const rootList = await createFeatureList(h.db, { name: uniq('Root '), ownerId: null, disabled: [] })
    const aList = await createFeatureList(h.db, { name: uniq('A '), ownerId: ra.id, disabled: [] })
    expect(await code(createPlan(h.db, planInput(aList.id, { name: uniq('P'), ownerId: rb.id })))).toBe('FORBIDDEN')
    expect(await code(createPlan(h.db, planInput(aList.id, { name: uniq('P'), ownerId: null })))).toBe('FORBIDDEN')
    const own = await createPlan(h.db, planInput(aList.id, { name: uniq('P'), ownerId: ra.id }))
    const shared = await createPlan(h.db, planInput(rootList.id, { name: uniq('P'), ownerId: rb.id }))
    expect(await code(updatePlan(h.db, shared.id, { featureListId: aList.id }))).toBe('FORBIDDEN')
    expect(await code(updatePlan(h.db, own.id, { resources: { memoryMb: 10 } }))).toBe('VALIDATION')
    expect((await getPlan(h.db, own.id))?.resources.memoryMb).toBe(1024)
  })
})

describe('accounts: plan ownership and reseller capacity', () => {
  it('an account is on a root plan or on its own reseller plan', async () => {
    const ra = await createReseller(h.db, resellerInput(uniq('own')))
    const rb = await createReseller(h.db, resellerInput(uniq('own')))
    const bPlan = await seedPlan(h.db, { ownerId: rb.id })
    expect(await code(createAccount(h.db, accountInput(bPlan.id, { ownerId: ra.id })))).toBe('FORBIDDEN')
    expect(await code(createAccount(h.db, accountInput(bPlan.id, { ownerId: null })))).toBe('FORBIDDEN')
    const acc = await createAccount(h.db, accountInput(bPlan.id, { ownerId: rb.id }))
    expect(await code(changeOwner(h.db, acc.id, ra.id))).toBe('FORBIDDEN')
    const rootPlan = await seedPlan(h.db)
    expect(await code(changePlan(h.db, (await seedAccount(h.db, rootPlan.id)).id, bPlan.id))).toBe('FORBIDDEN')
  })

  it('refuses accounts past maxAccounts, also when moved in', async () => {
    const r = await createReseller(h.db, resellerInput(uniq('max'), { maxAccounts: 2 }))
    const plan = await seedPlan(h.db)
    await createAccount(h.db, accountInput(plan.id, { ownerId: r.id }))
    await createAccount(h.db, accountInput(plan.id, { ownerId: r.id }))
    expect(await code(createAccount(h.db, accountInput(plan.id, { ownerId: r.id })))).toBe('LIMIT_EXCEEDED')
    const outsider = await seedAccount(h.db, plan.id)
    expect(await code(changeOwner(h.db, outsider.id, r.id))).toBe('LIMIT_EXCEEDED')
    expect((await getAccount(h.db, outsider.id))?.ownerId).toBeNull()
  })

  it('serialises concurrent creations under one reseller', async () => {
    const r = await createReseller(h.db, resellerInput(uniq('race'), { maxAccounts: 2 }))
    const plan = await seedPlan(h.db)
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => createAccount(h.db, accountInput(plan.id, { ownerId: r.id }))))
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(2)
  })

  it('keeps disk and bandwidth totals when overselling is off', async () => {
    const r = await createReseller(h.db, resellerInput(uniq('tot'), { totalDiskMb: 12_000, totalBandwidthMb: 'unlimited' }))
    const small = await seedPlan(h.db, { ownerId: r.id, ...withCaps({}, { diskMb: 5000 }) })
    const big = await seedPlan(h.db, { ownerId: r.id, ...withCaps({}, { diskMb: 11_000 }) })
    const huge = await seedPlan(h.db, { ownerId: r.id, ...withCaps({}, { diskMb: 'unlimited' }) })
    const a = await createAccount(h.db, accountInput(small.id, { ownerId: r.id }))
    expect(await code(createAccount(h.db, accountInput(huge.id, { ownerId: r.id })))).toBe('OVERSELL_BLOCKED')
    await createAccount(h.db, accountInput(small.id, { ownerId: r.id }))
    expect(await code(createAccount(h.db, accountInput(small.id, { ownerId: r.id })))).toBe('OVERSELL_BLOCKED')
    // 5000 + 11000 > 12000
    expect(await code(changePlan(h.db, a.id, big.id))).toBe('OVERSELL_BLOCKED')
    // editing the plan in use is checked too: 2 x 8000 > 12000, 2 x 6000 fits exactly
    expect(await code(updatePlan(h.db, small.id, { resources: { diskMb: 8000 } }))).toBe('OVERSELL_BLOCKED')
    expect((await getPlan(h.db, small.id))?.resources.diskMb).toBe(5000)
    expect((await updatePlan(h.db, small.id, { resources: { diskMb: 6000 } })).resources.diskMb).toBe(6000)
  })

  it('lets an overselling reseller go past its totals but never past maxAccounts', async () => {
    const r = await createReseller(h.db, resellerInput(uniq('over'), { totalDiskMb: 1000, oversell: true, maxAccounts: 2 }))
    const plan = await seedPlan(h.db, { ownerId: r.id, ...withCaps({}, { diskMb: 'unlimited' }) })
    await createAccount(h.db, accountInput(plan.id, { ownerId: r.id }))
    await createAccount(h.db, accountInput(plan.id, { ownerId: r.id }))
    expect(await code(createAccount(h.db, accountInput(plan.id, { ownerId: r.id })))).toBe('LIMIT_EXCEEDED')
  })

  it('refuses a plan change the domains do not fit, and deleting an account that is not terminating', async () => {
    const plan = await seedPlan(h.db)
    const acc = await seedAccount(h.db, plan.id)
    const fewWorkers = await seedPlan(h.db, withCaps({ phpWorkers: 4 }))
    const littleMemory = await seedPlan(h.db, withCaps({}, { memoryMb: 128 }))
    expect(await code(changePlan(h.db, acc.id, fewWorkers.id))).toBe('LIMIT_EXCEEDED')
    expect(await code(changePlan(h.db, acc.id, littleMemory.id))).toBe('VALIDATION')
    expect((await getAccount(h.db, acc.id))?.planId).toBe(plan.id)
    expect(await code(deleteAccount(h.db, acc.id))).toBe('PRECONDITION_FAILED')
    expect(await getAccount(h.db, acc.id)).not.toBeNull()
  })
})

describe('domains', () => {
  it('stop at the plan cap for each kind, also under concurrency', async () => {
    const plan = await seedPlan(h.db, withCaps({ addonDomains: 2, aliasDomains: 0, subdomains: 1 }))
    const acc = await seedAccount(h.db, plan.id, { primaryDomain: `${uniq('capped')}.example` })
    const results = await Promise.allSettled([1, 2, 3].map((i) => createDomain(h.db, domainInput(acc, `${uniq('addon')}-${i}.example`))))
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(2)
    const rejected = results.find((x) => x.status === 'rejected') as PromiseRejectedResult
    expect(isXpanelError(rejected.reason) && rejected.reason.code).toBe('LIMIT_EXCEEDED')
    const primary = await getDomainByName(h.db, acc.primaryDomain)
    const alias = domainInput(acc, `${uniq('alias')}.example`, { kind: 'alias', parentId: primary?.id ?? null, docRoot: `${acc.home}/public_html` })
    expect(await code(createDomain(h.db, alias))).toBe('LIMIT_EXCEEDED')
    await createDomain(h.db, domainInput(acc, `blog.${acc.primaryDomain}`, { kind: 'subdomain', parentId: primary?.id ?? null }))
    expect(await code(createDomain(h.db, domainInput(acc, `shop.${acc.primaryDomain}`, { kind: 'subdomain', parentId: primary?.id ?? null })))).toBe(
      'LIMIT_EXCEEDED',
    )
  })

  it('refuse names above, below or the www twin of a domain of another account', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id, { primaryDomain: 'shop.brand-a.example' })
    const b = await seedAccount(h.db, plan.id)
    for (const name of ['pay.shop.brand-a.example', 'www.shop.brand-a.example', 'brand-a.example', 'SHOP.brand-a.example']) {
      expect(await code(createDomain(h.db, domainInput(b, name, { docRoot: `${b.home}/takeover` }))), name).toBe('CONFLICT')
    }
    const primary = await getDomainByName(h.db, a.primaryDomain)
    const own = await createDomain(h.db, domainInput(a, 'pay.shop.brand-a.example', { kind: 'subdomain', parentId: primary?.id ?? null, docRoot: `${a.home}/pay` }))
    expect(own.accountId).toBe(a.id)
  })

  it.each([
    ['the mail directory', 'mail'],
    ['etc (mail passwd files)', 'etc/site'],
    ['ssl', 'ssl'],
    ['logs', 'logs/x'],
    ['a hidden directory', '.ssh'],
    ['a hidden subdirectory', 'public_html/.git'],
    ['traversal', 'public_html/../../other'],
  ])('refuse a docroot in %s', async (_w, rel) => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id)
    expect(await code(createDomain(h.db, domainInput(a, `${uniq('dr')}.example`, { docRoot: rel })))).toBe('VALIDATION')
    expect(await code(createDomain(h.db, domainInput(a, `${uniq('dr')}.example`, { docRoot: `${a.home}/${rel}` })))).toBe('VALIDATION')
  })

  it('resolve a relative docroot inside the home', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id)
    const d = await createDomain(h.db, domainInput(a, `${uniq('rel')}.example`, { docRoot: 'sites/rel' }))
    expect(d.docRoot).toBe(`${a.home}/sites/rel`)
  })

  it('aliases serve their target: same docroot, unsuspended primary or addon, and follow docroot changes', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id)
    const addon = await createDomain(h.db, domainInput(a, `${uniq('target')}.example`))
    const mk = (over = {}) => createDomain(h.db, domainInput(a, `${uniq('al')}.example`, { kind: 'alias', parentId: addon.id, docRoot: addon.docRoot, ...over }))
    expect(await code(mk({ docRoot: `${a.home}/elsewhere` }))).toBe('VALIDATION')
    const alias = await mk()
    expect(await code(mk({ parentId: alias.id, docRoot: alias.docRoot }))).toBe('VALIDATION')
    await updateDomain(h.db, addon.id, { docRoot: `${a.home}/moved` })
    expect((await getDomain(h.db, alias.id))?.docRoot).toBe(`${a.home}/moved`)
    expect(await code(updateDomain(h.db, alias.id, { docRoot: `${a.home}/x` }))).toBe('VALIDATION')
    await updateDomain(h.db, addon.id, { suspended: true })
    expect(await code(mk({ docRoot: `${a.home}/moved` }))).toBe('PRECONDITION_FAILED')
  })

  it('keep proxied sites off the panel, SSH, web backend, privileged and metadata targets', async () => {
    const settings: ServerSettings = {
      hostname: 'srv.example.net',
      nameservers: [],
      adminEmail: 'root@example.net',
      engine: 'apache',
      apacheMpm: 'itk',
      panelPort: 2087,
      sshPort: 2222,
      nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 4096, multiAccept: false, keepaliveTimeoutSec: 65 },
      apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 0, serverLimit: 100 },
      backendPort: 8080,
      backendTlsPort: 8443,
    }
    await saveServerSettings(h.db, settings)
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id)
    const proxy = (upstream: string) => createDomain(h.db, domainInput(a, `${uniq('px')}.example`, { siteType: 'proxy', upstream }))
    for (const bad of ['http://127.0.0.1:2087', 'https://[::1]:8443', 'http://localhost:8080', 'http://127.0.0.1:2222', 'http://127.0.0.1:443', 'http://localhost/', 'http://169.254.169.254/latest']) {
      expect(await code(proxy(bad)), bad).toBe('VALIDATION')
    }
    expect((await proxy('http://127.0.0.1:3000')).upstream).toBe('http://127.0.0.1:3000')
    expect((await proxy('https://backend.example.org/app')).upstream).toBe('https://backend.example.org/app')
  })

  it('keep path quotas inside the disk quota and PHP inside the plan caps', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id)
    const mk = (over = {}) => createDomain(h.db, domainInput(a, `${uniq('q')}.example`, over))
    expect(await code(mk({ pathQuotaMb: 10_241 }))).toBe('VALIDATION')
    expect(await code(mk({ pathQuotaMb: 0 }))).toBe('VALIDATION')
    expect((await mk({ pathQuotaMb: 10_240 })).pathQuotaMb).toBe(10_240)
    expect(await code(mk({ php: php({ fpm: { ...php().fpm, maxChildren: 9 } }) }))).toBe('LIMIT_EXCEEDED')
    expect(await code(mk({ php: php({ ini: { extension: 'evil.so' } }) }))).toBe('VALIDATION')
    const d = await mk()
    expect(await code(updateDomain(h.db, d.id, { php: php({ fpm: { ...php().fpm, maxChildren: 9 } }) }))).toBe('LIMIT_EXCEEDED')
  })

  it('attach only certificates of the same account', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id)
    const b = await seedAccount(h.db, plan.id)
    const [cert] = await h.query<{ id: string }>(
      `INSERT INTO certificates (account_id, names, source, not_after, cert_path, key_path)
       VALUES ($1, $2, 'upload', now() + interval '30 days', '/etc/xpanel/ssl/a.crt', '/etc/xpanel/ssl/a.key') RETURNING id`,
      [a.id, [a.primaryDomain]],
    )
    expect(await code(createDomain(h.db, domainInput(b, `${uniq('c')}.example`, { certificateId: cert?.id ?? null })))).toBe('FORBIDDEN')
    const own = await createDomain(h.db, domainInput(a, `${uniq('c')}.example`, { certificateId: cert?.id ?? null }))
    expect(own.certificateId).toBe(cert?.id)
    expect(await code(updateDomain(h.db, own.id, { certificateId: '00000000-0000-4000-8000-000000000000' }))).toBe('NOT_FOUND')
  })

  it('renames move subdomains, refuse foreign overlaps and need an active account for the primary', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id, { primaryDomain: 'alpha-site.example' })
    const other = await seedAccount(h.db, plan.id, { primaryDomain: 'gamma-site.example' })
    const primary = (await getDomainByName(h.db, 'alpha-site.example'))?.id as string
    const x = await createDomain(h.db, domainInput(a, 'x.alpha-site.example', { kind: 'subdomain', parentId: primary }))
    // the new primary name is currently a moving subdomain: parked first, so no unique clash midway
    const renamed = await renameDomain(h.db, primary, 'x.alpha-site.example')
    expect(renamed.name).toBe('x.alpha-site.example')
    expect((await getDomain(h.db, x.id))?.name).toBe('x.x.alpha-site.example')
    expect((await getAccount(h.db, a.id))?.primaryDomain).toBe('x.alpha-site.example')
    expect(await code(renameDomain(h.db, primary, 'shop.gamma-site.example'))).toBe('CONFLICT')

    const addon = await createDomain(h.db, domainInput(a, 'store-a.example'))
    const sub = await createDomain(h.db, domainInput(a, 'blog.store-a.example', { kind: 'subdomain', parentId: addon.id }))
    await renameDomain(h.db, addon.id, 'store-b.example')
    expect((await getDomain(h.db, sub.id))?.name).toBe('blog.store-b.example')
    expect(await code(renameDomain(h.db, addon.id, 'www.gamma-site.example'))).toBe('CONFLICT')

    await suspendAccount(h.db, other.id, 'billing')
    const otherPrimary = (await getDomainByName(h.db, 'gamma-site.example'))?.id as string
    expect(await code(renameDomain(h.db, otherPrimary, 'delta-site.example'))).toBe('PRECONDITION_FAILED')
  })
})

describe('terminating accounts', () => {
  it('take no new domains, logins, databases, plan or owner changes', async () => {
    const plan = await seedPlan(h.db)
    const other = await seedPlan(h.db)
    const r = await createReseller(h.db, resellerInput(uniq('term')))
    const a = await seedAccount(h.db, plan.id, { username: uniq('term') })
    await markTerminating(h.db, a.id)
    const login = { accountId: a.id, login: `x@${a.primaryDomain}`, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: '', passwordHash: 'h' }
    for (const [what, p] of [
      ['domain', createDomain(h.db, domainInput(a, `${uniq('late')}.example`))],
      ['service user', createServiceUser(h.db, login)],
      ['database', createDatabase(h.db, { accountId: a.id, name: `${a.username}_late` })],
      ['database user', createDatabaseUser(h.db, { accountId: a.id, name: `${a.username}_late`, authString: `*${'A1'.repeat(20)}` })],
      ['plan change', changePlan(h.db, a.id, other.id)],
      ['owner change', changeOwner(h.db, a.id, r.id)],
    ] as const) {
      expect(await code(p), what).toBe('PRECONDITION_FAILED')
    }
    expect(await deleteAccount(h.db, a.id)).toBe(true)
  })
})

describe('service users and databases count against the plan', () => {
  it('mailboxes and FTP logins stop at their caps, also when a service is switched on later', async () => {
    const plan = await seedPlan(h.db, withCaps({ mailboxes: 1, ftpAccounts: 1 }, { diskMb: 2048 }))
    const a = await seedAccount(h.db, plan.id)
    const base = { accountId: a.id, mailboxQuotaMb: 1024, ftpDir: '', passwordHash: '{ARGON2ID}x' }
    await createServiceUser(h.db, { ...base, login: `one@${a.primaryDomain}`, services: { email: true, ftp: false, webdisk: false } })
    expect(await code(createServiceUser(h.db, { ...base, login: `two@${a.primaryDomain}`, services: { email: true, ftp: false, webdisk: false } }))).toBe(
      'LIMIT_EXCEEDED',
    )
    const ftp = await createServiceUser(h.db, { ...base, login: `ftp@${a.primaryDomain}`, services: { email: false, ftp: true, webdisk: false } })
    expect(await code(updateServiceUser(h.db, ftp.id, { services: { email: true, ftp: true, webdisk: false } }))).toBe('LIMIT_EXCEEDED')
    expect(await code(createServiceUser(h.db, { ...base, login: `web@${a.primaryDomain}`, services: { email: false, ftp: false, webdisk: true }, mailboxQuotaMb: 4096 }))).toBe(
      'VALIDATION',
    )
    expect(await code(createServiceUser(h.db, { ...base, login: `a+b@${a.primaryDomain}`, services: { email: false, ftp: false, webdisk: true } }))).toBe(
      'VALIDATION',
    )
    expect(await code(createServiceUser(h.db, { ...base, login: `k@${a.primaryDomain}`, services: { email: false, ftp: true, webdisk: true }, ftpDir: '.ssh' }))).toBe(
      'VALIDATION',
    )
  })

  it('databases stop at their cap; the trash frees a slot; core naming applies', async () => {
    const plan = await seedPlan(h.db, withCaps({ databases: 1 }))
    const a = await seedAccount(h.db, plan.id, { username: uniq('dbcap') })
    const first = await createDatabase(h.db, { accountId: a.id, name: `${a.username}_one` })
    expect(await code(createDatabase(h.db, { accountId: a.id, name: `${a.username}_two` }))).toBe('LIMIT_EXCEEDED')
    await trashDatabase(h.db, first.id)
    await createDatabase(h.db, { accountId: a.id, name: `${a.username}_two` })
    expect(await code(restoreDatabase(h.db, first.id))).toBe('LIMIT_EXCEEDED')
    expect(await code(createDatabase(h.db, { accountId: a.id, name: `${a.username}__x` }))).toBe('VALIDATION')
    expect(await code(createDatabaseUser(h.db, { accountId: a.id, name: `${a.username}_${'u'.repeat(32)}`, authString: `*${'A1'.repeat(20)}` }))).toBe('VALIDATION')
  })
})
