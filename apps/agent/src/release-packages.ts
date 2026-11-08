import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { fail, msgid } from '@xpanel/core'
import type { RenderedFile } from '@xpanel/core'
import { releaseFeatures, rhelAwstatsFile } from '@xpanel/os'
import type { XpanelOsProfile } from '@xpanel/os'
import { withLifecycleWriterAdmission } from '../../../scripts/lifecycle-admission.mjs'
import { APT_UPGRADE_ENV } from '../../../packages/os/src/package-manager-command.ts'
import { isSoftwareCenterCommand, softwareCenterArgv } from '../../../packages/os/src/software-center-command.ts'
import { LinuxHostExecutor } from './executor.ts'
import type { AgentExecutor } from './executor.ts'
import type { HostJobCommandStep, HostJobPlan, HostJobStepRun, HostJobView } from './host-job-contract.ts'
import type { HostJobRunner } from './host-jobs.ts'
import { nativePackageSafetyPorts, observePackageSafety, packageSafetyRefusal, withPackageSafety } from './ops-package-writers.ts'
import type { PackageSafety, PackageSafetyRefusal } from './ops-package-writers.ts'
import { refreshStep } from './package-manager.ts'
import { readPackages } from './software-center.ts'
import type { SoftwareCenterRun } from './software-center.ts'

/** The job kind carries the version, so finished jobs of a release are its record: no second state file. */
export const RELEASE_PACKAGES_JOB_KIND = 'system.packages.release'
export const RELEASE_INSTALLER = '/opt/xpanel/current/scripts/install.sh'
const AUTOMATIC_ACTOR = 'system:release-packages'
const STEP_TIMEOUT_MS = 1_800_000
const SERVICE_STEP_TIMEOUT_MS = 60_000

export interface ReleaseFeatureRow { id: string; state: 'complete' | 'missing' | 'not-selected'; missing: string[] }
export type ReleasePackagesSummary = 'complete' | 'missing' | 'job-active' | 'unsupported-host' | 'package-database-unavailable' | 'invalid-package-database'
export interface ReleasePackagesView {
  state: 'read' | 'unavailable'
  summary: ReleasePackagesSummary
  release: string | null
  observedAt: string
  revision: string | null
  features: ReleaseFeatureRow[]
  jobStatus: HostJobView['status'] | 'none'
  jobReference: string
}

export interface ReleasePackagesDeps {
  /** The installed release; null on a checkout without one. */
  version: string | null
  /** null off a supported native Linux host. */
  profile: XpanelOsProfile | null
  run: SoftwareCenterRun
  exists(path: string): Promise<boolean>
  readFile(path: string): Promise<string | null>
  writeFile(file: RenderedFile): Promise<void>
  safety(): Promise<PackageSafety>
  jobs: Pick<HostJobRunner, 'list' | 'submit'> | null
  reconcile(): Promise<void>
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' }): Promise<unknown>
  /** Writer admission for one short effect, never for the job it queues. */
  admit<T>(work: () => Promise<T>): Promise<T>
  now?: () => Date
}

export interface ReleasePackages {
  read(): Promise<ReleasePackagesView>
  /** The operator path: refuses a stale revision, and a host with nothing to install or a package manager at work. */
  retry(expectedRevision: string, assertCurrent: () => Promise<{ actor: string }>): Promise<HostJobView>
  /** One automatic attempt per release, on the agent's minute timer, which never starts behind the lifecycle barrier. */
  tick(): Promise<void>
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const missingRows = (rows: readonly ReleaseFeatureRow[]): ReleaseFeatureRow[] => rows.filter(row => row.state === 'missing')
const refuseSafety = (reason: PackageSafetyRefusal): never => fail('PRECONDITION_FAILED', 'a package manager is at work or the package database needs repair', { stateChanged: false, reason })

export function createReleasePackages(deps: ReleasePackagesDeps): ReleasePackages {
  const { profile, version } = deps
  const family = profile?.family === 'debian' || profile?.family === 'rhel' ? profile.family : null
  const features = profile && family ? releaseFeatures(profile) : []
  const names = [...new Set(features.flatMap(feature => feature.packages))]
  const kind = `${RELEASE_PACKAGES_JOB_KIND}:${version}`
  const now = deps.now ?? (() => new Date())
  let settled = false, ticking = false

  const observe = async (query: SoftwareCenterRun): Promise<{ rows: ReleaseFeatureRow[] } | { reason: 'package-database-unavailable' | 'invalid-package-database' }> => {
    const packages = await readPackages(family!, query, names)
    if (packages === 'unavailable') return { reason: 'package-database-unavailable' }
    if (packages === 'invalid') return { reason: 'invalid-package-database' }
    const present = (name: string): boolean => packages.get(name)?.installed === true
    return { rows: await Promise.all(features.map(async (feature): Promise<ReleaseFeatureRow> => {
      if (feature.selectedBy.length > 0 && !feature.selectedBy.some(present)) return { id: feature.id, state: 'not-selected', missing: [] }
      const builds = await Promise.all(feature.builds.map(async build => await deps.exists(build.path) ? [] : [build.id]))
      const missing = [...feature.packages.filter(name => !present(name)), ...builds.flat()]
      return { id: feature.id, state: missing.length ? 'missing' : 'complete', missing }
    })) }
  }

  const latestJob = async (): Promise<HostJobView | null> =>
    (await deps.jobs?.list({ kindPrefix: kind, limit: 20 }))?.find(job => job.kind === kind) ?? null

  const read = async (): Promise<ReleasePackagesView> => {
    const blank = { release: version, observedAt: now().toISOString(), revision: null, features: [], jobStatus: 'none' as const, jobReference: '' }
    if (!family || !version) return { ...blank, state: 'unavailable', summary: 'unsupported-host' }
    const seen = await observe(deps.run)
    if ('reason' in seen) return { ...blank, state: 'unavailable', summary: seen.reason }
    const job = await latestJob(), active = job?.status === 'queued' || job?.status === 'running'
    return { ...blank, state: 'read', summary: active ? 'job-active' : missingRows(seen.rows).length ? 'missing' : 'complete',
      revision: sha256(JSON.stringify({ release: version, features: seen.rows })), features: seen.rows, jobStatus: job?.status ?? 'none', jobReference: job?.referenceCode ?? '' }
  }

  /** A stock file the awstats RPM brings in serves its CGI to `Require local`, and behind the nginx edge everyone is local. */
  const writeManagedFiles = async (): Promise<void> => {
    for (const file of family === 'rhel' ? rhelAwstatsFile(profile!) : []) {
      if (await deps.readFile(file.path) !== file.content) await deps.admit(() => deps.writeFile(file))
    }
  }

  const plan = (rows: readonly ReleaseFeatureRow[], revision: string): HostJobPlan => {
    const wanted = missingRows(rows).map(row => {
      const feature = features.find(item => item.id === row.id)!
      return { feature, packages: feature.packages.filter(name => row.missing.includes(name)), builds: feature.builds.filter(build => row.missing.includes(build.id)) }
    })
    const slug = (id: string): string => id.replaceAll('.', '-')
    // A failed step must not cost the features after it: the steps only try, and the package re-read below decides the outcome.
    const installs: HostJobCommandStep[] = wanted.filter(item => item.packages.length).map(item => ({
      id: `install-${slug(item.feature.id)}`, title: msgid('Install the missing packages of {feature}'), titleValues: { feature: item.feature.id },
      argv: softwareCenterArgv(family === 'debian' ? 'apt-install' : 'dnf-install', item.packages), mutates: true, timeoutMs: STEP_TIMEOUT_MS, successExitCodes: [family === 'debian' ? 100 : 1],
      ...(family === 'debian' ? { env: APT_UPGRADE_ENV } : {}),
    }))
    const builds: HostJobCommandStep[] = wanted.flatMap(item => item.builds).map(build => ({
      id: `build-${build.id}`, title: msgid('Build {component} from its pinned source'), titleValues: { component: build.id },
      argv: ['/bin/bash', RELEASE_INSTALLER, `--el-source-build=${build.id}`], mutates: true, timeoutMs: STEP_TIMEOUT_MS, successExitCodes: [1],
    }))
    // systemctl(1) exits 5 on a unit that is not loaded, which is what a failed install leaves.
    const daemons: HostJobCommandStep[] = wanted.filter(item => item.packages.length).flatMap(item => item.feature.daemonsOff).flatMap(unit => (['stop', 'disable'] as const).map(verb => ({
      id: `${verb}-${unit}`, title: verb === 'stop' ? msgid('Stop the distribution service {unit}') : msgid('Disable the distribution service {unit}'), titleValues: { unit },
      argv: [profile!.bin.systemctl, verb, unit], mutates: true, timeoutMs: SERVICE_STEP_TIMEOUT_MS, successExitCodes: [1, 5],
    })))
    const steps = [...(family === 'debian' ? [refreshStep(family)] : []), ...installs, ...builds, ...daemons]
    const reviewed = new Set(steps.map(step => JSON.stringify(step.argv)))
    const guarded = withPackageSafety({
      kind, summary: `Install the packages release ${version} declares`, accountId: null,
      fingerprint: { release: version, revision },
      detail: { release: version, missing: Object.fromEntries(missingRows(rows).map(row => [row.id, row.missing])) },
      steps,
      policy: candidate => reviewed.has(JSON.stringify(candidate)) || isSoftwareCenterCommand(candidate) && (candidate[0] === '/usr/bin/dpkg-query' || candidate[0] === '/usr/bin/rpm'),
      verify: async run => {
        const seen = await observe(run)
        if ('reason' in seen) return { ok: false, detail: { reason: seen.reason } }
        // The compile reads which optional modules exist, so a new one takes effect through a reconcile.
        const reconcile = await deps.reconcile().then(() => 'applied', () => 'failed')
        const missing = Object.fromEntries(missingRows(seen.rows).map(row => [row.id, row.missing]))
        return { ok: Object.keys(missing).length === 0 && reconcile === 'applied', detail: { missing, reconcile } }
      },
    }, family!, deps.safety, refuseSafety)
    const databaseCheck = guarded.finalize!
    return { ...guarded, finalize: async (run: HostJobStepRun, results) => {
      const checked = await databaseCheck(run, results)
      return writeManagedFiles().then(() => checked, () => ({ ok: false, detail: { ...checked.detail, managedFile: 'not-written' } }))
    } }
  }

  const submit = (view: ReleasePackagesView, actor: string): Promise<HostJobView> => deps.admit(async () => {
    const { job } = await deps.jobs!.submit(plan(view.features, view.revision!), actor)
    await deps.audit({ actor, action: 'upgrade.packages_queued', target: `release:${version}`, detail: { jobId: job.id, features: missingRows(view.features).map(row => row.id) }, outcome: 'ok' })
    return job
  })

  return {
    read,
    async retry(expectedRevision, assertCurrent) {
      if (!deps.jobs) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable; no package change was submitted', { stateChanged: false })
      const view = await read()
      if (view.state !== 'read') return fail('PRECONDITION_FAILED', 'the package database could not be observed', { stateChanged: false, reason: view.summary })
      if (view.revision !== expectedRevision) return fail('CONFLICT', 'installed packages changed since they were reviewed', { stateChanged: false, currentRevision: view.revision })
      if (view.summary === 'job-active') return fail('PRECONDITION_FAILED', 'a package job of this release is still running', { stateChanged: false, reason: 'job-active' })
      if (view.summary === 'complete') return fail('PRECONDITION_FAILED', 'every declared package is already installed', { stateChanged: false, reason: 'nothing-missing' })
      const reason = packageSafetyRefusal(await deps.safety())
      if (reason) return refuseSafety(reason)
      return submit(view, (await assertCurrent()).actor)
    },
    async tick() {
      if (settled || ticking || !family || !version || !deps.jobs) return
      ticking = true
      // A failed tick is retried by the next one; it must never reject inside the timer.
      try {
        await writeManagedFiles()
        const view = await read()
        if (view.state !== 'read') return
        if (view.summary === 'complete' || view.jobStatus !== 'none') { settled = true; return }
        if (packageSafetyRefusal(await deps.safety())) return
        await submit(view, AUTOMATIC_ACTOR)
        settled = true
      } catch { /* next minute */ } finally { ticking = false }
    },
  }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const ROUTES: Readonly<Record<string, string>> = { '/host/upgrade/packages': 'GET', '/host/upgrade/packages/retry': 'POST' }

/** Root-only: the per-feature report of the installed release, and the operator retry of its package job. */
export async function handleReleasePackagesRoute(req: Request, url: URL, method: string, ctx: { assertRoot(action: string): Promise<{ actor: string }>; packages: ReleasePackages | null }): Promise<Response | null> {
  const expected = ROUTES[url.pathname]
  if (!expected) return null
  await ctx.assertRoot('host.upgrade.packages')
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'release package routes do not accept selectors', { stateChanged: false })
  if (!ctx.packages) return fail('SERVICE_UNAVAILABLE', 'release packages are not connected on this agent', { stateChanged: false })
  if (expected === 'GET') return json(await ctx.packages.read())
  let body: unknown
  try { body = JSON.parse((await req.text()).slice(0, 4096)) } catch { body = null }
  const value = body as Record<string, unknown> | null
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'expectedRevision' || typeof value.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedRevision)) return fail('VALIDATION', 'the observed package revision is required', { stateChanged: false })
  const job = await ctx.packages.retry(value.expectedRevision, () => ctx.assertRoot('host.upgrade.packages'))
  return json({ job: { id: job.id, status: job.status } }, 202)
}

/** The running agent's composition. */
export const createNativeReleasePackages = (input: { version: string | null; os: XpanelOsProfile; executor: AgentExecutor; hostJobs: HostJobRunner | undefined; reconcile: () => Promise<{ status: string }>; audit: ReleasePackagesDeps['audit'] }): ReleasePackages => createReleasePackages({
  version: input.version, profile: process.platform === 'linux' ? input.os : null,
  // A dnf metadata refresh can exceed the default 30 s command timeout.
  run: argv => new LinuxHostExecutor({ timeoutMs: 180_000 }).runCommand([...argv]),
  exists: path => stat(path).then(info => info.isFile(), () => false),
  readFile: path => input.executor.readFile(path),
  writeFile: file => input.executor.writeFile(file),
  safety: () => observePackageSafety(input.os.family === 'debian' ? 'debian' : 'rhel', nativePackageSafetyPorts(argv => input.executor.runCommand(argv))),
  jobs: input.hostJobs ?? null,
  reconcile: async () => { if ((await input.reconcile()).status === 'failed') throw new Error('reconcile failed') },
  audit: input.audit,
  admit: withLifecycleWriterAdmission,
})
