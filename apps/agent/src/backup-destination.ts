import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { fail } from '@xpanel/core'
import { BACKUP_REMOTE_KINDS, backupDestinationProofDigest, backupDestinationTargetDigest, isBackupCredentialRef, readBackupCredentialProfiles } from '../../../packages/core/src/backup-destination.ts'
import type { BackupCredentialProfile, BackupDestinationProof, BackupDestinationTarget } from '../../../packages/core/src/backup-destination.ts'

export const BACKUP_DESTINATION_PROBE_BYTES = 256
export const BACKUP_DESTINATION_PROBE_TIMEOUT_MS = 5000
/** A real remote provider must bind a pinned peer, confined prefix and current secret revision before returning this session.
 * Each operation must enforce AbortSignal, settle before returning and drain on close; in-memory/local mirrors are not providers. */
export interface BackupDestinationProbeSession {
  binding: { destinationId: string; targetDigest: string; credentialRef: string; credentialRevision: string; remote: true; confined: true; pinnedPeer: true; redirects: false }
  writeProbe(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>
  readProbe(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null>
  deleteProbe(key: string, signal: AbortSignal): Promise<void>
  closeAndDrain(signal: AbortSignal): Promise<void>
}
/** Only trusted preconfigured identities cross this port. The provider never receives a request URL or filesystem path. */
export interface BackupDestinationProbeProvider {
  profiles(signal: AbortSignal): Promise<readonly BackupCredentialProfile[]>
  open(binding: { destinationId: string; targetDigest: string; credentialRef: string; credentialRevision: string }, signal: AbortSignal): Promise<BackupDestinationProbeSession>
}
export interface BackupDestinationProbeResult { destinationId: string; targetDigest: string; outcome: 'verified' | 'failed' | 'unknown'; proof: BackupDestinationProof | null; cleanupVerified: boolean; verificationRequired: boolean }
const unavailable = (): never => fail('PRECONDITION_FAILED', 'a trusted remote backup destination provider is unavailable', { stateChanged: false, nativeApplied: false })
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const signal = (): AbortSignal => AbortSignal.timeout(BACKUP_DESTINATION_PROBE_TIMEOUT_MS)
const readProbeBody = async (req: Request): Promise<unknown> => {
  const reader = req.body?.getReader(), chunks: Uint8Array[] = []
  let size = 0
  if (!reader) throw new Error('missing_probe_body')
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 256) { await reader.cancel(); throw new Error('probe_body_limit') }; chunks.push(part.value) } }
  finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
const profileFor = async (provider: BackupDestinationProbeProvider, target: BackupDestinationTarget): Promise<BackupCredentialProfile> => {
  let profiles: BackupCredentialProfile[]
  try { profiles = readBackupCredentialProfiles(await provider.profiles(signal())) } catch { return unavailable() }
  const profile = profiles.find(item => item.ref === target.credentialRef && item.kinds.includes(target.kind as BackupCredentialProfile['kinds'][number]))
  return profile ?? unavailable()
}
export async function probeBackupDestination(target: BackupDestinationTarget, provider: BackupDestinationProbeProvider | undefined, assertCurrent: () => Promise<void>, now: () => Date = () => new Date()): Promise<BackupDestinationProbeResult> {
  if (!provider || !BACKUP_REMOTE_KINDS.includes(target.kind as typeof BACKUP_REMOTE_KINDS[number]) || !isBackupCredentialRef(target.credentialRef)) return unavailable()
  const targetDigest = backupDestinationTargetDigest(target), profile = await profileFor(provider, target)
  await assertCurrent()
  const expected = { destinationId: target.id, targetDigest, credentialRef: target.credentialRef, credentialRevision: profile.revision }
  let session: BackupDestinationProbeSession
  try { session = await provider.open(expected, signal()) } catch { return unavailable() }
  const b = session.binding
  if (!b || b.destinationId !== expected.destinationId || b.targetDigest !== expected.targetDigest || b.credentialRef !== expected.credentialRef || b.credentialRevision !== expected.credentialRevision || b.remote !== true || b.confined !== true || b.pinnedPeer !== true || b.redirects !== false) {
    await session.closeAndDrain(signal()).catch(() => undefined)
    return unavailable()
  }
  const payload = randomBytes(BACKUP_DESTINATION_PROBE_BYTES), key = '.xpanel-probe/' + randomUUID()
  let attempted = false, matched = false, cleanupVerified = false, failed = false, closed = false
  const current = async (): Promise<void> => {
    await assertCurrent()
    if ((await profileFor(provider, target)).revision !== profile.revision) return fail('CONFLICT', 'backup credential changed during verification', { stateChanged: false })
    await assertCurrent()
  }
  try {
    await current()
    attempted = true
    await session.writeProbe(key, payload, signal())
    await current()
    const bytes = await session.readProbe(key, payload.length + 1, signal())
    matched = bytes instanceof Uint8Array && bytes.byteLength === payload.byteLength && timingSafeEqual(payload, bytes) && digest(bytes) === digest(payload)
    if (!matched) failed = true
    await current()
  } catch { failed = true }
  finally {
    // Cleanup owns only this unpredictable probe key; it must still run if the initiating authority is revoked.
    if (attempted) {
      try { await session.deleteProbe(key, signal()); cleanupVerified = await session.readProbe(key, 1, signal()) === null } catch { cleanupVerified = false }
    }
    try { await session.closeAndDrain(signal()); closed = true } catch { closed = false }
  }
  if (!failed && matched && cleanupVerified && closed) {
    try {
      await current()
      const fields = { targetDigest, credentialRef: target.credentialRef, credentialRevision: profile.revision, verifiedAt: now().toISOString(), probeDigest: digest(payload) }
      return { destinationId: target.id, targetDigest, outcome: 'verified', proof: { ...fields, proofDigest: backupDestinationProofDigest(fields) }, cleanupVerified: true, verificationRequired: false }
    } catch { failed = true }
  }
  return { destinationId: target.id, targetDigest, outcome: cleanupVerified && closed ? 'failed' : 'unknown', proof: null, cleanupVerified, verificationRequired: !cleanupVerified || !closed }
}

export interface BackupDestinationRouteContext {
  authorize(): Promise<void>
  readDestination(id: string): Promise<BackupDestinationTarget | null>
  provider?: BackupDestinationProbeProvider
  now?: () => Date
}
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
export async function handleBackupDestinationRoute(req: Request, url: URL, method: string, ctx: BackupDestinationRouteContext): Promise<Response | null> {
  const capability = url.pathname === '/host/backups/destinations/capabilities', match = /^\/host\/backups\/destinations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/test$/.exec(url.pathname)
  if (!capability && !match) return null
  await ctx.authorize()
  if (url.search) return fail('VALIDATION', 'destination verification accepts no query selectors', { stateChanged: false })
  if (method !== (capability ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: capability ? 'GET' : 'POST' } })
  if (capability) {
    let profiles: BackupCredentialProfile[] = []
    try { if (ctx.provider) profiles = readBackupCredentialProfiles(await ctx.provider.profiles(signal())) } catch { profiles = [] }
    await ctx.authorize()
    return json({ available: !!ctx.provider && profiles.length > 0, profiles, nativeApplied: false })
  }
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  let body: unknown
  try { body = await readProbeBody(req) } catch { return fail('VALIDATION', 'invalid bounded destination verification request', { stateChanged: false }) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'expectedTargetDigest') || typeof (body as { expectedTargetDigest: unknown }).expectedTargetDigest !== 'string' || !/^[0-9a-f]{64}$/.test((body as { expectedTargetDigest: string }).expectedTargetDigest)) return fail('VALIDATION', 'only the expected target digest is accepted', { stateChanged: false })
  if (!ctx.provider) return unavailable()
  const target = await ctx.readDestination(match![1]!)
  if (!target) return fail('NOT_FOUND', 'backup destination no longer exists', { stateChanged: false })
  const targetDigest = backupDestinationTargetDigest(target)
  if (targetDigest !== (body as { expectedTargetDigest: string }).expectedTargetDigest) return fail('CONFLICT', 'backup destination changed; read it again', { stateChanged: false })
  const assertCurrent = async (): Promise<void> => {
    await ctx.authorize()
    const fresh = await ctx.readDestination(target.id)
    if (!fresh || backupDestinationTargetDigest(fresh) !== targetDigest) return fail('CONFLICT', 'backup destination changed during verification', { stateChanged: false })
    await ctx.authorize()
  }
  const result = await probeBackupDestination(target, ctx.provider, assertCurrent, ctx.now)
  await ctx.authorize()
  return json(result)
}
