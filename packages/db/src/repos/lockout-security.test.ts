import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createDb, createTestDb, type DbHandle } from '../client.ts'
import { migrate } from '../migrate.ts'
import * as lockouts from './lockouts.ts'

const handles: DbHandle[] = []
const directories: string[] = []
const epoch = Date.parse('2026-10-22T10:00:00.000Z')
const at = (milliseconds = 0): string => new Date(epoch + milliseconds).toISOString()
const policy = { threshold: 3, windowMs: 10_000, lockoutDurationMs: 1_000 }
const exec = promisify(execFile)

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const setup = async () => {
  const handle = await createTestDb()
  handles.push(handle)
  return handle
}

const failLogin = (handle: DbHandle, input: Partial<Parameters<typeof lockouts.recordLoginFailure>[1]> = {}) =>
  lockouts.recordLoginFailure(handle.db, { username: 'root', ip: '198.51.100.1', now: at(), ...policy, ...input })

describe('persistent username and source-IP login throttling', () => {
  it('aggregates a username across source addresses and normalizes its case', async () => {
    const handle = await setup()
    await failLogin(handle, { username: 'ROOT', ip: '198.51.100.1' })
    await failLogin(handle, { username: 'Root', ip: '198.51.100.2', now: at(1) })
    const result = await failLogin(handle, { ip: '198.51.100.3', now: at(2) })
    expect(result).toEqual({ usernameFailures: 3, ipFailures: 1, lockedUntil: at(1_002) })
    expect((await lockouts.checkLockout(handle.db, { username: 'ROOT' }, at(2)))?.username).toBe('root')
    expect(await lockouts.checkLockout(handle.db, { ip: '198.51.100.3' }, at(2))).toBeNull()
  })

  it('aggregates username spraying by one source IP', async () => {
    const handle = await setup()
    await failLogin(handle, { username: 'alice' })
    await failLogin(handle, { username: 'bob', now: at(1) })
    const result = await failLogin(handle, { username: 'carol', now: at(2) })
    expect(result).toEqual({ usernameFailures: 1, ipFailures: 3, lockedUntil: at(1_002) })
    expect((await lockouts.checkLockout(handle.db, { ip: '198.51.100.1' }, at(2)))?.ip).toBe('198.51.100.1')
    expect(await lockouts.checkLockout(handle.db, { username: 'carol' }, at(2))).toBeNull()
  })

  it('keeps both counters after closing and reopening a file database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xpanel-login-counters-'))
    directories.push(directory)
    const path = join(directory, 'control.db')
    let handle = createDb(path)
    handles.push(handle)
    await migrate(handle.runner)
    await failLogin(handle)
    await handle.close()
    handle = createDb(path)
    handles.push(handle)
    await failLogin(handle, { now: at(1) })
    expect((await failLogin(handle, { now: at(2) })).lockedUntil).toBe(at(1_002))
  })

  it('records exactly one attempt per failure and loses no concurrent increments', async () => {
    const handle = await setup()
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => failLogin(handle, { threshold: 100, now: at(index) })))
    expect(results.map((result) => result.usernameFailures).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1))
    expect(results.every((result) => result.ipFailures === result.usernameFailures)).toBe(true)
    expect((await handle.query<{ count: number }>('SELECT count(*) AS count FROM login_attempts'))[0]?.count).toBe(16)
  })

  it('preserves the same counters across independent concurrent Node processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xpanel-login-processes-'))
    directories.push(directory)
    const path = join(directory, 'control.db')
    const handle = createDb(path)
    handles.push(handle)
    await migrate(handle.runner)
    const clientUrl = new URL('../client.ts', import.meta.url).href
    const repoUrl = new URL('./lockouts.ts', import.meta.url).href
    const source = `import {createDb} from ${JSON.stringify(clientUrl)}; import {recordLoginFailure} from ${JSON.stringify(repoUrl)}; const h=createDb(process.argv[1]); try { await recordLoginFailure(h.db,{username:'root',ip:'198.51.100.1',threshold:100,windowMs:10000,lockoutDurationMs:1000,now:${JSON.stringify(at())}}); } finally { await h.close(); }`
    const children = await Promise.allSettled(Array.from({ length: 4 }, () => exec(process.execPath, ['--input-type=module', '-e', source, path], { timeout: 15_000, windowsHide: true })))
    expect(children.map((child) => child.status)).toEqual(Array(4).fill('fulfilled'))
    const result = await failLogin(handle, { threshold: 100, now: at(1) })
    expect(result.usernameFailures).toBe(5)
    expect(result.ipFailures).toBe(5)
  })

  it('resets an expired observation window without creating a lock', async () => {
    const handle = await setup()
    await failLogin(handle)
    await failLogin(handle, { now: at(1) })
    expect(await failLogin(handle, { now: at(10_000) })).toEqual({ usernameFailures: 1, ipFailures: 1, lockedUntil: null })
    expect(await lockouts.listLockouts(handle.db, at(10_000))).toEqual([])
  })

  it('starts a new counter after a lock expires even inside the old observation window', async () => {
    const handle = await setup()
    await failLogin(handle, { threshold: 2 })
    expect((await failLogin(handle, { threshold: 2, now: at(1) })).lockedUntil).toBe(at(1_001))
    expect(await failLogin(handle, { threshold: 2, now: at(1_001) })).toEqual({ usernameFailures: 1, ipFailures: 1, lockedUntil: null })
  })

  it('does not extend an active lock for in-flight failures that finish after the threshold', async () => {
    const handle = await setup()
    await failLogin(handle, { threshold: 2 })
    const locked = await failLogin(handle, { threshold: 2, now: at(1) })
    const later = await failLogin(handle, { threshold: 2, now: at(500) })
    expect(later).toEqual(locked)
    expect((await handle.query<{ count: number }>('SELECT count(*) AS count FROM login_attempts'))[0]?.count).toBe(3)
  })

  it('clears the successful username counter while retaining the IP aggregate and failure history', async () => {
    const handle = await setup()
    await failLogin(handle, { username: 'alice' })
    await failLogin(handle, { username: 'bob', now: at(1) })
    await lockouts.recordLoginAttempt(handle.db, { username: 'alice', ip: '198.51.100.1', success: true })
    await lockouts.clearLockout(handle.db, { username: 'alice' })
    const result = await failLogin(handle, { username: 'alice', now: at(2) })
    expect(result).toEqual({ usernameFailures: 1, ipFailures: 3, lockedUntil: at(1_002) })
    const rows = await handle.query<{ success: number }>('SELECT success FROM login_attempts ORDER BY id')
    expect(rows.map((row) => row.success)).toEqual([0, 0, 1, 0])
  })

  it('lets an explicit administrator clear an IP counter without clearing other subjects', async () => {
    const handle = await setup()
    await failLogin(handle)
    await lockouts.clearLockout(handle.db, { ip: '198.51.100.1' })
    expect(await failLogin(handle, { now: at(1) })).toEqual({ usernameFailures: 2, ipFailures: 1, lockedUntil: null })
  })

  it('rejects invalid policy or identity without recording a partial failure', async () => {
    const handle = await setup()
    for (const input of [{ threshold: 0 }, { windowMs: 0 }, { lockoutDurationMs: -1 }, { ip: 'not-an-ip' }, { username: ' ' }, { now: 'invalid' }]) {
      await expect(failLogin(handle, input)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect((await handle.query<{ count: number }>('SELECT count(*) AS count FROM login_attempts'))[0]?.count).toBe(0)
  })

  it('rolls back the attempt, both counters and a new lock if the second counter write fails', async () => {
    const handle = await setup()
    await handle.db.exec(`CREATE TRIGGER deny_ip_counter BEFORE INSERT ON login_failure_counters
      WHEN NEW.subject_kind = 'ip' BEGIN SELECT RAISE(ABORT, 'counter unavailable'); END;`)
    await expect(failLogin(handle, { threshold: 1 })).rejects.toThrow()
    for (const table of ['login_attempts', 'login_failure_counters', 'lockouts']) {
      expect((await handle.query<{ count: number }>(`SELECT count(*) AS count FROM ${table}`))[0]?.count).toBe(0)
    }
  })

  it('normalizes IPv4-mapped IPv6 and expanded IPv6 forms into the same source-IP lockout counter', async () => {
    const handle = await setup()
    await failLogin(handle, { username: 'alice', ip: '198.51.100.44', now: at(0) })
    await failLogin(handle, { username: 'bob', ip: '::ffff:198.51.100.44', now: at(1) })
    const mappedResult = await failLogin(handle, { username: 'carol', ip: '0:0:0:0:0:ffff:c633:642c', now: at(2) })
    expect(mappedResult).toEqual({ usernameFailures: 1, ipFailures: 3, lockedUntil: at(1_002) })
    expect((await lockouts.checkLockout(handle.db, { ip: '::ffff:c633:642c' }, at(2)))?.ip).toBe('198.51.100.44')

    await failLogin(handle, { username: 'dave', ip: '2001:0db8:0000:0000:0000:0000:0000:0001', threshold: 2, now: at(3) })
    const v6Result = await failLogin(handle, { username: 'erin', ip: '2001:db8::1', threshold: 2, now: at(4) })
    expect(v6Result).toEqual({ usernameFailures: 1, ipFailures: 2, lockedUntil: at(1_004) })
    expect((await lockouts.checkLockout(handle.db, { ip: '2001:0db8::0001' }, at(4)))?.ip).toBe('2001:db8::1')
  })

  it('returns the longest active lockout across username and IP and clears both when requested together', async () => {
    const handle = await setup()
    await lockouts.upsertLockout(handle.db, { username: 'alice', failures: 3, reason: 'user_lock', lockedUntil: at(1_000) })
    await lockouts.upsertLockout(handle.db, { ip: '198.51.100.77', failures: 5, reason: 'ip_lock', lockedUntil: at(5_000) })
    const active = await lockouts.checkLockout(handle.db, { username: 'alice', ip: '::ffff:198.51.100.77' }, at(100))
    expect(active?.lockedUntil).toBe(at(5_000))
    expect(active?.ip).toBe('198.51.100.77')

    const cleared = await lockouts.clearLockout(handle.db, { username: 'alice', ip: '::ffff:198.51.100.77' })
    expect(cleared).toBe(2)
    expect(await lockouts.checkLockout(handle.db, { username: 'alice', ip: '198.51.100.77' }, at(100))).toBeNull()
  })
})
