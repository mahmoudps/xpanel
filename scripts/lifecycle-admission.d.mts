export const LIFECYCLE_ROOT: string
export const LIFECYCLE_LOCK: string
export const LIFECYCLE_BARRIER: string
export function parseLifecycleBarrier(value: unknown): Readonly<Record<string, unknown>>
export function readLifecycleBarrier(): Promise<Readonly<Record<string, unknown>> | null>
export function isLifecycleManaged(): Promise<boolean>
export function assertLifecycleWritesAllowed(): Promise<void>
export function lifecycleAdmissionResponse(request: Request, options?: {surface?: 'api' | 'agent'}): Promise<Response | null>
export function withLifecycleWriterAdmission<T>(callback: () => T | Promise<T>): Promise<T>
export function assertLifecycleWriterAdmissionHeld(): Promise<void>
export function withLifecycleRecoveryObservationAdmission<T>(capability: unknown, callback: () => Promise<T>): Promise<T>
export function assertLifecycleRecoveryObservationAdmissionHeld(capability: unknown): Promise<void>
export function withLifecycleExclusiveAdmission<T>(capability: unknown, callback: () => T | Promise<T>): Promise<T>
export function assertLifecycleExclusivePhysicalHeld(capability: unknown): Promise<void>
export function withLifecycleBootstrapExclusiveAdmission<T>(capability:unknown,callback:()=>Promise<T>):Promise<T>
export function assertLifecycleBootstrapExclusivePhysicalHeld(capability:unknown):Promise<void>
export function withLifecyclePromotedExclusiveAdmission<T>(bootstrap:unknown,capability:unknown,callback:()=>Promise<T>):Promise<T>
export function assertLifecycleClosedDatabaseObservationHeld(capability:unknown):Promise<void>
export function getLifecycleClosedDatabaseObservationInfo(capability:unknown):Readonly<{database:{file:string;device:string;inode:string;issuerId:string};operationId:string;reference:string;purpose:'closed-database-observation'}>
export function bindLifecycleClosedDatabaseObservation(capability:unknown):Promise<void>
export function retireLifecycleClosedDatabaseObservation(capability:unknown):Promise<void>
export function verifyNativeWriterGeneration(capability: unknown, operationId: string): Promise<boolean>
export function startLifecycleWriterParticipant(role: 'api' | 'agent', options?: {onFence?: () => Promise<void>}): Promise<Readonly<{close():Promise<void>}>>
export function readLifecyclePublicStatus(): Promise<Readonly<{active:boolean;reference:unknown;phase:unknown;kind?:unknown}>>

export function awaitLifecycleWriterDrain(): Promise<void>
export function createLifecycleBackgroundResources<T>(callback: () => T): T

export function withInstallFinalizationExclusiveAdmission<T>(capability:unknown,callback:()=>Promise<T>):Promise<T>
export function assertInstallFinalizationExclusiveHeld(capability:unknown):Promise<void>
export function verifyInstallFinalizationParticipants(capability:unknown):Promise<true>

/** Same actual EX flock, before a writable DB or host guard is opened. No effect authority alone. */
export function assertInstallFinalizationExclusivePhysicalHeld(capability:unknown):Promise<void>
/** Observation alone never grants effect authority. */
export function observeNormalLifecycleParticipants(processes: readonly {role:'api'|'agent';pid:number;uid:number;start:string}[],probeId:string):Promise<true>
export function withAgentPrivateStateMigrationExclusiveAdmission<T>(capability:unknown,callback:()=>Promise<T>):Promise<T>
export function assertAgentPrivateStateMigrationExclusivePhysicalHeld(capability:unknown):Promise<void>
