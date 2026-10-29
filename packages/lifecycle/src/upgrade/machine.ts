import { posix } from 'node:path'
import { auditEntry, fail } from '@xpanel/core'
import type { ErrorCode, HostAction, OsProfile, Principal } from '@xpanel/core'
import { ACME_DIR, acmeTraverseAclArgv, assertUnitName } from '@xpanel/os'
import type { FsPort } from '../ports.ts'
import { errorCode, errorMessage } from '../ports.ts'
import { stepPaths } from '../steps.ts'
import { lifecycleTools } from '../tools.ts'
import type { LifecycleTools } from '../tools.ts'
import { assertRoot, assertSafeAbsPath, assertText, assertUsername, compactStamp, isNonNegInt, isSafeAbsPath, isSha256, isUnder, isUnderHomes } from '../validate.ts'
import { assertHotPathMigrations } from './migrations.ts'
import { preflight } from './preflight.ts'
import type { PreflightCheck } from './preflight.ts'
import { assertSemver, parseSemver } from './semver.ts'
import type { AccountIdentity, GenerationId, UnitChange, UpgradePhase, UpgradePorts, UpgradeRow } from './ports.ts'

export interface UpgradeLayout {
  root: string
  releasesDir: string
  currentLink: string
  stagingDir: string
  /** root-only directory the agent downloads verified release tarballs into */
  downloadsDir: string
  stateDir: string
  snapshotsDir: string
  lockFile: string
  /** Diagnostic marker only. Actual writer admission is enforced by UpgradeSafetyPort. */
  maintenanceFile: string
}

export const DEFAULT_LAYOUT: UpgradeLayout = {
  root: '/opt/xpanel',
  releasesDir: '/opt/xpanel/releases',
  currentLink: '/opt/xpanel/current',
  stagingDir: '/opt/xpanel/staging',
  downloadsDir: '/opt/xpanel/downloads',
  stateDir: '/var/lib/xpanel',
  snapshotsDir: '/var/lib/xpanel-lifecycle/backups',
  lockFile: '/var/lib/xpanel/upgrade.lock',
  maintenanceFile: '/var/lib/xpanel/maintenance.json',
}

export interface ReleaseInfo {
  version: string
  /** SQLite index schema number this release expects */
  schemaVersion: number
  /** the downloaded release tarball, directly inside layout.downloadsDir */
  archivePath: string
  /** from the signed release index */
  sha256: string
  /** unpacked size in bytes */
  bytes: number
}

export interface UpgradePlan {
  actor: Principal
  os: Pick<OsProfile, 'family'>
  release: ReleaseInfo
  /** account whose site must still be served by its own uid after the switch */
  canary: string | null
  /** the panel's own units: restarted to load new code. Shared services are only reloaded. */
  panelUnits?: string[]
  /** OS account owning /var/lib/xpanel/state and snapshots, default 'xpanel' */
  panelUser?: string
  health?: { attempts: number; intervalMs: number }
  layout?: Partial<UpgradeLayout>
}

export interface UpgradeStepLog {
  phase: UpgradePhase
  step: string
  at: string
  ok: boolean
  detail: string
}

export type UpgradeHostOutcome = 'succeeded' | 'failed' | 'rolled_back' | 'rollback_failed'
export type UpgradeOutcome = 'refused' | 'retirement_pending' | UpgradeHostOutcome

/**
 * Automatic rewind after a failed switch, journaled in `upgrade-<recordId>.rewind.json`.
 * started -> verified | failed (a step or the snapshot was refused; `done` lists what was restored)
 * | unknown (restored but the health checks did not prove it: operator action required).
 */
export type RewindState = 'rewind-started' | 'rewind-verified' | 'rewind-failed' | 'rewind-unknown'
export type RewindStep = 'release' | 'state-extract' | 'state-swap' | 'index' | 'units' | 'start-panel'
export const REWIND_STEPS: readonly RewindStep[] = ['release', 'state-extract', 'state-swap', 'index', 'units', 'start-panel']

export interface RewindJournal {
  schemaVersion: 1
  recordId: string
  state: RewindState
  done: RewindStep[]
  /** generation the units step activated; verification expects it to stay active */
  generation: GenerationId | null
  problems: string[]
  startedAt: string
  updatedAt: string
}

/** Written once (O_EXCL) right after the snapshot; the rewind restores only what it names. */
interface SnapshotReceipt {
  schemaVersion: 1
  recordId: string
  stamp: string
  from: string
  fromSchema: number
  release: ReleaseInfo
  previousTarget: string
  previousGeneration: GenerationId
  snapshot: { path: string; sha256: string }
  control: { path: string; sha256: string }
  identitiesBefore: AccountIdentity[]
  canary: string | null
  panelUnits: string[]
  panelUser: string
  health: { attempts: number; intervalMs: number }
  createdAt: string
}

export interface UpgradeResult {
  outcome: UpgradeOutcome
  /** Observed host flow only; it never grants writer-admission retirement. */
  hostOutcome: UpgradeHostOutcome | null
  /** set for refusals; the API maps it to an HTTP status */
  code: ErrorCode | null
  from: string | null
  to: string
  reason: string | null
  checks: PreflightCheck[]
  snapshot: string | null
  previousGeneration: GenerationId | null
  newGeneration: GenerationId | null
  recordId: string | null
  rollbackErrors: string[]
  rewind: RewindJournal | null
  steps: UpgradeStepLog[]
}

interface NormalizedPlan {
  actor: Principal
  tools: LifecycleTools
  release: ReleaseInfo
  canary: string | null
  panelUnits: string[]
  panelUser: string
  health: { attempts: number; intervalMs: number }
  layout: UpgradeLayout
}

export const DEFAULT_PANEL_UNITS: readonly string[] = ['xpanel-api.service', 'xpanel-agent.service']
/** The flow itself runs in this oneshot unit, so restarting the API and agent does not kill it. */
export const UPGRADE_UNIT = 'xpanel-upgrade.service'

const SYS_USER = /^[a-z_][a-z0-9_-]{0,31}$/

/** Paths an upgrade may never write or pass to a command: homes, mail stores, customer databases. */
export const isCustomerDataPath = (p: string): boolean =>
  isUnderHomes(p) || ['/var/mail', '/var/vmail', '/var/spool/mail', '/var/lib/mysql', '/var/lib/mariadb'].some((r) => isUnder(p, r))

const stateSnapshotArgv = (t: LifecycleTools, stateDir: string, file: string): string[] =>
  [t.tar, '--create', '--gzip', `--file=${file}`, `--directory=${stateDir}`, 'state']

/** Only the `state` member, into a scratch directory beside the live one; root keeps owners and modes. */
const stateRestoreArgv = (t: LifecycleTools, file: string, scratch: string, excludes: string): string[] =>
  [t.tar, '--extract', '--gzip', '--overwrite', `--file=${file}`, `--directory=${scratch}`, `--exclude-from=${excludes}`, 'state']

/**
 * StateStore lease and lock artifacts are never restored: a stale lease or a hot mutex WAL from the
 * snapshot must not block the restored release. Unanchored: canonical state names never start with a dot.
 */
export const REWIND_EXCLUDES: readonly string[] = ['.lock', '.lock-prepared-*', '.rollback-*.tmp', '.writer-mutex.sqlite-wal', '.writer-mutex.sqlite-shm', '.writer-mutex.sqlite-journal']
/** An uncommitted StateStore write journal means the snapshot caught a write mid-flight: it needs review, never a restore. */
const PENDING_STATE_WRITE = 'state/.lock/intent.json'
/** Set-aside state trees kept after verified rewinds, newest last. */
const REWIND_RETAINED = 2

const normalizeLayout = (partial: Partial<UpgradeLayout> | undefined): UpgradeLayout => {
  const l = { ...DEFAULT_LAYOUT, ...(partial ?? {}) }
  for (const [k, v] of Object.entries(l)) {
    assertSafeAbsPath(v, `layout.${k}`)
    if (isCustomerDataPath(v)) fail('VALIDATION', `layout.${k} points into customer data: ${v}`)
  }
  for (const k of ['releasesDir', 'stagingDir', 'downloadsDir', 'currentLink'] as const) {
    if (!isUnder(l[k], l.root) || l[k] === l.root) fail('VALIDATION', `layout.${k} must be inside ${l.root}`)
  }
  for (const k of ['lockFile', 'maintenanceFile'] as const) {
    if (!isUnder(l[k], l.stateDir) || l[k] === l.stateDir) fail('VALIDATION', `layout.${k} must be inside ${l.stateDir}`)
  }
  if (l.snapshotsDir !== DEFAULT_LAYOUT.snapshotsDir && (!isUnder(l.snapshotsDir, l.stateDir) || l.snapshotsDir === l.stateDir)) fail('VALIDATION', 'custom snapshots directory must be inside panel state; production still requires root-private admission')
  const dirs = [l.releasesDir, l.stagingDir, l.downloadsDir]
  if (dirs.some((a, i) => dirs.some((b, j) => i !== j && isUnder(a, b)))) fail('VALIDATION', 'releases, staging and downloads directories must not nest')
  return l
}

const normalizeHealth = (h: { attempts: number; intervalMs: number } | undefined): { attempts: number; intervalMs: number } => {
  const health = h ?? { attempts: 5, intervalMs: 3000 }
  if (!Number.isInteger(health.attempts) || health.attempts < 1 || health.attempts > 20) fail('VALIDATION', 'health.attempts must be 1..20')
  if (!Number.isInteger(health.intervalMs) || health.intervalMs < 0 || health.intervalMs > 600_000) fail('VALIDATION', 'health.intervalMs must be 0..600000')
  return { attempts: health.attempts, intervalMs: health.intervalMs }
}

/** Restarting the unit the flow itself runs in would kill it halfway through. */
const normalizePanelUnits = (units: readonly string[]): string[] => {
  const out = [...new Set(units.map((u) => assertUnitName(u)))]
  if (out.length === 0) fail('VALIDATION', 'at least one panel unit is required')
  const coordinator = out.find(unit => unit === UPGRADE_UNIT || unit === 'xpanel-lifecycle.service')
  if (coordinator) fail('VALIDATION', `${coordinator} runs the upgrade and cannot be one of the restarted panel units`)
  return out
}

export const normalizeUpgradePlan = (p: UpgradePlan): NormalizedPlan => {
  const actor = assertRoot(p?.actor, 'upgrade the panel')
  const layout = normalizeLayout(p.layout)
  const r = p.release
  assertSemver(r?.version, 'release version')
  if (!isNonNegInt(r.schemaVersion)) fail('VALIDATION', 'invalid release schemaVersion')
  assertSafeAbsPath(r.archivePath, 'release archive path')
  // root unpacks it: only a root-only directory keeps it from being swapped after the checksum
  if (posix.dirname(r.archivePath) !== layout.downloadsDir) fail('VALIDATION', `release archive must be inside ${layout.downloadsDir}`)
  if (!isSha256(r.sha256)) fail('VALIDATION', 'release sha256 must be 64 lowercase hex characters')
  if (!isNonNegInt(r.bytes) || r.bytes === 0) fail('VALIDATION', 'release bytes must be a positive integer')
  const panelUser = p.panelUser ?? 'xpanel'
  if (!SYS_USER.test(panelUser)) fail('VALIDATION', 'invalid panel os user')
  return {
    actor,
    tools: lifecycleTools(p.os),
    release: { version: r.version, schemaVersion: r.schemaVersion, archivePath: r.archivePath, sha256: r.sha256, bytes: r.bytes },
    canary: p.canary === null ? null : assertUsername(p.canary, 'canary account'),
    panelUnits: normalizePanelUnits(p.panelUnits ?? DEFAULT_PANEL_UNITS),
    panelUser,
    health: normalizeHealth(p.health),
    layout,
  }
}

/** Version encoded by a `current` link target, or null when the target is not a release dir. */
const versionFromTarget = (target: string | null, layout: UpgradeLayout): string | null => {
  if (target === null || !isSafeAbsPath(target) || posix.dirname(target) !== layout.releasesDir) return null
  const v = posix.basename(target)
  return parseSemver(v) ? v : null
}

const assertWritable = (l: UpgradeLayout, p: string): void => {
  assertSafeAbsPath(p, 'write path')
  if (isCustomerDataPath(p) || ![l.root, l.stateDir, l.snapshotsDir].some((r) => isUnder(p, r))) fail('FORBIDDEN', `upgrade may not write ${p}`)
}

/** Defense in depth: the upgrader can only write panel-owned paths. */
const guardFs = (fs: FsPort, l: UpgradeLayout): FsPort => ({
  exists: (p) => fs.exists(p),
  readlink: (p) => fs.readlink(p),
  readFile: (p) => fs.readFile(p),
  sha256: (p) => fs.sha256(p),
  symlink: async (t, p) => { assertWritable(l, p); await fs.symlink(t, p) },
  rename: async (a, b) => { assertWritable(l, a); assertWritable(l, b); await fs.rename(a, b) },
  mkdirp: async (p, m) => { assertWritable(l, p); await fs.mkdirp(p, m) },
  writeFileExclusive: async (p, c, m) => { assertWritable(l, p); await fs.writeFileExclusive(p, c, m) },
  remove: async (p) => { assertWritable(l, p); await fs.remove(p) },
})

export type LockState = 'running' | 'rollback-failed' | 'retirement-pending'

export interface LockInfo {
  state: LockState
  recordId: string | null
  actor: string
  to: string
  at: string
}

interface Ctx {
  ports: UpgradePorts
  fs: FsPort
  plan: NormalizedPlan
  stamp: string
  phase: UpgradePhase
  steps: UpgradeStepLog[]
  checks: PreflightCheck[]
  from: string | null
  fromSchema: number | null
  previousTarget: string | null
  recordId: string | null
  snapshot: string | null
  previousGeneration: GenerationId | null
  newGeneration: GenerationId | null
  identitiesBefore: AccountIdentity[]
  staging: string | null
  releaseCreated: boolean
  migrated: string[]
  healthProblems: string[]
  rollbackErrors: string[]
  rewind: RewindJournal | null
  effectsStarted: boolean
  writersStopped: boolean
  hostOutcome: UpgradeHostOutcome | null
}

const nowIso = (c: Ctx): string => c.ports.clock.now().toISOString()

const log = (c: Ctx, step: string, ok: boolean, detail: string): void => {
  c.steps.push({ phase: c.phase, step, at: nowIso(c), ok, detail })
}

const result = (c: Ctx, outcome: UpgradeOutcome, reason: string | null, code: ErrorCode | null = null): UpgradeResult => ({
  outcome,
  hostOutcome: c.hostOutcome,
  code,
  from: c.from,
  to: c.plan.release.version,
  reason,
  checks: c.checks,
  snapshot: c.snapshot,
  previousGeneration: c.previousGeneration,
  newGeneration: c.newGeneration,
  recordId: c.recordId,
  rollbackErrors: c.rollbackErrors,
  rewind: c.rewind,
  steps: c.steps,
})

/** What the root sees in xWHM next to the upgrade row. */
const report = (c: Ctx): Record<string, unknown> => ({
  hostOutcome: c.hostOutcome,
  checks: c.checks,
  generations: { previous: c.previousGeneration, next: c.newGeneration },
  migrations: c.migrated,
  health: c.healthProblems,
  rollbackErrors: c.rollbackErrors,
  rewind: c.rewind,
  steps: c.steps,
})

const audit = async (c: Ctx, action: string, outcome: 'ok' | 'denied' | 'failed', reason: string | null): Promise<void> => {
    await c.ports.audit.record(auditEntry(c.plan.actor, action, 'xpanel', {
      from: c.from,
      to: c.plan.release.version,
      reason,
      snapshot: c.snapshot,
      previousGeneration: c.previousGeneration,
      newGeneration: c.newGeneration,
      rollbackErrors: c.rollbackErrors,
      rewind: c.rewind?.state ?? null,
      hostOutcome: c.hostOutcome,
    }, outcome, { now: c.ports.clock.now() }))
}

const refuse = async (c: Ctx, code: ErrorCode, reason: string): Promise<UpgradeResult> => {
  log(c, 'refused', false, reason)
  await audit(c, 'upgrade.refused', 'denied', reason)
  return result(c, 'refused', reason, code)
}

const describeAction = (a: HostAction): string =>
  a.kind === 'exec' ? a.argv.join(' ') : a.kind === 'systemd' ? `systemctl ${a.verb} ${a.unit}` : a.kind

const run = async (c: Ctx, step: string, action: HostAction): Promise<void> => {
  if (action.kind === 'ensure-dir' || action.kind === 'remove-path') assertWritable(c.plan.layout, action.path)
  for (const p of stepPaths(action)) if (isCustomerDataPath(p)) fail('FORBIDDEN', `upgrade may not pass ${p} to a command`)
  const r = await c.ports.host.apply(action)
  if (r.code !== 0) throw new Error(`${step}: ${describeAction(action)} exited ${r.code}${r.stderr ? `: ${r.stderr.slice(0, 500)}` : ''}`)
  log(c, step, true, describeAction(action))
}

const enterPhase = async (c: Ctx, phase: UpgradePhase, extra?: { snapshotPath?: string }): Promise<void> => {
  c.phase = phase
  if (c.recordId) await c.ports.history.setPhase(c.recordId, phase, extra)
}

const applyUnits = async (c: Ctx, step: string, units: UnitChange[]): Promise<void> => {
  for (const u of units) await run(c, step, { kind: 'systemd', verb: u.needs === 'restart' ? 'restart' : 'reload', unit: assertUnitName(u.unit) })
}

const panelUnits = async (c: Ctx, step: string, verb: 'restart' | 'stop' | 'start'): Promise<void> => {
  for (const unit of c.plan.panelUnits) await run(c, step, { kind: 'systemd', verb, unit })
}

const pointCurrentAt = async (c: Ctx, target: string, suffix: string): Promise<void> => {
  const l = c.plan.layout
  const tmp = posix.join(posix.dirname(l.currentLink), `.current-${c.stamp}${suffix}`)
  if ((await c.fs.readlink(tmp)) !== null || (await c.fs.exists(tmp))) await c.fs.remove(tmp)
  await c.fs.symlink(target, tmp)
  await c.fs.rename(tmp, l.currentLink)
  await c.ports.safety.syncPath(posix.dirname(l.currentLink))
  const now = await c.fs.readlink(l.currentLink)
  if (now !== target) throw new Error(`current link points to ${String(now)}, expected ${target}`)
}

const writeAtomic = async (c: Ctx, path: string, content: string, mode = 0o600): Promise<void> => {
  const tmp = `${path}.${c.stamp}.tmp`
  if (await c.fs.exists(tmp)) await c.fs.remove(tmp)
  await c.fs.writeFileExclusive(tmp, content, mode)
  await c.ports.safety.syncPath(tmp)
  await c.fs.rename(tmp, path)
  await c.ports.safety.syncPath(posix.dirname(path))
}

/** World-readable diagnostic; this file alone never proves that writers are fenced. */
const maintenance = async (c: Ctx): Promise<void> => {
  const file = c.plan.layout.maintenanceFile
  await writeAtomic(c, file, `${JSON.stringify({ reason: 'upgrade', to: c.plan.release.version, since: nowIso(c) })}\n`, 0o644)
  log(c, 'maintenance', true, 'on; retirement requires a separately qualified coordinator')
}

const retirementPath = (layout: UpgradeLayout): string => posix.join(layout.snapshotsDir, 'retirement-attention.json')
const RETIREMENT_REQUIRED = 'durable lifecycle retirement is pending; maintenance and recovery evidence remain retained'

/** Permanent attention evidence, never a self-issued finalization grant or a replacement kernel fence. */
const retainRetirementAttention = async (ports: UpgradePorts, fs: FsPort, layout: UpgradeLayout, evidence: Record<string, unknown>): Promise<void> => {
  await fs.mkdirp(layout.snapshotsDir, 0o700)
  const path = retirementPath(layout)
  try {
    await fs.writeFileExclusive(path, `${JSON.stringify({ schemaVersion: 1, status: 'retirement_pending', ...evidence })}\n`, 0o600)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
    // Existence is sufficient to refuse future entry. Existing evidence is never overwritten.
  }
  await ports.safety.syncPath(path)
  await ports.safety.syncPath(layout.snapshotsDir)
  await ports.safety.syncPath(posix.dirname(layout.snapshotsDir))
}

const lockInfo = (c: Ctx, state: LockState): string =>
  `${JSON.stringify({ state, recordId: c.recordId, actor: c.plan.actor.username, to: c.plan.release.version, at: nowIso(c) } satisfies LockInfo)}\n`

const identityDrift = (before: AccountIdentity[], after: AccountIdentity[]): string[] => {
  const byName = new Map(after.map((a) => [a.username, a]))
  const out: string[] = []
  for (const b of before) {
    const a = byName.get(b.username)
    if (!a) { out.push(`account ${b.username} missing`); continue }
    if (a.uid !== b.uid || a.gid !== b.gid) out.push(`account ${b.username} uid/gid ${b.uid}/${b.gid} became ${a.uid}/${a.gid}`)
    if (a.slice !== b.slice) out.push(`account ${b.username} slice ${b.slice} became ${a.slice}`)
    for (const k of new Set([...Object.keys(b.quotas), ...Object.keys(a.quotas)])) {
      if (a.quotas[k] !== b.quotas[k]) out.push(`account ${b.username} quota ${k} ${String(b.quotas[k])} became ${String(a.quotas[k])}`)
    }
  }
  return out
}

const probe = async <T>(fn: () => Promise<T>, what: string, problems: string[]): Promise<T | undefined> => {
  try {
    return await fn()
  } catch (e) {
    problems.push(`${what} probe failed: ${errorMessage(e)}`)
    return undefined
  }
}

interface HealthInput {
  ports: UpgradePorts
  canary: string | null
  /** identities to compare against; null skips the comparison (recovery has no baseline) */
  before: AccountIdentity[] | null
}

/** Converged desired state, unchanged identities, actual canary UID and qualified control-plane service readiness. */
const healthProblems = async ({ ports, canary, before }: HealthInput): Promise<string[]> => {
  const p: string[] = []
  const st = await probe(() => ports.reconciler.status(), 'reconciler status', p)
  if (st && !st.converged) p.push(`reconciler not converged${st.drift.length ? `: ${st.drift.join(', ')}` : ''}`)
  const now = await probe(() => ports.reconciler.identities(), 'identity', p)
  if (now && before) p.push(...identityDrift(before, now))
  if (canary !== null) {
    const expected = (before ?? now ?? []).find((i) => i.username === canary)?.uid
    const served = await probe(() => ports.health.servedUid(canary), 'canary', p)
    if (expected === undefined) p.push(`canary account ${canary} is unknown`)
    else if (served !== undefined && served !== expected) p.push(`canary ${canary} served by uid ${String(served)} instead of ${expected}`)
  }
  const qualifiedControlPlane = await probe(() => ports.health.qualifiedControlPlane(), 'qualified control-plane readiness', p)
  if (qualifiedControlPlane !== true) p.push('qualified control-plane readiness failed')
  return p
}

const healthGate = async (c: Ctx): Promise<void> => {
  for (let attempt = 1; attempt <= c.plan.health.attempts; attempt++) {
    c.healthProblems = await healthProblems({ ports: c.ports, canary: c.plan.canary, before: c.identitiesBefore })
    if (c.healthProblems.length === 0) {
      log(c, 'health', true, `healthy on attempt ${attempt}`)
      return
    }
    log(c, 'health', false, `attempt ${attempt}: ${c.healthProblems.join('; ')}`)
    if (attempt < c.plan.health.attempts) await c.ports.clock.sleep(c.plan.health.intervalMs)
  }
  throw new Error(`health check failed: ${c.healthProblems.join('; ')}`)
}

const bestEffort = async (c: Ctx, step: string, fn: () => Promise<void>, critical: boolean): Promise<void> => {
  try {
    await fn()
    log(c, step, true, 'done')
  } catch (e) {
    log(c, step, false, errorMessage(e))
    if (critical) c.rollbackErrors.push(`${step}: ${errorMessage(e)}`)
  }
}

type FinalOutcome = UpgradeHostOutcome

const finish = async (c: Ctx, outcome: FinalOutcome, reason: string | null): Promise<UpgradeResult> => {
  c.hostOutcome = outcome
  await retainRetirementAttention(c.ports, c.fs, c.plan.layout, { hostOutcome: outcome, recordId: c.recordId, from: c.from, to: c.plan.release.version, observedAt: nowIso(c), report: report(c) })
  const pendingReason = [reason, RETIREMENT_REQUIRED].filter(Boolean).join('; ')
  if (c.recordId) {
    const id = c.recordId
    if (outcome === 'rolled_back' || outcome === 'rollback_failed') await c.ports.history.setPhase(id, 'rollback')
    // The native terminal producer owns the single final DB transition after physical proof.
    // A host-flow return cannot finish the row while writer admission is still retained.
  }
  await audit(c, outcome === 'rollback_failed' ? 'upgrade.rollback_failed' : 'upgrade.retirement_pending', 'failed', pendingReason)
  // No final grant is composed. Never unlink the final barriers, even after healthy host observations.
  return result(c, outcome === 'rollback_failed' ? outcome : 'retirement_pending', pendingReason, 'PRECONDITION_FAILED')
}

/**
 * Before the link moves nothing customer-facing changed. Applied migrations stay: they are
 * expand-only, so the running release keeps working on them and the next attempt continues.
 */
const abortBeforeSwitch = async (c: Ctx, cause: unknown, releaseDir: string): Promise<UpgradeResult> => {
  const reason = errorMessage(cause)
  log(c, 'abort', false, reason)
  if (c.effectsStarted) {
    if (!c.writersStopped) {
      c.rollbackErrors.push('writer stop did not settle; no automatic restart or rollback is allowed')
      return finish(c, 'rollback_failed', reason)
    }
    try {
      await c.ports.safety.assertWritersQuiescent(c.plan.panelUnits)
      await c.ports.safety.assertCompatibility({ direction: 'rollback', fromVersion: c.plan.release.version, toVersion: c.from as string, currentSchema: await c.ports.migrator.currentSchema(), targetSchema: c.fromSchema as number, ...(c.snapshot ? { snapshot: { recordId: c.recordId as string, path: c.snapshot } } : {}) })
      await c.ports.safety.assertWriteBarrier()
      await panelUnits(c, 'abort:start-panel', 'start')
    } catch (error) {
      c.rollbackErrors.push(`abort: ${errorMessage(error)}`)
      return finish(c, 'rollback_failed', reason)
    }
  }
  if (c.staging) { const s = c.staging; await bestEffort(c, 'cleanup:staging', () => c.fs.remove(s), false) }
  if (c.releaseCreated) await bestEffort(c, 'cleanup:release', () => c.fs.remove(releaseDir), false)
  return finish(c, 'failed', reason)
}

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const receiptPath = (l: UpgradeLayout, recordId: string): string => posix.join(l.snapshotsDir, `upgrade-${recordId}.receipt.json`)
export const rewindJournalPath = (l: UpgradeLayout, recordId: string): string => posix.join(l.snapshotsDir, `upgrade-${recordId}.rewind.json`)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const parseJson = (raw: string | null): unknown => { try { return raw === null ? null : JSON.parse(raw) } catch { return null } }
const isFileRef = (v: unknown): v is { path: string; sha256: string } => isObject(v) && isSafeAbsPath(v.path) && isSha256(v.sha256)

export const parseRewindJournal = (raw: string | null): RewindJournal | null => {
  const v = parseJson(raw)
  if (!isObject(v) || v.schemaVersion !== 1 || typeof v.recordId !== 'string' || !RECORD_ID.test(v.recordId)
    || !['rewind-started', 'rewind-verified', 'rewind-failed', 'rewind-unknown'].includes(String(v.state))
    || !Array.isArray(v.done) || !v.done.every(s => REWIND_STEPS.includes(s as RewindStep))
    || !(v.generation === null || Number.isSafeInteger(v.generation))
    || !Array.isArray(v.problems) || !v.problems.every(p => typeof p === 'string')
    || typeof v.startedAt !== 'string' || typeof v.updatedAt !== 'string') return null
  return { schemaVersion: 1, recordId: v.recordId, state: v.state as RewindState, done: [...v.done] as RewindStep[], generation: v.generation as GenerationId | null, problems: [...v.problems] as string[], startedAt: v.startedAt, updatedAt: v.updatedAt }
}

const parseReceipt = (raw: string | null): SnapshotReceipt | null => {
  const v = parseJson(raw)
  return isObject(v) && v.schemaVersion === 1 && typeof v.recordId === 'string' && RECORD_ID.test(v.recordId) && typeof v.stamp === 'string'
    && typeof v.from === 'string' && isNonNegInt(v.fromSchema) && isObject(v.release) && isSafeAbsPath(v.previousTarget)
    && Number.isSafeInteger(v.previousGeneration) && isFileRef(v.snapshot) && isFileRef(v.control) && Array.isArray(v.identitiesBefore)
    && (v.canary === null || typeof v.canary === 'string') && Array.isArray(v.panelUnits) && typeof v.panelUser === 'string' && isObject(v.health)
    ? v as unknown as SnapshotReceipt : null
}

/** Same atomic replace as the lock, keyed by record so a resume never needs the original stamp. */
const saveJournal = async (ports: UpgradePorts, fs: FsPort, l: UpgradeLayout, j: RewindJournal): Promise<void> => {
  const path = rewindJournalPath(l, j.recordId)
  const tmp = `${path}.tmp`
  if (await fs.exists(tmp)) await fs.remove(tmp)
  await fs.writeFileExclusive(tmp, `${JSON.stringify(j)}\n`, 0o600)
  await ports.safety.syncPath(tmp)
  await fs.rename(tmp, path)
  await ports.safety.syncPath(l.snapshotsDir)
}

/** Restores only this upgrade's snapshot, and only after its checksums and identity match the receipt. */
const verifiedReceipt = async (c: Ctx): Promise<SnapshotReceipt> => {
  const l = c.plan.layout
  const r = parseReceipt(await c.fs.readFile(receiptPath(l, c.recordId as string)))
  if (!r) throw new Error('snapshot receipt is missing or malformed')
  const snapshot = posix.join(l.snapshotsDir, `${r.stamp}.tar.gz`)
  if (r.recordId !== c.recordId || r.stamp !== c.stamp || r.from !== c.from || r.release.version !== c.plan.release.version
    || r.previousTarget !== c.previousTarget || r.snapshot.path !== snapshot || r.control.path !== `${snapshot}.control.db`) throw new Error('snapshot receipt does not belong to this upgrade')
  for (const f of [r.snapshot, r.control]) {
    if ((await c.fs.sha256(f.path)) !== f.sha256) throw new Error(`snapshot ${f.path} does not match its receipt checksum`)
  }
  return r
}

const assertNoPendingStateWrite = async (c: Ctx, r: SnapshotReceipt): Promise<void> => {
  const listed = await c.ports.host.apply({ kind: 'exec', argv: [c.plan.tools.tar, '--list', '--gzip', `--file=${r.snapshot.path}`], runAsUser: 'root' })
  if (listed.code !== 0) throw new Error(`snapshot ${r.snapshot.path} cannot be listed: exited ${listed.code}`)
  if (listed.stdout.split('\n').some(line => line.trim() === PENDING_STATE_WRITE)) throw new Error(`snapshot ${r.snapshot.path} holds an uncommitted state write (${PENDING_STATE_WRITE}); review it before restoring`)
}

/** After a verified rewind only: keep the newest set-aside trees, remove older ones and the empty scratch. */
const pruneSetAside = async (c: Ctx, recordId: string): Promise<void> => {
  const l = c.plan.layout
  const index = posix.join(l.snapshotsDir, 'rewind-retention.json')
  const listed = parseJson(await c.fs.readFile(index))
  const ids = [...(Array.isArray(listed) ? listed : []).filter((id): id is string => typeof id === 'string' && RECORD_ID.test(id) && id !== recordId), recordId]
  const scratch = posix.join(l.stateDir, `.rewind-${recordId}`)
  if (await c.fs.exists(scratch)) await c.fs.remove(scratch)
  // Removal first, index second: a crash in between only repeats an idempotent removal.
  for (const id of ids.slice(0, -REWIND_RETAINED)) {
    const tree = posix.join(l.stateDir, `.pre-rewind-${id}`)
    if (await c.fs.exists(tree)) await c.fs.remove(tree)
  }
  await writeAtomic(c, index, `${JSON.stringify(ids.slice(-REWIND_RETAINED))}\n`)
}

/** Every step converges when re-run after a crash at any point inside it. */
const rewindStep = async (c: Ctx, r: SnapshotReceipt, step: RewindStep): Promise<void> => {
  const l = c.plan.layout
  const scratch = posix.join(l.stateDir, `.rewind-${r.recordId}`)
  const restored = posix.join(scratch, 'state')
  const live = posix.join(l.stateDir, 'state')
  const aside = posix.join(l.stateDir, `.pre-rewind-${r.recordId}`)
  if (step === 'release') {
    if ((await c.fs.readlink(l.currentLink)) !== r.previousTarget) await pointCurrentAt(c, r.previousTarget, '-rewind')
  } else if (step === 'state-extract') {
    // Re-extracting the same archive over a partial attempt converges; no removal is needed.
    await c.fs.mkdirp(scratch, 0o700)
    const excludes = posix.join(l.snapshotsDir, `upgrade-${r.recordId}.rewind-exclude`)
    const patterns = `${REWIND_EXCLUDES.join('\n')}\n`
    if ((await c.fs.readFile(excludes)) !== patterns) await writeAtomic(c, excludes, patterns)
    await run(c, 'rewind:state-extract', { kind: 'exec', argv: stateRestoreArgv(c.plan.tools, r.snapshot.path, scratch, excludes), runAsUser: 'root' })
    if (!(await c.fs.exists(restored))) throw new Error(`snapshot ${r.snapshot.path} holds no state directory`)
    // tar does not fsync; the journal may only record the extract once the files are durable.
    await run(c, 'rewind:state-sync', { kind: 'exec', argv: [c.plan.tools.sync, '--file-system', scratch], runAsUser: 'root' })
  } else if (step === 'state-swap') {
    if (await c.fs.exists(restored)) {
      if (await c.fs.exists(live)) {
        if (await c.fs.exists(aside)) throw new Error(`${live} and ${aside} both exist; inspect them before resuming`)
        await c.fs.rename(live, aside)
      }
      await c.fs.rename(restored, live)
    } else if (!(await c.fs.exists(live)) || !(await c.fs.exists(aside))) {
      throw new Error(`restored state is neither staged in ${scratch} nor swapped into ${live}`)
    }
    await c.ports.safety.syncPath(l.stateDir)
    if (await c.fs.exists(aside)) {
      // Evidence is sealed root-only so the panel user cannot alter it and retention can later remove it safely.
      await run(c, 'rewind:seal-set-aside', { kind: 'exec', argv: [c.plan.tools.chown, '-R', '--no-dereference', 'root:root', aside], runAsUser: 'root' })
      await run(c, 'rewind:seal-set-aside', { kind: 'exec', argv: [c.plan.tools.chmod, '-R', 'go-w', aside], runAsUser: 'root' })
    }
  } else if (step === 'index') {
    await c.ports.safety.restoreControlPlane(r.snapshot.path)
  } else if (step === 'units') {
    // The restored desired state is the one this generation was built and tested from.
    const a = await c.ports.reconciler.activate(r.previousGeneration)
    c.newGeneration = a.generationId
    await applyUnits(c, 'rewind:units', a.units)
  } else {
    await panelUnits(c, 'rewind:start-panel', 'start')
  }
}

const endRewind = async (c: Ctx, j: RewindJournal, state: Exclude<RewindState, 'rewind-started'>, problems: string[]): Promise<RewindJournal> => {
  j.state = state
  j.problems = problems
  j.updatedAt = nowIso(c)
  try {
    await saveJournal(c.ports, c.fs, c.plan.layout, j)
  } catch (e) {
    problems.push(`rewind journal: ${errorMessage(e)}`)
    if (state === 'rewind-verified') j.state = 'rewind-unknown'
  }
  log(c, j.state, j.state === 'rewind-verified', problems.join('; ') || 'verified against the snapshot')
  if (j.state === 'rewind-unknown') c.rollbackErrors.push('rewind unverified: operator action required')
  c.rollbackErrors.push(...problems)
  return j
}

/**
 * Switch back, restore state files, index and units from this upgrade's snapshot, start the panel,
 * then re-run the post-upgrade health checks. Runs inside the caller's admission scope, keeps
 * writers fenced throughout and never clears a barrier, lock or maintenance marker.
 */
const rewind = async (c: Ctx, resumed: RewindJournal | null): Promise<RewindJournal> => {
  const at = nowIso(c)
  const j: RewindJournal = resumed ?? { schemaVersion: 1, recordId: c.recordId as string, state: 'rewind-started', done: [], generation: null, problems: [], startedAt: at, updatedAt: at }
  c.rewind = j
  if (resumed) c.newGeneration = j.generation
  try {
    await saveJournal(c.ports, c.fs, c.plan.layout, j)
  } catch (e) {
    // Nothing was touched and nothing can be journaled: never proceed unrecorded.
    j.state = 'rewind-failed'
    j.problems = [`rewind journal: ${errorMessage(e)}`]
    c.rollbackErrors.push(...j.problems)
    return j
  }
  let receipt: SnapshotReceipt
  try {
    // Never move code, restore data or restart anything after uncertain writer termination.
    await panelUnits(c, 'rewind:stop-panel', 'stop')
    await c.ports.safety.assertWritersQuiescent(c.plan.panelUnits)
    c.writersStopped = true
    receipt = await verifiedReceipt(c)
    await c.ports.safety.assertCompatibility({ direction: 'rollback', fromVersion: c.plan.release.version, toVersion: c.from as string, currentSchema: await c.ports.migrator.currentSchema(), targetSchema: c.fromSchema as number, snapshot: { recordId: receipt.recordId, path: receipt.snapshot.path } })
    await c.ports.safety.assertWriteBarrier()
    // The native safety module is plain JS: refuse before any effect rather than stop half restored.
    if (typeof c.ports.safety.restoreControlPlane !== 'function') throw new Error('index restore is not available in this admission scope')
    await assertNoPendingStateWrite(c, receipt)
  } catch (e) {
    return endRewind(c, j, 'rewind-failed', [`rewind:admission: ${errorMessage(e)}`])
  }
  // Admission just stopped the panel, so a start journaled before a crash no longer holds.
  j.done = j.done.filter(s => s !== 'start-panel')
  for (const step of REWIND_STEPS) {
    if (j.done.includes(step)) continue
    try {
      await rewindStep(c, receipt, step)
    } catch (e) {
      return endRewind(c, j, 'rewind-failed', [`rewind:${step}: ${errorMessage(e)}`, `restored only: ${j.done.join(', ') || 'nothing'}`])
    }
    j.done.push(step)
    j.generation = c.newGeneration
    log(c, `rewind:${step}`, true, 'done')
    try {
      j.updatedAt = nowIso(c)
      await saveJournal(c.ports, c.fs, c.plan.layout, j)
    } catch (e) {
      return endRewind(c, j, 'rewind-unknown', [`rewind journal after ${step}: ${errorMessage(e)}`])
    }
  }
  const problems: string[] = []
  const link = await probe(() => c.fs.readlink(c.plan.layout.currentLink), 'release link', problems)
  if (link !== undefined && link !== receipt.previousTarget) problems.push(`current link points to ${String(link)}, expected ${receipt.previousTarget}`)
  const generation = await probe(() => c.ports.reconciler.currentGeneration(), 'generation', problems)
  if (generation !== undefined && generation !== c.newGeneration) problems.push(`generation ${generation} is active, expected the rewound ${String(c.newGeneration)}`)
  try {
    await healthGate(c)
  } catch {
    problems.push(...c.healthProblems)
  }
  const ended = await endRewind(c, j, problems.length ? 'rewind-unknown' : 'rewind-verified', problems)
  if (ended.state === 'rewind-verified') await bestEffort(c, 'rewind:prune-set-aside', () => pruneSetAside(c, ended.recordId), false)
  return ended
}

const rollback = async (c: Ctx, cause: unknown, releaseDir: string): Promise<UpgradeResult> => {
  const reason = errorMessage(cause)
  c.phase = 'rollback'
  log(c, 'rollback', false, reason)
  await bestEffort(c, 'rollback:phase', () => c.ports.history.setPhase(c.recordId as string, 'rollback'), false)
  const j = await rewind(c, null)
  if (j.state !== 'rewind-verified') return finish(c, 'rollback_failed', reason)
  await bestEffort(c, 'cleanup:release', () => c.fs.remove(releaseDir), false)
  return finish(c, 'rolled_back', reason)
}

const snapshotStep = async (c: Ctx): Promise<void> => {
  const l = c.plan.layout
  const file = posix.join(l.snapshotsDir, `${c.stamp}.tar.gz`)
  await enterPhase(c, 'snapshot', { snapshotPath: file })
  await run(c, 'snapshot:dir', { kind: 'ensure-dir', path: l.snapshotsDir, mode: 0o700, owner: 'root', group: 'root' })
  if (await c.fs.exists(file)) throw new Error(`snapshot ${file} already exists`)
  await run(c, 'snapshot', { kind: 'exec', argv: stateSnapshotArgv(c.plan.tools, l.stateDir, file), runAsUser: 'root' })
  if (!(await c.fs.exists(file))) throw new Error(`tar snapshot did not produce ${file}`)
  await c.ports.safety.snapshotControlPlane(file)
  await c.ports.safety.syncPath(file)
  await c.ports.safety.syncPath(l.snapshotsDir)
  c.snapshot = file
  c.previousGeneration = await c.ports.reconciler.currentGeneration()
  log(c, 'generation', true, `previous generation ${c.previousGeneration}`)
  const control = `${file}.control.db`
  if (!(await c.fs.exists(control))) throw new Error(`control-plane backup did not produce ${control}`)
  const id = c.recordId as string
  if (!RECORD_ID.test(id)) throw new Error('upgrade record id cannot name a snapshot receipt')
  const receipt: SnapshotReceipt = {
    schemaVersion: 1,
    recordId: id,
    stamp: c.stamp,
    from: c.from as string,
    fromSchema: c.fromSchema as number,
    release: c.plan.release,
    previousTarget: c.previousTarget as string,
    previousGeneration: c.previousGeneration,
    snapshot: { path: file, sha256: await c.fs.sha256(file) },
    control: { path: control, sha256: await c.fs.sha256(control) },
    identitiesBefore: c.identitiesBefore,
    canary: c.plan.canary,
    panelUnits: c.plan.panelUnits,
    panelUser: c.plan.panelUser,
    health: c.plan.health,
    createdAt: nowIso(c),
  }
  await c.fs.writeFileExclusive(receiptPath(l, id), `${JSON.stringify(receipt)}\n`, 0o600)
  await c.ports.safety.syncPath(receiptPath(l, id))
  await c.ports.safety.syncPath(l.snapshotsDir)
  log(c, 'snapshot:receipt', true, receiptPath(l, id))
}

const stageStep = async (c: Ctx, releaseDir: string): Promise<void> => {
  const { version, archivePath } = c.plan.release
  await enterPhase(c, 'stage')
  const staging = posix.join(c.plan.layout.stagingDir, `${version}-${c.stamp}`)
  await c.fs.mkdirp(staging, 0o755)
  c.staging = staging
  if ((await c.fs.sha256(archivePath)) !== c.plan.release.sha256) throw new Error('release archive changed after the preflight checksum')
  await c.ports.safety.verifyRelease(c.plan.release)
  await c.ports.safety.unpackVerifiedRelease(staging, c.plan.release)
  log(c, 'unpack', true, 'authenticated retained source; closed before publication')
  const marker = await c.fs.readFile(posix.join(staging, 'VERSION'))
  if (marker?.trim() !== version) throw new Error(`unpacked release reports version ${String(marker?.trim())}, expected ${version}`)
  await c.ports.safety.verifyStagedRelease(staging)
  await c.ports.safety.syncPath(staging)
  await c.fs.rename(staging, releaseDir)
  await c.ports.safety.syncPath(c.plan.layout.releasesDir)
  c.staging = null
  c.releaseCreated = true
  log(c, 'release', true, releaseDir)
}

const migrateStep = async (c: Ctx, releaseDir: string): Promise<void> => {
  const from = c.fromSchema as number
  const to = c.plan.release.schemaVersion
  await enterPhase(c, 'migrate')
  const pending = await c.ports.migrator.pending(releaseDir)
  assertHotPathMigrations(pending, from, to)
  if (pending.length === 0) {
    log(c, 'migrate', true, `schema ${from} unchanged`)
    return
  }
  const r = await c.ports.migrator.apply(releaseDir)
  c.migrated = r.applied
  if (r.version !== to) throw new Error(`schema is ${r.version} after migrating, release expects ${to}`)
  log(c, 'migrate', true, `schema ${from} -> ${to}: ${r.applied.join(', ')}`)
}

const activateStep = async (c: Ctx): Promise<void> => {
  await c.ports.safety.assertWriteBarrier()
  await panelUnits(c, 'panel', 'restart')
  await run(c, 'acme-dir', { kind: 'ensure-dir', path: ACME_DIR, mode: 0o755, owner: 'root', group: 'root' })
  await run(c, 'acme-acl', { kind: 'exec', argv: acmeTraverseAclArgv('nginx') })
  const r = await c.ports.reconciler.reconcile(`upgrade ${c.from} -> ${c.plan.release.version}`)
  c.newGeneration = r.generationId
  log(c, 'reconcile', true, `generation ${r.generationId}`)
  await applyUnits(c, 'reload', r.units)
}

/** Stable: nothing in flight. A failed rollback keeps the lock file, which refuses earlier. */
const isInFlight = (row: UpgradeRow | null): boolean => row !== null && (row.status === 'pending' || row.status === 'running')

const precheck = async (c: Ctx): Promise<UpgradeResult | null> => {
  const { history, reconciler, system, transfers, migrator } = c.ports
  const l = c.plan.layout
  await c.ports.safety.assertOwnedExecution(c.plan.panelUnits)
  await c.ports.safety.assertWriteBarrier()
  await c.ports.safety.verifyRelease(c.plan.release)
  const last = await history.latest()
  if (isInFlight(last)) {
    return refuse(c, 'PRECONDITION_FAILED', `upgrade ${last?.fromVersion} -> ${last?.toVersion} is still ${last?.status}; recover to a stable state first`)
  }
  const st = await reconciler.status()
  if (!st.converged) return refuse(c, 'PRECONDITION_FAILED', `reconciler is not converged: ${st.drift.join(', ') || 'unknown drift'}`)
  const target = await c.fs.readlink(l.currentLink)
  c.from = versionFromTarget(target, l)
  if (!c.from || !target) return refuse(c, 'PRECONDITION_FAILED', `${l.currentLink} does not point at a release in ${l.releasesDir}`)
  c.previousTarget = target
  const [freeBytes, os, activeTransfers, currentSchema] = await Promise.all([
    system.freeBytes(l.root), system.os(), transfers.activeCount(), migrator.currentSchema(),
  ])
  c.fromSchema = currentSchema
  await c.ports.safety.assertCompatibility({ direction: 'forward', fromVersion: c.from, toVersion: c.plan.release.version, currentSchema, targetSchema: c.plan.release.schemaVersion })
  // Admit fallback against the prospective schema before applying even an expand-only migration.
  await c.ports.safety.assertCompatibility({ direction: 'rollback', fromVersion: c.plan.release.version, toVersion: c.from, currentSchema: c.plan.release.schemaVersion, targetSchema: currentSchema, snapshot: 'planned' })
  const pre = preflight({
    freeBytes,
    releaseBytes: c.plan.release.bytes,
    os,
    activeTransfers,
    currentVersion: c.from,
    targetVersion: c.plan.release.version,
    schemaVersions: { current: currentSchema, target: c.plan.release.schemaVersion },
  })
  c.checks = pre.checks
  if (!pre.ok) return refuse(c, 'PRECONDITION_FAILED', pre.checks.filter((x) => !x.ok).map((x) => x.message).join('; '))
  const releaseDir = posix.join(l.releasesDir, c.plan.release.version)
  if (await c.fs.exists(releaseDir)) return refuse(c, 'CONFLICT', `${releaseDir} already exists; remove it after inspection`)
  if ((await c.fs.sha256(c.plan.release.archivePath)) !== c.plan.release.sha256) return refuse(c, 'VALIDATION', 'release archive checksum mismatch')
  c.identitiesBefore = await reconciler.identities()
  if (c.plan.canary && !c.identitiesBefore.some((i) => i.username === c.plan.canary)) {
    return refuse(c, 'NOT_FOUND', `canary account ${c.plan.canary} does not exist`)
  }
  return null
}

const execute = async (c: Ctx): Promise<UpgradeResult> => {
  const l = c.plan.layout
  const releaseDir = posix.join(l.releasesDir, c.plan.release.version)
  const row = await c.ports.history.create({
    fromVersion: c.from as string,
    toVersion: c.plan.release.version,
    actor: c.plan.actor.username,
    fromSchemaVersion: c.fromSchema as number,
  })
  c.recordId = row.id
  await writeAtomic(c, l.lockFile, lockInfo(c, 'running'))
  await audit(c, 'upgrade.started', 'ok', null)

  try {
    await enterPhase(c, 'precheck')
    await maintenance(c)
    c.effectsStarted = true
    await panelUnits(c, 'stop-writers', 'stop')
    await c.ports.safety.assertWritersQuiescent(c.plan.panelUnits)
    c.writersStopped = true
    await snapshotStep(c)
    await stageStep(c, releaseDir)
    await migrateStep(c, releaseDir)
  } catch (e) {
    return abortBeforeSwitch(c, e, releaseDir)
  }
  try {
    await enterPhase(c, 'switch')
    await c.ports.safety.assertWritersQuiescent(c.plan.panelUnits)
    await pointCurrentAt(c, releaseDir, '')
    log(c, 'switch', true, `${c.previousTarget} -> ${releaseDir}`)
  } catch (e) {
    const now = await c.fs.readlink(l.currentLink).catch(() => null)
    return now === releaseDir ? rollback(c, e, releaseDir) : abortBeforeSwitch(c, e, releaseDir)
  }
  try {
    await activateStep(c)
    await enterPhase(c, 'health-check')
    await healthGate(c)
  } catch (e) {
    return rollback(c, e, releaseDir)
  }
  return finish(c, 'succeeded', null)
}

const newCtx = (ports: UpgradePorts, plan: NormalizedPlan): Ctx => ({
  ports,
  fs: guardFs(ports.fs, plan.layout),
  plan,
  stamp: compactStamp(ports.clock.now()),
  phase: 'precheck',
  steps: [],
  checks: [],
  from: null,
  fromSchema: null,
  previousTarget: null,
  recordId: null,
  snapshot: null,
  previousGeneration: null,
  newGeneration: null,
  identitiesBefore: [],
  staging: null,
  releaseCreated: false,
  migrated: [],
  healthProblems: [],
  rollbackErrors: [],
  rewind: null,
  effectsStarted: false,
  writersStopped: false,
  hostOutcome: null,
})

/**
 * Called only inside mandatory operational exclusion. The O_EXCL file is diagnostic
 * evidence, not the kernel mutex. Native retirement is owned outside this model port.
 */
const withLock = async (c: Ctx, body: () => Promise<UpgradeResult>): Promise<UpgradeResult> => {
  const lock = c.plan.layout.lockFile
  if (await c.fs.exists(retirementPath(c.plan.layout))) return refuse(c, 'CONFLICT', RETIREMENT_REQUIRED)
  if (await c.fs.exists(lock)) {
    const held = await readLock(c.fs, lock)
    return refuse(c, 'CONFLICT', held?.state === 'rollback-failed'
      ? `the last upgrade (to ${held.to}) failed to roll back; recover it first`
      : 'another upgrade is in progress (lock file present)')
  }
  if (await c.fs.exists(c.plan.layout.maintenanceFile)) return refuse(c, 'PRECONDITION_FAILED', 'retained maintenance requires explicit lifecycle recovery')
  const refused = await precheck(c)
  if (refused) return refused
  try {
    await c.fs.writeFileExclusive(lock, lockInfo(c, 'running'), 0o600)
  } catch (e) {
    if (errorCode(e) !== 'EEXIST') throw e
    const held = await readLock(c.fs, lock)
    return refuse(c, 'CONFLICT', held?.state === 'rollback-failed'
      ? `the last upgrade (to ${held.to}) failed to roll back; recover it first`
      : 'another upgrade is in progress (lock file present)')
  }
  log(c, 'lock', true, lock)
  let res: UpgradeResult | null = null
  try {
    res = await body()
    return res
  } finally {
    await writeAtomic(c, lock, lockInfo(c, !res || res.outcome === 'rollback_failed' ? 'rollback-failed' : 'retirement-pending'))
  }
}

export const readLock = async (fs: Pick<FsPort, 'readFile'>, path: string): Promise<LockInfo | null> => {
  const raw = await fs.readFile(path)
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as Partial<LockInfo>
    return v && (v.state === 'running' || v.state === 'rollback-failed' || v.state === 'retirement-pending')
      ? { state: v.state, recordId: typeof v.recordId === 'string' ? v.recordId : null, actor: String(v.actor ?? ''), to: String(v.to ?? ''), at: String(v.at ?? '') }
      : null
  } catch {
    return null
  }
}

/**
 * Side-by-side upgrade: preflight, state snapshot, unpack next to the running release,
 * expand-only migrations, atomic link switch, reconcile with reloads, health gate.
 * A failure after the switch rewinds release link, state files, index and units from this
 * upgrade's receipt-verified snapshot, then re-runs the health checks (see RewindState).
 * Host completion remains retirement_pending until a genuine retirement protocol is qualified.
 */
export const runUpgrade = async (ports: UpgradePorts, input: UpgradePlan): Promise<UpgradeResult> => {
  if (!ports.safety || typeof ports.safety.withExclusive !== 'function') return fail('PRECONDITION_FAILED', 'operational lifecycle safety admission is required')
  const c = newCtx(ports, normalizeUpgradePlan(input))
  return ports.safety.withExclusive(() => withLock(c, () => execute(c)))
}

export interface RecoverInput {
  actor: Principal
  os: Pick<OsProfile, 'family'>
  note: string
  canary: string | null
  layout?: Partial<UpgradeLayout>
}

export interface RecoverResult {
  status: 'retirement_pending'
  version: string
  recordId: string | null
  closedRecordId: string | null
  problems: string[]
}

/**
 * Continues a rewind a crash left at `rewind-started`, inside the recovery's admission scope.
 * Terminal journals are never re-run: failed or unverified rewinds wait for the operator.
 */
const resumeRewind = async (ports: UpgradePorts, actor: Principal, os: Pick<OsProfile, 'family'>, layout: UpgradeLayout, recordId: string | null): Promise<RewindJournal | null> => {
  if (recordId === null || !RECORD_ID.test(recordId)) return null
  const fs = guardFs(ports.fs, layout)
  const journal = parseRewindJournal(await fs.readFile(rewindJournalPath(layout, recordId)))
  if (journal?.state !== 'rewind-started' || journal.recordId !== recordId) return null
  const r = parseReceipt(await fs.readFile(receiptPath(layout, recordId)))
  if (!r || r.recordId !== recordId) {
    journal.state = 'rewind-failed'
    journal.problems = ['snapshot receipt is missing or malformed']
    journal.updatedAt = ports.clock.now().toISOString()
    await saveJournal(ports, fs, layout, journal)
    return journal
  }
  const c = newCtx(ports, {
    actor,
    tools: lifecycleTools(os),
    release: r.release,
    canary: r.canary,
    panelUnits: normalizePanelUnits(r.panelUnits),
    panelUser: r.panelUser,
    health: normalizeHealth(r.health),
    layout,
  })
  Object.assign(c, {
    stamp: r.stamp, phase: 'rollback', recordId, from: r.from, fromSchema: r.fromSchema, previousTarget: r.previousTarget,
    snapshot: r.snapshot.path, previousGeneration: r.previousGeneration, identitiesBefore: r.identitiesBefore, effectsStarted: true,
  })
  return rewind(c, journal)
}

/**
 * Operator path after an interrupted upgrade or a failed rollback, once the server was
 * repaired by hand. Refused while the upgrade unit still runs; accepted only when the
 * health checks pass on a valid release link. Records observations but retains all barriers.
 */
const recoverWithinGuard = async (ports: UpgradePorts, input: RecoverInput): Promise<RecoverResult> => {
  const actor = assertRoot(input?.actor, 'recover an upgrade')
  const note = assertText(input.note, 'recovery note', 1000)
  const tools = lifecycleTools(input.os)
  const canary = input.canary === null ? null : assertUsername(input.canary, 'canary account')
  const layout = normalizeLayout(input.layout)
  const fs = guardFs(ports.fs, layout)
  await ports.safety.assertOwnedExecution(DEFAULT_PANEL_UNITS)
  await ports.safety.assertWriteBarrier()
  const lock = await readLock(fs, layout.lockFile)
  const lockPresent = lock !== null || (await fs.exists(layout.lockFile))
  const last = await ports.history.latest()
  if (!lockPresent && !isInFlight(last)) return fail('PRECONDITION_FAILED', 'nothing to recover: no upgrade lock and no upgrade in flight')
  const active = await ports.host.apply({ kind: 'exec', argv: [tools.systemctl, 'is-active', '--quiet', UPGRADE_UNIT] })
  if (active.code === 0) return fail('CONFLICT', `${UPGRADE_UNIT} is still running`)
  if (active.code !== 3) return fail('PRECONDITION_FAILED', 'upgrade unit state is unknown; recovery cannot clear admission')
  const rewound = await resumeRewind(ports, actor, input.os, layout, lock?.recordId ?? (last && isInFlight(last) ? last.id : null))
  if (rewound && rewound.state !== 'rewind-verified') {
    return fail('PRECONDITION_FAILED', `rewind unverified; operator action required: ${rewound.problems.join('; ')}`, { rewind: rewound })
  }
  const version = versionFromTarget(await fs.readlink(layout.currentLink), layout)
  if (!version) return fail('PRECONDITION_FAILED', `${layout.currentLink} does not point at a release`)
  const problems = await healthProblems({ ports, canary, before: null })
  if (problems.length) return fail('PRECONDITION_FAILED', `server is not healthy yet: ${problems.join('; ')}`, { problems })
  await retainRetirementAttention(ports, fs, layout, { recoveryObserved: true, version, recordId: last?.id ?? null, observedAt: ports.clock.now().toISOString() })
  const recordId = last && isInFlight(last) ? last.id : null
  await ports.audit.record(auditEntry(actor, 'upgrade.recovery_observed', 'xpanel', { note, version, lock, recordId, closedRecordId: null, rewind: rewound?.state ?? null, retirementPending: true }, 'failed', { now: ports.clock.now() }))
  return { status: 'retirement_pending', version, recordId, closedRecordId: null, problems: [RETIREMENT_REQUIRED] }
}

export const recoverUpgrade = async (ports: UpgradePorts, input: RecoverInput): Promise<RecoverResult> => {
  if (!ports.safety || typeof ports.safety.withExclusive !== 'function') return fail('PRECONDITION_FAILED', 'operational lifecycle safety admission is required')
  // Reject malformed requests before the native producer announces an operation.
  const validated: RecoverInput = {
    ...input,
    actor: assertRoot(input?.actor, 'recover an upgrade'),
    note: assertText(input.note, 'recovery note', 1000),
    canary: input.canary === null ? null : assertUsername(input.canary, 'canary account'),
    layout: normalizeLayout(input.layout),
  }
  lifecycleTools(validated.os)
  return ports.safety.withExclusive(() => recoverWithinGuard(ports, validated))
}
