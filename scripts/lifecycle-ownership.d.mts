import type { BigIntStats } from 'node:fs'
export const INSTALLATION_RECEIPT: string
export const OWNED_PANEL_UNITS: readonly string[]
export interface OwnedLifecycleFile { path: string; kind: 'file'|'symlink'; device: string; inode: string; size: number; mode: number; sha256: string|null; target: string|null }
export interface InstallationReceipt {
  schemaVersion: 1; product: 'xpanel'; status: 'bootstrap_pending'|'active'|'uninstalled'; officialReference: null; lastLifecycleReference: string|null; createdAt: string
  source: { root: '/opt/xpanel'; version: string; archiveSha256: string; manifestSha256: string; dependencyReceiptSha256: string; controlDbSchemaVersion: number }
  runtime: { nodePath: string; nodeVersion: '26.12.1'; nodeSha256: string; systemctlSha256: string; nginxSha256: string }
  writerProtocol: 'lifecycle-admission-v1'; units: string[]; files: OwnedLifecycleFile[]
}
export interface TrustedFileOptions { maxBytes?: number; exactMode?: number; sha256?: string }
export interface TrustedFileContents { readonly bytes: Buffer; readonly sha256: string; readonly info: BigIntStats }
export interface TrustedFilePin extends TrustedFileContents { readonly fd: number; verify(): Promise<void> }
export function isRemovableControlPlanePath(path: unknown): boolean
export function parseInstallationReceipt(value: unknown): Readonly<InstallationReceipt>
export function requireLinuxRoot(): void
export function withTrustedDirectory<T>(path: string, callback: (pin: { verify(): Promise<void> }) => Promise<T>): Promise<T>
export function assertTrustedDirectory(path: string): Promise<void>
export function withTrustedFile<T>(path: string, options: TrustedFileOptions, callback: (pin: TrustedFilePin) => Promise<T>): Promise<T>
export function readTrustedFile(path: string, options?: TrustedFileOptions): Promise<TrustedFileContents>
export function readInstallationReceipt(): Promise<{ receipt: Readonly<InstallationReceipt>; sha256: string }>
export function ownedFileDriftField(entry: OwnedLifecycleFile, named: import('node:fs').BigIntStats): 'device' | 'inode' | 'size' | 'mode' | 'owner' | 'kind' | null
export function assertOwnedFile(entry: OwnedLifecycleFile): Promise<void>
export function preservingUninstallPlan(receipt: InstallationReceipt): Readonly<Record<string, unknown>>
