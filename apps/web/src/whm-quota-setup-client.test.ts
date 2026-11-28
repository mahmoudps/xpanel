// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerSettings } from '@xpanel/core'
import { translator } from './i18n.ts'
import { renderV2WhmSetup } from './themes/v2/pages/xwhm/server/setup.ts'
import { WHM_QUOTA_SETUP_CLIENT_BINDING, bindWhmQuotaSetup, isAllowedQuotaFilesystem, readQuotaSetupStatus } from './whm-quota-setup-client.ts'

const settings: ServerSettings = {
  hostname: 'panel.example.test',
  nameservers: ['ns1.example.test', 'ns2.example.test'],
  adminEmail: 'ops@example.test',
  engine: 'apache',
  apacheMpm: 'itk',
  panelPort: 2087,
  sshPort: 22,
  backendPort: 8080,
  backendTlsPort: 8443,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 8192, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 },
}

const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }

function mount(opts: { canRead?: boolean; canManage?: boolean; locale?: 'en' | 'ar'; withSettings?: boolean } = {}) {
  const locale = opts.locale ?? 'en'
  document.documentElement.lang = locale
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderV2WhmSetup(
    translator(locale),
    { activeRoute: '/whm/server/setup', locale, principal: { kind: 'root', id: 'root-1', username: 'root' }, ...(opts.withSettings === false ? {} : { serverSettings: settings }) },
    { canRead: opts.canRead ?? true, canManage: opts.canManage ?? true },
  )
  return document.querySelector<HTMLElement>('[data-quota-setup]')!
}

afterEach(() => {
  document.documentElement.lang = 'en'
  document.documentElement.dir = 'ltr'
  document.body.replaceChildren()
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})

describe('WHM quota setup client', () => {
  it('validates /home and /home0-/home99 and removes inert setup controls from setup markup', () => {
    expect(isAllowedQuotaFilesystem('/home')).toBe(true)
    expect(isAllowedQuotaFilesystem('/home0')).toBe(true)
    expect(isAllowedQuotaFilesystem('/home99')).toBe(true)
    expect(isAllowedQuotaFilesystem('/home100')).toBe(false)
    expect(isAllowedQuotaFilesystem('/tmp')).toBe(false)

    mount()
    expect(document.querySelector('#v2-setup-ns1-address')).toBeNull()
    expect(document.querySelector('#v2-setup-default-pm')).toBeNull()
    expect(document.querySelector('#v2-setup-lsphp-0')).toBeNull()
    const select = document.querySelector<HTMLSelectElement>('[data-quota-filesystem]')!
    expect(select.options).toHaveLength(101)
    expect(select.value).toBe('/home')
  })

  it('reads live quota mount status, initializes selected filesystem after confirmation and wires worker child checkbox', async () => {
    let status: 'disabled' | 'enabled' = 'disabled'
    const wizardReply = () => ({
      setupComplete: true,
      settings,
      wizardState: { quotaFilesystem: '/home2' },
      quotaInitialized: status === 'enabled',
      quotaInitialization: { status, reason: status === 'enabled' ? null : 'quota_not_enforced', filesystem: '/home2', filesystemType: 'ext4', observedAt: '2026-11-27T10:00:00.000Z' },
      defaultSuggested: { nginx: { workerConnections: 2048, workerRlimitNofile: 16384 }, apache: { maxRequestWorkers: 200, serverLimit: 200 } },
    })
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/api/setup/wizard') return wizardReply()
      if (method === 'POST' && path === '/api/server/quotas/init') {
        status = 'enabled'
        return { filesystem: '/home2', filesystemType: 'ext4', status: 'enabled', changed: true, fstabBackup: '/etc/fstab.bak.20261127T100000Z' }
      }
      throw new Error('unexpected')
    })
    const ask = vi.fn(async () => true)
    const root = mount()
    bindWhmQuotaSetup(root, request, ask)
    await settle()

    expect(readQuotaSetupStatus(wizardReply()).status).toBe('disabled')
    expect(document.querySelector('[data-quota-fact="filesystem"]')?.textContent).toBe('/home2')
    expect(document.querySelector('[data-quota-fact="filesystemType"]')?.textContent).toBe('ext4')
    expect(document.querySelector('[data-quota-fact="quotaStatus"]')?.textContent).toBe('Not enforced')
    expect(document.querySelectorAll('[data-setup-diff-rows] tr')).toHaveLength(4)

    const select = document.querySelector<HTMLSelectElement>('[data-quota-filesystem]')!
    select.value = '/home2'
    document.querySelector<HTMLButtonElement>('[data-quota-init]')!.click()
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('POST', '/api/server/quotas/init', { filesystem: '/home2' })
    expect(document.querySelector('[data-quota-fact="quotaStatus"]')?.textContent).toBe('Enforced')
    expect(document.querySelector('[data-quota-status]')?.textContent).toContain('/etc/fstab.bak.20261127T100000Z')

    const unlimited = document.querySelector<HTMLInputElement>('[data-setup-unlimited-child]')!
    const maxChild = document.querySelector<HTMLInputElement>('input[name="apache.maxConnectionsPerChild"]')!
    expect(unlimited.checked).toBe(false)
    unlimited.checked = true
    unlimited.dispatchEvent(new Event('change'))
    expect(maxChild.value).toBe('0')
    unlimited.checked = false
    unlimited.dispatchEvent(new Event('change'))
    expect(maxChild.value).toBe('1000')
  })

  it('does not initialize when declined or in a read-only frame and runs serialized binding in Arabic', async () => {
    const request = vi.fn(async () => ({
      quotaInitialization: { status: 'disabled', reason: 'quota_not_enforced', filesystem: '/home', filesystemType: 'ext4', observedAt: '2026-11-27T10:00:00.000Z' },
    }))
    const root = mount()
    bindWhmQuotaSetup(root, request, async () => false)
    await settle()
    document.querySelector<HTMLButtonElement>('[data-quota-init]')!.click()
    await settle()
    expect(request).toHaveBeenCalledTimes(1)

    mount({ locale: 'ar', canRead: true, canManage: true })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    ;(new Function('return ' + WHM_QUOTA_SETUP_CLIENT_BINDING)() as () => void)()
    await settle()
    expect(document.querySelector('[data-quota-fact="filesystem"]')?.tagName).toBe('BDI')
    expect(document.querySelector('[data-quota-fact="filesystem"]')?.getAttribute('dir')).toBe('ltr')
    expect(WHM_QUOTA_SETUP_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_QUOTA_SETUP_CLIENT_BINDING).not.toMatch(/Not read|Not observed/)
  })
})
