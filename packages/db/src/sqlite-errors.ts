import { XpanelError, isXpanelError } from '@xpanel/core'
import type { ErrorCode } from '@xpanel/core'

export interface SqliteErrorLike {
  code?: string
  errcode?: number
  errstr?: string
  message?: string
}

export const isSqliteError = (e: unknown): e is SqliteErrorLike =>
  typeof e === 'object' &&
  e !== null &&
  ((e as SqliteErrorLike).code === 'ERR_SQLITE_ERROR' || typeof (e as SqliteErrorLike).errcode === 'number')

export const findSqliteError = (e: unknown): SqliteErrorLike | undefined => {
  let cur: unknown = e
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (isSqliteError(cur)) return cur
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

const PREFIX_CODES: readonly ErrorCode[] = [
  'FORBIDDEN',
  'VALIDATION',
  'CONFLICT',
  'NOT_FOUND',
  'PRECONDITION_FAILED',
  'LIMIT_EXCEEDED',
]

/**
 * Converts a SQLite error into an XpanelError with a safe message (constraint/table name only,
 * never echoing bound parameters or secrets).
 */
export const toXpanelError = (e: unknown): unknown => {
  if (isXpanelError(e)) return e
  const sq = findSqliteError(e)
  if (!sq) return e
  const msg = sq.message ?? ''

  for (const prefix of PREFIX_CODES) {
    if (msg.startsWith(`${prefix}:`)) {
      const clean = msg.slice(prefix.length + 1).trim() || prefix.toLowerCase()
      return new XpanelError(prefix, clean, { sqliteCode: sq.errcode ?? null })
    }
  }

  if (/UNIQUE constraint failed/i.test(msg)) {
    const target = msg.split(':').slice(1).join(':').trim() || 'unique constraint'
    return new XpanelError('CONFLICT', `already exists (${target})`, {
      sqliteCode: sq.errcode ?? 19,
      constraint: target,
    })
  }

  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return new XpanelError('NOT_FOUND', 'referenced row does not exist (foreign key)', {
      sqliteCode: sq.errcode ?? 19,
      constraint: 'foreign_key',
    })
  }

  if (/NOT NULL constraint failed|CHECK constraint failed|datatype mismatch/i.test(msg)) {
    const target = msg.split(':').slice(1).join(':').trim() || 'constraint'
    return new XpanelError('VALIDATION', `invalid value (${target})`, {
      sqliteCode: sq.errcode ?? 19,
      constraint: target,
    })
  }

  if (/database is locked|database table is locked|SQLITE_BUSY/i.test(msg) || sq.errcode === 5 || sq.errcode === 6) {
    return new XpanelError('CONFLICT', 'concurrent change, retry (sqlite_busy)', {
      sqliteCode: sq.errcode ?? 5,
    })
  }

  return Object.assign(new Error(`database error: ${msg}`), { sqliteCode: sq.errcode ?? null })
}

/** Runs fn and rethrows SQLite errors as XpanelError. */
export const withSqliteErrors = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (e) {
    throw toXpanelError(e)
  }
}
