import type { KeyObject } from 'node:crypto'

export interface PublisherRelease {
  version: string
  schemaVersion: number
  sha256: string
  /** Total unpacked file bytes from the HMAC-authenticated inner inventory. */
  bytes: number
}
export interface PublisherManifest extends PublisherRelease { keyId: string; signature: string }
export interface ReleaseSourceProvenance {
  schemaVersion: 1
  fingerprintAlgorithm: 'sha256-release-inputs-v1'
  inputFingerprint: string
  inputFiles: number
  commit: string | null
  tree: string | null
  dirty: boolean | null
}
export function publisherPayload(release: PublisherRelease): Buffer
export function createPublisherManifest(release: PublisherRelease, options: { keyId: string; privateKey: string | Buffer | KeyObject }): Readonly<PublisherManifest>
export function publisherManifestPath(archivePath: string): string
export function writePublisherOutput(path: string, bytes: string | Buffer): void
export function releaseInputFingerprint(entries: readonly { path: string; sha256: string; bytes: number }[]): string
export function captureReleaseSource(root: string, paths: readonly string[], options?: { requireClean?: boolean }): { source: Readonly<ReleaseSourceProvenance>; readInput(path: string): Buffer; assertUnchanged(): void }
