export interface PreparedReleaseInput { readonly artifactPath:string; readonly expectedArchiveSha256:string }
export interface PreparedReleaseInfo {
  readonly schemaVersion:1; readonly kind:'xpanel-prepared-release'
  readonly artifactPath:string; readonly releaseRoot:string; readonly version:string; readonly archiveSha256:string; readonly manifestSha256:string
  readonly sourceFilesDigest:string; readonly treeSha256:string; readonly controlDbSchemaVersion:number
  readonly dependencyReceiptPath:string; readonly dependencyReceiptSha256:string
  readonly runtime:Readonly<{nodePath:string;nodeVersion:'26.12.1';nodeSha256:string;packageManagerPath:string;packageManagerSha256:string}>
}
/** Opaque live scope; structural objects, receipts and data projections never grant this capability. */
declare const preparedReleaseBrand:unique symbol
export interface PreparedReleaseCapability { readonly [preparedReleaseBrand]:true }
export function parsePreparedReleaseInput(value:unknown):Readonly<PreparedReleaseInput>
export function withPreparedRelease<T>(input:PreparedReleaseInput,callback:(capability:PreparedReleaseCapability)=>Promise<T>):Promise<T>
export function withExistingPreparedRelease<T>(input:PreparedReleaseInput,callback:(capability:PreparedReleaseCapability)=>Promise<T>):Promise<T>
export function assertPreparedReleaseCurrent(capability:unknown):Promise<void>
export function preparedReleaseInfo(capability:unknown):Readonly<PreparedReleaseInfo>
export function observeInstalledReleaseTree(root:string):Promise<Readonly<{entries:number;treeSha256:string}>>
