import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { choosableEngines, defaultWebStatsPolicy, parseWebStatsConfig, selectedEngines, statsRunDue, validateWebStatsLocks, validateWebStatsPolicy, webStatsRevision } from './web-stats-config.ts'
import type { WebStatsPolicy } from './web-stats-config.ts'

const alice = { id: 'a1', username: 'alice' }
const policy = (patch: Partial<WebStatsPolicy> = {}): WebStatsPolicy => ({ ...defaultWebStatsPolicy(), ...patch })
const refused = (value: unknown): unknown => { try { validateWebStatsPolicy(value); return null } catch (error) { return isXpanelError(error) ? error.detail?.field : error } }

describe('web statistics policy', () => {
  it.each([[0.25, null], [24, null], [168, null], [0.3, 'intervalHours'], [0, 'intervalHours'], [168.25, 'intervalHours']])('checks interval %s', (intervalHours, field) => {
    expect(refused(policy({ intervalHours }))).toBe(field)
  })

  it.each([[5, null], [10, null], [360, null], [0, 'bandwidthIntervalMinutes'], [7, 'bandwidthIntervalMinutes'], [365, 'bandwidthIntervalMinutes']])('checks the bandwidth interval %s', (bandwidthIntervalMinutes, field) => {
    expect(refused(policy({ bandwidthIntervalMinutes }))).toBe(field)
  })

  it('refuses unknown fields, repeated hours, a fully blacked out day and foreign engines', () => {
    expect(refused({ ...policy(), bandwidthHours: 1 })).toBe('bandwidthHours')
    expect(refused(policy({ blackoutHours: [3, 3] }))).toBe('blackoutHours')
    expect(refused(policy({ blackoutHours: Array.from({ length: 24 }, (_, hour) => hour) }))).toBe('blackoutHours')
    expect(refused(policy({ blackoutHours: [24] }))).toBe('blackoutHours')
    expect(refused(policy({ allowed: { alice: ['goaccess' as 'awstats'] } }))).toBe('allowed')
    expect(refused(policy({ allowed: { 'Bad Name': [] } }))).toBe('allowed')
  })

  it('keeps nothing saved at the defaults and stops on a damaged file', () => {
    expect(parseWebStatsConfig(null)).toEqual({ policy: defaultWebStatsPolicy(), choices: {}, resellerLocks: {} })
    expect(parseWebStatsConfig({ policy: policy({ intervalHours: 0.3 }), choices: {}, resellerLocks: {} })).toBeNull()
    expect(parseWebStatsConfig({ policy: policy(), choices: { a1: { 'alice.test': ['goaccess'] } }, resellerLocks: {} })).toBeNull()
    expect(parseWebStatsConfig({ policy: policy(), choices: {}, resellerLocks: { r1: { goaccess: true } } })).toBeNull()
    expect(parseWebStatsConfig({ policy: policy(), choices: {} })).toBeNull()
    expect(webStatsRevision({ a: 1 })).not.toBe(webStatsRevision({ a: 2 }))
  })
})

describe('engine selection', () => {
  it('honours a saved choice only for engines the user may still choose', () => {
    const choices = { a1: { 'alice.test': ['awstats' as const] } }, config = (saved: WebStatsPolicy) => ({ policy: saved, choices, resellerLocks: {} })
    expect(selectedEngines(config(policy()), alice, 'alice.test')).toEqual(['awstats'])
    expect(selectedEngines(config(policy()), alice, 'other.test')).toEqual(['analog', 'awstats', 'webalizer'])
    const listed = policy({ users: 'listed', allowed: { alice: ['awstats'] } })
    expect(choosableEngines(config(listed), alice)).toEqual(['awstats'])
    expect(choosableEngines(config(listed), { id: 'b1', username: 'bob' })).toEqual([])
    expect(selectedEngines(config(listed), alice, 'alice.test')).toEqual(['analog', 'awstats', 'webalizer'])
    expect(selectedEngines(config(policy({ users: 'listed' })), alice, 'alice.test')).toEqual(['analog', 'awstats', 'webalizer'])
  })

  it('never runs an engine root made unavailable, whatever was chosen', () => {
    const engines = { analog: { available: false, byDefault: true }, awstats: { available: false, byDefault: true }, webalizer: { available: true, byDefault: false } }
    expect(selectedEngines({ policy: policy({ engines }), choices: { a1: { 'alice.test': ['awstats', 'webalizer'] } }, resellerLocks: {} }, alice, 'alice.test')).toEqual(['webalizer'])
    expect(selectedEngines({ policy: policy({ engines }), choices: {}, resellerLocks: {} }, alice, 'alice.test')).toEqual([])
  })

  it('lets a reseller hold an engine for its own accounts, under root availability', () => {
    const owned = { ...alice, ownerId: 'r1' }, resellerLocks = { r1: { awstats: false, webalizer: true } }, choices = { a1: { 'alice.test': ['awstats' as const] } }
    const config = { policy: policy(), choices, resellerLocks }
    expect(choosableEngines(config, owned)).toEqual(['analog'])
    expect(selectedEngines(config, owned, 'alice.test')).toEqual(['webalizer'])
    expect(selectedEngines(config, alice, 'alice.test')).toEqual(['awstats'])
    const engines = { ...defaultWebStatsPolicy().engines, webalizer: { available: false, byDefault: false } }
    expect(selectedEngines({ ...config, policy: policy({ engines }) }, owned, 'alice.test')).toEqual([])
    expect(validateWebStatsLocks({ analog: false })).toEqual({ analog: false })
    expect(() => validateWebStatsLocks({ analog: 'off' })).toThrow()
  })
})

describe('run schedule', () => {
  const at = (iso: string) => new Date(iso)
  it('starts a run due in a blackout hour at the first allowed hour', () => {
    const blackout = policy({ intervalHours: 1, blackoutHours: [2, 3] })
    expect(statsRunDue(blackout, '2026-11-07T00:00:00Z', at('2026-11-07T02:30:00Z'), false)).toBe(false)
    expect(statsRunDue(blackout, '2026-11-07T00:00:00Z', at('2026-11-07T03:59:00Z'), false)).toBe(false)
    expect(statsRunDue(blackout, '2026-11-07T00:00:00Z', at('2026-11-07T04:00:00Z'), false)).toBe(true)
  })
  it('waits for the interval and, when asked, for a running backup', () => {
    expect(statsRunDue(policy(), '2026-11-07T00:00:00Z', at('2026-11-07T23:59:00Z'), false)).toBe(false)
    expect(statsRunDue(policy(), '2026-11-07T00:00:00Z', at('2026-11-08T00:00:00Z'), false)).toBe(true)
    expect(statsRunDue(policy(), null, at('2026-11-07T00:00:00Z'), true)).toBe(false)
    expect(statsRunDue(policy({ avoidBackups: false }), null, at('2026-11-07T00:00:00Z'), true)).toBe(true)
  })
})
