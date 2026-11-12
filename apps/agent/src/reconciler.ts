import { withLifecycleWriterAdmission } from '../../../scripts/lifecycle-admission.mjs'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { canonicalIp, servedDocRoot, cronJobUnitId, effectivePlan, effectiveServerFtpSettings, effectiveServerRoles, effectiveServerSshSettings, fail, isXpanelError, MANAGEMENT_PUBLIC_PORTS, managementPortRules, natPublicAddresses, redirectionValues, refusePrefork, suspensionEffects, unitFamily } from '@xpanel/core'
import type {
  Account,
  ConfigTest,
  HostAction,
  Id,
  LiveEvent,
  LiveEventScope,
  OsProfile,
  PhpSettings,
  ReconcileStage,
  RenderedFile,
  ServerSettings,
} from '@xpanel/core'
import {
  activate,
  appendAudit,
  createGeneration,
  getGeneration,
  latestActive,
  markFailed,
  markGenerationRolledBack,
  markTested,
  recordMetricsSample,
  reindexFromState,
} from '@xpanel/db'
import type { ConfigGeneration, Db } from '@xpanel/db'
import { edge, extended, services, system } from '@xpanel/render'
import { siteQuotaActions } from './site-quota.ts'
import type { StateSnapshot, StateStore } from '@xpanel/state'
import { assertGenerationRollbackPreconditions, backgroundStateWrite, firewallPolicy, generationSourceIsLinked, isStateDirectoryDurabilityError, parseGenerationRollbackRequest, withGenerationReconciliationLease } from '@xpanel/state'
import type { GenerationRollbackRequest } from '@xpanel/state'
import type { AgentExecutor } from './executor.ts'
import { assertHostEffectAuthority, HOST_EFFECT_NOT_STARTED, hostEffectsStarted, withHostEffectAuthority, withoutHostEffectAuthority, type HostEffectAuthority } from './host-effect-authority.ts'
import { applyPostfixLocalDelivery, localMailNeedsUpdate, retirePostfixLocalDelivery } from './services/local-mail.ts'
import { ensureOpenDkimSigning, mailAuthZoneAdditions, type OpenDkimSigning } from './services/opendkim-live.ts'
import { removedMaildirPaths } from './services/mail.ts'
import type { DnsReconcileProvider } from './services/dns-native.ts'
import { chooseZoneSerial, stampZoneContent } from './zone-serial.ts'
import { resolveAccountIoDevices } from './io-device.ts'
import { SELINUX_ENFORCE_PATH } from './selinux-homes.ts'
import { readDbClientHost } from './db-profiles.ts'
import { databaseUserRemoteSqlHosts, databaseUserSqlHosts } from './db-remote-provider.ts'
import { compileFtpServer, ftpRestartActions, observeFtpHost, type FtpHostObservation } from './ftp-server.ts'
import { sshdObservedRunning, sshdPolicyOf, sshdReloadActions, sshdStateArgv } from './ssh-reconcile.ts'
import { compileMariadbServerConfig, mariadbRestartActions, observeMariadbHost, type MariadbHostObservation } from './db-server-config.ts'
import { dbQuotaPrivileges, readDbQuotaLocks } from './db-quota.ts'
import { compilePhpMyAdminAccess, observePhpMyAdminHost, phpMyAdminPorts, phpMyAdminRestartActions, type PhpMyAdminHostObservation } from './phpmyadmin-access.ts'
import { postgresqlAccountStatements, postgresqlSqlAction } from './pg-sql.ts'
import { readSecEdgeConfiguration } from './sec-waf.ts'
import { compilerAccessHookAvailable, compilerAccessInput } from './compiler-access.ts'
import { effectiveFpm, fpmIniDefaults } from './svc-policy.ts'
import { readSvcHostInput, renderSvcHost } from './svc-reconcile.ts'
import { containerLoopbackPorts } from './ctr-compose.ts'
import { CTR_REGISTRIES_DIR, readCtrPolicy, renderRegistriesConf } from './ctr-policy.ts'
import type { SvcHostInput } from './svc-reconcile.ts'
import { readLogTweaks } from './log-rotation.ts'
import { accountEdgeSiteOptions, readAccountEdge, removeAccountEdgeState, type AccountEdgeInput } from './account-edge.ts'
import { readSavedTweakValues } from './tweak-values.ts'
import { readAccountPages, type AccountPages } from './account-pages.ts'
import { observeHomeUserQuota } from './services/quota.ts'
import { readMailForwardingConfiguration, readMailfxRenderInput, type MailForwardingConfiguration, type MailfxRenderInput } from './mailfx-render.ts'
import { compileAccountRuntime, EMPTY_RUNTIME, runtimeAppPorts, readRuntimeGeneration, readRuntimeRegistries, removeRuntimeRegistry, restoreRuntimeRegistries, runtimeUnitNames, saveRuntimeGeneration, savedRuntimes, type RuntimeRegistry } from './account-runtime.ts'
import type { SecEdgeConfiguration } from './sec-waf.ts'
import { compileAccountDav, davUnitNames, davZoneAdditions, type DavIngress } from './account-dav.ts'
import { secIngressRenderAuthorityNative } from './sec-ingress-provider.ts'
import type { TrustedProxyRenderAuthority } from '../../../packages/core/src/trusted-proxies.ts'
import {
  buildGenerationManifest,
  computeFilesChecksum,
  detectHostDrift,
  diffManifests,
  hasUnverifiedPreActions,
  ReconcilerJournal,
  runJournaledPreActions,
  sha256Text,
  validateStagedCandidateSyntax,
} from './reconciler-journal.ts'
import type {
  AccountRetirementRecord,
  DriftReport,
  PreviousFileBackup,
  ReconcileJournalPhase,
  ReconcileJournalRecord,
} from './reconciler-journal.ts'
import { hostEffectsChecksum } from './host-effects-checksum.ts'
import { IP_ALIASES_UNIT_PATH, parseManagedAliases, planIpAliases, releasableHolds, type IpAlias } from './ip-aliases.ts'
import { readServerInterfaces } from './server-observation.ts'
import { readRemoteServiceIps } from './remote-service-ips.ts'
import { applyServerOperations, readServerOperations, renderZoneCatalog, type ServerOperationsInput } from './server-operations.ts'
import { applyHostTools, readHostTools } from './host-tools.ts'
import { readAppliedNfsClients } from './ops-file-sharing-native.ts'
import { readMailxSaved } from './mailx-routes.ts'
import { renderMailxRspamdHeaders, renderMailxRspamdLogging } from './mailx-policy.ts'
import { MAILX_RSPAMD_MILTER } from '../../../packages/os/src/mailx-command.ts'
import type { RemoteServiceIps } from '@xpanel/core'
import type { ServerInterface } from './server-observation.ts'
import { mailAutoconfigOption } from './mail-autoconfig.ts'

export * from './reconciler-journal.ts'

/** Irreversible steps of an account termination, in the order they run once its generation committed. */
export const ACCOUNT_RETIREMENT_STEPS = ['quota', 'user', 'home', 'container-runtime', 'mariadb', 'postgresql'] as const
export type AccountRetirementStep = typeof ACCOUNT_RETIREMENT_STEPS[number]
/** A terminating account whose removal stopped after its generation committed; it stays terminating. */
export interface IncompleteRetirement { accountId: Id; username: string; userRemoved: boolean; failedStep: AccountRetirementStep }

export interface CompiledGeneration {
  stateChecksum: string
  files: RenderedFile[]
  tests: ConfigTest[]
  preActions: HostAction[]
  postActions: HostAction[]
  /** `retire` runs only after the generation committed; deleting the user cannot be rolled back. */
  terminatingAccounts: { id: Id; username: string; uid: number; userRemoved: boolean; retire: { step: AccountRetirementStep; action: HostAction }[] }[]
  /** Postfix main.cf and master.cf are merged outside the owned file list. */
  localMail: boolean
  localMailOptions: services.PostfixMainOptions
  /** Saved host name that hostnamectl applies in this generation; verified against the kernel name. */
  hostname?: string
}

const KERNEL_HOSTNAME_PATH = '/proc/sys/kernel/hostname'
const HOSTNAME_FILES: readonly string[] = ['/etc/hostname', '/etc/hosts']
/** EL policy labels /etc/hosts net_conf_t and /etc/hostname hostname_etc_t; an atomic rename into /etc leaves etc_t. */
export const hostnameContextAction = (paths: readonly string[] = HOSTNAME_FILES): HostAction => ({ kind: 'exec', argv: ['/usr/sbin/restorecon', ...paths] })

const DNS_CATALOG_PATH = '/etc/powerdns/named.conf.xpanel-zones'
const DEFAULT_DNS_ZONE_DIR = '/var/lib/powerdns/zones'

/**
 * PowerDNS 4.x BIND backend: `rediscover` admits catalog additions/removals, but a changed zone
 * file is only re-read by `bind-reload-now <zone>`; a plain `reload` keeps serving the old bytes.
 * Order matters: rediscover first (so a newly added zone is known), then per-zone reload, then the
 * global reload so removals are dropped.
 */
/**
 * A one-shot cron service is inactive between timer triggers; restarting it during rollback fails the
 * reload and its post-rollback health probe reports the oneshot as inactive. The timer is the unit the
 * rollback restores; the service is only started by that timer.
 */
/** A one-shot cron service is inactive between timer triggers; only its timer is a managed reload unit. */
export const isOneShotCronService = (unit: string): boolean => /^xpanel-cron-[a-z0-9_-]+\.service$/.test(unit)
export const rollbackReloadUnits = (units: readonly string[]): string[] => units.filter(unit => !isOneShotCronService(unit))

export const powerDnsReloadActions = (zones: readonly string[]): HostAction[] => {
  const names = [...new Set(zones)].sort((a, b) => a.localeCompare(b))
  return [
    { kind: 'exec', argv: ['/usr/bin/pdns_control', 'rediscover'] },
    ...names.map((zone): HostAction => ({ kind: 'exec', argv: ['/usr/bin/pdns_control', 'bind-reload-now', zone] })),
    { kind: 'exec', argv: ['/usr/bin/pdns_control', 'reload'] },
    POWERDNS_CACHE_PURGE,
  ]
}

/**
 * PowerDNS keeps answering a removed or changed zone from its packet and query caches (20 s by default)
 * after rediscover/reload, so the observation probes that follow would see the old answer.
 */
export const POWERDNS_CACHE_PURGE: HostAction = { kind: 'exec', argv: ['/usr/bin/pdns_control', 'purge'] }

/** A catalog that ends empty only needs rediscovery, the global reload and the cache purge. */
const powerDnsEmptyCatalogActions = (): HostAction[] => [
  { kind: 'exec', argv: ['/usr/bin/pdns_control', 'rediscover'] },
  { kind: 'exec', argv: ['/usr/bin/pdns_control', 'reload'] },
  POWERDNS_CACHE_PURGE,
]

/**
 * The installer enables the web and mail daemons but leaves them stopped until the first generation that
 * configures them: start is a no-op on a running unit, and the reload then applies the new configuration.
 */
const startAndReload = (unit: string): HostAction[] => [{ kind: 'systemd', verb: 'start', unit }, { kind: 'systemd', verb: 'reload', unit }]

const isManagedDnsPath = (path: string, zoneDir: string): boolean =>
  path === DNS_CATALOG_PATH || (path.startsWith(`${zoneDir}/`) && path.endsWith('.zone'))

/**
 * A terminating account's zones leave the rendered generation in the same generation that tears the
 * account down; the manifest diff then removes the zone files and an empty catalog is published.
 * Zones are matched by domain name because a bind zone file carries no account identity.
 */
export const zonesExcludingTerminatingAccounts = <T extends { name: string }>(
  zones: readonly T[], domains: readonly { name: string; accountId: string }[], terminatingAccountIds: ReadonlySet<string>,
): T[] => zones.filter(zone => !domains.some(domain => domain.name === zone.name && terminatingAccountIds.has(domain.accountId)))

/** The generation remains the sole publisher, including when its final zone is removed. */
export const retainEmptyManagedDnsCatalog = (
  compiled: CompiledGeneration,
  previousPaths: readonly string[],
  zoneDir = DEFAULT_DNS_ZONE_DIR,
): void => {
  if (compiled.files.some(file => file.path === DNS_CATALOG_PATH)
    || !previousPaths.some(path => isManagedDnsPath(path, zoneDir))) return
  compiled.files.push({ path: DNS_CATALOG_PATH, content: '// Managed by xPanel: PowerDNS BIND zone catalog\n', mode: 0o644, owner: 'root', group: 'root' })
  compiled.files.sort((a, b) => a.path.localeCompare(b.path))
  compiled.postActions.push(...powerDnsEmptyCatalogActions())
}

/** Native DNS effects require a validator/observer; modeled fixtures cannot create native proof. */
export const runGenerationDnsHook = async (input: {
  phase: 'validate' | 'verify'
  native: boolean
  provider: DnsReconcileProvider | undefined
  files: readonly RenderedFile[]
  removedPaths: readonly string[]
  zoneDir?: string
}): Promise<void> => {
  const zoneDir = input.zoneDir ?? DEFAULT_DNS_ZONE_DIR
  if (!input.files.some(file => isManagedDnsPath(file.path, zoneDir))
    && !input.removedPaths.some(path => isManagedDnsPath(path, zoneDir))) return
  if (!input.provider) {
    if (input.native) return fail('SERVICE_UNAVAILABLE', 'native DNS reconciliation requires a connected validator and authoritative observer', {
      stateChanged: input.phase === 'verify', verificationRequired: input.phase === 'verify', reason: 'dns_reconciliation_provider_not_connected',
    })
    return
  }
  await input.provider[input.phase](input.files, input.removedPaths)
}

export interface CompileOptions {
  os: OsProfile
  quotaFilesystem?: string | null
  ioDevices?: string[]
  ioDevicesByAccount?: ReadonlyMap<string, readonly string[]>
  zoneDir?: string
  now?: Date
  /** DKIM material already written by the live mail writer. Absent leaves the zone unchanged. */
  mailAuth?: OpenDkimSigning | null
  /** Existing zone files, keyed by absolute path. Absent keeps each zone's state serial. */
  previousZones?: ReadonlyMap<string, string>
  /** Strictly parsed extended mail records, read from the same StateStore root. */
  mailForwarding?: MailForwardingConfiguration
  /** Spam filter milter and mailbox Sieve policy scripts (mailfx-render.ts). Absent renders neither. */
  mailFx?: MailfxRenderInput
  /** Null when saved hostname TLS material is absent on the host. */
  mailTls?: { certFile: string; keyFile: string } | null
  /** sec: saved WAF, flood and per-site switches (sec-waf.ts). Absent renders the previous defaults. */
  secEdge?: SecEdgeConfiguration
  /** sec: activated trusted-proxy policy, re-admitted against protected ingress evidence (sec-ingress-provider.ts). */
  trustedProxyAuthority?: TrustedProxyRenderAuthority
  /** Saved runtime apps, caches and containers per account id (account-runtime.ts). Absent renders none. */
  runtime?: ReadonlyMap<string, RuntimeRegistry>
  /** Pull mirrors of the container trust policy; null renders no file. */
  containerRegistries?: RenderedFile | null
  /** Hosts the management TLS ingress serves on the shared 80/443 sockets (agent-origin.ts readManagementHosts). */
  managementHosts?: readonly string[]
  /** Public panel ports of this host (panel-access.ts); a moved port gets its accept rule here, never in the saved list. */
  managementPorts?: readonly number[]
  /** Panel host the edge verifies Web Disk and calendar sign-ins with (account-dav.ts readDavIngress); absent renders neither. */
  davIngress?: DavIngress | null
  /** Panel paths of account sites; absent while Tweak Settings turns them off. */
  panelRedirects?: readonly edge.PanelRedirect[]
  /** Web Template Editor pages per scope and the scope of each account (account-pages.ts). */
  accountPages?: AccountPages
  /** Quota mount of each home root other than the one above; null where that root has no quota. */
  quotaFilesystems?: ReadonlyMap<string, string | null>
  /** HTTP/2 style of the installed nginx, read after preflight; the management ingress renders the same one. */
  nginxHttp2?: edge.NginxHttp2Style
  /** Live /etc/hosts read after preflight; its unrelated lines are kept. Absent renders only the managed lines. */
  etcHosts?: string | null
  /** Kernel host name read after preflight; hostnamectl runs only when it differs from the saved name. */
  observedHostname?: string | null
  /** SELinux is enabled (selinuxfs mounted); EL then restores the policy contexts of the host name files. */
  selinux?: boolean
  /** Saved Compiler Access (compiler-access.ts); absent or null leaves the compiler permissions untouched. */
  compilerAccess?: system.CompilerAccessInput | null
  /** EL with the dnf post-transaction-actions plugin: the hook that reports package updates to the source builds. */
  sourceBuildHook?: boolean
  /** Saved services and security centre tools (svc-reconcile.ts); absent renders none of them. */
  svcHost?: SvcHostInput
  /** Clients of the applied NFS exports; TCP/2049 stays closed without them. */
  nfsClients?: readonly string[]
  /** Recorded user-removal progress of terminating accounts (ReconcilerJournal.readRetirements). */
  retirements?: ReadonlyMap<string, AccountRetirementRecord['user']>
  /** Days logrotate keeps the server logs (Tweak Settings logs.panelRotateDays); absent keeps its default. */
  panelLogRotateDays?: number
  /** The Mail server policy page's own smtpd_client_event_limit_exceptions, kept in the one rendered value. */
  mailLimitPolicy?: string
  /** Saved Remote Service IPs; absent leaves the Postfix limit exceptions at their default. */
  remoteServiceIps?: RemoteServiceIps | null
  /** Saved server roles, domain forwards, system mail forwards and panel TLS policy (server-operations.ts). Absent changes nothing. */
  serverOperations?: ServerOperationsInput
  /** Observed interfaces (null: unreadable) and the aliases the live unit binds. Absent renders no alias change. */
  ipAliases?: { interfaces: readonly ServerInterface[] | null; managed: readonly IpAlias[] }
  /** Saved IP Blocker lists and cache settings per account id (account-edge.ts). Absent renders none. */
  accountEdge?: ReadonlyMap<string, AccountEdgeInput>
  /** Present only on a host with pure-ftpd; its daemon files, service and passive ports are then part of the generation. */
  ftpServer?: FtpHostObservation
  /** Present only on a host with MariaDB; the Tweak Settings drop-in is then part of the generation. */
  mariadbServer?: MariadbHostObservation
  /** How the server of the active remote profile sees this panel; absent on the local server. */
  databaseClientHost?: string
  /** Present only on a host with phpMyAdmin; its nginx server and PHP-FPM pool are then part of the generation. */
  phpMyAdminAccess?: PhpMyAdminHostObservation
  /** Databases over their size limit; their grants keep only what db-quota.ts allows. */
  dbQuotaLocks?: ReadonlySet<string>
}

const DEFAULT_ZONE_DIR = '/var/lib/powerdns/zones'

const docRootContextPaths = (home: string, docRoot: string): string[] => {
  if (!docRoot.startsWith(`${home}/`)) return [docRoot]
  const parts = docRoot.slice(home.length + 1).split('/').filter(Boolean)
  return parts.map((_, index) => `${home}/${parts.slice(0, index + 1).join('/')}`)
}

/** A domain can point at a folder that already holds files labelled for the home, so its whole tree is relabelled. */
const newDocRootContextActions = (snapshot: StateSnapshot, applied: StateSnapshot | null): HostAction[] => {
  const known = new Set(applied?.domains.map(domain => domain.docRoot))
  return snapshot.accounts.flatMap(account => {
    const roots = snapshot.domains.filter(domain => domain.accountId === account.id && !known.has(domain.docRoot)).map(domain => domain.docRoot)
    return account.status !== 'terminating' && roots.length ? [system.accountContextAction(account.username, [...new Set(roots)], true)] : []
  })
}

/**
 * Pure compiler: turns a validated `StateSnapshot` and `OsProfile` into the complete set
 * of rendered configuration files, preflight config tests, and host reconciliation actions.
 */
export const compileDesiredGeneration = (snapshot: StateSnapshot, opts: CompileOptions): CompiledGeneration => {
  const { os } = opts
  const quotaFilesystem = opts.quotaFilesystem ?? null
  // Quota lives on a mount: an account on another home root is limited on that filesystem or, without quota there, not at all.
  const quotaFor = (account: Pick<Account, 'home'>): string | null => {
    const base = dirname(account.home)
    return opts.quotaFilesystems?.has(base) ? opts.quotaFilesystems.get(base)! : quotaFilesystem
  }
  const ioDevices = opts.ioDevices ?? []
  const zoneDir = opts.zoneDir ?? DEFAULT_ZONE_DIR
  const now = opts.now ?? new Date()

  const files: RenderedFile[] = []
  const tests: ConfigTest[] = []
  const preActions: HostAction[] = []
  const postActions: HostAction[] = []
  const terminatingAccounts: CompiledGeneration['terminatingAccounts'] = []
  let localMail = false
  const localMailOptions: services.PostfixMainOptions = {}
  let hostname: string | undefined
  const mailForwarding = opts.mailForwarding ?? { forwarders: [], rejects: [], domainForwarders: [], lists: [] }

  const seenTests = new Set<string>()
  const addTest = (t: ConfigTest): void => {
    if (!seenTests.has(t.name)) {
      seenTests.add(t.name)
      tests.push(t)
    }
  }

  const probeAccounts = snapshot.accounts.filter(account => account.status !== 'terminating'
    && snapshot.domains.some(domain => domain.accountId === account.id && domain.siteType === 'php' && domain.php.handler === 'fpm'))
  if (snapshot.server && probeAccounts.length) {
    preActions.push(...system.accountProbeDirectories(probeAccounts))
    files.push(system.renderAccountProbeAsset())
  }
  const plansById = new Map(snapshot.plans.map((p) => [p.id, p]))
  const dedicatedAddresses = new Set((snapshot.ipPool ?? []).filter(entry => entry.role === 'dedicated').map(entry => entry.address))
  const certs = snapshot.certificates
  // sec: saved WAF edge input. Every server on the shared 443 socket must carry the same protocol options.
  const edgeSettings = (settings: ServerSettings): ServerSettings =>
    ({ ...settings, edge: { ...opts.secEdge?.edge, ...(opts.nginxHttp2 && { http2: opts.nginxHttp2 }) } }) as ServerSettings

  // 1. Server-level edge, backend, SSH, symlink protection, jailed shell, and firewall
  if (snapshot.server) {
    const settings = snapshot.server.settings
    preActions.push(...system.homeBaseProtectionActions(['/home', ...snapshot.accounts.map(account => dirname(account.home))]))
    const shellJail = system.renderShellJail(effectiveServerSshSettings(settings).jail, ['/home', ...snapshot.accounts.map(account => dirname(account.home))])
    files.push(system.renderJailShellBinary(undefined, shellJail.active), ...shellJail.files)
    shellJail.tests.forEach(addTest)
    const symlinkSysctl = system.renderSymlinkProtectionSysctl()
    files.push(symlinkSysctl)
    postActions.push(...system.symlinkProtectionActions())

    preActions.push(...edge.nginxEdgeDirs(os))
    if (opts.accountPages) {
      const pages = edge.accountPageFiles(opts.accountPages.scopes)
      preActions.push(...pages.dirs); files.push(...pages.files)
    }
    // sec: WAF edge input and trusted-proxy authority
    files.push(edge.renderNginxMain(edgeSettings(settings), os, opts.trustedProxyAuthority))
    if (opts.secEdge?.edge.modsecurity) files.push(edge.renderModsecurityMain(opts.secEdge.edge.modsecurity))
    files.push(edge.defaultSiteFile(os, { settings: edgeSettings(settings), ...(opts.managementHosts ? { excludedNames: opts.managementHosts } : {}) }))
    addTest(edge.nginxConfigTest(os))
    files.push(extended.renderLogrotateConfig({ rotateDays: opts.panelLogRotateDays ?? 14, apacheService: settings.engine === 'apache' ? os.services.apache : null,
      fpmAccounts: snapshot.accounts.filter(account => account.status !== 'terminating').map(account => account.username) }))

    if (settings.engine === 'apache') {
      // A saved prefork setting reads as saved; it is never served.
      if (settings.apacheMpm === 'prefork') refusePrefork()
      preActions.push(...edge.apacheLogDirs())
      files.push(
        edge.apacheMpmFile(settings, os, {
          uidRange: [system.ACCOUNT_ID_MIN, system.ACCOUNT_ID_MAX],
          gidRange: [system.ACCOUNT_ID_MIN, system.ACCOUNT_ID_MAX],
        }),
      )
      files.push(edge.renderApacheBase(settings, os))
      const postVhost = edge.renderApachePostVhostInclude(settings, os)
      if (postVhost) files.push(postVhost)
      addTest(edge.apacheConfigTest(os))
    }

    if (opts.containerRegistries) {
      preActions.push({ kind: 'ensure-dir', path: CTR_REGISTRIES_DIR, mode: 0o755, owner: 'root', group: 'root' })
      files.push(opts.containerRegistries)
    }

    const containerGuard = system.renderContainerGuard(containerLoopbackPorts(snapshot.accounts, opts.runtime), os)
    if (containerGuard) {
      files.push(containerGuard.rules, containerGuard.unit)
      addTest(system.nftConfigTest(containerGuard.rules.path))
      postActions.push(...containerGuard.actions)
    }

    // Firewall: real hosts (managementPorts) always maintain table inet xpanel (policy accept while off) for remote-db/ban/guard sets
    const firewall = firewallPolicy(snapshot.firewall)
    if (firewall.rules.length > 0 || firewall.blockPing || opts.managementPorts !== undefined || opts.secEdge?.flood != null || opts.svcHost?.smtpRestricted === true) {
      const prefixLists = Object.fromEntries(firewall.prefixLists.map((l) => [l.name, l.entries]))
      const nftSettings = system.nftSettingsFromServer(settings, {
        prefixLists,
        banTimeoutSec: 3600,
        databaseRemoteSources: snapshot.accounts.filter((a) => a.status === 'active').flatMap((a) => (a.databaseRemoteAccess ?? []).map((e) => e.host)),
        flood: opts.secEdge?.flood ?? null, // sec: flood limits
        ...(opts.ftpServer && opts.ftpServer.roleEnabled !== false && effectiveServerFtpSettings(settings).enabled ? { ftpPassivePorts: effectiveServerFtpSettings(settings).passivePorts } : {}),
        smtpRestricted: opts.svcHost?.smtpRestricted === true,
        enabled: firewall.enabled,
        blockPing: firewall.blockPing,
        nfsClients: opts.nfsClients ?? [],
        ...(opts.managementPorts ? { managementPorts: [...new Set([...MANAGEMENT_PUBLIC_PORTS, ...opts.managementPorts])] } : {}),
        ...(opts.serverOperations?.hostTools?.frp.server.enabled ? { frpPorts: opts.serverOperations.hostTools.frp.server } : {}),
        webClientPorts: phpMyAdminPorts(opts.phpMyAdminAccess),
        appPorts: runtimeAppPorts(snapshot.accounts, opts.runtime),
      })
      const nftFile = system.renderNftables([...firewall.rules, ...managementPortRules(opts.managementPorts ?? [])], nftSettings, os)
      files.push(nftFile)
      addTest(system.nftConfigTest(nftFile.path))
      postActions.push(...system.nftApplyActions(os))

      const sysctlFile = system.renderForwardingSysctl(firewall.enabled ? firewall.rules : [])
      if (sysctlFile) {
        files.push(sysctlFile)
        postActions.push(...system.sysctlApplyActions(sysctlFile))
      }
    }

    // SSHD drop-in
    const sshFile = system.renderSshdDropin(sshdPolicyOf(settings), os)
    files.push(sshFile)
    addTest(system.sshdConfigTest(os))

    if (opts.ipAliases) {
      // Bound before any service reloads, so a mail transport bound to an alias finds it.
      const aliases = planIpAliases(snapshot.ipPool ?? [], opts.ipAliases.interfaces, opts.ipAliases.managed)
      if (aliases.file) files.push(aliases.file)
      postActions.push(...aliases.actions)
    }

    const primaryIp = (version: 4 | 6): string | null => snapshot.ipPool?.find((entry) => entry.version === version && entry.isPrimary)?.address ?? null
    const host = extended.renderHostnameChange(settings.hostname, primaryIp(4) ?? '127.0.1.1', primaryIp(6), opts.etcHosts ?? null)
    files.push(...host.files)
    if (os.family === 'rhel' && opts.selinux) postActions.push(hostnameContextAction())
    if (typeof opts.observedHostname === 'string' && opts.observedHostname.trim() !== settings.hostname) {
      postActions.push(...host.actions)
      hostname = settings.hostname
    }
  }

  // 2. Accounts, slices, domains, PHP-FPM pools, cron timers, MariaDB, Mail, FTP
  const olsAccountRenders: edge.OlsAccountRender[] = []
  const ftpUsers: services.FtpUserInput[] = []
  const mailDomains: services.MailDomainInput[] = []
  const mailRouting = services.planMailRouting(
    {
      domains: snapshot.domains,
      mailboxes: snapshot.serviceUsers.filter((u) => u.services.email).map((u) => ({ login: u.login, accountId: u.accountId, id: u.id })),
    },
    snapshot.mailRouting,
  )
  const sqlStatements: string[] = []
  let needsDaemonReload = false
  const calDavNames: string[] = []

  for (const account of snapshot.accounts) {
    const accountDomains = snapshot.domains.filter((d) => d.accountId === account.id)
    const accountUsers = snapshot.serviceUsers.filter((u) => u.accountId === account.id)
    const accountDbs = snapshot.databases.filter((d) => d.accountId === account.id)
    const accountDbUsers = snapshot.databaseUsers.filter((u) => u.accountId === account.id)
    const accountCrons = snapshot.cronJobs.filter((c) => c.accountId === account.id)

    if (account.status === 'terminating') {
      const fpmVersions = [
        ...new Set(
          accountDomains
            .filter((d) => d.siteType === 'php' && d.php.handler === 'fpm')
            .map((d) => d.php.version),
        ),
      ]
      const units = [
        ...fpmVersions.map((v) => system.fpmUnitName(account.username, v)),
        ...accountCrons.flatMap((c) => {
          const names = system.cronUnitNames(account.username, c.id.slice(0, 16))
          return [names.timer, names.service]
        }),
        ...runtimeUnitNames(account, opts.runtime?.get(account.id) ?? EMPTY_RUNTIME),
        ...davUnitNames(account, accountUsers),
      ]
      const plan = system.accountTerminateActions(account, os, {
        confirmUsername: account.username,
        units,
        quotaFilesystem: quotaFor(account),
      })
      // Stopping units and removing their files stays in the generation, which can still roll back. From the
      // quota clear on (user deletion, home and database removal) nothing can be restored.
      const cut = plan.findIndex(action => action.kind === 'set-quota' || action.kind === 'delete-user')
      postActions.push(...plan.slice(0, cut))
      const progress = opts.retirements?.get(account.id)
      const retire = plan.slice(cut).flatMap((action): CompiledGeneration['terminatingAccounts'][number]['retire'] => {
        // A user that may already be gone has no quota to clear; a confirmed removal is never repeated.
        if (action.kind === 'set-quota') return progress ? [] : [{ step: 'quota', action }]
        if (action.kind === 'delete-user') return progress === 'removed' ? [] : [{ step: 'user', action }]
        return [{ step: 'home', action }]
      })
      // Podman keeps its per-account runtime directory across container restarts; the units above are stopped.
      if ((opts.runtime?.get(account.id)?.containers.length ?? 0) > 0 || (opts.runtime?.get(account.id)?.stacks?.length ?? 0) > 0) {
        retire.push({ step: 'container-runtime', action: { kind: 'remove-path', path: system.containerRuntimeDir(account.username) } })
      }
      const drops = [
        ...accountDbs.flatMap(db => services.dropDatabase(db.name, account.username)),
        ...accountDbUsers.flatMap(dbu => ['localhost', ...databaseUserRemoteSqlHosts(account), ...(opts.databaseClientHost ? [opts.databaseClientHost] : [])].flatMap(host => services.dropUser(dbu.name, account.username, [host]))),
      ]
      if (drops.length > 0) retire.push({ step: 'mariadb', action: services.sqlAction(drops) })
      const pgUsers = (snapshot.postgresqlUsers ?? []).filter(user => user.accountId === account.id)
      if (pgUsers.length > 0) {
        retire.push({ step: 'postgresql', action: postgresqlSqlAction(postgresqlAccountStatements(account, (snapshot.postgresqlDatabases ?? []).filter(database => database.accountId === account.id), pgUsers)) })
      }
      terminatingAccounts.push({ id: account.id, username: account.username, uid: account.uid, userRemoved: progress === 'removed', retire })
      continue
    }

    const plan = effectivePlan(
      plansById.get(account.planId) ??
      fail('NOT_FOUND', `plan ${account.planId} not found for account ${account.username}`), account)

    // Provision Linux group, user, 0750 home dirs, and filesystem quota
    preActions.push(...system.accountProvisionActions(account, plan, os, { quotaFilesystem: quotaFor(account) }))
    // Directories created under /home inherit its home_root_t, which Apache and PHP-FPM may not read.
    if (os.family === 'rhel' && opts.selinux) {
      preActions.push(system.accountContextAction(account.username, [...new Set([...system.accountDirPaths(account.home), ...accountDomains.flatMap(domain => docRootContextPaths(account.home, domain.docRoot))])]))
    }

    // Account systemd slice & logind user slice drop-in. The drop-in directory is
    // created before the atomic write so user-<uid>.slice.d/.tmp can be published.
    const accountDevices = opts.ioDevicesByAccount ? [...(opts.ioDevicesByAccount.get(account.id) ?? [])] : ioDevices
    files.push(system.renderAccountSlice(account, plan.resources, accountDevices, { systemdDir: os.paths.systemdDir }))
    const loginDropin = system.renderLoginSliceDropin(account, plan.resources, accountDevices, { systemdDir: os.paths.systemdDir })
    files.push(loginDropin)
    preActions.push({
      kind: 'ensure-dir',
      path: dirname(loginDropin.path),
      mode: 0o755,
      owner: 'root',
      group: 'root',
    })
    postActions.push(
      ...system.sliceUpdateActions(account, plan.resources, accountDevices, { systemdDir: os.paths.systemdDir }),
    )
    needsDaemonReload = true

    const effects = suspensionEffects(account)
    const cronEnabled = effects.some((e) => e.subsystem === 'cron' && e.state === 'enabled')
    const mailLogin: 'allowed' | 'denied' = effects.some((e) => e.subsystem === 'mail-login' && e.state === 'denied')
      ? 'denied'
      : 'allowed'
    const mailDelivery: 'accept' | 'defer' = effects.some((e) => e.subsystem === 'mail-delivery' && e.state === 'defer')
      ? 'defer'
      : 'accept'
    const ftpSuspended = effects.some((e) => e.subsystem === 'ftp-login' && e.state === 'denied')

    // Runtime apps, caches and containers as units in the slice; apps join the Nginx site below
    const runtime = opts.runtime?.get(account.id)
    const runtimeRender = runtime
      ? compileAccountRuntime(account, plan, accountDomains, runtime, os, snapshot.featureLists.find((f) => f.id === plan.featureListId)?.disabled ?? [])
      : null
    if (runtimeRender) {
      files.push(...runtimeRender.files)
      preActions.push(...runtimeRender.preActions)
      postActions.push(...runtimeRender.postActions)
      if (runtimeRender.python && !files.some((f) => f.path === system.WSGI_LAUNCHER_PATH)) files.push(system.renderWsgiLauncher(), system.renderStaticWsgi())
    }

    // Web Disk and calendars and contacts: units in the slice, nginx on 2078/2080; the launcher and default servers once
    const dav = compileAccountDav({ account, domains: accountDomains, users: accountUsers, certs, os, ingress: opts.davIngress ?? null, ...(opts.svcHost?.webdiskTls ? { tls: opts.svcHost.webdiskTls } : {}),
      disabled: snapshot.featureLists.find((f) => f.id === plan.featureListId)?.disabled ?? [] })
    files.push(...dav.files.filter((file) => !files.some((f) => f.path === file.path)))
    calDavNames.push(...dav.calDavNames)
    preActions.push(...dav.preActions)
    postActions.push(...dav.postActions)

    // Edge & backend vhosts + PHP-FPM pools
    if (snapshot.server && accountDomains.length > 0) {
      const settings = snapshot.server.settings
      // sec: per-site WAF limits and ModSecurity switches
      files.push(edge.nginxSiteFile(account, accountDomains, edgeSettings(settings), os, certs, { now, dedicatedAddresses, ...(opts.secEdge ? { waf: opts.secEdge.sites } : {}), ...(runtimeRender ? { appRoutes: runtimeRender.routes, ...(runtimeRender.compression ? { compression: runtimeRender.compression } : {}) } : {}), ...accountEdgeSiteOptions(opts.accountEdge, account.id), mailAutoconfig: mailAutoconfigOption(snapshot, account.id), calDavNames: dav.calDavNames, ...(opts.panelRedirects ? { panelRedirects: opts.panelRedirects } : {}), ...(opts.accountPages ? { pageScope: opts.accountPages.scopeOf.get(account.id) ?? '' } : {}) }))

      // Per-domain custom configuration drop-in files (cPanel userdata style) + .user.ini
      const customByDomain = new Map(
        (snapshot.domainCustomConfigs ?? [])
          .filter((c) => c.accountId === account.id)
          .map((c) => [c.domainId, c]),
      )
      for (const dom of accountDomains) {
        const customCfg = customByDomain.get(dom.id), basedir = dom.site?.isolated ? edge.siteOpenBasedir(account, dom) : undefined
        if (customCfg) {
          files.push(...system.renderDomainCustomIncludes(account, servedDocRoot(dom), customCfg, os, basedir))
        } else if (basedir) {
          files.push(system.renderSiteIsolationIni(account, servedDocRoot(dom), dom.name, basedir))
        }
      }

      // root-granted disable_functions exceptions follow the account on every handler and version
      const allowedFunctions = settings.phpFunctionExceptions?.find(item => item.account === account.username)?.functions ?? []
      if (settings.engine === 'apache') {
        files.push(...edge.renderApacheVhosts(account, edge.servedDomains(accountDomains), settings, os, {
          now,
          ...(opts.secEdge ? { waf: opts.secEdge.sites, ...(opts.secEdge.edge.apacheRuleEngine ? { modsecurityRuleEngine: opts.secEdge.edge.apacheRuleEngine } : {}) } : {}),
          ...(opts.accountPages ? { pageScope: opts.accountPages.scopeOf.get(account.id) ?? '' } : {}),
        }))
        for (const dom of accountDomains) {
          if (dom.siteType === 'php' && dom.php.handler !== 'fpm') {
            preActions.push(...edge.cgiWrapperDirs(account, settings, os))
            files.push(edge.renderPhpCgiWrapper(account, dom, settings, os, { allowedFunctions }))
          }
        }
      } else {
        const olsAcc = edge.renderOlsAccount(account, edge.servedDomains(accountDomains), settings, os, {
          workerCap: plan.caps.phpWorkers,
          allowedFunctions,
          now,
          ...(opts.accountPages ? { pageScope: opts.accountPages.scopeOf.get(account.id) ?? '' } : {}),
        })
        olsAccountRenders.push(olsAcc)
        files.push(...olsAcc.vhconfs)
      }

      // Render one PHP-FPM master + pool + systemd unit per distinct PHP version used by FPM domains
      const fpmByVersion = new Map<string, PhpSettings>()
      for (const dom of accountDomains) {
        if (dom.siteType === 'php' && dom.php.handler === 'fpm' && !fpmByVersion.has(dom.php.version)) {
          fpmByVersion.set(dom.php.version, dom.php)
        }
      }
      for (const [version, phpSettings] of fpmByVersion) {
        preActions.push(...edge.fpmInstanceDirs(account, version))
        files.push(
          edge.renderFpmPool(account, { ...phpSettings, fpm: effectiveFpm(phpSettings.fpm, opts.svcHost?.phpFpm ?? null, plan.caps.phpWorkers) }, os, {
            workerCap: plan.caps.phpWorkers,
            maxMemoryMb: plan.resources.memoryMb,
            apacheMpm: settings.apacheMpm,
            allowedFunctions,
            narrowableBasedir: accountDomains.some(dom => dom.site?.isolated && dom.php.version === version),
            iniDefaults: fpmIniDefaults(opts.svcHost?.phpFpm ?? null),
            pearLibrary: opts.svcHost?.pearLibraries[version] ?? null,
          }),
        )
        files.push(edge.renderFpmMaster(account, version, os))
        files.push(system.renderFpmUnit(account, version, os))
        addTest(edge.fpmConfigTest(account, version, os))
        const unit = system.fpmUnitName(account.username, version)
        if (account.status === 'active') {
          postActions.push({ kind: 'systemd', verb: 'enable', unit }, { kind: 'systemd', verb: 'restart', unit })
        } else {
          postActions.push({ kind: 'systemd', verb: 'stop', unit }, { kind: 'systemd', verb: 'disable', unit })
        }
      }
    }

    // Cron jobs as systemd timers inside xpanel-<uid>.slice
    if (new Set(accountCrons.map(cron => cronJobUnitId(cron.id))).size !== accountCrons.length) fail('PRECONDITION_FAILED', 'Saved cron unit identities collide; review configuration before reconciliation')
    if (accountCrons.length > 0) preActions.push(
      { kind: 'ensure-dir', path: system.CRON_COMMAND_ROOT, mode: 0o755, owner: 'root', group: 'root' },
      { kind: 'ensure-dir', path: system.cronCommandDir(account.username), mode: 0o750, owner: 'root', group: account.username },
    )
    for (const cron of accountCrons) {
      const shortId = cronJobUnitId(cron.id)
      const rendered = system.renderCronUnits(
        account,
        { id: shortId, schedule: cron.schedule, command: cron.command, ...(cron.maxRuntimeSec !== undefined ? { maxRuntimeSec: cron.maxRuntimeSec } : {}) },
        os,
      )
      files.push(rendered.commandFile, rendered.service, rendered.timer)
      if (cron.enabled && cronEnabled) {
        postActions.push(
          { kind: 'systemd', verb: 'enable', unit: rendered.timerName },
          { kind: 'systemd', verb: 'start', unit: rendered.timerName },
        )
      } else {
        postActions.push(
          { kind: 'systemd', verb: 'stop', unit: rendered.timerName },
          { kind: 'systemd', verb: 'disable', unit: rendered.timerName },
        )
      }
    }

    // Mail (Dovecot per-domain passwd files, forwarders, default addresses, domain forwarders)
    for (const dom of accountDomains) {
      const mailUsers = accountUsers.filter((u) => u.domainId === dom.id && u.services.email)
      const forwarders = mailForwarding.forwarders.filter(item => item.accountId === account.id && item.sourceAddress.endsWith(`@${dom.name}`))
        .map(item => ({ local: item.sourceAddress.slice(0, item.sourceAddress.lastIndexOf('@')), to: item.destinations }))
      const domainForward = mailForwarding.domainForwarders.find(item => item.accountId === account.id && item.sourceDomain === dom.name)?.targetDomain
      const lists = mailForwarding.lists.filter(item => item.accountId === account.id && item.address.endsWith(`@${dom.name}`))
        .map(item => ({ local: item.address.slice(0, item.address.lastIndexOf('@')), members: item.members, ...(item.gate ? { gate: item.gate.gate } : {}) }))
      const rejects = mailForwarding.rejects.filter(item => item.accountId === account.id && item.sourceAddress.endsWith(`@${dom.name}`))
        .map(item => ({ local: item.sourceAddress.slice(0, item.sourceAddress.lastIndexOf('@')), message: item.message }))
      // an autoresponder address also delivers to its hidden user; a list or rejection keeps its address to itself
      for (const item of mailRouting.autoreplies) {
        if (item.accountId !== account.id || item.domain !== dom.name || lists.some(list => list.local === item.local) || rejects.some(reject => reject.local === item.local)) continue
        const existing = forwarders.find(forwarder => forwarder.local === item.local)
        if (!existing) forwarders.push({ local: item.local, to: [item.target] })
        else if (existing.to.length < services.MAX_FORWARD_TARGETS) existing.to = [...existing.to, item.target]
      }
      // the default address comes from the routing plan, which checks it against the domain forwarder
      const defaultAddress = mailRouting.domains.get(dom.name)?.defaultAddress
      if (mailUsers.length > 0 || forwarders.length > 0 || rejects.length > 0 || lists.length > 0 || domainForward !== undefined || defaultAddress !== undefined) {
        const mailboxes = mailUsers.map((u) => ({
          local: u.localPart,
          passwordHash: u.passwordHash,
          quotaMb: u.mailboxQuotaMb,
          suspendLogin: mailLogin === 'denied',
        }))
        // Suspension alone keeps delivering, and a message landing here after the final sync would be lost: a frozen account defers.
        // Once it has moved, mail and logins pass through to the destination instead.
        const movedTo = account.status === 'suspended' ? opts.accountEdge?.get(account.id)?.policy.movedTo : undefined
        const domainInput: services.MailDomainInput = {
          domain: dom.name,
          account,
          login: mailLogin,
          delivery: movedTo ? 'accept' : movedTo === null ? 'defer' : mailDelivery,
          ...(movedTo ? { proxyHost: movedTo } : {}),
          mailboxes,
          forwarders,
          rejects,
          lists,
          ...(domainForward ? { domainForward } : {}),
          defaultAddress: defaultAddress ?? { kind: 'reject' },
        }
        // A backup or remote routing mode leaves the domain out of local delivery (Postfix relays it by MX) and denies
        // every mailbox login, so no local mailbox answers for a domain hosted elsewhere; the mail stays on disk.
        const routed = opts.mailFx?.routing?.has(dom.name) ?? false
        if (mailboxes.length > 0) files.push(services.dovecotPasswdFile(os, routed ? { ...domainInput, login: 'denied' } : domainInput))
        if (!routed) mailDomains.push(domainInput)
      }
    }
    // hidden autoresponder users of this account, one per address that some alias now reaches
    const hidden = mailRouting.autoreplies.filter(item => item.accountId === account.id
      && mailDomains.some(input => input.domain === item.domain && input.forwarders?.some(forwarder => forwarder.local === item.local && forwarder.to.includes(item.target))))
    const gated = mailForwarding.lists.flatMap(item => item.gate && item.accountId === account.id ? [item.gate.gate] : [])
    if (hidden.length > 0 || gated.length > 0) {
      const internal: services.MailDomainInput = { domain: services.autoreplyDomain(account.id), account, internal: true,
        mailboxes: [...hidden.map(item => ({ local: item.target.slice(0, item.target.indexOf('@')), passwordHash: services.LOCKED_MAILBOX_HASH, quotaMb: 1, suspendLogin: true })),
          ...gated.map(gate => ({ local: gate.slice(0, gate.indexOf('@')), passwordHash: services.LOCKED_MAILBOX_HASH, quotaMb: services.LIST_GATE_QUOTA_MB, suspendLogin: true }))] }
      files.push(services.dovecotPasswdFile(os, internal))
      mailDomains.push(internal)
    }

    // Sieve filters and autoresponders: one active script per mailbox, owned by the account
    for (const script of mailRouting.scripts) {
      if (script.accountId !== account.id) continue
      const file = services.sieveFile(account, script.address, script.script)
      const box = dirname(file.path)
      for (const path of [dirname(dirname(box)), dirname(box), box]) {
        preActions.push({ kind: 'ensure-dir', path, mode: 0o700, owner: account.username, group: account.username })
      }
      files.push(file)
      addTest(services.sieveConfigTest())
    }

    // FTP virtual users
    for (const u of accountUsers) {
      if (u.services.ftp) {
        const cleanHash = u.passwordHash.replace(/^\{[A-Z0-9-]+\}/, '')
        ftpUsers.push({
          login: u.login,
          passwordHash: cleanHash,
          account,
          dir: u.ftpDir,
          suspended: ftpSuspended,
        })
      }
    }

    // MariaDB databases, users, grants, and trash
    for (const db of accountDbs) {
      sqlStatements.push(...services.createDatabase(db.name, account.username))
    }
    const dbsById = new Map(accountDbs.map((d) => [d.id, d]))
    // One host per statement builder call: MAX_DB_HOSTS is 20 while an account may save 100 remote hosts.
    const dbHosts = [...databaseUserSqlHosts(account), ...(opts.databaseClientHost ? [opts.databaseClientHost] : [])]
    for (const dbu of accountDbUsers) {
      // Suspension keeps the saved remote policy but closes its SQL accounts until reactivation.
      if (account.status !== 'active') for (const host of databaseUserRemoteSqlHosts(account)) sqlStatements.push(...services.dropUser(dbu.name, account.username, [host]))
      for (const host of dbHosts) {
        sqlStatements.push(...services.createUser(dbu.name, account.username, [host], { plugin: dbu.authPlugin, hash: dbu.authString }))
        for (const grant of dbu.grants) {
          const targetDb = dbsById.get(grant.databaseId)
          const privileges = targetDb ? dbQuotaPrivileges(grant.privileges, opts.dbQuotaLocks?.has(targetDb.name) === true) : []
          if (targetDb && targetDb.trashedAt === null && privileges.length) sqlStatements.push(...services.grantPrivileges(dbu.name, account.username, [host], targetDb.name, privileges))
        }
      }
    }
    for (const db of accountDbs) {
      if (db.trashedAt !== null) {
        const dbGrants: services.DbGrant[] = accountDbUsers
          .filter((u) => u.grants.some((g) => g.databaseId === db.id))
          .flatMap((u) => dbHosts.map((host) => ({ user: u.name, hosts: [host], privileges: u.grants.find((g) => g.databaseId === db.id)?.privileges ?? ['ALL'] })))
        sqlStatements.push(...services.trashDatabase(db.name, account.username, dbGrants, db.trashedAt))
      }
    }
  }

  // OpenLiteSpeed server-level httpd_config.conf when OLS is the engine
  if (snapshot.server && snapshot.server.settings.engine === 'openlitespeed') {
    const settings = snapshot.server.settings
    const maps = olsAccountRenders.flatMap((r) => r.maps)
    const content = [
      edge.renderOlsServerBase(settings).trimEnd(),
      ...(maps.length > 0 ? [edge.renderOlsListener(settings, maps).trimEnd()] : []),
      ...olsAccountRenders.map((r) => r.server.trimEnd()),
      '',
    ].join('\n\n')
    files.push({
      path: `${os.paths.olsRoot}/conf/httpd_config.conf`,
      content,
      mode: 0o644,
      owner: 'root',
      group: 'root',
    })
  }

  if (mailDomains.length > 0 || snapshot.mailIpConfig || opts.mailFx?.routing?.size) {
    const postmaster = services.mailboxPostmaster(snapshot.server?.settings.hostname)
    const domainsDir = services.dovecotDomainsDir(os)
    preActions.push(
      { kind: 'ensure-dir', path: domainsDir.slice(0, domainsDir.lastIndexOf('/')), mode: 0o755, owner: 'root', group: 'root' },
      { kind: 'ensure-dir', path: domainsDir, mode: 0o750, owner: 'root', group: 'dovecot' },
    )
    files.push(services.renderDovecotMailboxConf(os, { postmaster }))
    const maps = services.renderPostfixMaps(os, mailDomains)
    files.push(...maps.files)
    preActions.push(...maps.actions.filter((action) => action.kind === 'ensure-dir'))
    postActions.push(...maps.actions.filter((action) => action.kind !== 'ensure-dir'))
    // mailfx: Sieve during delivery and each mailbox's spam policy script; sievec failures fail the generation.
    const sieve = services.renderMailboxPolicySieve(os, opts.mailFx?.sieve ?? [])
    const trap = services.renderBoxTrapper(os, opts.mailFx?.boxTrapper)
    const listGate = services.renderListGate(os, opts.mailFx?.listGateProgram ? { program: opts.mailFx.listGateProgram, lists: mailForwarding.lists.flatMap(item => item.gate ? [item.gate] : []) } : undefined)
    files.push(services.renderDovecotSieveConf(os, trap.execute || listGate.execute), ...sieve.files, ...trap.files, ...listGate.files, ...(opts.mailFx?.fts ? [services.renderDovecotFtsConf(os)] : []))
    preActions.push(...sieve.preActions, ...trap.preActions, ...listGate.preActions)
    postActions.push(...sieve.postActions, ...trap.postActions, ...listGate.postActions)
    postActions.push(...startAndReload(os.services.dovecot))
    localMail = true
  }

  // Pure-FTPd passwd + mkdb
  // On a pure-ftpd host an empty list still runs mkdb, so the last deleted login leaves the PureDB file.
  if (ftpUsers.length > 0 || opts.ftpServer) {
    const ftpRendered = services.renderFtpPasswd(ftpUsers)
    files.push(ftpRendered.file)
    postActions.push(...ftpRendered.actions)
  }
  if (opts.ftpServer && snapshot.server) {
    const ftp = compileFtpServer(snapshot, { os, ...opts.ftpServer })
    files.push(...ftp.files); preActions.push(...ftp.preActions); postActions.push(...ftp.postActions)
  }
  if (opts.mariadbServer) {
    const mariadb = compileMariadbServerConfig(os, opts.mariadbServer)
    files.push(...mariadb.files); postActions.push(...mariadb.postActions)
  }
  if (opts.phpMyAdminAccess) {
    const phpMyAdmin = compilePhpMyAdminAccess(os, opts.phpMyAdminAccess)
    files.push(...phpMyAdmin.files); preActions.push(...phpMyAdmin.preActions); postActions.push(...phpMyAdmin.postActions)
  }

  // Postfix outbound multi-IPv4/IPv6 transport maps & master.cf transports
  if (snapshot.mailIpConfig) {
    const accountsById = new Map(snapshot.accounts.filter(a => a.status !== 'terminating').map((a) => [a.id, a]))
    const primaryIpv4 =
      snapshot.ipPool?.find((ip) => ip.version === 4 && ip.isPrimary)?.address ??
      snapshot.ipPool?.find((ip) => ip.version === 4)?.address ??
      snapshot.accounts[0]?.ipv4 ??
      '127.0.0.1'
    const primaryIpv6 =
      snapshot.ipPool?.find((ip) => ip.version === 6 && ip.isPrimary)?.address ??
      snapshot.ipPool?.find((ip) => ip.version === 6)?.address ??
      null
    const outbound = system.renderPostfixOutboundIpTransports(
      snapshot.domains,
      accountsById,
      snapshot.mailIpConfig,
      {
        ipv4: primaryIpv4,
        ipv6: primaryIpv6,
        hostname: snapshot.server?.settings.hostname ?? 'localhost.localdomain',
        postfixDir: os.paths.postfixDir,
      },
    )
    files.push(...outbound.files)
    // texthash is read directly; do not invoke a distribution-dependent postmap DB type.
    const senderMap = outbound.files.find(file => file.path.endsWith('/xpanel_sender_transports'))!
    const master = outbound.files.find(file => file.path.endsWith('/xpanel_master_outbound.cf'))!
    localMailOptions.outbound = { senderMap: senderMap.path, master: master.content }
    localMail = true
  }

  if (localMail) {
    const tls = opts.mailTls === undefined ? opts.mailFx?.submissionTls ?? services.mailHostnameTls(snapshot.server?.settings.hostname, snapshot.certificates, now) : opts.mailTls
    if (tls) localMailOptions.tls = tls
    // mailfx: the spam filter milter follows OpenDKIM in the managed main.cf block.
    if (opts.mailFx?.spamMilter) localMailOptions.spamMilter = opts.mailFx.spamMilter
    if (opts.mailFx?.spamMilter === MAILX_RSPAMD_MILTER) {
      files.push(renderMailxRspamdHeaders(), renderMailxRspamdLogging())
      postActions.push(...startAndReload('rspamd.service'))
    }
    if (opts.remoteServiceIps) localMailOptions.limitExceptions = opts.remoteServiceIps.smtp
    if (snapshot.server) localMailOptions.hostname = snapshot.server.settings.hostname
    if (opts.mailLimitPolicy !== undefined) localMailOptions.limitPolicy = opts.mailLimitPolicy
    // These owned fragments bind merged main/master behavior to the generation checksum.
    for (const [name, content] of [
      ['main.cf.fragment', services.localDeliveryMainBlock(os, localMailOptions)],
      ['master.cf.fragment', services.localSubmissionMasterBlock(os, localMailOptions)],
    ]) files.push({ path: `${os.paths.postfixDir}/xpanel/${name}`, content: `${content}\n`, mode: 0o640, owner: 'root', group: 'postfix' })
    if (!preActions.some(action => action.kind === 'ensure-dir' && action.path === `${os.paths.postfixDir}/xpanel`)) {
      preActions.push({ kind: 'ensure-dir', path: `${os.paths.postfixDir}/xpanel`, mode: 0o750, owner: 'root', group: 'postfix' })
    }
    if (!postActions.some(action => action.kind === 'systemd' && action.unit === os.services.postfix)) {
      postActions.push(...startAndReload(os.services.postfix))
    }
  }

  // PowerDNS BIND zone files
  const terminatingAccountIds = new Set(snapshot.accounts.filter(account => account.status === 'terminating').map(account => account.id))
  const renderedZones = zonesExcludingTerminatingAccounts(snapshot.zones, snapshot.domains, terminatingAccountIds)
  // 1:1 NAT: zones keep the local address in state; DNS answers with its public mapping.
  const natPublic = natPublicAddresses(snapshot.ipPool ?? [])
  for (const zone of renderedZones) {
    const primaryNs = snapshot.server?.settings.nameservers[0] ?? `ns1.${zone.name}`
    const rname = `hostmaster.${zone.name}.`
    const path = `${zoneDir}/${zone.name}.zone`
    const renderZone = (serial: number): string => services.renderBindZone([
      {
        zone: zone.name,
        name: '@',
        type: 'SOA',
        ttl: 3600,
        content: `${primaryNs.replace(/\.$/, '')}. ${rname} ${serial} 3600 1800 1209600 3600`,
        priority: null,
      },
      ...zone.records.map((r) => ({
        zone: zone.name,
        name: r.name,
        type: r.type,
        ttl: r.ttl,
        content: (r.type === 'A' || r.type === 'AAAA') ? natPublic.get(r.content) ?? r.content : r.content,
        priority: r.priority,
      })),
      ...(opts.mailAuth && !zone.replica ? mailAuthZoneAdditions(zone.name, zone.records, opts.mailAuth) : []),
      ...(zone.replica ? [] : davZoneAdditions(zone.name, zone.records, calDavNames)),
    ])
    const drafted = renderZone(zone.serial)
    const previous = opts.previousZones ? (opts.previousZones.get(path) ?? null) : null
    // A cluster copy answers with the serial its source published, so members compare equal.
    const serial = zone.replica ? zone.serial : chooseZoneSerial(zone.serial, previous, drafted, now)
    const content = stampZoneContent(serial === zone.serial ? drafted : renderZone(serial))
    files.push({
      path,
      content,
      mode: 0o644,
      owner: 'root',
      group: 'root',
    })
  }
  if (snapshot.zones.length > 0) {
    files.push({
      path: '/etc/powerdns/named.conf.xpanel-zones',
      content: renderZoneCatalog(renderedZones.map(zone => zone.name), zoneDir),
      mode: 0o644,
      owner: 'root',
      group: 'root',
    })
    if (renderedZones.length > 0) postActions.push(...powerDnsReloadActions(renderedZones.map(zone => zone.name)))
    else postActions.push(...powerDnsEmptyCatalogActions())
  }

  if (needsDaemonReload) {
    postActions.unshift({ kind: 'systemd-daemon-reload' })
  }

  if (snapshot.server) {
    const settings = snapshot.server.settings
    const backendUnit = settings.engine === 'apache' ? os.services.apache : os.services.openlitespeed
    postActions.push(...startAndReload(backendUnit), ...startAndReload(os.services.nginx))
  }

  if (sqlStatements.length > 0) {
    postActions.push(services.sqlAction(sqlStatements))
  }
  // PostgreSQL only for accounts that saved PostgreSQL users, so a server without PostgreSQL never needs it.
  const postgresqlStatements = snapshot.accounts.filter(account => account.status !== 'terminating').flatMap((account) => {
    const users = (snapshot.postgresqlUsers ?? []).filter((user) => user.accountId === account.id)
    return users.length ? postgresqlAccountStatements(account, (snapshot.postgresqlDatabases ?? []).filter((database) => database.accountId === account.id), users) : []
  })
  if (postgresqlStatements.length > 0) postActions.push(postgresqlSqlAction(postgresqlStatements))

  // After account provisioning: gpasswd -M names only users that already exist.
  if (opts.svcHost) {
    const svc = renderSvcHost(os, opts.svcHost, snapshot.server?.settings.engine === 'apache')
    files.push(...svc.files)
    postActions.push(...svc.actions)
  }
  if (opts.compilerAccess) {
    const compilers = system.renderCompilerAccess(os, opts.compilerAccess)
    files.push(...compilers.files)
    postActions.push(...compilers.actions)
  }
  if (opts.sourceBuildHook) files.push(system.renderSourceBuildHook())

  if (opts.serverOperations) applyServerOperations(files, postActions, opts.serverOperations, os, opts.selinux === true, snapshot.certificates)
  if (opts.serverOperations?.hostTools) applyHostTools(files, preActions, postActions, opts.serverOperations.hostTools, os, snapshot)

  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    stateChecksum: snapshot.checksum,
    files,
    tests,
    preActions,
    postActions,
    terminatingAccounts,
    localMail,
    localMailOptions,
    ...(hostname ? { hostname } : {}),
  }
}

export interface ReconcileOptions {
  force?: boolean
  scope?: LiveEventScope
  actor?: string
  /** Trusted account operation only; HTTP reconcile bodies cannot supply authority. */
  effectAuthority?: HostEffectAuthority
  expectedState?: { revision: number; checksum: string }
  mailAuth?: OpenDkimSigning | null
  /** Trusted rollback source; never populated from an HTTP reconcile body. */
  expectedRestoredState?: { revision: number; checksum: string }
  /** Trusted historical-restore binding; extended forwarding is outside StateSnapshot. */
  expectedRestoredMailForwarding?: MailForwardingConfiguration
  /** Trusted historical-restore binding of the runtime registries (account-runtime.ts), also outside StateSnapshot. */
  expectedRestoredRuntime?: ReadonlyMap<string, RuntimeRegistry>
}
export interface GenerationRollbackGuard {
  request: GenerationRollbackRequest
  /** Fresh local principal/role read under the state restore writer lease. */
  authorize: () => Promise<void>
}

export type ReconcileResult =
  | { status: 'noop'; generation: ConfigGeneration | null; stateChecksum: string; kernelHostname?: string | null }
  | {
      status: 'applied'
      generation: ConfigGeneration
      filesCount: number
      durationMs: number
      removedFilesCount?: number
      repairedDriftCount?: number
      /** Kernel host name this reconciliation observed last (after verification or rollback). */
      kernelHostname?: string | null
      /** Present only when a terminating account's removal stopped after this generation committed. */
      incompleteRetirements?: IncompleteRetirement[]
    }
  | {
      status: 'failed'
      generation: ConfigGeneration
      failedTest: string
      error: string
      rolledBack?: boolean
      restoredGenerationId?: number | null
      stateChanged?: boolean
      verificationRequired?: true
      kernelHostname?: string | null
    }

export interface ReconciliationRecoveryResult {
  recovered: boolean
  outcome: 'none' | 'rolled_back' | 'failed' | 'needs_attention'
  generationId: number | null
  restoredGenerationId: number | null
  interruptedPhase: ReconcileJournalPhase | null
  restoredFiles: string[]
  reloadedUnits: string[]
  error: string | null
}

export interface ReconcilerDeps {
  /** Native hosts render the Web Server Status files; the token lives in root-only state. */
  webStatus?: boolean
  store: StateStore
  db: Db
  executor: AgentExecutor
  os: OsProfile
  quotaFilesystem?: string | null
  ioDevices?: string[]
  zoneDir?: string
  /** Hosts of the management TLS ingress, read once at agent start: nothing touches the host before preflight. */
  managementHosts?: readonly string[]
  /** Read on every reconcile: Panel access opens a new port before the listener moves. */
  managementPorts?: () => Promise<readonly number[]>
  /** Panel host for the Web Disk and calendar edge, read once at agent start (account-dav.ts readDavIngress). */
  davIngress?: DavIngress | null
  /** agent-origin.ts readPanelRedirects, read once at agent start like the hosts above. */
  panelRedirects?: readonly edge.PanelRedirect[]
  onEvent?: (event: LiveEvent) => void
  /** Optional health verification probe run against each service unit after reload and after rollback. */
  healthProbe?: (unit: string, generationId: number) => Promise<{ ok: boolean; error?: string }>
  /** Exact generation validation/observation; never a second DNS publishing authority. */
  dnsPublication?: DnsReconcileProvider
  /** Trusted host-side verification; file checks alone cannot clear prerequisite effects. */
  preActionRecoveryProbe?: (journal: Readonly<ReconcileJournalRecord>) => Promise<{ ok: boolean; error?: string }>
  /** Optional deterministic hook invoked at each journal phase boundary (used for crash-injection tests). */
  onPhaseHook?: (phase: ReconcileJournalPhase, journal: ReconcileJournalRecord) => Promise<void> | void
}

class SimulatedProcessCrashWrapper extends Error {
  readonly originalError: unknown
  constructor(originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : String(originalError))
    this.name = 'SimulatedProcessCrashWrapper'
    this.originalError = originalError
  }
}

const LOGIN_SLICE_DROPIN_RE = /\/user-\d+\.slice\.d\/50-xpanel\.conf$/

const isEnoent = (err: unknown): boolean => {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
  return err instanceof Error && err.message.includes('ENOENT')
}

/** A missing atomic temp under a slice drop-in is not a second host failure. */
const isMissingAtomicTemp = (err: unknown): boolean => {
  if (!isEnoent(err) || !(err instanceof Error)) return false
  return err.message.includes('.tmp') || err.message.includes('.slice.d')
}

/** The service an xPanel socket starts on demand (Web Disk, calendars, app proxies): its family owns both units. */
export const onDemandService = (unit: string): string | null => {
  const base = /^(.+)\.(?:service|socket)$/.exec(unit)?.[1]
  const family = base === undefined ? null : unitFamily(`${base}.socket`)
  return family && family === unitFamily(`${base}.service`) ? `${base}.service` : null
}

/**
 * PowerDNS units on this host reject `systemctl reload`. `reload-or-restart`
 * restarts when the unit has no ExecReload. Other units keep their previous verb.
 * Run after the daemon reload that applied the restored unit files.
 */
export const rollbackReloadActions = (unit: string): HostAction[] => {
  if (unit === 'pdns.service' || unit === 'pdns') {
    return [{ kind: 'exec', argv: ['/usr/bin/systemctl', 'reload-or-restart', unit] }]
  }
  // sshd exits when a reload cannot bind its port: the restored file needs a daemon started again, not signalled.
  if (unit === 'ssh' || unit === 'sshd') return [{ kind: 'systemd', verb: 'restart', unit }]
  // pure-ftpd and database/cache daemons have no ExecReload job; restarting applies the restored definition cleanly.
  if (/^(?:pure-ftpd|mariadb|mysql|postgresql|redis|redis-server|valkey|valkey-server|memcached)(?:\.service)?$/.test(unit)) {
    return [{ kind: 'systemd', verb: 'restart', unit }]
  }
  // Slice units have no reload job; restoring their file needs only a daemon reload.
  // `systemctl reload xpanel-<uid>.slice` fails and would strand the rollback.
  if (unit.endsWith('.slice')) return [{ kind: 'systemd-daemon-reload' }]
  // Sockets and the services they start have no reload job ("Job type reload is not applicable"). A socket stops
  // with its service and starts again on its restored definition; the stopped service starts on the next request.
  const service = onDemandService(unit)
  if (service === unit) return [{ kind: 'systemd', verb: 'stop', unit }]
  if (unit.endsWith('.socket')) {
    return service ? [{ kind: 'systemd', verb: 'stop', unit: service }, { kind: 'systemd', verb: 'stop', unit }, { kind: 'systemd', verb: 'start', unit }]
      : [{ kind: 'systemd', verb: 'restart', unit }]
  }
  // xPanel daemons other than PHP-FPM have no ExecReload either; a restart applies the restored definition.
  const verb = /^xpanel-(?:php-fpm-|daemon-|frp[sc]\.|app-|ctr-|redis-|memcached-)/.test(unit) ? 'restart' : unit.endsWith('.timer') ? 'start' : 'reload'
  return [{ kind: 'systemd', verb, unit }]
}

class StageFailureError extends Error {
  readonly failedUnit: string
  constructor(failedUnit: string, message: string) {
    super(message)
    this.name = 'StageFailureError'
    this.failedUnit = failedUnit
  }
}

export class HostReconciler {
  private readonly deps: ReconcilerDeps
  private readonly listeners = new Set<(event: LiveEvent) => void>()
  readonly journal: ReconcilerJournal
  /** False while the DNS role is off: PowerDNS is stopped, so a generation neither validates against it nor observes it. */
  private dnsRoleEnabled = true
  private get dnsPublication(): DnsReconcileProvider | undefined { return this.dnsRoleEnabled ? this.deps.dnsPublication : { validate: async () => {}, verify: async () => {} } as unknown as DnsReconcileProvider }

  constructor(deps: ReconcilerDeps) {
    this.deps = deps
    this.journal = new ReconcilerJournal(deps.store.rootDir)
    if (deps.onEvent) this.listeners.add(deps.onEvent)
  }

  subscribe(fn: (event: LiveEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(event: LiveEvent): void {
    for (const fn of this.listeners) {
      fn(event)
    }
  }

  private emitStage(
    generationId: number,
    stage: ReconcileStage,
    status: 'running' | 'passed' | 'failed',
    scope: LiveEventScope,
    detail?: string,
  ): void {
    this.emit({
      id: randomUUID(),
      at: new Date().toISOString(),
      kind: 'reconcile.stage',
      scope,
      data: {
        generationId,
        stage,
        status,
        ...(detail !== undefined && { detail }),
      },
    })
  }

  private async invokePhaseHook(phase: ReconcileJournalPhase, record: ReconcileJournalRecord): Promise<void> {
    if (!this.deps.onPhaseHook) return
    try {
      await this.deps.onPhaseHook(phase, record)
    } catch (err) {
      throw new SimulatedProcessCrashWrapper(err)
    }
  }

  private async verifyUnitHealth(rawUnit: string, generationId: number): Promise<{ ok: boolean; error?: string }> {
    if (this.deps.healthProbe) {
      return this.deps.healthProbe(rawUnit, generationId)
    }
    const fakeUnits = (this.deps.executor as unknown as {
      units?: Map<string, { enabled: boolean; active: boolean; properties: Record<string, string> }>
    }).units
    if (fakeUnits instanceof Map) {
      const state = fakeUnits.get(rawUnit)
      if (state && !state.active) {
        return { ok: false, error: `service unit ${rawUnit} is not active after reload` }
      }
      return { ok: true }
    }
    // systemd resolves a bare name (os.services.postfix = 'postfix') to its .service unit.
    const unit = /^[A-Za-z0-9][A-Za-z0-9_:@-]*$/.test(rawUnit) ? `${rawUnit}.service` : rawUnit
    // A generation may manage .service, .timer and .socket units; probing only .service units made
    // every cron timer look unprobeable after a successful start and failed the generation.
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.:@-]|\\x[0-9a-fA-F]{2})*\.(?:service|timer|socket)$/.test(unit) || unit.length > 200) {
      return { ok: false, error: `managed unit ${unit} cannot be probed` }
    }
    // Only ActiveState is consumed, and every emitted argv element must satisfy the reviewed
    // SAFE_ARG grammar (commas are not admitted), so request the single property the probe reads.
    const observed = await this.deps.executor.runCommand([
      '/usr/bin/systemctl', 'show', '--no-pager',
      '--property=ActiveState',
      '--', unit,
    ])
    if (!observed.ok || observed.code !== 0) {
      return { ok: false, error: observed.stderr.trim() || `service unit ${unit} probe failed` }
    }
    const active = observed.stdout.split('\n').find(line => line.startsWith('ActiveState='))?.slice('ActiveState='.length).trim()
    if (active !== 'active') return { ok: false, error: `service unit ${unit} is ${active || 'unobserved'}` }
    return { ok: true }
  }

  /**
   * Inspects the active generation's owned-file manifest against the live host files.
   */
  /** Checksums of the active generation's owned files. Empty when no generation is active. */
  async ownedChecksums(): Promise<Map<string, string>> {
    const current = await latestActive(this.deps.db)
    if (!current) return new Map()
    const manifest = await this.journal.readManifest(current.id)
    return new Map((manifest?.files ?? []).map(file => [file.path, file.sha256]))
  }

  async checkDrift(): Promise<DriftReport> {
    const currentGen = await latestActive(this.deps.db)
    if (!currentGen) {
      return { hasDrift: false, manifestMissing: false, generationId: null, items: [] }
    }
    const manifest = await this.journal.readManifest(currentGen.id)
    return detectHostDrift(this.deps.executor, manifest)
  }

  /**
   * Captures a durable backup of all live host files that will be modified, added, or removed
   * before any host mutation occurs.
   */
  private async capturePreviousFilesBackup(
    candidateFiles: readonly RenderedFile[],
    removedPaths: readonly { path: string; mode: number; owner: string; group: string }[],
    previousManifest: ReconcileJournalRecord['previousManifest'],
  ): Promise<PreviousFileBackup[]> {
    const prevByPath = new Map((previousManifest?.files ?? []).map((f) => [f.path, f]))
    const fakeFilesMap = (this.deps.executor as unknown as { files?: Map<string, RenderedFile> }).files

    const targets = new Map<string, { mode: number; owner: string; group: string }>()
    for (const f of candidateFiles) {
      targets.set(f.path, {
        mode: f.mode,
        owner: f.owner ?? 'root',
        group: f.group ?? 'root',
      })
    }
    for (const r of removedPaths) {
      targets.set(r.path, {
        mode: r.mode,
        owner: r.owner,
        group: r.group,
      })
    }

    const backups: PreviousFileBackup[] = []
    for (const [path, fallbackMeta] of targets) {
      const content = await this.deps.executor.readFile(path)
      const prevEntry = prevByPath.get(path)
      const fakeEntry = fakeFilesMap instanceof Map ? fakeFilesMap.get(path) : undefined
      const mode = fakeEntry?.mode ?? prevEntry?.mode ?? fallbackMeta.mode
      const owner = fakeEntry?.owner ?? prevEntry?.owner ?? fallbackMeta.owner
      const group = fakeEntry?.group ?? prevEntry?.group ?? fallbackMeta.group

      backups.push({
        path,
        existed: content !== null,
        content,
        sha256: content !== null ? sha256Text(content) : null,
        mode,
        owner,
        group,
      })
    }
    return backups
  }

  /**
   * Restores one backed-up file. A missing temp under user-<uid>.slice.d is retried
   * after the drop-in directory is created, and ignored when the live bytes already
   * match the backup.
   */
  private async restoreBackedUpFile(backup: PreviousFileBackup): Promise<void> {
    if (!backup.existed || backup.content === null) {
      await this.deps.executor.removePath(backup.path)
      return
    }
    const file: RenderedFile = {
      path: backup.path,
      content: backup.content,
      mode: backup.mode,
      owner: backup.owner,
      group: backup.group,
    }
    try {
      await this.deps.executor.writeFile(file)
    } catch (err) {
      if (!isMissingAtomicTemp(err)) throw err
      if (LOGIN_SLICE_DROPIN_RE.test(backup.path)) {
        await this.deps.executor.runAction({
          kind: 'ensure-dir',
          path: dirname(backup.path),
          mode: 0o755,
          owner: 'root',
          group: 'root',
        })
      }
      try {
        await this.deps.executor.writeFile(file)
      } catch (retryErr) {
        if (!isMissingAtomicTemp(retryErr)) throw retryErr
        const live = await this.deps.executor.readFile(backup.path)
        if (live === backup.content) return
        throw retryErr
      }
    }
  }

  /**
   * Restores previous file bytes/mode/owner/group from the persisted journal backup,
   * reloads affected services in reverse dependency order, verifies restored service health,
   * and transitions the generation to `rolled_back` in SQLite.
   */
  private async rollbackLiveHostAndRecord(
    journalRecord: ReconcileJournalRecord,
    failedUnitOrStage: string,
    errorMsg: string,
    scope: LiveEventScope,
  ): Promise<{
    rolledBackGen: ConfigGeneration
    restoredActiveGen: ConfigGeneration | null
    restoredFiles: string[]
    reloadedUnits: string[]
    verificationRequired: boolean
    kernelHostname?: string | null
  }> {
    let kernelHostname: string | null | undefined
    const restoredFiles: string[] = []
    const reloadedUnits: string[] = []
    const stoppedNewUnits: string[] = []
    const previousFiles: RenderedFile[] = journalRecord.previousFilesBackup
      .filter((backup): backup is PreviousFileBackup & { content: string } => backup.existed && backup.content !== null)
      .map(({ path, content, mode, owner, group }) => ({ path, content, mode, owner, group }))
    const absentPaths = journalRecord.previousFilesBackup.filter(backup => !backup.existed).map(backup => backup.path)
    const native = process.platform === 'linux' && !('files' in this.deps.executor)
    const zoneDir = this.deps.zoneDir ?? DEFAULT_DNS_ZONE_DIR
    const dnsWasTouched = journalRecord.previousFilesBackup.some(backup => isManagedDnsPath(backup.path, zoneDir))

    try {
      // Restore the captured bytes without requiring the failed daemon to answer first.
      // Readiness and authoritative observations remain mandatory before recovery succeeds.
      for (const backup of journalRecord.previousFilesBackup.filter(entry => isManagedDnsPath(entry.path, zoneDir))) {
        if (backup.existed ? backup.content === null || backup.sha256 !== sha256Text(backup.content)
          : backup.content !== null || backup.sha256 !== null) {
          fail('PRECONDITION_FAILED', 'captured DNS backup integrity could not be verified', {
            stateChanged: true, verificationRequired: true, generationId: journalRecord.generationId,
          })
        }
      }
      for (const backup of journalRecord.previousFilesBackup) {
        await this.restoreBackedUpFile(backup)
        restoredFiles.push(backup.path)
      }
      const relabel = HOSTNAME_FILES.filter(path => journalRecord.previousFilesBackup.some(backup => backup.existed && backup.path === path))
      if (this.deps.os.family === 'rhel' && relabel.length && await this.deps.executor.readFile(SELINUX_ENFORCE_PATH) !== null) {
        await this.deps.executor.runAction(hostnameContextAction(relabel))
      }

      for (const unit of [...journalRecord.stoppedObsoleteUnits].reverse()) {
        await this.deps.executor.runAction({ kind: 'systemd', verb: 'enable', unit })
        const verb = unit.endsWith('.timer') ? 'start' : 'restart'
        await this.deps.executor.runAction({ kind: 'systemd', verb, unit })
        reloadedUnits.push(unit)
      }

      // Unit files the failed generation created have no restored definition to restart from.
      const introducedUnits = new Set(journalRecord.previousFilesBackup
        .filter(backup => !backup.existed && /\/systemd\/system\/[^/]+\.(?:service|timer|socket)$/.test(backup.path))
        .map(backup => backup.path.slice(backup.path.lastIndexOf('/') + 1)))
      const unitsToReload = rollbackReloadUnits(
        journalRecord.reloadedUnits.length > 0
          ? [...journalRecord.reloadedUnits].reverse()
          : [...new Set(journalRecord.previousManifest?.files.flatMap((f) => f.dependentUnits) ?? [])].reverse())
      if (dnsWasTouched && !unitsToReload.includes('pdns.service')) unitsToReload.push('pdns.service')
      // Restored or removed unit files change systemd's view before any unit is touched.
      await this.deps.executor.runAction({ kind: 'systemd-daemon-reload' })

      for (const unit of unitsToReload) {
        if (reloadedUnits.includes(unit) || stoppedNewUnits.includes(unit)) continue
        // A slice has no reload job and no service health; the daemon reload above applied its restored drop-in.
        if (unit.endsWith('.slice')) continue
        if (introducedUnits.has(unit)) {
          await this.deps.executor.runAction({ kind: 'systemd', verb: 'stop', unit })
          stoppedNewUnits.push(unit)
          continue
        }
        if (
          unit === 'nftables.service' ||
          unit === 'nftables' ||
          unit === this.deps.os.services.nftables ||
          unit === `${this.deps.os.services.nftables}.service`
        ) {
          if (journalRecord.previousFilesBackup.some(entry => entry.existed && entry.path === this.deps.os.paths.nftablesConf)) {
            for (const action of system.nftApplyActions(this.deps.os)) await this.deps.executor.runAction(action)
          }
          continue
        }
        if (unit === 'pdns.service' && dnsWasTouched) {
          const restoredZoneDir = this.deps.zoneDir ?? DEFAULT_DNS_ZONE_DIR
          const restoredZones = journalRecord.previousFilesBackup
            .filter(entry => entry.existed && entry.path.startsWith(restoredZoneDir + '/') && entry.path.endsWith('.zone'))
            .map(entry => entry.path.slice(restoredZoneDir.length + 1, -'.zone'.length))
          for (const action of powerDnsReloadActions(restoredZones)) await this.deps.executor.runAction(action)
        } else {
          const actions = rollbackReloadActions(unit)
          for (const action of actions) await this.deps.executor.runAction(action)
          // An on-demand service stays stopped until its socket starts it; it has no health to probe.
          if (actions.every(action => action.kind === 'systemd' && action.verb === 'stop')) {
            stoppedNewUnits.push(unit)
            continue
          }
        }
        reloadedUnits.push(unit)
      }

      for (const unit of reloadedUnits) {
        // One-shot cron services are inactive between timer triggers; the timer is the managed reload unit.
        if (isOneShotCronService(unit) || unit.endsWith('.slice')) continue
        const health = await this.verifyUnitHealth(
          unit,
          journalRecord.previousActiveGenerationId ?? 0,
        )
        if (!health.ok) {
          throw new Error(
            `post-rollback health verification failed for ${unit}: ${health.error ?? 'unhealthy'}`,
          )
        }
      }
      await runGenerationDnsHook({ phase: 'verify', native, provider: this.dnsPublication, files: previousFiles, removedPaths: absentPaths, zoneDir })
      // A generation that may have run hostnamectl sets the kernel name back and proves it.
      const previous = journalRecord.previousKernelHostname
      if (previous !== undefined) {
        kernelHostname = (await this.deps.executor.readFile(KERNEL_HOSTNAME_PATH))?.trim() ?? null
        if (kernelHostname !== previous) {
          await this.deps.executor.runAction({ kind: 'exec', argv: ['/usr/bin/hostnamectl', 'set-hostname', previous] })
          kernelHostname = (await this.deps.executor.readFile(KERNEL_HOSTNAME_PATH))?.trim() ?? null
          if (kernelHostname !== previous) fail('PRECONDITION_FAILED', 'the previous system host name could not be restored', { stateChanged: true, verificationRequired: true, expected: previous, observed: kernelHostname })
        }
      }
    } catch (rollbackErr) {
      journalRecord.phase = 'needs_attention'
      journalRecord.rollbackFailed = true
      const rollbackDetail = isXpanelError(rollbackErr) && rollbackErr.detail && Object.keys(rollbackErr.detail).length
        ? ` ${JSON.stringify(rollbackErr.detail).slice(0, 400)}` : ''
      journalRecord.error = `rollback failed after ${errorMsg}: ${(rollbackErr as Error).message}${rollbackDetail}`
      await this.journal.saveJournal(journalRecord)
      throw rollbackErr
    }

    const { rolledBack, active } = await markGenerationRolledBack(
      this.deps.db,
      journalRecord.generationId,
      journalRecord.previousActiveGenerationId,
      errorMsg,
    )

    const verificationRequired = hasUnverifiedPreActions(journalRecord)
    journalRecord.phase = verificationRequired ? 'needs_attention' : 'rolled_back'
    journalRecord.error = errorMsg
    await this.journal.saveJournal(journalRecord)
    await this.journal.cleanupStagingDir(journalRecord.generationId)

    const audit = await appendAudit(this.deps.db, {
      actor: journalRecord.actor,
      action: verificationRequired ? 'reconcile.failed' : 'reconcile.rolled_back',
      target: `generation:${journalRecord.generationId}`,
      detail: {
        failedUnitOrStage,
        error: errorMsg,
        restoredGenerationId: active?.id ?? null,
        restoredFilesCount: restoredFiles.length,
        reloadedUnits,
        stateChanged: verificationRequired,
        verificationRequired,
        configurationFilesRestored: true,
      },
      outcome: 'failed',
    })
    this.emit({
      id: randomUUID(),
      at: new Date().toISOString(),
      kind: 'reconcile.failed',
      scope,
      data: {
        generationId: journalRecord.generationId,
        failedTest: failedUnitOrStage,
        error: errorMsg,
      },
    })
    this.emit({ id: randomUUID(), at: audit.at, kind: 'audit.entry', scope, data: audit })

    return {
      rolledBackGen: rolledBack,
      restoredActiveGen: active,
      restoredFiles,
      reloadedUnits,
      verificationRequired,
      ...(kernelHostname !== undefined ? { kernelHostname } : {}),
    }
  }

  /**
   * Reads the persisted on-disk journal after a process crash/kill at any phase
   * (`stage`, `test`, `activate`, `reload`, `verify`) and deterministically recovers
   * the host and SQLite generation state so no partial files or false `active` rows remain.
   */
  async recoverInterruptedReconciliation(scope: LiveEventScope = { accountId: null, resellerId: null }): Promise<ReconciliationRecoveryResult> {
    return withLifecycleWriterAdmission(() => withGenerationReconciliationLease(this.deps.store.rootDir, () => this.recoverInterruptedReconciliationAdmitted(scope)))
  }

  private async recoverInterruptedReconciliationAdmitted(
    scope: LiveEventScope = { accountId: null, resellerId: null },
  ): Promise<ReconciliationRecoveryResult> {
    await this.journal.assertNoUnresolvedPreparation()
    const activeJournal = await this.journal.readActiveJournal()
    if (!activeJournal) {
      return {
        recovered: false,
        outcome: 'none',
        generationId: null,
        restoredGenerationId: null,
        interruptedPhase: null,
        restoredFiles: [],
        reloadedUnits: [],
        error: null,
      }
    }

    const interruptedPhase = activeJournal.phase
    if (interruptedPhase === 'needs_attention') {
      return {
        recovered: false,
        outcome: 'needs_attention',
        generationId: activeJournal.generationId,
        restoredGenerationId: activeJournal.previousActiveGenerationId,
        interruptedPhase,
        restoredFiles: [],
        reloadedUnits: [],
        error: activeJournal.error,
      }
    }

    const reason = `recovered from interrupted reconciliation at phase '${interruptedPhase}'`

    // Native config tests can require users and directories before live config activation.
    // An interrupted prerequisite is not undone by restoring configuration files.
    if ((interruptedPhase === 'render' || interruptedPhase === 'stage' || interruptedPhase === 'test')
      && hasUnverifiedPreActions(activeJournal)) {
      activeJournal.preActionsNeedVerification = true
      activeJournal.phase = 'needs_attention'
      activeJournal.error = `${reason}; host prerequisite effects require verification`
      await this.journal.saveJournal(activeJournal)
      await markFailed(this.deps.db, activeJournal.generationId, activeJournal.error)
      return {
        recovered: false, outcome: 'needs_attention', generationId: activeJournal.generationId,
        restoredGenerationId: activeJournal.previousActiveGenerationId, interruptedPhase,
        restoredFiles: [], reloadedUnits: [], error: activeJournal.error,
      }
    }

    // Crashed before live host activation (`render`, `stage`, `test`): live files were untouched.
    if (interruptedPhase === 'render' || interruptedPhase === 'stage' || interruptedPhase === 'test') {
      await this.journal.cleanupStagingDir(activeJournal.generationId)
      const gen = await getGeneration(this.deps.db, activeJournal.generationId)
      if (gen && (gen.status === 'pending' || gen.status === 'tested')) {
        await markFailed(this.deps.db, activeJournal.generationId, reason)
      }
      activeJournal.phase = 'failed'
      activeJournal.error = reason
      await this.journal.saveJournal(activeJournal)

      await appendAudit(this.deps.db, {
        actor: activeJournal.actor,
        action: 'reconcile.recovered',
        target: `generation:${activeJournal.generationId}`,
        detail: {
          interruptedPhase,
          outcome: 'failed',
          restoredGenerationId: activeJournal.previousActiveGenerationId,
        },
        outcome: 'failed',
      })

      return {
        recovered: true,
        outcome: 'failed',
        generationId: activeJournal.generationId,
        restoredGenerationId: activeJournal.previousActiveGenerationId,
        interruptedPhase,
        restoredFiles: [],
        reloadedUnits: [],
        error: reason,
      }
    }

    // Crashed during or after live host mutation (`activate`, `reload`, `verify`):
    // restore previous files + metadata, reload services in reverse order, verify health, and mark rolled_back.
    const rb = await this.rollbackLiveHostAndRecord(
      activeJournal,
      `crash:${interruptedPhase}`,
      reason,
      scope,
    )

    return {
      recovered: !rb.verificationRequired,
      outcome: rb.verificationRequired ? 'needs_attention' : 'rolled_back',
      generationId: activeJournal.generationId,
      restoredGenerationId: rb.restoredActiveGen?.id ?? null,
      interruptedPhase,
      restoredFiles: rb.restoredFiles,
      reloadedUnits: rb.reloadedUnits,
      error: reason,
    }
  }

  /**
   * Clears a generation whose rollback failed and left the journal in `needs_attention`.
   * Verifies live owned files against the journal backup or the failed candidate, marks
   * that generation failed, and drops the active journal so reconcile can run again.
   */
  async resolveFailedGeneration(generationId: number, actor = 'root', options: { attestPreActions?: boolean } = {}): Promise<{ generationId: number; previousGenerationId: number | null; checkedFiles: number }> {
    return withLifecycleWriterAdmission(() => withGenerationReconciliationLease(this.deps.store.rootDir, () => this.resolveFailedGenerationAdmitted(generationId, actor, options.attestPreActions === true)))
  }

  private async resolveFailedGenerationAdmitted(
    generationId: number,
    actor = 'root',
    attestPreActions = false,
  ): Promise<{ generationId: number; previousGenerationId: number | null; checkedFiles: number }> {
    await this.journal.assertNoUnresolvedPreparation()
    if (!Number.isSafeInteger(generationId) || generationId < 1) {
      return fail('VALIDATION', 'resolve-failed requires a positive integer generation id')
    }
    const journal = await this.journal.readActiveJournal()
    if (!journal || journal.phase !== 'needs_attention') {
      return fail('PRECONDITION_FAILED', 'no failed reconciliation is waiting for operator attention')
    }
    if (journal.generationId !== generationId) {
      return fail('PRECONDITION_FAILED', `failed generation ${journal.generationId} is waiting, not ${generationId}`, {
        generationId: journal.generationId,
        requested: generationId,
      })
    }

    const candidate = await getGeneration(this.deps.db, generationId)
    if (!candidate) return fail('NOT_FOUND', `config generation ${generationId} not found`)
    if (candidate.status === 'active' || candidate.status === 'superseded') {
      return fail('PRECONDITION_FAILED', `generation ${generationId} is ${candidate.status} and cannot be cleared in place`, {
        generationId,
        status: candidate.status,
      })
    }

    const preActionsAttested = hasUnverifiedPreActions(journal) && attestPreActions
    if (hasUnverifiedPreActions(journal)) {
      // Without an automatic probe, an explicit audited operator attestation is the verification.
      const probe = attestPreActions ? { ok: true } : await this.deps.preActionRecoveryProbe?.(journal)
      if (!probe?.ok) {
        return fail('PRECONDITION_FAILED', 'host prerequisite effects require independent verification before clearing the generation', {
          generationId, stateChanged: true, verificationRequired: true,
          ...(probe?.error && { error: probe.error }),
        })
      }
      journal.preActionsNeedVerification = false
      delete journal.pendingPreAction
    }

    const active = await latestActive(this.deps.db)
    if ((active?.id ?? null) !== journal.previousActiveGenerationId) {
      return fail('PRECONDITION_FAILED', 'the active generation does not match the journal backup', {
        activeGenerationId: active?.id ?? null,
        previousGenerationId: journal.previousActiveGenerationId,
      })
    }

    const mismatches: string[] = []
    for (const backup of journal.previousFilesBackup) {
      const live = await this.deps.executor.readFile(backup.path)
      if (backup.existed ? live === backup.content : live === null) continue
      const owned = journal.candidateManifest.files.find((entry) => entry.path === backup.path)
      if (live !== null && owned && sha256Text(live) === owned.sha256) continue
      const missingSliceTemp = (journal.error ?? '').includes('.slice.d') && (journal.error ?? '').includes('.tmp')
      if (LOGIN_SLICE_DROPIN_RE.test(backup.path) && live === null && missingSliceTemp) {
        continue
      }
      mismatches.push(backup.path)
    }
    if (mismatches.length > 0) {
      return fail('PRECONDITION_FAILED', 'on-disk state does not match the journal backup or the failed candidate', {
        generationId,
        paths: mismatches.slice(0, 20),
      })
    }

    const reason = `operator resolved needs_attention after on-disk verification: ${journal.error ?? 'rollback failed'}`.slice(0, 2000)
    if (candidate.status === 'pending' || candidate.status === 'tested') {
      await markFailed(this.deps.db, generationId, reason)
    }
    journal.phase = 'failed'
    journal.error = reason
    await this.journal.saveJournal(journal)

    const scope: LiveEventScope = { accountId: null, resellerId: null }
    const audit = await appendAudit(this.deps.db, {
      actor,
      action: 'reconcile.attention_resolved',
      target: `generation:${generationId}`,
      detail: {
        generationId,
        previousGenerationId: journal.previousActiveGenerationId,
        checkedFiles: journal.previousFilesBackup.length,
        ...(preActionsAttested ? { preActionsAttestedByOperator: true } : {}),
      },
      outcome: 'ok',
    })
    this.emit({ id: randomUUID(), at: audit.at, kind: 'audit.entry', scope, data: audit })

    return {
      generationId,
      previousGenerationId: journal.previousActiveGenerationId,
      checkedFiles: journal.previousFilesBackup.length,
    }
  }

  /**
   * Runs each terminating account's irreversible removal after its generation committed, and removes a fully
   * retired account from desired state. A failed step is never rolled back: the account stays terminating with
   * its user-removal progress recorded, and a later reconciliation resumes at the failed step.
   */
  private async retireAccounts(accounts: CompiledGeneration['terminatingAccounts']): Promise<IncompleteRetirement[]> {
    const incomplete: IncompleteRetirement[] = []
    for (const account of accounts) {
      const record = { schemaVersion: 1 as const, accountId: account.id, username: account.username, uid: account.uid }
      let userRemoved = account.userRemoved
      let failedStep: AccountRetirementStep | undefined
      for (const { step, action } of account.retire) {
        try {
          if (step === 'user') await this.journal.saveRetirement({ ...record, user: 'removing' })
          await this.deps.executor.runAction(action)
          if (step === 'user') {
            await this.journal.saveRetirement({ ...record, user: 'removed' })
            userRemoved = true
          }
        } catch (error) {
          console.error('xpanel-agent account retirement step failed:', account.username, step,
            error instanceof Error ? error.message.split('\n')[0]!.slice(0, 300) : 'unexpected failure')
          failedStep = step
          break
        }
      }
      if (failedStep) {
        incomplete.push({ accountId: account.id, username: account.username, userRemoved, failedStep })
        continue
      }
      await this.deps.store.deleteAccount(account.id)
      await removeRuntimeRegistry(this.deps.store.rootDir, account.id)
      await removeAccountEdgeState(this.deps.store.rootDir, account.id)
      await this.journal.clearRetirement(account.id)
    }
    return incomplete
  }

  /**
   * Clears the release holds that the active generation, compiled from `snapshot`, makes safe; the account's new
   * addresses must be observed on the host. A failure leaves the holds for a later reconcile.
   */
  private async releaseVerifiedIps(snapshot: StateSnapshot): Promise<void> {
    try {
      const pool = await this.deps.store.listServerIps()
      if (!pool.some(entry => entry.releasing)) return
      const interfaces = await readServerInterfaces(argv => this.deps.executor.runCommand(argv))
      if (!interfaces) return
      const bound = new Set(interfaces.flatMap(item => item.addresses.map(address => canonicalIp(address.address).address)))
      const holds = releasableHolds(pool, snapshot, bound)
      if (holds.length) await backgroundStateWrite(() => this.deps.store.clearIpReleasing(holds))
    } catch (error) {
      console.error('xpanel-agent IP release check failed:', error instanceof Error ? error.message.split('\n')[0]!.slice(0, 300) : 'unexpected failure')
    }
  }

  /**
   * Reconciles the host to the desired state in `/var/lib/xpanel/state/`.
   * Stages candidate files, runs every service's config test before touching live paths,
   * removes only owned obsolete files, rolls back on reload/health failure, or activates
   * atomically and updates the SQLite index.
   */
  async reconcile(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
    const run = () => withLifecycleWriterAdmission(() => withGenerationReconciliationLease(this.deps.store.rootDir, async () => {
      await assertHostEffectAuthority(this.deps.executor)
      return this.reconcileAdmitted(opts)
    }))
    return opts.effectAuthority ? withHostEffectAuthority(this.deps.executor, opts.effectAuthority, run) : run()
  }

  /**
   * Upgrade rewind only: reconciles the restored desired state of `generationId`, which the restored index holds as
   * active. An attention journal belongs to the rewound upgrade when its generation was built on `generationId` and is
   * absent from the restored index; it is superseded, with an audit entry, unless that generation's own host rollback
   * stopped part way. Any other attention refuses with its generation and error.
   */
  async reconcileRewound(generationId: number, actor: string): Promise<ReconcileResult> {
    return withLifecycleWriterAdmission(() => withGenerationReconciliationLease(this.deps.store.rootDir, async () => {
      await assertHostEffectAuthority(this.deps.executor)
      const journal = await this.journal.readActiveJournal()
      if (journal?.phase === 'needs_attention') {
        const [active, recorded] = await Promise.all([latestActive(this.deps.db), getGeneration(this.deps.db, journal.generationId)])
        const ours = journal.previousActiveGenerationId === generationId && active?.id === generationId && recorded === null
        const error = (journal.error ?? 'no error was recorded').slice(0, 1500)
        if (!ours || journal.rollbackFailed) {
          return fail('PRECONDITION_FAILED', `generation ${journal.generationId} requires operator attention${ours ? ', its own rollback did not finish' : ', and the rewound upgrade did not create it'}: ${error}`, {
            generationId: journal.generationId, restoredGenerationId: generationId, stateChanged: false,
          })
        }
        journal.phase = 'failed'
        journal.error = `superseded by the upgrade rewind to generation ${generationId}: ${error}`
        await this.journal.saveJournal(journal)
        await appendAudit(this.deps.db, { actor, action: 'reconcile.attention_resolved', target: `generation:${journal.generationId}`,
          detail: { generationId: journal.generationId, previousGenerationId: generationId, supersededByRewind: true, error }, outcome: 'ok' })
      }
      return this.reconcileAdmitted({ force: true, actor })
    }))
  }

  private async reconcileAdmitted(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
    const startMs = Date.now()
    const scope: LiveEventScope = opts.scope ?? { accountId: null, resellerId: null }
    const actor = opts.actor ?? 'agent'
    const isRealLinuxExecutor = process.platform === 'linux' && !('files' in this.deps.executor)

    await this.journal.assertNoUnresolvedPreparation()
    const existingJournal = await this.journal.readActiveJournal()
    if (existingJournal) {
      if (opts.effectAuthority) return fail('PRECONDITION_FAILED', 'an interrupted reconciliation requires separate operator recovery before account provisioning', {
        stateChanged: false, verificationRequired: true, generationId: existingJournal.generationId,
      })
      if (existingJournal.phase === 'needs_attention') {
        fail('PRECONDITION_FAILED', `previous reconciliation of generation ${existingJournal.generationId} requires operator attention`, {
          generationId: existingJournal.generationId,
          error: existingJournal.error,
          ...(hasUnverifiedPreActions(existingJournal) && { stateChanged: true, verificationRequired: true }),
        })
      }
      const recovery = await this.recoverInterruptedReconciliationAdmitted(scope)
      if (recovery.outcome === 'needs_attention') {
        fail('PRECONDITION_FAILED', 'interrupted host prerequisite effects require operator verification', {
          generationId: recovery.generationId, stateChanged: true, verificationRequired: true,
        })
      }
    }

    const snapshot = await this.deps.store.readSnapshot()
    if (opts.expectedState && (snapshot.revision !== opts.expectedState.revision || snapshot.checksum !== opts.expectedState.checksum)) {
      return fail('CONFLICT', 'the saved account source changed before reconciliation', { stateChanged: false })
    }
    await assertHostEffectAuthority(this.deps.executor)
    const mailForwarding = await readMailForwardingConfiguration(this.deps.store.rootDir, snapshot)
    const remoteServiceIps = await readRemoteServiceIps(this.deps.store.rootDir)
    const serverOperations = await readServerOperations(this.deps.store.rootDir)
    serverOperations.hostTools = await readHostTools(this.deps.store.rootDir)
    this.dnsRoleEnabled = effectiveServerRoles(serverOperations.roles).has('dns')
    const ftpRoleEnabled = effectiveServerRoles(serverOperations.roles).has('ftp')
    const mailLimitPolicy = (await readMailxSaved(this.deps.store.rootDir)).sections.server?.policy.postfix.smtpd_client_event_limit_exceptions
    // mailfx: Sieve inputs come from saved files; the milter needs systemd answers, read after preflight.
    let mailFx = await readMailfxRenderInput(this.deps.store.rootDir, snapshot, this.deps.os.family, null)
    // sec: saved WAF/flood edge input and the activated trusted-proxy authority
    const secEdge = await readSecEdgeConfiguration(this.deps.store.rootDir, { family: this.deps.os.family, domains: snapshot.domains })
    const compilerAccess = await compilerAccessInput(this.deps.store.rootDir, this.deps.os.family, snapshot)
    const sourceBuildHook = this.deps.os.family === 'rhel' && await compilerAccessHookAvailable('rhel')
    const svcHost = await readSvcHostInput(this.deps.store.rootDir, snapshot, this.deps.webStatus === true)
    const nfsClients = await readAppliedNfsClients()
    const { panelRotateDays } = await readLogTweaks(this.deps.store.rootDir)
    const redirection = redirectionValues(await readSavedTweakValues(this.deps.store.rootDir))
    const quotaFilesystems = new Map<string, string | null>()
    for (const base of new Set(snapshot.accounts.map(account => dirname(account.home)))) {
      if (base === '/home' || this.deps.quotaFilesystem === null) continue
      const run = (argv: readonly string[]) => this.deps.executor.runCommand([...argv])
      const observed = await observeHomeUserQuota(run, base).catch(() => null)
      quotaFilesystems.set(base, observed?.status === 'enabled' ? observed.filesystem : null)
    }
    const accountPages = snapshot.server ? await readAccountPages(this.deps.store.rootDir, { accounts: snapshot.accounts, resellers: snapshot.resellers, settings: snapshot.server.settings }) : null
    const runtime = await readRuntimeRegistries(this.deps.store.rootDir, snapshot.accounts)
    const containerRegistries = renderRegistriesConf(await readCtrPolicy(this.deps.store.rootDir))
    const accountEdge = await readAccountEdge(this.deps.store.rootDir, snapshot.accounts)
    const retirements = await this.journal.readRetirements(snapshot.accounts.filter(account => account.status === 'terminating'))
    const runtimeText = JSON.stringify(savedRuntimes(runtime))
    if (opts.expectedRestoredRuntime && runtimeText !== JSON.stringify(savedRuntimes(opts.expectedRestoredRuntime))) {
      fail('CONFLICT', 'Saved runtime services changed after generation restore; review the restored state before reconciliation', { stateChanged: true, verificationRequired: true })
    }
    const trustedProxyAuthority = await secIngressRenderAuthorityNative()
    if (opts.expectedRestoredMailForwarding && JSON.stringify(mailForwarding) !== JSON.stringify(opts.expectedRestoredMailForwarding)) {
      fail('CONFLICT', 'Saved mail forwarding changed after generation restore; review the restored state before reconciliation', { stateChanged: true, verificationRequired: true })
    }
    const assertMailForwardingUnchanged = async (): Promise<void> => {
      const fresh = await readMailForwardingConfiguration(this.deps.store.rootDir, snapshot)
      if (JSON.stringify(fresh) !== JSON.stringify(mailForwarding)) {
        fail('CONFLICT', 'Saved mail forwarding changed during reconciliation; retry the current configuration')
      }
    }
    if (opts.expectedRestoredState && (snapshot.revision !== opts.expectedRestoredState.revision || snapshot.checksum !== opts.expectedRestoredState.checksum)) {
      return fail('CONFLICT', 'desired state changed after restore; newer saved changes are preserved and were not reconciled', { stateChanged: true, verificationRequired: true })
    }
    const currentGen = await latestActive(this.deps.db)
    const mailDomains = [
      ...snapshot.domains.map(domain => domain.name),
      ...snapshot.serviceUsers.flatMap(user => {
        if (!user.services.email) return []
        const at = user.login.lastIndexOf('@')
        return at > 0 ? [user.login.slice(at + 1)] : []
      }),
    ]
    const previousManifest = currentGen ? await this.journal.readManifest(currentGen.id) : null
    const appliedSnapshot = currentGen ? await this.deps.store.readGenerationSnapshot(currentGen.id) : null
    let accountIoDevices: ReadonlyMap<string, readonly string[]> | undefined
    let mailTls: CompileOptions['mailTls']
    let etcHosts: string | null | undefined
    let observedHostname: string | null | undefined
    let selinux: boolean | undefined
    let sshdRunning = true
    let nginxHttp2: edge.NginxHttp2Style | undefined
    let ipAliases: CompileOptions['ipAliases']
    let ftpServer: FtpHostObservation | undefined
    let mariadbServer: MariadbHostObservation | undefined
    let databaseClientHost: string | null = null
    let phpMyAdminAccess: PhpMyAdminHostObservation | undefined
    let dbQuotaLocks: ReadonlySet<string> | undefined
    let kernelHostname: string | null | undefined
    const observedKernel = () => (kernelHostname !== undefined ? { kernelHostname } : {})
    const managementPorts = await this.deps.managementPorts?.()
    const compileMail = (mailAuth: OpenDkimSigning | null, previousZones?: ReadonlyMap<string, string>) => {
      const next = compileDesiredGeneration(snapshot, {
        os: this.deps.os,
        ...(this.deps.managementHosts ? { managementHosts: this.deps.managementHosts } : {}),
        ...(managementPorts ? { managementPorts } : {}),
        ...(this.deps.davIngress ? { davIngress: this.deps.davIngress } : {}),
        ...(this.deps.panelRedirects && redirection.panelPaths ? { panelRedirects: this.deps.panelRedirects } : {}),
        ...(accountPages ? { accountPages } : {}),
        quotaFilesystems,
        quotaFilesystem: this.deps.quotaFilesystem ?? null,
        ...(this.deps.ioDevices && { ioDevices: this.deps.ioDevices }),
        ...(accountIoDevices ? { ioDevicesByAccount: accountIoDevices } : {}),
        ...(this.deps.zoneDir && { zoneDir: this.deps.zoneDir }),
        ...(mailAuth ? { mailAuth } : {}),
        ...(previousZones ? { previousZones } : {}),
        mailForwarding,
        mailFx,
        ...(mailTls !== undefined ? { mailTls } : {}),
        secEdge,
        compilerAccess,
        sourceBuildHook,
        svcHost,
        nfsClients,
        panelLogRotateDays: panelRotateDays,
        ...(trustedProxyAuthority ? { trustedProxyAuthority } : {}),
        runtime,
        containerRegistries,
        retirements,
        accountEdge,
        ...(etcHosts !== undefined ? { etcHosts } : {}),
        ...(observedHostname !== undefined ? { observedHostname } : {}),
        ...(selinux !== undefined ? { selinux } : {}),
        ...(nginxHttp2 && { nginxHttp2 }),
        ...(ipAliases && { ipAliases }),
        remoteServiceIps,
        serverOperations,
        ...(mailLimitPolicy !== undefined && { mailLimitPolicy }),
        ...(ftpServer && { ftpServer: { ...ftpServer, roleEnabled: ftpRoleEnabled } }),
        ...(mariadbServer && { mariadbServer }),
        ...(databaseClientHost && { databaseClientHost }),
        ...(phpMyAdminAccess && { phpMyAdminAccess }),
        ...(dbQuotaLocks && { dbQuotaLocks }),
        now: new Date(),
      })
      if (ftpServer) next.postActions.push(...ftpRestartActions(this.deps.os, next.files, previousManifest?.files, sha256Text, ftpRoleEnabled && effectiveServerFtpSettings(snapshot.server?.settings).enabled))
      if (mariadbServer) next.postActions.push(...mariadbRestartActions(this.deps.os, next.files, previousManifest?.files, sha256Text, effectiveServerRoles(serverOperations.roles).has('mysql')))
      next.postActions.push(...sshdReloadActions(this.deps.os, next.files, previousManifest?.files, sha256Text, sshdRunning))
      if (phpMyAdminAccess) next.postActions.push(...phpMyAdminRestartActions(next.files, previousManifest?.files, sha256Text))
      if (appliedSnapshot) {
        for (const path of removedMaildirPaths(appliedSnapshot, snapshot)) {
          next.postActions.push({ kind: 'remove-path', path })
        }
      }
      retainEmptyManagedDnsCatalog(next, previousManifest?.files.map(file => file.path) ?? [], this.deps.zoneDir ?? DEFAULT_DNS_ZONE_DIR)
      return next
    }
    const preflightOf = (next: ReturnType<typeof compileMail>, checksum: string) => {
      const previewCandidate = buildGenerationManifest({
        generationId: (currentGen?.id ?? 0) + 1,
        stateChecksum: snapshot.checksum,
        filesChecksum: checksum,
        actor,
        files: next.files,
        postActions: next.postActions,
        os: this.deps.os,
      })
      const previewDiff = diffManifests(previousManifest, previewCandidate)
      return {
        files: next.files,
        preActions: next.preActions,
        postActions: [
          ...next.postActions,
          ...previewDiff.removed.map((removed) => ({ kind: 'remove-path' as const, path: removed.path })),
          // Retirement runs after the commit, so its targets and SQL runner are admitted here, before any effect.
          ...next.terminatingAccounts.flatMap(account => account.retire.map(entry => entry.action)),
        ],
      }
    }

    // Preflight MUST run before any executor read/write/action or DB/snapshot creation.
    let mailAuth = opts.mailAuth ?? null
    let compiled = compileMail(mailAuth)
    if (opts.effectAuthority && compiled.terminatingAccounts.length) {
      return fail('PRECONDITION_FAILED', 'pending account retirements require a separate reconciliation before provisioning', { stateChanged: false })
    }
    let filesChecksum = computeFilesChecksum(compiled.files)
    await this.deps.executor.preflight(preflightOf(compiled, filesChecksum))
    const removedPathsFor = (files: readonly RenderedFile[]): string[] => {
      const paths = new Set(files.map(file => file.path))
      return (previousManifest?.files ?? []).filter(file => !paths.has(file.path)).map(file => file.path)
    }
    let validatedDnsDigest: string | undefined
    const validateDnsCandidate = async (): Promise<void> => {
      const zoneDir = this.deps.zoneDir ?? DEFAULT_DNS_ZONE_DIR
      const removedPaths = removedPathsFor(compiled.files)
      const digest = sha256Text(JSON.stringify({
        files: compiled.files.filter(file => isManagedDnsPath(file.path, zoneDir)),
        removedPaths: removedPaths.filter(path => isManagedDnsPath(path, zoneDir)),
      }))
      if (digest === validatedDnsDigest) return
      await runGenerationDnsHook({ phase: 'validate', native: isRealLinuxExecutor, provider: this.dnsPublication, files: compiled.files, removedPaths, zoneDir })
      validatedDnsDigest = digest
    }
    await validateDnsCandidate()
    await assertMailForwardingUnchanged()
    if (compiled.localMailOptions.tls) {
      const tls = compiled.localMailOptions.tls
      const cert = await this.deps.executor.readFile(tls.certFile)
      const key = await this.deps.executor.readFile(tls.keyFile)
      // Keep public submission off until the hostname's saved certificate is present.
      mailTls = cert !== null && key !== null ? tls : null
      if (cert !== null && key !== null) services.assertKeyPair(cert, key)
    }
    if (!this.deps.ioDevices?.length) accountIoDevices = await resolveAccountIoDevices(this.deps.executor, snapshot.accounts, this.deps.quotaFilesystem ?? '/home')
      ?? new Map(snapshot.accounts.map(account => [account.id, []]))
    if (compiled.localMail) mailFx = await readMailfxRenderInput(this.deps.store.rootDir, snapshot, this.deps.os.family, argv => this.deps.executor.runCommand(argv))
    if (!('mailAuth' in opts)) {
      mailAuth = (await this.journal.runHostPreparation({
        operation: 'opendkim', actor, stateChecksum: snapshot.checksum,
        domainsSha256: sha256Text(JSON.stringify([...new Set(mailDomains)].sort())),
      }, this.deps.executor, executor => ensureOpenDkimSigning(executor, mailDomains))).signing
    }
    const zoneDir = this.deps.zoneDir ?? '/var/lib/powerdns/zones'
    const previousZones = new Map<string, string>()
    for (const zone of snapshot.zones) {
      const path = `${zoneDir}/${zone.name}.zone`
      try {
        const text = await this.deps.executor.readFile(path)
        if (text !== null) previousZones.set(path, text)
      } catch { /* An unreadable zone file keeps the serial already in state. */ }
    }
    if (snapshot.server) {
      if (isRealLinuxExecutor) ftpServer = await observeFtpHost(this.deps.executor, this.deps.os, this.deps.store.rootDir)
      if (isRealLinuxExecutor) mariadbServer = await observeMariadbHost(this.deps.executor, this.deps.store.rootDir)
      if (isRealLinuxExecutor) databaseClientHost = await readDbClientHost(path => this.deps.executor.readFile(path))
      if (isRealLinuxExecutor) phpMyAdminAccess = await observePhpMyAdminHost(this.deps.executor, this.deps.os, this.deps.store.rootDir, snapshot.server.settings)
      if (isRealLinuxExecutor) dbQuotaLocks = await readDbQuotaLocks(this.deps.store.rootDir)
      etcHosts = await this.deps.executor.readFile('/etc/hosts')
      if (serverOperations.systemMail) serverOperations.etcAliases = await this.deps.executor.readFile(system.SYSTEM_ALIASES_PATH)
      observedHostname = await this.deps.executor.readFile(KERNEL_HOSTNAME_PATH)
      kernelHostname = observedHostname?.trim() ?? null
      if (this.deps.os.family === 'rhel') selinux = await this.deps.executor.readFile(SELINUX_ENFORCE_PATH) !== null
      if (isRealLinuxExecutor) sshdRunning = sshdObservedRunning((await this.deps.executor.runCommand(sshdStateArgv(this.deps.os))).stdout)
      // The binary that runs the config test reports its release on stderr.
      const version = await this.deps.executor.runCommand([edge.nginxBinary(this.deps.os), '-v'])
      nginxHttp2 = (version.ok ? edge.nginxHttp2Style(version.stderr) : null)
        ?? fail('PRECONDITION_FAILED', 'the installed nginx version could not be observed', { stateChanged: false })
      ipAliases = { interfaces: await readServerInterfaces(argv => this.deps.executor.runCommand(argv)), managed: parseManagedAliases(await this.deps.executor.readFile(IP_ALIASES_UNIT_PATH)) }
    }
    const refreshed = compileMail(mailAuth, previousZones)
    const nextChecksum = computeFilesChecksum(refreshed.files)
    // Observations can change only the actions (an alias to unbind, SELinux), so both are compared.
    const actionsChanged = hostEffectsChecksum([...refreshed.preActions, ...refreshed.postActions]) !== hostEffectsChecksum([...compiled.preActions, ...compiled.postActions])
    if (nextChecksum !== filesChecksum || actionsChanged) {
      compiled = refreshed
      filesChecksum = nextChecksum
      await this.deps.executor.preflight(preflightOf(compiled, filesChecksum))
      await validateDnsCandidate()
    }

    // Desired-state changes that only produce host actions (databases, quotas, runtime units) keep the same
    // rendered files, so the unchanged-file shortcut must also compare the ordered action list.
    const effectsChecksum = hostEffectsChecksum([...compiled.preActions, ...compiled.postActions])
    let repairedDriftCount = 0
    if (
      !opts.force &&
      // A terminating account still has its removal pending, even when the rendered host already omits it.
      compiled.terminatingAccounts.length === 0 &&
      currentGen &&
      currentGen.checksum === filesChecksum &&
      previousManifest?.effectsChecksum === effectsChecksum
    ) {
      const drift = await detectHostDrift(this.deps.executor, previousManifest)
      const mailDrift = compiled.localMail && await localMailNeedsUpdate(this.deps.executor, this.deps.os, compiled.localMailOptions)
      await assertMailForwardingUnchanged()
      if (!drift.hasDrift && !drift.manifestMissing && !mailDrift) {
        await runGenerationDnsHook({ phase: 'verify', native: isRealLinuxExecutor, provider: this.dnsPublication, files: compiled.files, removedPaths: removedPathsFor(compiled.files), zoneDir: this.deps.zoneDir })
        await this.releaseVerifiedIps(snapshot)
        return { status: 'noop', generation: currentGen, stateChecksum: snapshot.checksum, ...observedKernel() }
      }
      repairedDriftCount = drift.items.length + (mailDrift ? 1 : 0)
    }

    // Once per new document root, so it stays out of the effects checksum that decides a no-op.
    if (selinux) compiled.preActions.push(...newDocRootContextActions(snapshot, appliedSnapshot))
    compiled.postActions.push(...siteQuotaActions(snapshot.domains, appliedSnapshot?.domains ?? []))

    await assertHostEffectAuthority(this.deps.executor)
    const pendingGen = await createGeneration(this.deps.db, {
      checksum: filesChecksum,
      actor,
    })

    const activePreActionSet = Array.isArray(previousManifest?.preActionHashes)
      ? new Set(previousManifest.preActionHashes)
      : currentGen && appliedSnapshot
        ? new Set(compileDesiredGeneration(appliedSnapshot, {
          os: this.deps.os,
          ...(this.deps.managementHosts ? { managementHosts: this.deps.managementHosts } : {}),
          ...(managementPorts ? { managementPorts } : {}),
          ...(this.deps.davIngress ? { davIngress: this.deps.davIngress } : {}),
          ...(this.deps.panelRedirects && redirection.panelPaths ? { panelRedirects: this.deps.panelRedirects } : {}),
          ...(accountPages ? { accountPages } : {}),
          quotaFilesystems,
          quotaFilesystem: this.deps.quotaFilesystem ?? null,
          ...(this.deps.ioDevices && { ioDevices: this.deps.ioDevices }),
          ...(accountIoDevices ? { ioDevicesByAccount: accountIoDevices } : {}),
          ...(this.deps.zoneDir && { zoneDir: this.deps.zoneDir }),
          ...(mailAuth ? { mailAuth } : {}),
          mailForwarding,
          mailFx,
          ...(mailTls !== undefined ? { mailTls } : {}),
          secEdge,
          compilerAccess,
          sourceBuildHook,
          svcHost,
          nfsClients,
          panelLogRotateDays: panelRotateDays,
          ...(trustedProxyAuthority ? { trustedProxyAuthority } : {}),
          runtime: (await readRuntimeGeneration(this.deps.store.rootDir, currentGen.id).catch(() => null)) ?? new Map(),
          containerRegistries,
          retirements,
          accountEdge,
          ...(etcHosts !== undefined ? { etcHosts } : {}),
          ...(observedHostname !== undefined ? { observedHostname } : {}),
          ...(selinux !== undefined ? { selinux } : {}),
          ...(nginxHttp2 && { nginxHttp2 }),
          ...(ipAliases && { ipAliases }),
          remoteServiceIps,
          serverOperations,
          ...(mailLimitPolicy !== undefined && { mailLimitPolicy }),
          ...(ftpServer && { ftpServer: { ...ftpServer, roleEnabled: ftpRoleEnabled } }),
          ...(mariadbServer && { mariadbServer }),
          ...(databaseClientHost && { databaseClientHost }),
          ...(phpMyAdminAccess && { phpMyAdminAccess }),
          ...(dbQuotaLocks && { dbQuotaLocks }),
          now: new Date(),
        }).preActions.map(action => sha256Text(JSON.stringify(action))))
        : null
    const preActionsRequireVerification = isRealLinuxExecutor && (
      Boolean(opts.effectAuthority)
      || activePreActionSet === null
      || compiled.preActions.some(action => !activePreActionSet.has(sha256Text(JSON.stringify(action))))
    )

    const candidateManifest = buildGenerationManifest({
      generationId: pendingGen.id,
      stateChecksum: snapshot.checksum,
      filesChecksum,
      effectsChecksum,
      preActions: compiled.preActions,
      actor,
      files: compiled.files,
      postActions: compiled.postActions,
      os: this.deps.os,
    })
    const manifestDiff = diffManifests(previousManifest, candidateManifest)

    // Stage 1: Render, capture previous file backups, and stage candidate files in isolated directory
    this.emitStage(pendingGen.id, 'render', 'running', scope, `Rendering ${compiled.files.length} files`)
    try {
      await assertMailForwardingUnchanged()
      // Persist exactly the state that produced these files. The store rejects
      // a revision advanced during preflight before any live host activation.
      await assertHostEffectAuthority(this.deps.executor)
      await this.deps.store.saveGenerationSnapshot(pendingGen.id, snapshot)
      if (JSON.stringify(savedRuntimes(await readRuntimeRegistries(this.deps.store.rootDir, snapshot.accounts))) !== runtimeText) {
        fail('CONFLICT', 'Saved runtime services changed during reconciliation; retry the current configuration')
      }
      await assertHostEffectAuthority(this.deps.executor)
      await saveRuntimeGeneration(this.deps.store.rootDir, pendingGen.id, runtime)
    } catch (err) {
      const errorMsg = (err instanceof Error ? err.message : String(err)).slice(0, 2000)
      await markFailed(this.deps.db, pendingGen.id, errorMsg)
      this.emitStage(pendingGen.id, 'render', 'failed', scope, errorMsg)
      throw err
    }

    const managedMailFiles: RenderedFile[] = compiled.localMail || previousManifest?.files.some(file => file.path.startsWith(`${this.deps.os.paths.postfixDir}/xpanel/`))
      ? [
        ...['main.cf', 'master.cf'].map(name => ({ path: `${this.deps.os.paths.postfixDir}/${name}`, content: '', mode: 0o644, owner: 'root', group: 'root' })),
        services.renderDovecotAuthConf(this.deps.os), services.renderDovecotSpecialUseConf(this.deps.os), services.renderDovecotQuotaConf(this.deps.os),
      ] : []
    const previousFilesBackup = await this.capturePreviousFilesBackup(
      [...compiled.files, ...managedMailFiles],
      manifestDiff.removed,
      previousManifest,
    )

    const now = new Date().toISOString()
    const journalRecord: ReconcileJournalRecord = {
      schemaVersion: 1,
      journalId: randomUUID(),
      generationId: pendingGen.id,
      previousActiveGenerationId: currentGen?.id ?? null,
      actor,
      stateChecksum: snapshot.checksum,
      filesChecksum,
      phase: 'stage',
      startedAt: now,
      updatedAt: now,
      candidateManifest,
      previousManifest,
      diff: manifestDiff,
      previousFilesBackup,
      completedPreActions: 0,
      preActionsNeedVerification: false,
      switchedFilePaths: [],
      removedFilePaths: [],
      stoppedObsoleteUnits: [],
      completedPostActions: 0,
      reloadedUnits: [],
      verifiedUnits: [],
      error: null,
      ...(compiled.hostname && typeof observedHostname === 'string' ? { previousKernelHostname: observedHostname.trim() } : {}),
    }

    try {
      await assertHostEffectAuthority(this.deps.executor)
      await this.journal.saveJournal(journalRecord)
      await assertHostEffectAuthority(this.deps.executor)
      await this.journal.stageCandidateFiles(pendingGen.id, compiled.files, candidateManifest)
      this.emitStage(pendingGen.id, 'render', 'passed', scope)
      await this.invokePhaseHook('stage', journalRecord)

      // Stage 2: Validate every staged syntax input before native prerequisites (A19).
      journalRecord.phase = 'test'
      await this.journal.saveJournal(journalRecord)
      this.emitStage(pendingGen.id, 'test', 'running', scope, `Running ${compiled.tests.length} config tests`)
      const stagedFiles = await this.journal.verifyStagedCandidateIntegrity(pendingGen.id, candidateManifest)
      await this.invokePhaseHook('test', journalRecord)

      let preActionsExecutedDuringTest = false
      const syntaxResults = compiled.tests.map(test => ({ test, result: validateStagedCandidateSyntax(test, stagedFiles) }))
      const syntaxFailure = syntaxResults.find(entry => !entry.result.ok)
      // A later malformed file must reject the entire candidate before an earlier daemon
      // test has a chance to provision identities or directories on the live host.
      for (const { test, result: stagedSyntax } of syntaxFailure ? [syntaxFailure] : syntaxResults) {
        let res: { ok: boolean; code: number; stdout: string; stderr: string }
        if (!stagedSyntax.ok) {
          res = { ok: false, code: 1, stdout: '', stderr: stagedSyntax.stderr }
        } else {
          if (isRealLinuxExecutor && !preActionsExecutedDuringTest) {
            await runJournaledPreActions(journalRecord, compiled.preActions, this.deps.executor,
              record => this.journal.saveJournal(record), true, preActionsRequireVerification)
            preActionsExecutedDuringTest = true
          }
          const fpmConfigIdx = isRealLinuxExecutor ? test.argv.indexOf('--fpm-config') : -1
          if (fpmConfigIdx !== -1 && test.argv[fpmConfigIdx + 1]) {
            const masterPath = test.argv[fpmConfigIdx + 1]!
            const poolPath = masterPath.replace(/\.conf$/, '.pool.conf')
            const stagedMaster = stagedFiles.find((f) => f.path === masterPath)
            const stagedPool = stagedFiles.find((f) => f.path === poolPath)
            if (stagedMaster && stagedPool) {
              const tmpFpmDir = `/tmp/xpanel-fpm-stage-${pendingGen.id}-${randomUUID().slice(0, 8)}`
              await mkdir(tmpFpmDir, { recursive: true, mode: 0o755 })
              await chmod(tmpFpmDir, 0o755)
              try {
                const tmpPoolPath = join(tmpFpmDir, 'pool.conf')
                const tmpMasterPath = join(tmpFpmDir, 'master.conf')
                await writeFile(tmpPoolPath, stagedPool.content, { mode: 0o644 })
                await chmod(tmpPoolPath, 0o644)
                const rewrittenMaster = stagedMaster.content.replace(
                  `include = ${poolPath}`,
                  `include = ${tmpPoolPath}`,
                )
                await writeFile(tmpMasterPath, rewrittenMaster, { mode: 0o644 })
                await chmod(tmpMasterPath, 0o644)
                const testArgv = [...test.argv]
                testArgv[fpmConfigIdx + 1] = tmpMasterPath
                res = await this.deps.executor.runTest({ name: test.name, argv: testArgv })
              } finally {
                await rm(tmpFpmDir, { recursive: true, force: true })
              }
            } else {
              res = await this.deps.executor.runTest(test)
            }
          } else if (isRealLinuxExecutor && test.name === services.SIEVE_CONFIG_TEST) {
            // compile every staged script in a root-only copy: the live paths are account-writable
            const checkDir = await mkdtemp('/tmp/xpanel-sieve-check-')
            try {
              for (const file of stagedFiles) {
                if (!file.path.endsWith('/.dovecot.sieve')) continue
                const box = dirname(file.path)
                await writeFile(join(checkDir, `${basename(box)}@${basename(dirname(box))}.sieve`), file.content, { mode: 0o600 })
              }
              res = await this.deps.executor.runTest({ name: test.name, argv: [...test.argv.slice(0, -1), checkDir] })
            } finally {
              await rm(checkDir, { recursive: true, force: true })
            }
          } else {
            res = await this.deps.executor.runTest(test)
          }
        }

        candidateManifest.testResults.push({
          name: test.name,
          argv: [...test.argv],
          ok: res.ok,
          code: res.code,
          testedConfigChecksum: filesChecksum,
          at: new Date().toISOString(),
        })

        if (!res.ok) {
          const errorMsg = `${test.name} failed (exit ${res.code}): ${res.stderr || res.stdout}`.slice(0, 2000)
          const verificationRequired = hasUnverifiedPreActions(journalRecord)
          if (!verificationRequired) await this.journal.cleanupStagingDir(pendingGen.id)
          journalRecord.phase = verificationRequired ? 'needs_attention' : 'failed'
          journalRecord.error = errorMsg
          await this.journal.saveJournal(journalRecord)

          this.emitStage(pendingGen.id, 'test', 'failed', scope, errorMsg)
          const failedGen = await markFailed(this.deps.db, pendingGen.id, errorMsg)
          const audit = await appendAudit(this.deps.db, {
            actor,
            action: 'reconcile.failed',
            target: `generation:${pendingGen.id}`,
            detail: { failedTest: test.name, error: errorMsg, stateChanged: verificationRequired, verificationRequired },
            outcome: 'failed',
          })
          this.emit({
            id: randomUUID(),
            at: new Date().toISOString(),
            kind: 'reconcile.failed',
            scope,
            data: { generationId: pendingGen.id, failedTest: test.name, error: errorMsg },
          })
          this.emit({ id: randomUUID(), at: audit.at, kind: 'audit.entry', scope, data: audit })
          return { status: 'failed', generation: failedGen, failedTest: test.name, error: errorMsg, ...observedKernel(),
            stateChanged: verificationRequired,
            ...(verificationRequired && { verificationRequired: true as const }) }
        }
      }

      // Freeze & re-verify staged candidate integrity before switching live paths (R02.8)
      const verifiedStagedFiles = await this.journal.verifyStagedCandidateIntegrity(
        pendingGen.id,
        candidateManifest,
      )
      await markTested(this.deps.db, pendingGen.id)
      this.emitStage(pendingGen.id, 'test', 'passed', scope)

      // Stage 3, 4 & 5: Activate (Switch live files & remove obsolete owned files), Reload, and Verify Health
      let currentStageLabel: 'switch' | 'reload' | 'verify' = 'switch'
      try {
        await assertMailForwardingUnchanged()
        journalRecord.phase = 'activate'
        await this.journal.saveJournal(journalRecord)
        this.emitStage(pendingGen.id, 'switch', 'running', scope)

        if (!preActionsExecutedDuringTest) {
          await runJournaledPreActions(journalRecord, compiled.preActions, this.deps.executor,
            record => this.journal.saveJournal(record), isRealLinuxExecutor, preActionsRequireVerification)
        }

        for (const file of verifiedStagedFiles) {
          await this.deps.executor.writeFile(file)
          journalRecord.switchedFilePaths.push(file.path)
        }

        const removedMail = manifestDiff.removed.some((file) =>
          file.path.includes('/postfix/xpanel/')
          || file.path.endsWith('/11-xpanel-mailboxes.conf')
          || (file.path.endsWith('.passwd') && file.path.includes('/dovecot/')))
        if (compiled.localMail) {
          await applyPostfixLocalDelivery(this.deps.executor, this.deps.os, undefined, compiled.localMailOptions)
        } else if (removedMail) {
          await retirePostfixLocalDelivery(this.deps.executor, this.deps.os)
          await this.deps.executor.runAction({ kind: 'systemd', verb: 'reload', unit: this.deps.os.services.postfix })
          await this.deps.executor.runAction({ kind: 'systemd', verb: 'reload', unit: this.deps.os.services.dovecot })
        }

        for (const unit of manifestDiff.removedUnits) {
          await this.deps.executor.runAction({ kind: 'systemd', verb: 'stop', unit })
          await this.deps.executor.runAction({ kind: 'systemd', verb: 'disable', unit })
          journalRecord.stoppedObsoleteUnits.push(unit)
        }

        for (const obsolete of manifestDiff.removed) {
          await this.deps.executor.removePath(obsolete.path)
          journalRecord.removedFilePaths.push(obsolete.path)
        }

        // The tests before the switch read the live tree; the switched web server files are tested here, before any reload.
        for (const test of compiled.tests.filter(item => item.name === 'nginx' || item.name === 'apache')) {
          const res = await this.deps.executor.runTest(test)
          if (!res.ok) throw new StageFailureError(test.name, `${test.name} failed (exit ${res.code}): ${res.stderr || res.stdout}`.slice(0, 2000))
        }

        await this.journal.saveJournal(journalRecord)
        await this.invokePhaseHook('activate', journalRecord)
        this.emitStage(pendingGen.id, 'switch', 'passed', scope)

        // Stage 4: Reload affected services
        currentStageLabel = 'reload'
        journalRecord.phase = 'reload'
        await this.journal.saveJournal(journalRecord)
        this.emitStage(pendingGen.id, 'reload', 'running', scope)

        if (
          manifestDiff.removedUnits.length > 0 &&
          !compiled.postActions.some((a) => a.kind === 'systemd-daemon-reload')
        ) {
          await this.deps.executor.runAction({ kind: 'systemd-daemon-reload' })
        }

        for (const action of compiled.postActions) {
          try {
            await this.deps.executor.runAction(action)
          } catch (actionErr) {
            console.error('xpanel-agent reconcile post-action failed:', JSON.stringify(action).slice(0, 400))
            const unitLabel =
              action.kind === 'systemd'
                ? action.unit
                : action.kind === 'exec'
                  ? (action.argv[0] ?? 'exec')
                  : action.kind
            throw new StageFailureError(unitLabel, (actionErr as Error).message)
          }
          journalRecord.completedPostActions++
          if (
            action.kind === 'systemd' &&
            (action.verb === 'reload' || action.verb === 'restart' || action.verb === 'start') &&
            !journalRecord.reloadedUnits.includes(action.unit)
          ) {
            journalRecord.reloadedUnits.push(action.unit)
          }
        }

        await this.journal.saveJournal(journalRecord)
        await this.invokePhaseHook('reload', journalRecord)
        this.emitStage(pendingGen.id, 'reload', 'passed', scope)

        // Stage 5: Post-reload service health probes & final commit
        currentStageLabel = 'verify'
        journalRecord.phase = 'verify'
        await this.journal.saveJournal(journalRecord)
        this.emitStage(pendingGen.id, 'verify', 'running', scope)

        for (const unit of journalRecord.reloadedUnits) {
          // One-shot cron services are inactive between timer triggers; the timer is the managed unit.
          if (isOneShotCronService(unit) || unit.endsWith('.slice')) continue
          const probe = await this.verifyUnitHealth(unit, pendingGen.id)
          if (!probe.ok) {
            throw new StageFailureError(
              unit,
              `post-reload health probe failed for ${unit}: ${probe.error ?? 'service unhealthy'}`,
            )
          }
          journalRecord.verifiedUnits.push(unit)
        }
        if (compiled.hostname) {
          const observed = (await this.deps.executor.readFile(KERNEL_HOSTNAME_PATH))?.trim() ?? null
          kernelHostname = observed
          if (observed !== compiled.hostname) throw new StageFailureError('hostname', `the system host name was not applied: expected ${compiled.hostname}, observed ${observed ?? 'none'}`)
        }
        await runGenerationDnsHook({ phase: 'verify', native: isRealLinuxExecutor, provider: this.dnsPublication, files: verifiedStagedFiles,
          removedPaths: manifestDiff.removed.map(file => file.path), zoneDir: this.deps.zoneDir })

        await this.journal.saveJournal(journalRecord)
        await this.invokePhaseHook('verify', journalRecord)
      } catch (stageErr) {
        if (stageErr instanceof SimulatedProcessCrashWrapper) {
          throw stageErr
        }
        const failedUnit =
          stageErr instanceof StageFailureError ? stageErr.failedUnit : currentStageLabel
        const errorMsg = (stageErr as Error).message.slice(0, 2000)
        this.emitStage(pendingGen.id, currentStageLabel, 'failed', scope, errorMsg)

        // Restoring captured files must not depend on a request authority that may have just lapsed.
        const rb = await withoutHostEffectAuthority(() => this.rollbackLiveHostAndRecord(journalRecord, failedUnit, errorMsg, scope))
        return {
          status: 'failed',
          rolledBack: !rb.verificationRequired,
          restoredGenerationId: rb.restoredActiveGen?.id ?? null,
          generation: rb.rolledBackGen,
          failedTest: failedUnit,
          error: errorMsg,
          ...(rb.kernelHostname !== undefined ? { kernelHostname: rb.kernelHostname } : observedKernel()),
          ...(rb.verificationRequired && { stateChanged: true as const, verificationRequired: true as const }),
        }
      }

      await assertHostEffectAuthority(this.deps.executor)
      // Once admitted, complete the existing activation/manifest/projection
      // protocol before acknowledging authority again. A loss cannot be called
      // an undone commit; the outer scope reports it as requiring verification.
      const appliedGen = await activate(this.deps.db, pendingGen.id)
      await this.journal.writeManifest(candidateManifest)

      // Committed before any user is deleted: neither a later failure nor a crash can roll back
      // configuration files that belong to a removed user.
      journalRecord.phase = 'committed'
      await this.journal.saveJournal(journalRecord)
      await this.journal.cleanupStagingDir(pendingGen.id)

      const incompleteRetirements = await this.retireAccounts(compiled.terminatingAccounts)
      await this.releaseVerifiedIps(snapshot)
      const finalSnapshot =
        compiled.terminatingAccounts.length > 0 ? await this.deps.store.readSnapshot() : snapshot
      await reindexFromState(this.deps.db, finalSnapshot)

      this.emitStage(pendingGen.id, 'verify', 'passed', scope)

      const durationMs = Date.now() - startMs
      const audit = await appendAudit(this.deps.db, {
        actor,
        action: 'reconcile.applied',
        target: `generation:${appliedGen.id}`,
        detail: {
          stateChecksum: finalSnapshot.checksum,
          filesCount: compiled.files.length,
          removedFilesCount: manifestDiff.removed.length,
          repairedDriftCount,
          durationMs,
          ...(incompleteRetirements.length > 0 && { incompleteRetirements }),
        },
        outcome: 'ok',
      })
      this.emit({
        id: randomUUID(),
        at: new Date().toISOString(),
        kind: 'reconcile.applied',
        scope,
        data: {
          generationId: appliedGen.id,
          stateChecksum: finalSnapshot.checksum,
          filesCount: compiled.files.length,
          durationMs,
        },
      })
      this.emit({ id: randomUUID(), at: audit.at, kind: 'audit.entry', scope, data: audit })
      return {
        status: 'applied',
        generation: appliedGen,
        filesCount: compiled.files.length,
        durationMs,
        removedFilesCount: manifestDiff.removed.length,
        repairedDriftCount,
        ...observedKernel(),
        ...(incompleteRetirements.length > 0 && { incompleteRetirements }),
      }
    } catch (err) {
      if (err instanceof SimulatedProcessCrashWrapper) {
        throw err.originalError
      }
      // An admitted operation whose authority stopped it before any host primitive started applied nothing:
      // the journaled action never ran, so the generation fails cleanly and the next reconcile proceeds.
      if (journalRecord.phase === 'test' && hasUnverifiedPreActions(journalRecord) && hostEffectsStarted(this.deps.executor) === false) {
        delete journalRecord.pendingPreAction
        journalRecord.preActionsNeedVerification = false
        journalRecord.phase = 'failed'
        journalRecord.error = `stopped before any host effect: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2000)
        await this.journal.cleanupStagingDir(pendingGen.id)
        await this.journal.saveJournal(journalRecord)
        await markFailed(this.deps.db, pendingGen.id, journalRecord.error)
        return fail('PRECONDITION_FAILED', journalRecord.error, { generationId: pendingGen.id, stateChanged: false, reason: HOST_EFFECT_NOT_STARTED })
      }
      if (journalRecord.phase === 'test' && hasUnverifiedPreActions(journalRecord)) {
        journalRecord.phase = 'needs_attention'
        journalRecord.error = `native prerequisite or config check outcome requires verification: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2000)
        await this.journal.saveJournal(journalRecord)
        await markFailed(this.deps.db, pendingGen.id, journalRecord.error)
        return fail('PRECONDITION_FAILED', journalRecord.error, {
          generationId: pendingGen.id, stateChanged: true, verificationRequired: true,
        })
      }
      throw err
    }
  }

  /**
   * Restores the desired-state tree of a previous generation and reconciles the host to it.
   */
  async rollbackToGeneration(genId: number, actor = 'root', guard?: GenerationRollbackGuard): Promise<ReconcileResult & { rollbackTargetGenerationId: number; rollbackTargetChecksum: string; stateChanged: true; verificationRequired?: true; details?: { stateChanged: true; verificationRequired: true } }> {
    if (!guard || typeof guard.authorize !== 'function') return fail('PRECONDITION_FAILED', 'guarded generation restore requires trusted authorization and reviewed state metadata', { stateChanged: false })
    const request = parseGenerationRollbackRequest(genId, guard.request)
    return withLifecycleWriterAdmission(() => withGenerationReconciliationLease(this.deps.store.rootDir, () => this.rollbackToGenerationAdmitted(genId, actor, { ...guard, request })))
  }

  private async rollbackToGenerationAdmitted(genId: number, actor: string, guard: GenerationRollbackGuard): Promise<ReconcileResult & { rollbackTargetGenerationId: number; rollbackTargetChecksum: string; stateChanged: true; verificationRequired?: true; details?: { stateChanged: true; verificationRequired: true } }> {
    await this.journal.assertNoUnresolvedPreparation()
    if (await this.journal.readActiveJournal()) return fail('PRECONDITION_FAILED', 'an existing reconciliation journal requires review before restoring desired state', { stateChanged: false })
    let restored = false
    let expectedRestoredMailForwarding: MailForwardingConfiguration | undefined
    let expectedRestoredRuntime: Map<string, RuntimeRegistry> | undefined
    try {
      const snapshot = await this.deps.store.restoreGenerationSnapshot(genId, {
        expectedRevision: guard.request.expectedCurrentStateRevision,
        restoreGuard: async (current, targetSource) => {
          await guard.authorize()
          const [active, target] = await Promise.all([latestActive(this.deps.db), getGeneration(this.deps.db, genId)])
          const appliedSource = active ? await this.deps.store.readValidatedGenerationSnapshot(active.id) : null
          assertGenerationRollbackPreconditions(genId, guard.request, { current, active, target, appliedSource })
          const [activeManifest, targetManifest] = await Promise.all([this.journal.readManifest(active!.id), this.journal.readManifest(genId)])
          if (!generationSourceIsLinked(active!, appliedSource, activeManifest) || !generationSourceIsLinked(target!, targetSource, targetManifest)) return fail('CONFLICT', 'generation source linkage requires review before restoration', { stateChanged: false })
          const forwarding = await readMailForwardingConfiguration(this.deps.store.rootDir, targetSource)
          const mapPaths = new Set(Object.values(services.postfixMapPaths(this.deps.os)).filter(path => path !== services.postfixMapPaths(this.deps.os).dir))
          const desiredMail = compileDesiredGeneration(targetSource, { os: this.deps.os, mailForwarding: forwarding }).files.filter(file => mapPaths.has(file.path))
          const savedMail = targetManifest!.files.filter(file => mapPaths.has(file.path))
          // A StateSnapshot cannot restore the extended forwarding files. Only proceed
          // when their exact effective maps match the recorded target generation.
          if (desiredMail.length !== savedMail.length || desiredMail.some(file => savedMail.find(saved => saved.path === file.path)?.sha256 !== sha256Text(file.content))) {
            return fail('PRECONDITION_FAILED', 'Target generation mail forwarding cannot be restored from the current saved records; explicit review is required', { stateChanged: false })
          }
          expectedRestoredMailForwarding = forwarding
          // Runtime registries sit outside the StateSnapshot too: restore the set the target generation was compiled from.
          const runtimeTarget = await readRuntimeGeneration(this.deps.store.rootDir, genId)
          if (!runtimeTarget && Object.keys(savedRuntimes(await readRuntimeRegistries(this.deps.store.rootDir, current.accounts))).length > 0) {
            return fail('PRECONDITION_FAILED', 'Target generation predates saved runtime services; explicit review is required', { stateChanged: false })
          }
          expectedRestoredRuntime = new Map(Object.entries(savedRuntimes(runtimeTarget ?? new Map())).filter(([id]) => targetSource.accounts.some(account => account.id === id)))
          await guard.authorize()
          await appendAudit(this.deps.db, { actor, action: 'generation.restore_requested', target: 'generation:' + String(genId),
            detail: { expectedCurrentGenerationId: guard.request.expectedCurrentGenerationId, expectedCurrentStateRevision: guard.request.expectedCurrentStateRevision,
              rollbackTargetGenerationId: genId, rollbackTargetChecksum: guard.request.expectedTargetChecksum }, outcome: 'ok' })
        },
      })
      restored = true
      if (expectedRestoredRuntime) await restoreRuntimeRegistries(this.deps.store.rootDir, expectedRestoredRuntime)
      if (snapshot.revision === undefined) return fail('PRECONDITION_FAILED', 'the restored desired-state revision is unavailable', { stateChanged: true, verificationRequired: true })
      const result = await this.reconcileAdmitted({ force: true, actor, expectedRestoredState: { revision: snapshot.revision, checksum: snapshot.checksum }, ...(expectedRestoredMailForwarding ? { expectedRestoredMailForwarding } : {}), ...(expectedRestoredRuntime ? { expectedRestoredRuntime } : {}) })
      const metadata = { rollbackTargetGenerationId: genId, rollbackTargetChecksum: guard.request.expectedTargetChecksum, stateChanged: true as const }
      if (result.status !== 'applied') return { ...result, ...metadata, verificationRequired: true, details: { stateChanged: true, verificationRequired: true } }
      const [active, source] = await Promise.all([latestActive(this.deps.db), this.deps.store.readValidatedGenerationSnapshot(result.generation.id)])
      if (active?.id !== result.generation.id || active.checksum !== result.generation.checksum || source?.checksum !== snapshot.checksum) return fail('CONFLICT', 'the restored generation source could not be confirmed', { stateChanged: true, verificationRequired: true })
      return { ...result, ...metadata }
    } catch (error) {
      if (restored || error instanceof AggregateError || isStateDirectoryDurabilityError(error)) return fail('PRECONDITION_FAILED', 'generation restoration requires state review before continuing', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
      throw error
    }
  }

  /**
   * Samples cheap cgroup v2 slice counters for every active account, stores them in SQLite
   * `metrics_history`, and broadcasts `metrics.tick` live events for WebSocket subscribers.
   */
  async collectMetrics(): Promise<number> {
    return withLifecycleWriterAdmission(() => this.collectMetricsAdmitted())
  }

  private async collectMetricsAdmitted(): Promise<number> {
    const accounts = await this.deps.store.listAccounts({ status: 'active' })
    let count = 0
    for (const acc of accounts) {
      const m = await this.deps.executor.readSliceMetrics(acc.uid)
      if (!m) continue
      await recordMetricsSample(this.deps.db, {
        scope: 'account',
        accountId: acc.id,
        cpuPercent: Number((m.cpuUsageUsec / 1_000_000).toFixed(2)),
        memoryMb: Math.max(0, Math.round(m.memoryCurrentBytes / (1024 * 1024))),
        ioReadBps: Math.max(0, Math.round(m.ioReadBytes)),
        ioWriteBps: Math.max(0, Math.round(m.ioWriteBytes)),
        processes: Math.max(0, Math.round(m.pidsCurrent)),
      })
      count++
      this.emit({
        id: randomUUID(),
        at: new Date().toISOString(),
        kind: 'metrics.tick',
        scope: { accountId: acc.id, resellerId: acc.ownerId },
        data: {
          uid: acc.uid,
          cpuUsageUsec: m.cpuUsageUsec,
          memoryCurrentBytes: m.memoryCurrentBytes,
          ioReadBytes: m.ioReadBytes,
          ioWriteBytes: m.ioWriteBytes,
          pidsCurrent: m.pidsCurrent,
        },
      })
    }
    return count
  }
}
