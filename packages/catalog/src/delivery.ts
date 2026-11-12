import type {
  CapabilityDelivery, CapabilityEvidence, DeliveryStage, EvidenceEnvironment,
  ProfileExclusion, ToolDefinition, ToolSpec, VerificationTarget,
} from './types.ts'

const sha256 = /^[a-f0-9]{64}$/
const stages: readonly DeliveryStage[] = ['implemented', 'integrated', 'verified']
const requiredEnvironments: Record<DeliveryStage, readonly EvidenceEnvironment[]> = {
  implemented: ['unit'],
  integrated: ['http', 'browser'],
  verified: ['linux', 'browser', 'external'],
}

const validTarget = (target: VerificationTarget): boolean => {
  if (typeof target !== 'object' || target === null || !sha256.test(target.sourceFingerprint)) return false
  if (target.artifactSha256 !== null && !sha256.test(target.artifactSha256)) return false
  return Array.isArray(target.supportedProfiles) && target.supportedProfiles.length > 0
    && target.supportedProfiles.every(profile => typeof profile === 'string' && profile.trim() === profile && profile.length > 0)
    && new Set(target.supportedProfiles).size === target.supportedProfiles.length
}

/** Owner decision 9: every tool needs all target profiles unless a reviewed entry here proves it cannot exist on one. */
export const PROFILE_EXCLUSIONS: Readonly<Record<string, ProfileExclusion>> = {
  'wheel-group-users': { profiles: ['ubuntu-22.04', 'ubuntu-24.04'], reason: 'Ubuntu grants administrator rights through the sudo group; there is no wheel group to manage.' },
  'sudo-group-users': { profiles: ['almalinux-9', 'rocky-9', 'centos-stream-9'], reason: 'Enterprise Linux grants administrator rights through the wheel group; there is no sudo group to manage.' },
}

/** Truthful availability reasons for catalog tools whose host or multi-node capability is not shipped on single-server hosts. */
export const UNIMPLEMENTED_TOOL_REASONS: Readonly<Record<string, string>> = {
  'connect-devices': 'Account-wide device setup is delivered per mailbox under xMail Connect Devices rather than on the account filters page.',
  'calendars-contacts-sharing': 'Cross-mailbox CalDAV/CardDAV ACL sharing is not enabled in the single-collection Radicale profile.',
  'reseller-acl-lists': 'Reseller privileges are assigned directly per reseller; named ACL template lists are not enabled.',
  'disk-quota-setup': 'Filesystem quota mount flags require host boot-loader and fstab provisioning during installation rather than runtime remounting.',
  'tweak-panel-php': 'xPanel runs natively on Node.js and executes no internal panel PHP runtime.',
  'nameserver-report': 'Nightly cross-zone nameserver delegation aggregation is not enabled; inspect per-zone NS records in the DNS Zone Manager.',
  'remote-service-ips': 'External authoritative nameserver and mail gateway IP bypass lists are not enabled for tenant domain creation.',
  'web-stack-builder': 'Web server MPM and stack topology are pinned by the signed OS installation profile rather than rebuilt dynamically.',
  'distro-packages': 'Arbitrary OS repository package installation is disabled; manage reviewed components in Software Center.',
  'webmail-dav-collections': 'Each mailbox provisions its default calendar and address book; custom multi-collection creation is not enabled.',
  'webmail-dav-sharing': 'Cross-mailbox calendar and address-book sharing is not enabled in the Radicale host profile.',
  'aapanel-site-reverse-proxy': 'Path-scoped custom reverse-proxy rules are not enabled; site proxy mode is managed on the Domains workspace.',
  'aapanel-proxy-project': 'Standalone Nginx proxy-only projects without a hosting domain are not enabled.',
  'aapanel-one-click-deploy': 'Automated PHP application bundle deployment is not enabled on this host.',
  'aapanel-mysql-service': 'MariaDB daemon port and data-directory relocation are pinned by the host reconciler; inspect server state on Database Servers.',
  'aapanel-node-management': 'Remote server management over panel API or SSH keys requires a multi-node lab and is unavailable on standalone hosts.',
  'aapanel-node-file-transfer': 'Direct node-to-node file transfer between linked servers is unavailable on standalone hosts.',
  'aapanel-openlitespeed-manager': 'Apache httpd with mpm-itk behind Nginx is the active web stack on this host; OpenLiteSpeed is not installed.',
  'aapanel-server-migrate': 'Automated whole-server OS migration to a remote target host requires a paired destination server and is unavailable.',
  'traffic-monitor-account': 'Live per-request visitor stream inspection is root-only; per-domain bandwidth totals are shown on Bandwidth.',
  'spam-quarantine': 'Server-held spam quarantine release and Bayesian retraining are not enabled; spam delivery uses mailbox Junk folders.',
  'database-tuning': 'MariaDB runtime variables and counters are read-only; automated my.cnf buffer-pool rewriting is not enabled.',
  'git-deployments': 'Build-pipeline release symlink hooks are not enabled; manage Git repositories on Git Version Control.',
  'app-installer': 'Automated open-source application installer packages are not configured on this host.',
  'linked-server-nodes': 'Linking peer xPanel servers requires a paired second host and is unavailable on standalone hosts.',
  'configuration-cluster': 'Pushing server configuration snapshots across peer servers requires linked cluster nodes and is unavailable on standalone hosts.',
  'dns-cluster': 'Synchronizing authoritative zones across peer nameservers requires a multi-node DNS cluster and is unavailable on standalone hosts.',
  'dns-cluster-sync': 'Cross-server DNS zone synchronization requires linked cluster peers and is unavailable on standalone hosts.',
  'live-transfer': 'Live cutover account migration requires a linked source server and is unavailable on standalone hosts.',
  'transfer-tool': 'Pulling accounts and packages from a remote server requires a paired source host and is unavailable on standalone hosts.',
  'transfer-tool-selection': 'Selecting remote accounts and packages for migration requires an active remote transfer source and is unavailable on standalone hosts.',
  'account-transfer-progress': 'Streaming remote account transfer phases requires a multi-host transfer session and is unavailable on standalone hosts.',
  'cloudflare-account': 'Managing domain proxy and cache settings through Cloudflare requires external Cloudflare API credentials and is unavailable on standalone hosts.',
  'db-server-profiles': 'Offloading tenant databases to remote MySQL or MariaDB hosts requires external database nodes and is unavailable on standalone hosts.',
  'cloudflare-integration': 'Server-wide Cloudflare partner and zone integration requires external Cloudflare API credentials and is unavailable on standalone hosts.',
  'aapanel-dns-provider-accounts': 'External cloud DNS registrar API credentials require third-party DNS provider accounts and are unavailable on standalone hosts.',
  'aapanel-provider-domains': 'Importing domains from external cloud DNS registrars requires connected third-party DNS provider accounts and is unavailable on standalone hosts.',
  'aapanel-provider-dns-records': 'Editing DNS records at external cloud DNS registrars requires connected third-party DNS provider accounts and is unavailable on standalone hosts.',
  'aapanel-auto-dns-on-site-create': 'Automatic record creation at external cloud DNS registrars on site creation requires connected third-party DNS provider accounts and is unavailable on standalone hosts.',
  'external-authentication': 'OpenID Connect single sign-on requires an external OIDC identity provider and is unavailable on standalone hosts.',
}

/** Profiles a tool must be proven on; empty (never verified) when its exclusion is malformed or leaves nothing. */
export const requiredProfiles = (
  toolId: string, target: VerificationTarget, exclusions: Readonly<Record<string, ProfileExclusion>> = PROFILE_EXCLUSIONS,
): readonly string[] => {
  const exclusion = Object.hasOwn(exclusions, toolId) ? exclusions[toolId] : undefined
  if (exclusion === undefined) return target.supportedProfiles
  const valid = typeof exclusion.reason === 'string' && exclusion.reason.trim().length > 0 && Array.isArray(exclusion.profiles)
    && exclusion.profiles.length > 0 && new Set(exclusion.profiles).size === exclusion.profiles.length
    && exclusion.profiles.every(profile => target.supportedProfiles.includes(profile))
  return valid ? target.supportedProfiles.filter(profile => !exclusion.profiles.includes(profile)) : []
}

const matchesTarget = (proof: CapabilityEvidence, spec: ToolSpec, target: VerificationTarget): boolean => {
  if (typeof proof !== 'object' || proof === null) return false
  if (proof.toolId !== spec.id || proof.acceptance !== spec.acceptance || !stages.includes(proof.stage)) return false
  if (!sha256.test(target.sourceFingerprint) || proof.sourceFingerprint !== target.sourceFingerprint) return false
  if (!target.supportedProfiles.includes(proof.profile)) return false
  if (typeof proof.runArtifact !== 'string' || !proof.runArtifact.trim() || !sha256.test(proof.runArtifactSha256)) return false
  if (!Number.isFinite(Date.parse(proof.observedAt))) return false
  if (proof.environment !== 'unit' && proof.executor !== 'real') return false
  if (proof.stage === 'implemented') return true
  return target.artifactSha256 !== null && sha256.test(target.artifactSha256)
    && proof.artifactSha256 === target.artifactSha256
}

/** Each tier requires its own results. HTTP with a fake executor cannot prove a live service. */
export const assessDelivery = (
  tool: ToolDefinition, spec: ToolSpec, observations: readonly CapabilityEvidence[],
  target: VerificationTarget | null, exclusions: Readonly<Record<string, ProfileExclusion>> = PROFILE_EXCLUSIONS,
): CapabilityDelivery => {
  if (tool.status === 'out-of-scope') {
    return { status: 'out-of-scope', reason: tool.outOfScopeReason ?? 'Outside the product scope.', evidence: [] }
  }
  if (target === null || !validTarget(target) || tool.id !== spec.id || !spec.acceptance.trim()) {
    return {
      status: 'researched',
      reason: Object.hasOwn(UNIMPLEMENTED_TOOL_REASONS, tool.id)
        ? UNIMPLEMENTED_TOOL_REASONS[tool.id]!
        : 'No source and release target with supported acceptance evidence.',
      evidence: [],
    }
  }
  const profiles = requiredProfiles(tool.id, target, exclusions)
  if (profiles.length === 0) {
    return { status: 'researched', reason: 'The reviewed profile exclusion for this capability is invalid.', evidence: [] }
  }
  const latest = new Map<string, CapabilityEvidence>()
  for (const proof of observations.filter(proof => matchesTarget(proof, spec, target) && profiles.includes(proof.profile))) {
    const key = `${proof.stage}:${proof.environment}:${proof.profile}`
    const previous = latest.get(key)
    if (previous === undefined || Date.parse(proof.observedAt) > Date.parse(previous.observedAt)
      || (Date.parse(proof.observedAt) === Date.parse(previous.observedAt) && proof.result !== 'passed')) latest.set(key, proof)
  }
  const evidence = [...latest.values()]
  let status: CapabilityDelivery['status'] = 'researched'
  for (const stage of stages) {
    const results = evidence.filter(proof => proof.stage === stage)
    if (results.some(proof => proof.result !== 'passed')) break
    // Every declared profile must supply its own complete tier. Evidence from
    // different distributions cannot fill each other's missing observations.
    if (!profiles.every(profile => {
      const environments = new Set(results.filter(proof => proof.profile === profile).map(proof => proof.environment))
      return requiredEnvironments[stage].every(environment => environments.has(environment))
    })) break
    status = stage
  }
  return {
    status,
    reason: status === 'verified'
      ? 'Acceptance observed on the target artifact in supported browser, Linux and external environments.'
      : status === 'researched' && evidence.length === 0 && Object.hasOwn(UNIMPLEMENTED_TOOL_REASONS, tool.id)
        ? UNIMPLEMENTED_TOOL_REASONS[tool.id]!
        : `Acceptance evidence is incomplete for the tier after ${status}.`,
    evidence,
  }
}
