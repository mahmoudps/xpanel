import { assertAcl, fail, type Account, type Principal } from '@xpanel/core'
import { parseProvisioningCheckpointObservation } from '../../../../packages/core/src/account-provisioning-contract.ts'
import { findPrincipalByAccountId, getDurableJob, latestActive, type Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { canonicalProvisioningIdentity, type AccountExecutionObservation, type ProvisioningAuthority } from './account-provisioning-port.ts'
import { assertPreparedSources, type PreparedAccountRecord } from './account-provisioning-prepared.ts'

export type AuthorizeProvisioningTransaction = (db: Db, input: {
  actor: Principal; planId: string; reference: unknown
}) => Promise<void>

/** Enable only this operation's prepared principal at the admitted database transaction's linearization. */
export async function activatePreparedProvisioningPrincipal(input: {
  db: Db; store: StateStore; actor: Principal; account: Account; prepared: PreparedAccountRecord
  jobId: string; workerId: string; fencingToken: number; requestFingerprint: string; expectedActor: string; principalId: string
  proof: AccountExecutionObservation; recordedExecution: AccountExecutionObservation; recordedAuthority: ProvisioningAuthority
  readTemplates: () => Promise<unknown>; authorizeCredential: AuthorizeProvisioningTransaction
}): Promise<void> {
  const refused = (): never => fail('PRECONDITION_FAILED', 'prepared account sign-in activation requires verification', {
    stateChanged: true, verificationRequired: true,
  })
  // Public snapshots enter their own authority barrier. Capture before acquiring the writer,
  // then bind this exact checksum/epoch to the held lease; never assemble them at different instants.
  const snapshot = await input.store.readSnapshot()
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.checksum !== input.proof.sourceChecksum
    || snapshot.revision !== input.proof.revision) return refused()
  // Keep the established StateStore -> application DB lock order. No callback below may acquire
  // this writer lease again or use the outer DB runner from inside its admitted transaction.
  const stateLease = await input.store.getWriterLock().acquire()
  const assertSourceEpoch = async (): Promise<void> => {
    const authority = await stateLease.assertFencingToken()
    if (authority.revision !== snapshot.revision) return refused()
  }
  try {
    await assertSourceEpoch()
    await input.db.transaction(async tx => {
      // This callback starts only AFTER the DB writer queue. Clocks/credential reads outside it
      // cannot authorize an enable operation that sat queued past revocation or lease expiry.
      await assertSourceEpoch()
      await assertPreparedSources(input.store, input.prepared, input.readTemplates)
      const account = await input.store.getAccount(input.account.id)
      if (!account || canonicalProvisioningIdentity(account) !== canonicalProvisioningIdentity(input.account)) return refused()
      if (input.actor.kind === 'reseller') {
        if (account.ownerId !== input.actor.id) return refused()
        assertAcl(input.actor, await input.store.getReseller(input.actor.id), 'create-account')
      } else if (input.actor.kind !== 'root') return refused()
      const generation = await latestActive(tx)
      if (!generation || generation.id !== input.proof.generationId || generation.checksum !== input.proof.generationChecksum) return refused()

      const job = await getDurableJob(tx, input.jobId)
      if (!job || job.kind !== 'account.provision' || job.actor !== input.expectedActor || job.status !== 'running' || job.leaseOwner !== input.workerId || job.fencingToken !== input.fencingToken
        || (job.accountId !== null && job.accountId !== account.id) || job.idempotencyKey !== input.prepared.desiredState.operationKey
        || job.requestFingerprint !== input.requestFingerprint || job.cancelRequested || job.needsAttention
        || !job.completedSteps.includes('reconcile_host') || !job.completedSteps.includes('principal_activation_intent')) return refused()
      const expires = Date.parse(job.leaseExpiresAt ?? '')
      const assertCurrentLease = (): void => { if (!Number.isFinite(expires) || expires <= Date.now()) return refused() }
      assertCurrentLease()
      const checkpoint = job.checkpointData
      let recorded: ReturnType<typeof parseProvisioningCheckpointObservation>
      try { recorded = parseProvisioningCheckpointObservation(checkpoint.observedContext) } catch { return refused() }
      if (checkpoint.accountId !== account.id || checkpoint.username !== account.username || checkpoint.uid !== account.uid
        || checkpoint.gid !== account.gid || checkpoint.home !== account.home || checkpoint.ownerId !== account.ownerId
        || checkpoint.planId !== account.planId || checkpoint.principalId !== input.principalId
        || checkpoint.preparationReference !== input.prepared.reference
        || checkpoint.preparationIdentity !== canonicalProvisioningIdentity(input.prepared.desiredState)
        || checkpoint.generationId !== input.proof.generationId
        || canonicalProvisioningIdentity(recorded.request.authority) !== canonicalProvisioningIdentity(input.recordedAuthority)
        || canonicalProvisioningIdentity(recorded.execution) !== canonicalProvisioningIdentity(input.recordedExecution)) return refused()

      await input.authorizeCredential(tx, { actor: input.actor, planId: account.planId, reference: input.prepared.currentAuthorization ?? input.prepared.desiredState.authorizationRef })
      const principal = await findPrincipalByAccountId(tx, account.id)
      if (!principal || principal.id !== input.principalId || principal.kind !== 'user' || principal.username !== account.username
        || principal.accountId !== account.id || principal.passwordHash !== input.prepared.passwordHash
        || (checkpoint.principalActivated === true && principal.disabled)) return refused()
      await assertSourceEpoch()
      assertCurrentLease()
      if (principal.disabled) {
        // setPrincipalDisabled starts its own transaction. The enable branch here is deliberately
        // inside the already-admitted transaction, with identity predicates and no nested queue.
        const changed = await tx.query<{ id: string }>(`UPDATE principals SET disabled = 0, updated_at = $1
          WHERE id = $2 AND kind = 'user' AND account_id = $3 AND username = $4 AND password_hash = $5 AND disabled = 1 RETURNING id`,
        [new Date().toISOString(), principal.id, account.id, account.username, input.prepared.passwordHash])
        if (changed.length !== 1 || changed[0]!.id !== principal.id) return refused()
      }
      await assertSourceEpoch()
      await input.authorizeCredential(tx, { actor: input.actor, planId: account.planId, reference: input.prepared.currentAuthorization ?? input.prepared.desiredState.authorizationRef })
      assertCurrentLease()
    })
  } finally { await stateLease.release() }
}
