import { fail, isXpanelError } from '@xpanel/core'
import { readBackupCredentialProfiles } from '../../../packages/core/src/backup-destination.ts'
import type { BackupCredentialProfile } from '../../../packages/core/src/backup-destination.ts'
import type { BackupDestinationsWorkspacePorts } from './backup-destinations-workspace.ts'

export interface BackupCredentialView extends BackupCredentialProfile { publicKey: string | null }
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{68}(?:={0,2}) [A-Za-z0-9._@-]{1,96}$/
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const exact = (raw: unknown, keys: readonly string[]): raw is Record<string, unknown> => object(raw) && Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key))
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unreadable = (): never => fail('SERVICE_UNAVAILABLE', 'the host credential reply could not be verified', { stateChanged: false })

/** Profiles without secrets: an SFTP profile may carry its ed25519 public key, nothing else. */
export function readBackupCredentialViews(raw: unknown): BackupCredentialView[] {
  if (!Array.isArray(raw) || raw.length > 51 || raw.some(item => !exact(item, ['ref', 'label', 'kinds', 'revision', 'publicKey']))) return unreadable()
  let profiles: BackupCredentialProfile[]
  try { profiles = readBackupCredentialProfiles(raw.map(item => { const { publicKey: _key, ...profile } = item as Record<string, unknown>; return profile })) } catch { return unreadable() }
  return profiles.map((profile, index) => {
    const key = (raw[index] as Record<string, unknown>).publicKey
    if (!(key === null || typeof key === 'string' && PUBLIC_KEY.test(key) && profile.kinds.includes('sftp'))) return unreadable()
    return { ...profile, publicKey: key as string | null }
  })
}

/** /api/backups/workspace/credentials: root reads profiles and creates an SFTP key pair on this server; the private key never leaves it. */
export function createBackupCredentialsWorkspaceRoutes(ports: Pick<BackupDestinationsWorkspacePorts, 'requireCaller' | 'assertRoot' | 'emitAudit' | 'destinationHost'>) {
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    if (url.pathname !== '/api/backups/workspace/credentials') return null
    const initial = await ports.requireCaller(req)
    await ports.assertRoot(initial, 'backups.credentials')
    if (url.search) return fail('VALIDATION', 'backup credentials accept no selectors', { stateChanged: false })
    if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
    const host = ports.destinationHost
    if (!host) return fail('PRECONDITION_FAILED', 'backup credentials are unavailable on this host', { stateChanged: false })
    if (method === 'GET') {
      let raw: unknown
      try { raw = await host(initial, '/host/backups/credentials') } catch (error) { if (isXpanelError(error) && error.code !== 'SERVICE_UNAVAILABLE') throw error; return unreadable() }
      return json({ profiles: readBackupCredentialViews(object(raw) ? raw.profiles : null) })
    }
    if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
    const text = await req.text()
    let body: unknown
    try { body = Buffer.byteLength(text) <= 1024 ? JSON.parse(text) : null } catch { body = null }
    if (!exact(body, ['ref', 'label']) || typeof body.ref !== 'string' || typeof body.label !== 'string') return fail('VALIDATION', 'a profile name and label are required', { stateChanged: false })
    const fresh = await ports.requireCaller(req)
    await ports.assertRoot(fresh, 'backups.credentials')
    if (fresh.principal.id !== initial.principal.id || fresh.sessionId !== initial.sessionId || fresh.apiTokenId !== initial.apiTokenId) return fail('FORBIDDEN', 'backup authority changed', { stateChanged: false })
    let raw: unknown
    try { raw = await host(fresh, '/host/backups/credentials', { ref: body.ref, label: body.label }) } catch (error) {
      if (isXpanelError(error) && error.code !== 'SERVICE_UNAVAILABLE') throw error
      return fail('SERVICE_UNAVAILABLE', 'the key pair outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    }
    const [profile] = object(raw) ? readBackupCredentialViews([raw.profile]) : unreadable()
    if (!profile || profile.ref !== body.ref || !profile.publicKey) return fail('SERVICE_UNAVAILABLE', 'the key pair outcome requires review', { stateChanged: true, verificationRequired: true })
    try { await ports.emitAudit({ actor: fresh.principal.username, principalId: fresh.principal.id, action: 'backup.credential.created', target: 'backup-credential:' + profile.ref, outcome: 'ok' }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the key pair was created but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
    return json({ profile }, 201)
  }
}
