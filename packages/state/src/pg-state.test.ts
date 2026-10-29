import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertPostgresqlPassword, assertPostgresqlRoleName, assertPostgresqlVerifier, postgresqlScramVerifier, scramSha256Verifier, toPublicPostgresqlUser, validatePostgresqlDatabaseFile, validatePostgresqlUserFile } from './pg-state.ts'
import type { StoredAccount } from './types.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice' } as StoredAccount
const verifier = postgresqlScramVerifier('pencil-pencil', Buffer.alloc(16, 7))
const hmac = (key: Buffer, text: string): Buffer => createHmac('sha256', key).update(text).digest()

describe('PostgreSQL state', () => {
  it('builds the SCRAM-SHA-256 verifier that answers the RFC 7677 exchange', () => {
    // RFC 7677 section 3: user "user", password "pencil", the listed salt and nonces, 4096 iterations.
    const keys = /^SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$([^:]+):(.+)$/.exec(scramSha256Verifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64')))!
    const storedKey = Buffer.from(keys[1]!, 'base64'), serverKey = Buffer.from(keys[2]!, 'base64')
    const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0'
    const auth = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`
    expect(hmac(serverKey, auth).toString('base64')).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=')
    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64'), signature = hmac(storedKey, auth)
    expect(createHash('sha256').update(Buffer.from(proof.map((byte, index) => byte ^ signature[index]!))).digest().equals(storedKey)).toBe(true)
  })
  it('stores only a verifier with the reviewed shape', () => {
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:BwcHBwcHBwcHBwcHBwcHBw==\$/)
    expect(verifier).not.toContain('pencil')
    expect(assertPostgresqlVerifier(verifier)).toBe(verifier)
    expect(postgresqlScramVerifier('pencil-pencil')).not.toBe(postgresqlScramVerifier('pencil-pencil'))
    for (const value of ['md5abc', verifier + "'", verifier.replace('4096', '1'), null]) expect(() => assertPostgresqlVerifier(value)).toThrow()
    for (const value of ['short', 'x'.repeat(257), 'pässwörd-long', 'tab\there-long', 7]) expect(() => assertPostgresqlPassword(value)).toThrow()
    expect(() => postgresqlScramVerifier('pencil')).toThrow()
    expect(() => scramSha256Verifier('pencil-pencil', Buffer.alloc(8))).toThrow()
  })
  it('accepts only account-prefixed role names outside the reserved pg_ namespace', () => {
    expect(assertPostgresqlRoleName('alice', 'alice_app')).toBe('alice_app')
    for (const name of ['bob_app', 'alice', 'alice_' + 'x'.repeat(30), 'alice_App', 'alice_a"b']) expect(() => assertPostgresqlRoleName('alice', name)).toThrow()
    expect(() => assertPostgresqlRoleName('pg', 'pg_app')).toThrow('reserves')
  })
  it('validates saved files against their account and the saved owner roles', () => {
    const user = { id: '22222222-2222-4222-8222-222222222222', accountId: account.id, name: 'alice_app', authPlugin: 'scram-sha-256', authString: verifier }
    expect(toPublicPostgresqlUser(validatePostgresqlUserFile(user, account))).toEqual({ id: user.id, accountId: account.id, name: 'alice_app' })
    for (const bad of [{ ...user, accountId: '33333333-3333-4333-8333-333333333333' }, { ...user, authPlugin: 'mysql_native_password' }, { ...user, name: 'bob_app' }, { ...user, authString: 'secret' }]) expect(() => validatePostgresqlUserFile(bad, account)).toThrow()
    const database = { id: '44444444-4444-4444-8444-444444444444', accountId: account.id, engine: 'postgresql', name: 'alice_db', owner: 'alice_app', trashedAt: null }
    expect(validatePostgresqlDatabaseFile(database, account, new Set(['alice_app']))).toEqual(database)
    expect(validatePostgresqlDatabaseFile({ ...database, trashedAt: '2026-10-28T10:00:00Z' }, account, new Set(['alice_app'])).trashedAt).toBe('2026-10-28T10:00:00.000Z')
    for (const bad of [{ ...database, engine: 'mariadb' }, { ...database, owner: 'alice_other' }, { ...database, name: 'bob_db' }, { ...database, owner: undefined }]) expect(() => validatePostgresqlDatabaseFile(bad, account, new Set(['alice_app']))).toThrow()
  })
})
