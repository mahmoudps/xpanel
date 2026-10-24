import type { Db } from '../packages/db/src/index.ts'
import type { UpgradeLayout, ReleaseInfo, UpgradeSafetyPort } from '../packages/lifecycle/src/index.ts'
export function createNativeUpgradeSafety(options: { db: Db; actorId: string; operation: 'upgrade' | 'recover' | 'rollback' | 'uninstall' | 'adopt'; release?: ReleaseInfo; layout?: Partial<UpgradeLayout> }): Promise<UpgradeSafetyPort>
export function assertLifecycleRootSafetyHeld(capability: unknown, input: { effect: 'service.stop' | 'service.start' | 'service.observe' | 'barrier.retire' | 'filesystem.write' }): Promise<void>
export function getLifecycleRootSafetyInfo(capability: unknown): Readonly<{ operationId: string; kind: string; coordinatorUnit: string }>
export function observeLifecycleWriterService(capability: unknown, role: 'api' | 'agent', expected?: unknown): Promise<Readonly<{pid:number;uid:number;start:string;executable:string;source:string}>>
export function assertCurrentLifecycleEffect(effect: 'service.stop' | 'service.start' | 'service.observe' | 'barrier.retire' | 'filesystem.write'): Promise<void>
export function verifyCurrentLifecycleWriterReadiness(): Promise<boolean>
export function readNativeReleaseTrust(): Promise<Readonly<{signingKey:Buffer;keyId:string}>>
export function parseCoordinatorCgroup(text: string): string
export function parseLifecycleHead(value: unknown): Readonly<Record<string, unknown>>

export function executeNativeLifecycleCommand(request: unknown): Promise<unknown>

export function assertNativeLifecyclePrerequisites(): Promise<void>
