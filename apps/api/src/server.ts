import { AsyncLocalStorage } from 'node:async_hooks'
import { lifecycleAdmissionResponse, withLifecycleWriterAdmission } from '../../../scripts/lifecycle-admission.mjs'
import { createHandoffRoutes } from './panel-handoff-routes.ts'
import { impersonationForbidsRoute } from './panel-handoff-protocol.ts'
import { createHandoffSessionCheck } from './panel-handoff-authority.ts'
import { parseAuditFilters } from './audit-filters.ts'
import { createAccountBackupWorkspace } from './account-backup-workspace.ts'
import { createCertificateRuntimeRouter } from './certificate-runtime.ts'
import { handleSslStoreWorkspaceRoute, readSslStoreMaterial, type SslStorePorts } from './ssl-store-workspace.ts'
import { assertCronHostAdmissionReply, createCronWorkspaceRoutes, type CronWorkspacePorts } from './cron-workspace.ts'
import { createMailxWorkspaceRoutes } from './mailx-workspace.ts'
import { createMailxConfigRoutes } from './mailx-config-workspace.ts'
import { MAIL_REPORT_ROUTE, handleMailReportsWorkspaceRoute } from './mail-reports-workspace.ts'
import { createMailxCollectionsRoutes } from './mailx-collections.ts'
import { handlePhpManageRoute, handlePhpWorkspaceRoute } from './php-workspace.ts'
import { handleFirewallWorkspaceRoute } from './firewall-workspace.ts'
import { handleMailQueueWorkspaceRoute } from './mail-queue-workspace.ts'
import { handleSystemUpdatesWorkspaceRoute } from './system-updates-workspace.ts'
import { handleFileSharingWorkspaceRoute } from './ops-file-sharing-workspace.ts'
import { handleTerminalWorkspaceRoute } from './ops-terminal-workspace.ts'
import type { TerminalExecution } from './ops-terminal-workspace.ts'
import { handleAccountTerminalRoute } from './account-terminal-workspace.ts'
import { createTerminalBridge } from './terminal-bridge.ts'
import type { AgentTerminalSession, TerminalAgentPort } from './terminal-bridge.ts'
import { TerminalRegistry, TerminalTickets } from './terminal-sessions.ts'
import type { TerminalGrant } from './terminal-sessions.ts'
import type { Duplex } from 'node:stream'
import { handleNodesWorkspaceRoute } from './ops-nodes-workspace.ts'
import { handleClusterRoute, pushSectionsToCluster } from './config-cluster.ts'
import { handleLiveSourceRoute } from './live-transfer.ts'
import { createNodeLink, NODE_PIN_WATCH_MS, nodePackageVersion } from './node-link.ts'
import { handleIntegrationsWorkspaceRoute } from './ops-integrations-workspace.ts'
import { atomicWriteJson as opsAtomicWriteJson, readJsonIfExists as opsReadJsonIfExists } from '@xpanel/state'
import { join as opsJoin } from 'node:path'
import { handleRepairWorkspaceRoute } from './repair-workspace.ts'
import { handleConfigurationHealthWorkspaceRoute } from './configuration-health-workspace.ts'
import { handleAccountHealthWorkspaceRoute } from './account-health-workspace.ts'
import { handleAccountRepairWorkspaceRoute } from './account-repair-workspace.ts'
import { handleBackupFileRestoreWorkspaceRoute, handleOwnerFileRestorationRoute } from './backup-file-restore-workspace.ts'
import { handleJobsWorkspaceRoute } from './jobs-workspace.ts'
import { handlePanelTokensWorkspaceRoute } from './panel-tokens-workspace.ts'
import { handleOwnerApiTokensWorkspaceRoute } from './owner-api-tokens-workspace.ts'
import { assertAuthPersonalOwner } from './auth-personal.ts'
import { handlePanelNotificationsRoute } from './panel-notifications.ts'
import { handleAnnouncementsRoute } from './announcements-workspace.ts'
import { handleEmailAllUsersRoute } from './email-all-users.ts'
import { handleWhmHomeRoute } from './whm-home-workspace.ts'
import { handleWebTemplatesRoute } from './web-templates-workspace.ts'
import { copySkeleton, handleSkeletonRoute, readSkeleton } from './skeleton-workspace.ts'
import { auditActionLabel } from '../../web/src/audit-labels.ts'
import { handleTransferCredentialsRoute, readTransferCredentialToken } from './acct-transfer-credentials.ts'
import { handleTransferSourceInventoryRoute, handleTransferSourcePackageRoute } from './acct-transfer-source.ts'
import { clearAccountMoved, readAccountEdgeState } from '../../agent/src/account-edge.ts'
import { createCpanelImportPorts } from './lifecycle-cpanel-import.ts'
import { CPANEL_UPLOAD_CHUNK_BYTES } from './transfer-workspace.ts'
import { executeAddonConversion } from './lifecycle-convert-addon.ts'
import { createLifecycleAccount } from './lifecycle-account-create.ts'
import { createTransferExecution } from './lifecycle-transfer-execution.ts'
import { handleConvertAddonRoute } from './acct-convert-addon.ts'
import { handleComponentRestoreWorkspaceRoute } from './acct-restore-workspace.ts'
import { handleStagingWorkspaceRoute } from './acct-staging-workspace.ts'
import { handleTeamRoute, readSavedTeam, teamMemberPhase } from './acct-team-workspace.ts'
import { handleTeamPasswordRoute, signInTeamMember, teamFileReader, teamMemberResolver, TEAM_PASSWORD_ROUTE } from './team-session.ts'
import { findActiveTeamSession, revokeTeamSession } from './team-store.ts'
import { handleAccountTemplatesRoute } from './acct-templates-workspace.ts'
import { AccountLifecycleCoordinator, isFreshProvisioningHostEffect } from './use-cases/account-lifecycle.ts'
import { createAuthenticatedProvisioningPort } from './use-cases/account-provisioning-transport.ts'
import { createProvisioningPreparationAuthority, parseMailAuthOptions, prepareAccountProvisioning, type PreparedAccountState, type ProvisioningAuthorizationReference } from './use-cases/account-provisioning-prepared.ts'
import { services as renderServices } from '@xpanel/render'
import type { ProvisioningPreparationStore } from './use-cases/provisioning-preparation.ts'
import { handleAccountEnhancementsRoute, handleEnhancementAssignmentRoute } from './acct-enhancements-workspace.ts'
import { handleSoftwareCenterWorkspaceRoute } from './software-center-workspace.ts'
import { handleWhmDatabasesWorkspaceRoute } from './whm-databases-workspace.ts'
import { handleWhmDbAdminRoute } from './whm-db-admin-workspace.ts'
import { handleWhmDbToolsRoute } from './whm-db-tools-workspace.ts'
import { handleWhmDbServicesRoute } from './whm-db-services-workspace.ts'
import { handleFtpWorkspaceRoute } from './ftp-workspace.ts'
import { handleDatabaseTuningWorkspaceRoute } from './database-tuning-workspace.ts'
import { createDefaultIndexWorkspaceRoutes } from './default-index-workspace.ts'
import { handleComposerWorkspaceRoute } from './composer-workspace.ts'
import { handlePanelToolsRoute, PANEL_TOOL_ROUTE } from './panel-tools-routes.ts'
import { createErrorReporter, isReportableError, keepErrorBody } from './error-reporting.ts'
import { handleSwContainersWorkspaceRoute } from './sw-containers-workspace.ts'
import { handleSwAddonServicesWorkspaceRoute } from './sw-addon-services-workspace.ts'
import { handleSwDeploymentsWorkspaceRoute } from './sw-deployments-workspace.ts'
import { handleSwOptimizeWorkspaceRoute } from './sw-optimize-workspace.ts'
import { handleSwApplicationsWorkspaceRoute } from './sw-applications-workspace.ts'
import { handleAccountRuntimeWorkspaceRoute } from './account-runtime-workspace.ts'
import { handleAccountOwnerToolsRoute } from './account-owner-tools-workspace.ts'
import { handleAdminPreferencesRoute } from './admin-preferences.ts'
import { handleUiPreferencesRoute } from './ui-preferences.ts'
import { handlePersonalPreferencesRoute } from './personal-preferences.ts'
import { handleTeamAuditRoute } from './account-team-audit.ts'
import type { UiPreferenceAuthority } from './ui-preferences.ts'
import { localePolicy, registeredUiThemeIds, resolveUiTheme } from '../../web/src/index.ts'
import { handlePanelBrandingRoute, panelBrandingFile } from './panel-branding.ts'
import { handlePanelLanguagesRoute } from './panel-languages.ts'
import { handlePanelSettingsRoute, panelOfflineAdmits, panelSettingsFile } from './panel-settings.ts'
import { handleReverseProxyRoute } from './reverse-proxy-workspace.ts'
import { handleWhmcsRoute, readSavedWhmcs } from './whmcs-integration.ts'
import { DNS_CLUSTER_PEER_PREFIX } from '../../agent/src/dns-cluster-model.ts'
import { handleDnsClusterPeerRoute } from './dns-cluster-peer.ts'
import { handleDnsClusterWorkspaceRoute } from './dns-cluster-workspace.ts'
import { handleDbProfilesWorkspaceRoute } from './db-profiles-workspace.ts'
import type { WhmcsProvisionPorts, WhmcsRouteHelpers } from './whmcs-integration.ts'
import { WHMCS_PROVISION_PATH } from './whmcs-module.ts'
import { handleServiceManagerWorkspaceRoute } from './service-manager-workspace.ts'
import { handleBenchmarkWorkspaceRoute } from './benchmark-workspace.ts'
import { handleTrafficWorkspaceRoute } from './traffic-workspace.ts'
import { handleMeteringWorkspaceRoute } from './metering-workspace.ts'
import { handleGitWorkspaceRoute } from './git-workspace.ts'
import { handleEmailDiskUsageWorkspaceRoute } from './email-disk-usage-workspace.ts'
import { handlePgpWorkspace } from './pgp-workspace.ts'
import { createDynamicDnsRoutes } from './dynamic-dns.ts'
import { handleWebDirectivesRoute } from './web-directives-workspace.ts'
import { handleAccountEdgeRoute } from './account-edge-workspace.ts'
import { handleNginxProxyRoute } from './nginx-proxy-workspace.ts'
import { handleLeechProtectionRoute } from './leech-protection-workspace.ts'
import { handleDirectoryPrivacyRoute } from './directory-privacy-workspace.ts'
import { handleDnssecRoute } from './dnssec-workspace.ts'
import { handleDnsZoneFileRoute } from './dns-zone-file.ts'
import { handleDatabaseTransferRoute } from './database-transfer-workspace.ts'
import { handleResellerSuspensionRoute } from './reseller-suspension.ts'
import { handleAccountBulkActionsRoute } from './account-bulk-actions.ts'
import { accountCreateOperationView, handleAccountCreateOperationRoute, type AccountCreateOutcome } from './account-create-operations.ts'
import { changeAccountPackageLimit, handleAccountLimitsRoute, isPackageLimitPatch, saveAccountLimits } from './account-limits-workspace.ts'
import { handleForceHttpsRoute } from './domain-force-https.ts'
import { handleAccountAdminRoute } from './account-admin-workspace.ts'
import { handleMailLogWorkspaceRoute, handleMailTrackDeliveryRoute } from './mail-log-workspace.ts'
import { handleMailboxEngineRoute } from './mail/mailbox-engine-routes.ts'
import { handleFtpLogWorkspaceRoute } from './ftp-log-workspace.ts'
import { handleUpgradeWorkspaceRoute } from './upgrade-workspace.ts'
import { handleReleasePackagesWorkspaceRoute } from './release-packages-workspace.ts'
import { handleMonitoringWorkspaceRoute } from './monitoring-workspace.ts'
import { handleMailServerWorkspaceRoute } from './mail-server-workspace.ts'
import { readMailxSaved } from '../../agent/src/mailx-routes.ts'
import { handleMailQualityWorkspaceRoute } from './mail-quality-workspace.ts'
import { handleMailboxMaintenanceWorkspaceRoute } from './mailbox-maintenance-workspace.ts'
import { handleServerObservationWorkspaceRoute } from './server-observation-workspace.ts'
import { handleIpNetworkRoute } from './ip-network-workspace.ts'
import { handleRemoteServiceIpsRoute } from './remote-service-ips-workspace.ts'
import { handleServerOperationsRoute } from './server-operations-workspace.ts'
import { handleHostToolsRoute, handleInboundHook } from './host-tools-workspace.ts'
import { ddnsRootReconcile, runDdnsCycle } from './host-ddns.ts'
import { handleResellerWorkspaceRoute } from './reseller-workspace.ts'
import { handleServerHealthWorkspaceRoute } from './server-health-workspace.ts'
import { handleSupportWorkspaceRoute } from './support-workspace.ts'
import { handleMonitoringAlertsRoute } from './monitoring-alerts.ts'
import { alertStateFiles, alertTransports } from './alert-runtime.ts'
import { handleServiceDetailWorkspaceRoute } from './service-detail-workspace.ts'
import { handleDnsToolsWorkspaceRoute } from './dns-tools-workspace.ts'
import { handleSecurityToolsWorkspaceRoute } from './security-tools-workspace.ts'
import { handleSshWorkspaceRoute } from './ssh-workspace.ts'
import { handleSecWorkspaceRoute, readSecRaw, writeSecRecord } from './sec-workspace.ts'
import { readSecRecord, SEC_DEFAULTS, secRevision } from '../../agent/src/sec-policy.ts'
import { createExternalAuth } from './external-auth.ts'
import { checkSecurityQuestions, handleSecurityQuestionsRoute } from './security-questions.ts'
import { handleRootIdentityWorkspaceRoute } from './root-identity-workspace.ts'
import type { RootIdentityHelpers } from './root-identity-workspace.ts'
import type { SecWorkspaceHelpers } from './sec-workspace.ts'
import { handleSecCloudflareRoute, publishSiteRecord } from './sec-cloudflare.ts'
import { handleMailCertRoutes, readMailCertExtra } from './mail-cert-scheduler.ts'
import { handleUnsubscribeRoute, UNSUBSCRIBE_PATH } from './mail-marketing.ts'
import { secPanelAccessGate } from './sec-panel-access.ts'
import { panelGate } from './panel-gate.ts'
import { handlePanelAccessRoute } from './panel-access-workspace.ts'
import { admitTemporaryRequest, createTemporaryLoginRoutes, isTemporaryLogin } from './panel-temporary-login.ts'
import { authorizeAccountOwner, handleAccountSshRoute } from './account-ssh-workspace.ts'
import { SITE_PUBLISHER_DOMAIN_ROUTE, executeSitePublisherWorkspaceRequest, parseSitePublisherHttpRequest } from './site-publisher-workspace.ts'
import { readSitePublisherBody } from '../../agent/src/site-publisher-routes.ts'
import { handleAccountLogsRoute } from './account-logs-workspace.ts'
import { stateConfigFile } from './panel-config-file.ts'
import { handleWhmLogToolsRoute } from './whm-log-tools-workspace.ts'
import { FILE_SHARE_LINKS_NAMESPACE, createShareMissLimiter, SHARE_USE_LIMIT, handleFileShareDownload, handleFileShareLinksRoute } from './file-share-links-workspace.ts'
import { FILE_SHARE_LINKS_STATE_PATH, parseShareLinks } from '../../agent/src/file-share-links.ts'
import type { FileShareLinks } from '../../agent/src/file-share-links.ts'
import { handleWebStatsServerRoute, handleWebStatsWorkspaceRoute } from './web-stats-workspace.ts'
import { handleAccountVirusScanRoute } from './account-virus-scan-workspace.ts'
import { createNetworkToolsGate, handleNetworkToolsRoute } from './network-tools-workspace.ts'
import { handleAccountDatabaseInsightsRoute } from './account-database-insights-workspace.ts'
import { handleSiteHealthRoute, systemSiteHealthDns } from './site-health-workspace.ts'
import { handleExtendRoute } from './extend-routes.ts'
import { createLifecycleHooks } from './hooks-workspace.ts'
import { probeHtaccessTarget } from '../../agent/src/htaccess-native.ts'
import { readGenerationWorkspace } from './generation-workspace.ts'
import { createDefaultSiteWorkspaceRoutes } from './default-site-workspace.ts'
import { parseGenerationRollbackRequest } from '@xpanel/state'
import { createSecurityWorkspaceRoutes } from './security-workspace.ts'
import type { CookieIpMode, CronJobIntent, CronJobObservationReceipt } from '@xpanel/core'
import { HTACCESS_DOMAIN_ROUTE, executeHtaccessWorkspaceRequest, parseHtaccessHttpRequest } from './htaccess-workspace.ts'
import { createQuarantineRoutes, type QuarantineGateway } from './mail/quarantine-routes.ts'
import { assertDnsZoneRevision, dnsExpectedRevision, dnsZoneRevision } from './dns-workspace.ts'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { ACCOUNT_RETIREMENT_STEPS, agentCallerHeaders } from '@xpanel/agent'
import type { AccountRetirementStep, AgentApp } from '@xpanel/agent'
import { groups, savedFeatureKeys, shownFeatureKeys, visibleTools, visibleNavigation } from '@xpanel/catalog'
import {
  assertPackageValues,
  packageDefaults,
  redirectionValues,
  bindMfaRuntimePolicy,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  fail,
  cookieIpMode,
  DEFAULT_FPM,
  isXpanelError,
  isUuid,
  assertAcl,
  assertProvisioningAuthorization,
  assertPrivilegedSessionAuthorization,
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
  Id,
  IoAnalyticsSnapshot,
  LiveEvent,
  LiveEventScope,
  MailIpConfig,
  OsProfile,
  PhpSettings,
  Plan,
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
  findActiveApiTokenByHash,
  findActiveSessionByTokenHash,
  getPrincipal,
  latestActive,
  listAudit,
  verifyAuditLogStatus,
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
  assertNoActiveDatabaseTransaction,
  recordLoginFailure,
} from '@xpanel/db'
import type { Db, DurableJobRecord } from '@xpanel/db'
import type {
  DnsZoneState,
  DomainPatch,
  DomainMutationOptions,
  DatabaseMutationOptions,
  DomainWorkspaceRead,
  NewAccount,
  NewDomain,
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
  assertPasswordHashArgon2id,
  verifyTotpStep,
  passwordHashFromInput,
  serviceHashSchemeForOs,
  principalRecordToPrincipal,
} from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { assertPasswordAllowed, servicePasswordKinds, usePasswordStrengthPolicy } from './password-policy.ts'
import { handleSignInPolicyRoute, lockoutLimits, sessionLimits as signInSessionLimits, signInAddressRule, signInPolicyFile } from './sign-in-policy.ts'
import { handleSvcWorkspaceRoute } from './svc-workspace.ts'
import { handleTweakSettingsRoute, tweakSettingsFile, tweakValue } from './tweak-settings-workspace.ts'
import { assertDomainTweaks, zoneDefaultsFromTweaks } from '@xpanel/core'
import { handleDomainBulkRoute, handleSiteSettingsRoute } from './site-settings-workspace.ts'
import { observeDomainResolution } from './domain-resolution.ts'
import { createExtendedApiRouter, ExtendedFeaturesStore } from './extended-routes.ts'
import type { WebmailDavPorts, WebmailIdentity } from './extended-routes.ts'
import { createMailSearchWorkspace } from './mail/search-workspace.ts'
import { handleMailFolderAdminRoute } from './mail/folder-admin.ts'
import { handleMailboxUsageRoute } from './mail/mailbox-usage.ts'
import { createMailboxSendLimiter } from './mail/send-limit.ts'
import { handleMailDeviceSetupRoute } from './mail/device-setup.ts'
import { handleMailboxForwardersRoute } from './mail/mailbox-forwarders.ts'
import { applyMailRoutingChange, commitRoutingRevision, readMailRoutingStatus } from './mail/routing-application.ts'
import { handleMailboxPreferencesRoute } from './mail/mailbox-preferences.ts'
import { handleMailboxSecurityRoute } from './mail/mailbox-security.ts'
import { handleMailboxSpamRoute } from './mail/mailbox-spam.ts'
import { handleMailboxMailingListsRoute } from './mail/mailbox-mailing-lists.ts'
import { handleMailboxListAdminRoute, handleMailingListAdminRoute } from './mail/mailing-list-admin.ts'
import { handleListModerationRoute, handleMailboxListModerationRoute } from './mail/list-moderation.ts'
import { handleMailboxBoxTrapperRoute, handleOwnerBoxTrapperRoute } from './mail/boxtrapper.ts'
import { handleMailboxSettingsRoute, noteMailboxLogin } from './mail/mailbox-settings.ts'
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
import { assertAccountAuthorized, assertAccountFeatures, assertApiScope, assertRequestAuthorized, isMailboxPrincipal, requireDomainAccount, ownedAccounts, serverRoleFeatures } from './authorization.ts'
import { LiveEventHub, WS_AUTHORIZATION_UNAVAILABLE } from './ws.ts'
import type { EventSubscriber, UpgradeAuthorization } from './ws.ts'
import { renderWebApp } from '../../web/src/app.ts'
import { documentSecurityHeaders } from '../../web/src/content-security-policy.ts'
import { requestLocale, translator } from '../../web/src/i18n.ts'
import { requestPrefersHtml } from '../../web/src/status-page.ts'
import { ENTRY_POINTS, entryPointAdmitsPrincipal, entryPointAllowsApiRoute, isMailboxPrincipalUsername, sessionTokenHash } from './entry-points.ts'
import { createDavAuthorizeRoute, DAV_AUTHORIZE_PATH } from './dav-authorize.ts'
import { createMailboxLocks, openDavSession } from './mail/dav-store.ts'
import type { DavExchange } from './mail/dav-store.ts'
import { handleDavWorkspaceRoute, handleWebmailDavConfigRoute, WEBMAIL_DAV_CONFIG_PATH, WEBMAIL_DAV_PROFILE_PATH } from './dav-workspace.ts'
import { authenticateCliPeer, cliApiAllowsRoute, type CliPeer } from './cli-api/identity.ts'
import type { EntryPoint } from './entry-points.ts'
import { loadQualifiedCatalog, qualificationModeOn, type HostCatalogSource, type QualifiedCatalogProvider } from './host-catalog.ts'
import { renderTotpQrSvg } from './totp-qr.ts'
import { authorizeMailboxSessionBinding, createLocalMailboxTransport, establishMailboxSession, mailFolderName, mailboxAddressIndex, mailboxSessionPassword, openAuthorizedMailboxSession, parseMailboxSend, retireMailboxServiceUser, rewriteMailboxIds } from './mail/inbox.ts'
import { flagMailboxFolder, listMailboxFolder, readMailboxFolder, moveMailboxFolder, mailboxFolderUid, mailboxUidValidity } from './mail/folder-workspace.ts'
import type { FolderWorkspaceAuthorization } from './mail/folder-workspace.ts'
import { imapDialPlan, mailboxLiveEvent, watchMailboxIdle } from './mail/idle.ts'
import type { MailboxTransport } from './mail/inbox.ts'
import { deleteMailboxSession, listJobs, setPrincipalDisabled, setPrincipalForcePasswordChange } from '@xpanel/db'

// Public PHC fixture used only to equalize unknown-user password work; never an account credential.

const shownFeatureList = <T extends { disabled: readonly string[] }>(list: T): T => ({ ...list, disabled: shownFeatureKeys(list.disabled) })
export const INGRESS_SECRET_HEADER = 'x-xpanel-ingress-secret'

export interface TransportContext {
  remoteAddress?: string
  /** Original socket peer, explicitly null for transports without an IP peer. */
  socketRemoteAddress?: string | null
  trustedIngress?: boolean
  tls?: boolean
  /** Kernel peer of the local command-line API socket (cli-api/socket.ts); no network transport sets it. */
  cliPeer?: CliPeer
}

interface InternalTransportMeta {
  remoteAddress: string | null
  socketRemoteAddress?: string | null
  trustedIngress: boolean
  tls: boolean
  cliPeer?: CliPeer
}

const transportPeers = new WeakMap<Request, InternalTransportMeta>()
/** A request derived from another keeps its transport facts, so a re-check on it sees the same peer. */
const withTransportOf = (req: Request, derived: Request = req.clone()): Request => {
  const meta = transportPeers.get(req)
  if (meta) transportPeers.set(derived, meta)
  return derived
}
const trustedIngressRequests = new WeakSet<IncomingMessage>()

const defaultPhp = (version: PhpSettings['version'] = '8.3'): PhpSettings => ({
  version,
  handler: 'fpm',
  fpm: { ...DEFAULT_FPM },
  ini: {},
})

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  SERVICE_DISABLED: 409,
  VALIDATION: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 422,
  OVERSELL_BLOCKED: 422,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  SELF_LOCKOUT: 422,
  NO_AUTH_METHOD: 422,
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
  /** Shared process-local acceptance and host-readiness provider, supplied only by startup. */
  catalogProvider?: QualifiedCatalogProvider
  entryPoint?: EntryPoint
  publicOrigin?: string
  db: Db
  store: StateStore
  agentApp?: AgentApp
  /** The account calendar store; absent, it goes through the agent. A test passes an in-memory one. */
  davExchange?: DavExchange
  agentToken?: string
  /** Trusted startup/test authority only; no request may select a preparation store or directory. */
  provisioningPreparations?: ProvisioningPreparationStore
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
  /** Terminal sockets on the same listener (/api/terminal/ws); `close` ends every live terminal. */
  terminals?: { handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean; close(): void }
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

// Shared by the entry points of one process: xPanel and xMail write to the same mailboxes.
const mailboxLocks = createMailboxLocks()

export const createApiApp = (deps: ApiServerDeps): ApiApp => {
  const catalogSource: HostCatalogSource | null = deps.agentApp && deps.agentToken ? { fetch: deps.agentApp.fetch, token: deps.agentToken, identity: deps.agentApp } : null
  const loadCatalog = () => deps.catalogProvider ? deps.catalogProvider.load(catalogSource) : loadQualifiedCatalog(catalogSource)
  const qualificationMode = () => deps.catalogProvider ? deps.catalogProvider.qualificationMode() : qualificationModeOn()
  deps.store.registerAccountContactIndexRecovery(account => syncAccountContactIndex(deps.db, account))
  // Callers resolve authorization before entering this bounded leaf-read scope.
  // No snapshot, mutation, audit, agent call or nested state guard may run in it.
  const readRecoveredAccountProjection = async <T>(read: () => Promise<T>): Promise<T> => {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown }
    try {
      assertNoActiveDatabaseTransaction()
      outcome = await deps.store.withRecoveredAccountProjection(async () => {
        try { return { ok: true as const, value: await read() } }
        catch (error) { return { ok: false as const, error } }
      })
    } catch {
      return fail('SERVICE_UNAVAILABLE', 'Account contact recovery is unavailable')
    }
    // Preserve leaf errors only after recovery exclusion and retirement succeed.
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }
  const recoverAccountContactProjection = async (): Promise<void> => {
    assertNoActiveDatabaseTransaction()
    await deps.store.getWriterLock().waitForUnlocked()
  }
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
  // Linked servers reach each other on the xWHM listener only.
  const nodeLink = createNodeLink({ store: deps.store, db: deps.db, serverSecret, publicOrigin: entryPoint === 'xwhm' ? publicOrigin ?? null : null, version: nodePackageVersion,
    audit: (action, target, detail, outcome) => emitAudit({ actor: 'system', action, target, detail, outcome }) })
  if (entryPoint === 'xwhm') setInterval(() => { void nodeLink.announcePin().catch(() => undefined) }, NODE_PIN_WATCH_MS).unref()
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
        ...documentSecurityHeaders(html),
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
    // A local socket never crosses the network.
    if (meta?.tls || meta?.cliPeer) return true
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
  const errorReporter = createErrorReporter({ store: deps.store, db: deps.db, send: async () => (await alertTransports(deps.store)).webhook })
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
  // The saved sign-in policy (state in files) sets lockout limits, address rules, password strength and session lifetimes.
  // Session address validation is read with the sign-in policy, which every session check reads first.
  let sessionIpMode: CookieIpMode = 'strict', blankOriginRefused = false, apiCallsLogged = false
  const signInPolicy = async () => {
    const tweaks = await tweakSettingsFile(deps.store).current()
    sessionIpMode = cookieIpMode(tweaks); blankOriginRefused = tweaks['security.rejectBlankOrigin'] === true; apiCallsLogged = tweaks['logging.apiCalls'] === true
    return signInPolicyFile(deps.store).current()
  }
  const sessionLimits = (policy: Awaited<ReturnType<typeof signInPolicy>>) => ({ ...signInSessionLimits(policy), ipMode: sessionIpMode })

  if (deps.agentApp) {
    deps.agentApp.subscribe((event) => {
      hub.broadcast(event)
    })
  }


  const auditScope = new AsyncLocalStorage<{ impersonator?: Readonly<{ principalId: string; login: string }>; team?: string; ip?: string | null }>()
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
    const impersonator = auditScope.getStore()?.impersonator, team = auditScope.getStore()?.team
    const scoped = team && !Object.hasOwn(input.detail ?? {}, 'team') ? { ...input.detail, team } : input.detail
    const detail = impersonator && !Object.hasOwn(input.detail ?? {}, 'impersonator') ? { ...scoped, impersonator } : scoped
    const ip = input.ip !== undefined ? input.ip : (auditScope.getStore()?.ip ?? null)
    const entry = await appendAudit(deps.db, { ...input, actor, target, ip, ...(detail ? { detail } : {}) })
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
      const owned = await readRecoveredAccountProjection(() => deps.store.listAccounts({ ownerId: resellerId }))
      return {
        kind: 'reseller',
        id: resellerId,
        username: caller.principal.username,
        ownedAccountIds: new Set(owned.filter((a) => a.status === 'active').map((a) => a.id)),
      }
    }
    const { accountId, username } = caller.principal
    const account = await readRecoveredAccountProjection(() => deps.store.getAccount(accountId, { username }))
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
      const caller = await authenticateRequest(deps.db, webReq, { serverSecret, clientIp: extractClientIp(webReq), touchSession: false, entryPoint, mfaRuntimePolicy, handoffAuthority, sessionLimits: sessionLimits(await signInPolicy()) })
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
  /** A command-line request is named by its kernel peer; every other request by its own credentials. */
  const authenticateTransport = (db: Db, req: Request, options: Parameters<typeof authenticateRequest>[2]): Promise<AuthenticatedCaller | null> => {
    const cliPeer = transportPeers.get(req)?.cliPeer
    return cliPeer ? authenticateCliPeer({ db, store: deps.store }, entryPoint, cliPeer) : authenticateRequest(db, req, options)
  }
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
    const policy = await signInPolicy()
    usePasswordStrengthPolicy(policy.passwordStrength)
    let addressChanged = false, tokenAddressDenied = false
    const caller = await authenticateTransport(deps.db, req, { serverSecret, clientIp, entryPoint, mfaRuntimePolicy, teamMember, handoffAuthority, sessionLimits: sessionLimits(policy), onSessionAddressMismatch: () => { addressChanged = true }, onTokenAddressDenied: () => { tokenAddressDenied = true } })
    if (!caller) {
      if (tokenAddressDenied) return fail('FORBIDDEN', 'this API token may not be used from this address', { reason: 'token_address_denied' })
      return addressChanged ? fail('UNAUTHENTICATED', 'this session was opened from another address', { reason: 'SESSION_IP_MISMATCH' }) : fail('UNAUTHENTICATED', 'authentication required')
    }
    if (apiCallsLogged && caller.apiTokenId !== null) {
      const { pathname } = new URL(req.url, 'http://localhost')
      await emitAudit({ actor: caller.principal.username, action: 'api.call', target: `${req.method.toUpperCase()} ${pathname}`, outcome: 'ok', principalId: caller.principal.id, ip: clientIp }).catch(() => undefined)
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
        (origin === null && (secFetchSite === 'cross-site' || deps.requireOriginHeader === true || blankOriginRefused))
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
    // Offline mode leaves root working; everyone else keeps only identity and sign-out.
    if (!panelOfflineAdmits(pathname, caller.principal.kind) && (await panelSettingsFile(deps.store).current()).offlineMode) {
      return fail('SERVICE_UNAVAILABLE', 'the panel is offline for maintenance', { reason: 'panel_offline', stateChanged: false })
    }
    const nativeMailboxSession = caller.sessionId !== null && caller.apiTokenId === null
      && caller.principal.kind === 'user' && isMailboxPrincipalUsername(caller.principal.username)
    // xMail serves mailbox identities only; an owner, reseller or root session never acts there.
    if (entryPoint === 'xmail' && !nativeMailboxSession) return fail('FORBIDDEN', 'xMail accepts mailbox sign-in only')
    if (caller.team) { const scope = auditScope.getStore(); if (scope) scope.team = caller.team.login }
    if (caller.impersonator) {
      const scope = auditScope.getStore()
      if (scope) scope.impersonator = caller.impersonator
      if (impersonationForbidsRoute(pathname, method)) return fail('FORBIDDEN', 'a handed-off session cannot change the sign-in identity of the account it opened', { stateChanged: false, impersonated: true })
      if (isTemporaryLogin(caller.impersonator.login)) await admitTemporaryRequest({ caller, pathname, method, ip: clientIp, emitAudit })
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

  const terminalTickets = new TerminalTickets()
  const terminalRegistry = new TerminalRegistry()
  const readTerminalExecution = async (caller: AuthenticatedCaller): Promise<TerminalExecution> => {
    if (!deps.agentApp || !deps.agentToken) return { state: 'unavailable', reason: 'host_agent_not_connected' }
    try {
      const response = await callAgent('/terminal', { caller })
      const body = await response.json() as { execution?: TerminalExecution }
      const execution = body.execution
      if (response.ok && execution?.state === 'available' && [execution.idleTimeoutSeconds, execution.absoluteTimeoutSeconds, execution.maxInputBytes].every(value => Number.isSafeInteger(value) && value > 0)) return execution
      if (response.ok && execution?.state === 'unavailable' && /^[a-z_]{1,64}$/.test(execution.reason)) return { state: 'unavailable', reason: execution.reason }
    } catch { /* reported below */ }
    return { state: 'unavailable', reason: 'host_agent_unavailable' }
  }

  const shareLinksFile = stateConfigFile<FileShareLinks>(deps.store, FILE_SHARE_LINKS_STATE_PATH, FILE_SHARE_LINKS_NAMESPACE, parseShareLinks, () => ({ links: [] }))
  const shareMisses = createShareMissLimiter(), shareUses = createShareMissLimiter(Date.now, SHARE_USE_LIMIT)
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

  const davExchange: DavExchange = deps.davExchange ?? (async (caller, account, input) => {
    const response = await callAgent('/accounts/' + account.username + '/dav-exchange', { method: 'POST', caller, body: input })
    if (!response.ok) return fail('SERVICE_UNAVAILABLE', 'the calendar store is not available', { stateChanged: false, reason: 'dav_store_unavailable' })
    return { status: Number(response.headers.get('x-xpanel-dav-status')), etag: response.headers.get('x-xpanel-dav-etag'), body: await response.text() }
  })
  const dav: WebmailDavPorts = {
    open: (caller, account, authority) => openDavSession({ exchange: davExchange, listServiceUsers: accountId => deps.store.listServiceUsers(accountId) }, caller, account, authority),
    lock: mailboxLocks,
  }

  /** New domains start on the root-chosen default; existing domains keep their version. */
  const serverDefaultPhp = async (): Promise<PhpSettings> => defaultPhp((await deps.store.getServerSettings())?.defaultPhpVersion ?? '8.3')

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
    const generation = body?.generation
    const gen = generation !== null && typeof generation === 'object' && !Array.isArray(generation) ? generation as Record<string, unknown> : null
    const validGen = gen !== null && Number.isSafeInteger(gen.id) && Number(gen.id) >= 1 && gen.status === 'active'
      && typeof gen.checksum === 'string' && /^[a-f0-9]{64}$/.test(gen.checksum)
    if (body?.status === 'noop') {
      if (!validGen || typeof body.stateChecksum !== 'string' || !/^[a-f0-9]{64}$/.test(body.stateChecksum)) {
        return accountMutationFailure(caller, account, action, 'not_applied', 'host_apply_not_verified', 'PRECONDITION_FAILED')
      }
      if (await deps.store.getRevision() !== expectedRevision) {
        return accountMutationFailure(caller, account, action, 'unknown', 'state_changed_during_apply', 'CONFLICT')
      }
      const snapshot = await deps.store.readSnapshot()
      if (snapshot.checksum !== body.stateChecksum) {
        return accountMutationFailure(caller, account, action, 'not_applied', 'host_apply_not_verified', 'PRECONDITION_FAILED')
      }
      return { status: 'applied', generation: { id: Number(gen.id), status: 'active', checksum: gen.checksum as string }, filesCount: 0, durationMs: 0 }
    }
    if (body?.status !== 'applied' || !validGen
      || !Number.isSafeInteger(body.filesCount) || Number(body.filesCount) < 0
      || typeof body.durationMs !== 'number' || !Number.isFinite(body.durationMs) || body.durationMs < 0) {
      return accountMutationFailure(caller, account, action, 'unknown', 'host_reply_unverified')
    }
    if (await deps.store.getRevision() !== expectedRevision) {
      return accountMutationFailure(caller, account, action, 'unknown', 'state_changed_during_apply', 'CONFLICT')
    }
    return { status: 'applied', generation: { id: Number(gen.id), status: 'active', checksum: gen.checksum as string }, filesCount: Number(body.filesCount), durationMs: body.durationMs }
  }

  /**
   * Termination legitimately removes the account from desired state inside the very generation that
   * proves the host teardown, so the generic state-revision equality check cannot apply here. Accept
   * only an applied generation with a valid active identity; the caller then re-reads desired state.
   * Returns the account's irreversible removal step that stopped after that generation committed, if any.
   */
  const applyTerminationConfiguration = async (caller: AuthenticatedCaller, account: Account): Promise<{ userRemoved: boolean; failedStep: AccountRetirementStep } | undefined> => {
    let response: Response
    try { response = await callAgent('/state/apply', { method: 'POST', caller, body: { force: false } }) }
    catch { return accountMutationFailure(caller, account, 'account.terminate', 'unknown', 'host_transport_unknown') }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      return accountMutationFailure(caller, account, 'account.terminate', 'failed', 'host_apply_rejected', response.status === 422 ? 'CONFIG_TEST_FAILED' : 'SERVICE_UNAVAILABLE', response.status)
    }
    let body: Record<string, unknown> | null
    try { body = await readAccountApplyBody(response) }
    catch { return accountMutationFailure(caller, account, 'account.terminate', 'unknown', 'host_reply_unverified') }
    if (body?.status === 'failed') return accountMutationFailure(caller, account, 'account.terminate', 'failed', 'host_apply_failed', 'CONFIG_TEST_FAILED')
    if (body?.status === 'noop') return
    const generation = body?.generation
    const gen = generation !== null && typeof generation === 'object' && !Array.isArray(generation) ? generation as Record<string, unknown> : null
    const incomplete = body?.incompleteRetirements
    if (body?.status !== 'applied' || !gen || !Number.isSafeInteger(gen.id) || Number(gen.id) < 1 || gen.status !== 'active'
      || typeof gen.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(gen.checksum)
      || !Number.isSafeInteger(body.filesCount) || Number(body.filesCount) < 0
      || typeof body.durationMs !== 'number' || !Number.isFinite(body.durationMs) || body.durationMs < 0
      || (incomplete !== undefined && (!Array.isArray(incomplete) || incomplete.some(entry => entry === null || typeof entry !== 'object'
        || typeof entry.accountId !== 'string' || typeof entry.userRemoved !== 'boolean' || !ACCOUNT_RETIREMENT_STEPS.includes(entry.failedStep))))) {
      return accountMutationFailure(caller, account, 'account.terminate', 'unknown', 'host_reply_unverified')
    }
    const own = (incomplete as { accountId: string; userRemoved: boolean; failedStep: AccountRetirementStep }[] | undefined)?.find(entry => entry.accountId === account.id)
    return own && { userRemoved: own.userRemoved, failedStep: own.failedStep }
  }

  /** Verified target-bound purge of an account (DELETE /api/accounts/<id>, and the rollback of a failed transfer or import). */
  const purgeAccount = async (caller: AuthenticatedCaller, current: Account): Promise<void> => {
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
    const marked = current.status === 'terminating' ? current : await deps.store.markTerminating(current.id)
    // Native teardown is the reconciler's terminate plan: stop the account's units and slices, clear the
    // quota, delete the user and remove the home (and drop the account databases). The account leaves the
    // desired state in the same admitted generation whose reported outcome proves those host effects.
    let retirement: Awaited<ReturnType<typeof applyTerminationConfiguration>>
    try {
      retirement = await applyTerminationConfiguration(caller, marked)
    } catch (error) {
      return fail(isXpanelError(error) ? error.code : 'SERVICE_UNAVAILABLE', 'account termination requires verification', {
        ...(isXpanelError(error) ? error.detail : {}), verificationRequired: true, stateChanged: true, reason: 'termination_host_effect_unverified',
      })
    }
    // The account's configuration already left the host; a later reconciliation resumes at the named step.
    if (retirement) {
      return fail('SERVICE_UNAVAILABLE', retirement.userRemoved
        ? 'the account user was removed, but a later removal step needs repair'
        : 'the account configuration was removed, but removing the account user needs repair', {
        verificationRequired: true, stateChanged: true, reason: 'account_retirement_incomplete', ...retirement,
      })
    }
    const remaining = await deps.store.getAccount(marked.id)
    if (remaining) {
      return fail('SERVICE_UNAVAILABLE', 'account termination did not complete', {
        verificationRequired: true, stateChanged: true, reason: 'termination_not_completed',
      })
    }
    await revokeAccountSessionsAndTokens(deps.db, marked.id)
    terminalRegistry.revoke({ accountId: marked.id })
    const identities = await deps.db.query<{ id: string }>('SELECT id FROM principals WHERE account_id = $1 ORDER BY id', [marked.id])
    for (const identity of identities) await deletePrincipal(deps.db, identity.id)
    await reindexFromState(deps.db, await deps.store.readSnapshot())
    await emitAudit({ actor: caller.principal.username, action: 'account.terminated', target: 'account:' + marked.username,
      detail: { purged: true }, outcome: 'ok', principalId: caller.principal.id,
    }, { accountId: marked.id, resellerId: marked.ownerId })
  }

  const accountExecution = () => ({ status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } as const)

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
    if (password.length > 256) return fail('VALIDATION', 'database password must be 8 to 256 characters')
    assertPasswordAllowed(password, 'database')
    return `*${createHash('sha1').update(createHash('sha1').update(password).digest()).digest('hex').toUpperCase()}`
  }

  const recordFailedLoginAndMaybeLock = async (
    username: string,
    ip: string,
    reason: string,
    principalId?: Id | null,
  ): Promise<void> => {
    const policy = await signInPolicy()
    if (signInAddressRule(policy, ip) === 'allowed') {
      await recordLoginAttempt(deps.db, { surface: 'panel', username, ip, success: false, reason })
      return
    }
    const failure = await recordLoginFailure(deps.db, { username, ip, reason, surface: 'panel', ...lockoutLimits(policy) })
    if (failure.lockedUntil) {
      const failures = Math.max(failure.usernameFailures, failure.ipFailures)
      await emitAudit({ actor: username, action: 'auth.lockout', target: 'authentication', detail: { failures, lockedUntil: failure.lockedUntil }, outcome: 'denied', principalId: principalId ?? null, ip })
      return fail('FORBIDDEN', 'too many failed authentication attempts', { lockedOut: true, failures, lockedUntil: failure.lockedUntil })
    }
  }

  /** An allowed address is never locked out, even while its username is. */
  const activeLockout = async (username: string, ip: string): Promise<{ lockedUntil: string } | null> =>
    signInAddressRule(await signInPolicy(), ip) === 'allowed' ? null : checkLockout(deps.db, { username, ip })
  const davAuthorize = createDavAuthorizeRoute({ store: deps.store, db: deps.db, recordFailure: (login, ip) => recordFailedLoginAndMaybeLock(login, ip, 'dav_invalid_credentials') })

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
  const serviceHashScheme = serviceHashSchemeForOs(deps.os)
  const extendedRouter = createExtendedApiRouter({
    db: deps.db,
    store: deps.store,
    dav,
    serverSecret,
    serviceHashScheme,
    ...(deps.agentApp && deps.agentToken ? { maintainDatabase: (caller: AuthenticatedCaller, account: Account, body: { database: string; action: string }) => readNativeWorkspace(caller, `/accounts/${account.username}/databases/maintenance`, body, body.action === 'repair') } : {}),
    ...(deps.agentApp && deps.agentToken ? { readQuotaState: (caller: AuthenticatedCaller, path: string) =>
      readNativeWorkspace(caller, '/host/quota?path=' + encodeURIComponent(path), undefined, false, 'GET'),
    initializeQuota: (caller: AuthenticatedCaller, path: string) =>
      readNativeWorkspace(caller, '/host/quota/initialize', { path }, true, 'POST', null, true) } : {}),
    ...(deps.agentApp && deps.agentToken ? { purgeListQueue: async (caller: AuthenticatedCaller, accountId: string, address: string) => {
      const account = await deps.store.getAccount(accountId)
      if (account) await readNativeWorkspace(caller, `/host/mailx/accounts/${account.username}/list-moderation`, { address, call: { op: 'purge' } }, true)
    } } : {}),
    backupDestinationHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined),
    ...(deps.agentApp && deps.agentToken ? { transferPorts: (() => {
      const agent = (caller: AuthenticatedCaller, path: string, init: { method?: string; body?: unknown } = {}) => callAgent(path, { caller, ...init })
      const createAccount = async (caller: AuthenticatedCaller, input: { username: string; primaryDomain: string; planId: string }) => createLifecycleAccount(caller, input, { store: deps.store, db: deps.db, php: await serverDefaultPhp(), hashPassword: password => passwordHashFromInput({ password }),
        readTemplates: () => new ExtendedFeaturesStore(deps.store.rootDir).readOrDefault<unknown>('accounts/templates.json', null), applyConfiguration: applyAccountConfiguration })
      const applyAccount = async (caller: AuthenticatedCaller, account: Account) => applyAccountConfiguration(caller, account, 'update', await deps.store.getRevision())
      const audit = (caller: AuthenticatedCaller, action: string, target: string, detail: Record<string, unknown>, outcome: 'ok' | 'failed') => emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action, target, detail, outcome })
      const shared = { store: deps.store, agent, createAccount, applyAccount, removeAccount: purgeAccount, defaultPhp: serverDefaultPhp, audit }
      return {
        execution: createTransferExecution({ ...shared, readToken: id => readTransferCredentialToken(deps.store, id) }),
        nodeAuth: nodeLink.transferAuth,
        cpanel: createCpanelImportPorts({ ...shared, uploadDir: opsJoin(deps.store.rootDir, 'extended', 'transfers', 'cpanel'), maxBytes: 50 * 1024 ** 3, serviceHash: password => passwordHashFromInput({ password }, { service: ['mail'], scheme: serviceHashScheme }) }),
        // background work acts as the root user who started it, re-read from the principal store each time
        callerFor: async (principalId: string): Promise<AuthenticatedCaller | null> => {
          const record = await getPrincipal(deps.db, principalId)
          return record && !record.disabled && record.kind === 'root' ? { principal: principalRecordToPrincipal(record), principalRecord: record, sessionId: null, sessionToken: null, apiTokenId: null, scopes: ['*'], csrfValid: false, mfaVerified: true } : null
        },
      }
    })() } : {}),
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

  const readNativeWorkspace = async <T>(caller: AuthenticatedCaller, path: string, input?: unknown, mutation = false, method = 'POST', managementClient: string | null = null, relayRefusal = false): Promise<T> => {
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
      const relayed = relayRefusal ? (['VALIDATION', 'SERVICE_UNAVAILABLE', 'CONFIG_TEST_FAILED'] as const).find(known => known === problem.code) : undefined
      const code: ErrorCode = relayed ?? (response.status === 401 ? 'UNAUTHENTICATED' : response.status === 403 ? 'FORBIDDEN' : response.status === 404 ? 'NOT_FOUND' : response.status === 409 ? 'CONFLICT' : response.status === 422 ? 'VALIDATION' : 'PRECONDITION_FAILED')
      return fail(code, relayRefusal && typeof problem.detail === 'string' ? problem.detail : 'the protected host request was refused', { ...(relayRefusal ? detail : {}), stateChanged: mutation && !knownUnchanged, ...(mutation && !knownUnchanged ? { unknownOutcome: true, verificationRequired: true } : {}), ...(typeof detail.reason === 'string' && /^[A-Za-z_]{1,64}$/.test(detail.reason) ? { reason: detail.reason } : {}) })
    }
    return body as T
  }
  // sec: WAF, flood, panel access and DNS cluster workspaces; panelAccessEnforced is true because the request gate below is installed.
  const secHelpers = (): SecWorkspaceHelpers => ({ requireCaller, assertRoot, emitAudit, triggerReconcile, store: deps.store, panelAccessEnforced: true, readExtra: kind => readMailCertExtra(deps.store, kind),
    readClient: request => { let address: string | null = null; try { address = extractClientIp(request) } catch { address = null }; return { listener: entryPoint ?? null, address } },
    ...(deps.agentApp && deps.agentToken ? { callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}),
  })
  const extendHost = deps.agentApp && deps.agentToken ? { callHost: (caller: AuthenticatedCaller, path: string, body?: unknown) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}
  const lifecycleHooks = createLifecycleHooks({ store: deps.store, emitAudit, ...extendHost })
  // Security questions, external sign-in and root identity (security-questions.ts, external-auth.ts, root-identity-workspace.ts).
  const identityHelpers: RootIdentityHelpers & { db: Db; store: StateStore; clientIp: (request: Request) => string | null } = { requireCaller, assertRoot, emitAudit, db: deps.db, store: deps.store, clientIp: request => extractClientIp(request),
    verifyPassword: (caller, password) => verifyPasswordArgon2id(password, caller.principalRecord.passwordHash),
    checkLockout: async (caller, request) => (await checkLockout(deps.db, { username: caller.principal.username, ip: extractClientIp(request) ?? '127.0.0.1' }))?.lockedUntil ?? null,
    recordFailure: (caller, reason, request) => recordFailedLoginAndMaybeLock(caller.principal.username, extractClientIp(request) ?? '127.0.0.1', reason, caller.principal.id),
    secondFactorEnrolled: caller => mfaRuntimePolicy.mode !== 'disabled' && caller.principalRecord.totpEnabled && Boolean(caller.principalRecord.totpSecretEnc),
    verifySecondFactor: async (caller, code) => { const sealed = caller.principalRecord.totpSecretEnc; const step = sealed ? verifyTotpStep(unsealTotpSecret(sealed, serverSecret), code) : null; return step !== null && await consumeTotpStep(deps.db, caller.principal.id, step, sealed!) },
    ...(deps.agentApp && deps.agentToken ? { callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}) }
  const externalAuth = createExternalAuth({ ...identityHelpers, entryPoint, publicOrigin, secureCookies: useSecureCookies, fetch: (input, init) => globalThis.fetch(input, init),
    otherOrigins: { ...(entryPoint === 'xwhm' && handoffTargetOrigin ? { xpanel: handoffTargetOrigin } : {}), ...(entryPoint === 'xpanel' && handoffIssuerOrigin ? { xwhm: handoffIssuerOrigin } : {}) } })
  const identityRoutes = async (request: Request, url: URL, method: string): Promise<Response | null> => await externalAuth.handle(request, url, method)
    ?? await handleSecurityQuestionsRoute(request, url, method, identityHelpers) ?? await handleRootIdentityWorkspaceRoute(request, url, method, identityHelpers)
  const cronHost = async (caller: AuthenticatedCaller, intent: CronJobIntent, operation: 'status' | 'run'): Promise<CronJobObservationReceipt> => {
    const account = await deps.store.getAccount(intent.accountId)
    if (!account || account.status !== 'active' || caller.principal.kind !== 'user' || isMailboxPrincipal(caller) || caller.principal.accountId !== account.id) return fail('FORBIDDEN', 'cron account is unavailable', { stateChanged: false })
    return readNativeWorkspace(caller, '/accounts/' + account.username + '/cron/' + intent.jobId + '/' + operation, intent, operation === 'run')
  }
  const siteHealthDns = systemSiteHealthDns()
  const networkToolsGate = createNetworkToolsGate()
  const mailboxSendLimiter = createMailboxSendLimiter()
  // Trusted host admission for cron mutations: the agent qualifies the host scheduler primitive for this
  // account. Without it a saved schedule could be acknowledged while the host cannot execute it.
  const admitCronHostFromAgent = async (caller: AuthenticatedCaller, account: Account, _action: 'save' | 'run'): Promise<void> => {
    const response = await callAgent(`/accounts/${account.username}/cron/admission`, { caller })
    const body = await response.json().catch(() => null)
    assertCronHostAdmissionReply(response.status, body)
  }
  const cronRouter = createCronWorkspaceRoutes({
    store: deps.store, requireCaller, emitAudit, triggerReconcile,
    ...(deps.os ? { osProfile: deps.os } : {}),
    withCronAccountLease: (id, operation) => deps.store.withCronAccountLease(id, operation),
    admitCronMutation: (caller, account, action) => deps.admitCronMutation ? deps.admitCronMutation(caller, account, action) : admitCronHostFromAgent(caller, account, action),
    runCronNow: (caller, intent) => cronHost(caller, intent, 'run'),
    observeCronStatus: (caller, intent) => cronHost(caller, intent, 'status'),
  })

  const sslStorePorts: SslStorePorts = { store: deps.store, requireCaller, assertCanAccessAccount, callAgent: deps.agentApp && deps.agentToken ? callAgent : null,
    reconcile: caller => triggerReconcile(caller),
    audit: async (caller, action, target, detail) => { await emitAudit({ actor: caller.principal.username, action, target, detail, outcome: 'ok', principalId: caller.principal.id }) } }
  const certificateRuntimeRouter = createCertificateRuntimeRouter({
    store: deps.store, hostAvailable: Boolean(deps.agentApp && deps.agentToken), requireCaller, assertCanAccessAccount,
    assertCanBindCertificate, resolveResellerForCaller, callAgent, triggerReconcile, emitAudit,
    requireHostAgent: requireAccountHostAgent, readJsonBody, jsonResponse,
    readStoreMaterial: ({ caller, account, certificateId }) => readSslStoreMaterial(sslStorePorts, caller, account, certificateId),
  })

  const dynamicDns = createDynamicDnsRoutes({
    store: deps.store, requireCaller, emitAudit,
    readPrincipal: id => getPrincipal(deps.db, id),
    assertUpdateAvailable: async () => {
      if (!deps.agentApp || !deps.agentToken) return fail('PRECONDITION_FAILED', 'DNS publication is unavailable', { stateChanged: false })
      const catalog = await loadCatalog()
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

  const temporaryLoginRoutes = createTemporaryLoginRoutes({ db: deps.db, store: deps.store, ...(publicOrigin ? { publicOrigin } : {}), serverSecret, emitAudit, clientIp: request => extractClientIp(request) ?? '127.0.0.1', secureCookies: useSecureCookies, text: (request, message) => translator(requestLocale(new URL(request.url), request))(message) })
  const handoffRoutes = createHandoffRoutes({
    db: deps.db, store: deps.store, ...(entryPoint ? { entryPoint } : {}),
    ...(handoffTargetOrigin ? { targetOrigin: handoffTargetOrigin } : {}), ...(handoffIssuerOrigin ? { issuerOrigin: handoffIssuerOrigin } : {}),
    requireCaller: request => requireCaller(request), emitAudit,
    clientIp: request => extractClientIp(request) ?? '127.0.0.1', secureCookies: useSecureCookies, teamMember,
  })

  // Account lifecycle operations shared by the HTTP routes and the WHMCS provisioning ports.
  type CreateAccountBody = Partial<NewAccount> & { spf?: unknown; dkim?: unknown; dmarc?: unknown; username: string; primaryDomain: string; planId: Id; password?: string; idempotencyKey?: string }
  const provisioningPreparations = deps.provisioningPreparations ?? createProvisioningPreparationAuthority({ store: deps.store,
    directory: opsJoin(deps.store.rootDir, 'private', 'account-provisioning') })
  const provisioningPort = deps.agentApp && deps.agentToken ? createAuthenticatedProvisioningPort({
    fetch: request => deps.agentApp!.fetch(request), token: deps.agentToken,
  }) : undefined
  const readAccountTemplates = () => new ExtendedFeaturesStore(deps.store.rootDir).readOrDefault<unknown>('accounts/templates.json', null)
  // One account provisioning at a time: another creation writes state, which changes the revision an in-flight
  // provisioning is bound to and aborts its host step. shortcut: in-process only; one API process provisions accounts.
  let provisioningQueue: Promise<unknown> = Promise.resolve()
  const serialProvisioning = <T>(task: () => Promise<T>): Promise<T> => {
    const run = provisioningQueue.then(task, task); provisioningQueue = run.catch(() => undefined); return run
  }
  /**
   * Creations answered 202: null while this process still runs them (audit, hooks and skeleton follow the job), then the
   * answer their POST would have given, for the poller. shortcut: in-process and the latest 64 only; after a restart or
   * eviction the job alone answers (account-create-operations.ts).
   */
  const acceptedCreations = new Map<string, AccountCreateOutcome | null>()
  const settleCreation = (id: string, outcome: AccountCreateOutcome): void => {
    acceptedCreations.set(id, outcome)
    for (const [key, value] of acceptedCreations) { if (acceptedCreations.size <= 64) break; if (value !== null) acceptedCreations.delete(key) }
  }
  const createAccountAs = async (caller: AuthenticatedCaller, body: CreateAccountBody, authority: {
    reference: ProvisioningAuthorizationReference; reauthenticate: () => Promise<AuthenticatedCaller>; idempotencyKey?: unknown
    onHostStep?: Parameters<AccountLifecycleCoordinator['provisionPreparedAccount']>[0]['onHostStep']
  }) => {
    requireAccountHostAgent()
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => ![
      'username', 'primaryDomain', 'planId', 'password', 'passwordHash', 'ownerId', 'contactEmail', 'ipv4', 'ipAssignment',
      'ipv6', 'extraIps', 'shell', 'php', 'homeBase', 'forcePasswordChange', 'idempotencyKey', 'spf', 'dkim', 'dmarc',
    ].includes(key))) return fail('VALIDATION', 'unsupported account creation fields', { stateChanged: false })
    const omitMailAuth = parseMailAuthOptions(body)
    if (caller.principal.kind !== 'root' && caller.principal.kind !== 'reseller') return fail('FORBIDDEN', 'a privileged actor is required')
    const username = validateUsername(body.username)
    const primaryDomain = validateDomainName(body.primaryDomain)
    if (!isUuid(body.planId) || (caller.principal.kind === 'root' && body.ownerId !== undefined && body.ownerId !== null && !isUuid(body.ownerId))) {
      return fail('VALIDATION', 'valid account plan and owner identities are required', { stateChanged: false })
    }
    // Reject invalid credential input before reserving an immutable preparation. Hash only on its first admitted write.
    if (body.password !== undefined && body.passwordHash !== undefined) return fail('VALIDATION', 'supply a password or passwordHash, not both', { stateChanged: false })
    const credentialIntent = body.passwordHash !== undefined ? assertPasswordHashArgon2id(body.passwordHash) : body.password
    if (typeof credentialIntent !== 'string' || (body.passwordHash === undefined && (Buffer.byteLength(credentialIntent, 'utf8') > 1024 || /[\r\n\0]/.test(credentialIntent)))) {
      return fail('VALIDATION', 'a single-line password of 8..1024 UTF-8 bytes is required', { stateChanged: false })
    }
    if (body.passwordHash === undefined) assertPasswordAllowed(credentialIntent, 'panel')
    const explicitKey = authority.idempotencyKey ?? body.idempotencyKey
    if (authority.idempotencyKey !== undefined && body.idempotencyKey !== undefined && authority.idempotencyKey !== body.idempotencyKey) {
      return fail('VALIDATION', 'the account request keys do not match', { stateChanged: false })
    }
    // Legacy clients reuse one deterministic identity per actor/username. Changed inputs or credentials conflict;
    // a retry never receives a random key or adopts an existing account. Explicit keys use the same durable namespace.
    const idempotencyKey = explicitKey === undefined ? `username:${username}` : typeof explicitKey === 'string' ? explicitKey
      : fail('VALIDATION', 'the account request key must be a bounded string', { stateChanged: false })
    const reseller = caller.principal.kind === 'reseller' ? await resolveResellerForCaller(caller) : null
    if (caller.principal.kind === 'reseller') assertAcl(caller.principal, reseller, 'create-account')
    const ownerId = caller.principal.kind === 'reseller' ? reseller!.id : body.ownerId ?? null
    const requestedPlan = await deps.store.getPlan(body.planId) ?? fail('NOT_FOUND', 'the account plan is unavailable', { stateChanged: false })
    if ((await deps.store.getServerSettings())?.nameservers.filter(Boolean).length === 0) return fail('PRECONDITION_FAILED', 'set the server nameservers before creating an account', { stateChanged: false, reason: 'nameservers_not_configured' })
    const accountInput: PreparedAccountState['account'] = { username, primaryDomain, planId: body.planId,
      ownerId, contactEmail: body.contactEmail ?? `${username}@${primaryDomain}`,
      ...(body.ipv4 !== undefined && { ipv4: body.ipv4 }), ...(body.ipAssignment !== undefined && { ipAssignment: body.ipAssignment }),
      ...(body.ipv6 !== undefined && { ipv6: body.ipv6 }), ...(body.extraIps !== undefined && { extraIps: body.extraIps }),
      shell: body.shell ?? requestedPlan.shell, php: body.php ?? await serverDefaultPhp(), ...(body.homeBase !== undefined && { homeBase: body.homeBase }),
      forcePasswordChange: body.forcePasswordChange ?? false,
    }
    if (authority.reference.principalId !== caller.principal.id) return fail('FORBIDDEN', 'account provisioning credential identity changed', { stateChanged: false })
    const authorizeFresh = async (input: { actor: AuthenticatedCaller['principal']; accountId: Id | null; ownerId: Id | null }): Promise<void> => {
      const fresh = await authority.reauthenticate()
      if (fresh.principal.id !== caller.principal.id || fresh.principal.kind !== caller.principal.kind
        || fresh.principal.username !== caller.principal.username || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId
        || fresh.principal.id !== input.actor.id || fresh.principal.kind !== input.actor.kind || input.ownerId !== ownerId) {
        return fail('FORBIDDEN', 'account provisioning authorization changed', { stateChanged: false })
      }
      if (fresh.principal.kind === 'reseller') {
        const current = await resolveResellerForCaller(fresh)
        assertAcl(fresh.principal, current, 'create-account')
        if (!current || current.id !== ownerId) return fail('FORBIDDEN', 'account owner authority changed', { stateChanged: false })
      }
      if (input.accountId) {
        const account = await deps.store.getAccount(input.accountId)
        if (!account || account.ownerId !== ownerId || account.username !== username) return fail('FORBIDDEN', 'account provisioning identity changed', { stateChanged: false })
      }
    }
    const prepared = await prepareAccountProvisioning({ store: deps.store, preparations: provisioningPreparations, authorizeFresh, readTemplates: readAccountTemplates,
      assertIdentityAvailable: async account => { if (await findPrincipalByUsername(deps.db, account.username)) return fail('CONFLICT', 'the account username is already reserved', { stateChanged: false }) },
    }, {
      actor: caller.principal, idempotencyKey, account: accountInput, credentialIntent, authorizationRef: authority.reference, omitMailAuth, zoneDefaults: zoneDefaultsFromTweaks(await tweakSettingsFile(deps.store).current()),
      preparePasswordHash: () => passwordHashFromInput(body), verifyCredentialIntent: body.passwordHash === undefined
        ? (intent, hash) => verifyPasswordArgon2id(intent, hash)
        : async (intent, hash) => { const left = Buffer.from(intent), right = Buffer.from(hash); return left.length === right.length && timingSafeEqual(left, right) },
    })
    const lifecycle = new AccountLifecycleCoordinator({ store: deps.store, db: deps.db, preparations: provisioningPreparations,
      ...(provisioningPort ? { provisioningPort } : {}), authorizeProvisioning: authorizeFresh, readAccountTemplates,
      authorizeProvisioningInTransaction: (tx, input) => assertProvisioningAuthorization({ ...input, policy: mfaRuntimePolicy,
        ports: { principal: id => getPrincipal(tx, id), session: tokenHash => findActiveSessionByTokenHash(tx, tokenHash),
          apiToken: tokenHash => findActiveApiTokenByHash(tx, tokenHash),
          whmcs: async () => readSavedWhmcs(await new ExtendedFeaturesStore(deps.store.rootDir).readOrDefault<unknown>('integrations/whmcs.json', null)) },
      }),
    })
    const result = await serialProvisioning(() => lifecycle.provisionPreparedAccount({ actor: caller.principal, idempotencyKey, preparationReference: prepared.preparationReference,
      ...(authority.onHostStep && { onHostStep: authority.onHostStep }) })).catch(error => {
      // A consumed request key is a known refusal before any effect; it carries no diagnostics or operation IDs.
      if (isXpanelError(error) && error.detail.reason === 'provisioning_key_already_completed') throw error
      // Agent diagnostics and internal operation IDs are not a public failure contract. A lost
      // acknowledgment never becomes a rollback claim or permission to repeat privileged work.
      return fail(isXpanelError(error) ? error.code : 'SERVICE_UNAVAILABLE', 'account provisioning did not acknowledge a verified outcome', {
        stateChanged: isXpanelError(error) ? error.detail.stateChanged === true : true,
        verificationRequired: true, reason: 'account_provisioning_unverified',
      })
    })
    const account = result.account
    const freshExecution = isFreshProvisioningHostEffect(result)
    const currentObservation = result.execution ?? result.reobservedExecution
    const execution = currentObservation ? { status: 'account_verified', scope: 'account', targetVerified: true, verificationRequired: false, observation: currentObservation }
      : { status: 'already_completed', scope: 'account', targetVerified: false, verificationRequired: true, replay: true,
        ...(result.lastVerifiedExecution && { lastVerifiedObservation: result.lastVerifiedExecution }) }
    let primaryDomains: Domain[]
    try {
      if (!result.completedReplay) await emitAudit({ actor: caller.principal.username, action: 'account.desired.created', target: 'account:' + account.username,
        detail: { accountId: account.id, primaryDomain: account.primaryDomain, planId: account.planId, execution }, outcome: 'ok', principalId: caller.principal.id,
      }, { accountId: account.id, resellerId: account.ownerId })
      primaryDomains = await deps.store.listDomains({ accountId: account.id })
    } catch (error) {
      return fail(isXpanelError(error) ? error.code : 'SERVICE_UNAVAILABLE', 'account provisioning completed but its acknowledgment requires verification', {
        stateChanged: true, verificationRequired: true, reason: 'account_provisioning_acknowledgment_unverified',
      })
    }
    if (!result.completedReplay) lifecycleHooks.after('account.create', account, caller)
    try { await authorizeFresh({ actor: caller.principal, accountId: account.id, ownerId }) }
    catch { return fail('FORBIDDEN', 'account provisioning authorization changed before acknowledgment', { stateChanged: true, verificationRequired: true }) }
    // cPanel copies the skeleton at creation only: a replayed request finds it copied, or its owner's edits, in place.
    const skeleton = result.completedReplay === true ? { copied: 0, failed: [] } : await copySkeleton({
      readFiles: async () => readSkeleton(await new ExtendedFeaturesStore(deps.store.rootDir).readOrDefault<unknown>(`accounts/skeletons/${ownerId ?? 'root'}.json`, null)),
      op: async body => (await callAgent('/accounts/' + account.username + '/files', { caller, method: 'POST', body })).ok,
    })
    if (skeleton.copied || skeleton.failed.length) await emitAudit({ actor: caller.principal.username, action: 'account.skeleton.copied', target: 'account:' + account.username, detail: { copied: skeleton.copied, failed: skeleton.failed.length }, outcome: skeleton.failed.length ? 'failed' : 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
    return { account, skeleton, primaryDomain: primaryDomains[0] ?? null, reconcile: result.reconciliation, execution,
      operation: { status: result.job.status, reference: result.job.referenceCode, resumedFromStep: result.resumedFromStep, freshExecution, completedReplay: result.completedReplay === true } }
  }
  const setAccountSuspensionAs = async (caller: AuthenticatedCaller, target: Account, verb: 'suspend' | 'unsuspend', reason?: string, lock?: boolean) => {
    requireAccountHostAgent()
    if (lock !== undefined && (verb !== 'suspend' || typeof lock !== 'boolean')) fail('VALIDATION', 'lock applies to a suspension and is a boolean', { stateChanged: false })
    if (lock) await assertRoot(caller, 'account.suspend.lock')
    const captured = await captureAccountMutation(caller, target.id, 'account.' + verb, account => {
      const expected = verb === 'suspend' ? 'active' : 'suspended'
      if (account.status !== expected) fail('CONFLICT', 'account is not in the expected state for this transition')
    }, verb === 'unsuspend' ? async account => {
      terminalRegistry.revoke({ accountId: account.id })
      try { await revokeAccountSessionsAndTokens(deps.db, account.id) }
      catch { fail('SERVICE_UNAVAILABLE', 'account access cleanup requires verification', { reason: 'access_revocation_failed', verificationRequired: true, stateChanged: false }) }
    } : undefined)
    await lifecycleHooks.before(verb === 'suspend' ? 'account.suspend' : 'account.unsuspend', captured.account, caller)
    const updated = verb === 'suspend'
      ? await deps.store.suspendAccount(captured.account.id, reason || 'Suspended by administrator', { expectedRevision: captured.expectedRevision, ...(lock && { lock }) })
      : await deps.store.unsuspendAccount(captured.account.id, { expectedRevision: captured.expectedRevision, allowLocked: caller.principal.kind === 'root' })
    if (verb === 'unsuspend') await clearAccountMoved(deps.store.rootDir, updated.id)
    if (verb === 'suspend') {
      terminalRegistry.revoke({ accountId: updated.id })
      try { await revokeAccountSessionsAndTokens(deps.db, updated.id) }
      catch { return accountMutationFailure(caller, updated, verb, 'unknown', 'access_revocation_failed') }
    }
    const reconcile = await applyAccountConfiguration(caller, updated, verb, captured.expectedRevision + 1)
    await emitAudit({ actor: caller.principal.username, action: 'account.desired.' + (verb === 'suspend' ? 'suspended' : 'unsuspended'),
      target: 'account:' + updated.username, detail: { accountStatus: updated.status, reason: updated.suspendReason, execution: accountExecution() }, outcome: 'ok', principalId: caller.principal.id,
    }, { accountId: updated.id, resellerId: updated.ownerId })
    lifecycleHooks.after(verb === 'suspend' ? 'account.suspend' : 'account.unsuspend', updated, caller)
    return { account: updated, reconcile, execution: accountExecution() }
  }
  const updateAccountAs = async (caller: AuthenticatedCaller, target: Account, patch: { planId?: Id; ownerId?: Id | null; contactEmail?: string; shell?: 'none' | 'jailed' }) => {
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
    if (patch.contactEmail !== undefined || patch.shell !== undefined) {
      updated = await deps.store.updateAccount(updated.id, { ...(patch.contactEmail !== undefined && { contactEmail: patch.contactEmail }), ...(patch.shell !== undefined && { shell: patch.shell }) }, { expectedRevision }); expectedRevision++
    }
    const reconcile = await applyAccountConfiguration(caller, updated, 'update', expectedRevision)
    await emitAudit({ actor: caller.principal.username, action: 'account.desired.updated', target: 'account:' + updated.username,
      detail: { execution: accountExecution() }, outcome: 'ok', principalId: caller.principal.id,
    }, { accountId: updated.id, resellerId: updated.ownerId })
    return { account: updated, reconcile, execution: accountExecution() }
  }
  /** The caller re-check and the purge; the confirmation grammar stays in the HTTP route. */
  const terminateAccountAs = async (caller: AuthenticatedCaller, target: Account, confirmUsername: string) => {
    const current = await deps.store.getAccount(target.id)
    if (!current) return fail('NOT_FOUND', 'account not found')
    await assertCanAccessAccount(caller, current, 'account.delete', { allowUserSelf: false })
    if (confirmUsername !== current.username) return fail('CONFLICT', 'account confirmation is no longer current')
    // A retried termination is already past its point of no return, and a transfer rollback purges without these hooks.
    if (current.status !== 'terminating') await lifecycleHooks.before('account.terminate', current, caller)
    await purgeAccount(caller, current)
    lifecycleHooks.after('account.terminate', current, caller)
    return { ok: true as const, purged: true as const }
  }

  /** WHMCS acts as the root administrator who issued its current token; a disabled or demoted issuer stops every call. */
  const whmcsCaller = async (actor: string): Promise<AuthenticatedCaller> => {
    const record = await getPrincipal(deps.db, actor)
    if (!record || record.kind !== 'root' || record.disabled || record.forcePasswordChange) {
      return fail('FORBIDDEN', 'the root administrator who issued the WHMCS token is no longer active; create a new token', { stateChanged: false, reason: 'token_issuer_inactive' })
    }
    return { principal: principalRecordToPrincipal(record), principalRecord: record, sessionId: null, sessionToken: null, apiTokenId: null, scopes: [], csrfValid: true, mfaVerified: true }
  }
  const whmcsAccount = async (username: string): Promise<Account> =>
    await deps.store.getAccountByUsername(username) ?? fail('NOT_FOUND', `account "${username}" not found`, { stateChanged: false, reason: 'account_not_found' })
  const whmcsPorts: WhmcsProvisionPorts = {
    createAccount: async (input, authority) => {
      const caller = await whmcsCaller(input.actor)
      if (authority.reference.principalId !== caller.principal.id || authority.reference.planId !== input.planId) return fail('FORBIDDEN', 'WHMCS account authority does not match its request', { stateChanged: false })
      await createAccountAs(caller, { username: input.username, primaryDomain: input.primaryDomain, planId: input.planId,
        password: input.password, ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}) }, {
        reference: authority.reference, idempotencyKey: `whmcs:${validateUsername(input.username)}`,
        reauthenticate: async () => { await authority.assertCurrent(); return whmcsCaller(input.actor) },
      })
    },
    suspendAccount: async input => { await setAccountSuspensionAs(await whmcsCaller(input.actor), await whmcsAccount(input.username), 'suspend', input.reason) },
    unsuspendAccount: async input => { await setAccountSuspensionAs(await whmcsCaller(input.actor), await whmcsAccount(input.username), 'unsuspend') },
    terminateAccount: async input => { const account = await whmcsAccount(input.username); await terminateAccountAs(await whmcsCaller(input.actor), account, account.username) },
    // WHMCS also sends ChangePackage when only configurable options change: an unchanged plan is a success.
    changePlan: async input => {
      const caller = await whmcsCaller(input.actor), account = await whmcsAccount(input.username)
      if (account.planId !== input.planId) await updateAccountAs(caller, account, { planId: input.planId })
    },
  }
  const whmcsHelpers: WhmcsRouteHelpers = { store: deps.store, requireCaller, assertRoot, emitAudit, clientIp: extractClientIp, ports: whmcsPorts }

  const routeRequest = async (req: Request, context?: TransportContext): Promise<Response> => {
    const reportedBody = await keepErrorBody(req, errorReporter)
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
        ...(context.cliPeer ? { cliPeer: Object.freeze({ ...context.cliPeer }) } : {}),
      })
    }
    const activeAuditScope = auditScope.getStore()
    if (activeAuditScope) {
      try { activeAuditScope.ip = extractClientIp(req) } catch { activeAuditScope.ip = null }
    }
    const url = new URL(req.url, 'http://localhost')
    const { pathname } = url
    const method = req.method.toUpperCase()
    const mediaType = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    const rawUploadAllowed = method === 'PUT' && (
      (/^\/api\/server\/panel\/languages\/[A-Za-z0-9-]{1,35}\/catalog$/.test(pathname) && ['text/x-gettext-translation', 'text/x-po', 'text/plain'].includes(mediaType))
      || (/^\/api\/server\/panel\/branding\/(?:logo|favicon)$/.test(pathname) && ['image/png', 'image/jpeg', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(mediaType))
    )
    if (req.body !== null && pathname.startsWith('/api/') && mediaType !== 'application/json' && !rawUploadAllowed) {
      return transportProblem(415, 'UNSUPPORTED_MEDIA_TYPE', 'application/json is required', pathname)
    }

    try {
      if (publicOrigin && url.host !== new URL(publicOrigin).host) {
        if (prefersDocumentHtml(req, pathname, method)) return renderTransportStatus(req, 421)
        return transportProblem(421, 'MISDIRECTED_REQUEST', 'request host does not match this entry point', pathname)
      }
      const cliPeer = transportPeers.get(req)?.cliPeer
      if (cliPeer && !cliApiAllowsRoute(pathname, method)) return transportProblem(404, 'NOT_FOUND', 'route is unavailable to the command-line API', pathname)
      if (entryPoint && pathname.startsWith('/api/') && !entryPointAllowsApiRoute(entryPoint, pathname, method)) return transportProblem(404, 'NOT_FOUND', 'route is unavailable on this entry point', pathname)
      if (entryPoint && pathname !== '/api/health' && deps.requireSecureCookies && !isVerifiedHttps(req)) return transportProblem(403, 'FORBIDDEN', 'verified HTTPS ingress is required for this entry point', pathname)
      // An unsubscribe link must work from any address: the recipient is not a panel user.
      if (pathname === UNSUBSCRIBE_PATH) return (await handleUnsubscribeRoute(req, url, method, deps.store))!
      // sec: saved panel-access allowlist for this entry point, checked before sign-in on the socket or trusted-ingress address.
      // It filters network clients; the local command-line socket has no network peer.
      if (entryPoint && pathname !== '/api/health' && !cliPeer && !await secPanelAccessGate(deps.store.rootDir, entryPoint, () => extractClientIp(req))) {
        if (prefersDocumentHtml(req, pathname, method)) return renderTransportStatus(req, 403)
        return transportProblem(403, 'FORBIDDEN', 'this address is not allowed on this entry point', pathname)
      }
      if (entryPoint && !cliPeer) { const gated = await panelGate({ rootDir: deps.store.rootDir, listener: entryPoint, request: req, pathname, search: url.search, method, secret: serverSecret, secure: useSecureCookies(req), client: () => extractClientIp(req) ?? '127.0.0.1', hasSession: async () => !!await authenticateTransport(deps.db, req, { serverSecret, clientIp: extractClientIp(req), touchSession: false, entryPoint, mfaRuntimePolicy, teamMember, handoffAuthority }).catch(() => null) }); if (gated) return gated }
      // Dynamic DNS changes state on GET. A failed row leaves this try, so no operation runs unrecorded.
      if ((!['GET', 'HEAD', 'OPTIONS'].includes(method) || pathname === '/nic/update') && qualificationMode()) {
        const caller = await authenticateTransport(deps.db, req, { serverSecret, clientIp: extractClientIp(req), touchSession: false, entryPoint, mfaRuntimePolicy, teamMember, handoffAuthority }).catch(() => null)
        await emitAudit({ actor: caller?.principal.username ?? 'anonymous', principalId: caller?.principal.id ?? null, action: 'qualification.operation', target: `${method} ${pathname}`.slice(0, 256), outcome: 'ok', ip: extractClientIp(req) })
      }
      if (pathname === '/nic/update') {
        if (entryPoint !== 'xpanel') return transportProblem(404, 'NOT_FOUND', 'route is unavailable on this entry point', pathname)
        if (!publicOrigin || url.host !== new URL(publicOrigin).host || !isVerifiedHttps(req)) return transportProblem(403, 'FORBIDDEN', 'verified HTTPS ingress and the configured host are required', pathname)
        // Socket peer only: forwarded client headers never select the DDNS source address.
        return (await dynamicDns.update(req, url, transportPeers.get(req)?.socketRemoteAddress ?? null))!
      }
      if (pathname.startsWith('/hook/')) {
        if (entryPoint !== 'xpanel') return transportProblem(404, 'NOT_FOUND', 'route is unavailable on this entry point', pathname)
        if (!publicOrigin || url.host !== new URL(publicOrigin).host || !isVerifiedHttps(req)) return transportProblem(403, 'FORBIDDEN', 'verified HTTPS ingress and the configured host are required', pathname)
        return handleInboundHook(req, url, transportPeers.get(req)?.socketRemoteAddress ?? null, { store: deps.store, emitAudit, start: async id => {
          if (!deps.agentApp || !deps.agentToken) return false
          const root = await findPrincipalByUsername(deps.db, 'root')
          if (!root || root.disabled || root.kind !== 'root') return false
          const response = await deps.agentApp.fetch(new Request(`http://agent.local/host/host-tools/run/${id}`, { method: 'POST', headers: { ...agentCallerHeaders({ principalId: root.id, token: deps.agentToken }), 'content-type': 'application/json' }, body: '{}' }))
          await response.body?.cancel()
          return response.status === 202
        } })
      }
      // A public download: the token is the whole authority, so it stays on the account listener and verified HTTPS.
      if (pathname.startsWith('/share/')) {
        if (entryPoint !== 'xpanel' || !isVerifiedHttps(req)) return transportProblem(404, 'NOT_FOUND', 'route is unavailable on this entry point', pathname)
        return await handleFileShareDownload(req, url, method, { limiter: shareMisses, uses: shareUses, clientAddress: () => { try { return extractClientIp(req) } catch { return null } }, emitAudit,
          readLinks: async () => (await shareLinksFile.read()).value?.links ?? [],
          openFile: link => callAgent('/host/file-sharing/links/' + link.tokenHash + '/content', { caller: { principal: { id: link.createdById } } as AuthenticatedCaller }) })
      }
      // The edge's Web Disk and calendar verification; only the management ingress may name the account (dav-authorize.ts).
      if (pathname === DAV_AUTHORIZE_PATH) return entryPoint === 'xpanel' && method === 'GET' && isVerifiedHttps(req) ? davAuthorize(req, extractClientIp(req) ?? '') : transportProblem(404, 'NOT_FOUND', 'route is unavailable on this entry point', pathname)
      // ---- Health --------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/health') {
        return jsonResponse({ ok: true })
      }
      // WHMCS authenticates with its scoped token and address allowlist, not a session.
      if (pathname === WHMCS_PROVISION_PATH) return (await handleWhmcsRoute(req, url, method, whmcsHelpers))!
      // Cluster members authenticate with their per-member token and address, not a session.
      if (pathname.startsWith(DNS_CLUSTER_PEER_PREFIX)) return isVerifiedHttps(req) ? handleDnsClusterPeerRoute(req, url, method, { store: deps.store, clientAddress: request => { try { return extractClientIp(request) } catch { return null } }, issuer: whmcsCaller, callHost: (caller, path) => readNativeWorkspace(caller, path), reconcile: caller => triggerReconcile(caller), audit: entry => emitAudit(entry) }) : transportProblem(403, 'FORBIDDEN', 'verified HTTPS ingress is required', pathname)

      if (entryPoint === 'xwhm') { const temporary = await temporaryLoginRoutes(req, pathname, method); if (temporary) return temporary }
      // ---- One-time panel handoff ------------------------------------------------------
      const handedOff = await handoffRoutes(req, pathname, method)
      if (handedOff) return handedOff

      const identityResponse = await identityRoutes(req, url, method)
      if (identityResponse) return identityResponse

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
          external?: boolean
          securityAnswers?: unknown
        }>(req)
        // A provider sign-in this browser completed names the linked principal in place of a password.
        const external = body.external === undefined ? null : body.external === true && body.username === undefined && body.password === undefined
          ? await externalAuth.redeemSignIn(req) : fail('VALIDATION', 'an external sign-in carries no username or password')
        const username = external?.username ?? (typeof body.username === 'string' ? body.username.trim().toLowerCase() : '')
        const password = typeof body.password === 'string' ? body.password : ''
        if (!username || (!password && !external)) {
          return fail('VALIDATION', 'username and password are required')
        }

        if (signInAddressRule(await signInPolicy(), ip) === 'denied') {
          await recordLoginAttempt(deps.db, { surface: 'panel', username, ip, success: false, reason: 'address_denied' })
          await emitAudit({ actor: username, action: 'auth.login_denied_address', target: `principal:${username}`, outcome: 'denied', ip })
          return fail('FORBIDDEN', 'sign-in is not allowed from this address', { reason: 'address_denied' })
        }
        const lockout = await activeLockout(username, ip)
        if (lockout) {
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
            detail: { lockedUntil: lockout.lockedUntil },
            outcome: 'denied',
            ip,
          })
          return fail('FORBIDDEN', `too many failed login attempts; locked until ${lockout.lockedUntil}`, {
            lockedOut: true,
            lockedUntil: lockout.lockedUntil,
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
              totpCode: body.totpCode,
              recoveryCode: body.recoveryCode,
              mfaMode: mfaRuntimePolicy.mode,
              ip,
              userAgent: req.headers.get('user-agent') ?? 'xpanel-client',
            })
          } catch (err) {
            // The password was accepted: ask for the second factor without counting a failure, like the panel sign-in.
            if (isXpanelError(err) && err.code === 'UNAUTHENTICATED' && err.detail.mfaRequired === true) return fail('UNAUTHENTICATED', 'two-factor authentication code required', { mfaRequired: true })
            if (isXpanelError(err) && err.code === 'UNAUTHENTICATED') {
              const reason = err.detail.reason === 'invalid_totp' || err.detail.reason === 'invalid_recovery_code' ? err.detail.reason : 'invalid_credentials'
              await emitAudit({
                actor: username,
                action: 'auth.login_failed',
                target: `mailbox:${username}`,
                detail: { reason },
                outcome: 'denied',
                ip,
              })
              await recordFailedLoginAndMaybeLock(username, ip, reason, null)
              return fail('UNAUTHENTICATED', reason === 'invalid_totp' ? 'invalid two-factor authentication code' : reason === 'invalid_recovery_code' ? 'invalid recovery code' : 'invalid username or password', reason === 'invalid_credentials' ? undefined : { reason })
            }
            throw err
          }
          await clearLockout(deps.db, { username })
          await recordLoginAttempt(deps.db, { surface: 'panel', username, ip, success: true })
          await recordLogin(deps.db, established.principal.id)
          void alertTransports(deps.store).then(transports => noteMailboxLogin({ rootDir: deps.store.rootDir, store: deps.store, mailbox: established.mailbox, ip, email: transports.email, serverName: transports.serverName })).catch(() => undefined)
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
        const passwordValid = principalRecord !== null && !principalRecord.disabled && (external ? external.principalId === principalRecord.id : passwordMatches)

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
        await checkSecurityQuestions(identityHelpers, { principalId: principalRecord.id, username, ip, answers: body.securityAnswers, external: external !== null,
          secondFactorVerified: mfaRuntimePolicy.mode !== 'disabled' && principalRecord.totpEnabled, recordFailure: reason => recordFailedLoginAndMaybeLock(username, ip, reason, principalRecord.id) })

        const rawToken = randomBytes(32).toString('hex')
        const tokenHash = sessionTokenHash(rawToken, entryPoint)
        const { absoluteMs } = sessionLimits(await signInPolicy())
        const expiresAt = new Date(Date.now() + absoluteMs).toISOString()
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
          maxAgeSec: absoluteMs / 1000,
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
            detail: { sessionId: session.id, mfa: session.mfaVerified, mfaMode: mfaRuntimePolicy.mode, ...(external ? { externalProvider: external.providerId } : {}) },
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
          terminalRegistry.revoke({ panelSessionId: caller.sessionId })
        }
        await emitAudit({
          actor: caller.team?.login ?? caller.principal.username,
          action: 'auth.logout',
          target: caller.team ? `team:${caller.team.login}` : `principal:${caller.principal.username}`,
          outcome: 'ok',
          principalId: caller.principal.id,
          ip: extractClientIp(req),
        })
        return jsonResponse({ ok: true, redirect: redirectionValues(await tweakSettingsFile(deps.store).current()).logoutUrl }, 200, {
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
        terminalRegistry.revoke({ principalId: caller.principal.id, exceptPanelSessionId: caller.sessionId })
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
        terminalRegistry.revoke({ panelSessionId: sessionId })
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
        const lockout = await activeLockout(caller.principal.username, ip)
        if (lockout) return fail('FORBIDDEN', 'too many failed authentication attempts', { lockedOut: true, lockedUntil: lockout.lockedUntil })
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
        terminalRegistry.revoke({ principalId: caller.principal.id })
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
          context.disabledFeatures = new Set([...featureList.disabled, ...await serverRoleFeatures(deps.store)])
        } else if (caller.principal.kind === 'reseller') {
          const reseller = await resolveResellerForCaller(caller)
          if (!reseller) return fail('FORBIDDEN', 'reseller authorization is unavailable')
          context.reseller = reseller
        }
        const catalog = await loadCatalog()
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
          const hits = await readRecoveredAccountProjection(() => searchIndex(deps.db, q, { ...(kind && { kind }) }))
          return jsonResponse({ hits })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const hits = await readRecoveredAccountProjection(() => searchIndex(deps.db, q, {
            ...(resellerId && { ownerId: resellerId }),
            ...(kind && { kind }),
          }))
          return jsonResponse({ hits })
        }
        const accountId = caller.principal.accountId
        const hits = await readRecoveredAccountProjection(() => searchIndex(deps.db, q, {
          accountId,
          ...(kind && { kind }),
        }))
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
        if (current?.ftp) next.ftp = current.ftp
        else delete next.ftp
        if (current?.ssh) next.ssh = current.ssh
        else delete next.ssh
        if (current && body.sshPort !== undefined && body.sshPort !== current.sshPort) return fail('VALIDATION', 'use the guarded SSH workspace to change the SSH port', { stateChanged: false })
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
        const failedTest = reconcile?.body.status === 'failed' && reconcile.body.verificationRequired !== true && typeof reconcile.body.failedTest === 'string' ? reconcile.body.failedTest : null
        if (current && failedTest && JSON.stringify(current.web) !== JSON.stringify(settings.web)) {
          // Web directives the web server refuses are not kept: the previous ones stay saved, as they stay running.
          await deps.store.saveServerSettings(current, { settingsGuard: async fresh => {
            if (JSON.stringify(fresh) !== JSON.stringify(settings)) fail('CONFLICT', 'server settings changed again before the refused directives were restored', { stateChanged: true, verificationRequired: true })
          } })
          const error = typeof reconcile!.body.error === 'string' ? reconcile!.body.error.slice(0, 2000) : null
          await emitAudit({ actor: currentCaller.principal.username, action: 'server.settings.web_refused', target: 'server:settings', detail: { failedTest }, outcome: 'failed', principalId: currentCaller.principal.id })
          return fail('CONFIG_TEST_FAILED', 'the web server refused the new directives; the previous directives stay saved and running', { stateChanged: false, failedTest, error })
        }
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
          return jsonResponse({ featureLists: (await deps.store.listFeatureLists()).map(shownFeatureList) })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const all = await deps.store.listFeatureLists()
          return jsonResponse({
            featureLists: all.filter((f) => f.ownerId === null || f.ownerId === resellerId).map(shownFeatureList),
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
          disabled: savedFeatureKeys(body.disabled ?? []),
        })
        await emitAudit({
          actor: caller.principal.username,
          action: 'feature_list.created',
          target: `feature-list:${featureList.id}`,
          detail: { name: featureList.name },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ featureList: shownFeatureList(featureList) }, 201)
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
          const featureList = await deps.store.updateFeatureList(flId, patch.disabled === undefined ? patch : { ...patch, disabled: savedFeatureKeys(patch.disabled) })
          return jsonResponse({ featureList: shownFeatureList(featureList) })
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
          return jsonResponse({ plans: await enrichPlansWithAuditMeta(deps.db, all) })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          return jsonResponse({ plans: await enrichPlansWithAuditMeta(deps.db, all.filter((p) => p.ownerId === null || p.ownerId === resellerId)) })
        }
        const acc = await deps.store.getAccount(caller.principal.accountId)
        return jsonResponse({ plans: await enrichPlansWithAuditMeta(deps.db, all.filter((p) => p.id === acc?.planId)) })
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

        const packageValues = packageDefaults(await tweakSettingsFile(deps.store).current())
        const resources = {
          diskMb: packageValues.diskMb,
          bandwidthMbMonth: packageValues.bandwidthMbMonth,
          ioReadBps: 50_000_000,
          ioWriteBps: 50_000_000,
          ioReadIops: 2000,
          ioWriteIops: 2000,
          memoryMb: 1024,
          maxProcesses: 64,
          cpuPercent: 200,
          ...body.resources,
        }
        const defaultMailboxQuotaMb =
          body.defaultMailboxQuotaMb ??
          (typeof resources.diskMb === 'number' ? Math.min(packageValues.mailboxQuotaMb, Math.max(1, resources.diskMb)) : packageValues.mailboxQuotaMb)
        const finalCaps = body.caps ?? {
          addonDomains: 10,
          aliasDomains: 10,
          subdomains: 20,
          mailboxes: 20,
          forwarders: 20,
          mailingLists: 5,
          ftpAccounts: 10,
          databases: 10,
          phpWorkers: 8,
        }
        if (caller.principal.kind === 'reseller' && [...Object.values(resources), ...Object.values(finalCaps)].some((value) => value === 'unlimited')) {
          assertAcl(caller.principal, await resolveResellerForCaller(caller), 'allow-unlimited-plans')
        }
        assertPackageValues({ resources, defaultMailboxQuotaMb })

        const plan = await deps.store.createPlan({
          name: body.name,
          ownerId,
          featureListId,
          resources,
          caps: finalCaps,
          dedicatedIp: body.dedicatedIp ?? false,
          shell: body.shell ?? 'jailed',
          defaultMailboxQuotaMb,
          ...(body.enforceBandwidth !== undefined && { enforceBandwidth: body.enforceBandwidth }),
          updatedAt: new Date().toISOString(),
          updatedBy: caller.principal.username,
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
          if (patch.name !== undefined && patch.name !== existing.name) return fail('VALIDATION', 'a plan name is permanent', { stateChanged: false })
          if (patch.dedicatedIp !== undefined && patch.dedicatedIp !== existing.dedicatedIp) return fail('VALIDATION', 'a plan keeps its dedicated IP option', { stateChanged: false })
          if (caller.principal.kind === 'reseller' && [...Object.values(patch.resources ?? {}), ...Object.values(patch.caps ?? {})].some((value) => value === 'unlimited')) {
            assertAcl(caller.principal, await resolveResellerForCaller(caller), 'allow-unlimited-plans')
          }
          assertPackageValues(patch)
          const plan = await deps.store.updatePlan(planId, {
            ...patch,
            updatedAt: new Date().toISOString(),
            updatedBy: caller.principal.username,
          })
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
      if (pathname.startsWith('/api/resellers/acl-lists') || pathname === '/api/resellers/email') {
        const response = await handleResellerWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit, store: deps.store,
          email: (await alertTransports(deps.store)).email, reindex: async () => { await reindexFromState(deps.db, await deps.store.readSnapshot()) } })
        if (response) return response
      }
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

      const resellerSuspension = await handleResellerSuspensionRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit, setSuspension: setAccountSuspensionAs, setLoginDisabled: (id, disabled) => setPrincipalDisabled(deps.db, id, disabled) })
      if (resellerSuspension) return resellerSuspension
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
      if (pathname === '/api/webmail/search-index' || /^\/api\/webmail\/inbox\/[1-9]\d*\/report$/.test(pathname)) {
        const response = await handleMailboxEngineRoute(req, url, method, {
          open: async (request, tool) => { const { caller, opened } = await authorizeNativeMailboxRequest(request, [tool]); return { caller, mailbox: opened.record.mailbox.toLowerCase() } },
          callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined),
          move: async (caller, uid, body) => await moveMailboxFolder(await mailboxFolderDependencies(req, caller, mailboxTransport), uid, body) as unknown as Record<string, unknown>,
          readBody: request => readJsonBody(request),
          audit: async (session, action, detail) => { await emitAudit({ actor: session.caller.principal.username, principalId: session.caller.principal.id, action, target: 'mailbox:' + session.mailbox, outcome: 'ok', detail }) },
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
          sendEmail: async message => { await (await alertTransports(deps.store)).email(message) },
        })
        if (response) return response
      }
      if (pathname === WEBMAIL_DAV_CONFIG_PATH || pathname === WEBMAIL_DAV_PROFILE_PATH) {
        const response = await handleWebmailDavConfigRoute(req, url, method, { store: deps.store, open: async request => {
          const { opened } = await authorizeNativeMailboxRequest(request, ['webmail-dav-config'])
          return { mailbox: opened.record.mailbox, accountId: opened.record.accountId, serviceUserId: opened.record.serviceUserId }
        } })
        if (response) return response
      }
      if (pathname === '/api/webmail/forwarders') {
        const response = await handleMailboxForwardersRoute(req, url, method, { store: deps.store,
          open: async request => (await authorizeNativeMailboxRequest(request, ['webmail-forwarders', 'forwarders'])).opened,
          audit: sealedImapPorts('webmail-forwarders').audit,
          routing: {
            status: () => readMailRoutingStatus(deps.store, deps.db),
            commit: commitRoutingRevision,
            apply: async (request, revision, previous) => {
              const { caller } = await authorizeNativeMailboxRequest(request, ['webmail-forwarders', 'forwarders'])
              return applyMailRoutingChange({ store: deps.store, db: deps.db, reconcile: () => triggerReconcile(caller),
                audit: reason => emitAudit({ actor: caller.principal.username, action: 'mail.routing.rolled_back', target: 'mail-routing:mail/forwarders.json',
                  detail: { reason }, outcome: 'failed', principalId: caller.principal.id }) },
              revision, { path: opsJoin(deps.store.rootDir, 'extended', 'mail', 'forwarders.json'), previous })
            },
          } })
        if (response) return response
      }
      if (pathname === '/api/webmail/spam-preferences' || pathname === '/api/webmail/mailing-lists' || pathname.startsWith('/api/webmail/mailing-lists/') || pathname === '/api/webmail/boxtrapper' || pathname === '/api/webmail/boxtrapper/queue') {
        const trap = pathname.startsWith('/api/webmail/boxtrapper')
        const ids = pathname === '/api/webmail/spam-preferences' ? ['webmail-spam-box', 'webmail-spam-autodelete'] : trap ? ['webmail-boxtrapper'] : ['webmail-mailing-lists']
        const ports = { store: deps.store, open: async (request: Request) => (await authorizeNativeMailboxRequest(request, ids)).opened, audit: sealedImapPorts(ids[0]!).audit }
        const routing = { commit: commitRoutingRevision, apply: async (request: Request, revision: number, restore: { path: string; previous: unknown }) => {
          const { caller } = await authorizeNativeMailboxRequest(request, ids)
          return applyMailRoutingChange({ store: deps.store, db: deps.db, reconcile: () => triggerReconcile(caller),
            audit: reason => emitAudit({ actor: caller.principal.username, action: 'mail.routing.rolled_back', target: 'mail-routing:webmail/spam-preferences',
              detail: { reason }, outcome: 'failed', principalId: caller.principal.id }) }, revision, restore)
        } }
        const response = pathname === '/api/webmail/spam-preferences' ? await handleMailboxSpamRoute(req, url, method, { ...ports, routing })
          : trap ? await handleMailboxBoxTrapperRoute(req, url, method, { ...ports, routing, callHost: deps.agentApp && deps.agentToken ? async (request, username, body, mutation) => readNativeWorkspace((await authorizeNativeMailboxRequest(request, ids)).caller, `/host/mailx/accounts/${username}/boxtrapper`, body, mutation) : null })
            : await handleMailboxListAdminRoute(req, url, method, { ...ports, routing }) ?? await handleMailboxListModerationRoute(req, url, method, { ...ports, callHost: deps.agentApp && deps.agentToken ? async (request, username, body, mutation) => readNativeWorkspace((await authorizeNativeMailboxRequest(request, ids)).caller, `/host/mailx/accounts/${username}/list-moderation`, body, mutation) : null }) ?? await handleMailboxMailingListsRoute(req, url, method, ports)
        if (response) return response
      }
      if (pathname === '/api/webmail/security' || pathname.startsWith('/api/webmail/security/')) {
        const response = await handleMailboxSecurityRoute(req, url, method, { db: deps.db, serverSecret, mfaMode: mfaRuntimePolicy.mode, store: deps.store,
          transport: deps.mailboxTransport ?? createLocalMailboxTransport(mailboxEnvironment),
          requireCaller: request => requireCaller(request), open: (request, toolIds) => authorizeNativeMailboxRequest(request, toolIds),
          hashPassword: (password, services) => passwordHashFromInput({ password }, { service: servicePasswordKinds(services), scheme: serviceHashScheme }),
          reconcile: caller => triggerReconcile(caller),
          audit: async (caller, action, mailbox, detail) => {
            const account = await deps.store.getAccount(caller.principal.kind === 'user' ? caller.principal.accountId : '')
            await emitAudit({ actor: mailbox, action, target: 'mailbox:' + mailbox, outcome: 'ok', principalId: caller.principal.id, ...(detail ? { detail } : {}) }, { accountId: account?.id ?? null, resellerId: account?.ownerId ?? null })
          },
          lockedUntil: async (mailbox, request) => (await checkLockout(deps.db, { username: mailbox, ip: extractClientIp(request) ?? '127.0.0.1' }))?.lockedUntil ?? null,
          recordFailure: (mailbox, request, reason, principalId) => recordFailedLoginAndMaybeLock(mailbox, extractClientIp(request) ?? '127.0.0.1', reason, principalId),
          clearCookie: request => clearSessionCookie({ secure: useSecureCookies(request), entryPoint }),
        })
        if (response) return response
      }
      if (pathname === '/api/webmail/preferences') {
        const response = await handleMailboxPreferencesRoute(req, url, method, { store: deps.store,
          open: async request => (await authorizeNativeMailboxRequest(request, ['webmail-preferences'])).opened,
          audit: sealedImapPorts('webmail-preferences').audit, ...(deps.os ? { os: deps.os } : {}) })
        if (response) return response
      }
      if (pathname === '/api/webmail/mailbox-settings') {
        const response = await handleMailboxSettingsRoute(req, url, method, { store: deps.store, open: async request => (await authorizeNativeMailboxRequest(request, ['webmail-preferences'])).opened,
          audit: sealedImapPorts('webmail-preferences').audit, email: (await alertTransports(deps.store)).email,
          reconcile: async () => { await triggerReconcile((await authorizeNativeMailboxRequest(req, ['webmail-preferences'])).caller); return true } })
        if (response) return response
      }
      if (pathname === '/api/webmail/attachment-workspace' || pathname.startsWith('/api/webmail/attachment-download/')) {
        await authorizeNativeMailboxRequest(req, ['webmail-attachments'])
        const response = await handleNativeAttachmentRequest(req)
        if (response) return response
      }
      const moveMatch = /^\/api\/webmail\/inbox\/([1-9]\d*)\/move$/.exec(pathname)
      const flagMatch = /^\/api\/webmail\/inbox\/([1-9]\d*)\/flag$/.exec(pathname)
      const inboxMatch = /^\/api\/webmail\/inbox\/([1-9]\d*)$/.exec(pathname)
      if (pathname === '/api/webmail/inbox' && method === 'GET') {
        const caller = await requireCaller(req)
        return jsonResponse(await listMailboxFolder(await mailboxFolderDependencies(req, caller, mailboxTransport), url.searchParams.get('folder'), {
          offset: url.searchParams.get('offset'),
          limit: url.searchParams.get('limit'),
        }))
      }
      if (moveMatch && method === 'POST') {
        const { caller } = await authorizeNativeMailboxRequest(req)
        if (url.search) return fail('VALIDATION', 'mailbox moves do not accept query selectors', { stateChanged: false })
        const body = await readJsonBody(req)
        return jsonResponse(await moveMailboxFolder(await mailboxFolderDependencies(req, caller, mailboxTransport), moveMatch[1], body))
      }
      if (flagMatch && (method === 'POST' || method === 'PATCH')) {
        const { caller } = await authorizeNativeMailboxRequest(req)
        if (url.search) return fail('VALIDATION', 'mailbox flag updates do not accept query selectors', { stateChanged: false })
        const body = await readJsonBody(req)
        return jsonResponse(await flagMailboxFolder(await mailboxFolderDependencies(req, caller, mailboxTransport), flagMatch[1], body))
      }
      if (inboxMatch && (method === 'GET' || method === 'DELETE')) {
        const caller = await requireCaller(req)
        if (method === 'GET') {
          const allowRemoteImages = url.searchParams.get('remoteImages') === '1'
          return jsonResponse(await readMailboxFolder(await mailboxFolderDependencies(req, caller, mailboxTransport), inboxMatch[1], url.searchParams.get('folder'), allowRemoteImages ? { allowRemoteImages: true } : undefined))
        }
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
        const hourlySends = await tweakValue(deps.store, 'security.mailboxSendsPerHour')
        if (typeof hourlySends === 'number') mailboxSendLimiter.assertAvailable(opened.record.mailbox, hourlySends)
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
      if (pathname.startsWith('/api/account/file-restoration')) {
        const response = await handleOwnerFileRestorationRoute(req, url, method, { requireCaller, getAccount: id => deps.store.getAccount(id), assertCanAccessAccount: (caller, account, action) => assertCanAccessAccount(caller, account, action),
          assertAccountFeatures: (caller, account, toolIds) => assertAccountFeatures(deps.store, caller, account, toolIds), ...(deps.agentApp && deps.agentToken ? { callAgent: (path, options) => callAgent(path, options) } : {}) })
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
        const recheckRequest = withTransportOf(req)
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
      const emailDiskUsage = await handleEmailDiskUsageWorkspaceRoute(req, url, method, accountToolPorts)
      if (emailDiskUsage) return emailDiskUsage
      const accountGitResponse = await handleGitWorkspaceRoute(req, url, method, accountToolPorts)
      if (accountGitResponse) return accountGitResponse
      const accountPackagesResponse = await handleAccountPackagesWorkspaceRoute(req, url, method, accountToolPorts)
      if (accountPackagesResponse) return accountPackagesResponse
      const swOptimizeResponse = await handleSwOptimizeWorkspaceRoute(req, url, method, accountToolPorts)
      if (swOptimizeResponse) return swOptimizeResponse
      const swApplicationsResponse = await handleSwApplicationsWorkspaceRoute(req, url, method, accountToolPorts)
      if (swApplicationsResponse) return swApplicationsResponse
      const ownerToolsResponse = await handleAccountOwnerToolsRoute(req, url, method, accountToolPorts)
      if (ownerToolsResponse) return ownerToolsResponse
      const accountRuntimeResponse = await handleAccountRuntimeWorkspaceRoute(req, url, method, accountToolPorts)
      if (accountRuntimeResponse) return accountRuntimeResponse
      const remoteDatabaseResponse = await handleDatabaseRemoteAccessWorkspaceRoute(req, url, method, accountToolPorts)
      if (remoteDatabaseResponse) return remoteDatabaseResponse
      const ftpWorkspaceResponse = await handleFtpWorkspaceRoute(req, url, method, { ...accountToolPorts, assertRoot, emitAudit, triggerReconcile })
      if (ftpWorkspaceResponse) return ftpWorkspaceResponse
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
      const accountEdgeResponse = await handleAccountEdgeRoute(req, url, method, { store: deps.store, requireCaller, emitAudit, triggerReconcile }); if (accountEdgeResponse) return accountEdgeResponse
      const nginxProxyResponse = await handleNginxProxyRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit, triggerReconcile }); if (nginxProxyResponse) return nginxProxyResponse
      const leechResponse = await handleLeechProtectionRoute(req, url, method, { store: deps.store, requireCaller, emitAudit, readAgent: deps.agentApp && deps.agentToken ? readNativeWorkspace : null }); if (leechResponse) return leechResponse
      if (pathname.startsWith('/api/account/sec/cloudflare')) {
        const response = await handleSecCloudflareRoute(req, url, method, { requireCaller, assertRoot, emitAudit, store: deps.store, fetch: globalThis.fetch })
        if (response) return response
      }
      const logTools = await handleWhmLogToolsRoute(req, url, method, { requireCaller, assertRoot, emitAudit, readHost: (caller, path) => readNativeWorkspace(caller, path, undefined, false, 'GET'), callAgent: (caller, path) => callAgent(path, { caller }) })
      if (logTools) return logTools
      const accountLogsResponse = await handleAccountLogsRoute(req, url, method, { ...accountToolPorts, assertRoot, emitAudit,
        callAgent: (caller, path) => callAgent(path, { caller, method: 'GET' }) })
      if (accountLogsResponse) return accountLogsResponse
      const webStatsPorts = { ...accountToolPorts, assertRoot, emitAudit, toolQualified: async (id: string) => (await loadCatalog()).some(tool => tool.id === id && tool.status === 'verified' && tool.delivery.status === 'verified') }
      const webStatsResponse = await handleWebStatsWorkspaceRoute(req, url, method, webStatsPorts) ?? await handleWebStatsServerRoute(req, url, method, webStatsPorts)
      if (webStatsResponse) return webStatsResponse
      const accountVirusScanResponse = await handleAccountVirusScanRoute(req, url, method, accountToolPorts)
      if (accountVirusScanResponse) return accountVirusScanResponse
      const networkToolsResponse = await handleNetworkToolsRoute(req, url, method, { ...accountToolPorts, networkToolsGate })
      if (networkToolsResponse) return networkToolsResponse
      const accountDatabaseInsightsResponse = await handleAccountDatabaseInsightsRoute(req, url, method, accountToolPorts)
      if (accountDatabaseInsightsResponse) return accountDatabaseInsightsResponse
      const siteHealthResponse = await handleSiteHealthRoute(req, url, method, { store: deps.store, requireCaller, dns: siteHealthDns, probe: probeHtaccessTarget })
      if (siteHealthResponse) return siteHealthResponse
      const davWorkspaceResponse = await handleDavWorkspaceRoute(req, url, method, { store: deps.store, requireCaller })
      if (davWorkspaceResponse) return davWorkspaceResponse
      if (pathname === '/api/server/composer' || pathname.startsWith('/api/server/composer/jobs/')) {
        const response = await handleComposerWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          callHost: (caller, path, body, mutation = false) => readNativeWorkspace(caller, path, body, mutation, 'POST', null, true) })
        if (response) return response
      }
      if (pathname === '/api/server/default-index' || pathname.startsWith('/api/server/default-index/')) {
        const initial = await requireCaller(req)
        await assertRoot(initial, 'server.default_index.workspace')
        const available = Boolean(deps.agentApp && deps.agentToken)
        const catalog = await loadCatalog()
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
        const catalog = await loadCatalog()
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
        const metering = await handleMeteringWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          readHost: (caller, path) => readNativeWorkspace(caller, path) })
        if (metering) return metering
        const response = await handleMonitoringWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          readHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined),
          listHostMetrics: options => listMetricsHistory(deps.db, { scope: 'host', ...options }),
        })
        if (response) return response
      }
      if (pathname === '/api/server/upgrade' || pathname.startsWith('/api/server/upgrade/')) {
        const releasePackages = await handleReleasePackagesWorkspaceRoute(req, url, method, { requireCaller, assertRoot, readHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) })
        if (releasePackages) return releasePackages
        const response = await handleUpgradeWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit, callAgent })
        if (response) return response
      }
      if (pathname === '/api/server/ftp-log/activity') {
        const response = await handleFtpLogWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          readActivity: (caller, query) => readNativeWorkspace(caller, '/host/ftp/log?' + query) })
        if (response) return response
      }
      if (pathname === '/api/server/mail-log/delivery' || pathname === '/api/server/mail-log/monitor') {
        const response = await handleMailLogWorkspaceRoute(req, url, method, {
          requireCaller,
          assertRoot,
          listResellerDomains: async resellerCaller => {
            const accounts = await deps.store.listAccounts({ ownerId: resellerCaller.principal.id })
            const owned = new Set(accounts.map(account => account.id))
            return (await deps.store.listDomains()).filter(domain => owned.has(domain.accountId)).map(domain => domain.name)
          },
          readServerLog: async (caller, query) => {
            const agentCaller: AuthenticatedCaller = caller.principal.kind === 'reseller'
              ? await (async () => {
                  const rootPrincipal = await findPrincipalByUsername(deps.db, 'root')
                  return rootPrincipal
                    ? { ...caller, principalRecord: rootPrincipal, principal: { kind: 'root' as const, id: rootPrincipal.id, username: rootPrincipal.username } }
                    : caller
                })()
              : caller
            return readNativeWorkspace(agentCaller, '/host/mail/log?' + query)
          },
        })
        if (response) return response
      }
      if (pathname === '/api/auth/api-tokens' || pathname.startsWith('/api/auth/api-tokens/')) {
        const response = await handleOwnerApiTokensWorkspaceRoute(req, url, method, {
          db: deps.db, store: deps.store, entryPoint, requireCaller, emitAudit,
          authorizeSession: async (tx, request) => {
            // Only this admitted runner reads the original session and principal after any DB queue.
            // Team/handoff resolvers are deliberately absent: neither may become an original owner.
            const current = await authenticateRequest(tx, request, { serverSecret, clientIp: extractClientIp(request), entryPoint,
              touchSession: false, mfaRuntimePolicy, sessionLimits: sessionLimits(await signInPolicy()) })
            if (!current) return fail('FORBIDDEN', 'the original owner session is no longer authenticated', { stateChanged: false })
            assertAuthPersonalOwner(current, entryPoint)
            if (request.method !== 'GET' && !current.csrfValid) return fail('FORBIDDEN', 'the original owner CSRF proof changed', { stateChanged: false })
            await assertRequestAuthorized(deps.store, current, request)
            if (!panelOfflineAdmits(new URL(request.url).pathname, current.principal.kind) && (await panelSettingsFile(deps.store).current()).offlineMode) {
              return fail('SERVICE_UNAVAILABLE', 'the panel is offline for maintenance', { reason: 'panel_offline', stateChanged: false })
            }
            return current
          },
        })
        if (response) return response
      }
      const authorizeTokenIssuance = async (tx: Db, caller: AuthenticatedCaller): Promise<void> => {
        if (caller.principal.kind !== 'root' || caller.apiTokenId !== null || !caller.sessionId || !caller.sessionToken
          || caller.team || caller.impersonator || (entryPoint !== undefined && entryPoint !== 'xwhm')) {
          return fail('FORBIDDEN', 'token issuance requires the original interactive root session', { stateChanged: false })
        }
        await assertPrivilegedSessionAuthorization({
          reference: { kind: 'session', principalId: caller.principal.id, sessionId: caller.sessionId,
            tokenHash: sessionTokenHash(caller.sessionToken, entryPoint), entryPoint: entryPoint ?? null },
          actor: caller.principal, policy: mfaRuntimePolicy,
          ports: { principal: id => getPrincipal(tx, id), session: tokenHash => findActiveSessionByTokenHash(tx, tokenHash) },
        })
      }
      if (pathname === '/api/server/panel/api-tokens' || pathname.startsWith('/api/server/panel/api-tokens/')) {
        const response = await handlePanelTokensWorkspaceRoute(req, url, method, { db: deps.db, requireCaller, assertRoot, emitAudit, authorizeIssuance: authorizeTokenIssuance })
        if (response) return response
      }
      if (/^\/api\/(?:server|account)\/announcements(?:\/|$)/.test(pathname)) {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const emailResponse = pathname === '/api/server/announcements/email' ? await handleEmailAllUsersRoute(req, url, method, { requireCaller, assertRoot, emitAudit, readJsonBody, listAccounts: () => deps.store.listAccounts(), email: (await alertTransports(deps.store)).email }) : null
        if (emailResponse) return emailResponse
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
              readSaved: () => extended.readOrDefault<unknown>('accounts/templates.json', null), writeSaved: (value, writer) => extended.write('accounts/templates.json', value, { templateWriter: writer }) })
          : await handleAccountEnhancementsRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit,
              readSaved: () => extended.readOrDefault<unknown>('plans/enhancements.json', null), writeSaved: value => extended.write('plans/enhancements.json', value) })
        if (response) return response
      }
      if (pathname === '/api/admin/favorites' || pathname.startsWith('/api/admin/notifications')) {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const response = await handleWhmHomeRoute(req, url, method, { requireCaller, readJsonBody, read: path => extended.readOrDefault<unknown>(path, null), write: (path, value) => extended.write(path, value),
          failedJobs: () => listJobs(deps.db, { status: 'failed', limit: 100 }), failedAudit: () => listAudit(deps.db, { outcome: 'failed', limit: 100 }),
          backupRuns: async caller => (await readNativeWorkspace<{ runs?: { id: string; startedAt: string; finishedAt: string | null; state: string }[] }>(caller, '/host/backups/runs')).runs ?? [],
          actionLabel: (action, request) => auditActionLabel(action, requestLocale(new URL(request.url), request)) })
        if (response) return response
      }
      if (pathname === '/api/server/panel/notifications' || pathname.startsWith('/api/server/panel/notifications/')) {
        const response = await handlePanelNotificationsRoute(req, url, method, { requireCaller, assertRoot, emitAudit, ...alertStateFiles(deps.store), transports: await alertTransports(deps.store) })
        if (response) return response
      }
      const openPersonalAuthority = async (request: Request): Promise<UiPreferenceAuthority> => {
        const caller = await requireCaller(request)
        const surface = entryPoint ?? (isMailboxPrincipalUsername(caller.principal.username) ? 'xmail' : caller.principal.kind === 'user' ? 'xpanel' : 'xwhm')
        if (surface !== 'xmail') return { caller, surface }
        const record = await authorizeMailboxSessionBinding(deps.db, deps.store, caller)
        const current = await captureMailboxMetadataAuthority(deps.store, record.mailbox)
        if (current.accountId !== record.accountId || current.serviceUserId !== record.serviceUserId) return fail('FORBIDDEN', 'mailbox lifetime changed; sign in again', { stateChanged: false })
        return { caller, surface, mailbox: { ...current, sessionId: record.sessionId } }
      }
      const teamAuditResponse = await handleTeamAuditRoute(req, url, method, { store: deps.store, requireCaller, db: deps.db })
      if (teamAuditResponse) return teamAuditResponse
      const uiPreferencesResponse = await handleUiPreferencesRoute(req, url, method, { store: deps.store, emitAudit,
        choices: registeredUiThemeIds(), defaultUiTheme: resolveUiTheme().id, open: openPersonalAuthority })
      if (uiPreferencesResponse) return uiPreferencesResponse
      const personalPreferencesResponse = await handlePersonalPreferencesRoute(req, url, method, { store: deps.store, emitAudit, open: openPersonalAuthority, locales: () => localePolicy().offered })
      if (personalPreferencesResponse) return personalPreferencesResponse
      const adminPreferencesResponse = await handleAdminPreferencesRoute(req, url, method, { store: deps.store, requireCaller, emitAudit })
      if (adminPreferencesResponse) return adminPreferencesResponse
      const signInPolicyResponse = await handleSignInPolicyRoute(req, url, method, { store: deps.store, db: deps.db, requireCaller, assertRoot, emitAudit,
        clientIp: extractClientIp, applied: policy => usePasswordStrengthPolicy(policy.passwordStrength) })
      if (signInPolicyResponse) return signInPolicyResponse
      const tweakSettingsResponse = await handleTweakSettingsRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit })
      if (tweakSettingsResponse) return tweakSettingsResponse
      const panelConfigResponse = await handlePanelSettingsRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit })
        ?? await handlePanelBrandingRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit })
        ?? await handleWhmcsRoute(req, url, method, whmcsHelpers)
        ?? await handlePanelLanguagesRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit })
      if (panelConfigResponse) return panelConfigResponse
      const extendResponse = await handleExtendRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit, ...extendHost })
      if (extendResponse) return extendResponse
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
        const response = await handleSwContainersWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit, callHost, streamHost: (caller, path) => callAgent(path, { caller }) })
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
        const dbAdmin = await handleWhmDbAdminRoute(req, url, method, { requireCaller, assertRoot, callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, true), readHost: (caller, path) => readNativeWorkspace(caller, path, undefined, false, 'GET') })
        if (dbAdmin) return dbAdmin
        const dbTools = await handleWhmDbToolsRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit, triggerReconcile, callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, true), readHost: (caller, path) => readNativeWorkspace(caller, path, undefined, false, 'GET') })
        if (dbTools) return dbTools
        const dbServices = await handleWhmDbServicesRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit, triggerReconcile, callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, true), readHost: (caller, path) => readNativeWorkspace(caller, path, undefined, false, 'GET') })
        if (dbServices) return dbServices
        const response = await handleWhmDatabasesWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          readSaved: () => deps.store.readSnapshot(),
          readHost: (caller, path) => readNativeWorkspace(caller, path, undefined, false, 'GET'),
          killOnHost: (caller, body) => readNativeWorkspace(caller, '/host/databases/processes/kill', body, true),
        })
        if (response) return response
      }
      if (pathname === '/api/server/file-sharing/links' || pathname.startsWith('/api/server/file-sharing/links/')) {
        const response = await handleFileShareLinksRoute(req, url, method, { requireCaller, assertRoot, emitAudit, file: shareLinksFile, inspect: (caller, path) => readNativeWorkspace(caller, '/host/file-sharing/links/inspect', { path }) })
        if (response) return response
      }
      if (pathname === '/api/server/file-sharing' || pathname === '/api/server/file-sharing/apply') {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const response = await handleFileSharingWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          readSaved: () => extended.readOrDefault<unknown>('file-sharing/shares.json', null),
          writeSaved: value => extended.write('file-sharing/shares.json', value),
          callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined, body === undefined ? 'GET' : 'POST'), reconcile: caller => triggerReconcile(caller) })
        if (response) return response
      }
      if (pathname === '/api/account/terminal') {
        const response = await handleAccountTerminalRoute(req, url, method, { requireCaller, store: deps.store, readExecution: readTerminalExecution, tickets: terminalTickets, registry: terminalRegistry })
        if (response) return response
      }
      if (pathname === '/api/server/terminal') {
        const ip = extractClientIp(req) ?? '127.0.0.1'
        const response = await handleTerminalWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit,
          readExecution: readTerminalExecution, tickets: terminalTickets, registry: terminalRegistry,
          activeAccount: async username => { const account = await deps.store.getAccountByUsername(username); return account?.status === 'active' ? account : null },
          secondFactorEnrolled: caller => mfaRuntimePolicy.mode !== 'disabled' && caller.principalRecord.totpEnabled && Boolean(caller.principalRecord.totpSecretEnc),
          verifySecondFactor: async (caller, code) => {
            const sealed = caller.principalRecord.totpSecretEnc
            if (!sealed) return false
            const step = verifyTotpStep(unsealTotpSecret(sealed, serverSecret), code)
            return step !== null && await consumeTotpStep(deps.db, caller.principal.id, step, sealed)
          },
          verifyPassword: (caller, password) => verifyPasswordArgon2id(password, caller.principalRecord.passwordHash),
          checkLockout: async caller => { const lockout = await activeLockout(caller.principal.username, ip); return lockout ? lockout.lockedUntil : null },
          recordFailure: caller => recordFailedLoginAndMaybeLock(caller.principal.username, ip, 'invalid_terminal_reauthentication', caller.principal.id) })
        if (response) return response
      }
      if (/^\/api\/server\/(?:nodes|cluster)(?:\/|$)/.test(pathname)) {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir), guards = { requireCaller, assertRoot, emitAudit, link: nodeLink }
        const response = await handleNodesWorkspaceRoute(req, url, method, { ...guards, db: deps.db, authorizeIssuance: authorizeTokenIssuance,
          readHostname: async () => { const wizard = await extended.readOrDefault<{ hostname?: unknown } | null>('setup-wizard.json', null); return wizard && typeof wizard.hostname === 'string' ? wizard.hostname : null } })
          ?? await handleClusterRoute(req, url, method, { ...guards, store: deps.store })
          ?? await handleLiveSourceRoute(req, url, method, { ...guards, store: deps.store, setSuspension: setAccountSuspensionAs,
            applyAccount: async (caller, account) => applyAccountConfiguration(caller, account, 'update', await deps.store.getRevision()),
            drainMail: (caller, domains) => readNativeWorkspace(caller, '/host/mail/queue/drain', { domains }, true) })
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
          sender: (await alertTransports(deps.store)).webhook })
        if (response) return response
      }
      if (pathname.startsWith('/api/server/updates/')) {
        const response = await handleSystemUpdatesWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) })
        if (response) return response
      }
      if (pathname.startsWith('/api/accounts/repair/')) {
        const response = await handleAccountRepairWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit, callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, path.endsWith('/run')), rerender: caller => triggerReconcile(caller, { force: true }) })
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
          readSafety: async (request, safetyCaller) => {
            const addresses = new Set<string>(['127.0.0.1', '::1'])
            const addValidAddress = (raw: string): void => {
              const clean = raw.split('%')[0]!.trim()
              if (clean && parseIp(clean)) addresses.add(clean)
            }
            try {
              for (const entries of Object.values(networkInterfaces())) {
                for (const entry of entries ?? []) if (entry?.address) addValidAddress(entry.address)
              }
            } catch { /* systemd RestrictAddressFamilies blocks netlink getifaddrs in xpanel-api.service */ }
            const rawPool = await opsReadJsonIfExists<unknown>(opsJoin(deps.store.rootDir, 'ip-pool.json')).catch(() => null)
            const poolEntries = Array.isArray(rawPool)
              ? rawPool
              : rawPool && typeof rawPool === 'object' && Array.isArray((rawPool as { ips?: unknown }).ips)
                ? (rawPool as { ips: unknown[] }).ips
                : []
            for (const item of poolEntries) {
              const addr = item && typeof item === 'object' ? (item as { address?: unknown }).address : undefined
              if (typeof addr === 'string') addValidAddress(addr)
            }
            if (safetyCaller && deps.agentApp && deps.agentToken) {
              try {
                const hostReply = await callAgent('/host/addresses', { caller: safetyCaller })
                if (hostReply.ok) {
                  const payload = await hostReply.json() as { addresses?: unknown }
                  if (Array.isArray(payload.addresses)) {
                    for (const item of payload.addresses) if (typeof item === 'string' && item.length > 0) addValidAddress(item)
                  }
                }
              } catch { /* ipPool and loopback remain populated when the agent cannot report interfaces */ }
            }
            return { localAddresses: [...addresses], managementClient: extractClientIp(request) }
          },
          readHost: (caller, path, body, managementClient) => readNativeWorkspace(caller, path, body, body !== undefined, 'POST', managementClient ?? null),
        })
        if (response) return response
      }
      if (PANEL_TOOL_ROUTE.test(pathname)) {
        const response = await handlePanelToolsRoute(req, url, method, { store: deps.store, db: deps.db, requireCaller, assertRoot, emitAudit, clientIp: extractClientIp, reporter: errorReporter, dispatchRead: (selected: Request) => fetchInner(selected, context),
          apiShellEnabled: async () => await tweakValue(deps.store, 'security.apiShell') !== false, reconcile: caller => triggerReconcile(caller),
          callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined, 'POST', null, true), streamHost: (caller, path) => callAgent(path, { caller }) })
        if (response) return response
      }
      if (['/api/server/panel/developer', '/api/server/panel/integrations', '/api/account/developer'].includes(pathname)) {
        const ports = { store: deps.store, requireCaller, assertRoot, emitAudit, dispatchRead: (selected: Request) => fetchInner(selected, context),
          apiShellEnabled: async () => await tweakValue(deps.store, 'security.apiShell') !== false }
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
      if (pathname.startsWith('/api/server/notification-templates') || pathname.startsWith('/api/server/mail/marketing') || pathname.startsWith('/api/server/mail/outbound/') || pathname === '/api/server/ssl/autossl/run') {
        const response = await handleMailCertRoutes(req, url, method, { requireCaller, assertRoot, emitAudit, store: deps.store, publicOrigin: publicOrigin ?? null, call: deps.agentApp && deps.agentToken ? caller => (path, options) => callAgent(path, { ...options, caller }) : null })
        if (response) return response
      }
      if (pathname.startsWith('/api/server/panel-access')) { const response = await handlePanelAccessRoute(req, url, method, { ...secHelpers(), db: deps.db, serverSecret, ...(publicOrigin ? { publicOrigin } : {}), secureCookies: useSecureCookies, ...(deps.agentApp && deps.agentToken ? { callHostRelay: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined, 'POST', null, true) } : {}) }); if (response) return response }
      if (pathname.startsWith('/api/server/sec/') || pathname.startsWith('/api/server/services/')) {
        const svcResponse = await handleSvcWorkspaceRoute(req, url, method, secHelpers())
        if (svcResponse) return svcResponse
        const response = await handleSecWorkspaceRoute(req, url, method, secHelpers())
        if (response) return response
      }
      if (pathname.startsWith('/api/server/ssh') || pathname.startsWith('/api/server/security-tools/isolation/')) {
        const response = await handleSshWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit, store: deps.store, clientIp: extractClientIp, reconcile: caller => triggerReconcile(caller), readChannels: alertStateFiles(deps.store).readChannels,
          writeAlarmState: (file, value) => opsAtomicWriteJson(opsJoin(deps.store.rootDir, 'extended', file), value),
          ...(deps.agentApp && deps.agentToken ? { callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}) })
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
          // Support contacts come from the Branding & themes page.
          readBranding: async () => { const { supportUrl, supportEmail } = await panelBrandingFile(deps.store).current(); return { supportUrl, supportEmail } },
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
      if (pathname === '/api/server/db-profiles' || pathname.startsWith('/api/server/db-profiles/')) {
        const response = await handleDbProfilesWorkspaceRoute(req, url, method, { requireCaller, assertRoot, ...(deps.agentApp && deps.agentToken ? { callHost: (caller: AuthenticatedCaller, path: string, body?: unknown) => readNativeWorkspace(caller, path, body, body !== undefined, 'POST', null, true) } : {}) })
        if (response) return response
      }
      if (pathname === '/api/server/dns-cluster' || pathname.startsWith('/api/server/dns-cluster/')) {
        const response = await handleDnsClusterWorkspaceRoute(req, url, method, { requireCaller, assertRoot, emitAudit, store: deps.store, ...(deps.agentApp && deps.agentToken ? { callHost: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => readNativeWorkspace(caller, path, body, body !== undefined, 'POST', null, true) } : {}) })
        if (response) return response
      }
      if (pathname === '/api/server/remote-service-ips') {
        const response = await handleRemoteServiceIpsRoute(req, url, method, { requireCaller, assertRoot, emitAudit, store: deps.store, reconcile: caller => triggerReconcile(caller),
          ...(deps.agentApp && deps.agentToken ? { applyDns: (caller: AuthenticatedCaller, expectedRevision: string) => readNativeWorkspace(caller, '/host/sec/dns-cluster/apply', { expectedRevision }, true) } : {}) })
        if (response) return response
      }
      if (/^\/api\/server\/(?:resolvers|domain-forwards|role-profile|service-selection|system-mail|panel-tls|maintenance-schedule|update-preferences|dns-ops)(?:\/|$)/.test(pathname)) {
        const response = await handleServerOperationsRoute(req, url, method, { requireCaller, assertRoot, emitAudit, triggerReconcile, store: deps.store, db: deps.db,
          sendToCluster: (sections, note, caller) => pushSectionsToCluster({ requireCaller, assertRoot, emitAudit, store: deps.store, link: nodeLink }, sections, note, caller),
          ...(deps.agentApp && deps.agentToken ? { callHost: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}) })
        if (response) return response
      }
      if (pathname.startsWith('/api/server/host-tools/')) {
        const hookOrigin = entryPoint === 'xpanel' ? publicOrigin : handoffTargetOrigin
        const response = await handleHostToolsRoute(req, url, method, { ...identityHelpers, triggerReconcile, ...(hookOrigin ? { hookOrigin } : {}),
          ...(deps.agentApp && deps.agentToken ? { checkDdns: () => runDdnsCycle({ store: deps.store, fetcher: globalThis.fetch, reconcile: () => ddnsRootReconcile({ db: deps.db, agentApp: deps.agentApp!, agentToken: deps.agentToken! }) }, { force: true }) } : {}) })
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
        const response = await createMailxCollectionsRoutes({ store: deps.store, serverSecret, requireCaller, assertCanAccessAccount, emitAudit, dav })(req, url, method)
        if (response) return response
      }
      if (pathname.startsWith('/api/server/mailx-config/')) {
        const response = await createMailxConfigRoutes({ store: deps.store, requireCaller, assertRoot, emitAudit,
          ...(deps.agentApp && deps.agentToken ? { callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}) })(req, url, method)
        if (response) return response
      }
      if (MAIL_REPORT_ROUTE.test(pathname)) {
        const response = await handleMailReportsWorkspaceRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit,
          ...(deps.agentApp && deps.agentToken ? { callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}) })
        if (response) return response
      }
      if (pathname.startsWith('/api/server/mailx/') || pathname === '/api/account/mailx/archive' || pathname === '/api/account/mailx/archive/retention' || pathname.startsWith('/api/account/mailx/mail-tools') || ['greylisting', 'routing', 'deliverability', 'track-delivery'].some(tool => pathname === '/api/account/mailx/' + tool)) {
        const response = await createMailxWorkspaceRoutes({ store: deps.store, requireCaller, assertRoot, assertCanAccessAccount, emitAudit, readDkimPublicMaterial,
          ...(deps.agentApp && deps.agentToken ? { callHost: (caller, path, body) => readNativeWorkspace(caller, path, body, body !== undefined) } : {}) })(req, url, method)
        if (response) return response
      }
      if (pathname.startsWith('/api/server/mail-server/')) {
        const response = await handleMailServerWorkspaceRoute(req, url, method, { requireCaller, assertRoot,
          readSaved: () => deps.store.readSnapshot(), readMailPolicy: () => readMailxSaved(deps.store.rootDir),
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
      if (pathname.startsWith('/api/server/php/manage') || pathname.startsWith('/api/server/php/exceptions') || pathname === '/api/server/php/default' || pathname === '/api/server/php/assign' || pathname === '/api/server/php/domain' || pathname === '/api/server/php/pool-defaults') {
        const readPoolDefaults = async () => {
          const raw = await readSecRaw(deps.store, 'php-fpm-defaults')
          const record = raw === null ? null : readSecRecord('php-fpm-defaults', raw)
          if (raw !== null && !record) return fail('PRECONDITION_FAILED', 'saved PHP-FPM defaults require review before reading or changing', { stateChanged: false })
          return {
            pool: record ? { ...record.policy.pool } : { ...SEC_DEFAULTS['php-fpm-defaults'].pool },
            revision: secRevision('php-fpm-defaults', raw),
            updatedAt: record?.updatedAt ?? null,
          }
        }
        const response = await handlePhpManageRoute(req, url, method, { requireCaller, assertRoot,
          agent: (caller, path, body) => callAgent(path, { caller, ...(body === undefined ? {} : { method: 'POST', body }) }),
          listDomains: async () => (await deps.store.readSnapshot()).domains,
          listAccounts: () => deps.store.listAccounts(),
          getServerSettings: () => deps.store.getServerSettings(),
          saveServerSettings: settings => deps.store.saveServerSettings(settings),
          updateDomainPhp: async (_caller, domain, php) => { await deps.store.updateDomain(domain.id, { php }) },
          workerCap: async accountId => { const account = await deps.store.getAccount(accountId); return (account ? await deps.store.getPlan(account.planId) : null)?.caps.phpWorkers ?? 'unlimited' },
          readPoolDefaults,
          savePoolDefaults: async (_caller, pool, expectedRevision) => {
            const savedRaw = await writeSecRecord(
              { store: deps.store },
              'php-fpm-defaults',
              expectedRevision,
              raw => {
                const existing = raw === null ? null : readSecRecord('php-fpm-defaults', raw)
                return { pool, ini: existing ? existing.policy.ini : structuredClone(SEC_DEFAULTS['php-fpm-defaults'].ini) }
              },
              async () => {
                const current = await requireCaller(req)
                await assertRoot(current, 'server.php.modify')
              },
            )
            const savedRecord = readSecRecord('php-fpm-defaults', savedRaw)
            return {
              pool: savedRecord ? { ...savedRecord.policy.pool } : { ...pool },
              revision: secRevision('php-fpm-defaults', savedRaw),
              updatedAt: savedRecord?.updatedAt ?? null,
            }
          },
          reconcile: caller => triggerReconcile(caller),
          audit: async (caller, action, target, detail, outcome = 'ok') => { await emitAudit({ actor: caller.principal.username, action, target, detail, outcome, principalId: caller.principal.id }) },
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
        await assertAccountFeatures(deps.store, caller, account, ['domain-htaccess'])
        const request = parseHtaccessHttpRequest(method, htaccessMatch[2], method === 'GET' ? undefined : await readJsonBody(req))
        return await executeHtaccessWorkspaceRequest({ accountId: account.id, domainId: domain.id }, request, () => callAgent('/accounts/' + account.username + '/htaccess/' + domain.id, { caller, method: 'POST', body: request }))
      }

      const webDirectivesResponse = await handleWebDirectivesRoute(req, url, method, { store: deps.store, requireCaller, assertCanAccessAccount, readJsonBody, callAgent })
      if (webDirectivesResponse) return webDirectivesResponse
      const directoryPrivacyResponse = await handleDirectoryPrivacyRoute(req, url, method, { store: deps.store, requireCaller, assertCanAccessAccount, resolveAccountParam, emitAudit,
        readAgent: deps.agentApp && deps.agentToken ? readNativeWorkspace : null })
      if (directoryPrivacyResponse) return directoryPrivacyResponse
      const dnssecResponse = await handleDnssecRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, assertCanAccessAccount, callAgent: deps.agentApp && deps.agentToken ? (path, options) => callAgent(path, options) : null })
      if (dnssecResponse) return dnssecResponse
      const zoneFileResponse = await handleDnsZoneFileRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, assertCanAccessAccount })
      if (zoneFileResponse) return zoneFileResponse
      const listAdminResponse = await handleMailingListAdminRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, assertCanAccessAccount, emitAudit, callAgent: deps.agentApp && deps.agentToken ? (path, options) => callAgent(path, options) : null })
      if (listAdminResponse) return listAdminResponse
      const listModerationResponse = await handleListModerationRoute(req, url, method, { store: deps.store, requireCaller, assertCanAccessAccount, emitAudit,
        callHost: deps.agentApp && deps.agentToken ? (caller, username, body, mutation) => readNativeWorkspace(caller, `/host/mailx/accounts/${username}/list-moderation`, body, mutation) : null,
        routing: { commit: commitRoutingRevision, apply: async (request, revision, restore) => {
          const caller = await requireCaller(request)
          return applyMailRoutingChange({ store: deps.store, db: deps.db, reconcile: () => triggerReconcile(caller), audit: reason => emitAudit({ actor: caller.principal.username, action: 'mail.routing.rolled_back', target: 'mail-routing:mail/mailing-lists.json', detail: { reason }, outcome: 'failed', principalId: caller.principal.id }) }, revision, restore)
        } } })
      if (listModerationResponse) return listModerationResponse
      const boxTrapperResponse = await handleOwnerBoxTrapperRoute(req, url, method, { store: deps.store, requireCaller, assertCanAccessAccount, emitAudit,
        callHost: deps.agentApp && deps.agentToken ? (caller, username, body, mutation) => readNativeWorkspace(caller, `/host/mailx/accounts/${username}/boxtrapper`, body, mutation) : null,
        routing: { commit: commitRoutingRevision, apply: async (request, revision, restore) => {
          const caller = await requireCaller(request)
          return applyMailRoutingChange({ store: deps.store, db: deps.db, reconcile: () => triggerReconcile(caller), audit: reason => emitAudit({ actor: caller.principal.username, action: 'mail.routing.rolled_back', target: 'mail-routing:mail/boxtrapper', detail: { reason }, outcome: 'failed', principalId: caller.principal.id }) }, revision, restore)
        } } })
      if (boxTrapperResponse) return boxTrapperResponse

      const sslStoreResponse = await handleSslStoreWorkspaceRoute(req, url, method, sslStorePorts)
      if (sslStoreResponse) return sslStoreResponse
      const certificateResponse = await certificateRuntimeRouter(req, url, method)
      if (certificateResponse) return certificateResponse

      const accountBulkResponse = await handleAccountBulkActionsRoute(req, url, method, { db: deps.db, requireCaller, readJsonBody, getAccount: id => deps.store.getAccount(id), assertCanAccessAccount, setSuspension: setAccountSuspensionAs, update: updateAccountAs, terminate: terminateAccountAs })
      if (accountBulkResponse) return accountBulkResponse
      const accountOperationResponse = await handleAccountCreateOperationRoute(req, url, method, { requireCaller, db: deps.db, getAccount: id => deps.store.getAccount(id),
        primaryDomain: async accountId => (await deps.store.listDomains({ accountId }))[0] ?? null, local: id => acceptedCreations.get(id) })
      if (accountOperationResponse) return accountOperationResponse
      // The owner, by name: an account can also hold mailbox principals.
      const accountOwnerPrincipal = async (account: Account) => { const owner = await findPrincipalByUsername(deps.db, account.username); return owner?.kind === 'user' && owner.accountId === account.id ? owner : null }
      const accountAdminResponse = await handleAccountAdminRoute(req, url, method, { requireCaller, readJsonBody, getPlan: id => deps.store.getPlan(id),
        listAccounts: async caller => { if (caller.principal.kind === 'root') return deps.store.listAccounts(); const ownerId = await resolveResellerId(caller); return ownerId ? deps.store.listAccounts({ ownerId }) : [] },
        assertCanModify: (caller, account) => assertCanAccessAccount(caller, account, 'account.update', { allowUserSelf: false }),
        readForcedPassword: async account => (await accountOwnerPrincipal(account))?.forcePasswordChange ?? null,
        setForcedPassword: async (account, forced) => { const owner = await accountOwnerPrincipal(account); if (owner) await setPrincipalForcePasswordChange(deps.db, owner.id, forced) },
        audit: async (caller, account, forced) => { await emitAudit({ actor: caller.principal.username, action: forced ? 'account.password_change.forced' : 'account.password_change.cleared', target: 'account:' + account.username, outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId }) },
        rearrange: async (caller, account, root) => {
          await assertCanAccessAccount(caller, account, 'account.update', { allowUserSelf: false })
          const reply = await readNativeWorkspace<Record<string, unknown>>(caller, `/host/accounts/${account.username}/rearrange`, { root }, true)
          await emitAudit({ actor: caller.principal.username, action: 'account.rearrange.started', target: 'account:' + account.username, detail: { root }, outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
          return reply
        },
        recoverRearrange: async (caller, account) => {
          await assertCanAccessAccount(caller, account, 'account.update', { allowUserSelf: false })
          const reply = await readNativeWorkspace<{ outcome?: unknown }>(caller, `/host/accounts/${account.username}/rearrange`, {}, true, 'DELETE')
          await emitAudit({ actor: caller.principal.username, action: 'account.rearrange.recovered', target: 'account:' + account.username, detail: { outcome: reply.outcome }, outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
          return reply
        } }, async caller => ({ homeRoots: caller.principal.kind === 'root' && deps.agentApp && deps.agentToken ? await readNativeWorkspace<{ roots: unknown[] }>(caller, '/host/home-roots', undefined, false, 'GET').then(view => view.roots, () => null) : null }))
      if (accountAdminResponse) return accountAdminResponse
      if (pathname.startsWith('/api/accounts/web-templates') || pathname.startsWith('/api/accounts/skeleton')) {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const scoped = { requireCaller, readJsonBody, resellerOf: async (caller: AuthenticatedCaller) => caller.principal.kind === 'root' ? null : await resolveResellerId(caller) ?? fail('FORBIDDEN', 'reseller authorization is unavailable', { stateChanged: false }) }
        const auditFor = async (caller: AuthenticatedCaller, action: string, target: string): Promise<void> => { await emitAudit({ actor: caller.principal.username, action, target, outcome: 'ok', principalId: caller.principal.id }) }
        const response = await handleWebTemplatesRoute(req, url, method, { ...scoped, read: scope => extended.readOrDefault<unknown>(`accounts/web-templates/${scope}.json`, null), write: (scope, value) => extended.write(`accounts/web-templates/${scope}.json`, value),
          apply: caller => triggerReconcile(caller), audit: (caller, kind, action) => auditFor(caller, `server.web_template.${action}`, 'web-template:' + kind) })
          ?? await handleSkeletonRoute(req, url, method, { ...scoped, read: scope => extended.readOrDefault<unknown>(`accounts/skeletons/${scope}.json`, null), write: (scope, value) => extended.write(`accounts/skeletons/${scope}.json`, value),
            audit: (caller, action, path) => auditFor(caller, `server.skeleton.${action}`, 'skeleton:' + path) })
        if (response) return response
      }
      if (pathname === '/api/accounts/enhancements' || pathname.endsWith('/enhancements')) {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const response = await handleEnhancementAssignmentRoute(req, url, method, { store: deps.store, requireCaller, emitAudit, readSaved: () => extended.readOrDefault<unknown>('plans/enhancements.json', null), writeSaved: value => extended.write('plans/enhancements.json', value),
          resellerOf: async caller => caller.principal.kind === 'root' ? null : await resolveResellerId(caller) ?? fail('FORBIDDEN', 'reseller authorization is unavailable', { stateChanged: false }),
          assertCanModify: (caller, account) => assertCanAccessAccount(caller, account, 'account.update', { allowUserSelf: false }) })
        if (response) return response
      }
      const accountLimitsResponse = await handleAccountLimitsRoute(req, url, method, { store: deps.store, requireCaller, readJsonBody, resolveAccountParam, assertCanAccessAccount, assertRoot, resolveReseller: resolveResellerForCaller, captureAccountMutation: (caller, id, action) => captureAccountMutation(caller, id, action), requireHostAgent: requireAccountHostAgent, applyAccountConfiguration, emitAudit, execution: accountExecution,
        ...(deps.agentApp && deps.agentToken ? { readDisk: (caller: AuthenticatedCaller) => readNativeWorkspace(caller, '/host/monitoring/disk') } : {}) })
      if (accountLimitsResponse) return accountLimitsResponse

      // ---- Accounts CRUD & Lifecycle -------------------------------------------------
      if (method === 'GET' && pathname === '/api/accounts') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'root') {
          return jsonResponse({ accounts: await readRecoveredAccountProjection(() => deps.store.listAccounts()) })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          return jsonResponse({
            accounts: resellerId ? await readRecoveredAccountProjection(() => deps.store.listAccounts({ ownerId: resellerId })) : [],
          })
        }
        const accountId = caller.principal.accountId
        const acc = await readRecoveredAccountProjection(() => deps.store.getAccount(accountId))
        return jsonResponse({ accounts: acc ? [acc] : [] })
      }

      if (pathname === '/api/account/preferences') {
        const caller = await requireCaller(req)
        if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'hosting account owner access is required')
        if (new URL(req.url).searchParams.size > 0) return fail('VALIDATION', 'account preferences do not accept query selectors')
        const accountId = caller.principal.accountId
        const target = await readRecoveredAccountProjection(() => deps.store.getAccount(accountId))
        if (!target || target.status !== 'active') return fail('FORBIDDEN', 'active hosting account owner access is required')
        await assertCanAccessAccount(caller, target, 'account.contact.read')
        await assertAccountFeatures(deps.store, caller, target, ['account-preferences'])
        let account = target
        if (method === 'PATCH') {
          const body = await readJsonBody<Record<string, unknown>>(req)
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['contactEmail', 'expectedRevision', 'currentPassword'].includes(key))
            || !Object.hasOwn(body, 'contactEmail') || !Object.hasOwn(body, 'expectedRevision') || typeof body.expectedRevision !== 'string') {
            return fail('VALIDATION', 'contactEmail, expectedRevision and currentPassword are required; other settings are not accepted')
          }
          if (body.contactEmail !== target.contactEmail) {
            if (typeof body.currentPassword !== 'string' || !body.currentPassword) return fail('VALIDATION', 'the account password is required to change the contact email')
            const ip = extractClientIp(req) ?? '127.0.0.1'
            const lockout = await activeLockout(caller.principal.username, ip)
            if (lockout) return fail('FORBIDDEN', 'too many failed authentication attempts', { lockedOut: true, lockedUntil: lockout.lockedUntil })
            if (!await verifyPasswordArgon2id(body.currentPassword, caller.principalRecord.passwordHash)) {
              await recordFailedLoginAndMaybeLock(caller.principal.username, ip, 'invalid_contact_change_reauthentication', caller.principal.id)
              return fail('UNAUTHENTICATED', 'the account password is incorrect')
            }
          }
          account = await updateContactMetadata(req, caller, target, body.contactEmail, body.expectedRevision, true)
        } else if (method !== 'GET') return fail('FORBIDDEN', 'unsupported account preferences method')
        return jsonResponse({ ...(method === 'PATCH' && { ok: true, stateChanged: true }), context: { accountId: account.id },
          preferences: { contactEmail: account.contactEmail }, revision: accountContactRevision(account) })
      }

      if (method === 'POST' && pathname === '/api/accounts') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user') return fail('FORBIDDEN', 'user accounts cannot create hosting accounts')
        const body = await readJsonBody<CreateAccountBody>(req)
        let reference: ProvisioningAuthorizationReference
        if (caller.apiTokenId) {
          const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization')?.trim() ?? '')
          if (!bearer) return fail('UNAUTHENTICATED', 'the account creation credential is unavailable', { stateChanged: false })
          reference = { kind: 'api-token', principalId: caller.principal.id, tokenId: caller.apiTokenId,
            tokenHash: sha256Hex(bearer[1]!), clientIp: extractClientIp(req), scope: 'accounts:write' }
        } else if (caller.sessionId && caller.sessionToken && !caller.impersonator && (entryPoint === undefined || entryPoint === 'xwhm')) {
          reference = { kind: 'session', principalId: caller.principal.id, sessionId: caller.sessionId,
            tokenHash: sessionTokenHash(caller.sessionToken, entryPoint), entryPoint: entryPoint ?? null }
        } else return fail('FORBIDDEN', 'a direct privileged account creation credential is required', { stateChanged: false })
        const requestKey = req.headers.get('idempotency-key')
        // Refusals answer here. Once the host step starts the client gets the operation to poll: the job runs to its
        // recorded end on the server whether or not this request stays open.
        let hostStep: (operation: { job: DurableJobRecord; account: Account }) => void = () => {}
        const started = new Promise<{ job: DurableJobRecord; account: Account }>(resolve => { hostStep = resolve })
        const creation = createAccountAs(caller, body, { reference: Object.freeze(reference), reauthenticate: () => requireCaller(req),
          ...(requestKey !== null && { idempotencyKey: requestKey }), onHostStep: operation => hostStep(operation) })
        const first = await Promise.race([creation.then(result => ({ result })), started.then(operation => ({ operation }))])
        if ('result' in first) return jsonResponse(first.result, 201)
        const { job, account } = first.operation
        acceptedCreations.set(job.id, null)
        void creation.then(result => ({ result }), async error => ({ problem: await problemResponse(error, pathname, method).json() as unknown }))
          .then(outcome => settleCreation(job.id, outcome))
        // Informational only: the creation is accepted either way, and the operation read names the domain later.
        const [primaryDomain] = await deps.store.listDomains({ accountId: account.id }).catch(() => [])
        return jsonResponse(accountCreateOperationView(job, account, primaryDomain ?? null, null), 202, { location: `/api/accounts/operations/${job.id}` })
      }

      const accountSuspendMatch = /^\/api\/accounts\/([^/]+)\/(suspend|unsuspend)$/.exec(pathname)
      if (method === 'POST' && accountSuspendMatch) {
        const caller = await requireCaller(req)
        const target = await resolveAccountParam(accountSuspendMatch[1]!)
        const verb = accountSuspendMatch[2]!
        await assertCanAccessAccount(caller, target, 'account.' + verb, { allowUserSelf: false })
        const body = await readJsonBody<{ reason?: string; lock?: boolean }>(req)
        if (Object.keys(body).some(key => key !== 'reason' && key !== 'lock')) return fail('VALIDATION', 'a suspension accepts reason and lock', { stateChanged: false })
        return jsonResponse(await setAccountSuspensionAs(caller, target, verb as 'suspend' | 'unsuspend', body.reason, body.lock))
      }

      const accountItemMatch = /^\/api\/accounts\/([^/]+)$/.exec(pathname)
      if (accountItemMatch) {
        const caller = await requireCaller(req)
        const target = method === 'GET'
          ? await readRecoveredAccountProjection(() => resolveAccountParam(accountItemMatch[1]!))
          : await resolveAccountParam(accountItemMatch[1]!)
        if (method === 'GET') {
          await assertCanAccessAccount(caller, target, 'account.read')
          return jsonResponse({ account: target, domains: await deps.store.listDomains({ accountId: target.id }) })
        }
        if (method === 'PATCH') {
          await assertCanAccessAccount(caller, target, 'account.update', { allowUserSelf: false })
          const patch = await readJsonBody<{ planId?: Id; ownerId?: Id | null; contactEmail?: string; shell?: 'none' | 'jailed' }>(req)
          if (isPackageLimitPatch(patch)) return jsonResponse(await changeAccountPackageLimit(target, patch as Record<string, unknown>, { store: deps.store, principal: caller.principal, reconcileAll: () => triggerReconcile(caller),
            changePlan: planId => updateAccountAs(caller, target, { planId }), saveLimits: limits => saveAccountLimits(caller, target, limits, { store: deps.store, resolveReseller: resolveResellerForCaller, captureAccountMutation: (actor, id, action) => captureAccountMutation(actor, id, action), requireHostAgent: requireAccountHostAgent, applyAccountConfiguration, emitAudit, execution: accountExecution }),
            assertUnlimitedAllowed: async () => { if (caller.principal.kind === 'reseller') assertAcl(caller.principal, await resolveResellerForCaller(caller), 'allow-unlimited-plans') },
            audit: (action, plan) => emitAudit({ actor: caller.principal.username, action, target: `plan:${plan.id}`, detail: { name: plan.name, account: target.username }, outcome: 'ok', principalId: caller.principal.id }) }))
          if (Object.keys(patch).some(key => !['planId', 'ownerId', 'contactEmail', 'shell'].includes(key))) return fail('VALIDATION', "unsupported account setting; addresses change through POST /api/accounts/:id/ip")
          const metadataOnly = Object.keys(patch).length === 1 && Object.hasOwn(patch, 'contactEmail')
          if (metadataOnly) {
            const updated = await updateContactMetadata(req, caller, target, patch.contactEmail, accountContactRevision(target), false)
            return jsonResponse({ account: updated, stateChanged: true })
          }
          return jsonResponse(await updateAccountAs(caller, target, patch))
        }
        if (method === 'DELETE') {
          await assertCanAccessAccount(caller, target, 'account.delete', { allowUserSelf: false })
          const body = await readJsonBody<{ confirmUsername?: unknown }>(req)
          if (Object.keys(body).some(key => key !== 'confirmUsername') || typeof body.confirmUsername !== 'string' || body.confirmUsername !== target.username) {
            return fail('VALIDATION', 'confirmation must match the account username')
          }
          return jsonResponse(await terminateAccountAs(caller, target, body.confirmUsername))
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
      if (pathname.startsWith('/api/ips/') || /^\/api\/accounts\/[^/]+\/(?:ip|ipv6)$/.test(pathname)) {
        const response = await handleIpNetworkRoute(req, url, method, { requireCaller, assertRoot, emitAudit, resolveAccountParam, store: deps.store,
          reconcile: caller => triggerReconcile(caller),
          ...(deps.agentApp && deps.agentToken ? { readNetwork: (caller: AuthenticatedCaller) => readNativeWorkspace(caller, '/host/server/network') } : {}) })
        if (response) return response
      }
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

      const reverseProxyResponse = await handleReverseProxyRoute(req, url, method, { store: deps.store, requireCaller, assertCanAccessAccount,
        readJsonBody: request => readJsonBody<Record<string, unknown>>(request), mutateDomainWorkspace,
        readAllowedRemoteHosts: async () => (await panelSettingsFile(deps.store).current()).reverseProxyAllowedHosts })
      if (reverseProxyResponse) return reverseProxyResponse

      const forceHttpsResponse = await handleForceHttpsRoute(req, url, method, { requireCaller, readJsonBody, getDomain: id => deps.store.getDomain(id), getAccount: id => deps.store.getAccount(id),
        listCertificates: async account => (await deps.store.listCertificates()).filter(item => item.accountId === null || item.accountId === account.id),
        assertCanModify: async (caller, account) => { await assertCanAccessAccount(caller, account, 'domain.modify'); await assertAccountFeatures(deps.store, caller, account, ['domains', 'force-https-redirect']) },
        mutate: (request, caller, account, expected, change) => mutateDomainWorkspace(request, caller, account, expected, 'domain.updated', change), setForceHttps: (accountId, ids, enabled, options) => deps.store.setDomainsForceHttps(accountId, ids, enabled, options) })
      if (forceHttpsResponse) return forceHttpsResponse
      const sitePorts = { store: deps.store, requireCaller, assertCanAccessAccount, assertFeatures: (caller: AuthenticatedCaller, account: Account, features: readonly string[]) => assertAccountFeatures(deps.store, caller, account, [...features]), readJsonBody: (request: Request) => readJsonBody<Record<string, unknown>>(request), readAgent: deps.agentApp && deps.agentToken ? readNativeWorkspace : null, mutateDomainWorkspace }
      const siteSettingsResponse = await handleSiteSettingsRoute(req, url, method, sitePorts) ?? await handleDomainBulkRoute(req, url, method, sitePorts)
      if (siteSettingsResponse) return siteSettingsResponse
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
          if (url.searchParams.size || Object.keys(body).some(key => !['name', 'kind', 'parentId', 'docRoot', 'siteType', 'expectedRevision', 'autoDns', ...(!self ? ['accountId'] : [])].includes(key))) return fail('VALIDATION', 'unsupported domain workspace fields', { stateChanged: false })
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
        const effectiveKind = body.kind ?? 'addon'
        const alias = effectiveKind === 'alias' ? parent : undefined
        const newDomainPhp = (alias ? (guarded ? alias.php : body.php ?? alias.php) : body.php) ?? primaryDomain?.php ?? await serverDefaultPhp()
        const serverSettings = await deps.store.getServerSettings()
        const domainTweaks = await tweakSettingsFile(deps.store).current()
        assertDomainTweaks({ values: domainTweaks, privileged: caller.principal.kind === 'root', name, accountId: account.id, home: account.home, docRoot: guarded && alias ? undefined : body.docRoot,
          ...(caller.principal.kind !== 'root' && (domainTweaks['domains.allowRemote'] === false || domainTweaks['domains.allowUnregistered'] === false) ? { resolution: await observeDomainResolution(name, [account.ipv4, ...(await deps.store.readSnapshot()).ipPool?.map(ip => ip.address) ?? []]) } : {}),
          defaultDocRoot: `${account.home}/domains/${name}/public_html`, hostname: serverSettings?.hostname ?? null, others: await deps.store.listDomains() })
        const defaultZone = (effectiveKind === 'addon' || effectiveKind === 'alias') && (serverSettings?.nameservers?.length ?? 0) > 0 && !(await deps.store.getDnsZone(name))
          ? (() => {
              const serial = Number(new Date().toISOString().slice(0, 10).replaceAll('-', '') + '01')
              const records = renderServices.defaultZoneRecords(name, {
                ipv4: body.ipv4 ?? account.ipv4,
                ipv6: body.ipv6 ?? account.ipv6 ?? null,
                nameservers: [...serverSettings!.nameservers],
                mailHost: `mail.${name}`,
                adminEmail: account.contactEmail,
                serial,
                ...zoneDefaultsFromTweaks(domainTweaks),
              }).filter(r => r.type !== 'SOA').map(r => ({ id: randomUUID(), zone: name, name: r.name, type: r.type as Exclude<renderServices.ZoneRecordType, 'SOA'>, ttl: r.ttl, content: r.content, priority: r.priority }))
              return { id: randomUUID(), name, accountId: account.id, serial, records }
            })()
          : null
        const result = await mutateDomainWorkspace(req, caller, account, body.expectedRevision, 'domain.created', options => deps.store.createDomain({
          accountId: account.id,
          name,
          kind: effectiveKind,
          parentId,
          docRoot: (alias ? (guarded ? alias.docRoot : body.docRoot ?? alias.docRoot) : body.docRoot) ?? `${account.home}/domains/${name}/public_html`,
          siteType: (alias ? (guarded ? alias.siteType : body.siteType ?? alias.siteType) : body.siteType) ?? 'php',
          upstream: (alias ? (guarded ? alias.upstream : body.upstream ?? alias.upstream) : body.upstream) ?? null,
          redirect: (alias ? (guarded ? alias.redirect : body.redirect ?? alias.redirect) : body.redirect) ?? null,
          php: newDomainPhp,
          wildcard: body.wildcard ?? false,
          certificateId: body.certificateId ?? null,
          suspended: body.suspended ?? false,
          expiresAt: body.expiresAt ?? null,
          pathQuotaMb: body.pathQuotaMb ?? 'unlimited',
          ...(body.ipv4 !== undefined && { ipv4: body.ipv4 }),
          ...(body.ipv6 !== undefined && { ipv6: body.ipv6 }),
        }, defaultZone ? { ...options, defaultZone } : options), Boolean(body.certificateId))
        const providerDns = (body as { autoDns?: unknown }).autoDns === true ? await publishSiteRecord({ store: deps.store, fetch: globalThis.fetch }, { domain: name, ipv4: result.value.ipv4 ?? account.ipv4 ?? null, ownDomains: existingDomains.map(domain => domain.name), root: caller.principal.kind === 'root' }) : undefined
        return jsonResponse({ domain: result.value, stateChanged: true, ...result.view, reconcile: result.reconcile, ...(providerDns ? { providerDns } : {}) }, 201)
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

      const databaseTransfer = await handleDatabaseTransferRoute(req, url, method, { store: deps.store, requireCaller, assertCanAccessAccount, callAgent, mutateDatabase: mutateDatabaseWorkspace, emitAudit,
        reconcile: (caller, account) => triggerReconcile(caller, { scope: { accountId: account.id, resellerId: account.ownerId } }), ownedName: ownedDatabaseName, reindex: async () => { await reindexFromState(deps.db, await deps.store.readSnapshot()) }, passwordHash: mysqlNativePasswordHash, assertPassword: password => { if (typeof password !== 'string' || password.length < 8 || password.length > 256) fail('VALIDATION', 'the password must be 8 to 256 characters', { stateChanged: false }) } })
      if (databaseTransfer) return databaseTransfer
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

        const passwordHash = await passwordHashFromInput(body, { service: servicePasswordKinds(body.services), scheme: serviceHashScheme })

        const serviceUser = await deps.store.createServiceUser({
          accountId: account.id,
          login,
          passwordHash,
          services: body.services,
          mailboxQuotaMb: body.mailboxQuotaMb ?? 1024,
          ftpDir: body.ftpDir ?? 'public_html',
          ...(body.webdiskReadOnly !== undefined && { webdiskReadOnly: body.webdiskReadOnly }),
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
        // Insert after suId, before the existing state lookup/404. This permits an
        // explicitly authenticated retry of the SAME durable retirement intent.
        if (method === 'DELETE') {
          const credentialRequest = withTransportOf(req, new Request(req.url, { method: req.method, headers: new Headers(req.headers) }))
          const clientIp = extractClientIp(req), limits = sessionLimits(await signInPolicy())
          try {
            await retireMailboxServiceUser({
              db: deps.db, store: deps.store, serviceUserId: suId, actor: caller.principal,
              authorize: async (tx, source) => {
                const current = await authenticateTransport(tx, credentialRequest, {
                  serverSecret, clientIp, entryPoint, mfaRuntimePolicy, touchSession: false, teamMember, sessionLimits: limits,
                  handoffAuthority: createHandoffSessionCheck({ db: tx, store: deps.store, teamMember }),
                })
                if (!current || !current.mfaVerified || current.principalRecord.forcePasswordChange
                  || current.principal.id !== caller.principal.id || current.principal.kind !== caller.principal.kind
                  || current.principal.username !== caller.principal.username
                  || current.principal.kind === 'user' && (caller.principal.kind !== 'user' || current.principal.accountId !== caller.principal.accountId)
                  || current.sessionId !== caller.sessionId || current.apiTokenId !== caller.apiTokenId
                  || JSON.stringify([...current.scopes].sort()) !== JSON.stringify([...caller.scopes].sort())
                  || JSON.stringify(current.team ?? null) !== JSON.stringify(caller.team ?? null)
                  || JSON.stringify(current.impersonator ?? null) !== JSON.stringify(caller.impersonator ?? null)) {
                  return fail('UNAUTHENTICATED', 'the original retirement credential is no longer current', { stateChanged: false })
                }
                if (current.sessionId !== null && current.apiTokenId === null && !current.csrfValid) {
                  return fail('FORBIDDEN', 'invalid or missing CSRF token (x-csrf-token)', { stateChanged: false })
                }
                // Existing permission policy, including API scopes, user/team rights,
                // reseller ACL and source features. These routes use leaf reads only.
                await assertRequestAuthorized(deps.store, current, credentialRequest)
                await assertCanAccessAccount(current, source.account, 'service_user.modify')
                // The verifier's database/state reads may cross an expiry boundary.
                // Preserve the existing credential time policy in a synchronous guard
                // which the coordinator invokes after its LAST awaited admission read.
                const sessionDeadline = (session: { expiresAt: string; createdAt: string; lastSeenAt: string }): number => {
                  const expiresAt = Date.parse(session.expiresAt), createdAt = Date.parse(session.createdAt), lastSeenAt = Date.parse(session.lastSeenAt)
                  if (![expiresAt, createdAt, lastSeenAt].every(Number.isFinite)) return fail('UNAUTHENTICATED', 'the retirement credential time is unavailable', { stateChanged: false })
                  return Math.min(expiresAt, createdAt + Math.min(SESSION_ABSOLUTE_TIMEOUT_MS, limits.absoluteMs), lastSeenAt + Math.min(SESSION_IDLE_TIMEOUT_MS, limits.idleMs))
                }
                let deadline: number
                if (current.apiTokenId !== null) {
                  const bearer = /^Bearer\s+(\S+)$/i.exec(credentialRequest.headers.get('authorization')?.trim() ?? '')?.[1]
                  if (bearer === undefined) return fail('UNAUTHENTICATED', 'the original retirement credential is unavailable', { stateChanged: false })
                  const token = await findActiveApiTokenByHash(tx, sha256Hex(bearer))
                  if (!token || token.id !== current.apiTokenId || token.principalId !== current.principal.id) return fail('UNAUTHENTICATED', 'the original retirement credential changed', { stateChanged: false })
                  // API token expiry is required by its current persisted contract.
                  // Missing/invalid expiry must never become an unlimited credential.
                  deadline = Date.parse(token.expiresAt)
                } else if (transportPeers.get(credentialRequest)?.cliPeer) {
                  // A kernel peer holds no expiring credential; its identity was read again above, in this transaction.
                  deadline = Number.MAX_SAFE_INTEGER
                } else {
                  if (current.sessionToken === null || current.sessionId === null) return fail('UNAUTHENTICATED', 'the original retirement session is unavailable', { stateChanged: false })
                  const tokenHash = sessionTokenHash(current.sessionToken, entryPoint)
                  if (current.team) {
                    const member = readSavedTeam(await readTeamFile(current.team.accountId))?.find(value => value.id === current.team?.id)
                    if (!member || teamMemberPhase(member, Date.now()) !== 'active' || member.username !== current.team.username
                      || JSON.stringify([...member.roles].sort()) !== JSON.stringify([...current.team.roles].sort())) {
                      return fail('UNAUTHENTICATED', 'the retirement team authority changed', { stateChanged: false })
                    }
                    const session = await findActiveTeamSession(tx, tokenHash, new Date())
                    if (!session || session.id !== current.sessionId || session.ownerPrincipalId !== current.principal.id
                      || session.memberId !== current.team.id || session.accountId !== current.team.accountId || session.login !== current.team.login) {
                      return fail('UNAUTHENTICATED', 'the original retirement team session changed', { stateChanged: false })
                    }
                    deadline = sessionDeadline(session)
                    if (member.expiresAt !== null) deadline = Math.min(deadline, Date.parse(member.expiresAt))
                  } else {
                    const session = await findActiveSessionByTokenHash(tx, tokenHash)
                    if (!session || session.id !== current.sessionId || session.principalId !== current.principal.id) return fail('UNAUTHENTICATED', 'the original retirement session changed', { stateChanged: false })
                    deadline = sessionDeadline(session)
                  }
                }
                if (!Number.isFinite(deadline)) return fail('UNAUTHENTICATED', 'the retirement credential time is unavailable', { stateChanged: false })
                const clock = Object.freeze({ assertCurrentTime(): void {
                  const now = Date.now()
                  if (!Number.isFinite(now) || now >= deadline) return fail('UNAUTHENTICATED', 'the retirement credential expired during admission', { stateChanged: false })
                } })
                clock.assertCurrentTime()
                return clock
              },
              audit: async event => {
                await emitAudit({ actor: caller.principal.username, principalId: caller.principal.id,
                  action: event.action, target: 'mailbox:' + event.source.service.login, outcome: 'ok',
                  detail: { jobId: event.job.id, initiator: event.job.actor, recoveryActorId: caller.principal.id,
                    scope: 'control_plane', nativeDeletionVerified: false } },
                  { accountId: event.source.account.id, resellerId: event.source.account.ownerId })
              },
              reconcile: source => triggerReconcile(caller, { scope: { accountId: source.account.id, resellerId: source.account.ownerId } }),
            })
          } catch (error) {
            if (isXpanelError(error) && (error.code === 'UNAUTHENTICATED' || error.code === 'FORBIDDEN')) {
              // Rejection rolls back the admitted transaction. Preserve the normal
              // authenticator's session/team revocation outside that transaction.
              try { await authenticateTransport(deps.db, credentialRequest, { serverSecret, clientIp, entryPoint,
                mfaRuntimePolicy, touchSession: false, teamMember, handoffAuthority, sessionLimits: limits }) }
              catch { return fail('SERVICE_UNAVAILABLE', 'retirement credential rejection requires review', {
                stateChanged: true, verificationRequired: true, unknownOutcome: true,
              }) }
            }
            throw error
          }
          // A mailbox retirement cannot return success without native proof.
          // Null is only the unchanged non-mail service-user route below.
        }
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
              ? { passwordHash: await passwordHashFromInput(patch, { service: servicePasswordKinds(services), scheme: serviceHashScheme }) }
              : {}),
          }
          const serviceUser = await deps.store.updateServiceUser(suId, resolvedPatch)
          const reconcile = await triggerReconcile(caller, {
            scope: { accountId: account.id, resellerId: account.ownerId },
          })
          await emitAudit({ actor: caller.principal.username, action: 'service_user.updated', target: `service-user:${serviceUser.login}`, outcome: 'ok', principalId: caller.principal.id },
            { accountId: account.id, resellerId: account.ownerId })
          return jsonResponse({ serviceUser: publicServiceUser(serviceUser), reconcile: reconcile?.body ?? null })
        }
        if (method === 'DELETE') {
          await deps.store.deleteServiceUser(suId)
          const reconcile = await triggerReconcile(caller, {
            scope: { accountId: account.id, resellerId: account.ownerId },
          })
          await emitAudit({ actor: caller.principal.username, action: 'service_user.deleted', target: `service-user:${existing.login}`, outcome: 'ok', principalId: caller.principal.id },
            { accountId: account.id, resellerId: account.ownerId })
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
          const inputRecords = body.records ?? []
          const hasApexNs = inputRecords.some(record => record.type === 'NS' && (record.name === '@' || record.name === zoneName || record.name === `${zoneName}.`))
          const defaultNsRecords = !existingZone && zoneAccountId === null && inputRecords.length > 0 && !hasApexNs
            ? await (async () => {
                const settings = await deps.store.getServerSettings()
                const ttl = settings?.defaultTtl ?? 3600
                return (settings?.nameservers ?? []).map(ns => ({
                  id: randomUUID(),
                  zone: zoneName,
                  name: '@',
                  type: 'NS' as const,
                  ttl,
                  content: ns,
                  priority: null,
                }))
              })()
            : []
          const zone = await deps.store.saveDnsZone({
            id: body.id ?? existingZone?.id ?? randomUUID(),
            name: zoneName,
            accountId: zoneAccountId,
            serial: body.serial ?? (existingZone ? existingZone.serial + 1 : 2026102201),
            records: [...defaultNsRecords, ...inputRecords],
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
            // A zone that is gone is not found, whatever revision the caller last read.
            if (current === null) return fail('NOT_FOUND', 'zone not found', { stateChanged: false })
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
      if (pathname === '/api/firewall' || pathname.startsWith('/api/firewall/')) {
        // shortcut: the auto-revert timer lives in this process; after a restart the next firewall request reverts an expired change
        const response = await handleFirewallWorkspaceRoute(req, url, method, { requireCaller, assertRoot, store: deps.store,
          clientIp: extractClientIp, reconcile: caller => triggerReconcile(caller),
          bans: (caller, unban) => callAgent(unban ? '/host/firewall/bans/unban' : '/host/firewall/bans', { caller, ...(unban ? { method: 'POST', body: unban } : {}) }),
          audit: async (caller, action, target, detail, outcome = 'ok') => { await emitAudit({ actor: caller.principal.username, action, target, detail, outcome, principalId: caller.principal.id, ip: extractClientIp(req) }) },
        })
        if (response) return response
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
        const sanitizeIp = (entry: AuditEntry): AuditEntry => {
          if (entry.actor === caller.principal.username) return entry
          const { ip: _ip, ...rest } = entry
          return rest
        }
        if (caller.principal.kind === 'root') {
          const chain = await verifyAuditLogStatus(deps.db)
          return jsonResponse({ entries, chain })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const accounts = resellerId ? await ownedAccounts(deps.store, caller) : []
          const usernames = new Set(accounts.map((a) => a.username))
          return jsonResponse({
            entries: entries
              .filter(
                (e) =>
                  e.actor === caller.principal.username ||
                  usernames.has(e.actor) ||
                  [...usernames].some((u) => targetsAccount(e.target, u)),
              )
              .map(sanitizeIp),
          })
        }
        return jsonResponse({
          entries: entries
            .filter(
              (e) =>
                e.actor === caller.principal.username ||
                targetsAccount(e.target, caller.principal.username),
            )
            .map(sanitizeIp),
        })
      }

      if (/^\/api\/transfers\/(?:credentials|source\/inventory|source\/accounts|convert-addon)(?:\/|$)/.test(pathname)) {
        const extended = new ExtendedFeaturesStore(deps.store.rootDir)
        const readJournal = () => extended.readOrDefault<unknown>('transfers/convert-addon.json', null)
        const response = await handleTransferCredentialsRoute(req, url, method, { store: deps.store, requireCaller, assertRoot, emitAudit })
          ?? await handleTransferSourceInventoryRoute(req, url, method, { requireCaller, assertRoot, readSnapshot: () => deps.store.readSnapshot(),
            readDisk: caller => readNativeWorkspace(caller, '/host/monitoring/disk', undefined, false, 'GET') })
          ?? await handleTransferSourcePackageRoute(req, url, method, { requireCaller, assertRoot, readSnapshot: () => deps.store.readSnapshot(),
            readEdge: accountId => readAccountEdgeState(deps.store.rootDir, accountId),
            agent: (caller, path, init = {}) => callAgent(path, { caller, ...init }) })
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
      if (isReportableError(err)) void reportedBody().then(body => errorReporter.capture(err, { component: pathname.startsWith('/api/') ? (err instanceof Error && /agent/i.test(err.message) ? 'agent' : 'api') : 'web', method, path: pathname, ...(body === undefined ? {} : { body }) })).catch(() => undefined)
      if ((status === 500 || status === 503) && prefersDocumentHtml(req, pathname, method)) {
        try { return renderTransportStatus(req, status) } catch { /* keep the problem document */ }
      }
      return problemResponse(err, pathname, method)
    }
  }

  // Each request gets its own audit scope; a handed-off caller marks it inside requireCaller.
  const fetchInner = async (req: Request, context?: TransportContext): Promise<Response> => {
    const started = performance.now()
    const response = await auditScope.run({}, () => routeRequest(req, context))
    if (!(await panelSettingsFile(deps.store).current()).developerMode) return response
    // Developer mode: the time this process spent on the request, for the browser's network panel.
    try {
      const timed = new Response(response.body, response)
      timed.headers.set('server-timing', `app;dur=${(performance.now() - started).toFixed(1)}`)
      return timed
    } catch { return response }
  }

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
        await recoverAccountContactProjection()
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
        await recoverAccountContactProjection()
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

  // ---- Terminal sessions: tickets from the page routes, PTY over the agent socket, stream over /api/terminal/ws ----
  const terminalAgentCall = async (grant: TerminalGrant, path: string, method: string, body?: unknown): Promise<Response> => {
    if (!deps.agentApp || !deps.agentToken) return fail('PRECONDITION_FAILED', 'privileged host agent is not connected')
    const response = await deps.agentApp.fetch(new Request(`http://agent.local${path}`, { method,
      headers: { ...agentCallerHeaders({ principalId: grant.principalId, token: deps.agentToken }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return fail('SERVICE_UNAVAILABLE', 'the terminal host request failed') }
    return response
  }
  const terminalAgent: TerminalAgentPort = {
    open: async (grant, cols, rows) => ((await (await terminalAgentCall(grant, '/terminal/sessions', 'POST', { kind: grant.kind, cols, rows, ...(grant.container ? { account: grant.accountUsername, containerId: grant.container.id, shell: grant.container.shell, asRoot: grant.container.asRoot } : {}) })).json()) as { session: AgentTerminalSession }).session,
    output: async (grant, id) => (await terminalAgentCall(grant, `/terminal/sessions/${id}/output`, 'GET')).body ?? fail('SERVICE_UNAVAILABLE', 'the terminal output stream is unavailable'),
    input: async (grant, id, data) => { await terminalAgentCall(grant, `/terminal/sessions/${id}/input`, 'POST', { data }) },
    resize: async (grant, id, cols, rows) => { await terminalAgentCall(grant, `/terminal/sessions/${id}/resize`, 'POST', { cols, rows }) },
    close: async (grant, id) => { await terminalAgentCall(grant, `/terminal/sessions/${id}`, 'DELETE') },
  }
  const terminalBridge = createTerminalBridge({
    tickets: terminalTickets, registry: terminalRegistry, agent: terminalAgent,
    allowedOrigin: (origin, req) => isOriginPermitted(origin, new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`)),
    authenticate: async req => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v)
        else if (Array.isArray(v)) headers.set(k, v.join(', '))
      }
      const webReq = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { headers })
      if (publicOrigin && new URL(webReq.url).host !== new URL(publicOrigin).host) return null
      const peer = req.socket?.remoteAddress
      transportPeers.set(webReq, { remoteAddress: peer ? normalizedIp(peer) : null, trustedIngress: trustedIngressRequests.has(req), tls: 'encrypted' in (req.socket ?? {}) && Boolean((req.socket as { encrypted?: boolean }).encrypted) })
      if (deps.requireSecureCookies && !isVerifiedHttps(webReq)) return null
      if (await lifecycleAdmissionResponse(webReq)) return null
      return withLifecycleWriterAdmission(async () => {
        await recoverAccountContactProjection()
        const caller = await authenticateRequest(deps.db, webReq, { serverSecret, clientIp: extractClientIp(webReq), touchSession: false, entryPoint, mfaRuntimePolicy, teamMember, handoffAuthority, sessionLimits: sessionLimits(await signInPolicy()) })
        if (!caller || !caller.mfaVerified || caller.sessionId === null || caller.apiTokenId !== null || caller.team || caller.impersonator) return null
        if (entryPoint && !entryPointAdmitsPrincipal(entryPoint, caller.principal)) return null
        return { principalId: caller.principal.id, actor: caller.principal.username, panelSessionId: caller.sessionId, clientIp: extractClientIp(webReq) }
      })
    },
    audit: entry => emitAudit(entry),
  })

  return { fetch, hub, authenticateUpgrade, watchMailbox, terminals: { handleUpgrade: terminalBridge.handleUpgrade, close: () => { terminalBridge.close(); terminalRegistry.closeAll() } } }
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
      // a cPanel archive arrives in 4 MiB base64 chunks, each its own request
      const archiveChunk = req.method === 'PUT' && /^\/api\/(?:transfers\/cpanel-imports|server\/databases\/services\/mongodb\/import)\/[0-9a-f-]{36}$/.test(requestPath)
      // A language catalog upload is a whole PO file (the Arabic release catalog is about 2 MB).
      const languageCatalogWrite = req.method === 'PUT' && /^\/api\/server\/panel\/languages\/[A-Za-z0-9-]{1,35}\/catalog$/.test(requestPath)
      const maxBodyBytes = archiveChunk ? 2 * CPANEL_UPLOAD_CHUNK_BYTES : accountFileWrite ? 3 * 1024 * 1024 : languageCatalogWrite ? 4 * 1024 * 1024 : 1024 * 1024
      try {
        const declaredLength = req.headers['content-length']
        const bodyLimit = archiveChunk ? '8 MiB' : accountFileWrite ? '3 MiB' : languageCatalogWrite ? '4 MiB' : '1 MiB'
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
    }, (req, socket, head) => {
      if (trustedIngress) trustedIngressRequests.add(req)
      return app.terminals?.handleUpgrade(req, socket, head) ?? false
    })
    srv.once('close', () => app.terminals?.close())
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

export const enrichPlansWithAuditMeta = async (db: Db, plans: readonly Plan[]): Promise<Plan[]> => {
  if (plans.length === 0 || plans.every((p) => p.updatedBy !== undefined)) {
    return [...plans]
  }
  const rows = await db
    .query<{ target: string; actor: string; at: string }>(
      `SELECT target, actor, at
       FROM audit_log
       WHERE action IN ('plan.updated', 'plan.created')
         AND outcome = 'ok'
         AND id IN (
           SELECT MAX(id)
           FROM audit_log
           WHERE action IN ('plan.updated', 'plan.created')
             AND outcome = 'ok'
           GROUP BY target
         )`,
    )
    .catch(() => [])
  const byTarget = new Map(rows.map((r) => [r.target, r]))
  return plans.map((plan) => {
    if (plan.updatedBy !== undefined) return plan
    const hit = byTarget.get(`plan:${plan.id}`)
    if (!hit) return plan
    return {
      ...plan,
      updatedBy: hit.actor,
      ...(plan.updatedAt === undefined ? { updatedAt: hit.at } : {}),
    }
  })
}

export const enrichResellersWithAuthMeta = async (db: Db, resellers: readonly Reseller[]): Promise<Reseller[]> => {
  if (resellers.length === 0) return []
  const rows = await db
    .query<{ id: string; username: string; created_at: string; last_login_at: string | null; last_session_at: string | null }>(
      `SELECT p.id, p.username, p.created_at, p.last_login_at,
              (SELECT MAX(s.created_at) FROM sessions s WHERE s.principal_id = p.id) AS last_session_at
       FROM principals p
       WHERE p.kind = 'reseller'`,
    )
    .catch(() => null)
  if (rows === null) return [...resellers]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const byUsername = new Map(rows.map((r) => [r.username.toLowerCase(), r]))
  return resellers.map((reseller) => {
    const hit = byId.get(reseller.id) ?? byUsername.get(reseller.username.toLowerCase())
    const createdAt = reseller.createdAt ?? hit?.created_at
    const lastSignInAt = reseller.lastSignInAt !== undefined
      ? reseller.lastSignInAt
      : (hit?.last_login_at ?? hit?.last_session_at ?? null)
    return {
      ...reseller,
      ...(createdAt !== undefined && { createdAt }),
      lastSignInAt,
    }
  })
}
