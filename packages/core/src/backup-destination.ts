import { createHash } from 'node:crypto'

/** Kinds a credential profile can serve; `local` is the built-in separate-disk profile. */
export const BACKUP_REMOTE_KINDS = ['sftp', 's3', 'backblaze', 'local'] as const
export interface BackupDestinationTarget {
  id: string; name: string; kind: 's3' | 'sftp' | 'rsync' | 'backblaze' | 'ftp' | 'local'; endpoint: string
  bucket: string | null; region: string | null; pathPrefix: string; username: string | null; retentionDays: number; createdAt: string
  credentialRef?: string | null
}
export interface BackupDestinationProof { targetDigest: string; credentialRef: string; credentialRevision: string; verifiedAt: string; probeDigest: string; proofDigest: string }
export interface BackupCredentialProfile { ref: string; label: string; kinds: (typeof BACKUP_REMOTE_KINDS[number])[]; revision: string }
const HEX = /^[0-9a-f]{64}$/
export const isBackupCredentialRef = (raw: unknown): raw is string => typeof raw === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(raw)
const bad = (): never => { throw new Error('invalid_backup_destination_metadata') }
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const exact = (raw: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key))
const hash = (raw: unknown): string => createHash('sha256').update(JSON.stringify(raw)).digest('hex')
export function backupDestinationTargetDigest(target: BackupDestinationTarget): string {
  return hash([target.id, target.name, target.kind, target.endpoint, target.bucket, target.region, target.pathPrefix, target.username, target.retentionDays, target.createdAt, target.credentialRef ?? null])
}
export function backupDestinationProofDigest(proof: Omit<BackupDestinationProof, 'proofDigest'>): string {
  return hash([proof.targetDigest, proof.credentialRef, proof.credentialRevision, proof.verifiedAt, proof.probeDigest])
}
export function readBackupDestinationProof(raw: unknown): BackupDestinationProof | null {
  if (raw === undefined || raw === null) return null
  if (!object(raw) || !exact(raw, ['targetDigest', 'credentialRef', 'credentialRevision', 'verifiedAt', 'probeDigest', 'proofDigest']) || !isBackupCredentialRef(raw.credentialRef)
    || ![raw.targetDigest, raw.credentialRevision, raw.probeDigest, raw.proofDigest].every(value => typeof value === 'string' && HEX.test(value))
    || typeof raw.verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.verifiedAt) || !Number.isFinite(Date.parse(raw.verifiedAt))) return bad()
  const proof = raw as unknown as BackupDestinationProof
  return backupDestinationProofDigest(proof) === proof.proofDigest ? { ...proof } : bad()
}
export function backupDestinationProofCurrent(target: BackupDestinationTarget, proof: BackupDestinationProof | null | undefined, credentialRevision?: string): boolean {
  return !!proof && proof.targetDigest === backupDestinationTargetDigest(target) && proof.credentialRef === target.credentialRef && (credentialRevision === undefined || credentialRevision === proof.credentialRevision)
}
export function readBackupCredentialProfiles(raw: unknown): BackupCredentialProfile[] {
  if (!Array.isArray(raw) || raw.length > 50) return bad()
  const profiles = raw.map(item => {
    if (!object(item) || !exact(item, ['ref', 'label', 'kinds', 'revision']) || !isBackupCredentialRef(item.ref) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 120 || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(item.label)
      || typeof item.revision !== 'string' || !HEX.test(item.revision) || !Array.isArray(item.kinds) || !item.kinds.length || item.kinds.length > BACKUP_REMOTE_KINDS.length || new Set(item.kinds).size !== item.kinds.length || item.kinds.some(kind => !BACKUP_REMOTE_KINDS.includes(kind as typeof BACKUP_REMOTE_KINDS[number]))) return bad()
    return { ref: item.ref, label: item.label, kinds: [...item.kinds] as BackupCredentialProfile['kinds'], revision: item.revision }
  })
  return new Set(profiles.map(profile => profile.ref)).size === profiles.length ? profiles : bad()
}

/** UTC five-field schedule (minute hour day-of-month month day-of-week) with crontab(5) semantics. */
export interface BackupCron { fields: readonly ReadonlySet<number>[]; dayStar: boolean; weekdayStar: boolean }
const CRON_LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const
export function parseBackupCron(raw: unknown): BackupCron {
  const invalid = (): never => { throw new Error('invalid_backup_cron') }
  if (typeof raw !== 'string' || raw.length > 100) return invalid()
  const parts = raw.trim().split(/\s+/)
  if (parts.length !== 5) return invalid()
  const fields = parts.map((field, index) => {
    const [min, max] = CRON_LIMITS[index]!, values = new Set<number>()
    for (const item of field.split(',')) {
      const [base, stepText, extra] = item.split('/')
      if (extra !== undefined || base === undefined || stepText !== undefined && !/^\d+$/.test(stepText)) return invalid()
      const step = stepText === undefined ? 1 : Number(stepText)
      if (step < 1 || step > max - min + 1) return invalid()
      let low: number = min, high: number = max
      if (base !== '*') {
        const range = base.split('-')
        if (range.length > 2 || range.some(value => !/^\d+$/.test(value))) return invalid()
        low = Number(range[0]); high = range.length === 2 ? Number(range[1]) : stepText === undefined ? low : max
        if (low < min || high > max || low > high) return invalid()
      }
      for (let value = low; value <= high; value += step) values.add(index === 4 && value === 7 ? 0 : value)
    }
    return values
  })
  // crontab(5): when both day fields are restricted (not starting with *), a day matching either one runs.
  return { fields, dayStar: parts[2]!.startsWith('*'), weekdayStar: parts[4]!.startsWith('*') }
}
const cronDay = (cron: BackupCron, date: Date): boolean => {
  const day = cron.fields[2]!.has(date.getUTCDate()), weekday = cron.fields[4]!.has(date.getUTCDay())
  return cron.dayStar || cron.weekdayStar ? day && weekday : day || weekday
}
export const backupCronMatches = (cron: BackupCron, date: Date): boolean => cron.fields[0]!.has(date.getUTCMinutes()) && cron.fields[1]!.has(date.getUTCHours()) && cron.fields[3]!.has(date.getUTCMonth() + 1) && cronDay(cron, date)
/** First matching minute strictly after `after`, within 366 days; null when the schedule never matches (for example 30 February). */
export function nextBackupCronRun(cron: BackupCron, after: Date): Date | null {
  const at = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000), end = after.getTime() + 366 * 86_400_000
  while (at.getTime() <= end) {
    if (!cron.fields[3]!.has(at.getUTCMonth() + 1)) { at.setUTCMonth(at.getUTCMonth() + 1, 1); at.setUTCHours(0, 0, 0, 0); continue }
    if (!cronDay(cron, at)) { at.setUTCDate(at.getUTCDate() + 1); at.setUTCHours(0, 0, 0, 0); continue }
    if (!cron.fields[1]!.has(at.getUTCHours())) { at.setUTCHours(at.getUTCHours() + 1, 0, 0, 0); continue }
    if (cron.fields[0]!.has(at.getUTCMinutes())) return new Date(at)
    at.setUTCMinutes(at.getUTCMinutes() + 1, 0, 0)
  }
  return null
}
/** Missed minutes coalesce into one run: due when a scheduled minute fell after the last scheduled start and not after now. */
export const backupScheduleDue = (cron: BackupCron, since: Date, now: Date): Date | null => {
  const next = nextBackupCronRun(cron, since)
  return next && next.getTime() <= now.getTime() ? next : null
}
