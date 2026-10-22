// Account slice xpanel-<uid>.slice: every long-running account process lives here (FPM, apps, cron).
// The dash makes it a child of xpanel.slice, so all accounts share one parent in the cgroup tree.
//
// How each plan value reaches systemd (systemd.resource-control(5)):
//
//   field         finite                      unlimited (file)          unlimited (set-property)
//   memoryMb      MemoryMax=<n>M              MemoryMax=infinity        MemoryMax=infinity
//                 MemoryHigh=<90%>M           MemoryHigh=infinity       MemoryHigh=infinity
//                 MemorySwapMax=0             MemorySwapMax=infinity    MemorySwapMax=infinity
//   maxProcesses  TasksMax=<n>                TasksMax=infinity         TasksMax=infinity
//   cpuPercent    CPUQuota=<n>%               (line omitted)            CPUQuota= (empty resets)
//   io*           IO*Max=<dev> <n> per device (line omitted)            IO*Max=<dev> infinity
//
// Unlimited is written as `infinity` wherever systemd accepts it so a runtime update from a finite
// value back to unlimited really clears the old limit. IO lines are omitted from the file because an
// absent IO*Max means no throttling, while set-property must say `infinity` per device to undo one.
//
// MemorySwapMax=0 for a finite plan: cgroup v2 counts swap apart from memory.max, so any swap allowance
// would let the account hold its plan memory plus that much more, paid for in host swap I/O.

import { RESOURCE_RULES } from '@xpanel/core'
import type { Account, HostAction, Limit, RenderedFile, ResourceLimits } from '@xpanel/core'
import { assertAbsPath, assertAccountIdentity, assertLimit, invalid, toSystemdIoDevice } from './validate.ts'

export const SYSTEMD_UNIT_DIR = '/etc/systemd/system'
/** Where `systemctl set-property` keeps its drop-ins (persistent and --runtime). */
export const SYSTEMD_CONTROL_DIRS: readonly string[] = ['/etc/systemd/system.control', '/run/systemd/system.control']

export interface CgroupControllers {
  cpu: boolean
  memory: boolean
  pids: boolean
  io: boolean
}

export const ALL_CONTROLLERS: CgroupControllers = { cpu: true, memory: true, pids: true, io: true }

export interface SliceOptions {
  /** os.paths.systemdDir; defaults to /etc/systemd/system, which systemd defines on every distro */
  systemdDir?: string
  /** from parseCgroupControllers(/sys/fs/cgroup/cgroup.controllers) */
  controllers?: CgroupControllers
}

export type SliceField = 'memoryMb' | 'maxProcesses' | 'cpuPercent' | 'ioReadBps' | 'ioWriteBps' | 'ioReadIops' | 'ioWriteIops'

export const SLICE_FIELDS: readonly SliceField[] = [
  'memoryMb', 'maxProcesses', 'cpuPercent', 'ioReadBps', 'ioWriteBps', 'ioReadIops', 'ioWriteIops',
]

/** What the quota page shows per field. `applied: false` means "not enforced" on this host. */
export type FieldEnforcement =
  | { applied: true; unlimited: boolean; value: string }
  | { applied: false; reason: 'controller-unavailable' | 'no-io-device' }

/** Largest MemoryMax= systemd can hold: <n>M must stay below 2^64 bytes. */
const SYSTEMD_MEMORY_MAX_MB = 2 ** 44 - 1

/**
 * Core's plan bounds (RESOURCE_RULES), so every plan the API accepts renders. Memory is further capped
 * at what a 64-bit byte count can express.
 */
export const SLICE_BOUNDS: Readonly<Record<SliceField, { min: number; max: number }>> = {
  memoryMb: { min: RESOURCE_RULES.memoryMb.min, max: Math.min(RESOURCE_RULES.memoryMb.max, SYSTEMD_MEMORY_MAX_MB) },
  maxProcesses: RESOURCE_RULES.maxProcesses,
  cpuPercent: RESOURCE_RULES.cpuPercent,
  ioReadBps: RESOURCE_RULES.ioReadBps,
  ioWriteBps: RESOURCE_RULES.ioWriteBps,
  ioReadIops: RESOURCE_RULES.ioReadIops,
  ioWriteIops: RESOURCE_RULES.ioWriteIops,
}

const IO_KEYS = [
  ['ioReadBps', 'IOReadBandwidthMax'],
  ['ioWriteBps', 'IOWriteBandwidthMax'],
  ['ioReadIops', 'IOReadIOPSMax'],
  ['ioWriteIops', 'IOWriteIOPSMax'],
] as const

interface SlicePlan {
  lines: string[]
  scalarProps: Record<string, string>
  deviceProps: Record<string, string>[]
  enforcement: Record<SliceField, FieldEnforcement>
}

export const accountSliceName = (uid: number): string => `xpanel-${uid}.slice`

/** set-property drop-in directories of the account slice; they override the rendered file. */
export const sliceControlDirs = (uid: number): string[] => SYSTEMD_CONTROL_DIRS.map((d) => `${d}/${accountSliceName(uid)}.d`)

const normalizeDevices = (ioDevices: readonly unknown[]): string[] => {
  if (!Array.isArray(ioDevices)) return invalid('ioDevices must be an array')
  if (ioDevices.length > 16) return invalid('at most 16 io devices per slice', { count: ioDevices.length })
  return [...new Set(ioDevices.map(toSystemdIoDevice))]
}

const limitOf = (resources: ResourceLimits, f: SliceField): Limit => {
  if (typeof resources !== 'object' || resources === null) return invalid('resources must be an object')
  return assertLimit(f, resources[f], SLICE_BOUNDS[f].min, SLICE_BOUNDS[f].max)
}

const planSlice = (resources: ResourceLimits, ioDevices: readonly unknown[], controllers: CgroupControllers): SlicePlan => {
  const lines: string[] = []
  const scalarProps: Record<string, string> = {}
  const enforcement = {} as Record<SliceField, FieldEnforcement>
  const devices = normalizeDevices(ioDevices)
  const unavailable = { applied: false, reason: 'controller-unavailable' } as const

  const memory = limitOf(resources, 'memoryMb')
  if (!controllers.memory) enforcement.memoryMb = unavailable
  else {
    const max = memory === 'unlimited' ? 'infinity' : `${memory}M`
    const high = memory === 'unlimited' ? 'infinity' : `${Math.floor((memory * 9) / 10)}M`
    const swap = memory === 'unlimited' ? 'infinity' : '0'
    lines.push('MemoryAccounting=yes', `MemoryHigh=${high}`, `MemoryMax=${max}`, `MemorySwapMax=${swap}`)
    Object.assign(scalarProps, { MemoryHigh: high, MemoryMax: max, MemorySwapMax: swap })
    enforcement.memoryMb = { applied: true, unlimited: memory === 'unlimited', value: max }
  }

  const tasks = limitOf(resources, 'maxProcesses')
  if (!controllers.pids) enforcement.maxProcesses = unavailable
  else {
    const v = tasks === 'unlimited' ? 'infinity' : String(tasks)
    lines.push('TasksAccounting=yes', `TasksMax=${v}`)
    scalarProps.TasksMax = v
    enforcement.maxProcesses = { applied: true, unlimited: tasks === 'unlimited', value: v }
  }

  const cpu = limitOf(resources, 'cpuPercent')
  if (!controllers.cpu) enforcement.cpuPercent = unavailable
  else {
    lines.push('CPUAccounting=yes')
    if (cpu !== 'unlimited') lines.push(`CPUQuota=${cpu}%`)
    scalarProps.CPUQuota = cpu === 'unlimited' ? '' : `${cpu}%`
    enforcement.cpuPercent = { applied: true, unlimited: cpu === 'unlimited', value: cpu === 'unlimited' ? 'infinity' : `${cpu}%` }
  }

  const io = IO_KEYS.map(([field, key]) => ({ field, key, limit: limitOf(resources, field) }))
  const deviceProps: Record<string, string>[] = []
  if (!controllers.io) {
    for (const { field } of io) enforcement[field] = unavailable
  } else {
    lines.push('IOAccounting=yes')
    for (const { field, key, limit } of io) {
      if (limit === 'unlimited') enforcement[field] = { applied: true, unlimited: true, value: 'infinity' }
      else if (devices.length === 0) enforcement[field] = { applied: false, reason: 'no-io-device' }
      else {
        for (const dev of devices) lines.push(`${key}=${dev} ${limit}`)
        enforcement[field] = { applied: true, unlimited: false, value: String(limit) }
      }
    }
    for (const dev of devices) {
      deviceProps.push(Object.fromEntries(io.map(({ key, limit }) => [key, `${dev} ${limit === 'unlimited' ? 'infinity' : limit}`])))
    }
  }
  return { lines, scalarProps, deviceProps, enforcement }
}

const systemdDirOf = (opts: SliceOptions): string => assertAbsPath('systemdDir', opts.systemdDir ?? SYSTEMD_UNIT_DIR)

/** The `[Slice]` body shared by the account slice and the logind user-slice drop-in. */
export const sliceBodyLines = (resources: ResourceLimits, ioDevices: readonly unknown[], opts: SliceOptions = {}): string[] =>
  planSlice(resources, ioDevices, opts.controllers ?? ALL_CONTROLLERS).lines

export const renderAccountSlice = (
  account: Pick<Account, 'username' | 'uid' | 'gid'>,
  resources: ResourceLimits,
  ioDevices: readonly unknown[],
  opts: SliceOptions = {},
): RenderedFile => {
  const id = assertAccountIdentity(account)
  const { lines } = planSlice(resources, ioDevices, opts.controllers ?? ALL_CONTROLLERS)
  const content = [
    `# Generated by xPanel for account ${id.username} (uid ${id.uid}). Manual edits are overwritten.`,
    '[Unit]',
    `Description=xPanel account ${id.username}`,
    'Documentation=man:systemd.resource-control(5)',
    'Before=slices.target',
    '',
    '[Slice]',
    ...lines,
    '',
  ].join('\n')
  return { path: `${systemdDirOf(opts)}/${accountSliceName(id.uid)}`, content, mode: 0o644, owner: 'root', group: 'root' }
}

/**
 * Property maps for `systemctl set-property` without a restart. The first map holds the scalar limits;
 * each further map holds one device's IO limits, because a device-keyed list property cannot appear
 * twice in one Record. Apply them in order.
 */
export const sliceProperties = (
  resources: ResourceLimits,
  ioDevices: readonly unknown[],
  opts: SliceOptions = {},
): Record<string, string>[] => {
  const p = planSlice(resources, ioDevices, opts.controllers ?? ALL_CONTROLLERS)
  return [p.scalarProps, ...p.deviceProps]
}

export const sliceUpdateActions = (
  account: Pick<Account, 'username' | 'uid' | 'gid'>,
  resources: ResourceLimits,
  ioDevices: readonly unknown[],
  opts: SliceOptions = {},
): HostAction[] => {
  const unit = accountSliceName(assertAccountIdentity(account).uid)
  return sliceProperties(resources, ioDevices, opts)
    .filter((properties) => Object.keys(properties).length > 0)
    .map((properties): HostAction => ({ kind: 'systemd-set-property', unit, properties }))
}

export const sliceEnforcement = (
  resources: ResourceLimits,
  ioDevices: readonly unknown[],
  opts: SliceOptions = {},
): Record<SliceField, FieldEnforcement> => planSlice(resources, ioDevices, opts.controllers ?? ALL_CONTROLLERS).enforcement

/** Parses the content of /sys/fs/cgroup/cgroup.controllers ("cpuset cpu io memory pids ..."). */
export const parseCgroupControllers = (text: string): CgroupControllers => {
  const set = new Set(String(text).trim().split(/\s+/))
  return { cpu: set.has('cpu'), memory: set.has('memory'), pids: set.has('pids'), io: set.has('io') }
}
