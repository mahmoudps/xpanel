// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderDbQuotaCard, renderDbServiceCards, renderPmaAccessCard } from './board-port/whm-db-services-workspace.ts'
import { WHM_DB_SERVICES_CLIENT_BINDING, dbServiceBytes, dbServicePgSize, dbServiceRedisMb } from './whm-db-services-client.ts'

const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const boot = (request: Send, ask = vi.fn(async () => true)) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function(`return (${WHM_DB_SERVICES_CLIENT_BINDING})`)()(ask); return ask }
const el = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const named = <T extends HTMLElement>(name: string) => [...document.querySelectorAll<T>('[data-dbs-field]')].find(node => node.dataset.dbsField === name)!
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; (globalThis as { xpT?: unknown }).xpT = (message: string, values?: Record<string, string>) => Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{${key}}`, value), message) })

const redisView = { engine: 'redis', installed: true, service: { unit: 'redis-server.service', active: 'active', enabled: 'enabled' }, config: { facts: { port: 6379, maxmemory: '64mb', maxmemoryPolicy: 'allkeys-lru', appendOnly: 'no', bind: ['127.0.0.1'] } }, runtime: { state: 'read', version: '7.0.15', usedMemory: 2097152, connectedClients: 2, databases: 16, maxclients: 500, snapshots: false, keyspace: [{ db: 1, keys: 4, expires: 0 }] }, passwordConfigured: false, backups: [{ name: 'redis-20261107T101010Z.rdb', sizeBytes: 1048576, modifiedAt: '2026-11-07T10:10:10.000Z' }] }

describe('sizes', () => {
  it('shows MiB and GiB with ASCII digits', () => {
    expect(dbServiceBytes(1048576)).toBe('1.0 MiB')
    expect(dbServiceBytes(2147483648)).toBe('2.0 GiB')
    expect(dbServiceBytes(null)).toBe('0.0 MiB')
    expect(dbServiceBytes('x')).toBe('—')
  })
  it('keeps a Redis memory limit in any unit', () => {
    expect(dbServiceRedisMb('64mb')).toBe(64)
    expect(dbServiceRedisMb('1gb')).toBe(1024)
    expect(dbServiceRedisMb('268435456')).toBe(256)
    expect(dbServiceRedisMb('100k')).toBe(1)
    expect(dbServiceRedisMb(null)).toBe(0)
    expect(dbServiceRedisMb('0')).toBe(0)
  })
  it('turns pg_settings values back into form text', () => {
    expect(dbServicePgSize({ value: '16384', unit: '8kB' })).toBe('128MB')
    expect(dbServicePgSize({ value: '4096', unit: 'kB' })).toBe('4MB')
    expect(dbServicePgSize({ value: '1500', unit: 'kB' })).toBe('1500kB')
    expect(dbServicePgSize(undefined)).toBe('')
  })
})

describe('database service client', () => {
  it('stays closed without the verified tool and reads nothing when unavailable', async () => {
    document.body.innerHTML = `<section data-capability-state="unavailable">${renderDbServiceCards('en', 'redis', true)}</section>`
    const send = vi.fn(async () => redisView); boot(send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(el('[data-dbs-status]').dataset.state).toBe('unavailable')
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'redis', false)}</section>`
    boot(send); await tick()
    expect(el('[data-dbs-status]').textContent).toContain('Read-only')
    expect(el<HTMLButtonElement>('[data-dbs-control="restart"]').disabled).toBe(true)
  })
  it('fills facts, settings, the database selector and backups', async () => {
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'redis', true)}</section>`
    boot(async () => redisView); await tick()
    expect(document.querySelector('[data-dbs-fact="state"]')!.textContent).toBe('Running')
    expect(document.querySelector('[data-dbs-fact="usedMemory"]')!.textContent).toBe('2.0 MiB')
    expect(document.querySelector('[data-dbs-fact="password"]')!.textContent).toBe('Not set')
    expect(named<HTMLInputElement>('maxmemoryMb').value).toBe('64')
    expect(named<HTMLSelectElement>('maxmemoryPolicy').value).toBe('allkeys-lru')
    expect(named<HTMLInputElement>('maxclients').value).toBe('500')
    expect(named<HTMLSelectElement>('persistence').value).toBe('none')
    expect(el<HTMLSelectElement>('[data-dbs-keys-db]').options).toHaveLength(16)
    expect(el<HTMLSelectElement>('[data-dbs-keys-db]').options[1]!.textContent).toContain('4 keys')
    expect(el('[data-dbs-rows="backups"]').textContent).toContain('redis-20261107T101010Z.rdb')
    expect(el<HTMLButtonElement>('[data-dbs-keys-more]').hidden).toBe(true)
  })
  it('sends a confirmed restart and shows a stable refusal', async () => {
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'redis', true)}</section>`
    const send = vi.fn<Send>(async (method, path) => { if (method === 'POST' && path.endsWith('/settings')) throw { details: { stateChanged: false, reason: 'redis_remote_requires_password' } }; return redisView })
    const ask = boot(send); await tick()
    el('[data-dbs-control="restart"]').click(); await tick()
    expect(ask).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/databases/services/redis/control', { action: 'restart' })
    named<HTMLInputElement>('remoteAccess').checked = true
    el('[data-dbs-settings-save]').click(); await tick()
    expect(el('[data-dbs-status]').textContent).toContain('Set a password before opening Redis')
    expect(el('[data-dbs-status]').dataset.state).toBe('failed')
  })
  it('does nothing when the confirmation is declined', async () => {
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'redis', true)}</section>`
    const send = vi.fn<Send>(async () => redisView); boot(send, vi.fn(async () => false)); await tick()
    el('[data-dbs-flush-all]').click(); await tick()
    expect(send.mock.calls.some(([method]) => method === 'POST')).toBe(false)
  })
  it('lists keys, saves one with a time to live and pages', async () => {
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'redis', true)}</section>`
    const send = vi.fn<Send>(async (method, path) => path.endsWith('/keys') ? { cursor: '9', keys: [{ key: 'session', type: 'string', length: 3, ttlSeconds: 60, value: 'abc', truncated: false }, { key: null, type: 'binary', length: null, ttlSeconds: null, value: null, truncated: false }] } : method === 'GET' ? redisView : {})
    boot(send); await tick()
    el('[data-dbs-keys-read]').click(); await tick()
    expect(el('[data-dbs-rows="keys"]').textContent).toContain('60 s')
    expect(el('[data-dbs-rows="keys"]').textContent).toContain('(binary name)')
    expect(el<HTMLButtonElement>('[data-dbs-keys-more]').hidden).toBe(false)
    named<HTMLInputElement>('keyName').value = 'k'; named<HTMLTextAreaElement>('keyValue').value = 'v'; named<HTMLInputElement>('ttl').value = '60'
    el('[data-dbs-key-save]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/databases/services/redis/key', { db: 0, key: 'k', value: 'v', ttlSeconds: 60 })
  })
  it('edits a file only after loading it and says when the job only started', async () => {
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'mongodb', true)}</section>`
    const mongo = { engine: 'mongodb', installed: true, service: { active: 'active', enabled: 'enabled' }, config: { facts: { port: 27017, bindIp: '127.0.0.1', authorization: 'disabled', dbPath: '/var/lib/mongodb' } }, runtime: { state: 'read', version: '7.0.14', databases: [{ name: 'admin', sizeBytes: 1, users: [] }, { name: 'shop', sizeBytes: 1048576, users: ['shopper'] }] }, admin: 'absent', backups: [] }
    const send = vi.fn<Send>(async (method, path) => path.endsWith('/config') && method === 'GET' ? { path: '/etc/mongod.conf', text: 'net:\n', revision: 'r1' } : path.endsWith('/backup') ? { job: { id: 'j1' } } : method === 'GET' ? mongo : { saved: true })
    boot(send); await tick()
    expect(el('[data-dbs-rows="databases"]').textContent).toContain('shop')
    expect(el('[data-dbs-rows="databases"]').textContent).not.toContain('admin')
    el('[data-dbs-file-save]').click(); await tick()
    expect(el('[data-dbs-status]').textContent).toContain('Load the file')
    el('[data-dbs-file-load]').click(); await tick()
    el<HTMLTextAreaElement>('[data-dbs-file-text]').value = 'net:\n  port: 1\n'
    el('[data-dbs-file-save]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/databases/services/mongodb/config', { text: 'net:\n  port: 1\n', expectedRevision: 'r1' })
    el('[data-dbs-backup]').click(); await tick()
    expect(el('[data-dbs-status]').textContent).toContain('not complete until the job verifies')
  })
  it('deletes selected databases with their names as the confirmation', async () => {
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'mongodb', true)}</section>`
    const send = vi.fn<Send>(async (method) => method === 'GET' ? { engine: 'mongodb', installed: true, runtime: { state: 'read', databases: [{ name: 'shop', sizeBytes: 1, users: [] }, { name: 'blog', sizeBytes: 1, users: [] }] } } : {})
    boot(send); await tick()
    el('[data-dbs-db-delete]').click(); await tick()
    expect(el('[data-dbs-status]').textContent).toContain('Choose at least one')
    document.querySelectorAll<HTMLInputElement>('[data-dbs-pick]').forEach(box => { box.checked = true })
    el('[data-dbs-db-delete]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/databases/services/mongodb/database-delete', { names: ['shop', 'blog'], confirmation: 'shop,blog' })
  })
  it('closes every control while the engine is not installed', async () => {
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'mongodb', true)}</section>`
    boot(async () => ({ engine: 'mongodb', installed: false, runtime: { state: 'not-read', databases: [] } })); await tick()
    expect(el('[data-dbs-status]').textContent).toContain('not installed')
    expect([...document.querySelectorAll<HTMLButtonElement>('[data-db-service] button')].every(button => button.disabled)).toBe(true)
  })
})

describe('version switch, data move and upload', () => {
  it('offers only other versions and submits a confirmed switch', async () => {
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'redis', true)}</section>`
    const send = vi.fn<Send>(async (method, path) => path.endsWith('/versions') ? { current: '1', available: ['2', '1'] } : path.endsWith('/version') ? { job: { id: 'j' } } : method === 'GET' ? redisView : {})
    const ask = boot(send); await tick()
    expect([...el<HTMLSelectElement>('[data-dbs-version-target]').options].map(option => option.value)).toEqual(['2'])
    el('[data-dbs-version-switch]').click(); await tick()
    expect(ask).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/databases/services/redis/version', { version: '2' })
    expect(el('[data-dbs-status]').textContent).toContain('not complete until the job verifies')
  })
  it('says when no other version is offered and sends nothing', async () => {
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'redis', true)}</section>`
    const send = vi.fn<Send>(async (method, path) => path.endsWith('/versions') ? { current: '1', available: ['1'] } : method === 'GET' ? redisView : {})
    boot(send); await tick()
    el('[data-dbs-version-switch]').click(); await tick()
    expect(el('[data-dbs-status]').textContent).toContain('no other version')
    expect(send.mock.calls.some(([, path]) => path.endsWith('/version'))).toBe(false)
  })
  it('moves the data directory with the path as its confirmation', async () => {
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'postgresql', true)}</section>`
    const send = vi.fn<Send>(async (method, path) => path.endsWith('/versions') ? { current: 14, available: [16] } : method === 'GET' ? { engine: 'postgresql', installed: true } : { job: { id: 'j' } })
    boot(send); await tick()
    el('[data-dbs-version-switch]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/databases/services/postgresql/version', { major: 16, confirmation: '16' })
    named<HTMLInputElement>('dataTarget').value = ' /srv/pg '
    el('[data-dbs-data-move]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/databases/services/postgresql/data-directory', { target: '/srv/pg', confirmation: '/srv/pg' })
  })
  it('uploads an archive in chunks at their offsets', async () => {
    document.body.innerHTML = `<section>${renderDbServiceCards('en', 'mongodb', true)}</section>`
    const send = vi.fn<Send>(async (method, path) => path.endsWith('/import') ? { id: 'u1', chunkBytes: 2 } : method === 'GET' ? { engine: 'mongodb', installed: true, runtime: { state: 'read', databases: [] } } : { received: 1, complete: false })
    boot(send); await tick()
    el('[data-dbs-import-upload]').click(); await tick()
    expect(el('[data-dbs-status]').textContent).toContain('Choose a file')
    const input = el<HTMLInputElement>('[data-dbs-import-file]'), file = new File(['abc'], 'shop.archive.gz')
    Object.assign(file, { arrayBuffer: undefined }); Object.defineProperty(input, 'files', { value: [Object.assign(file, { slice: (from: number, to: number) => ({ arrayBuffer: async () => new TextEncoder().encode('abc'.slice(from, to)).buffer }) })] })
    el('[data-dbs-import-upload]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/databases/services/mongodb/import', { filename: 'shop.archive.gz', bytes: 3 })
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/databases/services/mongodb/import/u1', { offset: 0, data: btoa('ab') })
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/databases/services/mongodb/import/u1', { offset: 2, data: btoa('c') })
    expect(el('[data-dbs-status]').textContent).toContain('uploaded')
  })
})

describe('database size limit client', () => {
  it('shows limits, saves with the revision and names a blocked database', async () => {
    document.body.innerHTML = `<section>${renderDbQuotaCard('en', true)}</section>`
    const rows = [{ database: 'alice_shop', account: 'alice', sizeBytes: 2097152, limitMb: 1, locked: true }]
    const send = vi.fn<Send>(async () => ({ revision: 'r2', rows })); boot(send); await tick()
    expect(el('[data-db-quota-rows]').textContent).toContain('writes blocked')
    el<HTMLInputElement>('[data-db-quota-limit]').value = '5'
    el('[data-db-quota-save]').click(); await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/databases/quota', { database: 'alice_shop', limitMb: 5, expectedRevision: 'r2' })
    el('[data-db-quota-clear]').click(); await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/databases/quota', { database: 'alice_shop', limitMb: null, expectedRevision: 'r2' })
  })
})

describe('phpMyAdmin access client', () => {
  const view = { revision: 'r1', state: 'read', publicAccess: false, httpPort: 8008, httpsPort: 8009, phpVersion: null, basicAuthUser: null, host: { installed: true, phpVersions: ['8.3'], allowedPorts: null } }
  it('stays closed without the package', async () => {
    document.body.innerHTML = `<section>${renderPmaAccessCard('en', true)}</section>`
    boot(async () => ({ ...view, host: { installed: false, phpVersions: [] } })); await tick()
    expect(el('[data-pma-status]').textContent).toContain('not installed')
    expect(el<HTMLButtonElement>('[data-pma-save]').disabled).toBe(true)
  })
  it('saves the form and reports a host that did not apply it', async () => {
    document.body.innerHTML = `<section>${renderPmaAccessCard('en', true)}</section>`
    const send = vi.fn<Send>(async method => method === 'GET' ? view : { ...view, publicAccess: true, application: { status: 'failed' } }); boot(send); await tick()
    el<HTMLInputElement>('[data-pma-public]').checked = true
    el<HTMLInputElement>('[data-pma-user]').value = 'guard'; el<HTMLInputElement>('[data-pma-password]').value = 'Correct-Horse-9-x'
    el('[data-pma-save]').click(); await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/databases/phpmyadmin-access', { publicAccess: true, httpPort: 8008, httpsPort: 8009, phpVersion: null, basicAuthUser: 'guard', basicAuthPassword: 'Correct-Horse-9-x', expectedRevision: 'r1' })
    expect(el('[data-pma-status]').dataset.state).toBe('uncertain')
  })
})
