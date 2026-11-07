import { readFile, readlink, rename, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fail } from '@xpanel/core'
import { DEFAULT_LAYOUT } from '@xpanel/lifecycle'
import { isApplicationVersion } from '../../../packages/os/src/application-artifact.ts'
import { verifyApplicationCatalog } from './application-catalog.ts'
import type { ApplicationCatalogKey, ApplicationCatalogPolicy, VerifiedApplicationCatalog } from './application-catalog.ts'
import { loadTrustedReleaseKeys } from './upgrade-observation.ts'

/**
 * Store of the signed application catalog. The only trust anchors are the release signing keys
 * (/etc/xpanel/release-keys.json), so a catalog is accepted only when the release publisher signed it. The stored
 * envelope is verified on every read, an import is verified before it replaces the stored one, and the highest
 * accepted sequence is persisted so an older (rolled-back) catalog is refused.
 */
export interface SwCatalogTrust { state: 'configured' | 'missing' | 'invalid'; keys: readonly ApplicationCatalogKey[]; reason: string | null }
export interface SwApplicationCatalogFiles {
  readTrust(): Promise<SwCatalogTrust>
  readEnvelope(): Promise<string | null>
  writeEnvelope(text: string): Promise<void>
  readFloor(): Promise<string | null>
  writeFloor(text: string): Promise<void>
}
export interface SwApplicationCatalogSource {
  catalog(): Promise<VerifiedApplicationCatalog>
  /** The stored catalog, still signed and above the floor, but possibly expired: only a removal may use it. */
  removalCatalog(): Promise<VerifiedApplicationCatalog>
  policy(): ApplicationCatalogPolicy
  trust(): Promise<SwCatalogTrust>
  /** Verifies a new envelope against the release keys and the sequence floor, then stores it. */
  import(text: string): Promise<VerifiedApplicationCatalog>
}
export const SW_CATALOG_DIRECTORY = '/var/lib/xpanel-agent/catalog'
export const SW_CATALOG_MAX_BYTES = 1024 * 1024
const unavailable = (): never => fail('PRECONDITION_FAILED', 'no signed application catalog is configured on this server', { stateChanged: false, reason: 'application_catalog_unavailable' })

export function createSwApplicationCatalogSource(files: SwApplicationCatalogFiles, panelVersion: string, now: () => Date = () => new Date()): SwApplicationCatalogSource {
  if (!isApplicationVersion(panelVersion)) throw new Error('invalid_panel_version')
  let floor = 0
  const readFloor = async (): Promise<number> => {
    const text = await files.readFloor()
    if (text === null) return 0
    if (!/^(0|[1-9][0-9]{0,14})\n?$/.test(text)) return fail('PRECONDITION_FAILED', 'the application catalog sequence record is invalid', { stateChanged: false })
    return Number(text.trim())
  }
  const keys = async (): Promise<readonly ApplicationCatalogKey[]> => {
    const trust = await files.readTrust()
    return trust.state === 'configured' && trust.keys.length ? trust.keys : fail('PRECONDITION_FAILED', 'no trusted release signing key is configured', { stateChanged: false, reason: 'release_keys_unavailable' })
  }
  const verify = async (text: string, before?: () => Promise<void>, allowExpired = false): Promise<VerifiedApplicationCatalog> => {
    const trusted = await keys()
    let envelope: unknown
    try { envelope = Buffer.byteLength(text) <= SW_CATALOG_MAX_BYTES ? JSON.parse(text) : null } catch { envelope = null }
    const stored = await readFloor()
    const verified = verifyApplicationCatalog(envelope, trusted, { now: now(), minimumSequence: stored, panelVersion, allowExpired })
    await before?.()
    if (verified.sequence > stored) await files.writeFloor(verified.sequence + '\n')
    floor = verified.sequence
    return verified
  }
  return {
    policy: () => ({ now: now(), minimumSequence: floor, panelVersion }),
    trust: () => files.readTrust(),
    async catalog() {
      const envelopeText = await files.readEnvelope()
      if (envelopeText === null) return unavailable()
      return verify(envelopeText)
    },
    async removalCatalog() {
      const envelopeText = await files.readEnvelope()
      if (envelopeText === null) return unavailable()
      return verify(envelopeText, undefined, true)
    },
    async import(text) {
      if (Buffer.byteLength(text) > SW_CATALOG_MAX_BYTES) return fail('VALIDATION', 'the signed catalog is too large', { stateChanged: false })
      // Verified before it is written, and written before the floor rises: a failed write keeps the stored catalog readable.
      return verify(text, () => files.writeEnvelope(text))
    },
  }
}

/** Release signing keys as catalog trust anchors; HMAC or unsafe key files are refused by the loader. */
export const releaseKeyCatalogTrust = async (): Promise<SwCatalogTrust> => {
  const trust = await loadTrustedReleaseKeys()
  return { state: trust.state, reason: trust.reason, keys: trust.keys.flatMap(key => key.kind === 'ed25519-pem' && typeof key.publicKeyOrSecret === 'string' ? [{ keyId: key.keyId, publicKeyPem: key.publicKeyOrSecret }] : []) }
}

const readOptional = async (path: string): Promise<string | null> => {
  try { return await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
const writeAtomic = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode: 0o600, flag: 'w' })
  await rename(temporary, path)
}
export function createNodeSwApplicationCatalogFiles(directory = SW_CATALOG_DIRECTORY, name = 'applications'): SwApplicationCatalogFiles {
  const envelope = join(directory, name + '.signed.json'), floorPath = join(directory, name + '.sequence')
  return { readTrust: releaseKeyCatalogTrust, readEnvelope: () => readOptional(envelope), writeEnvelope: text => writeAtomic(envelope, text),
    readFloor: () => readOptional(floorPath), writeFloor: text => writeAtomic(floorPath, text) }
}

/** The running release version (current link name, confirmed by its VERSION marker); null outside an installed release. */
export async function readInstalledPanelVersion(currentLink = DEFAULT_LAYOUT.currentLink): Promise<string | null> {
  try {
    const target = await readlink(currentLink), version = basename(target)
    if (!isApplicationVersion(version) || dirname(target) !== DEFAULT_LAYOUT.releasesDir) return null
    return (await readFile(join(target, 'VERSION'), 'utf8')).trim() === version ? version : null
  } catch { return null }
}
