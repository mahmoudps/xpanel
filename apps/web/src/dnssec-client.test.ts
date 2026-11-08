import { describe, expect, it } from 'vitest'
import { renderClassicDnssecSection } from './board-port/dnssec-section.ts'
import { DNSSEC_CLIENT_BINDING, dnssecDsLines, dnssecKeyActions, dnssecState, dnssecUtc } from './dnssec-client.ts'
import { renderV2DnssecCard } from './themes/v2/pages/xpanel/services/dnssec.ts'

const zone = 'alice.example.test'
const reply = (keys: unknown[], rollovers: unknown[] = []) => ({ view: { zone, store: 'ready', served: true, signing: 'signed', publication: 'current', nsec: { mode: 'nsec', optOut: false, narrow: false }, observedAt: '2026-11-07T10:05:09.000Z', dnskeyTtl: 3600, keys }, rollovers })
const csk = { id: 1, type: 'CSK', active: true, published: true, bits: 256, algorithm: 'ECDSAP256SHA256', tag: 31415, dnskey: '257 3 13 AAAA', ds: [{ keyTag: 31415, algorithm: 13, digestType: 2, digest: 'A'.repeat(64) }] }

describe('DNSSEC client', { tags: ['unit'] }, () => {
  it('reads the pinned reply, offers safe actions per key and formats DS lines', () => {
    const state = dnssecState(reply([csk, { ...csk, id: 2, active: false, tag: 2718, ds: [] }], [{ keyId: 1, newKeyId: 2, type: 'CSK', startedAt: 'x', notBefore: '2026-11-07T11:01:30.000Z', ready: false }]), zone)
    expect(dnssecKeyActions(state.keys[0]!, state)).toEqual(['deactivate'])
    expect(dnssecKeyActions(state.keys[1]!, state)).toEqual(['activate', 'unpublish', 'remove'])
    expect(dnssecDsLines(state)).toEqual([`${zone}. IN DS 31415 13 2 ${'A'.repeat(64)}`])
    expect(dnssecUtc(state.observedAt)).toBe('2026-11-07 10:05 UTC')
  })
  it('refuses a reply for another zone or with a forged DS', () => {
    expect(() => dnssecState(reply([csk]), 'other.example.test')).toThrow()
    expect(() => dnssecState(reply([{ ...csk, ds: [{ ...csk.ds[0], keyTag: 1 }] }]), zone)).toThrow()
  })
  it('renders every declared hook in both themes and connects only a verified tool', () => {
    const hooks = ['data-dnssec-zone', 'data-dnssec-keys', 'data-dnssec-rollovers', 'data-dnssec-ds', 'data-dnssec-enable', 'data-dnssec-disable-confirm', 'data-dnssec-ds-updated', 'data-xp-template="dnssec-key"']
    const classic = renderClassicDnssecSection({ locale: 'ar', zones: [zone], connected: true })
    const v2 = renderV2DnssecCard(message => message, { zones: [zone], connected: true })
    for (const html of [classic, v2]) for (const hook of hooks) expect(html).toContain(hook)
    expect(classic).toMatch(/data-dnssec[ >]/)
    expect(renderClassicDnssecSection({ locale: 'en', zones: [zone], connected: false })).not.toMatch(/data-dnssec[ >]/)
    expect(renderV2DnssecCard(message => message, { zones: [zone], connected: false })).toContain('data-capability-unavailable="true"')
    expect(() => new Function('return ' + DNSSEC_CLIENT_BINDING)).not.toThrow()
  })
})
