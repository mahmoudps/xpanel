export const INSTALL_ROOT: '/opt/xpanel'
export const BOOTSTRAP_PATH: '/var/lib/xpanel-lifecycle/bootstrap.json'
export const DEPENDENCY_RECEIPT: '/var/lib/xpanel-lifecycle/install-dependencies.json'

export interface NewInstallInputs {
  phase?: 'plan' | 'prepare'
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
export function prepareNewInstallation(inputs: Omit<NewInstallInputs, 'phase'> & { phase?: 'prepare' }): Promise<Readonly<{ status: 'prepared'; version: string; releaseRoot: string; currentLink: string; dependencyReceiptSha256: string; installationReceipt: 'pending' }>>
export function establishInstallAdmission(): Promise<Readonly<{ status: 'admission_ready'; version: string; releaseRoot: string; installationReceipt: 'pending' }>>
export function captureInstallOwnership(): Promise<Readonly<{ status: 'bootstrap_pending'; version: string; releaseRoot: string; installationReceipt: 'captured'; active: false }>>
export function runBootstrapCli(argv: readonly string[], streams?: { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } }): Promise<number>
