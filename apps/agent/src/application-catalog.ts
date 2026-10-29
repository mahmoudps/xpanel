import { createPublicKey, verify } from 'node:crypto'
import { fail } from '@xpanel/core'
import { applicationDigest, isApplicationId, isApplicationVersion, readApplicationArtifactDescriptor } from '../../../packages/os/src/application-artifact.ts'
import type { ApplicationArtifactDescriptor } from '../../../packages/os/src/application-artifact.ts'

export const APPLICATION_CATALOG_LIMITS = Object.freeze({ bytes: 512 * 1024, apps: 64, releases: 8, lifetimeMs: 31 * 86400_000, futureSkewMs: 300_000 })
export interface ApplicationRelease { readonly version: string; readonly minimumPanelVersion: string; readonly artifact: Readonly<ApplicationArtifactDescriptor> }
/** `name` is the publisher's product name, shown as given in every locale. */
export interface CatalogApplication { readonly id: string; readonly name: string; readonly releases: readonly Readonly<ApplicationRelease>[] }
export interface ApplicationCatalog { readonly schemaVersion: 1; readonly sequence: number; readonly issuedAt: string; readonly expiresAt: string; readonly applications: readonly Readonly<CatalogApplication>[] }
export interface VerifiedApplicationCatalog extends ApplicationCatalog { readonly revision: string; readonly keyId: string }
/** Bootstrap configuration only; request bodies and remote catalog fields cannot supply trust anchors. */
export interface ApplicationCatalogKey { readonly keyId: string; readonly publicKeyPem: string }
export interface ApplicationCatalogPolicy { readonly now: Date; readonly minimumSequence: number; readonly panelVersion: string }
const verified = new WeakSet<object>()
const invalid = (): never => fail('VALIDATION', 'the signed application catalog is malformed or not current', { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(value).sort().join(',') === [...fields].sort().join(',')
const instant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const title = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 120 && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(value)
export function compareApplicationVersions(left: string, right: string): number {
  if (!isApplicationVersion(left) || !isApplicationVersion(right)) return invalid()
  const a = left.split('.').map(Number), b = right.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  return 0
}

/** Stable bytes with a domain separator, following the existing Ed25519 release-manifest pattern. */
export const applicationCatalogSigningBytes = (canonicalPayload: string): Buffer => Buffer.from('xpanel-application-catalog-v1\n' + canonicalPayload, 'utf8')

export function parseApplicationCatalog(value: unknown): ApplicationCatalog {
  if (!object(value) || !exact(value, ['schemaVersion', 'sequence', 'issuedAt', 'expiresAt', 'applications']) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1
    || !instant(value.issuedAt) || !instant(value.expiresAt) || !Array.isArray(value.applications) || value.applications.length > APPLICATION_CATALOG_LIMITS.apps) return invalid()
  let previous = ''
  const applications = value.applications.map(raw => {
    if (!object(raw) || !exact(raw, ['id', 'name', 'releases']) || !isApplicationId(raw.id) || raw.id <= previous || !title(raw.name)
      || !Array.isArray(raw.releases) || raw.releases.length < 1 || raw.releases.length > APPLICATION_CATALOG_LIMITS.releases) return invalid()
    previous = raw.id
    let lastVersion: string | null = null
    const releases = raw.releases.map(item => {
      if (!object(item) || !exact(item, ['version', 'minimumPanelVersion', 'artifact']) || !isApplicationVersion(item.version) || !isApplicationVersion(item.minimumPanelVersion)
        || lastVersion !== null && compareApplicationVersions(lastVersion, item.version) <= 0) return invalid()
      lastVersion = item.version
      return Object.freeze({ version: item.version, minimumPanelVersion: item.minimumPanelVersion, artifact: readApplicationArtifactDescriptor(item.artifact) })
    })
    return Object.freeze({ id: raw.id, name: raw.name, releases: Object.freeze(releases) })
  })
  return Object.freeze({ schemaVersion: 1, sequence: Number(value.sequence), issuedAt: value.issuedAt, expiresAt: value.expiresAt, applications: Object.freeze(applications) })
}

const assertTime = (catalog: ApplicationCatalog, policy: ApplicationCatalogPolicy): void => {
  if (!(policy.now instanceof Date) || !Number.isFinite(policy.now.getTime()) || !Number.isSafeInteger(policy.minimumSequence) || policy.minimumSequence < 0 || !isApplicationVersion(policy.panelVersion)
    || catalog.sequence < policy.minimumSequence || Date.parse(catalog.issuedAt) > policy.now.getTime() + APPLICATION_CATALOG_LIMITS.futureSkewMs
    || Date.parse(catalog.expiresAt) <= policy.now.getTime() || Date.parse(catalog.expiresAt) <= Date.parse(catalog.issuedAt)
    || Date.parse(catalog.expiresAt) - Date.parse(catalog.issuedAt) > APPLICATION_CATALOG_LIMITS.lifetimeMs) return invalid()
}

/** Envelope is {keyId,payload,signature}; payload is exact canonical JSON, signature lowercase Ed25519 hex. */
export function verifyApplicationCatalog(value: unknown, keys: readonly ApplicationCatalogKey[], policy: ApplicationCatalogPolicy): VerifiedApplicationCatalog {
  if (!object(value) || !exact(value, ['keyId', 'payload', 'signature']) || typeof value.keyId !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(value.keyId)
    || typeof value.payload !== 'string' || Buffer.byteLength(value.payload) > APPLICATION_CATALOG_LIMITS.bytes || typeof value.signature !== 'string' || !/^[0-9a-f]{128}$/.test(value.signature)) return invalid()
  if (!Array.isArray(keys) || keys.length > 32 || new Set(keys.map(key => key.keyId)).size !== keys.length) return fail('PRECONDITION_FAILED', 'application catalog trust configuration is invalid', { stateChanged: false })
  const trusted = keys.find(key => key.keyId === value.keyId)
  if (!trusted) return fail('FORBIDDEN', 'the application catalog signer is not trusted', { stateChanged: false })
  try {
    const publicKey = createPublicKey(trusted.publicKeyPem)
    if (publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, applicationCatalogSigningBytes(value.payload), publicKey, Buffer.from(value.signature, 'hex'))) return invalid()
  } catch { return invalid() }
  let raw: unknown
  try { raw = JSON.parse(value.payload) } catch { return invalid() }
  const catalog = parseApplicationCatalog(raw)
  if (JSON.stringify(catalog) !== value.payload) return invalid()
  assertTime(catalog, policy)
  const result = Object.freeze({ ...catalog, revision: applicationDigest(value.payload), keyId: value.keyId })
  verified.add(result)
  return result
}

export function assertApplicationCatalogCurrent(catalog: VerifiedApplicationCatalog, policy: ApplicationCatalogPolicy): void {
  if (!verified.has(catalog)) return fail('FORBIDDEN', 'an application catalog must be verified by a trusted signer', { stateChanged: false })
  assertTime(catalog, policy)
}

export function selectApplicationRelease(catalog: VerifiedApplicationCatalog, appId: string, version: string, policy: ApplicationCatalogPolicy): Readonly<ApplicationRelease> {
  assertApplicationCatalogCurrent(catalog, policy)
  const release = catalog.applications.find(app => app.id === appId)?.releases.find(item => item.version === version)
  if (!release) return fail('NOT_FOUND', 'the application release is not in the signed catalog', { stateChanged: false })
  if (compareApplicationVersions(policy.panelVersion, release.minimumPanelVersion) < 0) return fail('PRECONDITION_FAILED', 'the application release requires a newer panel version', { stateChanged: false })
  return release
}
