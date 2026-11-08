import { createPublicKey, verify } from 'node:crypto'
import { fail } from '@xpanel/core'
import { applicationDigest } from '../../../packages/os/src/application-artifact.ts'
import { CTR_APPS } from './ctr-apps.ts'
import type { CtrApp } from './ctr-apps.ts'
import { parseComposeServices, STACK_NAME } from './ctr-compose.ts'
import type { SwApplicationCatalogFiles } from './sw-application-catalog-store.ts'

/**
 * The container app catalog: apps shipped with the panel, overlaid by a feed signed with the release keys. The same
 * envelope, trust anchors and sequence floor as the application catalog, under its own signing domain, so a rolled
 * back or expired feed is refused and the shipped apps always remain.
 */
export interface CtrCatalogRead { source: 'bundled' | 'signed'; sequence: number | null; expiresAt: string | null; reason: string | null; apps: readonly CtrApp[] }
export interface CtrCatalog { read(): Promise<CtrCatalogRead>; import(text: string): Promise<CtrCatalogRead> }
const MAX_BYTES = 1024 * 1024, MAX_APPS = 64, MAX_LIFETIME_MS = 90 * 86400_000, FUTURE_SKEW_MS = 300_000
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(value).sort().join() === [...fields].sort().join()
const instant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const line = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const invalid = (): never => fail('VALIDATION', 'the signed container catalog is malformed or not current', { stateChanged: false, reason: 'catalog_invalid' })
export const ctrCatalogSigningBytes = (payload: string): Buffer => Buffer.from('xpanel-container-apps-v1\n' + payload, 'utf8')

function parseApp(raw: unknown): CtrApp {
  if (!object(raw) || !exact(raw, ['id', 'name', 'description', 'version', 'port', 'secrets', 'yaml']) || typeof raw.id !== 'string' || !STACK_NAME.test(raw.id) || !line(raw.name, 64) || !line(raw.description, 240) || !line(raw.version, 64) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(raw.version)
    || !Number.isSafeInteger(raw.port) || (raw.port as number) < 1 || (raw.port as number) > 65535 || !Array.isArray(raw.secrets) || raw.secrets.length > 8 || !raw.secrets.every(item => typeof item === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(item)) || typeof raw.yaml !== 'string') return invalid()
  const app = raw as unknown as CtrApp
  // An app must compile with its install variables before it can reach an operator.
  parseComposeServices(app.id, app.yaml, ['VERSION=' + app.version, 'BIND=127.0.0.1', 'HOST_PORT=8080', ...app.secrets.map(key => key + '=x')].join('\n'))
  return app
}
export function verifyCtrCatalog(text: string, keys: readonly { keyId: string; publicKeyPem: string }[], now: Date, minimumSequence: number): { sequence: number; expiresAt: string; revision: string; apps: CtrApp[] } {
  let envelope: unknown
  try { envelope = Buffer.byteLength(text) <= MAX_BYTES ? JSON.parse(text) : null } catch { envelope = null }
  if (!object(envelope) || !exact(envelope, ['keyId', 'payload', 'signature']) || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' || !/^[0-9a-f]{128}$/.test(envelope.signature)) return invalid()
  const trusted = keys.find(key => key.keyId === envelope.keyId) ?? fail('FORBIDDEN', 'the container catalog signer is not trusted', { stateChanged: false, reason: 'catalog_untrusted' })
  try { if (!verify(null, ctrCatalogSigningBytes(envelope.payload), createPublicKey(trusted.publicKeyPem), Buffer.from(envelope.signature, 'hex'))) return invalid() } catch { return invalid() }
  let raw: unknown
  try { raw = JSON.parse(envelope.payload) } catch { return invalid() }
  if (!object(raw) || !exact(raw, ['schemaVersion', 'sequence', 'issuedAt', 'expiresAt', 'apps']) || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 1 || !instant(raw.issuedAt) || !instant(raw.expiresAt) || !Array.isArray(raw.apps) || raw.apps.length > MAX_APPS || JSON.stringify(raw) !== envelope.payload) return invalid()
  const issued = Date.parse(raw.issuedAt), expires = Date.parse(raw.expiresAt)
  if (issued > now.getTime() + FUTURE_SKEW_MS || expires <= now.getTime() || expires - issued > MAX_LIFETIME_MS || (raw.sequence as number) < minimumSequence) return fail('VALIDATION', 'the signed container catalog is expired or older than the stored one', { stateChanged: false, reason: 'catalog_stale' })
  const apps = raw.apps.map(parseApp)
  if (new Set(apps.map(app => app.id)).size !== apps.length) return invalid()
  return { sequence: raw.sequence as number, expiresAt: raw.expiresAt, revision: applicationDigest(envelope.payload), apps }
}

export function createCtrCatalog(files: SwApplicationCatalogFiles, now: () => Date = () => new Date()): CtrCatalog {
  const floor = async (): Promise<number> => { const text = await files.readFloor(); return text !== null && /^[0-9]{1,15}\n?$/.test(text) ? Number(text.trim()) : 0 }
  const keys = async (): Promise<readonly { keyId: string; publicKeyPem: string }[]> => {
    const trust = await files.readTrust()
    return trust.state === 'configured' && trust.keys.length ? trust.keys : fail('PRECONDITION_FAILED', 'no trusted release signing key is configured', { stateChanged: false, reason: 'release_keys_unavailable' })
  }
  const overlay = (signed: readonly CtrApp[]): CtrApp[] => [...signed, ...CTR_APPS.filter(app => !signed.some(item => item.id === app.id))]
  return {
    async read() {
      const text = await files.readEnvelope()
      if (text === null) return { source: 'bundled', sequence: null, expiresAt: null, reason: null, apps: CTR_APPS }
      try { const verified = verifyCtrCatalog(text, await keys(), now(), await floor()); return { source: 'signed', sequence: verified.sequence, expiresAt: verified.expiresAt, reason: null, apps: overlay(verified.apps) } }
      // The shipped apps stay installable when the stored feed lapses; the view says which one is in force.
      catch (error) { return { source: 'bundled', sequence: null, expiresAt: null, reason: (error as { detail?: { reason?: string } }).detail?.reason ?? 'catalog_invalid', apps: CTR_APPS } }
    },
    async import(text) {
      const verified = verifyCtrCatalog(text, await keys(), now(), await floor())
      await files.writeEnvelope(text)
      await files.writeFloor(verified.sequence + '\n')
      return { source: 'signed', sequence: verified.sequence, expiresAt: verified.expiresAt, reason: null, apps: overlay(verified.apps) }
    },
  }
}

/** The body is signature-checked before anything is stored, so the host only needs to be a public HTTPS name. */
export async function fetchCtrCatalog(url: string, get: typeof fetch = fetch): Promise<string> {
  let parsed: URL
  try { parsed = new URL(url) } catch { return fail('VALIDATION', 'the feed must be an https URL on a public host name', { stateChanged: false }) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(parsed.hostname)) return fail('VALIDATION', 'the feed must be an https URL on a public host name', { stateChanged: false })
  const response = await get(parsed, { redirect: 'error', signal: AbortSignal.timeout(30_000) }).catch(() => fail('SERVICE_UNAVAILABLE', 'the catalog feed could not be reached', { stateChanged: false, reason: 'catalog_unreachable' }))
  const text = response.ok ? await response.text() : fail('SERVICE_UNAVAILABLE', 'the catalog feed could not be read', { stateChanged: false, reason: 'catalog_unreachable' })
  return Buffer.byteLength(text) <= MAX_BYTES ? text : fail('VALIDATION', 'the signed container catalog is too large', { stateChanged: false, reason: 'catalog_invalid' })
}
