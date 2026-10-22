import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import type { Engine, OsProfile, ServiceRole } from '@xpanel/core'
import { assertUnitName } from '@xpanel/os'
import type { LifecycleStep } from '../steps.ts'
import { assertSafeAbsPath, isUnder, isUnderHomes } from '../validate.ts'
import { assertApplicable, buildReview, reviewDigest } from './session.ts'
import type { TransferSession } from './session.ts'

/** Pull one account archive from the source (ssh `xpanel export` or the export API). */
export interface TransferFetchStep {
  kind: 'transfer-fetch'
  sessionId: string
  account: string
  to: string
}

/** Run importAccountArchive on a fetched archive and write the result into desired state. */
export interface ImportArchiveStep {
  kind: 'import-archive'
  sessionId: string
  path: string
  sourceUsername: string
  targetUsername: string
  plan: string
  dropDomains: string[]
}

export interface CreatePlanStep {
  kind: 'create-plan'
  sessionId: string
  source: string
  target: string
}

export type TransferStep = LifecycleStep | TransferFetchStep | ImportArchiveStep | CreatePlanStep

const DEFAULT_TRANSFER_STAGING = '/var/lib/xpanel/transfers'

/** Services every account shares. Account units (slice, FPM pools) are new and only ever started. */
const SHARED_ROLES: readonly ServiceRole[] = ['nginx', 'apache', 'openlitespeed', 'mariadb', 'postgresql', 'postfix', 'dovecot', 'powerdns', 'redis', 'ftp', 'sshd', 'nftables']

export const sharedUnits = (os: OsProfile): string[] => [...new Set(SHARED_ROLES.map((r) => os.services[r]))]

/**
 * What an imported account needs picked up: its vhosts, mail domains and zones, all by reload.
 * Mail and DNS are opt-in, so only the roles installed here are reloaded; the edge and the
 * engine must be installed.
 */
export const transferReloadUnits = (os: OsProfile, engine: Engine, installed: readonly ServiceRole[]): string[] => {
  if (engine !== 'apache' && engine !== 'openlitespeed') fail('VALIDATION', 'unknown engine')
  const has = new Set(installed)
  for (const role of ['nginx', engine] as const) if (!has.has(role)) fail('PRECONDITION_FAILED', `${role} is not installed on this server`)
  const roles: ServiceRole[] = ['nginx', engine, ...(['postfix', 'dovecot', 'powerdns'] as const).filter((r) => has.has(r))]
  return roles.map((r) => assertUnitName(os.services[r]))
}

const STOPPING_VERBS = new Set([
  'restart', 'stop', 'try-restart', 'reload-or-restart', 'try-reload-or-restart', 'condrestart', 'force-reload',
  'kill', 'disable', 'mask', 'isolate', 'reboot', 'poweroff', 'halt', 'rescue', 'emergency', 'graceful-stop',
])

/** systemctl/service/apachectl with a stopping verb, or `nginx -s stop|quit`. */
const stopsAService = (argv: readonly string[]): boolean => {
  const bin = posix.basename(argv[0] ?? '')
  const args = argv.slice(1)
  if (bin === 'nginx') return args.some((a, i) => a === '-s' && (args[i + 1] === 'stop' || args[i + 1] === 'quit'))
  return ['systemctl', 'service', 'apachectl', 'apache2ctl', 'httpd'].includes(bin) && args.some((a) => STOPPING_VERBS.has(a))
}

/**
 * The transfer guarantee: nothing in the plan restarts or stops a shared service. systemd
 * actions may only reload shared units, reconciles run reload-only, and no exec carries a
 * stopping verb. Starting a new account's own units is allowed.
 */
export const assertNoSharedRestart = (steps: readonly TransferStep[], shared: readonly string[]): void => {
  const isShared = new Set(shared)
  for (const s of steps) {
    if (s.kind === 'systemd' && s.verb !== 'reload' && (isShared.has(s.unit) || s.verb === 'restart' || s.verb === 'stop' || s.verb === 'disable')) {
      fail('CONFLICT', `transfer plan would ${s.verb} ${s.unit}; only reloads are allowed during a transfer`, { unit: s.unit, verb: s.verb })
    }
    if (s.kind === 'reconcile' && s.sharedUnits !== 'reload-only') fail('CONFLICT', 'a transfer reconcile must be reload-only')
    if ((s.kind === 'exec' || s.kind === 'exec-io') && stopsAService(s.argv)) {
      fail('CONFLICT', `transfer plan runs ${s.argv.join(' ').slice(0, 200)}; only reloads are allowed`)
    }
  }
}

export interface ApplyPlanOptions {
  os: OsProfile
  engine: Engine
  /** service roles installed on this server (mail, DNS and FTP are opt-in) */
  services: readonly ServiceRole[]
  stagingRoot?: string
}

/** Steps for a confirmed session: per account fetch, import, reconcile (reload-only) and reload. */
export const buildApplyPlan = (s: TransferSession, opts: ApplyPlanOptions): TransferStep[] => {
  if (s.state !== 'applying' && s.state !== 'reviewed') fail('PRECONDITION_FAILED', `session is ${s.state}; review and confirm first`)
  const review = buildReview(s)
  if (reviewDigest(review) !== s.reviewDigest) fail('CONFLICT', 'session changed since review')
  assertApplicable(review, s.local)
  const reloads = transferReloadUnits(opts.os, opts.engine, opts.services)
  const staging = assertSafeAbsPath(opts.stagingRoot ?? DEFAULT_TRANSFER_STAGING, 'staging root')
  if (isUnderHomes(staging)) fail('VALIDATION', 'transfer staging must not be inside homes')
  const dir = posix.join(staging, s.id)
  const steps: TransferStep[] = [{ kind: 'ensure-dir', path: dir, mode: 0o700, owner: 'root', group: 'root' }]
  for (const p of review.plans) if (p.action !== 'map') steps.push({ kind: 'create-plan', sessionId: s.id, source: p.source, target: p.target })
  for (const a of review.accounts) {
    const file = posix.join(dir, `${a.source}.tar.gz`)
    if (!isUnder(file, dir)) fail('VALIDATION', `unsafe archive path for ${a.source}`)
    steps.push({ kind: 'transfer-fetch', sessionId: s.id, account: a.source, to: file })
    steps.push({ kind: 'import-archive', sessionId: s.id, path: file, sourceUsername: a.source, targetUsername: a.target, plan: a.plan, dropDomains: a.droppedDomains })
    steps.push({ kind: 'reconcile', reason: `transfer ${s.id}: ${a.source} -> ${a.target}`, sharedUnits: 'reload-only' })
    for (const unit of reloads) steps.push({ kind: 'systemd', verb: 'reload', unit })
    steps.push({ kind: 'remove-path', path: file })
  }
  steps.push({ kind: 'remove-path', path: dir })
  assertNoSharedRestart(steps, sharedUnits(opts.os))
  return steps
}
