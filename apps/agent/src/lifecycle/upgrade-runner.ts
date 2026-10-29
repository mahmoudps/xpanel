import { createHash, createHmac, timingSafeEqual, verify as cryptoVerify } from 'node:crypto'
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
  UpgradeSafetyPort,
} from '@xpanel/lifecycle'
import type { OsRelease } from '@xpanel/os'
import { createNativeUpgradeSafety } from '../../../../scripts/lifecycle-root-safety.mjs'

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

const MANIFEST_FIELDS = ['bytes', 'keyId', 'schemaVersion', 'sha256', 'signature', 'version']

/** Strict wire grammar: unsigned extra fields (for example release notes) are refused, not shown. */
export const parseSignedReleaseManifest = (value: unknown): SignedReleaseManifest => {
  const m = value as Record<string, unknown>
  if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).sort().join(',') !== MANIFEST_FIELDS.join(',')
    || typeof m.version !== 'string' || !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(m.version)
    || !Number.isSafeInteger(m.schemaVersion) || (m.schemaVersion as number) < 0
    || typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)
    || !Number.isSafeInteger(m.bytes) || (m.bytes as number) < 1
    || typeof m.signature !== 'string' || !/^[0-9a-f]{64,256}$/.test(m.signature)
    || typeof m.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(m.keyId)) return fail('VALIDATION', 'release manifest is malformed')
  return { version: m.version, schemaVersion: m.schemaVersion as number, sha256: m.sha256, bytes: m.bytes as number, signature: m.signature, keyId: m.keyId }
}

/** Persist only this digest in redacted job metadata; the consumer reloads the signed manifest. */
export const signedReleaseManifestDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(parseSignedReleaseManifest(value))).digest('hex')

/** Binds the signed manifest to the exact release the machine will run, then verifies the signature. */
export const verifySignedManifestForRelease = (
  manifest: SignedReleaseManifest,
  release: Pick<ReleaseInfo, 'version' | 'schemaVersion' | 'sha256' | 'bytes'>,
  trustedKeys: readonly ReleaseVerificationKey[],
): void => {
  if (
    manifest.version !== release.version ||
    manifest.schemaVersion !== release.schemaVersion ||
    manifest.sha256 !== release.sha256 ||
    manifest.bytes !== release.bytes
  ) {
    fail('VALIDATION', 'signed release manifest fields do not match upgrade plan release info')
  }
  verifyReleaseArtifactSignature(manifest, trustedKeys)
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
  /** Independently verifies native control-plane service/process and private IPC readiness; not user login or MFA. */
  probeQualifiedControlPlane: () => Promise<boolean>
  /** Performs an HTTP canary request and verifies the serving worker UID, cgroup slice, and active unit. */
  probeCanaryHttp: (canaryUsername: string) => Promise<CanaryHttpProbeResult>
  /** Legacy composition field. Native safety independently owns consistent control-plane backup. */
  snapshotControlPlaneDb?: (snapshotPath: string) => Promise<void>
  /** Legacy composition field. Automatic authority rewind is never invoked by the upgrade engine. */
  restoreControlPlaneDb?: (snapshotPath: string) => Promise<void>
  trustedReleaseKeys: readonly ReleaseVerificationKey[]
}

/**
 * Composes repository and observation ports. These callbacks are not native admission;
 * the production runner separately constructs exact-operation safety from the canonical producer.
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
    async qualifiedControlPlane() {
      return deps.probeQualifiedControlPlane()
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

  const denied = async (): Promise<never> => fail('PRECONDITION_FAILED', 'native lifecycle safety must be composed for the exact operation')
  // A structural adapter or a legacy callback never authorizes production effects.
  const safety: UpgradeSafetyPort = {
    withExclusive: denied, assertOwnedExecution: denied, assertWritersQuiescent: denied,
    assertWriteBarrier: denied, verifyRelease: denied, unpackVerifiedRelease: denied,
    verifyStagedRelease: denied, assertCompatibility: denied, snapshotControlPlane: denied,
    restoreControlPlane: denied, syncPath: denied,
  }

  return {
    safety,
    host: deps.host,
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
    verifySignedManifestForRelease(signedManifest, plan.release, this.deps.trustedReleaseKeys)
    const safety = await createNativeUpgradeSafety({ db: this.deps.db, actorId: plan.actor.id, operation: 'upgrade', release: plan.release, ...(plan.layout ? { layout: plan.layout } : {}) })
    return runUpgrade({ ...this.ports, safety }, plan)
  }

  /**
   * Recovers an interrupted upgrade after a crash or failed rollback (`recoverUpgrade`),
   * observing current authority under native ownership. Historical state and generations are
   * never restored by a caller-supplied fallback parameter; retirement remains separately owned.
   */
  async recoverInterruptedUpgrade(
    input: RecoverInput & { fallbackVersion?: string; fallbackGenerationId?: GenerationId },
  ): Promise<RecoverResult> {
    if (input.fallbackVersion !== undefined || input.fallbackGenerationId !== undefined) return fail('PRECONDITION_FAILED', 'automatic recovery pointer or generation mutation is unsupported; admit current-authority repair separately')
    const safety = await createNativeUpgradeSafety({ db: this.deps.db, actorId: input.actor.id, operation: 'recover', ...(input.layout ? { layout: input.layout } : {}) })
    return recoverUpgrade({ ...this.ports, safety }, input)
  }
}

export { isCustomerDataPath, readLock }
