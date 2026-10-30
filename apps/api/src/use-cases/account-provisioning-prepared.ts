import { createHash } from 'node:crypto'
import { fail, type Account, type DnsRecord, type Plan, type Principal } from '@xpanel/core'
import { validateDnsZoneFile, type DnsZoneState, type NewAccount, type StateStore } from '@xpanel/state'
import { services } from '@xpanel/render'
import { accountTemplateZoneRecords, templateForNewAccount, type AccountTemplate } from '../acct-templates-workspace.ts'
import { canonicalProvisioningIdentity, type AuthorizeProvisioning } from './account-provisioning-port.ts'
import { FileProvisioningPreparationStore, type ProvisioningPreparationStore } from './provisioning-preparation.ts'

export interface PreparedAccountState {
  readonly account: Omit<NewAccount, 'passwordHash' | 'expectedRevision' | 'fencingToken'>
  readonly sourceRevision: number
  readonly operationKey: string
  readonly planIdentity: string
  readonly template: AccountTemplate | null
  readonly nameservers: readonly string[]
  readonly serial: number
}
export interface PreparedAccountRecord {
  readonly reference: string
  readonly requestIdentity: string
  readonly passwordHash: string
  readonly desiredState: PreparedAccountState
}
export const provisionActorKey = (actor: Principal): string => `${actor.kind}:${actor.id}`
export const provisioningRequestKey = (actor: Principal, key: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) fail('VALIDATION', 'a bounded explicit account provisioning idempotency key is required')
  return 'account.provision:v3:' + canonicalProvisioningIdentity([provisionActorKey(actor), key])
}

/** Invoke with authority.withLock bound to the existing StateStore writer mutex. */
export async function prepareAccountProvisioning(deps: {
  store: StateStore
  preparations: ProvisioningPreparationStore
  authorizeFresh: AuthorizeProvisioning
  readTemplates: () => Promise<unknown>
}, input: {
  actor: Principal
  idempotencyKey: string
  account: PreparedAccountState['account']
  /** Raw intent is HMAC-bound in private authority; never sent to jobs/logs. */
  credentialIntent: string
  preparePasswordHash: () => Promise<string>
  verifyCredentialIntent: (intent: string, passwordHash: string) => Promise<boolean>
}): Promise<{ preparationReference: string; requestIdentity: string }> {
  const operationKey = provisioningRequestKey(input.actor, input.idempotencyKey)
  const allowed = new Set(['username', 'primaryDomain', 'planId', 'ownerId', 'contactEmail', 'ipv4', 'ipAssignment', 'ipv6', 'extraIps', 'shell', 'homeBase', 'php', 'forcePasswordChange'])
  if (!input.account || Object.keys(input.account).some(key => !allowed.has(key))) fail('VALIDATION', 'account preparation contains unsupported authority fields')
  const requestIdentity = canonicalProvisioningIdentity(input.account)
  const result = await deps.preparations.prepare<PreparedAccountState>({
    actorKey: provisionActorKey(input.actor), idempotencyKey: operationKey,
    requestIdentity, credentialIntent: input.credentialIntent, preparePasswordHash: input.preparePasswordHash,
    verifyCredentialIntent: input.verifyCredentialIntent,
    prepareDesiredState: async () => {
      await deps.authorizeFresh({ actor: input.actor, accountId: null, ownerId: input.account.ownerId })
      const plan = await deps.store.getPlan(input.account.planId) ?? fail('NOT_FOUND', 'account plan is unavailable')
      if (plan.ownerId !== null && plan.ownerId !== input.account.ownerId) fail('FORBIDDEN', 'account plan belongs to another owner')
      const nameservers = (await deps.store.getServerSettings())?.nameservers ?? []
      const raw = await deps.readTemplates()
      const template = templateForNewAccount(raw, input.account.planId, input.account.primaryDomain, nameservers)
      if (await deps.store.getAccountByUsername(input.account.username) || await deps.store.getDnsZone(input.account.primaryDomain)) {
        fail('CONFLICT', 'account identity or DNS zone already exists before provisioning preparation', { stateChanged: false })
      }
      const now = new Date(), serial = Number(now.toISOString().slice(0, 10).replaceAll('-', '') + '01')
      return { account: input.account, sourceRevision: await deps.store.getRevision(), operationKey: provisioningRequestKey(input.actor, input.idempotencyKey), planIdentity: canonicalProvisioningIdentity(plan), template, nameservers, serial }
    },
  })
  await deps.authorizeFresh({ actor: input.actor, accountId: null, ownerId: input.account.ownerId })
  return { preparationReference: result.reference, requestIdentity: result.requestIdentity }
}

/** The credential directory is operator-configured and service-private, never a request field. */
export function createProvisioningPreparationAuthority(input: { store: StateStore; directory: string }): ProvisioningPreparationStore {
  return new FileProvisioningPreparationStore({ directory: input.directory, withLock: async work => {
    const lease = await input.store.getWriterLock().acquire()
    try {
      await lease.assertFencingToken()
      const result = await work()
      await lease.assertFencingToken()
      return result
    } finally { await lease.release() }
  } })
}

export async function assertPreparedSources(store: StateStore, prepared: PreparedAccountRecord, readTemplates: () => Promise<unknown>): Promise<void> {
  const desired = prepared.desiredState
  const plan: Plan | null = await store.getPlan(desired.account.planId)
  const nameservers = (await store.getServerSettings())?.nameservers ?? []
  const raw = await readTemplates()
  const template = templateForNewAccount(raw, desired.account.planId, desired.account.primaryDomain, nameservers)
  if (!plan || canonicalProvisioningIdentity(plan) !== desired.planIdentity
    || canonicalProvisioningIdentity(template) !== canonicalProvisioningIdentity(desired.template)
    || canonicalProvisioningIdentity(nameservers) !== canonicalProvisioningIdentity(desired.nameservers)) {
    fail('CONFLICT', 'saved provisioning plan, template or DNS authority changed; explicit recovery review is required', { verificationRequired: true })
  }
}

const stableId = (reference: string, purpose: string): string => {
  const b = createHash('sha256').update(JSON.stringify([reference, purpose])).digest().subarray(0, 16)
  b[6] = (b[6]! & 15) | 0x40; b[8] = (b[8]! & 63) | 0x80
  const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Exact deterministic zone IDs/bytes are pinned before the first zone write. */
export function preparedAccountZone(prepared: PreparedAccountRecord, account: Account): DnsZoneState {
  const d = prepared.desiredState
  const records: Omit<DnsRecord, 'id'>[] = d.template
    ? accountTemplateZoneRecords(d.template, account, d.nameservers)
    : services.defaultZoneRecords(account.primaryDomain, { ipv4: account.ipv4, ipv6: account.ipv6 ?? null,
      nameservers: [...(d.nameservers.length ? d.nameservers : ['ns1.xpanel.internal', 'ns2.xpanel.internal'])],
      mailHost: `mail.${account.primaryDomain}`, adminEmail: account.contactEmail, serial: d.serial })
      .filter(r => r.type !== 'SOA').map(r => ({ zone: account.primaryDomain, name: r.name, type: r.type as Exclude<services.ZoneRecordType, 'SOA'>, ttl: r.ttl, content: r.content, priority: r.priority }))
  return validateDnsZoneFile({ id: stableId(prepared.reference, 'zone'), name: account.primaryDomain, accountId: account.id, serial: d.serial,
    records: records.map((r, i) => ({ id: stableId(prepared.reference, `record:${i}:${canonicalProvisioningIdentity(r)}`), ...r })) })
}
