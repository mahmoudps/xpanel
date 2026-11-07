import { join } from 'node:path'
import { parseTweakValues, TWEAK_SETTINGS_STATE } from '@xpanel/core'
import type { HostAction, OsProfile, RenderedFile, TweakValue } from '@xpanel/core'
import { readJsonIfExists } from '@xpanel/state'
import type { AgentExecutor } from './executor.ts'

/** Tweak Settings: SQL. The server drop-in is rendered into every generation of a host with MariaDB. */
export const MARIADB_SERVER_BINARY = '/usr/sbin/mariadbd'
export const mariadbDropInPath = (os: Pick<OsProfile, 'family'>): string => os.family === 'rhel' ? '/etc/my.cnf.d/90-xpanel.cnf' : '/etc/mysql/mariadb.conf.d/90-xpanel.cnf'
// Both directories ship with the MariaDB server package, owned by mysql, and the distribution rotates logs there.
export const mariadbSlowLogPath = (os: Pick<OsProfile, 'family'>): string => os.family === 'rhel' ? '/var/log/mariadb/mariadb-slow.log' : '/var/log/mysql/mariadb-slow.log'
const OPEN_FILES_LIMIT = 16384
const MAX_ALLOWED_PACKET_MB = 256
const POOL_CHUNK_MB = 128

export interface MariadbHostObservation { tweaks: Record<string, TweakValue>; memoryMb: number | null }

/** Undefined without MariaDB; a saved file that fails validation keeps the defaults, as the API read does. */
export async function observeMariadbHost(executor: Pick<AgentExecutor, 'runCommand' | 'readFile'>, stateRoot: string): Promise<MariadbHostObservation | undefined> {
  if (!(await executor.runCommand(['/usr/bin/test', '-x', MARIADB_SERVER_BINARY])).ok) return undefined
  let tweaks: Record<string, TweakValue>
  try { tweaks = parseTweakValues(await readJsonIfExists<unknown>(join(stateRoot, TWEAK_SETTINGS_STATE))) } catch { tweaks = parseTweakValues(null) }
  const total = /^MemTotal:\s+([0-9]{1,12}) kB$/m.exec(await executor.readFile('/proc/meminfo').catch(() => null) ?? '')
  return { tweaks, memoryMb: total ? Math.floor(Number(total[1]) / 1024) : null }
}

/** A quarter of memory in whole 128 MiB chunks (innodb_buffer_pool_chunk_size), so MariaDB does not round the value itself. */
export const innodbBufferPoolMb = (memoryMb: number): number => Math.max(POOL_CHUNK_MB, Math.floor(memoryMb / 4 / POOL_CHUNK_MB) * POOL_CHUNK_MB)

export function renderMariadbDropIn(input: MariadbHostObservation, os: Pick<OsProfile, 'family'>): string {
  const lines = ['# Managed by xPanel Tweak Settings (SQL). Changes here are replaced on the next generation.', '[mysqld]']
  if (input.tweaks['sql.autotuneLimits'] === true) lines.push(`open_files_limit = ${OPEN_FILES_LIMIT}`, `max_allowed_packet = ${MAX_ALLOWED_PACKET_MB}M`)
  if (input.tweaks['sql.innodbBufferPoolByRam'] === true && input.memoryMb !== null) lines.push(`innodb_buffer_pool_size = ${innodbBufferPoolMb(input.memoryMb)}M`)
  if (input.tweaks['sql.slowQueryLog'] === true) lines.push('slow_query_log = 1', `long_query_time = ${input.tweaks['sql.longQueryTime']}`, `slow_query_log_file = ${mariadbSlowLogPath(os)}`)
  return lines.join('\n') + '\n'
}

export function compileMariadbServerConfig(os: OsProfile, input: MariadbHostObservation): { files: RenderedFile[]; postActions: HostAction[] } {
  // mariadbd(8) --help --verbose parses every option file and exits non-zero on a bad value, before the restart.
  return { files: [{ path: mariadbDropInPath(os), content: renderMariadbDropIn(input, os), mode: 0o644, owner: 'root', group: 'root' }], postActions: [{ kind: 'exec', argv: [MARIADB_SERVER_BINARY, '--verbose', '--help'] }] }
}

/** A restart drops every client connection, so it runs only when the drop-in changed. */
export function mariadbRestartActions(os: OsProfile, files: readonly RenderedFile[], previous: readonly { path: string; sha256: string }[] | undefined, sha256: (text: string) => string): HostAction[] {
  const path = mariadbDropInPath(os), file = files.find(row => row.path === path)
  return file && previous?.find(row => row.path === path)?.sha256 !== sha256(file.content) ? [{ kind: 'systemd', verb: 'restart', unit: os.services.mariadb }] : []
}
