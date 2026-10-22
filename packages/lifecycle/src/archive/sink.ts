import type { Body } from './reader.ts'
import type { EntryType } from './guard.ts'

// Where importers stream accepted content. The real sink writes into a staging area as
// the new account's uid; tests use MemorySink. A sink never sees rejected entries.

export type SinkPart = 'home' | 'mail' | 'sql' | 'ssl-cert' | 'ssl-key'

export interface SinkItem {
  part: SinkPart
  /** relative to the part root (home dir, mail root) or the bare file name */
  path: string
  type: EntryType
  mode: number
  size: number
  mtime: Date | null
  /** symlink target as stored; hardlink target relative to the same part root */
  linkTarget: string | null
}

export interface ImportSink {
  /** must consume `body`; returns an opaque reference to the stored content */
  put(item: SinkItem, body: Body): Promise<string | null>
  /** called once when an import fails after content was stored */
  abort?(reason: Error): Promise<void>
}

export async function* single(buf: Buffer): AsyncGenerator<Buffer> {
  if (buf.length) yield buf
}

export interface FileRef {
  /** path inside the source archive */
  archivePath: string
  size: number
  sha256: string
  /** sink reference, null in dry runs */
  ref: string | null
}
