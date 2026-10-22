// Fixtures shared by this package's tests. Not exported from index.ts.
import type { Account, PhpSettings, Plan } from '@xpanel/core'
import type { Db } from './client.ts'
import { createAccount, type NewAccount } from './repos/accounts.ts'
import type { NewDomain } from './repos/domains.ts'
import { createFeatureList } from './repos/feature-lists.ts'
import { createPlan } from './repos/plans.ts'
import type { NewReseller } from './repos/resellers.ts'

/** Syntactically valid argon2id PHC string (not a real password). */
export const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'

export const php = (over: Partial<PhpSettings> = {}): PhpSettings => ({
  version: '8.3',
  handler: 'fpm',
  fpm: {
    mode: 'ondemand',
    maxChildren: 5,
    startServers: 1,
    minSpareServers: 1,
    maxSpareServers: 3,
    maxRequests: 500,
    processIdleTimeoutSec: 10,
  },
  ini: { memory_limit: '256M' },
  ...over,
})

export const planInput = (featureListId: string, over: Partial<Omit<Plan, 'id'>> = {}): Omit<Plan, 'id'> => ({
  name: 'Basic',
  ownerId: null,
  featureListId,
  resources: {
    diskMb: 10_240,
    bandwidthMbMonth: 'unlimited',
    ioReadBps: 50_000_000,
    ioWriteBps: 'unlimited',
    ioReadIops: 1000,
    ioWriteIops: 1000,
    memoryMb: 1024,
    maxProcesses: 100,
    cpuPercent: 'unlimited',
  },
  caps: {
    addonDomains: 5,
    aliasDomains: 'unlimited',
    subdomains: 10,
    mailboxes: 'unlimited',
    forwarders: 10,
    mailingLists: 0,
    ftpAccounts: 2,
    databases: 'unlimited',
    phpWorkers: 8,
  },
  dedicatedIp: false,
  shell: 'none',
  defaultMailboxQuotaMb: 'unlimited',
  ...over,
})

let seq = 0
const next = (): number => ++seq

export const seedPlan = async (db: Db, over: Partial<Omit<Plan, 'id'>> = {}): Promise<Plan> => {
  const n = next()
  const fl = await createFeatureList(db, { name: `Features ${n}`, ownerId: over.ownerId ?? null, disabled: [] })
  return createPlan(db, planInput(fl.id, { name: `Plan ${n}`, ...over }))
}

export const accountInput = (planId: string, over: Partial<NewAccount> = {}): NewAccount => {
  const n = next()
  return {
    username: `user${n}`,
    passwordHash: ARGON2,
    primaryDomain: `site${n}.example.com`,
    planId,
    ownerId: null,
    contactEmail: `owner${n}@example.net`,
    ipv4: '192.0.2.10',
    shell: 'none',
    php: php(),
    ...over,
  }
}

export const seedAccount = async (db: Db, planId: string, over: Partial<NewAccount> = {}) =>
  createAccount(db, accountInput(planId, over))

export const sha = (c: string): string => c.repeat(64).slice(0, 64)

export const resellerInput = (username: string, over: Partial<NewReseller> = {}): NewReseller => ({
  username,
  passwordHash: ARGON2,
  acl: [],
  maxAccounts: 'unlimited',
  totalDiskMb: 'unlimited',
  totalBandwidthMb: 'unlimited',
  oversell: false,
  nameservers: [],
  delegatedIps: [],
  ...over,
})

export const domainInput = (account: Pick<Account, 'id' | 'home'>, name: string, over: Partial<NewDomain> = {}): NewDomain => ({
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
