import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerSettings } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'

const cleanup: Array<() => Promise<unknown>> = []
const settings = (): ServerSettings => ({ hostname: 'server.example.test', nameservers: ['ns1.example.test'], adminEmail: 'root@example.test', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 65535, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 }, backendPort: 8080, backendTlsPort: 8443 })
const fixture = async () => { const state = await createTestStateStore(); cleanup.push(() => state.close()); return state.store }
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('server settings authorization under the existing writer lease', () => {
  it('persists and reads explicit policy through the sole existing server settings authority', async () => {
    const store = await fixture(), source = { ...settings(), defaultSite: { response: 'redirect' as const, redirectTo: 'https://landing.example.test/', refuseHttps: true } }
    const guard = vi.fn(async (current: ServerSettings | null) => { expect(current).toBeNull() })
    expect(await store.saveServerSettings(source, { settingsGuard: guard })).toEqual(source)
    expect(guard).toHaveBeenCalledTimes(1)
    expect(await store.getServerSettings()).toEqual(source)
    expect((await store.readSnapshot()).server?.settings).toEqual(source)
  })
  it('passes current source to fresh authorization and preserves state after denial', async () => {
    const store = await fixture(), source = settings()
    await store.saveServerSettings(source)
    const revision = await store.getRevision()
    const guard = vi.fn(async (current: ServerSettings | null) => { expect(current).toEqual(source); throw new Error('Synthetic revoked root credential') })
    await expect(store.saveServerSettings({ ...source, defaultSite: { response: 'reject', redirectTo: null, refuseHttps: true } }, { expectedRevision: revision, settingsGuard: guard })).rejects.toThrow('Synthetic revoked root credential')
    expect(guard).toHaveBeenCalledTimes(1)
    expect(await store.getServerSettings()).toEqual(source)
    expect(await store.getRevision()).toBe(revision)
  })
  it('admits only one concurrent settings write for the same authority revision', async () => {
    const store = await fixture(), source = settings()
    await store.saveServerSettings(source)
    const revision = await store.getRevision(), guard = vi.fn(async () => {})
    const outcomes = await Promise.allSettled([false, true].map(refuseHttps => store.saveServerSettings({ ...source, defaultSite: { response: 'reject', redirectTo: null, refuseHttps } }, { expectedRevision: revision, settingsGuard: guard })))
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(guard).toHaveBeenCalledTimes(1)
  })
  it('keeps legacy absence unchanged when neither current nor incoming settings has a policy', async () => {
    const store = await fixture(), source = settings()
    await store.saveServerSettings(source)
    expect(await store.saveServerSettings({ ...source, hostname: 'renamed.example.test' })).toEqual({ ...source, hostname: 'renamed.example.test' })
    expect(await store.getServerSettings()).not.toHaveProperty('defaultSite')
  })
  it('preserves the current policy when a legacy settings caller omits the field', async () => {
    const store = await fixture(), policy = { response: 'redirect' as const, redirectTo: 'https://landing.example.test/', refuseHttps: true }
    await store.saveServerSettings({ ...settings(), defaultSite: policy })
    const updated = await store.saveServerSettings({ ...settings(), adminEmail: 'updated@example.test' })
    expect(updated).toEqual({ ...settings(), adminEmail: 'updated@example.test', defaultSite: policy })
    expect((await store.getServerSettings())!.defaultSite).toEqual(policy)
  })
  it('changes a policy only through an explicit normalized policy rather than omission', async () => {
    const store = await fixture()
    await store.saveServerSettings({ ...settings(), defaultSite: { response: 'redirect', redirectTo: 'https://landing.example.test/', refuseHttps: true } })
    const reset = { response: 'reject' as const, redirectTo: null, refuseHttps: false }
    expect((await store.saveServerSettings({ ...settings(), defaultSite: reset }, { settingsGuard: async () => {} })).defaultSite).toEqual(reset)
  })
  it('preserves a newly committed policy when an omission save is queued behind its writer lease', async () => {
    const store = await fixture(), oldPolicy = { response: 'redirect' as const, redirectTo: 'https://old.example.test/', refuseHttps: false }, nextPolicy = { response: 'redirect' as const, redirectTo: 'https://new.example.test/', refuseHttps: true }
    await store.saveServerSettings({ ...settings(), defaultSite: oldPolicy })
    let entered!: () => void, release!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const writing = store.saveServerSettings({ ...settings(), defaultSite: nextPolicy }, { settingsGuard: async () => { entered(); await gate } })
    await inside
    const legacy = store.saveServerSettings({ ...settings(), hostname: 'legacy-rename.example.test' })
    release()
    await writing
    expect((await legacy).defaultSite).toEqual(nextPolicy)
    expect(await store.getServerSettings()).toEqual({ ...settings(), hostname: 'legacy-rename.example.test', defaultSite: nextPolicy })
  })
})
