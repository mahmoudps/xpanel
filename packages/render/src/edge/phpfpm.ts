// One PHP-FPM master per account and PHP version, running as the account inside its slice
// (the systemd unit is rendered by the system module, which owns the file layout used here).
// This module renders php-fpm.conf, the pool, and .user.ini.
import type { Account, ApacheMpm, ConfigTest, HostAction, Limit, OsProfile, PhpIniOptions, PhpSettings, RenderedFile } from '@xpanel/core'
import {
  fpmConfDir,
  fpmErrorLog,
  fpmLogDir,
  fpmMasterConfPath,
  fpmPidPath,
  fpmPoolConfPath,
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
