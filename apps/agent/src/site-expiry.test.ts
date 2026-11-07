import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Domain } from '@xpanel/core'
import { createSiteExpiryMonitor, SITE_EXPIRY_INTERVAL_MS } from './site-expiry.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const NOW = Date.parse('2026-11-07T12:00:00.000Z')
const domain = (over: Partial<Domain>): Domain => ({ id: 'd1', name: 'a.example.test', expiresAt: null, ...over }) as Domain
const newRoot = (): string => { const root = mkdtempSync(join(tmpdir(), 'site-expiry-')); roots.push(root); return root }
const setup = (domains: Domain[]) => {
  const root = newRoot(), mail: string[] = []
  const state = { now: NOW, reconciles: 0, mailDown: false, domains }
  const monitor = () => createSiteExpiryMonitor({ root, listDomains: async () => state.domains, reconcile: async () => { state.reconciles++ }, now: () => state.now,
    sendAlert: async (to, subject) => { if (state.mailDown) throw new Error('down'); mail.push(to + ': ' + subject) } })
  return { state, mail, monitor }
}

describe('site expiry monitor', () => {
  it('reconciles once when an expiry passes, across a restart, and again for a new date', async () => {
    const { state, monitor } = setup([domain({ expiresAt: '2026-11-07T11:59:00.000Z' })])
    const first = monitor()
    await first.tick(); await first.tick()
    expect(state.reconciles).toBe(1)
    await monitor().tick()
    expect(state.reconciles).toBe(1)
    state.domains = [domain({ expiresAt: '2026-11-07T11:58:00.000Z' })]
    await monitor().tick()
    expect(state.reconciles).toBe(2)
  })
  it('leaves a future expiry alone and surfaces a failed reconcile for the next run', async () => {
    const { state, monitor } = setup([domain({ expiresAt: '2026-11-08T00:00:00.000Z' })])
    await monitor().tick()
    expect(state.reconciles).toBe(0)
    const failing = createSiteExpiryMonitor({ root: newRoot(), listDomains: async () => [domain({ expiresAt: '2026-11-01T00:00:00.000Z' })], reconcile: async () => { throw new Error('busy') }, sendAlert: async () => undefined, now: () => NOW })
    await expect(failing.tick()).rejects.toThrow('busy')
  })
  it('sends one reminder inside the window, retrying a failed send', async () => {
    const site = { expiryReminder: { address: 'owner@example.test', days: 3 } }
    const { state, mail, monitor } = setup([domain({ expiresAt: '2026-11-09T12:00:00.000Z', site })])
    state.mailDown = true
    const live = monitor()
    await live.tick()
    expect(mail).toEqual([])
    state.mailDown = false; state.now += SITE_EXPIRY_INTERVAL_MS
    await live.tick()
    expect(mail).toEqual(['owner@example.test: Site a.example.test stops on 2026-11-09 12:00 UTC'])
    state.now += SITE_EXPIRY_INTERVAL_MS
    await live.tick()
    expect(mail).toHaveLength(1)
    const outside = setup([domain({ expiresAt: '2026-12-09T12:00:00.000Z', site })])
    await outside.monitor().tick()
    expect(outside.mail).toEqual([])
  })
})
