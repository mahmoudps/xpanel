import type { PreparedReleaseCapability } from './prepared-release.mjs'
export interface CoordinatorRotationRequest { readonly operationId: string; readonly mode: 'apply' | 'recover' | 'rollback' }
export function parseCoordinatorRotationRequest(input: unknown): Readonly<CoordinatorRotationRequest>
export function classifyCoordinatorRotationImage(actual: unknown, oldHash: unknown, nextHash: unknown): 'foreign' | 'next' | 'previous'
export function rotatePreparedCoordinator(input: unknown, prepared: PreparedReleaseCapability): Promise<Readonly<{ operationId: string; status: 'complete' | 'rolled_back'; helperVersion: string; ready: false; ipcQualificationRequired: true }>>
