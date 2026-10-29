import { fail } from '@xpanel/core'
import { backupDestinationProofCurrent, backupDestinationTargetDigest, isBackupCredentialRef, readBackupCredentialProfiles, readBackupDestinationProof } from '../../../packages/core/src/backup-destination.ts'
import type { BackupCredentialProfile, BackupDestinationProof } from '../../../packages/core/src/backup-destination.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { BackupDestination, BackupScheduleConfig } from './extended-routes.ts'
import type { WhmBackupWorkspacePorts } from './backup-workspace.ts'
import { createBackupRunsWorkspaceRoutes } from './acct-backup-runs-workspace.ts'

export type BackupLifecycleDestination = BackupDestination & { credentialRef?: string | null; verification?: BackupDestinationProof | null }
export type BackupDestinationHost = (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
export interface BackupDestinationsWorkspacePorts extends WhmBackupWorkspacePorts {
  load(): Promise<{ destinations: BackupLifecycleDestination[]; schedule: BackupScheduleConfig | null; revision: string }>
  destinationHost?: BackupDestinationHost
}
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const exact = (raw: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key))
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unavailable = (): never => fail('PRECONDITION_FAILED', 'trusted remote backup verification is unavailable; destination remains inactive', { stateChanged: false, nativeApplied: false })
const readLifecycleBody = async (req: Request): Promise<unknown> => {
  const reader = req.body?.getReader(), chunks: Uint8Array[] = []
  let size = 0
  if (!reader) throw new Error('missing_lifecycle_body')
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 256) { await reader.cancel(); throw new Error('lifecycle_body_limit') }; chunks.push(part.value) } }
  finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export function normalizeBackupDestinationMetadata(value: Record<string, unknown>, target: BackupLifecycleDestination, saved?: BackupLifecycleDestination): BackupLifecycleDestination {
  const credentialRef = value.credentialRef === undefined || value.credentialRef === null || value.credentialRef === '' ? null : value.credentialRef
  if (credentialRef !== null && !isBackupCredentialRef(credentialRef)) return fail('VALIDATION', 'a destination credential must be a trusted reference, never a credential value or path', { stateChanged: false })
  const next = { ...target, credentialRef }
  let verification: BackupDestinationProof | null
  try { verification = readBackupDestinationProof(saved?.verification ?? null) } catch { return fail('PRECONDITION_FAILED', 'saved backup verification requires review', { stateChanged: false }) }
  return { ...next, verification: backupDestinationProofCurrent(next, verification) ? verification : null }
}
const capabilities = async (ports: Pick<BackupDestinationsWorkspacePorts, 'destinationHost'>, caller: AuthenticatedCaller): Promise<{ available: boolean; profiles: BackupCredentialProfile[] }> => {
  if (!ports.destinationHost) return { available: false, profiles: [] }
  try {
    const raw = await ports.destinationHost(caller, '/host/backups/destinations/capabilities')
    if (!object(raw) || !exact(raw, ['available', 'profiles', 'nativeApplied']) || typeof raw.available !== 'boolean' || raw.nativeApplied !== false) throw new Error()
    const profiles = readBackupCredentialProfiles(raw.profiles)
    return { available: raw.available && profiles.length > 0, profiles }
  } catch { return { available: false, profiles: [] } }
}
const profileFor = (destination: BackupLifecycleDestination, current: { available: boolean; profiles: BackupCredentialProfile[] }): BackupCredentialProfile | undefined => current.available ? current.profiles.find(profile => profile.ref === destination.credentialRef && profile.kinds.includes(destination.kind as BackupCredentialProfile['kinds'][number])) : undefined
export async function assertBackupDestinationsReady(destinations: readonly BackupLifecycleDestination[], ports: Pick<BackupDestinationsWorkspacePorts, 'destinationHost'>, caller: AuthenticatedCaller): Promise<void> {
  const current = await capabilities(ports, caller)
  if (destinations.some(destination => { const profile = profileFor(destination, current); return !destination.enabled || !profile || !backupDestinationProofCurrent(destination, destination.verification, profile.revision) })) return unavailable()
}

/** Lifecycle metadata is published only through the canonical destinations file and its existing writer lease. */
export function createBackupDestinationsWorkspaceRoutes(ports: BackupDestinationsWorkspacePorts) {
  const runs = createBackupRunsWorkspaceRoutes(ports)
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const runsResponse = await runs(req, url, method)
    if (runsResponse) return runsResponse
    const listing = url.pathname === '/api/backups/workspace/destination-lifecycle'
    const match = /^\/api\/backups\/workspace\/destinations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(test|activate|revoke)$/.exec(url.pathname)
    if (!listing && !match) return null
    const initial = await ports.requireCaller(req)
    await ports.assertRoot(initial, 'backups.destinations')
    if (method !== (listing ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: listing ? 'GET' : 'POST' } })
    if (url.search) return fail('VALIDATION', 'destination lifecycle accepts no selectors', { stateChanged: false })
    let expected: string | undefined
    if (!listing) {
      if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
      let body: unknown
      try { body = await readLifecycleBody(req) } catch { return fail('VALIDATION', 'invalid bounded destination lifecycle request', { stateChanged: false }) }
      if (!object(body) || !exact(body, ['expectedRevision']) || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return fail('VALIDATION', 'only the current expectedRevision is accepted', { stateChanged: false })
      expected = body.expectedRevision
    }
    const lease = await ports.store.getWriterLock().acquire()
    let wrote = false, audit: { action: string; target: string; outcome: 'ok' | 'failed' } | null = null, result: unknown, caller = initial
    const authorize = async (): Promise<void> => {
      const fresh = await ports.requireCaller(req)
      await ports.assertRoot(fresh, 'backups.destinations')
      if (fresh.principal.id !== initial.principal.id || fresh.sessionId !== initial.sessionId || fresh.apiTokenId !== initial.apiTokenId) return fail('FORBIDDEN', 'backup destination authority changed', { stateChanged: false })
      caller = fresh
      await lease.assertFencingToken()
    }
    try {
      await authorize()
      let current = await ports.load()
      if (expected !== undefined && current.revision !== expected) return fail('CONFLICT', 'backup configuration changed; reload and review', { stateChanged: false })
      if (listing) {
        const transport = await capabilities(ports, caller)
        await authorize()
        return json({ revision: current.revision, destinations: current.destinations.map(destination => {
          const profile = profileFor(destination, transport), verified = !!profile && backupDestinationProofCurrent(destination, destination.verification, profile.revision)
          return { ...destination, credentialRef: destination.credentialRef ?? null, verification: verified ? destination.verification : null, state: !profile ? 'unavailable' : verified ? destination.enabled ? 'active' : 'verified' : 'unverified', effectiveActive: destination.enabled && verified }
        }), capabilities: { canTest: transport.available, profiles: transport.profiles }, application: { nativeApplied: false, schedulerVerified: false } })
      }
      const target = current.destinations.find(destination => destination.id === match![1])
      if (!target) return fail('NOT_FOUND', 'backup destination no longer exists', { stateChanged: false })
      const action = match![2]!
      const publish = async (destination: BackupLifecycleDestination): Promise<void> => {
        await authorize()
        const fresh = await ports.load()
        if (fresh.revision !== current.revision) return fail('CONFLICT', 'backup destination changed during verification', { stateChanged: wrote, verificationRequired: wrote })
        const next = current.destinations.map(row => row.id === target.id ? destination : row)
        wrote = true
        await ports.publish('backups/destinations.json', next, lease)
        current = await ports.load()
        const saved = current.destinations.find(row => row.id === target.id)
        if (JSON.stringify(saved) !== JSON.stringify(destination)) return fail('SERVICE_UNAVAILABLE', 'destination write requires readback review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
      }
      if (action === 'revoke') {
        if (current.schedule?.enabled && current.schedule.destinationIds.includes(target.id)) return fail('CONFLICT', 'disable the backup schedule before revoking this destination', { stateChanged: false })
        await publish({ ...target, enabled: false, verification: null })
        result = { outcome: 'revoked', destinationId: target.id, revision: current.revision, effectiveActive: false }
      } else if (action === 'activate') {
        await assertBackupDestinationsReady([{ ...target, enabled: true }], ports, caller)
        await authorize()
        await publish({ ...target, enabled: true })
        result = { outcome: 'activated', destinationId: target.id, revision: current.revision, effectiveActive: true, nativeApplied: false }
      } else {
        if (current.schedule?.enabled && current.schedule.destinationIds.includes(target.id)) return fail('CONFLICT', 'disable the backup schedule before testing this destination', { stateChanged: false })
        const transport = await capabilities(ports, caller), profile = profileFor(target, transport)
        if (!profile || !ports.destinationHost) return unavailable()
        await authorize()
        await publish({ ...target, enabled: false, verification: null })
        const targetDigest = backupDestinationTargetDigest(target)
        await authorize()
        let raw: unknown
        try { raw = await ports.destinationHost(caller, '/host/backups/destinations/' + target.id + '/test', { expectedTargetDigest: targetDigest }) } catch { raw = null }
        await authorize()
        let proof: BackupDestinationProof | null = null
        try {
          if (!object(raw) || !exact(raw, ['destinationId', 'targetDigest', 'outcome', 'proof', 'cleanupVerified', 'verificationRequired']) || raw.destinationId !== target.id || raw.targetDigest !== targetDigest || raw.outcome !== 'verified' || raw.cleanupVerified !== true || raw.verificationRequired !== false) throw new Error()
          proof = readBackupDestinationProof(raw.proof)
          const freshProfiles = await capabilities(ports, caller), freshProfile = profileFor(target, freshProfiles)
          if (!proof || !freshProfile || !backupDestinationProofCurrent(target, proof, freshProfile.revision) || freshProfile.revision !== profile.revision) throw new Error()
        } catch { proof = null }
        if (proof) await publish({ ...target, enabled: false, verification: proof })
        result = { outcome: proof ? 'verified' : 'unknown', destinationId: target.id, revision: current.revision, effectiveActive: false, verificationRequired: !proof, nativeApplied: false }
      }
      audit = { action: 'backup.destination.' + action, target: 'backup-destination:' + target.name, outcome: object(result) && result.verificationRequired === true ? 'failed' : 'ok' }
      await authorize()
    } catch (error) {
      if (wrote) return fail('SERVICE_UNAVAILABLE', 'destination lifecycle requires readback review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
      throw error
    } finally { await lease.release() }
    if (audit) try { await ports.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, ...audit }) } catch { return fail('SERVICE_UNAVAILABLE', 'destination lifecycle audit requires review', { stateChanged: wrote, verificationRequired: wrote, unknownOutcome: wrote }) }
    return json(result)
  }
}
