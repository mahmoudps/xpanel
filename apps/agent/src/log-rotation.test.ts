import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { FakeHostExecutor } from './executor.ts'
import { archiveName, archivesToRemove, buildLogArchiveCommand, copyFailure, createLogRotation, isLogRotationCommand, NGINX_REOPEN_COMMAND, parseArchiveName, parseLogRotationState, planHeldLogs, type HeldLog, type LogArchive, type LogRotationDeps, type LogRotationState } from './log-rotation.ts'

const ID = '11111111-1111-4111-8111-111111111111'
const account = { id: ID, username: 'alice', uid: 2001, gid: 2001, home: '/home/alice', status: 'active', primaryDomain: 'alice.test' } as Account
const path = edge.nginxAccessLog('alice.test'), copy = path + '.1'
const at = (iso: string) => new Date(iso)
const defaults = { archive: true, removePreviousMonthArchive: false, retentionDays: null }

function harness(input: { files?: Record<string, string>; archives?: LogArchive[]; reopenOk?: boolean; installOk?: boolean; logs?: Account['logs']; retentionDays?: number | null; held?: HeldLog[]; holdFails?: boolean; hold?: { days: number; maxBytes: number }; run?: LogRotationDeps['run'] } = {}) {
  const files = new Map(Object.entries(input.files ?? {}))
  let state: LogRotationState | null = null, clock = '2026-11-06T00:00:00.000Z'
  const archives = [...(input.archives ?? [])], held = [...(input.held ?? [])]
  const commands: string[][] = []
  const deps: LogRotationDeps = {
    readState: async () => ({ accounts: [{ ...account, ...(input.logs ? { logs: input.logs } : {}) }] }),
    readTweaks: async () => ({ defaults: { ...defaults, retentionDays: input.retentionDays ?? null }, panelRotateDays: 14, hold: input.hold ?? { days: 30, maxBytes: 1 << 30 } }),
    hold: vi.fn(async (who: Account, _source: string, name: string) => { if (input.holdFails) throw new Error('not protected'); held.push({ username: who.username, name, sizeBytes: 99, heldAt: clock }); return 99 }),
    listHeld: async () => [...held],
    unhold: vi.fn(async (username: string, name: string) => { const index = held.findIndex(item => item.username === username && item.name === name); if (index >= 0) held.splice(index, 1) }),
    readRotation: async () => state, writeRotation: async value => { state = structuredClone(value) },
    stat: async file => files.has(file) ? { identity: files.get(file)!, sizeBytes: 10 } : null,
    rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from) },
    unlink: async file => { files.delete(file) },
    reopen: vi.fn(async () => { if (input.reopenOk !== false) files.set(path, '1:20'); return { ok: input.reopenOk !== false, code: 0, stdout: '', stderr: '' } }),
    stage: vi.fn(async () => 99), unstage: vi.fn(async () => undefined),
    run: vi.fn(async argv => {
      commands.push(argv)
      const result = input.run ? await input.run(argv) : { ok: input.installOk !== false, code: input.installOk !== false ? 0 : 1, stdout: '', stderr: input.installOk !== false ? '' : 'install: error writing: Disk quota exceeded' }
      if (argv.includes('/usr/bin/install') && result.ok) archives.push({ name: argv.at(-1)!.split('/').at(-1)!, site: 'alice.test', day: '2026-11-05', sizeBytes: 99, mtime: '2026-11-06T00:05:00.000Z' })
      return result
    }),
    listArchives: async () => [...archives],
  }
  return { rotation: createLogRotation(deps), deps, files, commands, state: () => state, archives, held, setClock: (iso: string) => { clock = iso } }
}
const heldLog = (name: string, heldAt: string, sizeBytes = 100, username = 'alice'): HeldLog => ({ username, name, sizeBytes, heldAt })
const collected = (iso: string, identity: string | null) => ({ at: at(iso), sites: [{ path, accountId: ID, site: 'alice.test' }], cursors: identity ? { [path]: { accountId: ID, identity, offset: 10 } } : {} })

describe('raw access log rotation after metering', { tags: ['unit'] }, () => {
  it('rotates once per UTC day, only while the meter follows the file, and verifies that nginx reopened it', async () => {
    const h = harness({ files: { [path]: '1:10' } })
    await h.rotation.run(collected('2026-11-05T10:00:00Z', '1:10'))
    expect(h.files.has(copy)).toBe(false)
    expect(h.state()?.sites[path]).toEqual({ accountId: ID, day: '2026-11-05' })
    await h.rotation.run(collected('2026-11-06T00:05:00Z', '1:99'))
    expect(h.files.has(copy)).toBe(false)
    const run = await h.rotation.run(collected('2026-11-06T00:10:00Z', '1:10'))
    expect(run).toMatchObject({ rotated: 1, failures: 0 })
    expect(h.deps.reopen).toHaveBeenCalledTimes(1)
    expect(h.files.get(copy)).toBe('1:10')
    expect(h.state()?.sites[path]).toEqual({ accountId: ID, day: '2026-11-06', archiveDay: '2026-11-05' })
    // the meter still follows the copy: it is not archived until its last lines are counted
    await h.rotation.run(collected('2026-11-06T00:15:00Z', '1:10'))
    expect(h.files.has(copy)).toBe(true)
  })

  it('puts the file back when nginx did not reopen, so it is never archived while still written', async () => {
    const h = harness({ files: { [path]: '1:10' }, reopenOk: false })
    await h.rotation.run(collected('2026-11-05T10:00:00Z', '1:10'))
    const run = await h.rotation.run(collected('2026-11-06T00:10:00Z', '1:10'))
    expect(run).toMatchObject({ rotated: 0, failures: 1 })
    expect(h.files.get(path)).toBe('1:10')
    expect(h.files.has(copy)).toBe(false)
    const lost = harness({ files: { [copy]: '1:10' } })
    expect(await lost.rotation.run(collected('2026-11-06T00:10:00Z', '1:10'))).toMatchObject({ failures: 1 })
    expect(lost.files.get(path)).toBe('1:10')
    expect((await lost.rotation.status()).failures).toEqual([expect.objectContaining({ username: 'alice', reason: 'reopen_unverified' })])
  })

  it('archives a counted copy as the account into ~/logs, verified by its size, or deletes it when archiving is off', async () => {
    const h = harness({ files: { [path]: '1:20', [copy]: '1:10' }, archives: [{ name: 'alice.test-2026-11-05.gz', site: 'alice.test', day: '2026-11-05', sizeBytes: 1, mtime: '2026-11-05T00:00:00.000Z' }] })
    const run = await h.rotation.run(collected('2026-11-06T00:15:00Z', '1:20'))
    expect(run).toMatchObject({ archived: 1, failures: 0 })
    expect(h.deps.hold).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }), copy, 'alice.test-2026-11-05-2.gz')
    expect(h.deps.stage).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }), 'alice.test-2026-11-05-2.gz')
    expect(h.held).toEqual([])
    expect(h.commands[0]!.slice(-8)).toEqual(['/usr/bin/install', '-D', '-m', '0640', '-T', '--', '/var/lib/xpanel-log-archive/alice/alice.test-2026-11-05-2.gz', '/home/alice/logs/alice.test-2026-11-05-2.gz'])
    expect(h.commands.every(isLogRotationCommand)).toBe(true)
    expect(h.files.has(copy)).toBe(false)
    expect(h.deps.unstage).toHaveBeenCalled()
    // a failed copy is never a deletion: the compressed archive stays held with its reason
    const failed = harness({ files: { [path]: '1:20', [copy]: '1:10' }, installOk: false })
    expect(await failed.rotation.run(collected('2026-11-06T00:15:00Z', '1:20'))).toMatchObject({ archived: 0, failures: 1, held: 1, lost: 0 })
    expect(failed.files.has(copy)).toBe(false)
    expect(failed.held).toEqual([expect.objectContaining({ name: 'alice.test-2026-11-05.gz' })])
    expect((await failed.rotation.status()).pending).toEqual([{ username: 'alice', code: 'archive_pending', count: 1, bytes: 99, oldest: '2026-11-06T00:00:00.000Z', reason: 'archive_quota_exceeded' }])
    // without a protected holding area the rotated copy stays in place
    const unprotected = harness({ files: { [path]: '1:20', [copy]: '1:10' }, holdFails: true })
    expect(await unprotected.rotation.run(collected('2026-11-06T00:15:00Z', '1:20'))).toMatchObject({ failures: 1 })
    expect(unprotected.files.has(copy)).toBe(true)
    const off = harness({ files: { [path]: '1:20', [copy]: '1:10' }, logs: { archive: false, removePreviousMonthArchive: false, retentionDays: null } })
    expect(await off.rotation.run(collected('2026-11-06T00:15:00Z', '1:20'))).toMatchObject({ deleted: 1, archived: 0 })
    expect(off.deps.stage).not.toHaveBeenCalled()
    expect(off.deps.hold).not.toHaveBeenCalled()
  })

  it('purges archives by retention and earlier months once per day, as the account', async () => {
    const day = (d: string): LogArchive => ({ name: archiveName('alice.test', d), site: 'alice.test', day: d, sizeBytes: 1, mtime: d + 'T00:00:00.000Z' })
    const h = harness({ files: { [path]: '1:10' }, archives: [day('2026-10-20'), day('2026-10-31'), day('2026-11-01'), day('2026-11-05')], retentionDays: 5 })
    expect(await h.rotation.run(collected('2026-11-06T00:05:00Z', '1:10'))).toMatchObject({ removedArchives: 2 })
    expect(h.commands[0]!.slice(-5)).toEqual(['/usr/bin/rm', '-f', '--', '/home/alice/logs/alice.test-2026-10-20.gz', '/home/alice/logs/alice.test-2026-10-31.gz'])
    expect(isLogRotationCommand(h.commands[0]!)).toBe(true)
    await h.rotation.run(collected('2026-11-06T00:10:00Z', '1:10'))
    expect(h.commands).toHaveLength(1)
    expect(archivesToRemove([day('2026-10-31'), day('2026-11-01')], { archive: true, removePreviousMonthArchive: true, retentionDays: null }, '2026-11-02')).toEqual([archiveName('alice.test', '2026-10-31')])
    expect(archivesToRemove([day('2026-10-31')], defaults, '2027-01-01')).toEqual([])
  })

  it('admits only its own archive and reopen commands', () => {
    const install = buildLogArchiveCommand(account, { kind: 'install', name: 'alice.test-2026-11-05.gz' })
    expect(isLogRotationCommand(install)).toBe(true)
    expect(isLogRotationCommand([...NGINX_REOPEN_COMMAND])).toBe(true)
    expect(isLogRotationCommand([...install.slice(0, -1), '/home/alice/.ssh/authorized_keys'])).toBe(false)
    expect(isLogRotationCommand([...install.slice(0, -2), '/etc/shadow', install.at(-1)!])).toBe(false)
    expect(isLogRotationCommand(install.map(value => value === 'BindPaths=/home/alice' ? 'BindPaths=/home/bob' : value))).toBe(false)
    expect(isLogRotationCommand(['/usr/bin/systemctl', 'kill', '--signal=KILL', 'nginx.service'])).toBe(false)
    expect(() => buildLogArchiveCommand(account, { kind: 'remove', names: ['../../etc/passwd'] })).toThrow()
    expect(parseArchiveName('shop.alice.test-2026-11-05-3.gz')).toEqual({ site: 'shop.alice.test', day: '2026-11-05' })
    expect(parseArchiveName('alice.test-2026-11-05.log')).toBeNull()
    expect(parseLogRotationState({ sites: { [path]: { accountId: ID, day: 'yesterday' } }, purged: {}, failures: [] }).sites).toEqual({})
  })

  it('plans the holding area: expire past the server hold days, evict oldest first above the byte bound, retry the rest of due accounts', () => {
    const now = new Date('2026-11-30T00:00:00Z')
    const items = [heldLog('a.test-2026-10-01.gz', '2026-10-02T00:00:00.000Z'), heldLog('a.test-2026-11-20.gz', '2026-11-21T00:00:00.000Z', 300),
      heldLog('a.test-2026-11-25.gz', '2026-11-26T00:00:00.000Z', 300), heldLog('b.test-2026-11-28.gz', '2026-11-29T00:00:00.000Z', 300, 'bob')]
    const plan = planHeldLogs(items, { now, holdDays: 30, maxBytes: 650, retry: new Set(['alice']) })
    expect(plan.expire.map(item => item.name)).toEqual(['a.test-2026-10-01.gz'])
    expect(plan.evict.map(item => item.name)).toEqual(['a.test-2026-11-20.gz'])
    expect(plan.retry.map(item => item.name)).toEqual(['a.test-2026-11-25.gz'])
    expect(planHeldLogs(items, { now, holdDays: 365, maxBytes: 1 << 30, retry: new Set() })).toEqual({ retry: [], expire: [], evict: [] })
    expect(copyFailure({ ok: false, code: 1, stdout: '', stderr: 'install: cannot create regular file: No such file or directory' })).toBe('archive_home_unavailable')
    expect(copyFailure({ ok: true, code: 0, stdout: '', stderr: '' })).toBe('archive_unverified')
    expect(copyFailure(null)).toBe('archive_failed')
  })
})

describe('held archives with the fake host executor', { tags: ['feature'] }, () => {
  it('keeps a failed copy, retries it on the next daily run, and reports every expiry or eviction as a loss', async () => {
    const executor = new FakeHostExecutor()
    executor.failCommand('/usr/bin/install', 1, 'install: error writing: Disk quota exceeded')
    const h = harness({ files: { [path]: '1:20', [copy]: '1:10' }, run: argv => executor.runCommand(argv), hold: { days: 2, maxBytes: 150 } })
    expect(await h.rotation.run(collected('2026-11-06T00:15:00Z', '1:20'))).toMatchObject({ archived: 0, held: 1, lost: 0 })
    // the same day does not retry; the next daily run does, and the quota now allows it
    h.setClock('2026-11-06T00:20:00.000Z')
    await h.rotation.run(collected('2026-11-06T00:20:00Z', '1:20'))
    expect(executor.executedCommands.filter(argv => argv.includes('/usr/bin/install'))).toHaveLength(1)
    executor.clearCommandFailures()
    expect(await h.rotation.run(collected('2026-11-07T00:15:00Z', '1:20'))).toMatchObject({ archived: 1, held: 0, lost: 0 })
    expect(h.archives.map(item => item.name)).toEqual(['alice.test-2026-11-05.gz'])
    expect(executor.executedCommands.every(isLogRotationCommand)).toBe(true)
    // a stuck account: the byte bound evicts the oldest at once, the hold days expire the rest, each reported
    executor.failCommand('/usr/bin/install', 1, 'install: error writing: Disk quota exceeded')
    h.held.push(heldLog('alice.test-2026-11-01.gz', '2026-11-02T00:00:00.000Z', 100), heldLog('alice.test-2026-11-06.gz', '2026-11-07T00:00:00.000Z', 100), heldLog('alice.test-2026-11-07.gz', '2026-11-08T00:00:00.000Z', 100))
    const stuck = await h.rotation.run(collected('2026-11-08T00:15:00Z', '1:20'))
    expect(stuck).toMatchObject({ lost: 2, held: 1 })
    expect(h.held.map(item => item.name)).toEqual(['alice.test-2026-11-07.gz'])
    expect((await h.rotation.status()).pending).toEqual([expect.objectContaining({ code: 'archive_pending', count: 1, reason: 'archive_quota_exceeded' })])
    expect(await h.rotation.run(collected('2026-11-10T00:15:00Z', '1:20'))).toMatchObject({ lost: 1, held: 0 })
    expect((await h.rotation.status()).failures.map(failure => failure.reason)).toEqual(expect.arrayContaining(['archive_quota_exceeded', 'held_expired', 'held_evicted']))
    expect((await h.rotation.status()).pending).toEqual([])
  })
})
