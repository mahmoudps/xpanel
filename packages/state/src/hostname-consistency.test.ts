import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSettings } from '@xpanel/core'
import { ExtendedFeaturesStore } from './extended-store.ts'
import { StateStore } from './store.ts'

const io = vi.hoisted(() => ({
  beforeRename: null as null | ((target: string) => Promise<void>),
  afterRename: null as null | ((target: string) => Promise<void>),
}))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const target = String(args[1]).replace(/\\/g, '/')
      await io.beforeRename?.(target)
      await fs.rename(...args)
      await io.afterRename?.(target)
    },
  }
})

const settings = (): ServerSettings => ({
  hostname: 'before.example.net',
  nameservers: ['ns1.example.net'],
  adminEmail: 'ops@example.net',
  engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 65535, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 },
  backendPort: 8080, backendTlsPort: 8443,
})

describe('canonical hostname mutation authority', () => {
  let rootDir: string
  let state: StateStore
  let extended: ExtendedFeaturesStore

  beforeEach(async () => {
    io.beforeRename = null
    io.afterRename = null
    rootDir = await mkdtemp(join(tmpdir(), 'xpanel-hostname-consistency-'))
    state = new StateStore(rootDir)
    extended = new ExtendedFeaturesStore(rootDir)
    await state.saveServerSettings(settings())
    await extended.saveSetupWizardStep({ step: 2, hostname: 'before.example.net' })
  })

  afterEach(async () => {
    io.beforeRename = null
    io.afterRename = null
    await rm(rootDir, { recursive: true, force: true })
  })

  it('waits for the canonical writer before changing either hostname projection', async () => {
    const serverBefore = await readFile(join(rootDir, 'server.json'), 'utf8')
    const wizardBefore = await readFile(join(rootDir, 'extended', 'setup-wizard.json'), 'utf8')
    const lease = await state.writerLock.acquire()
    let settled = false
    const pending = extended.changeHostname('after.example.net').finally(() => { settled = true })
    try {
      await delay(80)
      expect(settled).toBe(false)
      expect(await readFile(join(rootDir, 'server.json'), 'utf8')).toBe(serverBefore)
      expect(await readFile(join(rootDir, 'extended', 'setup-wizard.json'), 'utf8')).toBe(wizardBefore)
    } finally {
      await lease.release()
      await pending
    }
    expect((await state.readSnapshot()).server?.settings.hostname).toBe('after.example.net')
    expect((await extended.getSetupWizardState()).hostname).toBe('after.example.net')
  })

  it('advances canonical authority once and preserves unrelated server settings', async () => {
    const before = await state.getAuthorityMetadata()
    const result = await extended.changeHostname('AFTER.EXAMPLE.NET')
    const after = await state.getAuthorityMetadata()
    expect(after.revision).toBe(before.revision + 1)
    expect(after.fencingToken).toBeGreaterThan(before.fencingToken)
    const snapshot = await state.readSnapshot()
    expect(snapshot.server?.settings).toEqual({ ...settings(), hostname: 'after.example.net' })
    expect(result.hostname).toBe('after.example.net')
    expect(result.updatedAt).toBe(snapshot.server?.updatedAt)
  })

  it('rejects corrupt canonical server state before modifying the wizard', async () => {
    const corrupt = JSON.stringify({ settings: { hostname: 'before.example.net' } })
    await writeFile(join(rootDir, 'server.json'), corrupt)
    const wizardBefore = await readFile(join(rootDir, 'extended', 'setup-wizard.json'), 'utf8')
    const before = await state.getAuthorityMetadata()
    await expect(extended.changeHostname('after.example.net')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await readFile(join(rootDir, 'server.json'), 'utf8')).toBe(corrupt)
    expect(await readFile(join(rootDir, 'extended', 'setup-wizard.json'), 'utf8')).toBe(wizardBefore)
    expect((await state.getAuthorityMetadata()).revision).toBe(before.revision)
  })

  it.each(['wizard', 'server', 'authority'] as const)('restores exact raw preimages when the %s write fails before commitment', async failedTarget => {
    const serverPath = join(rootDir, 'server.json')
    const wizardPath = join(rootDir, 'extended', 'setup-wizard.json')
    const serverRaw = JSON.stringify(JSON.parse(await readFile(serverPath, 'utf8')), null, 4) + '\r\n'
    const wizardRaw = ' ' + JSON.stringify(JSON.parse(await readFile(wizardPath, 'utf8'))) + '\n\n'
    await writeFile(serverPath, serverRaw)
    await writeFile(wizardPath, wizardRaw)
    const before = await state.getAuthorityMetadata()
    const failure = Object.assign(new Error('injected hostname write failure'), { code: 'EIO' })
    let authorityWrites = 0
    io.beforeRename = async target => {
      if (target.endsWith('/authority.json')) authorityWrites++
      if ((failedTarget === 'wizard' && target.endsWith('/extended/setup-wizard.json'))
        || (failedTarget === 'server' && target.endsWith('/server.json'))
        || (failedTarget === 'authority' && target.endsWith('/authority.json') && authorityWrites === 2)) {
        io.beforeRename = null
        throw failure
      }
    }
    await expect(extended.changeHostname('after.example.net')).rejects.toBe(failure)
    expect(io.beforeRename).toBeNull()
    expect(await readFile(serverPath, 'utf8')).toBe(serverRaw)
    expect(await readFile(wizardPath, 'utf8')).toBe(wizardRaw)
    const after = await state.getAuthorityMetadata()
    expect(after.revision).toBe(before.revision)
    expect(after.fencingToken).toBeGreaterThan(before.fencingToken)
    expect(await state.writerLock.readLockHolder()).toBeNull()
  })

  it('recognizes a persisted commit after an authority-write acknowledgement failure', async () => {
    const before = await state.getAuthorityMetadata()
    let authorityWrites = 0
    io.afterRename = async target => {
      if (!target.endsWith('/authority.json')) return
      authorityWrites++
      if (authorityWrites === 2) {
        io.afterRename = null
        throw Object.assign(new Error('lost commit acknowledgement'), { code: 'EIO' })
      }
    }
    const result = await extended.changeHostname('after.example.net')
    expect(io.afterRename).toBeNull()
    expect(result.hostname).toBe('after.example.net')
    expect((await state.getAuthorityMetadata()).revision).toBe(before.revision + 1)
    expect((await state.readSnapshot()).server?.settings.hostname).toBe('after.example.net')
    expect((await extended.getSetupWizardState()).hostname).toBe('after.example.net')
    expect(await state.writerLock.readLockHolder()).toBeNull()
  })

  it.each(['step', 'complete', 'quota'] as const)('serializes the overlapping %s wizard writer behind hostname rollback', async kind => {
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const released = new Promise<void>(resolve => { resume = resolve })
    const failure = Object.assign(new Error('hostname server write rejected'), { code: 'EIO' })
    io.beforeRename = async target => {
      if (!target.endsWith('/server.json')) return
      enter()
      await released
      io.beforeRename = null
      throw failure
    }
    const hostname = extended.changeHostname('after.example.net').then(
      value => ({ value }), error => ({ error }),
    )
    await entered
    const other = new ExtendedFeaturesStore(rootDir)
    let settled = false
    const mutation = (kind === 'step'
      ? other.saveSetupWizardStep({ step: 3, hostname: 'wizard-b.example.net' })
      : kind === 'complete'
        ? other.completeSetupWizard({ hostname: 'wizard-b.example.net', nameservers: ['ns1.example.net'], contactEmail: 'ops@example.net', engine: 'apache', primaryIpv4: '192.0.2.10', quotaFilesystem: '/home', quotaInitialized: false })
        : other.initializeFilesystemQuota('/home')).finally(() => { settled = true })
    try {
      await delay(80)
      expect(settled).toBe(false)
    } finally {
      resume()
      expect(await hostname).toEqual({ error: failure })
      await mutation
    }
    expect((await state.readSnapshot()).server?.settings.hostname).toBe('before.example.net')
    const wizard = await other.getSetupWizardState()
    expect(wizard.hostname).toBe(kind === 'quota' ? 'before.example.net' : 'wizard-b.example.net')
    if (kind === 'quota') expect(wizard.quotaFilesystem).toBe('/home')
  })
})
