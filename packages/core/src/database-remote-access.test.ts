import { describe, expect, it } from 'vitest'
import { databaseRemoteAccessRevision, databaseRemoteHost, parseDatabaseRemoteAccessRequest, parseDatabaseRemoteEntries, remoteAccessEntriesAfter } from './database-remote-access.ts'
import type { DatabaseRemoteAccessSnapshot } from './database-remote-access.ts'
const createdAt = '2026-10-27T00:00:00.000Z', accountId = '11111111-1111-4111-8111-111111111111', dbId = '22222222-2222-4222-8222-222222222222'
const snapshot = (): DatabaseRemoteAccessSnapshot => ({ account: { id: accountId, username: 'alice', createdAt, status: 'active', planId: dbId, uid: 1001, gid: 1001, home: '/home/alice', ownerId: null, ipv4: '192.0.2.1', ipv6: null, databaseRemoteAccess: [], primaryDomain: 'alice.example.test', suspendReason: null, contactEmail: 'owner@alice.example.test', shell: 'none' }, databases: [{ id: dbId, accountId, name: 'alice_shop', engine: 'mariadb', trashedAt: null }], users: [{ id: '33333333-3333-4333-8333-333333333333', accountId, name: 'alice_app', authPlugin: 'mysql_native_password', authString: '*' + 'A'.repeat(40), grants: [{ databaseId: dbId, privileges: ['SELECT'] }] }] })
describe('canonical database remote host policy', () => {
  it.each([['192.0.2.7', '192.0.2.7', '192.0.2.7'], ['192.0.2.%', '192.0.2.0/24', '192.0.2.0/255.255.255.0'], ['10.%', '10.0.0.0/8', '10.0.0.0/255.0.0.0'], ['192.0.2.0/25', '192.0.2.0/25', '192.0.2.0/255.255.255.128'], ['2001:0DB8::7', '2001:db8::7', '2001:db8::7'], ['::ffff:192.0.2.7', '192.0.2.7', '192.0.2.7']])('canonicalizes %s without a broad wildcard', (input, host, sqlHost) => { expect(databaseRemoteHost(input)).toMatchObject({ host, sqlHost }) })
  it.each(['%', '0.0.0.0/0', '::/0', '2001:db8::/64', '192.0.2.1/24', '01.2.3.4', 'example.com', 'localhost', '192.0.2.%evil', '192.0.2.7\n', "192.0.2.7';DROP USER", '192.0.2.7/033'])('refuses ambiguous or unbounded host %j', input => { expect(() => databaseRemoteHost(input)).toThrow() })
  it('refuses noncanonical/duplicate saved hosts, invalid metadata, extras and capacity overflow', () => {
    const row = { host: '192.0.2.7', comment: '', createdAt }
    for (const raw of [[row, row], [{ ...row, host: '192.0.2.%' }], [{ ...row, comment: '<b>bad</b>' }], [{ ...row, secret: 'hidden' }], [{ ...row, createdAt: 'yesterday' }], Array(101).fill(row)]) expect(() => parseDatabaseRemoteEntries(raw)).toThrow()
  })
  it('requires exact owner mutation fields and current revision; normalizes legacy input only at ingress', () => {
    const request = { action: 'add', expectedRevision: 'a'.repeat(64), host: '192.0.2.%', comment: 'Office' }
    expect(parseDatabaseRemoteAccessRequest(request).host).toBe('192.0.2.0/24')
    for (const raw of [{ ...request, accountId }, { ...request, expectedRevision: '' }, { ...request, action: 'clear' }, { ...request, comment: ' bad ' }, { ...request, host: '%' }]) expect(() => parseDatabaseRemoteAccessRequest(raw)).toThrow()
  })
  it('keeps sibling hosts and original issue time on edit/remove and refuses duplicate/no-op edits', () => {
    const before = [{ host: '192.0.2.7', comment: 'Office', createdAt }, { host: '198.51.100.2', comment: 'Branch', createdAt }], revision = 'a'.repeat(64)
    const edited = remoteAccessEntriesAfter(before, { action: 'edit', expectedRevision: revision, host: before[0]!.host, replacement: '203.0.113.2', comment: 'New office' }, '2026-10-28T00:00:00.000Z')
    expect(edited).toContainEqual(before[1]); expect(edited.find(row => row.host === '203.0.113.2')?.createdAt).toBe(createdAt)
    expect(remoteAccessEntriesAfter(edited, { action: 'remove', expectedRevision: revision, host: '203.0.113.2' }, createdAt)).toEqual([before[1]])
    expect(() => remoteAccessEntriesAfter(before, { action: 'edit', expectedRevision: revision, host: before[0]!.host, replacement: before[1]!.host, comment: '' }, createdAt)).toThrow()
    expect(() => remoteAccessEntriesAfter(before, { action: 'edit', expectedRevision: revision, host: before[0]!.host, replacement: before[0]!.host, comment: before[0]!.comment }, createdAt)).toThrow()
  })
  it('fences lifetime, host identity, ownership, network, grants and password changes without returning authentication data', () => {
    const original = snapshot(), revision = databaseRemoteAccessRevision(original)
    for (const patch of [{ uid: 1002 }, { gid: 1002 }, { home: '/home/renamed' }, { ownerId: dbId }, { ipv4: '192.0.2.2' }, { ipv6: '2001:db8::1' }, { status: 'suspended' }, { createdAt: '2026-10-28T00:00:00.000Z' }]) expect(databaseRemoteAccessRevision({ ...original, account: { ...original.account, ...patch } as typeof original.account })).not.toBe(revision)
    expect(databaseRemoteAccessRevision({ ...original, users: [{ ...original.users[0]!, authString: '*' + 'B'.repeat(40) }] })).not.toBe(revision)
    expect(databaseRemoteAccessRevision({ ...original, users: [{ ...original.users[0]!, grants: [{ databaseId: dbId, privileges: ['UPDATE'] }] }] })).not.toBe(revision)
    expect(revision).toMatch(/^[0-9a-f]{64}$/)
    expect(() => databaseRemoteAccessRevision({ ...original, databases: [{ ...original.databases[0]!, accountId: dbId }] })).toThrow()
  })
})
