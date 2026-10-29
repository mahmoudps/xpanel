import { describe, expect, it } from 'vitest'
import { parseOwnerDatabaseCreateRequest, parseOwnerDatabaseGrantRequest, parseOwnerDatabaseStateRequest, parseOwnerDatabaseUserCreateRequest, projectDatabaseWorkspaceUser } from './database-workspace.ts'
import { isXpanelError } from './errors.ts'

const username = 'owner'
const target = '11111111-aaaa-4111-8111-111111111111'
const password = 'x'.repeat(16)
const codeOf = (fn: () => unknown): string => {
  try { fn(); return 'ok' } catch (error) { return isXpanelError(error) ? error.code : 'raw' }
}

describe('owner database recoverable state request', () => {
  it('binds trash to a live expectation and restore to the exact stored timestamp', () => {
    expect(parseOwnerDatabaseStateRequest({ expectedTrashedAt: null, confirmation: 'owner_live' }, 'trash'))
      .toEqual({ expectedTrashedAt: null, confirmation: 'owner_live' })
    const body = { expectedTrashedAt: '2026-01-01T00:00:00.000Z', confirmation: 'owner_live' }
    expect(parseOwnerDatabaseStateRequest(body, 'restore')).toEqual(body)
  })
  it.each([{}, { expectedTrashedAt: null }, { expectedTrashedAt: null, confirmation: ' owner_live' },
    { expectedTrashedAt: null, confirmation: 'owner_live', accountId: target },
    { expectedTrashedAt: '2026-01-01T00:00:00.000Z', confirmation: 'owner_live' }])('rejects malformed trash body %j', body => {
    expect(codeOf(() => parseOwnerDatabaseStateRequest(body, 'trash'))).toBe('VALIDATION')
  })
  it.each([null, 'invalid', '2026-02-30T00:00:00.000Z'])('rejects an invalid restore expectation %j', expectedTrashedAt => {
    expect(codeOf(() => parseOwnerDatabaseStateRequest({ expectedTrashedAt, confirmation: 'owner_live' }, 'restore'))).toBe('VALIDATION')
  })
})

describe('owner database privilege edit request', () => {
  it('accepts an explicit absent-grant expectation and canonical requested privileges', () => {
    expect(parseOwnerDatabaseGrantRequest({ databaseId: target.toUpperCase(), privileges: ['UPDATE', 'SELECT', 'SELECT'], expectedPrivileges: null }))
      .toEqual({ databaseId: target, privileges: ['SELECT', 'UPDATE'], expectedPrivileges: null })
  })

  it('canonicalizes but preserves an independent expected grant without rebasing it to the request', () => {
    expect(parseOwnerDatabaseGrantRequest({ databaseId: target, privileges: ['SELECT'], expectedPrivileges: ['UPDATE', 'INSERT', 'UPDATE'] }))
      .toEqual({ databaseId: target, privileges: ['SELECT'], expectedPrivileges: ['INSERT', 'UPDATE'] })
  })

  it('retains existing ALL PRIVILEGES canonicalization for both arrays', () => {
    const request = parseOwnerDatabaseGrantRequest({ databaseId: target, privileges: ['SELECT', 'ALL PRIVILEGES'], expectedPrivileges: ['UPDATE', 'ALL PRIVILEGES'] })
    expect(request.privileges).toEqual(['ALL PRIVILEGES'])
    expect(request.expectedPrivileges).toEqual(['ALL PRIVILEGES'])
  })

  it('rejects unknown account, user, identity and authentication selectors', () => {
    for (const key of ['accountId', 'databaseUserId', 'userId', 'id', 'name', 'password', 'authString']) {
      expect(codeOf(() => parseOwnerDatabaseGrantRequest({ databaseId: target, privileges: ['SELECT'], expectedPrivileges: null, [key]: 'caller-selector' })))
        .toBe('VALIDATION')
    }
  })

  it('requires an explicit null or array expectation instead of silently assuming no grant', () => {
    expect(codeOf(() => parseOwnerDatabaseGrantRequest({ databaseId: target, privileges: ['SELECT'] }))).toBe('VALIDATION')
    expect(codeOf(() => parseOwnerDatabaseGrantRequest({ databaseId: target, privileges: ['SELECT'], expectedPrivileges: undefined }))).toBe('VALIDATION')
  })

  it('rejects malformed and empty expected-privilege shapes', () => {
    for (const expectedPrivileges of [[], 'SELECT', {}, [42], ['GRANT OPTION'], ['select']]) {
      expect(codeOf(() => parseOwnerDatabaseGrantRequest({ databaseId: target, privileges: ['SELECT'], expectedPrivileges }))).toBe('VALIDATION')
    }
  })

  it('requires nonempty known requested privileges without changing privilege authority', () => {
    for (const privileges of [null, undefined, [], 'SELECT', 42, [{}], ['GRANT OPTION'], ['select']]) {
      expect(codeOf(() => parseOwnerDatabaseGrantRequest({ databaseId: target, privileges, expectedPrivileges: null }))).toBe('VALIDATION')
    }
  })

  it('requires an exact UUID database target rather than selectors or newline repair', () => {
    for (const databaseId of ['', 42, { id: target }, [target], `${target}\n`, ` ${target}`]) {
      expect(codeOf(() => parseOwnerDatabaseGrantRequest({ databaseId, privileges: ['SELECT'], expectedPrivileges: null }))).toBe('VALIDATION')
    }
  })

  it.each([['null', null], ['array', []], ['primitive string', 'grant'], ['primitive number', 42]])('rejects a nonobject grant body: %s', (_label, body) => {
    expect(codeOf(() => parseOwnerDatabaseGrantRequest(body))).toBe('VALIDATION')
  })

  it('returns independent canonical arrays without mutating caller expectations', () => {
    const privileges = ['UPDATE', 'SELECT'], expectedPrivileges = ['INSERT', 'SELECT']
    const request = parseOwnerDatabaseGrantRequest({ databaseId: target, privileges, expectedPrivileges })
    request.privileges.push('DELETE')
    request.expectedPrivileges!.push('DELETE')
    expect(privileges).toEqual(['UPDATE', 'SELECT'])
    expect(expectedPrivileges).toEqual(['INSERT', 'SELECT'])
  })
})

describe('owner database request boundaries', () => {
  it('preserves the full-owned-name database create contract', () => {
    expect(parseOwnerDatabaseCreateRequest({ name: 'owner_blog' }, username)).toEqual({ name: 'owner_blog' })
    for (const name of ['blog', 'other_blog', ' OWNER_BLOG ', 'owner_']) {
      expect(codeOf(() => parseOwnerDatabaseCreateRequest({ name }, username))).toBe('VALIDATION')
    }
  })

  it.each([
    ['null', null], ['array', []], ['string', 'owner_blog'], ['number', 42], ['missing name', {}], ['object name', { name: {} }],
  ])('rejects malformed create body: %s', (_label, input) => {
    expect(codeOf(() => parseOwnerDatabaseCreateRequest(input, username))).toBe('VALIDATION')
  })

  it('rejects unsupported identity, account, engine and authentication selectors on both operations', () => {
    for (const key of ['accountId', 'id', 'username', 'engine', 'authString', 'passwordHash', 'authPlugin']) {
      expect(codeOf(() => parseOwnerDatabaseCreateRequest({ name: 'owner_blog', [key]: 'caller-selector' }, username))).toBe('VALIDATION')
      expect(codeOf(() => parseOwnerDatabaseUserCreateRequest({ name: 'writer', password, [key]: 'caller-selector' }, username))).toBe('VALIDATION')
    }
    expect(codeOf(() => parseOwnerDatabaseCreateRequest({ name: 'owner_blog', password }, username))).toBe('VALIDATION')
  })

  it('does not obtain required fields or account selectors from an inherited object', () => {
    const inherited = Object.create({ name: 'writer', password, accountId: 'foreign' }) as object
    expect(codeOf(() => parseOwnerDatabaseUserCreateRequest(inherited, username))).toBe('VALIDATION')
    const plain = Object.assign(Object.create(null) as Record<string, unknown>, { name: 'owner_blog' })
    expect(parseOwnerDatabaseCreateRequest(plain, username)).toEqual({ name: 'owner_blog' })
  })

  it('uses the existing database and shorter user naming rules rather than accepting SQL fragments', () => {
    for (const name of ['owner_bad-name', 'owner_a;DROP', 'owner_a\n', `owner_${'a'.repeat(100)}`]) {
      expect(codeOf(() => parseOwnerDatabaseCreateRequest({ name }, username))).toBe('VALIDATION')
    }
    for (const name of ['bad-name', 'a;DROP', 'owner_', 'a'.repeat(100), {}, null]) {
      expect(codeOf(() => parseOwnerDatabaseUserCreateRequest({ name, password }, username))).toBe('VALIDATION')
    }
  })
})

describe('owner database user and initial grant', () => {
  it('preserves existing user suffix/full-name trim and lowercase behavior', () => {
    for (const name of ['writer', ' WRITER ', 'owner_writer', ' OWNER_WRITER ']) {
      expect(parseOwnerDatabaseUserCreateRequest({ name, password }, username)).toEqual({ name: 'owner_writer', password })
    }
  })

  it('keeps an underscore suffix owned rather than selecting another account', () => {
    expect(parseOwnerDatabaseUserCreateRequest({ name: 'other_writer', password }, username).name).toBe('owner_other_writer')
  })

  it('preserves the existing password length policy without trimming or adding strength rules', () => {
    for (const input of [' '.repeat(8), '\u0000'.repeat(8), String.fromCodePoint(0x1f600).repeat(4), 'x'.repeat(256)]) {
      expect(parseOwnerDatabaseUserCreateRequest({ name: 'writer', password: input }, username).password).toBe(input)
    }
  })

  it.each([
    ['missing', undefined], ['null', null], ['number', 42], ['object', {}], ['array', []], ['wrapper', new String('x'.repeat(8))],
    ['short', 'x'.repeat(7)], ['long', 'x'.repeat(257)],
  ])('rejects malformed password: %s', (_label, input) => {
    expect(codeOf(() => parseOwnerDatabaseUserCreateRequest({ name: 'writer', password: input }, username))).toBe('VALIDATION')
  })

  it('validates and canonicalizes the default initial grant before returning a user DTO', () => {
    const request = parseOwnerDatabaseUserCreateRequest({ name: 'writer', password, databaseId: target.toUpperCase() }, username)
    expect(request.databaseId).toBe(target)
    expect(request.privileges).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
  })

  it('reuses privilege canonicalization and preserves ALL PRIVILEGES semantics', () => {
    expect(parseOwnerDatabaseUserCreateRequest({ name: 'writer', password, databaseId: target, privileges: ['UPDATE', 'SELECT', 'SELECT'] }, username).privileges)
      .toEqual(['SELECT', 'UPDATE'])
    expect(parseOwnerDatabaseUserCreateRequest({ name: 'writer', password, databaseId: target, privileges: ['SELECT', 'ALL PRIVILEGES'] }, username).privileges)
      .toEqual(['ALL PRIVILEGES'])
  })

  it('refuses privileges without a target rather than silently dropping them', () => {
    expect(codeOf(() => parseOwnerDatabaseUserCreateRequest({ name: 'writer', password, privileges: ['SELECT'] }, username))).toBe('VALIDATION')
  })

  it.each([
    ['object selector', { id: target, accountId: 'foreign' }], ['array selector', [target]], ['null', null], ['empty', ''],
    ['missing shape', 'foreign_database'], ['trailing newline', `${target}\n`], ['explicit undefined', undefined],
  ])('rejects malformed target: %s', (_label, databaseId) => {
    expect(codeOf(() => parseOwnerDatabaseUserCreateRequest({ name: 'writer', password, databaseId }, username))).toBe('VALIDATION')
  })

  it.each([
    ['empty', []], ['object', {}], ['string', 'SELECT'], ['number item', [42]], ['object item', [{}]], ['unknown', ['GRANT OPTION']],
    ['lowercase', ['select']], ['explicit undefined', undefined],
  ])('rejects malformed privileges before a DTO can be persisted: %s', (_label, privileges) => {
    expect(codeOf(() => parseOwnerDatabaseUserCreateRequest({ name: 'writer', password, databaseId: target, privileges }, username))).toBe('VALIDATION')
  })

  it('does not include password values in validation diagnostics', () => {
    try {
      parseOwnerDatabaseUserCreateRequest({ name: 'writer', password, authString: 'not-accepted' }, username)
      expect.fail('authentication selector accepted')
    } catch (error) {
      expect(error).toMatchObject({ code: 'VALIDATION' })
      expect(`${(error as Error).message} ${JSON.stringify(error)}`).not.toContain(password)
    }
  })
})

describe('database workspace user response', () => {
  it('drops authentication/account extras, preserves actual grants and returns independent arrays', () => {
    const stored = {
      id: target, accountId: '22222222-bbbb-4222-8222-222222222222', name: 'owner_writer',
      authPlugin: 'mysql_native_password', authString: 'synthetic-auth-value', passwordHash: 'synthetic-hash-value', password,
      grants: [{ databaseId: target, privileges: ['UPDATE', 'SELECT'], authString: 'synthetic-extra' }],
    }
    const response = projectDatabaseWorkspaceUser(stored)
    expect(response).toEqual({ id: target, name: 'owner_writer', grants: [{ databaseId: target, privileges: ['UPDATE', 'SELECT'] }] })
    response.grants[0]!.privileges.push('DELETE')
    expect(stored.grants[0]!.privileges).toEqual(['UPDATE', 'SELECT'])
    expect(response).not.toHaveProperty('authString')
    expect(response).not.toHaveProperty('passwordHash')
    expect(response).not.toHaveProperty('password')
  })
})
