import { lstat, mkdir, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import { isBackupCredentialRef } from '../../../packages/core/src/backup-destination.ts'
import type { BackupCredentialProfile } from '../../../packages/core/src/backup-destination.ts'
import { BACKUP_CREDENTIALS_PATH, BACKUP_SSH_KEY_DIR, readBackupCredentialFile } from './acct-backup-s3.ts'
import type { StoredCredential } from './acct-backup-s3.ts'
import { LOCAL_DISK_PROFILE } from './acct-backup-local.ts'
import { runBackupCommand } from './backup-low-priority.ts'
import type { BackupCommandRunner } from './backup-low-priority.ts'

/** A profile as the panel may see it: secrets never; an SFTP profile shows its public key so it can be installed on the remote host. */
export interface BackupCredentialView extends BackupCredentialProfile { publicKey: string | null }
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{68}(?:={0,2}) [A-Za-z0-9._@-]{1,96}$/
const LABEL = /^[^\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]{1,120}$/u

export interface BackupCredentialStore {
  path: string; keyDir: string; run: BackupCommandRunner
  read(): Promise<StoredCredential[]>
  readRaw(): Promise<unknown>
  write(value: unknown): Promise<void>
  readPublicKey(privateKeyPath: string): Promise<string | null>
}
export const hostBackupCredentialStore = (path = BACKUP_CREDENTIALS_PATH, keyDir = BACKUP_SSH_KEY_DIR): BackupCredentialStore => ({
  path, keyDir, run: runBackupCommand,
  read: () => readBackupCredentialFile(path),
  readRaw: () => readJsonIfExists<unknown>(path),
  write: value => atomicWriteJson(path, value, 0o600),
  readPublicKey: async privateKeyPath => {
    try {
      const info = await lstat(privateKeyPath + '.pub')
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return null
      const text = (await readFile(privateKeyPath + '.pub', 'utf8')).trim()
      return PUBLIC_KEY.test(text) ? text : null
    } catch { return null }
  },
})

export async function listBackupCredentials(store: BackupCredentialStore): Promise<BackupCredentialView[]> {
  const stored = await store.read()
  return [{ ...LOCAL_DISK_PROFILE, publicKey: null }, ...await Promise.all(stored.map(async item => ({ ...item.profile, publicKey: 'privateKeyPath' in item ? await store.readPublicKey(item.privateKeyPath) : null })))]
}

/**
 * Creates an ed25519 key pair for an SFTP destination on this server (ssh-keygen(1), no passphrase, root-only 0600) and records
 * a profile naming it. The private key never leaves the key directory; only the public key is returned.
 */
export async function createSftpBackupCredential(store: BackupCredentialStore, input: { ref: unknown; label: unknown }): Promise<BackupCredentialView> {
  if (!isBackupCredentialRef(input.ref) || input.ref === LOCAL_DISK_PROFILE.ref || !/^[A-Za-z0-9._-]{1,64}$/.test(input.ref)) return fail('VALIDATION', 'the profile name must be 1 to 64 lowercase letters, digits, dots, dashes or underscores', { stateChanged: false })
  if (typeof input.label !== 'string' || !LABEL.test(input.label.trim())) return fail('VALIDATION', 'the profile label must be 1 to 120 printable characters', { stateChanged: false })
  const ref = input.ref, label = input.label.trim(), keyPath = posix.join(store.keyDir, ref)
  const existing = await store.read()
  if (existing.some(item => item.profile.ref === ref)) return fail('CONFLICT', 'a backup credential profile with this name exists', { stateChanged: false })
  const raw = await store.readRaw() as { version?: unknown; profiles?: unknown } | null
  const profiles = raw === null ? [] : Array.isArray(raw?.profiles) ? raw.profiles : fail('PRECONDITION_FAILED', 'the backup credential file requires review', { stateChanged: false })
  await mkdir(store.keyDir, { recursive: true, mode: 0o700 })
  const created = await store.run({ argv: ['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'xpanel-backup-' + ref, '-f', keyPath], maxStdoutBytes: 64 * 1024, timeoutMs: 30_000 })
  if (!created.ok) return fail('CONFIG_TEST_FAILED', 'the key pair could not be created', { stateChanged: false })
  await store.write({ version: 1, profiles: [...profiles, { ref, label, kinds: ['sftp'], privateKeyPath: keyPath }] })
  const profile = (await store.read()).find(item => item.profile.ref === ref)
  const publicKey = await store.readPublicKey(keyPath)
  if (!profile || !publicKey) return fail('SERVICE_UNAVAILABLE', 'the new credential profile requires review', { stateChanged: true, verificationRequired: true })
  return { ...profile.profile, publicKey }
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
/** /host/backups/credentials: GET lists profiles without secrets, POST {ref, label} creates an SFTP key pair. Root only. */
export async function handleBackupCredentialsRoute(req: Request, url: URL, method: string, ctx: { authorize(action: string): Promise<{ actor: string }>; store: BackupCredentialStore | null }): Promise<Response | null> {
  if (url.pathname !== '/host/backups/credentials') return null
  await ctx.authorize('host.backups.credentials')
  if (url.search) return fail('VALIDATION', 'backup credentials accept no query selectors', { stateChanged: false })
  if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (!ctx.store) return fail('PRECONDITION_FAILED', 'backup credentials are unavailable on this host', { stateChanged: false })
  if (method === 'GET') return json({ profiles: await listBackupCredentials(ctx.store) })
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await req.text()
  let body: unknown
  try { body = Buffer.byteLength(text) <= 1024 ? JSON.parse(text) : null } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== 'label,ref') return fail('VALIDATION', 'a profile name and label are required', { stateChanged: false })
  await ctx.authorize('host.backups.credentials')
  return json({ profile: await createSftpBackupCredential(ctx.store, body as { ref: unknown; label: unknown }) }, 201)
}
