import { fail } from '@xpanel/core'
import type { HostAction, RenderedFile } from '@xpanel/core'
import type { ManifestHeader } from './backup/manifest.ts'

// Plan steps produced by the backup, restore and transfer planners: core HostActions plus
// the effects HostAction cannot express (see contractRequests in the module report).

/**
 * exec with file-backed stdio. The executor opens `stdinFrom` and creates `stdoutTo`
 * itself (as root, O_NOFOLLOW, O_EXCL for stdout) and only then drops to `runAsUser`,
 * so an account can never redirect a root-side read or write through a symlink.
 */
export interface ExecIoStep {
  kind: 'exec-io'
  argv: string[]
  runAsUser?: string
  stdinFrom?: string
  stdoutTo?: { path: string; mode: number }
  /** exit codes treated as success, default [0] (GNU tar uses 1 for "file changed as we read it") */
  okExitCodes?: number[]
}

export interface WriteFileStep {
  kind: 'write-file'
  file: RenderedFile
}

/** Hash the staged parts and write manifest.json (executor side: computeManifest). */
export interface ManifestStep {
  kind: 'write-manifest'
  root: string
  output: string
  header: ManifestHeader
  sources: ManifestSource[]
}

export type ManifestSource =
  | { part: 'home'; tarGz: string }
  | { part: 'databases' | 'mail-config'; file: string }

/** Run inspectBackupArchive on `path`; abort the plan unless it verifies for `username`. */
export interface VerifyArchiveStep {
  kind: 'verify-archive'
  path: string
  username: string
}

export interface RemoteUploadStep {
  kind: 'remote-upload'
  from: string
  /** id of a stored remote destination; credentials never appear in plans */
  targetId: string
  objectKey: string
}

/** Desired-state writes the executor performs through the repositories, never on the host. */
export type DesiredStateStep =
  | { kind: 'desired-state'; op: 'ensure-database'; username: string; database: string }
  | { kind: 'desired-state'; op: 'merge-mail-config'; username: string; from: string }

/** Build and activate a generation. Lifecycle flows never restart shared services. */
export interface ReconcileStep {
  kind: 'reconcile'
  reason: string
  sharedUnits: 'reload-only'
}

export type LifecycleStep =
  | HostAction
  | ExecIoStep
  | WriteFileStep
  | ManifestStep
  | VerifyArchiveStep
  | RemoteUploadStep
  | DesiredStateStep
  | ReconcileStep

const argvPaths = (argv: string[]): string[] =>
  argv.flatMap((a) => {
    const v = a.startsWith('--') && a.includes('=') ? a.slice(a.indexOf('=') + 1) : a.startsWith('of=') ? a.slice(3) : a
    return v.startsWith('/') ? [v] : []
  })

/** Every absolute path a step mentions (argv values, stdio, targets); used by safety assertions. */
export const stepPaths = (s: LifecycleStep): string[] => {
  switch (s.kind) {
    case 'exec': return argvPaths(s.argv)
    case 'exec-io': return [...argvPaths(s.argv), ...(s.stdinFrom ? [s.stdinFrom] : []), ...(s.stdoutTo ? [s.stdoutTo.path] : [])]
    case 'ensure-dir': case 'remove-path': return [s.path]
    case 'ensure-user': return [s.home]
    case 'write-file': return [s.file.path]
    case 'write-manifest': return [s.root, s.output]
    case 'verify-archive': return [s.path]
    case 'remote-upload': return [s.from]
    case 'desired-state': return s.op === 'merge-mail-config' ? [s.from] : []
    default: return []
  }
}

/** Last line of defense before a plan leaves the planner: absolute binaries, no NUL or newline in argv. */
export const assertExecSteps = (steps: readonly { kind: string; argv?: string[] }[]): void => {
  for (const s of steps) {
    if (s.kind !== 'exec' && s.kind !== 'exec-io') continue
    const argv = s.argv ?? []
    if (argv.length === 0 || !(argv[0] as string).startsWith('/')) fail('VALIDATION', `step runs a non-absolute binary: ${String(argv[0]).slice(0, 80)}`)
    if (argv.some((a) => typeof a !== 'string' || /[\0\n\r]/.test(a))) fail('VALIDATION', 'argv element contains NUL or a line break')
  }
}
