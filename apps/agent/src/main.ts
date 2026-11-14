import { createNativeAccountProvisioningHttp } from './account-provisioning-http.ts'
import { DurableUpgradeCoordinator } from './upgrade-coordinator.ts'
import { createUpgradeLauncherProvider, nativeUpgradeLauncherPorts } from './ops-upgrade-launcher.ts'
import { createReadonlyAccountProvisioningObserver } from './account-provisioning-observer.ts'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { chmod, chown, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureMfaRuntimePolicy, fail } from '@xpanel/core'
import { appendAudit, createDb, hostOperationInFlight, initializeOperationalMetadata, migrate, pruneMetricsHistory, recordHostMetricsSample } from '@xpanel/db'
import { detectOs, XPANEL_FPM_SOCKET_DIR } from '@xpanel/os'
import type { XpanelOsProfile } from '@xpanel/os'
import { StateStore, atomicWriteJson, backgroundStateWrite, readJsonIfExists } from '@xpanel/state'
import { createProductionAccountFileRunner, DEFAULT_FILE_WORKER_INCIDENT_DIR } from './production-file-runner.ts'
import { refreshAccountFileHelperIfStale } from './refresh-account-file-helper.ts'
import { CanonicalIoResourcePipeline, IoAnalyticsEngine, readWebsiteAnalyticsStore, WEBSITE_ANALYTICS_PATH, WebsiteAnalyticsEngine } from './analytics.ts'
import { createProductionHostTargetMatcher, LinuxHostExecutor } from './executor.ts'
import { ensureAcmeWebRoot } from './host-access.ts'
import { ACCOUNT_RELABEL_TIMEOUT_MS, ensureAccountHomeContexts } from './selinux-homes.ts'
import { createSourceBuilds, SOURCE_BUILD_TIMEOUT_MS } from './source-builds.ts'
import { syncRuntimePublicOrigin } from './agent-origin.ts'
import { ensureInstalledMail } from './services/local-mail.ts'
import { enableMailWebsocketProxy } from './services/mail-websocket.ts'
import { readOpenDkimPublished, writeOpenDkimPublished } from './services/opendkim-live.ts'
import { resolveHomeQuotaFilesystem } from './services/quota.ts'
import { createNativeHostReconciler } from './native-reconciler.ts'
import { loadNativePeerIdentityAddon, resolveProvisionedPeerUids, resolveServicePrimaryGid } from './peer-identity.ts'
import { AccountProvisioningPreparationReader } from './account-provisioning-preparation.ts'
import { provisioningAuthorizationPorts } from './account-provisioning-authorization.ts'
import { createAccountProvisioningRuntime } from './account-provisioning-runtime.ts'
import { HostJobRunner } from './host-jobs.ts'
import { system } from '@xpanel/render'
import { ApplicationInstallCoordinator, isApplicationInstallCommand } from './application-install.ts'
import { createApplicationArtifactStore, createApplicationProvider } from './application-provider.ts'
import { createNativeApplicationWorkerRun } from './application-worker.ts'
import { DATABASE_REMOTE_ACCESS_JOURNAL_DIR, pendingDatabaseRemoteAccessJournals, qualifyDatabaseRemoteAccessNative, recoverPendingDatabaseRemoteAccess, type QualifiedDatabaseRemoteAccessNative } from './db-remote-provider.ts'
import { createHostJobRun } from './host-job-exec.ts'
import { createHostMetricsCollector } from './host-metrics.ts'
import { createBackupTransportProvider } from './acct-backup-sftp.ts'
import { hostBackupCredentialStore } from './acct-backup-credentials.ts'
import { defaultBackupArchiveRoot } from './acct-backup-runs.ts'
import { buildControlSnapshot } from './acct-backup-archive.ts'
import { DatabaseSync } from 'node:sqlite'
import { BACKUP_LOW_PRIORITY, runBackupCommand } from './backup-low-priority.ts'
import { createGeoipSource } from './geoip.ts'
import { GEOIP2_PERL_MODULES, WEB_STATS_ROOT, createWebStats, type WebStats } from './web-stats.ts'
import { AWSTATS_BINARIES, WEBALIZER_BINARY } from './web-stats-format.ts'
import { WEB_STATS_CONFIG_STATE, parseWebStatsConfig } from './web-stats-config.ts'
import { BANDWIDTH_INTERVAL_MS, BANDWIDTH_LEDGER_PATH, createBandwidthMeter, enforceBandwidthLimits, type BandwidthMeter } from './metering.ts'
import { createLogRotation, LOG_ROTATION_STATE_PATH, nativeLogRotationDeps, readLogTweaks } from './log-rotation.ts'
import { createSvcBackground } from './svc-agent.ts'
import { createNativeReleasePackages } from './release-packages.ts'
import { createNativeHostWatch } from './host-watch.ts'
import { readProtectedLogFrom } from './account-logs.ts'
import { createNativeLeechMonitor, sendmailAlert, type LeechMonitor } from './leech-protection.ts'
import { createSiteExpiryMonitor } from './site-expiry.ts'
import { MAIL_LOG_MAX_OUTPUT_BYTES, observeMailLog } from './mail-log.ts'
import { observeFtpLog } from './ftp-log.ts'
import { createHostBackupRunController, readBackupConfigFiles, readSavedBackupDestination } from './acct-backup-runs.ts'
import { createHostDnsClusterSync } from './dns-cluster-routes.ts'
import { createAgentApp, listenAgentSocket, loadAgentCredentialFile } from './server.ts'
import { revertExpiredPanelTrial } from './panel-access.ts'
import { createDbQuotaEnforcer } from './db-quota.ts'
import { loadPostgresqlPort } from './db-postgresql-service.ts'
import { createNodeSwApplicationCatalogFiles, createSwApplicationCatalogSource, readInstalledPanelVersion } from './sw-application-catalog-store.ts'
import { createSystemPgpRunner } from './account-pgp.ts'
import { createProvisioningDatabaseReaderPort } from './account-provisioning-database-reader.ts'
import { createNativeCronQualification } from './cron-qualification.ts'
import { createUpdater } from './update-policy.ts'
import { createSystemdPtySpawner, DEFAULT_TERMINAL_PTY_HELPER, TerminalSessionManager, verifyTerminalPtyHelper } from './terminal-sessions.ts'
import type { AgentApp } from './server.ts'
import { awaitLifecycleWriterDrain, createLifecycleBackgroundResources, isLifecycleManaged, readLifecyclePublicStatus, startLifecycleWriterParticipant, withLifecycleWriterAdmission } from '../../../scripts/lifecycle-admission.mjs'
import { createMariaDbSqlRunner, DEFAULT_MARIADB_ADMIN_CNF, defaultCommandRunner as mariadbCommandRunner, MariaDbServiceAdapter, mariadbSocketForFamily } from './services/mariadb.ts'
import { withPostgresqlSqlRunner } from './pg-sql.ts'
import { createAccountGitRun } from './account-git-runner.ts'
import { GIT_BINARY, GIT_LIMITS } from '../../../packages/os/src/git-command.ts'
import { nativeRhelCacheRecovery, nativeRpmDatabaseRecovery } from './ops-package-recovery.ts'

export interface AgentDaemonOptions {
  dbPath?: string
  stateDir?: string
  socketPath?: string
  agentTokenFile?: string
  socketGid?: number
  quotaFilesystem?: string | null
  ioDevices?: string[]
  fileHelperBinaryPath?: string
  fileWorkerIncidentDir?: string
  mariadbAdminCnfPath?: string
  mariadbSocketPath?: string | null
  terminalPtyBinaryPath?: string
}

const detectHostOsProfile = async (): Promise<XpanelOsProfile> => detectOs((p) => readFileSync(p, 'utf8'))

/** A failed shutdown step keeps its cause; diagnostics print the step and a stable code, never the message. */
class ShutdownStepError extends Error {
  readonly step: string
  constructor(step: string, cause: unknown) { super(`${step} failed`, { cause }); this.step = step }
}
const stableCode = (error: unknown): string => {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(code)) return code
  const name = error instanceof Error ? error.constructor.name : typeof error
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'unknown'
}
/** Bounded `step:code` entries of an aggregated shutdown failure, free of messages, paths and secrets. */
export const shutdownFailureCodes = (error: unknown): string[] => {
  const codes: string[] = []
  const visit = (value: unknown, step: string, depth: number): void => {
    if (codes.length >= 16) return
    if (value instanceof ShutdownStepError && depth < 8) visit(value.cause, value.step, depth + 1)
    else if (value instanceof AggregateError && depth < 8) { for (const item of value.errors) visit(item, step, depth + 1) }
    else codes.push(`${step}:${stableCode(value)}`)
  }
  visit(error, 'agent', 0)
  return codes
}

/** A frozen maintenance endpoint does not open a database or manufacture authenticated state. */
const quarantinedAgentApp = (agentToken: string): AgentApp => ({
  async fetch(request) {
    const actual = Buffer.from(request.headers.get('x-xpanel-agent-token') ?? '', 'utf8')
    const expected = Buffer.from(agentToken, 'utf8')
    const authenticated = actual.length === expected.length && timingSafeEqual(actual, expected)
    return new Response(JSON.stringify({ error: authenticated ? 'Lifecycle maintenance requires an inspected restart before this agent can serve requests.' : 'Invalid or missing agent service authentication.' }), {
      status: authenticated ? 503 : 401,
      headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...(authenticated ? { 'retry-after': '5' } : {}) },
    })
  },
  subscribe() { return () => {} },
})

/**
 * Starts the privileged `xpanel-agent` root daemon listening on `/run/xpanel/agent.sock`.
 */
export const startAgentDaemon = async (opts: AgentDaemonOptions = {}) => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    fail('PRECONDITION_FAILED', 'the privileged agent daemon requires root on Linux')
  }
  const dbPath = opts.dbPath ?? process.env.XPANEL_DB_PATH ?? '/var/lib/xpanel/control.db'
  const stateDir = opts.stateDir ?? process.env.XPANEL_STATE_DIR ?? '/var/lib/xpanel/state'
  const socketPath = opts.socketPath ?? process.env.XPANEL_AGENT_SOCKET ?? '/run/xpanel/agent.sock'
  const tokenFile = opts.agentTokenFile ?? process.env.XPANEL_AGENT_TOKEN_FILE ?? '/etc/xpanel/agent.token'
  const agentToken = await loadAgentCredentialFile(tokenFile)
  const socketGid = opts.socketGid ?? Number(process.env.XPANEL_AGENT_GID)
  if (!Number.isSafeInteger(socketGid) || socketGid <= 0) {
    fail('PRECONDITION_FAILED', 'XPANEL_AGENT_GID must identify the dedicated API service group')
  }
  // Unset means the mount that holds /home, observed on the host below; 'none' disables account disk limits.
  const rawQuotaFs = opts.quotaFilesystem !== undefined ? opts.quotaFilesystem : process.env.XPANEL_QUOTA_FS
  const configuredQuotaFilesystem = rawQuotaFs === 'none' || rawQuotaFs === '' ? null : rawQuotaFs
  const ioDevices =
    opts.ioDevices ??
    (process.env.XPANEL_IO_DEVICES !== undefined
      ? process.env.XPANEL_IO_DEVICES.split(',').map((s) => s.trim()).filter(Boolean)
      : [])
  const os = await detectHostOsProfile()

  let managed = false
  let quarantined = false
  try {
    managed = await isLifecycleManaged()
    quarantined = (await readLifecyclePublicStatus()).active
    managed ||= quarantined
  } catch {
    // Unsafe lifecycle metadata is a fence, never permission for ordinary initialization.
    managed = true
    quarantined = true
  }
  let ioResourcePipeline: CanonicalIoResourcePipeline | undefined
  let hostMetrics: ReturnType<typeof createHostMetricsCollector> | undefined
  let bandwidthMeter: BandwidthMeter | undefined
  let webStats: WebStats | undefined
  let backupRuns: ReturnType<typeof createHostBackupRunController> | undefined
  let copyControlDatabase: ((outputPath: string) => Promise<void>) | undefined
  let backupTimer: ReturnType<typeof setInterval> | undefined
  let leechMonitor: LeechMonitor | undefined
  let resourcesFenced = false
  let closeDaemon: (() => Promise<void>) | undefined
  const participant = managed ? await startLifecycleWriterParticipant('agent', {
    // A fenced pipeline stays paused until an inspected process restart. This callback
    // does not establish native host quiescence or authorize barrier retirement.
    onFence: async () => { resourcesFenced = true; clearInterval(backupTimer); await hostMetrics?.stop(); await bandwidthMeter?.stop(); await webStats?.stop(); await ioResourcePipeline?.pause() },
  }) : undefined
  let participantClosing: Promise<void> | undefined
  const closeParticipant = (): Promise<void> => participantClosing ??= participant?.close() ?? Promise.resolve()
  if (quarantined) {
    try {
      // The normal listener can build a missing native verifier. Quarantine must only
      // load the existing protected artifact and must never enter that build fallback.
      if (!existsSync('/opt/xpanel/bin/xpanel-peer-identity.node')) fail('PRECONDITION_FAILED', 'quarantine requires the installed native peer identity artifact')
      const app = quarantinedAgentApp(agentToken)
      const listener = await createLifecycleBackgroundResources(() => listenAgentSocket(app, socketPath, { gid: socketGid }))
      let closing: Promise<void> | undefined
      const close = (): Promise<void> => closing ??= (async () => {
        const errors: unknown[] = []
        try { await listener.close() } catch (error) { errors.push(new ShutdownStepError('listener.close', error)) }
        try { await closeParticipant() } catch (error) { errors.push(new ShutdownStepError('participant.close', error)) }
        if (errors.length) throw new AggregateError(errors, 'quarantined agent IPC shutdown requires inspection')
      })()
      return { app, socketPath, close, recoveryRequired: new Promise<void>(() => {}), quarantined: true as const }
    } catch (error) {
      try { await closeParticipant() } catch (cleanup) { throw new AggregateError([error, cleanup], 'quarantined agent startup cleanup requires inspection') }
      throw error
    }
  }
  let settleStartup!: () => void
  const startupSettled = new Promise<void>((resolve) => { settleStartup = resolve })
  try {
    // An upgrade finishing or release retention can hold EX past one lock wait: startup waits for it, it does not exit.
    const daemon = await withLifecycleWriterAdmission(async () => {
      if (dbPath !== ':memory:') {
        await mkdir(dirname(dbPath), { recursive: true })
      }
      await mkdir(stateDir, { recursive: true })
      const runtimeDirectory = dirname(socketPath)
      const createdRuntimeDirectory = await mkdir(runtimeDirectory, { recursive: true, mode: 0o750 })
      if (createdRuntimeDirectory) await chown(runtimeDirectory, 0, socketGid)
      // Traverse-only, so accounts reach their own staging paths below without listings,
      // while the agent socket remains group-only (0660 root:xpanel-agent).
      await chmod(runtimeDirectory, 0o711)
      // PHP-FPM sockets live outside the agent's RuntimeDirectory, which systemd wipes on every
      // agent stop; each FPM unit creates its own <root>/<user>-<version>/ below this root.
      await mkdir(XPANEL_FPM_SOCKET_DIR, { recursive: true, mode: 0o711 })
      await chmod(XPANEL_FPM_SOCKET_DIR, 0o711)

      const dbHandle = createDb(dbPath, dbPath === ':memory:' ? {} : { durability: 'strict' })
      let accountFileRunner: Awaited<ReturnType<typeof createProductionAccountFileRunner>> | undefined
      let listener: Awaited<ReturnType<typeof listenAgentSocket>> | undefined
      let hostJobs: HostJobRunner | undefined
      let terminals: TerminalSessionManager | null = null
      let resourcesClosing: Promise<void> | undefined
      let closing: Promise<void> | undefined
      const closeResources = (): Promise<void> => resourcesClosing ??= (async () => {
        const errors: unknown[] = []
        try { await listener?.close() } catch (error) { errors.push(new ShutdownStepError('listener.close', error)) }
        try { hostJobs?.close() } catch (error) { errors.push(new ShutdownStepError('hostJobs.close', error)) }
        try { terminals?.closeAll() } catch (error) { errors.push(new ShutdownStepError('terminals.closeAll', error)) }
        try { await hostMetrics?.stop() } catch (error) { errors.push(new ShutdownStepError('hostMetrics.stop', error)) }
        try { await bandwidthMeter?.stop() } catch (error) { errors.push(new ShutdownStepError('bandwidthMeter.stop', error)) }
        try { await webStats?.stop() } catch (error) { errors.push(new ShutdownStepError('webStats.stop', error)) }
        try { clearInterval(backupTimer); await backupRuns?.idle() } catch (error) { errors.push(new ShutdownStepError('backupRuns.idle', error)) }
        try { await ioResourcePipeline?.stop() } catch (error) { errors.push(new ShutdownStepError('ioResourcePipeline.stop', error)) }
        try { await accountFileRunner?.close() } catch (error) { errors.push(new ShutdownStepError('accountFileRunner.close', error)) }
        if (errors.length) throw new AggregateError(errors, 'agent resource shutdown requires inspection')
      })()
      const closeNormal = (): Promise<void> => closing ??= (async () => {
        // Startup owns a shared writer scope. Waiting for global drainage inside that
        // scope would wait for ourselves; final retirement starts after its release.
        await startupSettled
        const errors: unknown[] = []
        try { await closeResources() } catch (error) { errors.push(error) }
        try { await awaitLifecycleWriterDrain() } catch (error) { errors.push(new ShutdownStepError('writerDrain', error)) }
        try { await dbHandle.close() } catch (error) { errors.push(new ShutdownStepError('database.close', error)) }
        // Closing owned IPC is process cleanup, never a host-drain assertion or
        // permission to remove an incident, root barrier, or retirement fence.
        try { await closeParticipant() } catch (error) { errors.push(new ShutdownStepError('participant.close', error)) }
        if (errors.length) throw new AggregateError(errors, 'agent shutdown requires operational recovery')
      })()
      closeDaemon = closeNormal
      try {
        await migrate(dbHandle.runner)
        await initializeOperationalMetadata(dbHandle.db)

        const store = new StateStore(stateDir)
        store.registerHostOperationProbe(() => hostOperationInFlight(dbHandle.db))
        const mariadbAdminCnfPath =
          opts.mariadbAdminCnfPath ?? process.env.XPANEL_MARIADB_ADMIN_CNF ?? DEFAULT_MARIADB_ADMIN_CNF
        const mariaDbOptions = {
          adminDefaultsFile: mariadbAdminCnfPath,
          socketPath: mariadbSocketForFamily(os.family, opts.mariadbSocketPath !== undefined ? opts.mariadbSocketPath : process.env.XPANEL_MARIADB_SOCKET),
        }
        const mariadbAdmin = new MariaDbServiceAdapter(mariaDbOptions)
        const sqlRunner = withPostgresqlSqlRunner(createMariaDbSqlRunner(mariadbAdmin))
        await loadPostgresqlPort(store.rootDir)
        const dbQuota = createDbQuotaEnforcer({ store, sql: mariadbAdmin, audit: entry => withLifecycleWriterAdmission(() => appendAudit(dbHandle.db, entry)) })
        const executor = new LinuxHostExecutor({
          trustedHostTargetMatcher: createProductionHostTargetMatcher(),
          sqlRunner,
        })
        // Account Git runs in the account jail; this bound outlasts its RuntimeMaxSec so systemd ends the unit first.
        const gitExecutor = existsSync(GIT_BINARY) ? new LinuxHostExecutor({ timeoutMs: (GIT_LIMITS.timeoutSeconds + 15) * 1000, maxOutputBytes: GIT_LIMITS.outputBytes + 1 }) : null
        const rpmDatabaseRecovery = nativeRpmDatabaseRecovery(os.family, argv => executor.runCommand(argv))
        const rhelCacheRecovery = nativeRhelCacheRecovery(os.family, argv => executor.runCommand(argv))
        const quotaFilesystem = configuredQuotaFilesystem !== undefined ? configuredQuotaFilesystem
          : await resolveHomeQuotaFilesystem(argv => executor.runCommand(argv)).catch(() => {
            process.stderr.write('xpanel-agent quota: the mount holding /home could not be observed; using /home\n')
            return '/home'
          })
        const readBackupDestination = readSavedBackupDestination(readBackupConfigFiles(stateDir))
        const backupDestinationProvider = createBackupTransportProvider({ readDestination: readBackupDestination, archiveRoot: defaultBackupArchiveRoot() })
        // Backup dumps run at the same low priority as the archive build, with the hour-long bound of a large database.
        const backupDumps = new MariaDbServiceAdapter({ ...mariaDbOptions, dumpTimeoutMs: 3_600_000, commandRunner: input => mariadbCommandRunner({ ...input, argv: [...BACKUP_LOW_PRIORITY, ...input.argv] }) })
        // VACUUM INTO writes a consistent copy of the WAL database from a separate read-only connection.
        copyControlDatabase = dbPath === ':memory:' ? undefined : async (outputPath: string) => { const copy = new DatabaseSync(dbPath, { readOnly: true }); try { copy.prepare('VACUUM INTO ?').run(outputPath) } finally { copy.close() } }
        backupRuns = createHostBackupRunController({ executor, stateRoot: stateDir, provider: backupDestinationProvider, listAccounts: async () => (await store.listAccounts()).map(a => ({ id: a.id, username: a.username, home: a.home, uid: a.uid, status: a.status })),
          databases: {
            list: async account => (await store.listDatabases(account.id)).filter(database => database.engine === 'mariadb' && !database.trashedAt).map(database => database.name),
            dump: async (account, database, outputPath) => { const dumped = await backupDumps.streamLogicalDump({ database, username: account.username, outputPath }); return { bytes: dumped.sizeBytes, sha256: dumped.sha256 } },
          },
          zones: { list: async account => (await store.listDnsZones(account.id)).filter(zone => zone.accountId === account.id).map(zone => ({ name: zone.name, content: JSON.stringify(zone) })) },
          ...(copyControlDatabase ? { copyControlDatabase } : {}),
        })
        hostMetrics = createHostMetricsCollector({ reader: { readFile: path => executor.readFile(path), runCommand: argv => executor.runCommand(argv), listDirectory: path => readdir(path) },
          write: (observation, at) => withLifecycleWriterAdmission(() => recordHostMetricsSample(dbHandle.db, { at, observation })),
          prune: olderThan => withLifecycleWriterAdmission(() => pruneMetricsHistory(dbHandle.db, olderThan, 'host')),
          onError: () => { process.stderr.write('xpanel-agent host metrics: sample could not be recorded\n') },
        })
        // Same bounded journal reader as /host/mail/log and /host/ftp/log (16 MiB output cap).
        const journalExecutor = process.platform === 'linux' ? new LinuxHostExecutor({ maxOutputBytes: MAIL_LOG_MAX_OUTPUT_BYTES }) : null
        const websiteAnalytics = new WebsiteAnalyticsEngine({ store: { read: () => readWebsiteAnalyticsStore(), write: data => withLifecycleWriterAdmission(() => atomicWriteJson(WEBSITE_ANALYTICS_PATH, data, 0o600)) } })
        const logRotation = createLogRotation(nativeLogRotationDeps({ readState: () => store.readSnapshot(), readTweaks: () => readLogTweaks(stateDir), runCommand: argv => executor.runCommand(argv),
          readRotation: () => readJsonIfExists<unknown>(LOG_ROTATION_STATE_PATH), writeRotation: state => withLifecycleWriterAdmission(() => atomicWriteJson(LOG_ROTATION_STATE_PATH, state, 0o600)) }))
        // Engines are distribution packages, or the installer's pinned builds on EL; a host without them spools nothing and reports them unavailable.
        const statsGeoip = createGeoipSource({ dir: WEB_STATS_ROOT + '/geoip', admit: work => withLifecycleWriterAdmission(work) })
        const readStatsConfig = () => readJsonIfExists(join(stateDir, WEB_STATS_CONFIG_STATE)).then(parseWebStatsConfig, () => null)
        if (process.platform === 'linux') webStats = createWebStats({ readState: () => store.readSnapshot(), run: runBackupCommand, backupBusy: () => backupRuns?.busy() ?? false,
          readConfig: readStatsConfig, engines: () => ({ awstats: AWSTATS_BINARIES.find(path => existsSync(path)) ?? null, webalizer: existsSync(WEBALIZER_BINARY) ? WEBALIZER_BINARY : null }), geoip: statsGeoip,
          geoipReady: () => GEOIP2_PERL_MODULES.some(path => existsSync(path)) && existsSync(statsGeoip.path), admit: work => withLifecycleWriterAdmission(work),
          onError: () => { process.stderr.write('xpanel-agent web statistics: run could not be completed\n') } })
        bandwidthMeter = createBandwidthMeter({ readState: () => store.readSnapshot(), readFrom: readProtectedLogFrom,
          readMail: journalExecutor ? (since, until) => observeMailLog({ run: argv => journalExecutor.runCommand(argv), since, until }) : null,
          readFtp: journalExecutor ? (since, until) => observeFtpLog({ run: argv => journalExecutor.runCommand(argv), readState: () => store.readSnapshot(), since, until }) : null,
          readLedger: () => readJsonIfExists<unknown>(BANDWIDTH_LEDGER_PATH),
          writeLedger: ledger => withLifecycleWriterAdmission(() => atomicWriteJson(BANDWIDTH_LEDGER_PATH, ledger, 0o600)),
          intervalMs: async () => { const config = await readStatsConfig(); return config ? config.policy.bandwidthIntervalMinutes * 60_000 : BANDWIDTH_INTERVAL_MS },
          afterCollect: async collected => {
            try {
              await enforceBandwidthLimits(await bandwidthMeter!.report(), await store.readSnapshot(), {
                setLimits: (changes, expectedRevision) => withLifecycleWriterAdmission(() => backgroundStateWrite(() => store.setBandwidthLimits(changes, expectedRevision === undefined ? {} : { expectedRevision }))),
                audit: entry => withLifecycleWriterAdmission(() => appendAudit(dbHandle.db, entry)),
                reconcile: () => reconciler.reconcile({ actor: 'agent' }),
              })
            } finally {
              // Raw access logs rotate only after the collection that counted them was recorded, whatever enforcement did.
              await withLifecycleWriterAdmission(() => logRotation.run(collected))
            }
          },
          onError: () => { process.stderr.write('xpanel-agent bandwidth: collection could not be recorded\n') },
          webAnalytics: webStats ? webStats.tee(websiteAnalytics) : websiteAnalytics,
        })
        const ioAnalytics = new IoAnalyticsEngine()

        const fileHelperBinaryPath =
          opts.fileHelperBinaryPath ?? process.env.XPANEL_FILE_HELPER_BINARY ?? '/opt/xpanel/bin/xpanel-account-files'
        if (process.platform === 'linux' && process.getuid?.() === 0 && dbPath !== ':memory:'
          && opts.fileHelperBinaryPath === undefined && process.env.XPANEL_FILE_HELPER_BINARY === undefined) {
          await refreshAccountFileHelperIfStale(fileHelperBinaryPath)
        }
        let recoveryDetected = false
        let signalRecovery!: () => void
        const recoveryRequired = new Promise<void>((resolve) => { signalRecovery = resolve })
        const onRecoveryRequired = (): void => {
          if (recoveryDetected) return
          recoveryDetected = true
          signalRecovery()
          // Do not await the operation that reported this state through pool.close().
          if (closeDaemon) void closeDaemon().catch(() => undefined)
        }
        accountFileRunner = await createProductionAccountFileRunner(fileHelperBinaryPath, {
          incidentDir: opts.fileWorkerIncidentDir ?? DEFAULT_FILE_WORKER_INCIDENT_DIR,
          onRecoveryRequired,
        })
        if (recoveryDetected) fail('PRECONDITION_FAILED', 'privileged file worker recovery is required before agent startup')
        if (process.platform === 'linux') leechMonitor = createNativeLeechMonitor({ store, runner: accountFileRunner!, audit: entry => withLifecycleWriterAdmission(() => appendAudit(dbHandle.db, entry)) })
        // Terminal sessions exist only with a verified root-owned PTY helper; otherwise they stay unavailable.
        const terminalHelperPath = opts.terminalPtyBinaryPath ?? process.env.XPANEL_TERMINAL_PTY_BINARY ?? DEFAULT_TERMINAL_PTY_HELPER
        if (await verifyTerminalPtyHelper(terminalHelperPath)) terminals = new TerminalSessionManager(createSystemdPtySpawner(terminalHelperPath))

        const { reconciler, dnsPublication } = await createNativeHostReconciler({ store, db: dbHandle.db, executor, os, quotaFilesystem, ioDevices })
        await syncRuntimePublicOrigin(executor).catch((error: unknown) => {
          process.stderr.write(`xpanel-agent public origin: ${error instanceof Error ? error.message : String(error)}\n`)
        })
        await enableMailWebsocketProxy(executor).catch((error: unknown) => {
          process.stderr.write(`xpanel-agent mail websocket: ${error instanceof Error ? error.message : String(error)}\n`)
        })
        await reconciler.recoverInterruptedReconciliation().catch(() => undefined)
        const hostJobRun = createHostJobRun(), applicationCoordinator = new ApplicationInstallCoordinator()
        hostJobs = new HostJobRunner({ db: dbHandle.db, run: (argv, options) => isApplicationInstallCommand(argv) ? applicationCoordinator.run(argv, options) : hostJobRun(argv, options) })
        await hostJobs.recoverInterrupted().catch((error: unknown) => {
          process.stderr.write(`xpanel-agent host jobs: ${error instanceof Error ? error.message : String(error)}\n`)
        })
        // Remote database access stays unavailable unless the nft sets, the 0700 journal directory and MariaDB admin all qualify.
        await mkdir(DATABASE_REMOTE_ACCESS_JOURNAL_DIR, { recursive: true, mode: 0o700 }).catch(() => undefined)
        const qualifyRemoteDatabase = () => qualifyDatabaseRemoteAccessNative({
          mariadb: mariadbAdmin,
          run: argv => executor.runCommand([...argv]),
          readAllEntries: async () => (await store.listAccounts()).map(account => ({ accountId: account.id, status: account.status, entries: account.databaseRemoteAccess ?? [] })),
        })
        let databaseRemoteAccessNative = await qualifyRemoteDatabase()
        const recoverRemoteDatabaseJournals = async (qualified: QualifiedDatabaseRemoteAccessNative) => {
          const report = await recoverPendingDatabaseRemoteAccess(qualified, accountId => store.readDatabaseRemoteAccess(accountId)).catch(() => [{ accountId: null, outcome: 'review' as const }])
          for (const row of report) if (row.outcome === 'review') process.stderr.write(`xpanel-agent remote database recovery: journal ${row.accountId ?? 'unknown'} requires review\n`)
        }
        if (databaseRemoteAccessNative) {
          await recoverRemoteDatabaseJournals(databaseRemoteAccessNative)
        } else if (await pendingDatabaseRemoteAccessJournals() !== 0) process.stderr.write('xpanel-agent remote database recovery: pending journals remain; the provider is not qualified\n')
        let pendingRemoteDatabaseQualification: Promise<QualifiedDatabaseRemoteAccessNative | null> | null = null
        const resolveDatabaseRemoteAccessNative = async (): Promise<QualifiedDatabaseRemoteAccessNative | null> => {
          if (databaseRemoteAccessNative) return databaseRemoteAccessNative
          pendingRemoteDatabaseQualification ??= (async () => {
            try {
              const qualified = await qualifyRemoteDatabase()
              if (!qualified) return null
              await recoverRemoteDatabaseJournals(qualified)
              databaseRemoteAccessNative = qualified
              return qualified
            } finally {
              pendingRemoteDatabaseQualification = null
            }
          })()
          return pendingRemoteDatabaseQualification
        }

        await ensureAcmeWebRoot(executor, os.paths.nginxUser).catch((error: unknown) => {
          process.stderr.write(`xpanel-agent ACME webroot: ${error instanceof Error ? error.message : String(error)}\n`)
        })
        if (existsSync('/usr/sbin/postfix') && existsSync('/usr/sbin/dovecot')) {
          await (async () => {
            const snapshot = await store.readSnapshot().catch(() => null)
            const hostname = snapshot?.server?.settings.hostname
            const domains = [
              ...(snapshot?.domains.map(domain => domain.name) ?? []),
              ...(snapshot?.serviceUsers.flatMap(user => {
                if (!user.services.email) return []
                const at = user.login.lastIndexOf('@')
                return at > 0 ? [user.login.slice(at + 1)] : []
              }) ?? []),
            ]
            const owned = await reconciler.ownedChecksums()
            const signing = await ensureInstalledMail(executor, os, hostname, owned, domains)
            const published = (await readOpenDkimPublished(executor).catch(() => null))?.trim() ?? ''
            if (signing.stamp && published !== signing.stamp) {
              await reconciler.reconcile({ force: true, actor: 'agent', mailAuth: signing.signing })
              await writeOpenDkimPublished(executor, signing.stamp)
            }
          })().catch((error: unknown) => {
            process.stderr.write(`xpanel-agent local mail: ${error instanceof Error ? error.message : String(error)}\n`)
          })
        }

        ioResourcePipeline = new CanonicalIoResourcePipeline({ store, engine: ioAnalytics, onEvent: event => reconciler.emit(event) })
        if (resourcesFenced) await ioResourcePipeline.pause()
        await createLifecycleBackgroundResources(() => ioResourcePipeline!.start())

        const provisioningPeerUids = await resolveProvisionedPeerUids({ gid: socketGid, allowRootPeer: false })
        const provisioningOwnerUid = [...provisioningPeerUids][0]
        if (provisioningPeerUids.size !== 1 || provisioningOwnerUid === undefined) {
          return fail('PRECONDITION_FAILED', 'account preparation requires the unique provisioned API service identity')
        }
        // Preparation files are API-owned: trust the API's own primary group, not the agent socket group.
        const provisioningOwner = { uid: provisioningOwnerUid, gid: await resolveServicePrimaryGid(provisioningOwnerUid) }
        const nativeAccountHttp = createNativeAccountProvisioningHttp({ db: dbHandle.db,
          databaseReader: createProvisioningDatabaseReaderPort(dbPath), store, reconciler, executor, os,
          addon: await loadNativePeerIdentityAddon(),
        })
        const accountProvisioning = createAccountProvisioningRuntime({
          db: dbHandle.db, executor, reconciler,
          preparations: new AccountProvisioningPreparationReader(stateDir, provisioningOwner),
          authorization: provisioningAuthorizationPorts({ db: dbHandle.db, stateRoot: stateDir, owner: provisioningOwner }),
          policy: captureMfaRuntimePolicy(),
          observer: createReadonlyAccountProvisioningObserver({ executor, store, dns: dnsPublication, ...nativeAccountHttp }),
        })
        const panelVersion = await readInstalledPanelVersion()
        const upgradeCoordinator = new DurableUpgradeCoordinator({ db: dbHandle.db, provider: createUpgradeLauncherProvider(nativeUpgradeLauncherPorts()) })
        const updater = createUpdater({ rootDir: store.rootDir, db: dbHandle.db, coordinator: upgradeCoordinator })
        const releasePackages = createNativeReleasePackages({ version: panelVersion, os, executor, hostJobs, reconcile: () => reconciler.reconcile({ actor: 'system:release-packages' }), audit: entry => appendAudit(dbHandle.db, entry) })
        const dnsCluster = process.platform === 'linux' ? createHostDnsClusterSync({ rootDir: store.rootDir, store, run: argv => executor.runCommand(argv), reconcile: async () => (await reconciler.reconcile({ actor: 'system:dns-cluster' })).status !== 'failed', audit: entry => withLifecycleWriterAdmission(() => appendAudit(dbHandle.db, { ...entry, actor: 'system:dns-cluster' })) }) : null
        const app = createAgentApp({
          dnsCluster,
          mailGeoip: statsGeoip,
          pgpRunner: createSystemPgpRunner(),
          reconciler,
          ...(panelVersion ? { applicationCatalog: createSwApplicationCatalogSource(createNodeSwApplicationCatalogFiles(), panelVersion), applicationArtifacts: createApplicationArtifactStore() } : {}),
          ...(panelVersion && process.platform === 'linux' && existsSync(system.RUNTIME_BINARIES.python) ? { applicationProvider: createApplicationProvider({ worker: createNativeApplicationWorkerRun() }), applicationCoordinator } : {}),
          accountProvisioning,
          upgradeCoordinator,
          store,
          db: dbHandle.db,
          executor,
          cronQualification: createNativeCronQualification({ isActive: async unit => (await executor.runCommand(['/usr/bin/systemctl', 'is-active', unit])).code === 0 }),
          ...(accountFileRunner ? { accountFileRunner } : {}),
          ...(leechMonitor ? { leechMonitor } : {}),
          ...(gitExecutor ? { accountGitRun: createAccountGitRun(argv => gitExecutor.runCommand(argv), os.family) } : {}),
          ...(rpmDatabaseRecovery ? { rpmDatabaseRecovery } : {}),
          ...(rhelCacheRecovery ? { rhelCacheRecovery } : {}),
          ...(hostJobs ? { hostJobs } : {}),
          releasePackages,
          terminals,
          ioAnalytics,
          ioResourcePipeline,
          ...(process.platform === 'linux' ? { bandwidthMeter, logRotation, readDiskLatency: () => hostMetrics!.latestDiskLatency() } : {}),
          websiteAnalytics,
          ...(webStats ? { webStats } : {}),
          os: { id: os.id, versionId: os.versionId, family: os.family },
          nginxUser: os.paths.nginxUser,
          agentToken,
          mariadbAdmin,
          dbQuota,
          backupCredentials: hostBackupCredentialStore(),
          restoreBackupDatabase: async (account, database, inputPath, sha256) => { await backupDumps.streamLogicalRestore({ targetDatabase: database, username: account.username, inputPath, expectedSha256: sha256 }) },
          databaseTransfer: {
            dump: async (account, database, outputPath) => { const dumped = await backupDumps.streamLogicalDump({ database, username: account.username, outputPath }); return { bytes: dumped.sizeBytes, sha256: dumped.sha256 } },
            restore: async (account, database, inputPath, sha256) => { await backupDumps.streamLogicalRestore({ targetDatabase: database, username: account.username, inputPath, expectedSha256: sha256 }) },
            importUntrusted: (account, database, inputPath) => backupDumps.importUntrustedDump({ database, username: account.username, inputPath }),
            drop: (account, database) => backupDumps.dropDatabase(database, account.username, { requireBackupVerified: false }),
          },
          websiteDatabases: {
            list: async account => (await store.listDatabases(account.id)).filter(database => database.engine === 'mariadb' && !database.trashedAt).map(database => database.name),
            dump: async (account, database, outputPath) => { const dumped = await backupDumps.streamLogicalDump({ database, username: account.username, outputPath }); return { bytes: dumped.sizeBytes, sha256: dumped.sha256 } },
            restore: async (account, database, inputPath, sha256) => { await backupDumps.streamLogicalRestore({ targetDatabase: database, username: account.username, inputPath, expectedSha256: sha256 }) },
          },
          databaseRemoteAccessNative: resolveDatabaseRemoteAccessNative,
          readBackupDestination,
          backupDestinationProvider,
          backupRuns,
          ...(copyControlDatabase ? { panelSnapshot: () => buildControlSnapshot({ root: defaultBackupArchiveRoot(), stateDir, copyDatabase: copyControlDatabase!, run: runBackupCommand, compression: 'gzip', level: 6 }) } : {}),
        })

        listener = await createLifecycleBackgroundResources(() => listenAgentSocket(app, socketPath, { gid: socketGid }))

        if (recoveryDetected) {
          fail('PRECONDITION_FAILED', 'privileged file worker recovery is required before agent startup')
        }
        // After the socket listens: the first relabel of a large host must not hold the upgrade's health gate.
        if (os.family === 'rhel') void store.readSnapshot()
          .then(snapshot => ensureAccountHomeContexts(new LinuxHostExecutor({ timeoutMs: ACCOUNT_RELABEL_TIMEOUT_MS, trustedHostTargetMatcher: createProductionHostTargetMatcher() }), os.family, snapshot.accounts))
          .catch((error: unknown) => { process.stderr.write(`xpanel-agent SELinux account homes: ${error instanceof Error ? error.message : String(error)}\n`) })
        if (!resourcesFenced) createLifecycleBackgroundResources(() => hostMetrics!.start())
        if (!resourcesFenced) webStats?.start()
        const releaseRoot = fileURLToPath(new URL('../../../', import.meta.url))
        const svcBackground = process.platform === 'linux' ? createSvcBackground({ store, executor, hostJobs: hostJobs ?? null, releaseRoot: existsSync(join(releaseRoot, 'release-manifest.json')) ? releaseRoot : null,
          readDbProcesses: async () => (await mariadbAdmin.query(['SELECT USER, COUNT(*) FROM information_schema.PROCESSLIST GROUP BY USER'])).split('\n').flatMap(line => { const [user, count] = line.split('\t'); return user && /^\d+$/.test(count ?? '') ? [{ user, count: Number(count) }] : [] }),
          reconcile: () => reconciler.reconcile({ actor: 'system:nightly' }) }) : null
        const sourceBuildHost = process.platform === 'linux' && os.family === 'rhel' ? new LinuxHostExecutor({ timeoutMs: SOURCE_BUILD_TIMEOUT_MS }) : null
        const sourceBuilds = sourceBuildHost ? createSourceBuilds({ run: argv => sourceBuildHost.runCommand(argv), reconcile: () => reconciler.reconcile({ actor: 'system:source-builds' }),
          audit: entry => withLifecycleWriterAdmission(() => appendAudit(dbHandle.db, entry)), admit: work => withLifecycleWriterAdmission(work),
          onError: error => { process.stderr.write(`xpanel-agent source builds: ${error instanceof Error ? error.message : String(error)}\n`) } }) : null
        const hostWatch = process.platform === 'linux' ? createNativeHostWatch({ store, executor, os }) : null
        const siteExpiry = createSiteExpiryMonitor({ root: store.rootDir, listDomains: () => store.listDomains(), reconcile: () => reconciler.reconcile({ actor: 'system:site-expiry' }), sendAlert: async (to, subject, text) => { await sendmailAlert('xpanel@' + (await store.getServerSettings())!.hostname, to, subject, text) } })
        if (!resourcesFenced) { backupTimer = setInterval(() => { void backupRuns!.tick(); void updater.tick(); void releasePackages.tick(); void sourceBuilds?.tick(); if (process.platform === 'linux') { void bandwidthMeter!.collect(); void svcBackground!.tick(); void dnsCluster!.tick().catch(() => undefined); void revertExpiredPanelTrial(executor).catch(() => undefined); void siteExpiry.tick().catch(() => undefined) }; if (hostWatch) void withLifecycleWriterAdmission(() => hostWatch.tick()).catch(() => undefined); if (leechMonitor) void withLifecycleWriterAdmission(() => leechMonitor!.tick()).catch(() => undefined) ; void withLifecycleWriterAdmission(() => dbQuota.tick()).catch(() => undefined) }, 60_000); backupTimer.unref() }
        return { app, socketPath, close: closeNormal, recoveryRequired, quarantined: false as const }
      } catch (error) {
        try { await closeResources() } catch (cleanup) { throw new AggregateError([error, cleanup], 'agent startup cleanup requires inspection') }
        throw error
      }
    }, { busyRetryMs: 1000 })
    settleStartup()
    return daemon
  } catch (error) {
    settleStartup()
    try {
      if (closeDaemon) await closeDaemon()
      else { await awaitLifecycleWriterDrain(); await closeParticipant() }
    } catch (cleanup) { throw new AggregateError([error, cleanup], 'agent startup retirement requires inspection') }
    throw error
  }
}

export const AGENT_SHUTDOWN_TIMEOUT_MS = 35_000

/** Standalone process lifetime; the daemon library never exits its caller. */
export const attachAgentProcessLifecycle = (daemon: { close: () => Promise<void>; recoveryRequired: Promise<void> }): void => {
  let stopping: Promise<void> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let exitCode = 0
  let exited = false
  let recoveryReported = false
  const reportRecovery = (error?: unknown): void => {
    const detail = error === undefined ? '' : `: ${shutdownFailureCodes(error).join(', ')}`
    if (recoveryReported && !detail) return
    recoveryReported = true
    process.stderr.write(`xpanel-agent shutdown requires operational recovery${detail}\n`)
  }
  const finish = (code: number): void => {
    if (exited) return
    exited = true
    clearTimeout(deadline)
    process.exit(code)
  }
  const shutdown = (requestedCode: number): void => {
    exitCode = Math.max(exitCode, requestedCode)
    if (stopping) return
    deadline = setTimeout(() => { reportRecovery(); finish(1) }, AGENT_SHUTDOWN_TIMEOUT_MS)
    stopping = Promise.resolve().then(() => daemon.close()).then(
      () => finish(exitCode),
      (error: unknown) => { reportRecovery(error); finish(1) },
    )
  }
  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))
  void daemon.recoveryRequired.then(
    () => { reportRecovery(); shutdown(1) },
    () => { reportRecovery(); shutdown(1) },
  )
}

const isMainModule = (): boolean => {
  try {
    const entry = fileURLToPath(import.meta.url)
    const argv = process.argv[1]
    return argv === entry || (typeof argv === 'string' && argv.length > 0 && realpathSync(argv) === realpathSync(entry))
  } catch {
    return false
  }
}

if (isMainModule()) {
  startAgentDaemon()
    .then((daemon) => {
      process.stdout.write(`xpanel-agent ${daemon.quarantined ? 'quarantined' : 'listening'} on ${daemon.socketPath}\n`)
      attachAgentProcessLifecycle(daemon)
    })
    .catch((err) => {
      process.stderr.write(`xpanel-agent fatal error: ${err instanceof Error ? err.message : String(err)}${err instanceof AggregateError ? ` (${shutdownFailureCodes(err).join(', ')})` : ''}\n`)
      process.exit(1)
    })
}
