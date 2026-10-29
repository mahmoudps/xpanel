import { fail } from '@xpanel/core'
import { isApplicationVersion } from '../../../packages/os/src/application-artifact.ts'
import { verifyApplicationCatalog } from './application-catalog.ts'
import type { ApplicationCatalogKey, ApplicationCatalogPolicy, VerifiedApplicationCatalog } from './application-catalog.ts'

/**
 * Bootstrap and cache consumer for the signed application catalog. Trust anchors come only from a
 * root-owned bootstrap file; the cached envelope is verified on every read, and the highest accepted
 * sequence is persisted so an older (rolled-back) catalog is refused. Fetching a fresh envelope into
 * the cache is a separate network job and is not performed here.
 */
export interface SwApplicationCatalogFiles {
  readTrustKeys(): Promise<string | null>
  readEnvelope(): Promise<string | null>
  readFloor(): Promise<string | null>
  writeFloor(text: string): Promise<void>
}
export interface SwApplicationCatalogSource {
  catalog(): Promise<VerifiedApplicationCatalog>
  policy(): ApplicationCatalogPolicy
}
const unavailable = (): never => fail('PRECONDITION_FAILED', 'no signed application catalog is configured on this server', { stateChanged: false, reason: 'application_catalog_unavailable' })

export function parseSwCatalogTrustKeys(text: string): ApplicationCatalogKey[] {
  let value: unknown
  try { value = Buffer.byteLength(text) <= 128 * 1024 ? JSON.parse(text) : null } catch { value = null }
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return fail('PRECONDITION_FAILED', 'application catalog trust configuration is invalid', { stateChanged: false })
  const keys = value.map(item => {
    const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null
    if (!record || Object.keys(record).sort().join() !== 'keyId,publicKeyPem' || typeof record.keyId !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(record.keyId)
      || typeof record.publicKeyPem !== 'string' || record.publicKeyPem.length > 4096 || !record.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----\n')) return fail('PRECONDITION_FAILED', 'application catalog trust configuration is invalid', { stateChanged: false })
    return Object.freeze({ keyId: record.keyId, publicKeyPem: record.publicKeyPem })
  })
  if (new Set(keys.map(key => key.keyId)).size !== keys.length) return fail('PRECONDITION_FAILED', 'application catalog trust configuration is invalid', { stateChanged: false })
  return keys
}

export function createSwApplicationCatalogSource(files: SwApplicationCatalogFiles, panelVersion: string, now: () => Date = () => new Date()): SwApplicationCatalogSource {
  if (!isApplicationVersion(panelVersion)) throw new Error('invalid_panel_version')
  let floor = 0
  const readFloor = async (): Promise<number> => {
    const text = await files.readFloor()
    if (text === null) return 0
    if (!/^(0|[1-9][0-9]{0,14})\n?$/.test(text)) return fail('PRECONDITION_FAILED', 'the application catalog sequence record is invalid', { stateChanged: false })
    return Number(text.trim())
  }
  return {
    policy: () => ({ now: now(), minimumSequence: floor, panelVersion }),
    async catalog() {
      const [keysText, envelopeText] = await Promise.all([files.readTrustKeys(), files.readEnvelope()])
      if (keysText === null || envelopeText === null) return unavailable()
      const keys = parseSwCatalogTrustKeys(keysText)
      let envelope: unknown
      try { envelope = Buffer.byteLength(envelopeText) <= 1024 * 1024 ? JSON.parse(envelopeText) : null } catch { envelope = null }
      const stored = await readFloor()
      const verified = verifyApplicationCatalog(envelope, keys, { now: now(), minimumSequence: stored, panelVersion })
      if (verified.sequence > stored) await files.writeFloor(verified.sequence + '\n')
      floor = verified.sequence
      return verified
    },
  }
}
