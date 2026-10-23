import { randomBytes } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { ApacheMpm, Engine, RenderedFile } from '@xpanel/core'
import { services as rendered } from '@xpanel/render'
import { ACME_DIR, acmeTraverseAclArgv, acmeTraverseProbeArgv } from './acme-access.ts'
import { detectOs, profileFor } from './detect.ts'
import { installBundle, itkAvailable } from './install.ts'
import { parseOsRelease } from './osRelease.ts'
import type { InstallAction, InstallOptions, XpanelOsProfile } from './types.ts'
import { assertAbsolutePath, preview } from './validate.ts'

export const INSTALL_PHASES = Object.freeze([
  'preflight',
  'users-and-dirs',
  'secrets',
  'packages',
  'configs',
  'schema',
  'systemd',
  'health-probe',
] as const)

export type InstallPhase = (typeof INSTALL_PHASES)[number]

export type InstallPhaseStatus = 'started' | 'completed' | 'failed'

export interface ConfigBackupRecord {
  targetPath: string
  backupPath: string
  createdAt: string
  mode: number
  owner: string
  group: string
}

export interface SecretProvisionRecord {
  path: string
  action: 'created' | 'preserved'
  mode: number
  owner: string
  group: string
}

export interface InstallPhaseEntry {
  phase: InstallPhase
  status: InstallPhaseStatus
  at: string
  detail?: string
}

export interface InstallJournalState {
  schemaVersion: 1
  installId: string
  startedAt: string
  updatedAt: string
  osId: string
  osVersionId: string
  completedPhases: InstallPhase[]
  lastFailedPhase: InstallPhase | null
  entries: InstallPhaseEntry[]
  backups: ConfigBackupRecord[]
  secrets: SecretProvisionRecord[]
}

export interface OptInServiceSelection {
  engine?: Engine
  apacheMpm?: ApacheMpm
  phpVersions?: string[]
  withMail?: boolean
  withDns?: boolean
  withFtp?: boolean
  withMariaDb?: boolean
  withModSecurity?: boolean
}

export interface ResolvedOptInServices {
  engine: Engine
  apacheMpm: ApacheMpm
  phpVersions: string[]
  withMail: boolean
  withDns: boolean
  withFtp: boolean
  withMariaDb: boolean
  withModSecurity: boolean
}

export interface PathStatInfo {
  exists: boolean
  isSymbolicLink: boolean
  isDirectory: boolean
  isFile: boolean
  uid: number
  gid: number
  owner: string
  group: string
  mode: number
}

export interface PreflightHostProbe {
  /** Raw contents of /etc/os-release */
  osReleaseText: string
  /** Optional pre-detected profile to cross-check against /etc/os-release */
  detectedProfile?: XpanelOsProfile
  /** Active cgroup v2 controllers from /sys/fs/cgroup/cgroup.controllers */
  cgroupControllers: readonly string[]
  /** Available quota utilities on the host */
  quotaToolsAvailable: readonly string[]
  /** Currently listening TCP/UDP ports owned by non-xPanel processes */
  listeningPorts: readonly number[]
  /** Active systemd units on the host */
  activeUnits: readonly string[]
  /** Pinned Node version expected by the installer */
  expectedNodeVersion?: string
  /** Actual Node version reported by XPANEL_NODE_BIN */
  actualNodeVersion?: string
  /** Inspects host path ownership and permission bits */
  statPath: (absPath: string) => PathStatInfo
}

export interface PreflightCheckResult {
  id:
    | 'active-services'
    | 'os-release'
    | 'apache-mpm-itk'
    | 'cgroup-v2-controllers'
    | 'quota-tools'
    | 'port-conflicts'
    | 'parent-paths'
    | 'runtime-pin'
  ok: boolean
  code?: string
  message: string
  detail: Record<string, unknown>
}

export interface InstallPreflightReport {
  ok: boolean
  profile: XpanelOsProfile
  services: ResolvedOptInServices
  requiredPorts: number[]
  closedOptInPorts: number[]
  checks: PreflightCheckResult[]
}

export const REQUIRED_CGROUP_CONTROLLERS = Object.freeze(['cpu', 'memory', 'io', 'pids'] as const)
export const REQUIRED_QUOTA_TOOLS = Object.freeze(['quotacheck', 'quotaon', 'setquota', 'repquota'] as const)
export const PROTECTED_PARENT_PATHS = Object.freeze(['/opt/xpanel', '/etc/xpanel', '/var/lib/xpanel'] as const)

const BASE_PORTS = [80, 443, 2087] as const
const MAIL_PORTS = [25, 110, 143, 465, 587, 993, 995, 4190] as const
const DNS_PORTS = [53] as const
const FTP_PORTS = [21] as const
const MARIADB_PORTS = [3306] as const

/**
 * Resolves strict opt-in service flags for H02: Mail, DNS, FTP, MariaDB, and ModSecurity
 * are disabled by default unless explicitly opted in (`true`).
 */
export const resolveOptInServices = (raw: OptInServiceSelection = {}): ResolvedOptInServices => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('VALIDATION', 'service selection must be a plain object')
  }
  const engine: Engine = raw.engine ?? 'apache'
  if (engine !== 'apache' && engine !== 'openlitespeed') {
    return fail('VALIDATION', 'engine must be apache or openlitespeed', { engine: preview(engine) })
  }
  const apacheMpm: ApacheMpm = raw.apacheMpm ?? 'itk'
  if (apacheMpm !== 'itk' && apacheMpm !== 'prefork') {
    return fail('VALIDATION', 'apacheMpm must be itk or prefork', { apacheMpm: preview(apacheMpm) })
  }
  const phpVersions = raw.phpVersions ?? ['8.3']
  if (!Array.isArray(phpVersions)) {
    return fail('VALIDATION', 'phpVersions must be an array')
  }
  const bool = (val: unknown, name: string): boolean => {
    if (val === undefined) return false
    if (typeof val !== 'boolean') {
      return fail('VALIDATION', `${name} must be a boolean`, { field: name, value: preview(val) })
    }
    return val
  }
  return {
    engine,
    apacheMpm,
    phpVersions: [...phpVersions],
    withMail: bool(raw.withMail, 'withMail'),
    withDns: bool(raw.withDns, 'withDns'),
    withFtp: bool(raw.withFtp, 'withFtp'),
    withMariaDb: bool(raw.withMariaDb, 'withMariaDb'),
    withModSecurity: bool(raw.withModSecurity, 'withModSecurity'),
  }
}

export const computeServicePorts = (services: ResolvedOptInServices): { requiredPorts: number[]; closedOptInPorts: number[] } => {
  const required = new Set<number>(BASE_PORTS)
  const closed = new Set<number>()

  for (const p of MAIL_PORTS) (services.withMail ? required : closed).add(p)
  for (const p of DNS_PORTS) (services.withDns ? required : closed).add(p)
  for (const p of FTP_PORTS) (services.withFtp ? required : closed).add(p)
  for (const p of MARIADB_PORTS) (services.withMariaDb ? required : closed).add(p)

  return {
    requiredPorts: [...required].sort((a, b) => a - b),
    closedOptInPorts: [...closed].sort((a, b) => a - b),
  }
}

/**
 * Unified H02 preflight verifier.
 * Validates OS release against `detectOs`, rejects active xPanel services, requires Apache `mpm_itk`
 * (refusing shared-identity fallback), verifies cgroup v2 controllers (`cpu`, `memory`, `io`, `pids`),
 * quota tools, port conflicts, and root-owned non-writable parent paths before any host mutation.
 */
export const verifyInstallPreflight = (
  probe: PreflightHostProbe,
  serviceOptions: OptInServiceSelection = {},
): InstallPreflightReport => {
  const services = resolveOptInServices(serviceOptions)
  const checks: PreflightCheckResult[] = []

  // 1. Reject running fresh install over active xpanel-api / xpanel-agent services
  const activePanelUnits = probe.activeUnits.filter(
    (u) => u === 'xpanel-api' || u === 'xpanel-api.service' || u === 'xpanel-agent' || u === 'xpanel-agent.service',
  )
  if (activePanelUnits.length > 0) {
    fail(
      'CONFLICT',
      `Active xPanel services detected (${activePanelUnits.join(', ')}); use the upgrade flow instead of fresh install`,
      { activeUnits: activePanelUnits, remedy: 'upgrade' },
    )
  }
  checks.push({
    id: 'active-services',
    ok: true,
    message: 'no active xpanel-api or xpanel-agent services running',
    detail: { activePanelUnits: [] },
  })

  // 2. Compare /etc/os-release with detectOs()
  const detectedFromText = detectOs((p) => (p === '/etc/os-release' ? probe.osReleaseText : null))
  const parsedOsRelease = parseOsRelease(probe.osReleaseText)
  const profileFromParsed = profileFor(parsedOsRelease)
  if (
    detectedFromText.id !== profileFromParsed.id ||
    detectedFromText.versionId !== profileFromParsed.versionId ||
    (probe.detectedProfile &&
      (probe.detectedProfile.id !== detectedFromText.id ||
        probe.detectedProfile.versionId !== detectedFromText.versionId ||
        probe.detectedProfile.family !== detectedFromText.family))
  ) {
    fail('UNSUPPORTED_OS', 'Mismatch between /etc/os-release and detected OS profile', {
      osReleaseId: parsedOsRelease.id,
      osReleaseVersionId: parsedOsRelease.versionId,
      detectedId: probe.detectedProfile?.id ?? detectedFromText.id,
      detectedVersionId: probe.detectedProfile?.versionId ?? detectedFromText.versionId,
    })
  }
  checks.push({
    id: 'os-release',
    ok: true,
    message: `verified ${detectedFromText.id} ${detectedFromText.versionId} (${detectedFromText.family})`,
    detail: { id: detectedFromText.id, versionId: detectedFromText.versionId, family: detectedFromText.family },
  })

  // 3. Enforce Apache mpm_itk availability & refuse shared-identity fallback
  if (services.engine !== 'apache' || services.apacheMpm !== 'itk') {
    fail(
      'ENGINE_UNAVAILABLE',
      'Production installation requires Apache with mpm_itk; shared-identity prefork fallback is refused',
      { engine: services.engine, apacheMpm: services.apacheMpm },
    )
  }
  if (!itkAvailable(detectedFromText)) {
    fail(
      'ENGINE_UNAVAILABLE',
      `Apache mpm_itk is not available on ${detectedFromText.id} ${detectedFromText.versionId}; refusing shared-identity fallback`,
      { os: `${detectedFromText.id} ${detectedFromText.versionId}`, engine: 'apache', apacheMpm: 'itk' },
    )
  }
  checks.push({
    id: 'apache-mpm-itk',
    ok: true,
    message: 'Apache mpm_itk is available and selected',
    detail: { engine: 'apache', apacheMpm: 'itk' },
  })

  // 4. Verify cgroup v2 controllers (cpu, memory, io, pids)
  const controllerSet = new Set(probe.cgroupControllers)
  const missingControllers = REQUIRED_CGROUP_CONTROLLERS.filter((c) => !controllerSet.has(c))
  if (missingControllers.length > 0) {
    fail(
      'PRECONDITION_FAILED',
      `Missing required cgroup v2 controllers: ${missingControllers.join(', ')}`,
      { required: [...REQUIRED_CGROUP_CONTROLLERS], available: [...probe.cgroupControllers], missing: missingControllers },
    )
  }
  checks.push({
    id: 'cgroup-v2-controllers',
    ok: true,
    message: 'all required cgroup v2 controllers (cpu, memory, io, pids) are active',
    detail: { controllers: [...REQUIRED_CGROUP_CONTROLLERS] },
  })

  // 5. Verify quota tools
  const quotaSet = new Set(probe.quotaToolsAvailable)
  const missingQuotaTools = REQUIRED_QUOTA_TOOLS.filter((t) => !quotaSet.has(t))
  if (missingQuotaTools.length > 0) {
    fail(
      'PRECONDITION_FAILED',
      `Missing required filesystem quota utilities: ${missingQuotaTools.join(', ')}`,
      { required: [...REQUIRED_QUOTA_TOOLS], available: [...probe.quotaToolsAvailable], missing: missingQuotaTools },
    )
  }
  checks.push({
    id: 'quota-tools',
    ok: true,
    message: 'quota utilities available',
    detail: { tools: [...REQUIRED_QUOTA_TOOLS] },
  })

  // 6. Check port conflicts for selected services only
  const { requiredPorts, closedOptInPorts } = computeServicePorts(services)
  const listeningSet = new Set(probe.listeningPorts)
  const conflictingPorts = requiredPorts.filter((p) => listeningSet.has(p))
  if (conflictingPorts.length > 0) {
    fail(
      'CONFLICT',
      `Required service ports are already in use: ${conflictingPorts.join(', ')}`,
      { conflictingPorts, requiredPorts },
    )
  }
  checks.push({
    id: 'port-conflicts',
    ok: true,
    message: 'no port conflicts on selected services',
    detail: { requiredPorts, closedOptInPorts },
  })

  // 7. Verify parent paths (/opt/xpanel, /etc/xpanel, /var/lib/xpanel)
  for (const parentPath of PROTECTED_PARENT_PATHS) {
    const st = probe.statPath(parentPath)
    if (!st.exists) continue
    if (st.isSymbolicLink || !st.isDirectory) {
      fail('PRECONDITION_FAILED', `Protected path must be a non-symlink directory: ${parentPath}`, { path: parentPath })
    }
    const isVarLibDataDir = parentPath === '/var/lib/xpanel' && st.owner === 'xpanel' && st.group === 'xpanel' && (st.mode & 0o7777) === 0o2770
    if (!isVarLibDataDir) {
      if (st.uid !== 0) {
        fail('PRECONDITION_FAILED', `Protected parent directory is not root-owned: ${parentPath}`, {
          path: parentPath,
          uid: st.uid,
          owner: st.owner,
        })
      }
      if ((st.mode & 0o0022) !== 0) {
        fail('PRECONDITION_FAILED', `Protected parent directory is writable by group or other: ${parentPath}`, {
          path: parentPath,
          mode: st.mode.toString(8),
        })
      }
    }
  }
  checks.push({
    id: 'parent-paths',
    ok: true,
    message: 'protected parent paths verified',
    detail: { paths: [...PROTECTED_PARENT_PATHS] },
  })

  // 8. Verify runtime pin if provided
  if (probe.expectedNodeVersion !== undefined || probe.actualNodeVersion !== undefined) {
    const expected = probe.expectedNodeVersion?.replace(/^v/, '')
    const actual = probe.actualNodeVersion?.replace(/^v/, '')
    if (!expected || !actual || expected !== actual) {
      fail('PRECONDITION_FAILED', `Pinned Node runtime mismatch: expected v${expected ?? 'unknown'}, found v${actual ?? 'missing'}`, {
        expected: probe.expectedNodeVersion,
        actual: probe.actualNodeVersion,
      })
    }
    checks.push({
      id: 'runtime-pin',
      ok: true,
      message: `pinned Node runtime v${expected} verified`,
      detail: { version: expected },
    })
  }

  return {
    ok: true,
    profile: detectedFromText,
    services,
    requiredPorts,
    closedOptInPorts,
    checks,
  }
}

export interface JournalStorage {
  read(): string | null
  write(content: string): void
}

/**
 * Durable install phase journal (`installPhaseJournal`).
 * Persists phase transitions, config `.bak.<timestamp>` backups, and secret preservation records
 * so an interrupted installation can be inspected and safely resumed.
 */
export const installPhaseJournal = (storage: JournalStorage, meta?: { installId?: string; osId?: string; osVersionId?: string; now?: () => Date }) => {
  const nowIso = (): string => (meta?.now ? meta.now() : new Date()).toISOString()

  const loadOrInit = (): InstallJournalState => {
    const raw = storage.read()
    if (raw) {
      const parsed = JSON.parse(raw) as InstallJournalState
      if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.completedPhases)) {
        return parsed
      }
    }
    const ts = nowIso()
    return {
      schemaVersion: 1,
      installId: meta?.installId ?? `install-${ts}`,
      startedAt: ts,
      updatedAt: ts,
      osId: meta?.osId ?? 'unknown',
      osVersionId: meta?.osVersionId ?? 'unknown',
      completedPhases: [],
      lastFailedPhase: null,
      entries: [],
      backups: [],
      secrets: [],
    }
  }

  const save = (state: InstallJournalState): InstallJournalState => {
    state.updatedAt = nowIso()
    storage.write(`${JSON.stringify(state, null, 2)}\n`)
    return state
  }

  return {
    getState(): InstallJournalState {
      return loadOrInit()
    },

    isPhaseCompleted(phase: InstallPhase): boolean {
      return loadOrInit().completedPhases.includes(phase)
    },

    startPhase(phase: InstallPhase, detail?: string): InstallJournalState {
      const state = loadOrInit()
      state.entries.push({
        phase,
        status: 'started',
        at: nowIso(),
        ...(detail !== undefined ? { detail } : {}),
      })
      return save(state)
    },

    completePhase(phase: InstallPhase, detail?: string): InstallJournalState {
      const state = loadOrInit()
      if (!state.completedPhases.includes(phase)) {
        state.completedPhases.push(phase)
      }
      if (state.lastFailedPhase === phase) {
        state.lastFailedPhase = null
      }
      state.entries.push({
        phase,
        status: 'completed',
        at: nowIso(),
        ...(detail !== undefined ? { detail } : {}),
      })
      return save(state)
    },

    failPhase(phase: InstallPhase, detail: string): InstallJournalState {
      const state = loadOrInit()
      state.lastFailedPhase = phase
      state.entries.push({
        phase,
        status: 'failed',
        at: nowIso(),
        detail,
      })
      return save(state)
    },

    recordBackup(record: ConfigBackupRecord): InstallJournalState {
      const state = loadOrInit()
      if (!state.backups.some((b) => b.backupPath === record.backupPath)) {
        state.backups.push(record)
      }
      return save(state)
    },

    recordSecret(record: SecretProvisionRecord): InstallJournalState {
      const state = loadOrInit()
      const idx = state.secrets.findIndex((s) => s.path === record.path)
      if (idx >= 0) state.secrets[idx] = record
      else state.secrets.push(record)
      return save(state)
    },
  }
}

export interface VirtualFileEntry {
  content: string
  mode: number
  owner: string
  group: string
  isSymbolicLink?: boolean
  isDirectory?: boolean
}

export interface InstallerExecutionHost {
  probe: PreflightHostProbe
  journalStorage: JournalStorage
  /** Timestamp suffix for `.bak.<stamp>` config backups */
  backupStamp?: string
  /** Simulated or real file reader */
  readFile(path: string): VirtualFileEntry | null
  /** Simulated or real file writer */
  writeFile(path: string, entry: VirtualFileEntry): void
  /** Ensures a directory with exact owner, group, and mode */
  ensureDir(path: string, entry: { mode: number; owner: string; group: string }): void
  /** Ensures a system group exists and returns its numeric GID */
  ensureGroup(name: string): number
  /** Ensures a system user exists */
  ensureUser(user: { name: string; primaryGroup: string; supplementaryGroups: string[]; home: string; shell: string }): void
  /** Executes an install action (exec or systemd) */
  runAction(action: InstallAction, phase: InstallPhase): void
  /** Initializes the SQLite control database schema as the unprivileged xpanel user */
  initSchemaAsXpanelUser(dbPath: string, stateDir: string): void
  /** Optional random hex generator for 32-byte credentials */
  generateSecretHex?: () => string
  /** Optional argv runner. When present, the ACME traversal probe must exit 0. */
  command?: (argv: string[]) => { code: number }
}

const VALID_CREDENTIAL_HEX = /^[a-f0-9]{64}\n?$/

const provisionSecretIdempotent = (
  host: InstallerExecutionHost,
  journal: ReturnType<typeof installPhaseJournal>,
  secretPath: string,
): SecretProvisionRecord => {
  assertAbsolutePath(secretPath)
  const existing = host.readFile(secretPath)
  if (existing !== null) {
    if (existing.isSymbolicLink || existing.isDirectory) {
      fail('PRECONDITION_FAILED', `Credential path must be a regular file, not a symlink or directory: ${secretPath}`, {
        path: secretPath,
      })
    }
    if (existing.owner !== 'root' || existing.group !== 'xpanel' || (existing.mode & 0o7777) !== 0o640) {
      fail(
        'PRECONDITION_FAILED',
        `Existing credential ${secretPath} has invalid ownership or mode (expected root:xpanel 0640)`,
        { path: secretPath, owner: existing.owner, group: existing.group, mode: existing.mode.toString(8) },
      )
    }
    if (!VALID_CREDENTIAL_HEX.test(existing.content)) {
      fail('PRECONDITION_FAILED', `Existing credential ${secretPath} is malformed (expected 64 hex chars)`, {
        path: secretPath,
      })
    }
    const rec: SecretProvisionRecord = {
      path: secretPath,
      action: 'preserved',
      mode: 0o640,
      owner: 'root',
      group: 'xpanel',
    }
    journal.recordSecret(rec)
    return rec
  }

  const hex = host.generateSecretHex ? host.generateSecretHex() : randomBytes(32).toString('hex')
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    fail('VALIDATION', 'Generated credential must be 64 lowercase hex characters')
  }
  host.writeFile(secretPath, {
    content: `${hex}\n`,
    mode: 0o640,
    owner: 'root',
    group: 'xpanel',
  })
  const rec: SecretProvisionRecord = {
    path: secretPath,
    action: 'created',
    mode: 0o640,
    owner: 'root',
    group: 'xpanel',
  }
  journal.recordSecret(rec)
  return rec
}

const writeManagedConfigWithBackup = (
  host: InstallerExecutionHost,
  journal: ReturnType<typeof installPhaseJournal>,
  file: RenderedFile,
  backupStamp: string,
): void => {
  assertAbsolutePath(file.path)
  const existing = host.readFile(file.path)
  if (existing !== null) {
    if (existing.isSymbolicLink) {
      fail('PRECONDITION_FAILED', `Refusing to overwrite symbolic link config file: ${file.path}`, { path: file.path })
    }
    // If content and metadata are already identical (e.g. idempotent re-run), preserve existing backup without duplicating
    if (
      existing.content === file.content &&
      existing.mode === file.mode &&
      existing.owner === file.owner &&
      existing.group === file.group
    ) {
      return
    }
    const backupPath = `${file.path}.bak.${backupStamp}`
    if (host.readFile(backupPath) === null) {
      host.writeFile(backupPath, {
        content: existing.content,
        mode: existing.mode,
        owner: existing.owner,
        group: existing.group,
      })
      journal.recordBackup({
        targetPath: file.path,
        backupPath,
        createdAt: new Date().toISOString(),
        mode: existing.mode,
        owner: existing.owner,
        group: existing.group,
      })
    }
  }
  host.writeFile(file.path, {
    content: file.content,
    mode: file.mode,
    owner: file.owner ?? 'root',
    group: file.group ?? 'root',
  })
}

export const renderSystemdAgentUnit = (nodeBin = '/usr/bin/node'): RenderedFile => ({
  path: '/etc/systemd/system/xpanel-agent.service',
  mode: 0o644,
  owner: 'root',
  group: 'root',
  content: [
    '[Unit]',
    'Description=xPanel Privileged Host Reconciler & Isolation Agent',
    'After=network-online.target systemd-sysctl.service systemd-tmpfiles-setup.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'User=root',
    'Group=xpanel-agent',
    'SupplementaryGroups=xpanel',
    'RuntimeDirectory=xpanel',
    'RuntimeDirectoryMode=0750',
    'RuntimeDirectoryPreserve=no',
    'WorkingDirectory=/opt/xpanel',
    'Environment=NODE_ENV=production',
    'EnvironmentFile=/etc/xpanel/runtime.env',
    'Environment=XPANEL_GENERATIONS_DIR=/var/lib/xpanel/generations',
    'Environment=XPANEL_LOG_DIR=/var/log/xpanel',
    'Environment=XPANEL_RUN_DIR=/run/xpanel',
    'ExecStartPre=/usr/bin/test -f /var/lib/xpanel/control.db',
    `ExecStart=${nodeBin} --max-old-space-size=64 /opt/xpanel/apps/agent/src/main.ts`,
    'Restart=always',
    'RestartSec=2',
    'UMask=0007',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n'),
})

export const renderSystemdApiUnit = (nodeBin = '/usr/bin/node'): RenderedFile => ({
  path: '/etc/systemd/system/xpanel-api.service',
  mode: 0o644,
  owner: 'root',
  group: 'root',
  content: [
    '[Unit]',
    'Description=xPanel Control Plane API & Web Panel (:2087)',
    'After=network-online.target xpanel-agent.service',
    'Requires=xpanel-agent.service',
    '',
    '[Service]',
    'Type=simple',
    'User=xpanel',
    'Group=xpanel',
    'SupplementaryGroups=xpanel-agent',
    'WorkingDirectory=/opt/xpanel',
    'Environment=NODE_ENV=production',
    'EnvironmentFile=/etc/xpanel/runtime.env',
    'EnvironmentFile=/etc/xpanel/api.env',
    `ExecStart=${nodeBin} --max-old-space-size=96 /opt/xpanel/apps/api/src/main.ts`,
    'Restart=always',
    'RestartSec=2',
    'UMask=0007',
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'ProtectHome=yes',
    'ProtectSystem=strict',
    'ReadWritePaths=/var/lib/xpanel /var/log/xpanel',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectControlGroups=yes',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n'),
})

export const renderSystemdSliceUnit = (): RenderedFile => ({
  path: '/etc/systemd/system/xpanel.slice',
  mode: 0o644,
  owner: 'root',
  group: 'root',
  content: [
    '# Generated by xPanel: parent cgroup v2 slice for all tenant account slices (xpanel-<uid>.slice)',
    '[Unit]',
    'Description=xPanel Multi-Tenant Account Hierarchy Slice',
    'Documentation=man:systemd.resource-control(5)',
    'Before=slices.target',
    '',
    '[Slice]',
    'CPUAccounting=yes',
    'MemoryAccounting=yes',
    'IOAccounting=yes',
    'TasksAccounting=yes',
    '',
  ].join('\n'),
})

/**
 * Executes the unified H02 installer across all 8 durable phases:
 * `preflight` -> `users-and-dirs` -> `secrets` -> `packages` -> `configs` -> `schema` -> `systemd` -> `health-probe`.
 * Safe for idempotent re-run after mid-install interruption: preserves valid secrets and `.bak.<timestamp>` backups.
 */
export const runUnifiedInstaller = (
  host: InstallerExecutionHost,
  serviceOptions: OptInServiceSelection = {},
): {
  preflight: InstallPreflightReport
  journal: InstallJournalState
} => {
  const journal = installPhaseJournal(host.journalStorage)
  const backupStamp = host.backupStamp ?? '20261022T120000Z.1'

  const runPhase = <T>(phase: InstallPhase, detail: string, fn: () => T): T => {
    journal.startPhase(phase, detail)
    try {
      const out = fn()
      journal.completePhase(phase, detail)
      return out
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      journal.failPhase(phase, msg)
      throw err
    }
  }

  // Phase 1: preflight
  const preflight = runPhase('preflight', 'verify OS, mpm_itk, cgroup v2, quotas, ports, and parent paths', () =>
    verifyInstallPreflight(host.probe, serviceOptions),
  )

  const { profile, services } = preflight
  const bundleOptions: InstallOptions & { withMariaDb?: boolean } = {
    engine: services.engine,
    apacheMpm: services.apacheMpm,
    phpVersions: services.phpVersions,
    withMail: services.withMail,
    withDns: services.withDns,
    withFtp: services.withFtp,
    withModSecurity: services.withModSecurity,
    withMariaDb: services.withMariaDb,
  }
  const bundle = installBundle(profile, bundleOptions)

  // Phase 2: users-and-dirs
  let agentGid = 0
  runPhase('users-and-dirs', 'provision xpanel/xpanel-agent groups, xpanel user, and isolated directory modes', () => {
    host.ensureGroup('xpanel')
    agentGid = host.ensureGroup('xpanel-agent')
    if (!Number.isSafeInteger(agentGid) || agentGid <= 0) {
      fail('PRECONDITION_FAILED', 'xpanel-agent group must have a positive numeric GID')
    }
    host.ensureUser({
      name: 'xpanel',
      primaryGroup: 'xpanel',
      supplementaryGroups: ['xpanel-agent'],
      home: '/var/lib/xpanel',
      shell: '/usr/sbin/nologin',
    })
    host.ensureDir('/home', { mode: 0o711, owner: 'root', group: 'root' })
    host.ensureDir('/var/lib/xpanel', { mode: 0o2770, owner: 'xpanel', group: 'xpanel' })
    host.ensureDir('/var/lib/xpanel/state', { mode: 0o2750, owner: 'xpanel', group: 'xpanel' })
    host.ensureDir('/var/lib/xpanel/generations', { mode: 0o2750, owner: 'xpanel', group: 'xpanel' })
    host.ensureDir('/var/log/xpanel', { mode: 0o2750, owner: 'xpanel', group: 'xpanel' })
    host.ensureDir('/etc/xpanel', { mode: 0o750, owner: 'root', group: 'xpanel' })
    host.ensureDir('/etc/xpanel/userdata', { mode: 0o750, owner: 'root', group: 'root' })
    host.ensureDir('/run/xpanel', { mode: 0o750, owner: 'root', group: 'xpanel-agent' })
    host.ensureDir('/opt/xpanel/bin', { mode: 0o755, owner: 'root', group: 'root' })
  })

  // Phase 3: secrets
  runPhase('secrets', 'provision or preserve 0640 root:xpanel service credentials', () => {
    provisionSecretIdempotent(host, journal, '/etc/xpanel/agent.token')
    provisionSecretIdempotent(host, journal, '/etc/xpanel/server.secret')
  })

  // Phase 4: packages
  runPhase('packages', `execute ${bundle.actions.length} OS package & module actions`, () => {
    for (const action of bundle.actions) {
      if (action.kind === 'exec' && action.creates) {
        const created = host.readFile(action.creates)
        if (created !== null) continue
      }
      host.runAction(action, 'packages')
    }
  })

  // Phase 5: configs
  runPhase('configs', 'backup existing configs and write runtime.env, api.env, sysctl, and web server configs', () => {
    const runtimeEnv: RenderedFile = {
      path: '/etc/xpanel/runtime.env',
      mode: 0o640,
      owner: 'root',
      group: 'xpanel',
      content: [
        `XPANEL_AGENT_GID=${agentGid}`,
        'XPANEL_DB_PATH=/var/lib/xpanel/control.db',
        'XPANEL_STATE_DIR=/var/lib/xpanel/state',
        'XPANEL_AGENT_SOCKET=/run/xpanel/agent.sock',
        'XPANEL_AGENT_TOKEN_FILE=/etc/xpanel/agent.token',
        '',
      ].join('\n'),
    }
    writeManagedConfigWithBackup(host, journal, runtimeEnv, backupStamp)

    // Preserve existing operator api.env if valid; otherwise create default closed-origin api.env
    const existingApiEnv = host.readFile('/etc/xpanel/api.env')
    if (existingApiEnv === null) {
      const apiEnv: RenderedFile = {
        path: '/etc/xpanel/api.env',
        mode: 0o640,
        owner: 'root',
        group: 'xpanel',
        content: [
          '# Configure the exact HTTPS browser origins before allowing cookie WebSocket upgrades.',
          'XPANEL_ALLOWED_ORIGINS=',
          '# Forwarded client addresses are ignored unless the immediate proxy is listed here.',
          'XPANEL_TRUSTED_PROXIES=',
          'XPANEL_HOST=127.0.0.1',
          'XPANEL_PORT=2087',
          'XPANEL_SERVER_SECRET_FILE=/etc/xpanel/server.secret',
          '',
        ].join('\n'),
      }
      writeManagedConfigWithBackup(host, journal, apiEnv, backupStamp)
    } else if (
      existingApiEnv.isSymbolicLink ||
      existingApiEnv.owner !== 'root' ||
      existingApiEnv.group !== 'xpanel' ||
      (existingApiEnv.mode !== 0o640 && existingApiEnv.mode !== 0o600)
    ) {
      fail('PRECONDITION_FAILED', 'Existing /etc/xpanel/api.env must be root:xpanel with mode 0600 or 0640')
    }

    const sysctlFile: RenderedFile = {
      path: '/etc/sysctl.d/99-xpanel-symlink-protection.conf',
      mode: 0o644,
      owner: 'root',
      group: 'root',
      content: [
        '# Generated by xPanel: kernel symlink, hardlink, FIFO, and ptrace isolation.',
        'fs.protected_symlinks = 1',
        'fs.protected_hardlinks = 1',
        'fs.protected_fifos = 2',
        'fs.protected_regular = 2',
        'kernel.yama.ptrace_scope = 2',
        'kernel.dmesg_restrict = 1',
        'kernel.kptr_restrict = 2',
        '',
      ].join('\n'),
    }
    writeManagedConfigWithBackup(host, journal, sysctlFile, backupStamp)

    for (const file of bundle.files) {
      writeManagedConfigWithBackup(host, journal, file, backupStamp)
    }
    if (services.withMail) {
      writeManagedConfigWithBackup(host, journal, rendered.renderDovecotAuthConf(profile), backupStamp)
      writeManagedConfigWithBackup(host, journal, rendered.renderDovecotMailboxConf(profile), backupStamp)
      const maps = rendered.renderPostfixMaps(profile, [])
      for (const action of maps.actions) {
        if (action.kind === 'ensure-dir') host.ensureDir(action.path, { mode: action.mode, owner: action.owner, group: action.group })
      }
      for (const file of maps.files) {
        if (host.readFile(file.path) === null) {
          host.writeFile(file.path, {
            content: file.content,
            mode: file.mode,
            owner: file.owner ?? 'root',
            group: file.group ?? 'root',
          })
        }
      }
      const merge = (path: string, body: string): void => {
        const existing = host.readFile(path)
        writeManagedConfigWithBackup(host, journal, {
          path,
          content: rendered.replaceManagedBlock(existing?.content ?? '', body),
          mode: 0o644,
          owner: 'root',
          group: 'root',
        }, backupStamp)
      }
      merge(`${profile.paths.postfixDir}/main.cf`, rendered.localDeliveryMainBlock(profile))
      merge(`${profile.paths.postfixDir}/master.cf`, rendered.localSubmissionMasterBlock(profile))
      host.runAction({ kind: 'systemd', verb: 'reload', unit: profile.services.dovecot }, 'configs')
      host.runAction({ kind: 'systemd', verb: 'reload', unit: profile.services.postfix }, 'configs')
    }
  })

  // Phase 6: schema
  runPhase('schema', 'initialize control.db under xpanel identity with mode 0660', () => {
    const dbPath = '/var/lib/xpanel/control.db'
    const existingDb = host.readFile(dbPath)
    if (existingDb !== null) {
      if (existingDb.isSymbolicLink || existingDb.owner !== 'xpanel' || existingDb.group !== 'xpanel' || existingDb.mode !== 0o660) {
        fail('PRECONDITION_FAILED', 'Existing control.db ownership/mode requires an explicit reviewed repair')
      }
    }
    host.initSchemaAsXpanelUser(dbPath, '/var/lib/xpanel/state')
  })

  // Phase 7: systemd
  runPhase('systemd', 'write systemd slice, agent, api units and tmpfiles.d config', () => {
    writeManagedConfigWithBackup(host, journal, renderSystemdSliceUnit(), backupStamp)
    writeManagedConfigWithBackup(host, journal, renderSystemdAgentUnit(), backupStamp)
    writeManagedConfigWithBackup(host, journal, renderSystemdApiUnit(), backupStamp)
    writeManagedConfigWithBackup(
      host,
      journal,
      {
        path: '/etc/tmpfiles.d/xpanel.conf',
        mode: 0o644,
        owner: 'root',
        group: 'root',
        content: 'd /run/xpanel 0750 root xpanel-agent -\n',
      },
      backupStamp,
    )
    host.runAction({ kind: 'systemd', verb: 'enable', unit: 'xpanel.slice' }, 'systemd')
    host.runAction({ kind: 'systemd', verb: 'enable', unit: 'xpanel-agent.service' }, 'systemd')
    host.runAction({ kind: 'systemd', verb: 'enable', unit: 'xpanel-api.service' }, 'systemd')
  })

  // Phase 8: health-probe
  runPhase('health-probe', 'verify post-install ownership, secret permissions, and control.db state', () => {
    const agentToken = host.readFile('/etc/xpanel/agent.token')
    const serverSecret = host.readFile('/etc/xpanel/server.secret')
    const controlDb = host.readFile('/var/lib/xpanel/control.db')
    const agentUnit = host.readFile('/etc/systemd/system/xpanel-agent.service')
    const apiUnit = host.readFile('/etc/systemd/system/xpanel-api.service')

    if (!agentToken || agentToken.mode !== 0o640 || agentToken.owner !== 'root' || agentToken.group !== 'xpanel') {
      fail('PRECONDITION_FAILED', 'Post-install health probe failed: /etc/xpanel/agent.token is not root:xpanel 0640')
    }
    if (!serverSecret || serverSecret.mode !== 0o640 || serverSecret.owner !== 'root' || serverSecret.group !== 'xpanel') {
      fail('PRECONDITION_FAILED', 'Post-install health probe failed: /etc/xpanel/server.secret is not root:xpanel 0640')
    }
    if (!controlDb || controlDb.mode !== 0o660 || controlDb.owner !== 'xpanel' || controlDb.group !== 'xpanel') {
      fail('PRECONDITION_FAILED', 'Post-install health probe failed: /var/lib/xpanel/control.db is not xpanel:xpanel 0660')
    }
    if (!agentUnit || !apiUnit) {
      fail('PRECONDITION_FAILED', 'Post-install health probe failed: systemd unit files are missing')
    }
    host.ensureDir(ACME_DIR, { mode: 0o755, owner: 'root', group: 'root' })
    host.runAction({ kind: 'exec', argv: acmeTraverseAclArgv(profile.paths.nginxUser) }, 'health-probe')
    if (host.command) {
      for (const argv of acmeTraverseProbeArgv(profile.paths.nginxUser)) {
        if (host.command(argv).code !== 0) {
          fail('PRECONDITION_FAILED', 'Post-install health probe failed: nginx cannot read the ACME challenge directory')
        }
      }
    }
  })

  return {
    preflight,
    journal: journal.getState(),
  }
}
