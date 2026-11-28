import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { siteSoftwareFile } from './site-software-catalog.ts'
import {
  handleWhmAppInstallerRoute,
  WHM_APP_INSTALLER_PATH,
  WHM_DISTRO_PACKAGES_PATH,
  WHM_ONE_CLICK_PATH,
  type WhmAppInstallerHelpers,
} from './whm-app-installer-routes.ts'

const ROOT = { principal: { kind: 'root', id: 'root-1', username: 'root' } } as AuthenticatedCaller
const RESELLER = { principal: { kind: 'reseller', id: 'reseller-1', username: 'reseller' } } as AuthenticatedCaller
const USER = { principal: { kind: 'user', id: 'user-1', username: 'alice', accountId: '11111111-1111-4111-8111-111111111111' } } as AuthenticatedCaller
const REV = 'a'.repeat(64)
const CAT_REV = 'b'.repeat(64)

const ALICE: Account = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'alice',
  uid: 2001,
  gid: 2001,
  home: '/home/alice',
  primaryDomain: 'alice.example',
  planId: 'plan-1',
  ownerId: null,
  status: 'active',
  suspendReason: null,
  contactEmail: 'alice@alice.example',
  ipv4: '198.51.100.8',
  shell: 'none',
  createdAt: '2026-11-01T00:00:00.000Z',
}

const DOMAIN: Domain = {
  id: '22222222-2222-4222-8222-222222222222',
  accountId: ALICE.id,
  name: 'alice.example',
  kind: 'primary',
  parentId: null,
  docRoot: '/home/alice/public_html',
  siteType: 'php',
  upstream: null,
  redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false,
  certificateId: null,
  suspended: false,
  expiresAt: null,
  pathQuotaMb: 'unlimited',
}

const ALIAS: Domain = {
  ...DOMAIN,
  id: '33333333-3333-4333-8333-333333333333',
  name: 'alias.example',
  kind: 'alias',
  parentId: DOMAIN.id,
}

const HOST_CATALOG = {
  trust: { state: 'configured', keyIds: ['apps-2026'], reason: null },
  catalog: {
    state: 'read',
    reason: null,
    keyId: 'apps-2026',
    sequence: 5,
    issuedAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    revision: CAT_REV,
    applications: [
      { id: 'wordpress', name: 'WordPress', versions: ['6.7.1', '6.7.0'], stored: ['6.7.1'] },
    ],
  },
}

const INSTANCE = {
  username: 'alice',
  accountId: ALICE.id,
  domainId: DOMAIN.id,
  domain: 'alice.example',
  path: 'blog',
  appId: 'wordpress',
  version: '6.7.1',
  previousVersion: null,
  database: 'alice_wp',
  updatedAt: '2026-11-10T10:00:00.000Z',
  revision: REV,
  accountStatus: 'active',
}

let rootDir = ''
beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'xp-whm-installer-')) })
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }) })

function createHarness(options: { caller?: AuthenticatedCaller; callHost?: WhmAppInstallerHelpers['callHost'] } = {}) {
  const activeCaller = options.caller ?? ROOT
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const defaultCallHost: NonNullable<WhmAppInstallerHelpers['callHost']> = async (_caller, path, input) => {
    if (path.startsWith('/host/software-center?page=')) {
      const page = path.split('=')[1]!
      return {
        state: 'read',
        reason: null,
        family: 'debian',
        observedAt: '2026-11-27T10:00:00.000Z',
        revision: REV,
        page,
        phpVersions: ['8.3'],
        candidates: 'read',
        components: page === 'catalog'
          ? [{ id: 'memcached', page: 'catalog', category: 'cache', name: 'Memcached', description: 'Cache', packages: ['memcached'], state: 'absent', needsReview: false, installed: [], candidates: [{ name: 'memcached', version: '1.6.24' }], services: ['memcached.service'], requires: [], conflicts: [], requiredBy: [], estimate: { memoryMb: 64, diskMb: 1 } }]
          : page === 'runtime'
            ? [{ id: 'nodejs', page: 'runtime', category: 'nodejs', name: 'Node.js', description: 'JS', packages: ['nodejs'], state: 'installed', needsReview: false, installed: [{ name: 'nodejs', versions: ['20.11'] }], candidates: [{ name: 'nodejs', version: '20.11' }], services: [], requires: [], conflicts: [], requiredBy: [], estimate: { memoryMb: 0, diskMb: 60 } }]
            : [],
        sources: [{ id: 'shipped', state: 'trusted', trust: 'release-code' }],
        actions: { manage: true },
      }
    }
    if (path === '/host/software-center/preview') {
      const body = input as { action: string; componentIds: string[]; expectedRevision: string }
      return { preview: { state: 'ready', reason: null, blockers: [], action: body.action, family: 'debian', revision: body.expectedRevision, componentIds: body.componentIds, resolvedComponentIds: body.componentIds, pulledComponentIds: [], requestedPackages: ['memcached'], packages: { install: [{ name: 'memcached', from: null, to: '1.6.24' }], upgrade: [], remove: [], configure: [] }, extraRemovals: [], extraRemovalsFingerprint: null, protectedUpgrades: [], estimate: { memoryMb: 64, diskMb: 1 }, observed: { downloadBytes: 100000, sizeDeltaBytes: 300000 }, fingerprint: REV } }
    }
    if (path === '/host/software-center/apply') {
      const body = input as { action: string }
      return { job: { id: 'job-dp-1', kind: 'software.component.' + body.action, status: 'queued' } }
    }
    if (path === '/host/site-software') return HOST_CATALOG
    if (path === '/host/site-software/instances') return { instances: [INSTANCE] }
    if (path.startsWith('/host/site-software/target?')) {
      return { state: 'read', reason: null, revision: REV, catalogRevision: CAT_REV, installation: null, writesAvailable: true }
    }
    if (path === '/host/software/one-click/deploy' || path === '/host/software/app-installer/install') {
      return { job: { id: 'job-app-1', kind: 'application.install', status: 'queued' } }
    }
    if (path === '/host/site-software/instances/jobs') {
      return { job: { id: 'job-app-2', kind: 'application.remove', status: 'queued' } }
    }
    return {}
  }
  const helpers: WhmAppInstallerHelpers = {
    store: {
      rootDir,
      getWriterLock: () => ({ acquire: async () => lease }) as never,
      listAccounts: async () => [ALICE],
      listDomains: async () => [DOMAIN, ALIAS],
      getAccount: async id => id === ALICE.id ? ALICE : null,
      getDomain: async id => [DOMAIN, ALIAS].find(d => d.id === id) ?? null,
    },
    requireCaller: vi.fn(async () => activeCaller),
    assertRoot: vi.fn(async caller => {
      if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required')
    }),
    emitAudit: vi.fn(async () => undefined),
    callHost: options.callHost ?? vi.fn(defaultCallHost),
    now: () => new Date('2026-11-27T12:00:00.000Z'),
  }
  const seedOffer = async (ids: string[]) => {
    const file = siteSoftwareFile(helpers.store)
    const { offerRevision } = { offerRevision: (await file.read()).raw }
    void offerRevision
    const first = await file.read()
    const { panelConfigRevision } = await import('./panel-config-file.ts')
    await file.write({ version: 1, offered: ids, updatedAt: '2026-11-27T11:00:00.000Z' } as unknown as string[], panelConfigRevision('site-software:v1', first.raw), async () => undefined)
  }
  const call = (path: string, method = 'GET', body?: unknown) => {
    const url = new URL('http://api.test' + path)
    return handleWhmAppInstallerRoute(
      new Request(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      }),
      url,
      method,
      helpers,
    )
  }
  return { helpers, seedOffer, call }
}

describe('WHM distro packages, one-click deploy, and app installer routes', () => {
  it('enforces root-only access across all installer endpoints before touching host or store', async () => {
    for (const caller of [RESELLER, USER]) {
      const h = createHarness({ caller })
      await expect(h.call(WHM_DISTRO_PACKAGES_PATH)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(h.call(WHM_ONE_CLICK_PATH)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(h.call(WHM_APP_INSTALLER_PATH)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(h.call(WHM_DISTRO_PACKAGES_PATH + '/apply', 'POST', {})).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(h.helpers.callHost).not.toHaveBeenCalled()
    }
    expect(await createHarness().call('/api/server/software/other')).toBeNull()
    expect((await createHarness().call(WHM_ONE_CLICK_PATH, 'POST', {}))!.status).toBe(405)
  })

  it('reads, searches, previews and applies reviewed distro packages while rejecting unknown component IDs', async () => {
    const h = createHarness()
    const read = await h.call(`${WHM_DISTRO_PACKAGES_PATH}?q=mem`)
    expect(read!.status).toBe(200)
    const readBody = await read!.json() as { components: { id: string }[]; revision: string }
    expect(readBody.components.map(c => c.id)).toEqual(['memcached'])

    await expect(h.call(`${WHM_DISTRO_PACKAGES_PATH}/preview`, 'POST', {
      action: 'install',
      componentIds: ['arbitrary-unreviewed-pkg'],
      expectedRevision: REV,
    })).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { reason: 'unknown_component' } })

    const preview = await h.call(`${WHM_DISTRO_PACKAGES_PATH}/preview`, 'POST', {
      action: 'install',
      componentIds: ['memcached'],
      expectedRevision: REV,
    })
    expect(preview!.status).toBe(200)
    expect((await preview!.json() as { preview: { state: string } }).preview.state).toBe('ready')

    const applied = await h.call(`${WHM_DISTRO_PACKAGES_PATH}/apply`, 'POST', {
      action: 'install',
      componentIds: ['memcached'],
      expectedRevision: REV,
    })
    expect(applied!.status).toBe(202)
    expect(await applied!.json()).toEqual({ job: { id: 'job-dp-1', kind: 'software.component.install', status: 'queued' } })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.distro_packages.change_requested' }))
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.distro_packages.job_submitted' }))
  })

  it('reads one-click targets and deploys reviewed apps only onto eligible active domain docRoots', async () => {
    const h = createHarness()
    await h.seedOffer(['wordpress'])
    const view = await (await h.call(WHM_ONE_CLICK_PATH))!.json() as { offered: string[]; targets: { domainId: string; docRoot: string }[] }
    expect(view.offered).toEqual(['wordpress'])
    expect(view.targets).toHaveLength(1)
    expect(view.targets[0]).toMatchObject({ domainId: DOMAIN.id, docRoot: '/home/alice/public_html' })

    const targetRes = await (await h.call(`${WHM_ONE_CLICK_PATH}?domainId=${DOMAIN.id}&path=shop`))!.json() as {
      target: { domainId: string; path: string; state: string; revision: string; catalogRevision: string; writesAvailable: boolean }
    }
    expect(targetRes.target).toMatchObject({ domainId: DOMAIN.id, path: 'shop', state: 'read', revision: REV, catalogRevision: CAT_REV, writesAvailable: true })

    // Alias domains are refused.
    await expect(h.call(`${WHM_ONE_CLICK_PATH}/deploy`, 'POST', {
      domainId: ALIAS.id,
      appId: 'wordpress',
      version: '6.7.1',
      expectedRevision: REV,
      expectedCatalogRevision: CAT_REV,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'domain_ineligible' } })

    // Unoffered app is refused.
    await expect(h.call(`${WHM_ONE_CLICK_PATH}/deploy`, 'POST', {
      domainId: DOMAIN.id,
      appId: 'drupal',
      version: '10.0.0',
      expectedRevision: REV,
      expectedCatalogRevision: CAT_REV,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const deployed = await h.call(`${WHM_ONE_CLICK_PATH}/deploy`, 'POST', {
      domainId: DOMAIN.id,
      appId: 'wordpress',
      version: '6.7.1',
      path: 'shop',
      expectedRevision: REV,
      expectedCatalogRevision: CAT_REV,
    })
    expect(deployed!.status).toBe(202)
    expect(await deployed!.json()).toEqual({ job: { id: 'job-app-1', kind: 'application.install', status: 'queued' } })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.one_click.deploy_requested' }))
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.one_click.job_submitted' }))
  })

  it('reads app-installer catalog and instances, installs onto owned domain, and removes an instance', async () => {
    const h = createHarness()
    await h.seedOffer(['wordpress'])
    const read = await h.call(WHM_APP_INSTALLER_PATH)
    expect(read!.status).toBe(200)
    const body = await read!.json() as { instances: { appId: string }[]; targets: { domain: string }[] }
    expect(body.instances[0]!.appId).toBe('wordpress')
    expect(body.targets[0]!.domain).toBe('alice.example')

    const installed = await h.call(`${WHM_APP_INSTALLER_PATH}/install`, 'POST', {
      domainId: DOMAIN.id,
      appId: 'wordpress',
      version: '6.7.1',
      expectedRevision: REV,
      expectedCatalogRevision: CAT_REV,
    })
    expect(installed!.status).toBe(202)
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.app_installer.install_requested' }))

    const removed = await h.call(`${WHM_APP_INSTALLER_PATH}/remove`, 'POST', {
      username: 'alice',
      domainId: DOMAIN.id,
      path: 'blog',
      expectedRecord: REV,
    })
    expect(removed!.status).toBe(202)
    expect(await removed!.json()).toEqual({ job: { id: 'job-app-2', kind: 'application.remove', status: 'queued' } })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.app_installer.remove_requested' }))
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.app_installer.job_submitted' }))
  })
})
