import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { dirname, join, posix, win32 } from 'node:path'
import { fail } from '@xpanel/core'
import type { ConfigTest, HostAction, RenderedFile } from '@xpanel/core'
import { assertSafeArgv, isPhpInventoryCommand, isSecurityObservationCommand, isMailQuarantineArgv, isMailQueueCommand, isPackageManagerCommand, isRepairCommand, isSoftwareCenterCommand, isMailLogCommand, isFtpLogCommand, isMonitoringCommand, isMailServerCommand, isServiceDetailCommand, isSecurityToolsCommand, isMailboxMaintenanceCommand, isNetworkToolsCommand, isSecHostCommand } from '@xpanel/os'
import { removePinnedHostTree, withOwnedHostFileHandle, withPinnedHostTargetParent } from './host-target-parent.ts'
import { isServiceManagerCommand, isBenchmarkCommand, isComposerCommand, isMailxCommand, isDatabaseEngineCommand, isDatabaseRemoteCommand } from '@xpanel/os'
import { isAccountGitCommand } from './account-git-runner.ts'
import { isAccountRuntimeCommand } from './account-runtime.ts'
import { isSwContainerCommand } from '../../../packages/os/src/sw-container-command.ts'
import { isSwAddonServiceCommand } from '../../../packages/os/src/sw-addon-command.ts'
import { isRpmInstalledIdentityCommand } from '../../../packages/os/src/ops-package-recovery-command.ts'
import { applyObservedUserQuota } from './services/quota.ts'

export interface ConfigTestResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

export interface AccountSliceMetrics {
  uid: number
  cpuUsageUsec: number
  memoryCurrentBytes: number
  ioReadBytes: number
  ioWriteBytes: number
  pidsCurrent: number
  /** Raw `io.max`. Null when the file is absent. `wbps=max` is not a plan cap. */
  ioMax?: string | null
  memoryMax?: string | null
  pidsMax?: string | null
  cpuMax?: string | null
}

export interface AgentExecutor {
  preflight(plan: HostExecutionPlan): Promise<void>
  writeFile(file: RenderedFile): Promise<void>
  readFile(path: string): Promise<string | null>
  removePath(path: string): Promise<void>
  runTest(test: ConfigTest): Promise<ConfigTestResult>
  runAction(action: HostAction): Promise<void>
  runCommand(argv: string[]): Promise<ConfigTestResult>
  readSliceMetrics(uid: number): Promise<AccountSliceMetrics | null>
}

export interface HostExecutionPlan {
  files: readonly RenderedFile[]
  preActions: readonly HostAction[]
  postActions: readonly HostAction[]
}

export interface FakeUserEntry {
  uid: number
  gid: number
  home: string
  shell: string
}

export interface FakeQuotaEntry {
  blockSoftKb: number
  blockHardKb: number
  filesystem: string
}

const isReviewedServiceCommand = (argv: readonly string[]): boolean =>
  isServiceManagerCommand(argv) || isMailxCommand(argv) || isDatabaseEngineCommand(argv) || isDatabaseRemoteCommand(argv) || isSwContainerCommand(argv) || isSwAddonServiceCommand(argv) || isBenchmarkCommand(argv) || isAccountGitCommand(argv) || isAccountRuntimeCommand(argv) || isComposerCommand(argv) || isRpmInstalledIdentityCommand(argv) ||
  isPhpInventoryCommand(argv) || isSecurityObservationCommand(argv) || isMailQuarantineArgv(argv) || isMailQueueCommand(argv) || isPackageManagerCommand(argv) || isRepairCommand(argv) || isSoftwareCenterCommand(argv) || isMailLogCommand(argv) || isFtpLogCommand(argv) || isMonitoringCommand(argv) || isMailServerCommand(argv) || isServiceDetailCommand(argv) || isSecurityToolsCommand(argv) || isMailboxMaintenanceCommand(argv) || isNetworkToolsCommand(argv) || isSecHostCommand(argv)

const assertValidCommandArgv = (argv: readonly string[]): void => {
  const head = Array.isArray(argv) ? argv[0] : undefined
  if (!head) {
    fail('VALIDATION', 'argv must be a non-empty array')
  }
  // Finite reviewed grammars admit only their literal flags and bounded identities.
  // Generic SAFE_ARG remains unchanged for all other commands.
  if (isReviewedServiceCommand(argv)) return
  const normalized = head.startsWith('/') ? [...argv] : [`/usr/sbin/${head}`, ...argv.slice(1)]
  assertSafeArgv(normalized)
}
export class FakeHostExecutor implements AgentExecutor {
  /** Memory-only simulation supports the plan; it does not certify host capabilities. */
  async preflight(_plan: HostExecutionPlan): Promise<void> {}
  readonly files = new Map<string, RenderedFile>()
  readonly dirs = new Map<string, { mode: number; owner: string; group: string }>()
  readonly groups = new Map<string, number>()
  readonly users = new Map<string, FakeUserEntry>()
  readonly quotas = new Map<string, FakeQuotaEntry>()
  readonly units = new Map<string, { enabled: boolean; active: boolean; properties: Record<string, string> }>()
  readonly executedTests: ConfigTest[] = []
  readonly executedActions: HostAction[] = []
  readonly executedCommands: string[][] = []
  readonly sqlStatements: { engine: 'mariadb' | 'postgresql'; statement: string }[] = []
  readonly sliceMetrics = new Map<number, AccountSliceMetrics>()

  private failingTests = new Map<string, string>()
  private failingCommands = new Map<string, { code: number; stderr: string; stdout: string }>()

  /** Simulates a failing `ConfigTest` (e.g., `nginx` or `apache`) with the given stderr message. */
  failConfigTest(name: string, stderr = `${name}: configuration test failed`): void {
    this.failingTests.set(name, stderr)
  }

  clearConfigTestFailures(): void {
    this.failingTests.clear()
  }

  /** Simulates a non-zero exit code for any `runCommand` whose argv matches `match`. */
  failCommand(match: string, code = 1, stderr = `command failed: ${match}`, stdout = ''): void {
    this.failingCommands.set(match, { code, stderr, stdout })
  }

  clearCommandFailures(): void {
    this.failingCommands.clear()
  }

  async writeFile(file: RenderedFile): Promise<void> {
    this.files.set(file.path, { ...file })
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path)?.content ?? null
  }

  async removePath(path: string): Promise<void> {
    this.files.delete(path)
    this.dirs.delete(path)
    for (const k of [...this.files.keys()]) {
      if (k.startsWith(`${path}/`)) this.files.delete(k)
    }
    for (const k of [...this.dirs.keys()]) {
      if (k.startsWith(`${path}/`)) this.dirs.delete(k)
    }
  }

  async runTest(test: ConfigTest): Promise<ConfigTestResult> {
    assertValidCommandArgv(test.argv)
    this.executedTests.push({ name: test.name, argv: [...test.argv] })
    const err = this.failingTests.get(test.name)
    if (err !== undefined) {
      return { ok: false, code: 1, stdout: '', stderr: err }
    }
    return { ok: true, code: 0, stdout: 'syntax ok', stderr: '' }
  }

  async runAction(action: HostAction): Promise<void> {
    this.executedActions.push(action)
    switch (action.kind) {
      case 'ensure-group':
        this.groups.set(action.name, action.gid)
        return
      case 'ensure-user':
        this.users.set(action.name, {
          uid: action.uid,
          gid: action.gid,
          home: action.home,
          shell: action.shell,
        })
        return
      case 'delete-user':
        this.users.delete(action.name)
        return
      case 'ensure-dir':
        this.dirs.set(action.path, { mode: action.mode, owner: action.owner, group: action.group })
        return
      case 'remove-path':
        await this.removePath(action.path)
        return
      case 'set-quota':
        if (action.blockSoftKb === 0 && action.blockHardKb === 0) {
          this.quotas.delete(action.user)
        } else {
          this.quotas.set(action.user, {
            blockSoftKb: action.blockSoftKb,
            blockHardKb: action.blockHardKb,
            filesystem: action.filesystem,
          })
        }
        return
      case 'systemd-daemon-reload':
        return
      case 'systemd': {
        const cur = this.units.get(action.unit) ?? { enabled: false, active: false, properties: {} }
        if (action.verb === 'enable') cur.enabled = true
        else if (action.verb === 'disable') cur.enabled = false
        else if (action.verb === 'start' || action.verb === 'restart' || action.verb === 'reload') cur.active = true
        else if (action.verb === 'stop') cur.active = false
        this.units.set(action.unit, cur)
        return
      }
      case 'systemd-set-property': {
        const cur = this.units.get(action.unit) ?? { enabled: false, active: true, properties: {} }
        Object.assign(cur.properties, action.properties)
        this.units.set(action.unit, cur)
        return
      }
      case 'exec':
        assertValidCommandArgv(action.argv)
        return
      case 'sql':
        for (const statement of action.statements) {
          this.sqlStatements.push({ engine: action.engine, statement })
        }
        return
    }
  }

  async runCommand(argv: string[]): Promise<ConfigTestResult> {
    assertValidCommandArgv(argv)
    this.executedCommands.push([...argv])
    const joined = argv.join(' ')
    for (const [match, failure] of this.failingCommands) {
      if (joined.includes(match) || argv.some((token) => token.includes(match))) {
        return {
          ok: failure.code === 0,
          code: failure.code,
          stdout: failure.stdout,
          stderr: failure.stderr,
        }
      }
    }
    // Declared cron fixture state only: no synthetic completed run or timestamps.
    if (argv[0] === '/usr/bin/systemctl' && argv[1] === 'show' && /^xpanel-cron-[a-z0-9_-]+\.(?:timer|service)$/.test(argv[2] ?? '') && argv.slice(3).every(value => value.startsWith('--property='))) {
      const unit = argv[2]!, declared = [...this.files.keys()].some(path => path.endsWith('/' + unit))
      const current = this.units.get(unit)
      const values: Record<string, string> = {
        LoadState: declared ? 'loaded' : 'not-found', ActiveState: current?.active ? 'active' : 'inactive',
        UnitFileState: current?.enabled ? 'enabled' : 'disabled', SubState: current?.active ? 'running' : 'dead',
        LastTriggerUSec: '', NextElapseUSecRealtime: '', Result: '', ExecMainStatus: '0',
        ExecMainStartTimestamp: '', ExecMainStartTimestampMonotonic: '0', ExecMainExitTimestampMonotonic: '0',
        ...current?.properties,
      }
      if (!declared) values.LoadState = 'not-found'
      return { ok: true, code: 0, stdout: argv.slice(3).map(value => { const key = value.slice('--property='.length); return key + '=' + (values[key] ?? '') }).join('\n') + '\n', stderr: '' }
    }
    if (argv.length === 4 && argv[0] === '/usr/bin/systemctl' && argv[1] === 'start' && argv[2] === '--no-block' && /^xpanel-cron-[a-z0-9_-]+\.service$/.test(argv[3] ?? '')) {
      const unit = argv[3]!
      if (![...this.files.keys()].some(path => path.endsWith('/' + unit))) return { ok: false, code: 5, stdout: '', stderr: 'declared cron unit not found' }
      const current = this.units.get(unit) ?? { enabled: false, active: false, properties: {} }
      current.active = true
      this.units.set(unit, current)
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    return {
      ok: true,
      code: 0,
      stdout: `[jailshell] ${joined}\n`,
      stderr: '',
    }
  }

  async readSliceMetrics(uid: number): Promise<AccountSliceMetrics | null> {
    return (
      this.sliceMetrics.get(uid) ?? {
        uid,
        cpuUsageUsec: 0,
        memoryCurrentBytes: 0,
        ioReadBytes: 0,
        ioWriteBytes: 0,
        pidsCurrent: 0,
        ioMax: null,
      }
    )
  }
}

export interface LinuxExecutorOptions {
  timeoutMs?: number
  maxOutputBytes?: number
  sqlRunner?: (engine: 'mariadb' | 'postgresql', statements: string[]) => Promise<void>
  /** Reviewed root-owned host targets, supplied independently of desired state and render output. */
  trustedHostTargets?: readonly TrustedHostTarget[]
  /** Optional reviewed host target policy for daemon-managed system configuration roots. */
  trustedHostTargetMatcher?: (path: string, operation: HostTargetOperation) => boolean
}

const SYSTEM_CONFIG_PREFIXES: readonly string[] = [
  '/etc/nginx/',
  '/etc/apache2/',
  '/etc/php/',
  '/etc/xpanel/php-fpm/',
  '/etc/xpanel/ssl/',
  '/etc/xpanel/modsecurity/',
  '/etc/xpanel/userdata/',
  '/etc/xpanel/runtime/',
  '/etc/systemd/system/',
  '/run/systemd/system/',
  '/etc/sysctl.d/',
  '/etc/ssh/sshd_config.d/',
  '/etc/nftables.d/',
  '/etc/dovecot/',
  '/etc/postfix/',
  '/etc/opendkim/',
  '/etc/pure-ftpd/',
  '/etc/powerdns/',
  '/var/lib/powerdns/',
  '/var/lib/xpanel/acme/',
  '/var/lib/xpanel/staging/',
  '/var/cache/xpanel/',
  '/var/log/xpanel/',
  '/var/log/apache2/',
  '/var/log/nginx/',
  '/var/www/xpanel-default/',
  '/var/www/xpanel-acme/',
  '/usr/share/xpanel/',
  '/var/run/php/',
  '/run/php/',
  '/run/xpanel-fpm/',
]

const SYSTEM_EXACT_TARGETS = new Set<string>([
  '/usr/local/bin/xpanel-jailshell',
  '/opt/xpanel/bin/jailshell',
  '/etc/nginx',
  '/etc/apache2',
  '/etc/dovecot',
  '/etc/postfix',
  '/etc/opendkim',
  '/etc/opendkim.conf',
  '/etc/pure-ftpd',
  '/etc/powerdns',
  '/etc/xpanel/php-fpm',
  '/etc/xpanel/ssl',
  '/etc/xpanel/modsecurity',
  '/etc/xpanel/userdata',
  '/etc/xpanel/runtime',
  '/var/lib/powerdns',
  '/var/lib/powerdns/zones',
  '/var/lib/xpanel/acme',
  '/var/cache/xpanel',
  '/var/cache/xpanel/nginx',
  '/var/log/xpanel',
  '/var/log/xpanel/nginx',
  '/var/log/xpanel/apache',
  '/var/log/xpanel/php-fpm',
  '/var/log/apache2',
  '/var/log/nginx',
  '/var/www/xpanel-default',
  '/var/www/xpanel-acme',
  '/usr/share/xpanel',
  '/usr/share/xpanel/suspended',
  '/usr/share/xpanel/default',
  '/var/run/php',
  '/run/php',
  '/run/xpanel-fpm',
])

/** Read-only host facts. A path is granted only when it is listed here, and no other /proc path is readable. */
const HOST_MEASUREMENT_READS = new Set<string>([
  '/proc/loadavg', '/proc/meminfo', '/proc/uptime', '/proc/cpuinfo',
  '/proc/stat', '/proc/net/dev',
  '/proc/self/mountinfo',
  '/etc/os-release', '/usr/lib/os-release', '/opt/xpanel/VERSION',
  '/etc/hostname', '/etc/resolv.conf',
  '/run/reboot-required',
  '/sys/fs/cgroup/xpanel.slice/cgroup.subtree_control',
  '/sys/fs/cgroup/cgroup.subtree_control',
])

/** systemd drop-in directories such as user-<uid>.slice.d. The parent unit dir already exists. */
const SYSTEMD_DROPIN_DIR_RE = /\/[^/]+\.(?:slice|service|socket|timer)\.d$/

const isEnoent = (err: unknown): boolean => {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
  return err instanceof Error && err.message.includes('ENOENT')
}

const ACCOUNT_HOME_DIR_RE = /^\/home\/[a-z_][a-z0-9_-]{0,31}(?:\/(?:public_html|logs|tmp|mail|etc|ssl|\.ssh|cgi-bin))?$/
/** One mailbox Maildir root. Removal is recursive; nested cur/new/tmp paths are not separate grants. */
export const MAILDIR_BOX_RE = /^\/home\/[a-z_][a-z0-9_-]{0,31}\/mail\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** The per-domain directory that holds an account's Maildirs. */
const MAIL_DOMAIN_DIR_RE = /^\/home\/[a-z_][a-z0-9_-]{0,31}\/mail\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
/** A mailbox's active Sieve script; the writer walks the account-owned parents without following links. */
export const MAILBOX_SIEVE_RE = /^\/home\/[a-z_][a-z0-9_-]{0,31}\/mail\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/\.dovecot\.sieve$/
const ACCOUNT_MANAGED_WRAPPER_RE = /^\/home\/[a-z_][a-z0-9_-]{0,31}\/(?:cgi-bin\/php\.cgi|(?:public_html\/)?\.user\.ini)$/

/**
 * Reviewed production host-target policy for `xpanel-agent`: permits managed system config
 * roots and initial account directory scaffolding while refusing arbitrary tenant content I/O.
 */
export const createProductionHostTargetMatcher = (): ((path: string, operation: HostTargetOperation) => boolean) => {
  return (path: string, operation: HostTargetOperation): boolean => {
    if (HOST_MEASUREMENT_READS.has(path)) return operation === 'read'
    if (path === '/etc/xpanel/runtime.env' || path.startsWith('/etc/xpanel/runtime.env.bak.')) {
      return operation === 'read' || operation === 'write'
    }
    if (path === '/etc/xpanel/api.env') return operation === 'read'
    // Podman runtime state of a terminated account; its units are already stopped.
    if (/^\/run\/xpanel-ctr\/[a-z][a-z0-9]{0,15}$/.test(path)) return operation === 'remove'
    if (path === '/etc/xpanel/cron') return operation === 'ensure-directory'
    if (/^\/etc\/xpanel\/cron\/[a-z][a-z0-9]{0,15}$/.test(path)) return operation === 'ensure-directory'
    if (/^\/etc\/xpanel\/cron\/[a-z][a-z0-9]{0,15}\/[A-Za-z0-9_-]{1,64}\.command$/.test(path)) return operation === 'read' || operation === 'write' || operation === 'remove'
    if (path === '/var/lib/xpanel/backups' || path === '/var/lib/xpanel/backups/account-workspaces'
      || /^\/var\/lib\/xpanel\/backups\/account-workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[a-z][a-z0-9]{0,15})?$/.test(path)
      || path === '/run/xpanel/account-restores' || /^\/run\/xpanel\/account-restores\/[a-z][a-z0-9]{0,15}$/.test(path)) return operation === 'ensure-directory'
    if (/^\/home\/[a-z][a-z0-9]{0,15}\/\.xpanel-backup-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\.tar\.gz$/.test(path)
      || /^\/run\/xpanel\/account-restores\/[a-z][a-z0-9]{0,15}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tar\.gz$/.test(path)) return operation === 'remove'
    if (path === '/root/.ssh' || path === '/var/lib/xpanel-agent/security') return operation === 'ensure-directory'
    if (path === '/root/.ssh/authorized_keys' || path === '/var/lib/xpanel-agent/security/root-managed-keys.json' || path === '/var/lib/xpanel-agent/security/root-key-write.json') return operation === 'read' || operation === 'write' || operation === 'remove'
    if (/^\/root\/\.ssh\/authorized_keys\.bak\.[0-9]{17}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path)
      || /^\/var\/lib\/xpanel-agent\/security\/root-managed-keys\.json\.bak\.[0-9]{17}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path)) return operation === 'read' || operation === 'write'
    if (path === '/var/lib/xpanel/mail-quarantine' || /^\/var\/lib\/xpanel\/mail-quarantine\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/stage)?$/.test(path)) return operation === 'ensure-directory'
    if (/^\/var\/lib\/xpanel\/mail-quarantine\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/stage\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.eml$/.test(path)) return operation === 'write' || operation === 'read' || operation === 'remove'
    if (path === '/var/lib/xpanel/acme-account' || path === '/var/lib/xpanel/acme-orders') return operation === 'ensure-directory'
    if (path === '/var/lib/xpanel/acme-account/account-key.pem' || /^\/var\/lib\/xpanel\/acme-orders\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(path)) return operation === 'read' || operation === 'write'
    if (path === '/var/lib/xpanel-management-tls/status.json') return operation === 'read'
    if (/^\/etc\/xpanel\/management-certificates\/[a-f0-9]{64}\/fullchain\.pem$/.test(path)) return operation === 'read'
    if (path === '/home') return operation === 'ensure-directory'
    if (path === '/var/spool/postfix/opendkim') return operation === 'ensure-directory'
    if (path === '/etc/opendkim.conf' || path.startsWith('/etc/opendkim.conf.bak.')) {
      return operation === 'read' || operation === 'write'
    }
    if (['/etc/rspamd/local.d/actions.conf', '/etc/rspamd/local.d/greylist.conf', '/etc/rspamd/local.d/multimap.conf', '/etc/rspamd/local.d/xpanel_blocked_domains.map', '/etc/rspamd/local.d/settings.conf', '/etc/spamassassin/90-xpanel.cf', '/etc/mail/spamassassin/90-xpanel.cf'].includes(path)) return operation === 'read' || operation === 'write' || operation === 'remove'
    if (path === '/etc/spamassassin/local.cf' || path === '/etc/mail/spamassassin/local.cf') return operation === 'read'
    if (SYSTEM_EXACT_TARGETS.has(path)) return true
    if (SYSTEM_CONFIG_PREFIXES.some((prefix) => path.startsWith(prefix))) return true
    if (ACCOUNT_HOME_DIR_RE.test(path)) {
      return operation === 'ensure-directory' || operation === 'remove'
    }
    if (MAIL_DOMAIN_DIR_RE.test(path)) return operation === 'ensure-directory'
    if (MAILDIR_BOX_RE.test(path)) return operation === 'remove' || operation === 'ensure-directory'
    if (MAILBOX_SIEVE_RE.test(path)) return operation === 'read' || operation === 'write' || operation === 'remove'
    if (ACCOUNT_MANAGED_WRAPPER_RE.test(path)) {
      return operation === 'read' || operation === 'write' || operation === 'remove'
    }
    return false
  }
}

export type HostTargetOperation = 'read' | 'write' | 'remove' | 'ensure-directory'

export interface TrustedHostTarget {
  path: string
  operations: readonly HostTargetOperation[]
}

const HOST_TARGET_OPERATIONS = new Set<HostTargetOperation>(['read', 'write', 'remove', 'ensure-directory'])
const HOST_ACTION_KINDS: Readonly<Record<HostAction['kind'], true>> = {
  'ensure-group': true, 'ensure-user': true, 'delete-user': true, 'ensure-dir': true,
  'remove-path': true, 'set-quota': true, 'systemd-daemon-reload': true,
  systemd: true, 'systemd-set-property': true, exec: true, sql: true,
}

const assertTrustedTargetPath = (path: string): void => {
  if (typeof path !== 'string' || !path.isWellFormed() || /[\u0000-\u001f\u007f]/.test(path)) {
    fail('VALIDATION', 'trusted host target must be a canonical absolute local path')
  }
  const unix = posix.isAbsolute(path) && posix.normalize(path) === path && path !== '/' && !path.includes('\\') && !path.endsWith('/')
  const windows = /^[A-Za-z]:\\/.test(path) && win32.normalize(path) === path && path !== win32.parse(path).root && !path.endsWith('\\')
  if (!(process.platform === 'win32' ? windows : unix)) fail('VALIDATION', 'trusted host target must be a canonical absolute path for this host')
}

const assertMode = (mode: number): void => {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) fail('VALIDATION', 'host target mode must be in 0000..0777')
}

const assertOwnership = (owner: string | undefined, group: string | undefined): void => {
  if (owner === undefined && group === undefined) return
  if (typeof owner !== 'string' || owner.length === 0 || typeof group !== 'string' || group.length === 0) {
    return fail('VALIDATION', 'host target ownership requires both owner and group')
  }
  assertValidCommandArgv(['/usr/bin/id', '-u', '--', owner])
  assertValidCommandArgv(['/usr/bin/getent', '--', 'group', group])
  if (process.platform !== 'linux') fail('PRECONDITION_FAILED', 'host ownership operations require native Linux')
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

const execArgv = (
  argv: string[],
  opts: { timeoutMs?: number; maxBuffer?: number; skipSafeArgv?: boolean } = {},
): Promise<ConfigTestResult> => {
  if (!opts.skipSafeArgv) assertValidCommandArgv(argv)
  const [cmd, ...args] = argv
  if (!cmd) return fail('VALIDATION', 'argv must not be empty')
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, code: 0, stdout: String(stdout), stderr: String(stderr) })
          return
        }
        const code = typeof err.code === 'number' ? err.code : 1
        resolve({
          ok: false,
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr || err.message),
        })
      },
    )
  })
}

/**
 * Real Linux host executor using atomic file writes and argv-only child processes.
 */
export class LinuxHostExecutor implements AgentExecutor {
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly sqlRunner: ((engine: 'mariadb' | 'postgresql', statements: string[]) => Promise<void>) | undefined
  private readonly trustedHostTargets = new Map<string, ReadonlySet<HostTargetOperation>>()
  private readonly trustedHostTargetMatcher: ((path: string, operation: HostTargetOperation) => boolean) | undefined

  constructor(opts: LinuxExecutorOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.sqlRunner = opts.sqlRunner
    this.trustedHostTargetMatcher = opts.trustedHostTargetMatcher
    if (opts.sqlRunner !== undefined && typeof opts.sqlRunner !== 'function') {
      fail('VALIDATION', 'SQL runner must be a function')
    }
    for (const target of opts.trustedHostTargets ?? []) {
      assertTrustedTargetPath(target.path)
      if (this.trustedHostTargets.has(target.path) || !Array.isArray(target.operations) || target.operations.length === 0 ||
          target.operations.some((operation) => !HOST_TARGET_OPERATIONS.has(operation))) {
        fail('VALIDATION', 'trusted host target capabilities must be explicit and unique')
      }
      this.trustedHostTargets.set(target.path, new Set(target.operations))
    }
  }

  private requireHostTarget(path: string, operation: HostTargetOperation): void {
    assertTrustedTargetPath(path)
    if (!this.trustedHostTargets.get(path)?.has(operation) && !this.trustedHostTargetMatcher?.(path, operation)) {
      fail('PRECONDITION_FAILED', 'a reviewed exact host target capability is required; tenant I/O requires its confined runner', { operation })
    }
  }

  async preflight(plan: HostExecutionPlan): Promise<void> {
    const actions = [...plan.preActions, ...plan.postActions]
    if (actions.some((action) => !action || typeof action !== 'object' || !Object.hasOwn(HOST_ACTION_KINDS, action.kind))) {
      fail('VALIDATION', 'unknown host action in execution plan')
    }
    if (!this.sqlRunner && actions.some((action) => action.kind === 'sql')) {
      fail('PRECONDITION_FAILED', 'SQL execution requires a configured runner')
    }
    for (const file of plan.files) {
      this.requireHostTarget(file.path, 'read')
      this.requireHostTarget(file.path, 'write')
      this.requireHostTarget(file.path, 'remove')
      assertMode(file.mode)
      assertOwnership(file.owner, file.group)
      if (typeof file.content !== 'string') fail('VALIDATION', 'rendered host file content must be a string')
    }
    for (const action of actions) {
      if (action.kind === 'ensure-dir') {
        this.requireHostTarget(action.path, 'ensure-directory')
        assertMode(action.mode)
        assertOwnership(action.owner, action.group)
      } else if (action.kind === 'remove-path') {
        this.requireHostTarget(action.path, 'remove')
      }
    }
    if (process.platform !== 'linux' && actions.some((action) => action.kind !== 'sql')) {
      fail('PRECONDITION_FAILED', 'host system actions require native Linux')
    }
  }

  private async resolveOwnership(owner: string | undefined, group: string | undefined): Promise<{ uid: number; gid: number } | undefined> {
    assertOwnership(owner, group)
    if (owner === undefined || group === undefined) return undefined
    const parseId = (value: string): number => {
      if (!/^[0-9]+$/.test(value)) return fail('CONFIG_TEST_FAILED', 'host ownership lookup returned an invalid identifier')
      const id = Number(value)
      if (!Number.isSafeInteger(id) || id < 0 || id >= 0xffff_ffff) return fail('CONFIG_TEST_FAILED', 'host ownership identifier is out of range')
      return id
    }
    const lookup = async (argv: string[]): Promise<ConfigTestResult> => {
      const result = await execArgv(argv, { timeoutMs: this.timeoutMs, maxBuffer: this.maxOutputBytes })
      if (!result.ok) fail('CONFIG_TEST_FAILED', 'host target ownership could not be resolved')
      return result
    }
    const uid = /^[0-9]+$/.test(owner) ? parseId(owner) : parseId((await lookup(['/usr/bin/id', '-u', '--', owner])).stdout.trim())
    const groupRow = /^[0-9]+$/.test(group) ? undefined : (await lookup(['/usr/bin/getent', '--', 'group', group])).stdout.trim()
    const fields = groupRow?.split(':')
    if (fields && fields.length !== 4) fail('CONFIG_TEST_FAILED', 'host group lookup returned an invalid record')
    const gid = parseId(groupRow === undefined ? group : fields?.[2] ?? '')
    return { uid, gid }
  }

  /**
   * Creates a systemd drop-in directory (for example user-<uid>.slice.d) before the
   * atomic publish. The directory must already be an allowed ensure-directory target.
   */
  private async ensureSystemdDropInDir(dir: string): Promise<void> {
    this.requireHostTarget(dir, 'ensure-directory')
    await withPinnedHostTargetParent(dir, async target => {
      try {
        await mkdir(target, { mode: 0o755 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      await withOwnedHostFileHandle(await open(target, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)), async directory => {
        await directory.chmod(0o755)
      })
    })
  }

  /**
   * Publishes one file by writing a sibling temp, fsyncing it, and renaming it onto
   * the destination. A vanished temp under a drop-in directory is success when the
   * destination already has the intended bytes.
   */
  private async publishAtomicFile(
    file: RenderedFile,
    ownership: { uid: number; gid: number } | undefined,
    target: string,
  ): Promise<void> {
    const dir = dirname(file.path)
    const tmp = join(dirname(target), `.${randomUUID()}.tmp`)
    let published = false
    try {
      await withOwnedHostFileHandle(await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600), async fh => {
        const metadata = await fh.stat()
        if (!metadata.isFile() || metadata.nlink !== 1) fail('PRECONDITION_FAILED', 'managed temporary content must be a regular file without hard links')
        await fh.writeFile(file.content, 'utf8')
        if (ownership) await fh.chown(ownership.uid, ownership.gid)
        await fh.chmod(file.mode)
        await fh.sync()
      })
      await rename(tmp, target)
      published = true
    } catch (err) {
      if (isEnoent(err) && SYSTEMD_DROPIN_DIR_RE.test(dir)) {
        try {
          const current = await this.readFile(file.path)
          if (current === file.content) {
            published = true
            await rm(tmp, { force: true })
            return
          }
        } catch {
          // The destination was not readable; the original missing-temp error stands.
        }
      }
      throw err
    } finally {
      if (!published) await rm(tmp, { force: true })
    }
  }

  async writeFile(file: RenderedFile): Promise<void> {
    this.requireHostTarget(file.path, 'write')
    assertMode(file.mode)
    if (typeof file.content !== 'string') fail('VALIDATION', 'rendered host file content must be a string')
    const ownership = await this.resolveOwnership(file.owner, file.group)
    const dir = dirname(file.path)
    const dropIn = SYSTEMD_DROPIN_DIR_RE.test(dir)
    if (dropIn) await this.ensureSystemdDropInDir(dir)
    try {
      await withPinnedHostTargetParent(file.path, target => this.publishAtomicFile(file, ownership, target))
    } catch (err) {
      if (!dropIn || !isEnoent(err)) throw err
      await this.ensureSystemdDropInDir(dir)
      await withPinnedHostTargetParent(file.path, target => this.publishAtomicFile(file, ownership, target))
    }
  }

  async readFile(path: string): Promise<string | null> {
    this.requireHostTarget(path, 'read')
    try {
      const read = async (target: string): Promise<string> => {
        return withOwnedHostFileHandle(await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)), async fh => {
          const metadata = await fh.stat()
          if (!metadata.isFile() || (!HOST_MEASUREMENT_READS.has(path) && metadata.nlink !== 1)) fail('PRECONDITION_FAILED', 'managed host content must be a regular file without hard links')
          return await fh.readFile('utf8')
        })
      }
      return HOST_MEASUREMENT_READS.has(path) ? await read(path) : await withPinnedHostTargetParent(path, read)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async removePath(path: string): Promise<void> {
    this.requireHostTarget(path, 'remove')
    try {
      await withPinnedHostTargetParent(path, async target => {
        if (MAILDIR_BOX_RE.test(path)) {
          await removePinnedHostTree(target)
          return
        }
        try {
          await unlink(target)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT') return
          if (code !== 'EISDIR' && code !== 'EPERM') throw error
          await rmdir(target)
        }
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  /** Absence is positive ENOENT evidence, never a failed subprocess predicate. */
  async probeRemovalTarget(path: string): Promise<'present' | 'absent' | 'unknown'> {
    this.requireHostTarget(path, 'remove')
    try {
      await lstat(path)
      return 'present'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown'
    }
  }

  runTest(test: ConfigTest): Promise<ConfigTestResult> {
    return execArgv(test.argv, { timeoutMs: this.timeoutMs, maxBuffer: this.maxOutputBytes })
  }

  runCommand(argv: string[]): Promise<ConfigTestResult> {
    return execArgv(argv, { timeoutMs: this.timeoutMs, maxBuffer: this.maxOutputBytes })
  }

  async runAction(action: HostAction): Promise<void> {
    switch (action.kind) {
      case 'ensure-group': {
        const res = await execArgv(['/usr/sbin/groupadd', '-f', '-g', String(action.gid), action.name])
        if (!res.ok) fail('CONFIG_TEST_FAILED', `groupadd ${action.name} failed: ${res.stderr}`)
        return
      }
      case 'ensure-user': {
        const check = await execArgv(['/usr/bin/id', '-u', action.name])
        if (!check.ok) {
          const add = await execArgv([
            '/usr/sbin/useradd',
            '-u',
            String(action.uid),
            '-g',
            String(action.gid),
            '-d',
            action.home,
            '-s',
            action.shell,
            '-M',
            action.name,
          ])
          if (!add.ok) fail('CONFIG_TEST_FAILED', `useradd ${action.name} failed: ${add.stderr}`)
        } else {
          const mod = await execArgv(['/usr/sbin/usermod', '-s', action.shell, '-d', action.home, action.name])
          if (!mod.ok) fail('CONFIG_TEST_FAILED', `usermod ${action.name} failed: ${mod.stderr}`)
        }
        return
      }
      case 'delete-user': {
        const res = await execArgv(['/usr/sbin/userdel', action.name])
        if (!res.ok && !res.stderr.includes('does not exist')) {
          fail('CONFIG_TEST_FAILED', `userdel ${action.name} failed: ${res.stderr}`)
        }
        return
      }
      case 'ensure-dir': {
        this.requireHostTarget(action.path, 'ensure-directory')
        assertMode(action.mode)
        const ownership = await this.resolveOwnership(action.owner, action.group)
        await withPinnedHostTargetParent(action.path, async target => {
          try {
            await mkdir(target, { mode: action.mode })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          }
          await withOwnedHostFileHandle(await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), async directory => {
            if (ownership) await directory.chown(ownership.uid, ownership.gid)
            await directory.chmod(action.mode)
          })
        })
        return
      }
      case 'remove-path':
        await this.removePath(action.path)
        return
      case 'set-quota': {
        await applyObservedUserQuota(argv => {
          assertValidCommandArgv(argv)
          // quotaon --print-state deliberately exits 1 when user accounting is active.
          // Keep its real stderr separate from execFile's generic nonzero-exit message.
          return new Promise<ConfigTestResult>(resolve => execFile('/usr/bin/env', ['LC_ALL=C', ...argv], {
            timeout: this.timeoutMs, maxBuffer: this.maxOutputBytes, windowsHide: true,
          }, (error, stdout, stderr) => {
            const code = error?.killed || error?.signal ? 124 : !error ? 0 : typeof error.code === 'number' ? error.code : 127
            resolve({ ok: code === 0, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
          }))
        }, action)
        return
      }
      case 'systemd-daemon-reload': {
        const res = await execArgv(['/usr/bin/systemctl', 'daemon-reload'])
        if (!res.ok) fail('CONFIG_TEST_FAILED', `systemctl daemon-reload failed: ${res.stderr}`)
        return
      }
      case 'systemd': {
        const res = await execArgv(['/usr/bin/systemctl', action.verb, action.unit])
        if (!res.ok && action.verb !== 'stop' && action.verb !== 'disable') {
          fail('CONFIG_TEST_FAILED', `systemctl ${action.verb} ${action.unit} failed: ${res.stderr}`)
        }
        return
      }
      case 'systemd-set-property': {
        assertValidCommandArgv(['/usr/bin/systemctl', 'set-property', action.unit])
        const pairs = Object.entries(action.properties).map(([k, v]) => {
          const pair = `${k}=${v}`
          // systemd accepts device paths (including /dev/block/<major>:<minor>) and comma-separated
          // CPU lists in these properties; rejecting them stranded valid IO/CPU limits.
          if (!/^[A-Za-z][A-Za-z0-9]*=[A-Za-z0-9%/._ :,+-]*$/.test(pair)) {
            fail('VALIDATION', 'unsafe systemd property assignment')
          }
          return pair
        })
        const res = await execArgv(['/usr/bin/systemctl', 'set-property', action.unit, ...pairs], { skipSafeArgv: true })
        if (!res.ok) fail('CONFIG_TEST_FAILED', `systemctl set-property ${action.unit} failed: ${res.stderr}`)
        return
      }
      case 'exec': {
        const argv = action.runAsUser ? ['/usr/sbin/runuser', '-u', action.runAsUser, '--', ...action.argv] : action.argv
        const res = await execArgv(argv)
        if (!res.ok) fail('CONFIG_TEST_FAILED', `exec ${action.argv[0]} failed: ${res.stderr}`)
        return
      }
      case 'sql': {
        if (!this.sqlRunner) return fail('PRECONDITION_FAILED', 'SQL execution requires a configured runner')
        await this.sqlRunner(action.engine, [...action.statements])
        return
      }
      default:
        return fail('VALIDATION', 'unknown host action')
    }
  }

  async readSliceMetrics(uid: number): Promise<AccountSliceMetrics | null> {
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid >= 0xffff_ffff) fail('VALIDATION', 'account cgroup metrics require a valid non-root UID')
    const candidates = [
      `/sys/fs/cgroup/xpanel.slice/xpanel-${uid}.slice`,
      `/sys/fs/cgroup/xpanel-${uid}.slice`,
    ]
    let base: string | null = null
    for (const candidate of candidates) {
      try {
        await stat(`${candidate}/memory.current`)
        base = candidate
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
    if (!base) return null
    const readText = async (name: string): Promise<string | null> => {
      try {
        return await readFile(`${base}/${name}`, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }
    const [cpuStat, memCur, ioStat, pidsCur, ioMax, memoryMax, pidsMax, cpuMax] = await Promise.all([
      readText('cpu.stat'),
      readText('memory.current'),
      readText('io.stat'),
      readText('pids.current'),
      readText('io.max'),
      readText('memory.max'),
      readText('pids.max'),
      readText('cpu.max'),
    ])
    if (cpuStat === null || memCur === null || pidsCur === null) return null
    const cpuMatch = /^usage_usec\s+(\d+)/m.exec(cpuStat)
    let ioReadBytes = 0
    let ioWriteBytes = 0
    for (const line of (ioStat ?? '').split('\n')) {
      const r = /\brbytes=(\d+)/.exec(line)
      const w = /\bwbytes=(\d+)/.exec(line)
      if (r) ioReadBytes += Number(r[1])
      if (w) ioWriteBytes += Number(w[1])
    }
    return {
      uid,
      cpuUsageUsec: cpuMatch ? Number(cpuMatch[1]) : 0,
      memoryCurrentBytes: Number(memCur.trim()) || 0,
      ioReadBytes,
      ioWriteBytes,
      pidsCurrent: Number(pidsCur.trim()) || 0,
      ioMax,
      memoryMax,
      pidsMax,
      cpuMax,
    }
  }
}
