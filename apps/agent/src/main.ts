import { existsSync, readFileSync } from 'node:fs'
import { chown, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail } from '@xpanel/core'
import type { OsProfile } from '@xpanel/core'
import { createDb, migrate } from '@xpanel/db'
import { detectOs } from '@xpanel/os'
import { StateStore } from '@xpanel/state'
import { NativeAccountFileRunner, verifyHelperBinary } from './account-file-runner.ts'
import { IoAnalyticsEngine, WebsiteAnalyticsEngine } from './analytics.ts'
import { createProductionHostTargetMatcher, LinuxHostExecutor } from './executor.ts'
import { ensureAcmeWebRoot } from './host-access.ts'
import { syncRuntimePublicOrigin } from './agent-origin.ts'
import { ensureInstalledMail } from './services/local-mail.ts'
import { enableMailWebsocketProxy } from './services/mail-websocket.ts'
import { readOpenDkimPublished, writeOpenDkimPublished } from './services/opendkim-live.ts'
import { HostReconciler } from './reconciler.ts'
import { createAgentApp, listenAgentSocket, loadAgentCredentialFile } from './server.ts'
import { createMariaDbSqlRunner, DEFAULT_MARIADB_ADMIN_CNF, MariaDbServiceAdapter } from './services/mariadb.ts'

export interface AgentDaemonOptions {
  dbPath?: string
  stateDir?: string
  socketPath?: string
  agentTokenFile?: string
  socketGid?: number
  quotaFilesystem?: string | null
  ioDevices?: string[]
  fileHelperBinaryPath?: string
  mariadbAdminCnfPath?: string
}

const detectHostOsProfile = async (): Promise<OsProfile> => detectOs((p) => readFileSync(p, 'utf8'))

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

  if (dbPath !== ':memory:') {
    await mkdir(dirname(dbPath), { recursive: true })
  }
  await mkdir(stateDir, { recursive: true })
  const runtimeDirectory = dirname(socketPath)
  const createdRuntimeDirectory = await mkdir(runtimeDirectory, { recursive: true, mode: 0o750 })
  if (createdRuntimeDirectory) await chown(runtimeDirectory, 0, socketGid)

  const dbHandle = createDb(dbPath)
  await migrate(dbHandle.runner)

  const store = new StateStore(stateDir)
  const mariadbAdminCnfPath =
    opts.mariadbAdminCnfPath ?? process.env.XPANEL_MARIADB_ADMIN_CNF ?? DEFAULT_MARIADB_ADMIN_CNF
  const sqlRunner = createMariaDbSqlRunner(new MariaDbServiceAdapter({ adminDefaultsFile: mariadbAdminCnfPath }))
  const executor = new LinuxHostExecutor({
    trustedHostTargetMatcher: createProductionHostTargetMatcher(),
    sqlRunner,
  })
  const ioAnalytics = new IoAnalyticsEngine()
  const websiteAnalytics = new WebsiteAnalyticsEngine()

  const fileHelperBinaryPath =
    opts.fileHelperBinaryPath ?? process.env.XPANEL_FILE_HELPER_BINARY ?? '/opt/xpanel/bin/xpanel-account-files'
  let accountFileRunner: NativeAccountFileRunner | undefined
  if (existsSync(fileHelperBinaryPath)) {
    const helperSha256 = await verifyHelperBinary(fileHelperBinaryPath)
    accountFileRunner = new NativeAccountFileRunner({
      binaryPath: fileHelperBinaryPath,
      expectedSha256: helperSha256,
    })
  }

  const reconciler = new HostReconciler({
    store,
    db: dbHandle.db,
    executor,
    os,
    quotaFilesystem,
    ioDevices,
  })
  await syncRuntimePublicOrigin(executor).catch((error: unknown) => {
    process.stderr.write(`xpanel-agent public origin: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  await enableMailWebsocketProxy(executor).catch((error: unknown) => {
    process.stderr.write(`xpanel-agent mail websocket: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  await reconciler.recoverInterruptedReconciliation().catch(() => undefined)

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

  const app = createAgentApp({
    reconciler,
    store,
    db: dbHandle.db,
    executor,
    ...(accountFileRunner ? { accountFileRunner } : {}),
    ioAnalytics,
    websiteAnalytics,
    os: { id: os.id, versionId: os.versionId, family: os.family },
    nginxUser: os.paths.nginxUser,
    agentToken,
  })

  let listener: Awaited<ReturnType<typeof listenAgentSocket>>
  try {
    listener = await listenAgentSocket(app, socketPath, { gid: socketGid })
  } catch (error) {
    await dbHandle.close()
    throw error
  }

  return {
    app,
    socketPath,
    close: async () => {
      await listener.close()
      await dbHandle.close()
    },
  }
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
      process.stdout.write(`xpanel-agent listening on ${daemon.socketPath}\n`)
      const shutdown = () => {
        daemon.close().finally(() => process.exit(0))
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })
    .catch((err) => {
      process.stderr.write(`xpanel-agent fatal error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    })
}
