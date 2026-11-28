import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleWhmWebStackRoutes, type WhmWebStackHelpers } from './whm-web-stack-routes.ts'

const ROOT = {
  principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' },
  sessionId: 'sess-root',
  apiTokenId: null,
  scopes: [],
  principalRecord: {},
} as unknown as AuthenticatedCaller

const USER = {
  principal: { kind: 'user', id: '22222222-2222-4222-8222-222222222222', username: 'alice', accountId: '33333333-3333-4333-8333-333333333333' },
  sessionId: 'sess-user',
  apiTokenId: null,
  scopes: [],
  principalRecord: {},
} as unknown as AuthenticatedCaller

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-whm-web-stack-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function setup(overrides: Partial<WhmWebStackHelpers> = {}, caller = ROOT) {
  const helpers: WhmWebStackHelpers = {
    requireCaller: vi.fn(async () => caller),
    assertRoot: vi.fn(async (current: AuthenticatedCaller) => {
      if (current.principal.kind !== 'root') fail('FORBIDDEN', 'root required', { stateChanged: false })
    }),
    emitAudit: vi.fn(async () => undefined),
    store: {
      rootDir: root,
      getServerSettings: async () => ({
        hostname: 'host.example.test',
        nameservers: ['ns1.example.test'],
        adminEmail: 'root@example.test',
        engine: 'apache',
        apacheMpm: 'itk',
        panelPort: 2087,
        sshPort: 22,
        backendPort: 8080,
        backendTlsPort: 8443,
        nginx: { workerProcesses: 'auto', workerConnections: 2048, workerRlimitNofile: 8192, multiAccept: false, keepaliveTimeoutSec: 65 },
        apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 120, serverLimit: 120, maxConnectionsPerChild: 0 },
      }) as never,
    },
    now: () => new Date('2026-11-27T12:00:00.000Z'),
    ...overrides,
  }
  const send = (path: string, method = 'GET', body?: unknown) =>
    handleWhmWebStackRoutes(
      new Request('http://api.test' + path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      }),
      new URL('http://api.test' + path),
      method,
      helpers,
    )
  return { helpers, send }
}

describe('WHM web-stack and OpenLiteSpeed API routes', () => {
  it('enforces root-only access across web-stack and openlitespeed endpoints', async () => {
    const denied = setup({}, USER)
    for (const [path, method, body] of [
      ['/api/server/web-stack', 'GET', undefined],
      ['/api/server/web-stack/preview', 'POST', { engine: 'apache', mpm: 'itk' }],
      ['/api/server/web-stack/apply', 'POST', { engine: 'apache', mpm: 'itk' }],
      ['/api/server/services/openlitespeed', 'GET', undefined],
      ['/api/server/services/openlitespeed/action', 'POST', { action: 'restart' }],
      ['/api/server/services/openlitespeed/config/preview', 'POST', { generateBase: true }],
      ['/api/server/services/openlitespeed/config/apply', 'POST', { text: 'useIpInProxyHeader 2\n' }],
      ['/api/server/services/openlitespeed/config/rollback', 'POST', {}],
    ] as const) {
      await expect(denied.send(path, method, body)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
  })

  it('rejects multiple MPMs with 409 CONFLICT and non-isolated MPMs with 422 VALIDATION, while applying mpm_itk profiles with audit', async () => {
    const callHost = vi.fn(async (_caller: AuthenticatedCaller, path: string) => {
      if (path === '/host/web-stack/apply') {
        return { applied: true, stateChanged: true, isolationPolicy: 'mpm_itk', generationId: 4, revision: 'a'.repeat(64) }
      }
      return { valid: true, stateChanged: false, isolationPolicy: 'mpm_itk', diff: { addModules: [], removeModules: [], addPhpVersions: [], removePhpVersions: [], engineChanged: false }, renderedFiles: [] }
    })
    const h = setup({ callHost })

    await expect(h.send('/api/server/web-stack/preview', 'POST', { engine: 'apache', mpms: ['itk', 'prefork'] })).rejects.toMatchObject({
      code: 'CONFLICT',
      detail: { stateChanged: false, reason: 'multiple_mpms_selected' },
    })
    await expect(h.send('/api/server/web-stack/apply', 'POST', { engine: 'apache', mpm: 'worker' })).rejects.toMatchObject({
      code: 'VALIDATION',
      detail: { stateChanged: false, reason: 'mpm_isolation_required' },
    })
    expect(callHost).not.toHaveBeenCalled()

    const offline = setup()
    const offlineInitial = await (await offline.send('/api/server/web-stack'))!.json()
    expect(offlineInitial.isolationPolicy).toBe('mpm_itk')
    expect(offlineInitial.hostConnected).toBe(false)

    const initial = await (await h.send('/api/server/web-stack'))!.json()
    expect(initial.isolationPolicy).toBe('mpm_itk')
    expect(initial.hostConnected).toBe(true)

    const applied = await (await h.send('/api/server/web-stack/apply', 'POST', {
      profileId: 'apache-itk-fpm',
      engine: 'apache',
      mpm: 'itk',
      modules: ['mod_rewrite', 'mod_ssl'],
      phpVersions: ['8.3'],
    }))!.json()
    expect(applied.applied).toBe(true)
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.web_stack.applied', outcome: 'ok' }))
  })

  it('reports openlitespeed not_installed truthfully and audits service actions, config apply, and rollback when host is connected', async () => {
    const offline = setup()
    const offlineRead = await (await offline.send('/api/server/services/openlitespeed'))!.json()
    expect(offlineRead.installed).toBe(false)
    expect(offlineRead.state).toBe('not_installed')
    expect(offlineRead.renderedReference).toContain('useIpInProxyHeader')

    await expect(offline.send('/api/server/services/openlitespeed/config/preview', 'POST', { text: 'include /etc/shadow\n' })).rejects.toMatchObject({
      code: 'VALIDATION',
      detail: { stateChanged: false, reason: 'unsafe_ols_include' },
    })

    const callHost = vi.fn(async (_caller: AuthenticatedCaller, path: string) => {
      if (path === '/host/services/openlitespeed/action') return { action: 'restart', unit: 'lshttpd.service', active: 'active', enabled: 'enabled', state: 'active', stateChanged: true }
      if (path === '/host/services/openlitespeed/config/apply') return { applied: true, stateChanged: true, backupId: '1700000000000-aaaaaaaa', revision: 'b'.repeat(64) }
      if (path === '/host/services/openlitespeed/config/rollback') return { rolledBack: true, stateChanged: true, backupId: '1700000000000-aaaaaaaa', revision: 'c'.repeat(64) }
      return {}
    })
    const online = setup({ callHost })

    await (await online.send('/api/server/services/openlitespeed/action', 'POST', { action: 'restart' }))!.json()
    expect(online.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.openlitespeed.service_action', outcome: 'ok' }))

    await (await online.send('/api/server/services/openlitespeed/config/apply', 'POST', { text: 'useIpInProxyHeader 2\n' }))!.json()
    expect(online.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.openlitespeed.config_applied', outcome: 'ok' }))

    await (await online.send('/api/server/services/openlitespeed/config/rollback', 'POST', { backupId: '1700000000000-aaaaaaaa' }))!.json()
    expect(online.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.openlitespeed.config_rolled_back', outcome: 'ok' }))
  })
})
