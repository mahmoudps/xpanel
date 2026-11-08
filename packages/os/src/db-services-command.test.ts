import { describe, expect, it } from 'vitest'
import { postgresqlQueryArgv } from './db-engines-command.ts'
import { MONGO_BACKUP_DIR, PG_PING_SQL, REDIS_BACKUP_DIR, pgConfigCheckArgv, dbBackupDirArgv, dbBackupRemoveArgv, dbServiceControlArgv, isDatabaseServiceCommand, isDbServiceHostTarget, mongodumpArgv, mongorestoreArgv, redisBackupCopyArgv, redisRestoreCopyArgv } from './db-services-command.ts'

describe('database service grammar', () => {
  it('admits exactly what the tools build', () => {
    for (const argv of [dbServiceControlArgv('restart', 'redis-server.service'), dbServiceControlArgv('reload', 'postgresql@14-main.service'), dbServiceControlArgv('stop', 'mongod.service'),
      dbBackupDirArgv(REDIS_BACKUP_DIR), dbBackupDirArgv(MONGO_BACKUP_DIR), redisBackupCopyArgv('/var/lib/redis/dump.rdb', 'redis-20261107T101010Z.rdb'), redisRestoreCopyArgv('redis-20261107T101010Z.rdb', '/var/lib/valkey/dump.rdb', 'valkey'),
      dbBackupRemoveArgv('redis', 'redis-20261107T101010Z.rdb'), dbBackupRemoveArgv('mongodb', 'mongodb-20261107T101010Z.archive.gz'), mongodumpArgv(27017, 'a.archive.gz', null), mongodumpArgv(27018, 'a.archive.gz', 'shop'), mongorestoreArgv(27017, 'a.archive.gz'), postgresqlQueryArgv(PG_PING_SQL), pgConfigCheckArgv('/usr/lib/postgresql/14/bin/postgres', '/var/lib/postgresql/14/main', '/etc/postgresql/14/main/postgresql.conf'), pgConfigCheckArgv('/usr/bin/postgres', '/var/lib/pgsql/data', '/var/lib/pgsql/data/postgresql.conf')])
      expect(isDatabaseServiceCommand(argv), argv.join(' ')).toBe(true)
  })
  it('refuses other units, paths and options', () => {
    for (const argv of [['/usr/bin/systemctl', 'restart', '--', 'nginx.service'], ['/usr/bin/systemctl', 'mask', '--', 'redis.service'], ['/usr/bin/rm', '-f', '--', '/var/backups/xpanel/redis/../../../etc/passwd'], ['/usr/bin/rm', '-rf', '--', REDIS_BACKUP_DIR],
      ['/usr/bin/install', '-m', '0600', '-o', 'root', '-g', 'root', '--', '/etc/shadow', `${REDIS_BACKUP_DIR}/redis-20261107T101010Z.rdb`], ['/usr/bin/install', '-m', '0640', '-o', 'www-data', '-g', 'www-data', '--', `${REDIS_BACKUP_DIR}/redis-20261107T101010Z.rdb`, '/var/lib/redis/dump.rdb'],
      [...mongorestoreArgv(27017, 'a.archive.gz'), '--nsInclude=x'], postgresqlQueryArgv('DROP DATABASE x'), ['/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/bin/postgres', '-D', '/tmp/x', '-c', 'config_file=/etc/postgresql/14/main/postgresql.conf', '-C', 'port'], ['/usr/sbin/runuser', '-u', 'root', '--', '/usr/bin/postgres', '-D', '/var/lib/pgsql/data', '-c', 'config_file=/var/lib/pgsql/data/postgresql.conf', '-C', 'port']])
      expect(isDatabaseServiceCommand(argv), argv.join(' ')).toBe(false)
    expect(() => dbServiceControlArgv('restart', 'ssh.service')).toThrow()
    expect(() => mongodumpArgv(27017, 'a.archive.gz', 'a b')).toThrow()
    expect(() => redisBackupCopyArgv('/var/lib/redis/../../etc/shadow.rdb', 'redis-20261107T101010Z.rdb')).toThrow()
  })
  it('never puts a password in argv and owns only reviewed files', () => {
    expect(mongodumpArgv(27017, 'a.archive.gz', null).some(word => /password/i.test(word))).toBe(false)
    expect(isDbServiceHostTarget('/etc/redis/redis.conf', 'write')).toBe(true)
    expect(isDbServiceHostTarget('/etc/postgresql/14/main/pg_hba.conf', 'read')).toBe(true)
    expect(isDbServiceHostTarget('/var/lib/postgresql/14/main/postgresql.auto.conf', 'write')).toBe(true)
    expect(isDbServiceHostTarget('/etc/redis/redis.conf', 'remove')).toBe(false)
    expect(isDbServiceHostTarget('/etc/postgresql/14/main/pg_ident.conf', 'write')).toBe(false)
    expect(isDbServiceHostTarget('/etc/shadow', 'read')).toBe(false)
  })
})
