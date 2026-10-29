import { lifecycleAdmissionResponse, withLifecycleWriterAdmission } from '../../../scripts/lifecycle-admission.mjs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { constants } from 'node:fs'
import { lstat, open, readdir, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { Socket } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fail, isUuid, isXpanelError, validateDomainName } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { edge } from '@xpanel/render'
import type { Account, ErrorCode, Id, LiveEvent, Principal } from '@xpanel/core'
import { appendAudit, getPrincipal, latestActive } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { parseGenerationRollbackRequest } from '@xpanel/state'
import { type CanonicalIoResourcePipeline, type IoAnalyticsEngine, runJailedShellCommand, unavailableIoAnalytics, WebsiteAnalyticsEngine } from './analytics.ts'
import { LinuxHostExecutor } from './executor.ts'
import type { AgentExecutor } from './executor.ts'
import { JailedFileManager } from './file-manager.ts'
import { HtaccessWorkspace, deriveHtaccessTarget } from './htaccess-workspace.ts'
import { parseHtaccessRequest } from './htaccess-contract.ts'
import { createNativeHtaccessValidator, probeHtaccessTarget } from './htaccess-native.ts'
import { AcmeCertificateServiceAdapter } from './services/acme.ts'
import { createHttp01AcmeClient } from './services/acme-client.ts'
import { computeLeafFingerprintSha256 } from './services/acme.ts'
import { services } from '@xpanel/render'
import { readAccountAcmeOrders, readManagementTlsObservation, MAX_CERTIFICATE_ORDER_READS } from './services/certificate-observations.ts'
import { SecurityObservationService } from './services/security-observation.ts'
import { MailQuarantineService } from './services/mail-quarantine.ts'
import type { QuarantineNativeProfile, QuarantineServiceOptions } from './services/mail-quarantine.ts'
import { parseQuarantineMutation, quarantineIdentity } from '../../../packages/core/src/mail-quarantine.ts'
import type { QuarantineScope } from '../../../packages/core/src/mail-quarantine.ts'
import { installManualCertificate, validateCertificateRenewalTarget } from './services/certificate-workspace.ts'
import { assertAcl } from '@xpanel/core'
import { probeAuditLog, probeHostCapabilities, readHostMeasurements } from './host-probes.ts'
import { readAccountUsage } from './account-usage.ts'
import { observeHostLimits, unavailableHostLimits } from './limit-gaps.ts'
import { readPublicOriginSync } from './agent-origin.ts'
import { readHostConfigChecks, readHostIdentity, readServedCertificatePem, PANEL_LISTENER_PORT } from './host-identity.ts'
import { probeDkimOutcome } from './services/dkim-probe.ts'
import { createSignRateLimit, signMailboxSubmission, submissionFromDomains } from './services/dkim-sign.ts'
import { readOpenDkimPublicMaterial } from './services/opendkim-live.ts'
import { parseDf, parseDfInodes, parseLoadavg, parseMeminfo } from './host-info.ts'
import { readHostServices, restartHostService } from './host-services.ts'
import { readDefaultSiteRequests } from './default-site-observation.ts'
import { readGenerationRollbackAdmission } from './generation-rollback-admission.ts'
import { readPhpRuntimeInventory } from './php-inventory.ts'
import { handleMailQueueRoute } from './mail-queue-routes.ts'
import { handleSystemUpdatesRoute } from './system-updates-routes.ts'
import { nativePackageSafetyPorts, observePackageSafety } from './ops-package-writers.ts'
import { handleFileSharingRoute } from './ops-file-sharing-routes.ts'
import { handleRepairCenterRoute } from './repair-center-routes.ts'
import type { RhelCacheRecovery } from './repair-center.ts'
import { handleConfigurationHealthRoute } from './configuration-health.ts'
import { handleAccountHealthRoute, nativeAccountHealthHost } from './account-health.ts'
import { handleHostJobsRoute } from './host-jobs-routes.ts'
import type { HostJobRunner } from './host-jobs.ts'
import { handleSoftwareCenterRoute } from './software-center-routes.ts'
import { handleSwContainersRoute } from './sw-containers.ts'
import { handleSwAddonServicesRoute } from './sw-addon-services.ts'
import { handleSwDeploymentsRoute } from './sw-deployments.ts'
import { handleSwOptimizeRoute } from './sw-optimize.ts'
import { handleSwApplicationsRoute } from './sw-applications.ts'
import type { SwApplicationCatalogSource } from './sw-application-catalog-store.ts'
import type { ApplicationArtifactProvider } from './application-install.ts'
import type { ComposerJobProvider } from './composer-job-provider.ts'
import type { HostJobPlan } from './host-job-contract.ts'
import { handleMariadbAdminRoute, parseMariadbVersion } from './mariadb-admin.ts'
import { handleDatabaseTuningRoute } from './database-tuning.ts'
import { handleDbEnginesRoute } from './db-engines.ts'
import { handleDbSignonRoute, nodeDbSignonFs } from './db-signon.ts'
import { handleDbUpgradeRoute } from './db-upgrade.ts'
import { MARIADB_ADMIN_VERSION_SQL } from '../../../packages/os/src/mariadb-admin-command.ts'
import { handleComposerWorkspaceRoute } from './composer-workspace.ts'
import { handleServiceManagerRoute } from './service-manager-routes.ts'
import { createNativeBenchmarkStore, handleBenchmarkRoute } from './benchmark.ts'
import type { BenchmarkStore } from './benchmark.ts'
import { handleTrafficMonitorRoute } from './traffic-monitor.ts'
import { handleAccountGitRoute } from './account-git.ts'
import { handleAccountPackagesRoute } from './account-packages.ts'
import type { VerifiedPearCatalog } from './account-packages.ts'
import { handleDatabaseRemoteAccessRoute } from './database-remote-access.ts'
import type { DatabaseRemoteAccessNative } from './database-remote-access.ts'
import { handleTrustedProxiesRoute } from './trusted-proxies-routes.ts'
import type { TrustedProxyNativeProvider } from './trusted-proxies.ts'
import { handleBackupDestinationRoute } from './backup-destination.ts'
import { handleBackupRunsRoute } from './acct-backup-runs.ts'
import type { BackupRunController } from './acct-backup-runs.ts'
import { handleComponentRestoreRoute } from './acct-restore-components.ts'
import { handleStagingRoute } from './acct-staging.ts'
import type { BackupDestinationProbeProvider } from './backup-destination.ts'
import type { BackupDestinationTarget } from '@xpanel/core'
import type { AccountGitRun } from './account-git-runner.ts'
import { handleAccountPgpRoute } from './account-pgp.ts'
import { handleSitePublisherAgentRoute } from './site-publisher-routes.ts'
import type { PgpRunner } from './account-pgp.ts'
import type { MariadbAdminClient } from './mariadb-admin.ts'
import { assertMailLogMailboxCaller, handleMailLogRoute, MAIL_LOG_MAX_OUTPUT_BYTES } from './mail-log.ts'
import { FTP_LOG_MAX_OUTPUT_BYTES, handleFtpLogRoute } from './ftp-log.ts'
import { handleUpgradeRoute } from './upgrade-routes.ts'
import type { UpgradeCoordinator } from './upgrade-routes.ts'
import { DurableUpgradeCoordinator } from './upgrade-coordinator.ts'
import { handleHostMonitoringRoute } from './host-monitoring-route.ts'
import { handleMailServerObservationRoute } from './mail-server-observation.ts'
import { handleMailxRoute } from './mailx-routes.ts'
import { handleMailboxMaintenanceRoute } from './mailbox-maintenance-routes.ts'
import { handleServerObservationRoute } from './server-observation-routes.ts'
import { handleServerHealthRoute } from './server-health.ts'
import { handleSupportRoute } from './support-bundle.ts'
import { nodeUpgradeFs } from './upgrade-observation.ts'
import { SERVER_CRON_DIRECTORY } from '../../../packages/os/src/server-observation-command.ts'
import { handleServiceDetailRoute } from './service-detail-routes.ts'
import { handleDnsToolsRoute } from './dns-tools-routes.ts'
import { listHostDirectory, statHostPath } from './service-detail.ts'
import { handleSecurityToolsRoute } from './security-tools-routes.ts'
import { handleSecRoute } from './sec-routes.ts'
import { secIngressProviderFor } from './sec-ingress-provider.ts'
import { handleAccountSshRoute } from './account-ssh.ts'
import { handleAccountLogsRoute, readProtectedLogTail } from './account-logs.ts'
import { handleAccountVirusScanRoute } from './account-virus-scan.ts'
import { handleNetworkToolsRoute, systemNetworkToolsHost } from './network-tools.ts'
import { handleBackupFileRestoreRoute } from './backup-file-restore.ts'
import { handleAccountDatabaseInsightsRoute } from './account-database-insights.ts'
import { createAccountBackup, listAccountBackups, restoreAccountBackup, DEFAULT_BACKUP_DIR } from './account-backup.ts'
import type { AccountFileRunner } from './file-manager.ts'
import { handleAccountBackupAgentRequest } from './account-backup-workspace.ts'
import { handleTransferArchiveRoute } from './lifecycle-transfer-archives.ts'
import { handleConvertAddonFilesRoute } from './lifecycle-convert-addon-files.ts'
import { cronJobUnitId, cronWorkspaceRevision } from '@xpanel/core'
import type { CronWorkspaceJob } from '@xpanel/core'
import { system } from '@xpanel/render'
import { AccountProcessServiceAdapter } from './services/account-process.ts'
import {
  assertValidKernelPeerCredentials,
  bindVerifiedRequestPeer,
  DEFAULT_AGENT_SOCKET_BACKLOG,
  DEFAULT_AGENT_SOCKET_IDLE_TIMEOUT_MS,
  getVerifiedRequestPeer,
  loadNativePeerIdentityAddon,
  MAX_AGENT_INFLIGHT_REQUESTS,
  MAX_AGENT_SOCKET_CONNECTIONS,
  normalizeAllowedPeerUids,
  resolveProvisionedPeerUids,
  stripForgedPeerHeaders,
} from './peer-identity.ts'
import type {
  KernelPeerCredentials,
  NativePeerAcceptedConnection,
  NativePeerIdentityAddon,
  PeerIdentityDecisionEvent,
} from './peer-identity.ts'
import type { HostReconciler } from './reconciler.ts'

export * from './peer-identity.ts'

export type AgentCallerRole = Principal['kind']

export const MAX_AGENT_MESSAGE_BYTES = 8 * 1024 * 1024

/** Kept equivalent to current catalog metadata by an affected authorization test. */
export const AGENT_QUARANTINE_FEATURE_POLICY = Object.freeze([
  Object.freeze({ id: 'spam-quarantine', featureKey: 'spam-quarantine' }),
  Object.freeze({ id: 'email-accounts', featureKey: 'popaccts (Email Accounts)' }),
] as const)

export const assertAgentCredential = (token: unknown): string => {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    fail('PRECONDITION_FAILED', 'agent requires a provisioned 32-byte hexadecimal service credential')
  }
  return token as string
}

/** Open the credential itself, then validate its metadata; never follow a token symlink. */
export const loadAgentCredentialFile = async (path: string): Promise<string> => {
  if (process.platform !== 'linux' || !isAbsolute(path)) {
    fail('PRECONDITION_FAILED', 'protected agent credential files require an absolute Linux path')
  }
  await assertRootOwnedAgentPath(dirname(path))
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.uid !== 0 || ![0o600, 0o640].includes(metadata.mode & 0o7777) || metadata.size > 65) {
      fail('PRECONDITION_FAILED', 'agent credential must be a root-owned regular file with mode 0600 or 0640')
    }
    return assertAgentCredential((await handle.readFile('utf8')).trim())
  } finally {
    await handle.close()
  }
}

export const assertRootOwnedAgentPath = async (path: string): Promise<void> => {
  if (process.platform !== 'linux' || !isAbsolute(path)) {
    fail('PRECONDITION_FAILED', 'protected agent paths require an absolute Linux path')
  }
  let current = resolve(path)
  while (true) {
    const metadata = await lstat(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      fail('PRECONDITION_FAILED', 'agent paths must traverse root-owned directories without group or other write access')
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 422,
  OVERSELL_BLOCKED: 422,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  SELF_LOCKOUT: 422,
  ENGINE_UNAVAILABLE: 422,
  SERVICE_UNAVAILABLE: 503,
  UNSUPPORTED_OS: 422,
  CONFIG_TEST_FAILED: 422,
  PRECONDITION_FAILED: 412,
}

export interface AgentCallerIdentity {
  principalId: Id
  actor: string
  role: AgentCallerRole
  accountId: Id | null
  resellerId: Id | null
}

export const agentCallerHeaders = (caller: {
  principalId: Id
  token: string
}): Record<string, string> => {
  if (!isUuid(caller.principalId)) fail('UNAUTHENTICATED', 'an authenticated principal is required')
  return {
    'x-xpanel-agent-token': assertAgentCredential(caller.token),
    'x-xpanel-principal-id': caller.principalId,
  }
}

const safeTokenCompare = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

/**
 * Formats an RFC 7807 Problem Details response.
 * Non-`XpanelError` 500 internal errors NEVER expose `err.message` to callers.
 */
const problemResponse = (err: unknown, instance: string): Response => {
  if (isXpanelError(err)) {
    const status = STATUS_BY_CODE[err.code] ?? 400
    return new Response(
      JSON.stringify({
        type: `https://xpanel.dev/problems/${err.code.toLowerCase().replace(/_/g, '-')}`,
        title: err.code,
        status,
        detail: err.message,
        code: err.code,
        instance,
        ...(Object.keys(err.detail).length > 0 && { details: err.detail }),
      }),
      {
        status,
        headers: { 'content-type': 'application/problem+json; charset=utf-8' },
      },
    )
  }
  return new Response(
    JSON.stringify({
      type: 'https://xpanel.dev/problems/internal-error',
      title: 'INTERNAL_ERROR',
      status: 500,
      detail: 'Internal agent error',
      instance,
    }),
    {
      status: 500,
      headers: { 'content-type': 'application/problem+json; charset=utf-8' },
    },
  )
}

export interface AgentServerDeps {
  reconciler: HostReconciler
  store: StateStore
  db: Db
  executor?: AgentExecutor
  /** Trusted startup evidence; absence never admits SSH key mutations. */
  assertKeyMutationQualified?: () => Promise<void>
  /** Protected fleet fingerprints are supplied locally, never by an HTTP request. */
  protectedSshKeyFingerprints?: readonly string[]
  /** Trusted activated filter profile; identity is derived locally, never from an RPC profile. */
  resolveQuarantineProfile?: (identity: Readonly<QuarantineScope & Pick<QuarantineNativeProfile, 'serviceUserId'>>) => ReturnType<QuarantineServiceOptions['resolveProfile']>
  /** Independently qualified native quarantine admission; absence refuses every write. */
  quarantineQualification?: QuarantineServiceOptions['authorize']
  accountFileRunner?: AccountFileRunner
  /** Independently qualified account jail and Git egress adapter; absence keeps native Git unavailable. */
  accountGitRun?: AccountGitRun
  applicationCatalog?: SwApplicationCatalogSource | null
  /** No implementation exists; stays null until native qualification. */
  applicationProvider?: ApplicationArtifactProvider | null
  composerJobProvider?: ComposerJobProvider | null
  accountPackageCatalog?: VerifiedPearCatalog
  admitAccountPackageMutation?: (account: Account) => Promise<void>
  databaseRemoteAccessNative?: DatabaseRemoteAccessNative
  trustedProxiesProvider?: TrustedProxyNativeProvider
  backupDestinationProvider?: BackupDestinationProbeProvider
  readBackupDestination?: (id: string) => Promise<BackupDestinationTarget | null>
  backupRuns?: BackupRunController
  /** Independently qualified account keyring runner; absence keeps native OpenPGP unavailable. */
  pgpRunner?: PgpRunner
  benchmarkStore?: BenchmarkStore
  /** The one daemon-owned host job runner; absence keeps host jobs unavailable. */
  hostJobs?: HostJobRunner
  /** Absent until exclusive cache snapshot/recovery and crash recovery are independently qualified. */
  rhelCacheRecovery?: RhelCacheRecovery
  /** Absent until the /var/lib/rpm snapshot provider (ops-package-recovery.ts createRpmDatabaseRecovery) is natively qualified. */
  rpmDatabaseRecovery?: RhelCacheRecovery
  /** Trusted local cron evidence only; absence never admits scheduler operations. */
  cronQualification?: (input: { account: Account; job: CronWorkspaceJob; action: 'observe' | 'run' }) => Promise<void>
  ioAnalytics?: IoAnalyticsEngine
  /** The one daemon-owned sampler; API reads never create collectors or choose kernel paths. */
  ioResourcePipeline?: CanonicalIoResourcePipeline
  websiteAnalytics?: WebsiteAnalyticsEngine
  /** Native upgrade coordinator launcher. Absent: upgrade start is refused with upgrade-coordinator-unavailable. */
  upgradeCoordinator?: UpgradeCoordinator
  os: { id: string; versionId: string; family: string }
  /** System account nginx runs as. The ACME traversal probe uses it. */
  nginxUser?: string
  /** Optional override for account home root in tests (maps `/home/<user>` into `<homeBaseDir>/home/<user>`) */
  homeBaseDir?: string
  /** Provisioned local service credential; there is no unauthenticated mode. */
  agentToken: string
  /** Protected MariaDB admin client (MariaDbServiceAdapter); absence reports database observations as unavailable. */
  mariadbAdmin?: MariadbAdminClient
  /**
   * Expected unprivileged API service UID(s). When configured, every request
   * must carry verified kernel SO_PEERCRED identity matching an allowed UID;
   * missing or mismatched peer identity fails closed before route execution.
   */
  expectedPeerUid?: number | readonly number[]
  /** Whether root (UID 0) is also permitted when `expectedPeerUid` is configured. */
  allowRootPeer?: boolean
  /** Optional observer invoked whenever kernel peer identity is evaluated. */
  onPeerDecision?: (event: PeerIdentityDecisionEvent) => void
}

export interface AgentApp {
  fetch(req: Request): Promise<Response>
  subscribe(fn: (event: LiveEvent) => void): () => void
}

const FILE_AUDIT_ACTIONS: Readonly<Record<string, string>> = {
  write: 'file.write',
  'put-bytes': 'file.write',
  mkdir: 'file.mkdir',
  chmod: 'file.chmod',
  trash: 'file.trash',
  restore: 'file.restore',
  'empty-trash': 'file.empty_trash',
  'purge-trash': 'file.purge_trash',
}

export const createAgentApp = (deps: AgentServerDeps): AgentApp => {
  const benchmarkStore = deps.benchmarkStore ?? (process.platform === 'linux' && deps.executor instanceof LinuxHostExecutor ? createNativeBenchmarkStore() : null)
  const credential = assertAgentCredential(deps.agentToken)
  const configuredAllowedPeerUids =
    deps.expectedPeerUid !== undefined
      ? normalizeAllowedPeerUids(deps.expectedPeerUid, deps.allowRootPeer === true)
      : null
  const allowDkimSign = createSignRateLimit()
  const webEngine = deps.websiteAnalytics ?? new WebsiteAnalyticsEngine()
  const securityExecutor = deps.executor ?? new LinuxHostExecutor()
  let securityObservation: Promise<SecurityObservationService> | undefined
  const protectedSecurityObservation = (): Promise<SecurityObservationService> => {
    if (!securityObservation) securityObservation = (async () => {
      let profile: ReturnType<typeof profileFor>
      try {
        const release = await securityExecutor.readFile('/etc/os-release')
        if (!release) return fail('PRECONDITION_FAILED', 'SSH observations require a trusted supported host profile', { stateChanged: false })
        profile = profileFor(release)
        if (profile.family !== deps.os.family || !['debian', 'rhel'].includes(profile.family)) return fail('PRECONDITION_FAILED', 'SSH observations require a trusted supported host profile', { stateChanged: false })
      } catch { return fail('PRECONDITION_FAILED', 'SSH observations require a trusted supported host profile', { stateChanged: false }) }
      return new SecurityObservationService({ executor: securityExecutor, os: profile, stateDir: '/var/lib/xpanel-agent', protectedFingerprints: deps.protectedSshKeyFingerprints })
    })().catch(error => { securityObservation = undefined; throw error })
    return securityObservation
  }
  let htaccessValidator: Promise<ReturnType<typeof createNativeHtaccessValidator> | undefined> | undefined
  const protectedHtaccessValidator = () => htaccessValidator ??= (async () => {
    try {
      const release = await (deps.executor ?? new LinuxHostExecutor()).readFile('/etc/os-release')
      if (!release) return undefined
      const profile = profileFor(release)
      if (profile.family !== deps.os.family || !['debian', 'rhel'].includes(profile.family)) return undefined
      // Use the reviewed concrete executable, avoiding distro apachectl symlinks.
      return createNativeHtaccessValidator({ apacheControlPath: profile.family === 'debian' ? '/usr/sbin/apache2ctl' : '/usr/sbin/httpd',
        apacheMainConfigPath: profile.paths.apacheMainConf, workRoot: '/run/xpanel/htaccess-checks' })
    } catch { return undefined }
  })()

  const resolveAccountHome = (accountHome: string, username: string): string => {
    if (!deps.homeBaseDir) return accountHome
    return resolve(deps.homeBaseDir, 'home', username)
  }

  const assertSocketPeerAuthorized = async (
    req: Request,
    pathname: string,
    method: string,
  ): Promise<KernelPeerCredentials | null> => {
    const verifiedContext = getVerifiedRequestPeer(req)
    if (!verifiedContext) {
      if (configuredAllowedPeerUids !== null) {
        fail('PRECONDITION_FAILED', 'kernel socket peer identity verification is required')
      }
      return null
    }
    const peer = assertValidKernelPeerCredentials(verifiedContext.peer)
    if (verifiedContext.credentialSource !== 'SO_PEERCRED') {
      fail('PRECONDITION_FAILED', 'socket peer identity must originate from kernel SO_PEERCRED')
    }
    const effectiveAllowedUids =
      configuredAllowedPeerUids !== null
        ? new Set([...configuredAllowedPeerUids].filter((uid) => verifiedContext.allowedPeerUids.has(uid)))
        : verifiedContext.allowedPeerUids
    if (effectiveAllowedUids.size === 0) {
      fail('PRECONDITION_FAILED', 'no authorized socket peer UIDs are configured')
    }
    const allowed = effectiveAllowedUids.has(peer.uid)
    deps.onPeerDecision?.({
      allowed,
      peer,
      allowedPeerUids: [...effectiveAllowedUids],
      credentialSource: 'SO_PEERCRED',
      pathname,
      method,
    })
    if (!allowed) {
      await appendAudit(deps.db, {
        actor: `uid:${peer.uid}`,
        action: 'agent.peer_denied',
        target: pathname,
        detail: {
          peerUid: peer.uid,
          peerGid: peer.gid,
          peerPid: peer.pid,
          expectedUids: [...effectiveAllowedUids],
          peerSource: 'SO_PEERCRED',
        },
        outcome: 'denied',
      })
      fail('FORBIDDEN', 'unauthorized socket peer identity', {
        peerUid: peer.uid,
        peerGid: peer.gid,
        peerPid: peer.pid,
        peerSource: 'SO_PEERCRED',
        credentialSource: 'SO_PEERCRED',
      })
    }
    return peer
  }

  const authenticateService = (req: Request): void => {
    const tokenHeader = req.headers.get('x-xpanel-agent-token')
    if (!tokenHeader || !safeTokenCompare(tokenHeader, credential)) {
      fail('UNAUTHENTICATED', 'invalid or missing agent service authentication')
    }
  }

  const authenticateCaller = async (req: Request): Promise<AgentCallerIdentity> => {
    const principal = await getPrincipal(deps.db, req.headers.get('x-xpanel-principal-id') ?? '')
    if (!principal || principal.disabled) return fail('UNAUTHENTICATED', 'an enabled authenticated principal is required')
    if (principal.kind === 'user') {
      const account = principal.accountId ? await deps.store.getAccount(principal.accountId) : null
      if (!account || account.status !== 'active') fail('FORBIDDEN', 'account is not active')
    }
    if (principal.kind === 'reseller' && !(await deps.store.getReseller(principal.id))) {
      fail('UNAUTHENTICATED', 'reseller identity is not available')
    }
    return {
      principalId: principal.id,
      actor: principal.username,
      role: principal.kind,
      accountId: principal.accountId,
      resellerId: principal.kind === 'reseller' ? principal.id : null,
    }
  }

  const assertRootCaller = async (caller: AgentCallerIdentity, target: string): Promise<void> => {
    if (caller.role !== 'root') {
      await appendAudit(deps.db, {
        actor: caller.actor,
        action: 'agent.access_denied',
        target,
        detail: { requiredRole: 'root', actualRole: caller.role },
        outcome: 'denied',
      })
      fail('FORBIDDEN', 'root role is required for this agent operation')
    }
  }

  const assertAccountCaller = async (caller: AgentCallerIdentity, account: Account, opName: string): Promise<void> => {
    if (caller.role === 'root') return
    if (account.status !== 'active') fail('FORBIDDEN', 'account is not active')
    if (caller.role === 'reseller' && caller.resellerId && account.ownerId === caller.resellerId) return
    if (caller.role === 'user' && caller.accountId && account.id === caller.accountId) return

    await appendAudit(deps.db, {
      actor: caller.actor,
      action: 'agent.access_denied',
      target: `account:${account.username}`,
      detail: {
        op: opName,
        callerRole: caller.role,
        callerAccountId: caller.accountId,
        callerResellerId: caller.resellerId,
        targetAccountId: account.id,
      },
      outcome: 'denied',
    })
    fail('FORBIDDEN', `caller "${caller.actor}" is not authorized to access account "${account.username}"`)
  }

  const readReconcileBody = async (req: Request): Promise<{ force: boolean }> => {
    const raw = await req.text()
    if (raw.length === 0) return { force: false }
    let value: unknown
    try { value = JSON.parse(raw) } catch { return fail('VALIDATION', 'request body must be valid JSON') }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail('VALIDATION', 'request body must be an object')
    }
    if (Object.keys(value).some(key => key !== 'force')) {
      return fail('VALIDATION', 'only force may be supplied in a reconcile request')
    }
    const force = (value as { force?: unknown }).force
    if (force !== undefined && typeof force !== 'boolean') return fail('VALIDATION', 'force must be a boolean')
    return { force: force === true }
  }

  const readObjectBody = async (req: Request): Promise<Record<string, unknown>> => {
    let value: unknown
    try { value = await req.json() } catch { return fail('VALIDATION', 'request body must be valid JSON') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', 'request body must be an object')
    return value as Record<string, unknown>
  }

  type QuarantineAction = Parameters<QuarantineServiceOptions['authorize']>[1]
  type QuarantineCall = { req: Request; caller: AgentCallerIdentity; scope: QuarantineScope; action: QuarantineAction;
    nativeIdentity: { serviceUserId: string; accountUsername: string; uid: number; gid: number } | null }
  const quarantineCall = new AsyncLocalStorage<QuarantineCall>()
  const assertQuarantineAuthority: QuarantineServiceOptions['authorize'] = async (scope, action) => {
    const context = quarantineCall.getStore()
    if (!context || context.scope.accountId !== scope.accountId || context.scope.mailbox !== scope.mailbox
      || action !== 'read' && action !== context.action) return fail('FORBIDDEN', 'quarantine request authority is unavailable', { stateChanged: false })
    const principal = await getPrincipal(deps.db, context.caller.principalId)
    if (!principal || principal.disabled || principal.kind !== context.caller.role || principal.username !== context.caller.actor) return fail('FORBIDDEN', 'current quarantine authorization is required', { stateChanged: false })
    const account = await deps.store.getAccount(scope.accountId)
    if (!account || account.status !== 'active') return fail('NOT_FOUND', 'active quarantine account not found', { stateChanged: false })
    if (principal.kind === 'user' && (principal.accountId !== account.id || principal.username !== account.username)) return fail('FORBIDDEN', 'hosting account authorization is required for quarantine', { stateChanged: false })
    if (principal.kind === 'reseller') {
      if (account.ownerId !== principal.id) return fail('FORBIDDEN', 'quarantine account ownership changed', { stateChanged: false })
      assertAcl({ id: principal.id, username: principal.username, kind: 'reseller' }, await deps.store.getReseller(principal.id), context.action === 'read' ? 'list-accounts' : 'edit-account')
    }
    if (principal.kind !== 'root') {
      const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
      if (!features || AGENT_QUARANTINE_FEATURE_POLICY.some(tool => features.disabled.includes(tool.id) || features.disabled.includes(tool.featureKey))) return fail('FORBIDDEN', 'quarantine is unavailable in the current account feature policy', { stateChanged: false })
    }
    const mailbox = await deps.store.getServiceUserByLogin(scope.mailbox)
    if (!mailbox || !mailbox.services.email || mailbox.accountId !== account.id || mailbox.login !== scope.mailbox) return fail('NOT_FOUND', 'quarantine mailbox not found', { stateChanged: false })
    const identity = { serviceUserId: mailbox.id, accountUsername: account.username, uid: account.uid, gid: account.gid }
    if (context.nativeIdentity && (context.nativeIdentity.serviceUserId !== identity.serviceUserId || context.nativeIdentity.accountUsername !== identity.accountUsername
      || context.nativeIdentity.uid !== identity.uid || context.nativeIdentity.gid !== identity.gid)) return fail('CONFLICT', 'quarantine mailbox lifetime or native account changed', { stateChanged: false })
    context.nativeIdentity ??= identity
  }
  const authorizeQuarantine: QuarantineServiceOptions['authorize'] = async (scope, action) => {
    await assertQuarantineAuthority(scope, action)
    const required = quarantineCall.getStore()!.action
    if (required !== 'read') {
      if (!deps.quarantineQualification) return fail('PRECONDITION_FAILED', 'quarantine changes require independently qualified host capability', { stateChanged: false })
      await deps.quarantineQualification({ ...scope }, required)
      await assertQuarantineAuthority(scope, required)
      if (process.platform !== 'linux' || !(deps.executor instanceof LinuxHostExecutor)) return fail('PRECONDITION_FAILED', 'quarantine changes require the native Linux host executor', { stateChanged: false })
    }
  }
  const quarantineService = new MailQuarantineService({ executor: securityExecutor, authorize: authorizeQuarantine, resolveProfile: async scope => {
    const context = quarantineCall.getStore()
    if (!context) return fail('FORBIDDEN', 'quarantine request authority is unavailable', { stateChanged: false })
    await authorizeQuarantine(scope, context.action)
    if (!deps.resolveQuarantineProfile || process.platform !== 'linux' || !(deps.executor instanceof LinuxHostExecutor)) return null
    const identity = context.nativeIdentity
    if (!identity) return fail('FORBIDDEN', 'quarantine mailbox lifetime is unavailable', { stateChanged: false })
    const profile = await deps.resolveQuarantineProfile(Object.freeze({ accountId: scope.accountId, serviceUserId: identity.serviceUserId, mailbox: scope.mailbox }))
    await authorizeQuarantine(scope, context.action)
    if (profile && (profile.accountId !== scope.accountId || profile.mailbox !== scope.mailbox || profile.serviceUserId !== identity.serviceUserId
      || profile.accountUsername !== identity.accountUsername || profile.uid !== identity.uid || profile.gid !== identity.gid)) return fail('PRECONDITION_FAILED', 'trusted quarantine profile does not match current mailbox authority', { stateChanged: false })
    return profile
  } })
  const readQuarantineObjectBody = async (req: Request): Promise<Record<string, unknown>> => {
    const reader = req.body?.getReader(), chunks: Uint8Array[] = []; let length = 0
    if (reader) try {
      while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength
        if (length > 16384) { await reader.cancel().catch(() => {}); return fail('VALIDATION', 'quarantine request exceeds its bounded body size', { stateChanged: false }) }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { return fail('VALIDATION', 'quarantine request must contain valid UTF-8 JSON', { stateChanged: false }) }
    if (!quarantineIdentity.object(value)) return fail('VALIDATION', 'quarantine request must be an object', { stateChanged: false })
    return value
  }

  const readFileBody = async (req: Request) => {
    const body = await readObjectBody(req)
    const fields: Record<string, readonly string[]> = {
      list: ['path', 'showHidden'], read: ['path'], write: ['path', 'content', 'overwrite', 'mode'],
      'put-bytes': ['path', 'contentBase64', 'overwrite', 'mode'], 'get-bytes': ['path'],
      mkdir: ['path', 'mode'], chmod: ['path', 'mode'], trash: ['path'],
      'list-trash': [], restore: ['trashId', 'overwrite'], 'empty-trash': ['olderThanDays'],
      'purge-trash': ['trashId', 'originalPath', 'deletedAt'],
    }
    if (typeof body.op !== 'string' || !Object.hasOwn(fields, body.op)) fail('VALIDATION', 'unsupported file operation')
    const op = body.op as string
    if (Object.keys(body).some(key => key !== 'op' && !fields[op]!.includes(key))) fail('VALIDATION', 'unknown file operation field')
    for (const key of ['path', 'content', 'contentBase64', 'trashId', 'originalPath', 'deletedAt']) {
      if (body[key] !== undefined && typeof body[key] !== 'string') fail('VALIDATION', `${key} must be a string`)
    }
    for (const key of ['overwrite', 'showHidden']) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') fail('VALIDATION', `${key} must be a boolean`)
    }
    for (const key of ['mode', 'olderThanDays']) {
      if (body[key] !== undefined && typeof body[key] !== 'number') fail('VALIDATION', `${key} must be a number`)
    }
    if (op === 'write' && typeof body.content !== 'string') fail('VALIDATION', 'write content is required')
    if (op === 'put-bytes' && typeof body.contentBase64 !== 'string') fail('VALIDATION', 'binary content is required')
    return body as {
      op: string; path?: string; content?: string; contentBase64?: string; overwrite?: boolean; mode?: number;
      showHidden?: boolean; trashId?: string; olderThanDays?: number; originalPath?: string; deletedAt?: string
    }
  }

  const streamInternalEvents = (req: Request): Response => {
    let dispose = () => undefined as void
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        let unsubscribe = () => undefined as void
        let heartbeat: ReturnType<typeof setInterval> | undefined
        dispose = () => {
          if (closed) return
          closed = true
          unsubscribe()
          if (heartbeat) clearInterval(heartbeat)
          req.signal.removeEventListener('abort', finish)
        }
        const finish = () => {
          if (closed) return
          dispose()
          controller.close()
        }
        const send = (value: unknown) => {
          if (closed) return
          const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
          if (bytes.length > 128 * 1024 || (controller.desiredSize ?? 0) <= 0) return finish()
          controller.enqueue(bytes)
        }
        unsubscribe = deps.reconciler.subscribe(event => send({ event }))
        heartbeat = setInterval(() => send({ heartbeat: new Date().toISOString() }), 20_000)
        heartbeat.unref()
        req.signal.addEventListener('abort', finish, { once: true })
        send({ heartbeat: new Date().toISOString() })
        if (req.signal.aborted) finish()
      },
      cancel() { dispose() },
    }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength })
    return new Response(stream, {
      headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
    })
  }

  const fetchInner = async (req: Request): Promise<Response> => {
    const url = new URL(req.url, 'http://agent.local')
    const { pathname } = url
    const method = req.method.toUpperCase()

    try {
      const verifiedPeer = await assertSocketPeerAuthorized(req, pathname, method)
      authenticateService(req)
      if (method === 'GET' && pathname === '/health') {
        const currentGen = await latestActive(deps.db)
        const linuxExecutor = deps.executor instanceof LinuxHostExecutor ? deps.executor : null
        const executor = linuxExecutor ? 'linux' : deps.executor ? 'fake' : 'unknown'
        const measurements = linuxExecutor ? await readHostMeasurements(linuxExecutor, deps.nginxUser ?? 'nginx') : undefined
        const auditLog = await probeAuditLog(() => deps.db.query('SELECT id FROM audit_log LIMIT 1'))
        return jsonResponse({
          ok: true,
          os: deps.os,
          currentGeneration: currentGen,
          executor,
          ...(measurements ? { probes: probeHostCapabilities(Boolean(deps.accountFileRunner), true, { ...measurements, auditLog, hostJobs: Boolean(deps.hostJobs), packageFamily: deps.os.family }) } : {}),
          ...(verifiedPeer
            ? {
                peer: {
                  uid: verifiedPeer.uid,
                  gid: verifiedPeer.gid,
                  pid: verifiedPeer.pid,
                  source: 'SO_PEERCRED' as const,
                },
              }
            : {}),
        })
      }

      if (method === 'GET' && pathname === '/internal/events') return streamInternalEvents(req)

      const caller = await authenticateCaller(req)

      if (method === 'GET' && pathname === '/host/dkim-probe') {
        const outcome = probeDkimOutcome()
        return jsonResponse(outcome.selector ? outcome : { status: outcome.status })
      }

      if (method === 'GET' && pathname === '/host/dkim-public') {
        const domain = validateDomainName(url.searchParams.get('domain') ?? '')
        const assigned = (await deps.store.listDomains()).find(row => row.name === domain)
        const account = assigned ? await deps.store.getAccount(assigned.accountId) : null
        if (!account) return fail('NOT_FOUND', 'domain not found')
        await assertAccountCaller(caller, account, 'host.dkim-public')
        if (!deps.executor) return fail('PRECONDITION_FAILED', 'verified DKIM signing material is unavailable')
        const material = await readOpenDkimPublicMaterial(deps.executor, domain)
        if (!material) return fail('PRECONDITION_FAILED', 'verified DKIM signing material is unavailable')
        return jsonResponse(material)
      }

      if (method === 'POST' && pathname === '/host/dkim-sign') {
        const body = await readObjectBody(req)
        const mailbox = typeof body.mailbox === 'string' ? body.mailbox.trim().toLowerCase() : ''
        const rawMime = typeof body.rawMime === 'string' ? body.rawMime : ''
        const purpose = body.purpose
        const validMailbox = mailbox.length <= 254 && /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(mailbox)
        const auditSign = async (outcome: 'ok' | 'denied' | 'failed', detail: Record<string, unknown>): Promise<void> => {
          await appendAudit(deps.db, {
            actor: caller.actor,
            action: 'host.dkim-sign',
            target: `mailbox:${validMailbox ? mailbox : 'unavailable'}`,
            detail,
            outcome,
          })
        }
        if (purpose !== 'webmail-send') {
          await auditSign('denied', { reason: 'purpose' })
          return fail('FORBIDDEN', 'signing is only available to the webmail send path')
        }
        if (!validMailbox) {
          await auditSign('denied', { reason: 'mailbox' })
          return fail('VALIDATION', 'mailbox address is invalid')
        }
        const mimeBytes = Buffer.byteLength(rawMime, 'utf8')
        if (mimeBytes === 0 || mimeBytes > 12_000_000) {
          await auditSign('denied', { reason: 'size', bytes: mimeBytes })
          return fail('VALIDATION', 'submitted message is empty or too large')
        }
        const user = await deps.store.getServiceUserByLogin(mailbox)
        if (!user?.services.email) {
          await auditSign('denied', { reason: 'mailbox-not-found' })
          return fail('NOT_FOUND', 'mailbox not found')
        }
        const account = await deps.store.getAccount(user.accountId)
        if (!account) {
          await auditSign('denied', { reason: 'account-not-found' })
          return fail('NOT_FOUND', 'account not found')
        }
        try {
          await assertAccountCaller(caller, account, 'host.dkim-sign')
        } catch (error) {
          await auditSign('denied', { reason: 'cross-account', accountId: account.id })
          throw error
        }
        const fromDomains = submissionFromDomains(rawMime)
        const domains = new Set((await deps.store.listDomains({ accountId: account.id })).map(domain => domain.name.toLowerCase()))
        const mailboxDomain = mailbox.slice(mailbox.lastIndexOf('@') + 1)
        if (!domains.has(mailboxDomain) || !fromDomains || fromDomains.some(domain => !domains.has(domain)) || new Set(fromDomains).size !== 1) {
          await auditSign('denied', { reason: 'from-domain', fromDomain: fromDomains?.[0] ?? null })
          return fail('FORBIDDEN', 'the From domain is not one of this account')
        }
        const fromDomain = fromDomains[0]!
        if (!allowDkimSign(account.id)) {
          await auditSign('denied', { reason: 'rate' })
          return fail('FORBIDDEN', 'signing rate limit exceeded')
        }
        if (!deps.executor) {
          await auditSign('failed', { reason: 'unavailable' })
          return jsonResponse({ signed: false }, 404)
        }
        const signed = await signMailboxSubmission(deps.executor, mailbox, rawMime, fromDomain)
        if (!signed) {
          await auditSign('failed', { reason: 'unsigned', fromDomain })
          return jsonResponse({ signed: false })
        }
        await auditSign('ok', { fromDomain, purpose: 'webmail-send' })
        return jsonResponse({ rawMime: signed })
      }

      if (method === 'GET' && pathname === '/host/account-usage') {
        const username = url.searchParams.get('username') ?? ''
        const account = await deps.store.getAccountByUsername(username)
        if (!account) return fail('NOT_FOUND', 'account not found')
        await assertAccountCaller(caller, account, 'host.account-usage')
        if (!deps.executor) return jsonResponse({ available: false }, 404)
        let resources
        try { resources = (await deps.store.getPlan(account.planId))?.resources }
        catch { /* An unread assigned plan leaves enforcement unknown, preserving usage measurements. */ }
        const usage = await readAccountUsage(deps.executor, { username: account.username, uid: account.uid, home: account.home, ...(resources ? { resources } : {}) })
        return jsonResponse(usage)
      }

      const purgeMatch = /^\/accounts\/([a-z][a-z0-9]{0,15})\/purge$/.exec(pathname)
      if ((method === 'GET' || method === 'POST') && purgeMatch) {
        await assertRootCaller(caller, 'account.purge')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        if (method === 'GET') return jsonResponse({ available: true, contract: 'target-bound-userdel' })
        const username = purgeMatch[1]!
        const body = await readObjectBody(req)
        const account = await deps.store.getAccountByUsername(username)
        const uid = body.uid
        const home = body.home
        const confirmed = body.confirmUsername === username
          && account?.status === 'terminating'
          && account.username === username
          && uid === account.uid
          && home === account.home
          && typeof uid === 'number'
          && Number.isInteger(uid)
          && uid >= 20_000
          && uid <= 60_000
          && home === `/home/${username}`
        if (!confirmed || !account) return jsonResponse({ purged: false, reason: 'target_refused' }, 409)
        const removed = await deps.executor.runCommand(['/usr/sbin/userdel', '-r', '--', username])
        const alreadyGone = /does not exist|no such user|unknown user/i.test(removed.stderr)
        if (!removed.ok && !alreadyGone) return jsonResponse({ purged: false, reason: 'userdel_failed' }, 409)
        const presence = await deps.executor.probeRemovalTarget(account.home)
        if (presence !== 'absent') return jsonResponse({ purged: false, reason: presence === 'present' ? 'home_still_present' : 'home_presence_unknown' }, 409)
        return jsonResponse({ purged: true })
      }

      if (method === 'GET' && pathname === '/host/addresses') {
        await assertRootCaller(caller, 'host.addresses')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ addresses: [] }, 404)
        const primary = await deps.executor.runCommand(['/usr/sbin/ip', '-j', 'addr'])
        const observed = primary.ok ? primary : await deps.executor.runCommand(['/usr/bin/ip', '-j', 'addr'])
        const addresses: string[] = []
        try {
          const parsed = JSON.parse(observed.stdout || '[]') as { addr_info?: { local?: string }[] }[]
          if (Array.isArray(parsed)) {
            for (const iface of parsed) {
              for (const info of iface?.addr_info ?? []) {
                if (typeof info?.local === 'string' && info.local.length > 0) addresses.push(info.local)
              }
            }
          }
        } catch { /* An unreadable address list stays empty. Account creation keeps the unverified result. */ }
        return jsonResponse({ addresses })
      }

      if (method === 'GET' && pathname === '/host/info') {
        await assertRootCaller(caller, 'host.info')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        const host = deps.executor
        const loadText = await host.readFile('/proc/loadavg')
        const memText = await host.readFile('/proc/meminfo')
        const diskResult = await host.runCommand(['/usr/bin/df', '-B1', '-P', '/'])
        if (!loadText || !memText || !diskResult.ok) return fail('PRECONDITION_FAILED', 'host measurements could not be read')
        try {
          const disk = parseDf(diskResult.stdout)
          const identity = await readHostIdentity({
            readFile: (path) => host.readFile(path),
            runCommand: (argv) => host.runCommand(argv),
            readServedCertificate: (servername?: string) => readServedCertificatePem('127.0.0.1', PANEL_LISTENER_PORT, 2000, servername),
            publicOrigin: () => readPublicOriginSync(),
          })
          identity.observedLimits = unavailableHostLimits()
          try {
            const [accounts, plans] = await Promise.all([deps.store.listAccounts(), deps.store.listPlans()])
            identity.observedLimits = await observeHostLimits(host, accounts, plans, '/home')
          } catch { /* Missing account or plan evidence must not fall back to controller presence. */ }
          let configChecks: Awaited<ReturnType<typeof readHostConfigChecks>> = {}
          try {
            configChecks = await readHostConfigChecks(host)
          } catch { /* A missing test binary leaves that tile empty. */ }
          let homeOnRoot = false
          let inodes: ReturnType<typeof parseDfInodes> | null = null
          const home = await host.runCommand(['/usr/bin/df', '-B1', '-P', '/home'])
          if (home.ok) {
            try {
              const parsedHome = parseDf(home.stdout)
              homeOnRoot = parsedHome.mount === '/' || parsedHome.filesystem === disk.filesystem
            } catch { /* A missing /home row leaves the inode meter empty. */ }
          }
          const inodeResult = await host.runCommand(['/usr/bin/df', '-P', '-i', '/home'])
          if (inodeResult.ok) {
            try {
              inodes = parseDfInodes(inodeResult.stdout)
              if (inodes.mount === '/') homeOnRoot = true
            } catch { /* Unreadable inode counts stay empty. */ }
          }
          return jsonResponse({
            load: parseLoadavg(loadText),
            memory: parseMeminfo(memText),
            disk,
            ...(inodes ? { inodes } : {}),
            ...(homeOnRoot ? { homeOnRoot: true } : {}),
            identity,
            ...(identity.certificates ? { certificates: identity.certificates } : {}),
            sampledAt: new Date().toISOString(),
            ...(configChecks.nginx || configChecks.apache ? { configChecks } : {}),
          })
        } catch (error) {
          return fail('PRECONDITION_FAILED', error instanceof Error ? error.message : 'host measurements could not be read')
        }
      }

      if (pathname === '/host/security/ssh') {
        await assertRootCaller(caller, 'security.observe')
        if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
        if ([...url.searchParams.keys()].some(key => key !== 'window') || url.searchParams.getAll('window').length > 1) return fail('VALIDATION', 'unsupported SSH observation selector', { stateChanged: false })
        const window = url.searchParams.get('window') ?? '24h'
        if (window !== '24h' && window !== '7d') return fail('VALIDATION', 'SSH observation window must be 24h or 7d', { stateChanged: false })
        const fresh = await authenticateCaller(req)
        if (fresh.principalId !== caller.principalId) return fail('FORBIDDEN', 'SSH observation authority changed', { stateChanged: false })
        await assertRootCaller(fresh, 'security.observe')
        return jsonResponse(await (await protectedSecurityObservation()).observeSsh({ window }))
      }

      if (pathname === '/host/security/ssh/keys') {
        await assertRootCaller(caller, 'security.ssh.keys.modify')
        if (method !== 'POST' && method !== 'DELETE') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } })
        if (url.search) return fail('VALIDATION', 'SSH key operations do not accept selectors', { stateChanged: false })
        if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
        const body = await readObjectBody(req)
        const fields = method === 'POST' ? ['publicKey', 'expectedRevision'] : ['fingerprint', 'expectedRevision']
        if (Object.keys(body).some(key => !fields.includes(key)) || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)
          || (method === 'POST' ? typeof body.publicKey !== 'string' || body.publicKey.length > 8192 : typeof body.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(body.fingerprint))) return fail('VALIDATION', 'a bounded SSH key identity and saved revision are required', { stateChanged: false })
        if (!deps.assertKeyMutationQualified) return fail('PRECONDITION_FAILED', 'SSH key operations require independently qualified host capability', { stateChanged: false })
        await deps.assertKeyMutationQualified()
        const qualifiedCaller = await authenticateCaller(req)
        if (qualifiedCaller.principalId !== caller.principalId) return fail('FORBIDDEN', 'SSH key authority changed', { stateChanged: false })
        await assertRootCaller(qualifiedCaller, 'security.ssh.keys.modify')
        if (process.platform !== 'linux' || !(deps.executor instanceof LinuxHostExecutor)) return fail('PRECONDITION_FAILED', 'SSH key operations require the native Linux host executor', { stateChanged: false })
        const service = await protectedSecurityObservation()
        try { await appendAudit(deps.db, { actor: qualifiedCaller.actor, action: 'security.ssh.key.change_requested', target: 'ssh:root-authorized-keys', detail: { operation: method === 'POST' ? 'add' : 'remove' }, outcome: 'ok' }) }
        catch { return fail('PRECONDITION_FAILED', 'SSH key change could not be audited before dispatch', { stateChanged: false }) }
        const fresh = await authenticateCaller(req)
        if (fresh.principalId !== caller.principalId) return fail('FORBIDDEN', 'SSH key authority changed', { stateChanged: false })
        await assertRootCaller(fresh, 'security.ssh.keys.modify')
        const authorize = async (): Promise<void> => {
          if (!deps.assertKeyMutationQualified) return fail('PRECONDITION_FAILED', 'SSH key operations require independently qualified host capability', { stateChanged: false })
          await deps.assertKeyMutationQualified()
          const principal = await getPrincipal(deps.db, caller.principalId)
          if (!principal || principal.disabled || principal.kind !== 'root' || principal.username !== caller.actor) return fail('FORBIDDEN', 'current root authorization is required for SSH key changes', { stateChanged: false })
        }
        const result = method === 'POST'
          ? await service.addRootKey({ publicKey: body.publicKey, expectedRevision: body.expectedRevision }, { authorize })
          : await service.removeManagedRootKey({ fingerprint: body.fingerprint, expectedRevision: body.expectedRevision }, { authorize })
        try { await appendAudit(deps.db, { actor: fresh.actor, action: method === 'POST' ? 'security.ssh.key.added' : 'security.ssh.key.removed', target: 'ssh:root-authorized-keys', detail: { managedKeys: result.keys.items.filter(key => key.managed).length }, outcome: 'ok' }) }
        catch { return fail('PRECONDITION_FAILED', 'SSH key change requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
        return jsonResponse({ ...result, authenticationVerified: false })
      }

      if (pathname.startsWith('/host/repair/')) {
        const repairResponse = await handleRepairCenterRoute(req, url, method, {
          assertRoot: async action => {
            const fresh = await authenticateCaller(req)
            if (fresh.principalId !== caller.principalId) return fail('FORBIDDEN', 'repair authority changed', { stateChanged: false })
            await assertRootCaller(fresh, action)
            return { actor: fresh.actor }
          },
          family: deps.os.family,
          run: deps.executor instanceof LinuxHostExecutor ? argv => (deps.executor as LinuxHostExecutor).runCommand([...argv]) : null,
          ...(deps.executor ? { runTest: test => deps.executor!.runTest(test) } : {}),
          configTests: async () => {
            const active = await latestActive(deps.db)
            const manifest = active ? await deps.reconciler.journal.readManifest(active.id) : null
            const server = new Set(['nginx', 'apache', 'nftables', 'sshd', 'postfix', 'dovecot'])
            return (manifest?.testResults ?? []).filter(t => server.has(t.name)).map(t => ({ name: t.name, argv: [...t.argv] }))
          },
          readDrift: () => deps.reconciler.checkDrift(),
          submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
          ...(deps.rhelCacheRecovery ? { cacheRecovery: deps.rhelCacheRecovery } : {}),
          ...(deps.rpmDatabaseRecovery ? { rpmRecovery: deps.rpmDatabaseRecovery } : {}),
          ...(deps.hostJobs ? { readJob: (id: string) => deps.hostJobs!.get(id) } : {}),
        })
        if (repairResponse) return repairResponse
      }
      if (pathname === '/host/accounts/health') {
        const response = await handleAccountHealthRoute(req, url, method, {
          authenticate: () => authenticateCaller(req),
          readState: () => deps.store.readSnapshot(),
          host: deps.executor instanceof LinuxHostExecutor ? nativeAccountHealthHost(deps.executor) : null,
        })
        if (response) return response
      }
      if (method === 'GET' && pathname === '/host/drift') {
        await assertRootCaller(caller, 'host.drift')
        const report = await deps.reconciler.checkDrift()
        return jsonResponse({
          hasDrift: report.hasDrift,
          count: report.items.length,
          generationId: report.generationId,
          checkedAt: new Date().toISOString(),
        })
      }

      const quarantineRoute = /^\/host\/mail\/quarantine\/(list|release|delete|expire)$/.exec(pathname)
      if (quarantineRoute) {
        if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
        if (url.search || req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'quarantine RPC requires JSON without selectors', { stateChanged: false })
        const operation = quarantineRoute[1]!, body = await readQuarantineObjectBody(req)
        const fields = operation === 'list' ? ['scope', 'options'] : operation === 'expire' ? ['scope', 'expectedRevision', 'beforeUid'] : ['scope', 'input']
        const rawScope = body.scope
        if (Object.keys(body).some(key => !fields.includes(key)) || !quarantineIdentity.object(rawScope) || Object.keys(rawScope).length !== 2
          || Object.keys(rawScope).some(key => key !== 'accountId' && key !== 'mailbox') || typeof rawScope.accountId !== 'string' || !quarantineIdentity.uuid.test(rawScope.accountId)
          || !quarantineIdentity.address(rawScope.mailbox)) return fail('VALIDATION', 'quarantine RPC requires an exact captured mailbox scope', { stateChanged: false })
        const scope: QuarantineScope = Object.freeze({ accountId: rawScope.accountId, mailbox: rawScope.mailbox })
        const action: QuarantineAction = operation === 'list' ? 'read' : operation === 'release' ? 'release' : operation === 'delete' ? 'delete' : 'expire'
        let beforeUid: number | undefined, mutation: ReturnType<typeof parseQuarantineMutation> | undefined, expectedRevision: string | undefined
        if (operation === 'list') {
          const options = body.options === undefined ? {} : body.options
          if (!quarantineIdentity.object(options) || Object.keys(options).some(key => key !== 'beforeUid') || options.beforeUid !== undefined && !quarantineIdentity.integer(options.beforeUid, 1)) return fail('VALIDATION', 'invalid quarantine page options', { stateChanged: false })
          beforeUid = options.beforeUid as number | undefined
        } else if (operation === 'expire') {
          if (!quarantineIdentity.hash(body.expectedRevision) || body.beforeUid !== undefined && !quarantineIdentity.integer(body.beforeUid, 1)) return fail('VALIDATION', 'quarantine expiry requires a saved revision and bounded cursor', { stateChanged: false })
          expectedRevision = body.expectedRevision; beforeUid = body.beforeUid as number | undefined
        } else mutation = parseQuarantineMutation(body.input)
        return await quarantineCall.run({ req, caller, scope, action, nativeIdentity: null }, async () => {
          await authorizeQuarantine(scope, action)
          if (action !== 'read') try { await appendAudit(deps.db, { actor: caller.actor, principalId: caller.principalId, action: 'mail.quarantine.agent.change_requested', target: 'mailbox:' + scope.mailbox, detail: { operation, accountId: scope.accountId }, outcome: 'ok' }) }
          catch { return fail('PRECONDITION_FAILED', 'quarantine request could not be audited before dispatch', { stateChanged: false }) }
          const result = operation === 'list' ? await quarantineService.list(scope, beforeUid === undefined ? {} : { beforeUid })
            : operation === 'expire' ? await quarantineService.expire(scope, expectedRevision!, beforeUid)
              : operation === 'release' ? await quarantineService.release(scope, mutation!) : await quarantineService.delete(scope, mutation!)
          if (action === 'read') await authorizeQuarantine(scope, 'read')
          else try { await appendAudit(deps.db, { actor: caller.actor, principalId: caller.principalId, action: 'mail.quarantine.agent.' + operation, target: 'mailbox:' + scope.mailbox,
            detail: { state: result.state, accountId: scope.accountId, ...('stateChanged' in result ? { stateChanged: result.stateChanged } : 'removed' in result ? { removed: result.removed } : {}) }, outcome: ['released', 'deleted', 'expired'].includes(result.state) ? 'ok' : 'failed' }) }
          catch { return fail('SERVICE_UNAVAILABLE', 'quarantine outcome and audit require review', { stateChanged: 'stateChanged' in result ? result.stateChanged : 'removed' in result && result.removed > 0, verificationRequired: true, unknownOutcome: true }) }
          const response = jsonResponse(result); response.headers.set('cache-control', 'no-store'); return response
        })
      }

      if (method === 'GET' && pathname === '/host/default-site/requests') {
        if (url.search || req.body !== null) return fail('VALIDATION', 'default-site observations do not accept selectors or a body', { stateChanged: false })
        const fresh = await authenticateCaller(req)
        await assertRootCaller(fresh, 'default-site.requests')
        if (fresh.principalId !== caller.principalId || fresh.actor !== caller.actor) return fail('FORBIDDEN', 'default-site observation authority changed', { stateChanged: false })
        const observation = await readDefaultSiteRequests()
        const after = await authenticateCaller(req)
        await assertRootCaller(after, 'default-site.requests')
        if (after.principalId !== fresh.principalId || after.actor !== fresh.actor) return fail('FORBIDDEN', 'default-site observation authority changed', { stateChanged: false })
        const response = jsonResponse(observation); response.headers.set('cache-control', 'no-store'); return response
      }

      const linuxHost = process.platform === 'linux' && deps.executor instanceof LinuxHostExecutor
      const freshRoot = (label: string) => async (action: string) => {
        const fresh = await authenticateCaller(req)
        if (fresh.principalId !== caller.principalId) return fail('FORBIDDEN', label + ' authority changed', { stateChanged: false })
        await assertRootCaller(fresh, action)
        return { actor: fresh.actor }
      }
      if (pathname === '/host/configuration-health' || pathname === '/host/configuration-health/repair') {
        let configurationProfile: ReturnType<typeof profileFor> | null = null
        if (linuxHost) try { configurationProfile = profileFor('ID=' + deps.os.id + '\nVERSION_ID=' + deps.os.versionId) } catch { /* An unsupported profile never supplies executable configuration tests. */ }
        const configurationHealth = await handleConfigurationHealthRoute(req, url, method, {
          assertRoot: freshRoot('configuration health'),
          readGeneration: linuxHost ? async () => { const active = await latestActive(deps.db); return active ? { id: active.id, checksum: active.checksum, manifest: await deps.reconciler.journal.readManifest(active.id) } : null } : null,
          readDesired: linuxHost ? async () => { const saved = await deps.store.readSnapshot(); const revision = saved.revision; if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return fail('PRECONDITION_FAILED', 'saved state revision is unavailable', { stateChanged: false }); return { revision, checksum: saved.checksum } } : null,
          readDrift: linuxHost ? () => deps.reconciler.checkDrift() : null,
          reviewedTests: configurationProfile ? [edge.nginxConfigTest(configurationProfile), edge.apacheConfigTest(configurationProfile), system.sshdConfigTest(configurationProfile), system.nftConfigTest(configurationProfile.paths.nftablesConf), ...services.mailConfigTests(configurationProfile)] : [],
          runTest: configurationProfile ? test => deps.executor!.runTest(test) : null,
          repair: null,
          audit: entry => appendAudit(deps.db, { ...entry, outcome: entry.outcome === 'error' ? 'failed' : entry.outcome }),
        })
        if (configurationHealth) return configurationHealth
      }
      const secHostProfile = (): ReturnType<typeof profileFor> | null => { if (!linuxHost) return null; try { return profileFor('ID=' + deps.os.id + '\nVERSION_ID=' + deps.os.versionId) } catch { return null } }
      const trustedProxiesProfile = linuxHost && !deps.trustedProxiesProvider && url.pathname.startsWith('/host/trusted-proxies') ? secHostProfile() : null
      const trustedProxiesResponse = await handleTrustedProxiesRoute(req, url, method, { store: deps.store, assertRoot: freshRoot('trusted proxies'),
        // x-xpanel-management-client is set only by the API's authenticated agent transport, from its socket or trusted-ingress address.
        provider: linuxHost ? deps.trustedProxiesProvider ?? (trustedProxiesProfile ? secIngressProviderFor({ executor: deps.executor!, os: trustedProxiesProfile, store: deps.store, managementClient: req.headers.get('x-xpanel-management-client') }) : null) : null })
      if (trustedProxiesResponse) return trustedProxiesResponse
      const backupDestinationResponse = await handleBackupDestinationRoute(req, url, method, {
        authorize: async () => { await freshRoot('backup destinations')('host.backups.destinations') },
        readDestination: deps.readBackupDestination ?? (async () => null),
        ...(deps.backupDestinationProvider ? { provider: deps.backupDestinationProvider } : {}),
      })
      if (backupDestinationResponse) return backupDestinationResponse
      const backupRunsResponse = await handleBackupRunsRoute(req, url, method, { authorize: freshRoot('backup runs'), controller: deps.backupRuns ?? null })
      if (backupRunsResponse) return backupRunsResponse
      if (pathname.startsWith('/host/monitoring/')) {
        const benchmark = await handleBenchmarkRoute(req, url, method, { assertRoot: freshRoot('benchmark'), store: benchmarkStore,
          submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
          listJobs: deps.hostJobs ? async () => [...await deps.hostJobs!.list({ kindPrefix: 'system.monitoring.benchmark', status: 'queued', limit: 100 }), ...await deps.hostJobs!.list({ kindPrefix: 'system.monitoring.benchmark', status: 'running', limit: 100 })] : null })
        if (benchmark) return benchmark
        const traffic = await handleTrafficMonitorRoute(req, url, method, { assertRoot: freshRoot('traffic'),
          readProc: linuxHost ? () => deps.executor!.readFile('/proc/net/dev') : null,
          readTail: linuxHost ? readProtectedLogTail : null, readState: () => deps.store.readSnapshot() })
        if (traffic) return traffic
        const executor = deps.executor instanceof LinuxHostExecutor ? deps.executor : undefined
        const response = await handleHostMonitoringRoute(req, url, method, {
          caller, reauthenticate: () => authenticateCaller(req), assertRoot: assertRootCaller,
          ...(executor ? { run: (argv: string[]) => executor.runCommand(argv), readFile: (path: string) => executor.readFile(path) } : {}),
          listAccounts: () => deps.store.listAccounts(),
          audit: entry => appendAudit(deps.db, entry),
        })
        if (response) return response
      }
      const hostJobsResponse = await handleHostJobsRoute(req, url, method, { runner: deps.hostJobs ?? null, assertRoot: freshRoot('host job') })
      if (hostJobsResponse) return hostJobsResponse
      const serviceManagerResponse = await handleServiceManagerRoute(req, url, method, { assertRoot: freshRoot('service manager'),
        run: linuxHost ? argv => deps.executor!.runCommand([...argv]) : null,
        readFile: path => linuxHost ? deps.executor!.readFile(path) : Promise.resolve(null),
        submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
        audit: entry => appendAudit(deps.db, { ...entry, principalId: caller.principalId }) })
      if (serviceManagerResponse) return serviceManagerResponse
      const composerResponse = await handleComposerWorkspaceRoute(req, url, method, { assertRoot: freshRoot('composer'), store: deps.store,
        files: (account, plan) => linuxHost && deps.accountFileRunner ? new JailedFileManager(resolveAccountHome(account.home, account.username), plan.resources.diskMb, { account, runner: deps.accountFileRunner }) : null,
        run: linuxHost ? argv => deps.executor!.runCommand(argv) : null,
        composerJobs: { provider: deps.composerJobProvider ?? null, family: linuxHost ? (deps.os.family === 'debian' ? 'debian' : deps.os.family === 'rhel' ? 'rhel' : null) : null,
          submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
          audit: async entry => { await appendAudit(deps.db, { ...entry, principalId: caller.principalId }) } },
      })
      if (composerResponse) return composerResponse
      const mailQueueResponse = await handleMailQueueRoute(req, url, method, {
        assertRoot: freshRoot('mail queue'),
        // postqueue -j can exceed the default 2 MiB executor buffer; the parser bounds at 16 MiB.
        run: linuxHost ? argv => new LinuxHostExecutor({ maxOutputBytes: 16 * 1024 * 1024 }).runCommand(argv) : null,
        audit: entry => appendAudit(deps.db, { ...entry, principalId: caller.principalId }),
      })
      if (mailQueueResponse) return mailQueueResponse
      const mailServerResponse = await handleMailServerObservationRoute(req, url, method, {
        assertRoot: freshRoot('mail server'),
        run: linuxHost ? argv => deps.executor!.runCommand(argv) : null,
      })
      if (mailServerResponse) return mailServerResponse
      const mailxResponse = await handleMailxRoute(req, url, method, {
        assertRoot: freshRoot('mail policy'),
        assertAccount: async (username, action) => {
          const fresh = await authenticateCaller(req)
          if (fresh.principalId !== caller.principalId) return fail('FORBIDDEN', 'mail policy authority changed', { stateChanged: false })
          const account = await deps.store.getAccountByUsername(username)
          if (!account) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
          await assertAccountCaller(fresh, account, action)
          return { actor: fresh.actor, accountId: account.id }
        },
        stateRoot: deps.store.rootDir,
        run: linuxHost ? argv => deps.executor!.runCommand(argv) : null,
        files: linuxHost ? { read: path => deps.executor!.readFile(path), write: file => deps.executor!.writeFile(file), remove: path => deps.executor!.removePath(path),
          ensureMapDir: () => deps.executor!.runAction({ kind: 'ensure-dir', path: '/etc/postfix/xpanel/mailx', mode: 0o750, owner: 'root', group: 'postfix' }) } : null,
        readSnapshot: () => deps.store.readSnapshot(),
        submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
        // mailfx: the milter, mailbox Sieve scripts and mailing lists apply through a reconciler generation.
        reconcile: linuxHost ? actor => deps.reconciler.reconcile({ actor, scope: { accountId: caller.accountId, resellerId: caller.resellerId } }) : undefined,
        audit: entry => appendAudit(deps.db, { ...entry, principalId: caller.principalId }),
      })
      if (mailxResponse) return mailxResponse
      const mailboxMaintenance = await handleMailboxMaintenanceRoute(req, url, method, {
        assertRoot: freshRoot('mailbox maintenance'),
        run: linuxHost ? argv => deps.executor!.runCommand(argv) : null,
        readSnapshot: () => deps.store.readSnapshot(),
        submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
        audit: entry => appendAudit(deps.db, { ...entry, principalId: caller.principalId }),
      })
      if (mailboxMaintenance) return mailboxMaintenance
      const serverObservation = await handleServerObservationRoute(req, url, method, {
        assertRoot: freshRoot('server observation'),
        run: linuxHost ? argv => deps.executor!.runCommand(argv) : null,
        readFile: linuxHost ? path => deps.executor!.readFile(path) : null,
        // Names only from one fixed directory; contents are never opened.
        readCronDirectory: linuxHost ? () => readdir(SERVER_CRON_DIRECTORY, { withFileTypes: true }) : null,
      })
      if (serverObservation) return serverObservation
      const serverHealth = await handleServerHealthRoute(req, url, method, {
        assertRoot: freshRoot('server health'),
        executor: linuxHost ? deps.executor! : null,
        family: linuxHost ? (deps.os.family === 'debian' ? 'debian' : deps.os.family === 'rhel' ? 'rhel' : null) : null,
        readDrift: linuxHost ? () => deps.reconciler.checkDrift() : null,
        readSaved: () => deps.store.readSnapshot(),
        readResources: deps.ioResourcePipeline ? async () => deps.ioResourcePipeline!.read(await deps.store.readSnapshot()) : null,
      })
      if (serverHealth) return serverHealth
      const support = await handleSupportRoute(req, url, method, {
        assertRoot: freshRoot('support'),
        // journalctl JSON for 500 entries with 4 KiB messages can exceed the default 2 MiB executor buffer.
        host: linuxHost ? { run: argv => new LinuxHostExecutor({ maxOutputBytes: 4 * 1024 * 1024 }).runCommand(argv), readFile: path => deps.executor!.readFile(path), releaseFs: nodeUpgradeFs } : null,
        os: deps.os,
        latestGeneration: () => latestActive(deps.db),
        readDrift: linuxHost ? () => deps.reconciler.checkDrift() : null,
        listFailedJobs: deps.hostJobs ? limit => deps.hostJobs!.list({ status: 'failed', limit }) : null,
      })
      if (support) return support
      const serviceDetailResponse = await handleServiceDetailRoute(req, url, method, {
        assertRoot: freshRoot('service detail'),
        host: linuxHost ? { run: argv => deps.executor!.runCommand(argv), readFile: path => deps.executor!.readFile(path), stat: statHostPath, listDirectory: listHostDirectory } : null,
        readState: () => deps.store.readSnapshot(),
      })
      if (serviceDetailResponse) return serviceDetailResponse
      const dnsToolsResponse = await handleDnsToolsRoute(req, url, method, {
        assertRoot: freshRoot('dns tools'),
        host: linuxHost ? { run: argv => deps.executor!.runCommand(argv), readFile: path => deps.executor!.readFile(path), stat: statHostPath, listDirectory: listHostDirectory } : null,
        readState: () => deps.store.readSnapshot(),
        jobs: deps.hostJobs ?? null,
        submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
        audit: entry => appendAudit(deps.db, { ...entry, principalId: caller.principalId }),
      })
      if (dnsToolsResponse) return dnsToolsResponse
      const securityTools = await handleSecurityToolsRoute(req, url, method, {
        assertRoot: freshRoot('security tools'),
        executor: linuxHost ? deps.executor! : null,
        readSnapshot: () => deps.store.readSnapshot(),
        submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
        jobs: deps.hostJobs ?? null,
        audit: entry => appendAudit(deps.db, { ...entry, principalId: caller.principalId }),
      })
      if (securityTools) return securityTools
      const secProfile = url.pathname.startsWith('/host/sec/') ? secHostProfile() : null
      const secResponse = await handleSecRoute(req, url, method, {
        assertRoot: freshRoot('security'),
        assertCaller: async () => { const fresh = await authenticateCaller(req); if (fresh.principalId !== caller.principalId) fail('FORBIDDEN', 'security authority changed', { stateChanged: false }) },
        executor: secProfile ? deps.executor! : null,
        os: { family: deps.os.family, nginxConf: (secProfile?.paths.nginxRoot ?? '/etc/nginx') + '/nginx.conf', powerdnsUnit: secProfile?.services.powerdns ?? 'pdns' },
        rootDir: deps.store.rootDir,
        zones: async () => (await deps.store.readSnapshot()).zones.map(zone => zone.name),
        audit: entry => appendAudit(deps.db, { ...entry, principalId: caller.principalId }),
      })
      if (secResponse) return secResponse
      const systemUpdates = await handleSystemUpdatesRoute(req, url, method, {
        assertRoot: freshRoot('system update'),
        family: linuxHost ? (deps.os.family === 'debian' ? 'debian' : deps.os.family === 'rhel' ? 'rhel' : null) : null,
        run: argv => deps.executor!.runCommand(argv),
        readFile: path => deps.executor!.readFile(path),
        submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
        // Competing apt/dnf/dpkg/rpm writers and the package-database check; null keeps update jobs unavailable as unverified.
        safety: linuxHost && (deps.os.family === 'debian' || deps.os.family === 'rhel')
          ? (() => { const family = deps.os.family === 'debian' ? 'debian' as const : 'rhel' as const; return () => observePackageSafety(family, nativePackageSafetyPorts(argv => deps.executor!.runCommand(argv))) })()
          : null,
      })
      if (systemUpdates) return systemUpdates
      const fileSharing = await handleFileSharingRoute(req, url, method, {
        assertRoot: freshRoot('file sharing'),
        store: deps.store,
        // Native NFS exportfs/etab provider is not qualified on any host yet; observation and apply stay truthfully unavailable.
        provider: null,
      })
      if (fileSharing) return fileSharing
      const softwareCenter = await handleSoftwareCenterRoute(req, url, method, {
        assertRoot: freshRoot('software center'),
        family: linuxHost ? (deps.os.family === 'debian' ? 'debian' : deps.os.family === 'rhel' ? 'rhel' : null) : null,
        // A dnf metadata refresh can exceed the default 30 s command timeout.
        run: linuxHost ? argv => new LinuxHostExecutor({ timeoutMs: 180_000 }).runCommand([...argv]) : null,
        submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
      })
      if (softwareCenter) return softwareCenter
      const swJobs = deps.hostJobs ? async (plan: HostJobPlan, actor: string) => (await deps.hostJobs!.submit(plan, actor)).job : null
      const swContainers = await handleSwContainersRoute(req, url, method, { assertRoot: freshRoot('containers'), run: linuxHost ? argv => deps.executor!.runCommand([...argv]) : null,
        binaryPresent: linuxHost ? path => stat(path).then(info => info.isFile(), () => false) : null, submitJob: swJobs, audit: async entry => { await appendAudit(deps.db, { ...entry, principalId: caller.principalId }) } })
      if (swContainers) return swContainers
      const swAddons = await handleSwAddonServicesRoute(req, url, method, { assertRoot: freshRoot('add-on services'), run: linuxHost ? argv => deps.executor!.runCommand([...argv]) : null,
        submitJob: swJobs, audit: async entry => { await appendAudit(deps.db, { ...entry, principalId: caller.principalId }) } })
      if (swAddons) return swAddons
      const swDeployments = await handleSwDeploymentsRoute(req, url, method, { assertRoot: freshRoot('deployments'), store: deps.store, run: deps.accountGitRun ?? null,
        files: linuxHost && deps.accountFileRunner ? (account, plan) => new JailedFileManager(resolveAccountHome(account.home, account.username), plan.resources.diskMb, { account, runner: deps.accountFileRunner! }) : null,
        audit: async entry => { await appendAudit(deps.db, { ...entry, principalId: caller.principalId }) } })
      if (swDeployments) return swDeployments
      if (method === 'GET' && pathname === '/host/php/inventory') {
        await assertRootCaller(caller, 'host.php.inventory')
        if (url.search) return fail('VALIDATION', 'PHP inventory does not accept request selectors')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        const executor = deps.executor
        const release = await executor.readFile('/etc/os-release')
        if (!release) return fail('PRECONDITION_FAILED', 'the host operating system could not be read')
        const profile = profileFor(release)
        const source = profile.family === 'debian' ? 'dpkg' : 'rpm'
        const inventory = await readPhpRuntimeInventory(argv => executor.runCommand(argv), source)
        const response = jsonResponse(inventory)
        response.headers.set('cache-control', 'no-store')
        return response
      }

      if (pathname === '/host/mail/log' || pathname === '/host/mail/log/mailbox') {
        // journalctl JSON for 20000 records exceeds the default 2 MiB executor buffer.
        const mailLogExecutor = deps.executor instanceof LinuxHostExecutor ? new LinuxHostExecutor({ maxOutputBytes: MAIL_LOG_MAX_OUTPUT_BYTES }) : null
        const response = await handleMailLogRoute(req, url, method, {
          authenticateCaller, assertRootCaller,
          assertMailboxCaller: (current, address) => assertMailLogMailboxCaller({ principal: id => getPrincipal(deps.db, id), store: deps.store }, current, address),
          run: mailLogExecutor ? argv => mailLogExecutor.runCommand(argv) : null,
        })
        if (response) return response
      }
      if (pathname === '/host/ftp/log') {
        // journalctl JSON for 20000 records exceeds the default 2 MiB executor buffer.
        const ftpLogExecutor = deps.executor instanceof LinuxHostExecutor ? new LinuxHostExecutor({ maxOutputBytes: FTP_LOG_MAX_OUTPUT_BYTES }) : null
        const response = await handleFtpLogRoute(req, url, method, {
          authenticateCaller, assertRootCaller, readState: () => deps.store.readSnapshot(),
          run: ftpLogExecutor ? argv => ftpLogExecutor.runCommand(argv) : null,
        })
        if (response) return response
      }
      const upgradeResponse = await handleUpgradeRoute(req, url, method, {
        db: deps.db, caller, authenticate: () => authenticateCaller(req), assertRootCaller,
        coordinator: deps.upgradeCoordinator ?? new DurableUpgradeCoordinator({ db: deps.db }),
      })
      if (upgradeResponse) return upgradeResponse

      if (method === 'GET' && pathname === '/host/services') {
        await assertRootCaller(caller, 'host.services')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        const services = await readHostServices(argv => deps.executor!.runCommand(argv))
        return jsonResponse({ services })
      }

      const serviceRestart = /^\/host\/services\/([a-z0-9-]+)\/restart$/.exec(pathname)
      if (method === 'POST' && serviceRestart) {
        await assertRootCaller(caller, 'host.services.restart')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        const service = await restartHostService(argv => deps.executor!.runCommand(argv), serviceRestart[1]!)
        return jsonResponse({ service })
      }

      const mariadbAdminResponse = await handleMariadbAdminRoute(req, url, method, {
        caller, reauthenticate: () => authenticateCaller(req), assertRoot: assertRootCaller,
        audit: entry => appendAudit(deps.db, entry),
        ...(deps.mariadbAdmin ? { mariadb: deps.mariadbAdmin } : {}),
        ...(deps.executor instanceof LinuxHostExecutor ? { readServices: () => readHostServices(argv => deps.executor!.runCommand(argv)) } : {}),
      })
      if (mariadbAdminResponse) return mariadbAdminResponse

      const databaseTuningResponse = await handleDatabaseTuningRoute(req, url, method, {
        caller, reauthenticate: () => authenticateCaller(req), assertRoot: assertRootCaller,
        ...(deps.mariadbAdmin ? { mariadb: deps.mariadbAdmin } : {}),
      })
      if (databaseTuningResponse) return databaseTuningResponse
      const dbFamily = linuxHost ? (deps.os.family === 'debian' ? 'debian' as const : deps.os.family === 'rhel' ? 'rhel' as const : null) : null
      const dbRun = linuxHost ? (argv: readonly string[]) => new LinuxHostExecutor({ timeoutMs: 180_000 }).runCommand([...argv]) : null
      const dbAccount = { caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId) }
      const dbEnginesResponse = await handleDbEnginesRoute(req, url, method, { ...dbAccount, assertRoot: freshRoot('database engines'), family: dbFamily, run: dbRun, readFile: linuxHost ? nodeDbSignonFs.readFile : null,
        runPostgresql: linuxHost ? statements => deps.executor!.runAction({ kind: 'sql', engine: 'postgresql', statements }) : null })
      if (dbEnginesResponse) return dbEnginesResponse
      const dbSignonResponse = await handleDbSignonRoute(req, url, method, { ...dbAccount, assertRoot: freshRoot('database web clients'), family: dbFamily, run: dbRun, fs: linuxHost ? nodeDbSignonFs : null, sql: deps.mariadbAdmin ?? null, audit: entry => appendAudit(deps.db, entry) })
      if (dbSignonResponse) return dbSignonResponse
      const dbUpgradeResponse = await handleDbUpgradeRoute(req, url, method, {
        assertRoot: freshRoot('database upgrade'), family: dbFamily, run: dbRun,
        sql: deps.mariadbAdmin ? { version: async () => parseMariadbVersion(await deps.mariadbAdmin!.query([MARIADB_ADMIN_VERSION_SQL])) } : null,
        adminDefaultsFile: deps.mariadbAdmin && 'adminDefaultsFile' in deps.mariadbAdmin ? String(deps.mariadbAdmin.adminDefaultsFile) : null,
        submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
      })
      if (dbUpgradeResponse) return dbUpgradeResponse

      const accountCronWorkspace = /^\/accounts\/([a-z][a-z0-9]{0,15})\/cron\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(status|run)$/.exec(pathname)
      if (accountCronWorkspace) {
        if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
        if (url.search) return fail('VALIDATION', 'Cron host requests do not accept query selectors', { stateChanged: false })
        if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'Cron operations require the signed-in account owner', { stateChanged: false })
        const body = await readObjectBody(req)
        if (Object.keys(body).some(key => !['accountId', 'jobId', 'expectedRevision'].includes(key)) || body.accountId !== caller.accountId || body.jobId !== accountCronWorkspace[2] || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return fail('VALIDATION', 'Cron host intent must match the account, saved job and revision', { stateChanged: false })
        const executor = deps.executor
        if (!executor || typeof deps.cronQualification !== 'function') return fail('PRECONDITION_FAILED', 'Trusted cron host qualification is unavailable', { stateChanged: false })
        const action = accountCronWorkspace[3] === 'run' ? 'run' : 'observe'
        const profile = profileFor('ID=' + deps.os.id + '\nVERSION_ID=' + deps.os.versionId)
        const adapter = new AccountProcessServiceAdapter({ executor, os: profile })
        const receipt = await deps.store.withCronAccountLease(caller.accountId, async (account, jobs) => {
          // Direct local principal/state reads only: no snapshot barrier or API self-RPC.
          const principal = await getPrincipal(deps.db, caller.principalId)
          if (!principal || principal.disabled || principal.kind !== 'user' || principal.accountId !== account.id || principal.username !== account.username || account.username !== accountCronWorkspace[1]) return fail('FORBIDDEN', 'The current cron account owner is no longer authorized', { stateChanged: false })
          const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
          if (!features || features.disabled.includes('cron') || features.disabled.includes('cron-jobs')) return fail('FORBIDDEN', 'Cron is disabled by the current account plan', { stateChanged: false })
          if (jobs.some(job => job.accountId !== account.id) || new Set(jobs.map(job => cronJobUnitId(job.id))).size !== jobs.length) return fail('PRECONDITION_FAILED', 'Saved cron unit identity requires review', { stateChanged: false })
          const revision = cronWorkspaceRevision(account.id, jobs)
          if (revision !== body.expectedRevision) return fail('CONFLICT', 'Cron configuration changed before host execution', { stateChanged: false })
          const job = jobs.find(job => job.id === body.jobId)
          if (!job) return fail('NOT_FOUND', 'Cron job not found', { stateChanged: false })
          if (action === 'run' && !job.enabled) return fail('PRECONDITION_FAILED', 'The saved cron schedule is disabled', { stateChanged: false })
          await deps.cronQualification!({ account, job, action })
          const rendered = system.renderCronUnits(account, { id: cronJobUnitId(job.id), schedule: job.schedule, command: job.command, ...(job.maxRuntimeSec === undefined ? {} : { maxRuntimeSec: job.maxRuntimeSec }) }, profile)
          for (const file of [rendered.commandFile, rendered.service, rendered.timer]) {
            if (await executor.readFile(file.path) !== file.content) return fail('PRECONDITION_FAILED', 'Cron host source differs from saved configuration; reconcile and review before execution', { stateChanged: false, sourceConflict: true })
          }
          const observation = action === 'run' ? await adapter.triggerCronNow(account, cronJobUnitId(job.id)) : await adapter.observeCronStatus(account, cronJobUnitId(job.id))
          return { context: { accountId: account.id, jobId: job.id }, revision, observation }
        })
        if (action === 'run') await appendAudit(deps.db, { actor: caller.actor, action: 'cron.host_run_requested', target: 'account:' + accountCronWorkspace[1], detail: { requested: true, completed: false, accountId: caller.accountId }, outcome: 'ok', principalId: caller.principalId })
        return jsonResponse(receipt, action === 'run' ? 202 : 200)
      }

      const accountBackupWorkspace = /^\/accounts\/([a-z][a-z0-9]{0,15})\/backup-workspace(?:\/|$)/.exec(pathname)
      if (accountBackupWorkspace) {
        if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'account backups require the signed-in account owner')
        const account = await deps.store.getAccount(caller.accountId)
        if (!account || account.username !== accountBackupWorkspace[1] || caller.actor !== account.username) return fail('FORBIDDEN', 'the backup account does not match the signed-in hosting owner')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        return await handleAccountBackupAgentRequest(req, {
          executor: deps.executor, account, root: process.env.XPANEL_BACKUP_DIR || DEFAULT_BACKUP_DIR,
          withAccountLease: operation => deps.store.withAccountLifecycleLease(account.id, async fresh => {
            // Resolve the principal directly; no public snapshot/self-RPC is allowed in this lease.
            const principal = await getPrincipal(deps.db, caller.principalId)
            if (!principal || principal.disabled || principal.kind !== 'user' || principal.accountId !== fresh.id || principal.username !== fresh.username || fresh.status !== 'active' || fresh.username !== accountBackupWorkspace[1]) return fail('FORBIDDEN', 'the current account owner is no longer authorized')
            return operation(fresh)
          }),
        })
      }

      const transferArchiveResponse = await handleTransferArchiveRoute(req, url, method, {
        authorize: action => assertRootCaller(caller, action), store: deps.store,
        executor: deps.executor instanceof LinuxHostExecutor ? deps.executor : null, root: process.env.XPANEL_BACKUP_DIR || DEFAULT_BACKUP_DIR,
      })
      if (transferArchiveResponse) return transferArchiveResponse
      const convertAddonFilesResponse = await handleConvertAddonFilesRoute(req, url, method, {
        authorize: action => assertRootCaller(caller, action), store: deps.store, audit: entry => appendAudit(deps.db, entry), caller: { actor: caller.actor, principalId: caller.principalId },
        files: deps.executor instanceof LinuxHostExecutor && deps.accountFileRunner ? (account, plan) => new JailedFileManager(resolveAccountHome(account.home, account.username), plan.resources.diskMb, { account, runner: deps.accountFileRunner! }) : null,
      })
      if (convertAddonFilesResponse) return convertAddonFilesResponse

      const accountBackup = /^\/accounts\/([a-z][a-z0-9]{0,15})\/backups$/.exec(pathname)
      if (accountBackup && (method === 'GET' || method === 'POST')) {
        await assertRootCaller(caller, 'account.backup')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        const username = accountBackup[1]!
        const account = await deps.store.getAccountByUsername(username)
        if (!account || account.username !== username) return fail('NOT_FOUND', 'account not found')
        const target = { username: account.username, home: account.home, uid: account.uid, status: account.status }
        const root = process.env.XPANEL_BACKUP_DIR || DEFAULT_BACKUP_DIR
        if (method === 'GET') return jsonResponse({ backups: await listAccountBackups(root, target) })
        const body = await readObjectBody(req)
        if (body.op === 'create') return jsonResponse({ backup: await createAccountBackup({ executor: deps.executor, root, account: target }) }, 201)
        if (body.op === 'restore') {
          if (typeof body.file !== 'string') return fail('VALIDATION', 'backup file is required')
          return jsonResponse({ backup: await restoreAccountBackup({ executor: deps.executor, root, account: target, file: body.file }) })
        }
        return fail('VALIDATION', 'backup operation must be create or restore')
      }

      if (method === 'POST' && (pathname === '/reconcile' || pathname === '/state/apply')) {
        if (pathname === '/reconcile') await assertRootCaller(caller, 'reconcile')
        const body = await readReconcileBody(req)
        if (caller.role !== 'root' && body.force) fail('FORBIDDEN', 'only root may force reconciliation')
        const result = await deps.reconciler.reconcile({
          force: caller.role === 'root' && body.force,
          actor: caller.actor,
          scope: { accountId: caller.accountId, resellerId: caller.resellerId },
        })
        return jsonResponse(result, result.status === 'failed' ? 422 : 200)
      }

      const resolveFailedMatch = /^\/generations\/(\d+)\/resolve-failed$/.exec(pathname)
      if (method === 'POST' && resolveFailedMatch) {
        await assertRootCaller(caller, `generation:${resolveFailedMatch[1]}:resolve-failed`)
        const genId = Number(resolveFailedMatch[1])
        const result = await deps.reconciler.resolveFailedGeneration(genId, caller.actor)
        return jsonResponse(result)
      }

      if (method === 'GET' && pathname === '/generations/rollback-admission') {
        if (url.search) return fail('VALIDATION', 'generation rollback admission does not accept selectors', { stateChanged: false })
        const fresh = await authenticateCaller(req)
        await assertRootCaller(fresh, 'generation.rollback-admission')
        if (fresh.principalId !== caller.principalId || fresh.actor !== caller.actor) return fail('FORBIDDEN', 'generation rollback authority changed', { stateChanged: false })
        const admission = await readGenerationRollbackAdmission({ store: deps.store, db: deps.db, executor: deps.executor, journal: deps.reconciler.journal })
        const after = await authenticateCaller(req)
        await assertRootCaller(after, 'generation.rollback-admission')
        if (after.principalId !== fresh.principalId || after.actor !== fresh.actor) return fail('FORBIDDEN', 'generation rollback authority changed', { stateChanged: false })
        const response = jsonResponse(admission); response.headers.set('cache-control', 'no-store'); return response
      }

      const rollbackMatch = /^\/generations\/(\d+)\/rollback$/.exec(pathname)
      if (method === 'POST' && rollbackMatch) {
        await assertRootCaller(caller, `generation:${rollbackMatch[1]}:rollback`)
        const genId = Number(rollbackMatch[1])
        if (url.search || !Number.isSafeInteger(genId) || genId < 1 || String(genId) !== rollbackMatch[1]) return fail('VALIDATION', 'a canonical generation target without selectors is required', { stateChanged: false })
        const request = parseGenerationRollbackRequest(genId, await readObjectBody(req))
        const admission = await readGenerationRollbackAdmission({ store: deps.store, db: deps.db, executor: deps.executor, journal: deps.reconciler.journal })
        if (!admission.canRollback) return fail('PRECONDITION_FAILED', 'generation rollback requires current protected host admission', { stateChanged: false })
        if (admission.activeGeneration?.id !== request.expectedCurrentGenerationId || admission.sourceRevision !== request.expectedCurrentStateRevision
          || !admission.eligibleTargets.some(target => target.generationId === genId && target.checksum === request.expectedTargetChecksum)) return fail('CONFLICT', 'the reviewed generation rollback authority changed', { stateChanged: false })
        const result = await deps.reconciler.rollbackToGeneration(genId, caller.actor, { request, authorize: async () => {
          const fresh = await getPrincipal(deps.db, caller.principalId)
          if (!fresh || fresh.disabled || fresh.kind !== 'root' || fresh.username !== caller.actor) return fail('FORBIDDEN', 'current root authorization is required', { stateChanged: false })
        } })
        return jsonResponse(result, result.status === 'failed' ? 422 : 200)
      }

      if (method === 'POST' && pathname === '/metrics/collect') {
        await assertRootCaller(caller, 'metrics.collect')
        const count = await deps.reconciler.collectMetrics()
        return jsonResponse({ ok: true, accountsSampled: count })
      }

      if (method === 'GET' && pathname === '/analytics/io') {
        await assertRootCaller(caller, 'analytics.io')
        if ([...url.searchParams.keys()].length > 0) return fail('VALIDATION', 'resource reads do not accept caller-selected accounts, UIDs or paths')
        const snapshot = await deps.store.readSnapshot()
        const result = deps.ioResourcePipeline ? await deps.ioResourcePipeline.read(snapshot) : unavailableIoAnalytics('not-sampled')
        return jsonResponse(result.available ? result.snapshot : result, result.available ? 200 : 503)
      }

      if (method === 'POST' && pathname === '/analytics/websites/ingest') {
        await assertRootCaller(caller, 'analytics.websites.ingest')
        const body = (await req.json()) as { lines?: string[] | string }
        const ingested = webEngine.ingestJsonLogLines(body.lines ?? [])
        return jsonResponse({ ok: true, ingested })
      }

      const webAnalyticsMatch = /^\/analytics\/websites\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'GET' && webAnalyticsMatch) {
        const domainId = webAnalyticsMatch[1]!.toLowerCase()
        const domain =
          (await deps.store.getDomain(domainId)) ?? fail('NOT_FOUND', `domain "${domainId}" not found`)
        const account =
          (await deps.store.getAccount(domain.accountId)) ??
          fail('NOT_FOUND', `account "${domain.accountId}" not found`)
        await assertAccountCaller(caller, account, 'analytics.websites')
        const windowParam = url.searchParams.get('window')
        const window =
          windowParam === '1h' || windowParam === '24h' || windowParam === '7d' || windowParam === '30d'
            ? windowParam
            : '24h'
        const snap = webEngine.queryDomainSnapshot(domain, {
          window,
          resellerId: account.ownerId ?? null,
          onEvent: (ev) => deps.reconciler.emit(ev),
        })
        return jsonResponse(snap)
      }

      const shellMatch = /^\/accounts\/([a-z][a-z0-9]{0,15})\/shell$/.exec(pathname)
      if (method === 'POST' && shellMatch) {
        const username = shellMatch[1]!
        const account =
          (await deps.store.getAccountByUsername(username)) ??
          fail('NOT_FOUND', `account "${username}" not found`, { username })
        await assertAccountCaller(caller, account, 'shell.exec')
        const plan =
          (await deps.store.getPlan(account.planId)) ?? fail('NOT_FOUND', `plan "${account.planId}" not found`)
        const executor = deps.executor ?? fail('PRECONDITION_FAILED', 'agent executor not configured')
        const body = await readObjectBody(req)
        if (Object.keys(body).some(key => key !== 'command' && key !== 'sessionId') || typeof body.command !== 'string' ||
          (body.sessionId !== undefined && typeof body.sessionId !== 'string')) {
          fail('VALIDATION', 'shell request requires a command and an optional string sessionId')
        }
        const command = body.command as string
        const sessionId = body.sessionId as string | undefined
        try {
          const result = await runJailedShellCommand(account, plan, command, executor, {
            ...(sessionId && { sessionId }),
            onEvent: (ev) => deps.reconciler.emit(ev),
          })
          await appendAudit(deps.db, {
            actor: caller.actor,
            action: 'shell.exec',
            target: `account:${account.username}`,
            detail: { command, code: result.code, sessionId: result.sessionId },
            outcome: result.code === 0 ? 'ok' : 'failed',
          })
          return jsonResponse(result)
        } catch (err) {
          await appendAudit(deps.db, {
            actor: caller.actor,
            action: 'shell.exec',
            target: `account:${account.username}`,
            detail: { command, error: isXpanelError(err) ? err.message : 'Shell execution error' },
            outcome: isXpanelError(err) && err.code === 'FORBIDDEN' ? 'denied' : 'failed',
          })
          throw err
        }
      }

      const htaccessMatch = /^\/accounts\/([a-z][a-z0-9]{0,15})\/htaccess\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'POST' && htaccessMatch) {
        const username = htaccessMatch[1]!, domainId = htaccessMatch[2]!
        if (!isUuid(domainId)) return fail('VALIDATION', 'a domain selector is required', { stateChanged: false })
        const body = parseHtaccessRequest(await readObjectBody(req))
        const account = await deps.store.getAccountByUsername(username)
        if (!account) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
        return await deps.store.withAccountLifecycleLease(account.id, async fresh => {
          const resolveTarget = async () => {
            try {
              const principal = await getPrincipal(deps.db, caller.principalId)
              if (!principal || principal.disabled || fresh.username !== username || principal.kind === 'user' && (principal.accountId !== fresh.id || principal.username !== fresh.username)) return fail('FORBIDDEN', 'the current account caller is unavailable', { stateChanged: false })
              await assertAccountCaller({ principalId: principal.id, actor: principal.username, role: principal.kind,
                accountId: principal.accountId, resellerId: principal.kind === 'reseller' ? principal.id : null }, fresh, 'htaccess')
              const plan = await deps.store.getPlan(fresh.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
              if (!plan || !features || features.disabled.includes('aapanel-url-rewrite')) return fail('FORBIDDEN', 'the .htaccess tool is unavailable in the current plan', { stateChanged: false })
              const domain = await deps.store.getDomain(domainId)
              if (!domain || domain.accountId !== fresh.id) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
              const serving = domain.kind === 'alias' && domain.parentId ? await deps.store.getDomain(domain.parentId) : undefined
              return deriveHtaccessTarget(fresh, domain, await deps.store.getServerSettings(), serving)
            } catch (error) { if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false }); throw error }
          }
          await resolveTarget()
          const plan = await deps.store.getPlan(fresh.planId), validator = await protectedHtaccessValidator()
          const workspace = new HtaccessWorkspace({ historyDir: '/var/lib/xpanel-agent/htaccess-history', actor: caller.actor,
            resolve: async (requestedUsername, requestedDomainId) => {
              if (requestedUsername !== username || requestedDomainId !== domainId) return fail('FORBIDDEN', 'the .htaccess request target changed', { stateChanged: false })
              return resolveTarget()
            },
            files: () => new JailedFileManager(resolveAccountHome(fresh.home, fresh.username), plan?.resources.diskMb ?? 'unlimited', { account: fresh,
              ...(deps.accountFileRunner ? { runner: deps.accountFileRunner } : {}) }),
            ...(validator ? { validator } : {}), probe: probeHtaccessTarget })
          const result = await workspace.handle(username, domainId, body)
          if (['save', 'restore', 'migrate-php'].includes(body.op)) {
            try { await appendAudit(deps.db, { actor: caller.actor, action: 'domain.htaccess.' + body.op, target: 'domain:' + result.context.domainName,
              detail: { status: result.application.status, syntaxChecked: result.application.syntaxChecked, httpStatus: result.application.httpStatus, nativeQualified: false }, outcome: result.application.status === 'rolled_back' || result.validation?.valid === false ? 'failed' : 'ok' }) }
            catch { return fail('SERVICE_UNAVAILABLE', '.htaccess outcome and audit require inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
          }
          return jsonResponse(result)
        })
      }

      const accountSshResponse = await handleAccountSshRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId), audit: entry => appendAudit(deps.db, entry),
        files: (account, plan) => new JailedFileManager(resolveAccountHome(account.home, account.username), plan.resources.diskMb, { account, ...(deps.accountFileRunner ? { runner: deps.accountFileRunner } : {}) }),
      })
      if (accountSshResponse) return accountSshResponse
      const accountGitResponse = await handleAccountGitRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId), audit: entry => appendAudit(deps.db, entry),
        files: (account, plan) => new JailedFileManager(resolveAccountHome(account.home, account.username), plan.resources.diskMb, { account, ...(deps.accountFileRunner ? { runner: deps.accountFileRunner } : {}) }),
        run: deps.accountGitRun ?? null,
      })
      if (accountGitResponse) return accountGitResponse
      const swOptimize = await handleSwOptimizeRoute(req, url, method, { caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId),
        readEdgeMain: process.platform === 'linux' && deps.executor instanceof LinuxHostExecutor ? () => deps.executor!.readFile(profileFor('ID=' + deps.os.id + '\nVERSION_ID=' + deps.os.versionId).paths.nginxRoot + '/nginx.conf') : null })
      if (swOptimize) return swOptimize
      const swApplications = await handleSwApplicationsRoute(req, url, method, { caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId),
        catalog: deps.applicationCatalog ?? null, provider: deps.applicationProvider ?? null,
        submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null, audit: entry => appendAudit(deps.db, entry) })
      if (swApplications) return swApplications
      const accountPackagesResponse = await handleAccountPackagesRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId), audit: entry => appendAudit(deps.db, entry),
        files: (account, plan) => new JailedFileManager(resolveAccountHome(account.home, account.username), plan.resources.diskMb, { account, ...(deps.accountFileRunner ? { runner: deps.accountFileRunner } : {}) }),
        catalog: deps.accountPackageCatalog ?? null,
        ...(deps.admitAccountPackageMutation ? { admitMutation: deps.admitAccountPackageMutation } : {}),
      })
      if (accountPackagesResponse) return accountPackagesResponse
      const remoteDatabaseResponse = await handleDatabaseRemoteAccessRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId),
        ...(deps.databaseRemoteAccessNative ? { native: deps.databaseRemoteAccessNative } : {}),
        audit: async (account, action, host) => { await appendAudit(deps.db, { actor: caller.actor, principalId: caller.principalId, action: 'database.remote_access.' + action, target: 'account:' + account.username, detail: { host }, outcome: 'ok' }) },
      })
      if (remoteDatabaseResponse) return remoteDatabaseResponse
      const accountPgpResponse = await handleAccountPgpRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId), audit: entry => appendAudit(deps.db, entry),
        files: (account, plan) => new JailedFileManager(resolveAccountHome(account.home, account.username), plan.resources.diskMb, { account, ...(deps.accountFileRunner ? { runner: deps.accountFileRunner } : {}) }),
        runner: deps.pgpRunner ?? null,
      })
      if (accountPgpResponse) return accountPgpResponse
      const sitePublisherResponse = await handleSitePublisherAgentRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId), audit: entry => appendAudit(deps.db, entry),
        files: (account, plan) => deps.accountFileRunner ? new JailedFileManager(resolveAccountHome(account.home, account.username), plan.resources.diskMb, { account, runner: deps.accountFileRunner }) : null,
      })
      if (sitePublisherResponse) return sitePublisherResponse
      const accountLogsResponse = await handleAccountLogsRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId),
        readTail: process.platform === 'linux' && deps.executor instanceof LinuxHostExecutor ? readProtectedLogTail : null,
      })
      if (accountLogsResponse) return accountLogsResponse
      const accountVirusScanResponse = await handleAccountVirusScanRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId), audit: entry => appendAudit(deps.db, entry),
        run: process.platform === 'linux' && deps.executor instanceof LinuxHostExecutor ? argv => deps.executor!.runCommand(argv) : null,
        jobs: deps.hostJobs ?? null, submitJob: deps.hostJobs ? async (plan, actor) => (await deps.hostJobs!.submit(plan, actor)).job : null,
      })
      if (accountVirusScanResponse) return accountVirusScanResponse
      const networkToolsResponse = await handleNetworkToolsRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId),
        host: process.platform === 'linux' && deps.executor instanceof LinuxHostExecutor ? systemNetworkToolsHost(argv => deps.executor!.runCommand(argv)) : null,
      })
      if (networkToolsResponse) return networkToolsResponse
      const backupFilesResponse = await handleBackupFileRestoreRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId), audit: entry => appendAudit(deps.db, entry),
        root: deps.executor instanceof LinuxHostExecutor ? process.env.XPANEL_BACKUP_DIR || DEFAULT_BACKUP_DIR : null,
        files: (account, plan) => deps.accountFileRunner ? new JailedFileManager(resolveAccountHome(account.home, account.username), plan.resources.diskMb, { account, runner: deps.accountFileRunner }) : null,
      })
      if (backupFilesResponse) return backupFilesResponse
      const backupComponentsResponse = await handleComponentRestoreRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId), audit: entry => appendAudit(deps.db, entry),
        root: deps.executor instanceof LinuxHostExecutor ? process.env.XPANEL_BACKUP_DIR || DEFAULT_BACKUP_DIR : null,
        files: (account, plan) => deps.accountFileRunner ? new JailedFileManager(resolveAccountHome(account.home, account.username), plan.resources.diskMb, { account, runner: deps.accountFileRunner }) : null,
      })
      if (backupComponentsResponse) return backupComponentsResponse
      const stagingResponse = await handleStagingRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId), audit: entry => appendAudit(deps.db, entry),
        files: (account, plan) => deps.executor instanceof LinuxHostExecutor && deps.accountFileRunner ? new JailedFileManager(resolveAccountHome(account.home, account.username), plan.resources.diskMb, { account, runner: deps.accountFileRunner }) : null,
      })
      if (stagingResponse) return stagingResponse
      const accountDatabaseInsightsResponse = await handleAccountDatabaseInsightsRoute(req, url, method, {
        caller, store: deps.store, currentPrincipal: () => getPrincipal(deps.db, caller.principalId),
        ...(deps.mariadbAdmin ? { mariadb: deps.mariadbAdmin } : {}),
      })
      if (accountDatabaseInsightsResponse) return accountDatabaseInsightsResponse

      const filesMatch = /^\/accounts\/([a-z][a-z0-9]{0,15})\/files$/.exec(pathname)
      if (method === 'POST' && filesMatch) {
        const username = filesMatch[1]!
        const account =
          (await deps.store.getAccountByUsername(username)) ??
          fail('NOT_FOUND', `account "${username}" not found`, { username })
        await assertAccountCaller(caller, account, 'files')
        const plan = await deps.store.getPlan(account.planId)
        const homeRoot = resolveAccountHome(account.home, account.username)
        const fm = new JailedFileManager(homeRoot, plan?.resources.diskMb ?? 'unlimited', {
          account,
          ...(deps.accountFileRunner && { runner: deps.accountFileRunner }),
        })
        const body = await readFileBody(req)

        const auditAction = FILE_AUDIT_ACTIONS[body.op]
        const target = `account:${account.username}:${body.path ?? body.trashId ?? ''}`

        try {
          let result: unknown
          switch (body.op) {
            case 'list':
              return jsonResponse({ entries: await fm.list(body.path ?? '', { showHidden: body.showHidden ?? true }) })
            case 'read':
              return jsonResponse(await fm.readText(body.path ?? ''))
            case 'write':
              result = await fm.writeText(body.path ?? '', body.content ?? '', {
                overwrite: body.overwrite ?? true,
                ...(body.mode !== undefined && { mode: body.mode }),
              })
              break
            case 'put-bytes':
              result = await fm.putBytes(body.path ?? '', body.contentBase64 ?? '', {
                overwrite: body.overwrite ?? true,
                ...(body.mode !== undefined && { mode: body.mode }),
              })
              break
            case 'get-bytes':
              return jsonResponse(await fm.getBytes(body.path ?? ''))
            case 'mkdir':
              result = await fm.mkdir(body.path ?? '', body.mode ?? 0o750)
              break
            case 'chmod':
              result = await fm.chmod(body.path ?? '', body.mode ?? 0o640)
              break
            case 'trash':
              result = await fm.moveToTrash(body.path ?? '')
              break
            case 'list-trash':
              return jsonResponse({ items: await fm.listTrash() })
            case 'restore':
              result = await fm.restoreFromTrash(body.trashId ?? '', { overwrite: body.overwrite ?? false })
              break
            case 'empty-trash':
              result = {
                removed: await fm.emptyTrash(
                  body.olderThanDays !== undefined ? { olderThanDays: body.olderThanDays } : {},
                ),
              }
              break
            case 'purge-trash':
              result = await fm.purgeTrash(body.trashId ?? '', { originalPath: body.originalPath ?? '', deletedAt: body.deletedAt ?? '' })
              break
            default:
              return fail('VALIDATION', `unsupported file operation "${String(body.op)}"`)
          }

          if (auditAction) {
            await appendAudit(deps.db, {
              actor: caller.actor,
              action: auditAction,
              target,
              detail: {
                op: body.op,
                path: body.path ?? body.originalPath ?? null,
                ...(body.mode !== undefined && { mode: body.mode }),
                ...(body.trashId !== undefined && { trashId: body.trashId }),
              },
              outcome: 'ok',
            })
          }
          return jsonResponse(result)
        } catch (err) {
          if (auditAction) {
            await appendAudit(deps.db, {
              actor: caller.actor,
              action: auditAction,
              target,
              detail: {
                op: body.op,
                path: body.path ?? body.originalPath ?? null,
                error: isXpanelError(err) ? err.message : 'File operation failed',
              },
              outcome: isXpanelError(err) && err.code === 'FORBIDDEN' ? 'denied' : 'failed',
            })
          }
          throw err
        }
      }

      const certificateMatch = /^\/accounts\/([a-z][a-z0-9]{0,15})\/certificates$/.exec(pathname)
      if (method === 'GET' && pathname === '/host/management-tls-observation') {
        if (url.search) return fail('VALIDATION', 'management TLS observations do not accept selectors', { stateChanged: false })
        const fresh = await authenticateCaller(req)
        await assertRootCaller(fresh, 'management-tls.read')
        if (fresh.principalId !== caller.principalId) return fail('FORBIDDEN', 'certificate observation authorization changed', { stateChanged: false })
        const observation = await readManagementTlsObservation({ ...(deps.executor ? { runCommand: (argv: string[]) => deps.executor!.runCommand(argv) } : {}) })
        const after = await authenticateCaller(req)
        await assertRootCaller(after, 'management-tls.read')
        if (after.principalId !== fresh.principalId) return fail('FORBIDDEN', 'certificate observation authorization changed', { stateChanged: false })
        return jsonResponse(observation)
      }
      if (method === 'GET' && certificateMatch) {
        if ([...url.searchParams.keys()].some(key => key !== 'limit') || url.searchParams.getAll('limit').length > 1) return fail('VALIDATION', 'unsupported certificate observation selector', { stateChanged: false })
        const rawLimit = url.searchParams.get('limit'), limit = rawLimit === null ? MAX_CERTIFICATE_ORDER_READS : /^[0-9]{1,2}$/.test(rawLimit) ? Number(rawLimit) : 0
        if (limit < 1 || limit > MAX_CERTIFICATE_ORDER_READS) return fail('VALIDATION', 'invalid certificate observation bound', { stateChanged: false })
        const fresh = await authenticateCaller(req), snapshot = await deps.store.readSnapshot()
        const account = snapshot.accounts.find(row => row.username === certificateMatch[1] && row.status === 'active')
        if (!account || fresh.principalId !== caller.principalId || fresh.role !== caller.role) return fail('NOT_FOUND', 'certificate observation account not found', { stateChanged: false })
        await assertAccountCaller(fresh, account, 'certificates.read')
        if (fresh.role === 'reseller') assertAcl({ id: fresh.principalId, username: fresh.actor, kind: 'reseller' }, await deps.store.getReseller(fresh.principalId), 'manage-ssl')
        const observation = await readAccountAcmeOrders({ account, certificates: snapshot.certificates.filter(row => row.accountId === account.id), domains: snapshot.domains, limit })
        const after = await authenticateCaller(req), current = await deps.store.getAccount(account.id)
        if (!current || after.principalId !== fresh.principalId || after.role !== fresh.role || await deps.store.getRevision() !== snapshot.revision) return fail('CONFLICT', 'certificate observation scope changed', { stateChanged: false })
        await assertAccountCaller(after, current, 'certificates.read')
        if (after.role === 'reseller') assertAcl({ id: after.principalId, username: after.actor, kind: 'reseller' }, await deps.store.getReseller(after.principalId), 'manage-ssl')
        return jsonResponse(observation)
      }
      if (method === 'POST' && certificateMatch) {
        const username = certificateMatch[1]!
        // Target authority precedes body grammar and domain lookup so a neighbor cannot probe another account.
        const targetAccount = (await deps.store.getAccountByUsername(username)) ?? fail('NOT_FOUND', 'active certificate account not found', { stateChanged: false })
        await assertAccountCaller(caller, targetAccount, 'certificates')
        if (caller.role === 'reseller') assertAcl({ id: caller.principalId, username: caller.actor, kind: 'reseller' }, await deps.store.getReseller(caller.principalId), 'manage-ssl')
        const body = await readObjectBody(req)
        const manual = body.operation === 'install'
        const allowed = manual ? ['operation', 'domain', 'expectedRevision', 'fullchainPem', 'privateKeyPem'] : ['domain', 'certificateId', 'directoryUrl', 'expectedRevision']
        if (Object.keys(body).some(key => !allowed.includes(key))) return fail('VALIDATION', 'unsupported certificate request field', { stateChanged: false })
        const domainName = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : ''
        if (!domainName) return fail('VALIDATION', 'domain is required', { stateChanged: false })
        const executor = deps.executor
        if (!executor) return fail('PRECONDITION_FAILED', 'host executor is not connected', { stateChanged: false })
        const snapshot = await deps.store.readSnapshot()
        const expectedRevision = body.expectedRevision === undefined ? snapshot.revision : body.expectedRevision
        if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail('VALIDATION', 'expectedRevision must be a saved authority revision', { stateChanged: false })
        if (expectedRevision !== snapshot.revision) return fail('CONFLICT', 'certificate configuration changed', { stateChanged: false })
        const account = snapshot.accounts.find(row => row.username === username)
        if (!account || account.status !== 'active') return fail('NOT_FOUND', 'active certificate account not found', { stateChanged: false })
        const domains = snapshot.domains.filter(row => row.accountId === account.id)
        const domain = domains.find(row => row.name === domainName)
        if (!domain) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
        const freshCaller = await authenticateCaller(req)
        if (freshCaller.principalId !== caller.principalId || freshCaller.role !== caller.role) return fail('FORBIDDEN', 'certificate authorization changed', { stateChanged: false })
        await assertAccountCaller(freshCaller, account, 'certificates')
        if (freshCaller.role === 'reseller') assertAcl({ id: freshCaller.principalId, username: freshCaller.actor, kind: 'reseller' }, await deps.store.getReseller(freshCaller.principalId), 'manage-ssl')
        // assertAccountCaller already confines a user to the own account; SAN ownership is validated per name.
        if (manual && !['root', 'reseller', 'user'].includes(freshCaller.role)) return fail('FORBIDDEN', 'account certificate access is required', { stateChanged: false })
        const renewal = Object.hasOwn(body, 'certificateId') ? validateCertificateRenewalTarget({ certificateId: body.certificateId,
          certificate: snapshot.certificates.find(row => row.id === String(body.certificateId).toLowerCase()) ?? null,
          accountId: account.id, domain, domains: snapshot.domains }) : null
        const assertUnchanged = async (nativeStarted: boolean): Promise<void> => {
          try {
            const fresh = await authenticateCaller(req)
            const current = await deps.store.readSnapshot()
            const currentAccount = current.accounts.find(row => row.id === account.id && row.username === username && row.status === 'active')
            if (!currentAccount || fresh.principalId !== freshCaller.principalId || fresh.role !== freshCaller.role || current.revision !== expectedRevision) return fail('CONFLICT', 'certificate authority changed', { stateChanged: false })
            await assertAccountCaller(fresh, currentAccount, 'certificates')
            if (fresh.role === 'reseller') assertAcl({ id: fresh.principalId, username: fresh.actor, kind: 'reseller' }, await deps.store.getReseller(fresh.principalId), 'manage-ssl')
            const currentDomain = current.domains.find(row => row.id === domain.id && row.accountId === account.id && row.name === domain.name)
            if (!currentDomain) return fail('CONFLICT', 'certificate domain changed', { stateChanged: false })
            if (renewal) validateCertificateRenewalTarget({ certificateId: renewal.certificateId,
              certificate: current.certificates.find(row => row.id === renewal.certificateId) ?? null,
              accountId: account.id, domain: currentDomain, domains: current.domains })
          } catch (error) {
            if (!nativeStarted) throw error
            return fail('SERVICE_UNAVAILABLE', 'certificate files require verification after authority changed', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
          }
        }
        await assertUnchanged(false)
        if (manual) {
          const result = await installManualCertificate({ executor, accountId: account.id, domains: snapshot.domains,
            body: { domain: domain.name, fullchainPem: body.fullchainPem, privateKeyPem: body.privateKeyPem } })
          await assertUnchanged(true)
          await appendAudit(deps.db, { actor: freshCaller.actor, action: 'certificate.candidate_written', target: 'domain:' + domain.name,
            detail: { certificateId: result.certificate.id, names: result.certificate.names, notAfter: result.certificate.notAfter, nativeApplied: false, servedTlsVerified: false }, outcome: 'ok' })
          return jsonResponse(result)
        }
        const release = await executor.readFile('/etc/os-release')
        if (!release) return fail('PRECONDITION_FAILED', 'the host operating system could not be read', { stateChanged: false })
        const directoryUrl = freshCaller.role === 'root' && typeof body.directoryUrl === 'string' && body.directoryUrl.startsWith('http://127.0.0.1:')
          ? body.directoryUrl
          : 'https://acme-v02.api.letsencrypt.org/directory'
        const accountKeyPath = '/var/lib/xpanel/acme-account/account-key.pem'
        const existingKey = await executor.readFile(accountKeyPath)
        const caClient = createHttp01AcmeClient({ directoryUrl, ...(existingKey ? { accountKeyPem: existingKey } : {}) })
        if (!existingKey) {
          await executor.runAction({ kind: 'ensure-dir', path: '/var/lib/xpanel/acme-account', mode: 0o700, owner: 'root', group: 'root' })
          if (await executor.readFile(accountKeyPath) !== null) return fail('CONFLICT', 'ACME account key appeared during preparation; review before retrying', { stateChanged: true, verificationRequired: true })
          await executor.writeFile({ path: accountKeyPath, content: caClient.accountKeyPem, mode: 0o600, owner: 'root', group: 'root' })
          if (await executor.readFile(accountKeyPath) !== caClient.accountKeyPem) return fail('SERVICE_UNAVAILABLE', 'ACME account key persistence requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
        }
        const adapter = new AcmeCertificateServiceAdapter({ executor, os: profileFor(release), directoryUrl, caClient,
          http01ChallengeDir: edge.XP_PATHS.acmeDir,
          sniVerifier: async ({ servername, expectedFingerprintSha256 }) => {
            const address = domain.ipv4 ?? domain.ipv6 ?? account.ipv4 ?? account.ipv6
            if (!address) return { servername, ok: false, fingerprintSha256: null, notAfter: null, error: 'served_certificate_address_unavailable' }
            const pem = await readServedCertificatePem(address, 443, 2000, servername)
            if (!pem) return { servername, ok: false, fingerprintSha256: null, notAfter: null, error: 'served_certificate_unavailable' }
            try {
              const observed = computeLeafFingerprintSha256(pem)
              return { servername, ok: observed.fingerprintSha256 === expectedFingerprintSha256 && services.coversHost(observed.dnsSans, servername) && observed.notAfter.getTime() > Date.now(), fingerprintSha256: observed.fingerprintSha256, notAfter: observed.notAfter.toISOString() }
            } catch { return { servername, ok: false, fingerprintSha256: null, notAfter: null, error: 'served_certificate_invalid' } }
          } })
        await assertUnchanged(false)
        const result = await adapter.issueOrRenewCertificate({ certId: renewal?.certificateId ?? randomUUID(), accountId: account.id,
          callerRole: freshCaller.role === 'root' || freshCaller.role === 'reseller' || freshCaller.role === 'user' ? freshCaller.role : 'user',
          names: renewal?.names ?? [domain.name], challenge: 'http-01', domains, prepareOnly: !renewal })
        await assertUnchanged(true)
        await appendAudit(deps.db, { actor: freshCaller.actor, action: renewal ? 'certificate.renewed' : 'certificate.issued',
          target: 'domain:' + domain.name, detail: { certificateId: result.certId, names: result.identifiers, notAfter: result.notAfter, servedTlsVerified: false }, outcome: 'ok' })
        return jsonResponse({ certificate: { id: result.certId, names: result.identifiers, notAfter: result.notAfter,
          fingerprintSha256: result.fingerprintSha256, certPath: result.fullchainPath, keyPath: result.privkeyPath, challenge: 'http-01' as const },
          orderUrl: result.orderUrl, application: { status: 'certificate_material_prepared', configurationApplied: false, servedTlsVerified: false } })
      }

      return fail('NOT_FOUND', `route ${method} ${pathname} not found`)
    } catch (err) {
      if (!isXpanelError(err)) {
        await appendAudit(deps.db, {
          actor: 'agent',
          action: 'agent.internal_error',
          target: pathname,
          detail: { error: err instanceof Error ? err.message : String(err) },
          outcome: 'failed',
        }).catch(() => undefined)
      }
      return problemResponse(err, pathname)
    }
  }

  const fetch = async (req: Request): Promise<Response> => {
    // Agent health authenticates/audits, so it has no anonymous maintenance bypass.
    const denied = await lifecycleAdmissionResponse(req, { surface: 'agent' })
    if (denied) return denied
    try { return await withLifecycleWriterAdmission(() => fetchInner(req)) }
    catch { return new Response(JSON.stringify({ error: 'Lifecycle writer admission is unavailable.' }), { status: 503, headers: { 'content-type': 'application/problem+json', 'retry-after': '5', 'cache-control': 'no-store' } }) }
  }

  return {
    fetch,
    subscribe: (fn) => deps.reconciler.subscribe(fn),
  }
}

export interface ListenAgentSocketOptions {
  /** Group dedicated to the unprivileged API service. */
  gid: number
  /**
   * Expected unprivileged API service UID(s). When omitted, resolved from
   * `XPANEL_API_UID` or the unique non-root service identity in `gid` (`/etc/group`).
   */
  expectedPeerUid?: number | readonly number[]
  /**
   * Whether local root (UID 0) connections are permitted alongside the
   * unprivileged API service UID.
   */
  allowRootPeer?: boolean
  /** Maximum concurrent active socket connections (default 64). */
  maxConnections?: number
  /** Maximum concurrent in-flight HTTP requests (default 32). */
  maxInFlightRequests?: number
  /** Idle timeout in milliseconds for accepted sockets (default 35_000). */
  socketIdleTimeoutMs?: number
  /** Optional observer invoked on every kernel peer identity evaluation. */
  onPeerDecision?: (event: PeerIdentityDecisionEvent) => void
  /** Optional native addon override for fault-injection tests. */
  nativeAddon?: NativePeerIdentityAddon
}

/**
 * Listens on an AF_UNIX socket owned by root with dedicated API group `0660`,
 * enforcing kernel `SO_PEERCRED` peer UID verification on every accepted socket
 * via the native C N-API listener before handing the descriptor to `node:http`.
 */
export const listenAgentSocket = async (
  app: AgentApp,
  socketPath: string,
  opts: ListenAgentSocketOptions,
): Promise<{ server: Server; close: () => Promise<void> }> => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    fail('PRECONDITION_FAILED', 'agent socket must be provisioned by root on Linux')
  }
  if (!isAbsolute(socketPath) || !Number.isSafeInteger(opts.gid) || opts.gid <= 0) {
    fail('PRECONDITION_FAILED', 'agent socket requires an absolute path and a dedicated API group')
  }
  const maxConnections = opts.maxConnections ?? MAX_AGENT_SOCKET_CONNECTIONS
  const maxInFlightRequests = opts.maxInFlightRequests ?? MAX_AGENT_INFLIGHT_REQUESTS
  const socketIdleTimeoutMs = opts.socketIdleTimeoutMs ?? DEFAULT_AGENT_SOCKET_IDLE_TIMEOUT_MS
  if (
    !Number.isSafeInteger(maxConnections) ||
    maxConnections < 1 ||
    !Number.isSafeInteger(maxInFlightRequests) ||
    maxInFlightRequests < 1 ||
    !Number.isSafeInteger(socketIdleTimeoutMs) ||
    socketIdleTimeoutMs < 100
  ) {
    fail('PRECONDITION_FAILED', 'agent socket connection and timeout bounds must be positive integers')
  }

  await assertRootOwnedAgentPath(dirname(socketPath))
  const allowedPeerUids = await resolveProvisionedPeerUids({
    gid: opts.gid,
    ...(opts.expectedPeerUid !== undefined && { expectedPeerUid: opts.expectedPeerUid }),
    ...(opts.allowRootPeer !== undefined && { allowRootPeer: opts.allowRootPeer }),
  })
  const addon = opts.nativeAddon ?? (await loadNativePeerIdentityAddon())

  const socketPeers = new WeakMap<Socket, KernelPeerCredentials>()
  const activeSockets = new Set<Socket>()
  let inFlightRequests = 0
  let closing = false
  let nativeListener: unknown = null

  const server = createServer(
    { requestTimeout: 30_000, headersTimeout: 5_000, maxHeaderSize: 16 * 1024, keepAliveTimeout: 5_000 },
    async (req, res) => {
      const abort = new AbortController()
      res.once('close', () => abort.abort())
      req.once('aborted', () => abort.abort())
      const isEventsStream = (req.url ?? '').startsWith('/internal/events')
      if (!isEventsStream) {
        inFlightRequests += 1
      }
      try {
        if (closing || !nativeListener || !addon.verifyListenerSocket(nativeListener)) {
          req.socket.destroy()
          return fail('PRECONDITION_FAILED', 'agent socket path was replaced or closed')
        }
        const peer = socketPeers.get(req.socket)
        if (!peer) {
          req.socket.destroy()
          return fail('PRECONDITION_FAILED', 'kernel socket peer credentials unavailable')
        }
        if (!isEventsStream && inFlightRequests > maxInFlightRequests) {
          return fail('SERVICE_UNAVAILABLE', 'agent concurrent request limit exceeded')
        }
        if (isEventsStream) {
          req.socket.setTimeout(0)
        }
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of req) {
          length += chunk.length
          if (length > MAX_AGENT_MESSAGE_BYTES) fail('LIMIT_EXCEEDED', 'agent request exceeds the message limit')
          chunks.push(Buffer.from(chunk))
        }
        const method = req.method ?? 'GET'
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value)
          else if (Array.isArray(value)) headers.set(key, value.join(', '))
        }
        stripForgedPeerHeaders(headers)
        const request = new Request(`http://agent.local${req.url ?? '/'}`, {
          method,
          headers,
          signal: abort.signal,
          ...(length && method !== 'GET' && method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}),
        })
        bindVerifiedRequestPeer(request, {
          peer,
          allowedPeerUids,
          credentialSource: 'SO_PEERCRED',
        })
        opts.onPeerDecision?.({
          allowed: allowedPeerUids.has(peer.uid),
          peer,
          allowedPeerUids: [...allowedPeerUids],
          credentialSource: 'SO_PEERCRED',
          pathname: new URL(request.url).pathname,
          method: method.toUpperCase(),
        })
        const response = await app.fetch(request)
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        const reader = response.body?.getReader()
        try {
          while (reader && !abort.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) break
            if (!res.write(value)) await once(res, 'drain', { signal: abort.signal })
          }
        } finally {
          await reader?.cancel().catch(() => undefined)
        }
        res.end()
      } catch (error) {
        if (res.headersSent) {
          res.destroy()
          return
        }
        const response = problemResponse(error, req.url ?? '/')
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        res.end(await response.text())
      } finally {
        if (!isEventsStream) {
          inFlightRequests = Math.max(0, inFlightRequests - 1)
        }
      }
    },
  )

  const onReadable = () => {
    while (!closing && nativeListener) {
      let accepted: NativePeerAcceptedConnection | null = null
      try {
        accepted = addon.acceptPeer(nativeListener)
      } catch {
        break
      }
      if (accepted === null) break
      if (activeSockets.size >= maxConnections) {
        addon.closeFd(accepted.fd)
        continue
      }
      let peer: KernelPeerCredentials
      try {
        peer = assertValidKernelPeerCredentials({
          uid: accepted.uid,
          gid: accepted.gid,
          pid: accepted.pid,
        })
      } catch {
        addon.closeFd(accepted.fd)
        continue
      }
      let socket: Socket
      try {
        socket = new Socket({ fd: accepted.fd, readable: true, writable: true })
      } catch {
        addon.closeFd(accepted.fd)
        continue
      }
      socketPeers.set(socket, peer)
      activeSockets.add(socket)
      socket.setTimeout(socketIdleTimeoutMs, () => {
        socket.destroy()
      })
      socket.once('error', () => {
        socket.destroy()
      })
      socket.once('close', () => {
        activeSockets.delete(socket)
        socketPeers.delete(socket)
      })
      server.emit('connection', socket)
    }
  }

  const keepAliveTimer = setInterval(() => undefined, 60_000)
  try {
    nativeListener = addon.openListener(socketPath, opts.gid, 0o660, DEFAULT_AGENT_SOCKET_BACKLOG, onReadable)
    const socket = await lstat(socketPath)
    if (!socket.isSocket() || socket.uid !== 0 || socket.gid !== opts.gid || (socket.mode & 0o7777) !== 0o660) {
      fail('PRECONDITION_FAILED', 'agent socket permissions were not applied')
    }
  } catch (error) {
    closing = true
    clearInterval(keepAliveTimer)
    if (nativeListener) {
      try {
        addon.closeListener(nativeListener)
      } catch {
        // ignore close failure on partial init
      }
      nativeListener = null
    }
    server.closeAllConnections()
    if (!isXpanelError(error)) {
      fail('PRECONDITION_FAILED', error instanceof Error ? error.message : 'failed to open agent socket')
    }
    throw error
  }

  return {
    server,
    close: async () => {
      if (closing) return
      closing = true
      clearInterval(keepAliveTimer)
      if (nativeListener) {
        try {
          addon.closeListener(nativeListener)
        } catch {
          // ignore close failure during shutdown
        }
        nativeListener = null
      }
      for (const socket of activeSockets) {
        socket.destroy()
      }
      activeSockets.clear()
      server.closeAllConnections()
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      })
    },
  }
}
