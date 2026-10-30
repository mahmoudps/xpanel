import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { createExtendedApiRouter, ExtendedFeaturesStore } from './extended-routes.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

const caller = { principal: { id: 'root-fixture', kind: 'root', username: 'root' }, sessionId: 'root-session' } as AuthenticatedCaller

describe('quota initialization requires a connected host port', () => {
  const fixture = () => {
    const writes = vi.spyOn(ExtendedFeaturesStore.prototype, 'write')
    const emitAudit = vi.fn()
    const assertRoot = vi.fn(async () => undefined)
    const helpers = {
      store: {
        rootDir: '/unused-quota-fixture', getServerSettings: async () => null, listServerIps: async () => [],
        saveServerSettings: async (value: unknown) => value, saveServerIp: async (value: unknown) => value,
        markSetupComplete: async () => undefined,
      }, db: {}, requireCaller: async () => caller, assertRoot, emitAudit,
      triggerReconcile: async () => null,
    } as unknown as ExtendedRouteHelpers
    const router = createExtendedApiRouter(helpers)
    const request = (body: unknown, path = '/api/server/quotas/init') => {
      const req = new Request('https://panel.example' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return router.handleExtendedRoute(req, new URL(req.url), 'POST')
    }
    return { request, writes, emitAudit, assertRoot }
  }
  it('refuses initialization without writing status or emitting a success audit', async () => {
    const host = fixture()
    try {
      await expect(host.request({ filesystem: '/home' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false, reason: 'host_quota_initialization_not_connected' } })
      expect(host.assertRoot).toHaveBeenCalledWith(caller, 'server.quota_init')
      expect(host.writes).not.toHaveBeenCalled()
      expect(host.emitAudit).not.toHaveBeenCalled()
    } finally { host.writes.mockRestore() }
  })
  it('still validates the requested filesystem before reporting unavailable', async () => {
    const host = fixture()
    try {
      await expect(host.request({ filesystem: 'relative' })).rejects.toMatchObject({ code: 'VALIDATION' })
      expect(host.writes).not.toHaveBeenCalled()
    } finally { host.writes.mockRestore() }
  })
  it('keeps setup completion separate from quota execution and preserves existing quota metadata', async () => {
    const host = fixture()
    host.writes.mockImplementation(async <T>(_key: string, value: T): Promise<T> => value)
    try {
      const response = await host.request({ hostname: 'panel.example.test', primaryIpv4: '192.0.2.12', initQuotas: true }, '/api/setup/wizard')
      expect(await response!.json()).toMatchObject({
        setupComplete: true, quotaInitialized: false,
        quotaInitialization: { status: 'unavailable', reason: 'host_quota_initialization_not_connected' },
      })
      expect(host.writes.mock.calls.some(([key]) => key === 'quota-status.json')).toBe(false)
      expect(host.writes.mock.calls.find(([key]) => key === 'setup-wizard.json')?.[1]).toMatchObject({ quotaInitializationRequested: true, quotaInitialized: false })
    } finally { host.writes.mockRestore() }
  })
})
