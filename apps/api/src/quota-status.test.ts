import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { createExtendedApiRouter, ExtendedFeaturesStore } from './extended-routes.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

const caller = { principal: { id: 'root-fixture', kind: 'root', username: 'root' }, sessionId: 'root-session' } as AuthenticatedCaller

describe('quota initialization requires a connected host port', () => {
  const fixture = (readQuotaState?: ExtendedRouteHelpers['readQuotaState'], wizardState: Record<string, unknown> | null = null) => {
    const reads = vi.spyOn(ExtendedFeaturesStore.prototype, 'readOrDefault').mockImplementation(async <T>(key: string, fallback: T): Promise<T> =>
      (key === 'setup-wizard.json' ? wizardState : fallback) as T)
    const writes = vi.spyOn(ExtendedFeaturesStore.prototype, 'write')
    const emitAudit = vi.fn()
    const assertRoot = vi.fn(async () => undefined)
    const helpers = {
      store: {
        rootDir: '/unused-quota-fixture', isSetupComplete: async () => true, getServerSettings: async () => null, listServerIps: async () => [],
        saveServerSettings: async (value: unknown) => value, saveServerIp: async (value: unknown) => value,
        markSetupComplete: async () => undefined,
      }, db: {}, requireCaller: async () => caller, assertRoot, emitAudit,
      triggerReconcile: vi.fn(async () => null), ...(readQuotaState ? { readQuotaState } : {}),
    } as unknown as ExtendedRouteHelpers
    const router = createExtendedApiRouter(helpers)
    const request = (body: unknown, path = '/api/server/quotas/init', method = 'POST') => {
      const req = new Request('https://panel.example' + path, { method, ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      return router.handleExtendedRoute(req, new URL(req.url), method)
    }
    return { request, writes, emitAudit, assertRoot, reconcile: helpers.triggerReconcile, restore: () => { writes.mockRestore(); reads.mockRestore() } }
  }
  it('refuses initialization without writing status or emitting a success audit', async () => {
    const host = fixture()
    try {
      await expect(host.request({ filesystem: '/home' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false, reason: 'host_quota_initialization_not_connected' } })
      expect(host.assertRoot).toHaveBeenCalledWith(caller, 'server.quota_init')
      expect(host.writes).not.toHaveBeenCalled()
      expect(host.emitAudit).not.toHaveBeenCalled()
    } finally { host.restore() }
  })
  it('still validates the requested filesystem before reporting unavailable', async () => {
    const host = fixture()
    try {
      await expect(host.request({ filesystem: 'relative' })).rejects.toMatchObject({ code: 'VALIDATION' })
      expect(host.writes).not.toHaveBeenCalled()
    } finally { host.restore() }
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
    } finally { host.restore() }
  })

  const enabled = { filesystem: '/', source: '/dev/sda1', filesystemType: 'ext4', status: 'enabled', reason: null }
  it('records fresh enforcement after CLI initialization even when the setup request does not initialize quotas', async () => {
    const read = vi.fn(async () => enabled), host = fixture(read)
    host.writes.mockImplementation(async <T>(_key: string, value: T): Promise<T> => value)
    try {
      const response = await host.request({ hostname: 'panel.example.test', primaryIpv4: '192.0.2.12', initQuotas: false }, '/api/setup/wizard')
      expect(await response!.json()).toMatchObject({ quotaInitialized: true, quotaInitialization: { status: 'enabled', filesystem: '/', filesystemType: 'ext4', reason: null } })
      expect(read).toHaveBeenCalledExactlyOnceWith(caller, '/home')
      expect(host.writes.mock.calls.find(([key]) => key === 'setup-wizard.json')?.[1]).toMatchObject({ quotaInitializationRequested: false, quotaInitialized: true })
      expect(host.writes.mock.calls.some(([key]) => key === 'quota-status.json')).toBe(false)
    } finally { host.restore() }
  })
  it('refreshes the saved wizard flag from current enforcement without writing or reconciling on GET', async () => {
    const read = vi.fn(async () => enabled), host = fixture(read, { quotaFilesystem: '/home', quotaInitialized: false, quotaInitialization: { status: 'unavailable' } })
    try {
      const first = await host.request(undefined, '/api/setup/wizard', 'GET')
      expect(await first!.json()).toMatchObject({ quotaInitialized: true, wizardState: { quotaInitialized: true, quotaInitialization: { status: 'enabled' } } })
      read.mockResolvedValueOnce({ ...enabled, status: 'disabled' })
      const second = await host.request(undefined, '/api/setup/wizard', 'GET')
      expect(await second!.json()).toMatchObject({ quotaInitialized: false, wizardState: { quotaInitialized: false, quotaInitialization: { status: 'disabled', reason: 'quota_not_enforced' } } })
      expect(host.writes).not.toHaveBeenCalled(); expect(host.reconcile).not.toHaveBeenCalled(); expect(host.emitAudit).not.toHaveBeenCalled()
    } finally { host.restore() }
  })
  it.each([
    null, { ...enabled, filesystem: '/other' }, { ...enabled, source: null },
    { ...enabled, filesystemType: 'overlay' }, { ...enabled, status: 'pending' }, { ...enabled, reason: 'not_confirmed' },
  ])('does not preserve a saved success when the native observation is invalid: %j', async observation => {
    const host = fixture(async () => observation, { quotaFilesystem: '/home', quotaInitialized: true })
    try {
      const response = await host.request(undefined, '/api/setup/wizard', 'GET')
      expect(await response!.json()).toMatchObject({ quotaInitialized: false, wizardState: { quotaInitialized: false }, quotaInitialization: { status: 'unavailable', reason: 'host_quota_observation_invalid' } })
      expect(host.writes).not.toHaveBeenCalled()
    } finally { host.restore() }
  })
  it('does not turn a failed host read into saved success', async () => {
    const host = fixture(async () => { throw new Error('untrusted host failure text') }, { quotaFilesystem: '/home', quotaInitialized: true })
    try {
      const response = await host.request(undefined, '/api/setup/wizard', 'GET'), body = await response!.text()
      expect(JSON.parse(body)).toMatchObject({ quotaInitialized: false, quotaInitialization: { status: 'unavailable', reason: 'host_quota_observation_failed' } })
      expect(body).not.toContain('untrusted host failure text'); expect(host.writes).not.toHaveBeenCalled()
    } finally { host.restore() }
  })
  it('requires root authorization before any native quota observation', async () => {
    const read = vi.fn(async () => enabled), host = fixture(read)
    host.assertRoot.mockRejectedValueOnce(new Error('denied'))
    try {
      await expect(host.request(undefined, '/api/setup/wizard', 'GET')).rejects.toThrow('denied')
      expect(read).not.toHaveBeenCalled(); expect(host.writes).not.toHaveBeenCalled()
    } finally { host.restore() }
  })
})
