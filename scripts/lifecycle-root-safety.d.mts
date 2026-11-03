import type { Db } from '../packages/db/src/index.ts'
import type { UpgradeLayout, ReleaseInfo, UpgradeSafetyPort } from '../packages/lifecycle/src/index.ts'
export const NATIVE_RUNTIME_ABI_PROBE: string
export function createNativeUpgradeSafety(options: { db: Db; actorId: string; operation: 'upgrade' | 'recover' | 'rollback' | 'uninstall' | 'adopt'; release?: ReleaseInfo; layout?: Partial<UpgradeLayout>; preparedRelease?: unknown }): Promise<UpgradeSafetyPort>
export function assertLifecycleRootSafetyHeld(capability: unknown, input: { effect: 'service.stop' | 'service.start' | 'service.observe' | 'barrier.retire' | 'filesystem.write' }): Promise<void>
export function getLifecycleRootSafetyInfo(capability: unknown): Readonly<{ operationId: string; kind: string; reference: string; coordinatorUnit: string; transitionBinding: unknown; recoveryOf: string | null; recoveryJournalSha256: string | null }>
export function observeLifecycleWriterService(capability: unknown, role: 'api' | 'agent', expected?: unknown): Promise<Readonly<{pid:number;uid:number;start:string;executable:string;source:string}>>
export function assertCurrentLifecycleEffect(effect: 'service.stop' | 'service.start' | 'service.observe' | 'barrier.retire' | 'filesystem.write'): Promise<void>
export interface LifecycleObservationScope {
  readonly operationId: string
  readonly kind: string
  readonly readOnly: true
  readonly signal: AbortSignal
  assertAuthority(): Promise<void>
  release(): void
}
/** Only capture inside the actual held native lifecycle scope; this grants no new effect. */
export function captureCurrentLifecycleObservationScope(): Promise<LifecycleObservationScope>
export function verifyCurrentLifecycleWriterReadiness(): Promise<boolean>
export function readNativeReleaseTrust(): Promise<Readonly<{signingKey:Buffer;keyId:string}>>
export function readNativeReleaseTrustIdentity(): Promise<Readonly<{keyId:string;signingKeyPath:string}>>
export function parseCoordinatorCgroup(text: string): string
export function parseLifecycleHead(value: unknown): Readonly<Record<string, unknown>>
export function admitSchemaTransition(input: Parameters<UpgradeSafetyPort['assertCompatibility']>[0] | null | undefined, facts: { liveSchema: number; manifestSchema: number | null; snapshotVerified: boolean }): boolean

export function executeNativeLifecycleCommand(request: unknown): Promise<unknown>

export function assertNativeLifecyclePrerequisites(): Promise<void>
export function assertNativeLifecycleRecoveryPrerequisites(): Promise<Readonly<{ transitionOperationId: string; mode: 'abort-before-transition' | 'rollback' | 'finish-publication' }>>
export function withNativeRecoveryPreparation<T>(callback: (prepared: import('./prepared-release.mjs').PreparedReleaseCapability) => Promise<T>): Promise<T>
export function assertLifecycleRecoveryObservationHeld(capability: unknown): Promise<void>
export function withNativeLifecycleRecoveryObservation<T>(callback: (scope: Readonly<{ operationId: string; kind: 'recover'; readOnly: true; signal: AbortSignal; assertCurrent(): Promise<void>;
  activeGenerationSource(): Promise<Readonly<{ generation: { id: number; status: 'active'; checksum: string }; snapshot: import('../packages/state/src/index.ts').StateSnapshot; sourceChecksum: string }>> }>) => Promise<T>): Promise<T>

/** Pure diagnostic only; no capture or authority is minted. */
export function isSettledControlPlaneProjection(value: unknown): boolean

export interface NativeDatabaseAdmission { readonly db: Db; readonly principal: Readonly<{id:string;username:string;kind:'root'}> }
export interface NativeClosedRecoveryObservation {
  readonly signal: AbortSignal
  assertCurrent(): Promise<void>
  withReadonlyDatabase<T>(work:(reader:import('../packages/db/src/index.ts').ReadonlyOperationDatabase)=>Promise<T>):Promise<T>
  activeGenerationSource():Promise<Readonly<{generation:{id:number;status:'active';checksum:string};snapshot:import('../packages/state/src/index.ts').StateSnapshot;sourceChecksum:string}>>
}
export function withNativeLifecycleDatabaseAdmission<T>(operation:'upgrade'|'recover', callback:(admitted:NativeDatabaseAdmission)=>Promise<T>,dispatch?:unknown):Promise<T>
export function withNativeClosedDatabaseRecoveryAdmission<T>(dispatch:unknown, observeHosted:(scope:NativeClosedRecoveryObservation)=>Promise<unknown>, execute:(admitted:NativeDatabaseAdmission)=>Promise<T>):Promise<T>
export function assertLifecycleBootstrapHeld(capability:unknown):Promise<void>
export function assertLifecycleBootstrapPromotion(initial:unknown,capability:unknown):Promise<void>
export function assertNativeClosedDatabaseObservationHeld(capability:unknown):Promise<void>
export function getNativeClosedDatabaseObservationInfo(capability:unknown):Readonly<{database:{file:string;device:string;inode:string;issuerId:string};operationId:string;reference:string;purpose:'closed-database-observation'}>
export function assertNativeClosedDatabaseRecoveryScopeHeld(scope:unknown):Promise<void>

/** Native-only issuance and exact interrupted-append repair. Parsed plans do not confer authority. */
export function assertLifecycleAuditIssuanceHeld(capability:unknown,plan:unknown):Promise<void>
export function getLifecycleAuditIssuanceInfo(capability:unknown):Readonly<Record<string,unknown>>
export function assertLifecycleIssuedAuditRepairHeld(capability:unknown):Promise<void>
export function getLifecycleIssuedAuditRepairInfo(capability:unknown):Readonly<{purpose:'issued-lifecycle-audit-repair';plan:import('../packages/db/src/index.ts').IssuedLifecycleAppendPlan}>
export function assertLifecycleIssuedAuditCompletionHeld(capability:unknown):Promise<void>
export function getLifecycleIssuedAuditCompletionInfo(capability:unknown):Readonly<{jobId:string;journalSha256:string;binding:import('../packages/db/src/index.ts').OperationIntentBinding;origin:import('../packages/db/src/index.ts').StrictOperationDatabaseOrigin;verified:import('../packages/db/src/index.ts').VerifiedOperationIntent}>
