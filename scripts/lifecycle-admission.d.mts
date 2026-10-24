export const LIFECYCLE_ROOT: string
export const LIFECYCLE_LOCK: string
export const LIFECYCLE_BARRIER: string
export function parseLifecycleBarrier(value: unknown): Readonly<Record<string, unknown>>
export function readLifecycleBarrier(): Promise<Readonly<Record<string, unknown>> | null>
export function isLifecycleManaged(): Promise<boolean>
export function assertLifecycleWritesAllowed(): Promise<void>
export function lifecycleAdmissionResponse(request: Request, options?: {surface?: 'api' | 'agent'}): Promise<Response | null>
export function withLifecycleWriterAdmission<T>(callback: () => T | Promise<T>): Promise<T>
export function withLifecycleExclusiveAdmission<T>(capability: unknown, callback: () => T | Promise<T>): Promise<T>
export function assertLifecycleExclusivePhysicalHeld(capability: unknown): Promise<void>
export function verifyNativeWriterGeneration(capability: unknown, operationId: string): Promise<boolean>
export function startLifecycleWriterParticipant(role: 'api' | 'agent', options?: {onFence?: () => Promise<void>}): Promise<Readonly<{close():Promise<void>}>>
export function readLifecyclePublicStatus(): Promise<Readonly<{active:boolean;reference:unknown;phase:unknown;kind?:unknown}>>

export function awaitLifecycleWriterDrain(): Promise<void>
export function createLifecycleBackgroundResources<T>(callback: () => T): T
