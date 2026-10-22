import { createHmac, timingSafeEqual, verify as cryptoVerify } from 'node:crypto'
import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import type { AuditEntry, HostAction, OsProfile, Principal } from '@xpanel/core'
import {
  appendAudit,
  createUpgrade,
  currentSchemaVersion,
  finishUpgrade,
  latestUpgrade,
  migrate,
  setUpgradePhase,
} from '@xpanel/db'
import type { Db, Migration } from '@xpanel/db'
import {
  DEFAULT_LAYOUT,
  isCustomerDataPath,
  normalizeUpgradePlan,
  readLock,
  recoverUpgrade,
  runUpgrade,
} from '@xpanel/lifecycle'
import type {
  AccountIdentity,
  AuditPort,
  ClockPort,
  ExecResult,
  FsPort,
  GenerationId,
  HealthPort,
  HostPort,
  MigratorPort,
  ReconcilerPort,
  RecoverInput,
  RecoverResult,
  ReleaseInfo,
  SystemProbePort,
  TransferProbePort,
  UnitChange,
  UpgradeHistoryPort,
  UpgradeLayout,
  UpgradePlan,
  UpgradePorts,
  UpgradeResult,
} from '@xpanel/lifecycle'
import type { OsRelease } from '@xpanel/os'

export interface SignedReleaseManifest {
  version: string
  schemaVersion: number
  sha256: string
  bytes: number
  /** Hex-encoded HMAC-SHA256 or Ed25519 signature over canonical `${version}:${schemaVersion}:${sha256}:${bytes}` */
  signature: string
  keyId: string
}

export interface ReleaseVerificationKey {
  keyId: string
  kind: 'ed25519-pem' | 'hmac-sha256'
  publicKeyOrSecret: string | Buffer
}

export const canonicalReleasePayload = (m: Pick<SignedReleaseManifest, 'version' | 'schemaVersion' | 'sha256' | 'bytes'>): Buffer =>
  Buffer.from(`xpanel-release-v1:${m.version}:${m.schemaVersion}:${m.sha256}:${m.bytes}`, 'utf8')

export const signReleaseManifestHmac = (
  m: Pick<SignedReleaseManifest, 'version' | 'schemaVersion' | 'sha256' | 'bytes'>,
  keyId: string,
  secret: string | Buffer,
): SignedReleaseManifest => ({
  ...m,
  keyId,
  signature: createHmac('sha256', secret).update(canonicalReleasePayload(m)).digest('hex'),
})

/**
 * Verifies the cryptographic signature of a release manifest before any staging or unpacking.
 */
export const verifyReleaseArtifactSignature = (
  manifest: SignedReleaseManifest,
  trustedKeys: readonly ReleaseVerificationKey[],
): void => {
  if (!manifest || typeof manifest.signature !== 'string' || !/^[0-9a-f]{64,256}$/i.test(manifest.signature)) {
    fail('VALIDATION', 'release manifest signature is missing or malformed')
  }
  const key = trustedKeys.find((k) => k.keyId === manifest.keyId)
  if (!key) {
    return fail('FORBIDDEN', `release manifest signed by untrusted keyId ${String(manifest.keyId)}`)
  }
  const payload = canonicalReleasePayload(manifest)
  const sigBuf = Buffer.from(manifest.signature, 'hex')

  if (key.kind === 'hmac-sha256') {
    const expected = createHmac('sha256', key.publicKeyOrSecret).update(payload).digest()
    if (sigBuf.length !== expected.length || !timingSafeEqual(sigBuf, expected)) {
      fail('VALIDATION', 'release artifact signature verification failed')
    }
    return
  }

  const ok = cryptoVerify(null, payload, key.publicKeyOrSecret, sigBuf)
  if (!ok) {
    fail('VALIDATION', 'release artifact Ed25519 signature verification failed')
  }
}

export interface CanaryHttpProbeResult {
  httpStatus: number
  servedByUid: number | null
  cgroupSlice: string | null
  serviceActive: boolean
}

export interface ProductionUpgradeDependencies {
  db: Db
  fs: FsPort
  host: HostPort
  clock: ClockPort
  audit?: AuditPort
  reconciler: ReconcilerPort
  /** Resolves migrations shipped inside a release directory (e.g. `<releaseDir>/migrations`). */
  loadReleaseMigrations: (releaseDir: string) => Promise<Migration[]>
  /** Probes free bytes on the filesystem containing `path`. */
  probeFreeBytes: (path: string) => Promise<number>
  /** Reads the live host `/etc/os-release`. */
  probeOsRelease: () => Promise<OsRelease>
  /** Counts active transfers from the durable transfer store. */
  probeActiveTransfers: () => Promise<number>
  /** Performs an authenticated control-plane login probe against the running release. */
  probePanelLogin: () => Promise<boolean>
  /** Performs an HTTP canary request and verifies the serving worker UID, cgroup slice, and active unit. */
  probeCanaryHttp: (canaryUsername: string) => Promise<CanaryHttpProbeResult>
  /** Takes a consistent WAL-safe SQLite control DB & secrets backup alongside the state tarball. */
  snapshotControlPlaneDb?: (snapshotPath: string) => Promise<void>
  /** Restores the WAL-safe SQLite control DB & secrets backup on rollback (preserving the upgrades history table). */
  restoreControlPlaneDb?: (snapshotPath: string) => Promise<void>
  trustedReleaseKeys: readonly ReleaseVerificationKey[]
}

/**
 * Builds the production `UpgradePorts` backed by `@xpanel/db` repositories, real OS/disk probes,
 * cgroup-verified canary health checks, and WAL-safe control-plane snapshots.
 */
export const createProductionUpgradePorts = (deps: ProductionUpgradeDependencies): UpgradePorts => {
  if (!deps.db || !deps.fs || !deps.host || !deps.clock || !deps.reconciler) {
    fail('PRECONDITION_FAILED', 'missing required production upgrade ports')
  }

  const history: UpgradeHistoryPort = {
    async latest() {
      const r = await latestUpgrade(deps.db)
      if (!r) return null
      return {
        id: r.id,
        fromVersion: r.fromVersion,
        toVersion: r.toVersion,
        status: r.status,
        phase: r.phase,
      }
    },
    async create(input) {
      const rec = await createUpgrade(deps.db, {
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        actor: input.actor,
        fromSchemaVersion: input.fromSchemaVersion,
      })
      return { id: rec.id }
    },
    async setPhase(id, phase, extra) {
      await setUpgradePhase(deps.db, id, phase, extra)
    },
    async finish(id, outcome) {
      await finishUpgrade(deps.db, id, outcome)
    },
  }

  const migrator: MigratorPort = {
    async currentSchema() {
      return currentSchemaVersion(deps.db)
    },
    async pending(releaseDir) {
      const migrations = await deps.loadReleaseMigrations(releaseDir)
      const cur = await currentSchemaVersion(deps.db)
      return migrations
        .filter((m) => m.version > cur)
        .sort((a, b) => a.version - b.version)
        .map((m) => ({ version: m.version, name: m.name, contract: m.contract }))
    },
    async apply(releaseDir) {
      const migrations = await deps.loadReleaseMigrations(releaseDir)
      const res = await migrate(deps.db, { migrations })
      return { applied: res.applied, version: res.version }
    },
  }

  const health: HealthPort = {
    async servedUid(username) {
      const probe = await deps.probeCanaryHttp(username)
      if (!probe.serviceActive || probe.httpStatus < 200 || probe.httpStatus >= 400) {
        throw new Error(`canary HTTP probe for ${username} returned status ${probe.httpStatus} (serviceActive=${String(probe.serviceActive)})`)
      }
      if (probe.servedByUid !== null && probe.cgroupSlice !== `xpanel-${probe.servedByUid}.slice`) {
        throw new Error(`canary ${username} cgroup slice mismatch: expected xpanel-${probe.servedByUid}.slice, got ${String(probe.cgroupSlice)}`)
      }
      return probe.servedByUid
    },
    async panelLogin() {
      return deps.probePanelLogin()
    },
  }

  const system: SystemProbePort = {
    async freeBytes(path) {
      return deps.probeFreeBytes(path)
    },
    async os() {
      return deps.probeOsRelease()
    },
  }

  const transfers: TransferProbePort = {
    async activeCount() {
      return deps.probeActiveTransfers()
    },
  }

  const audit: AuditPort =
    deps.audit ?? {
      async record(entry: AuditEntry) {
        await appendAudit(deps.db, {
          actor: entry.actor,
          action: entry.action,
          target: entry.target,
          outcome: entry.outcome,
          detail: entry.detail,
        })
      },
    }

  const wrappedHost: HostPort = {
    async apply(action: HostAction): Promise<ExecResult> {
      const res = await deps.host.apply(action)
      if (res.code === 0 && action.kind === 'exec' && action.argv[0]?.endsWith('/tar')) {
        const fileFlag = action.argv.find((a) => a.startsWith('--file='))?.slice('--file='.length)
        if (fileFlag && action.argv.includes('--create') && action.argv.includes('state') && deps.snapshotControlPlaneDb) {
          await deps.snapshotControlPlaneDb(fileFlag)
        } else if (fileFlag && action.argv.includes('--extract') && action.argv.some((a) => a.startsWith('--directory=')) && deps.restoreControlPlaneDb) {
          await deps.restoreControlPlaneDb(fileFlag)
        }
      }
      return res
    },
  }

  return {
    host: wrappedHost,
    fs: deps.fs,
    reconciler: deps.reconciler,
    migrator,
    health,
    system,
    transfers,
    history,
    clock: deps.clock,
    audit,
  }
}

export class PanelUpgradeRunner {
  private readonly deps: ProductionUpgradeDependencies
  readonly ports: UpgradePorts

  constructor(deps: ProductionUpgradeDependencies) {
    this.deps = deps
    this.ports = createProductionUpgradePorts(deps)
  }

  /**
   * Verifies the signed release manifest against trusted keys, then runs the atomic
   * side-by-side upgrade state machine (`runUpgrade`) with health gate and automatic rollback.
   */
  async executeSignedUpgrade(
    plan: UpgradePlan,
    signedManifest: SignedReleaseManifest,
  ): Promise<UpgradeResult> {
    normalizeUpgradePlan(plan)
    if (
      signedManifest.version !== plan.release.version ||
      signedManifest.schemaVersion !== plan.release.schemaVersion ||
      signedManifest.sha256 !== plan.release.sha256 ||
      signedManifest.bytes !== plan.release.bytes
    ) {
      fail('VALIDATION', 'signed release manifest fields do not match upgrade plan release info')
    }
    verifyReleaseArtifactSignature(signedManifest, this.deps.trustedReleaseKeys)
    return runUpgrade(this.ports, plan)
  }

  /**
   * Recovers an interrupted upgrade after a crash or failed rollback (`recoverUpgrade`),
   * repairing the `/opt/xpanel/current` release symlink to the last healthy release if needed,
   * closing the stale in-flight row in SQLite `upgrades`, and releasing `upgrade.lock` and
   * `maintenance.json` so a subsequent valid upgrade can run cleanly.
   */
  async recoverInterruptedUpgrade(
    input: RecoverInput & { fallbackVersion?: string; fallbackGenerationId?: GenerationId },
  ): Promise<RecoverResult> {
    const layout: UpgradeLayout = { ...DEFAULT_LAYOUT, ...(input.layout ?? {}) }
    if (input.fallbackVersion) {
      const fallbackTarget = posix.join(layout.releasesDir, input.fallbackVersion)
      if (await this.deps.fs.exists(fallbackTarget)) {
        const curTarget = await this.deps.fs.readlink(layout.currentLink)
        if (curTarget !== fallbackTarget) {
          const tmp = `${layout.currentLink}.recover.tmp`
          if (await this.deps.fs.exists(tmp)) await this.deps.fs.remove(tmp)
          await this.deps.fs.symlink(fallbackTarget, tmp)
          await this.deps.fs.rename(tmp, layout.currentLink)
        }
      }
      // Clean up leftover partial target release directory if currentLink points back to fallbackVersion
      const latest = await this.ports.history.latest()
      if (latest && latest.toVersion !== input.fallbackVersion) {
        const partialReleaseDir = posix.join(layout.releasesDir, latest.toVersion)
        if (await this.deps.fs.exists(partialReleaseDir)) {
          await this.deps.fs.remove(partialReleaseDir)
        }
      }
    }
    if (input.fallbackGenerationId !== undefined) {
      await this.ports.reconciler.activate(input.fallbackGenerationId)
    }
    return recoverUpgrade(this.ports, input)
  }
}

export { isCustomerDataPath, readLock }
