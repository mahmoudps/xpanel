import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import type { HostAction } from '@xpanel/core'
import type { ConfigTestResult } from '../executor.ts'

/** The runner must use a fixed C locale. No shell, remount or quota-file rebuilding is performed here. */
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
  if (!result.ok || after.status !== 'enabled' || !sameMount(before, after)) {
    fail('SERVICE_UNAVAILABLE', 'account quota mutation could not be confirmed on the same enforcing filesystem', {
      stateChanged: true, unknownOutcome: true, verificationRequired: true,
    })
  }
}
