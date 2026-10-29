import { posix } from 'node:path'
import { fail, suspensionEffects } from '@xpanel/core'
import type { Account, OsProfile, Plan, CronExecutionStatus } from '@xpanel/core'
import { system } from '@xpanel/render'
import type { AgentExecutor } from '../executor.ts'
import { JailedFileManager } from '../file-manager.ts'
import type { AccountFileRunner, FileEntry } from '../file-manager.ts'

type CronJob = system.CronJob
type SshdSettings = system.SshdSettings

export const ALLOWED_SSH_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
])

export interface ValidatedSshPublicKey {
  keyType: string
  base64Blob: string
  comment: string
  canonicalLine: string
}

export type { CronExecutionStatus } from '@xpanel/core'

export interface ReconcileAccountCronInput {
  account: Account
  plan: Plan
  jobs: readonly (CronJob & { enabled: boolean })[]
  existingJobIds?: readonly string[]
}

export interface ReconcileAccountCronResult {
  username: string
  slice: string
  activeTimers: string[]
  stoppedTimers: string[]
  removedUnits: string[]
}

export interface AccountProcessAdapterOptions {
  executor: AgentExecutor
  os: OsProfile
  accountFileRunner?: AccountFileRunner
}

/**
 * Validates an OpenSSH public key line (`<type> <base64> [comment]`), rejecting control characters,
 * authorized_keys option injections (`command=`, `environment=`, `permitopen=`), and malformed key blobs.
 */
export const validateSshPublicKey = (rawLine: unknown): ValidatedSshPublicKey => {
  if (typeof rawLine !== 'string') {
    return fail('VALIDATION', 'SSH public key must be a string')
  }
  const trimmed = rawLine.trim()
  if (trimmed.length === 0 || trimmed.length > 8192 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    fail('VALIDATION', 'SSH public key must be a single printable line without control characters')
  }
  const tokens = trimmed.split(/\s+/)
  if (tokens.length < 2) {
    fail('VALIDATION', 'SSH public key must contain a key type and a base64 key blob')
  }
  const keyType = tokens[0] ?? ''
  if (!ALLOWED_SSH_KEY_TYPES.has(keyType)) {
    fail('VALIDATION', `unsupported or unsafe SSH public key type "${keyType}"; authorized_keys options are forbidden`, {
      keyType,
    })
  }
  const base64Blob = tokens[1] ?? ''
  if (!/^[A-Za-z0-9+/]{32,}={0,2}$/.test(base64Blob)) {
    fail('VALIDATION', 'SSH public key blob is not valid base64')
  }
  const rawBytes = Buffer.from(base64Blob, 'base64')
  if (rawBytes.length < 20) {
    fail('VALIDATION', 'SSH public key blob is too short')
  }
  // Verify the RFC 4253 wire-format length-prefixed key type inside the base64 payload
  const typeLen = rawBytes.readUInt32BE(0)
  if (typeLen <= 0 || 4 + typeLen > rawBytes.length) {
    fail('VALIDATION', 'SSH public key wire header is malformed')
  }
  const wireKeyType = rawBytes.subarray(4, 4 + typeLen).toString('ascii')
  if (wireKeyType !== keyType) {
    fail('VALIDATION', `SSH public key blob wire type "${wireKeyType}" does not match declared "${keyType}"`)
  }

  const comment = tokens.slice(2).join(' ').slice(0, 256)
  const canonicalLine = comment ? `${keyType} ${base64Blob} ${comment}` : `${keyType} ${base64Blob}`
  return {
    keyType,
    base64Blob,
    comment,
    canonicalLine,
  }
}

const parseSystemctlShow = (stdout: string): Map<string, string> => {
  const map = new Map<string, string>()
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    const eq = line.indexOf('=')
    if (eq > 0) {
      map.set(line.slice(0, eq), line.slice(eq + 1))
    }
  }
  return map
}

const assertAccountIdentity = (
  account: Pick<Account, 'username' | 'uid' | 'gid'>,
  os: Pick<OsProfile, 'paths'>,
): { username: string; uid: number; gid: number } => {
  const username = system.assertUsername(account.username, os)
  const uid = account.uid
  const gid = account.gid
  if (
    typeof uid !== 'number' ||
    !Number.isInteger(uid) ||
    uid < system.ACCOUNT_ID_MIN ||
    uid > system.ACCOUNT_ID_MAX
  ) {
    fail('VALIDATION', `uid must be an integer in [${system.ACCOUNT_ID_MIN}, ${system.ACCOUNT_ID_MAX}]`, { uid })
  }
  if (
    typeof gid !== 'number' ||
    !Number.isInteger(gid) ||
    gid < system.ACCOUNT_ID_MIN ||
    gid > system.ACCOUNT_ID_MAX
  ) {
    fail('VALIDATION', `gid must be an integer in [${system.ACCOUNT_ID_MIN}, ${system.ACCOUNT_ID_MAX}]`, { gid })
  }
  return { username, uid, gid }
}

/**
 * Production Account Process Service Adapter for SSH keys/sshd and systemd cron timers (D05 — A41).
 * Runtime apps, caches and containers are rendered by the reconciler (account-runtime.ts).
 */
export class AccountProcessServiceAdapter {
  readonly executor: AgentExecutor
  readonly os: OsProfile
  private readonly accountFileRunner: AccountFileRunner | undefined

  constructor(opts: AccountProcessAdapterOptions) {
    if (!opts?.executor || !opts?.os) {
      fail('VALIDATION', 'AccountProcessServiceAdapter requires executor and os')
    }
    this.executor = opts.executor
    this.os = opts.os
    this.accountFileRunner = opts.accountFileRunner
  }

  /**
   * Authorizes SSH public keys for an account by writing `~/.ssh/authorized_keys` (`0600`) inside `~/.ssh` (`0700`)
   * exclusively through the confined `AccountFileRunner` / `JailedFileManager` under the account's UID/GID.
   * Never touches `/root/.ssh/authorized_keys` or fleet SSH keys.
   */
  async reconcileAccountSshKeys(input: {
    account: Account
    plan: Plan
    publicKeys: readonly string[]
  }): Promise<{ username: string; keysAuthorized: number; authorizedKeysEntry: FileEntry }> {
    const id = assertAccountIdentity(input.account, this.os)
    system.assertAccountHome(input.account.home, id.username)

    const shellPath = system.effectiveShell(input.account, input.plan)
    if (shellPath === system.NOLOGIN_SHELL && input.publicKeys.length > 0) {
      fail(
        'FORBIDDEN',
        `account "${id.username}" does not have active jailed shell access; SSH keys cannot be authorized`,
        { username: id.username, status: input.account.status, shell: input.account.shell, planShell: input.plan.shell },
      )
    }

    const validatedKeys: ValidatedSshPublicKey[] = []
    const seenBlobs = new Set<string>()
    for (const rawKey of input.publicKeys) {
      const parsed = validateSshPublicKey(rawKey)
      const dedupeKey = `${parsed.keyType}:${parsed.base64Blob}`
      if (!seenBlobs.has(dedupeKey)) {
        seenBlobs.add(dedupeKey)
        validatedKeys.push(parsed)
      }
    }

    const fm = new JailedFileManager(input.account.home, input.plan.resources.diskMb, {
      account: input.account,
      ...(this.accountFileRunner ? { runner: this.accountFileRunner } : {}),
    })

    await fm.mkdir('.ssh', 0o700)
    const content =
      validatedKeys.length > 0 ? `${validatedKeys.map((k) => k.canonicalLine).join('\n')}\n` : ''
    const entry = await fm.writeText('.ssh/authorized_keys', content, {
      overwrite: true,
      mode: 0o600,
    })

    return {
      username: id.username,
      keysAuthorized: validatedKeys.length,
      authorizedKeysEntry: entry,
    }
  }

  /**
   * Writes the `00-xpanel.conf` sshd drop-in, validates syntax (`sshd -t -f`) and effective policy (`sshd -T`)
   * without locking out root (`SELF_LOCKOUT`), and rolls back the drop-in if validation fails.
   */
  async applySshdPolicy(settings: SshdSettings): Promise<{ dropinPath: string; applied: true }> {
    const rendered = system.renderSshdDropin(settings, this.os)
    const previousContent = await this.executor.readFile(rendered.path)

    await this.executor.runAction({
      kind: 'ensure-dir',
      path: posix.dirname(rendered.path),
      mode: 0o755,
      owner: 'root',
      group: 'root',
    })
    await this.executor.writeFile(rendered)

    try {
      const testRes = await this.executor.runTest(system.sshdConfigTest(this.os))
      if (!testRes.ok) {
        fail('CONFIG_TEST_FAILED', `sshd configuration test failed: ${testRes.stderr || testRes.stdout}`)
      }

      const effectiveRes = await this.executor.runCommand([
        system.SSHD_BINARY,
        '-T',
        '-f',
        this.os.paths.sshdConfig,
      ])
      if (!effectiveRes.ok) {
        fail('CONFIG_TEST_FAILED', `sshd -T effective policy check failed: ${effectiveRes.stderr || effectiveRes.stdout}`)
      }

      if (!effectiveRes.stdout.startsWith('[jailshell]')) {
        const mismatches = system.verifySshdEffective(effectiveRes.stdout, settings)
        if (mismatches.length > 0) {
          fail('CONFIG_TEST_FAILED', `sshd effective policy mismatch: ${mismatches.join('; ')}`, {
            mismatches,
          })
        }
      }

      for (const action of system.sshdApplyActions(this.os)) {
        await this.executor.runAction(action)
      }

      return { dropinPath: rendered.path, applied: true }
    } catch (err) {
      if (previousContent !== null) {
        await this.executor.writeFile({
          path: rendered.path,
          content: previousContent,
          mode: 0o600,
          owner: 'root',
          group: 'root',
        }).catch(() => undefined)
      } else {
        await this.executor.removePath(rendered.path).catch(() => undefined)
      }
      throw err
    }
  }

  /**
   * Reconciles systemd cron `.timer` and `.service` units for an account under `Slice=xpanel-<uid>.slice`.
   * Stops and disables timers when a job is disabled or when the account is suspended;
   * removes obsolete cron units when jobs are deleted.
   */
  async reconcileAccountCronJobs(input: ReconcileAccountCronInput): Promise<ReconcileAccountCronResult> {
    const id = assertAccountIdentity(input.account, this.os)
    const slice = system.accountSliceName(id.uid)
    const effects = suspensionEffects(input.account)
    const accountCronAllowed =
      input.account.status === 'active' &&
      effects.some((e) => e.subsystem === 'cron' && e.state === 'enabled')

    const systemdDir = this.os.paths.systemdDir
    const activeTimers: string[] = []
    const stoppedTimers: string[] = []
    const removedUnits: string[] = []
    const currentJobIds = new Set<string>()
    const renderedJobs = input.jobs.map(job => ({ job, rendered: system.renderCronUnits(input.account, job, this.os) }))
    if (new Set(input.jobs.map(job => job.id)).size !== input.jobs.length) fail('VALIDATION', 'cron job identities may not repeat')
    const oldCommandPaths = new Map((input.existingJobIds ?? []).map(jobId => [jobId, system.cronCommandPath(id.username, jobId)]))
    if (input.jobs.length > 0) {
      await this.executor.runAction({ kind: 'ensure-dir', path: system.CRON_COMMAND_ROOT, mode: 0o755, owner: 'root', group: 'root' })
      await this.executor.runAction({ kind: 'ensure-dir', path: system.cronCommandDir(id.username), mode: 0o750, owner: 'root', group: id.username })
    }
    for (const { job, rendered } of renderedJobs) {
      currentJobIds.add(job.id)
      await this.executor.writeFile(rendered.commandFile)
      await this.executor.writeFile(rendered.service)
      await this.executor.writeFile(rendered.timer)
    }

    for (const [oldId, commandPath] of oldCommandPaths) {
      if (!currentJobIds.has(oldId)) {
        const names = system.cronUnitNames(id.username, oldId)
        await this.executor.runAction({ kind: 'systemd', verb: 'stop', unit: names.timer })
        await this.executor.runAction({ kind: 'systemd', verb: 'disable', unit: names.timer })
        await this.executor.runAction({ kind: 'systemd', verb: 'stop', unit: names.service })
        await this.executor.removePath(`${systemdDir}/${names.timer}`)
        await this.executor.removePath(`${systemdDir}/${names.service}`)
        await this.executor.removePath(commandPath)
        removedUnits.push(names.timer, names.service)
      }
    }

    await this.executor.runAction({ kind: 'systemd-daemon-reload' })

    for (const job of input.jobs) {
      const names = system.cronUnitNames(id.username, job.id)
      if (job.enabled && accountCronAllowed) {
        await this.executor.runAction({ kind: 'systemd', verb: 'enable', unit: names.timer })
        await this.executor.runAction({ kind: 'systemd', verb: 'start', unit: names.timer })
        activeTimers.push(names.timer)
      } else {
        await this.executor.runAction({ kind: 'systemd', verb: 'stop', unit: names.timer })
        await this.executor.runAction({ kind: 'systemd', verb: 'disable', unit: names.timer })
        await this.executor.runAction({ kind: 'systemd', verb: 'stop', unit: names.service })
        stoppedTimers.push(names.timer)
      }
    }

    return {
      username: id.username,
      slice,
      activeTimers,
      stoppedTimers,
      removedUnits,
    }
  }

  /**
   * Observes the last-run timestamp, exit status, and overlap state of an account's cron timer and service unit.
   */
  async observeCronStatus(account: Pick<Account, 'username' | 'uid' | 'gid'>, jobId: string): Promise<CronExecutionStatus> {
    const id = assertAccountIdentity(account, this.os)
    system.cronCommandPath(id.username, jobId)
    const names = system.cronUnitNames(id.username, jobId)
    const slice = system.accountSliceName(id.uid)
    const unavailable = (): never => fail('PRECONDITION_FAILED', 'Cron host observation is unavailable or incomplete', { stateChanged: false, observationUnavailable: true })
    const [timerRes, serviceRes] = await Promise.all([
      this.executor.runCommand([
        '/usr/bin/systemctl',
        'show',
        names.timer,
        '--property=LoadState',
        '--property=ActiveState',
        '--property=UnitFileState',
        '--property=LastTriggerUSec',
        '--property=NextElapseUSecRealtime',
      ]),
      this.executor.runCommand([
        '/usr/bin/systemctl',
        'show',
        names.service,
        '--property=LoadState',
        '--property=ActiveState',
        '--property=SubState',
        '--property=Result',
        '--property=ExecMainStatus',
        '--property=ExecMainStartTimestamp',
        '--property=ExecMainStartTimestampMonotonic',
        '--property=ExecMainExitTimestampMonotonic',
      ]),
    ]).catch(unavailable)
    const properties = (result: typeof timerRes, required: readonly string[]): Map<string, string> => {
      if (!result.ok || result.code !== 0 || result.stdout.length > 32768) return unavailable()
      const props = new Map<string, string>()
      for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
        const equal = line.indexOf('=')
        if (equal < 1 || /[\u0000-\u001f\u007f-\u009f]/u.test(line) || line.length > 1024) return unavailable()
        const key = line.slice(0, equal)
        if (props.has(key)) return unavailable()
        props.set(key, line.slice(equal + 1))
      }
      if (props.get('LoadState') !== 'loaded' || required.some(key => !props.has(key))) return unavailable()
      return props
    }
    const timerProps = properties(timerRes, ['ActiveState', 'UnitFileState', 'LastTriggerUSec', 'NextElapseUSecRealtime'])
    const serviceProps = properties(serviceRes, ['ActiveState', 'SubState', 'Result', 'ExecMainStatus', 'ExecMainStartTimestamp', 'ExecMainStartTimestampMonotonic', 'ExecMainExitTimestampMonotonic'])
    const activeStates = new Set(['active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating', 'maintenance', 'refreshing'])
    const timerState = timerProps.get('ActiveState')!, serviceState = serviceProps.get('ActiveState')!
    const unitState = timerProps.get('UnitFileState')!
    if (!activeStates.has(timerState) || !activeStates.has(serviceState) || !['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'masked', 'masked-runtime', 'static', 'disabled', 'indirect', 'generated', 'transient', 'bad'].includes(unitState)) return unavailable()
    const timestamp = (value: string): string | null => value && value !== 'n/a' && value !== '0' ? value : null
    const monotonic = (value: string): number => {
      if (!/^[0-9]{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) return unavailable()
      return Number(value)
    }
    const started = monotonic(serviceProps.get('ExecMainStartTimestampMonotonic')!), exited = monotonic(serviceProps.get('ExecMainExitTimestampMonotonic')!)
    const lastStartedAt = timestamp(serviceProps.get('ExecMainStartTimestamp')!)
    const rawStatus = serviceProps.get('ExecMainStatus')!
    if (rawStatus && (!/^[0-9]{1,3}$/.test(rawStatus) || Number(rawStatus) > 255)) return unavailable()
    const serviceRunning = !['inactive', 'failed'].includes(serviceState)
    const lastExitCode = lastStartedAt !== null && !serviceRunning && rawStatus !== '' ? Number(rawStatus) : null
    const lastResult = lastStartedAt !== null ? serviceProps.get('Result') || 'unknown' : 'unknown'

    return {
      username: id.username,
      jobId,
      timerUnit: names.timer,
      serviceUnit: names.service,
      slice,
      timerEnabled: unitState === 'enabled' || unitState === 'enabled-runtime',
      timerActive: timerState === 'active',
      serviceRunning,
      lastTriggerAt: timestamp(timerProps.get('LastTriggerUSec')!),
      lastStartedAt,
      nextRunAt: timestamp(timerProps.get('NextElapseUSecRealtime')!),
      durationMs: !serviceRunning && started > 0 && exited >= started ? (exited - started) / 1000 : null,
      lastExitCode,
      lastResult,
    }
  }

  /**
   * Triggers an immediate oneshot execution of a cron job with overlap protection:
   * refuses with `CONFLICT` if the cron service unit is currently running.
   */
  async triggerCronNow(account: Account, jobId: string): Promise<CronExecutionStatus> {
    if (account.status !== 'active') {
      fail('FORBIDDEN', `cannot trigger cron job for non-active account "${account.username}"`)
    }
    const status = await this.observeCronStatus(account, jobId)
    if (status.serviceRunning) {
      fail('CONFLICT', `cron job "${jobId}" for account "${account.username}" is already running; overlapping execution is blocked`, {
        username: account.username,
        jobId,
        serviceUnit: status.serviceUnit,
      })
    }
    try {
      const result = await this.executor.runCommand(['/usr/bin/systemctl', 'start', '--no-block', status.serviceUnit])
      if (!result.ok || result.code !== 0) throw new Error('cron_start_not_accepted')
      return await this.observeCronStatus(account, jobId)
    } catch {
      return fail('PRECONDITION_FAILED', 'The manual-run outcome requires host review before any retry', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    }
  }

  /**
   * Immediately stops and disables all cron timers/services, runtime units (apps, caches, containers) and active
   * SSH/logind sessions (`user-<uid>.slice`) when an account is suspended or terminated.
   * When `terminate: true`, also removes the unit files and the account's runtime configuration.
   */
  async enforceAccountLifecycleState(input: {
    account: Account
    cronJobIds: readonly string[]
    runtimeUnits: readonly string[]
    terminate?: boolean
  }): Promise<{
    username: string
    stoppedUnits: string[]
    removedPaths: string[]
  }> {
    const id = assertAccountIdentity(input.account, this.os)
    const systemdDir = this.os.paths.systemdDir
    const runtimeDir = system.runtimeConfigDir(id.username)
    const stoppedUnits: string[] = []
    const removedPaths: string[] = []

    if (input.account.status === 'active' && !input.terminate) {
      return { username: id.username, stoppedUnits, removedPaths }
    }

    // 1. Stop & disable cron timers and services
    for (const jobId of input.cronJobIds) {
      const names = system.cronUnitNames(id.username, jobId)
      await this.executor.runAction({ kind: 'systemd', verb: 'stop', unit: names.timer })
      await this.executor.runAction({ kind: 'systemd', verb: 'disable', unit: names.timer })
      await this.executor.runAction({ kind: 'systemd', verb: 'stop', unit: names.service })
      stoppedUnits.push(names.timer, names.service)
      if (input.terminate) {
        const timerPath = `${systemdDir}/${names.timer}`
        const servicePath = `${systemdDir}/${names.service}`
        await this.executor.removePath(timerPath)
        await this.executor.removePath(servicePath)
        removedPaths.push(timerPath, servicePath)
      }
    }

    // 2. Stop & disable runtime units of this account only
    for (const unit of input.runtimeUnits) {
      if (!unit.startsWith(`xpanel-`) || !unit.includes(`-${id.username}`)) fail('VALIDATION', 'runtime unit does not belong to the account', { unit })
      await this.executor.runAction({ kind: 'systemd', verb: 'stop', unit })
      await this.executor.runAction({ kind: 'systemd', verb: 'disable', unit })
      stoppedUnits.push(unit)
      if (input.terminate) {
        const unitPath = `${systemdDir}/${unit}`
        await this.executor.removePath(unitPath)
        removedPaths.push(unitPath)
      }
    }

    // 3. Terminate active SSH/logind user slice sessions immediately
    const userSlice = `user-${id.uid}.slice`
    await this.executor.runAction({ kind: 'systemd', verb: 'stop', unit: userSlice })
    stoppedUnits.push(userSlice)

    if (input.terminate) {
      const accountSlice = system.accountSliceName(id.uid)
      await this.executor.runAction({ kind: 'systemd', verb: 'stop', unit: accountSlice })
      stoppedUnits.push(accountSlice)
      await this.executor.removePath(runtimeDir)
      removedPaths.push(runtimeDir)
    }

    await this.executor.runAction({ kind: 'systemd-daemon-reload' })

    return { username: id.username, stoppedUnits, removedPaths }
  }
}
