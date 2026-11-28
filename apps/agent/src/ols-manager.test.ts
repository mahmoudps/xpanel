import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OsProfile, ServerSettings } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { handleOlsManagerRoute, validateOlsConfigText, type OlsHostFs, type OlsRouteDeps } from './ols-manager.ts'

const osProfile: OsProfile = profileFor('ID=ubuntu\nVERSION_ID=24.04')
const readJson = async (res: Response | null): Promise<Record<string, any>> => res!.json() as Promise<Record<string, any>>

const baseSettings: ServerSettings = {
  hostname: 'host.example.test',
  nameservers: ['ns1.example.test'],
  adminEmail: 'root@example.test',
  engine: 'openlitespeed',
  apacheMpm: 'itk',
  panelPort: 2087,
  sshPort: 22,
  backendPort: 8080,
  backendTlsPort: 8443,
  nginx: { workerProcesses: 'auto', workerConnections: 2048, workerRlimitNofile: 8192, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 120, serverLimit: 120, maxConnectionsPerChild: 0 },
}

let stateRoot = ''
beforeEach(async () => { stateRoot = await mkdtemp(join(tmpdir(), 'xp-ols-mgr-')) })
afterEach(async () => { await rm(stateRoot, { recursive: true, force: true }) })

function setup(opts: { installed?: boolean; failRestartOnCandidate?: boolean } = {}) {
  const installed = opts.installed ?? true
  const files = new Map<string, string>()
  if (installed) {
    files.set('/usr/local/lsws/bin/lshttpd', 'binary')
    files.set('/usr/local/lsws/bin/lswsctrl', 'script')
    files.set('/usr/local/lsws/conf/httpd_config.conf', 'useIpInProxyHeader      2\nlistener xpanel-backend {\n  address                 127.0.0.1:8080\n  secure                  0\n}\n')
    files.set('/usr/local/lsws/logs/error.log', '2026-11-27 [INFO] lshttpd ready\n')
  }
  let active = installed ? 'active' : 'inactive'
  let enabled = installed ? 'enabled' : 'disabled'
  const fs: OlsHostFs = {
    readFile: async path => files.get(path) ?? null,
    writeFile: async file => { files.set(file.path, file.content) },
    stat: async path => (files.has(path) ? { uid: 0, gid: 0, mode: 0o644 } : null),
    tail: async path => files.get(path) ?? null,
  }
  const run = vi.fn(async (argv: readonly string[]) => {
    if (argv[0] === '/usr/bin/systemctl' && argv[1] === 'show') {
      return {
        ok: true,
        code: 0,
        stdout: installed
          ? `Id=lshttpd.service\nLoadState=loaded\nActiveState=${active}\nUnitFileState=${enabled}\n`
          : 'Id=lshttpd.service\nLoadState=not-found\nActiveState=inactive\nUnitFileState=\n',
        stderr: '',
      }
    }
    if (argv[0] === '/usr/bin/systemctl') {
      const verb = argv[1]
      if (verb === 'stop') active = 'inactive'
      if (verb === 'start') active = 'active'
      if (verb === 'restart') {
        if (opts.failRestartOnCandidate && files.get('/usr/local/lsws/conf/httpd_config.conf')?.includes('badDirective')) {
          return { ok: false, code: 1, stdout: '', stderr: 'restart failed' }
        }
        active = 'active'
      }
      if (verb === 'enable') enabled = 'enabled'
      if (verb === 'disable') enabled = 'disabled'
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    if (argv[0] === '/usr/local/lsws/bin/lswsctrl' && argv[1] === 'configtest') {
      return { ok: true, code: 0, stdout: 'OK', stderr: '' }
    }
    return { ok: true, code: 0, stdout: '', stderr: '' }
  })
  const deps: OlsRouteDeps = {
    assertRoot: async () => ({ actor: 'root' }),
    os: osProfile,
    stateRoot,
    readServerSettings: async () => ({ ...baseSettings }),
    run,
    fs,
    now: () => new Date('2026-11-27T12:00:00.000Z'),
  }
  const call = (path: string, method = 'GET', body?: unknown) =>
    handleOlsManagerRoute(
      new Request('http://agent.local' + path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      }),
      new URL('http://agent.local' + path),
      method,
      deps,
    )
  return { deps, files, call }
}

describe('agent ols-manager', () => {
  it('reports state not_installed truthfully when lshttpd binary and unit are absent', async () => {
    const h = setup({ installed: false })
    const res = await h.call('/host/services/openlitespeed')
    const view = await readJson(res)
    expect(view.installed).toBe(false)
    expect(view.state).toBe('not_installed')
    expect(view.active).toBeNull()
    expect(view.renderedReference).toContain('useIpInProxyHeader')
    await expect(h.call('/host/services/openlitespeed/action', 'POST', { action: 'restart' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      detail: { stateChanged: false, reason: 'openlitespeed_not_installed' },
    })
  })

  it('rejects shell metacharacters and unsafe include directives in httpd_config.conf', () => {
    expect(() => validateOlsConfigText('serverName $(whoami)\n')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION', detail: expect.objectContaining({ reason: 'unsafe_ols_directive' }) }),
    )
    expect(() => validateOlsConfigText('serverName host; rm -rf /\n')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION', detail: expect.objectContaining({ reason: 'unsafe_ols_directive' }) }),
    )
    expect(() => validateOlsConfigText('include /etc/passwd\n')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION', detail: expect.objectContaining({ reason: 'unsafe_ols_include' }) }),
    )
    expect(() => validateOlsConfigText('include /usr/local/lsws/conf/../../etc/shadow.conf\n')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION', detail: expect.objectContaining({ reason: 'unsafe_ols_include' }) }),
    )
    expect(validateOlsConfigText('include /usr/local/lsws/conf/vhosts/site.conf\nlistener xpanel-backend {\n  address 127.0.0.1:8080\n}\n').valid).toBe(true)
  })

  it('controls lshttpd service actions, applies config with backup, rolls back on restart failure, and supports explicit rollback', async () => {
    const h = setup({ failRestartOnCandidate: true })
    const initial = await readJson(await h.call('/host/services/openlitespeed'))
    expect(initial.state).toBe('active')

    const stopped = await readJson(await h.call('/host/services/openlitespeed/action', 'POST', { action: 'stop' }))
    expect(stopped.state).toBe('inactive')
    const started = await readJson(await h.call('/host/services/openlitespeed/action', 'POST', { action: 'start' }))
    expect(started.state).toBe('active')

    const preview = await readJson(await h.call('/host/services/openlitespeed/config/preview', 'POST', { generateBase: true }))
    expect(preview.valid).toBe(true)
    expect(preview.renderedText).toContain('listener xpanel-backend')

    const originalConf = h.files.get('/usr/local/lsws/conf/httpd_config.conf')!
    await expect(
      h.call('/host/services/openlitespeed/config/apply', 'POST', { text: 'badDirective 1\n', expectedRevision: initial.revision }),
    ).rejects.toMatchObject({
      code: 'CONFIG_TEST_FAILED',
      detail: { stateChanged: false, restored: true, reason: 'openlitespeed_config_rejected' },
    })
    expect(h.files.get('/usr/local/lsws/conf/httpd_config.conf')).toBe(originalConf)

    const validNext = `${originalConf}tuning {\n  maxConnections 500\n}\n`
    const applied = await readJson(await h.call('/host/services/openlitespeed/config/apply', 'POST', { text: validNext, expectedRevision: initial.revision }))
    expect(applied.applied).toBe(true)
    expect(h.files.get('/usr/local/lsws/conf/httpd_config.conf')).toBe(validNext)

    const rolled = await readJson(await h.call('/host/services/openlitespeed/config/rollback', 'POST', { backupId: applied.backupId, expectedRevision: applied.revision }))
    expect(rolled.rolledBack).toBe(true)
    expect(h.files.get('/usr/local/lsws/conf/httpd_config.conf')).toBe(originalConf)
  })
})
