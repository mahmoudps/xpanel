// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderV2WhmSoftwareCenter, renderV2WhmStore } from './themes/v2/pages/xwhm/software/catalog.ts'
import {
  parseAppInstallerResponse,
  parseDistroPackagesResponse,
  parseOneClickResponse,
  WHM_APP_INSTALLER_CLIENT_BINDING,
} from './whm-app-installer-client.ts'

const REV = 'a'.repeat(64)
const CAT_REV = 'b'.repeat(64)
const EXTRA_FP = 'c'.repeat(64)
const DOMAIN_ID = '22222222-2222-4222-8222-222222222222'
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'

function makeDistroView(state: 'read' | 'unavailable' = 'read') {
  return {
    state,
    reason: state === 'read' ? null : 'host_agent_unavailable',
    family: state === 'read' ? 'debian' : null,
    observedAt: state === 'read' ? '2026-11-27T10:00:00.000Z' : null,
    revision: state === 'read' ? REV : null,
    components: [
      {
        id: 'redis-server',
        page: 'catalog',
        category: 'cache',
        name: 'Redis server',
        description: 'In-memory cache service',
        packages: ['redis-server'],
        state: state === 'read' ? 'absent' : 'unavailable',
        needsReview: false,
        installed: [],
        estimate: { memoryMb: 64, diskMb: 24 },
      },
      {
        id: 'imagemagick',
        page: 'catalog',
        category: 'media',
        name: 'ImageMagick',
        description: 'CLI image conversion tools',
        packages: ['imagemagick'],
        state: state === 'read' ? 'installed' : 'unavailable',
        needsReview: false,
        installed: state === 'read' ? [{ name: 'imagemagick', versions: ['6.9.11'] }] : [],
        estimate: { memoryMb: 32, diskMb: 48 },
      },
    ],
    actions: { manage: state === 'read' },
  }
}

function makeInstallerView() {
  return {
    state: 'read',
    reason: null,
    host: {
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
          { id: 'nextcloud', name: 'Nextcloud', versions: ['30.0.1'], stored: ['30.0.1'] },
        ],
      },
    },
    offered: ['wordpress'],
    targets: [
      {
        accountId: ACCOUNT_ID,
        username: 'alice',
        domainId: DOMAIN_ID,
        domain: 'alice.example',
        docRoot: '/home/alice/public_html',
        siteType: 'php',
      },
    ],
    instances: [
      {
        username: 'alice',
        accountId: ACCOUNT_ID,
        domainId: DOMAIN_ID,
        domain: 'alice.example',
        path: 'blog',
        appId: 'wordpress',
        version: '6.7.1',
        revision: REV,
      },
    ],
  }
}

function mount(html: string, transport: (method: string, path: string, body?: unknown) => Promise<unknown>, askDialog?: (opts: Record<string, unknown>) => Promise<unknown>) {
  document.body.innerHTML = html
  ;(window as unknown as Record<string, unknown>).xpT = (msg: string, vals?: Record<string, unknown>) =>
    vals ? msg.replace(/\{([a-z0-9_]+)\}/gi, (_, k) => String(vals[k] ?? '')) : msg
  ;(window as unknown as Record<string, unknown>).xpanelSessionRequest = transport
  const bind = new Function('return ' + WHM_APP_INSTALLER_CLIENT_BINDING)() as (fn?: (opts: Record<string, unknown>) => Promise<unknown>) => void
  bind(askDialog)
}

const flush = () => new Promise(resolve => setTimeout(resolve, 10))

beforeEach(() => { document.body.innerHTML = '' })
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).xpanelSessionRequest
  delete (window as unknown as Record<string, unknown>).xpT
  document.body.innerHTML = ''
})

describe('WHM app installer, one-click deploy, and distro packages client', () => {
  it('enforces strict payload validation and keeps the serialized client bundle free of innerHTML and dynamic selectors', async () => {
    expect(() => parseDistroPackagesResponse('view', makeDistroView('read'))).not.toThrow()
    expect(() => parseDistroPackagesResponse('view', { state: 'read', components: [{ id: 'redis-server', name: '<script>x</script>' }], actions: { manage: true } })).toThrow()
    expect(() => parseOneClickResponse('view', makeInstallerView())).not.toThrow()
    expect(() => parseAppInstallerResponse('view', { state: 'read', offered: ['../bad'] })).toThrow()

    const source = await readFile(new URL('./whm-app-installer-client.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/innerHTML/)
    expect(source).not.toMatch(/style=/)
    expect(source).not.toMatch(/\b(v0|v1|v2|v3|smart|legacy|hero|magic|super)\b/i)
    for (const match of source.matchAll(/\.(querySelector|querySelectorAll|closest|matches)\s*(?:<[^>]+>)?\s*\(([^)]+)\)/g)) {
      expect(match[2]!.trim()).toMatch(/^(?:'[^']+'|"[^"]+"|`[^`]+`)$/)
    }
  })

  it('loads, filters, previews with extra removal acknowledgement, and applies distro package changes', async () => {
    const requests: { method: string; path: string; body?: unknown }[] = []
    const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
      requests.push({ method, path, body })
      if (method === 'GET' && path.startsWith('/api/server/software/distro-packages')) return makeDistroView('read')
      if (method === 'POST' && path === '/api/server/software/distro-packages/preview') {
        return {
          preview: {
            state: 'ready',
            reason: null,
            blockers: [],
            action: 'remove',
            revision: REV,
            componentIds: ['imagemagick'],
            resolvedComponentIds: ['imagemagick'],
            extraRemovals: ['php-imagick'],
            extraRemovalsFingerprint: EXTRA_FP,
          },
        }
      }
      if (method === 'POST' && path === '/api/server/software/distro-packages/apply') {
        return { job: { id: 'job-dp-42', kind: 'software.component.remove', status: 'queued' } }
      }
      throw new Error('unexpected ' + method + ' ' + path)
    })
    const askDialog = vi.fn(async () => true)
    const html = renderV2WhmSoftwareCenter({ locale: 'en', dataAuthority: { canRead: true, canManage: true } }, 'catalog')
    mount(html, transport, askDialog)
    await flush()

    const root = document.querySelector('[data-whm-distro-packages]')!
    expect(root.querySelectorAll('[data-dp-rows] tr').length).toBe(2)

    const removeBtn = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-dp-rows] [data-xp-slot="remove"]'))[1]!
    expect(removeBtn.disabled).toBe(false)
    removeBtn.click()
    await flush()

    const confirmBtn = root.querySelector<HTMLButtonElement>('[data-dp-confirm]')!
    const acceptExtra = root.querySelector<HTMLInputElement>('[data-dp-accept-extra]')!
    expect(confirmBtn.disabled).toBe(true)
    acceptExtra.click()
    expect(confirmBtn.disabled).toBe(false)

    confirmBtn.click()
    await flush()

    expect(askDialog).toHaveBeenCalledTimes(1)
    expect(requests.some(req => req.path === '/api/server/software/distro-packages/apply')).toBe(true)
    const applyReq = requests.find(req => req.path === '/api/server/software/distro-packages/apply')!
    expect(applyReq.body).toEqual({
      action: 'remove',
      componentIds: ['imagemagick'],
      expectedRevision: REV,
      acceptExtraRemovals: EXTRA_FP,
    })
    const jobLink = root.querySelector<HTMLAnchorElement>('[data-dp-job-link]')!
    expect(jobLink.getAttribute('href')).toBe('/whm/jobs?job=job-dp-42')
  })

  it('wires one-click deploy and app installer on /whm/software/store without placeholder store blocks', async () => {
    const html = renderV2WhmStore({ locale: 'en', dataAuthority: { canRead: true, canManage: true }, plans: [] }, '/whm/software/store')
    expect(html).not.toContain('data-section="store-unavailable"')
    expect(html).not.toContain('data-section="store-actions"')

    const requests: { method: string; path: string; body?: unknown }[] = []
    const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
      requests.push({ method, path, body })
      if (method === 'GET' && (path === '/api/server/software/one-click' || path === '/api/server/software/app-installer')) {
        return makeInstallerView()
      }
      if (method === 'POST' && path === '/api/server/software/one-click/deploy') {
        return { job: { id: 'job-ocd-9', kind: 'application.install', status: 'queued' } }
      }
      if (method === 'POST' && path === '/api/server/software/app-installer/remove') {
        return { job: { id: 'job-ai-rm-3', kind: 'application.remove', status: 'queued' } }
      }
      throw new Error('unexpected ' + method + ' ' + path)
    })
    const askDialog = vi.fn(async () => true)
    mount(html, transport, askDialog)
    await flush()

    const ocd = document.querySelector('[data-whm-one-click-deploy]')!
    const ocdApp = ocd.querySelector<HTMLSelectElement>('[data-ocd-app]')!
    expect(Array.from(ocdApp.options).map(o => o.value)).toEqual(['', 'wordpress'])
    const ocdPath = ocd.querySelector<HTMLInputElement>('[data-ocd-path]')!
    ocdPath.value = '/shop/'
    ocd.querySelector<HTMLButtonElement>('[data-ocd-deploy]')!.click()
    await flush()

    const deployReq = requests.find(req => req.path === '/api/server/software/one-click/deploy')!
    expect(deployReq.body).toEqual({
      domainId: DOMAIN_ID,
      appId: 'wordpress',
      version: '6.7.1',
      path: 'shop',
      expectedRevision: CAT_REV,
      expectedCatalogRevision: CAT_REV,
    })
    expect(ocd.querySelector<HTMLAnchorElement>('[data-ocd-job-link]')!.getAttribute('href')).toBe('/whm/jobs?job=job-ocd-9')

    const ai = document.querySelector('[data-whm-app-installer]')!
    const aiRemove = ai.querySelector<HTMLButtonElement>('[data-ai-rows] [data-xp-slot="remove"]')!
    expect(aiRemove.disabled).toBe(false)
    aiRemove.click()
    await flush()

    const removeReq = requests.find(req => req.path === '/api/server/software/app-installer/remove')!
    expect(removeReq.body).toEqual({
      username: 'alice',
      domainId: DOMAIN_ID,
      path: 'blog',
      expectedRecord: REV,
    })
    expect(ai.querySelector<HTMLAnchorElement>('[data-ai-job-link]')!.getAttribute('href')).toBe('/whm/jobs?job=job-ai-rm-3')
  })

  it('refuses mutations inside read-only frames while allowing safe read display', async () => {
    const requests: { method: string; path: string }[] = []
    const transport = vi.fn(async (method: string, path: string) => {
      requests.push({ method, path })
      if (method === 'GET') return makeInstallerView()
      throw new Error('mutation should not fire')
    })
    const html = '<div data-readonly="true">' + renderV2WhmStore({ locale: 'en', dataAuthority: { canRead: true, canManage: true }, plans: [] }, '/whm/software/store') + '</div>'
    mount(html, transport, vi.fn(async () => true))
    await flush()

    const ocdDeploy = document.querySelector<HTMLButtonElement>('[data-ocd-deploy]')!
    const aiInstall = document.querySelector<HTMLButtonElement>('[data-ai-install]')!
    const aiRemove = document.querySelector<HTMLButtonElement>('[data-ai-rows] [data-xp-slot="remove"]')!
    expect(ocdDeploy.disabled).toBe(true)
    expect(aiInstall.disabled).toBe(true)
    expect(aiRemove.disabled).toBe(true)
    expect(requests.every(req => req.method === 'GET')).toBe(true)
  })
})
