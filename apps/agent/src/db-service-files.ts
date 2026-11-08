import { constants } from 'node:fs'
import { copyFile, open, readdir, rename, stat, statfs, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { fail, isXpanelError } from '@xpanel/core'
import { DB_SERVICE_ACTIONS, dbServiceControlArgv } from '../../../packages/os/src/db-services-command.ts'
import type { DbServiceAction } from '../../../packages/os/src/db-services-command.ts'
import { readDbEngines, redisTokens } from './db-engines.ts'
import type { DbFamily, DbReadFile, DbRun } from './db-engines.ts'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import type { MongoClient, MongoCredential } from './mongo-client.ts'
import type { RedisClient, RedisTarget } from './redis-client.ts'

/** Files of the optional database daemons: edits that keep the operator's own lines, and a change undone when the daemon refuses it. */
export interface DbServiceHost {
  readFile(path: string): Promise<string | null>
  writeFile(file: { path: string; content: string; mode: number; owner: string; group: string }): Promise<unknown>
}
export interface DbServiceFs {
  stat(path: string): Promise<{ uid: number; gid: number; mode: number } | null>
  list(directory: string): Promise<{ name: string; sizeBytes: number; modifiedAt: string }[]>
  tail(path: string, bytes: number): Promise<string | null>
  freeKb(path: string): Promise<number | null>
  /** The first bytes after gunzip, or null when the file is not gzip. */
  gunzipHead(path: string, bytes: number): Promise<Buffer | null>
  /** Copies a file in as root-only, publishes it by rename and removes the source. */
  adopt(source: string, target: string): Promise<void>
  remove(path: string): Promise<void>
}
export const nodeDbServiceFs: DbServiceFs = {
  async stat(path) { try { const info = await stat(path); return { uid: info.uid, gid: info.gid, mode: info.mode & 0o777 } } catch { return null } },
  async list(directory) {
    let names: string[]
    try { names = await readdir(directory) } catch { return [] }
    const rows = await Promise.all(names.slice(0, 500).map(async name => { const info = await stat(`${directory}/${name}`); return { name, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() } }))
    return rows.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  },
  async tail(path, bytes) {
    let handle
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      const { size } = await handle.stat(), length = Math.min(size, bytes), buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } finally { await handle.close() }
  },
  async freeKb(path) { try { const info = await statfs(path); return Math.floor(info.bavail * info.bsize / 1024) } catch { return null } },
  gunzipHead: (path, bytes) => new Promise(resolve => {
    const input = createReadStream(path), unzip = createGunzip(), chunks: Buffer[] = []
    let size = 0
    const done = (value: Buffer | null): void => { input.destroy(); unzip.destroy(); resolve(value) }
    input.on('error', () => done(null)); unzip.on('error', () => done(null))
    unzip.on('data', (chunk: Buffer) => { chunks.push(chunk); size += chunk.length; if (size >= bytes) done(Buffer.concat(chunks).subarray(0, bytes)) })
    unzip.on('end', () => done(Buffer.concat(chunks)))
    input.pipe(unzip)
  }),
  async adopt(source, target) {
    const temporary = `${target}.part`
    await copyFile(source, temporary)
    const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await handle.chown(0, 0); await handle.chmod(0o600); await handle.sync() } finally { await handle.close() }
    await rename(temporary, target)
    await unlink(source)
  },
  async remove(path) { await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) },
}

export const revisionOf = (text: string): string => createHash('sha256').update(text).digest('hex')
export const LOG_TAIL_BYTES = 65536
/** The last lines of a daemon log, without control characters or anything that looks like a credential. */
export function logLines(text: string | null, max = 200): string[] {
  if (text === null) return []
  const lines = text.split('\n')
  if (text.length >= LOG_TAIL_BYTES) lines.shift()
  return lines.filter(Boolean).slice(-max).map(line => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ').replace(/SCRAM-SHA-256\$\S*/g, '[REDACTED]').replace(/md5[0-9a-f]{32}/g, '[REDACTED]').replace(/(PASSWORD\s+)'[^']*'/gi, "$1'[REDACTED]'").replace(/((?:pwd|password)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"').slice(0, 2000))
}

/**
 * Runs one change and proves it on the running daemon. A refusal puts the previous file back and activates it again,
 * so a daemon never stays down on a rejected value. Every failure says whether the old state returned.
 */
export async function withFileRollback(input: { host: DbServiceHost; fs: DbServiceFs; path: string; change(): Promise<void>; check?(): Promise<string | null>; activate(): Promise<void>; verify(): Promise<boolean>; verifyRestored?(): Promise<boolean>; reason: string }): Promise<void> {
  const previous = await input.host.readFile(input.path), info = await input.fs.stat(input.path)
  if (previous === null || !info) return fail('PRECONDITION_FAILED', 'the configuration file could not be read; nothing was changed', { stateChanged: false, reason: input.reason + '_config_unread' })
  const restore = async (): Promise<boolean> => {
    try { await input.host.writeFile({ path: input.path, content: previous, mode: info.mode, owner: String(info.uid), group: String(info.gid) }); await input.activate(); return await (input.verifyRestored ?? input.verify)() } catch { return false }
  }
  await input.change()
  let refusal: string | null = null, accepted = false
  try {
    refusal = (await input.check?.()) ?? null
    if (refusal === null) { await input.activate(); accepted = await input.verify() }
  } catch { accepted = false }
  if (accepted) return
  const restored = await restore()
  return fail('CONFIG_TEST_FAILED', refusal ?? 'the server did not accept this change', restored ? { stateChanged: false, reason: input.reason + '_rejected', restored: true } : { stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: input.reason + '_restore_failed' })
}

const SECRETS = {
  redis: /^\s*(?:requirepass|masterauth|masteruser|user|tls-key-file-pass|tls-client-key-file-pass)\s/i,
  mongodb: /^\s*[A-Za-z]*[Pp]assword:/,
  postgresql: /^\s*(?:primary_conninfo|ssl_passphrase_command)\b/,
} as const
export type SecretFile = keyof typeof SECRETS
const HIDDEN = '<hidden by xPanel>'
/** The editor never holds a credential; each secret line is a placeholder that must survive the edit. */
export const hideSecrets = (kind: SecretFile, text: string): string => text.split('\n').map(line => { const match = SECRETS[kind].exec(line); return match ? `${match[0].trimEnd()} ${HIDDEN}` : line }).join('\n')
export function restoreSecrets(kind: SecretFile, edited: string, current: string): string {
  const pattern = SECRETS[kind], secrets = current.split('\n').filter(line => pattern.test(line)), found = edited.split('\n').filter(line => pattern.test(line))
  if (found.length !== secrets.length || found.some(line => !line.endsWith(' ' + HIDDEN))) return fail('VALIDATION', 'secret lines stay as they are here; use the password form', { stateChanged: false, reason: 'secret_line_changed' })
  let index = 0
  return edited.split('\n').map(line => pattern.test(line) ? secrets[index++]! : line).join('\n')
}
export function redisPassword(text: string): string | null {
  let password: string | null = null
  for (const line of text.split('\n')) { const tokens = redisTokens(line.trim()); if (tokens[0]?.toLowerCase() === 'requirepass') password = tokens[1] || null }
  return password
}
/** redis.conf: a later line wins, so saved values replace every active line of their keyword at the end of the file. */
export function setRedisDirectives(text: string, values: Readonly<Record<string, readonly string[]>>): string {
  const keep = text.split('\n').filter(line => { const word = redisTokens(line.trim())[0]?.toLowerCase(); return !word || word.startsWith('#') || !Object.hasOwn(values, word) })
  while (keep.at(-1) === '') keep.pop()
  return [...keep, ...Object.entries(values).flatMap(([key, lines]) => lines.map(line => `${key} ${line}`)), ''].join('\n')
}

/** mongod.conf: one scalar in a two-level block mapping, leaving every comment and other key in place. */
export function setMongodValue(text: string, section: string, key: string, value: string): string {
  const lines = text.split('\n'), head = lines.findIndex(line => line.replace(/\s+#.*$/, '').trimEnd() === section + ':')
  if (head < 0) { while (lines.at(-1) === '') lines.pop(); return [...lines, `${section}:`, `  ${key}: ${value}`, ''].join('\n') }
  let end = head + 1
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]!) || lines[end]!.startsWith('#'))) end++
  const body = lines.slice(head + 1, end)
  const indent = body.find(line => /^\s+\S/.test(line) && !line.trim().startsWith('#'))?.match(/^\s+/)?.[0] ?? '  '
  const at = body.findIndex(line => line.startsWith(`${indent}${key}:`))
  if (at >= 0) lines[head + 1 + at] = `${indent}${key}: ${value}`
  else lines.splice(head + 1, 0, `${indent}${key}: ${value}`)
  return lines.join('\n')
}
export const assertServicePort = (value: unknown, label: string): number => Number.isInteger(value) && (value as number) >= 1024 && (value as number) <= 65535 ? value as number : fail('VALIDATION', `${label} must be a port from 1024 to 65535`, { stateChanged: false })

export interface DbServiceContext {
  family: DbFamily | null
  run: DbRun
  readFile: DbReadFile | null
  host: DbServiceHost
  fs: DbServiceFs
  runPostgresql: ((statements: string[]) => Promise<void>) | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  stateRoot: string
  connectRedis: (target: RedisTarget, password: string | null) => Promise<RedisClient>
  connectMongo: (input: { host: string; port: number; credential: MongoCredential | null }) => Promise<MongoClient>
  sleep(ms: number): Promise<void>
  now(): Date
  assertFresh(): Promise<string>
}
const quiet = { stateChanged: false }
export const engineFacts = (ctx: DbServiceContext) => readDbEngines({ family: ctx.family, run: ctx.run, readFile: ctx.readFile, now: ctx.now })
export function exactBody(body: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = body as Record<string, unknown>
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return fail('VALIDATION', `exactly ${keys.join(', ')} are required`, quiet)
  return value
}
/** A long change runs as a verified host job; a refused submission keeps its own code. */
export async function submitServiceJob(ctx: DbServiceContext, plan: HostJobPlan): Promise<{ job: HostJobView }> {
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable; nothing was submitted', { ...quiet, reason: 'host_jobs_unavailable' })
  try { return { job: await ctx.submitJob(plan, await ctx.assertFresh()) } }
  catch (error) { if (isXpanelError(error) && error.detail.stateChanged === false) throw error; return fail('SERVICE_UNAVAILABLE', 'the submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
}
export const requireUnit = (unit: string | null, engine: string): string => unit ?? fail('PRECONDITION_FAILED', 'the service unit could not be observed', { ...quiet, reason: `${engine}_service_unread` })
export const requireOk = async (ctx: DbServiceContext, action: DbServiceAction, unit: string): Promise<void> => {
  const result = await ctx.run(dbServiceControlArgv(action, unit))
  if (!result.ok) return fail('CONFIG_TEST_FAILED', 'the service manager refused this action', { stateChanged: true, verificationRequired: true, reason: 'database_service_control_failed' })
}
export async function controlUnit(ctx: DbServiceContext, unit: string | null, engine: 'redis' | 'mongodb' | 'postgresql', body: unknown) {
  const { action } = exactBody(body, ['action'])
  if (!(DB_SERVICE_ACTIONS as readonly unknown[]).includes(action)) return fail('VALIDATION', 'unsupported service action', quiet)
  const known = requireUnit(unit, engine)
  await ctx.assertFresh()
  if (!(await ctx.run(dbServiceControlArgv(action as DbServiceAction, known))).ok) return fail('CONFIG_TEST_FAILED', 'the service manager refused this action', { stateChanged: true, verificationRequired: true, reason: `${engine}_control_failed` })
  const product = (await engineFacts(ctx)).products[engine], service = typeof product.service === 'object' ? product.service : null
  const expected = action === 'stop' ? service?.active !== 'active' : action === 'enable' ? service?.enabled === 'enabled' : action === 'disable' ? service?.enabled === 'disabled' : service?.active === 'active'
  if (!expected) return fail('SERVICE_UNAVAILABLE', 'the service did not reach the requested state', { stateChanged: true, verificationRequired: true, reason: `${engine}_control_unverified` })
  return { action, unit: known, active: service?.active ?? null, enabled: service?.enabled ?? null }
}
