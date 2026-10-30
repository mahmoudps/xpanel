import { existsSync, readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { chmod, chown, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail } from '@xpanel/core'
import type { OsProfile } from '@xpanel/core'
import { appendAudit, createDb, initializeOperationalMetadata, migrate, pruneMetricsHistory, recordHostMetricsSample } from '@xpanel/db'
import { detectOs, XPANEL_FPM_SOCKET_DIR } from '@xpanel/os'
import { StateStore, atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import { createProductionAccountFileRunner, DEFAULT_FILE_WORKER_INCIDENT_DIR } from './production-file-runner.ts'
import { CanonicalIoResourcePipeline, IoAnalyticsEngine, WebsiteAnalyticsEngine } from './analytics.ts'
import { createProductionHostTargetMatcher, LinuxHostExecutor } from './executor.ts'
import { ensureAcmeWebRoot } from './host-access.ts'
import { syncRuntimePublicOrigin } from './agent-origin.ts'
import { ensureInstalledMail } from './services/local-mail.ts'
import { enableMailWebsocketProxy } from './services/mail-websocket.ts'
import { readOpenDkimPublished, writeOpenDkimPublished } from './services/opendkim-live.ts'
import { HostReconciler } from './reconciler.ts'
import { HostJobRunner } from './host-jobs.ts'
import { DATABASE_REMOTE_ACCESS_JOURNAL_DIR, pendingDatabaseRemoteAccessJournals, qualifyDatabaseRemoteAccessNative, recoverPendingDatabaseRemoteAccess } from './db-remote-provider.ts'
import { createHostJobRun } from './host-job-exec.ts'
import { createHostMetricsCollector } from './host-metrics.ts'
import { createBackupTransportProvider } from './acct-backup-sftp.ts'
import { hostBackupCredentialStore } from './acct-backup-credentials.ts'
import { defaultBackupArchiveRoot } from './acct-backup-runs.ts'
import { DatabaseSync } from 'node:sqlite'
import { BACKUP_LOW_PRIORITY } from './backup-low-priority.ts'
import { BANDWIDTH_LEDGER_PATH, createBandwidthMeter, enforceBandwidthLimits, type BandwidthMeter } from './metering.ts'
import { readProtectedLogFrom } from './account-logs.ts'
import { MAIL_LOG_MAX_OUTPUT_BYTES, observeMailLog } from './mail-log.ts'
import { observeFtpLog } from './ftp-log.ts'
import { createHostBackupRunController, readBackupConfigFiles, readSavedBackupDestination } from './acct-backup-runs.ts'
import { createAgentApp, listenAgentSocket, loadAgentCredentialFile } from './server.ts'
import { createSystemdPtySpawner, DEFAULT_TERMINAL_PTY_HELPER, TerminalSessionManager, verifyTerminalPtyHelper } from './terminal-sessions.ts'
import type { AgentApp } from './server.ts'
import { awaitLifecycleWriterDrain, createLifecycleBackgroundResources, isLifecycleManaged, readLifecyclePublicStatus, startLifecycleWriterParticipant, withLifecycleWriterAdmission } from '../../../scripts/lifecycle-admission.mjs'
import { createMariaDbSqlRunner, DEFAULT_MARIADB_ADMIN_CNF, defaultCommandRunner as mariadbCommandRunner, MariaDbServiceAdapter, mariadbSocketForFamily } from './services/mariadb.ts'
import { withPostgresqlSqlRunner } from './pg-sql.ts'
import { createNativeDnsReconcileProvider } from './services/dns-native.ts'

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

const detectHostOsProfile = async (): Promise<OsProfile> => detectOs((p) => readFileSync(p, 'utf8'))

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
  const rawQuotaFs = opts.quotaFilesystem !== undefined ? opts.quotaFilesystem : (process.env.XPANEL_QUOTA_FS ?? '/home')
  const quotaFilesystem = rawQuotaFs === 'none' || rawQuotaFs === '' ? null : rawQuotaFs
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
  let backupRuns: ReturnType<typeof createHostBackupRunController> | undefined
  let backupTimer: ReturnType<typeof setInterval> | undefined
  let resourcesFenced = false
  let closeDaemon: (() => Promise<void>) | undefined
  const participant = managed ? await startLifecycleWriterParticipant('agent', {
    // A fenced pipeline stays paused until an inspected process restart. This callback
    // does not establish native host quiescence or authorize barrier retirement.
    onFence: async () => { resourcesFenced = true; clearInterval(backupTimer); await hostMetrics?.stop(); await bandwidthMeter?.stop(); await ioResourcePipeline?.pause() },
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
        try { await listener.close() } catch (error) { errors.push(error) }
        try { await closeParticipant() } catch (error) { errors.push(error) }
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
        try { await listener?.close() } catch (error) { errors.push(error) }
        try { hostJobs?.close() } catch (error) { errors.push(error) }
        try { terminals?.closeAll() } catch (error) { errors.push(error) }
        try { await hostMetrics?.stop() } catch (error) { errors.push(error) }
        try { await bandwidthMeter?.stop() } catch (error) { errors.push(error) }
        try { clearInterval(backupTimer); await backupRuns?.idle() } catch (error) { errors.push(error) }
        try { await ioResourcePipeline?.stop() } catch (error) { errors.push(error) }
        try { await accountFileRunner?.close() } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, 'agent resource shutdown requires inspection')
      })()
      const closeNormal = (): Promise<void> => closing ??= (async () => {
        // Startup owns a shared writer scope. Waiting for global drainage inside that
        // scope would wait for ourselves; final retirement starts after its release.
        await startupSettled
        const errors: unknown[] = []
        try { await closeResources() } catch (error) { errors.push(error) }
        try { await awaitLifecycleWriterDrain() } catch (error) { errors.push(error) }
        try { await dbHandle.close() } catch (error) { errors.push(error) }
        // Closing owned IPC is process cleanup, never a host-drain assertion or
        // permission to remove an incident, root barrier, or retirement fence.
        try { await closeParticipant() } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, 'agent shutdown requires operational recovery')
      })()
      closeDaemon = closeNormal
      try {
        await migrate(dbHandle.runner)
        await initializeOperationalMetadata(dbHandle.db)

        const store = new StateStore(stateDir)
        const mariadbAdminCnfPath =
          opts.mariadbAdminCnfPath ?? process.env.XPANEL_MARIADB_ADMIN_CNF ?? DEFAULT_MARIADB_ADMIN_CNF
        const mariaDbOptions = {
          adminDefaultsFile: mariadbAdminCnfPath,
          socketPath: mariadbSocketForFamily(os.family, opts.mariadbSocketPath !== undefined ? opts.mariadbSocketPath : process.env.XPANEL_MARIADB_SOCKET),
        }
        const mariadbAdmin = new MariaDbServiceAdapter(mariaDbOptions)
        const sqlRunner = withPostgresqlSqlRunner(createMariaDbSqlRunner(mariadbAdmin))
        const executor = new LinuxHostExecutor({
          trustedHostTargetMatcher: createProductionHostTargetMatcher(),
          sqlRunner,
        })
        const readBackupDestination = readSavedBackupDestination(readBackupConfigFiles(stateDir))
        const backupDestinationProvider = createBackupTransportProvider({ readDestination: readBackupDestination, archiveRoot: defaultBackupArchiveRoot() })
        // Backup dumps run at the same low priority as the archive build, with the hour-long bound of a large database.
        const backupDumps = new MariaDbServiceAdapter({ ...mariaDbOptions, dumpTimeoutMs: 3_600_000, commandRunner: input => mariadbCommandRunner({ ...input, argv: [...BACKUP_LOW_PRIORITY, ...input.argv] }) })
        backupRuns = createHostBackupRunController({ executor, stateRoot: stateDir, provider: backupDestinationProvider, listAccounts: async () => (await store.listAccounts()).map(a => ({ id: a.id, username: a.username, home: a.home, uid: a.uid, status: a.status })),
          databases: {
            list: async account => (await store.listDatabases(account.id)).filter(database => database.engine === 'mariadb' && !database.trashedAt).map(database => database.name),
            dump: async (account, database, outputPath) => { const dumped = await backupDumps.streamLogicalDump({ database, username: account.username, outputPath }); return { bytes: dumped.sizeBytes, sha256: dumped.sha256 } },
          },
          zones: { list: async account => (await store.listDnsZones(account.id)).filter(zone => zone.accountId === account.id).map(zone => ({ name: zone.name, content: JSON.stringify(zone) })) },
          // VACUUM INTO writes a consistent copy of the WAL database from a separate read-only connection.
          ...(dbPath === ':memory:' ? {} : { copyControlDatabase: async (outputPath: string) => { const copy = new DatabaseSync(dbPath, { readOnly: true }); try { copy.prepare('VACUUM INTO ?').run(outputPath) } finally { copy.close() } } }),
        })
        hostMetrics = createHostMetricsCollector({ reader: { readFile: path => executor.readFile(path), runCommand: argv => executor.runCommand(argv), listDirectory: path => readdir(path) },
          write: (observation, at) => withLifecycleWriterAdmission(() => recordHostMetricsSample(dbHandle.db, { at, observation })),
          prune: olderThan => withLifecycleWriterAdmission(() => pruneMetricsHistory(dbHandle.db, olderThan, 'host')),
          onError: () => { process.stderr.write('xpanel-agent host metrics: sample could not be recorded\n') },
        })
        // Same bounded journal reader as /host/mail/log and /host/ftp/log (16 MiB output cap).
        const journalExecutor = process.platform === 'linux' ? new LinuxHostExecutor({ maxOutputBytes: MAIL_LOG_MAX_OUTPUT_BYTES }) : null
        bandwidthMeter = createBandwidthMeter({ readState: () => store.readSnapshot(), readFrom: readProtectedLogFrom,
          readMail: journalExecutor ? (since, until) => observeMailLog({ run: argv => journalExecutor.runCommand(argv), since, until }) : null,
          readFtp: journalExecutor ? (since, until) => observeFtpLog({ run: argv => journalExecutor.runCommand(argv), readState: () => store.readSnapshot(), since, until }) : null,
          readLedger: () => readJsonIfExists<unknown>(BANDWIDTH_LEDGER_PATH),
          writeLedger: ledger => withLifecycleWriterAdmission(() => atomicWriteJson(BANDWIDTH_LEDGER_PATH, ledger, 0o600)),
          afterCollect: async () => {
            await enforceBandwidthLimits(await bandwidthMeter!.report(), await store.readSnapshot(), {
              setLimits: (changes, expectedRevision) => withLifecycleWriterAdmission(() => store.setBandwidthLimits(changes, expectedRevision === undefined ? {} : { expectedRevision })),
              audit: entry => withLifecycleWriterAdmission(() => appendAudit(dbHandle.db, entry)),
              reconcile: () => reconciler.reconcile({ actor: 'agent' }),
            })
          },
          onError: () => { process.stderr.write('xpanel-agent bandwidth: collection could not be recorded\n') },
        })
        const ioAnalytics = new IoAnalyticsEngine()
        const websiteAnalytics = new WebsiteAnalyticsEngine()

        const fileHelperBinaryPath =
          opts.fileHelperBinaryPath ?? process.env.XPANEL_FILE_HELPER_BINARY ?? '/opt/xpanel/bin/xpanel-account-files'
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
        // Terminal sessions exist only with a verified root-owned PTY helper; otherwise they stay unavailable.
        const terminalHelperPath = opts.terminalPtyBinaryPath ?? process.env.XPANEL_TERMINAL_PTY_BINARY ?? DEFAULT_TERMINAL_PTY_HELPER
        if (await verifyTerminalPtyHelper(terminalHelperPath)) terminals = new TerminalSessionManager(createSystemdPtySpawner(terminalHelperPath))

        const reconciler: HostReconciler = new HostReconciler({
          store,
          db: dbHandle.db,
          executor,
          os,
          quotaFilesystem,
          ioDevices,
          dnsPublication: createNativeDnsReconcileProvider({ executor, family: os.family,
            readOwnedPaths: async () => new Set((await reconciler.ownedChecksums()).keys()),
          }),
        })
        await syncRuntimePublicOrigin(executor).catch((error: unknown) => {
          process.stderr.write(`xpanel-agent public origin: ${error instanceof Error ? error.message : String(error)}\n`)
        })
        await enableMailWebsocketProxy(executor).catch((error: unknown) => {
          process.stderr.write(`xpanel-agent mail websocket: ${error instanceof Error ? error.message : String(error)}\n`)
        })
        await reconciler.recoverInterruptedReconciliation().catch(() => undefined)
        hostJobs = new HostJobRunner({ db: dbHandle.db, run: createHostJobRun() })
        await hostJobs.recoverInterrupted().catch((error: unknown) => {
          process.stderr.write(`xpanel-agent host jobs: ${error instanceof Error ? error.message : String(error)}\n`)
        })
        // Remote database access stays unavailable unless the nft sets, the 0700 journal directory and MariaDB admin all qualify.
        await mkdir(DATABASE_REMOTE_ACCESS_JOURNAL_DIR, { recursive: true, mode: 0o700 }).catch(() => undefined)
        const databaseRemoteAccessNative = await qualifyDatabaseRemoteAccessNative({
          mariadb: mariadbAdmin,
          run: argv => executor.runCommand([...argv]),
          readAllEntries: async () => (await store.readSnapshot()).accounts.map(account => ({ accountId: account.id, status: account.status, entries: account.databaseRemoteAccess ?? [] })),
        })
        if (databaseRemoteAccessNative) {
          const report = await recoverPendingDatabaseRemoteAccess(databaseRemoteAccessNative, accountId => store.readDatabaseRemoteAccess(accountId)).catch(() => [{ accountId: null, outcome: 'review' as const }])
          for (const row of report) if (row.outcome === 'review') process.stderr.write(`xpanel-agent remote database recovery: journal ${row.accountId ?? 'unknown'} requires review\n`)
        } else if (await pendingDatabaseRemoteAccessJournals() !== 0) process.stderr.write('xpanel-agent remote database recovery: pending journals remain; the provider is not qualified\n')

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

        const app = createAgentApp({
          reconciler,
          store,
          db: dbHandle.db,
          executor,
          ...(accountFileRunner ? { accountFileRunner } : {}),
          ...(hostJobs ? { hostJobs } : {}),
          terminals,
          ioAnalytics,
          ioResourcePipeline,
          ...(process.platform === 'linux' ? { bandwidthMeter, readDiskLatency: () => hostMetrics!.latestDiskLatency() } : {}),
          websiteAnalytics,
          os: { id: os.id, versionId: os.versionId, family: os.family },
          nginxUser: os.paths.nginxUser,
          agentToken,
          mariadbAdmin,
          backupCredentials: hostBackupCredentialStore(),
          restoreBackupDatabase: async (account, database, inputPath, sha256) => { await backupDumps.streamLogicalRestore({ targetDatabase: database, username: account.username, inputPath, expectedSha256: sha256 }) },
          ...(databaseRemoteAccessNative ? { databaseRemoteAccessNative } : {}),
          readBackupDestination,
          backupDestinationProvider,
          backupRuns,
        })

        listener = await createLifecycleBackgroundResources(() => listenAgentSocket(app, socketPath, { gid: socketGid }))

        if (recoveryDetected) {
          fail('PRECONDITION_FAILED', 'privileged file worker recovery is required before agent startup')
        }
        if (!resourcesFenced) createLifecycleBackgroundResources(() => hostMetrics!.start())
        if (!resourcesFenced) { backupTimer = setInterval(() => { void backupRuns!.tick(); if (process.platform === 'linux') void bandwidthMeter!.collect() }, 60_000); backupTimer.unref() }
        return { app, socketPath, close: closeNormal, recoveryRequired, quarantined: false as const }
      } catch (error) {
        try { await closeResources() } catch (cleanup) { throw new AggregateError([error, cleanup], 'agent startup cleanup requires inspection') }
        throw error
      }
    })
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
  const reportRecovery = (): void => {
    if (recoveryReported) return
    recoveryReported = true
    process.stderr.write('xpanel-agent shutdown requires operational recovery\n')
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
      () => { reportRecovery(); finish(1) },
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
    return process.argv[1] === fileURLToPath(import.meta.url)
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
      process.stderr.write(`xpanel-agent fatal error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    })
}
