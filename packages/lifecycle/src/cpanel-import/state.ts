import type { FileRef } from '../archive/sink.ts'
import type { UserdataDomain, UserdataMain } from './parsers.ts'
import type { ImportPlan, ImportWarning } from './types.ts'

/** Everything collected in one streaming pass over the archive, before the plan is built. */
export interface ReadState {
  top: string | null
  format: ImportPlan['format'] | null
  sourceUser: string | null
  /** the account name the import creates (source name unless renamed) */
  target: string | null
  cp: Map<string, string> | null
  main: UserdataMain | null
  userdata: Map<string, UserdataDomain>
  zones: Map<string, string>
  grants: string | null
  sql: Map<string, FileRef>
  mailPasswd: Map<string, string[]>
  mailQuota: Map<string, Map<string, number>>
  maildirs: Set<string>
  valiases: Map<string, string>
  vfilters: Map<string, number>
  certs: Map<string, Buffer>
  keys: Map<string, Buffer>
  quota: string | null
  /** homedir paths (relative to it) that were not stored: a hardlink to one is skipped too */
  unstored: Set<string>
  home: ImportPlan['home']
  warnings: ImportWarning[]
  warningCount: number
  reportedOnce: Set<string>
}

const MAX_WARNINGS = 1000

export const newReadState = (): ReadState => ({
  top: null, format: null, sourceUser: null, target: null, cp: null, main: null, userdata: new Map(), zones: new Map(), grants: null,
  sql: new Map(), mailPasswd: new Map(), mailQuota: new Map(), maildirs: new Set(), valiases: new Map(), vfilters: new Map(),
  certs: new Map(), keys: new Map(), quota: null, unstored: new Set(),
  home: { files: 0, directories: 0, symlinks: 0, bytes: 0, skipped: 0 },
  warnings: [], warningCount: 0, reportedOnce: new Set(),
})

export const warn = (s: ReadState, code: string, message: string, path?: string): void => {
  s.warningCount++
  if (s.warnings.length < MAX_WARNINGS) s.warnings.push(path === undefined ? { code, message } : { code, message, path })
}

/** One warning per key (an unsupported top-level directory is reported once, not per file). */
export const warnOnce = (s: ReadState, key: string, code: string, message: string, path?: string): void => {
  if (s.reportedOnce.has(key)) return
  s.reportedOnce.add(key)
  warn(s, code, message, path)
}
