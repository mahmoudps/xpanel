import type { ComposerJobAction } from '../../../packages/os/src/composer-job-command.ts'

export interface ComposerJobTarget {
  accountId: string; domainId: string; username: string; uid: number; gid: number
  home: string; directory: string; phpVersion: string; family: 'debian' | 'rhel'; planDigest: string
  limits: { memoryMb: number; cpuPercent: number; maxProcesses: number; maxBytes: number; maxFiles: number }
}
/** Trusted startup evidence, never accepted from a request. The adapter remains absent until native qualification proves every property. */
export interface ComposerJobQualification {
  protocol: 1; native: true; helperSha256: string; sourcePolicyRevision: string
  descriptorConfined: true; numericAccountIdentity: true; lifecycleFencing: true
  isolatedStaging: true; offlineExecution: true; approvedArtifactDigests: true; resourceLimits: true
  durableSnapshotRecovery: true; completeOwnershipReadback: true; sanitizedOutput: true
}
export interface ComposerJobObservation {
  targetFingerprint: string; treeDigest: string; manifest: string | null; lock: string | null; installed: string | null
  uid: number; gid: number; ownershipVerified: boolean
  /** Populated only after checking every installed file against this reviewed artifact graph. */
  verifiedGraphDigest: string | null
}
export interface ComposerJobGraphPackage { name: string; version: string; development: boolean }
export interface ComposerJobResolution {
  beforeRevision: string; graphDigest: string; lockDigest: string; sourcePolicyRevision: string
  packages: ComposerJobGraphPackage[]
}
export interface ComposerJobSnapshot {
  transactionId: string; targetFingerprint: string; beforeRevision: string; snapshotDigest: string
  complete: true; durable: true; uid: number; gid: number
}
export interface ComposerJobRecovery {
  state: 'restored' | 'unchanged' | 'conflict' | 'unknown'
  observation: ComposerJobObservation | null
}
/**
 * No generic run callback can implement this port. The native adapter must pin the target descriptors,
 * stage an immutable complete preimage, resolve only approved digest-pinned dist artifacts, and journal
 * CAS publication of lock/vendor. Its fixed helper drops numeric UID/GID before PHP/Composer or project I/O;
 * it clears inherited credentials/config, disables network and child executables, applies resource bounds,
 * and emits only a bounded safe protocol receipt (never raw Composer stdout/stderr).
 *
 * prepare persists recoverable intent before publication. recover refuses unrelated postimage edits and
 * verifies the complete preimage after restore. Unfinished journals block new transactions/startup until
 * recovered. close retains the snapshot; it never silently deletes the recovery copy.
 */
export interface ComposerJobProvider {
  readonly qualification: ComposerJobQualification
  observe(target: Readonly<ComposerJobTarget>): Promise<ComposerJobObservation>
  resolve(target: Readonly<ComposerJobTarget>, action: ComposerJobAction, beforeRevision: string): Promise<ComposerJobResolution>
  prepare(input: { transactionId: string; target: Readonly<ComposerJobTarget>; action: ComposerJobAction; review: Readonly<ComposerJobResolution>; beforeRevision: string; argv: readonly string[] }): Promise<ComposerJobSnapshot>
  recover(transactionId: string, target: Readonly<ComposerJobTarget>): Promise<ComposerJobRecovery>
  close(transactionId: string, target: Readonly<ComposerJobTarget>, outcome: 'committed' | 'recovered'): Promise<{ released: boolean; snapshotRetained: boolean }>
}
