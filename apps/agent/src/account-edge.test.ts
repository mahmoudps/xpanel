import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { accountEdgeSiteOptions, edgeStatePath, parseAccountEdgeState, readAccountEdgeState, writeAccountEdgeState, ipBlockerRange, nextCacheEpoch, parseIpBlockerInput, readAccountEdge, readEdgeCacheRecord, readIpBlockerRecord, removeAccountEdgeState } from './account-edge.ts'
import { leechStatePath } from './leech-protection.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222'
const at = '2026-11-07T10:00:00.000Z'

describe('account edge desired state', () => {
  it('turns cPanel IP Blocker input into the exact covering CIDR blocks', () => {
    // cPanel acceptance: 10.5.3.3-40 covers exactly 10.5.3.3 through 10.5.3.40.
    const range = parseIpBlockerInput('10.5.3.3-40')
    expect(range).toEqual({ entries: ['10.5.3.3', '10.5.3.4/30', '10.5.3.8/29', '10.5.3.16/28', '10.5.3.32/29', '10.5.3.40'] })
    if (!('entries' in range)) throw new Error('expected entries')
    expect(ipBlockerRange(range.entries[0]!).first).toBe('10.5.3.3'); expect(ipBlockerRange(range.entries.at(-1)!).last).toBe('10.5.3.40')
    expect(parseIpBlockerInput(' 192.0.2.7 ')).toEqual({ entries: ['192.0.2.7'] })
    expect(parseIpBlockerInput('192.0.2.77/24')).toEqual({ entries: ['192.0.2.0/24'] })
    expect(parseIpBlockerInput('10.')).toEqual({ entries: ['10.0.0.0/8'] })
    expect(parseIpBlockerInput('172.16.5.')).toEqual({ entries: ['172.16.5.0/24'] })
    expect(parseIpBlockerInput('198.51.100.0-198.51.101.255')).toEqual({ entries: ['198.51.100.0/23'] })
    expect(parseIpBlockerInput('2001:DB8:0:0::1')).toEqual({ entries: ['2001:db8::1'] })
    expect(parseIpBlockerInput('2001:db8:aaaa::7/48')).toEqual({ entries: ['2001:db8:aaaa::/48'] })
    expect(parseIpBlockerInput('2001:db8::-2001:db8::3')).toEqual({ entries: ['2001:db8::/126'] })
    expect(ipBlockerRange('2001:db8::/126')).toEqual({ first: '2001:db8::', last: '2001:db8::3' })
    expect(ipBlockerRange('10.5.3.4/30')).toEqual({ first: '10.5.3.4', last: '10.5.3.7' })
  })
  it('refuses invalid text, loopback ranges, inverted and over-wide ranges', () => {
    for (const input of ['abc', '', '10.0.0.0/33', '01.2.3.4', 'fe80::1%eth0', '::ffff:127.0.0.9', '192.0.2.1 192.0.2.2', '1.2.3.4/024', '1.2.3.4-5-6', '1.2.3.4-2001:db8::1', 'example.com', '192.0.2.1;deny', 'x'.repeat(101)])
      expect(parseIpBlockerInput(input), input).toEqual({ code: 'address' })
    for (const input of ['127.0.0.1', '127.', '0.0.0.0/0', '::1', '::/0', '126.0.0.0-128.0.0.0']) expect(parseIpBlockerInput(input), input).toEqual({ code: 'protected_address' })
    expect(parseIpBlockerInput('10.5.3.40-3')).toEqual({ code: 'range' })
    expect(parseIpBlockerInput('2001:db8::1-2001:db8:ffff:ffff:ffff:ffff:ffff:fffe')).toEqual({ code: 'too_many' })
  })
  it('accepts only canonical saved records and bounds the cache epoch', () => {
    expect(readIpBlockerRecord({ version: 1, entries: ['192.0.2.7', '10.5.3.4/30'], updatedAt: at })).toEqual({ version: 1, entries: ['192.0.2.7', '10.5.3.4/30'], updatedAt: at })
    for (const entries of [['192.0.2.77/24'], ['192.0.2.7', '192.0.2.7'], ['127.0.0.1'], ['2001:DB8::1'], [7]]) expect(readIpBlockerRecord({ version: 1, entries, updatedAt: at }), String(entries)).toBeNull()
    expect(readIpBlockerRecord({ version: 1, entries: [], updatedAt: at, extra: true })).toBeNull()
    expect(readEdgeCacheRecord({ version: 1, enabled: false, epoch: 'mh3k2a9z', purgedAt: at, updatedAt: at })).toMatchObject({ enabled: false, epoch: 'mh3k2a9z' })
    for (const epoch of ['', 'A', 'a"b']) expect(readEdgeCacheRecord({ version: 1, enabled: true, epoch, purgedAt: at, updatedAt: at }), epoch).toBeNull()
    expect(readEdgeCacheRecord({ version: 1, enabled: true, epoch: 'a1', purgedAt: null, updatedAt: at })).toBeNull()
    const now = new Date(at)
    expect(nextCacheEpoch(now, null)).toBe(now.getTime().toString(36))
    expect(nextCacheEpoch(now, now.getTime().toString(36))).not.toBe(now.getTime().toString(36))
    expect(() => edgeStatePath('cache', '../x')).toThrow()
  })
  it('reads one file per account for the reconciler and stops on an invalid file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xpanel-account-edge-'))
    try {
      expect(await readAccountEdge(root, [{ id: ACCOUNT }])).toEqual(new Map())
      await mkdir(join(root, 'extended/edge/ip-blocker'), { recursive: true }); await mkdir(join(root, 'extended/edge/cache'), { recursive: true })
      await writeFile(join(root, edgeStatePath('ip-blocker', ACCOUNT)), JSON.stringify({ version: 1, entries: ['203.0.113.9'], updatedAt: at }))
      await writeFile(join(root, edgeStatePath('cache', OTHER)), JSON.stringify({ version: 1, enabled: false, epoch: null, purgedAt: null, updatedAt: at }))
      const edge = await readAccountEdge(root, [{ id: ACCOUNT }, { id: OTHER }])
      expect(accountEdgeSiteOptions(edge, ACCOUNT)).toEqual({ accountEdge: { deny: ['203.0.113.9'], cacheEpoch: null } })
      expect(accountEdgeSiteOptions(edge, OTHER)).toEqual({ accountEdge: { deny: [], cacheEpoch: null }, cache: false })
      expect(accountEdgeSiteOptions(edge, '33333333-3333-4333-8333-333333333333')).toEqual({})
      await writeFile(join(root, edgeStatePath('ip-blocker', OTHER)), JSON.stringify({ version: 1, entries: ['10.0.0.1/8'], updatedAt: at }))
      await expect(readAccountEdge(root, [{ id: OTHER }])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      await writeFile(join(root, edgeStatePath('ip-blocker', OTHER)), '{')
      await expect(readAccountEdge(root, [{ id: OTHER }])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('carries an account edge state through a transfer and refuses non-canonical records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xpanel-account-edge-'))
    try {
      const state = { ipBlocker: { version: 1 as const, entries: ['203.0.113.7'], updatedAt: '2026-10-29T00:00:00.000Z' } }
      expect(await readAccountEdgeState(root, ACCOUNT)).toEqual({})
      await writeAccountEdgeState(root, ACCOUNT, state, async () => undefined)
      expect(await readAccountEdgeState(root, ACCOUNT)).toEqual(state)
      expect(parseAccountEdgeState({ ...state, extra: true })).toBeNull()
      expect(parseAccountEdgeState({ cache: { version: 2 } })).toBeNull()
      expect(parseAccountEdgeState({ leech: { version: 1, folders: [{ path: '../up' }], updatedAt: '2026-10-29T00:00:00.000Z' } })).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('leaves no edge state behind a retired account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xpanel-account-edge-'))
    try {
      const paths = (id: string) => [edgeStatePath('ip-blocker', id), edgeStatePath('cache', id), leechStatePath(id)]
      for (const path of [...paths(ACCOUNT), ...paths(OTHER)]) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), '{}') }
      await removeAccountEdgeState(root, ACCOUNT)
      await removeAccountEdgeState(root, ACCOUNT)
      for (const path of paths(ACCOUNT)) await expect(access(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' })
      for (const path of paths(OTHER)) await expect(access(join(root, path))).resolves.toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
