import { describe, expect, it, vi } from 'vitest'
import {
  MYSQL_DROPIN_DEBIAN, MYSQL_PING_SQL, MYSQL_SERVICE_SETTINGS_SQL, MYSQL_VERSION_SQL,
  assertMysqlSettings, controlMysql, previewMysqlConfig, readMysqlConfig, readMysqlLog,
  readMysqlView, saveMysqlConfig, saveMysqlSettings, validateMysqlDropInText,
} from './db-mysql-service.ts'
import type { DbServiceContext, DbServiceFs, DbServiceHost } from './db-service-files.ts'
import { revisionOf } from './db-service-files.ts'

const clock = () => new Date('2026-11-27T12:00:00.000Z')
const dpkgOut = 'mariadb-server\t1:10.11.9\tinstall ok installed\n'
const showActive = 'Id=mariadb.service\nNames=mariadb.service\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n'
const showInactive = 'Id=mariadb.service\nNames=mariadb.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\n'

function makeContext(opts: { initialConfig?: string | null; installed?: boolean; active?: boolean; configOk?: boolean; pingOk?: boolean; observedPort?: number; observedBind?: string } = {}) {
  const files = new Map<string, string>()
  if (opts.initialConfig !== undefined && opts.initialConfig !== null) files.set(MYSQL_DROPIN_DEBIAN, opts.initialConfig)
  let active = opts.active ?? true
  let enabled = true
  let configOk = opts.configOk ?? true
  let pingOk = opts.pingOk ?? true
  let port = opts.observedPort ?? 3306
  let bind = opts.observedBind ?? '127.0.0.1'
  let maxConnections = 151
  let skipNetworking = 'OFF'
  const commands: string[][] = []

  const host: DbServiceHost = {
    readFile: async path => files.get(path) ?? null,
    writeFile: async file => {
      files.set(file.path, file.content)
      const p = /^port\s*=\s*([0-9]+)$/m.exec(file.content)?.[1]
      const b = /^bind_address\s*=\s*(\S+)$/m.exec(file.content)?.[1]
      const m = /^max_connections\s*=\s*([0-9]+)$/m.exec(file.content)?.[1]
      const s = /^skip_networking\s*=\s*([01])$/m.exec(file.content)?.[1]
      if (p) port = Number(p)
      if (b) bind = b
      if (m) maxConnections = Number(m)
      if (s) skipNetworking = s === '1' ? 'ON' : 'OFF'
    },
  }
  const fs: DbServiceFs = {
    stat: async path => files.has(path) ? { uid: 0, gid: 0, mode: 0o644 } : null,
    list: async () => [],
    tail: async path => path === '/var/log/mysql/error.log' ? "2026-11-27 [Note] ready for connections\nPASSWORD 'secret1'\n" : null,
    freeKb: async () => 1024 * 1024,
    gunzipHead: async () => null,
    adopt: async () => undefined,
    remove: async path => { files.delete(path) },
  }
  const run = vi.fn(async (argv: readonly string[]) => {
    commands.push([...argv])
    if (argv[0] === '/usr/bin/dpkg-query') return { ok: true, code: 0, stdout: opts.installed === false ? '' : dpkgOut, stderr: '' }
    if (argv[0] === '/usr/bin/systemctl' && argv[1] === 'show') {
      const unit = argv.at(-1)
      if (unit === 'mariadb.service') return { ok: true, code: 0, stdout: (active ? showActive : showInactive).replace('UnitFileState=enabled', `UnitFileState=${enabled ? 'enabled' : 'disabled'}`), stderr: '' }
      return { ok: true, code: 0, stdout: 'Id=mysql.service\nNames=mysql.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\n', stderr: '' }
    }
    if (argv[0] === '/usr/bin/systemctl') {
      const verb = argv[1]
      if (verb === 'stop') active = false
      else if (verb === 'start' || verb === 'restart') active = true
      else if (verb === 'enable') enabled = true
      else if (verb === 'disable') enabled = false
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    if (argv[0] === '/usr/sbin/mariadbd') {
      return { ok: configOk, code: configOk ? 0 : 1, stdout: '', stderr: configOk ? '' : 'unknown option --bad' }
    }
    if (argv[0] === '/usr/bin/mariadb') {
      const sql = argv.at(-1)
      if (!pingOk) return { ok: false, code: 1, stdout: '', stderr: 'ERROR 2002: Can\'t connect' }
      if (sql === MYSQL_PING_SQL) return { ok: true, code: 0, stdout: '1\n', stderr: '' }
      if (sql === MYSQL_VERSION_SQL) return { ok: true, code: 0, stdout: '10.11.9-MariaDB\n', stderr: '' }
      if (sql === MYSQL_SERVICE_SETTINGS_SQL) {
        return {
          ok: true,
          code: 0,
          stdout: [
            `port\t${port}`,
            `bind_address\t${bind}`,
            'socket\t/run/mysqld/mysqld.sock',
            'datadir\t/var/lib/mysql',
            'log_error\t/var/log/mysql/error.log',
            `max_connections\t${maxConnections}`,
            'innodb_buffer_pool_size\t134217728',
            'slow_query_log\tOFF',
            'long_query_time\t10.000000',
            `skip_networking\t${skipNetworking}`,
          ].join('\n') + '\n',
          stderr: '',
        }
      }
    }
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected' }
  })

  const ctx: DbServiceContext = {
    family: 'debian',
    run,
    readFile: async path => files.get(path) ?? null,
    host,
    fs,
    runPostgresql: null,
    submitJob: null,
    stateRoot: '/tmp/xp-mysql-test',
    connectRedis: async () => { throw new Error('unused') },
    connectMongo: async () => { throw new Error('unused') },
    sleep: async () => undefined,
    now: clock,
    assertFresh: async () => 'root',
  }
  return {
    ctx,
    files,
    commands,
    setState(next: { configOk?: boolean; pingOk?: boolean }) {
      if (next.configOk !== undefined) configOk = next.configOk
      if (next.pingOk !== undefined) pingOk = next.pingOk
    },
  }
}

describe('MariaDB/MySQL service controller', () => {
  it('reads live version, listen check, settings and redacted log tail', async () => {
    const f = makeContext({ initialConfig: '[mysqld]\nport = 3306\n' })
    const view = await readMysqlView(f.ctx)
    expect(view).toMatchObject({
      engine: 'mysql',
      installed: true,
      version: '10.11.9-MariaDB',
      service: { unit: 'mariadb.service', active: 'active', enabled: 'enabled' },
      listenCheck: { port: 3306, bindAddress: '127.0.0.1', skipNetworking: false, listening: true },
      dropInPresent: true,
    })
    const log = await readMysqlLog(f.ctx)
    expect(log.path).toBe('/var/log/mysql/error.log')
    expect(log.lines.join('\n')).toContain('ready for connections')
    expect(log.lines.join('\n')).not.toContain('secret1')
  })

  it('controls systemd start, stop, restart, enable and disable with verification', async () => {
    const f = makeContext()
    expect(await controlMysql(f.ctx, { action: 'stop' })).toMatchObject({ action: 'stop', active: 'inactive' })
    expect(await controlMysql(f.ctx, { action: 'start' })).toMatchObject({ action: 'start', active: 'active' })
    expect(await controlMysql(f.ctx, { action: 'disable' })).toMatchObject({ action: 'disable', enabled: 'disabled' })
    expect(await controlMysql(f.ctx, { action: 'enable' })).toMatchObject({ action: 'enable', enabled: 'enabled' })
    await expect(controlMysql(f.ctx, { action: 'destroy' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('validates settings and drop-in directives and rejects unsafe inputs', () => {
    expect(assertMysqlSettings({ port: 3306, bindAddress: '127.0.0.1', maxConnections: 200, skipNetworking: false })).toEqual({ port: 3306, bindAddress: '127.0.0.1', maxConnections: 200, skipNetworking: false })
    expect(() => assertMysqlSettings({ port: 80, bindAddress: '127.0.0.1', maxConnections: 200, skipNetworking: false })).toThrow()
    expect(() => assertMysqlSettings({ port: 3306, bindAddress: 'bad host;', maxConnections: 200, skipNetworking: false })).toThrow()
    expect(() => assertMysqlSettings({ port: 3306, bindAddress: '127.0.0.1', maxConnections: 5, skipNetworking: false })).toThrow()
    expect(() => validateMysqlDropInText('[client]\npassword=leak\n')).toThrow()
    expect(() => validateMysqlDropInText('[mysqld]\ninit_file=/tmp/evil.sql\n')).toThrow()
  })

  it('previews drop-in diff, saves validated config and rolls back when MariaDB does not answer', async () => {
    const f = makeContext()
    const read0 = await readMysqlConfig(f.ctx)
    expect(read0.present).toBe(false)

    const preview = await previewMysqlConfig(f.ctx, { port: 3307, bindAddress: '0.0.0.0', maxConnections: 300, skipNetworking: false })
    expect(preview.changed).toBe(true)
    expect(preview.diff).toContain('+ port = 3307')
    expect(f.files.has(MYSQL_DROPIN_DEBIAN)).toBe(false)

    await expect(saveMysqlConfig(f.ctx, { text: '[mysqld]\nmax_connections = 300\n', expectedRevision: 'stale' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const saved = await saveMysqlSettings(f.ctx, { port: 3307, bindAddress: '0.0.0.0', maxConnections: 300, skipNetworking: false })
    expect(saved.saved).toBe(true)
    expect(f.files.get(MYSQL_DROPIN_DEBIAN)).toContain('port = 3307')

    // Now test automatic rollback when config check fails on a subsequent edit
    const currentText = f.files.get(MYSQL_DROPIN_DEBIAN)!
    f.setState({ configOk: false })
    await expect(saveMysqlConfig(f.ctx, { text: '[mysqld]\nmax_connections = 400\n', expectedRevision: revisionOf(currentText) }))
      .rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { stateChanged: false, restored: true } })
    expect(f.files.get(MYSQL_DROPIN_DEBIAN)).toBe(currentText)
  })
})
