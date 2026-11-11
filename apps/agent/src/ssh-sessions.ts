import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type SshOpenSessionsView =
  | { state: 'read'; count: number }
  | { state: 'unavailable'; count: null }

export type SshSessionScope = 'host' | { uid: number; username: string }

export interface ObserveSshSessionsOptions {
  scope: SshSessionScope
  procRoot?: string | null
  run?: ((argv: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>) | null
}

const PROC_SESSION_CMD = /^sshd(?:-session)?:\s+([a-zA-Z0-9._-]+)(?:@(?:pts\/\d+|notty))?(?:\0.*)?$/s

function matchesScope(scope: SshSessionScope, username: string, ruid: number | null): boolean {
  if (scope === 'host') return true
  if (username !== scope.username) return false
  return ruid === null || ruid === scope.uid
}

/** Parses /proc/<pid>/status + /proc/<pid>/cmdline for one process entry; returns true when it is an active OpenSSH user session worker. */
export function isProcSshSessionWorker(statusText: string, cmdlineText: string, scope: SshSessionScope): boolean {
  const name = /^Name:\t(\S+)$/m.exec(statusText)?.[1]
  if (name !== 'sshd' && name !== 'sshd-session') return false
  const ppidRaw = /^PPid:\t(\d+)$/m.exec(statusText)?.[1]
  if (!ppidRaw || Number(ppidRaw) <= 1) return false
  const uidRaw = /^Uid:\t(\d+)/m.exec(statusText)?.[1]
  const ruid = uidRaw !== undefined ? Number(uidRaw) : null
  const match = PROC_SESSION_CMD.exec(cmdlineText.trimEnd())
  if (!match) return false
  const username = match[1]!
  if (username === '[accepted]' || username === '[net]') return false
  if (cmdlineText.includes('[priv]') || cmdlineText.includes('[net]') || cmdlineText.includes('[accepted]')) return false
  return matchesScope(scope, username, ruid)
}

/** Parses `loginctl list-sessions --output=json` output when systemd-logind tracks sshd PAM sessions. */
export function countLoginctlSshSessions(stdout: string, scope: SshSessionScope): number | null {
  let rows: unknown
  try { rows = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(rows)) return null
  let total = 0
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const service = typeof row.service === 'string' ? row.service : ''
    const tty = typeof row.tty === 'string' ? row.tty : ''
    const state = typeof row.state === 'string' ? row.state : 'active'
    if (state === 'closing') continue
    const isSsh = service === 'sshd' || service === 'ssh' || (!service && /^pts\/\d+$/.test(tty) && row.remote === true)
    if (!isSsh) continue
    const user = typeof row.user === 'string' ? row.user : ''
    const uid = typeof row.uid === 'number' && Number.isSafeInteger(row.uid) ? row.uid : null
    if (!user) continue
    if (matchesScope(scope, user, uid)) total++
  }
  return total
}

/** Parses `/usr/bin/who` output lines with remote SSH peer `(host)` on `pts/N`. */
export function countWhoSshSessions(stdout: string, scope: SshSessionScope): number {
  let total = 0
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^([a-zA-Z0-9._-]+)\s+pts\/\d+\s+.*\(([^)]+)\)\s*$/.exec(trimmed)
    if (!match) continue
    if (matchesScope(scope, match[1]!, null)) total++
  }
  return total
}

/** Truthful active SSH session count from /proc, loginctl or who; returns unavailable when no host source can be read. */
export async function observeActiveSshSessions(options: ObserveSshSessionsOptions): Promise<SshOpenSessionsView> {
  const procRoot = options.procRoot === undefined ? (process.platform === 'linux' ? '/proc' : null) : options.procRoot
  if (procRoot) {
    try {
      const entries = await readdir(procRoot)
      const pids = entries.filter(name => /^[1-9]\d{0,9}$/.test(name))
      if (pids.length > 0) {
        let count = 0
        let readable = 0
        for (const pid of pids) {
          const [statusText, cmdlineText] = await Promise.all([
            readFile(join(procRoot, pid, 'status'), 'utf8').catch(() => null),
            readFile(join(procRoot, pid, 'cmdline'), 'utf8').catch(() => null),
          ])
          if (statusText !== null && cmdlineText !== null) {
            readable++
            if (isProcSshSessionWorker(statusText, cmdlineText, options.scope)) count++
          }
        }
        if (readable > 0) return { state: 'read', count }
      }
    } catch {
      // Fall through to loginctl / who when /proc is inaccessible.
    }
  }
  if (options.run) {
    const loginctl = await options.run(['/usr/bin/loginctl', 'list-sessions', '--output=json']).catch(() => null)
    if (loginctl?.ok) {
      const counted = countLoginctlSshSessions(loginctl.stdout, options.scope)
      if (counted !== null) return { state: 'read', count: counted }
    }
    const who = await options.run(['/usr/bin/who']).catch(() => null)
    if (who?.ok) return { state: 'read', count: countWhoSshSessions(who.stdout, options.scope) }
  }
  return { state: 'unavailable', count: null }
}
