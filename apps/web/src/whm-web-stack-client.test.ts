// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderV2WhmWebServer } from './themes/v2/pages/xwhm/service-tools/web.ts'
import {
  readOpenLiteSpeedView,
  readWebStackView,
  validateWebStackMpmChoice,
  WHM_WEB_STACK_CLIENT_BINDING,
} from './whm-web-stack-client.ts'

const saved = {
  hostname: 'host.example.test',
  nameservers: ['ns1.example.test'],
  adminEmail: 'root@example.test',
  engine: 'apache' as const,
  apacheMpm: 'itk' as const,
  panelPort: 2087,
  sshPort: 22,
  backendPort: 8080,
  backendTlsPort: 8443,
  nginx: { workerProcesses: 'auto' as const, workerConnections: 2048, workerRlimitNofile: 8192, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 120, serverLimit: 120, maxConnectionsPerChild: 0 },
}

const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }

const stackResponse = {
  observedAt: '2026-11-27T12:00:00.000Z',
  engine: 'apache',
  apacheMpm: 'itk',
  isolationPolicy: 'mpm_itk',
  isolationEnforced: true,
  activeProfile: {
    profileId: 'apache-itk-fpm',
    engine: 'apache',
    mpm: 'itk',
    modules: ['mod_rewrite', 'mod_ssl'],
    phpVersions: ['8.3'],
  },
  profiles: [
    { id: 'apache-itk-fpm', name: 'Nginx Edge + Apache mpm_itk + PHP-FPM', engine: 'apache', mpm: 'itk', modules: ['mod_rewrite', 'mod_ssl'], phpVersions: ['8.3'], summary: 'Isolated Apache' },
  ],
  mpmConfigPath: '/etc/apache2/sites-enabled/000-xpanel-mpm.conf',
  mpmConfigPreview: '# Managed by xPanel: Apache MPM (mpm_itk on prefork)\n',
  revision: 'a'.repeat(64),
}

const olsNotInstalledResponse = {
  observedAt: '2026-11-27T12:00:00.000Z',
  installed: false,
  state: 'not_installed',
  unit: null,
  active: null,
  enabled: null,
  binaryPath: '/usr/local/lsws/bin/lshttpd',
  configPath: '/usr/local/lsws/conf/httpd_config.conf',
  config: null,
  revision: null,
  backups: [],
  logTail: [],
  renderedReference: 'useIpInProxyHeader 2\n',
}

beforeEach(() => {
  document.body.innerHTML = renderV2WhmWebServer({
    locale: 'en',
    serverSettings: saved as never,
    dataAuthority: { canRead: true, canManage: true },
  })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})

describe('WHM web-stack builder and OpenLiteSpeed client controller', () => {
  it('validates MPM isolation choices and parses strict stack/OpenLiteSpeed responses', () => {
    expect(validateWebStackMpmChoice(['itk'])).toEqual({ ok: true, mpm: 'itk' })
    expect(validateWebStackMpmChoice(['itk', 'event'])).toEqual({ ok: false, status: 409, reason: 'multiple_mpms_selected' })
    expect(validateWebStackMpmChoice(['prefork'])).toEqual({ ok: false, status: 422, reason: 'mpm_isolation_required' })
    expect(readWebStackView(stackResponse).isolationPolicy).toBe('mpm_itk')
    expect(readOpenLiteSpeedView(olsNotInstalledResponse).state).toBe('not_installed')
    expect(WHM_WEB_STACK_CLIENT_BINDING).toContain('frameRequest')
    expect(WHM_WEB_STACK_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_WEB_STACK_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('loads web-stack and OpenLiteSpeed state via frameRequest and keeps OLS actions disabled when not_installed', async () => {
    const send = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/api/server/web-stack') return stackResponse
      if (method === 'GET' && path === '/api/server/services/openlitespeed') return olsNotInstalledResponse
      if (method === 'POST' && path === '/api/server/web-stack/preview') {
        return {
          valid: true,
          isolationPolicy: 'mpm_itk',
          diff: { addModules: [], removeModules: [], addPhpVersions: [], removePhpVersions: [], engineChanged: false },
          renderedFiles: [{ path: '/etc/apache2/sites-enabled/000-xpanel-mpm.conf', content: 'StartServers 2\n' }],
        }
      }
      throw new Error(`unexpected ${method} ${path}`)
    })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    new Function('return ' + WHM_WEB_STACK_CLIENT_BINDING)()(vi.fn(async () => true))
    await tick()

    expect(send).toHaveBeenCalledWith('GET', '/api/server/web-stack')
    expect(send).toHaveBeenCalledWith('GET', '/api/server/services/openlitespeed')
    expect(document.querySelector('[data-web-stack-active-mpm]')!.textContent).toBe('mpm_itk')
    expect(document.querySelector('[data-ols-state]')!.textContent).toBe('Not installed')
    expect(document.querySelector<HTMLButtonElement>('[data-ols-action="restart"]')!.disabled).toBe(true)

    document.querySelector<HTMLButtonElement>('[data-web-stack-preview]')!.click()
    await tick()
    expect(document.querySelector('[data-web-stack-preview-output]')!.textContent).toContain('StartServers 2')
  })
})
