import { eq, sql } from 'drizzle-orm'
import { fail } from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withPgErrors } from '../pg-errors.ts'
import { principals } from '../schema.ts'
import { assertArgon2Hash, assertPrincipalUsername } from '../validate.ts'
import { assertId, first, isUuid, mustExist } from './util.ts'

export type PrincipalKind = 'root' | 'reseller' | 'user'

/** Panel login as the auth layer sees it. The TOTP secret stays sealed. */
export interface PrincipalRecord {
  id: Id
  kind: PrincipalKind
  username: string
  passwordHash: string
  forcePasswordChange: boolean
  totpSecretEnc: Uint8Array | null
  totpEnabled: boolean
  accountId: Id | null
  disabled: boolean
  lastLoginAt: string | null
}

type Row = typeof principals.$inferSelect

const fromRow = (r: Row): PrincipalRecord => ({
  id: r.id,
  kind: r.kind,
  username: r.username,
  passwordHash: r.passwordHash,
  forcePasswordChange: r.forcePasswordChange,
  totpSecretEnc: r.totpSecretEnc,
  totpEnabled: r.totpEnabledAt !== null,
  accountId: r.accountId,
  disabled: r.disabled,
  lastLoginAt: r.lastLoginAt ? r.lastLoginAt.toISOString() : null,
})

/** Root logins only; resellers and account owners are created by their repos. */
export const createRootPrincipal = (
  db: Db,
  input: { username: string; passwordHash: string; forcePasswordChange?: boolean },
): Promise<PrincipalRecord> =>
  withPgErrors(async () => {
    const [row] = await db
      .insert(principals)
      .values({
        kind: 'root',
        username: assertPrincipalUsername(input.username),
        passwordHash: assertArgon2Hash(input.passwordHash),
        forcePasswordChange: input.forcePasswordChange ?? true,
      })
      .returning()
    return fromRow(mustExist(row, 'principal', input.username))
  })

export const getPrincipal = async (db: Db, id: Id): Promise<PrincipalRecord | null> => {
  if (!isUuid(id)) return null
  const row = first(await db.select().from(principals).where(eq(principals.id, id)))
  return row ? fromRow(row) : null
}

/** Case-insensitive, like the unique index. */
export const findPrincipalByUsername = async (db: Db, username: string): Promise<PrincipalRecord | null> => {
  if (typeof username !== 'string' || username.length === 0 || username.length > 64) return null
  const row = first(await db.select().from(principals).where(eq(sql`lower(${principals.username})`, username.toLowerCase())))
  return row ? fromRow(row) : null
}

export const setPasswordHash = (db: Db, id: Id, passwordHash: string, opts: { forceChange?: boolean } = {}): Promise<void> =>
  withPgErrors(async () => {
    const rows = await db
      .update(principals)
      .set({ passwordHash: assertArgon2Hash(passwordHash), forcePasswordChange: opts.forceChange ?? false, passwordChangedAt: new Date() })
      .where(eq(principals.id, assertId(id, 'id')))
      .returning({ id: principals.id })
    mustExist(rows[0], 'principal', id)
  })

/** Store an already-sealed TOTP secret (or null to disable 2FA). */
export const setTotpSecret = (db: Db, id: Id, sealed: Uint8Array | null): Promise<void> =>
  withPgErrors(async () => {
    if (sealed !== null && (!(sealed instanceof Uint8Array) || sealed.byteLength < 16 || sealed.byteLength > 1024)) {
      fail('VALIDATION', 'sealed TOTP secret must be 16..1024 bytes')
    }
    const rows = await db
      .update(principals)
      .set({ totpSecretEnc: sealed, totpEnabledAt: sealed ? new Date() : null, totpRecoveryHashes: sealed ? undefined : [] })
      .where(eq(principals.id, assertId(id, 'id')))
      .returning({ id: principals.id })
    mustExist(rows[0], 'principal', id)
  })

export const recordLogin = (db: Db, id: Id): Promise<void> =>
  withPgErrors(async () => {
    await db.update(principals).set({ lastLoginAt: new Date() }).where(eq(principals.id, assertId(id, 'id')))
  })

export const setPrincipalDisabled = (db: Db, id: Id, disabled: boolean): Promise<void> =>
  withPgErrors(async () => {
    const rows = await db.update(principals).set({ disabled }).where(eq(principals.id, assertId(id, 'id'))).returning({ id: principals.id })
    mustExist(rows[0], 'principal', id)
  })
