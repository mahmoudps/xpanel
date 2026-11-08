import { describe, expect, it } from 'vitest'
import { siteDenyExtensions, siteDraftProblem, siteServingState, siteSettingsBody, type SiteDraft } from './account-site-settings-client.ts'
import { readDomainBulkResult } from './whm-domain-bulk-client.ts'

const row = (over: Record<string, unknown> = {}) => ({ docRoot: '/home/a/public_html', suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ...over }) as Parameters<typeof siteSettingsBody>[0]
const draft = (over: Partial<SiteDraft> = {}): SiteDraft => ({ docRoot: '/home/a/public_html', runDirectory: '', isolated: false, visitorLog: true, message: '', expiry: null, quota: 'unlimited', reminderAddress: '', reminderDays: null, traffic: null, denyRules: [], ...over })

describe('site settings client', () => {
  it('sends only what changed', () => {
    expect(siteSettingsBody(row(), draft())).toEqual({})
    expect(siteSettingsBody(row(), draft({ expiry: '2026-12-01', quota: 50 }))).toEqual({ expiresAt: '2026-12-01T00:00:00.000Z', pathQuotaMb: 50 })
    expect(siteSettingsBody(row({ expiresAt: '2026-12-01T00:00:00.000Z' }), draft({ expiry: '2026-12-01' }))).toEqual({})
    expect(siteSettingsBody(row(), draft({ visitorLog: false, runDirectory: 'public' }))).toEqual({ site: { runDirectory: 'public', visitorLogOff: true } })
  })
  it('ignores server-held site keys when comparing, and clears options by sending the rest', () => {
    const saved = row({ site: { stoppedByOwner: true, category: 'shop' } })
    expect(siteSettingsBody(saved, draft())).toEqual({})
    expect(siteSettingsBody(row({ site: { isolated: true } }), draft())).toEqual({ site: {} })
  })
  it('names the first problem in a draft', () => {
    expect(siteDraftProblem(draft())).toBeNull()
    expect(siteDraftProblem(draft({ runDirectory: '../x' }))).toBe('run')
    expect(siteDraftProblem(draft({ quota: 0 }))).toBe('quota')
    expect(siteDraftProblem(draft({ traffic: { siteConnections: null, ipConnections: null, rateKbPerConnection: null } }))).toBe('traffic')
    expect(siteDraftProblem(draft({ reminderAddress: 'a@example.test' }))).toBe('reminder')
    expect(siteDraftProblem(draft({ reminderDays: 3 }))).toBe('reminder')
    expect(siteDraftProblem(draft({ reminderAddress: 'a@example.test', reminderDays: 3 }))).toBeNull()
  })
  it('reads extensions and the serving state', () => {
    expect(siteDenyExtensions('.PHP, phtml  php')).toEqual(['php', 'phtml'])
    expect(siteServingState({ suspended: true, expiresAt: null }, 0)).toBe('stopped')
    expect(siteServingState({ suspended: false, expiresAt: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-01-02T00:00:00.000Z'))).toBe('expired')
    expect(siteServingState({ suspended: false, expiresAt: '2026-01-01T00:00:00.000Z' }, Date.parse('2025-01-02T00:00:00.000Z'))).toBe('running')
  })
})

describe('bulk site result reader', () => {
  it('takes exactly the submitted sites in order', () => {
    expect(readDomainBulkResult({ results: [{ domainId: 'a', outcome: 'applied', code: null, reason: null }] }, ['a'])[0]!.outcome).toBe('applied')
    expect(() => readDomainBulkResult({ results: [{ domainId: 'b', outcome: 'applied' }] }, ['a'])).toThrow('invalid_domain_bulk_result')
    expect(() => readDomainBulkResult({ results: [] }, ['a'])).toThrow('invalid_domain_bulk_result')
    expect(() => readDomainBulkResult({ results: [{ domainId: 'a', outcome: 'done' }] }, ['a'])).toThrow('invalid_domain_bulk_result')
  })
})
