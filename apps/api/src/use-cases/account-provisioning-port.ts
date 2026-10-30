import type { HostAction, Id, Principal } from '@xpanel/core'
import type { ReconcileResult } from '@xpanel/agent'
import type { ProvisioningReconcileReply as SharedReply, ProvisioningReconcileRequest } from '../../../../packages/core/src/account-provisioning-contract.ts'
export { canonicalProvisioningIdentity, assertProvisioningReply, parseProvisioningReconcileRequest } from '../../../../packages/core/src/account-provisioning-contract.ts'
export type { ProvisioningAuthority, AccountExecutionObservation, ProvisioningReconcileRequest } from '../../../../packages/core/src/account-provisioning-contract.ts'

/** Structural compatibility boundary for the other existing lifecycle operations. */
export interface LifecycleReconcilePort {
  reconcile(options: { actor?: string; force?: boolean; scope?: { accountId?: Id | null; resellerId?: Id | null } }): Promise<ReconcileResult>
}
/** Existing non-provisioning effects; never construct this in the API transport adapter. */
export interface LifecycleEffectsPort { runAction(action: HostAction): Promise<void> }
export type ProvisioningReconcileReply = SharedReply<ReconcileResult>
export interface ProvisioningReconcilePort {
  reconcile(request: ProvisioningReconcileRequest, context: {
    readonly signal: AbortSignal
    /** Fresh authorization/database fence read, immediately before and after host work. */
    readonly assertAuthority: () => Promise<void>
  }): Promise<ProvisioningReconcileReply>
}
export type AuthorizeProvisioning = (input: { actor: Principal; accountId: Id | null; ownerId: Id | null }) => Promise<void>
