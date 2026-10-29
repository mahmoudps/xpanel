import { createHash } from 'node:crypto'
import { fail, isXpanelError, msgid } from '@xpanel/core'
import { APT_UPGRADE_ENV, isPackageManagerCommand, packageUpgradeArgv } from '../../../packages/os/src/package-manager-command.ts'
import { DB_ADMIN_DEFAULTS_FILE, DB_UPGRADE_BACKUP_DIR, DB_UPGRADE_BACKUP_DIR_ARGV, MARIADB_UPGRADE_ARGV, dbUpgradeBackupFile, isDatabaseEngineCommand, mariadbTryRestartArgv, mariadbUpgradeDumpArgv } from '../../../packages/os/src/db-engines-command.ts'
import { comparePackageVersions, isSelectablePackage, readSystemUpdatePlan } from './package-manager.ts'
import type { SystemUpdatePackage } from './package-manager.ts'
import type { HostJobCommandStep, HostJobPlan, HostJobRun, HostJobView } from './host-job-contract.ts'
import { readDbPackages } from './db-engines.ts'
import type { DbFamily, DbRun } from './db-engines.ts'

/** Server version as reported by SELECT VERSION(); the same reviewed statement the database pages use. */
export interface DbUpgradeSql { version(): Promise<string> }
export interface DbUpgradeObservation {
  state: 'read' | 'unavailable'
  reason: 'unsupported-host' | 'not-installed' | 'package-manager-unavailable' | 'package-manager-busy' | 'invalid-package-manager-output' | 'admin-credentials-unsupported' | null
  observedAt: string
  revision: string | null
  family: DbFamily | null
  installed: { name: string; version: string } | null
  running: string | null
  unit: { unit: string; active: string } | null
  packages: SystemUpdatePackage[]
  blocked: string[]
  backupDirectory: string
  canApply: boolean
}

// Distribution and MariaDB-repository package families; the base name drops a Debian :arch or an RPM .arch suffix.
export const isMariadbPackage = (family: DbFamily, name: string): boolean => /^(?:mariadb|galera|libmariadb|mysql-common)(?:[-0-9]|$)/.test(family === 'debian' ? name.split(':')[0]! : name.slice(0, name.lastIndexOf('.')))
/** Upstream x.y.z from a package version ("1:10.11.6-0+deb12u1", "3:10.5.22-1.el9") or VERSION() ("10.11.6-MariaDB-0+deb12u1"). */
export const upstreamVersion = (value: string | null): string | null => /^(?:[0-9]+:)?([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4})/.exec(value ?? '')?.[1] ?? null

export async function readDbUpgrade(input: { family: DbFamily | null; run: DbRun | null; sql: DbUpgradeSql | null; adminDefaultsFile: string | null; jobs: boolean; now?: () => Date }): Promise<DbUpgradeObservation> {
  const observedAt = (input.now ?? (() => new Date()))().toISOString()
  const base = { observedAt, revision: null, family: input.family, installed: null, running: null, unit: null, packages: [], blocked: [], backupDirectory: DB_UPGRADE_BACKUP_DIR, canApply: false }
  if (!input.family || !input.run) return { ...base, state: 'unavailable', reason: 'unsupported-host' }
  const products = await readDbPackages({ family: input.family, run: input.run }), mariadb = products.products.mariadb
  if (products.state !== 'read') return { ...base, state: 'unavailable', reason: 'package-manager-unavailable' }
  if (!mariadb.installed) return { ...base, state: 'unavailable', reason: 'not-installed' }
  const unit = typeof mariadb.service === 'object' && mariadb.service ? { unit: mariadb.service.unit, active: mariadb.service.active } : null
  let running: string | null = null
  if (input.sql) try { running = await input.sql.version() } catch { running = null }
  const plan = await readSystemUpdatePlan({ run: input.run, family: input.family, ...(input.now ? { now: input.now } : {}) })
  const known = { ...base, installed: mariadb.package, running, unit }
  if (plan.state !== 'read' || !plan.revision) return { ...known, state: 'unavailable', reason: plan.reason === 'package-manager-busy' || plan.reason === 'invalid-package-manager-output' ? plan.reason : 'package-manager-unavailable' }
  const family = input.family, packages = plan.packages.filter(entry => isMariadbPackage(family, entry.name))
  const blocked = packages.filter(entry => !isSelectablePackage(entry)).map(entry => entry.name)
  const revision = createHash('sha256').update(JSON.stringify({ plan: plan.revision, installed: mariadb.package, running, unit, packages })).digest('hex')
  // The fixed dump grammar names the default protected credential file; a custom path is never interpolated.
  const credentials = input.adminDefaultsFile === DB_ADMIN_DEFAULTS_FILE
  return { ...known, state: 'read', reason: credentials ? null : 'admin-credentials-unsupported', revision, packages, blocked, canApply: credentials && input.jobs && !!unit && unit.active === 'active' && running !== null && packages.length > 0 && blocked.length === 0 }
}

const stampOf = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.[0-9]{3}Z$/, 'Z')
/** Backup, upgrade, restart, system-table upgrade; success only when the re-read host shows the new version running. */
export function buildDbUpgradeJobPlan(input: { observed: DbUpgradeObservation; now: Date; sql: DbUpgradeSql; assertRoot(): Promise<unknown> }): HostJobPlan {
  const { observed } = input, family = observed.family
  if (observed.state !== 'read' || !observed.canApply || !family || !observed.unit || !observed.revision) return fail('PRECONDITION_FAILED', 'no reviewed MariaDB upgrade can be applied', { stateChanged: false })
  const names = observed.packages.map(entry => entry.name).sort(), stamp = stampOf(input.now), backup = dbUpgradeBackupFile(stamp)
  const target = observed.packages.find(entry => /^(?:mariadb-server)(?:[.:]|$)/.test(entry.name))?.candidate ?? observed.packages[0]!.candidate
  const steps: HostJobCommandStep[] = [
    { id: 'prepare-backup', title: msgid('Prepare the protected backup directory'), argv: [...DB_UPGRADE_BACKUP_DIR_ARGV], timeoutMs: 30_000, mutates: true },
    { id: 'backup', title: msgid('Back up all databases'), argv: mariadbUpgradeDumpArgv(stamp), timeoutMs: 3_600_000, mutates: true },
    { id: 'upgrade-packages', title: msgid('Upgrade MariaDB packages'), argv: packageUpgradeArgv(family, names), timeoutMs: 1_800_000, mutates: true, ...(family === 'debian' ? { env: APT_UPGRADE_ENV } : {}) },
    { id: 'restart', title: msgid('Restart MariaDB'), argv: mariadbTryRestartArgv(observed.unit.unit), timeoutMs: 300_000, mutates: true },
    { id: 'upgrade-tables', title: msgid('Upgrade MariaDB system tables'), argv: [...MARIADB_UPGRADE_ARGV], timeoutMs: 1_800_000, mutates: true },
  ]
  return {
    kind: 'database.mariadb.upgrade',
    summary: `Upgrade MariaDB from ${observed.installed?.version ?? 'unknown'} to ${target}`,
    accountId: null,
    fingerprint: { revision: observed.revision, packages: createHash('sha256').update(names.join('\n')).digest('hex') },
    detail: { family, from: observed.installed?.version ?? null, to: target, running: observed.running, packages: names.slice(0, 50), backup },
    steps,
    policy: argv => isDatabaseEngineCommand(argv) || isPackageManagerCommand(argv),
    beforeStep: async () => { await input.assertRoot() },
    verify: async (run: HostJobRun) => {
      const plan = await readSystemUpdatePlan({ run: argv => run(argv, { env: { LC_ALL: 'C' }, timeoutMs: 300_000 }), family })
      let running: string | null = null
      try { running = await input.sql.version() } catch { running = null }
      const pending = plan.state === 'read' ? plan.packages.filter(entry => isMariadbPackage(family, entry.name) && observed.packages.some(old => old.name === entry.name && comparePackageVersions(family, entry.candidate, old.candidate) <= 0)).map(entry => entry.name) : null
      const ok = pending !== null && pending.length === 0 && running !== null && upstreamVersion(running) === upstreamVersion(target)
      return { ok, detail: { running, expected: upstreamVersion(target), pending: pending ?? 'not-read', backup } }
    },
  }
}

export interface DbUpgradeRouteDeps {
  assertRoot(action: string): Promise<{ actor: string }>
  family: DbFamily | null
  run: DbRun | null
  sql: DbUpgradeSql | null
  adminDefaultsFile: string | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  now?: () => Date
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
export async function handleDbUpgradeRoute(req: Request, url: URL, method: string, deps: DbUpgradeRouteDeps): Promise<Response | null> {
  const apply = url.pathname === '/host/databases/upgrade/apply'
  if (url.pathname !== '/host/databases/upgrade' && !apply) return null
  if (method !== (apply ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: apply ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'the database upgrade does not accept selectors', { stateChanged: false })
  const action = apply ? 'host.databases.upgrade' : 'host.databases.upgrade.read', first = await deps.assertRoot(action)
  const fresh = async (): Promise<string> => { const current = await deps.assertRoot(action); return current.actor === first.actor ? current.actor : fail('FORBIDDEN', 'database upgrade authority changed', { stateChanged: false }) }
  const read = () => readDbUpgrade({ family: deps.family, run: deps.run, sql: deps.sql, adminDefaultsFile: deps.adminDefaultsFile, jobs: deps.submitJob !== null, ...(deps.now ? { now: deps.now } : {}) })
  if (!apply) { const observed = await read(); await fresh(); return json(200, observed) }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  let body: unknown
  try { const text = await req.text(); body = text.length <= 256 ? JSON.parse(text) : null } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { expectedRevision?: unknown }).expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test((body as { expectedRevision: string }).expectedRevision)) return fail('VALIDATION', 'exactly the observed expectedRevision is required', { stateChanged: false })
  if (!deps.submitJob || !deps.sql || !deps.run) return fail('PRECONDITION_FAILED', 'the host job runner or MariaDB administration is unavailable; nothing was submitted', { stateChanged: false })
  const observed = await read()
  if (observed.revision !== (body as { expectedRevision: string }).expectedRevision) return fail('CONFLICT', 'the MariaDB upgrade plan changed since it was reviewed', { stateChanged: false, currentRevision: observed.revision })
  const plan = buildDbUpgradeJobPlan({ observed, now: (deps.now ?? (() => new Date()))(), sql: deps.sql, assertRoot: fresh })
  const actor = await fresh()
  let job: HostJobView
  try { job = await deps.submitJob(plan, actor) }
  catch (error) {
    if (isXpanelError(error) && error.detail.stateChanged === false) throw error
    return fail('SERVICE_UNAVAILABLE', 'the database upgrade submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  if (!job || typeof job.id !== 'string' || job.kind !== plan.kind) return fail('SERVICE_UNAVAILABLE', 'the database upgrade submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return json(202, { job })
}
