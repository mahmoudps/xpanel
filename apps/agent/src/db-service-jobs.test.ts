import { describe, expect, it, vi } from 'vitest'
import { movePostgresqlData, parseAptVersions, parseDnfStreams, parseDnfVersions, switchPostgresqlVersion, switchRedisVersion } from './db-service-jobs.ts'
import { importMongodbArchive } from './db-mongodb-service.ts'
import type { DbServiceContext, DbServiceFs } from './db-service-files.ts'
import type { HostJobCommandStep, HostJobPlan, HostJobStepResult } from './host-job-contract.ts'
import type { RedisClient, RespValue } from './redis-client.ts'

const POLICY = `redis-server:
  Installed: 5:6.0.16-1ubuntu1
  Candidate: 5:6.0.16-1ubuntu1.1
  Version table:
     5:6.0.16-1ubuntu1.1 500
        500 http://archive.ubuntu.com/ubuntu jammy-updates/universe amd64 Packages
 *** 5:6.0.16-1ubuntu1 500
        500 http://archive.ubuntu.com/ubuntu jammy/universe amd64 Packages
        100 /var/lib/dpkg/status
`
const PG_FILES = '/etc/postgresql/14/main/postgresql.conf\t/etc/postgresql/14/main/pg_hba.conf\t/var/lib/postgresql/14/main\t140013\t\n'
interface Host { files: Map<string, string>; argv: string[][]; version: string; keys: number; major: number; data: string; failInstall: boolean }
function host(overrides: Partial<Host> = {}, packages = 'redis-server\t5:6.0.16-1ubuntu1\tinstall ok installed\npostgresql-14\t14.13-1\tinstall ok installed\n') {
  const state: Host = { files: new Map([['/etc/redis/redis.conf', 'port 6379\n'], ['/etc/postgresql/14/main/postgresql.conf', 'port = 5432\n'], ['/etc/postgresql/14/main/start.conf', 'auto\n']]), argv: [], version: '5:6.0.16-1ubuntu1', keys: 2, major: 14, data: '/var/lib/postgresql/14/main', failInstall: false, ...overrides }
  const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' })
  const run = async (argv: readonly string[]) => {
    state.argv.push([...argv])
    const sql = String(argv.at(-1))
    if (argv[0] === '/usr/bin/dpkg-query') return ok(packages.replace('5:6.0.16-1ubuntu1', state.version))
    if (argv[1] === 'show') return ok(`Id=${String(argv.at(-1))}\nNames=${String(argv.at(-1))}\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n`)
    if (argv[0] === '/usr/bin/apt-cache') return ok(argv.includes('redis-server') ? POLICY : 'postgresql-14:\n  Version table:\n *** 14.13-1 500\n        500 http://a jammy/main amd64 Packages\npostgresql-16:\n  Version table:\n     16.4-1 500\n        500 http://apt.postgresql.org/pub jammy-pgdg/main amd64 Packages\n')
    if (argv[0] === '/usr/bin/du') return ok('1024\t/x\n')
    if (sql.includes('config_file')) return ok(PG_FILES.replace('/var/lib/postgresql/14/main', state.data).replace('140013', `${state.major}0013`))
    if (sql.includes('pg_database')) return ok('alice_shop\npostgres\n')
    return ok()
  }
  const stepRun = async (item: HostJobCommandStep) => {
    state.argv.push([...item.argv])
    if (item.argv.join(' ').startsWith('/usr/bin/apt-get install -y -q --allow-downgrades')) {
      if (state.failInstall) return { ok: false, code: 100, stdout: '', stderr: '', timedOut: false }
      state.version = String(item.argv.at(-1)).split('=')[1]!
    }
    return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false }
  }
  const redis: RedisClient = { close: () => undefined, command: async (...args): Promise<RespValue> => {
    if (args[0] === 'INFO') return `db0:keys=${state.keys},expires=0,avg_ttl=0\r\n`
    if (args[0] === 'CONFIG') return [args[2]!, args[2] === 'dir' ? '/var/lib/redis' : 'dump.rdb']
    if (args[0] === 'LASTSAVE') return ++saves
    return args[0] === 'PING' ? 'PONG' : 'OK'
  } }
  let saves = 0
  const fs: DbServiceFs = { stat: async path => /\/srv\/(?:pg|exists)$/.test(path) ? (path.endsWith('exists') ? { uid: 0, gid: 0, mode: 0o755 } : null) : { uid: 0, gid: 0, mode: 0o755 }, list: async () => [{ name: 'redis-20261107T101010Z.rdb', sizeBytes: 9, modifiedAt: '2026-11-07T10:10:10.000Z' }], tail: async () => null, freeKb: async () => 1_000_000, gunzipHead: async () => Buffer.from([0x6d, 0xe2, 0x99, 0x81]), adopt: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }
  const plans: HostJobPlan[] = []
  const ctx: DbServiceContext = { family: 'debian', run, readFile: async path => state.files.get(path) ?? null, host: { readFile: async path => state.files.get(path) ?? null, writeFile: async file => { state.files.set(file.path, file.content) } }, fs, runPostgresql: null,
    submitJob: async plan => { plans.push(plan); return { id: 'job', kind: plan.kind } as never }, stateRoot: '/state', connectRedis: async () => redis, connectMongo: async () => { throw new Error('none') }, sleep: async () => undefined, now: () => new Date('2026-11-07T10:10:10.000Z'), assertFresh: async () => 'root' }
  /** Runs a plan the way the job runner does: steps until one fails, then verify, then finalize. */
  const runPlan = async (plan: HostJobPlan) => {
    const results: HostJobStepResult[] = []
    let failed = false
    for (const item of plan.steps) {
      expect(plan.policy(item.argv), item.id).toBe(true)
      await plan.beforeStep?.(item)
      const result = await stepRun(item)
      results.push({ id: item.id, result })
      if (!result.ok) { failed = true; break }
    }
    const verified = failed ? null : await plan.verify!(stepRun as never)
    const final = await plan.finalize!(item => { expect(plan.policy(item.argv), item.id).toBe(true); return stepRun(item) }, results)
    return { failed, verified, final }
  }
  return { state, ctx, plans, runPlan, fs }
}

describe('repository version lists', () => {
  it('counts a version only when a repository holds it', () => {
    expect(parseAptVersions(POLICY).get('redis-server')).toEqual(['5:6.0.16-1ubuntu1.1', '5:6.0.16-1ubuntu1'])
    expect(parseAptVersions('redis-server:\n  Version table:\n *** 5:7.0 100\n        100 /var/lib/dpkg/status\n').get('redis-server')).toEqual([])
  })
  it('reads dnf lists and module streams', () => {
    expect(parseDnfVersions('Available Packages\nredis.x86_64   6.2.7-1.el9   appstream\nredis.x86_64 7.2.5-1.el9 remi\nredis-devel.x86_64 7.2.5-1.el9 remi\n', 'redis')).toEqual(['6.2.7-1.el9', '7.2.5-1.el9'])
    expect(parseDnfStreams('Name Stream Profiles Summary\npostgresql 15 client, server PostgreSQL\npostgresql 16 client, server\n')).toEqual([15, 16])
  })
})

describe('Redis version switch', () => {
  const target = '5:6.0.16-1ubuntu1.1'
  it('backs up, proves it, downloads both versions and only then touches the service', async () => {
    const { ctx, plans, runPlan, state } = host()
    await switchRedisVersion(ctx, { version: target })
    expect(plans[0]!.steps.map(item => item.id)).toEqual(['verify-backup', 'fetch-target', 'fetch-rollback', 'stop', 'keep-data', 'verify-data', 'install', 'start'])
    expect(await runPlan(plans[0]!)).toMatchObject({ failed: false, verified: { ok: true }, final: { ok: true, detail: { version: target } } })
    expect(state.version).toBe(target)
  })
  it('puts the version and the data back when a key is missing afterwards', async () => {
    const { ctx, plans, runPlan, state } = host()
    await switchRedisVersion(ctx, { version: target })
    const plan = plans[0]!, verify = plan.verify!
    plan.verify = async run => { const before = state.keys; state.keys = 0; const result = await verify(run); state.keys = before; return result }
    expect(await runPlan(plan)).toMatchObject({ verified: { ok: false }, final: { ok: true, detail: { rolledBack: true, version: '5:6.0.16-1ubuntu1' } } })
    expect(state.version).toBe('5:6.0.16-1ubuntu1')
    expect(state.argv.some(argv => argv[0] === '/usr/bin/install' && argv.at(-1) === '/var/lib/redis/dump.rdb')).toBe(true)
  })
  it('rolls back a failed install and leaves an early failure alone', async () => {
    const failed = host({ failInstall: true })
    await switchRedisVersion(failed.ctx, { version: target })
    expect((await failed.runPlan(failed.plans[0]!)).final).toMatchObject({ ok: false, detail: { rollback: 'rollback-install' } })
    const early = host()
    await switchRedisVersion(early.ctx, { version: target })
    expect(await early.plans[0]!.finalize!(vi.fn() as never, [{ id: 'verify-backup', result: null }])).toEqual({ ok: true, detail: { changed: false } })
  })
  it('refuses what it could not undo', async () => {
    const { ctx } = host({ files: new Map([['/etc/redis/redis.conf', 'appendonly yes\n']]) })
    await expect(switchRedisVersion(ctx, { version: target })).rejects.toMatchObject({ detail: { reason: 'redis_switch_requires_rdb' } })
    const other = host({ version: '5:7.0.0-1' })
    await expect(switchRedisVersion(other.ctx, { version: target })).rejects.toMatchObject({ detail: { reason: 'redis_rollback_unavailable' } })
    await expect(switchRedisVersion(host().ctx, { version: '9:9' })).rejects.toMatchObject({ detail: { reason: 'redis_version_not_offered' } })
  })
})

describe('PostgreSQL major upgrade', () => {
  it('dumps and proves the dump before the packages change', async () => {
    const { ctx, plans } = host()
    await switchPostgresqlVersion(ctx, { major: 16, confirmation: '16' })
    expect(plans[0]!.steps.map(item => item.id)).toEqual(['prepare-backup', 'backup', 'verify-backup', 'install', 'drop-empty', 'upgrade', 'start'])
    expect(plans[0]!.steps[5]!.argv).toEqual(['/usr/bin/pg_upgradecluster', '-v', '16', '14', 'main'])
  })
  it('restores the old cluster files and removes the new version when the upgrade fails', async () => {
    const { ctx, plans, runPlan, state } = host()
    await switchPostgresqlVersion(ctx, { major: 16, confirmation: '16' })
    state.files.set('/etc/postgresql/14/main/start.conf', 'manual\n')
    const { final, verified } = await runPlan(plans[0]!)
    expect(verified).toMatchObject({ ok: false })
    expect(final).toMatchObject({ ok: true, detail: { rolledBack: true, major: 14 } })
    expect(state.files.get('/etc/postgresql/14/main/start.conf')).toBe('auto\n')
    expect(state.argv.some(argv => argv.join(' ').includes('remove -y -q -- postgresql-16 postgresql-client-16'))).toBe(true)
    expect(state.argv).toContainEqual(['/usr/bin/systemctl', 'start', '--', 'postgresql@14-main.service'])
  })
  it('refuses a version no repository offers, a downgrade and a full disk', async () => {
    await expect(switchPostgresqlVersion(host().ctx, { major: 13, confirmation: '13' })).rejects.toMatchObject({ detail: { reason: 'postgresql_version_not_offered' } })
    await expect(switchPostgresqlVersion(host().ctx, { major: 16, confirmation: '15' })).rejects.toMatchObject({ detail: { reason: 'confirmation_required' } })
    const full = host(); full.fs.freeKb = async () => 10
    await expect(switchPostgresqlVersion(full.ctx, { major: 16, confirmation: '16' })).rejects.toMatchObject({ detail: { reason: 'postgresql_space_short' } })
  })
})

describe('PostgreSQL data move', () => {
  const body = { target: '/srv/pg', confirmation: '/srv/pg' }
  it('copies, compares every file, then points the server and keeps the original', async () => {
    const { ctx, plans, runPlan, state } = host()
    await movePostgresqlData(ctx, body)
    const plan = plans[0]!
    expect(plan.steps.map(item => item.id)).toEqual(['stop', 'copy', 'compare', 'point', 'start'])
    expect(plan.steps[3]!.argv).toEqual(['/usr/bin/pg_conftool', '14', 'main', 'set', 'data_directory', '/srv/pg'])
    state.data = '/srv/pg'
    expect(await runPlan(plan)).toMatchObject({ verified: { ok: true }, final: { ok: true, detail: { previous: '/var/lib/postgresql/14/main' } } })
    expect(state.argv.some(argv => argv[0] === '/usr/bin/rm')).toBe(false)
  })
  it('points back, proves the original and only then removes the copy', async () => {
    const { ctx, plans, runPlan, state } = host()
    await movePostgresqlData(ctx, body)
    expect(await runPlan(plans[0]!)).toMatchObject({ verified: { ok: false }, final: { ok: true, detail: { rolledBack: true } } })
    const commands = state.argv.map(argv => argv.join(' '))
    expect(commands.indexOf('/usr/bin/pg_conftool 14 main set data_directory /var/lib/postgresql/14/main')).toBeGreaterThan(commands.indexOf('/usr/bin/systemctl stop -- postgresql@14-main.service'))
    expect(commands.at(-1)).toBe('/usr/bin/rm -rf -- /srv/pg')
  })
  it('keeps the copy when the original does not answer', async () => {
    const { ctx, plans, runPlan, state } = host()
    await movePostgresqlData(ctx, body)
    state.data = '/elsewhere'
    expect((await runPlan(plans[0]!)).final).toMatchObject({ ok: false, detail: { rolledBack: false } })
    expect(state.argv.some(argv => argv[0] === '/usr/bin/rm')).toBe(false)
  })
  it('refuses unsafe targets', async () => {
    const send = (target: string) => movePostgresqlData(host().ctx, { target, confirmation: target })
    for (const target of ['/etc/x', '/home/alice/pg', '/var/lib/xpanel/pg', '/var/lib/postgresql/14/main/sub', '/srv/../etc', 'relative']) await expect(send(target)).rejects.toMatchObject({ detail: { reason: 'postgresql_target_rejected' } })
    await expect(send('/srv/exists')).rejects.toMatchObject({ detail: { reason: 'postgresql_target_exists' } })
    await expect(movePostgresqlData(host().ctx, { target: '/srv/pg', confirmation: 'x' })).rejects.toMatchObject({ detail: { reason: 'confirmation_required' } })
  })
})

describe('MongoDB import', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const mongo = () => { const made = host({ files: new Map([['/etc/mongod.conf', 'net:\n  port: 27017\n']]) }, 'mongodb-org-server\t7.0.14\tinstall ok installed\n'); return made }
  it('takes a real archive into the backups under a safe name', async () => {
    const { ctx, fs } = mongo()
    fs.list = async () => [{ name: 'upload-20261107T101010Z-shop-dump.archive.gz', sizeBytes: 9, modifiedAt: '' }]
    expect(await importMongodbArchive(ctx, { id, filename: '../shop dump.archive.gz' })).toMatchObject({ name: 'upload-20261107T101010Z-shop-dump.archive.gz' })
    expect(fs.adopt).toHaveBeenCalledWith(`/state/extended/transfers/mongodb/${id}.archive.gz`, '/var/backups/xpanel/mongodb/upload-20261107T101010Z-shop-dump.archive.gz')
  })
  it('refuses and removes anything that is not a mongodump archive', async () => {
    const { ctx, fs } = mongo()
    fs.gunzipHead = async () => Buffer.from('nope')
    await expect(importMongodbArchive(ctx, { id, filename: 'x.gz' })).rejects.toMatchObject({ detail: { reason: 'mongodb_archive_rejected' } })
    expect(fs.remove).toHaveBeenCalledOnce()
    expect(fs.adopt).not.toHaveBeenCalled()
    await expect(importMongodbArchive(ctx, { id: '../x', filename: 'x.gz' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
