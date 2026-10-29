import { randomUUID } from 'node:crypto'
import {
  assertCidr,
  assertId,
  assertIp,
  assertIsoDate,
  assertLine,
  assertSha256Hex,
  fail,
  isUuid,
} from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { first, mustExist, nowIso } from './util.ts'

export interface ApiTokenRecord {
  id: Id
  principalId: Id
  name: string
  tokenHash: string
  scopes: string[]
  allowedIps: string[]
  expiresAt: string
  lastUsedAt: string | null
  lastUsedIp: string | null
  createdAt: string
  revokedAt: string | null
}

interface ApiTokenRow {
  id: string
  principal_id: string
  name: string
  token_hash: string
  scopes: string
  allowed_ips: string
  expires_at: string
  last_used_at: string | null
  last_used_ip: string | null
  created_at: string
  revoked_at: string | null
  [k: string]: unknown
}

const SCOPE_RE = /^[a-z*][a-z0-9_.:*-]{0,63}$/

const fromRow = (r: ApiTokenRow): ApiTokenRecord => ({
  id: r.id,
  principalId: r.principal_id,
  name: r.name,
  tokenHash: r.token_hash,
  scopes: JSON.parse(r.scopes) as string[],
  allowedIps: JSON.parse(r.allowed_ips) as string[],
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  lastUsedIp: r.last_used_ip,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
})

const normalizeCidrOrHost = (v: string, what: string): string => {
  if (v.includes('/')) return assertCidr(v, what)
  const ip = assertIp(v, what)
  return ip.includes(':') ? `${ip}/128` : `${ip}/32`
}

export const createApiToken = (
  db: Db,
  input: {
    principalId: Id
    name: string
    tokenHash: string
    scopes?: readonly string[]
    allowedIps?: readonly string[]
    expiresAt: string
  },
): Promise<ApiTokenRecord> =>
  withSqliteErrors(async () => {
    const id = randomUUID()
    const principalId = assertId(input.principalId, 'principalId')
    const name = assertLine(input.name, 128, 'name', { allowEmpty: false })
    const tokenHash = assertSha256Hex(input.tokenHash, 'tokenHash')
    const scopes = [...new Set((input.scopes ?? []).map((s) => {
      if (typeof s !== 'string' || !SCOPE_RE.test(s)) return fail('VALIDATION', `invalid scope: ${String(s)}`)
      return s
    }))]
    const allowedIps = [...new Set((input.allowedIps ?? []).map((ip) => normalizeCidrOrHost(ip, 'allowedIps')))]
    const expiresAt = assertIsoDate(input.expiresAt, 'expiresAt').toISOString()
    const now = nowIso()
    if (Date.parse(expiresAt) <= Date.parse(now)) {
      fail('VALIDATION', 'api token expiresAt must be in the future')
    }
    const rows = await db.query<ApiTokenRow>(
      `INSERT INTO api_tokens (
        id, principal_id, name, token_hash, scopes, allowed_ips, expires_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [id, principalId, name, tokenHash, JSON.stringify(scopes), JSON.stringify(allowedIps), expiresAt, now],
    )
    return fromRow(mustExist(rows[0], 'api token', id))
  })

export const findActiveApiTokenByHash = async (
  db: Db,
  tokenHash: string,
  now: string = nowIso(),
): Promise<ApiTokenRecord | null> => {
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/i.test(tokenHash)) return null
  const rows = await db.query<ApiTokenRow>(
    `SELECT * FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [tokenHash.toLowerCase(), now],
  )
  const row = first(rows)
  return row ? fromRow(row) : null
}

/** Persist successful authentication; coalesce same-address bursts within 60 seconds without process-local caches. */
export const recordApiTokenUse = (db: Db, id: Id, ip: string | null): Promise<void> =>
  withSqliteErrors(async () => {
    const tid = assertId(id, 'id')
    const cleanIp = ip === null ? null : assertIp(ip, 'ip')
    const now = nowIso()
    const before = new Date(Date.parse(now) - 60_000).toISOString()
    await db.query(
      `UPDATE api_tokens SET last_used_at = $1, last_used_ip = $2
       WHERE id = $3 AND revoked_at IS NULL AND expires_at > $1
       AND EXISTS (SELECT 1 FROM principals WHERE principals.id = api_tokens.principal_id AND disabled = 0)
       AND (last_used_at IS NULL OR last_used_at <= $4 OR last_used_ip IS NOT $2)`,
      [now, cleanIp, tid, before],
    )
  })

export const revokeApiToken = (db: Db, id: Id, principalId?: Id): Promise<void> =>
  withSqliteErrors(async () => {
    const tid = assertId(id, 'id')
    const now = nowIso()
    const rows =
      principalId !== undefined
        ? await db.query<{ id: string }>(
            `UPDATE api_tokens SET revoked_at = coalesce(revoked_at, $1) WHERE id = $2 AND principal_id = $3 RETURNING id`,
            [now, tid, assertId(principalId, 'principalId')],
          )
        : await db.query<{ id: string }>(
            `UPDATE api_tokens SET revoked_at = coalesce(revoked_at, $1) WHERE id = $2 RETURNING id`,
            [now, tid],
          )
    mustExist(rows[0], 'api token', id)
  })

/** Permanently revokes every token issued before a credential or factor change. */
export const revokeAllApiTokensForPrincipal = (db: Db, principalId: Id): Promise<number> =>
  withSqliteErrors(async () => {
    const pid = assertId(principalId, 'principalId')
    const rows = await db.query<{ id: string }>(
      'UPDATE api_tokens SET revoked_at = $1 WHERE principal_id = $2 AND revoked_at IS NULL RETURNING id',
      [nowIso(), pid],
    )
    return rows.length
  })

export const listApiTokensForPrincipal = async (db: Db, principalId: Id): Promise<ApiTokenRecord[]> => {
  if (!isUuid(principalId)) return []
  const rows = await db.query<ApiTokenRow>(
    `SELECT * FROM api_tokens WHERE principal_id = $1 ORDER BY created_at DESC`,
    [principalId.toLowerCase()],
  )
  return rows.map(fromRow)
}
