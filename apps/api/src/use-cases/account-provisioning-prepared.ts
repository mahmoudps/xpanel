import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { fail, type Account, type DnsRecord, type Plan, type Principal, type ProvisioningAuthorizationReference } from '@xpanel/core'
import { validateDnsZoneFile, type DnsZoneState, type NewAccount, type StateStore } from '@xpanel/state'
import { services } from '@xpanel/render'
import { accountTemplateZoneRecords, templateForNewAccount, type AccountTemplate } from '../acct-templates-workspace.ts'
import { canonicalProvisioningIdentity, type AuthorizeProvisioning } from './account-provisioning-port.ts'
import { FileProvisioningPreparationStore, type ProvisioningPreparationStore } from './provisioning-preparation.ts'

export type { ProvisioningAuthorizationReference } from '@xpanel/core'

export type MailAuthRecord = 'spf' | 'dmarc'
/** The spf, dkim and dmarc creation options, each 0 or 1 and on by default. DMARC needs both others; the zone omits what is off. */
export function parseMailAuthOptions(body: { spf?: unknown; dkim?: unknown; dmarc?: unknown }): MailAuthRecord[] {
  const [spf, dkim, dmarc] = [body.spf, body.dkim, body.dmarc].map(value => value ?? 1)
  if (![spf, dkim, dmarc].every(value => value === 0 || value === 1)) return fail('VALIDATION', 'spf, dkim and dmarc must be 0 or 1', { stateChanged: false })
  if (dmarc === 1 && (spf === 0 || dkim === 0)) return fail('VALIDATION', 'DMARC requires SPF and DKIM', { stateChanged: false, reason: 'dmarc_requires_spf_dkim' })
  return [...(spf === 0 ? ['spf' as const] : []), ...(dmarc === 0 ? ['dmarc' as const] : [])]
}
export interface PreparedAccountState {
  readonly account: Omit<NewAccount, 'passwordHash' | 'expectedRevision' | 'fencingToken'>
  readonly sourceRevision: number
  readonly operationKey: string
  readonly planIdentity: string
  readonly template: AccountTemplate | null
  readonly nameservers: readonly string[]
  readonly serial: number
  /** Records the creation request turned off in the new zone. */
  readonly omitMailAuth?: readonly MailAuthRecord[]
  /** Tweak Settings for the default zone, pinned with the preparation. */
  readonly zoneDefaults?: { serviceSubdomains: boolean; autodiscover: boolean; nameserverRecords: boolean }
  /** Legacy portable preparations omit this; the production Agent requires it before any effect. */
  readonly authorizationRef?: ProvisioningAuthorizationReference
}
export interface PreparedAccountRecord {
  readonly reference: string
  readonly requestIdentity: string
  readonly passwordHash: string
  readonly desiredState: PreparedAccountState
  /** The live credential of the latest verified request; authorizes retries after the original session ended. */
  readonly currentAuthorization?: unknown
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
  assertIdentityAvailable?: (account: PreparedAccountState['account']) => Promise<void>
}, input: {
  actor: Principal
  idempotencyKey: string
  account: PreparedAccountState['account']
  /** Raw intent is HMAC-bound in private authority; never sent to jobs/logs. */
  credentialIntent: string
  preparePasswordHash: () => Promise<string>
  verifyCredentialIntent: (intent: string, passwordHash: string) => Promise<boolean>
  authorizationRef?: ProvisioningAuthorizationReference
  omitMailAuth?: readonly MailAuthRecord[]
  zoneDefaults?: { serviceSubdomains: boolean; autodiscover: boolean; nameserverRecords: boolean }
}): Promise<{ preparationReference: string; requestIdentity: string }> {
  const operationKey = provisioningRequestKey(input.actor, input.idempotencyKey)
  const allowed = new Set(['username', 'primaryDomain', 'planId', 'ownerId', 'contactEmail', 'ipv4', 'ipAssignment', 'ipv6', 'extraIps', 'shell', 'homeBase', 'php', 'forcePasswordChange'])
  if (!input.account || Object.keys(input.account).some(key => !allowed.has(key))) fail('VALIDATION', 'account preparation contains unsupported authority fields')
  const requestIdentity = canonicalProvisioningIdentity(input.account)
  const result = await deps.preparations.prepare<PreparedAccountState>({
    actorKey: provisionActorKey(input.actor), idempotencyKey: operationKey,
    requestIdentity, credentialIntent: input.credentialIntent, preparePasswordHash: input.preparePasswordHash,
    verifyCredentialIntent: input.verifyCredentialIntent,
    ...(input.authorizationRef && { currentAuthorization: input.authorizationRef }),
    prepareDesiredState: async () => {
      await deps.authorizeFresh({ actor: input.actor, accountId: null, ownerId: input.account.ownerId })
      await deps.assertIdentityAvailable?.(input.account)
      const plan = await deps.store.getPlan(input.account.planId) ?? fail('NOT_FOUND', 'account plan is unavailable')
      if (plan.ownerId !== null && plan.ownerId !== input.account.ownerId) fail('FORBIDDEN', 'account plan belongs to another owner')
      const nameservers = (await deps.store.getServerSettings())?.nameservers ?? []
      const raw = await deps.readTemplates()
      const template = templateForNewAccount(raw, input.account.planId, input.account.primaryDomain, nameservers)
      if (await deps.store.getAccountByUsername(input.account.username) || await deps.store.getDnsZone(input.account.primaryDomain)) {
        fail('CONFLICT', 'account identity or DNS zone already exists before provisioning preparation', { stateChanged: false })
      }
      const now = new Date(), serial = Number(now.toISOString().slice(0, 10).replaceAll('-', '') + '01')
      return { account: input.account, sourceRevision: await deps.store.getRevision(), operationKey: provisioningRequestKey(input.actor, input.idempotencyKey), planIdentity: canonicalProvisioningIdentity(plan), template, nameservers, serial,
        ...(input.omitMailAuth?.length && { omitMailAuth: input.omitMailAuth }),
        ...(input.zoneDefaults && { zoneDefaults: input.zoneDefaults }),
        ...(input.authorizationRef && { authorizationRef: input.authorizationRef }) }
    },
  })
  await deps.authorizeFresh({ actor: input.actor, accountId: null, ownerId: input.account.ownerId })
  return { preparationReference: result.reference, requestIdentity: result.requestIdentity }
}

/** The credential directory is operator-configured and service-private, never a request field. */
export function createProvisioningPreparationAuthority(input: { store: StateStore; directory: string }): ProvisioningPreparationStore {
  return new FileProvisioningPreparationStore({ directory: input.directory,
    ...(process.platform === 'linux' && process.getuid && process.getgid ? { trustedStateRoot: {
      // The installed data root above the state directory is the one setgid 02770 directory.
      directory: dirname(input.store.rootDir), uid: process.getuid(), gid: process.getgid(),
    } } : {}), withLock: async work => {
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
      mailHost: `mail.${account.primaryDomain}`, adminEmail: account.contactEmail, serial: d.serial, ...d.zoneDefaults })
      .filter(r => r.type !== 'SOA').map(r => ({ zone: account.primaryDomain, name: r.name, type: r.type as Exclude<services.ZoneRecordType, 'SOA'>, ttl: r.ttl, content: r.content, priority: r.priority }))
  const omitted = (r: Omit<DnsRecord, 'id'>): boolean => r.type === 'TXT' && (d.omitMailAuth?.includes('spf') === true && r.name === '@' && r.content.includes('v=spf1') || d.omitMailAuth?.includes('dmarc') === true && r.name === '_dmarc')
  return validateDnsZoneFile({ id: stableId(prepared.reference, 'zone'), name: account.primaryDomain, accountId: account.id, serial: d.serial,
    records: records.filter(r => !omitted(r)).map((r, i) => ({ id: stableId(prepared.reference, `record:${i}:${canonicalProvisioningIdentity(r)}`), ...r })) })
}
