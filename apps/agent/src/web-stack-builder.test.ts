import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OsProfile, ServerSettings } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { handleWebStackRoute, validateWebStackSelection, type WebStackHostFs, type WebStackRouteDeps } from './web-stack-builder.ts'

const osProfile: OsProfile = profileFor('ID=ubuntu\nVERSION_ID=24.04')
const readJson = async (res: Response | null): Promise<Record<string, any>> => res!.json() as Promise<Record<string, any>>

const baseSettings: ServerSettings = {
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
}

let stateRoot = ''
beforeEach(async () => { stateRoot = await mkdtemp(join(tmpdir(), 'xp-web-stack-')) })
afterEach(async () => { await rm(stateRoot, { recursive: true, force: true }) })

function setup(overrides: Partial<WebStackRouteDeps> = {}) {
  const files = new Map<string, string>([
    ['/etc/apache2/sites-enabled/000-xpanel-mpm.conf', '# old mpm\n'],
  ])
  const fs: WebStackHostFs = {
    readFile: async path => files.get(path) ?? null,
    writeFile: async file => { files.set(file.path, file.content) },
    stat: async path => (files.has(path) ? { uid: 0, gid: 0, mode: 0o644 } : null),
  }
  const runCalls: string[][] = []
  const run = vi.fn(async (argv: readonly string[]) => {
    runCalls.push([...argv])
    if (argv[0] === '/usr/bin/systemctl' && argv[1] === 'show') {
      return { ok: true, code: 0, stdout: 'LoadState=loaded\nActiveState=active\n', stderr: '' }
    }
    if (argv[1] === '-M') {
      return { ok: true, code: 0, stdout: ' mpm_itk_module (shared)\n rewrite_module (shared)\n', stderr: '' }
    }
    return { ok: true, code: 0, stdout: 'Syntax OK', stderr: '' }
  })
  const audits: unknown[] = []
  const deps: WebStackRouteDeps = {
    assertRoot: async () => ({ actor: 'root' }),
    os: osProfile,
    stateRoot,
    readServerSettings: async () => ({ ...baseSettings }),
    updateServerSettings: vi.fn(async () => undefined),
    run,
    fs,
    audit: async entry => { audits.push(entry) },
    now: () => new Date('2026-11-27T12:00:00.000Z'),
    ...overrides,
  }
  const call = (path: string, method = 'GET', body?: unknown) =>
    handleWebStackRoute(
      new Request('http://agent.local' + path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      }),
      new URL('http://agent.local' + path),
      method,
      deps,
    )
  return { deps, files, runCalls, audits, call }
}

describe('agent web-stack-builder', () => {
  it('fails closed with 409 CONFLICT when two MPMs are selected simultaneously', async () => {
    expect(() => validateWebStackSelection({ engine: 'apache', mpms: ['itk', 'event'] })).toThrowError(
      expect.objectContaining({ code: 'CONFLICT', detail: expect.objectContaining({ stateChanged: false, reason: 'multiple_mpms_selected' }) }),
    )
    expect(() => validateWebStackSelection({ engine: 'apache', modules: ['mpm_prefork', 'mpm_worker'] })).toThrowError(
      expect.objectContaining({ code: 'CONFLICT', detail: expect.objectContaining({ stateChanged: false, reason: 'multiple_mpms_selected' }) }),
    )

    const h = setup()
    await expect(h.call('/host/web-stack/preview', 'POST', { engine: 'apache', mpms: ['itk', 'prefork'] })).rejects.toMatchObject({
      code: 'CONFLICT',
      detail: { stateChanged: false, reason: 'multiple_mpms_selected' },
    })
  })

  it('fails closed with 422 VALIDATION when prefork, event, or worker is selected without mpm_itk', async () => {
    for (const badMpm of ['prefork', 'event', 'worker', 'mpm_prefork', 'mpm_event', 'mpm_worker']) {
      expect(() => validateWebStackSelection({ engine: 'apache', mpm: badMpm })).toThrowError(
        expect.objectContaining({ code: 'VALIDATION', detail: expect.objectContaining({ stateChanged: false, reason: 'mpm_isolation_required' }) }),
      )
    }

    const h = setup()
    await expect(h.call('/host/web-stack/apply', 'POST', { engine: 'apache', mpm: 'event' })).rejects.toMatchObject({
      code: 'VALIDATION',
      detail: { stateChanged: false, reason: 'mpm_isolation_required' },
    })
    expect(h.files.get('/etc/apache2/sites-enabled/000-xpanel-mpm.conf')).toBe('# old mpm\n')
  })

  it('previews and applies an mpm_itk web-stack profile with config tests, generation backup, and audit', async () => {
    const h = setup()
    const readRes = await h.call('/host/web-stack')
    const view = await readJson(readRes)
    expect(view.isolationPolicy).toBe('mpm_itk')
    expect(view.mpmConfigPreview).toContain('mpm_itk_module')

    const previewRes = await h.call('/host/web-stack/preview', 'POST', {
      profileId: 'apache-itk-hardened',
      engine: 'apache',
      mpm: 'itk',
      modules: ['mod_rewrite', 'mod_ssl', 'mod_security2'],
      phpVersions: ['8.3', '8.4'],
    })
    const preview = await readJson(previewRes)
    expect(preview.valid).toBe(true)
    expect(preview.stateChanged).toBe(false)
    expect(preview.renderedFiles[0].content).toContain('mpm_itk_module')

    const applyRes = await h.call('/host/web-stack/apply', 'POST', {
      profileId: 'apache-itk-hardened',
      engine: 'apache',
      mpm: 'itk',
      modules: ['mod_rewrite', 'mod_ssl', 'mod_security2'],
      phpVersions: ['8.3', '8.4'],
      expectedRevision: view.revision,
    })
    const applied = await readJson(applyRes)
    expect(applied.applied).toBe(true)
    expect(applied.generationId).toBe(1)
    expect(applied.tests.nginx.ok).toBe(true)
    expect(applied.tests.apache.ok).toBe(true)
    expect(h.runCalls.some(argv => argv.includes('configtest'))).toBe(true)
    expect(h.audits).toHaveLength(1)
  })

  it('rolls back modified MPM configuration when apachectl configtest fails', async () => {
    const h = setup({
      run: vi.fn(async (argv: readonly string[]) => {
        if (argv.includes('configtest')) {
          return { ok: false, code: 1, stdout: '', stderr: 'AH00526: Syntax error' }
        }
        return { ok: true, code: 0, stdout: 'Syntax OK', stderr: '' }
      }),
    })
    await expect(h.call('/host/web-stack/apply', 'POST', { profileId: 'apache-itk-fpm', engine: 'apache', mpm: 'itk' })).rejects.toMatchObject({
      code: 'CONFIG_TEST_FAILED',
      detail: { stateChanged: false, restored: true, reason: 'web_stack_config_test_failed', failedTest: 'apache' },
    })
    expect(h.files.get('/etc/apache2/sites-enabled/000-xpanel-mpm.conf')).toBe('# old mpm\n')
  })
})
