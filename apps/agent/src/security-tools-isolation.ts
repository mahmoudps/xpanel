import { lstat } from 'node:fs/promises'
import { effectivePlan } from '@xpanel/core'
import type { Account, Domain, Plan, ResourceLimits, ShellJailPolicy } from '@xpanel/core'
import { system } from '@xpanel/render'
import type { AgentExecutor } from './executor.ts'
import { compareAccountLimits } from './limit-gaps.ts'
import { accountSliceShowArgv, fpmUnitShowArgv, getentPasswdArgv } from '../../../packages/os/src/security-tools-command.ts'
import { SHELL_JAIL_LIST_HOMES, SHELL_JAIL_LIST_TMP, shellJailProbeArgv } from '../../../packages/os/src/ssh-host-command.ts'

export type IsolationCheckState = 'ok' | 'drift' | 'unavailable'
export interface IsolationCheck { id: string; state: IsolationCheckState; expected: string | null; observed: string | null }
export interface IsolationReport {
  username: string
  uid: number
  status: string
  observedAt: string
  state: IsolationCheckState
  counts: Record<IsolationCheckState, number>
  checks: IsolationCheck[]
}
export interface HomeFacts { type: 'directory' | 'symlink' | 'other'; uid: number; gid: number; mode: number }
export type InspectHome = (path: string) => Promise<HomeFacts | null>
export type IsolationExecutor = Pick<AgentExecutor, 'runCommand' | 'readSliceMetrics'>

const UNLIMITED: ResourceLimits = { diskMb: 'unlimited', bandwidthMbMonth: 'unlimited', ioReadBps: 'unlimited', ioWriteBps: 'unlimited', ioReadIops: 'unlimited', ioWriteIops: 'unlimited', memoryMb: 'unlimited', maxProcesses: 'unlimited', cpuPercent: 'unlimited' }
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const shown = (value: string | null | undefined): string | null => typeof value === 'string' ? value.trim().slice(0, 256).replace(new RegExp(UNSAFE.source, 'g'), ' ') : null
const octal = (mode: number): string => '0' + (mode & 0o7777).toString(8).padStart(3, '0')

/** lstat only: the home itself is never followed, opened or listed. */
export const inspectAccountHome: InspectHome = async path => {
  try {
    const facts = await lstat(path)
    return { type: facts.isSymbolicLink() ? 'symlink' : facts.isDirectory() ? 'directory' : 'other', uid: facts.uid, gid: facts.gid, mode: facts.mode & 0o7777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** systemctl(1) show: one Key=Value per line, unordered. */
const showValues = (stdout: string): Map<string, string> => new Map(stdout.split('\n').flatMap(line => { const split = line.indexOf('='); return split > 0 ? [[line.slice(0, split), line.slice(split + 1).trim()] as [string, string]] : [] }))
const run = async (executor: IsolationExecutor, argv: string[]): Promise<{ ok: boolean; code: number; stdout: string } | null> => {
  try { const result = await executor.runCommand(argv); return typeof result?.stdout === 'string' && Buffer.byteLength(result.stdout) <= 64 * 1024 ? result : null } catch { return null }
}

export interface ShellJailProof { username: string; observedAt: string; checks: IsolationCheck[] }

/** Runs each read as the account through its login shell, so the proof sees what an SSH login sees. */
export async function verifyShellJail(input: { account: Pick<Account, 'username'>; others: readonly Pick<Account, 'username' | 'home'>[]; policy: ShellJailPolicy; executor: IsolationExecutor; now?: () => Date }): Promise<ShellJailProof> {
  const { account, policy, executor } = input, user = account.username, checks: IsolationCheck[] = []
  const exempt = policy.exceptions.some(entry => entry.username === user)
  const homes = await run(executor, shellJailProbeArgv(user, SHELL_JAIL_LIST_HOMES))
  const names = homes?.ok ? homes.stdout.split('\n').filter(Boolean) : null
  const foreign = names?.filter(name => name !== user) ?? []
  checks.push({ id: 'jail-home-list', state: !homes ? 'unavailable' : foreign.length ? 'drift' : 'ok', expected: 'no other account', observed: !homes ? null : names === null ? 'denied' : foreign.length + ' other' })
  const other = input.others.find(item => item.username !== user)
  const read = other ? await run(executor, shellJailProbeArgv(user, 'ls -A ' + other.home)) : null
  checks.push({ id: 'jail-other-home', state: !read ? 'unavailable' : read.ok ? 'drift' : 'ok', expected: 'denied', observed: !other ? 'no other account' : !read ? null : read.ok ? 'readable' : 'denied' })
  if (policy.privateTmp && !exempt) {
    const tmp = await run(executor, shellJailProbeArgv(user, SHELL_JAIL_LIST_TMP))
    checks.push({ id: 'jail-private-tmp', state: !tmp?.ok ? 'unavailable' : tmp.stdout.trim() ? 'drift' : 'ok', expected: 'empty', observed: !tmp?.ok ? null : tmp.stdout.trim() ? 'shared' : 'empty' })
  }
  return { username: user, observedAt: (input.now?.() ?? new Date()).toISOString(), checks }
}

/** Read-only comparison of the isolation controls xPanel renders for one account against its plan. */
export async function readAccountIsolation(input: {
  account: Account; plan: Plan | null; domains: readonly Domain[]; executor: IsolationExecutor; inspectHome?: InspectHome; ioDevices?: readonly string[] | null; now?: () => Date
}): Promise<IsolationReport> {
  const { account, plan, executor } = input
  const checks: IsolationCheck[] = []
  const check = (id: string, state: IsolationCheckState, expected: string | null, observed: string | null): void => { checks.push({ id, state, expected, observed: shown(observed) }) }

  // getent(1): passwd entries are name:password:UID:GID:GECOS:directory:shell; exit 2 means the key was not found.
  const passwd = await run(executor, getentPasswdArgv(account.username))
  const fields = passwd?.ok && passwd.code === 0 ? passwd.stdout.trim().split(':') : null
  const entry = fields && fields.length === 7 && fields[0] === account.username ? fields : null
  const identity = `${account.uid}:${account.gid} ${account.home}`
  if (entry) check('passwd', `${entry[2]}:${entry[3]} ${entry[5]}` === identity ? 'ok' : 'drift', identity, `${entry[2]}:${entry[3]} ${entry[5]}`)
  else check('passwd', passwd && !passwd.ok && passwd.code === 2 ? 'drift' : 'unavailable', identity, passwd && !passwd.ok && passwd.code === 2 ? 'absent' : null)
  const shell = plan ? system.effectiveShell(account, plan) : null
  check('shell', !entry || !shell ? 'unavailable' : entry[6] === shell ? 'ok' : 'drift', shell, entry?.[6] ?? null)

  const expectedHome = `directory ${account.uid}:${account.gid} ${octal(system.ACCOUNT_DIRS[0]!.mode)}`
  let home: HomeFacts | null | undefined
  try { home = await (input.inspectHome ?? inspectAccountHome)(account.home) } catch { home = undefined }
  const observedHome = home === undefined ? null : home === null ? 'absent' : `${home.type} ${home.uid}:${home.gid} ${octal(home.mode)}`
  check('home', home === undefined ? 'unavailable' : observedHome === expectedHome ? 'ok' : 'drift', expectedHome, observedHome)

  const slice = await run(executor, accountSliceShowArgv(account.uid))
  const sliceValues = slice?.ok ? showValues(slice.stdout) : null
  const loadState = sliceValues?.get('LoadState')
  check('slice', !loadState ? 'unavailable' : loadState === 'loaded' ? 'ok' : 'drift', 'loaded', loadState ? `${loadState} ${sliceValues!.get('ActiveState') ?? ''}` : null)

  // Kernel-effective cgroup v2 limits; a slice with no running unit has no cgroup to read.
  let metrics: Awaited<ReturnType<IsolationExecutor['readSliceMetrics']>> | undefined
  try { metrics = await executor.readSliceMetrics(account.uid) } catch { metrics = undefined }
  const resources = plan ? effectivePlan(plan, account).resources : undefined
  const limit = (id: string, raw: string | null | undefined, expected: string, finite: boolean, subset: Partial<ResourceLimits>, unlimitedOk: (value: string) => boolean): void => {
    const value = raw?.trim() ?? null
    if (!resources || !metrics || value === null) return check(id, 'unavailable', expected, metrics === null ? 'not active' : value)
    const comparison = compareAccountLimits({ ...UNLIMITED, ...subset }, { memoryMax: metrics.memoryMax ?? null, pidsMax: metrics.pidsMax ?? null, cpuMax: metrics.cpuMax ?? null, ioMax: metrics.ioMax ?? null, diskQuotaHardKb: null, ioDevices: input.ioDevices ?? null })
    const state: IsolationCheckState = finite ? comparison.unavailable ? 'unavailable' : comparison.gaps.length ? 'drift' : 'ok' : unlimitedOk(value) ? 'ok' : 'drift'
    check(id, state, expected, value === '' ? 'none' : value)
  }
  if (resources) {
    const { memoryMb, maxProcesses, cpuPercent, ioReadBps, ioWriteBps, ioReadIops, ioWriteIops } = resources
    limit('memory', metrics?.memoryMax, memoryMb === 'unlimited' ? 'max' : String(memoryMb * 1024 * 1024), memoryMb !== 'unlimited', { memoryMb }, value => value === 'max')
    limit('processes', metrics?.pidsMax, maxProcesses === 'unlimited' ? 'max' : String(maxProcesses), maxProcesses !== 'unlimited', { maxProcesses }, value => value === 'max')
    limit('cpu', metrics?.cpuMax, cpuPercent === 'unlimited' ? 'max' : cpuPercent + '%', cpuPercent !== 'unlimited', { cpuPercent }, value => value.split(/\s+/)[0] === 'max')
    const io = { ioReadBps, ioWriteBps, ioReadIops, ioWriteIops }
    const ioFinite = Object.values(io).some(value => value !== 'unlimited')
    limit('io', metrics?.ioMax ?? (metrics ? '' : null), ioFinite ? Object.entries(io).map(([key, value]) => key + '=' + value).join(' ') : 'max', ioFinite, io, value => value.split(/\s+/).every(token => token === '' || /^\d+:\d+$/.test(token) || /=max$/.test(token)))
  } else check('plan', 'unavailable', account.planId, null)

  const versions = [...new Set(input.domains.filter(domain => domain.accountId === account.id && domain.siteType === 'php' && domain.php.handler === 'fpm').map(domain => domain.php.version))].sort()
  const expectedFpm = `User=${account.username} Group=${account.username} Slice=${system.accountSliceName(account.uid)}`
  for (const version of versions.slice(0, 16)) {
    let argv: string[]
    try { argv = fpmUnitShowArgv(account.username, version) } catch { check('fpm-' + version, 'unavailable', expectedFpm, null); continue }
    const result = await run(executor, argv)
    const values = result?.ok ? showValues(result.stdout) : null
    const state = values?.get('LoadState')
    const observed = !state ? null : state !== 'loaded' ? state : `User=${values!.get('User') ?? ''} Group=${values!.get('Group') ?? ''} Slice=${values!.get('Slice') ?? ''}`
    check('fpm-' + version, !state ? 'unavailable' : observed === expectedFpm ? 'ok' : 'drift', expectedFpm, observed)
  }

  const counts = { ok: 0, drift: 0, unavailable: 0 }
  for (const item of checks) counts[item.state]++
  return { username: account.username, uid: account.uid, status: account.status, observedAt: (input.now?.() ?? new Date()).toISOString(),
    state: counts.drift ? 'drift' : counts.unavailable ? 'unavailable' : 'ok', counts, checks }
}
