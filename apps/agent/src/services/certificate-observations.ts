import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { fail, isUuid, resolveServingDomain } from '@xpanel/core'
import type { Account, Certificate, Domain } from '@xpanel/core'
import type { ConfigTestResult } from '../executor.ts'
import { withOwnedHostFileHandle, withPinnedHostTargetParent } from '../host-target-parent.ts'

export const CERTIFICATE_ORDER_DIRECTORY = '/var/lib/xpanel/acme-orders'
export const MANAGEMENT_TLS_STATUS_FILE = '/var/lib/xpanel-management-tls/status.json'
export const MAX_CERTIFICATE_ORDER_BYTES = 512 * 1024
export const MAX_CERTIFICATE_ORDER_READS = 50
export type CertificateProviderReader = (path: string, maxBytes: number) => Promise<string | null>
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const date = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return null
  const normalized = new Date(value).toISOString()
  return normalized === (value.includes('.') ? value : value.replace('Z', '.000Z')) ? normalized : null
}
const fingerprint = (value: unknown): string | null => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null
const badRecord = (): never => fail('PRECONDITION_FAILED', 'certificate provider record requires review', { stateChanged: false })

/** Only these fixed provider files are read; no private key, arbitrary path or write is exposed. */
export const readBoundedCertificateProviderFile: CertificateProviderReader = async (path, maxBytes) => {
  const order = path.startsWith(CERTIFICATE_ORDER_DIRECTORY + '/') ? path.slice(CERTIFICATE_ORDER_DIRECTORY.length + 1) : ''
  if (path !== MANAGEMENT_TLS_STATUS_FILE && (!/^[0-9a-f-]{36}\.json$/.test(order) || !isUuid(order.slice(0, -5)))) return fail('FORBIDDEN', 'certificate provider path is not authorized', { stateChanged: false })
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CERTIFICATE_ORDER_BYTES) return fail('PRECONDITION_FAILED', 'a protected certificate provider reader is unavailable', { stateChanged: false })
  try {
    return await withPinnedHostTargetParent(path, async anchored => withOwnedHostFileHandle(await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), async handle => {
      const before = await handle.stat()
      if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600 || before.size > maxBytes) return badRecord()
      const bytes = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      const after = await handle.stat(), published = await lstat(anchored)
      if (length > maxBytes || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || published.dev !== before.dev || published.ino !== before.ino) return badRecord()
      return bytes.subarray(0, length).toString('utf8')
    }))
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

type SavedCertificate = Pick<Certificate, 'id' | 'accountId' | 'names' | 'source' | 'challenge'>
type OwnedDomain = Pick<Domain, 'accountId' | 'name'>
export function projectOwnedAcmeOrder(value: unknown, certificate: SavedCertificate, accountId: string, domains: readonly OwnedDomain[]) {
  const record = object(value)
  if (!record || !isUuid(accountId) || !isUuid(certificate.id) || certificate.source !== 'acme' || certificate.accountId !== accountId
    || record.certId !== certificate.id || record.accountId !== accountId || !Array.isArray(record.identifiers)
    || record.identifiers.length < 1 || record.identifiers.length > 100 || !record.identifiers.every(name => typeof name === 'string')
    || !['planned', 'challenged', 'issued', 'installed', 'failed'].includes(String(record.phase))
    || !['http-01', 'dns-01'].includes(String(record.challenge)) || record.challenge !== certificate.challenge || !Number.isSafeInteger(record.attempts) || Number(record.attempts) < 0 || Number(record.attempts) > 1_000_000) return badRecord()
  const names = record.identifiers as string[]
  const exact = domains.map(domain => ({ ...domain, wildcard: false }))
  if (new Set(names).size !== names.length || names.some(name => (name.startsWith('*.') ? exact.find(domain => domain.name === name.slice(2)) : resolveServingDomain(name, exact))?.accountId !== accountId)
    || JSON.stringify([...names].sort()) !== JSON.stringify([...certificate.names].sort())) return badRecord()
  const updatedAt = date(record.updatedAt), nextRetryAt = record.nextRetryAt === null ? null : date(record.nextRetryAt)
  const notAfter = record.notAfter === null ? null : date(record.notAfter)
  const fingerprintSha256 = record.fingerprintSha256 === null ? null : fingerprint(record.fingerprintSha256)
  if (!updatedAt || (record.nextRetryAt !== null && !nextRetryAt) || (record.notAfter !== null && !notAfter)
    || (record.fingerprintSha256 !== null && !fingerprintSha256)) return badRecord()
  return { certificateId: certificate.id, names: [...names], phase: record.phase as 'planned' | 'challenged' | 'issued' | 'installed' | 'failed',
    challenge: record.challenge as 'http-01' | 'dns-01', attempts: Number(record.attempts), nextRetryAt, updatedAt, notAfter, fingerprintSha256,
    failureRecorded: typeof record.lastError === 'string' && record.lastError.length > 0,
    servedTlsVerified: false as const }
}

export async function readAccountAcmeOrders(input: { account: Pick<Account, 'id'>; certificates: readonly SavedCertificate[];
  domains: readonly OwnedDomain[]; readFile?: CertificateProviderReader; now?: Date; limit?: number }) {
  const observedAt = input.now ?? new Date()
  if (!isUuid(input.account.id) || !Number.isFinite(observedAt.getTime()) || input.certificates.some(certificate => certificate.accountId !== input.account.id || !isUuid(certificate.id))) return fail('FORBIDDEN', 'certificate observation scope is unavailable', { stateChanged: false })
  const certificates = input.certificates.filter(certificate => certificate.source === 'acme')
  const limit = input.limit ?? MAX_CERTIFICATE_ORDER_READS
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CERTIFICATE_ORDER_READS) return badRecord()
  if (new Set(certificates.map(certificate => certificate.id)).size !== certificates.length) return badRecord()
  const read = input.readFile ?? readBoundedCertificateProviderFile
  const rows: { certificateId: string; state: 'observed' | 'missing' | 'invalid' | 'unavailable'; order?: ReturnType<typeof projectOwnedAcmeOrder> }[] = []
  for (const certificate of certificates.slice(0, limit)) {
    let text: string | null
    try { text = await read(CERTIFICATE_ORDER_DIRECTORY + '/' + certificate.id + '.json', MAX_CERTIFICATE_ORDER_BYTES) }
    catch { rows.push({ certificateId: certificate.id, state: 'unavailable' }); continue }
    if (text === null) { rows.push({ certificateId: certificate.id, state: 'missing' }); continue }
    try {
      if (Buffer.byteLength(text, 'utf8') > MAX_CERTIFICATE_ORDER_BYTES) return badRecord()
      rows.push({ certificateId: certificate.id, state: 'observed', order: projectOwnedAcmeOrder(JSON.parse(text), certificate, input.account.id, input.domains) })
    } catch { rows.push({ certificateId: certificate.id, state: 'invalid' }) }
  }
  return { observedAt: observedAt.toISOString(), scope: 'authorized_saved_certificate_ids' as const, inventoryComplete: false as const,
    totalSavedAcmeCertificates: certificates.length, inspectedSavedCertificates: rows.length, truncated: certificates.length > rows.length,
    rows, scheduler: { state: 'unavailable' as const, nextRunAt: null, reason: 'site_scheduler_not_connected' as const } }
}

export function projectManagementTlsStatus(value: unknown) {
  const record = object(value)
  if (!record || record.schemaVersion !== 1 || !date(record.at) || !['prepare', 'verify', 'renew'].includes(String(record.phase))
    || !['tls-ready', 'ingress-observed-ready', 'failed'].includes(String(record.status))) return badRecord()
  const success = record.status !== 'failed'
  if (success && (!fingerprint(record.fingerprint) || !date(record.expiresAt))) return badRecord()
  return { recordedAt: date(record.at)!, phase: record.phase as 'prepare' | 'verify' | 'renew', status: record.status as 'tls-ready' | 'ingress-observed-ready' | 'failed',
    fingerprintSha256: fingerprint(record.fingerprint), expiresAt: date(record.expiresAt), historical: true as const,
    failureRecorded: !success, servedTlsVerified: false as const, renewalQualified: false as const }
}

export function projectManagementTlsTimer(text: string) {
  if (text.length > 16 * 1024) return badRecord()
  const fields = new Map<string, string>()
  for (const line of text.trim().split('\n')) {
    const split = line.indexOf('=')
    if (split < 1 || fields.has(line.slice(0, split))) return badRecord()
    fields.set(line.slice(0, split), line.slice(split + 1).trim())
  }
  if (fields.get('LoadState') !== 'loaded' || fields.get('FragmentPath') !== '/etc/systemd/system/xpanel-management-tls.timer'
    || fields.get('DropInPaths') !== '' || !['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(fields.get('ActiveState') ?? '')
    || !['enabled', 'enabled-runtime', 'disabled', 'static', 'masked', 'masked-runtime'].includes(fields.get('UnitFileState') ?? '')) return badRecord()
  return { active: fields.get('ActiveState') === 'active', enabled: ['enabled', 'enabled-runtime'].includes(fields.get('UnitFileState')!),
    renewalQualified: false as const }
}

export async function readManagementTlsObservation(input: { readFile?: CertificateProviderReader;
  runCommand?: (argv: string[]) => Promise<ConfigTestResult>; now?: Date } = {}) {
  const observedAt = input.now ?? new Date()
  if (!Number.isFinite(observedAt.getTime())) return badRecord()
  let state: 'observed' | 'missing' | 'invalid' | 'unavailable' = 'unavailable'
  let status: ReturnType<typeof projectManagementTlsStatus> | null = null
  try {
    const text = await (input.readFile ?? readBoundedCertificateProviderFile)(MANAGEMENT_TLS_STATUS_FILE, 64 * 1024)
    if (text === null) state = 'missing'
    else { try { if (Buffer.byteLength(text, 'utf8') > 64 * 1024) return badRecord(); status = projectManagementTlsStatus(JSON.parse(text)); state = 'observed' } catch { state = 'invalid' } }
  } catch { state = 'unavailable' }
  let timer: { state: 'observed'; observation: ReturnType<typeof projectManagementTlsTimer> } | { state: 'unavailable' | 'invalid' } = { state: 'unavailable' }
  if (input.runCommand) {
    try {
      const result = await input.runCommand(['/usr/bin/systemctl', 'show', 'xpanel-management-tls.timer', '--no-pager', '--property=LoadState', '--property=ActiveState', '--property=UnitFileState', '--property=FragmentPath', '--property=DropInPaths'])
      if (result.ok) { try { timer = { state: 'observed', observation: projectManagementTlsTimer(result.stdout) } } catch { timer = { state: 'invalid' } } }
    } catch { /* A command acknowledgement is never timer or certificate health. */ }
  }
  return { observedAt: observedAt.toISOString(), state, status, timer, servedTlsVerified: false as const, renewalQualified: false as const }
}
