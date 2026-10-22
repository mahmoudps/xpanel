import type { AuditEntry, HostAction } from '@xpanel/core'

// Ports injected into the long-running flows. Real implementations live in apps/agent;
// unit tests use the in-memory fakes in ./testing.

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Executes core HostActions (exec argv, systemd verbs). Never a shell string. */
export interface HostPort {
  apply(action: HostAction): Promise<ExecResult>
}

/** Minimal filesystem surface. Errors carry a Node-style `code` (ENOENT, EEXIST). */
export interface FsPort {
  exists(path: string): Promise<boolean>
  /** symlink target, or null when the path is not a symlink */
  readlink(path: string): Promise<string | null>
  /** file content, or null when the path is not a regular file */
  readFile(path: string): Promise<string | null>
  symlink(target: string, path: string): Promise<void>
  /** atomic rename(2); replaces an existing destination */
  rename(from: string, to: string): Promise<void>
  mkdirp(path: string, mode: number): Promise<void>
  /** O_CREAT|O_EXCL|O_NOFOLLOW: rejects with code EEXIST when the path already exists */
  writeFileExclusive(path: string, content: string, mode: number): Promise<void>
  /** recursive; never follows symlinks */
  remove(path: string): Promise<void>
  sha256(path: string): Promise<string>
}

export interface ClockPort {
  now(): Date
  sleep(ms: number): Promise<void>
}

/** Append-only audit log; entries are built with core `auditEntry` (secrets redacted there). */
export interface AuditPort {
  record(entry: AuditEntry): Promise<void>
}

export const errorCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string'
    ? (e as { code: string }).code
    : undefined

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))
