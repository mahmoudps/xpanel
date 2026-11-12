import { readdir, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import type { HostAction, RenderedFile } from '@xpanel/core'
import type { ConfigTestResult } from '../executor.ts'

/** The runner must use a fixed C locale. No shell. Only initializeUserQuota remounts or rebuilds quota files. */
export type QuotaCommandRunner = (argv: string[]) => Promise<ConfigTestResult>
export interface UserQuotaObservation {
  filesystem: string
  source: string | null
  filesystemType: string | null
  status: 'enabled' | 'disabled' | 'unavailable'
  reason: string | null
}

export const validateQuotaFilesystem = (value: unknown): string => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 1024 || posix.normalize(value) !== value ||
      (value !== '/' && value.endsWith('/')) || !/^\/[A-Za-z0-9_./+-]*$/.test(value)) {
    return fail('VALIDATION', 'quota filesystem must be a canonical absolute mount path')
  }
  return value
}

/** Parse one exact quotaon --print-state observation; exit 0 or missing output is never proof. */
export const parseUserQuotaState = (stdout: string, filesystem: string, source: string, filesystemType = 'ext4'): 'enabled' | 'disabled' | 'unavailable' => {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length !== 1) return 'unavailable'
  if (lines[0] === `user quota on ${filesystem} (${source}) is on (enforced)`) return 'enabled'
  if (filesystemType !== 'xfs' && lines[0] === `user quota on ${filesystem} (${source}) is on`) return 'enabled'
  if (lines[0] === `user quota on ${filesystem} (${source}) is on (accounting)`) return 'disabled'
  if (lines[0] === `user quota on ${filesystem} (${source}) is off`) return 'disabled'
  return 'unavailable'
}

export const observeUserQuota = async (run: QuotaCommandRunner, value: string): Promise<UserQuotaObservation> => {
  const filesystem = validateQuotaFilesystem(value)
  const unavailable = (reason: string): UserQuotaObservation => ({ filesystem, source: null, filesystemType: null, status: 'unavailable', reason })
  const fields: Record<string, string> = {}
  for (const field of ['TARGET', 'SOURCE', 'FSTYPE']) {
    const result = await run(['/usr/bin/findmnt', '--noheadings', '--raw', '--output', field, '--target', filesystem])
    if (!result.ok || !result.stdout.trim() || /[\r\n]/.test(result.stdout.trim())) return unavailable('mount_observation_failed')
    fields[field] = result.stdout.trim()
  }
  if (fields.TARGET !== filesystem) return unavailable('exact_mount_required')
  if (!['ext4', 'xfs'].includes(fields.FSTYPE!)) return unavailable('filesystem_not_supported')
  const result = await run(['/usr/sbin/quotaon', '--print-state', '--verbose', '--user', filesystem])
  const parsed = parseUserQuotaState(result.stdout, filesystem, fields.SOURCE!, fields.FSTYPE!)
  // quotaon -p returns the number of active quota types: one user quota ON exits 1, OFF exits 0.
  // Verbose XFS accounting-only also exits 1 but is not enforcement.
  const expectedCode = result.stdout.trim().endsWith(' is off') ? 0 : 1
  const status = parsed !== 'unavailable' && result.code === expectedCode && result.stderr.trim() === '' ? parsed : 'unavailable'
  return {
    filesystem, source: fields.SOURCE!, filesystemType: fields.FSTYPE!, status,
    reason: status === 'unavailable' ? 'quota_state_unconfirmed' : null,
  }
}

const sameMount = (before: UserQuotaObservation, after: UserQuotaObservation): boolean =>
  before.filesystem === after.filesystem && before.source === after.source && before.filesystemType === after.filesystemType

/** Enable existing on-disk quota metadata only. Missing accounting requires an offline reviewed setup. */
export const enableExistingUserQuota = async (run: QuotaCommandRunner, filesystem: string): Promise<UserQuotaObservation> => {
  const before = await observeUserQuota(run, filesystem)
  if (before.status === 'enabled') return before
  if (before.status !== 'disabled') {
    return fail('PRECONDITION_FAILED', 'quota enablement requires a supported observed mount and existing accounting', { stateChanged: false, reason: before.reason })
  }
  const enabled = await run(['/usr/sbin/quotaon', '--user', before.filesystem])
  const after = await observeUserQuota(run, filesystem)
  if (!enabled.ok || after.status !== 'enabled' || !sameMount(before, after)) {
    return fail('SERVICE_UNAVAILABLE', 'quota enablement outcome requires verification; offline quota initialization may be required', {
      stateChanged: true, unknownOutcome: true, verificationRequired: true,
    })
  }
  return after
}

/** User quota applies to a whole mount: the one holding account homes, which is `/` when /home is not its own filesystem. */
export const resolveHomeQuotaFilesystem = async (run: QuotaCommandRunner, homeBase = '/home'): Promise<string> => {
  const mount = await run(['/usr/bin/findmnt', '--noheadings', '--raw', '--output', 'TARGET', '--target', validateQuotaFilesystem(homeBase)])
  if (!mount.ok || !mount.stdout.trim() || /[\r\n]/.test(mount.stdout.trim())) {
    return fail('PRECONDITION_FAILED', 'the filesystem holding account homes could not be observed', { stateChanged: false })
  }
  return validateQuotaFilesystem(mount.stdout.trim())
}

/** Read enforcement on the mount containing account homes, without remounting or initializing quotas. */
export const observeHomeUserQuota = async (run: QuotaCommandRunner, path = '/home'): Promise<UserQuotaObservation> =>
  observeUserQuota(run, await resolveHomeQuotaFilesystem(run, path))

export const QUOTA_FSTAB_PATH = '/etc/fstab'
/** ext4 journaled user quota: accounting stays consistent after a crash without a new quotacheck. */
const JOURNALED_USER_QUOTA = ['usrjquota=aquota.user', 'jqfmt=vfsv1']

/** Adds journaled user quota to the single fstab entry of `mountpoint`; null when user quota is already configured. */
export const fstabWithUserQuota = (fstab: string, mountpoint: string): string | null => {
  const lines = fstab.split('\n')
  const entries = lines.flatMap((line, index) => {
    const fields = line.trim().split(/\s+/)
    return !line.trim().startsWith('#') && fields.length >= 4 && fields[1] === mountpoint ? [index] : []
  })
  if (entries.length !== 1) {
    return fail('PRECONDITION_FAILED', 'quota setup requires exactly one /etc/fstab entry for the filesystem', { stateChanged: false, entries: entries.length })
  }
  const index = entries[0]!
  const [, head, options, tail] = /^(\s*\S+\s+\S+\s+\S+\s+)(\S+)(.*)$/.exec(lines[index]!)!
  const current = options!.split(',')
  if (current.some(option => option === 'usrquota' || option === 'quota' || option.startsWith('usrjquota='))) return null
  lines[index] = head + [...current, ...JOURNALED_USER_QUOTA].join(',') + tail
  return lines.join('\n')
}

/** A kernel the host can boot, with its module index (modules.builtin and modules.dep contents). */
export interface BootableKernel {
  readonly release: string
  readonly moduleIndex: string
}

/** Journaled vfsv1 quota needs quota_v2 and quota_tree, built in or as modules, when the filesystem mounts. */
export const lacksQuotaFormat = (moduleIndex: string): boolean =>
  ['quota_v2', 'quota_tree'].some(module => !new RegExp(`(^|/)${module}\\.ko(\\.[a-z]+)?(:|$)`, 'm').test(moduleIndex))

/** Native reader for {@link QuotaInitializationPorts.bootableKernels}. */
export const readBootableKernels = async (): Promise<BootableKernel[]> => {
  const read = (path: string): Promise<string | null> => readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const kernels: BootableKernel[] = []
  for (const name of (await readdir('/boot')).sort()) {
    if (!name.startsWith('vmlinuz-')) continue
    const release = name.slice('vmlinuz-'.length)
    const dependencies = await read(`/lib/modules/${release}/modules.dep`)
    if (dependencies !== null) kernels.push({ release, moduleIndex: `${await read(`/lib/modules/${release}/modules.builtin`) ?? ''}\n${dependencies}` })
  }
  return kernels
}

export interface QuotaInitializationPorts {
  readonly run: QuotaCommandRunner
  /** Kernels in /boot that have a module tree; images without one (EL rescue) are left out. */
  bootableKernels(): Promise<readonly BootableKernel[]>
  /** The accounting scan reads the whole filesystem; it runs under its own longer deadline. */
  readonly scan: QuotaCommandRunner
  readFile(path: string): Promise<string | null>
  writeFile(file: RenderedFile): Promise<void>
}

export interface UserQuotaInitialization extends UserQuotaObservation {
  readonly changed: boolean
  readonly fstabBackup: string | null
}

/**
 * Turns on enforced user quota for the ext4 filesystem holding `path`, as cPanel's initquotas does:
 * fstab gains journaled quota options after a backup, the mount is remounted, accounting is built
 * and enforcement is switched on and observed. An already enforcing filesystem is left untouched.
 */
export const initializeUserQuota = async (ports: QuotaInitializationPorts, path: string, stamp: string): Promise<UserQuotaInitialization> => {
  if (!/^[0-9]{8}T[0-9]{6}Z$/.test(stamp)) fail('VALIDATION', 'quota setup backup stamp must be YYYYMMDDTHHMMSSZ')
  const mountpoint = await resolveHomeQuotaFilesystem(ports.run, path)
  const before = await observeUserQuota(ports.run, mountpoint)
  if (before.status === 'enabled') return { ...before, changed: false, fstabBackup: null }
  if (before.filesystemType !== 'ext4') {
    return fail('PRECONDITION_FAILED', 'automatic quota setup supports ext4; XFS user quota is the uquota mount option set at boot', {
      stateChanged: false, filesystemType: before.filesystemType,
    })
  }
  // A kernel without the format modules cannot mount the filesystem with quota options, so its next boot would stop.
  const unbootable = (await ports.bootableKernels()).filter(kernel => lacksQuotaFormat(kernel.moduleIndex)).map(kernel => kernel.release)
  if (unbootable.length > 0) {
    return fail('PRECONDITION_FAILED', 'every bootable kernel needs quota_v2 and quota_tree before quota options reach /etc/fstab', {
      stateChanged: false, kernels: unbootable,
    })
  }
  const fstab = await ports.readFile(QUOTA_FSTAB_PATH) ?? fail('PRECONDITION_FAILED', '/etc/fstab is missing', { stateChanged: false })
  const updated = fstabWithUserQuota(fstab, mountpoint)
  const file = (target: string, content: string): RenderedFile => ({ path: target, content, mode: 0o644, owner: 'root', group: 'root' })
  const fstabBackup = updated === null ? null : `${QUOTA_FSTAB_PATH}.bak.${stamp}`
  if (updated !== null) {
    await ports.writeFile(file(fstabBackup!, fstab))
    await ports.writeFile(file(QUOTA_FSTAB_PATH, updated))
  }
  const remount = await ports.run(['/usr/bin/mount', '-o', 'remount', mountpoint])
  if (!remount.ok) {
    // Options the kernel refused must not reach the next boot.
    if (updated !== null) await ports.writeFile(file(QUOTA_FSTAB_PATH, fstab))
    return fail('PRECONDITION_FAILED', 'the kernel refused the quota mount options; /etc/fstab was restored', {
      stateChanged: false, fstabBackup, detail: remount.stderr.trim().slice(0, 200),
    })
  }
  const unverified = (step: string): never => fail('SERVICE_UNAVAILABLE', `quota setup stopped at ${step}; the host requires verification`, {
    stateChanged: true, verificationRequired: true, step, fstabBackup,
  })
  const accounting = await ports.scan(['/usr/sbin/quotacheck', '--create-files', '--user', '--no-remount', '--format=vfsv1', mountpoint])
  if (!accounting.ok) return unverified('quotacheck')
  const enforcement = await ports.run(['/usr/sbin/quotaon', '--user', mountpoint])
  if (!enforcement.ok) return unverified('quotaon')
  const after = await observeUserQuota(ports.run, mountpoint)
  if (after.status !== 'enabled' || !sameMount(before, after)) return unverified('verification')
  return { ...after, changed: true, fstabBackup }
}

/** Setting an account limit must not succeed on a filesystem with disabled or unobserved enforcement. */
export const applyObservedUserQuota = async (run: QuotaCommandRunner, action: Extract<HostAction, { kind: 'set-quota' }>): Promise<void> => {
  validateQuotaFilesystem(action.filesystem)
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(action.user) ||
      !Number.isSafeInteger(action.blockSoftKb) || !Number.isSafeInteger(action.blockHardKb) ||
      action.blockSoftKb < 0 || action.blockHardKb < 0 ||
      (action.blockHardKb !== 0 && action.blockSoftKb > action.blockHardKb)) {
    fail('VALIDATION', 'quota action requires a valid user and nonnegative bounded limits')
  }
  const before = await observeUserQuota(run, action.filesystem)
  if (before.status !== 'enabled') {
    fail('PRECONDITION_FAILED', 'user quota enforcement is not enabled on the observed filesystem', { stateChanged: false, reason: before.reason ?? before.status })
  }
  const result = await run(['/usr/sbin/setquota', '-u', action.user, String(action.blockSoftKb), String(action.blockHardKb), '0', '0', action.filesystem])
  const after = await observeUserQuota(run, action.filesystem)
  const clearedAbsentUser = !result.ok && action.blockSoftKb === 0 && action.blockHardKb === 0 && result.stderr.includes(`user ${action.user} does not exist`)
  if ((!result.ok && !clearedAbsentUser) || after.status !== 'enabled' || !sameMount(before, after)) {
    fail('SERVICE_UNAVAILABLE', 'account quota mutation could not be confirmed on the same enforcing filesystem', {
      stateChanged: true, unknownOutcome: true, verificationRequired: true,
    })
  }
}
