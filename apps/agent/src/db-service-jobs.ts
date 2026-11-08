import { createHash } from 'node:crypto'
import { dirname } from 'node:path/posix'
import { fail, msgid } from '@xpanel/core'
import { softwareCenterArgv } from '../../../packages/os/src/software-center-command.ts'
import { DB_RUNUSER, postgresqlQueryArgv } from '../../../packages/os/src/db-engines-command.ts'
import { PG_BACKUP_DIR, PG_DATABASES_SQL, PG_DROP_CLUSTER, PG_MAJORS, PG_UPGRADE_CLUSTER, REDIS_BACKUP_DIR, dbDataSizeArgv, dbServiceControlArgv, dnfModuleArgv, dnfModuleListArgv, dnfVersionListArgv, isPostgresqlDataPath, redisBackupCopyArgv, redisRestoreCopyArgv, versionFetchArgv, versionInstallArgv, versionSpecs } from '../../../packages/os/src/db-services-command.ts'
import type { DbServiceContext } from './db-service-files.ts'
import { exactBody, requireUnit, submitServiceJob } from './db-service-files.ts'
import { backupRedis, pingAfterRestart, redisDataFile, redisFile, withRedis } from './db-redis-service.ts'
import { requirePgFiles } from './db-postgresql-service.ts'
import type { HostJobCommandStep, HostJobPlan, HostJobStepResult, HostJobVerification } from './host-job-contract.ts'

/**
 * Version switches and the PostgreSQL data move. Each one backs up, proves the backup, changes the host and proves the
 * result on the running server. A failed proof runs the plan's rollback, and the job reports what came back.
 * shortcut: the rollback is the job's finalizer, so an agent that dies mid-job leaves the backups for an operator.
 */
const unchanged = { stateChanged: false }
const SHORT = 300_000, LONG = 3_600_000
const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l', APT_LISTCHANGES_FRONTEND: 'none' } as const
const step = (id: string, title: string, argv: readonly string[], timeoutMs = SHORT, extra: Partial<HostJobCommandStep> = {}): HostJobCommandStep => ({ id, title, argv, timeoutMs, mutates: true, ...extra })
const check = (id: string, title: string, argv: readonly string[], timeoutMs = SHORT, extra: Partial<HostJobCommandStep> = {}): HostJobCommandStep => step(id, title, argv, timeoutMs, { ...extra, mutates: false })
const stampOf = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.[0-9]{3}Z$/, 'Z')
const exactPolicy = (steps: readonly HostJobCommandStep[]): HostJobPlan['policy'] => { const allowed = new Set(steps.map(item => JSON.stringify(item.argv))); return argv => allowed.has(JSON.stringify(argv)) }
const attempted = (results: readonly HostJobStepResult[], id: string): boolean => results.some(row => row.id === id)
const revisionOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** apt-cache(8) policy: a version under "Version table:" counts when a line below it names a repository, not only the dpkg status file. */
export function parseAptVersions(stdout: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  let name: string | null = null, version: string | null = null
  for (const line of stdout.split('\n')) {
    const head = /^([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9]+)?:$/.exec(line)
    if (head) { name = head[1]!; version = null; found.set(name, []); continue }
    const row = /^ (?:\*\*\*| {3}) (\S+) [0-9]+$/.exec(line)
    if (row) { version = row[1]!; continue }
    const source = /^ {8}\s*[0-9]+ (\S+)/.exec(line)
    if (source && name && version && source[1] !== '/var/lib/dpkg/status' && !found.get(name)!.includes(version)) found.get(name)!.push(version)
  }
  return found
}
/** dnf(8) list: `name.arch  version  repository`, with headers and blank lines around it. */
export const parseDnfVersions = (stdout: string, name: string): string[] => [...new Set(stdout.split('\n').flatMap(line => { const row = /^(\S+)\.[a-z0-9_]+\s+(\S+)\s+\S+$/.exec(line.trim()); return row?.[1] === name ? [row[2]!] : [] }))]
export const parseDnfStreams = (stdout: string): number[] => [...new Set(stdout.split('\n').flatMap(line => { const row = /^postgresql\s+([0-9]{2})\b/.exec(line); return row ? [Number(row[1])] : [] }))].sort((a, b) => a - b)

const redisPackages = (family: 'debian' | 'rhel', name: string): string[] => family === 'rhel' ? [name] : name.startsWith('valkey') ? ['valkey-server', 'valkey-tools'] : ['redis-server', 'redis-tools']
const family = (ctx: DbServiceContext): 'debian' | 'rhel' => ctx.family ?? fail('PRECONDITION_FAILED', 'this host has no supported package manager', { ...unchanged, reason: 'native_host_required' })
export async function readRedisVersions(ctx: DbServiceContext) {
  const file = await redisFile(ctx), kind = family(ctx), main = redisPackages(kind, file.packageName)[0]!
  const result = await ctx.run(kind === 'debian' ? softwareCenterArgv('apt-cache-policy', [main]) : dnfVersionListArgv(main))
  const available = !result.ok ? [] : kind === 'debian' ? parseAptVersions(result.stdout).get(main) ?? [] : parseDnfVersions(result.stdout, main)
  return { engine: 'redis', package: main, current: file.packageVersion, available, rollback: available.includes(file.packageVersion), revision: revisionOf(available) }
}
const keyCounts = (info: string): { keys: number; expires: number } => {
  const rows = [...info.matchAll(/^db[0-9]+:keys=([0-9]+),expires=([0-9]+)/gm)]
  return { keys: rows.reduce((sum, row) => sum + Number(row[1]), 0), expires: rows.reduce((sum, row) => sum + Number(row[2]), 0) }
}
export async function switchRedisVersion(ctx: DbServiceContext, body: unknown) {
  const { version } = exactBody(body, ['version']), offered = await readRedisVersions(ctx), file = await redisFile(ctx), kind = family(ctx)
  if (typeof version !== 'string' || version === offered.current || !offered.available.includes(version)) return fail('VALIDATION', 'the repositories do not offer this version', { ...unchanged, reason: 'redis_version_not_offered' })
  // Without the current version in a repository, a failed switch could not be undone.
  if (!offered.rollback) return fail('PRECONDITION_FAILED', 'the installed version is no longer in a repository, so a failed switch could not be undone', { ...unchanged, reason: 'redis_rollback_unavailable' })
  if (file.facts?.appendOnly === 'yes') return fail('PRECONDITION_FAILED', 'switch persistence to snapshots first: an append-only file may not load in the other version', { ...unchanged, reason: 'redis_switch_requires_rdb' })
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable; nothing was submitted', { ...unchanged, reason: 'host_jobs_unavailable' })
  const unit = requireUnit(file.unit, 'redis'), names = redisPackages(kind, file.packageName), valkey = file.packageName.startsWith('valkey'), info = await ctx.fs.stat(file.path), source = await withRedis(ctx, file, redisDataFile)
  const backup = await backupRedis(ctx), checker = valkey ? '/usr/bin/valkey-check-rdb' : '/usr/bin/redis-check-rdb', finalName = `redis-${stampOf(new Date(ctx.now().getTime() + 1000))}.rdb`, env = kind === 'debian' ? { env: APT_ENV } : {}
  const install = (target: string): readonly string[] => versionInstallArgv(kind, versionSpecs(kind, names, target))
  const steps = [
    check('verify-backup', msgid('Check the backup file'), [checker, `${REDIS_BACKUP_DIR}/${backup.name}`]),
    check('fetch-target', msgid('Download the new version'), versionFetchArgv(kind, versionSpecs(kind, names, version), false), LONG, env),
    check('fetch-rollback', msgid('Download the current version for a rollback'), versionFetchArgv(kind, versionSpecs(kind, names, offered.current), true), LONG, env),
    step('stop', msgid('Stop the service'), dbServiceControlArgv('stop', unit)),
    step('keep-data', msgid('Keep the final data file'), redisBackupCopyArgv(source, finalName)),
    check('verify-data', msgid('Check the final data file'), [checker, `${REDIS_BACKUP_DIR}/${finalName}`]),
    step('install', msgid('Install the new version'), install(version), LONG, env),
    step('start', msgid('Start the service'), dbServiceControlArgv('start', unit)),
  ]
  const rollback = (name: string) => [
    step('rollback-stop', msgid('Stop the service'), dbServiceControlArgv('stop', unit)),
    step('rollback-install', msgid('Install the previous version'), install(offered.current), LONG, env),
    step('rollback-data', msgid('Put the data file back'), redisRestoreCopyArgv(name, source, valkey ? 'valkey' : 'redis')),
    step('rollback-start', msgid('Start the service'), dbServiceControlArgv('start', unit)),
  ]
  let before = { keys: 0, expires: 0 }, proved = false
  const answers = async (expected: string): Promise<boolean> => {
    const now = await redisFile(ctx).catch(() => null)
    if (!now || now.packageVersion !== expected || !await pingAfterRestart(ctx, now.text, now.facts)) return false
    const after = await withRedis(ctx, now, async redis => keyCounts(String(await redis.command('INFO', 'keyspace'))))
    return after.keys >= before.keys - before.expires
  }
  return submitServiceJob(ctx, {
    kind: 'database.redis.version', summary: `Switch Redis from ${offered.current} to ${version}`, accountId: null, fingerprint: { from: offered.current, to: version }, detail: { from: offered.current, to: version, backup: backup.name },
    steps, policy: exactPolicy([...steps, ...rollback(backup.name), ...rollback(finalName)]),
    beforeStep: async item => {
      await ctx.assertFresh()
      // The last snapshot on disk and the count that proves it comes back.
      if (item.id === 'stop') before = await withRedis(ctx, file, async redis => { await redis.command('SAVE'); return keyCounts(String(await redis.command('INFO', 'keyspace'))) })
    },
    verify: async () => { proved = await answers(version); return { ok: proved, detail: { version, keys: before.keys } } },
    finalize: async (run, results): Promise<HostJobVerification> => {
      if (proved) return { ok: true, detail: { version } }
      if (!attempted(results, 'stop')) return { ok: true, detail: { changed: false } }
      const name = results.find(row => row.id === 'verify-data')?.result?.ok ? finalName : backup.name
      for (const item of rollback(name)) if (!(await run(item)).ok) return { ok: false, detail: { rollback: item.id } }
      if (info) await ctx.host.writeFile({ path: file.path, content: file.text, mode: info.mode, owner: String(info.uid), group: String(info.gid) })
      const back = await answers(offered.current)
      return { ok: back, detail: { rolledBack: back, version: offered.current, data: name } }
    },
  })
}

const majorOf = (versionNum: number): number => Math.floor(versionNum / 10000)
export async function readPostgresqlVersions(ctx: DbServiceContext) {
  const files = await requirePgFiles(ctx), current = majorOf(files.versionNum), kind = family(ctx), names = PG_MAJORS.map(major => `postgresql-${major}`)
  const result = await ctx.run(kind === 'debian' ? softwareCenterArgv('apt-cache-policy', names) : dnfModuleListArgv())
  const offered = !result.ok ? [] : kind === 'debian' ? PG_MAJORS.filter(major => (parseAptVersions(result.stdout).get(`postgresql-${major}`) ?? []).length > 0) : parseDnfStreams(result.stdout)
  return { engine: 'postgresql', current, available: offered.filter(major => major > current) }
}
const databaseNames = async (ctx: DbServiceContext): Promise<string[] | null> => { const result = await ctx.run(postgresqlQueryArgv(PG_DATABASES_SQL)); return result.ok ? result.stdout.split('\n').filter(Boolean) : null }
const dataSizeKb = async (ctx: DbServiceContext, data: string): Promise<number> => {
  const kb = Number(/^([0-9]+)\s/.exec((await ctx.run(dbDataSizeArgv(data))).stdout)?.[1])
  return Number.isSafeInteger(kb) && kb > 0 ? kb : fail('PRECONDITION_FAILED', 'the size of the data directory could not be read', { ...unchanged, reason: 'postgresql_size_unread' })
}
const assertRoom = async (ctx: DbServiceContext, path: string, needKb: number): Promise<void> => {
  const free = await ctx.fs.freeKb(path)
  if (free === null || free < needKb) return fail('PRECONDITION_FAILED', 'there is not enough free disk space', { ...unchanged, reason: 'postgresql_space_short', needKb, freeKb: free })
}
export async function switchPostgresqlVersion(ctx: DbServiceContext, body: unknown) {
  const { major, confirmation } = exactBody(body, ['major', 'confirmation']), offered = await readPostgresqlVersions(ctx), kind = family(ctx)
  if (typeof major !== 'number' || !offered.available.includes(major)) return fail('VALIDATION', 'the repositories do not offer this major version', { ...unchanged, reason: 'postgresql_version_not_offered' })
  if (confirmation !== String(major)) return fail('VALIDATION', 'the confirmation does not match', { ...unchanged, reason: 'confirmation_required' })
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable; nothing was submitted', { ...unchanged, reason: 'host_jobs_unavailable' })
  const files = await requirePgFiles(ctx), old = offered.current, size = await dataSizeKb(ctx, files.data), before = await databaseNames(ctx)
  if (!before) return fail('PRECONDITION_FAILED', 'PostgreSQL must be running for this', { ...unchanged, reason: 'postgresql_not_running' })
  // The dump and a second cluster each need about the size of the first.
  await assertRoom(ctx, dirname(files.data), Math.ceil(size * 2.2))
  const dump = `${PG_BACKUP_DIR}/pre-version-${stampOf(ctx.now())}.sql`, port = process.env.PGPORT ?? '5432', env = kind === 'debian' ? { env: APT_ENV } : {}
  const backup = [
    step('prepare-backup', msgid('Prepare the protected backup directory'), ['/usr/bin/install', '-d', '-m', '0700', '-o', 'postgres', '-g', 'postgres', '--', PG_BACKUP_DIR]),
    step('backup', msgid('Back up all databases'), [DB_RUNUSER, '-u', 'postgres', '--', '/usr/bin/pg_dumpall', `--port=${port}`, `--file=${dump}`], LONG),
    check('verify-backup', msgid('Check the backup file'), ['/usr/bin/grep', '-qF', '--', 'PostgreSQL database cluster dump complete', dump], LONG),
  ]
  const oldUnit = files.unit, newUnit = kind === 'debian' ? `postgresql@${major}-main.service` : oldUnit
  const packages = [`postgresql-${major}`, `postgresql-client-${major}`], oldData = `${files.data}-old`
  const steps = kind === 'debian' ? [...backup,
    step('install', msgid('Install the new version'), versionInstallArgv(kind, packages), LONG, env),
    // The package creates an empty cluster that pg_upgradecluster must not find; a host set not to create one exits 1 here.
    step('drop-empty', msgid('Remove the empty new cluster'), [PG_DROP_CLUSTER, '--stop', String(major), 'main'], SHORT, { successExitCodes: [1] }),
    step('upgrade', msgid('Upgrade the cluster'), [PG_UPGRADE_CLUSTER, '-v', String(major), String(old), 'main'], LONG),
    step('start', msgid('Start the service'), dbServiceControlArgv('start', newUnit)),
  ] : [...backup,
    step('stop', msgid('Stop the service'), dbServiceControlArgv('stop', oldUnit)),
    step('module-reset', msgid('Reset the module stream'), dnfModuleArgv('reset', 'postgresql'), LONG),
    step('module-enable', msgid('Enable the new module stream'), dnfModuleArgv('enable', `postgresql:${major}`), LONG),
    step('install', msgid('Install the new version'), ['/usr/bin/dnf', '-y', '-q', 'distro-sync', '--', 'postgresql', 'postgresql-server'], LONG),
    step('install-upgrade', msgid('Install the upgrade tools'), ['/usr/bin/dnf', '-y', '-q', 'install', '--', 'postgresql-upgrade'], LONG),
    step('upgrade', msgid('Upgrade the cluster'), ['/usr/bin/postgresql-setup', '--upgrade'], LONG),
    step('start', msgid('Start the service'), dbServiceControlArgv('start', oldUnit)),
  ]
  const startOld = step('rollback-start', msgid('Start the service'), dbServiceControlArgv('start', oldUnit))
  const rollback = kind === 'debian' ? [
    step('rollback-drop', msgid('Remove the new cluster'), [PG_DROP_CLUSTER, '--stop', String(major), 'main'], SHORT, { successExitCodes: [1] }),
    step('rollback-remove', msgid('Remove the new version'), softwareCenterArgv('apt-remove', packages), LONG, env),
    step('rollback-reload', msgid('Reload the service manager'), ['/usr/bin/systemctl', 'daemon-reload']),
    startOld,
  ] : [
    step('rollback-stop', msgid('Stop the service'), dbServiceControlArgv('stop', oldUnit)),
    step('rollback-set-aside', msgid('Set the new data aside'), ['/usr/bin/mv', '-T', '--', files.data, `${files.data}-failed`]),
    step('rollback-data', msgid('Put the previous data back'), ['/usr/bin/mv', '-T', '--', oldData, files.data]),
    step('rollback-reset', msgid('Reset the module stream'), dnfModuleArgv('reset', 'postgresql'), LONG),
    // A distribution default is not a stream, so a host may have nothing to enable here.
    step('rollback-enable', msgid('Enable the previous module stream'), dnfModuleArgv('enable', `postgresql:${old}`), LONG, { successExitCodes: [1] }),
    step('rollback-install', msgid('Install the previous version'), ['/usr/bin/dnf', '-y', '-q', 'distro-sync', '--', 'postgresql', 'postgresql-server'], LONG),
    startOld,
  ]
  // pg_upgradecluster moves the old cluster to another port and to manual start; these two files take that back.
  const saved = kind !== 'debian' ? [] : await Promise.all([files.config, files.config.replace(/postgresql\.conf$/, 'start.conf')].map(async path => ({ path, text: await ctx.host.readFile(path), info: await ctx.fs.stat(path) })))
  let proved = false
  const answers = async (expected: number): Promise<boolean> => {
    const now = await requirePgFiles(ctx).catch(() => null), names = now ? await databaseNames(ctx) : null
    return !!now && !!names && majorOf(now.versionNum) === expected && before.every(name => names.includes(name))
  }
  return submitServiceJob(ctx, {
    kind: 'database.postgresql.version', summary: `Upgrade PostgreSQL from ${old} to ${major}`, accountId: null, fingerprint: { from: old, to: major }, detail: { from: old, to: major, backup: dump },
    steps, policy: exactPolicy([...steps, ...rollback]), beforeStep: async () => { await ctx.assertFresh() },
    verify: async () => { proved = await answers(major); return { ok: proved, detail: { major, backup: dump } } },
    finalize: async (run, results): Promise<HostJobVerification> => {
      if (proved) return { ok: true, detail: { major, previous: kind === 'debian' ? old : oldData, backup: dump } }
      if (!attempted(results, kind === 'debian' ? 'install' : 'stop')) return { ok: true, detail: { changed: false } }
      for (const item of saved) if (item.text !== null && item.info) await ctx.host.writeFile({ path: item.path, content: item.text, mode: item.info.mode, owner: String(item.info.uid), group: String(item.info.gid) })
      // postgresql-setup renames the data directory only once it starts the upgrade; before that the data never moved.
      const moved = kind === 'rhel' && await ctx.fs.stat(oldData) !== null
      for (const item of rollback) {
        if (!moved && (item.id === 'rollback-set-aside' || item.id === 'rollback-data')) continue
        if (!(await run(item)).ok) return { ok: false, detail: { rollback: item.id, backup: dump } }
      }
      const back = await answers(old)
      return { ok: back, detail: { rolledBack: back, major: old, backup: dump } }
    },
  })
}

const SELINUX_ENFORCE = '/sys/fs/selinux/enforce'
const dropInFor = (data: string): string => `# Managed by xPanel: PostgreSQL data directory\n[Service]\nEnvironment=PGDATA=${data}\n`
export async function movePostgresqlData(ctx: DbServiceContext, body: unknown) {
  const { target, confirmation } = exactBody(body, ['target', 'confirmation']), kind = family(ctx), files = await requirePgFiles(ctx), major = majorOf(files.versionNum), data = files.data
  if (typeof target !== 'string' || !isPostgresqlDataPath(target) || target === data || target.startsWith(data + '/') || data.startsWith(target + '/')) return fail('VALIDATION', 'choose an absolute path outside the current data directory', { ...unchanged, reason: 'postgresql_target_rejected' })
  if (confirmation !== target) return fail('VALIDATION', 'the confirmation does not match', { ...unchanged, reason: 'confirmation_required' })
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable; nothing was submitted', { ...unchanged, reason: 'host_jobs_unavailable' })
  if (await ctx.fs.stat(target) !== null) return fail('PRECONDITION_FAILED', 'the target already exists', { ...unchanged, reason: 'postgresql_target_exists' })
  const parent = await ctx.fs.stat(dirname(target))
  if (!parent || (parent.mode & 0o001) === 0) return fail('PRECONDITION_FAILED', 'the parent directory must exist and let the postgres user through', { ...unchanged, reason: 'postgresql_target_parent_closed' })
  const size = await dataSizeKb(ctx, data), before = await databaseNames(ctx)
  if (!before) return fail('PRECONDITION_FAILED', 'PostgreSQL must be running for this', { ...unchanged, reason: 'postgresql_not_running' })
  await assertRoom(ctx, dirname(target), Math.ceil(size * 1.1))
  const unit = files.unit, dropIn = `/etc/systemd/system/${unit}.d/90-xpanel-data.conf`, selinux = kind === 'rhel' && await ctx.fs.stat(SELINUX_ENFORCE) !== null
  const point = (path: string, id: string): HostJobCommandStep => kind === 'debian' ? step(id, msgid('Point the server at the data directory'), ['/usr/bin/pg_conftool', String(major), 'main', 'set', 'data_directory', path]) : step(id, msgid('Reload the service manager'), ['/usr/bin/systemctl', 'daemon-reload'])
  const steps = [
    step('stop', msgid('Stop the service'), dbServiceControlArgv('stop', unit)),
    step('copy', msgid('Copy the data directory'), ['/usr/bin/cp', '-a', '--', data, target], LONG),
    check('compare', msgid('Compare every file'), ['/usr/bin/diff', '-r', '--no-dereference', '--', data, target], LONG),
    ...(selinux ? [step('context-rule', msgid('Label the new data directory'), ['/usr/sbin/semanage', 'fcontext', '-a', '-t', 'postgresql_db_t', `${target}(/.*)?`], SHORT, { successExitCodes: [1] }), step('context', msgid('Label the new data directory'), ['/usr/sbin/restorecon', '-R', '--', target], LONG)] : []),
    point(target, 'point'),
    step('start', msgid('Start the service'), dbServiceControlArgv('start', unit)),
  ]
  const rollback = [step('rollback-stop', msgid('Stop the service'), dbServiceControlArgv('stop', unit)), point(data, 'rollback-point'), step('rollback-start', msgid('Start the service'), dbServiceControlArgv('start', unit))]
  const discard = step('rollback-discard', msgid('Remove the failed copy'), ['/usr/bin/rm', '-rf', '--', target], LONG)
  const writeDropIn = async (path: string): Promise<void> => { if (kind === 'rhel') await ctx.host.writeFile({ path: dropIn, content: dropInFor(path), mode: 0o644, owner: 'root', group: 'root' }) }
  let proved = false
  const answers = async (expected: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const now = await requirePgFiles(ctx).catch(() => null), names = now ? await databaseNames(ctx) : null
      if (now && names) return now.data === expected && before.every(name => names.includes(name))
      await ctx.sleep(500)
    }
    return false
  }
  return submitServiceJob(ctx, {
    kind: 'database.postgresql.data_directory', summary: `Move the PostgreSQL data directory to ${target}`, accountId: null, fingerprint: { from: data, to: target }, detail: { from: data, to: target },
    steps, policy: exactPolicy([...steps, ...rollback, discard]),
    beforeStep: async item => { await ctx.assertFresh(); if (item.id === 'point') await writeDropIn(target) },
    verify: async () => { proved = await answers(target); return { ok: proved, detail: { dataDirectory: target, previous: data } } },
    finalize: async (run, results): Promise<HostJobVerification> => {
      if (proved) return { ok: true, detail: { dataDirectory: target, previous: data } }
      if (!attempted(results, 'stop')) return { ok: true, detail: { changed: false } }
      await writeDropIn(data)
      for (const item of rollback) if (!(await run(item)).ok) return { ok: false, detail: { rollback: item.id, previous: data } }
      const back = await answers(data)
      // The copy goes only once the original answers again.
      if (back && attempted(results, 'copy')) await run(discard)
      return { ok: back, detail: { rolledBack: back, dataDirectory: data } }
    },
  })
}
