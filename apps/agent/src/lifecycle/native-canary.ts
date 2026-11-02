import { createHash, randomBytes } from 'node:crypto'
import { fail, type Account, type Domain } from '@xpanel/core'
import { latestActive } from '@xpanel/db'
import type { AccountIdentity } from '@xpanel/lifecycle'
import type { StateStore, StateAuthorityMetadata } from '@xpanel/state'
import { system } from '@xpanel/render'
import { captureCurrentLifecycleObservationScope, type LifecycleObservationScope } from '../../../../scripts/lifecycle-root-safety.mjs'
import { createNativeHeldAccountHttp, type NativeAccountHttpOptions } from '../account-provisioning-http.ts'
import type { HostEffectAuthority } from '../host-effect-authority.ts'
import { assertProvisioningProcessBinding } from '../account-provisioning-observer.ts'
import type { CanaryHttpProbeResult } from './upgrade-runner.ts'

export interface NativeLifecycleCanaryOptions extends Omit<NativeAccountHttpOptions, 'store'> {
  readonly store: Pick<StateStore, 'listDomains' | 'getAccount' | 'getAuthorityMetadata' | 'readSnapshot'>
}
const targetBrand = Symbol('native lifecycle canary target')
export interface LifecycleCanaryTarget extends AccountIdentity { readonly [targetBrand]: true }
export interface NativeCanarySelection { readonly username: string | null }
const refused: (reason: string) => never = reason => fail('PRECONDITION_FAILED', 'the scoped lifecycle account observation was not verified', { verificationRequired: true, reason })
const lifetime = (account: Account): string => JSON.stringify({ id: account.id, username: account.username, uid: account.uid, gid: account.gid,
  home: account.home, primaryDomain: account.primaryDomain, ownerId: account.ownerId, planId: account.planId, createdAt: account.createdAt })
const commit = (meta: StateAuthorityMetadata): string => JSON.stringify({ revision: meta.revision, fence: meta.fencingToken, commit: meta.committedLeaseId ?? null })
const primaryFor = (account: Account, domains: readonly Domain[]): Domain | undefined => {
  const matches = domains.filter(domain => domain.accountId === account.id && domain.kind === 'primary' && domain.name === account.primaryDomain)
  return matches.length === 1 ? matches[0] : undefined
}
const expiry = (domain: Domain): number => domain.expiresAt === null ? Infinity : Date.parse(domain.expiresAt)
const eligible = (account: Account, domains: readonly Domain[]): boolean => {
  const primary = primaryFor(account, domains)
  return account.status === 'active' && account.bandwidthLimitedMonth === undefined && primary !== undefined
    && primary.siteType === 'php' && primary.php.handler === 'fpm' && !primary.suspended && expiry(primary) > Date.now()
}
interface SelectionRecord { readonly accountId: string | null; readonly username: string | null; readonly lifetime: string | null }
interface TargetRecord { readonly operationId: string; readonly accountId: string; readonly username: string; readonly lifetime: string }

/** Concrete composition. No request-supplied authority, producer, target ID, URL or readiness flag. */
export function createNativeLifecycleCanary(options: NativeLifecycleCanaryOptions) {
  const exchange = createNativeHeldAccountHttp(options)
  const selections = new WeakMap<object, SelectionRecord>(), targets = new WeakMap<object, TargetRecord>()
  const baselines = new Map<string, string>()
  let operation: string | undefined, selected: SelectionRecord | undefined
  const scope = async (): Promise<LifecycleObservationScope> => {
    const actual = await captureCurrentLifecycleObservationScope()
    if (!['upgrade', 'recover'].includes(actual.kind)) { actual.release(); return refused('lifecycle_observation_purpose_denied') }
    if (operation !== actual.operationId) { operation = actual.operationId; selected = undefined; baselines.clear() }
    return actual
  }
  const readAccount = async (record: { accountId: string; username: string; lifetime: string }, authority: LifecycleObservationScope): Promise<Account> => {
    await authority.assertAuthority()
    const account = await options.store.getAccount(record.accountId, { username: record.username })
    await authority.assertAuthority()
    if (!account || lifetime(account) !== record.lifetime) return refused('canary_account_lifetime_changed')
    return account
  }
  return {
    /** Selection is metadata only. The actual safety scope must revalidate this opaque object before any flow effects. */
    async select(): Promise<NativeCanarySelection> {
      const snapshot = await options.store.readSnapshot()
      const candidates = snapshot.accounts.filter(account => eligible(account, snapshot.domains)).sort((a, b) => a.id.localeCompare(b.id))
      const account = candidates[0]
      if (snapshot.accounts.length && !account) return refused('active_primary_fpm_canary_required')
      const selection = Object.freeze({ username: account?.username ?? null })
      selections.set(selection, account ? { accountId: account.id, username: account.username, lifetime: lifetime(account) }
        : { accountId: null, username: null, lifetime: null })
      return selection
    },
    async assertSelectionCurrent(selection: NativeCanarySelection): Promise<void> {
      const authority = await scope()
      try {
        const record = selection && typeof selection === 'object' ? selections.get(selection) : undefined
        if (!record || (selected !== undefined && JSON.stringify(selected) !== JSON.stringify(record))) refused('unissued_or_changed_canary_selection')
        await authority.assertAuthority()
        const snapshot = await options.store.readSnapshot()
        await authority.assertAuthority()
        if (record.accountId === null) { if (snapshot.accounts.length) refused('empty_host_canary_selection_changed') }
        else {
          const account = snapshot.accounts.find(value => value.id === record.accountId)
          if (!account || lifetime(account) !== record.lifetime || !eligible(account, snapshot.domains)) refused('canary_selection_lifetime_changed')
          baselines.set(account.username, lifetime(account))
        }
        selected = record
        await authority.assertAuthority()
      } finally { authority.release() }
    },
    /** Native identities() supplies OS/quota-verified projections; bind them to current stored lifetimes under the same opaque operation. */
    async bindIdentities(identities: readonly AccountIdentity[]): Promise<LifecycleCanaryTarget[]> {
      const authority = await scope()
      try {
        if (selected === undefined) refused('canary_selection_not_admitted')
        await authority.assertAuthority()
        const snapshot = await options.store.readSnapshot()
        await authority.assertAuthority()
        const seen = new Set<string>(), result: LifecycleCanaryTarget[] = []
        for (const identity of identities) {
          const matches = snapshot.accounts.filter(account => account.username === identity.username), stored = matches[0]
          if (seen.has(identity.username) || matches.length !== 1 || !stored || stored.uid !== identity.uid || stored.gid !== identity.gid
            || identity.slice !== system.accountSliceName(stored.uid)) refused('canary_identity_projection_mismatch')
          seen.add(identity.username)
          const key = lifetime(stored), previous = baselines.get(stored.username)
          if (previous !== undefined && previous !== key) refused('account_lifetime_changed_during_lifecycle')
          const account = await options.store.getAccount(stored.id, { username: stored.username })
          await authority.assertAuthority()
          if (!account || lifetime(account) !== key) refused('canary_account_lifetime_changed')
          baselines.set(account.username, key)
          const marker: true = true
          const target: LifecycleCanaryTarget = Object.freeze({ ...identity, quotas: Object.freeze({ ...identity.quotas }), [targetBrand]: marker })
          targets.set(target, { operationId: authority.operationId, accountId: account.id, username: account.username, lifetime: key })
          result.push(target)
        }
        if (seen.size !== snapshot.accounts.length) refused('lifecycle_identity_inventory_changed')
        await authority.assertAuthority()
        return result
      } finally { authority.release() }
    },
    /** Bare usernames, copied JSON and targets from another operation never become capabilities. */
    async observe(target: unknown): Promise<CanaryHttpProbeResult> {
      const authority = await scope()
      try {
        const record = target && typeof target === 'object' ? targets.get(target) : undefined
        if (!record || record.operationId !== authority.operationId || selected?.accountId !== record.accountId) return refused('unissued_lifecycle_canary_target')
        const account = await readAccount(record, authority)
        const before = await options.store.getAuthorityMetadata(); await authority.assertAuthority()
        const snapshot = await options.store.readSnapshot(); await authority.assertAuthority()
        const after = await options.store.getAuthorityMetadata(); await authority.assertAuthority()
        const current = snapshot.accounts.find(value => value.id === account.id), primary = primaryFor(account, snapshot.domains)
        if (commit(before) !== commit(after) || snapshot.revision !== after.revision || !current || lifetime(current) !== record.lifetime
          || !eligible(account, snapshot.domains) || !primary) return refused('canary_source_snapshot_changed')
        const domainDeadline = expiry(primary), generation = await latestActive(options.db); await authority.assertAuthority()
        if (!generation || generation.status !== 'active') return refused('canary_active_generation_required')
        const manifest = await options.reconciler.journal.readManifest(generation.id); await authority.assertAuthority()
        if (!manifest || manifest.generationId !== generation.id || manifest.filesChecksum !== generation.checksum || manifest.stateChecksum !== snapshot.checksum) return refused('canary_current_generation_mismatch')
        const stateCommit = commit(after), signal = AbortSignal.any([authority.signal, AbortSignal.timeout(15000)])
        const guard = async (): Promise<void> => {
          if (signal.aborted || Date.now() >= domainDeadline) refused('lifecycle_canary_deadline_or_cancel')
          await authority.assertAuthority()
          await readAccount(record, authority)
          const meta = await options.store.getAuthorityMetadata(); await authority.assertAuthority()
          const active = await latestActive(options.db); await authority.assertAuthority()
          if (commit(meta) !== stateCommit || active?.id !== generation.id || active.checksum !== generation.checksum || active.status !== 'active'
            || signal.aborted || Date.now() >= domainDeadline) refused('lifecycle_canary_authority_or_source_changed')
        }
        const context: HostEffectAuthority = { readOnly: true, signal, assertAuthority: guard }
        const binding = createHash('sha256').update(JSON.stringify({ schemaVersion: 1, purpose: 'lifecycle.canary.http', operationId: authority.operationId,
          kind: authority.kind, target: record.lifetime, generationId: generation.id, filesChecksum: generation.checksum, sourceChecksum: snapshot.checksum })).digest('hex')
        const challenge = randomBytes(32).toString('hex')
        await guard(); await exchange.assertAvailable(account, context); await guard()
        const held = await exchange.open({ account, sourceChecksum: snapshot.checksum, binding, challenge }, context)
        let closed = false
        try {
          await guard(); await held.assertCurrent(); await guard()
          const observed = held.observedProcess
          assertProvisioningProcessBinding(observed, account, held.unit, held.mainPid)
          const uid = observed.uids[0], group = observed.cgroup.split('/').at(-2)
          if (held.requestBinding !== binding || held.challenge !== challenge || held.status !== 200 || held.pid !== observed.pid
            || uid === undefined || group === undefined || group !== system.accountSliceName(uid)) return refused('lifecycle_canary_observation_mismatch')
          await held.close(); closed = true
          await guard()
          return { httpStatus: held.status, servedByUid: uid, cgroupSlice: group, serviceActive: true }
        } finally { if (!closed) await held.close() }
      } finally { authority.release() }
    },
  }
}
