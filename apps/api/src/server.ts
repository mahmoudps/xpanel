import { AsyncLocalStorage } from 'node:async_hooks'
import { lifecycleAdmissionResponse, withLifecycleWriterAdmission } from '../../../scripts/lifecycle-admission.mjs'
import { createHandoffRoutes } from './panel-handoff-routes.ts'
import { impersonationForbidsRoute } from './panel-handoff-protocol.ts'
import { createHandoffSessionCheck } from './panel-handoff-authority.ts'
import { parseAuditFilters } from './audit-filters.ts'
import { createAccountBackupWorkspace } from './account-backup-workspace.ts'
import { createCertificateRuntimeRouter } from './certificate-runtime.ts'
import { createCronWorkspaceRoutes, type CronWorkspacePorts } from './cron-workspace.ts'
import { createMailxWorkspaceRoutes } from './mailx-workspace.ts'
import { createMailxCollectionsRoutes } from './mailx-collections.ts'
import { handlePhpWorkspaceRoute } from './php-workspace.ts'
import { handleMailQueueWorkspaceRoute } from './mail-queue-workspace.ts'
import { handleSystemUpdatesWorkspaceRoute } from './system-updates-workspace.ts'
import { handleFileSharingWorkspaceRoute } from './ops-file-sharing-workspace.ts'
import { handleTerminalWorkspaceRoute } from './ops-terminal-workspace.ts'
import { handleNodesWorkspaceRoute } from './ops-nodes-workspace.ts'
import { handleIntegrationsWorkspaceRoute } from './ops-integrations-workspace.ts'
import { atomicWriteJson as opsAtomicWriteJson } from '@xpanel/state'
import { join as opsJoin } from 'node:path'
import { handleRepairWorkspaceRoute } from './repair-workspace.ts'
import { handleConfigurationHealthWorkspaceRoute } from './configuration-health-workspace.ts'
import { handleAccountHealthWorkspaceRoute } from './account-health-workspace.ts'
import { handleBackupFileRestoreWorkspaceRoute } from './backup-file-restore-workspace.ts'
import { handleJobsWorkspaceRoute } from './jobs-workspace.ts'
import { handlePanelTokensWorkspaceRoute } from './panel-tokens-workspace.ts'
import { handlePanelNotificationsRoute } from './panel-notifications.ts'
import { handleAnnouncementsRoute } from './announcements-workspace.ts'
import { handleTransferCredentialsRoute, readTransferCredentialToken } from './acct-transfer-credentials.ts'
import { handleTransferSourceBackupRoute, handleTransferSourceInventoryRoute } from './acct-transfer-source.ts'
import { executeAddonConversion } from './lifecycle-convert-addon.ts'
import { createLifecycleAccount } from './lifecycle-account-create.ts'
import { createTransferExecution } from './lifecycle-transfer-execution.ts'
import { handleConvertAddonRoute } from './acct-convert-addon.ts'
import { handleComponentRestoreWorkspaceRoute } from './acct-restore-workspace.ts'
import { handleStagingWorkspaceRoute } from './acct-staging-workspace.ts'
import { handleTeamRoute } from './acct-team-workspace.ts'
import { handleTeamPasswordRoute, signInTeamMember, teamFileReader, teamMemberResolver, TEAM_PASSWORD_ROUTE } from './team-session.ts'
import { revokeTeamSession } from './team-store.ts'
import { accountTemplateZoneRecords, handleAccountTemplatesRoute, templateForNewAccount } from './acct-templates-workspace.ts'
import type { AccountTemplate } from './acct-templates-workspace.ts'
import { handleAccountEnhancementsRoute } from './acct-enhancements-workspace.ts'
import { handleSoftwareCenterWorkspaceRoute } from './software-center-workspace.ts'
import { handleWhmDatabasesWorkspaceRoute } from './whm-databases-workspace.ts'
import { handleDatabaseTuningWorkspaceRoute } from './database-tuning-workspace.ts'
import { createDefaultIndexWorkspaceRoutes } from './default-index-workspace.ts'
import { handleComposerWorkspaceRoute } from './composer-workspace.ts'
import { handleSwContainersWorkspaceRoute } from './sw-containers-workspace.ts'
import { handleSwAddonServicesWorkspaceRoute } from './sw-addon-services-workspace.ts'
import { handleSwDeploymentsWorkspaceRoute } from './sw-deployments-workspace.ts'
import { handleSwOptimizeWorkspaceRoute } from './sw-optimize-workspace.ts'
import { handleSwApplicationsWorkspaceRoute } from './sw-applications-workspace.ts'
import { handleAdminPreferencesRoute } from './admin-preferences.ts'
import { handleServiceManagerWorkspaceRoute } from './service-manager-workspace.ts'
import { handleBenchmarkWorkspaceRoute } from './benchmark-workspace.ts'
import { handleTrafficWorkspaceRoute } from './traffic-workspace.ts'
import { handleGitWorkspaceRoute } from './git-workspace.ts'
import { handlePgpWorkspace } from './pgp-workspace.ts'
import { createDynamicDnsRoutes } from './dynamic-dns.ts'
import { handleWebDirectivesRoute } from './web-directives-workspace.ts'
import { handleMailLogWorkspaceRoute, handleMailTrackDeliveryRoute } from './mail-log-workspace.ts'
import { handleFtpLogWorkspaceRoute } from './ftp-log-workspace.ts'
import { handleUpgradeWorkspaceRoute } from './upgrade-workspace.ts'
import { handleMonitoringWorkspaceRoute } from './monitoring-workspace.ts'
import { handleMailServerWorkspaceRoute } from './mail-server-workspace.ts'
import { handleMailQualityWorkspaceRoute } from './mail-quality-workspace.ts'
import { handleMailboxMaintenanceWorkspaceRoute } from './mailbox-maintenance-workspace.ts'
import { handleServerObservationWorkspaceRoute } from './server-observation-workspace.ts'
import { handleServerHealthWorkspaceRoute } from './server-health-workspace.ts'
import { handleSupportWorkspaceRoute } from './support-workspace.ts'
import { handleMonitoringAlertsRoute } from './monitoring-alerts.ts'
import { alertStateFiles, alertTransports } from './alert-runtime.ts'
import { handleServiceDetailWorkspaceRoute } from './service-detail-workspace.ts'
import { handleDnsToolsWorkspaceRoute } from './dns-tools-workspace.ts'
import { handleSecurityToolsWorkspaceRoute } from './security-tools-workspace.ts'
import { handleSecWorkspaceRoute } from './sec-workspace.ts'
import type { SecWorkspaceHelpers } from './sec-workspace.ts'
import { handleSecCloudflareRoute } from './sec-cloudflare.ts'
import { secPanelAccessGate } from './sec-panel-access.ts'
import { authorizeAccountOwner, handleAccountSshRoute } from './account-ssh-workspace.ts'
import { SITE_PUBLISHER_DOMAIN_ROUTE, executeSitePublisherWorkspaceRequest, parseSitePublisherHttpRequest } from './site-publisher-workspace.ts'
import { readSitePublisherBody } from '../../agent/src/site-publisher-routes.ts'
import { handleAccountLogsRoute } from './account-logs-workspace.ts'
import { handleAccountVirusScanRoute } from './account-virus-scan-workspace.ts'
import { createNetworkToolsGate, handleNetworkToolsRoute } from './network-tools-workspace.ts'
import { handleAccountDatabaseInsightsRoute } from './account-database-insights-workspace.ts'
import { handleSiteHealthRoute, systemSiteHealthDns } from './site-health-workspace.ts'
import { probeHtaccessTarget } from '../../agent/src/htaccess-native.ts'
import { readGenerationWorkspace } from './generation-workspace.ts'
import { createDefaultSiteWorkspaceRoutes } from './default-site-workspace.ts'
import { parseGenerationRollbackRequest } from '@xpanel/state'
import { createSecurityWorkspaceRoutes } from './security-workspace.ts'
import type { CronJobIntent, CronJobObservationReceipt } from '@xpanel/core'
import { HTACCESS_DOMAIN_ROUTE, executeHtaccessWorkspaceRequest, parseHtaccessHttpRequest } from './htaccess-workspace.ts'
import { createQuarantineRoutes, type QuarantineGateway } from './mail/quarantine-routes.ts'
import { assertDnsZoneRevision, dnsExpectedRevision, dnsZoneRevision } from './dns-workspace.ts'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { agentCallerHeaders } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { groups, visibleTools, visibleNavigation } from '@xpanel/catalog'
import {
  bindMfaRuntimePolicy,
  fail,
  isXpanelError,
  isUuid,
  assertAcl,
  parseIp,
  canonicalIp,
  validateDomainCustomConfig,
  MANAGEMENT_PUBLIC_PORTS,
  validateUsername,
  validateDefaultSitePolicy,
  accountContactRevision,
  validateDomainName,
  parseOwnerDatabaseCreateRequest,
  parseOwnerDatabaseUserCreateRequest,
  parseOwnerDatabaseGrantRequest,
  parseOwnerDatabaseStateRequest,
  projectDatabaseWorkspaceUser,
} from '@xpanel/core'
import type {
  MfaRuntimePolicy,
  Account,
  AuditEntry,
  DomainCustomConfig,
  Domain,
  ErrorCode,
  FeatureList,
  FirewallRule,
  Id,
  IoAnalyticsSnapshot,
  LiveEvent,
  LiveEventScope,
  MailIpConfig,
  OsProfile,
  PhpSettings,
  Reseller,
  ServerIpEntry,
  ServerSettings,
} from '@xpanel/core'
import {
  appendAudit,
  checkLockout,
  changePasswordForSession,
  clearLockout,
  consumeRecoveryHash,
  consumeTotpStep,
  completeTotpEnrollment,
  disableTotpForSession,
  createResellerPrincipal,
  createRootPrincipal,
  createAuthenticatedSession,
  createUserPrincipal,
  deletePrincipal,
  listMetricsHistory,
  findPrincipalByUsername,
  getPrincipal,
  latestActive,
  listAudit,
  getPendingTotpEnrollment,
  startTotpEnrollment,
  recordLogin,
  recordLoginAttempt,
  reindexFromState,
  listSessionsForPrincipal,
  revokeSession,
  revokeAccountSessionsAndTokens,
  revokeOtherSessionsForPrincipal,
  setPasswordHash,
  syncAccountContactIndex,
  prepareAccountContactIndexRollback,
  prepareDomainIndexTransition,
  prepareDatabaseIndexCreation,
  prepareDatabaseIndexTransition,
  searchIndex,
  recordLoginFailure,
} from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type {
  DnsZoneState,
  DomainPatch,
  DomainMutationOptions,
  DatabaseMutationOptions,
  DomainWorkspaceRead,
  FirewallGuard,
  NewAccount,
  NewDomain,
  NewFirewallRule,
  NewPlan,
  NewReseller,
  NewServiceUser,
  PlanPatch,
  ResellerPatch,
  ServiceUserPatch,
  StateStore,
} from '@xpanel/state'
import {
  DUMMY_PASSWORD_HASH,
  authenticateRequest,
  clearSessionCookie,
  deriveCsrfToken,
  formatSessionCookie,
  generateTotpSecret,
  sealTotpSecret,
  sha256Hex,
  unsealTotpSecret,
  verifyPasswordArgon2id,
  verifyTotpStep,
  passwordHashFromInput,
} from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { createExtendedApiRouter, ExtendedFeaturesStore } from './extended-routes.ts'
import type { WebmailIdentity } from './extended-routes.ts'
import { createMailSearchWorkspace } from './mail/search-workspace.ts'
import { handleMailFolderAdminRoute } from './mail/folder-admin.ts'
import { handleMailboxUsageRoute } from './mail/mailbox-usage.ts'
import { handleMailDeviceSetupRoute } from './mail/device-setup.ts'
import { handleMailboxForwardersRoute } from './mail/mailbox-forwarders.ts'
import { handleMailboxPreferencesRoute } from './mail/mailbox-preferences.ts'
import { handleMailboxSpamRoute } from './mail/mailbox-spam.ts'
import { handleMailboxMailingListsRoute } from './mail/mailbox-mailing-lists.ts'
import { handleAccountPackagesWorkspaceRoute } from './account-packages-workspace.ts'
import { handleDatabaseRemoteAccessWorkspaceRoute } from './database-remote-access-workspace.ts'
import { handleDbWorkspaceRoute } from './db-workspace.ts'
import { handleTrustedProxiesWorkspaceRoute } from './trusted-proxies-workspace.ts'
import { handleDeveloperWorkspaceRoute } from './developer-workspace.ts'
import { handleIntegrationWorkspaceRoute } from './integration-workspace.ts'
import type { MailSearchDependencies } from './mail/search-workspace.ts'
import { createAttachmentWorkspaceRoutes } from './mail/attachment-workspace.ts'
import type { AttachmentMailboxContext, AttachmentSource } from './mail/attachment-workspace.ts'
import { prepareComposeAttachments, ComposeAttachmentValidationError } from './mail/compose-attachments.ts'
import { resolveComposeIdentity } from './mail/compose-identity.ts'
import { captureMailboxMetadataAuthority, readBoundMailboxIdentityRecords } from './mail/metadata-authority.ts'
import { saveMailboxDraft } from './mail/draft-workspace.ts'
import { createNativeDraftTransport } from './mail/draft-native.ts'
import type { DraftContent, DraftTransport } from './mail/draft-workspace.ts'
import { sanitizeEmailHtml } from './mail/mime.ts'
import { validateFileWorkspaceRequest } from './file-workspace-validation.ts'
import { executeFileWorkspaceRequest } from './file-workspace-proxy.ts'
import { assertAccountAuthorized, assertAccountFeatures, assertApiScope, assertRequestAuthorized, isMailboxPrincipal, requireDomainAccount, ownedAccounts } from './authorization.ts'
import { LiveEventHub, WS_AUTHORIZATION_UNAVAILABLE } from './ws.ts'
import type { EventSubscriber, UpgradeAuthorization } from './ws.ts'
import { renderWebApp } from '../../web/src/app.ts'
import { requestLocale } from '../../web/src/i18n.ts'
import { requestPrefersHtml } from '../../web/src/status-page.ts'
import { ENTRY_POINTS, entryPointAdmitsPrincipal, entryPointAllowsApiRoute, isMailboxPrincipalUsername, sessionTokenHash } from './entry-points.ts'
import type { EntryPoint } from './entry-points.ts'
import { loadQualifiedCatalog } from './host-catalog.ts'
import { renderTotpQrSvg } from './totp-qr.ts'
import { authorizeMailboxSessionBinding, createLocalMailboxTransport, establishMailboxSession, mailFolderName, mailboxAddressIndex, mailboxSessionPassword, openAuthorizedMailboxSession, parseMailboxSend, revokeMailboxIdentity, rewriteMailboxIds } from './mail/inbox.ts'
import { listMailboxFolder, readMailboxFolder, moveMailboxFolder, mailboxFolderUid, mailboxUidValidity } from './mail/folder-workspace.ts'
import type { FolderWorkspaceAuthorization } from './mail/folder-workspace.ts'
import { imapDialPlan, mailboxLiveEvent, watchMailboxIdle } from './mail/idle.ts'
import type { MailboxTransport } from './mail/inbox.ts'
import { deleteMailboxSession } from '@xpanel/db'

// Public PHC fixture used only to equalize unknown-user password work; never an account credential.

export const INGRESS_SECRET_HEADER = 'x-xpanel-ingress-secret'

export interface TransportContext {
  remoteAddress?: string
  /** Original socket peer, explicitly null for transports without an IP peer. */
  socketRemoteAddress?: string | null
  trustedIngress?: boolean
  tls?: boolean
}

interface InternalTransportMeta {
  remoteAddress: string | null
  socketRemoteAddress?: string | null
  trustedIngress: boolean
  tls: boolean
}

const transportPeers = new WeakMap<Request, InternalTransportMeta>()
const trustedIngressRequests = new WeakSet<IncomingMessage>()

const defaultPhp = (version: PhpSettings['version'] = '8.3'): PhpSettings => ({
  version,
  handler: 'fpm',
  fpm: {
    mode: 'ondemand',
    maxChildren: 4,
    startServers: 2,
    minSpareServers: 1,
    maxSpareServers: 3,
    maxRequests: 500,
    processIdleTimeoutSec: 10,
  },
  ini: {},
})

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
  UNSUPPORTED_OS: 422,
  CONFIG_TEST_FAILED: 422,
  PRECONDITION_FAILED: 412,
  SERVICE_UNAVAILABLE: 503,
}

const jsonResponse = (body: unknown, status = 200, extraHeaders?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  })

/**
 * Formats an RFC 7807 Problem Details response.
 * Never leaks internal `err.message` on 500 responses — always returns constant `"Internal server error"`.
 */
const problemResponse = (err: unknown, instance: string, method = ''): Response => {
  if (isXpanelError(err)) {
    const isLockedOut = err.detail.lockedOut === true
    const status = isLockedOut ? 429 : (STATUS_BY_CODE[err.code] ?? 400)
    const code = isLockedOut ? 'LOCKED_OUT' : err.code
    return new Response(
      JSON.stringify({
        type: `https://xpanel.dev/problems/${code.toLowerCase().replace(/_/g, '-')}`,
        title: code,
        status,
        detail: err.message,
        code,
        instance,
        ...(Object.keys(err.detail).length > 0 && { details: err.detail }),
      }),
      {
        status,
        headers: { 'content-type': 'application/problem+json; charset=utf-8' },
      },
    )
  }
  const stack = err instanceof Error ? err.stack ?? err.message : String(err)
  console.error(`[xpanel-api] unexpected error ${method || 'UNKNOWN'} ${instance}\n${stack}`)
  return new Response(
    JSON.stringify({
      type: 'https://xpanel.dev/problems/internal-error',
      title: 'INTERNAL_ERROR',
      status: 500,
      detail: 'Internal server error',
      code: 'INTERNAL_ERROR',
      instance,
      // An unexpected exception may follow a committed write; it is not proof of rollback.
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && {
        details: { unknownOutcome: true, verificationRequired: true },
      }),
    }),
    {
      status: 500,
      headers: { 'content-type': 'application/problem+json; charset=utf-8' },
    },
  )
}

const transportProblem = (status: number, code: string, detail: string, instance: string): Response => new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, detail, instance }), { status, headers: { 'content-type': 'application/problem+json; charset=utf-8' } })

export interface ApiServerDeps {
  entryPoint?: EntryPoint
  publicOrigin?: string
  db: Db
  store: StateStore
  agentApp?: AgentApp
  agentToken?: string
  serverSecret: string
  /** Frozen trusted process policy shared with the document renderer. */
  mfaRuntimePolicy?: MfaRuntimePolicy
  allowedOrigins?: readonly string[]
  trustedProxyAddresses?: readonly string[]
  ingressSecret?: string
  requireSecureCookies?: boolean
  requireOriginHeader?: boolean
  hub?: LiveEventHub
  os?: OsProfile
  secureCookies?: boolean
  lockoutThreshold?: number
  lockoutDurationMs?: number
  homeBaseDir?: string
  mailboxTransport?: MailboxTransport
  /** Trusted native mail ports. Requests never provide transport or session selectors. */
  mailSearchClientFactory?: MailSearchDependencies['clientFactory']
  mailAttachmentSource?: AttachmentSource
  mailDraftTransport?: (opened: Readonly<AttachmentMailboxContext>) => DraftTransport
  /** Trusted native quarantine adapter; the request cannot select or qualify its profile. */
  quarantineGateway?: QuarantineGateway
  /** Trusted host admission only; never populated by a request or an API body. */
  admitCronMutation?: CronWorkspacePorts['admitCronMutation']
  assertSshKeyMutationQualified?: () => Promise<void>
  /** Trusted startup mail settings, captured once for transports and live watches. */
  mailboxEnvironment?: Readonly<NodeJS.ProcessEnv>
  webRenderer?: (req: Request) => Promise<Response> | Response
  /**
   * One-time handoff configuration, never rendered: the exact HTTPS origin this listener may open
   * (xWHM: xPanel, xPanel: xMail) and the exact origin whose handoffs it consumes (xPanel: xWHM, xMail: xPanel).
   */
  handoff?: { targetOrigin?: string; issuerOrigin?: string }
}

export interface ApiApp {
  fetch(req: Request, context?: TransportContext): Promise<Response>
  hub: LiveEventHub
  authenticateUpgrade(req: IncomingMessage, context?: TransportContext): Promise<UpgradeAuthorization>
  watchMailbox(req: IncomingMessage, signal: AbortSignal): void
}

const readJsonBody = async <T = Record<string, unknown>>(req: Request): Promise<T> => {
  if (req.body === null) return {} as T
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return fail('VALIDATION', 'request body must be valid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'request body must be a JSON object')
  return body as T
}

const publicServiceUser = <T extends object>(user: T): Omit<T, 'passwordHash'> => {
  const safe = { ...user } as T & { passwordHash?: unknown }
  delete safe.passwordHash
  return safe
}

const normalizedIp = (ip: string): string => parseIp(ip) ? canonicalIp(ip).address : ip

const isLocalProxyAddress = (address: string): boolean => {
  const parsed = parseIp(address)
  if (!parsed || parsed.value === 0n || (parsed.version === 4 && parsed.value >> 24n === 127n) || (parsed.version === 6 && parsed.value === 1n)) return true
  return Object.values(networkInterfaces()).some(entries => entries?.some(entry => {
    const local = parseIp(entry.address)
    return local?.version === parsed.version && local.value === parsed.value
  }))
}

export const createApiApp = (deps: ApiServerDeps): ApiApp => {
  // Copy the profile: mutating the caller's dependency object cannot retarget a running listener.
  const entryPoint = deps.entryPoint
  if (entryPoint !== undefined && !Object.hasOwn(ENTRY_POINTS, entryPoint)) return fail('PRECONDITION_FAILED', 'invalid entry point')
  const publicOrigin = deps.publicOrigin
  if (publicOrigin !== undefined) {
    const parsed = new URL(publicOrigin)
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin) return fail('PRECONDITION_FAILED', 'publicOrigin must be an exact HTTPS origin')
  }
  const serverSecret = deps.serverSecret
  const mfaRuntimePolicy = bindMfaRuntimePolicy(deps.mfaRuntimePolicy)
  if (typeof serverSecret !== 'string' || Buffer.byteLength(serverSecret, 'utf8') < 32) fail('PRECONDITION_FAILED', 'a protected server secret of at least 32 bytes is required')
  const ingressSecret = deps.ingressSecret
  if (ingressSecret !== undefined && (typeof ingressSecret !== 'string' || Buffer.byteLength(ingressSecret, 'utf8') < 32)) {
    return fail('PRECONDITION_FAILED', 'a protected ingressSecret of at least 32 bytes is required when configured')
  }
  const trustedProxies = new Set((deps.trustedProxyAddresses ?? []).map(normalizedIp))
  if ([...trustedProxies].some(isLocalProxyAddress)) return fail('PRECONDITION_FAILED', 'trusted proxies must be remote dedicated hosts; local proxy trust requires protected ingress')
  const allowedOrigins = new Set(deps.allowedOrigins ?? [])
  if (entryPoint && allowedOrigins.size !== 1) return fail('PRECONDITION_FAILED', 'interactive entry points require one exact allowed origin')
  if (entryPoint && [...allowedOrigins].some(origin => { try { const url = new URL(origin); return url.protocol !== 'https:' || url.origin !== origin } catch { return true } })) return fail('PRECONDITION_FAILED', 'interactive origins must be exact HTTPS origins')
  if (publicOrigin && !allowedOrigins.has(publicOrigin)) return fail('PRECONDITION_FAILED', 'publicOrigin must match the configured allowed origin')
  const handoffOrigin = (origin: string | undefined): string | undefined => {
    if (origin === undefined) return undefined
    let parsed: URL
    try { parsed = new URL(origin) } catch { return fail('PRECONDITION_FAILED', 'handoff origins must be exact HTTPS origins') }
    if (parsed.protocol !== 'https:' || parsed.origin !== origin || origin === publicOrigin) return fail('PRECONDITION_FAILED', 'handoff origins must be exact HTTPS origins of another panel')
    return parsed.origin
  }
  const handoffTargetOrigin = handoffOrigin(deps.handoff?.targetOrigin)
  const handoffIssuerOrigin = handoffOrigin(deps.handoff?.issuerOrigin)
  const statusSurface: EntryPoint = entryPoint ?? 'xpanel'
  const prefersDocumentHtml = (request: Request, pathname: string, method: string): boolean =>
    (method === 'GET' || method === 'HEAD') && !pathname.startsWith('/api/') && requestPrefersHtml(request)
  const renderTransportStatus = (request: Request, status: 403 | 421 | 500 | 503): Response => {
    const pageUrl = new URL(request.url, 'http://localhost')
    const locale = requestLocale(pageUrl, request)
    const theme = pageUrl.searchParams.get('theme') === 'dark' ? 'dark' as const : 'light' as const
    const density = pageUrl.searchParams.get('density') === 'compact' ? 'compact' as const : 'comfortable' as const
    // A transport status page brands and links only this listener's own panel.
    const html = renderWebApp({
      surface: statusSurface,
      locale,
      theme,
      density,
      activeRoute: pageUrl.pathname,
      error: {
        status,
        surface: statusSurface,
        ...(status === 500 || status === 503 ? { retryHref: `${pageUrl.pathname}${pageUrl.search}` } : {}),
      },
    })
    return new Response(html, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
      },
    })
  }

  const hasValidIngressSecret = (req: Request): boolean => {
    if (!ingressSecret) return false
    const supplied = req.headers.get(INGRESS_SECRET_HEADER)
    if (typeof supplied !== 'string' || supplied.length === 0) return false
    const expectedBuf = Buffer.from(ingressSecret, 'utf8')
    const actualBuf = Buffer.from(supplied, 'utf8')
    return expectedBuf.byteLength === actualBuf.byteLength && timingSafeEqual(expectedBuf, actualBuf)
  }

  const isTrustedProxySource = (req: Request): boolean => {
    const meta = transportPeers.get(req)
    const suppliedSecret = req.headers.get(INGRESS_SECRET_HEADER)
    if (ingressSecret) {
      if (suppliedSecret !== null && !hasValidIngressSecret(req)) {
        return fail('UNAUTHENTICATED', 'invalid ingress authentication credential')
      }
      if (hasValidIngressSecret(req)) return true
      if (meta?.trustedIngress) {
        return fail('UNAUTHENTICATED', 'missing ingress authentication credential')
      }
    } else if (meta?.trustedIngress) {
      return true
    }
    const current = meta?.remoteAddress ?? null
    if (!current || !trustedProxies.has(current) || isLocalProxyAddress(current)) return false
    return true
  }

  const extractClientIp = (req: Request): string | null => {
    const meta = transportPeers.get(req)
    const current = meta?.remoteAddress ?? null
    if (!isTrustedProxySource(req)) return current
    const protoHeader = req.headers.get('x-forwarded-proto')?.trim().toLowerCase()
    if (protoHeader !== undefined && protoHeader !== '' && protoHeader !== 'https' && protoHeader !== 'http') {
      return fail('UNAUTHENTICATED', 'invalid forwarded protocol')
    }
    const rawForwarded = req.headers.get('x-forwarded-for')
    const chain = rawForwarded !== null ? rawForwarded.split(',').map(value => normalizedIp(value.trim())) : []
    if (chain.length > 1 || chain.some(value => !parseIp(value))) return fail('UNAUTHENTICATED', 'invalid forwarded client identity')
    if (chain.length === 0) {
      const realIp = req.headers.get('x-real-ip')?.trim()
      if (!realIp || !parseIp(realIp)) return fail('UNAUTHENTICATED', 'trusted proxy must supply a valid client identity')
      return normalizedIp(realIp)
    }
    return chain[0]!
  }

  const isVerifiedHttps = (req: Request): boolean => {
    const meta = transportPeers.get(req)
    if (meta?.tls) return true
    if (!isTrustedProxySource(req)) return false
    return req.headers.get('x-forwarded-proto')?.trim().toLowerCase() === 'https'
  }

  const useSecureCookies = (req: Request): boolean =>
    Boolean(deps.secureCookies || deps.requireSecureCookies || isVerifiedHttps(req))

  const isOriginPermitted = (origin: string, req: Request): boolean => {
    if (allowedOrigins.size > 0) return allowedOrigins.has(origin)
    try {
      const reqUrl = new URL(req.url, 'http://localhost')
      if (origin === reqUrl.origin) return true
      if (useSecureCookies(req) && origin === `https://${reqUrl.host}`) return true
      return false
    } catch {
      return false
    }
  }

  const hub = deps.hub ?? new LiveEventHub()
  const mailInput = deps.mailboxEnvironment ?? process.env
  const mailboxEnvironment: NodeJS.ProcessEnv = Object.freeze(Object.fromEntries([
    'XPANEL_IMAP_HOST', 'XPANEL_IMAP_PORT', 'XPANEL_IMAP_TLS', 'XPANEL_IMAP_TIMEOUT_MS',
    'XPANEL_SMTP_HOST', 'XPANEL_SMTP_PORT', 'XPANEL_SMTP_TIMEOUT_MS',
  ].map(key => [key, mailInput[key]])))
  const idleHost = mailboxEnvironment.XPANEL_IMAP_HOST || '127.0.0.1'
  const idlePort = Number(mailboxEnvironment.XPANEL_IMAP_PORT || '143')
  const idlePlan = imapDialPlan(idleHost, idlePort, mailboxEnvironment.XPANEL_IMAP_TLS)
  const idleTimeout = Number(mailboxEnvironment.XPANEL_IMAP_TIMEOUT_MS || '15000')
  const idleTarget = idlePlan && Number.isSafeInteger(idleTimeout) && idleTimeout > 0 && idleTimeout <= 120_000
    ? Object.freeze({ host: idleHost, port: idlePort, tls: idlePlan.tls, timeoutMs: idleTimeout }) : null
  const pendingIdle = new WeakMap<IncomingMessage, { mailbox: string; password: string; accountId: string }>()
  const idleWatching = new WeakSet<IncomingMessage>()
  const lockoutThreshold = deps.lockoutThreshold ?? 5
  const lockoutDurationMs = deps.lockoutDurationMs ?? 15 * 60_000

  if (deps.agentApp) {
    deps.agentApp.subscribe((event) => {
      hub.broadcast(event)
    })
  }


  const auditScope = new AsyncLocalStorage<{ impersonator?: Readonly<{ principalId: string; login: string }> }>()
  const emitAudit = async (
    input: {
      actor: string
      action: string
      target: string
      detail?: Record<string, unknown>
      outcome: 'ok' | 'denied' | 'failed'
      principalId?: Id | null
      ip?: string | null
    },
    scope: LiveEventScope = { accountId: null, resellerId: null },
  ): Promise<AuditEntry> => {
    let actor = input.actor
    let target = input.target
    if (/mbx[0-9a-f]{8,}/i.test(`${actor}\n${target}`)) {
      try {
        const snap = await deps.store.readSnapshot()
        const addresses = mailboxAddressIndex(
          snap.serviceUsers.filter(user => user.services.email && user.login.includes('@')).map(user => user.login),
        )
        actor = rewriteMailboxIds(actor, addresses)
        target = rewriteMailboxIds(target, addresses)
      } catch { /* The row keeps the id when the address cannot be read. */ }
    }
    // Every entry written for a handed-off session names the issuing identity beside the acting principal.
    const impersonator = auditScope.getStore()?.impersonator
    const detail = impersonator && !Object.hasOwn(input.detail ?? {}, 'impersonator') ? { ...input.detail, impersonator } : input.detail
    const entry = await appendAudit(deps.db, { ...input, actor, target, ...(detail ? { detail } : {}) })
    const event: LiveEvent = {
      id: randomUUID(),
      at: entry.at,
      kind: 'audit.entry',
      scope,
      data: entry,
    }
    hub.broadcast(event)
    return entry
  }

  const resolveResellerForCaller = async (caller: AuthenticatedCaller): Promise<Reseller | null> => {
    if (caller.principal.kind !== 'reseller') return null
    return deps.store.getReseller(caller.principal.id)
  }

  const resolveResellerId = async (caller: AuthenticatedCaller): Promise<Id | null> => {
    if (caller.principal.kind !== 'reseller') return null
    const r = await resolveResellerForCaller(caller)
    return r?.id ?? null
  }

  const buildSubscriberForCaller = async (caller: AuthenticatedCaller): Promise<EventSubscriber> => {
    if (caller.principal.kind === 'root') {
      return { kind: 'root', id: caller.principal.id, username: caller.principal.username }
    }
    if (caller.principal.kind === 'reseller') {
      const resellerId = (await resolveResellerId(caller)) ?? caller.principal.id
      const owned = await deps.store.listAccounts({ ownerId: resellerId })
      return {
        kind: 'reseller',
        id: resellerId,
        username: caller.principal.username,
        ownedAccountIds: new Set(owned.filter((a) => a.status === 'active').map((a) => a.id)),
      }
    }
    const account = await deps.store.getAccount(caller.principal.accountId, { username: caller.principal.username })
    if (!account || account.status !== 'active') {
      return fail('FORBIDDEN', 'hosting account is suspended or terminating')
    }
    return {
      kind: 'user',
      id: caller.principal.id,
      username: caller.principal.username,
      accountId: caller.principal.accountId,
    }
  }

  const authenticateUpgradeInner = async (req: IncomingMessage, context?: TransportContext): Promise<EventSubscriber | null> => {
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v)
      else if (Array.isArray(v)) headers.set(k, v.join(', '))
    }
    const webReq = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { headers })
    if (publicOrigin && new URL(webReq.url).host !== new URL(publicOrigin).host) return null
    const peer = context?.remoteAddress ?? req.socket?.remoteAddress
    const trustedIngress = Boolean(context?.trustedIngress || trustedIngressRequests.has(req))
    const tls = Boolean(context?.tls || ('encrypted' in (req.socket ?? {}) && (req.socket as { encrypted?: boolean }).encrypted))
    transportPeers.set(webReq, {
      remoteAddress: peer ? normalizedIp(peer) : null,
      trustedIngress,
      tls,
    })
    const origin = headers.get('origin')
    if (origin ? !allowedOrigins.has(origin) : !headers.has('authorization')) return null
    try {
      if (deps.requireSecureCookies && !isVerifiedHttps(webReq) && (entryPoint || (!deps.secureCookies && !headers.has('authorization')))) {
        return null
      }
      const caller = await authenticateRequest(deps.db, webReq, { serverSecret, clientIp: extractClientIp(webReq), touchSession: false, entryPoint, mfaRuntimePolicy, handoffAuthority })
      if (!caller || !caller.mfaVerified) return null
      if (caller.apiTokenId !== null) assertApiScope(caller, 'events:read')
      const mailboxIdentity = isMailboxPrincipal(caller)
        || (caller.principal.kind === 'user' && (/^mbx[0-9a-f]{28}$/i.test(caller.principal.username) || caller.principal.username.includes('@')))
      if (mailboxIdentity || entryPoint === 'xmail') {
        if (!idleTarget) return null
        const record = await authorizeMailboxSessionBinding(deps.db, deps.store, caller)
        // A handed-off session has no mailbox credential, so it receives events without an IMAP IDLE watch.
        const password = mailboxSessionPassword(record, serverSecret)
        if (password !== null && !idleWatching.has(req)) pendingIdle.set(req, {
          mailbox: record.mailbox, password, accountId: record.accountId,
        })
        return {
          kind: 'user', id: caller.principal.id, username: caller.principal.username,
          accountId: record.accountId, mailboxLogin: record.mailbox,
        }
      }
      await assertRequestAuthorized(deps.store, caller, new Request(new URL('/api/events/recent', webReq.url), { headers }))
      return buildSubscriberForCaller(caller)
    } catch {
      return null
    }
  }

  // Team sign-in reads the same accounts/team/<account>.json that handleTeamRoute writes.
  const readTeamFile = teamFileReader(deps.store.rootDir)
  const teamMember = teamMemberResolver(readTeamFile)
  const handoffAuthority = createHandoffSessionCheck({ db: deps.db, store: deps.store, teamMember })
  const requireCaller = async (req: Request, opts?: {
    allowUnverifiedMfa?: boolean
    allowInvalidCsrf?: boolean
    deferDeniedAudit?: (input: Parameters<typeof emitAudit>[0]) => void
  }): Promise<AuthenticatedCaller> => {
    const clientIp = extractClientIp(req)
    const auditDenied = async (input: Parameters<typeof emitAudit>[0]): Promise<void> => {
      if (opts?.deferDeniedAudit) opts.deferDeniedAudit(input)
      else await emitAudit(input)
    }
    const caller = await authenticateRequest(deps.db, req, { serverSecret, clientIp, entryPoint, mfaRuntimePolicy, teamMember, handoffAuthority })
    if (!caller) {
      return fail('UNAUTHENTICATED', 'authentication required')
    }
    if (
      deps.requireSecureCookies &&
      !deps.secureCookies &&
      !isVerifiedHttps(req) &&
      caller.sessionId !== null &&
      caller.apiTokenId === null
    ) {
      return fail('FORBIDDEN', 'HTTPS ingress is required for session cookie authentication')
    }
    if (!opts?.allowUnverifiedMfa && !caller.mfaVerified) {
      return fail('FORBIDDEN', 'two-factor authentication verification required')
    }
    const method = req.method.toUpperCase()
    if (
      (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') &&
      caller.sessionId !== null &&
      caller.apiTokenId === null
    ) {
      const origin = req.headers.get('origin')?.trim() ?? null
      const secFetchSite = req.headers.get('sec-fetch-site')?.trim().toLowerCase() ?? null
      if (
        (origin !== null && !isOriginPermitted(origin, req)) ||
        (origin === null && (secFetchSite === 'cross-site' || deps.requireOriginHeader === true))
      ) {
        await auditDenied({
          actor: caller.principal.username,
          action: 'auth.origin_rejected',
          target: new URL(req.url, 'http://localhost').pathname,
          detail: { origin, secFetchSite },
          outcome: 'denied',
          principalId: caller.principal.id,
          ip: clientIp,
        })
        return fail('FORBIDDEN', 'cross-origin state-changing request rejected')
      }
      if (!caller.csrfValid && !opts?.allowInvalidCsrf) {
        await auditDenied({
          actor: caller.principal.username,
          action: 'auth.csrf_rejected',
          target: new URL(req.url, 'http://localhost').pathname,
          outcome: 'denied',
          principalId: caller.principal.id,
          ip: clientIp,
        })
        return fail('FORBIDDEN', 'invalid or missing CSRF token (x-csrf-token)')
      }
    }
    const pathname = new URL(req.url).pathname
    const recoveryRoute = (method === 'GET' && pathname === '/api/auth/me')
      || (method === 'POST' && ['/api/auth/logout', '/api/auth/change-password'].includes(pathname))
    const nativeMailboxSession = caller.sessionId !== null && caller.apiTokenId === null
      && caller.principal.kind === 'user' && isMailboxPrincipalUsername(caller.principal.username)
    // xMail serves mailbox identities only; an owner, reseller or root session never acts there.
    if (entryPoint === 'xmail' && !nativeMailboxSession) return fail('FORBIDDEN', 'xMail accepts mailbox sign-in only')
    if (caller.impersonator) {
      const scope = auditScope.getStore()
      if (scope) scope.impersonator = caller.impersonator
      if (impersonationForbidsRoute(pathname, method)) return fail('FORBIDDEN', 'a handed-off session cannot change the sign-in identity of the account it opened', { stateChanged: false, impersonated: true })
    }
    // Native address sign-in is a mailbox identity, even though its persisted
    // principal belongs to a hosting account. Bind only from the sealed session;
    // request mailbox selectors must never grant account-owner authority.
    const authorizedCaller = nativeMailboxSession && !recoveryRoute
      ? await (async () => {
        const record = await authorizeMailboxSessionBinding(deps.db, deps.store, caller)
        return Object.freeze({
          ...caller,
          principal: Object.freeze({ ...caller.principal, accountId: record.accountId }),
          principalKind: 'mailbox' as const,
          mailbox: record.mailbox,
          serviceUserId: record.serviceUserId,
        })
      })()
      : caller
    await assertRequestAuthorized(deps.store, authorizedCaller, req)
    return authorizedCaller
  }

  const assertRoot = async (caller: AuthenticatedCaller, action: string): Promise<void> => {
    if (caller.principal.kind !== 'root') {
      await emitAudit({
        actor: caller.principal.username,
        action: 'rbac.denied',
        target: action,
        detail: { requiredRole: 'root', actualRole: caller.principal.kind },
        outcome: 'denied',
        principalId: caller.principal.id,
      })
      return fail('FORBIDDEN', 'root role is required for this operation')
    }
  }

  const assertCanAccessAccount = async (
    caller: AuthenticatedCaller,
    account: Account,
    action: string,
    opts?: { allowUserSelf?: boolean },
  ): Promise<void> => {
    await assertAccountAuthorized(deps.store, caller, account, action, opts?.allowUserSelf ?? true)
  }

  const updateContactMetadata = async (
    req: Request,
    caller: AuthenticatedCaller,
    target: Account,
    contactEmail: unknown,
    expectedRevision: string,
    self: boolean,
  ): Promise<Account> => {
    const deferred: Parameters<typeof emitAudit>[0][] = []
    let currentCaller = caller
    let updated: Account
    try {
      updated = await deps.store.updateAccountContactEmail(target.id, contactEmail, {
        expectedContactRevision: expectedRevision,
        authorize: async account => {
          const fresh = await requireCaller(req, { deferDeniedAudit: input => { deferred.push(input) } })
          if (fresh.principal.id !== caller.principal.id || fresh.principal.kind !== caller.principal.kind || isMailboxPrincipal(fresh)) {
            return fail('FORBIDDEN', 'account contact authorization changed')
          }
          if (self && (fresh.principal.kind !== 'user' || fresh.principal.accountId !== account.id || account.status !== 'active')) {
            return fail('FORBIDDEN', 'active hosting account owner access is required')
          }
          await assertCanAccessAccount(fresh, account, 'account.contact.update', { allowUserSelf: self })
          if (self) await assertAccountFeatures(deps.store, fresh, account, ['account-preferences'])
          currentCaller = fresh
        },
        prepareIndex: account => prepareAccountContactIndexRollback(deps.db, account.id),
        synchronizeIndex: account => syncAccountContactIndex(deps.db, account),
      })
    } finally {
      // Denial audit privacy resolution may read a snapshot, so flush only after
      // the StateStore writer lease has been released. No authorization is skipped.
      for (const input of deferred) await emitAudit(input)
    }
    try {
      await emitAudit({ actor: currentCaller.principal.username, action: 'account.contact.updated', target: 'account:' + updated.username,
        detail: { contactEmail: updated.contactEmail }, outcome: 'ok', principalId: currentCaller.principal.id,
      }, { accountId: updated.id, resellerId: updated.ownerId })
    } catch {
      return fail('SERVICE_UNAVAILABLE', 'account contact audit requires verification', {
        reason: 'contact_audit_failed', stateChanged: true, verificationRequired: true, unknownOutcome: true,
      })
    }
    return updated
  }

  const assertCanBindCertificate = async (caller: AuthenticatedCaller, account: Account): Promise<void> => {
    if (caller.apiTokenId !== null) assertApiScope(caller, 'tls:write')
    if (caller.principal.kind === 'reseller') assertAcl(caller.principal, await resolveResellerForCaller(caller), 'manage-ssl')
    await assertAccountFeatures(deps.store, caller, account, ['ssl-install'])
  }

  const resolveAccountParam = async (idOrUsername: string): Promise<Account> => {
    const byId = await deps.store.getAccount(idOrUsername)
    if (byId) return byId
    const byUsername = await deps.store.getAccountByUsername(idOrUsername.toLowerCase())
    if (byUsername) return byUsername
    return fail('NOT_FOUND', `account "${idOrUsername}" not found`)
  }

  const callAgent = async (
    pathAndQuery: string,
    opts: {
      method?: string
      body?: unknown
      caller: AuthenticatedCaller
      /** Socket or trusted-ingress client address for the protected ingress provider; never a browser header. */
      managementClient?: string | null
    },
  ): Promise<Response> => {
    const agentApp = deps.agentApp
    if (!agentApp) {
      return fail('PRECONDITION_FAILED', 'privileged host agent is not connected')
    }
    if (!deps.agentToken) return fail('PRECONDITION_FAILED', 'protected agent service credentials are required')
    const method = opts.method ?? 'GET'
    const headers: Record<string, string> = {
      ...agentCallerHeaders({
        principalId: opts.caller.principal.id,
        token: deps.agentToken,
      }),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.managementClient ? { 'x-xpanel-management-client': opts.managementClient } : {}),
    }
    return agentApp.fetch(
      new Request(`http://agent.local${pathAndQuery}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }),
    )
  }

  const triggerReconcile = async (
    caller: AuthenticatedCaller,
    opts?: { force?: boolean; scope?: LiveEventScope },
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | null> => {
    if (!deps.agentApp) {
      const snap = await deps.store.readSnapshot()
      await reindexFromState(deps.db, snap)
      return null
    }
    const res = await callAgent('/state/apply', {
      method: 'POST',
      caller,
      body: {
        force: Boolean(opts?.force),
      },
    })
    const body = (await res.json()) as Record<string, unknown>
    return { ok: res.ok, status: res.status, body }
  }

  const requireAccountHostAgent = (): void => {
    if (!deps.agentApp || !deps.agentToken) {
      fail('PRECONDITION_FAILED', 'a protected host agent connection is required for account changes', {
        verificationRequired: true, reason: 'host_agent_unavailable', stateChanged: false,
      })
    }
  }

  const accountMutationFailure = async (
    caller: AuthenticatedCaller,
    account: Account,
    action: string,
    outcome: 'failed' | 'unknown' | 'not_applied',
    reason: string,
    code: ErrorCode = 'SERVICE_UNAVAILABLE',
    hostStatus?: number,
  ): Promise<never> => {
    const detail = { verificationRequired: true, needsAttention: true, stateChanged: true,
      hostOutcome: outcome, reason, ...(hostStatus === undefined ? {} : { hostStatus }) }
    await emitAudit({ actor: caller.principal.username, action: 'account.' + action + '.configuration_failed',
      target: 'account:' + account.username, detail, outcome: 'failed', principalId: caller.principal.id,
    }, { accountId: account.id, resellerId: account.ownerId })
    return fail(code, 'account configuration requires verification before further action', detail)
  }

  const captureAccountMutation = async (
    caller: AuthenticatedCaller,
    targetId: Id,
    action: string,
    validate?: (account: Account) => void | Promise<void>,
    beforeRelease?: (account: Account) => Promise<void>,
  ): Promise<{ account: Account; expectedRevision: number }> => {
    const lease = await deps.store.getWriterLock().acquire()
    try {
      const account = await deps.store.getAccount(targetId)
      if (!account) return fail('NOT_FOUND', 'account not found')
      await assertCanAccessAccount(caller, account, action, { allowUserSelf: false })
      if (account.status === 'terminating') return fail('PRECONDITION_FAILED', 'account termination requires attention')
      await validate?.(account)
      await beforeRelease?.(account)
      const authority = await lease.assertFencingToken()
      return { account, expectedRevision: authority.revision }
    } finally { await lease.release() }
  }

  const readAccountApplyBody = async (response: Response): Promise<Record<string, unknown> | null> => {
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > 65_536) { await reader.cancel(); return null }
        chunks.push(next.value)
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    } finally { reader.releaseLock() }
  }

  const applyAccountConfiguration = async (
    caller: AuthenticatedCaller, account: Account, action: string, expectedRevision: number,
  ): Promise<{ status: 'applied'; generation: { id: number; status: 'active'; checksum: string }; filesCount: number; durationMs: number }> => {
    let response: Response
    try { response = await callAgent('/state/apply', { method: 'POST', caller, body: { force: false } }) }
    catch { return accountMutationFailure(caller, account, action, 'unknown', 'host_transport_unknown') }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      return accountMutationFailure(caller, account, action, 'failed', 'host_apply_rejected', response.status === 422 ? 'CONFIG_TEST_FAILED' : 'SERVICE_UNAVAILABLE', response.status)
    }
    let body: Record<string, unknown> | null
    try { body = await readAccountApplyBody(response) }
    catch { return accountMutationFailure(caller, account, action, 'unknown', 'host_reply_unverified') }
    if (body?.status === 'failed') return accountMutationFailure(caller, account, action, 'failed', 'host_apply_failed', 'CONFIG_TEST_FAILED')
    if (body?.status === 'noop') return accountMutationFailure(caller, account, action, 'not_applied', 'host_apply_not_verified', 'PRECONDITION_FAILED')
    const generation = body?.generation
    const gen = generation !== null && typeof generation === 'object' && !Array.isArray(generation) ? generation as Record<string, unknown> : null
    if (body?.status !== 'applied' || !gen || !Number.isSafeInteger(gen.id) || Number(gen.id) < 1 || gen.status !== 'active'
      || typeof gen.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(gen.checksum)
      || !Number.isSafeInteger(body.filesCount) || Number(body.filesCount) < 0
      || typeof body.durationMs !== 'number' || !Number.isFinite(body.durationMs) || body.durationMs < 0) {
      return accountMutationFailure(caller, account, action, 'unknown', 'host_reply_unverified')
    }
    if (await deps.store.getRevision() !== expectedRevision) {
      return accountMutationFailure(caller, account, action, 'unknown', 'state_changed_during_apply', 'CONFLICT')
    }
    return { status: 'applied', generation: { id: Number(gen.id), status: 'active', checksum: gen.checksum }, filesCount: Number(body.filesCount), durationMs: body.durationMs }
  }

  const accountExecution = () => ({ status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } as const)

  const observeAccountExecution = async (caller: AuthenticatedCaller, ipv4: string) => {
    const pending = accountExecution()
    try {
      const response = await callAgent('/host/addresses', { caller })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return pending
      }
      const body = await response.json() as { addresses?: unknown }
      const seen = Array.isArray(body.addresses) && body.addresses.includes(ipv4)
      if (!seen) return pending
      return { status: 'configuration_applied' as const, scope: 'global_configuration' as const, targetVerified: true, verificationRequired: false, hostBinding: 'observed' as const, observedAddress: ipv4 }
    } catch {
      return pending
    }
  }

  const publicDomainRevision = (revision: string): string => createHmac('sha256', serverSecret)
    .update('xpanel-domain-view:v1\0').update(revision).digest('hex')

  const domainWorkspaceView = (workspace: DomainWorkspaceRead, application: {
    status: 'unverified' | 'not_requested' | 'global_configuration_applied'; targetVerified: false
  } = { status: 'unverified', targetVerified: false }) => {
    const { source } = workspace
    return { context: { accountId: source.account.id, home: source.account.home }, revision: publicDomainRevision(workspace.revision),
      domains: source.domains, limits: { addonDomains: source.plan.caps.addonDomains,
        aliasDomains: source.plan.caps.aliasDomains, subdomains: source.plan.caps.subdomains },
      removals: source.dependencies.map(dependency => ({ ...dependency,
        canRemove: source.domains.find(domain => domain.id === dependency.domainId)?.kind !== 'primary'
          && dependency.childCount === 0 && dependency.serviceUserCount === 0 })), application }
  }

  const mutateDomainWorkspace = async <T>(req: Request, caller: AuthenticatedCaller, account: Account,
    expected: unknown, action: string, mutate: (options: DomainMutationOptions) => Promise<T>, certificate = false, removedName?: string,
  ) => {
    const self = caller.principal.kind === 'user'
    const guarded = self || expected !== undefined
    const workspace = await deps.store.readDomainWorkspace(account.id)
    if (guarded) {
      if (expected === undefined) return fail('PRECONDITION_FAILED', 'reload the domain workspace before changing it', { stateChanged: false })
      if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) return fail('VALIDATION', 'invalid domain workspace revision', { stateChanged: false })
      if (expected !== publicDomainRevision(workspace.revision)) return fail('CONFLICT', 'domain workspace changed; reload before retrying', { stateChanged: false })
    }
    let currentCaller = caller
    let committedRevision: number | undefined
    const deferred: Parameters<typeof emitAudit>[0][] = []
    try {
      let value: T
      try {
        value = await mutate({ domainGuard: {
          accountId: account.id, expectedRevision: workspace.revision, safeLeaf: guarded,
          authorize: async (freshAccount, currentDomain) => {
            const fresh = await requireCaller(req, { deferDeniedAudit: input => { deferred.push(input) } })
            if (fresh.principal.id !== caller.principal.id || fresh.principal.kind !== caller.principal.kind || isMailboxPrincipal(fresh)) fail('FORBIDDEN', 'domain authorization changed', { stateChanged: false })
            if (self && (fresh.principal.kind !== 'user' || fresh.principal.accountId !== freshAccount.id || freshAccount.status !== 'active')) fail('FORBIDDEN', 'active hosting account owner access is required', { stateChanged: false })
            if (guarded && freshAccount.status !== 'active') fail('FORBIDDEN', 'active hosting account access is required', { stateChanged: false })
            if (guarded && action === 'domain.deleted' && (!currentDomain || currentDomain.name !== removedName)) fail('CONFLICT', 'domain confirmation changed; reload before retrying', { stateChanged: false })
            await assertCanAccessAccount(fresh, freshAccount, action)
            await assertAccountFeatures(deps.store, fresh, freshAccount, ['domains'])
            if (certificate) await assertCanBindCertificate(fresh, freshAccount)
            currentCaller = fresh
          },
          prepareProjection: transition => prepareDomainIndexTransition(deps.db, transition),
          onCommitted: revision => { committedRevision = revision },
        } })
      } finally { for (const input of deferred) await emitAudit(input) }
      let reconcile: Awaited<ReturnType<typeof applyAccountConfiguration>> | null = null
      let application: { status: 'not_requested' | 'global_configuration_applied'; targetVerified: false } = { status: 'not_requested', targetVerified: false }
      if (deps.agentApp) {
        const dispatchCaller = await requireCaller(req)
        const dispatchAccount = await deps.store.getAccount(account.id)
        if (!dispatchAccount || dispatchCaller.principal.id !== caller.principal.id || dispatchCaller.principal.kind !== caller.principal.kind || isMailboxPrincipal(dispatchCaller)
          || (self && (dispatchCaller.principal.kind !== 'user' || dispatchCaller.principal.accountId !== account.id || dispatchAccount.status !== 'active'))
          || (guarded && dispatchAccount.status !== 'active')) return fail('FORBIDDEN', 'domain authorization changed before application')
        await assertCanAccessAccount(dispatchCaller, dispatchAccount, action)
        await assertAccountFeatures(deps.store, dispatchCaller, dispatchAccount, ['domains'])
        if (certificate) await assertCanBindCertificate(dispatchCaller, dispatchAccount)
        currentCaller = dispatchCaller
        reconcile = await applyAccountConfiguration(currentCaller, account, action, committedRevision!)
        application = { status: 'global_configuration_applied', targetVerified: false }
      }
      const targetName = value !== null && typeof value === 'object' && 'name' in value && typeof value.name === 'string' ? value.name : removedName
      await emitAudit({ actor: currentCaller.principal.username, action,
        target: targetName ? 'domain:' + targetName : 'account:' + account.username, outcome: 'ok', principalId: currentCaller.principal.id,
      }, { accountId: account.id, resellerId: account.ownerId })
      return { value, reconcile, view: domainWorkspaceView(await deps.store.readDomainWorkspace(account.id), application) }
    } catch (error) {
      if (committedRevision === undefined) throw error
      return fail(isXpanelError(error) ? error.code : 'SERVICE_UNAVAILABLE', 'domain configuration requires verification', {
        ...(isXpanelError(error) ? error.detail : {}), stateChanged: true, verificationRequired: true, unknownOutcome: true,
      })
    }
  }

  const mutateDatabaseWorkspace = async <T extends { name: string }>(req: Request, caller: AuthenticatedCaller,
    account: Account, action: string, targetKind: 'database' | 'database-user',
    operation: (options: DatabaseMutationOptions) => Promise<T>, toolId = 'mysql-databases') => {
    const deferred: Parameters<typeof emitAudit>[0][] = []
    const self = caller.principal.kind === 'user'
    let currentCaller = caller
    let currentAccount = account
    let possibleChange = false
    let committedRevision: number | undefined
    try {
      let value: T
      try {
        value = await operation({
          authorize: async freshAccount => {
            const fresh = await requireCaller(req, { deferDeniedAudit: input => { deferred.push(input) } })
            if (freshAccount.id !== account.id) return fail('FORBIDDEN', 'database account binding changed')
            if (fresh.principal.id !== caller.principal.id || fresh.principal.kind !== caller.principal.kind || isMailboxPrincipal(fresh)) return fail('FORBIDDEN', 'database authorization changed')
            if (self && (fresh.principal.kind !== 'user' || fresh.principal.accountId !== freshAccount.id || freshAccount.status !== 'active')) return fail('FORBIDDEN', 'active hosting account owner access is required')
            await assertCanAccessAccount(fresh, freshAccount, action)
            await assertAccountFeatures(deps.store, fresh, freshAccount, [toolId])
            currentCaller = fresh
            currentAccount = freshAccount
          },
          onMutationStarted: () => { possibleChange = true },
          onCommitted: revision => { committedRevision = revision },
        })
      } finally { for (const input of deferred) await emitAudit(input) }
      let reconcile: Awaited<ReturnType<typeof applyAccountConfiguration>> | null = null
      let application: { status: 'not_requested' | 'global_configuration_applied'; targetVerified: false } = { status: 'not_requested', targetVerified: false }
      if (deps.agentApp) {
        const fresh = await requireCaller(req)
        const freshAccount = await deps.store.getAccount(account.id)
        if (!freshAccount || fresh.principal.id !== caller.principal.id || fresh.principal.kind !== caller.principal.kind || isMailboxPrincipal(fresh)
          || (self && (fresh.principal.kind !== 'user' || fresh.principal.accountId !== freshAccount.id || freshAccount.status !== 'active'))) return fail('FORBIDDEN', 'database authorization changed before application')
        await assertCanAccessAccount(fresh, freshAccount, action)
        await assertAccountFeatures(deps.store, fresh, freshAccount, [toolId])
        if (await deps.store.getRevision() !== committedRevision) return fail('CONFLICT', 'configuration changed before database application')
        currentCaller = fresh
        currentAccount = freshAccount
        reconcile = await applyAccountConfiguration(fresh, freshAccount, action, committedRevision!)
        application = { status: 'global_configuration_applied', targetVerified: false }
      }
      await emitAudit({ actor: currentCaller.principal.username, action, target: targetKind + ':' + value.name,
        detail: { application: application.status, targetVerified: false }, outcome: 'ok', principalId: currentCaller.principal.id,
      }, { accountId: currentAccount.id, resellerId: currentAccount.ownerId })
      return { value, context: { accountId: currentAccount.id }, application, reconcile }
    } catch (error) {
      if (committedRevision === undefined && isXpanelError(error) && error.detail.stateChanged === false) throw error
      if (possibleChange || committedRevision !== undefined) {
        return fail(isXpanelError(error) ? error.code : 'SERVICE_UNAVAILABLE', 'database configuration requires verification', {
          ...(isXpanelError(error) ? error.detail : {}), stateChanged: true, verificationRequired: true, unknownOutcome: true,
        })
      }
      if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
      throw error
    }
  }

  const mailboxFolderDependencies = async (req: Request, caller: AuthenticatedCaller, transport: MailboxTransport) => {
    const access = await authorizeNativeMailboxRequest(req), opened = access.opened
    if (access.caller.principal.id !== caller.principal.id || access.caller.principal.kind !== caller.principal.kind || access.caller.sessionId !== caller.sessionId || access.caller.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'mailbox authorization changed', { stateChanged: false })
    return { transport, opened, authorize: async (context: Readonly<FolderWorkspaceAuthorization>) => {
      const current = (await authorizeNativeMailboxRequest(req)).opened
      if (current.record.accountId !== opened.record.accountId || current.record.serviceUserId !== opened.record.serviceUserId
        || current.record.mailbox !== opened.record.mailbox || context.mailbox !== opened.record.mailbox
        || current.password !== opened.password) return fail('FORBIDDEN', 'mailbox session changed; sign in again', { stateChanged: false })
    } }
  }

  const nativeMailboxRequests = new WeakMap<Request, { caller: AuthenticatedCaller; opened: Awaited<ReturnType<typeof openAuthorizedMailboxSession>> }>()
  const authorizeNativeMailboxRequest = async (req: Request, toolIds: readonly string[] = []) => {
    const caller = await requireCaller(req)
    if (!isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'a signed-in sealed mailbox is required', { stateChanged: false })
    const opened = await openAuthorizedMailboxSession(deps.db, deps.store, serverSecret, caller)
    const previous = nativeMailboxRequests.get(req)
    if (previous && (previous.caller.principal.id !== caller.principal.id || previous.caller.principal.kind !== caller.principal.kind
      || previous.caller.sessionId !== caller.sessionId || previous.caller.apiTokenId !== caller.apiTokenId
      || previous.opened.record.sessionId !== opened.record.sessionId || previous.opened.record.accountId !== opened.record.accountId
      || previous.opened.record.serviceUserId !== opened.record.serviceUserId || previous.opened.record.mailbox !== opened.record.mailbox
      || previous.opened.password !== opened.password)) return fail('FORBIDDEN', 'mailbox authorization or credentials changed; sign in again', { stateChanged: false })
    if (toolIds.length) {
      const account = await deps.store.getAccount(opened.record.accountId)
      if (!account || account.status !== 'active') return fail('FORBIDDEN', 'mailbox account is unavailable', { stateChanged: false })
      await assertAccountFeatures(deps.store, caller, account, ['email-accounts', ...toolIds])
    }
    if (!previous) nativeMailboxRequests.set(req, { caller, opened })
    return { caller, opened }
  }
  const nativeComposeBody = async (req: Request, draft: boolean): Promise<Record<string, unknown>> => {
    const body = await readJsonBody<unknown>(req)
    const allowed = ['to', 'cc', 'bcc', 'subject', 'text', 'html', 'identityId', 'expectedIdentityRevision', 'attachments', ...(draft ? ['expectedDraft'] : [])]
    if (new URL(req.url).search || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !allowed.includes(key))) return fail('VALIDATION', 'compose requires supported content and saved identity fields only; header and mailbox selectors are not accepted', { stateChanged: false })
    return body as Record<string, unknown>
  }
  const resolveNativeComposeIdentity = async (req: Request, body: Record<string, unknown>) => {
    const access = await authorizeNativeMailboxRequest(req), mailbox = access.opened.record.mailbox
    const authority = await captureMailboxMetadataAuthority(deps.store, mailbox)
    if (authority.accountId !== access.opened.record.accountId || authority.serviceUserId !== access.opened.record.serviceUserId || authority.mailbox !== mailbox) return fail('FORBIDDEN', 'mailbox lifetime changed; sign in again', { stateChanged: false })
    const records = body.identityId === undefined && body.expectedIdentityRevision === undefined ? []
      : await readBoundMailboxIdentityRecords(deps.store, mailbox, () => new ExtendedFeaturesStore(deps.store.rootDir).readOrDefault<WebmailIdentity[]>('webmail/identities.json', []))
    return { ...access, identity: resolveComposeIdentity(mailbox, body, records) }
  }
  const nativeDraftRecipients = (value: unknown): string[] => {
    if (value === undefined || value === '') return []
    if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) return fail('VALIDATION', 'draft recipients must be address text', { stateChanged: false })
    const values = [...new Set(value.split(/[,;]/).map(address => address.trim().toLowerCase()).filter(Boolean))]
    if (values.length > 200) return fail('VALIDATION', 'draft recipient count exceeds the supported limit', { stateChanged: false })
    return values
  }
  const handleNativeAttachmentRequest = createAttachmentWorkspaceRoutes({
    secret: serverSecret, env: mailboxEnvironment,
    open: async req => (await authorizeNativeMailboxRequest(req, ['webmail-attachments'])).opened,
    source: deps.mailAttachmentSource ?? (deps.mailboxTransport ? { read: async () => fail('PRECONDITION_FAILED', 'an actual mailbox attachment source has not been configured', { stateChanged: false }) } : undefined),
    audit: async (req, event) => {
      const { caller, opened } = await authorizeNativeMailboxRequest(req, ['webmail-attachments'])
      const account = await deps.store.getAccount(opened.record.accountId)
      if (!account || event.mailbox !== opened.record.mailbox) return fail('FORBIDDEN', 'mailbox attachment authorization changed', { stateChanged: false })
      await emitAudit({ actor: caller.principal.username, action: 'webmail.attachment.downloaded', target: 'mailbox:' + event.mailbox,
        detail: { folder: event.folder, uid: event.uid, filename: event.filename, sizeBytes: event.sizeBytes, sha256: event.sha256 }, outcome: 'ok', principalId: caller.principal.id },
      { accountId: account.id, resellerId: account.ownerId })
    },
  })

  const ownedDatabaseName = (username: string, raw: unknown): string => {
    if (typeof raw !== 'string' || raw.trim().length === 0) return fail('VALIDATION', 'database name is required')
    const name = raw.trim().toLowerCase()
    return name.startsWith(`${username}_`) ? name : `${username}_${name}`
  }

  const mysqlNativePasswordHash = (password: string): string => {
    if (password.length < 8 || password.length > 256) return fail('VALIDATION', 'database password must be 8 to 256 characters')
    return `*${createHash('sha1').update(createHash('sha1').update(password).digest()).digest('hex').toUpperCase()}`
  }

  const recordFailedLoginAndMaybeLock = async (
    username: string,
    ip: string,
    reason: string,
    principalId?: Id | null,
  ): Promise<void> => {
    const failure = await recordLoginFailure(deps.db, { username, ip, reason, surface: 'panel', threshold: lockoutThreshold, windowMs: lockoutDurationMs, lockoutDurationMs })
    if (failure.lockedUntil) {
      const failures = Math.max(failure.usernameFailures, failure.ipFailures)
      await emitAudit({ actor: username, action: 'auth.lockout', target: 'authentication', detail: { failures, lockedUntil: failure.lockedUntil }, outcome: 'denied', principalId: principalId ?? null, ip })
      return fail('FORBIDDEN', 'too many failed authentication attempts', { lockedOut: true, failures, lockedUntil: failure.lockedUntil })
    }
  }

  const readDkimPublicMaterial = async (caller: AuthenticatedCaller, domain: string): Promise<{ selector: string; publicKeyPem: string } | null> => {
    if (!deps.agentApp || !deps.agentToken) return null
    try {
      const response = await deps.agentApp.fetch(new Request('http://agent.local/host/dkim-public?domain=' + encodeURIComponent(domain), {
        headers: agentCallerHeaders({ principalId: caller.principal.id, token: deps.agentToken }),
      }))
      if (!response.ok) return null
      const text = await response.text()
      if (text.length > 20_000) return null
      const body = JSON.parse(text) as { selector?: unknown; publicKeyPem?: unknown }
      if (typeof body.selector !== 'string' || typeof body.publicKeyPem !== 'string'
        || body.selector.length > 63 || body.publicKeyPem.includes('PRIVATE KEY')) return null
      return { selector: body.selector, publicKeyPem: body.publicKeyPem }
    } catch { return null }
  }
  const extendedRouter = createExtendedApiRouter({
    db: deps.db,
    store: deps.store,
    serverSecret,
    backupDestinationHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined),
    ...(deps.agentApp && deps.agentToken ? { transferExecution: createTransferExecution({
      store: deps.store, readToken: id => readTransferCredentialToken(deps.store, id),
      // The archive body is streamed to the agent, never buffered here; the agent checks its size and SHA-256.
      importArchive: (caller, username, body, expected) => deps.agentApp!.fetch(new Request('http://agent.local/transfers/destination/accounts/' + username + '/archives', { method: 'POST', body, duplex: 'half',
        headers: { ...agentCallerHeaders({ principalId: caller.principal.id, token: deps.agentToken! }), 'content-type': 'application/gzip', 'x-xpanel-archive-bytes': String(expected.bytes), 'x-xpanel-archive-sha256': expected.sha256 } } as RequestInit)),
      createAccount: (caller, input) => createLifecycleAccount(caller, input, { store: deps.store, db: deps.db, php: defaultPhp('8.3'), hashPassword: password => passwordHashFromInput({ password }),
        readTemplates: () => new ExtendedFeaturesStore(deps.store.rootDir).readOrDefault<unknown>('accounts/templates.json', null), applyConfiguration: applyAccountConfiguration }),
      restoreArchive: (caller, username, file) => callAgent('/accounts/' + username + '/backups', { caller, method: 'POST', body: { op: 'restore', file } }),
      verifyArchive: (caller, username, file) => callAgent('/transfers/destination/accounts/' + username + '/verify', { caller, method: 'POST', body: { file } }),
      audit: (caller, action, target, detail, outcome) => emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action, target, detail, outcome }),
    }) } : {}),
    ...(deps.homeBaseDir !== undefined && { homeBaseDir: deps.homeBaseDir }),
    requireCaller,
    assertRoot,
    assertCanAccessAccount,
    resolveAccountParam,
    resolveResellerId,
    emitAudit,
    triggerReconcile,
    readDkimPublicMaterial,
  })

  const accountBackupRouter = createAccountBackupWorkspace({
    authorize: async (req, action) => {
      const caller = await requireCaller(req)
      if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'account backups require the signed-in account owner', { stateChanged: false })
      const account = await deps.store.getAccount(caller.principal.accountId)
      if (!account || account.status !== 'active') return fail('NOT_FOUND', 'account is unavailable', { stateChanged: false })
      await assertCanAccessAccount(caller, account, action)
      await assertAccountFeatures(deps.store, caller, account, [action === 'backup.preview' || action === 'backup.restore' ? 'backup-restoration' : 'backup'])
      return { account, caller }
    },
    requestAgent: (context, suffix, input) => callAgent('/accounts/' + context.account.username + '/backup-workspace' + suffix, { caller: context.caller, ...input }),
    audit: async (context, action, file, outcome) => { await emitAudit({ actor: context.caller.principal.username, principalId: context.caller.principal.id, action, target: 'account:' + context.account.username, detail: { ...(file ? { file } : {}) }, outcome }, { accountId: context.account.id, resellerId: context.account.ownerId }) },
  })
  const quarantineGateway: QuarantineGateway | undefined = deps.quarantineGateway ?? (deps.agentApp && deps.agentToken ? {
    list: (caller, scope, options) => readNativeWorkspace<Awaited<ReturnType<QuarantineGateway['list']>>>(caller, '/host/mail/quarantine/list', { scope, options }),
    release: (caller, scope, input) => readNativeWorkspace<Awaited<ReturnType<QuarantineGateway['release']>>>(caller, '/host/mail/quarantine/release', { scope, input }, true),
    delete: (caller, scope, input) => readNativeWorkspace<Awaited<ReturnType<QuarantineGateway['delete']>>>(caller, '/host/mail/quarantine/delete', { scope, input }, true),
    expire: (caller, scope, expectedRevision, beforeUid) => readNativeWorkspace<Awaited<ReturnType<QuarantineGateway['expire']>>>(caller, '/host/mail/quarantine/expire', { scope, expectedRevision, ...(beforeUid === undefined ? {} : { beforeUid }) }, true),
  } : undefined)
  const quarantineRouter = createQuarantineRoutes({
    store: deps.store, requireCaller, emitAudit,
    ...(quarantineGateway ? { gateway: quarantineGateway } : {}),
    requireAccountId: async (caller, requested, action) => {
      if (isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'hosting authorization is required', { stateChanged: false })
      const id = caller.principal.kind === 'user' ? caller.principal.accountId : requested
      if (!id || !isUuid(id)) return fail('VALIDATION', 'select an authorized account', { stateChanged: false })
      if (caller.principal.kind === 'user' && requested && requested !== id) return fail('FORBIDDEN', 'account selector does not match the signed-in owner', { stateChanged: false })
      const account = await deps.store.getAccount(id)
      if (!account) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
      await assertCanAccessAccount(caller, account, action)
      return account.id
    },
  })

  const readNativeWorkspace = async <T>(caller: AuthenticatedCaller, path: string, input?: unknown, mutation = false, method = 'POST', managementClient: string | null = null): Promise<T> => {
    let response: Response
    try { response = await callAgent(path, { caller, ...(input === undefined ? {} : { method, body: input }), ...(managementClient ? { managementClient } : {}) }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'protected host transport could not be verified', { stateChanged: mutation, verificationRequired: mutation, unknownOutcome: mutation }) }
    if (!response.body) return fail('SERVICE_UNAVAILABLE', 'protected host response is missing', { stateChanged: mutation, verificationRequired: mutation, unknownOutcome: mutation })
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
    let body: unknown
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error('host_response_limit') }; chunks.push(next.value) }
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    } catch { return fail('SERVICE_UNAVAILABLE', 'protected host response could not be verified', { stateChanged: mutation, verificationRequired: mutation, unknownOutcome: mutation }) }
    finally { reader.releaseLock() }
    if (!response.ok) {
      const problem = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
      const detail = problem.details && typeof problem.details === 'object' && !Array.isArray(problem.details) ? problem.details as Record<string, unknown> : {}
      const knownUnchanged = detail.stateChanged === false && detail.unknownOutcome !== true && detail.verificationRequired !== true
      const code: ErrorCode = response.status === 401 ? 'UNAUTHENTICATED' : response.status === 403 ? 'FORBIDDEN' : response.status === 404 ? 'NOT_FOUND' : response.status === 409 ? 'CONFLICT' : response.status === 422 ? 'VALIDATION' : 'PRECONDITION_FAILED'
      return fail(code, 'the protected host request was refused', { stateChanged: mutation && !knownUnchanged, ...(mutation && !knownUnchanged ? { unknownOutcome: true, verificationRequired: true } : {}) })
    }
    return body as T
  }
  // sec: WAF, flood, panel access and DNS cluster workspaces; panelAccessEnforced is true because the request gate below is installed.
  const secHelpers = (): SecWorkspaceHelpers => ({ requireCaller, assertRoot, emitAudit, triggerReconcile, store: deps.store, panelAccessEnforced: true,
    readClient: request => { let address: string | null = null; try { address = extractClientIp(request) } catch { address = null }; return { listener: entryPoint ?? null, address } },
    ...(deps.agentApp && deps.agentToken ? { callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}),
  })
  const cronHost = async (caller: AuthenticatedCaller, intent: CronJobIntent, operation: 'status' | 'run'): Promise<CronJobObservationReceipt> => {
    const account = await deps.store.getAccount(intent.accountId)
    if (!account || account.status !== 'active' || caller.principal.kind !== 'user' || isMailboxPrincipal(caller) || caller.principal.accountId !== account.id) return fail('FORBIDDEN', 'cron account is unavailable', { stateChanged: false })
    return readNativeWorkspace(caller, '/accounts/' + account.username + '/cron/' + intent.jobId + '/' + operation, intent, operation === 'run')
  }
  const siteHealthDns = systemSiteHealthDns()
  const networkToolsGate = createNetworkToolsGate()
  const cronRouter = createCronWorkspaceRoutes({
    store: deps.store, requireCaller, emitAudit, triggerReconcile,
    ...(deps.os ? { osProfile: deps.os } : {}),
    withCronAccountLease: (id, operation) => deps.store.withCronAccountLease(id, operation),
    admitCronMutation: (caller, account, action) => deps.admitCronMutation ? deps.admitCronMutation(caller, account, action) : fail('PRECONDITION_FAILED', 'cron host admission is unavailable', { stateChanged: false }),
    runCronNow: (caller, intent) => cronHost(caller, intent, 'run'),
    observeCronStatus: (caller, intent) => cronHost(caller, intent, 'status'),
  })

  const certificateRuntimeRouter = createCertificateRuntimeRouter({
    store: deps.store, hostAvailable: Boolean(deps.agentApp && deps.agentToken), requireCaller, assertCanAccessAccount,
    assertCanBindCertificate, resolveResellerForCaller, callAgent, triggerReconcile, emitAudit,
    requireHostAgent: requireAccountHostAgent, readJsonBody, jsonResponse,
  })

  const dynamicDns = createDynamicDnsRoutes({
    store: deps.store, requireCaller, emitAudit,
    readPrincipal: id => getPrincipal(deps.db, id),
    assertUpdateAvailable: async () => {
      if (!deps.agentApp || !deps.agentToken) return fail('PRECONDITION_FAILED', 'DNS publication is unavailable', { stateChanged: false })
      const catalog = await loadQualifiedCatalog({ fetch: request => deps.agentApp!.fetch(request), token: deps.agentToken })
      const dns = catalog.find(tool => tool.id === 'dns-zone-records')
      if (dns?.status !== 'verified' || dns.delivery.status !== 'verified') return fail('PRECONDITION_FAILED', 'DNS publication is unqualified on this host', { stateChanged: false })
      // Keep verified tool delivery and additionally require an uncached current host report.
      const response = await deps.agentApp.fetch(new Request('http://agent.local/health', { headers: { 'x-xpanel-agent-token': deps.agentToken } }))
      const health = response.ok ? await readAccountApplyBody(response) : null, probes = health?.probes
      if (process.env.XPANEL_HOST_QUALIFICATION === 'off' || health?.executor !== 'linux' || !probes || typeof probes !== 'object' || Array.isArray(probes) || (probes as Record<string, unknown>).pdns !== 'passed') return fail('PRECONDITION_FAILED', 'current DNS publication evidence is unavailable', { stateChanged: false })
    },
    reconcile: async (principalId, account) => {
      if (!deps.agentApp || !deps.agentToken) return false
      const owner = await getPrincipal(deps.db, principalId)
      if (!owner || owner.disabled || owner.id !== principalId || owner.kind !== 'user' || owner.accountId !== account.id || owner.username !== account.username) return false
      const currentAccount = await deps.store.getAccount(account.id)
      if (!currentAccount || currentAccount.status !== 'active' || currentAccount.username !== account.username || currentAccount.createdAt !== account.createdAt || currentAccount.ownerId !== account.ownerId || currentAccount.planId !== account.planId) return false
      const snapshot = await deps.store.readSnapshot()
      // The credential authorizes this exact stored owner; no interactive session is synthesized.
      const response = await deps.agentApp.fetch(new Request('http://agent.local/state/apply', { method: 'POST', headers: {
        ...agentCallerHeaders({ principalId: owner.id, token: deps.agentToken }), 'content-type': 'application/json',
      }, body: JSON.stringify({ force: false }) }))
      if (response.status !== 200) { await response.body?.cancel(); return false }
      const ack = await readAccountApplyBody(response), generation = ack?.generation
      if (!ack || !['applied', 'noop'].includes(String(ack.status)) || !generation || typeof generation !== 'object' || Array.isArray(generation)) return false
      const gen = generation as Record<string, unknown>
      if (!Number.isSafeInteger(gen.id) || Number(gen.id) < 1 || gen.status !== 'active' || typeof gen.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(gen.checksum) || ack.status === 'noop' && ack.stateChecksum !== snapshot.checksum) return false
      const [active, source, currentOwner] = await Promise.all([latestActive(deps.db), deps.store.readValidatedGenerationSnapshot(Number(gen.id)), getPrincipal(deps.db, principalId)])
      if (!active) return false
      return active.id === gen.id && active.checksum === gen.checksum && source?.checksum === snapshot.checksum
        && await deps.store.getRevision() === snapshot.revision && !!currentOwner && !currentOwner.disabled && currentOwner.kind === 'user' && currentOwner.accountId === account.id && currentOwner.username === account.username
    },
  })

  const handoffRoutes = createHandoffRoutes({
    db: deps.db, store: deps.store, ...(entryPoint ? { entryPoint } : {}),
    ...(handoffTargetOrigin ? { targetOrigin: handoffTargetOrigin } : {}), ...(handoffIssuerOrigin ? { issuerOrigin: handoffIssuerOrigin } : {}),
    requireCaller: request => requireCaller(request), emitAudit,
    clientIp: request => extractClientIp(request) ?? '127.0.0.1', secureCookies: useSecureCookies, teamMember,
  })

  const routeRequest = async (req: Request, context?: TransportContext): Promise<Response> => {
    if (context) {
      let peer: string | null = null
      if (context.remoteAddress !== undefined) {
        peer = normalizedIp(context.remoteAddress)
        if (!parseIp(peer)) return problemResponse(new Error('invalid transport context'), '/')
      }
      transportPeers.set(req, {
        remoteAddress: peer,
        socketRemoteAddress: context.socketRemoteAddress === undefined ? peer : context.socketRemoteAddress === null ? null : normalizedIp(context.socketRemoteAddress),
        trustedIngress: Boolean(context.trustedIngress),
        tls: Boolean(context.tls),
      })
    }
    const url = new URL(req.url, 'http://localhost')
    const { pathname } = url
    const method = req.method.toUpperCase()
    if (req.body !== null && pathname.startsWith('/api/') && req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return transportProblem(415, 'UNSUPPORTED_MEDIA_TYPE', 'application/json is required', pathname)
    }

    try {
      if (publicOrigin && url.host !== new URL(publicOrigin).host) {
        if (prefersDocumentHtml(req, pathname, method)) return renderTransportStatus(req, 421)
        return transportProblem(421, 'MISDIRECTED_REQUEST', 'request host does not match this entry point', pathname)
      }
      if (entryPoint && pathname.startsWith('/api/') && !entryPointAllowsApiRoute(entryPoint, pathname, method)) return transportProblem(404, 'NOT_FOUND', 'route is unavailable on this entry point', pathname)
      if (entryPoint && pathname !== '/api/health' && deps.requireSecureCookies && !isVerifiedHttps(req)) return transportProblem(403, 'FORBIDDEN', 'verified HTTPS ingress is required for this entry point', pathname)
      // sec: saved panel-access allowlist for this entry point, checked before sign-in on the socket or trusted-ingress address.
      if (entryPoint && pathname !== '/api/health' && !await secPanelAccessGate(deps.store.rootDir, entryPoint, () => extractClientIp(req))) {
        if (prefersDocumentHtml(req, pathname, method)) return renderTransportStatus(req, 403)
        return transportProblem(403, 'FORBIDDEN', 'this address is not allowed on this entry point', pathname)
      }
      if (pathname === '/nic/update') {
        if (entryPoint !== 'xpanel') return transportProblem(404, 'NOT_FOUND', 'route is unavailable on this entry point', pathname)
        if (!publicOrigin || url.host !== new URL(publicOrigin).host || !isVerifiedHttps(req)) return transportProblem(403, 'FORBIDDEN', 'verified HTTPS ingress and the configured host are required', pathname)
        // Socket peer only: forwarded client headers never select the DDNS source address.
        return (await dynamicDns.update(req, url, transportPeers.get(req)?.socketRemoteAddress ?? null))!
      }
      // ---- Health --------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/health') {
        return jsonResponse({ ok: true })
      }

      // ---- One-time panel handoff ------------------------------------------------------
      const handedOff = await handoffRoutes(req, pathname, method)
      if (handedOff) return handedOff

      // ---- Authentication & 2FA ------------------------------------------------------
      if (method === 'POST' && pathname === '/api/auth/login') {
        const loginOrigin = req.headers.get('origin')?.trim() ?? null
        const loginFetchSite = req.headers.get('sec-fetch-site')?.trim().toLowerCase() ?? null
        const ip = extractClientIp(req) ?? '127.0.0.1'
        if (
          (loginOrigin !== null && !isOriginPermitted(loginOrigin, req)) ||
          (loginOrigin === null && (loginFetchSite === 'cross-site' || deps.requireOriginHeader === true))
        ) {
          await emitAudit({
            actor: 'anonymous',
            action: 'auth.origin_rejected',
            target: '/api/auth/login',
            detail: { origin: loginOrigin, secFetchSite: loginFetchSite },
            outcome: 'denied',
            ip,
          })
          return fail('FORBIDDEN', 'cross-origin authentication request rejected')
        }
        if (deps.requireSecureCookies && !deps.secureCookies && !isVerifiedHttps(req)) {
          return fail('PRECONDITION_FAILED', 'HTTPS ingress is required for secure session cookies')
        }
        const body = await readJsonBody<{
          username?: string
          password?: string
          totpCode?: string
          recoveryCode?: string
        }>(req)
        const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
        const password = typeof body.password === 'string' ? body.password : ''
        if (!username || !password) {
          return fail('VALIDATION', 'username and password are required')
        }

        const activeLockout = await checkLockout(deps.db, { username, ip })
        if (activeLockout) {
          await recordLoginAttempt(deps.db, {
            surface: 'panel',
            username,
            ip,
            success: false,
            reason: 'locked_out',
          })
          await emitAudit({
            actor: username,
            action: 'auth.login_locked',
            target: `principal:${username}`,
            detail: { lockedUntil: activeLockout.lockedUntil },
            outcome: 'denied',
            ip,
          })
          return fail('FORBIDDEN', `too many failed login attempts; locked until ${activeLockout.lockedUntil}`, {
            lockedOut: true,
            lockedUntil: activeLockout.lockedUntil,
          })
        }

        // member@primary-domain on xPanel is a team member; principal usernames never contain "@".
        if ((entryPoint === undefined || entryPoint === 'xpanel') && username.includes('@')) {
          return signInTeamMember({ db: deps.db, serverSecret, store: deps.store, readTeam: readTeamFile, emitAudit,
            recordFailure: reason => recordFailedLoginAndMaybeLock(username, ip, reason, null) },
          { login: username, password, ip, userAgent: req.headers.get('user-agent') ?? 'xpanel-client', ...(entryPoint ? { entryPoint } : {}), secure: useSecureCookies(req), mfaMode: mfaRuntimePolicy.mode })
        }

        if (entryPoint === 'xmail' && username.includes('@')) {
          let established: Awaited<ReturnType<typeof establishMailboxSession>>
          try {
            established = await establishMailboxSession({
              db: deps.db,
              store: deps.store,
              serverSecret,
              transport: deps.mailboxTransport ?? createLocalMailboxTransport(mailboxEnvironment),
              entryPoint,
              mailbox: username,
              password,
              ip,
              userAgent: req.headers.get('user-agent') ?? 'xpanel-client',
            })
          } catch (err) {
            if (isXpanelError(err) && err.code === 'UNAUTHENTICATED') {
              await emitAudit({
                actor: username,
                action: 'auth.login_failed',
                target: `mailbox:${username}`,
                detail: { reason: 'invalid_credentials' },
                outcome: 'denied',
                ip,
              })
              await recordFailedLoginAndMaybeLock(username, ip, 'invalid_credentials', null)
              return fail('UNAUTHENTICATED', 'invalid username or password')
            }
            throw err
          }
          await clearLockout(deps.db, { username })
          await recordLoginAttempt(deps.db, { surface: 'panel', username, ip, success: true })
          await recordLogin(deps.db, established.principal.id)
          const mailboxCsrf = deriveCsrfToken(established.rawToken, serverSecret, entryPoint)
          const mailboxCookie = formatSessionCookie(established.rawToken, {
            entryPoint,
            secure: useSecureCookies(req),
            maxAgeSec: 86_400,
          })
          await emitAudit({
            actor: established.mailbox,
            action: 'auth.login',
            target: `mailbox:${established.mailbox}`,
            detail: { sessionId: established.session.id },
            outcome: 'ok',
            principalId: established.principal.id,
            ip,
          }, { accountId: established.principal.kind === 'user' ? established.principal.accountId : null, resellerId: null })
          return jsonResponse({
            principal: established.principal,
            mailbox: established.mailbox,
            entryPoint,
            home: ENTRY_POINTS[entryPoint].home,
            session: { id: established.session.id, expiresAt: established.session.expiresAt, mfaVerified: established.session.mfaVerified },
            csrfToken: mailboxCsrf,
            passwordChangeRequired: false,
            mfaEnrollmentRequired: false,
            mfaMode: mfaRuntimePolicy.mode,
          }, 200, { 'set-cookie': mailboxCookie })
        }

        const principalRecord = await findPrincipalByUsername(deps.db, username)
        const passwordMatches = await verifyPasswordArgon2id(password, principalRecord?.passwordHash ?? DUMMY_PASSWORD_HASH)
        const passwordValid = principalRecord !== null && !principalRecord.disabled && passwordMatches

        if (!principalRecord || !passwordValid || (entryPoint && !entryPointAdmitsPrincipal(entryPoint, principalRecord))) {
          await emitAudit({
            actor: username,
            action: 'auth.login_failed',
            target: `principal:${username}`,
            detail: { reason: 'invalid_credentials' },
            outcome: 'denied',
            principalId: principalRecord?.id ?? null,
            ip,
          })
          await recordFailedLoginAndMaybeLock(username, ip, 'invalid_credentials', principalRecord?.id ?? null)
          return fail('UNAUTHENTICATED', 'invalid username or password')
        }

        if (principalRecord.kind === 'user' && principalRecord.accountId) {
          const account = await deps.store.getAccount(principalRecord.accountId, { username: principalRecord.username })
          if (!account) return fail('UNAUTHENTICATED', 'hosting account is unavailable')
          if (account.status !== 'active') {
            await emitAudit({
              actor: username,
              action: 'auth.login_denied_suspended',
              target: `account:${account.username}`,
              detail: { status: account.status },
              outcome: 'denied',
              principalId: principalRecord.id,
              ip,
            })
            return fail('FORBIDDEN', `account "${account.username}" is ${account.status}`)
          }
        }

        if (mfaRuntimePolicy.mode !== 'disabled' && principalRecord.totpEnabled && !principalRecord.totpSecretEnc) return fail('PRECONDITION_FAILED', 'two-factor key recovery is required')
        if (mfaRuntimePolicy.mode !== 'disabled' && principalRecord.totpEnabled && principalRecord.totpSecretEnc) {
          const secretBase32 = unsealTotpSecret(principalRecord.totpSecretEnc, serverSecret)
          if (typeof body.totpCode === 'string' && body.totpCode.trim().length > 0) {
            const step = verifyTotpStep(secretBase32, body.totpCode)
            if (step === null || !await consumeTotpStep(deps.db, principalRecord.id, step, principalRecord.totpSecretEnc)) {
              await recordFailedLoginAndMaybeLock(username, ip, 'invalid_totp', principalRecord.id)
              return fail('UNAUTHENTICATED', 'invalid two-factor authentication code')
            }
          } else if (typeof body.recoveryCode === 'string' && body.recoveryCode.trim().length > 0) {
            const consumed = await consumeRecoveryHash(deps.db, principalRecord.id, sha256Hex(body.recoveryCode.trim()))
            if (!consumed) {
              await recordFailedLoginAndMaybeLock(username, ip, 'invalid_recovery_code', principalRecord.id)
              return fail('UNAUTHENTICATED', 'invalid recovery code')
            }
          } else {
            return fail('UNAUTHENTICATED', 'two-factor authentication code required', { mfaRequired: true })
          }
        }

        const rawToken = randomBytes(32).toString('hex')
        const tokenHash = sessionTokenHash(rawToken, entryPoint)
        const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString()
        const session = await createAuthenticatedSession(deps.db, {
          principalId: principalRecord.id,
          tokenHash,
          expiresAt,
          ip,
          userAgent: req.headers.get('user-agent') ?? 'xpanel-client',
          mfaVerified: mfaRuntimePolicy.mode !== 'disabled' && principalRecord.totpEnabled,
          expectedPasswordHash: principalRecord.passwordHash,
          expectedTotpEnabled: principalRecord.totpEnabled,
          expectedSealedSecret: principalRecord.totpSecretEnc,
        })
        if (!session) return fail('UNAUTHENTICATED', 'credentials changed; authenticate again')
        await clearLockout(deps.db, { username })
        await recordLoginAttempt(deps.db, {
          surface: 'panel',
          username,
          ip,
          success: true,
        })
        await recordLogin(deps.db, principalRecord.id)


        const csrfToken = deriveCsrfToken(rawToken, serverSecret, entryPoint)
        const cookie = formatSessionCookie(rawToken, {
          entryPoint,
          secure: useSecureCookies(req),
          maxAgeSec: 86_400,
        })

        const principal =
          principalRecord.kind === 'root'
            ? { kind: 'root' as const, id: principalRecord.id, username: principalRecord.username }
            : principalRecord.kind === 'reseller'
              ? { kind: 'reseller' as const, id: principalRecord.id, username: principalRecord.username }
              : {
                  kind: 'user' as const,
                  id: principalRecord.id,
                  username: principalRecord.username,
                  accountId: principalRecord.accountId!,
                }

        await emitAudit(
          {
            actor: principal.username,
            action: 'auth.login',
            target: `principal:${principal.username}`,
            detail: { sessionId: session.id, mfa: session.mfaVerified, mfaMode: mfaRuntimePolicy.mode },
            outcome: 'ok',
            principalId: principal.id,
            ip,
          },
          {
            accountId: principal.kind === 'user' ? principal.accountId : null,
            resellerId: principal.kind === 'reseller' ? principal.id : null,
          },
        )

        return jsonResponse(
          {
            principal,
            ...(entryPoint ? { entryPoint, home: ENTRY_POINTS[entryPoint].home } : {}),
            session: {
              id: session.id,
              expiresAt: session.expiresAt,
              mfaVerified: session.mfaVerified,
            },
            csrfToken,
            totpEnabled: principalRecord.totpEnabled,
            mfaMode: mfaRuntimePolicy.mode,
            passwordChangeRequired: principalRecord.forcePasswordChange,
            mfaEnrollmentRequired: false,
          },
          200,
          { 'set-cookie': cookie },
        )
      }

      if (pathname === TEAM_PASSWORD_ROUTE) {
        return handleTeamPasswordRoute(req, method, { db: deps.db, store: deps.store, readTeam: readTeamFile, emitAudit, ...(entryPoint ? { entryPoint } : {}),
          originPermitted: isOriginPermitted, requireOriginHeader: deps.requireOriginHeader === true, clientIp: request => extractClientIp(request) ?? '127.0.0.1' })
      }

      if (method === 'POST' && pathname === '/api/auth/logout') {
        const caller = await requireCaller(req, { allowUnverifiedMfa: true, allowInvalidCsrf: true })
        if (caller.sessionId && caller.team) await revokeTeamSession(deps.db, caller.sessionId, new Date())
        else if (caller.sessionId) {
          await deleteMailboxSession(deps.db, caller.sessionId)
          await revokeSession(deps.db, caller.sessionId)
        }
        await emitAudit({
          actor: caller.team?.login ?? caller.principal.username,
          action: 'auth.logout',
          target: caller.team ? `team:${caller.team.login}` : `principal:${caller.principal.username}`,
          outcome: 'ok',
          principalId: caller.principal.id,
          ip: extractClientIp(req),
        })
        return jsonResponse({ ok: true }, 200, {
          'set-cookie': clearSessionCookie({ secure: useSecureCookies(req), entryPoint }),
        })
      }

      if (method === 'GET' && pathname === '/api/auth/me') {
        const caller = await requireCaller(req, { allowUnverifiedMfa: true })
        return jsonResponse({
          ...(entryPoint ? { entryPoint, home: ENTRY_POINTS[entryPoint].home } : {}),
          principal: caller.team ?? caller.principal,
          totpEnabled: caller.team ? false : caller.principalRecord.totpEnabled,
          mfaMode: mfaRuntimePolicy.mode,
          passwordChangeRequired: caller.team ? false : caller.principalRecord.forcePasswordChange,
          mfaEnrollmentRequired: false,
          csrfToken: caller.sessionToken ? deriveCsrfToken(caller.sessionToken, serverSecret, entryPoint) : null,
        })
      }

      // ---- Trusted-self session management -------------------------------------------
      // A signed-in principal may list and revoke only its own interactive sessions.
      // API tokens are rejected: token holders cannot inspect browser sessions.
      if (method === 'GET' && pathname === '/api/auth/sessions') {
        const caller = await requireCaller(req)
        if (caller.apiTokenId !== null) return fail('FORBIDDEN', 'session listing requires an interactive session')
        const sessions = await listSessionsForPrincipal(deps.db, caller.principal.id)
        const now = Date.now()
        return jsonResponse({
          sessions: sessions
            .filter(session => session.revokedAt === null && Date.parse(session.expiresAt) > now)
            .map(session => ({
              id: session.id,
              current: session.id === caller.sessionId,
              ip: session.ip,
              userAgent: session.userAgent,
              mfaVerified: session.mfaVerified,
              createdAt: session.createdAt,
              lastSeenAt: session.lastSeenAt,
              expiresAt: session.expiresAt,
            })),
          currentSessionId: caller.sessionId,
        })
      }

      if (method === 'POST' && pathname === '/api/auth/sessions/revoke-others') {
        const caller = await requireCaller(req)
        if (!caller.sessionId || caller.apiTokenId !== null) return fail('FORBIDDEN', 'revoking other sessions requires an interactive session')
        const revokedCount = await revokeOtherSessionsForPrincipal(deps.db, caller.principal.id, caller.sessionId)
        await emitAudit({
          actor: caller.principal.username,
          action: 'auth.sessions_revoked_others',
          target: `principal:${caller.principal.username}`,
          detail: { revokedCount },
          outcome: 'ok',
          principalId: caller.principal.id,
          ip: extractClientIp(req),
        })
        return jsonResponse({ ok: true, revokedCount })
      }

      const sessionRevokeMatch = /^\/api\/auth\/sessions\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'DELETE' && sessionRevokeMatch) {
        const caller = await requireCaller(req)
        if (!caller.sessionId || caller.apiTokenId !== null) return fail('FORBIDDEN', 'session revocation requires an interactive session')
        const sessionId = sessionRevokeMatch[1]!.toLowerCase()
        const owned = (await listSessionsForPrincipal(deps.db, caller.principal.id))
          .find(session => session.id === sessionId && session.revokedAt === null)
        if (!owned) return fail('NOT_FOUND', 'session not found')
        await revokeSession(deps.db, sessionId)
        await emitAudit({
          actor: caller.principal.username,
          action: 'auth.session_revoked',
          target: `session:${sessionId}`,
          outcome: 'ok',
          principalId: caller.principal.id,
          ip: extractClientIp(req),
        })
        const currentSessionRevoked = sessionId === caller.sessionId
        return jsonResponse({ ok: true, currentSessionRevoked }, 200,
          currentSessionRevoked ? { 'set-cookie': clearSessionCookie({ secure: useSecureCookies(req), entryPoint }) } : {},
        )
      }

      if (method === 'POST' && pathname === '/api/auth/change-password') {
        const caller = await requireCaller(req)
        if (!caller.sessionId || caller.apiTokenId !== null) return fail('FORBIDDEN', 'password changes require an interactive session')
        const body = await readJsonBody<{ currentPassword?: string; newPassword?: string }>(req)
        if (Object.keys(body).some(key => key !== 'currentPassword' && key !== 'newPassword')) return fail('VALIDATION', 'only currentPassword and newPassword are accepted')
        if (typeof body.currentPassword !== 'string' || !body.currentPassword || typeof body.newPassword !== 'string') return fail('VALIDATION', 'current and new passwords are required')
        if (body.currentPassword === body.newPassword) return fail('VALIDATION', 'new password must differ from the current password')
        const ip = extractClientIp(req) ?? '127.0.0.1'
        const activeLockout = await checkLockout(deps.db, { username: caller.principal.username, ip })
        if (activeLockout) return fail('FORBIDDEN', 'too many failed authentication attempts', { lockedOut: true, lockedUntil: activeLockout.lockedUntil })
        if (!await verifyPasswordArgon2id(body.currentPassword, caller.principalRecord.passwordHash)) {
          await recordFailedLoginAndMaybeLock(caller.principal.username, ip, 'invalid_password_change_reauthentication', caller.principal.id)
          return fail('UNAUTHENTICATED', 'current password is incorrect')
        }
        const newPasswordHash = await passwordHashFromInput({ password: body.newPassword })
        const changed = await changePasswordForSession(deps.db, {
          principalId: caller.principal.id,
          sessionId: caller.sessionId,
          expectedPasswordHash: caller.principalRecord.passwordHash,
          newPasswordHash,
          expectedTotpEnabled: caller.principalRecord.totpEnabled,
          expectedSealedSecret: caller.principalRecord.totpSecretEnc,
          expectedForcePasswordChange: caller.principalRecord.forcePasswordChange,
        })
        if (!changed) return fail('UNAUTHENTICATED', 'authentication state changed; authenticate again')
        await emitAudit({ actor: caller.principal.username, action: 'auth.password_changed', target: `principal:${caller.principal.username}`, outcome: 'ok', principalId: caller.principal.id, ip })
        return jsonResponse({ ok: true, reauthenticationRequired: true }, 200, {
          'set-cookie': clearSessionCookie({ secure: useSecureCookies(req), entryPoint }),
        })
      }

      if (method === 'POST' && pathname === '/api/auth/2fa/setup') {
        const caller = await requireCaller(req)
        if (mfaRuntimePolicy.mode === 'disabled') return fail('FORBIDDEN', 'two-factor changes are disabled in development')
        if (!caller.sessionId) return fail('FORBIDDEN', 'two-factor enrollment requires an interactive session')
        if (caller.principalRecord.totpEnabled) return fail('CONFLICT', 'two-factor authentication is already enabled')
        const body = await readJsonBody<{ password?: string }>(req)
        if (typeof body.password !== 'string' || !await verifyPasswordArgon2id(body.password, caller.principalRecord.passwordHash)) return fail('UNAUTHENTICATED', 'current password is required for two-factor enrollment')
        const secret = generateTotpSecret()
        const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(16).toString('hex'))
        const enrollment = await startTotpEnrollment(deps.db, { principalId: caller.principal.id, sessionId: caller.sessionId, expectedPasswordHash: caller.principalRecord.passwordHash, sealedSecret: sealTotpSecret(secret, serverSecret), recoveryHashes: recoveryCodes.map(sha256Hex) })
        const otpauthUrl = `otpauth://totp/xPanel:${encodeURIComponent(caller.principal.username)}?secret=${secret}&issuer=xPanel`
        let qrCodeSvg: string | undefined
        try { qrCodeSvg = renderTotpQrSvg(otpauthUrl) } catch { qrCodeSvg = undefined }
        return jsonResponse({
          secret,
          otpauthUrl,
          ...(qrCodeSvg ? { qrCodeSvg } : {}),
          recoveryCodes,
          expiresAt: enrollment.expiresAt,
        })
      }

      if (method === 'POST' && pathname === '/api/auth/2fa/enable') {
        const caller = await requireCaller(req)
        if (mfaRuntimePolicy.mode === 'disabled') return fail('FORBIDDEN', 'two-factor changes are disabled in development')
        if (!caller.sessionId) return fail('FORBIDDEN', 'two-factor enrollment requires an interactive session')
        const body = await readJsonBody<{ code?: string }>(req)
        if (Object.keys(body).some(key => key !== 'code')) return fail('VALIDATION', 'only the verification code is accepted')
        const pending = await getPendingTotpEnrollment(deps.db, caller.principal.id, caller.sessionId)
        if (!pending) {
          return fail('PRECONDITION_FAILED', '2FA setup must be initiated before enabling')
        }
        const secret = unsealTotpSecret(pending.sealedSecret, serverSecret)
        const code = typeof body.code === 'string' ? body.code.trim() : ''
        const step = verifyTotpStep(secret, code)
        if (step === null) {
          return fail('VALIDATION', 'invalid TOTP verification code')
        }
        if (!await completeTotpEnrollment(deps.db, { principalId: caller.principal.id, sessionId: caller.sessionId, enrollmentId: pending.enrollmentId, step })) return fail('PRECONDITION_FAILED', 'two-factor enrollment expired or changed')
        await emitAudit({
          actor: caller.principal.username,
          action: 'auth.2fa_enabled',
          target: `principal:${caller.principal.username}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true, totpEnabled: true })
      }

      if (method === 'POST' && pathname === '/api/auth/2fa/disable') {
        const caller = await requireCaller(req)
        if (mfaRuntimePolicy.mode === 'disabled') return fail('FORBIDDEN', 'two-factor changes are disabled in development')
        if (!caller.sessionId) return fail('FORBIDDEN', 'two-factor changes require an interactive session')
        const body = await readJsonBody<{ password?: string; code?: string; recoveryCode?: string }>(req)
        if (typeof body.password !== 'string' || !await verifyPasswordArgon2id(body.password, caller.principalRecord.passwordHash)) return fail('UNAUTHENTICATED', 'current password is required')
        const sealedSecret = caller.principalRecord.totpSecretEnc
        if (!caller.principalRecord.totpEnabled || !sealedSecret) return fail('PRECONDITION_FAILED', 'two-factor authentication is not enabled')
        const step = typeof body.code === 'string' ? verifyTotpStep(unsealTotpSecret(sealedSecret, serverSecret), body.code) : null
        const verified = step !== null
          ? await consumeTotpStep(deps.db, caller.principal.id, step, sealedSecret)
          : typeof body.recoveryCode === 'string' && await consumeRecoveryHash(deps.db, caller.principal.id, sha256Hex(body.recoveryCode.trim()))
        if (!verified) return fail('UNAUTHENTICATED', 'a fresh two-factor code is required')
        if (!await disableTotpForSession(deps.db, { principalId: caller.principal.id, sessionId: caller.sessionId, expectedPasswordHash: caller.principalRecord.passwordHash, expectedSealedSecret: sealedSecret })) return fail('PRECONDITION_FAILED', 'two-factor state changed; authenticate again')
        await emitAudit({
          actor: caller.principal.username,
          action: 'auth.2fa_disabled',
          target: `principal:${caller.principal.username}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true, totpEnabled: false })
      }

      // ---- Live Events & Catalog & Search --------------------------------------------
      if (method === 'GET' && pathname === '/api/events/recent') {
        const caller = await requireCaller(req)
        const subscriber = await buildSubscriberForCaller(caller)
        const limit = Number(url.searchParams.get('limit') ?? '100') || 100
        const afterSeqParam = url.searchParams.get('afterSeq') ?? url.searchParams.get('cursor')
        const afterSeq = afterSeqParam !== null && /^\d+$/.test(afterSeqParam) ? Number(afterSeqParam) : undefined
        const afterId = url.searchParams.get('afterId') ?? undefined
        return jsonResponse(
          hub.resyncFor(subscriber, {
            limit,
            ...(afterSeq !== undefined && { afterSeq }),
            ...(afterId !== undefined && { afterId }),
          }),
        )
      }

      if (method === 'GET' && pathname === '/api/catalog') {
        const caller = await requireCaller(req)
        const context: Parameters<typeof visibleTools>[1] = { principal: caller.principal }
        if (caller.principal.kind === 'user') {
          const account = await deps.store.getAccount(caller.principal.accountId)
          const plan = account ? await deps.store.getPlan(account.planId) : null
          const featureList = plan ? await deps.store.getFeatureList(plan.featureListId) : null
          if (!featureList) return fail('PRECONDITION_FAILED', 'account feature policy is unavailable')
          context.disabledFeatures = new Set(featureList.disabled)
        } else if (caller.principal.kind === 'reseller') {
          const reseller = await resolveResellerForCaller(caller)
          if (!reseller) return fail('FORBIDDEN', 'reseller authorization is unavailable')
          context.reseller = reseller
        }
        const catalog = await loadQualifiedCatalog(
          deps.agentApp && deps.agentToken
            ? { fetch: request => deps.agentApp!.fetch(request), token: deps.agentToken }
            : null,
        )
        return jsonResponse({ tools: visibleTools(catalog, context), groups, navigation: visibleNavigation(context, catalog) })
      }

      if (method === 'GET' && pathname === '/api/search') {
        const caller = await requireCaller(req)
        const q = url.searchParams.get('q') ?? ''
        if (!q.trim()) return jsonResponse({ hits: [] })
        const kindParam = url.searchParams.get('kind')
        const kind =
          kindParam === 'account' || kindParam === 'domain' || kindParam === 'reseller' || kindParam === 'plan'
            ? kindParam
            : undefined
        if (caller.principal.kind === 'root') {
          const hits = await searchIndex(deps.db, q, { ...(kind && { kind }) })
          return jsonResponse({ hits })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const hits = await searchIndex(deps.db, q, {
            ...(resellerId && { ownerId: resellerId }),
            ...(kind && { kind }),
          })
          return jsonResponse({ hits })
        }
        const hits = await searchIndex(deps.db, q, {
          accountId: caller.principal.accountId,
          ...(kind && { kind }),
        })
        return jsonResponse({ hits })
      }

      // ---- Server Settings -----------------------------------------------------------
      if (method === 'GET' && pathname === '/api/server/settings') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.settings.read')
        const [settings, setupComplete] = await Promise.all([
          deps.store.getServerSettings(),
          deps.store.isSetupComplete(),
        ])
        return jsonResponse({ settings, setupComplete })
      }

      if (method === 'PUT' && pathname === '/api/server/settings') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.settings.update')
        const body = await readJsonBody<ServerSettings & { markSetupComplete?: boolean }>(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'server settings must be an object', { stateChanged: false })
        const current = await deps.store.getServerSettings(), policy = current?.defaultSite
        const policyKey = JSON.stringify(policy)
        if (Object.hasOwn(body, 'defaultSite') && JSON.stringify(validateDefaultSitePolicy(body.defaultSite)) !== policyKey) return fail('VALIDATION', 'use the guarded default-site workspace to change its policy', { stateChanged: false })
        const next = { ...body }
        if (policy === undefined) delete next.defaultSite
        else next.defaultSite = policy
        const deferred: Parameters<typeof emitAudit>[0][] = []
        let currentCaller = caller, settings: ServerSettings
        try {
          settings = await deps.store.saveServerSettings(next, { settingsGuard: async fresh => {
            const authorized = await requireCaller(req, { deferDeniedAudit: input => { deferred.push(input) } })
            if (authorized.principal.kind !== 'root' || authorized.principal.id !== caller.principal.id || authorized.sessionId !== caller.sessionId || authorized.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'server settings authorization changed', { stateChanged: false })
            if (JSON.stringify(fresh?.defaultSite) !== policyKey) return fail('CONFLICT', 'default-site policy changed; reload server settings before saving', { stateChanged: false })
            currentCaller = authorized
          } })
        } finally { for (const denied of deferred) await emitAudit(denied) }
        if (body.markSetupComplete !== false) {
          await deps.store.markSetupComplete()
        }
        const reconcile = await triggerReconcile(currentCaller)
        await emitAudit({
          actor: currentCaller.principal.username,
          action: 'server.settings.updated',
          target: 'server:settings',
          detail: { hostname: settings.hostname, engine: settings.engine },
          outcome: 'ok',
          principalId: currentCaller.principal.id,
        })
        return jsonResponse({ settings, reconcile: reconcile?.body ?? null })
      }

      // ---- Feature Lists -------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/feature-lists') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'root') {
          return jsonResponse({ featureLists: await deps.store.listFeatureLists() })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const all = await deps.store.listFeatureLists()
          return jsonResponse({
            featureLists: all.filter((f) => f.ownerId === null || f.ownerId === resellerId),
          })
        }
        return fail('FORBIDDEN', 'user accounts cannot list feature lists')
      }

      if (method === 'POST' && pathname === '/api/feature-lists') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user') return fail('FORBIDDEN', 'user accounts cannot create feature lists')
        const body = await readJsonBody<Omit<FeatureList, 'id'>>(req)
        const ownerId =
          caller.principal.kind === 'reseller' ? await resolveResellerId(caller) : (body.ownerId ?? null)
        const featureList = await deps.store.createFeatureList({
          name: body.name,
          ownerId,
          disabled: body.disabled ?? [],
        })
        await emitAudit({
          actor: caller.principal.username,
          action: 'feature_list.created',
          target: `feature-list:${featureList.id}`,
          detail: { name: featureList.name },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ featureList }, 201)
      }

      const featureListIdMatch = /^\/api\/feature-lists\/([0-9a-f-]{36})$/i.exec(pathname)
      if (featureListIdMatch) {
        const caller = await requireCaller(req)
        const flId = featureListIdMatch[1]!.toLowerCase()
        const existing = await deps.store.getFeatureList(flId)
        if (!existing) return fail('NOT_FOUND', `feature list "${flId}" not found`)
        if (caller.principal.kind !== 'root') {
          const resellerId = await resolveResellerId(caller)
          if (!resellerId || existing.ownerId !== resellerId) {
            return fail('FORBIDDEN', 'not authorized to modify this feature list')
          }
        }
        if (method === 'PATCH') {
          const patch = await readJsonBody<{ name?: string; disabled?: string[] }>(req)
          const featureList = await deps.store.updateFeatureList(flId, patch)
          return jsonResponse({ featureList })
        }
        if (method === 'DELETE') {
          await deps.store.deleteFeatureList(flId)
          return jsonResponse({ ok: true })
        }
      }

      // ---- Plans ---------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/plans') {
        const caller = await requireCaller(req)
        const all = await deps.store.listPlans()
        if (caller.principal.kind === 'root') {
          return jsonResponse({ plans: all })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          return jsonResponse({ plans: all.filter((p) => p.ownerId === null || p.ownerId === resellerId) })
        }
        const acc = await deps.store.getAccount(caller.principal.accountId)
        return jsonResponse({ plans: all.filter((p) => p.id === acc?.planId) })
      }

      if (method === 'POST' && pathname === '/api/plans') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user') return fail('FORBIDDEN', 'user accounts cannot create plans')
        const body = await readJsonBody<Partial<NewPlan> & { name: string }>(req)
        const ownerId =
          caller.principal.kind === 'reseller' ? await resolveResellerId(caller) : (body.ownerId ?? null)

        let featureListId = body.featureListId
        if (!featureListId) {
          const existingFls = await deps.store.listFeatureLists()
          if (existingFls[0]) {
            featureListId = existingFls[0].id
          } else {
            const defaultFl = await deps.store.createFeatureList({
              name: 'Standard',
              ownerId: null,
              disabled: [],
            })
            featureListId = defaultFl.id
          }
        }

        const resources = body.resources ?? {
          diskMb: 10_240,
          bandwidthMbMonth: 102_400,
          ioReadBps: 50_000_000,
          ioWriteBps: 50_000_000,
          ioReadIops: 2000,
          ioWriteIops: 2000,
          memoryMb: 1024,
          maxProcesses: 64,
          cpuPercent: 200,
        }
        const defaultMailboxQuotaMb =
          body.defaultMailboxQuotaMb ??
          (typeof resources.diskMb === 'number' ? Math.min(1024, Math.max(1, resources.diskMb)) : 1024)

        const plan = await deps.store.createPlan({
          name: body.name,
          ownerId,
          featureListId,
          resources,
          caps: body.caps ?? {
            addonDomains: 10,
            aliasDomains: 10,
            subdomains: 20,
            mailboxes: 20,
            forwarders: 20,
            mailingLists: 5,
            ftpAccounts: 10,
            databases: 10,
            phpWorkers: 8,
          },
          dedicatedIp: body.dedicatedIp ?? false,
          shell: body.shell ?? 'jailed',
          defaultMailboxQuotaMb,
        })
        const snap = await deps.store.readSnapshot()
        await reindexFromState(deps.db, snap)
        await emitAudit({
          actor: caller.principal.username,
          action: 'plan.created',
          target: `plan:${plan.id}`,
          detail: { name: plan.name, ownerId: plan.ownerId },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ plan }, 201)
      }

      const planIdMatch = /^\/api\/plans\/([0-9a-f-]{36})$/i.exec(pathname)
      if (planIdMatch) {
        const caller = await requireCaller(req)
        const planId = planIdMatch[1]!.toLowerCase()
        const existing = await deps.store.getPlan(planId)
        if (!existing) return fail('NOT_FOUND', `plan "${planId}" not found`)
        if (caller.principal.kind !== 'root') {
          const resellerId = await resolveResellerId(caller)
          if (!resellerId || existing.ownerId !== resellerId) {
            return fail('FORBIDDEN', 'not authorized to modify this plan')
          }
        }
        if (method === 'PATCH') {
          const patch = await readJsonBody<PlanPatch>(req)
          const plan = await deps.store.updatePlan(planId, patch)
          const reconcile = await triggerReconcile(caller)
          await emitAudit({
            actor: caller.principal.username,
            action: 'plan.updated',
            target: `plan:${plan.id}`,
            detail: { name: plan.name },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ plan, reconcile: reconcile?.body ?? null })
        }
        if (method === 'DELETE') {
          await deps.store.deletePlan(planId)
          const snap = await deps.store.readSnapshot()
          await reindexFromState(deps.db, snap)
          await emitAudit({
            actor: caller.principal.username,
            action: 'plan.deleted',
            target: `plan:${planId}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ ok: true })
        }
      }

      // ---- Resellers -----------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/resellers') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'reseller') {
          const r = await resolveResellerForCaller(caller)
          return jsonResponse({ resellers: r ? [r] : [] })
        }
        await assertRoot(caller, 'resellers.list')
        return jsonResponse({ resellers: await deps.store.listResellers() })
      }

      if (method === 'POST' && pathname === '/api/resellers') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'resellers.create')
        const body = await readJsonBody<Omit<NewReseller, 'passwordHash'> & { password?: string; passwordHash?: string }>(req)
        const passwordHash = await passwordHashFromInput(body)
        const reseller = await deps.store.createReseller({
          ...body,
          passwordHash,
        })
        const existingPrincipal = await findPrincipalByUsername(deps.db, reseller.username)
        if (!existingPrincipal) {
          await createResellerPrincipal(deps.db, {
            id: reseller.id,
            username: reseller.username,
            passwordHash,
          })
        }
        const snap = await deps.store.readSnapshot()
        await reindexFromState(deps.db, snap)
        await emitAudit({
          actor: caller.principal.username,
          action: 'reseller.created',
          target: `reseller:${reseller.username}`,
          detail: { resellerId: reseller.id },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ reseller }, 201)
      }

      const resellerIdMatch = /^\/api\/resellers\/([0-9a-f-]{36})$/i.exec(pathname)
      if (resellerIdMatch) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'resellers.modify')
        const resellerId = resellerIdMatch[1]!.toLowerCase()
        if (method === 'PATCH') {
          const patch = await readJsonBody<ResellerPatch>(req)
          const reseller = await deps.store.updateReseller(resellerId, patch)
          const snap = await deps.store.readSnapshot()
          await reindexFromState(deps.db, snap)
          await emitAudit({
            actor: caller.principal.username,
            action: 'reseller.updated',
            target: `reseller:${reseller.username}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ reseller })
        }
        if (method === 'DELETE') {
          const existing = await deps.store.getReseller(resellerId)
          await deps.store.deleteReseller(resellerId)
          if (existing) {
            const p = await findPrincipalByUsername(deps.db, existing.username)
            if (p) await deletePrincipal(deps.db, p.id)
          }
          const snap = await deps.store.readSnapshot()
          await reindexFromState(deps.db, snap)
          await emitAudit({
            actor: caller.principal.username,
            action: 'reseller.deleted',
            target: `reseller:${resellerId}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ ok: true })
        }
      }

      const mailboxTransport = deps.mailboxTransport ?? createLocalMailboxTransport(mailboxEnvironment)
      if (pathname === '/api/webmail/search' || pathname === '/api/webmail/search-message') {
        const searchCaller = await requireCaller(req)
        // Account administrators retain their existing metadata search below.
        if (pathname === '/api/webmail/search-message' || isMailboxPrincipal(searchCaller)) {
          const { caller } = await authorizeNativeMailboxRequest(req, ['webmail-search'])
          if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } })
          const workspace = createMailSearchWorkspace({ db: deps.db, store: deps.store, serverSecret, env: mailboxEnvironment,
            openSession: async () => (await authorizeNativeMailboxRequest(req, ['webmail-search'])).opened,
            clientFactory: deps.mailSearchClientFactory ?? (deps.mailboxTransport ? () => fail('PRECONDITION_FAILED', 'a native mailbox search adapter has not been configured', { stateChanged: false }) : undefined),
          })
          const result = pathname === '/api/webmail/search' ? await workspace.search(caller, url.searchParams) : await workspace.read(caller, url.searchParams)
          const response = jsonResponse(result)
          response.headers.set('cache-control', 'private, no-store')
          return response
        }
      }
      if (pathname === '/api/webmail/track-delivery') {
        const response = await handleMailTrackDeliveryRoute(req, url, method, {
          openMailbox: async request => { const { caller, opened } = await authorizeNativeMailboxRequest(request, ['webmail-track-delivery']); return { caller, mailbox: opened.record.mailbox } },
          readMailboxLog: (caller, query) => readNativeWorkspace(caller, '/host/mail/log/mailbox?' + query),
        })
        if (response) return response
      }
      const sealedImapPorts = (toolId: string) => ({ env: mailboxEnvironment,
        open: async (request: Request) => (await authorizeNativeMailboxRequest(request, [toolId])).opened,
        ...(deps.mailboxTransport ? { clientFactory: () => fail('PRECONDITION_FAILED', 'a native mailbox IMAP adapter has not been configured', { stateChanged: false }) } : {}),
        audit: async (request: Request, event: { action: string; mailbox: string; detail: Record<string, unknown> }) => {
          const { caller, opened } = await authorizeNativeMailboxRequest(request, [toolId])
          const account = await deps.store.getAccount(opened.record.accountId)
          if (!account || event.mailbox !== opened.record.mailbox) return fail('FORBIDDEN', 'mailbox authorization changed', { stateChanged: false })
          await emitAudit({ actor: caller.principal.username, action: event.action, target: 'mailbox:' + event.mailbox, detail: event.detail, outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
        } })
      if (pathname === '/api/webmail/folders' || pathname.startsWith('/api/webmail/folders/')) {
        const foldersCaller = await requireCaller(req)
        // API tokens and administrators keep the existing metadata listing below; sealed sessions get native IMAP folders.
        if (pathname !== '/api/webmail/folders' || foldersCaller.sessionId !== null && isMailboxPrincipal(foldersCaller) && !url.searchParams.has('mailbox')) {
          await authorizeNativeMailboxRequest(req, ['webmail-folders'])
          const response = await handleMailFolderAdminRoute(req, url, method, sealedImapPorts('webmail-folders'))
          if (response) return response
        }
      }
      if (pathname === '/api/webmail/disk-usage' || pathname.startsWith('/api/webmail/disk-usage/')) {
        await authorizeNativeMailboxRequest(req, ['webmail-disk-cleanup'])
        const response = await handleMailboxUsageRoute(req, url, method, sealedImapPorts('webmail-disk-cleanup'))
        if (response) return response
      }
      if (pathname === '/api/webmail/connect-devices' || pathname.startsWith('/api/webmail/connect-devices/')) {
        const response = await handleMailDeviceSetupRoute(req, url, method, {
          open: async request => ({ mailbox: (await authorizeNativeMailboxRequest(request, ['webmail-mail-client-setup'])).opened.record.mailbox }),
          readHostname: async () => (await deps.store.getServerSettings())?.hostname ?? null,
        })
        if (response) return response
      }
      if (pathname === '/api/webmail/forwarders') {
        const response = await handleMailboxForwardersRoute(req, url, method, { store: deps.store,
          open: async request => (await authorizeNativeMailboxRequest(request, ['webmail-forwarders', 'forwarders'])).opened,
          audit: sealedImapPorts('webmail-forwarders').audit })
        if (response) return response
      }
      if (pathname === '/api/webmail/spam-preferences' || pathname === '/api/webmail/mailing-lists' || pathname.startsWith('/api/webmail/mailing-lists/')) {
        const ids = pathname === '/api/webmail/spam-preferences' ? ['webmail-spam-box', 'webmail-spam-autodelete'] : ['webmail-mailing-lists']
        const ports = { store: deps.store, open: async (request: Request) => (await authorizeNativeMailboxRequest(request, ids)).opened, audit: sealedImapPorts(ids[0]!).audit }
        const response = pathname === '/api/webmail/spam-preferences' ? await handleMailboxSpamRoute(req, url, method, ports) : await handleMailboxMailingListsRoute(req, url, method, ports)
        if (response) return response
      }
      if (pathname === '/api/webmail/preferences') {
        const response = await handleMailboxPreferencesRoute(req, url, method, { store: deps.store,
          open: async request => (await authorizeNativeMailboxRequest(request, ['webmail-preferences'])).opened,
          audit: sealedImapPorts('webmail-preferences').audit, ...(deps.os ? { os: deps.os } : {}) })
        if (response) return response
      }
      if (pathname === '/api/webmail/attachment-workspace' || pathname.startsWith('/api/webmail/attachment-download/')) {
        await authorizeNativeMailboxRequest(req, ['webmail-attachments'])
        const response = await handleNativeAttachmentRequest(req)
        if (response) return response
      }
      const moveMatch = /^\/api\/webmail\/inbox\/([1-9]\d*)\/move$/.exec(pathname)
      const inboxMatch = /^\/api\/webmail\/inbox\/([1-9]\d*)$/.exec(pathname)
      if (pathname === '/api/webmail/inbox' && method === 'GET') {
        const caller = await requireCaller(req)
        return jsonResponse(await listMailboxFolder(await mailboxFolderDependencies(req, caller, mailboxTransport), url.searchParams.get('folder')))
      }
      if (moveMatch && method === 'POST') {
        const { caller } = await authorizeNativeMailboxRequest(req)
        if (url.search) return fail('VALIDATION', 'mailbox moves do not accept query selectors', { stateChanged: false })
        const body = await readJsonBody(req)
        return jsonResponse(await moveMailboxFolder(await mailboxFolderDependencies(req, caller, mailboxTransport), moveMatch[1], body))
      }
      if (inboxMatch && (method === 'GET' || method === 'DELETE')) {
        const caller = await requireCaller(req)
        if (method === 'GET') return jsonResponse(await readMailboxFolder(await mailboxFolderDependencies(req, caller, mailboxTransport), inboxMatch[1], url.searchParams.get('folder')))
        const { opened } = await authorizeNativeMailboxRequest(req)
        const raw = await readJsonBody<unknown>(req)
        if ([...url.searchParams.keys()].some(key => !['folder','confirm'].includes(key)) || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)
          || !raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'uidValidity')) return fail('VALIDATION', 'message deletion requires the observed uidValidity without scope selectors', { stateChanged: false })
        const validity = mailboxUidValidity((raw as Record<string,unknown>).uidValidity)
        const uid = mailboxFolderUid(inboxMatch[1])
        const folder = mailFolderName(url.searchParams.get('folder'))
        if (method === 'DELETE') {
          if (folder === 'Trash') {
            if (url.searchParams.get('confirm') !== 'delete') {
              return fail('PRECONDITION_FAILED', msgid('Deleting a message from Trash removes it permanently.'))
            }
            await authorizeNativeMailboxRequest(req)
            let acknowledged = false
            try {
              await mailboxTransport.remove(opened.record.mailbox, opened.password, uid, folder, { uidValidity: validity })
              acknowledged = true
              await authorizeNativeMailboxRequest(req)
            } catch (error) {
              if (!acknowledged && isXpanelError(error) && error.detail.stateChanged === false && error.detail.unknownOutcome !== true && error.detail.verificationRequired !== true) throw error
              return fail(isXpanelError(error) ? error.code : 'SERVICE_UNAVAILABLE', 'message deletion outcome requires review before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
            }
            return jsonResponse({ ok: true, uid, folder, sourceUidValidity: validity, permanent: true, stateChanged: true })
          }
          return jsonResponse({ ...await moveMailboxFolder(await mailboxFolderDependencies(req, caller, mailboxTransport), uid, { from: folder, folder: 'Trash', uidValidity: validity }), permanent: false })
        }
      }
      if (pathname === '/api/webmail/drafts' && method === 'POST') {
        await authorizeNativeMailboxRequest(req)
        const body = await nativeComposeBody(req, true)
        let prepared: ReturnType<typeof prepareComposeAttachments>
        try { prepared = prepareComposeAttachments(body.attachments, body) }
        catch (error) {
          if (error instanceof ComposeAttachmentValidationError) return jsonResponse({ code: 'VALIDATION', detail: error.message, details: { stateChanged: false } }, error.status)
          throw error
        }
        if (body.subject !== undefined && typeof body.subject !== 'string' || body.text !== undefined && typeof body.text !== 'string'
          || body.html !== undefined && typeof body.html !== 'string') return fail('VALIDATION', 'draft subject and bodies must be text', { stateChanged: false })
        const { caller, opened, identity } = await resolveNativeComposeIdentity(req, body)
        const transport = deps.mailDraftTransport ? deps.mailDraftTransport(opened)
          : deps.mailboxTransport ? fail('PRECONDITION_FAILED', 'a native mailbox draft adapter has not been configured', { stateChanged: false })
          : createNativeDraftTransport({ env: mailboxEnvironment, openSession: async () => (await authorizeNativeMailboxRequest(req)).opened })
        const content: DraftContent = { to: nativeDraftRecipients(body.to), cc: nativeDraftRecipients(body.cc), bcc: nativeDraftRecipients(body.bcc),
          subject: typeof body.subject === 'string' ? body.subject : '', textBody: typeof body.text === 'string' ? body.text : '',
          ...(typeof body.html === 'string' && body.html ? { htmlBody: sanitizeEmailHtml(body.html).sanitizedHtml } : {}),
          ...(identity ? { fromName: identity.fromName, replyTo: identity.replyTo } : {}), attachments: prepared.attachments,
        }
        const saved = await saveMailboxDraft({ mailbox: opened.record.mailbox, transport,
          authorize: async () => { await resolveNativeComposeIdentity(req, body) },
        }, content, body.expectedDraft)
        try {
          await authorizeNativeMailboxRequest(req)
          const account = await deps.store.getAccount(opened.record.accountId)
          if (!account) throw new Error('draft audit scope unavailable')
          await emitAudit({ actor: caller.principal.username, action: 'webmail.draft.saved', target: 'mailbox:' + opened.record.mailbox,
            detail: { uid: saved.draft.uid, uidValidity: saved.draft.uidValidity, previousDraft: saved.previousDraft, reviewRequired: saved.reviewRequired },
            outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
        } catch {
          return fail('SERVICE_UNAVAILABLE', 'draft save outcome requires review before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true, draftReviewRequired: true })
        }
        return jsonResponse({ ...saved, ...(identity ? { identityId: identity.identityId, identityRevision: identity.identityRevision } : {}) }, saved.status === 'partial' ? 200 : 201)
      }
      if (pathname === '/api/webmail/send' && method === 'POST') {
        await authorizeNativeMailboxRequest(req)
        const body = await nativeComposeBody(req, false)
        let prepared: ReturnType<typeof prepareComposeAttachments>
        try { prepared = prepareComposeAttachments(body.attachments, body) }
        catch (error) {
          if (error instanceof ComposeAttachmentValidationError) return jsonResponse({ code: 'VALIDATION', detail: error.message, details: { stateChanged: false } }, error.status)
          throw error
        }
        const input = parseMailboxSend(body)
        await resolveNativeComposeIdentity(req, body)
        const { caller, opened, identity } = await resolveNativeComposeIdentity(req, body)
        const signSent = deps.agentApp && deps.agentToken
          ? async (mailbox: string, rawMime: string): Promise<string | null> => {
              const response = await deps.agentApp!.fetch(new Request('http://agent.local/host/dkim-sign', {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  ...agentCallerHeaders({ principalId: caller.principal.id, token: deps.agentToken! }),
                },
                body: JSON.stringify({ mailbox, rawMime, purpose: 'webmail-send' }),
              }))
              if (!response.ok) return null
              const body = await response.json() as { rawMime?: unknown }
              return typeof body.rawMime === 'string' ? body.rawMime : null
            }
          : undefined
        const sending = deps.mailboxTransport ?? createLocalMailboxTransport(mailboxEnvironment, signSent ? { signSent } : {})
        let submissionAcknowledged = false
        try {
          const sent = await sending.send(opened.record.mailbox, opened.password, { ...input,
            ...(identity ? { fromName: identity.fromName, replyTo: identity.replyTo } : {}),
            ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}),
          })
          submissionAcknowledged = true
          if (!sent || typeof sent.messageId !== 'string' || !/^<[^<>\s@]+@[^<>\s@]+>$/.test(sent.messageId)) throw new Error('submission acknowledgement is incomplete')
          await authorizeNativeMailboxRequest(req)
          const account = await deps.store.getAccount(opened.record.accountId)
          if (!account) throw new Error('mailbox audit scope unavailable')
          await emitAudit({ actor: caller.principal.username, action: 'webmail.message.sent', target: 'mailbox:' + opened.record.mailbox,
            outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
          return jsonResponse({ mailbox: opened.record.mailbox, messageId: sent.messageId, savedToSent: sent.savedToSent === true,
            ...(identity ? { identityId: identity.identityId, identityRevision: identity.identityRevision } : {}),
          }, 201)
        } catch (error) {
          if (!submissionAcknowledged && isXpanelError(error) && error.detail.stateChanged === false && error.detail.unknownOutcome !== true && error.detail.verificationRequired !== true) throw error
          return fail(isXpanelError(error) ? error.code : 'SERVICE_UNAVAILABLE', 'message submission outcome requires review before retrying', {
            stateChanged: true, verificationRequired: true, unknownOutcome: true,
          })
        }
      }
      if (method === 'GET' && pathname === '/api/server/info') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.info')
        return callAgent('/host/info', { caller })
      }
      if (method === 'GET' && pathname === '/api/server/drift') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.drift')
        return callAgent('/host/drift', { caller })
      }
      if (method === 'GET' && pathname === '/api/server/services') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.services')
        return callAgent('/host/services', { caller })
      }
      const serviceRestart = /^\/api\/server\/services\/([a-z0-9-]+)\/restart$/.exec(pathname)
      if (method === 'POST' && serviceRestart) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.services.restart')
        return callAgent(`/host/services/${serviceRestart[1]}/restart`, { method: 'POST', caller, body: {} })
      }
      if (pathname === '/api/backups/files' || pathname.startsWith('/api/backups/files/')) {
        const response = await handleBackupFileRestoreWorkspaceRoute(req, url, method, { requireCaller,
          getAccountByUsername: username => deps.store.getAccountByUsername(username),
          visibleAccounts: caller => ownedAccounts(deps.store, caller),
          assertCanAccessAccount: (caller, account, action) => assertCanAccessAccount(caller, account, action),
          ...(deps.agentApp && deps.agentToken ? { callAgent: (path, options) => callAgent(path, options) } : {}),
        })
        if (response) return response
      }
      if (pathname.startsWith('/api/backups/components/')) {
        const response = await handleComponentRestoreWorkspaceRoute(req, url, method, { requireCaller,
          getAccountByUsername: username => deps.store.getAccountByUsername(username),
          assertCanAccessAccount: (caller, account, action) => assertCanAccessAccount(caller, account, action),
          ...(deps.agentApp && deps.agentToken ? { callAgent: (path, options) => callAgent(path, options) } : {}),
        })
        if (response) return response
      }
      const accountBackup = /^\/api\/backups\/accounts\/([a-z][a-z0-9]{0,15})$/.exec(pathname)
      if (accountBackup && (method === 'GET' || method === 'POST')) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'backup.account')
        const username = accountBackup[1]!
        const account = await deps.store.getAccountByUsername(username)
        if (!account) return fail('NOT_FOUND', `account "${username}" not found`)
        if (method === 'GET') return callAgent(`/accounts/${username}/backups`, { caller })
        return callAgent(`/accounts/${username}/backups`, { method: 'POST', caller, body: await readJsonBody(req) })
      }

      // ---- Accounts: Jailed Files & Shell (Proxied to Agent) -------------------------
      const accountFilesMatch = /^\/api\/accounts\/([a-z][a-z0-9]{0,15})\/files$/.exec(pathname)
      if (method === 'POST' && accountFilesMatch) {
        const caller = await requireCaller(req)
        const username = accountFilesMatch[1]!
        const account = await deps.store.getAccountByUsername(username)
        if (!account) return fail('NOT_FOUND', `account "${username}" not found`)
        await assertCanAccessAccount(caller, account, 'files')
        const recheckRequest = req.clone()
        const body = validateFileWorkspaceRequest(await readJsonBody(req))
        const currentCaller = await requireCaller(recheckRequest)
        const currentAccount = await deps.store.getAccountByUsername(username)
        if (!currentAccount || currentAccount.id !== account.id) return fail('NOT_FOUND', 'account target changed')
        await assertCanAccessAccount(currentCaller, currentAccount, 'files')
        if (!deps.agentApp || !deps.agentToken) return fail('PRECONDITION_FAILED', 'protected host file service is unavailable', { stateChanged: false })
        return executeFileWorkspaceRequest(body, () => callAgent(`/accounts/${username}/files`, {
          method: 'POST',
          caller: currentCaller,
          body,
        }))
      }

      const backupWorkspaceResponse = await accountBackupRouter(req, url, method)
      if (backupWorkspaceResponse) return backupWorkspaceResponse
      const cronWorkspaceResponse = await cronRouter(req, url, method)
      if (cronWorkspaceResponse) return cronWorkspaceResponse
      const accountToolPorts = { store: deps.store, requireCaller, readAgent: readNativeWorkspace }
      const accountSshResponse = await handleAccountSshRoute(req, url, method, accountToolPorts)
      if (accountSshResponse) return accountSshResponse
      const dynamicDnsResponse = await dynamicDns.manage(req, url, method)
      if (dynamicDnsResponse) return dynamicDnsResponse
      const accountGitResponse = await handleGitWorkspaceRoute(req, url, method, accountToolPorts)
      if (accountGitResponse) return accountGitResponse
      const accountPackagesResponse = await handleAccountPackagesWorkspaceRoute(req, url, method, accountToolPorts)
      if (accountPackagesResponse) return accountPackagesResponse
      const swOptimizeResponse = await handleSwOptimizeWorkspaceRoute(req, url, method, accountToolPorts)
      if (swOptimizeResponse) return swOptimizeResponse
      const swApplicationsResponse = await handleSwApplicationsWorkspaceRoute(req, url, method, accountToolPorts)
      if (swApplicationsResponse) return swApplicationsResponse
      const remoteDatabaseResponse = await handleDatabaseRemoteAccessWorkspaceRoute(req, url, method, accountToolPorts)
      if (remoteDatabaseResponse) return remoteDatabaseResponse
      const dbEngineAccountResponse = await handleDbWorkspaceRoute(req, url, method, { ...accountToolPorts, assertRoot, mutateDatabase: mutateDatabaseWorkspace })
      if (dbEngineAccountResponse) return dbEngineAccountResponse
      const accountPgpResponse = await handlePgpWorkspace(req, url, method, accountToolPorts)
      if (accountPgpResponse) return accountPgpResponse
      const sitePublisherMatch = SITE_PUBLISHER_DOMAIN_ROUTE.exec(pathname)
      if (sitePublisherMatch) {
        const suffix = sitePublisherMatch[2], expectedMethod = suffix ? 'POST' : 'GET'
        if (method !== expectedMethod) return new Response(null, { status: 405, headers: { allow: expectedMethod } })
        if (url.search) return fail('VALIDATION', 'site publisher accepts no query selectors', { stateChanged: false })
        const first = await authorizeAccountOwner(accountToolPorts, req, ['site-publisher'], 'Site publisher')
        const domain = await deps.store.getDomain(sitePublisherMatch[1]!)
        if (!domain || domain.accountId !== first.account.id) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
        const intent = parseSitePublisherHttpRequest(method, suffix, suffix ? await readSitePublisherBody(req) : undefined)
        const fresh = await authorizeAccountOwner(accountToolPorts, req, ['site-publisher'], 'Site publisher')
        const currentDomain = await deps.store.getDomain(domain.id)
        if (fresh.caller.principal.id !== first.caller.principal.id || fresh.account.id !== first.account.id || !currentDomain || JSON.stringify(currentDomain) !== JSON.stringify(domain)) return fail('CONFLICT', 'site publisher ownership or target changed', { stateChanged: false })
        const path = '/accounts/' + fresh.account.username + '/site-publisher/' + domain.id + (suffix ? '/' + suffix : '')
        const response = await executeSitePublisherWorkspaceRequest({ accountId: fresh.account.id, domainId: domain.id }, intent, () => callAgent(path, { caller: fresh.caller, method, ...(intent.body ? { body: intent.body } : {}) }))
        try {
          const after = await authorizeAccountOwner(accountToolPorts, req, ['site-publisher'], 'Site publisher'), latest = await deps.store.getDomain(domain.id)
          if (after.caller.principal.id !== fresh.caller.principal.id || after.account.id !== fresh.account.id || !latest || JSON.stringify(latest) !== JSON.stringify(domain)) return fail('CONFLICT', 'site publisher authority or target changed', { stateChanged: false })
        } catch (error) {
          if (intent.operation === 'publish' || intent.operation === 'rollback') return fail('SERVICE_UNAVAILABLE', 'site publisher outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
          throw error
        }
        return response
      }
      if (pathname === '/api/account/sec/waf') {
        const response = await handleSecWorkspaceRoute(req, url, method, secHelpers())
        if (response) return response
      }
      if (pathname.startsWith('/api/account/sec/cloudflare')) {
        const response = await handleSecCloudflareRoute(req, url, method, { requireCaller, assertRoot, emitAudit, store: deps.store, fetch: globalThis.fetch })
        if (response) return response
      }
      const accountLogsResponse = await handleAccountLogsRoute(req, url, method, accountToolPorts)
      if (accountLogsResponse) return accountLogsResponse
      const accountVirusScanResponse = await handleAccountVirusScanRoute(req, url, method, accountToolPorts)
      if (accountVirusScanResponse) return accountVirusScanResponse
      const networkToolsResponse = await handleNetworkToolsRoute(req, url, method, { ...accountToolPorts, networkToolsGate })
      if (networkToolsResponse) return networkToolsResponse
      const accountDatabaseInsightsResponse = await handleAccountDatabaseInsightsRoute(req, url, method, accountToolPorts)
      if (accountDatabaseInsightsResponse) return accountDatabaseInsightsResponse
      const siteHealthResponse = await handleSiteHealthRoute(req, url, method, { store: deps.store, requireCaller, dns: siteHealthDns, probe: probeHtaccessTarget })
      if (siteHealthResponse) return siteHealthResponse
      if (pathname === '/api/server/composer' || pathname.startsWith('/api/server/composer/jobs/')) {
        const response = await handleComposerWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          callHost: (caller, path, body, mutation = false) => readNativeWorkspace(caller, path, body, mutation) })
        if (response) return response
      }
      if (pathname === '/api/server/default-index' || pathname.startsWith('/api/server/default-index/')) {
        const initial = await requireCaller(req)
        await assertRoot(initial, 'server.default_index.workspace')
        const available = Boolean(deps.agentApp && deps.agentToken)
        const catalog = await loadQualifiedCatalog(available ? { fetch: request => deps.agentApp!.fetch(request), token: deps.agentToken! } : null)
        const tool = catalog.find(tool => tool.id === 'aapanel-default-index')
        const qualified = available && tool?.status === 'verified' && tool.delivery.status === 'verified'
        const assertQualified = async (caller: AuthenticatedCaller) => {
          if (caller.principal.kind !== 'root' || caller.principal.id !== initial.principal.id || caller.sessionId !== initial.sessionId || caller.apiTokenId !== initial.apiTokenId) return fail('FORBIDDEN', 'default-index authority changed', { stateChanged: false })
          if (!qualified) return fail('PRECONDITION_FAILED', 'default-index mutation is not qualified on this host', { stateChanged: false })
        }
        const router = createDefaultIndexWorkspaceRoutes({ store: deps.store, serverSecret, requireCaller, assertRoot, emitAudit,
          assertMutationQualified: assertQualified,
          prepareProjection: transition => prepareDomainIndexTransition(deps.db, transition),
          ...(available ? { applyConfiguration: async (caller: AuthenticatedCaller, account: Account, revision: number) => {
            await assertQualified(caller)
            await applyAccountConfiguration(caller, account, 'server.default_index.updated', revision)
            return { status: 'global_configuration_applied' as const, targetVerified: false as const }
          } } : {}),
        })
        const response = await router(req, url, method)
        if (response) return response
      }
      if (pathname === '/api/server/default-site' || pathname === '/api/server/default-site/requests') {
        const initial = await requireCaller(req)
        await assertRoot(initial, 'default-site.workspace')
        const available = Boolean(deps.agentApp && deps.agentToken)
        // Read trusted host admission before any metadata writer lease is acquired.
        const catalog = await loadQualifiedCatalog(available ? { fetch: request => deps.agentApp!.fetch(request), token: deps.agentToken! } : null)
        const tool = catalog.find(tool => tool.id === 'aapanel-default-site')
        const qualified = available && tool?.status === 'verified' && tool.delivery.status === 'verified'
        const assertQualified = async (caller: AuthenticatedCaller) => {
          if (caller.principal.kind !== 'root' || caller.principal.id !== initial.principal.id || caller.sessionId !== initial.sessionId || caller.apiTokenId !== initial.apiTokenId) return fail('FORBIDDEN', 'default-site authorization changed', { stateChanged: false })
          if (!qualified) return fail('PRECONDITION_FAILED', 'default-site mutation is not qualified on this host', { stateChanged: false })
        }
        const router = createDefaultSiteWorkspaceRoutes({ store: deps.store, serverSecret, requireCaller, assertRoot, emitAudit,
          assertMutationQualified: assertQualified,
          ...(available ? {
            observeRequests: (caller: AuthenticatedCaller) => readNativeWorkspace(caller, '/host/default-site/requests', undefined, false, 'GET'),
            applyConfiguration: async (caller: AuthenticatedCaller, expectedRevision: number) => {
              const fresh = await requireCaller(req)
              await assertRoot(fresh, 'default-site.apply')
              await assertQualified(fresh)
              if (fresh.principal.id !== caller.principal.id || await deps.store.getRevision() !== expectedRevision) return fail('SERVICE_UNAVAILABLE', 'default-site configuration changed before application', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
              const result = await triggerReconcile(fresh)
              if (!result?.ok || !['applied','noop'].includes(String(result.body.status)) || await deps.store.getRevision() !== expectedRevision) return fail('SERVICE_UNAVAILABLE', 'default-site application requires verification', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
              return { status: 'global_configuration_applied' as const, targetVerified: false as const }
            },
          } : {}),
        })
        const response = await router(req, url, method)
        if (response) return response
      }
      if (/^\/api\/jobs(?:\/|$)/.test(pathname)) {
        const response = await handleJobsWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          callAgent: (caller, path, agentMethod) => callAgent(path, { caller, method: agentMethod }) })
        if (response) return response
      }
      if (pathname.startsWith('/api/server/monitoring/')) {
        const benchmark = await handleBenchmarkWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) })
        if (benchmark) return benchmark
        const traffic = await handleTrafficWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          readHost: caller => readNativeWorkspace(caller, '/host/monitoring/traffic') })
        if (traffic) return traffic
        const response = await handleMonitoringWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          readHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined),
          listHostMetrics: options => listMetricsHistory(deps.db, { scope: 'host', ...options }),
        })
        if (response) return response
      }
      if (pathname === '/api/server/upgrade' || pathname.startsWith('/api/server/upgrade/')) {
        const response = await handleUpgradeWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit, callAgent })
        if (response) return response
      }
      if (pathname === '/api/server/ftp-log/activity') {
        const response = await handleFtpLogWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          readActivity: (caller, query) => readNativeWorkspace(caller, '/host/ftp/log?' + query) })
        if (response) return response
      }
      if (pathname === '/api/server/mail-log/delivery' || pathname === '/api/server/mail-log/monitor') {
        const response = await handleMailLogWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          readServerLog: (caller, query) => readNativeWorkspace(caller, '/host/mail/log?' + query) })
        if (response) return response
      }
      if (pathname === '/api/server/panel/api-tokens' || pathname.startsWith('/api/server/panel/api-tokens/')) {
        const response = await handlePanelTokensWorkspaceRoute(req, url, method, { db: deps.db, requireCaller, assertRoot, emitAudit })
        if (response) return response
      }
      if (/^\/api\/(?:server|account)\/announcements(?:\/|$)/.test(pathname)) {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const response = await handleAnnouncementsRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit,
          readSaved: () => extended.readOrDefault<unknown>('accounts/announcements.json', null),
          writeSaved: value => extended.write('accounts/announcements.json', value),
          readDismissed: accountId => extended.readOrDefault<unknown>(`accounts/announcement-dismissals/${accountId}.json`, null),
          writeDismissed: (accountId, value) => extended.write(`accounts/announcement-dismissals/${accountId}.json`, value) })
        if (response) return response
      }
      if (/^\/api\/account\/staging(?:\/|$)/.test(pathname)) {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const response = await handleStagingWorkspaceRoute(req, url, method, { store: deps.store, requireCaller,
          readSaved: accountId => extended.readOrDefault<unknown>(`accounts/staging/${accountId}.json`, null),
          writeSaved: (accountId, value) => extended.write(`accounts/staging/${accountId}.json`, value),
          ...(deps.agentApp && deps.agentToken ? { callAgent: (path, options) => callAgent(path, options) } : {}),
        })
        if (response) return response
      }
      if (/^\/api\/account\/team(?:\/|$)/.test(pathname)) {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const response = await handleTeamRoute(req, url, method, { store: deps.store, db: deps.db, requireCaller, emitAudit,
          readTeam: accountId => extended.readOrDefault<unknown>(`accounts/team/${accountId}.json`, null),
          writeTeam: (accountId, value) => extended.write(`accounts/team/${accountId}.json`, value) })
        if (response) return response
      }
      if (/^\/api\/server\/account-(?:templates|enhancements)(?:\/|$)/.test(pathname)) {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const response = pathname.startsWith('/api/server/account-templates')
          ? await handleAccountTemplatesRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit,
              readSaved: () => extended.readOrDefault<unknown>('accounts/templates.json', null), writeSaved: value => extended.write('accounts/templates.json', value) })
          : await handleAccountEnhancementsRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit,
              readSaved: () => extended.readOrDefault<unknown>('plans/enhancements.json', null), writeSaved: value => extended.write('plans/enhancements.json', value) })
        if (response) return response
      }
      if (pathname === '/api/server/panel/notifications' || pathname.startsWith('/api/server/panel/notifications/')) {
        const response = await handlePanelNotificationsRoute(req, url, method, { requireCaller, assertRoot, emitAudit, ...alertStateFiles(deps.store), transports: await alertTransports(deps.store) })
        if (response) return response
      }
      const adminPreferencesResponse = await handleAdminPreferencesRoute(req, url, method, { store: deps.store, requireCaller, emitAudit })
      if (adminPreferencesResponse) return adminPreferencesResponse
      const serviceManagerResponse = await handleServiceManagerWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
        callHost: (caller, path, body, mutation = false) => readNativeWorkspace(caller, path, body, mutation) })
      if (serviceManagerResponse) return serviceManagerResponse
      if (pathname === '/api/server/software-center' || pathname.startsWith('/api/server/software-center/')) {
        const response = await handleSoftwareCenterWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          callHost: (caller, path, body, mutation = false) => readNativeWorkspace(caller, path, body, mutation) })
        if (response) return response
      }
      if (pathname.startsWith('/api/server/software/')) {
        const callHost = (caller: AuthenticatedCaller, path: string, body?: unknown, mutation = false) => readNativeWorkspace(caller, path, body, mutation)
        const response = await handleSwContainersWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit, callHost })
          ?? await handleSwAddonServicesWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit, callHost })
          ?? await handleSwDeploymentsWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit, callHost, getAccountByUsername: name => deps.store.getAccountByUsername(name) })
        if (response) return response
      }
      if (pathname.startsWith('/api/server/databases/')) {
        const engines = await handleDbWorkspaceRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, readAgent: readNativeWorkspace })
        if (engines) return engines
        const tuning = await handleDatabaseTuningWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          readHost: (caller, path) => readNativeWorkspace(caller, path, undefined, false, 'GET') })
        if (tuning) return tuning
        const response = await handleWhmDatabasesWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          readSaved: () => deps.store.readSnapshot(),
          readHost: (caller, path) => readNativeWorkspace(caller, path, undefined, false, 'GET'),
          killOnHost: (caller, body) => readNativeWorkspace(caller, '/host/databases/processes/kill', body, true),
        })
        if (response) return response
      }
      if (pathname === '/api/server/file-sharing' || pathname === '/api/server/file-sharing/apply') {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const response = await handleFileSharingWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          readSaved: () => extended.readOrDefault<unknown>('file-sharing/shares.json', null),
          writeSaved: value => extended.write('file-sharing/shares.json', value),
          callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined, body === undefined ? 'GET' : 'POST') })
        if (response) return response
      }
      if (pathname === '/api/server/terminal') {
        const ip = extractClientIp(req) ?? '127.0.0.1'
        const response = await handleTerminalWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          verifyPassword: (caller, password) => verifyPasswordArgon2id(password, caller.principalRecord.passwordHash),
          checkLockout: async caller => { const lockout = await checkLockout(deps.db, { username: caller.principal.username, ip }); return lockout ? lockout.lockedUntil : null },
          recordFailure: caller => recordFailedLoginAndMaybeLock(caller.principal.username, ip, 'invalid_terminal_reauthentication', caller.principal.id) })
        if (response) return response
      }
      if (pathname === '/api/server/nodes' || pathname === '/api/server/nodes/verify') {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const response = await handleNodesWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          readSaved: () => extended.readOrDefault<unknown>('server/managed-nodes.json', null),
          writeSaved: value => extended.write('server/managed-nodes.json', value),
          readHostname: async () => { const wizard = await extended.readOrDefault<{ hostname?: unknown } | null>('setup-wizard.json', null); return wizard && typeof wizard.hostname === 'string' ? wizard.hostname : null },
          // verifyChannel stays absent until an authenticated, fingerprint-pinned node channel is qualified.
        })
        if (response) return response
      }
      if (pathname === '/api/server/integrations' || pathname === '/api/server/integrations/test') {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const response = await handleIntegrationsWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          readSaved: () => extended.readOrDefault<unknown>('integrations/webhooks.json', null),
          writeSaved: value => extended.write('integrations/webhooks.json', value),
          readSecrets: () => extended.readOrDefault<Record<string, string>>('integrations/secrets.json', {}),
          // Signing secrets are written owner-only (0600), unlike ordinary extended state.
          writeSecrets: value => opsAtomicWriteJson(opsJoin(deps.store.rootDir, 'extended', 'integrations', 'secrets.json'), value, 0o600),
          readLog: () => extended.readOrDefault('integrations/deliveries.json', []),
          writeLog: value => extended.write('integrations/deliveries.json', value),
          // No reviewed outbound webhook egress exists yet; test deliveries report unavailable and nothing is sent.
          sender: null })
        if (response) return response
      }
      if (pathname.startsWith('/api/server/updates/')) {
        const response = await handleSystemUpdatesWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) })
        if (response) return response
      }
      if (pathname === '/api/accounts/health') {
        const response = await handleAccountHealthWorkspaceRoute(req, url, method, { requireCaller,
          visibleAccounts: caller => ownedAccounts(deps.store, caller),
          forward: (caller, path) => deps.agentApp && deps.agentToken ? callAgent(path, { caller })
            : fail('PRECONDITION_FAILED', 'privileged host agent is not connected', { stateChanged: false }),
        })
        if (response) return response
      }
      if (pathname === '/api/server/trusted-proxies' || pathname.startsWith('/api/server/trusted-proxies/')) {
        const response = await handleTrustedProxiesWorkspaceRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit,
          readSafety: async request => ({ localAddresses: Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? []), managementClient: extractClientIp(request) }),
          readHost: (caller, path, body, managementClient) => readNativeWorkspace(caller, path, body, body !== undefined, 'POST', managementClient ?? null),
        })
        if (response) return response
      }
      if (['/api/server/panel/developer', '/api/server/panel/integrations', '/api/account/developer'].includes(pathname)) {
        const ports = { store: deps.store, requireCaller, assertRoot, emitAudit, dispatchRead: (selected: Request) => fetchInner(selected, context) }
        const response = pathname === '/api/server/panel/integrations' ? await handleIntegrationWorkspaceRoute(req, url, method, ports) : await handleDeveloperWorkspaceRoute(req, url, method, ports)
        if (response) return response
      }
      if (pathname === '/api/server/configuration-health' || pathname === '/api/server/configuration-health/repair') {
        const configurationHealth = await handleConfigurationHealthWorkspaceRoute(req, url, method, {
          requireCaller, assertRoot, emitAudit,
          callHost: (caller, path, body, mutation = false) => readNativeWorkspace(caller, path, body, mutation),
        })
        if (configurationHealth) return configurationHealth
      }
      if (pathname.startsWith('/api/server/repair/')) {
        const response = await handleRepairWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          forward: (caller, path, body) => deps.agentApp && deps.agentToken
            ? callAgent(path, { caller, ...(body === undefined ? {} : { method: 'POST', body }) })
            : fail('PRECONDITION_FAILED', 'privileged host agent is not connected', { stateChanged: false }),
        })
        if (response) return response
      }
      if (/^\/api\/server\/services\/(?:dns|ftp|certificates|dns\/zone-check)$/.test(pathname)) {
        const response = await handleServiceDetailWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          ...(deps.agentApp && deps.agentToken ? { readDetail: (caller, path) => readNativeWorkspace(caller, path) } : {}) })
        if (response) return response
      }
      if (pathname === '/api/server/dns-tools' || pathname.startsWith('/api/server/dns-tools/')) {
        const response = await handleDnsToolsWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit, triggerReconcile, store: deps.store,
          ...(deps.agentApp && deps.agentToken ? { callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}),
        })
        if (response) return response
      }
      if (pathname.startsWith('/api/server/sec/dns-providers')) {
        const response = await handleSecCloudflareRoute(req, url, method, { requireCaller, assertRoot, emitAudit, store: deps.store, fetch: globalThis.fetch })
        if (response) return response
      }
      if (pathname.startsWith('/api/server/sec/')) {
        const response = await handleSecWorkspaceRoute(req, url, method, secHelpers())
        if (response) return response
      }
      if (pathname.startsWith('/api/server/security-tools/')) {
        const response = await handleSecurityToolsWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          ...(deps.agentApp && deps.agentToken ? { callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}),
        })
        if (response) return response
      }
      if (pathname === '/api/server/monitoring-alerts' || pathname.startsWith('/api/server/monitoring-alerts/')) {
        const response = await handleMonitoringAlertsRoute(req, url, method, { requireCaller, assertRoot, emitAudit, ...alertStateFiles(deps.store), transports: await alertTransports(deps.store),
          ...(deps.agentApp && deps.agentToken ? { readHost: (caller, path) => readNativeWorkspace(caller, path) } : {}),
        })
        if (response) return response
      }
      if (pathname === '/api/server/support' || pathname === '/api/server/support/bundle') {
        const response = await handleSupportWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          readBranding: () => new ExtendedFeaturesStore(deps.store.rootDir).readOrDefault<unknown>('branding.json', null),
          ...(deps.agentApp && deps.agentToken ? { readHost: (caller, path) => readNativeWorkspace(caller, path) } : {}),
        })
        if (response) return response
      }
      if (pathname === '/api/server/server-health' || pathname === '/api/server/server-limits') {
        const response = await handleServerHealthWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          listAccounts: () => deps.store.listAccounts(),
          ...(deps.agentApp && deps.agentToken ? { readHost: (caller, path) => readNativeWorkspace(caller, path) } : {}),
        })
        if (response) return response
      }
      if (pathname.startsWith('/api/server/server-observation/')) {
        const response = await handleServerObservationWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          readSaved: () => deps.store.readSnapshot(),
          ...(deps.agentApp && deps.agentToken ? { readHost: (caller, path) => readNativeWorkspace(caller, path) } : {}),
        })
        if (response) return response
      }
      if (pathname === '/api/server/mail-quality' || pathname === '/api/server/mail-quality/check') {
        const response = await handleMailQualityWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          readSaved: () => deps.store.readSnapshot(), readDkimPublicMaterial })
        if (response) return response
      }
      if (pathname === '/api/server/mail-maintenance' || pathname === '/api/server/mail-maintenance/jobs') {
        const response = await handleMailboxMaintenanceWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          ...(deps.agentApp && deps.agentToken ? { callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}),
        })
        if (response) return response
      }
      if (pathname === '/api/account/mailx/collections') {
        const response = await createMailxCollectionsRoutes({ store: deps.store, serverSecret, requireCaller, assertCanAccessAccount, emitAudit })(req, url, method)
        if (response) return response
      }
      if (pathname.startsWith('/api/server/mailx/') || pathname === '/api/account/mailx/archive' || pathname === '/api/account/mailx/archive/retention' || pathname.startsWith('/api/account/mailx/mail-tools')) {
        const response = await createMailxWorkspaceRoutes({ store: deps.store, requireCaller, assertRoot, assertCanAccessAccount, emitAudit,
          ...(deps.agentApp && deps.agentToken ? { callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}) })(req, url, method)
        if (response) return response
      }
      if (pathname.startsWith('/api/server/mail-server/')) {
        const response = await handleMailServerWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          readSaved: () => deps.store.readSnapshot(),
          ...(deps.os ? { os: deps.os } : {}),
          ...(deps.agentApp && deps.agentToken ? { readObservation: caller => readNativeWorkspace(caller, '/host/mail/server') } : {}),
        })
        if (response) return response
      }
      if (pathname === '/api/server/mail-queue' || pathname === '/api/server/mail-queue/action') {
        const response = await handleMailQueueWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          ...(deps.agentApp && deps.agentToken ? {
            readQueue: caller => readNativeWorkspace(caller, '/host/mail/queue'),
            applyAction: (caller, input) => readNativeWorkspace(caller, '/host/mail/queue/action', input, true),
          } : {}),
        })
        if (response) return response
      }
      if (pathname === '/api/server/php/inventory' || pathname === '/api/server/php/usage') {
        let snapshot: ReturnType<StateStore['readSnapshot']> | undefined
        const source = () => snapshot ??= deps.store.readSnapshot()
        const response = await handlePhpWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          readInventory: caller => callAgent('/host/php/inventory', { caller }),
          listDomains: async () => (await source()).domains,
          listAccounts: async () => (await source()).accounts,
        })
        if (response) return response
      }
      if (/^\/api\/security\/(?:workspace|ssh(?:\/keys)?)$/.test(pathname)) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'security.workspace')
        const router = createSecurityWorkspaceRoutes({ store: deps.store, requireCaller, assertRoot, emitAudit,
          assertKeyMutationQualified: () => deps.assertSshKeyMutationQualified ? deps.assertSshKeyMutationQualified() : fail('PRECONDITION_FAILED', 'SSH key mutation admission is unavailable', { stateChanged: false }),
          observeSsh: input => readNativeWorkspace(caller, '/host/security/ssh?window=' + input.window),
          addRootKey: input => readNativeWorkspace(caller, '/host/security/ssh/keys', input, true),
          removeManagedRootKey: input => readNativeWorkspace(caller, '/host/security/ssh/keys', input, true, 'DELETE'),
        })
        const response = await router(req, url, method)
        if (response) return response
      }
      const quarantineResponse = await quarantineRouter(req, url, method)
      if (quarantineResponse) return quarantineResponse
      const htaccessMatch = HTACCESS_DOMAIN_ROUTE.exec(pathname)
      if (htaccessMatch) {
        if (url.search) return fail('VALIDATION', '.htaccess does not accept scope selectors', { stateChanged: false })
        const caller = await requireCaller(req)
        const domain = await deps.store.getDomain(htaccessMatch[1]!.toLowerCase())
        const account = domain ? await deps.store.getAccount(domain.accountId) : null
        if (!domain || !account) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
        await assertCanAccessAccount(caller, account, 'domain.htaccess')
        await assertAccountFeatures(deps.store, caller, account, ['aapanel-url-rewrite'])
        const request = parseHtaccessHttpRequest(method, htaccessMatch[2], method === 'GET' ? undefined : await readJsonBody(req))
        return await executeHtaccessWorkspaceRequest({ accountId: account.id, domainId: domain.id }, request, () => callAgent('/accounts/' + account.username + '/htaccess/' + domain.id, { caller, method: 'POST', body: request }))
      }

      const webDirectivesResponse = await handleWebDirectivesRoute(req, url, method, { store: deps.store, requireCaller, assertCanAccessAccount, readJsonBody, callAgent })
      if (webDirectivesResponse) return webDirectivesResponse

      const certificateResponse = await certificateRuntimeRouter(req, url, method)
      if (certificateResponse) return certificateResponse

      const accountShellMatch = /^\/api\/accounts\/([a-z][a-z0-9]{0,15})\/shell$/.exec(pathname)
      if (method === 'POST' && accountShellMatch) {
        const caller = await requireCaller(req)
        const username = accountShellMatch[1]!
        const account = await deps.store.getAccountByUsername(username)
        if (!account) return fail('NOT_FOUND', `account "${username}" not found`)
        await assertCanAccessAccount(caller, account, 'shell')
        const body = await readJsonBody(req)
        return callAgent(`/accounts/${username}/shell`, {
          method: 'POST',
          caller,
          body,
        })
      }

      // ---- Accounts CRUD & Lifecycle -------------------------------------------------
      if (method === 'GET' && pathname === '/api/accounts') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'root') {
          return jsonResponse({ accounts: await deps.store.listAccounts() })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          return jsonResponse({
            accounts: resellerId ? await deps.store.listAccounts({ ownerId: resellerId }) : [],
          })
        }
        const acc = await deps.store.getAccount(caller.principal.accountId)
        return jsonResponse({ accounts: acc ? [acc] : [] })
      }

      if (pathname === '/api/account/preferences') {
        const caller = await requireCaller(req)
        if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'hosting account owner access is required')
        if (new URL(req.url).searchParams.size > 0) return fail('VALIDATION', 'account preferences do not accept query selectors')
        const target = await deps.store.getAccount(caller.principal.accountId)
        if (!target || target.status !== 'active') return fail('FORBIDDEN', 'active hosting account owner access is required')
        await assertCanAccessAccount(caller, target, 'account.contact.read')
        await assertAccountFeatures(deps.store, caller, target, ['account-preferences'])
        let account = target
        if (method === 'PATCH') {
          const body = await readJsonBody<Record<string, unknown>>(req)
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
            || !Object.hasOwn(body, 'contactEmail') || !Object.hasOwn(body, 'expectedRevision') || typeof body.expectedRevision !== 'string') {
            return fail('VALIDATION', 'contactEmail and expectedRevision are required; other settings are not accepted')
          }
          account = await updateContactMetadata(req, caller, target, body.contactEmail, body.expectedRevision, true)
        } else if (method !== 'GET') return fail('FORBIDDEN', 'unsupported account preferences method')
        return jsonResponse({ ...(method === 'PATCH' && { ok: true, stateChanged: true }), context: { accountId: account.id },
          preferences: { contactEmail: account.contactEmail }, revision: accountContactRevision(account) })
      }

      if (method === 'POST' && pathname === '/api/accounts') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user') return fail('FORBIDDEN', 'user accounts cannot create hosting accounts')
        const body = await readJsonBody<Partial<NewAccount> & { username: string; primaryDomain: string; planId: Id; password?: string }>(req)
        requireAccountHostAgent()
        const username = validateUsername(body.username)
        const passwordHash = await passwordHashFromInput(body)
        let ownerId: Id | null
        let expectedRevision: number
        let template: AccountTemplate | null = null, nameservers: string[] = []
        const lease = await deps.store.getWriterLock().acquire()
        try {
          const reseller = caller.principal.kind === 'reseller' ? await resolveResellerForCaller(caller) : null
          if (caller.principal.kind === 'reseller') {
            if (!reseller) return fail('FORBIDDEN', 'reseller authorization is unavailable')
            assertAcl(caller.principal, reseller, 'create-account')
          }
          ownerId = caller.principal.kind === 'reseller' ? reseller!.id : body.ownerId ?? null
          if (await findPrincipalByUsername(deps.db, username) || await deps.store.getAccountByUsername(username)) return fail('CONFLICT', 'the account username is already reserved')
          // The plan template is read and proven against this domain before any state changes; an unreadable file refuses.
          nameservers = (await deps.store.getServerSettings())?.nameservers ?? []
          template = templateForNewAccount(await new ExtendedFeaturesStore(deps.store.rootDir).readOrDefault<unknown>('accounts/templates.json', null), body.planId, validateDomainName(body.primaryDomain), nameservers)
          if (template && await deps.store.getDnsZone(body.primaryDomain)) return fail('CONFLICT', 'a DNS zone for this domain already exists, so the plan template cannot add its records', { stateChanged: false })
          expectedRevision = (await lease.assertFencingToken()).revision
        } finally { await lease.release() }
        const account = await deps.store.createAccount({ username, passwordHash, primaryDomain: body.primaryDomain, planId: body.planId,
          ownerId, contactEmail: body.contactEmail ?? username + '@' + body.primaryDomain,
          ...(body.ipv4 !== undefined && { ipv4: body.ipv4 }), ...(body.ipAssignment !== undefined && { ipAssignment: body.ipAssignment }),
          ...(body.ipv6 !== undefined && { ipv6: body.ipv6 }), ...(body.extraIps !== undefined && { extraIps: body.extraIps }),
          shell: body.shell ?? 'jailed', php: body.php ?? defaultPhp('8.3'), ...(body.homeBase !== undefined && { homeBase: body.homeBase }),
        }, { expectedRevision })
        if (template) {
          try { await deps.store.saveDnsZone({ id: randomUUID(), name: account.primaryDomain, accountId: account.id, serial: 2026102201, records: accountTemplateZoneRecords(template, account, nameservers).map(record => ({ id: randomUUID(), ...record })) }, { expectedRevision: expectedRevision + 1 }) }
          catch { return accountMutationFailure(caller, account, 'create', 'failed', 'template_zone_unverified', 'PRECONDITION_FAILED') }
        }
        const reconcile = await applyAccountConfiguration(caller, account, 'create', expectedRevision + (template ? 2 : 1))
        try {
          const existing = await findPrincipalByUsername(deps.db, account.username)
          if (existing && (existing.kind !== 'user' || existing.accountId !== account.id)) {
            return accountMutationFailure(caller, account, 'create', 'unknown', 'identity_binding_conflict', 'CONFLICT')
          }
          if (!existing) await createUserPrincipal(deps.db, { username: account.username, passwordHash, accountId: account.id })
        } catch { return accountMutationFailure(caller, account, 'create', 'unknown', 'identity_establishment_unverified') }
        await emitAudit({ actor: caller.principal.username, action: 'account.desired.created', target: 'account:' + account.username,
          detail: { accountId: account.id, primaryDomain: account.primaryDomain, planId: account.planId, templateId: template?.id ?? null, execution: accountExecution() }, outcome: 'ok', principalId: caller.principal.id,
        }, { accountId: account.id, resellerId: account.ownerId })
        const primaryDomains = await deps.store.listDomains({ accountId: account.id })
        return jsonResponse({ account, primaryDomain: primaryDomains[0] ?? null, reconcile, execution: await observeAccountExecution(caller, account.ipv4) }, 201)
      }

      const accountSuspendMatch = /^\/api\/accounts\/([^/]+)\/(suspend|unsuspend)$/.exec(pathname)
      if (method === 'POST' && accountSuspendMatch) {
        const caller = await requireCaller(req)
        const target = await resolveAccountParam(accountSuspendMatch[1]!)
        const verb = accountSuspendMatch[2]!
        await assertCanAccessAccount(caller, target, 'account.' + verb, { allowUserSelf: false })
        const body = await readJsonBody<{ reason?: string }>(req)
        requireAccountHostAgent()
        const captured = await captureAccountMutation(caller, target.id, 'account.' + verb, account => {
          const expected = verb === 'suspend' ? 'active' : 'suspended'
          if (account.status !== expected) fail('CONFLICT', 'account is not in the expected state for this transition')
        }, verb === 'unsuspend' ? async account => {
          try { await revokeAccountSessionsAndTokens(deps.db, account.id) }
          catch { fail('SERVICE_UNAVAILABLE', 'account access cleanup requires verification', { reason: 'access_revocation_failed', verificationRequired: true, stateChanged: false }) }
        } : undefined)
        const updated = verb === 'suspend'
          ? await deps.store.suspendAccount(captured.account.id, body.reason || 'Suspended by administrator', { expectedRevision: captured.expectedRevision })
          : await deps.store.unsuspendAccount(captured.account.id, { expectedRevision: captured.expectedRevision })
        if (verb === 'suspend') {
          try { await revokeAccountSessionsAndTokens(deps.db, updated.id) }
          catch { return accountMutationFailure(caller, updated, verb, 'unknown', 'access_revocation_failed') }
        }
        const reconcile = await applyAccountConfiguration(caller, updated, verb, captured.expectedRevision + 1)
        await emitAudit({ actor: caller.principal.username, action: 'account.desired.' + (verb === 'suspend' ? 'suspended' : 'unsuspended'),
          target: 'account:' + updated.username, detail: { accountStatus: updated.status, reason: updated.suspendReason, execution: accountExecution() }, outcome: 'ok', principalId: caller.principal.id,
        }, { accountId: updated.id, resellerId: updated.ownerId })
        return jsonResponse({ account: updated, reconcile, execution: accountExecution() })
      }

      const accountItemMatch = /^\/api\/accounts\/([^/]+)$/.exec(pathname)
      if (accountItemMatch) {
        const caller = await requireCaller(req)
        const target = await resolveAccountParam(accountItemMatch[1]!)
        if (method === 'GET') {
          await assertCanAccessAccount(caller, target, 'account.read')
          return jsonResponse({ account: target, domains: await deps.store.listDomains({ accountId: target.id }) })
        }
        if (method === 'PATCH') {
          await assertCanAccessAccount(caller, target, 'account.update', { allowUserSelf: false })
          const patch = await readJsonBody<{ planId?: Id; ownerId?: Id | null; contactEmail?: string; ipv4?: string; ipv6?: string | null; shell?: 'none' | 'jailed' }>(req)
          if (Object.keys(patch).some(key => !['planId', 'ownerId', 'contactEmail', 'ipv4', 'ipv6', 'shell'].includes(key))) return fail('VALIDATION', 'unsupported account setting')
          const metadataOnly = Object.keys(patch).length === 1 && Object.hasOwn(patch, 'contactEmail')
          if (metadataOnly) {
            const updated = await updateContactMetadata(req, caller, target, patch.contactEmail, accountContactRevision(target), false)
            return jsonResponse({ account: updated, stateChanged: true })
          }
          requireAccountHostAgent()
          const captured = await captureAccountMutation(caller, target.id, 'account.update', async account => {
            if (patch.planId && patch.planId !== account.planId && caller.principal.kind === 'reseller') assertAcl(caller.principal, await resolveResellerForCaller(caller), 'change-plan')
            if (patch.ownerId !== undefined && patch.ownerId !== account.ownerId) await assertRoot(caller, 'account.change_owner')
            if (!Object.entries(patch).some(([key, value]) => value !== undefined && value !== account[key as keyof Account])) return fail('CONFLICT', 'account already has the requested settings')
          })
          let updated = captured.account
          let expectedRevision = captured.expectedRevision
          if (patch.planId && patch.planId !== updated.planId) { updated = await deps.store.changePlan(updated.id, patch.planId, { expectedRevision }); expectedRevision++ }
          if (patch.ownerId !== undefined && patch.ownerId !== updated.ownerId) { updated = await deps.store.changeOwner(updated.id, patch.ownerId, { expectedRevision }); expectedRevision++ }
          if (patch.contactEmail !== undefined || patch.ipv4 !== undefined || patch.ipv6 !== undefined || patch.shell !== undefined) {
            updated = await deps.store.updateAccount(updated.id, patch, { expectedRevision }); expectedRevision++
          }
          const reconcile = await applyAccountConfiguration(caller, updated, 'update', expectedRevision)
          await emitAudit({ actor: caller.principal.username, action: 'account.desired.updated', target: 'account:' + updated.username,
            detail: { execution: accountExecution() }, outcome: 'ok', principalId: caller.principal.id,
          }, { accountId: updated.id, resellerId: updated.ownerId })
          return jsonResponse({ account: updated, reconcile, execution: accountExecution() })
        }
        if (method === 'DELETE') {
          await assertCanAccessAccount(caller, target, 'account.delete', { allowUserSelf: false })
          const body = await readJsonBody<{ confirmUsername?: unknown }>(req)
          if (Object.keys(body).some(key => key !== 'confirmUsername') || typeof body.confirmUsername !== 'string' || body.confirmUsername !== target.username) {
            return fail('VALIDATION', 'confirmation must match the account username')
          }
          const current = await deps.store.getAccount(target.id)
          if (!current) return fail('NOT_FOUND', 'account not found')
          await assertCanAccessAccount(caller, current, 'account.delete', { allowUserSelf: false })
          if (body.confirmUsername !== current.username) return fail('CONFLICT', 'account confirmation is no longer current')
          const unavailable = () => fail('PRECONDITION_FAILED', 'account termination requires a verified target-bound purge operation', {
            verificationRequired: true, reason: 'target_bound_purge_unavailable', stateChanged: false,
          })
          let probe: Response
          try { probe = await callAgent(`/accounts/${current.username}/purge`, { method: 'GET', caller }) }
          catch { return unavailable() }
          if (!probe.ok) {
            await probe.body?.cancel().catch(() => undefined)
            return unavailable()
          }
          const probeBody = await probe.json().catch(() => null) as { available?: unknown; contract?: unknown } | null
          if (probeBody?.available !== true || probeBody.contract !== 'target-bound-userdel') return unavailable()
          const marked = await deps.store.markTerminating(current.id)
          const purge = await callAgent(`/accounts/${marked.username}/purge`, {
            method: 'POST', caller, body: { confirmUsername: marked.username, uid: marked.uid, home: marked.home },
          })
          const purgeBody = await purge.json().catch(() => null) as { purged?: unknown; reason?: unknown } | null
          if (!purge.ok || purgeBody?.purged !== true) {
            return fail('SERVICE_UNAVAILABLE', 'account purge did not complete', {
              verificationRequired: true, reason: typeof purgeBody?.reason === 'string' ? purgeBody.reason : 'purge_failed', stateChanged: true,
            })
          }
          await revokeAccountSessionsAndTokens(deps.db, marked.id)
          const identities = await deps.db.query<{ id: string }>('SELECT id FROM principals WHERE account_id = $1 ORDER BY id', [marked.id])
          for (const identity of identities) await deletePrincipal(deps.db, identity.id)
          await deps.store.deleteAccount(marked.id)
          await reindexFromState(deps.db, await deps.store.readSnapshot())
          await emitAudit({ actor: caller.principal.username, action: 'account.terminated', target: 'account:' + marked.username,
            detail: { purged: true }, outcome: 'ok', principalId: caller.principal.id,
          }, { accountId: marked.id, resellerId: marked.ownerId })
          return jsonResponse({ ok: true, purged: true })
        }
      }

      const accountPasswordMatch = /^\/api\/accounts\/([^/]+)\/password$/.exec(pathname)
      if (method === 'POST' && accountPasswordMatch) {
        const caller = await requireCaller(req)
        const target = await resolveAccountParam(accountPasswordMatch[1]!)
        await assertCanAccessAccount(caller, target, 'account.password', { allowUserSelf: false })
        if (caller.principal.kind === 'reseller') assertAcl(caller.principal, await resolveResellerForCaller(caller), 'change-password')
        const body = await readJsonBody<{ password?: string }>(req)
        const passwordHash = await passwordHashFromInput({ password: body.password })
        const identities = await deps.db.query<{ id: string }>('SELECT id FROM principals WHERE account_id = $1 ORDER BY id', [target.id])
        if (identities.length === 0) {
          const taken = await findPrincipalByUsername(deps.db, target.username)
          if (taken) return fail('CONFLICT', 'login identity is not bound to this account', { stateChanged: false })
          const created = await createUserPrincipal(deps.db, { username: target.username, passwordHash, accountId: target.id })
          identities.push({ id: created.id })
        }
        for (const identity of identities) await setPasswordHash(deps.db, identity.id, passwordHash)
        await emitAudit({ actor: caller.principal.username, action: 'account.password.changed', target: 'account:' + target.username,
          detail: { principals: identities.length }, outcome: 'ok', principalId: caller.principal.id,
        }, { accountId: target.id, resellerId: target.ownerId })
        return jsonResponse({ ok: true, accountId: target.id, principals: identities.length })
      }

      // ---- Multi-IPv4 / IPv6 Pool Management -----------------------------------------
      if (method === 'GET' && pathname === '/api/ips') {
        const caller = await requireCaller(req)
        if (url.searchParams.size > 0) {
          const allowed = new Set(['view', 'planId', 'ownerId'])
          for (const key of url.searchParams.keys()) {
            if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return fail('VALIDATION', 'invalid or repeated IP allocation query parameter')
          }
          const planId = url.searchParams.get('planId'), requestedOwner = url.searchParams.get('ownerId')
          if (url.searchParams.get('view') !== 'allocation' || !isUuid(planId) || planId !== planId.toLowerCase()
            || (requestedOwner !== null && (!isUuid(requestedOwner) || requestedOwner !== requestedOwner.toLowerCase()))) {
            return fail('VALIDATION', 'allocation preview requires a canonical planId and optional ownerId UUID')
          }
          let ownerId: Id | null = requestedOwner
          if (caller.principal.kind === 'reseller') {
            const resellerId = await resolveResellerId(caller)
            if (!resellerId || (requestedOwner !== null && requestedOwner !== resellerId)) return fail('FORBIDDEN', 'allocation preview owner must match the authenticated reseller')
            ownerId = resellerId
          } else if (caller.principal.kind !== 'root') {
            return fail('FORBIDDEN', 'hosting administrator permission is required for allocation preview')
          }
          return jsonResponse(await deps.store.readAccountIpAllocationOptions({ planId, ownerId }))
        }
        const all = await deps.store.listServerIps()
        if (caller.principal.kind === 'root') {
          return jsonResponse({ ips: all })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          return jsonResponse({
            ips: all.filter((ip) => ip.role === 'shared' || ip.ownerId === null || ip.ownerId === resellerId),
          })
        }
        const account = await deps.store.getAccount(caller.principal.accountId)
        return jsonResponse({
          ips: all.filter((ip) => ip.address === account?.ipv4 || ip.address === account?.ipv6),
        })
      }

      if (method === 'POST' && pathname === '/api/ips') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'ips.save')
        const body = await readJsonBody<Partial<ServerIpEntry> & { address: string }>(req)
        if (typeof body.address !== 'string') return fail('VALIDATION', 'address must be an IP address string')
        const version: 4 | 6 = body.version ?? (body.address.includes(':') ? 6 : 4)
        const ip = await deps.store.saveServerIp({
          ...(body.id && { id: body.id }),
          address: body.address,
          version,
          prefixLength: body.prefixLength ?? (version === 6 ? 64 : 24),
          interfaceName: body.interfaceName ?? 'eth0',
          role: body.role ?? 'shared',
          ownerKind: body.ownerKind ?? 'root',
          ownerId: body.ownerId ?? null,
          ptrHostname: body.ptrHostname ?? null,
          isPrimary: body.isPrimary ?? false,
          notes: body.notes ?? '',
        })
        const reconcile = await triggerReconcile(caller)
        await emitAudit({
          actor: caller.principal.username,
          action: 'ip.saved',
          target: `ip:${ip.address}`,
          detail: { id: ip.id, version: ip.version, role: ip.role, ownerId: ip.ownerId },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ip, reconcile: reconcile?.body ?? null }, 201)
      }

      const ipDeleteMatch = /^\/api\/ips\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'DELETE' && ipDeleteMatch) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'ips.delete')
        const ipId = ipDeleteMatch[1]!.toLowerCase()
        if (!await deps.store.deleteServerIp(ipId)) return fail('NOT_FOUND', 'IP pool entry not found')
        const reconcile = await triggerReconcile(caller)
        await emitAudit({
          actor: caller.principal.username,
          action: 'ip.deleted',
          target: `ip:${ipId}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
      }

      // ---- Mail Outbound IP Configuration --------------------------------------------
      if (method === 'GET' && pathname === '/api/mail/ips') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'mail.ips.read')
        return jsonResponse({ config: await deps.store.getMailIpConfig() })
      }

      if (method === 'PUT' && pathname === '/api/mail/ips') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'mail.ips.update')
        const body = await readJsonBody<MailIpConfig>(req)
        const config = await deps.store.saveMailIpConfig(body)
        const reconcile = await triggerReconcile(caller)
        await emitAudit({
          actor: caller.principal.username,
          action: 'mail.ips.updated',
          target: 'mail:ips',
          detail: { mode: config.mode, overridesCount: config.domainOverrides.length },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ config, reconcile: reconcile?.body ?? null })
      }

      // ---- Domains & Smart Custom Configuration (userdata) ---------------------------
      const domainCustomMatch = /^\/api\/domains\/([0-9a-f-]{36})\/custom-config$/i.exec(pathname)
      if (domainCustomMatch) {
        const caller = await requireCaller(req)
        const domainId = domainCustomMatch[1]!.toLowerCase()
        const domain = await deps.store.getDomain(domainId)
        if (!domain) return fail('NOT_FOUND', `domain "${domainId}" not found`)
        const account = await deps.store.getAccount(domain.accountId)
        if (!account) return fail('NOT_FOUND', `account "${domain.accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'domain.custom_config')

        if (method === 'GET') {
          return jsonResponse({ config: await deps.store.getDomainCustomConfig(domain.id) })
        }

        if (method === 'PUT') {
          const body = await readJsonBody<
            Partial<DomainCustomConfig> & { allowRootDirectives?: boolean }
          >(req)
          const allowRootDirectives = caller.principal.kind === 'root' && Boolean(body.allowRootDirectives)
          const validated = validateDomainCustomConfig(
            {
              ...body,
              domainId: domain.id,
              accountId: account.id,
              domainName: domain.name,
              updatedBy: caller.principal.kind,
            },
            { allowRootDirectives, accountHome: account.home },
          )

          const previousConfig = await deps.store.getDomainCustomConfig(domain.id)
          const saved = await deps.store.saveDomainCustomConfig(validated)
          const reconcile = await triggerReconcile(caller, {
            force: true,
            scope: { accountId: account.id, resellerId: account.ownerId },
          })

          if (reconcile && (!reconcile.ok || reconcile.body.status === 'failed')) {
            if (previousConfig) {
              await deps.store.saveDomainCustomConfig(previousConfig)
            } else {
              await deps.store.deleteDomainCustomConfig(domain.id)
            }
            await emitAudit(
              {
                actor: caller.principal.username,
                action: 'domain.custom_config.rollback',
                target: `domain:${domain.name}`,
                detail: {
                  domainId: domain.id,
                  failedTest: reconcile.body.failedTest,
                  error: reconcile.body.error,
                },
                outcome: 'failed',
                principalId: caller.principal.id,
              },
              { accountId: account.id, resellerId: account.ownerId },
            )
            return fail(
              'CONFIG_TEST_FAILED',
              `custom config for "${domain.name}" failed service config test (${String(reconcile.body.failedTest ?? 'test')}) and was automatically rolled back`,
              {
                domainId: domain.id,
                rolledBack: true,
                failedTest: reconcile.body.failedTest,
                error: reconcile.body.error,
                reconcile: reconcile.body,
              },
            )
          }

          await emitAudit(
            {
              actor: caller.principal.username,
              action: 'domain.custom_config.updated',
              target: `domain:${domain.name}`,
              detail: { domainId: domain.id },
              outcome: 'ok',
              principalId: caller.principal.id,
            },
            { accountId: account.id, resellerId: account.ownerId },
          )
          return jsonResponse({ config: saved, reconcile: reconcile?.body ?? null })
        }

        if (method === 'DELETE') {
          await deps.store.deleteDomainCustomConfig(domain.id)
          const reconcile = await triggerReconcile(caller, {
            force: true,
            scope: { accountId: account.id, resellerId: account.ownerId },
          })
          await emitAudit(
            {
              actor: caller.principal.username,
              action: 'domain.custom_config.deleted',
              target: `domain:${domain.name}`,
              outcome: 'ok',
              principalId: caller.principal.id,
            },
            { accountId: account.id, resellerId: account.ownerId },
          )
          return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
        }
      }

      if (method === 'GET' && pathname === '/api/domains') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user') {
          if (url.searchParams.size) return fail('VALIDATION', 'domain workspace does not accept query selectors', { stateChanged: false })
          const workspace = await deps.store.readDomainWorkspace(caller.principal.accountId)
          if (workspace.source.account.status !== 'active') return fail('FORBIDDEN', 'active hosting account owner access is required')
          await assertCanAccessAccount(caller, workspace.source.account, 'domains.list')
          return jsonResponse(domainWorkspaceView(workspace))
        }
        const accountIdFilter = url.searchParams.get('accountId') ?? undefined
        if (url.searchParams.has('workspace')) {
          if (url.searchParams.get('workspace') !== '1' || !accountIdFilter || url.searchParams.size !== 2
            || url.searchParams.getAll('accountId').length !== 1 || url.searchParams.getAll('workspace').length !== 1
            || [...url.searchParams.keys()].some(key => !['accountId', 'workspace'].includes(key))) return fail('VALIDATION', 'select one account domain workspace', { stateChanged: false })
          if (caller.principal.kind !== 'root' && caller.principal.kind !== 'reseller') return fail('FORBIDDEN', 'hosting account access is required')
          const account = await deps.store.getAccount(accountIdFilter)
          if (!account) return fail('NOT_FOUND', 'account not found')
          await assertCanAccessAccount(caller, account, 'domains.list')
          const workspace = await deps.store.readDomainWorkspace(account.id)
          await assertCanAccessAccount(caller, workspace.source.account, 'domains.list')
          return jsonResponse(domainWorkspaceView(workspace))
        }
        if (caller.principal.kind === 'root') {
          return jsonResponse({
            domains: await deps.store.listDomains(accountIdFilter ? { accountId: accountIdFilter } : undefined),
          })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const accounts = resellerId ? await ownedAccounts(deps.store, caller) : []
          const ownedIds = new Set(accounts.map((a) => a.id))
          const allDomains = await deps.store.listDomains(accountIdFilter ? { accountId: accountIdFilter } : undefined)
          return jsonResponse({ domains: allDomains.filter((d) => ownedIds.has(d.accountId)) })
        }
        return fail('FORBIDDEN', 'hosting account access is required')
      }

      if (method === 'POST' && pathname === '/api/domains') {
        const caller = await requireCaller(req)
        const body = await readJsonBody<Partial<NewDomain> & { name: string; parentDomainId?: Id | null; expectedRevision?: unknown }>(req)
        const self = caller.principal.kind === 'user'
        const guarded = self || body.expectedRevision !== undefined
        if (guarded) {
          if (url.searchParams.size || Object.keys(body).some(key => !['name', 'kind', 'parentId', 'docRoot', 'siteType', 'expectedRevision', ...(!self ? ['accountId'] : [])].includes(key))) return fail('VALIDATION', 'unsupported domain workspace fields', { stateChanged: false })
          if (typeof body.kind !== 'string' || !['addon', 'alias', 'subdomain'].includes(body.kind)) return fail('VALIDATION', 'domain kind is required', { stateChanged: false })
          if (body.siteType !== undefined && !['php', 'static'].includes(body.siteType)) return fail('VALIDATION', 'unsupported site type', { stateChanged: false })
          if (body.kind === 'alias' && (Object.hasOwn(body, 'docRoot') || Object.hasOwn(body, 'siteType'))) return fail('VALIDATION', 'alias settings are derived from the parent', { stateChanged: false })
        }
        const accountId =
          caller.principal.kind === 'user' ? caller.principal.accountId : (body.accountId ?? '')
        if (!accountId) return fail('VALIDATION', 'accountId is required')
        const account = await deps.store.getAccount(accountId)
        if (!account) return fail('NOT_FOUND', `account "${accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'domain.create')
        if (body.certificateId) await assertCanBindCertificate(caller, account)

        const existingDomains = await deps.store.listDomains({ accountId: account.id })
        const primaryDomain = existingDomains.find((d) => d.kind === 'primary')
        const name = validateDomainName(body.name)
        const parentId = body.parentId ?? body.parentDomainId ?? null
        const parent = parentId ? existingDomains.find(domain => domain.id === parentId) : undefined
        if (guarded && (body.kind === 'alias' || body.kind === 'subdomain') && (!parent || parent.kind === 'alias')) return fail('VALIDATION', 'an owned non-alias parent is required', { stateChanged: false })
        const alias = guarded && body.kind === 'alias' ? parent : undefined
        const result = await mutateDomainWorkspace(req, caller, account, body.expectedRevision, 'domain.created', options => deps.store.createDomain({
          accountId: account.id,
          name,
          kind: body.kind ?? 'addon',
          parentId,
          docRoot: alias?.docRoot ?? body.docRoot ?? `${account.home}/domains/${name}/public_html`,
          siteType: alias?.siteType ?? body.siteType ?? 'php',
          upstream: alias?.upstream ?? body.upstream ?? null,
          redirect: alias?.redirect ?? body.redirect ?? null,
          php: alias?.php ?? body.php ?? primaryDomain?.php ?? defaultPhp('8.3'),
          wildcard: body.wildcard ?? false,
          certificateId: body.certificateId ?? null,
          suspended: body.suspended ?? false,
          expiresAt: body.expiresAt ?? null,
          pathQuotaMb: body.pathQuotaMb ?? 'unlimited',
          ...(body.ipv4 !== undefined && { ipv4: body.ipv4 }),
          ...(body.ipv6 !== undefined && { ipv6: body.ipv6 }),
        }, options), Boolean(body.certificateId))
        return jsonResponse({ domain: result.value, stateChanged: true, ...result.view, reconcile: result.reconcile }, 201)
      }

      const domainIdMatch = /^\/api\/domains\/([0-9a-f-]{36})$/i.exec(pathname)
      if (domainIdMatch) {
        const caller = await requireCaller(req)
        const domainId = domainIdMatch[1]!.toLowerCase()
        const existing = await deps.store.getDomain(domainId)
        if (!existing) return fail('NOT_FOUND', `domain "${domainId}" not found`)
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', `account "${existing.accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'domain.modify')
        const self = caller.principal.kind === 'user'
        if (self && url.searchParams.size) return fail('VALIDATION', 'domain workspace does not accept query selectors', { stateChanged: false })

        if (method === 'PATCH') {
          const body = await readJsonBody<DomainPatch & { expectedRevision?: unknown }>(req)
          if (Object.hasOwn(body, 'indexFiles')) return fail('VALIDATION', 'index files must be changed through the root default-index workspace', { stateChanged: false })
          const guarded = self || body.expectedRevision !== undefined
          if (guarded && (url.searchParams.size || Object.keys(body).some(key => !['docRoot', 'php', 'expectedRevision'].includes(key)) || (!Object.hasOwn(body, 'docRoot') && !Object.hasOwn(body, 'php')))) return fail('VALIDATION', 'only document root and PHP settings changes are accepted', { stateChanged: false })
          if (guarded && Object.hasOwn(body, 'php')) await assertAccountFeatures(deps.store, caller, account, ['domain-php-settings'])
          const { expectedRevision, ...patch } = body
          if (patch.certificateId !== undefined && patch.certificateId !== existing.certificateId) await assertCanBindCertificate(caller, account)
          const result = await mutateDomainWorkspace(req, caller, account, expectedRevision, 'domain.updated', options => deps.store.updateDomain(domainId, patch, options), patch.certificateId !== undefined && patch.certificateId !== existing.certificateId)
          return jsonResponse({ domain: result.value, stateChanged: true, ...result.view, reconcile: result.reconcile })
        }
        if (method === 'DELETE') {
          const body = await readJsonBody<{ confirmName?: unknown; expectedRevision?: unknown }>(req)
          const guarded = self || body.expectedRevision !== undefined
          if (guarded && (url.searchParams.size || Object.keys(body).some(key => !['confirmName', 'expectedRevision'].includes(key)) || body.confirmName !== existing.name)) return fail('VALIDATION', 'confirm the exact domain name', { stateChanged: false })
          const result = await mutateDomainWorkspace(req, caller, account, body.expectedRevision, 'domain.deleted', options => deps.store.deleteDomain(domainId, options), false, existing.name)
          return jsonResponse({ ok: result.value, removed: { id: existing.id, name: existing.name }, stateChanged: true, ...result.view, reconcile: result.reconcile })
        }
      }

      // ---- Databases -----------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/databases') {
        const caller = await requireCaller(req)
        const includeTrashed = url.searchParams.get('includeTrashed') === 'true'
        if (caller.principal.kind === 'user') {
          if ([...url.searchParams.keys()].some(key => key !== 'includeTrashed') || url.searchParams.getAll('includeTrashed').length > 1
            || (url.searchParams.has('includeTrashed') && !['true', 'false'].includes(url.searchParams.get('includeTrashed')!))) return fail('VALIDATION', 'unsupported database workspace selectors', { stateChanged: false })
          const account = await deps.store.getAccount(caller.principal.accountId)
          if (!account || account.status !== 'active') return fail('FORBIDDEN', 'active hosting account owner access is required')
          await assertCanAccessAccount(caller, account, 'database.list')
          const workspace = await deps.store.readAccountDatabases(account.id, { username: account.username, includeTrashed })
          return jsonResponse({
            context: { accountId: account.id }, databases: workspace.databases,
            application: { status: 'unverified', targetVerified: false },
          })
        }
        const accountId = url.searchParams.get('accountId')
        if (accountId) {
          const account = await deps.store.getAccount(accountId)
          if (!account) return fail('NOT_FOUND', `account "${accountId}" not found`)
          await assertCanAccessAccount(caller, account, 'databases.list')
          return jsonResponse({
            databases: await deps.store.listDatabases(account.id, { includeTrashed }),
          })
        }
        const snap = await deps.store.readSnapshot()
        if (caller.principal.kind === 'root') {
          return jsonResponse({
            databases: includeTrashed ? snap.databases : snap.databases.filter((d) => d.trashedAt === null),
          })
        }
        const resellerId = await resolveResellerId(caller)
        const ownedIds = new Set((await ownedAccounts(deps.store, caller)).map(account => account.id))
        return jsonResponse({
          databases: snap.databases.filter(
            (d) => ownedIds.has(d.accountId) && (includeTrashed || d.trashedAt === null),
          ),
        })
      }

      if (method === 'POST' && pathname === '/api/databases') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user' && url.searchParams.size) return fail('VALIDATION', 'database creation does not accept owner selectors', { stateChanged: false })
        const body = await readJsonBody<{ accountId?: Id; name: string }>(req)
        const accountId =
          caller.principal.kind === 'user' ? caller.principal.accountId : (body.accountId ?? '')
        if (!accountId) return fail('VALIDATION', 'accountId is required')
        const account = await deps.store.getAccount(accountId)
        if (!account) return fail('NOT_FOUND', `account "${accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'database.create')
        const parsed = caller.principal.kind === 'user' ? parseOwnerDatabaseCreateRequest(body, account.username) : body
        const result = await mutateDatabaseWorkspace(req, caller, account, 'database.created', 'database', options =>
          deps.store.createDatabase({ accountId: account.id, name: parsed.name }, {
            ...options, prepareIndex: (freshAccount, database) => prepareDatabaseIndexCreation(deps.db, freshAccount, database),
          }))
        return jsonResponse({ database: result.value, context: result.context, application: result.application,
          stateChanged: true, reconcile: result.reconcile }, 201)
      }

      const dbTrashRestoreMatch = /^\/api\/databases\/([0-9a-f-]{36})\/(trash|restore)$/i.exec(pathname)
      if (method === 'POST' && dbTrashRestoreMatch) {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user' && url.searchParams.size) return fail('VALIDATION', 'database state changes do not accept owner selectors', { stateChanged: false })
        const dbId = dbTrashRestoreMatch[1]!.toLowerCase()
        const verb = dbTrashRestoreMatch[2] === 'trash' ? 'trash' : 'restore'
        const existing = await deps.store.getDatabase(dbId)
        if (!existing) return fail('NOT_FOUND', `database "${dbId}" not found`)
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', `account "${existing.accountId}" not found`)
        await assertCanAccessAccount(caller, account, `database.${verb}`)
        const guard = caller.principal.kind === 'user'
          ? parseOwnerDatabaseStateRequest(await readJsonBody<unknown>(req), verb) : undefined
        const result = await mutateDatabaseWorkspace(req, caller, account, `database.${verb === 'trash' ? 'trashed' : 'restored'}`, 'database', options => {
          const transitionOptions: DatabaseMutationOptions = { ...options, ...(guard && { stateGuard: guard }),
            prepareTransitionIndex: (freshAccount, before, after) => prepareDatabaseIndexTransition(deps.db, freshAccount, before, after) }
          return verb === 'trash' ? deps.store.trashDatabase(dbId, transitionOptions) : deps.store.restoreDatabase(dbId, transitionOptions)
        })
        return jsonResponse({ database: result.value, context: result.context, application: result.application,
          stateChanged: true, reconcile: result.reconcile })
      }

      const dbDeleteMatch = /^\/api\/databases\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'DELETE' && dbDeleteMatch) {
        const caller = await requireCaller(req)
        const dbId = dbDeleteMatch[1]!.toLowerCase()
        const existing = await deps.store.getDatabase(dbId)
        if (!existing) return fail('NOT_FOUND', `database "${dbId}" not found`)
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', `account "${existing.accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'database.purge')
        if (existing.trashedAt === null) await deps.store.trashDatabase(dbId)
        await deps.store.purgeDatabase(dbId)
        const reconcile = await triggerReconcile(caller, {
          scope: { accountId: account.id, resellerId: account.ownerId },
        })
        await emitAudit(
          {
            actor: caller.principal.username,
            action: 'database.purged',
            target: `database:${existing.name}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          },
          { accountId: account.id, resellerId: account.ownerId },
        )
        return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
      }

      if (method === 'GET' && pathname === '/api/databases/users') {
        const caller = await requireCaller(req)
        const accountId = caller.principal.kind === 'user' ? caller.principal.accountId : (url.searchParams.get('accountId') ?? '')
        if (!accountId) return fail('VALIDATION', 'accountId is required')
        const account = await deps.store.getAccount(accountId)
        if (!account) return fail('NOT_FOUND', 'account not found')
        await assertCanAccessAccount(caller, account, 'database_user.list')
        if (caller.principal.kind === 'user') {
          if (url.searchParams.size) return fail('VALIDATION', 'database users do not accept owner selectors', { stateChanged: false })
          if (account.status !== 'active') return fail('FORBIDDEN', 'active hosting account owner access is required')
          const workspace = await deps.store.readAccountDatabases(account.id, { username: account.username, includeTrashed: true })
          return jsonResponse({ context: { accountId: account.id }, users: workspace.databaseUsers.map(projectDatabaseWorkspaceUser),
            application: { status: 'unverified', targetVerified: false } })
        }
        const users = (await deps.store.listDatabaseUsers(account.id)).map(user => ({ id: user.id, name: user.name, grants: user.grants }))
        return jsonResponse({ users })
      }

      if (method === 'POST' && pathname === '/api/databases/users') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user' && url.searchParams.size) return fail('VALIDATION', 'database user creation does not accept owner selectors', { stateChanged: false })
        const body = await readJsonBody<{ accountId?: Id; name?: string; password?: string; databaseId?: Id; privileges?: string[] }>(req)
        const accountId = caller.principal.kind === 'user' ? caller.principal.accountId : (body.accountId ?? '')
        if (!accountId) return fail('VALIDATION', 'accountId is required')
        const account = await deps.store.getAccount(accountId)
        if (!account) return fail('NOT_FOUND', 'account not found')
        await assertCanAccessAccount(caller, account, 'database_user.create')
        const parsed = caller.principal.kind === 'user' ? parseOwnerDatabaseUserCreateRequest(body, account.username) : body
        const result = await mutateDatabaseWorkspace(req, caller, account, 'database_user.created', 'database-user', options => deps.store.createDatabaseUser({
          accountId: account.id,
          name: ownedDatabaseName(account.username, parsed.name),
          authPlugin: 'mysql_native_password',
          authString: mysqlNativePasswordHash(parsed.password ?? ''),
          ...(parsed.databaseId ? { initialGrant: { databaseId: parsed.databaseId, privileges: parsed.privileges ?? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] } } : {}),
        }, options))
        return jsonResponse({ user: projectDatabaseWorkspaceUser(result.value), context: result.context,
          application: result.application, stateChanged: true, reconcile: result.reconcile }, 201)
      }

      const databaseUserGrantMatch = /^\/api\/databases\/users\/([0-9a-f-]{36})\/grants$/i.exec(pathname)
      if (method === 'POST' && databaseUserGrantMatch) {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user' && url.searchParams.size) return fail('VALIDATION', 'database privileges do not accept owner selectors', { stateChanged: false })
        const userId = databaseUserGrantMatch[1]!.toLowerCase()
        const existing = await deps.store.getDatabaseUser(userId)
        if (!existing) return fail('NOT_FOUND', 'database user not found')
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', 'account not found')
        await assertCanAccessAccount(caller, account, 'database_user.grant')
        const body = await readJsonBody<{ databaseId?: Id; privileges?: string[]; expectedPrivileges?: string[] | null }>(req)
        if (!body.databaseId) return fail('VALIDATION', 'databaseId is required')
        const parsed = caller.principal.kind === 'user' ? parseOwnerDatabaseGrantRequest(body) : { databaseId: body.databaseId, privileges: body.privileges ?? ['SELECT'] }
        const result = await mutateDatabaseWorkspace(req, caller, account, 'database_user.granted', 'database-user', options =>
          deps.store.setGrant({ databaseUserId: existing.id, ...parsed }, options))
        return jsonResponse({ user: projectDatabaseWorkspaceUser(result.value), context: result.context,
          application: result.application, stateChanged: true, reconcile: result.reconcile })
      }

      const databaseUserMatch = /^\/api\/databases\/users\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'DELETE' && databaseUserMatch) {
        const caller = await requireCaller(req)
        const userId = databaseUserMatch[1]!.toLowerCase()
        const existing = await deps.store.getDatabaseUser(userId)
        if (!existing) return fail('NOT_FOUND', 'database user not found')
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', 'account not found')
        await assertCanAccessAccount(caller, account, 'database_user.delete')
        await deps.store.deleteDatabaseUser(existing.id)
        const reconcile = await triggerReconcile(caller, { scope: { accountId: account.id, resellerId: account.ownerId } })
        await emitAudit({ actor: caller.principal.username, action: 'database_user.deleted', target: `database-user:${existing.name}`,
          outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
        return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
      }

      // ---- Service Users (Mailboxes & FTP) -------------------------------------------
      if (method === 'GET' && pathname === '/api/service-users') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user') {
          return jsonResponse({
            serviceUsers: (await deps.store.listServiceUsers(caller.principal.accountId)).map(publicServiceUser),
          })
        }
        const accountId = url.searchParams.get('accountId')
        if (accountId) {
          const account = await deps.store.getAccount(accountId)
          if (!account) return fail('NOT_FOUND', `account "${accountId}" not found`)
          await assertCanAccessAccount(caller, account, 'service_users.list')
          return jsonResponse({ serviceUsers: (await deps.store.listServiceUsers(account.id)).map(publicServiceUser) })
        }
        const snap = await deps.store.readSnapshot()
        if (caller.principal.kind === 'root') {
          return jsonResponse({ serviceUsers: snap.serviceUsers.map(publicServiceUser) })
        }
        const resellerId = await resolveResellerId(caller)
        const ownedIds = new Set((await ownedAccounts(deps.store, caller)).map(account => account.id))
        return jsonResponse({
          serviceUsers: snap.serviceUsers.filter((u) => ownedIds.has(u.accountId)).map(publicServiceUser),
        })
      }

      if (method === 'POST' && pathname === '/api/service-users') {
        const caller = await requireCaller(req)
        const body = await readJsonBody<
          Partial<NewServiceUser> & { domainId?: Id; localPart?: string; password?: string }
        >(req)
        const accountId =
          caller.principal.kind === 'user' ? caller.principal.accountId : (body.accountId ?? '')
        if (!accountId || !body.services) {
          return fail('VALIDATION', 'accountId and services are required')
        }
        const account = await deps.store.getAccount(accountId)
        if (!account) return fail('NOT_FOUND', `account "${accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'service_user.create')
        await assertAccountFeatures(deps.store, caller, account, [body.services.email ? 'email-accounts' : '', body.services.ftp ? 'ftp-accounts' : '', body.services.webdisk ? 'web-disk' : ''].filter(Boolean))

        let login = body.login
        if (!login && body.localPart && body.domainId) {
          const dom = await deps.store.getDomain(body.domainId)
          if (!dom || dom.accountId !== account.id) return fail('NOT_FOUND', 'domain not found')
          login = `${body.localPart}@${dom.name}`
        }
        if (!login) return fail('VALIDATION', 'login (or localPart + domainId) is required')

        const passwordHash = await passwordHashFromInput(body, { service: true })

        const serviceUser = await deps.store.createServiceUser({
          accountId: account.id,
          login,
          passwordHash,
          services: body.services,
          mailboxQuotaMb: body.mailboxQuotaMb ?? 1024,
          ftpDir: body.ftpDir ?? 'public_html',
        })
        const reconcile = await triggerReconcile(caller, {
          scope: { accountId: account.id, resellerId: account.ownerId },
        })
        await emitAudit(
          {
            actor: caller.principal.username,
            action: 'service_user.created',
            target: `service-user:${serviceUser.login}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          },
          { accountId: account.id, resellerId: account.ownerId },
        )
        return jsonResponse({ serviceUser: publicServiceUser(serviceUser), reconcile: reconcile?.body ?? null }, 201)
      }

      const serviceUserIdMatch = /^\/api\/service-users\/([0-9a-f-]{36})$/i.exec(pathname)
      if (serviceUserIdMatch) {
        const caller = await requireCaller(req)
        const suId = serviceUserIdMatch[1]!.toLowerCase()
        const existing = await deps.store.getServiceUser(suId)
        if (!existing) return fail('NOT_FOUND', `service user "${suId}" not found`)
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', `account "${existing.accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'service_user.modify')

        if (method === 'PATCH') {
          const patch = await readJsonBody<ServiceUserPatch & { password?: string }>(req)
          const services = patch.services ?? existing.services
          await assertAccountFeatures(deps.store, caller, account, [services.email ? 'email-accounts' : '', services.ftp ? 'ftp-accounts' : '', services.webdisk ? 'web-disk' : ''].filter(Boolean))
          const resolvedPatch: ServiceUserPatch = {
            ...patch,
            ...(patch.password !== undefined || patch.passwordHash !== undefined
              ? { passwordHash: await passwordHashFromInput(patch, { service: true }) }
              : {}),
          }
          const serviceUser = await deps.store.updateServiceUser(suId, resolvedPatch)
          const reconcile = await triggerReconcile(caller, {
            scope: { accountId: account.id, resellerId: account.ownerId },
          })
          return jsonResponse({ serviceUser, reconcile: reconcile?.body ?? null })
        }
        if (method === 'DELETE') {
          if (existing.services.email && existing.login.includes('@')) {
            await emitAudit(
              {
                actor: caller.principal.username,
                action: 'mailbox.deleted',
                target: `mailbox:${existing.login}`,
                outcome: 'ok',
                principalId: caller.principal.id,
              },
              { accountId: account.id, resellerId: account.ownerId },
            )
          }
          await revokeMailboxIdentity(deps.db, existing.login, suId)
          await deps.store.deleteServiceUser(suId)
          const reconcile = await triggerReconcile(caller, {
            scope: { accountId: account.id, resellerId: account.ownerId },
          })
          return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
        }
      }

      // ---- DNS Zones -----------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/dns/zones') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'root') {
          return jsonResponse({ zones: (await deps.store.listDnsZones()).map(zone => ({ ...zone, revision: dnsZoneRevision(zone) })) })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const accounts = resellerId ? await ownedAccounts(deps.store, caller) : []
          const ownedIds = new Set(accounts.map((a) => a.id))
          const zones = await deps.store.listDnsZones()
          return jsonResponse({ zones: zones.filter((z) => z.accountId && ownedIds.has(z.accountId)).map(zone => ({ ...zone, revision: dnsZoneRevision(zone) })) })
        }
        return jsonResponse({ zones: (await deps.store.listDnsZones(caller.principal.accountId)).map(zone => ({ ...zone, revision: dnsZoneRevision(zone) })) })
      }

      const dnsZoneMatch = /^\/api\/dns\/zones\/([^/]+)$/.exec(pathname)
      if (dnsZoneMatch) {
        const caller = await requireCaller(req)
        const zoneName = decodeURIComponent(dnsZoneMatch[1]!).toLowerCase()
        if (method === 'PUT') {
          const body = await readJsonBody<Partial<DnsZoneState> & { expectedZoneRevision?: string | null }>(req)
          if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'DNS body must be an object', { stateChanged: false })
          const guarded = Object.hasOwn(body, 'expectedZoneRevision')
          const expected = guarded ? dnsExpectedRevision(body, 'PUT') : null
          const existingZone = await deps.store.getDnsZone(zoneName)
          if (existingZone) {
            if (existingZone.accountId) {
              const existingOwner = await deps.store.getAccount(existingZone.accountId)
              if (!existingOwner) return fail('NOT_FOUND', 'zone not found')
              await assertCanAccessAccount(caller, existingOwner, 'dns.zone.save')
            } else if (caller.principal.kind !== 'root') return fail('NOT_FOUND', 'zone not found')
          }
          const zoneAccountId = caller.principal.kind === 'user'
            ? caller.principal.accountId
            : body.accountId !== undefined ? body.accountId : existingZone?.accountId ?? null
          if (caller.principal.kind !== 'root' && existingZone && zoneAccountId !== existingZone.accountId) return fail('FORBIDDEN', 'zone ownership cannot be changed')
          if (zoneAccountId) {
            const owner = await deps.store.getAccount(zoneAccountId)
            if (!owner) return fail('NOT_FOUND', 'account not found')
            await assertCanAccessAccount(caller, owner, 'dns.zone.save')
            if (!existingZone && caller.principal.kind !== 'root') await requireDomainAccount(deps.store, caller, zoneName, 'dns.zone.save', owner.id)
          } else await assertRoot(caller, 'dns.zone.save')
          if (guarded) assertDnsZoneRevision(existingZone, expected)
          const dnsGuard = guarded ? async (current: DnsZoneState | null): Promise<void> => {
            assertDnsZoneRevision(current, expected)
            const fresh = await requireCaller(req)
            if (current?.accountId && current.accountId !== zoneAccountId) {
              const previousOwner = await deps.store.getAccount(current.accountId)
              if (!previousOwner) return fail('NOT_FOUND', 'zone not found', { stateChanged: false })
              await assertCanAccessAccount(fresh, previousOwner, 'dns.zone.save')
            }
            if (zoneAccountId) {
              const owner = await deps.store.getAccount(zoneAccountId)
              if (!owner) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
              await assertCanAccessAccount(fresh, owner, 'dns.zone.save')
              if (!current && fresh.principal.kind !== 'root') await requireDomainAccount(deps.store, fresh, zoneName, 'dns.zone.save', owner.id)
            } else await assertRoot(fresh, 'dns.zone.save')
          } : undefined
          const zone = await deps.store.saveDnsZone({
            id: body.id ?? existingZone?.id ?? randomUUID(),
            name: zoneName,
            accountId: zoneAccountId,
            serial: body.serial ?? (existingZone ? existingZone.serial + 1 : 2026102201),
            records: body.records ?? [],
          }, dnsGuard ? { dnsGuard } : undefined)
          const reconcile = await triggerReconcile(caller)
          await emitAudit({
            actor: caller.principal.username,
            action: 'dns.zone.saved',
            target: `zone:${zone.name}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ zone, revision: dnsZoneRevision(zone), reconcile: reconcile?.body ?? null })
        }
        if (method === 'DELETE') {
          const hasBody = req.headers.has('content-type')
          const expected = hasBody ? dnsExpectedRevision(await readJsonBody<unknown>(req), 'DELETE') : null
          const existing = await deps.store.getDnsZone(zoneName)
          if (existing?.accountId) {
            const account = await deps.store.getAccount(existing.accountId)
            if (account) await assertCanAccessAccount(caller, account, 'dns.zone.delete')
          } else {
            await assertRoot(caller, 'dns.zone.delete')
          }
          await deps.store.deleteDnsZone(zoneName, hasBody ? { dnsGuard: async current => {
            assertDnsZoneRevision(current, expected)
            const fresh = await requireCaller(req)
            if (current?.accountId) {
              const account = await deps.store.getAccount(current.accountId)
              if (!account) return fail('NOT_FOUND', 'zone not found', { stateChanged: false })
              await assertCanAccessAccount(fresh, account, 'dns.zone.delete')
            } else await assertRoot(fresh, 'dns.zone.delete')
          } } : undefined)
          const reconcile = await triggerReconcile(caller)
          await emitAudit({
            actor: caller.principal.username,
            action: 'dns.zone.deleted',
            target: `zone:${zoneName}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
        }
      }

      // ---- Firewall ------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/firewall') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'firewall.read')
        return jsonResponse(await deps.store.getFirewallState())
      }

      if (method === 'POST' && pathname === '/api/firewall/rules') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'firewall.create')
        const body = await readJsonBody<NewFirewallRule & { sessionIp?: string }>(req)
        const settings = await deps.store.getServerSettings()
        const guard: FirewallGuard = {
          lockout: {
            sessionIp: extractClientIp(req) ?? fail('PRECONDITION_FAILED', 'trusted transport peer is required for firewall changes'),
            panelPort: settings?.panelPort ?? 2087,
            managementPorts: MANAGEMENT_PUBLIC_PORTS,
            sshPort: settings?.sshPort ?? 22,
          },
        }
        const rule = await deps.store.createFirewallRule(body, guard)
        const reconcile = await triggerReconcile(caller)
        await emitAudit({
          actor: caller.principal.username,
          action: 'firewall.rule.created',
          target: `firewall:${rule.id}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ rule, reconcile: reconcile?.body ?? null }, 201)
      }

      const fwRuleMatch = /^\/api\/firewall\/rules\/([0-9a-f-]{36})$/i.exec(pathname)
      if (fwRuleMatch) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'firewall.modify')
        const ruleId = fwRuleMatch[1]!.toLowerCase()
        const settings = await deps.store.getServerSettings()
        const guard: FirewallGuard = {
          lockout: {
            sessionIp: extractClientIp(req) ?? fail('PRECONDITION_FAILED', 'trusted transport peer is required for firewall changes'),
            panelPort: settings?.panelPort ?? 2087,
            managementPorts: MANAGEMENT_PUBLIC_PORTS,
            sshPort: settings?.sshPort ?? 22,
          },
        }
        if (method === 'PATCH') {
          const patch = await readJsonBody<Partial<Omit<FirewallRule, 'id'>>>(req)
          const rule = await deps.store.updateFirewallRule(ruleId, patch, guard)
          const reconcile = await triggerReconcile(caller)
          return jsonResponse({ rule, reconcile: reconcile?.body ?? null })
        }
        if (method === 'DELETE') {
          await deps.store.deleteFirewallRule(ruleId, guard)
          const reconcile = await triggerReconcile(caller)
          return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
        }
      }

      // ---- IO Monitor & Website Analytics --------------------------------------------
      if (method === 'GET' && pathname === '/api/analytics/io') {
        const caller = await requireCaller(req)
        const principal = caller.principal
        const res = await callAgent('/analytics/io', {
          method: 'GET',
          caller,
        })
        if (!res.ok) return res
        const snap = (await res.json()) as IoAnalyticsSnapshot
        if (principal.kind === 'root') {
          return jsonResponse(snap)
        }
        if (principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const accounts = resellerId ? await ownedAccounts(deps.store, caller) : []
          const ownedIds = new Set(accounts.map((a) => a.id))
          return jsonResponse({
            ...snap,
            accounts: snap.accounts.filter((a) => ownedIds.has(a.accountId)),
          })
        }
        return jsonResponse({
          ...snap,
          accounts: snap.accounts.filter((a) => a.accountId === principal.accountId),
        })
      }

      if (method === 'POST' && pathname === '/api/analytics/websites/ingest') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'analytics.websites.ingest')
        const body = await readJsonBody(req)
        return callAgent('/analytics/websites/ingest', {
          method: 'POST',
          caller,
          body,
        })
      }

      const webAnalyticsMatch = /^\/api\/analytics\/websites\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'GET' && webAnalyticsMatch) {
        const caller = await requireCaller(req)
        const domainId = webAnalyticsMatch[1]!.toLowerCase()
        const domain = await deps.store.getDomain(domainId)
        if (!domain) return fail('NOT_FOUND', `domain "${domainId}" not found`)
        const account = await deps.store.getAccount(domain.accountId)
        if (!account) return fail('NOT_FOUND', `account "${domain.accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'analytics.websites')
        const window = url.searchParams.get('window') ?? '24h'
        return callAgent(`/analytics/websites/${domainId}?window=${encodeURIComponent(window)}`, {
          method: 'GET',
          caller,
        })
      }

      // ---- Generations, Reconcile, Rollback & Audit ----------------------------------
      if (method === 'GET' && pathname === '/api/generations') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'generations.list')
        if (url.search) return fail('VALIDATION', 'generation history does not accept selectors', { stateChanged: false })
        const result = await readGenerationWorkspace({ store: deps.store, db: deps.db,
          readAdmission: () => readNativeWorkspace(caller, '/generations/rollback-admission', undefined, false, 'GET'),
        })
        const fresh = await requireCaller(req)
        await assertRoot(fresh, 'generations.list')
        if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'generation authorization changed', { stateChanged: false })
        const response = jsonResponse(result)
        response.headers.set('cache-control', 'no-store')
        return response
      }

      if (method === 'POST' && pathname === '/api/reconcile') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'reconcile')
        const body = await readJsonBody<{ force?: boolean }>(req)
        return callAgent('/reconcile', {
          method: 'POST',
          caller,
          body: { force: Boolean(body.force) },
        })
      }

      const rollbackMatch = /^\/api\/generations\/(\d+)\/rollback$/.exec(pathname)
      if (method === 'POST' && rollbackMatch) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'generations.rollback')
        const genId = Number(rollbackMatch[1])
        if (url.search || !/^[1-9]\d*$/.test(rollbackMatch[1]!) || !Number.isSafeInteger(genId)) return fail('VALIDATION', 'a canonical positive generation ID without selectors is required', { stateChanged: false })
        const body = parseGenerationRollbackRequest(genId, await readJsonBody(req))
        return await callAgent(`/generations/${genId}/rollback`, {
          method: 'POST',
          caller,
          body,
        })
      }

      if (method === 'GET' && pathname === '/api/audit') {
        const caller = await requireCaller(req)
        let query: ReturnType<typeof parseAuditFilters>
        try {
          query = parseAuditFilters(url.searchParams)
        } catch (error) {
          if (isXpanelError(error) && error.code === 'VALIDATION') {
            const problem = problemResponse(error, pathname, method)
            return new Response(JSON.stringify({ ...await problem.json(), status: 400 }), {
              status: 400, headers: problem.headers,
            })
          }
          throw error
        }
        const entries = await listAudit(deps.db, query)
        const targetsAccount = (target: string, username: string): boolean =>
          target === `account:${username}` || target.startsWith(`account:${username}:`)
        if (caller.principal.kind === 'root') {
          return jsonResponse({ entries })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const accounts = resellerId ? await ownedAccounts(deps.store, caller) : []
          const usernames = new Set(accounts.map((a) => a.username))
          return jsonResponse({
            entries: entries.filter(
              (e) =>
                e.actor === caller.principal.username ||
                usernames.has(e.actor) ||
                [...usernames].some((u) => targetsAccount(e.target, u)),
            ),
          })
        }
        return jsonResponse({
          entries: entries.filter(
            (e) =>
              e.actor === caller.principal.username ||
              targetsAccount(e.target, caller.principal.username),
          ),
        })
      }

      if (/^\/api\/transfers\/(?:credentials|source\/inventory|source\/accounts|convert-addon)(?:\/|$)/.test(pathname)) {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const readJournal = () => extended.readOrDefault<unknown>('transfers/convert-addon.json', null)
        const response = await handleTransferCredentialsRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit })
          ?? await handleTransferSourceInventoryRoute(req, url, method, { requireCaller, assertRoot, readSnapshot: () => deps.store.readSnapshot(),
            readDisk: caller => readNativeWorkspace(caller, '/host/monitoring/disk', undefined, false, 'GET') })
          ?? await handleTransferSourceBackupRoute(req, url, method, { requireCaller, assertRoot, readSnapshot: () => deps.store.readSnapshot(),
            createArchive: (caller, username) => callAgent('/transfers/source/accounts/' + username + '/archives', { caller, method: 'POST' }),
            openArchive: (caller, username, file) => callAgent('/transfers/source/accounts/' + username + '/archives/' + file, { caller }) })
          ?? await handleConvertAddonRoute(req, url, method, { requireCaller, assertRoot, emitAudit, readSnapshot: () => deps.store.readSnapshot(), readJournal,
            usernameTaken: async username => !!await findPrincipalByUsername(deps.db, username) || !!await deps.store.getAccountByUsername(username),
            ...(deps.agentApp && deps.agentToken ? { execute: (caller, plan, snapshot) => executeAddonConversion(caller, plan, snapshot, {
              store: deps.store, db: deps.db, hashPassword: password => passwordHashFromInput({ password }), applyConfiguration: applyAccountConfiguration,
              callFiles: (caller, op, body) => callAgent('/transfers/convert-addon/' + op, { caller, method: 'POST', body }),
              readJournal, writeJournal: value => extended.write('transfers/convert-addon.json', value), emitAudit: entry => emitAudit(entry),
            }) } : {}) })
        if (response) return response
      }
      // ---- Root-Gated Lifecycle: Transfer ----------------------------------
      if (method === 'POST' && pathname === '/api/lifecycle/transfer') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'lifecycle.transfer')
        return fail('PRECONDITION_FAILED', 'use the saved transfer workspace at /api/transfers/sessions; client-supplied lifecycle events cannot authorize execution', { stateChanged: false, nativeApplied: false })
      }

      // ---- Extended Capabilities Router ----------------------------------------------
      const extendedRes = await extendedRouter.handleExtendedRoute(req, url, method)
      if (extendedRes) {
        return extendedRes
      }

      // ---- Optional Web UI Renderer Fallback -----------------------------------------
      if (deps.webRenderer && !pathname.startsWith('/api/')) {
        return await deps.webRenderer(req)
      }

      return fail('NOT_FOUND', `route ${method} ${pathname} not found`)
    } catch (err) {
      if (!isXpanelError(err)) {
        await appendAudit(deps.db, {
          actor: 'system',
          action: 'api.internal_error',
          target: pathname,
          detail: { error: err instanceof Error ? err.message : String(err) },
          outcome: 'failed',
        }).catch(() => undefined)
      }
      const status = isXpanelError(err)
        ? (err.detail.lockedOut === true ? 429 : (STATUS_BY_CODE[err.code] ?? 400))
        : 500
      if ((status === 500 || status === 503) && prefersDocumentHtml(req, pathname, method)) {
        try { return renderTransportStatus(req, status) } catch { /* keep the problem document */ }
      }
      return problemResponse(err, pathname, method)
    }
  }

  // Each request gets its own audit scope; a handed-off caller marks it inside requireCaller.
  const fetchInner = (req: Request, context?: TransportContext): Promise<Response> => auditScope.run({}, () => routeRequest(req, context))

  const watchMailbox = (req: IncomingMessage, signal: AbortSignal): void => {
    const row = pendingIdle.get(req)
    pendingIdle.delete(req)
    if (!row || signal.aborted || !idleTarget || idleWatching.has(req)) return
    idleWatching.add(req)
    watchMailboxIdle({ ...idleTarget, mailbox: row.mailbox, password: row.password, signal,
      onPush: push => hub.broadcast(mailboxLiveEvent(push, { accountId: row.accountId, mailbox: row.mailbox })),
    })
  }

  // Bounded HTTP/WS authorization settles SH; idle sockets hold no writer lease.
  const authenticateUpgrade = async (req: IncomingMessage, context?: TransportContext): Promise<UpgradeAuthorization> => {
    try {
      const probe = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`)
      if (await lifecycleAdmissionResponse(probe)) return WS_AUTHORIZATION_UNAVAILABLE
      return await withLifecycleWriterAdmission(async () => {
        try { return await authenticateUpgradeInner(req, context) }
        catch { return null }
      })
    } catch { return WS_AUTHORIZATION_UNAVAILABLE }
  }
  const fetch = async (req: Request, context?: TransportContext): Promise<Response> => {
    const denied = await lifecycleAdmissionResponse(req)
    if (denied) return denied
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/api/health' && url.search === '') return fetchInner(req, context)
    try {
      return await withLifecycleWriterAdmission(async () => {
        try { return await fetchInner(req, context) }
        catch (error) {
          // Async route failures keep their sanitized public outcome inside admission.
          // Physical admission/retirement errors still reach the fail-closed outer catch.
          if (isXpanelError(error)) return problemResponse(error, url.pathname, req.method.toUpperCase())
          throw error
        }
      })
    } catch { return new Response(JSON.stringify({ error: 'Lifecycle writer admission is unavailable.' }), { status: 503, headers: { 'content-type': 'application/problem+json', 'retry-after': '5', 'cache-control': 'no-store' } }) }
  }

  return { fetch, hub, authenticateUpgrade, watchMailbox }
}

export interface ListenApiServerOptions {
  port?: number
  host?: string
  ingressSocketPath?: string
  ingressSocketMode?: number
}

/**
 * Starts the HTTP + WebSocket server for the xPanel API & Web UI, with an optional
 * verified UNIX domain / named-pipe ingress listener (`ingressSocketPath`).
 */
export const listenApiServer = async (
  app: ApiApp,
  opts: ListenApiServerOptions = {},
): Promise<{
  server: Server
  ingressServer?: Server
  port: number
  ingressSocketPath?: string
  close: () => Promise<void>
}> => {
  const buildHttpServer = (trustedIngress: boolean): Server => {
    const srv = createServer(async (req, res) => {
      if (trustedIngress) trustedIngressRequests.add(req)
      const writeResponse = async (response: Response): Promise<void> => {
        if (res.destroyed || res.writableEnded) { await response.body?.cancel().catch(() => undefined); return }
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        let cancellation: Promise<void> | undefined
        const abort = new AbortController()
        const cancel = (): Promise<void> => cancellation ??= reader ? reader.cancel().catch(() => undefined) : Promise.resolve()
        const disconnected = (): void => { abort.abort(); void cancel() }
        try {
          res.statusCode = response.status
          response.headers.forEach((value, key) => { if (key.toLowerCase() !== 'set-cookie') res.setHeader(key, value) })
          const cookies = response.headers.getSetCookie()
          if (cookies.length) res.setHeader('set-cookie', cookies)
          if (!response.body || req.method === 'HEAD') { await response.body?.cancel(); res.end(); return }
          reader = response.body.getReader()
          res.once('close', disconnected); res.once('error', disconnected); req.once('aborted', disconnected)
          while (!abort.signal.aborted && !res.destroyed && !res.writableEnded) {
            const next = await reader.read()
            if (next.done) break
            if (res.write(next.value)) continue
            await new Promise<void>((resolveDrain, rejectDrain) => {
              const cleanup = () => { res.off('drain', drained); res.off('close', closed); res.off('error', failed); abort.signal.removeEventListener('abort', closed) }
              const drained = () => { cleanup(); resolveDrain() }
              const closed = () => { cleanup(); rejectDrain(new Error('HTTP response closed before drain')) }
              const failed = (error: Error) => { cleanup(); rejectDrain(error) }
              res.once('drain', drained); res.once('close', closed); res.once('error', failed); abort.signal.addEventListener('abort', closed, { once: true })
              if (res.destroyed || res.writableEnded || abort.signal.aborted) closed()
            })
          }
          if (!res.destroyed && !res.writableEnded) res.end()
        } catch (error) { res.destroy(); throw error }
        finally {
          res.off('close', disconnected); res.off('error', disconnected); req.off('aborted', disconnected)
          if (reader) { await cancel(); reader.releaseLock() }
          else await response.body?.cancel().catch(() => undefined)
        }
      }
      const requestPath = (req.url ?? '/').split('?')[0] ?? '/'
      const accountFileWrite = req.method === 'POST' && /^\/api\/accounts\/[a-z][a-z0-9]{0,15}\/files$/.test(requestPath)
      const maxBodyBytes = accountFileWrite ? 3 * 1024 * 1024 : 1024 * 1024
      try {
        const declaredLength = req.headers['content-length']
        const bodyLimit = accountFileWrite ? '3 MiB' : '1 MiB'
        if (declaredLength && Number(declaredLength) > maxBodyBytes) {
          await writeResponse(transportProblem(413, 'CONTENT_TOO_LARGE', `request body exceeds ${bodyLimit}`, req.url ?? '/'))
          req.resume()
          return
        }
        let bodyBytes = 0
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk)
          bodyBytes += bytes.byteLength
          if (bodyBytes > maxBodyBytes) {
            await writeResponse(transportProblem(413, 'CONTENT_TOO_LARGE', `request body exceeds ${bodyLimit}`, req.url ?? '/'))
            req.resume()
            return
          }
          chunks.push(bytes)
        }
        const body = chunks.length > 0 ? Buffer.concat(chunks, bodyBytes) : undefined
        const method = req.method ?? 'GET'
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value)
          else if (Array.isArray(value)) headers.set(key, value.join(', '))
        }
        const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
          method,
          headers,
          ...(body && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
        })
        const peer = req.socket.remoteAddress
        await writeResponse(
          await app.fetch(request, {
            socketRemoteAddress: peer ?? null,
            ...(peer ? { remoteAddress: peer } : trustedIngress ? { remoteAddress: '127.0.0.1' } : {}),
            trustedIngress,
          }),
        )
      } catch (error) {
        await writeResponse(problemResponse(error, req.url ?? '/', req.method ?? '')).catch(() => res.destroy())
      }
    })
    srv.requestTimeout = 30_000
    srv.headersTimeout = 10_000
    srv.maxConnections = 128
    app.hub.attachToServer(srv, (req) => {
      if (trustedIngress) trustedIngressRequests.add(req)
      return app.authenticateUpgrade(req, { trustedIngress })
    }, (req, _subscriber, signal) => {
      app.watchMailbox(req, signal)
    })
    return srv
  }

  const server = buildHttpServer(false)

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolveListen())
  })

  let ingressServer: Server | undefined
  const ingressSocketPath = opts.ingressSocketPath
  if (ingressSocketPath) {
    if (!ingressSocketPath.startsWith('\\\\.\\pipe\\')) {
      await rm(ingressSocketPath, { force: true }).catch(() => undefined)
    }
    ingressServer = buildHttpServer(true)
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        ingressServer!.once('error', rejectListen)
        ingressServer!.listen(ingressSocketPath, () => resolveListen())
      })
      if (process.platform !== 'win32' && !ingressSocketPath.startsWith('\\\\.\\pipe\\')) {
        await chmod(ingressSocketPath, opts.ingressSocketMode ?? 0o660)
      }
    } catch (err) {
      server.closeAllConnections?.()
      await new Promise<void>((r) => server.close(() => r()))
      throw err
    }
  }

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0)

  return {
    server,
    ...(ingressServer && { ingressServer }),
    ...(ingressSocketPath && { ingressSocketPath }),
    port,
    close: async () => {
      await Promise.all([
        new Promise<void>((resolveClose) => {
          server.closeAllConnections?.()
          server.close(() => resolveClose())
        }),
        ingressServer
          ? new Promise<void>((resolveClose) => {
              ingressServer.closeAllConnections?.()
              ingressServer.close(() => resolveClose())
            })
          : Promise.resolve(),
      ])
      if (ingressSocketPath && !ingressSocketPath.startsWith('\\\\.\\pipe\\')) {
        await rm(ingressSocketPath, { force: true }).catch(() => undefined)
      }
    },
  }
}

/**
 * Helper to ensure a default `root` principal exists in the control database.
 */
export const ensureRootPrincipal = async (
  db: Db,
  opts: { password?: string; passwordHash?: string; forcePasswordChange?: boolean } = {},
) => {
  const existing = await findPrincipalByUsername(db, 'root')
  if (existing) return existing
  const passwordHash = await passwordHashFromInput(opts)
  return createRootPrincipal(db, {
    username: 'root',
    passwordHash,
    forcePasswordChange: opts.forcePasswordChange ?? true,
  })
}
