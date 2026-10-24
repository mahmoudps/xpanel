import type { createHmac } from 'node:crypto'

/** Runtime validation accepts only positive safe integers below these hard ceilings. */
export interface ReleaseVerificationBounds {
  readonly compressedBytes: number
  readonly tarBytes: number
  readonly fileBytes: number
  readonly manifestBytes: number
  readonly metadataBytes: number
  readonly members: number
  readonly pathBytes: number
  readonly depth: number
  readonly jsonDepth: number
  readonly jsonTokens: number
}
export const RELEASE_VERIFICATION_LIMITS: Readonly<ReleaseVerificationBounds>
export const REQUIRED_RELEASE_ENTRYPOINTS: readonly string[]
export const REQUIRED_SYSTEMD_UNITS: readonly string[]
export const REQUIRED_ROOT_FILES: readonly string[]
export const REQUIRED_LIFECYCLE_CONTROL_FILES: readonly string[]
export const DESIGN_REFERENCE_INPUTS: Readonly<{ directories: readonly string[]; files: readonly string[] }>

export class ReleaseVerificationError extends Error {
  constructor(code: string, message: string, cause?: unknown)
  code: string
  uncertain?: true
  archiveSha256?: string
  stagedAt?: string
  stagingRetained?: true
}

export interface ReleaseManifestFile {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly mode: number
  readonly owner: 'root'
  readonly group: 'root'
}
export interface ReleaseSystemdUnit {
  readonly name: string
  readonly execStart: string
  readonly user: 'root' | 'xpanel'
  readonly group: 'xpanel-agent' | 'xpanel'
  readonly supplementaryGroups: 'xpanel' | 'xpanel-agent'
  readonly umask: '0007'
  readonly runtimeDirectory: string | null
  readonly runtimeDirectoryMode: string | null
  readonly runtimeDirectoryPreserve: string | null
  readonly noNewPrivileges: string | null
  readonly path: string
  readonly sha256: string
}
export interface ReleaseManifestCore {
  readonly schemaVersion: 1
  readonly version: string
  readonly controlDbSchemaVersion: number
  readonly runtime: Readonly<{
    nodeVersion: string
    packageManager: string
    typescriptVersion: string
    executionMode: 'node-strip-types-source'
  }>
  readonly target: Readonly<{ os: 'linux'; arch: 'x64' }>
  readonly entrypoints: Readonly<{ api: string; agent: string; cli: string; web: string }>
  readonly sourcePolicy: Readonly<{
    excludedDesignReferences: Readonly<{ directories: readonly string[]; files: readonly string[] }>
    sourceClosure: Readonly<{ checkedSources: number; checkedImports: number }>
  }>
  readonly systemdUnits: readonly ReleaseSystemdUnit[]
  readonly migrations: readonly Readonly<{ version: number; name: string; path: string; sha256: string }>[]
  readonly webAssets: readonly Readonly<{ path: string; sha256: string; bytes: number }>[]
  readonly lockfileSha256: string
  readonly sbomSha256: string
  readonly totalUnpackedBytes: number
  readonly files: readonly ReleaseManifestFile[]
}
export interface ReleaseManifest extends ReleaseManifestCore {
  readonly payloadSha256: string
  readonly signature: Readonly<{ algorithm: 'hmac-sha256'; keyId: string; payloadSha256: string; mac: string }>
}
export interface ReleaseArchiveEntry {
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly sha256: string
  readonly bytes: number
  readonly mode: number
  readonly uid: 0
  readonly gid: 0
}

declare const authenticatedArchiveIdentity: unique symbol
/**
 * Only the module produces this report. Its private runtime identity is checked
 * again by tree/staging APIs; a cast, copy or deserialized shape grants no authority.
 * Authentication covers source bytes, not dependency ABI or native installation.
 */
export interface AuthenticatedReleaseArchive {
  readonly [authenticatedArchiveIdentity]: true
  readonly ok: true
  readonly manifest: ReleaseManifest
  readonly entries: readonly ReleaseArchiveEntry[]
  readonly tarBytes: number
  readonly manifestSha256: string
  readonly archiveSha256: string
  readonly archiveBytes: number
  readonly totalUnpackedBytes: number
  readonly sourceClosure: Readonly<{ authenticatedBuilderDeclaration: true; runtimeImportsReparsed: false }>
  readonly scope: 'source-artifact'
  readonly runtimeDependenciesVerified: false
  readonly installReady: false
  readonly lifecycleControlsPresent: boolean
}
export interface ReleaseTrustOptions {
  /** Copied on entry; must contain 32-4096 bytes. */
  readonly signingKey: string | Buffer
  readonly keyId: string
  /** Only reductions of the hard ceilings are accepted; unknown keys are refused. */
  readonly bounds?: Partial<ReleaseVerificationBounds>
}
export interface ArchiveVerificationOptions extends ReleaseTrustOptions {
  readonly expectedArchiveSha256: string
}
export interface AuthenticatedTreeOptions extends ReleaseTrustOptions {
  readonly authenticatedArchive: AuthenticatedReleaseArchive
}
export interface AuthenticatedReleaseTree {
  readonly ok: true
  readonly root: string
  readonly manifest: ReleaseManifest
  readonly manifestSha256: string
  readonly archiveSha256: string
  readonly verifiedFiles: number
  readonly ownership: 'observed-linux-root'
  readonly verifiedAt: string
}
export interface StagedAuthenticatedRelease extends AuthenticatedReleaseTree {
  readonly stagedAt: string
  readonly activated: false
  readonly installReady: false
  readonly runtimeDependenciesVerified: false
}

/** Insertion-order JSON serialization; undefined input can return undefined. */
export function serializeManifestPayload(manifestCore: unknown): string | undefined
export function signManifestPayload(canonicalJson: string, signingKey: Parameters<typeof createHmac>[1]): string
/** Bounded byte authentication only; no extraction or native-root qualification. */
export function verifyAuthenticatedReleaseArchive(archivePath: string, options: ArchiveVerificationOptions): Promise<AuthenticatedReleaseArchive>
/**
 * Linux-root retained-descriptor lifetime. FD use and tree/staging work must end
 * within the callback. A numeric FD is not an independent staging capability.
 * Await the outer return before publishing; callback output cannot authorize it.
 */
export function withAuthenticatedReleaseArchive<T>(
  archivePath: string,
  options: ArchiveVerificationOptions,
  callback: (held: Readonly<{ report: AuthenticatedReleaseArchive; fd: number }>) => T | PromiseLike<T>,
): Promise<Readonly<{ report: AuthenticatedReleaseArchive; value: Awaited<T> }>>
/** Requires same-module report identity and actual Linux-root observations. */
export function verifyAuthenticatedReleaseTree(root: string, options: AuthenticatedTreeOptions): Promise<AuthenticatedReleaseTree>
/**
 * Only inside the matching live callback, once per retained archive. Creates a
 * fresh private child of the existing protected parent; retains uncertain output.
 * Does not activate, qualify dependencies, or accept caller FD/writer hooks.
 */
export function stageAuthenticatedReleaseArchive(stagingRoot: string, options: AuthenticatedTreeOptions): Promise<StagedAuthenticatedRelease>
