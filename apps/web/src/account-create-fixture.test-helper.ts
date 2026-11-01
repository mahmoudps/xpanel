import type { Account } from '@xpanel/core'
import type { AccountExecutionObservation } from '../../../packages/core/src/account-provisioning-contract.ts'

/** Synthetic browser-contract evidence only; this fixture does not qualify a hosting server. */
export const accountCreationPlanId = '10000000-0000-4000-8000-000000000001'

export function verifiedAccountCreationFixture(overrides: Partial<Account> = {}) {
  const username = overrides.username ?? 'alpha'
  const account: Account = {
    id: '10000000-0000-4000-8000-000000000003', username, uid: 20001, gid: 20001,
    home: '/home/' + username, primaryDomain: username + '.example.test', planId: accountCreationPlanId,
    ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10',
    shell: 'jailed', createdAt: '2026-10-30T00:00:00.000Z', ...overrides,
  }
  const checksum = 'd'.repeat(64)
  const observation: AccountExecutionObservation = {
    accountId: account.id, uid: account.uid, gid: account.gid, home: account.home, revision: 4,
    generationId: 7, generationChecksum: checksum, sourceChecksum: 'b'.repeat(64),
    cgroup: '/xpanel-' + account.uid + '.slice', services: ['nginx.service', 'php-fpm.service'],
    quota: { enforced: true, filesystem: 'ext4' },
    dns: { zone: account.primaryDomain, serial: 2026103001, authoritative: true },
    php: { status: 200, uid: account.uid, cgroup: '/xpanel-' + account.uid + '.slice' },
  }
  return {
    account,
    operation: { status: 'succeeded' as const, reference: null, resumedFromStep: 0, freshExecution: true, completedReplay: false },
    reconcile: {
      status: 'applied' as const,
      generation: { id: 7, checksum, status: 'active' as const, createdAt: '2026-10-30T00:00:00.000Z', error: null, actor: 'root:operator', testedAt: '2026-10-30T00:00:01.000Z', activatedAt: '2026-10-30T00:00:02.000Z' },
      filesCount: 12, durationMs: 3,
    },
    execution: { status: 'account_verified' as const, scope: 'account' as const, targetVerified: true, verificationRequired: false, observation },
  }
}

/** Current independently observed finalization; this call performs no new host application. */
export function reobservedAccountCreationFixture(overrides: Partial<Account> = {}) {
  const current = verifiedAccountCreationFixture(overrides)
  return { ...current, reconcile: null, operation: { ...current.operation, resumedFromStep: 3, freshExecution: false, completedReplay: false } }
}

/** Completed public phase 4 carries a historical receipt, never current verification. */
export function completedAccountCreationReplayFixture(overrides: Partial<Account> = {}) {
  const completed = verifiedAccountCreationFixture(overrides)
  return {
    ...completed, reconcile: null,
    operation: { ...completed.operation, resumedFromStep: 4, freshExecution: false, completedReplay: true },
    execution: { status: 'already_completed' as const, scope: 'account' as const, targetVerified: false, verificationRequired: true,
      replay: true, lastVerifiedObservation: completed.execution.observation },
  }
}
