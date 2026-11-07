declare const coordinatorBrand: unique symbol
export interface CoordinatorOwnershipCapability { readonly [coordinatorBrand]: true }
export interface CoordinatorHelperIdentity {
  readonly version: string; readonly releaseRoot: string; readonly archivePath: string; readonly archiveSha256: string
  readonly manifestSha256: string; readonly sourceFilesDigest: string; readonly dependencyReceiptPath: string
  readonly dependencyReceiptSha256: string; readonly treeSha256: string
}
export interface CoordinatorOwnershipInfo {
  readonly unit: 'xpanel-lifecycle.service'; readonly nodePath: string; readonly nodeSha256: string
  readonly sourcePath: string; readonly unitSha256: string; readonly addonSha256: string; readonly publicKeySha256: string
  readonly receiptSha256: string; readonly helper: CoordinatorHelperIdentity
}
export const COORDINATOR_PATHS: Readonly<Record<'receipt'|'unit'|'enabled'|'privateKey'|'publicKey'|'addon', string>>
export function renderCoordinatorUnit(nodePath: string, releaseRoot: string): string
/** Parser result is data, not native authority. */
export function parseCoordinatorOwnership(value: unknown): Readonly<Record<string, unknown>>
export function coordinatorHelperFromPrepared(info: Readonly<Record<string, unknown>>, archivePath: string): CoordinatorHelperIdentity
export function withVerifiedCoordinatorOwnership<T>(callback: (capability: CoordinatorOwnershipCapability) => Promise<T>): Promise<T>
export function assertCoordinatorOwnershipCurrent(capability: unknown): Promise<void>
export function withVisibleCoordinatorOwnership<T>(capability: unknown, callback: () => T | Promise<T>): Promise<T>
export function coordinatorOwnershipInfo(capability: CoordinatorOwnershipCapability): CoordinatorOwnershipInfo
