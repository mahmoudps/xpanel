import { describe, expect, it, vi } from 'vitest'
import { assertBindAddresses } from './db-mongodb-service.ts'
import { assertPostgresqlSettings } from './db-postgresql-service.ts'
import { exactBody, hideSecrets, logLines, redisPassword, restoreSecrets, setMongodValue, setRedisDirectives, withFileRollback } from './db-service-files.ts'
import type { DbServiceFs, DbServiceHost } from './db-service-files.ts'

const SECRET = 's3cret-Value-1'
const host = (text: string | null) => { const state = { text, writes: [] as string[] }; const api: DbServiceHost = { readFile: async () => state.text, writeFile: async file => { state.text = file.content; state.writes.push(file.content) } }; return { state, api } }
const fs: DbServiceFs = { stat: async () => ({ uid: 0, gid: 0, mode: 0o640 }), list: async () => [], tail: async () => null, freeKb: async () => null, gunzipHead: async () => null, adopt: async () => undefined, remove: async () => undefined }

describe('redis.conf editing', () => {
  it('replaces every active line of a keyword and keeps comments and other lines', () => {
    const text = '# port 1\nport 6379\nbind 127.0.0.1 ::1\nsave 900 1\nsave 300 10\ndatabases 16\n'
    const next = setRedisDirectives(text, { port: ['6380'], save: ['""'] })
    expect(next).toBe('# port 1\nbind 127.0.0.1 ::1\ndatabases 16\nport 6380\nsave ""\n')
  })
  it('hides secrets, refuses a changed secret line and restores the real value', () => {
    const text = `port 6379\nrequirepass ${SECRET}\nmasterauth other-secret\n`, hidden = hideSecrets('redis', text)
    expect(hidden).not.toContain(SECRET)
    expect(hidden).not.toContain('other-secret')
    expect(restoreSecrets('redis', hidden.replace('6379', '6380'), text)).toBe(`port 6380\nrequirepass ${SECRET}\nmasterauth other-secret\n`)
    expect(() => restoreSecrets('redis', hidden.replace('requirepass <hidden by xPanel>', 'requirepass x'), text)).toThrow()
    expect(() => restoreSecrets('redis', hidden.replace('masterauth <hidden by xPanel>\n', ''), text)).toThrow()
  })
  it('hides credentials in the MongoDB and PostgreSQL files too', () => {
    const mongo = `net:\n  tls:\n    certificateKeyFilePassword: ${SECRET}\n`, hidden = hideSecrets('mongodb', mongo)
    expect(hidden).not.toContain(SECRET)
    expect(restoreSecrets('mongodb', hidden, mongo)).toBe(mongo)
    const pg = `port = 5432\nprimary_conninfo = 'password=${SECRET}'\n`
    expect(hideSecrets('postgresql', pg)).not.toContain(SECRET)
    expect(restoreSecrets('postgresql', hideSecrets('postgresql', pg), pg)).toBe(pg)
  })
  it('reads the last password and treats an empty one as unset', () => {
    expect(redisPassword(`requirepass a\nrequirepass "${SECRET}"\n`)).toBe(SECRET)
    expect(redisPassword('requirepass ""\n')).toBeNull()
    expect(redisPassword('# requirepass x\n')).toBeNull()
  })
})

describe('mongod.conf editing', () => {
  const text = '# mongod.conf\nstorage:\n  dbPath: /var/lib/mongodb\n\n# network interfaces\nnet:\n  port: 27017\n  bindIp: 127.0.0.1  # keep\n\nprocessManagement:\n  timeZoneInfo: /usr/share/zoneinfo\n'
  it('changes one value in its block and keeps the rest', () => {
    const next = setMongodValue(text, 'net', 'bindIp', '127.0.0.1,10.0.0.5')
    expect(next).toContain('  bindIp: 127.0.0.1,10.0.0.5\n')
    expect(next).toContain('# network interfaces\n')
    expect(next).toContain('dbPath: /var/lib/mongodb')
  })
  it('adds a key to a block and a block to the file', () => {
    expect(setMongodValue(text, 'net', 'ipv6', 'true')).toContain('net:\n  ipv6: true\n  port: 27017')
    expect(setMongodValue(text, 'security', 'authorization', 'enabled').endsWith('security:\n  authorization: enabled\n')).toBe(true)
  })
  it('requires loopback in the listen addresses', () => {
    expect(assertBindAddresses('127.0.0.1, 10.0.0.5')).toBe('127.0.0.1,10.0.0.5')
    expect(() => assertBindAddresses('10.0.0.5')).toThrow()
    expect(() => assertBindAddresses('127.0.0.1,example.test')).toThrow()
  })
})

describe('verified file change', () => {
  it('keeps a change the daemon accepts', async () => {
    const { state, api } = host('old'), activate = vi.fn(async () => undefined)
    await withFileRollback({ host: api, fs, path: '/x', reason: 'test', change: async () => { state.text = 'new' }, activate, verify: async () => true })
    expect(state.text).toBe('new')
    expect(activate).toHaveBeenCalledTimes(1)
  })
  it('restores the file, activates it again and says so when the daemon refuses', async () => {
    const { state, api } = host('old')
    let answers = false
    const activate = vi.fn(async () => { if (state.text === 'old') answers = true })
    await expect(withFileRollback({ host: api, fs, path: '/x', reason: 'test', change: async () => { state.text = 'bad' }, activate, verify: async () => answers })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { stateChanged: false, restored: true, reason: 'test_rejected' } })
    expect(state.text).toBe('old')
    expect(activate).toHaveBeenCalledTimes(2)
  })
  it('stops before activation on a failed check', async () => {
    const { state, api } = host('old')
    const activate = vi.fn(async () => undefined)
    await expect(withFileRollback({ host: api, fs, path: '/x', reason: 'test', change: async () => { state.text = 'bad' }, check: async () => 'line 3: invalid', activate, verify: async () => true })).rejects.toThrow('line 3: invalid')
    expect(state.text).toBe('old')
    expect(activate).toHaveBeenCalledTimes(1)
  })
  it('reports an unknown outcome when the old state does not return', async () => {
    const { state, api } = host('old')
    await expect(withFileRollback({ host: api, fs, path: '/x', reason: 'test', change: async () => { state.text = 'bad' }, activate: async () => undefined, verify: async () => false })).rejects.toMatchObject({ detail: { unknownOutcome: true, verificationRequired: true, reason: 'test_restore_failed' } })
  })
  it('changes nothing when the file cannot be read', async () => {
    const { api } = host(null), change = vi.fn(async () => undefined)
    await expect(withFileRollback({ host: api, fs, path: '/x', reason: 'test', change, activate: async () => undefined, verify: async () => true })).rejects.toMatchObject({ detail: { stateChanged: false, reason: 'test_config_unread' } })
    expect(change).not.toHaveBeenCalled()
  })
})

describe('input checks', () => {
  it('builds ALTER SYSTEM only from checked values', () => {
    const body = { port: 5433, maxConnections: 50, sharedBuffers: '128MB', workMem: '4MB', maintenanceWorkMem: '32MB', effectiveCacheSize: '256MB', logMinDurationMs: 500 }
    expect(assertPostgresqlSettings(body)).toContain("ALTER SYSTEM SET shared_buffers = '128MB';")
    expect(assertPostgresqlSettings(body)).toContain('ALTER SYSTEM SET port = 5433;')
    expect(() => assertPostgresqlSettings({ ...body, sharedBuffers: "1MB'; DROP ROLE x; --" })).toThrow()
    expect(() => assertPostgresqlSettings({ ...body, port: 80 })).toThrow()
    expect(() => assertPostgresqlSettings({ ...body, extra: 1 })).toThrow()
  })
  it('accepts exact bodies only', () => {
    expect(() => exactBody({ a: 1, b: 2 }, ['a'])).toThrow()
    expect(() => exactBody([], [])).toThrow()
    expect(exactBody({ a: 1 }, ['a'])).toEqual({ a: 1 })
  })
  it('strips credentials and control characters from log lines', () => {
    const lines = logLines(`ok\nALTER ROLE x PASSWORD 'hunter2'\nrole SCRAM-SHA-256$4096:abc\n{"pwd":"hunter3"}\nbell\u0007\n`)
    expect(lines.join('\n')).not.toMatch(/hunter|abc|\u0007/)
    expect(lines).toHaveLength(5)
    expect(logLines(null)).toEqual([])
  })
})
