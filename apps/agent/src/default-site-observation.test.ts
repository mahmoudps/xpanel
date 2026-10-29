import { describe, expect, it } from 'vitest'
import { DEFAULT_SITE_LOG_BYTES, parseDefaultSiteLogTail, readDefaultSiteRequests } from './default-site-observation.ts'

const at = '2026-10-26T21:30:00.000Z'
const row = (extra: Record<string, unknown> = {}) => JSON.stringify({ time: '2026-10-26T23:29:00+02:00', host: 'unbound.example.test', ip: '192.0.2.1', status: 404, ...extra }) + '\n'
const tail = (text: string, partialStart = false) => ({ bytes: Buffer.from(text), partialStart })

describe('bounded default-vhost request observations', () => {
  it('projects only approved table columns and converts actual log time to ASCII UTC', () => {
    const observation = parseDefaultSiteLogTail(tail(row({ uri: '/?token=private', referer: 'https://private.test/', agent: 'private-agent' })), at)
    expect(observation).toMatchObject({ state: 'read', limit: 100, truncated: false, malformedRecords: 0, items: [{ at: '2026-10-26T21:29:00.000Z', host: 'unbound.example.test', address: '192.0.2.1', status: 404 }] })
    expect(JSON.stringify(observation)).not.toMatch(/private|uri|referer|agent/)
  })
  it('marks malformed records partial without presenting them as empty success', () => {
    const observation = parseDefaultSiteLogTail(tail('not-json\n' + row({ ip: 'invalid' }) + row({ ip: '2001:db8::1', status: 302 })), at)
    expect(observation.state).toBe('partial'); expect(observation.malformedRecords).toBe(2)
    expect(observation.items).toHaveLength(1); expect(observation.items[0]!.address).toBe('2001:db8::1')
  })
  it('discards incomplete tail boundaries and preserves the actual complete records', () => {
    const observation = parseDefaultSiteLogTail(tail('partial-before\n' + row() + '{"time":', true), at)
    expect(observation).toMatchObject({ state: 'partial', truncated: true, malformedRecords: 1 })
    expect(observation.items).toHaveLength(1)
  })
  it('bounds returned rows and marks the result window truncated', () => {
    const observation = parseDefaultSiteLogTail(tail(Array.from({ length: 101 }, (_, index) => row({ host: index + '.example.test' })).join('')), at)
    expect(observation.items).toHaveLength(100); expect(observation.truncated).toBe(true)
  })
  it('distinguishes an actually empty observed file from missing or unreadable native source', async () => {
    expect(parseDefaultSiteLogTail(tail(''), at)).toMatchObject({ state: 'read', items: [], truncated: false })
    expect(await readDefaultSiteRequests({ now: () => new Date(at), readTail: async () => { throw new Error('Synthetic missing log') } })).toMatchObject({ state: 'unavailable', items: [], reason: 'default_log_unavailable' })
  })
  it('refuses excess bytes and marks invalid UTF-8 partial rather than exposing replacement text', () => {
    expect(() => parseDefaultSiteLogTail({ bytes: new Uint8Array(DEFAULT_SITE_LOG_BYTES + 1), partialStart: false }, at)).toThrow()
    expect(parseDefaultSiteLogTail({ bytes: Buffer.from([0xff, 10]), partialStart: false }, at)).toMatchObject({ state: 'partial', malformedRecords: 1, items: [] })
  })
})
