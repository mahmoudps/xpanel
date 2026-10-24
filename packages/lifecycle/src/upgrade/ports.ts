import type { Limit } from '@xpanel/core'
import type { OsRelease } from '@xpanel/os'
import type { AuditPort, ClockPort, FsPort, HostPort } from '../ports.ts'
import type { PendingMigration } from './migrations.ts'

export interface UnitChange {
  unit: string
  /** reload is preferred; restart only when the reconciler says a reload cannot apply the change */
  needs: 'reload' | 'restart'
}

/** What must survive an upgrade untouched, per account. */
export interface AccountIdentity {
  username: string
  uid: number
  gid: number
  slice: string
  quotas: Record<string, Limit>
}

/** config_generations ids (bigint identity in the control DB). */
export type GenerationId = number

export interface ReconcilerPort {
  currentGeneration(): Promise<GenerationId>
  /** builds a generation from desired state, config-tests it and activates it */
  reconcile(reason: string): Promise<{ generationId: GenerationId; units: UnitChange[] }>
  /** re-activates an existing, already-tested generation */
  activate(generationId: GenerationId): Promise<{ units: UnitChange[] }>
  status(): Promise<{ converged: boolean; drift: string[] }>
  identities(): Promise<AccountIdentity[]>
}

/** Backed by the db package's expand-only runner, pointed at the release's migrations directory. */
export interface MigratorPort {
  currentSchema(): Promise<number>
  /** migrations shipped in `releaseDir` that the control DB has not applied yet, in order */
  pending(releaseDir: string): Promise<PendingMigration[]>
  /** applies them, each in its own transaction; refuses non-contract SQL that is not expand-only */
  apply(releaseDir: string): Promise<{ applied: string[]; version: number }>
}

export interface HealthPort {
  /** uid that actually served a request for the canary account's host, or null */
  servedUid(username: string): Promise<number | null>
  /** Native fenced service/process and private IPC readiness; this does not prove user authentication or MFA. */
  qualifiedControlPlane(): Promise<boolean>
}

export interface SystemProbePort {
  freeBytes(path: string): Promise<number>
  os(): Promise<OsRelease>
}

export interface TransferProbePort {
  activeCount(): Promise<number>
}

// Mirrors UPGRADE_STATUSES / UPGRADE_PHASES of the control DB `upgrades` table.
export type UpgradeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled_back'
export type UpgradePhase = 'precheck' | 'snapshot' | 'stage' | 'migrate' | 'switch' | 'health-check' | 'rollback'

/** The fields of an `upgrades` row the flow reads. */
export interface UpgradeRow {
  id: string
  fromVersion: string
  toVersion: string
  status: UpgradeStatus
  phase: UpgradePhase | null
}

/** Same operations as the db upgrades repository (create, setPhase, finish, latest). */
export interface UpgradeHistoryPort {
  latest(): Promise<UpgradeRow | null>
  create(input: { fromVersion: string; toVersion: string; actor: string; fromSchemaVersion: number }): Promise<{ id: string }>
  setPhase(id: string, phase: UpgradePhase, extra?: { snapshotPath?: string }): Promise<void>
  finish(
    id: string,
    outcome: { status: 'succeeded' | 'failed' | 'rolled_back'; healthReport: Record<string, unknown>; error: string | null; toSchemaVersion: number | null },
  ): Promise<void>
}

/**
 * Mandatory operational admission. These ports are test seams, not proof by structural typing.
 * Production must bind them to actual host exclusion, owned execution, authenticated artifacts,
 * current authority contracts and an enforced writer barrier through durable settlement.
 * withExclusive supplies exclusion only, never a durable retirement grant. This engine
 * retains its attention evidence and returns retirement_pending until that separate protocol
 * is qualified; a callback returning normally cannot authorize clearing the last barrier.
 */
export interface UpgradeSafetyPort {
  withExclusive<T>(callback: () => Promise<T>): Promise<T>
  assertOwnedExecution(panelUnits: readonly string[]): Promise<void>
  assertWritersQuiescent(panelUnits: readonly string[]): Promise<void>
  assertWriteBarrier(): Promise<void>
  verifyRelease(release: { version: string; schemaVersion: number; archivePath: string; sha256: string; bytes: number }): Promise<void>
  /** Extract only from the authenticated retained FD; return after source revalidation and FD close. */
  unpackVerifiedRelease(path: string, release: { version: string; schemaVersion: number; archivePath: string; sha256: string; bytes: number }): Promise<void>
  /** Reverify and fsync every staged file and directory before the engine may publish the tree. */
  verifyStagedRelease(path: string): Promise<void>
  /** Verify exact migration hashes, state/protocol contracts and reader compatibility, not schema integers alone. */
  assertCompatibility(input: { direction: 'forward' | 'rollback'; fromVersion: string; toVersion: string; currentSchema: number; targetSchema: number }): Promise<void>
  /** Mandatory WAL-safe DB/metadata backup, distinct from the state tar and never used to rewind authority. */
  snapshotControlPlane(snapshotPath: string): Promise<void>
  /** fsync the named regular file or directory; callers also sync containing directories. */
  syncPath(path: string): Promise<void>
}

export interface UpgradePorts {
  safety: UpgradeSafetyPort
  host: HostPort
  fs: FsPort
  reconciler: ReconcilerPort
  migrator: MigratorPort
  health: HealthPort
  system: SystemProbePort
  transfers: TransferProbePort
  history: UpgradeHistoryPort
  clock: ClockPort
  audit: AuditPort
}
