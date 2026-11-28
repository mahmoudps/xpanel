// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Domain } from '@xpanel/core'
import { renderV2PanelTraffic } from './themes/v2/pages/xpanel/observations/traffic.ts'
import { ACCOUNT_TRAFFIC_MONITOR_CLIENT_BINDING, readAccountTrafficMonitorView } from './account-traffic-monitor-client.ts'

const account: Account = {
  id: '10000000-0000-4000-8000-000000000001',
  username: 'alice',
  uid: 20014,
  gid: 20014,
  home: '/home/alice',
  primaryDomain: 'alice.example.test',
  planId: 'plan',
  ownerId: null,
  status: 'active',
  suspendReason: null,
  contactEmail: 'owner@alice.example.test',
  ipv4: '192.0.2.10',
  shell: 'jailed',
  createdAt: '2026-10-29T00:00:00Z',
}

const domain: Domain = {
  id: '10000000-0000-4000-8000-000000000002',
  accountId: account.id,
  name: 'alice.example.test',
  kind: 'primary',
  parentId: null,
  docRoot: '/home/alice/public_html',
  siteType: 'php',
  upstream: null,
  redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 0, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false,
  certificateId: null,
  suspended: false,
  expiresAt: null,
  pathQuotaMb: 'unlimited',
}

const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const samplePayload = (blocked = false) => ({
  context: { username: 'alice', domain: 'alice.example.test', domains: ['alice.example.test'] },
  state: 'read',
  observedAt: '2026-11-10T10:10:00.000Z',
  summary: { totalRequests: 3, uniqueVisitors: 2, totalBytes: 2048, error5xx: 1, truncated: false, unparsedLines: 0, fileExists: true },
  dailyVisitors: [{ date: '2026-11-10', uniqueVisitors: 2, requests: 3, bytes: 2048 }],
  recentRequests: [{ time: '2026-11-10T10:09:00.000Z', method: 'GET', path: '/<img src=x>', status: 200, bytes: 512, ip: '198.51.100.7', agent: 'Mozilla/5.0' }],
  topUserAgents: [{ agent: 'Mozilla/5.0', requests: 3, bytes: 2048 }],
  topClientIps: [{ ip: '198.51.100.7', requests: 3, bytes: 2048, errors: 1, blocked }],
  ipBlocker: { available: true, revision: 'a'.repeat(64), blockedCount: blocked ? 1 : 0 },
})

beforeEach(() => {
  document.documentElement.lang = 'en'
  document.documentElement.dir = 'ltr'
  document.body.innerHTML = renderV2PanelTraffic({ account, domains: [domain] }, { canRead: true, canManage: true, presentation: 'live' })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})

afterEach(() => {
  document.body.replaceChildren()
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})

describe('account traffic monitor client binding', () => {
  it('compiles cleanly without innerHTML, fetch, or dynamic querySelector calls', () => {
    expect(() => new Function('return ' + ACCOUNT_TRAFFIC_MONITOR_CLIENT_BINDING)()).not.toThrow()
    expect(ACCOUNT_TRAFFIC_MONITOR_CLIENT_BINDING).not.toContain('innerHTML')
    expect(ACCOUNT_TRAFFIC_MONITOR_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('rejects control characters and foreign domain mismatches in the reader', () => {
    expect(readAccountTrafficMonitorView(samplePayload(), 'alice.example.test').summary?.totalRequests).toBe(3)
    expect(() => readAccountTrafficMonitorView(samplePayload(), 'other.example.test')).toThrow()
    const bad = samplePayload()
    bad.recentRequests[0]!.path = '/bad\u0007path'
    expect(() => readAccountTrafficMonitorView(bad, 'alice.example.test')).toThrow()
  })

  it('loads daily visitors, live visitor stream, user agents, and blocks an IP after confirmation', async () => {
    let blocked = false
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET') return samplePayload(blocked)
      expect(path).toBe('/api/account/traffic-monitor/block-ip')
      expect(body).toEqual({ expectedRevision: 'a'.repeat(64), ip: '198.51.100.7' })
      blocked = true
      return { stateChanged: true, blocked: ['198.51.100.7'], revision: 'b'.repeat(64) }
    })
    const ask = vi.fn(async () => true)
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    new Function('return ' + ACCOUNT_TRAFFIC_MONITOR_CLIENT_BINDING)()(ask)
    await tick()

    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-traffic-monitor-requests]')!.textContent).toContain('/<img src=x>')
    expect(document.querySelector('[data-traffic-monitor-daily]')!.textContent).toContain('2026-11-10')
    expect(document.querySelector('[data-traffic-monitor-agents]')!.textContent).toContain('Mozilla/5.0')

    const blockBtn = document.querySelector<HTMLButtonElement>('[data-traffic-monitor-ips] button')!
    expect(blockBtn.disabled).toBe(false)
    blockBtn.click()
    await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-traffic-monitor-status]')!.getAttribute('data-state')).toBe('saved')
    expect(document.querySelector<HTMLButtonElement>('[data-traffic-monitor-ips] button')!.disabled).toBe(true)
  })
})
