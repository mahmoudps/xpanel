// Account isolation on the host: one UID/GID per account, a closed home, and a disk quota.
// The account group holds only the account. Apache reaches files as the account through mpm_itk and
// Nginx never reads homes, so neither web server user may ever be added to it.

import { fail, RESOURCE_RULES } from '@xpanel/core'
import type { Account, HostAction, Limit, OsProfile, Plan } from '@xpanel/core'
import { accountSliceName, sliceControlDirs } from './slice.ts'
import { appEnvDir, fpmAccountLogDir, fpmPaths, loginSliceDropinPath } from './units.ts'
import {
  assertAbsPath,
  assertAccountHome,
  assertAccountIdentity,
  assertLimit,
  assertMountPoint,
  assertUsername,
  invalid,
} from './validate.ts'

export const NOLOGIN_SHELL = '/usr/sbin/nologin'
export const DEFAULT_JAIL_SHELL = '/opt/xpanel/bin/jailshell'

/** Largest disk quota whose KiB block count is still an exact integer (about 8 EiB). */
export const MAX_DISK_MB = Math.min(RESOURCE_RULES.diskMb.max, Math.floor(Number.MAX_SAFE_INTEGER / 1024))

export interface AccountDir {
  /** relative to home, '' is the home itself */
  rel: string
  mode: number
}

export const ACCOUNT_DIRS: readonly AccountDir[] = [
  { rel: '', mode: 0o750 },
  { rel: 'public_html', mode: 0o750 },
  { rel: 'tmp', mode: 0o700 },
  { rel: 'logs', mode: 0o750 },
  { rel: 'mail', mode: 0o700 },
]

export interface ProvisionOptions {
  /** mount point that holds the homes, or null when that filesystem has no quota support */
  quotaFilesystem: string | null
  /** login shell for jailed accounts */
  jailShell?: string
  homeBases?: string[]
}

/**
 * Jailed only when both the plan and the account allow it, and never while suspended. `/usr/sbin/nologin`
 * exists on both families because Ubuntu 22.04+ and EL9+ are usr-merged.
 */
export const effectiveShell = (account: Pick<Account, 'shell' | 'status'>, plan: Pick<Plan, 'shell'>, jailShell = DEFAULT_JAIL_SHELL): string =>
  account.status === 'active' && account.shell === 'jailed' && plan.shell === 'jailed'
    ? assertAbsPath('jailShell', jailShell)
    : NOLOGIN_SHELL

/**
 * Plan disk (MB) -> setquota block limits (1 KiB blocks). Soft equals hard: a soft limit below the cap
 * would, once the grace period ends, permanently withhold part of the space the plan sells.
 * Unlimited is 0/0, which setquota(8) defines as "no limit", so a plan change to unlimited really
 * clears the old quota. A finite 0 MB plan is rejected because it would mean the same 0/0.
 */
export const quotaBlocksKb = (diskMb: Limit): { blockSoftKb: number; blockHardKb: number } => {
  const mb = assertLimit('diskMb', diskMb, Math.max(1, RESOURCE_RULES.diskMb.min), MAX_DISK_MB)
  if (mb === 'unlimited') return { blockSoftKb: 0, blockHardKb: 0 }
  return { blockSoftKb: mb * 1024, blockHardKb: mb * 1024 }
}

export const accountProvisionActions = (account: Account, plan: Plan, os: OsProfile, opts: ProvisionOptions): HostAction[] => {
  const id = assertAccountIdentity(account, os)
  const { home } = assertAccountHome(account.home, id.username, opts.homeBases)
  if (account.status === 'terminating') {
    return fail('PRECONDITION_FAILED', `account ${id.username} is being terminated`, { username: id.username })
  }
  if (plan.id !== account.planId) return invalid('plan does not belong to this account', { planId: plan.id, accountPlanId: account.planId })

  const actions: HostAction[] = [
    { kind: 'ensure-group', name: id.username, gid: id.gid },
    { kind: 'ensure-user', name: id.username, uid: id.uid, gid: id.gid, home, shell: effectiveShell(account, plan, opts.jailShell) },
    ...ACCOUNT_DIRS.map((d): HostAction => ({
      kind: 'ensure-dir',
      path: d.rel ? `${home}/${d.rel}` : home,
      mode: d.mode,
      owner: id.username,
      group: id.username,
    })),
  ]
  const quota = quotaBlocksKb(plan.resources.diskMb)
  if (opts.quotaFilesystem !== null) {
    actions.push({ kind: 'set-quota', user: id.username, ...quota, filesystem: assertMountPoint('quotaFilesystem', opts.quotaFilesystem) })
  }
  return actions
}

const ACCOUNT_UNIT_RE = /^xpanel-(php-fpm|app|cron)-([a-z][a-z0-9]{0,15})-([a-z0-9][a-z0-9.-]{0,40})\.(service|timer)$/
const SHORT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** True only for units xPanel renders for this account. Usernames have no dash, so the match is exact. */
export const isAccountUnit = (username: string, unit: string): boolean => {
  const m = ACCOUNT_UNIT_RE.exec(unit)
  if (!m || m[2] !== username) return false
  const rest = m[3] ?? ''
  if (m[1] === 'php-fpm') return m[4] === 'service' && /^[5-9]\.[0-9]{1,2}$/.test(rest)
  if (!SHORT_NAME_RE.test(rest)) return false
  return m[1] === 'cron' || m[4] === 'service'
}

export interface TerminateOptions {
  /** must repeat the account username, as typed in the confirmation dialog */
  confirmUsername: string
  /** xPanel units of this account (FPM, apps, cron timers and services) */
  units?: string[]
  /** os.paths.systemdDir when omitted */
  systemdDir?: string
  homeBases?: string[]
  /** when set, the quota entry is cleared before the user goes, so a reused UID starts clean */
  quotaFilesystem?: string | null
}

const FPM_UNIT_RE = /^xpanel-php-fpm-[a-z][a-z0-9]*-([0-9.]+)\.service$/

/**
 * Removal plan for an account that the API already moved to `terminating`. Refuses unless the caller
 * repeats the username. Order: stop timers (so they cannot start a job again) and then the other units,
 * stop both slices, remove unit files, FPM configs/logs/runtime dirs, app env files and the
 * set-property drop-ins (they would otherwise give a reused UID the old limits), reload, clear the
 * quota, delete the user, and remove the home last so a failed userdel leaves the data in place.
 * Executors must treat stopping an already-inactive unit as success.
 */
export const accountTerminateActions = (account: Account, os: OsProfile, opts: TerminateOptions): HostAction[] => {
  const id = assertAccountIdentity(account, os)
  const { home } = assertAccountHome(account.home, id.username, opts.homeBases)
  if (opts.confirmUsername !== id.username) {
    return fail('PRECONDITION_FAILED', 'termination needs explicit confirmation with the account username', { username: id.username })
  }
  if (account.status !== 'terminating') {
    return fail('PRECONDITION_FAILED', `account ${id.username} is not marked terminating`, { status: account.status })
  }
  const systemdDir = assertAbsPath('systemdDir', opts.systemdDir ?? os.paths.systemdDir)
  const requested = [...new Set(opts.units ?? [])]
  for (const u of requested) {
    if (typeof u !== 'string' || !isAccountUnit(id.username, u)) return invalid(`unit ${String(u)} does not belong to ${id.username}`, { unit: u })
  }
  const units = [...requested.filter((u) => u.endsWith('.timer')), ...requested.filter((u) => !u.endsWith('.timer'))]
  const fpmVersions = units.map((u) => FPM_UNIT_RE.exec(u)?.[1]).filter((v): v is string => v !== undefined)

  const actions: HostAction[] = []
  for (const unit of units) {
    actions.push({ kind: 'systemd', verb: 'stop', unit }, { kind: 'systemd', verb: 'disable', unit })
  }
  actions.push(
    { kind: 'systemd', verb: 'stop', unit: accountSliceName(id.uid) },
    { kind: 'systemd', verb: 'stop', unit: `user-${id.uid}.slice` },
  )
  for (const unit of units) actions.push({ kind: 'remove-path', path: `${systemdDir}/${unit}` })
  actions.push(
    { kind: 'remove-path', path: `${systemdDir}/${accountSliceName(id.uid)}` },
    ...sliceControlDirs(id.uid).map((path): HostAction => ({ kind: 'remove-path', path })),
    { kind: 'remove-path', path: loginSliceDropinPath(id.uid, systemdDir) },
    ...fpmVersions.flatMap((v): HostAction[] => {
      const p = fpmPaths(id.username, v)
      return [p.config, p.pool, p.socketDir].map((path): HostAction => ({ kind: 'remove-path', path }))
    }),
    { kind: 'remove-path', path: fpmAccountLogDir(id.username) },
    { kind: 'remove-path', path: appEnvDir(id.username) },
    { kind: 'systemd-daemon-reload' },
  )
  if (opts.quotaFilesystem) {
    actions.push({ kind: 'set-quota', user: id.username, blockSoftKb: 0, blockHardKb: 0, filesystem: assertMountPoint('quotaFilesystem', opts.quotaFilesystem) })
  }
  actions.push({ kind: 'delete-user', name: id.username }, { kind: 'remove-path', path: home })
  return actions
}

/**
 * Audits /etc/group content: returns `group:member` for every account group that lists the Apache or
 * Nginx user. Any hit breaks the isolation model and must be fixed before serving.
 */
export const findWebServerInAccountGroups = (etcGroup: string, usernames: readonly string[], os: Pick<OsProfile, 'paths'>): string[] => {
  const accounts = new Set(usernames.map((u) => assertUsername(u)))
  const web = new Set([os.paths.apacheUser, os.paths.nginxUser])
  const leaks: string[] = []
  for (const line of String(etcGroup).split('\n')) {
    const [name = '', , , members = ''] = line.trim().split(':')
    if (!accounts.has(name)) continue
    for (const m of members.split(',').map((s) => s.trim())) if (web.has(m)) leaks.push(`${name}:${m}`)
  }
  return leaks
}
