import { randomUUID } from 'node:crypto'
import {
  assertBool,
  assertInt,
  assertIp,
  assertIsoDate,
  assertLine,
  fail,
  oneOf,
} from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { first, nowIso } from './util.ts'

export const LOGIN_SURFACES = ['panel', 'api', 'webmail'] as const
export type LoginSurface = (typeof LOGIN_SURFACES)[number]

export interface LoginAttemptRecord {
  id: number
  at: string
  surface: LoginSurface
  username: string
  ip: string
  success: boolean
  reason: string | null
}

export interface LockoutRecord {
  id: Id
  username: string | null
  ip: string | null
  failures: number
  reason: string
  lockedUntil: string
  createdAt: string
}

interface LockoutRow {
  id: string
  username: string | null
  ip: string | null
  failures: number
  reason: string
  locked_until: string
  created_at: string
  [k: string]: unknown
}

const fromLockoutRow = (r: LockoutRow): LockoutRecord => ({
  id: r.id,
  username: r.username,
  ip: r.ip,
  failures: r.failures,
  reason: r.reason,
  lockedUntil: r.locked_until,
  createdAt: r.created_at,
})

export const recordLoginAttempt = (
  db: Db,
  input: {
    surface?: LoginSurface
    username: string
    ip: string
    success: boolean
    reason?: string | null
    at?: string
  },
): Promise<LoginAttemptRecord> =>
  withSqliteErrors(async () => {
    const surface = oneOf(input.surface ?? 'panel', LOGIN_SURFACES, 'surface')
    const username = assertLine(input.username, 128, 'username', { allowEmpty: false }).toLowerCase()
    const ip = assertIp(input.ip, 'ip')
    const success = assertBool(input.success, 'success')
    const reason = input.reason == null ? null : assertLine(input.reason, 255, 'reason')
    const at = input.at === undefined ? nowIso() : assertIsoDate(input.at, 'at').toISOString()
    const rows = await db.query<{
      id: number
      at: string
      surface: LoginSurface
      username: string
      ip: string
      success: number
      reason: string | null
    }>(
      `INSERT INTO login_attempts (at, surface, username, ip, success, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [at, surface, username, ip, success ? 1 : 0, reason],
    )
    const r = rows[0]!
    return {
      id: r.id,
      at: r.at,
      surface: r.surface,
      username: r.username,
      ip: r.ip,
      success: Boolean(r.success),
      reason: r.reason,
    }
  })

export const checkLockout = async (
  db: Db,
  input: { username?: string; ip?: string },
  now: string = nowIso(),
): Promise<LockoutRecord | null> => {
  const uname = input.username ? input.username.trim().toLowerCase() : null
  const ip = input.ip ? assertIp(input.ip.trim(), 'ip') : null
  if (!uname && !ip) return null
  let hit: LockoutRecord | null = null
  if (uname) {
    const uRows = await db.query<LockoutRow>(
      `SELECT * FROM lockouts WHERE lower(username) = $1 AND locked_until > $2 ORDER BY locked_until DESC LIMIT 1`,
      [uname, now],
    )
    const uHit = first(uRows)
    if (uHit) hit = fromLockoutRow(uHit)
  }
  if (ip) {
    const ipRows = await db.query<LockoutRow>(
      `SELECT * FROM lockouts WHERE ip = $1 AND locked_until > $2 ORDER BY locked_until DESC LIMIT 1`,
      [ip, now],
    )
    const ipHit = first(ipRows)
    if (ipHit) {
      const candidate = fromLockoutRow(ipHit)
      if (!hit || candidate.lockedUntil > hit.lockedUntil) hit = candidate
    }
  }
  return hit
}

export const upsertLockout = (
  db: Db,
  input: {
    username?: string | null
    ip?: string | null
    failures: number
    reason?: string
    lockedUntil: string
  },
): Promise<LockoutRecord> =>
  withSqliteErrors(() =>
    db.transaction(async (tx) => {
      const hasUser = input.username !== undefined && input.username !== null
      const hasIp = input.ip !== undefined && input.ip !== null
      if (hasUser === hasIp) {
        fail('VALIDATION', 'lockout must target either username or ip, not both')
      }
      const username = hasUser ? assertLine(input.username, 128, 'username', { allowEmpty: false }).toLowerCase() : null
      const ip = hasIp ? assertIp(typeof input.ip === 'string' ? input.ip.trim() : input.ip, 'ip') : null
      const failures = assertInt(input.failures, 0, 1_000_000, 'failures')
      const reason = assertLine(input.reason ?? '', 255, 'reason')
      const lockedUntil = assertIsoDate(input.lockedUntil, 'lockedUntil').toISOString()
      const now = nowIso()

      return replaceLockout(tx, { username, ip, failures, reason, lockedUntil, createdAt: now })
    }),
  )

export const clearLockout = (db: Db, input: { username?: string; ip?: string }): Promise<number> =>
  withSqliteErrors(() => db.transaction(async (tx) => {
    let cleared = 0
    if (input.username) {
      const username = input.username.trim().toLowerCase()
      await tx.query(`DELETE FROM login_failure_counters WHERE subject_kind = 'username' AND subject_value = $1`, [username])
      const rows = await tx.query<{ id: string }>(
        `DELETE FROM lockouts WHERE lower(username) = $1 RETURNING id`,
        [username],
      )
      cleared += rows.length
    }
    if (input.ip) {
      const ip = assertIp(input.ip.trim(), 'ip')
      await tx.query(`DELETE FROM login_failure_counters WHERE subject_kind = 'ip' AND subject_value = $1`, [ip])
      const rows = await tx.query<{ id: string }>(
        `DELETE FROM lockouts WHERE ip = $1 RETURNING id`,
        [ip],
      )
      cleared += rows.length
    }
    return cleared
  }))

interface LockoutWrite {
  username: string | null
  ip: string | null
  failures: number
  reason: string
  lockedUntil: string
  createdAt: string
}

const replaceLockout = async (db: Db, input: LockoutWrite): Promise<LockoutRecord> => {
  if (input.username !== null) await db.query(`DELETE FROM lockouts WHERE lower(username) = $1`, [input.username])
  else await db.query(`DELETE FROM lockouts WHERE ip = $1`, [input.ip])
  const rows = await db.query<LockoutRow>(
    `INSERT INTO lockouts (id, username, ip, failures, reason, locked_until, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [randomUUID(), input.username, input.ip, input.failures, input.reason, input.lockedUntil, input.createdAt],
  )
  return fromLockoutRow(rows[0]!)
}

export interface LoginFailureInput {
  username: string
  ip: string
  threshold: number
  /** Fixed observation window; expiry or a completed lock starts a new counter. */
  windowMs: number
  lockoutDurationMs: number
  surface?: LoginSurface
  reason?: string | null
  now?: string
}

export interface LoginFailureResult {
  usernameFailures: number
  ipFailures: number
  lockedUntil: string | null
}

interface FailureSubject {
  kind: 'username' | 'ip'
  value: string
}

interface FailurePolicy {
  threshold: number
  windowMs: number
  now: string
  lockedUntil: string
}

interface FailureCounterRow {
  failures: number
  window_started_at: string
  [key: string]: unknown
}

const advanceFailureCounter = async (
  db: Db,
  subject: FailureSubject,
  policy: FailurePolicy,
): Promise<{ failures: number; lockedUntil: string | null }> => {
  const column = subject.kind === 'username' ? 'lower(username)' : 'ip'
  const lock = first(await db.query<LockoutRow>(`SELECT * FROM lockouts WHERE ${column} = $1`, [subject.value]))
  if (lock && lock.locked_until > policy.now) return { failures: lock.failures, lockedUntil: lock.locked_until }
  const current = first(await db.query<FailureCounterRow>(
    `SELECT failures, window_started_at FROM login_failure_counters WHERE subject_kind = $1 AND subject_value = $2`,
    [subject.kind, subject.value],
  ))
  const currentStart = current ? assertIsoDate(current.window_started_at, 'failure window start').toISOString() : policy.now
  const reset = Boolean(lock) || !current || Date.parse(policy.now) - Date.parse(currentStart) >= policy.windowMs
  const failures = reset ? 1 : current!.failures + 1
  const startedAt = reset ? policy.now : currentStart
  if (lock) await db.query(`DELETE FROM lockouts WHERE ${column} = $1`, [subject.value])
  await db.query(
    `INSERT INTO login_failure_counters (subject_kind, subject_value, failures, window_started_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (subject_kind, subject_value) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at`,
    [subject.kind, subject.value, failures, startedAt],
  )
  if (failures < policy.threshold) return { failures, lockedUntil: null }
  await replaceLockout(db, {
    username: subject.kind === 'username' ? subject.value : null,
    ip: subject.kind === 'ip' ? subject.value : null,
    failures,
    reason: 'excessive_failed_logins',
    lockedUntil: policy.lockedUntil,
    createdAt: policy.now,
  })
  return { failures, lockedUntil: policy.lockedUntil }
}

/** Records one failure and advances both durable limits in one serialized write transaction. */
export const recordLoginFailure = (db: Db, input: LoginFailureInput): Promise<LoginFailureResult> =>
  withSqliteErrors(async () => {
    const username = assertLine(input.username, 128, 'username', { allowEmpty: false }).trim().toLowerCase()
    if (!username) fail('VALIDATION', 'username must not be empty')
    const ip = assertIp(input.ip, 'ip')
    const threshold = assertInt(input.threshold, 1, 1_000_000, 'threshold')
    const windowMs = assertInt(input.windowMs, 1, 604_800_000, 'windowMs')
    const duration = assertInt(input.lockoutDurationMs, 1, 604_800_000, 'lockoutDurationMs')
    const now = input.now === undefined ? nowIso() : assertIsoDate(input.now, 'now').toISOString()
    const expiry = Date.parse(now) + duration
    if (expiry > 8_640_000_000_000_000) fail('VALIDATION', 'lockout expiry exceeds the supported date range')
    const policy = { threshold, windowMs, now, lockedUntil: new Date(expiry).toISOString() }
    return db.transaction(async (tx) => {
      await recordLoginAttempt(tx, { surface: input.surface ?? 'panel', username, ip, success: false, reason: input.reason ?? null, at: now })
      const user = await advanceFailureCounter(tx, { kind: 'username', value: username }, policy)
      const source = await advanceFailureCounter(tx, { kind: 'ip', value: ip }, policy)
      const lockedUntil = [user.lockedUntil, source.lockedUntil].filter((value): value is string => value !== null).sort().at(-1) ?? null
      return { usernameFailures: user.failures, ipFailures: source.failures, lockedUntil }
    })
  })

export const listLockouts = async (db: Db, now: string = nowIso()): Promise<LockoutRecord[]> => {
  const rows = await db.query<LockoutRow>(
    `SELECT * FROM lockouts WHERE locked_until > $1 ORDER BY locked_until DESC`,
    [now],
  )
  return rows.map(fromLockoutRow)
}
