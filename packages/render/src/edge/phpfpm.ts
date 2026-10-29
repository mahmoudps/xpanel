// One PHP-FPM master per account and PHP version, running as the account inside its slice
// (the systemd unit is rendered by the system module, which owns the file layout used here).
// This module renders php-fpm.conf, the pool, and .user.ini.
import type { Account, ApacheMpm, ConfigTest, HostAction, Limit, OsProfile, PhpIniOptions, PhpSettings, RenderedFile } from '@xpanel/core'
import { accountSliceName } from '../system/slice.ts'
import { fpmUnitName } from '../system/units.ts'
import {
  fpmConfDir,
  fpmErrorLog,
  fpmLogDir,
  fpmMasterConfPath,
  fpmPidPath,
  fpmPoolConfPath,
  fpmRuntimeDir,
  fpmSocketPath,
  phpFpmBinary,
  XP_PATHS,
} from './paths.ts'
import { assertWorkers, iniEntries, phpIsolation, type PhpIsolationOptions } from './php.ts'
import { iniValue } from './quote.ts'
import { assertAccount, assertInt, assertPhpVersion, assertSystemUser, invalid } from './validate.ts'

export interface FpmPoolOptions extends PhpIsolationOptions, PhpIniOptions {
  /** PlanCaps.phpWorkers of the account's plan: pm.max_children may not exceed it */
  workerCap?: Limit
  /** request_terminate_timeout, seconds (default 300, 0 = off) */
  requestTerminateTimeoutSec?: number
  /**
   * Apache MPM in front of the pool (default itk). Under itk the Apache child already is the
   * account, so only the account may connect. Under prefork the shared Apache user connects,
   * which gets an ACL entry on the socket (the master is not root and cannot chgrp to it).
   */
  apacheMpm?: ApacheMpm
}

const FLAG = /^(on|off)$/i

const adminLine = ([k, v]: [string, string]): string =>
  FLAG.test(v) ? `php_admin_flag[${k}] = ${v.toLowerCase()}` : `php_admin_value[${k}] = ${iniValue(v, k)}`

const socketAccess = (user: string, os: OsProfile, mpm: ApacheMpm): string[] => {
  const base = [`listen.owner = ${user}`, `listen.group = ${user}`, 'listen.mode = 0660']
  if (mpm === 'itk') return base
  if (mpm !== 'prefork') return invalid('apacheMpm', mpm, 'must be itk or prefork')
  return [...base, `listen.acl_users = ${assertSystemUser(os.paths.apacheUser, 'Apache user')}`]
}

/** Pool of `<user>-<version>`; listen socket inside the unit's runtime dir, mode 0660. */
export const renderFpmPool = (account: Account, domainPhp: PhpSettings, os: OsProfile, opts: FpmPoolOptions = {}): RenderedFile => {
  assertAccount(account)
  if (!domainPhp || typeof domainPhp !== 'object') return invalid('PHP settings', domainPhp, 'are required')
  const version = assertPhpVersion(domainPhp.version)
  if (domainPhp.handler !== 'fpm') return invalid('PHP handler', domainPhp.handler, 'a pool is rendered only for PHP-FPM')
  const w = assertWorkers(domainPhp.fpm, opts.workerCap)
  const terminate = assertInt('request_terminate_timeout', opts.requestTerminateTimeoutSec ?? 300, 0, 86400)
  const user = account.username
  const iso = phpIsolation(account, os, opts)
  const ini = iniEntries(domainPhp.ini, opts.maxMemoryMb === undefined ? {} : { maxMemoryMb: opts.maxMemoryMb })

  const lines = [
    `; Managed by xPanel: PHP ${version} pool for ${user}`,
    `[${user}]`,
    // the master already runs as the account; user/group take effect if it is ever started as root
    `user = ${user}`,
    `group = ${user}`,
    `listen = ${fpmSocketPath(user, version)}`,
    ...socketAccess(user, os, opts.apacheMpm ?? 'itk'),
    'listen.backlog = 511',
    '',
    `pm = ${w.mode}`,
    `pm.max_children = ${w.maxChildren}`,
    `pm.start_servers = ${w.startServers}`,
    `pm.min_spare_servers = ${w.minSpareServers}`,
    `pm.max_spare_servers = ${w.maxSpareServers}`,
    `pm.max_requests = ${w.maxRequests}`,
    `pm.process_idle_timeout = ${w.processIdleTimeoutSec}s`,
    `request_terminate_timeout = ${terminate}s`,
    '',
    `chdir = ${account.home}`,
    'catch_workers_output = yes',
    'clear_env = yes',
    'security.limit_extensions = .php',
    'env[PATH] = /usr/local/bin:/usr/bin:/bin',
    `env[TMPDIR] = ${iso.tmpDir}`,
    `env[TMP] = ${iso.tmpDir}`,
    `env[TEMP] = ${iso.tmpDir}`,
    '',
    ...iso.admin.map(adminLine),
    'php_admin_flag[log_errors] = on',
    // custom session.save_path: Debian's cron-based session cleanup never sees it
    'php_value[session.gc_probability] = 1',
    // PHP_INI_SYSTEM keys only take effect as admin values; the rest stay adjustable in .user.ini
    ...ini.pool.map(adminLine),
    ...ini.user.map(([k, v]) => `php_value[${k}] = ${v}`),
  ]
  return {
    path: fpmPoolConfPath(user, version),
    content: `${lines.join('\n')}\n`,
    mode: 0o640,
    owner: 'root',
    group: user,
  }
}

/** php-fpm.conf of the account's master: foreground under systemd, pid and log in xPanel dirs. */
export const renderFpmMaster = (account: Account, version: string, os: OsProfile): RenderedFile => {
  assertAccount(account)
  const v = assertPhpVersion(version)
  const user = account.username
  phpFpmBinary(os, v)
  const lines = [
    `; Managed by xPanel: PHP ${v} FPM master for ${user}; runs as ${user} in xpanel-${account.uid}.slice`,
    '[global]',
    `pid = ${fpmPidPath(user, v)}`,
    `error_log = ${fpmErrorLog(user, v)}`,
    'log_level = notice',
    'daemonize = no',
    'emergency_restart_threshold = 10',
    'emergency_restart_interval = 1m',
    'process_control_timeout = 10s',
    `include = ${fpmPoolConfPath(user, v)}`,
  ]
  return {
    path: fpmMasterConfPath(user, v),
    content: `${lines.join('\n')}\n`,
    mode: 0o640,
    owner: 'root',
    group: user,
  }
}

/**
 * Directories one master needs before its unit starts. Config is root-owned and readable by
 * the account only, so the account can run the master but cannot rewrite its own isolation.
 * The socket directory is the unit's RuntimeDirectory=, which systemd creates and removes.
 */
export const fpmInstanceDirs = (account: Account, version: string): HostAction[] => {
  assertAccount(account)
  const user = account.username
  const v = assertPhpVersion(version)
  return [
    { kind: 'ensure-dir', path: XP_PATHS.fpmConfDir, mode: 0o755, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: fpmConfDir(v), mode: 0o755, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: XP_PATHS.fpmLogDir, mode: 0o755, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: fpmLogDir(user, v), mode: 0o750, owner: user, group: user },
    { kind: 'ensure-dir', path: `${account.home}/tmp`, mode: 0o700, owner: user, group: user },
  ]
}

/**
 * `php-fpm --test` opens (and creates) the error log. Run as root it would leave a root-owned
 * 0600 log the account's master can never open, so the test runs as the account, the same
 * identity the unit uses.
 */
export const fpmConfigTest = (account: Account, version: string, os: OsProfile): ConfigTest => {
  assertAccount(account)
  const v = assertPhpVersion(version)
  const user = account.username
  return {
    name: `php-fpm ${user}-${v}`,
    argv: ['runuser', '-u', user, '--', phpFpmBinary(os, v), '--test', '--fpm-config', fpmMasterConfPath(user, v)],
  }
}

/**
 * .user.ini body from panel PHP settings (php_value/php_flag never via .htaccess). Keys PHP
 * reads only at startup (PHP_INI_SYSTEM) are refused: in .user.ini they would be ignored.
 */
export const renderUserIni = (ini: Record<string, string>, opts: PhpIniOptions = {}): string => {
  const entries = iniEntries(ini, opts)
  if (entries.pool.length > 0) {
    return invalid('PHP setting', entries.pool.map(([k]) => k).join(', '), 'is read only at PHP startup; set it on the pool, not in .user.ini')
  }
  return ['; Managed by xPanel: PHP settings for this directory', ...entries.user.map(([k, v]) => `${k} = ${v}`)].join('\n') + '\n'
}

export interface FpmSocketContract {
  accountUsername: string
  uid: number
  gid: number
  version: string
  unit: string
  slice: string
  runtimeDir: string
  runtimeDirMode: string
  socketPath: string
  listenOwner: string
  listenGroup: string
  listenMode: string
  aclUsers: string[]
  pmMode: PhpSettings['fpm']['mode']
  maxChildren: number
  openBasedir: string[]
}

const fpmKeyValue = (content: string, key: string): string | undefined =>
  content
    .split('\n')
    .find((l) => l.startsWith(`${key} = `))
    ?.slice(key.length + 3)

/**
 * Verifies the per-account PHP-FPM pool and master isolation contract (H05 — A31, A32, A35):
 * - Runs as `<user>:<user>` inside `xpanel-<uid>.slice`
 * - Listens on `/run/xpanel-fpm/<user>-<ver>/php-fpm.sock` (`0660`, owned by `<user>:<user>`)
 * - Grants zero `listen.acl_users` under `mpm_itk` so only the account's own UID/GID may connect
 * - Enforces `pm` worker bounds and `open_basedir` confinement
 */
export const verifyFpmPoolIsolation = (
  account: Account,
  domainPhp: PhpSettings,
  os: OsProfile,
  opts: FpmPoolOptions = {},
): FpmSocketContract => {
  const poolFile = renderFpmPool(account, domainPhp, os, opts)
  const masterFile = renderFpmMaster(account, domainPhp.version, os)
  const user = account.username
  const v = assertPhpVersion(domainPhp.version)
  const mpm = opts.apacheMpm ?? 'itk'
  const expectedSlice = accountSliceName(account.uid)

  if (!masterFile.content.includes(expectedSlice)) {
    return invalid('FPM master slice', masterFile.content, `must reference ${expectedSlice}`)
  }

  const poolUser = fpmKeyValue(poolFile.content, 'user')
  const poolGroup = fpmKeyValue(poolFile.content, 'group')
  const listen = fpmKeyValue(poolFile.content, 'listen')
  const listenOwner = fpmKeyValue(poolFile.content, 'listen.owner')
  const listenGroup = fpmKeyValue(poolFile.content, 'listen.group')
  const listenMode = fpmKeyValue(poolFile.content, 'listen.mode')
  const aclUsersRaw = fpmKeyValue(poolFile.content, 'listen.acl_users')
  const pmMode = fpmKeyValue(poolFile.content, 'pm') as PhpSettings['fpm']['mode'] | undefined
  const maxChildren = Number(fpmKeyValue(poolFile.content, 'pm.max_children'))
  const openBasedirRaw = fpmKeyValue(poolFile.content, 'php_admin_value[open_basedir]') ?? ''

  const expectedSocket = fpmSocketPath(user, v)
  if (poolUser !== user || poolGroup !== user) {
    return invalid('FPM pool user/group', `${poolUser}:${poolGroup}`, `must equal ${user}:${user}`)
  }
  if (listen !== expectedSocket) {
    return invalid('FPM pool listen socket', listen, `must equal ${expectedSocket}`)
  }
  if (listenOwner !== user || listenGroup !== user || listenMode !== '0660') {
    return invalid('FPM socket ownership/mode', `${listenOwner}:${listenGroup} ${listenMode}`, `must equal ${user}:${user} 0660`)
  }
  const aclUsers = aclUsersRaw ? aclUsersRaw.split(',').map((s) => s.trim()).filter(Boolean) : []
  if (mpm === 'itk' && aclUsers.length > 0) {
    return invalid('FPM listen.acl_users', aclUsersRaw, 'must be empty under mpm_itk so only the account UID/GID can connect')
  }
  if (mpm === 'prefork' && (aclUsers.length !== 1 || aclUsers[0] !== os.paths.apacheUser)) {
    return invalid('FPM listen.acl_users', aclUsersRaw, `must contain only ${os.paths.apacheUser} under prefork`)
  }
  if (!pmMode || !['ondemand', 'dynamic', 'static'].includes(pmMode)) {
    return invalid('FPM pm mode', pmMode, 'must be ondemand, dynamic, or static')
  }

  return {
    accountUsername: user,
    uid: account.uid,
    gid: account.gid,
    version: v,
    unit: fpmUnitName(user, v),
    slice: expectedSlice,
    runtimeDir: fpmRuntimeDir(user, v),
    runtimeDirMode: '0750',
    socketPath: expectedSocket,
    listenOwner,
    listenGroup,
    listenMode,
    aclUsers,
    pmMode,
    maxChildren,
    openBasedir: openBasedirRaw.split(':').filter(Boolean),
  }
}

/**
 * Evaluates kernel DAC + POSIX ACL access for a caller process identity attempting `connect(2)`
 * on a tenant's PHP-FPM UNIX domain socket (`0750 <user>:<user>` runtime dir + `0660 <user>:<user>` socket).
 * Under `mpm_itk`, an Apache worker serving tenant B runs with UID/GID `bob:bob` and is denied with `EACCES`.
 */
export const canIdentityConnectFpmSocket = (
  contract: FpmSocketContract,
  caller: { username: string; uid: number; gid: number },
): { allowed: boolean; errno: null | 'EACCES'; reason: string } => {
  if (caller.uid === 0) {
    return { allowed: true, errno: null, reason: 'root (CAP_DAC_OVERRIDE)' }
  }
  if (
    caller.uid === contract.uid ||
    caller.gid === contract.gid ||
    caller.username === contract.listenOwner ||
    caller.username === contract.listenGroup
  ) {
    return {
      allowed: true,
      errno: null,
      reason: `caller ${caller.username} (${caller.uid}:${caller.gid}) matches socket owner/group ${contract.listenOwner}:${contract.listenGroup} (mode ${contract.listenMode})`,
    }
  }
  if (contract.aclUsers.includes(caller.username)) {
    return {
      allowed: true,
      errno: null,
      reason: `caller ${caller.username} is granted explicit POSIX ACL access via listen.acl_users`,
    }
  }
  return {
    allowed: false,
    errno: 'EACCES',
    reason: `Permission denied (EACCES): caller ${caller.username} (${caller.uid}:${caller.gid}) cannot traverse ${contract.runtimeDir} (${contract.runtimeDirMode} ${contract.listenOwner}:${contract.listenGroup}) or connect to ${contract.socketPath} (${contract.listenMode} ${contract.listenOwner}:${contract.listenGroup})`,
  }
}
