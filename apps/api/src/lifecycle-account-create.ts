import { randomBytes, randomUUID } from 'node:crypto'
import { fail, validateDomainName, validateUsername } from '@xpanel/core'
import type { Account, PhpSettings } from '@xpanel/core'
import { createUserPrincipal, findPrincipalByUsername } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { accountTemplateZoneRecords, templateForNewAccount } from './acct-templates-workspace.ts'

export interface LifecycleAccountPorts {
  store: StateStore
  db: Db
  /** ExtendedFeaturesStore 'accounts/templates.json', null when nothing is saved. */
  readTemplates: () => Promise<unknown>
  hashPassword: (password: string) => Promise<string>
  php: PhpSettings
  /** The applyAccountConfiguration of POST /api/accounts: host apply plus revision readback, failing with verification required. */
  applyConfiguration: (caller: AuthenticatedCaller, account: Account, action: 'create', expectedRevision: number) => Promise<unknown>
}

/**
 * A root-owned account for transfers: same desired state, template zone and host apply as POST /api/accounts, a
 * shared IPv4 and a random password nobody knows, so the panel login stays closed until root resets it.
 */
export async function createLifecycleAccount(caller: AuthenticatedCaller, input: { username: string; primaryDomain: string; planId: string }, ports: LifecycleAccountPorts): Promise<Account> {
  if (caller.principal.kind !== 'root') return fail('FORBIDDEN', 'root access is required', { stateChanged: false })
  const username = validateUsername(input.username), primaryDomain = validateDomainName(input.primaryDomain)
  const passwordHash = await ports.hashPassword(randomBytes(32).toString('base64url'))
  const lease = await ports.store.getWriterLock().acquire()
  let expectedRevision: number, template: ReturnType<typeof templateForNewAccount>, nameservers: string[]
  try {
    if (await findPrincipalByUsername(ports.db, username) || await ports.store.getAccountByUsername(username)) return fail('CONFLICT', 'the account username is already reserved', { stateChanged: false })
    nameservers = (await ports.store.getServerSettings())?.nameservers ?? []
    template = templateForNewAccount(await ports.readTemplates(), input.planId, primaryDomain, nameservers)
    if (template && await ports.store.getDnsZone(primaryDomain)) return fail('CONFLICT', 'a DNS zone for this domain already exists, so the plan template cannot add its records', { stateChanged: false })
    expectedRevision = (await lease.assertFencingToken()).revision
  } finally { await lease.release() }
  const account = await ports.store.createAccount({ username, passwordHash, primaryDomain, planId: input.planId, ownerId: null, contactEmail: username + '@' + primaryDomain,
    ipAssignment: { mode: 'shared' }, shell: 'jailed', php: ports.php }, { expectedRevision })
  if (template) {
    try { await ports.store.saveDnsZone({ id: randomUUID(), name: account.primaryDomain, accountId: account.id, serial: 2026102201, records: accountTemplateZoneRecords(template, account, nameservers).map(record => ({ id: randomUUID(), ...record })) }, { expectedRevision: expectedRevision + 1 }) }
    catch { return fail('PRECONDITION_FAILED', 'the account exists but its template zone could not be saved', { stateChanged: true, verificationRequired: true }) }
  }
  await ports.applyConfiguration(caller, account, 'create', expectedRevision + (template ? 2 : 1))
  try { await createUserPrincipal(ports.db, { username: account.username, passwordHash, accountId: account.id, forcePasswordChange: true }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the account exists but its panel identity requires verification', { stateChanged: true, verificationRequired: true }) }
  return account
}
