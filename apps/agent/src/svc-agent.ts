import { stat } from 'node:fs/promises'
import type { Account, OsProfile } from '@xpanel/core'
import { appendAudit } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { edge } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AgentExecutor } from './executor.ts'
import type { HostJobRunner } from './host-jobs.ts'
import type { ScanScope } from '../../../packages/os/src/security-tools-command.ts'
import { readSvcPolicy, writeSvcState } from './svc-reconcile.ts'
import type { SvcRouteContext } from './svc-routes.ts'
import { appendKillerRun, parseKillerReports, PROCESS_KILLER_REPORT_PATH, runProcessKiller } from './svc-process-killer.ts'
import { createNightlyMaintenance, checkInstalledRelease, PACKAGE_CHECK_PATH } from './svc-nightly.ts'
import { createProcessLogSampler, parseDbProcessCounts, PROCESS_LOG_PATH } from './svc-process-log.ts'
import { readSavedTweakValues } from './tweak-values.ts'
import { readWebStatusToken } from './svc-web-status.ts'
import { fetchVendorMetadata, installVendor, parseInstalledVendors, recordInstalledVendor, vendorUnchanged, WAF_VENDOR_INSTALLED_PATH } from './svc-waf.ts'

interface SvcDeps { store: StateStore; executor?: AgentExecutor | null; hostJobs?: Pick<HostJobRunner, 'submit'> | null; db: Db }

const fpmPools = (snapshot: Awaited<ReturnType<StateStore['readSnapshot']>>): { account: string; version: string }[] => {
  const owners = new Map(snapshot.accounts.filter(account => account.status !== 'terminating').map(account => [account.id, account.username]))
  const seen = new Map<string, { account: string; version: string }>()
  for (const domain of snapshot.domains) {
    const account = owners.get(domain.accountId)
    if (account && domain.siteType === 'php' && domain.php.handler === 'fpm') seen.set(account + ' ' + domain.php.version, { account, version: domain.php.version })
  }
  return [...seen.values()].sort((left, right) => left.account.localeCompare(right.account) || left.version.localeCompare(right.version))
}

/** Route ports of the running agent; the route module itself stays free of daemon wiring. */
export const svcRouteContext = (deps: SvcDeps, assertRoot: SvcRouteContext['assertRoot'], profile: OsProfile | null, linuxHost: boolean, principalId: string): SvcRouteContext => ({
  assertRoot,
  executor: linuxHost && deps.executor ? deps.executor : null,
  family: profile?.family === 'debian' || profile?.family === 'rhel' ? profile.family : null,
  phpBinary: profile ? version => profile.phpBinary(version) : null,
  rootDir: deps.store.rootDir,
  accounts: async () => (await deps.store.readSnapshot()).accounts,
  fpmPools: async () => fpmPools(await deps.store.readSnapshot()),
  server: async () => { const settings = await deps.store.getServerSettings(); return settings ? { engine: settings.engine, backendPort: settings.backendPort } : null },
  webStatusPath: linuxHost ? async () => edge.webStatusPath(await readWebStatusToken()) : null,
  submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
  audit: entry => appendAudit(deps.db, { ...entry, principalId }),
  writeReports: value => writeSvcState(PROCESS_KILLER_REPORT_PATH, value),
})

/** Saved scope of one user for a scan of `home`, minus areas this home does not have; undefined scans the whole home. */
export async function scanScopeFor(root: string, home: string, username: string): Promise<ScanScope | undefined> {
  const policy = await readSvcPolicy(root, 'antivirus-scope')
  if (!policy) return undefined
  const scope = policy.users[username] ?? policy.global
  if (scope.home) return scope
  const exists = (folder: string): Promise<boolean> => stat(`${home}/${folder}`).then(facts => facts.isDirectory(), () => false)
  return { ...scope, mail: scope.mail && await exists('mail'), publicFtp: scope.publicFtp && await exists('public_ftp'), publicWeb: scope.publicWeb && await exists('public_html') }
}

const UPDATE_JOB_PREFIXES: readonly string[] = ['system.packages.', 'system.repair.', 'php.']
export interface SvcBackgroundDeps {
  store: StateStore
  executor: AgentExecutor
  hostJobs: Pick<HostJobRunner, 'pruneLogs'> | null
  /** the installed release root; null on a checkout without a signed manifest */
  releaseRoot: string | null
  /** PROCESSLIST rows of the MariaDB server, or null when it is not reachable */
  readDbProcesses: () => Promise<{ user: string; count: number }[]>
  reconcile: () => Promise<unknown>
}

/** The sampler and the nightly run behind the agent's existing minute timer: no new daemon or timer unit. */
export function createSvcBackground(deps: SvcBackgroundDeps): { tick: () => Promise<void> } {
  const run = (argv: string[]) => deps.executor.runCommand(argv)
  const accounts = async (): Promise<readonly Account[]> => (await deps.store.readSnapshot()).accounts
  const sampler = createProcessLogSampler({
    run,
    accounts: async () => { const snapshot = await deps.store.readSnapshot(); return snapshot.accounts.map(account => ({ ...account, primaryDomain: account.primaryDomain })) },
    dbProcesses: async () => parseDbProcessCounts(await deps.readDbProcesses(), new Set((await accounts()).map(account => account.username))),
    read: () => readJsonIfExists<unknown>(PROCESS_LOG_PATH),
    write: file => writeSvcState(PROCESS_LOG_PATH, file),
  })
  const nightly = createNightlyMaintenance({
    readTweaks: () => readSavedTweakValues(deps.store.rootDir),
    readState: async () => ({ day: ((await readJsonIfExists<{ day?: unknown }>(NIGHTLY_STATE_PATH))?.day as string | undefined) ?? null }),
    writeState: state => writeSvcState(NIGHTLY_STATE_PATH, state),
    runProcessKiller: async () => {
      const policy = await readSvcPolicy(deps.store.rootDir, 'process-killer')
      if (!policy?.enabled) return
      const result = await runProcessKiller({ run, policy, accounts: await accounts(), self: { pid: process.pid, ppid: process.ppid }, trigger: 'nightly' })
      await writeSvcState(PROCESS_KILLER_REPORT_PATH, appendKillerRun(parseKillerReports(await readJsonIfExists<unknown>(PROCESS_KILLER_REPORT_PATH)), result))
    },
    pruneJobs: async before => { await deps.hostJobs?.pruneLogs(UPDATE_JOB_PREFIXES, before) },
    updateWafVendors: async () => {
      const saved = await readSvcPolicy(deps.store.rootDir, 'waf-vendors')
      if (!saved) return
      const installed = parseInstalledVendors(await readJsonIfExists<unknown>(WAF_VENDOR_INSTALLED_PATH))
      let changed = false
      for (const vendor of saved.vendors) {
        if (!vendor.autoUpdate) continue
        const metadata = await fetchVendorMetadata(vendor.metadataUrl)
        if (vendorUnchanged(metadata, installed[vendor.id] ?? { archiveSha256: vendor.archiveSha256 })) continue
        await recordInstalledVendor(await installVendor(vendor.metadataUrl, { writeFile: file => deps.executor.writeFile(file), removePath: path => deps.executor.removePath(path) }),
          { read: () => readJsonIfExists<unknown>(WAF_VENDOR_INSTALLED_PATH), write: value => writeSvcState(WAF_VENDOR_INSTALLED_PATH, value) })
        changed = true
      }
      if (changed) await deps.reconcile()
    },
    checkRelease: deps.releaseRoot ? async () => writeSvcState(PACKAGE_CHECK_PATH, await checkInstalledRelease(deps.releaseRoot!)) : null,
  })
  return { tick: async () => {
    // A failed tick is retried by the next one; it must never reject inside the timer.
    try { await sampler.tick(); await nightly.tick() } catch { /* next minute */ }
  } }
}
const NIGHTLY_STATE_PATH = '/var/lib/xpanel/svc/nightly-maintenance.json'
