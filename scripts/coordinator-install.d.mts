import type { PreparedReleaseCapability } from './prepared-release.mjs'
import type { StrictOperationDatabaseOrigin } from '../packages/db/src/index.ts'

export function withCoordinatorDatabaseAuthority<T>(callback: (authority: Readonly<{
  origin: StrictOperationDatabaseOrigin
  rootId: string
  assertDatabaseAuthority(): Promise<void>
}>) => Promise<T>): Promise<T>

export function installPreparedCoordinator(prepared: PreparedReleaseCapability): Promise<Readonly<{ status: 'registered'; unit: string; sourceVersion: string; started: boolean; ready: false; ipcQualificationRequired?: true }>>
