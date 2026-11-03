import type { PreparedReleaseCapability } from './prepared-release.mjs'
export function installPreparedCoordinator(prepared: PreparedReleaseCapability): Promise<Readonly<{ status: 'registered'; unit: string; sourceVersion: string; started: boolean; ready: false; ipcQualificationRequired?: true }>>
