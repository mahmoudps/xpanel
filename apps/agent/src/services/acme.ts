import { X509Certificate, createHash } from 'node:crypto'
import { posix } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Certificate, ConfigTest, Domain, Id, OsProfile } from '@xpanel/core'
import { edge, services } from '@xpanel/render'
import type { AgentExecutor } from '../executor.ts'
import type { AuthoritativeDnsServiceAdapter } from './dns.ts'
import { publishCertificateCandidate } from './certificate-candidate.ts'

type AcmeChallengeType = services.AcmeChallengeType
type AcmeOrderPlan = services.AcmeOrderPlan

export const DEFAULT_ACME_WEBROOT_CHALLENGE_DIR = '/var/www/xpanel-acme/.well-known/acme-challenge'
export const DEFAULT_ACME_ORDER_STATE_DIR = '/var/lib/xpanel/acme-orders'
export const DEFAULT_TLS_READER_GROUP = 'xpanel-tls'
export const DEFAULT_CA_ISSUER_DOMAIN = 'letsencrypt.org'
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

export interface AcmeChallengeTokenMaterial {
  identifier: string
  token: string
  keyAuthorization: string
}

export interface AcmeCaClientOrderInput {
  certId: string
  identifiers: string[]
  challenge: AcmeChallengeType
  directoryUrl: string
  /** Invoked by the CA client after challenge tokens are generated so the adapter can publish HTTP-01/DNS-01 responses before validation. */
  onPublishChallenges: (challenges: readonly AcmeChallengeTokenMaterial[]) => Promise<void>
}

export interface AcmeCaClientOrderResult {
  orderUrl: string
  fullchainPem: string
  privkeyPem: string
}

export type AcmeCaClient = (input: AcmeCaClientOrderInput) => Promise<AcmeCaClientOrderResult>

export interface CaaRecordEntry {
  flags: number
  tag: 'issue' | 'issuewild' | 'iodef' | string
  value: string
}

export type CaaResolver = (domain: string) => Promise<CaaRecordEntry[]>

export interface SniHandshakeObservation {
  servername: string
  ok: boolean
  fingerprintSha256: string | null
  notAfter: string | null
  error?: string
}

export type SniHandshakeVerifier = (input: {
  servername: string
  expectedFingerprintSha256: string
  expectedCertPath: string
}) => Promise<SniHandshakeObservation>

export type AcmeOrderPhase = 'planned' | 'challenged' | 'issued' | 'installed' | 'failed'

export interface PersistedAcmeOrderState {
  certId: string
  accountId: Id | null
  identifiers: string[]
  challenge: AcmeChallengeType
  directoryUrl: string
  phase: AcmeOrderPhase
  orderUrl: string | null
  issuedPem: {
    fullchain: string
    privkey: string
  } | null
  fingerprintSha256: string | null
  notAfter: string | null
  attempts: number
  nextRetryAt: string | null
  lastError: string | null
  updatedAt: string
}

export interface AcmeCertificateAdapterOptions {
  executor: AgentExecutor
  os: OsProfile
  dnsAdapter?: AuthoritativeDnsServiceAdapter
  caClient: AcmeCaClient
  caaResolver?: CaaResolver
  sniVerifier?: SniHandshakeVerifier
  /** Challenge directory where HTTP-01 token files are staged (`/var/www/xpanel-acme/.well-known/acme-challenge`). */
  http01ChallengeDir?: string
  /** Directory where idempotent ACME order states are persisted. */
  orderStateDir?: string
  /** Group assigned to `privkey.pem` (`0640 root:xpanel-tls`). */
  tlsGroup?: string
  /** Authorized CA domain checked against CAA `issue` / `issuewild` records (default `'letsencrypt.org'`). */
  caIssuerDomain?: string
  /** Default ACME directory URL (staging or production). */
  directoryUrl?: string
}

export interface IssueOrRenewCertificateInput {
  /** Server-owned fresh issuance stages immutable files before domain binding/reconcile. */
  prepareOnly?: boolean
  certId: string
  accountId: Id | null
  callerRole: 'root' | 'reseller' | 'user'
  names: string[]
  challenge: AcmeChallengeType
  domains: readonly Pick<Domain, 'id' | 'accountId' | 'name'>[]
  hostedZones?: readonly string[]
  now?: Date
  caReferenceNow?: Date
}

export interface IssueOrRenewCertificateResult {
  application: { status: 'candidate_files_written' | 'installed'; servedTlsVerified: boolean }
  certId: string
  identifiers: string[]
  challenge: AcmeChallengeType
  resumedFromPersistedOrder: boolean
  orderUrl: string
  fullchainPath: string
  privkeyPath: string
  privkeyMode: number
  privkeyGroup: string
  fingerprintSha256: string
  notAfter: string
  sniObservations: SniHandshakeObservation[]
  certificate: Certificate
}

const assertSafeUnixPath = (what: string, p: unknown): string => {
  if (typeof p !== 'string' || p.length < 2 || p.length > 1024 || /[\u0000-\u001f\u007f]/.test(p)) {
    return fail('VALIDATION', `${what} must be a canonical absolute path`)
  }
  if (!p.startsWith('/') || posix.normalize(p) !== p || p.endsWith('/')) {
    return fail('VALIDATION', `${what} must be a normalized absolute Linux path`, { path: p })
  }
  return p
}

const baseDomainOf = (identifier: string): string =>
  identifier.startsWith('*.') ? identifier.slice(2) : identifier

/**
 * Extracts DNS SAN entries (`DNS:example.com`, `DNS:*.example.com`) from an `X509Certificate`.
 */
export const extractCertDnsSans = (cert: X509Certificate): string[] => {
  const san = cert.subjectAltName ?? ''
  const out: string[] = []
  for (const part of san.split(',')) {
    const trimmed = part.trim()
    if (trimmed.toUpperCase().startsWith('DNS:')) {
      out.push(trimmed.slice(4).trim().toLowerCase())
    }
  }
  return out
}

/**
 * Computes the uppercase colon-free SHA-256 fingerprint of the leaf certificate in a PEM chain.
 */
export const computeLeafFingerprintSha256 = (fullchainPem: string): {
  leaf: X509Certificate
  fingerprintSha256: string
  notBefore: Date
  notAfter: Date
  dnsSans: string[]
} => {
  const blocks = fullchainPem.split(/(?<=-----END CERTIFICATE-----)\r?\n?/).filter((b) => b.trim() !== '')
  const firstBlock = blocks[0]
  if (!firstBlock) {
    return fail('VALIDATION', 'certificate chain is empty')
  }
  let leaf: X509Certificate
  try {
    leaf = new X509Certificate(firstBlock)
  } catch {
    return fail('VALIDATION', 'leaf certificate is not a valid X.509 block')
  }
  const fingerprintSha256 = createHash('sha256').update(leaf.raw).digest('hex')
  const notBefore = new Date(leaf.validFrom)
  const notAfter = new Date(leaf.validTo)
  const dnsSans = extractCertDnsSans(leaf)
  return { leaf, fingerprintSha256, notBefore, notAfter, dnsSans }
}

/**
 * Validates that a certificate chain and private key match, are currently valid at `now`,
 * and cover every requested identifier in the order.
 */
export const verifyIssuedCertificateBundle = (
  fullchainRaw: string,
  privkeyRaw: string,
  requiredIdentifiers: readonly string[],
  now: Date,
): {
  fullchain: string
  privkey: string
  fingerprintSha256: string
  notAfterIso: string
  dnsSans: string[]
} => {
  const fullchain = services.assertFullchainPem(fullchainRaw)
  const privkey = services.assertPrivateKeyPem(privkeyRaw)
  services.assertKeyPair(fullchain, privkey)

  const { fingerprintSha256, notBefore, notAfter, dnsSans } = computeLeafFingerprintSha256(fullchain)
  const nowMs = now.getTime()
  if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) {
    fail('VALIDATION', 'certificate validity timestamps could not be parsed')
  }
  if (nowMs < notBefore.getTime() - MAX_CLOCK_SKEW_MS) {
    fail('VALIDATION', `certificate is not valid until ${notBefore.toISOString()}`)
  }
  if (nowMs >= notAfter.getTime()) {
    fail('VALIDATION', `certificate has already expired at ${notAfter.toISOString()}`)
  }

  const sanSet = new Set(dnsSans.map((s) => s.toLowerCase()))
  for (const id of requiredIdentifiers) {
    const normalized = services.normalizeCertName(id)
    if (normalized.startsWith('*.')) {
      if (!sanSet.has(normalized)) {
        fail('VALIDATION', `issued certificate SANs (${dnsSans.join(', ')}) do not include wildcard ${normalized}`, {
          missingIdentifier: normalized,
          dnsSans,
        })
      }
    } else if (!services.coversHost(dnsSans, normalized)) {
      fail('VALIDATION', `issued certificate SANs (${dnsSans.join(', ')}) do not cover ${normalized}`, {
        missingIdentifier: normalized,
        dnsSans,
      })
    }
  }

  return {
    fullchain,
    privkey,
    fingerprintSha256,
    notAfterIso: notAfter.toISOString(),
    dnsSans,
  }
}

/**
 * Evaluates RFC 8659 CAA authorization for a single identifier (`example.com` or `*.example.com`).
 */
export const isIdentifierAuthorizedByCaa = (
  identifier: string,
  caaRecords: readonly CaaRecordEntry[],
  caIssuerDomain: string,
): boolean => {
  if (caaRecords.length === 0) return true
  const isWild = identifier.startsWith('*.')
  const relevantTag = isWild && caaRecords.some((r) => r.tag === 'issuewild') ? 'issuewild' : 'issue'
  const matching = caaRecords.filter((r) => r.tag === relevantTag)
  if (matching.length === 0) {
    // Unknown critical flag check (RFC 8659 §5)
    const unknownCritical = caaRecords.some(
      (r) => (r.flags & 0x80) !== 0 && r.tag !== 'issue' && r.tag !== 'issuewild' && r.tag !== 'iodef',
    )
    return !unknownCritical
  }
  const expectedIssuer = caIssuerDomain.trim().toLowerCase()
  return matching.some((r) => {
    const domainPart = (r.value.split(';')[0] ?? '').trim().toLowerCase()
    return domainPart === expectedIssuer
  })
}

/**
 * Production ACME Certificate Issuance, Renewal & SNI Installation Adapter (D03 — A39).
 */
export class AcmeCertificateServiceAdapter {
  readonly executor: AgentExecutor
  readonly os: OsProfile
  readonly dnsAdapter: AuthoritativeDnsServiceAdapter | undefined
  readonly caClient: AcmeCaClient
  readonly caaResolver: CaaResolver | undefined
  readonly sniVerifier: SniHandshakeVerifier
  readonly http01ChallengeDir: string
  readonly orderStateDir: string
  readonly tlsGroup: string
  readonly caIssuerDomain: string
  readonly directoryUrl: string
  private readonly locks = new Map<string, Promise<void>>()
  private readonly hasSniVerifier: boolean

  constructor(opts: AcmeCertificateAdapterOptions) {
    if (!opts?.executor || !opts?.os || typeof opts.caClient !== 'function') {
      fail('VALIDATION', 'AcmeCertificateServiceAdapter requires executor, os, and caClient')
    }
    this.executor = opts.executor
    this.os = opts.os
    this.dnsAdapter = opts.dnsAdapter
    this.caClient = opts.caClient
    this.caaResolver = opts.caaResolver
    this.http01ChallengeDir = assertSafeUnixPath(
      'http01ChallengeDir',
      opts.http01ChallengeDir ?? DEFAULT_ACME_WEBROOT_CHALLENGE_DIR,
    )
    this.orderStateDir = assertSafeUnixPath('orderStateDir', opts.orderStateDir ?? DEFAULT_ACME_ORDER_STATE_DIR)
    const tlsGroup = opts.tlsGroup ?? DEFAULT_TLS_READER_GROUP
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(tlsGroup)) {
      fail('VALIDATION', 'tlsGroup must be a valid Linux group name')
    }
    this.tlsGroup = tlsGroup
    this.caIssuerDomain = services.normalizeHostname(opts.caIssuerDomain ?? DEFAULT_CA_ISSUER_DOMAIN, 'CA issuer domain')
    this.directoryUrl = opts.directoryUrl ?? 'https://acme-v02.api.letsencrypt.org/directory'
    this.hasSniVerifier = typeof opts.sniVerifier === 'function'
    this.sniVerifier =
      opts.sniVerifier ??
      (async ({ servername }) => ({
        servername,
        ok: false,
        fingerprintSha256: null,
        notAfter: null,
        error: 'served_certificate_verifier_unavailable',
      }))
  }

  private async withMultiKeyLock<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const sortedUnique = [...new Set(keys)].sort((a, b) => a.localeCompare(b))
    const runAt = async (idx: number): Promise<T> => {
      const key = sortedUnique[idx]
      if (!key) return fn()
      const previous = this.locks.get(key) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      const chained = previous.then(() => current)
      this.locks.set(key, chained)
      await previous
      try {
        return await runAt(idx + 1)
      } finally {
        release()
        if (this.locks.get(key) === chained) {
          this.locks.delete(key)
        }
      }
    }
    return runAt(0)
  }

  private orderStatePath(certId: string): string {
    services.certFiles(certId)
    return `${this.orderStateDir}/${certId}.json`
  }

  async readOrderState(certId: string): Promise<PersistedAcmeOrderState | null> {
    const path = this.orderStatePath(certId)
    const raw = await this.executor.readFile(path)
    if (!raw) return null
    try {
      return JSON.parse(raw) as PersistedAcmeOrderState
    } catch {
      return null
    }
  }

  private async writeOrderState(state: PersistedAcmeOrderState): Promise<void> {
    const path = this.orderStatePath(state.certId)
    await this.executor.runAction({
      kind: 'ensure-dir',
      path: this.orderStateDir,
      mode: 0o700,
      owner: 'root',
      group: 'root',
    })
    await this.executor.writeFile({
      path,
      content: `${JSON.stringify(state, null, 2)}\n`,
      mode: 0o600,
      owner: 'root',
      group: 'root',
    })
  }

  /**
   * Verifies that the caller owns every domain in the requested certificate names.
   */
  private assertDomainOwnership(
    identifiers: readonly string[],
    accountId: Id | null,
    callerRole: 'root' | 'reseller' | 'user',
    domains: readonly Pick<Domain, 'id' | 'accountId' | 'name'>[],
  ): void {
    for (const id of identifiers) {
      const base = baseDomainOf(id)
      const matchedDomain = domains.find(
        (d) => d.name === base || base.endsWith(`.${d.name}`),
      )
      if (!matchedDomain) {
        return fail('FORBIDDEN', `domain "${base}" is not registered on this server`, { identifier: id })
      }
      if (callerRole !== 'root' && matchedDomain.accountId !== accountId) {
        fail(
          'FORBIDDEN',
          `account "${String(accountId)}" does not own domain "${base}" required for certificate "${id}"`,
          { identifier: id, domain: base },
        )
      }
    }
  }

  /**
   * Checks CAA records for all requested identifiers before placing an ACME order.
   */
  private async verifyCaaPreflight(identifiers: readonly string[]): Promise<void> {
    for (const id of identifiers) {
      const base = baseDomainOf(id)
      const caaRecords: CaaRecordEntry[] = []

      if (this.caaResolver) {
        caaRecords.push(...(await this.caaResolver(base)))
      } else if (this.dnsAdapter) {
        const liveZone = await this.dnsAdapter.readLiveZone(base).catch(() => null)
        if (liveZone) {
          for (const rec of liveZone.records) {
            if (rec.type === 'CAA' && rec.name === '@') {
              const m = /^(\d+)\s+([a-z0-9]+)\s+"([^"]*)"$/i.exec(rec.content.trim())
              if (m) {
                caaRecords.push({
                  flags: Number(m[1]),
                  tag: (m[2] ?? '').toLowerCase(),
                  value: m[3] ?? '',
                })
              }
            }
          }
        }
      }

      if (!isIdentifierAuthorizedByCaa(id, caaRecords, this.caIssuerDomain)) {
        fail(
          'PRECONDITION_FAILED',
          `CAA policy for ${base} forbids issuance by ${this.caIssuerDomain} for identifier ${id}`,
          {
            identifier: id,
            caIssuerDomain: this.caIssuerDomain,
          },
        )
      }
    }
  }

  private assertClockPreflight(now: Date, caReferenceNow?: Date): void {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      fail('VALIDATION', 'now must be a valid Date')
    }
    if (caReferenceNow) {
      const skewMs = Math.abs(now.getTime() - caReferenceNow.getTime())
      if (skewMs > MAX_CLOCK_SKEW_MS) {
        fail('PRECONDITION_FAILED', `host clock skew (${Math.round(skewMs / 1000)}s) exceeds 300s ACME threshold`, {
          skewMs,
        })
      }
    }
  }

  /**
   * Publishes HTTP-01 or DNS-01 challenges and returns a cleanup callback that is guaranteed
   * to run in `finally` even if validation or CA issuance fails or is cancelled.
   */
  private async publishChallengesWithCleanup(
    plan: AcmeOrderPlan,
    challenges: readonly AcmeChallengeTokenMaterial[],
    now: Date,
  ): Promise<() => Promise<void>> {
    const stagedHttpPaths: string[] = []
    const publishedDnsTokens: { zone: string; recordName: string; tokens: string[] }[] = []

    const cleanup = async (): Promise<void> => {
      for (const path of stagedHttpPaths) {
        await this.executor.removePath(path).catch(() => undefined)
      }
      if (this.dnsAdapter && publishedDnsTokens.length > 0) {
        for (const item of publishedDnsTokens) {
          await this.dnsAdapter
            .removeAcmeChallengeTxt(item.zone, item.recordName, item.tokens, { now })
            .catch(() => undefined)
        }
      }
    }

    try {
      if (plan.challenge === 'http-01') {
        await this.executor.runAction({
          kind: 'ensure-dir',
          path: this.http01ChallengeDir,
          mode: 0o755,
          owner: 'root',
          group: 'root',
        })
        await this.executor.runAction({
          kind: 'ensure-dir',
          path: edge.XP_PATHS.acmeDir,
          mode: 0o755,
          owner: 'root',
          group: 'root',
        })

        for (const ch of challenges) {
          // Validate token and keyAuthorization strictly via @xpanel/render's http01File
          const rendered = services.http01File(ch.token, ch.keyAuthorization)
          const primaryPath = `${this.http01ChallengeDir}/${ch.token}`
          await this.executor.writeFile({
            ...rendered,
            path: primaryPath,
          })
          stagedHttpPaths.push(primaryPath)
          if (rendered.path !== primaryPath) {
            await this.executor.writeFile(rendered)
            stagedHttpPaths.push(rendered.path)
          }
        }
      } else {
        const dnsAdapter = this.dnsAdapter
        if (!dnsAdapter) {
          return fail('PRECONDITION_FAILED', 'ACME dns-01 challenge requires an AuthoritativeDnsServiceAdapter')
        }
        const byRecord = new Map<string, { zone: string; recordName: string; tokens: string[] }>()
        for (const step of plan.steps) {
          if (step.challenge !== 'dns-01') continue
          const ch = challenges.find((c) => c.identifier === step.identifier)
          if (!ch) {
            return fail('VALIDATION', `missing ACME challenge material for identifier ${step.identifier}`)
          }
          const txtDigest = services.dns01Value(ch.keyAuthorization)
          const existing: { zone: string; recordName: string; tokens: string[] } = byRecord.get(step.recordName) ?? {
            zone: step.zone,
            recordName: step.recordName,
            tokens: [],
          }
          if (!existing.tokens.includes(txtDigest)) {
            existing.tokens.push(txtDigest)
          }
          byRecord.set(step.recordName, existing)
        }

        for (const entry of byRecord.values()) {
          await dnsAdapter.publishAcmeChallengeTxt(entry.zone, entry.recordName, entry.tokens, { now })
          publishedDnsTokens.push(entry)
        }
      }

      return cleanup
    } catch (err) {
      await cleanup()
      throw err
    }
  }

  /**
   * Installs a validated PEM certificate and private key (`0640 root:xpanel-tls`),
   * tests and reloads Nginx/Apache, verifies SNI handshakes, and rolls back to the
   * previous valid certificate if any step fails.
   */
  private async installValidatedCertificateWithRollback(input: {
    certId: string
    identifiers: readonly string[]
    fullchain: string
    privkey: string
    fingerprintSha256: string
  }): Promise<{
    fullchainPath: string
    privkeyPath: string
    sniObservations: SniHandshakeObservation[]
  }> {
    const paths = services.certFiles(input.certId)
    const previousFullchain = await this.executor.readFile(paths.fullchain)
    const previousPrivkey = await this.executor.readFile(paths.privkey)
    const hadPreviousCert = previousFullchain !== null && previousPrivkey !== null

    const installPlan = services.certInstall(input.certId, {
      fullchain: input.fullchain,
      privkey: input.privkey,
    })

    for (const action of installPlan.actions) {
      await this.executor.runAction(action)
    }

    // Write fullchain (0644 root:root) and privkey (0640 root:xpanel-tls)
    await this.executor.writeFile({
      path: paths.fullchain,
      content: input.fullchain,
      mode: 0o644,
      owner: 'root',
      group: 'root',
    })
    await this.executor.writeFile({
      path: paths.privkey,
      content: input.privkey,
      mode: 0o640,
      owner: 'root',
      group: this.tlsGroup,
    })

    try {
      const nginxTest = await this.executor.runTest(edge.nginxConfigTest(this.os))
      if (!nginxTest.ok) {
        fail('CONFIG_TEST_FAILED', `nginx config test failed after installing certificate ${input.certId}: ${nginxTest.stderr}`)
      }
      const apacheTest = await this.executor.runTest(edge.apacheConfigTest(this.os))
      if (!apacheTest.ok) {
        fail('CONFIG_TEST_FAILED', `apache config test failed after installing certificate ${input.certId}: ${apacheTest.stderr}`)
      }

      await this.executor.runAction({
        kind: 'systemd',
        verb: 'reload',
        unit: this.os.services.apache,
      })
      await this.executor.runAction({
        kind: 'systemd',
        verb: 'reload',
        unit: this.os.services.nginx,
      })

      const sniObservations: SniHandshakeObservation[] = []
      for (const id of input.identifiers) {
        const probeHost = id.startsWith('*.') ? `sni-probe.${id.slice(2)}` : id
        const obs = await this.sniVerifier({
          servername: probeHost,
          expectedFingerprintSha256: input.fingerprintSha256,
          expectedCertPath: paths.fullchain,
        })
        if (!obs.ok || obs.fingerprintSha256 !== input.fingerprintSha256) {
          fail(
            'CONFIG_TEST_FAILED',
            `SNI handshake verification failed for ${probeHost}: ${obs.error ?? 'certificate fingerprint mismatch'}`,
            {
              servername: probeHost,
              expectedFingerprintSha256: input.fingerprintSha256,
              observedFingerprintSha256: obs.fingerprintSha256,
            },
          )
        }
        sniObservations.push(obs)
      }

      return {
        fullchainPath: paths.fullchain,
        privkeyPath: paths.privkey,
        sniObservations,
      }
    } catch (installErr) {
      // Restore previous valid certificate if one existed, otherwise remove the failed candidate
      try {
        if (hadPreviousCert) {
          await this.executor.writeFile({
            path: paths.fullchain,
            content: previousFullchain,
            mode: 0o644,
            owner: 'root',
            group: 'root',
          })
          await this.executor.writeFile({
            path: paths.privkey,
            content: previousPrivkey,
            mode: 0o640,
            owner: 'root',
            group: this.tlsGroup,
          })
          await this.executor.runAction({
            kind: 'systemd',
            verb: 'reload',
            unit: this.os.services.apache,
          }).catch(() => undefined)
          await this.executor.runAction({
            kind: 'systemd',
            verb: 'reload',
            unit: this.os.services.nginx,
          }).catch(() => undefined)
        } else {
          await this.executor.removePath(paths.fullchain).catch(() => undefined)
          await this.executor.removePath(paths.privkey).catch(() => undefined)
        }
      } catch {
        /* preserve primary installation failure */
      }
      throw installErr
    }
  }

  /**
   * Issues or renews an ACME certificate with:
   * - Domain ownership & CAA preflight enforcement
   * - Per-certificate and per-domain concurrency locks
   * - Idempotent order state persistence (resumes installation without duplicate CA order after a post-issuance crash)
   * - Guaranteed `finally` cleanup of HTTP-01 token files and DNS-01 TXT records
   * - Full X.509 chain + SAN + key pair validation (`0640 root:xpanel-tls`)
   * - Rollback to the existing valid certificate if Nginx/Apache reload or SNI verification fails
   */
  async issueOrRenewCertificate(input: IssueOrRenewCertificateInput): Promise<IssueOrRenewCertificateResult> {
    if (input.prepareOnly !== undefined && typeof input.prepareOnly !== 'boolean') return fail('VALIDATION', 'invalid certificate preparation mode', { stateChanged: false })
    const now = input.now ?? new Date()
    this.assertClockPreflight(now, input.caReferenceNow)
    services.certFiles(input.certId)

    const plan = services.planAcmeOrder(input.names, input.challenge, {
      ...(input.hostedZones !== undefined && { zones: [...input.hostedZones] }),
    })

    const lockKeys = [
      `cert:${input.certId}`,
      ...plan.identifiers.map((id) => `domain:${baseDomainOf(id)}`),
    ]

    return this.withMultiKeyLock(lockKeys, async () => {
      this.assertDomainOwnership(plan.identifiers, input.accountId, input.callerRole, input.domains)
      await this.verifyCaaPreflight(plan.identifiers)
      if (!input.prepareOnly && !this.hasSniVerifier) return fail('PRECONDITION_FAILED', 'a real served-certificate verifier is required for installation', { stateChanged: false })

      const existingOrder = await this.readOrderState(input.certId)
      if (existingOrder && (existingOrder.certId !== input.certId || existingOrder.accountId !== input.accountId
        || existingOrder.directoryUrl !== this.directoryUrl || existingOrder.challenge !== plan.challenge
        || !Array.isArray(existingOrder.identifiers) || existingOrder.identifiers.length > 100 || !existingOrder.identifiers.every(name => typeof name === 'string')
        || !Number.isSafeInteger(existingOrder.attempts) || existingOrder.attempts < 0 || existingOrder.attempts > 1_000_000)) return fail('PRECONDITION_FAILED', 'persisted certificate order authority requires review')
      const sameIdentifiers =
        existingOrder !== null &&
        existingOrder.identifiers.length === plan.identifiers.length &&
        existingOrder.identifiers.every((id, idx) => id === plan.identifiers[idx])

      let orderUrl = existingOrder?.orderUrl ?? ''
      let resumedFromPersistedOrder = false
      let validatedBundle: ReturnType<typeof verifyIssuedCertificateBundle> | null = null

      // Resume installation if a previous run crashed after CA issuance ('issued') with a valid certificate
      if (sameIdentifiers && existingOrder?.phase === 'issued' && existingOrder.issuedPem) {
        try {
          validatedBundle = verifyIssuedCertificateBundle(
            existingOrder.issuedPem.fullchain,
            existingOrder.issuedPem.privkey,
            plan.identifiers,
            now,
          )
          resumedFromPersistedOrder = true
        } catch {
          validatedBundle = null
        }
      }

      const attempts = (existingOrder?.attempts ?? 0) + 1
      let state: PersistedAcmeOrderState = {
        certId: input.certId,
        accountId: input.accountId,
        identifiers: plan.identifiers,
        challenge: plan.challenge,
        directoryUrl: this.directoryUrl,
        phase: resumedFromPersistedOrder ? 'issued' : 'planned',
        orderUrl: existingOrder?.orderUrl ?? null,
        issuedPem: resumedFromPersistedOrder ? existingOrder!.issuedPem : null,
        fingerprintSha256: validatedBundle?.fingerprintSha256 ?? null,
        notAfter: validatedBundle?.notAfterIso ?? null,
        attempts,
        nextRetryAt: null,
        lastError: null,
        updatedAt: now.toISOString(),
      }
      await this.writeOrderState(state)

      try {
        if (!validatedBundle) {
          let cleanupChallenges: (() => Promise<void>) | null = null
          try {
            const caResult = await this.caClient({
              certId: input.certId,
              identifiers: plan.identifiers,
              challenge: plan.challenge,
              directoryUrl: this.directoryUrl,
              onPublishChallenges: async (challenges) => {
                cleanupChallenges = await this.publishChallengesWithCleanup(plan, challenges, now)
                state = {
                  ...state,
                  phase: 'challenged',
                  updatedAt: new Date().toISOString(),
                }
                await this.writeOrderState(state)
              },
            })

            orderUrl = caResult.orderUrl
            validatedBundle = verifyIssuedCertificateBundle(
              caResult.fullchainPem,
              caResult.privkeyPem,
              plan.identifiers,
              now,
            )

            // Persist 'issued' checkpoint BEFORE installation so a crash during reload/SNI does not re-order from CA
            state = {
              ...state,
              phase: 'issued',
              orderUrl,
              issuedPem: {
                fullchain: validatedBundle.fullchain,
                privkey: validatedBundle.privkey,
              },
              fingerprintSha256: validatedBundle.fingerprintSha256,
              notAfter: validatedBundle.notAfterIso,
              updatedAt: new Date().toISOString(),
            }
            await this.writeOrderState(state)
          } finally {
            if (cleanupChallenges !== null) {
              await (cleanupChallenges as () => Promise<void>)()
            }
          }
        }

        const candidateBundle = validatedBundle
        const installed = input.prepareOnly ? await (async () => {
          const files = await publishCertificateCandidate({ executor: this.executor, certificateId: input.certId,
            fullchain: candidateBundle.fullchain, privateKey: candidateBundle.privkey })
          return { fullchainPath: files.certPath, privkeyPath: files.keyPath, sniObservations: [] as SniHandshakeObservation[] }
        })() : await this.installValidatedCertificateWithRollback({
          certId: input.certId,
          identifiers: plan.identifiers,
          fullchain: validatedBundle.fullchain,
          privkey: validatedBundle.privkey,
          fingerprintSha256: validatedBundle.fingerprintSha256,
        })

        state = {
          ...state,
          phase: input.prepareOnly ? 'issued' : 'installed',
          issuedPem: input.prepareOnly ? state.issuedPem : null,
          lastError: null,
          nextRetryAt: null,
          updatedAt: new Date().toISOString(),
        }
        await this.writeOrderState(state)

        const certificate: Certificate = {
          id: input.certId,
          accountId: input.accountId,
          names: plan.identifiers,
          source: 'acme',
          challenge: plan.challenge,
          notAfter: validatedBundle.notAfterIso,
          autoRenew: true,
        }

        return {
          application: { status: input.prepareOnly ? 'candidate_files_written' : 'installed', servedTlsVerified: !input.prepareOnly },
          certId: input.certId,
          identifiers: plan.identifiers,
          challenge: plan.challenge,
          resumedFromPersistedOrder,
          orderUrl,
          fullchainPath: installed.fullchainPath,
          privkeyPath: installed.privkeyPath,
          privkeyMode: input.prepareOnly ? 0o600 : 0o640,
          privkeyGroup: input.prepareOnly ? 'root' : this.tlsGroup,
          fingerprintSha256: validatedBundle.fingerprintSha256,
          notAfter: validatedBundle.notAfterIso,
          sniObservations: installed.sniObservations,
          certificate,
        }
      } catch (err) {
        const backoffMinutes = Math.min(24 * 60, 5 * 2 ** Math.min(attempts - 1, 8))
        const nextRetryAt = new Date(now.getTime() + backoffMinutes * 60_000).toISOString()
        const errMsg = isXpanelError(err) ? err.message : err instanceof Error ? err.message : String(err)

        // If CA already issued a valid bundle and only installation/reload failed, keep phase='issued' so retry resumes installation!
        const preserveIssuedCheckpoint = validatedBundle !== null && state.issuedPem !== null
        state = {
          ...state,
          phase: preserveIssuedCheckpoint ? 'issued' : 'failed',
          lastError: errMsg,
          nextRetryAt,
          updatedAt: new Date().toISOString(),
        }
        await this.writeOrderState(state).catch(() => undefined)
        throw err
      }
    })
  }
}
