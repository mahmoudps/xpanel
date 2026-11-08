export const INSTALL_ROOT: '/opt/xpanel'
export const BOOTSTRAP_PATH: '/var/lib/xpanel-lifecycle/bootstrap.json'
export const DEPENDENCY_RECEIPT: '/var/lib/xpanel-lifecycle/install-dependencies.json'

export interface NewInstallInputs {
  phase?: 'plan' | 'verify' | 'prepare' | 'resume'
  artifactPath: string
  artifactSha256: string
  trustPath: string
  keysPath: string
}
export interface BootstrapTrust {
  keyId: string
  signingKeyPath: string
  packageManagerPath: string
  packageManagerSha256: string
}
export interface BootstrapKeys {
  schemaVersion: 1
  keys: readonly { keyId: string; algorithm: 'ed25519'; publicKey: string }[]
}
export interface PublisherManifest {
  version: string
  schemaVersion: number
  sha256: string
  bytes: number
  keyId: string
  signature: string
}
export function parseBootstrapArgs(argv: readonly string[]): Readonly<NewInstallInputs | { phase: 'admission' | 'capture' }>
export function parseBootstrapTrust(value: unknown): Readonly<BootstrapTrust>
export function parseBootstrapKeys(value: unknown): Readonly<BootstrapKeys>
/** Pure wire validation; it does not confer native extraction or installation authority. */
export function verifyBootstrapPublisher(value: unknown, report: { manifest: { version: string; controlDbSchemaVersion: number }; archiveSha256: string; totalUnpackedBytes: number }, keys: unknown): Readonly<PublisherManifest>
/** Pure prerequisite validation; legacy archive verification is not changed or replaced. */
export function assertFreshInstallReleaseControls(report: unknown): void
export function verifyNewInstallation(inputs: Omit<NewInstallInputs, 'phase'> & { phase?: 'verify' }): Promise<Readonly<{ status: 'verified'; version: string; active: false }>>
export function resumePreparedInstallation(inputs: Omit<NewInstallInputs, 'phase'> & { phase?: 'resume' }): Promise<Readonly<{ status: 'prepared'; version: string; releaseRoot: string; currentLink: string; dependencyReceiptSha256: string; installationReceipt: 'pending'; resumed: true }>>
export function prepareNewInstallation(inputs: Omit<NewInstallInputs, 'phase'> & { phase?: 'prepare' }): Promise<Readonly<{ status: 'prepared'; version: string; releaseRoot: string; currentLink: string; dependencyReceiptSha256: string; installationReceipt: 'pending' }>>
export function establishInstallAdmission(): Promise<Readonly<{ status: 'admission_ready'; version: string; releaseRoot: string; installationReceipt: 'pending' }>>
export function resumableInstallReceipt(receipt: Readonly<Record<string, unknown> & { runtime: object }>): string
export function captureInstallOwnership(): Promise<Readonly<{ status: 'bootstrap_pending'; version: string; releaseRoot: string; installationReceipt: 'captured'; active: false }>>
export function runBootstrapCli(argv: readonly string[], streams?: { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } }): Promise<number>

export interface PreparedInstallBootstrap {
  readonly schemaVersion: 1
  readonly status: 'bootstrap_pending' | 'active'
  readonly createdAt: string
  readonly version: string
  readonly releaseRoot: string
  readonly archiveSha256: string
  readonly manifestSha256: string
  readonly controlDbSchemaVersion: number
  readonly dependencyReceiptSha256: string
  readonly runtime: Readonly<{ nodePath: string; nodeSha256: string }>
  readonly installationTransition?: Readonly<{ operationId: string; reference: string; previousBootstrapSha256: string }>
  readonly finalization?: import('./install-finalization.mjs').InstallFinalizationIntent
}
/** A protected source observation only; it does not confer the native finalization capability. */
export function observePreparedInstallFinalization(): Promise<Readonly<{ bootstrap: PreparedInstallBootstrap; runtime: Readonly<{ nodePath: string; nodeSha256: string }> }>>
/** The fixed native factory validates the unknown request independently before admitting effects. */
export function finalizePreparedInstallation(request: unknown): ReturnType<typeof import('./install-finalization.mjs').runPreparedInstallFinalization>

export { parsePreparedReleaseInput, withPreparedRelease, withExistingPreparedRelease, assertPreparedReleaseCurrent, preparedReleaseInfo, observeInstalledReleaseTree } from './prepared-release.mjs'
export function observePreparedAdoptionSource(capability:unknown, migrations?:import('../packages/db/src/index.ts').OperationalMigrationMode):Promise<Readonly<{bootstrap:PreparedInstallBootstrap;runtime:Readonly<{nodePath:string;nodeSha256:string}>;helper:import('./prepared-release.mjs').PreparedReleaseInfo}>>

/** Read-only typed active-source observation; does not mint readiness or native mutation authority. */
export function observeInstalledAcquisitionSource(): ReturnType<typeof observePreparedInstallFinalization>
