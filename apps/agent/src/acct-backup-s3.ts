import { createHash, createHmac } from 'node:crypto'
import { lstat as fsLstat, readFile as fsReadFile } from 'node:fs/promises'
import { backupDestinationTargetDigest, isBackupCredentialRef, readBackupCredentialProfiles } from '../../../packages/core/src/backup-destination.ts'
import type { BackupCredentialProfile, BackupDestinationTarget } from '../../../packages/core/src/backup-destination.ts'
import type { BackupDestinationProbeProvider, BackupDestinationProbeSession } from './backup-destination.ts'
import { BACKUP_RUN_LIMITS, parseBackupArchiveName } from './acct-backup-plan.ts'
import type { BackupRemoteArchive } from './acct-backup-plan.ts'

/** Root-owned credential store; the request path never names it and its secrets never leave this module. */
export const BACKUP_CREDENTIALS_PATH = '/etc/xpanel/backup-credentials.json'
export const BACKUP_S3_KINDS = ['s3', 'backblaze'] as const
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024
const MAX_LIST_PAGE_BYTES = 2 * 1024 * 1024
const MAX_LIST_PAGES = 20
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const PROBE_KEY = /^\.xpanel-probe\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface BackupArchiveSource { bytes: number; sha256: string; chunks(): AsyncIterable<Uint8Array> }
/** A probe session that can also move whole account archives; every name is relative to the confined destination prefix. */
export interface BackupTransferSession extends BackupDestinationProbeSession {
  putArchive(name: string, source: BackupArchiveSource, signal: AbortSignal): Promise<void>
  readArchive(name: string, maxBytes: number, signal: AbortSignal): Promise<AsyncIterable<Uint8Array> | null>
  listArchives(signal: AbortSignal): Promise<BackupRemoteArchive[]>
  deleteArchive(name: string, signal: AbortSignal): Promise<void>
}
export interface BackupTransferProvider extends BackupDestinationProbeProvider {
  open(binding: { destinationId: string; targetDigest: string; credentialRef: string; credentialRevision: string }, signal: AbortSignal): Promise<BackupTransferSession>
}
interface StoredCredential { profile: BackupCredentialProfile; accessKeyId: string; secretAccessKey: string }
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const hex = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const hmac = (key: string | Buffer, value: string): Buffer => createHmac('sha256', key).update(value).digest()
// RFC 3986 unreserved characters stay literal; SigV4 requires uppercase percent-encoding of everything else.
const encode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())

/**
 * AWS Signature Version 4 for Amazon S3 (docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html).
 * `path` is already canonical (each segment encoded once); `query` pairs are encoded and sorted here.
 * Returns the request headers without `host`, which fetch derives from the same URL that was signed.
 */
export function signS3Request(input: { method: string; host: string; path: string; query?: readonly [string, string][]; region: string; accessKeyId: string; secretAccessKey: string; payloadSha256: string; headers?: Readonly<Record<string, string>>; now: Date }): { headers: Record<string, string>; query: string } {
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'), day = amzDate.slice(0, 8)
  const headers: Record<string, string> = { host: input.host, 'x-amz-content-sha256': input.payloadSha256, 'x-amz-date': amzDate }
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ')
  const names = Object.keys(headers).sort(), signedHeaders = names.join(';')
  const query = (input.query ?? []).map(([key, value]) => [encode(key), encode(value)] as const).sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(([key, value]) => key + '=' + value).join('&')
  const canonical = [input.method, input.path, query, names.map(name => name + ':' + headers[name] + '\n').join(''), signedHeaders, input.payloadSha256].join('\n')
  const scope = `${day}/${input.region}/s3/aws4_request`
  const key = hmac(hmac(hmac(hmac('AWS4' + input.secretAccessKey, day), input.region), 's3'), 'aws4_request')
  const signature = hmac(key, ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n')).toString('hex')
  const { host: _host, ...rest } = headers
  return { headers: { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` }, query }
}

/** Reads the root-only (mode 0600, uid 0, no link) credential file; revision changes whenever a key is rotated. */
export async function readBackupCredentialFile(path = BACKUP_CREDENTIALS_PATH, io: { lstat: typeof fsLstat; readFile: typeof fsReadFile } = { lstat: fsLstat, readFile: fsReadFile }): Promise<StoredCredential[]> {
  const bad = (): never => { throw new Error('invalid_backup_credentials') }
  let info: Awaited<ReturnType<typeof fsLstat>>
  try { info = await io.lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  if (!info.isFile() || info.isSymbolicLink() || (Number(info.mode) & 0o077) !== 0 || Number(info.uid) !== 0 || Number(info.size) > MAX_CREDENTIAL_FILE_BYTES) return bad()
  const raw: unknown = JSON.parse(String(await io.readFile(path, 'utf8')))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join() !== 'profiles,version' || (raw as { version: unknown }).version !== 1 || !Array.isArray((raw as { profiles: unknown }).profiles)) return bad()
  const stored = ((raw as { profiles: unknown[] }).profiles).map(item => {
    const value = item as Record<string, unknown>
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== 'accessKeyId,kinds,label,ref,secretAccessKey' || !isBackupCredentialRef(value.ref)
      || typeof value.accessKeyId !== 'string' || !/^[A-Za-z0-9]{16,128}$/.test(value.accessKeyId) || typeof value.secretAccessKey !== 'string' || !/^[A-Za-z0-9/+=]{16,128}$/.test(value.secretAccessKey)
      || !Array.isArray(value.kinds) || value.kinds.some(kind => !(BACKUP_S3_KINDS as readonly unknown[]).includes(kind))) return bad()
    const revision = hex(JSON.stringify([value.ref, value.kinds, value.accessKeyId, value.secretAccessKey]))
    return { profile: { ref: value.ref, label: value.label as string, kinds: value.kinds as BackupCredentialProfile['kinds'], revision }, accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey }
  })
  readBackupCredentialProfiles(stored.map(item => item.profile))
  return stored
}

/** Saved destination fields the provider will sign against: HTTPS service origin only, DNS-style bucket, region, segment-confined prefix. */
export function s3DestinationBinding(target: BackupDestinationTarget): { origin: string; host: string; bucket: string; region: string; prefix: string } {
  const bad = (): never => { throw new Error('unsupported_backup_destination') }
  if (!(BACKUP_S3_KINDS as readonly string[]).includes(target.kind) || !target.bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(target.bucket) || target.bucket.includes('..') || !target.region || !/^[a-z0-9-]{1,32}$/.test(target.region)) return bad()
  let url: URL
  try { url = new URL(target.endpoint) } catch { return bad() }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname) return bad()
  const segments = target.pathPrefix.split('/').filter(Boolean)
  if (!segments.length || segments.length > 16 || segments.some(part => part === '.' || part === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(part))) return bad()
  return { origin: url.origin, host: url.host, bucket: target.bucket, region: target.region, prefix: segments.join('/') }
}

const unescapeXml = (value: string): string => value.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name]!)
const readBounded = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []
  let size = 0
  if (!reader) return new Uint8Array()
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new Error('remote_response_limit') } chunks.push(part.value) } }
  finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}
async function* boundedStream(response: Response, maxBytes: number, expected: number | null): AsyncIterable<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('remote_body_missing')
  let size = 0
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new Error('remote_response_limit') } yield part.value } }
  finally { reader.releaseLock() }
  if (expected !== null && size !== expected) throw new Error('remote_length_mismatch')
}

/**
 * S3-compatible transport (Amazon S3, and Backblaze B2 through its S3-compatible API). Path-style requests to the saved origin only,
 * redirects refused, system-CA TLS. shortcut: path-style addressing; switch to virtual-hosted style if a provider retires path-style.
 */
export function createS3BackupProvider(deps: { readDestination(id: string): Promise<BackupDestinationTarget | null>; readCredentials?: () => Promise<StoredCredential[]>; fetch?: FetchLike; now?: () => Date }): BackupTransferProvider {
  const readCredentials = deps.readCredentials ?? (() => readBackupCredentialFile()), request = deps.fetch ?? ((url, init) => fetch(url, init)), now = deps.now ?? (() => new Date())
  return {
    async profiles() { return (await readCredentials()).map(item => item.profile) },
    async open(binding) {
      const target = await deps.readDestination(binding.destinationId)
      const credential = (await readCredentials()).find(item => item.profile.ref === binding.credentialRef)
      if (!target || backupDestinationTargetDigest(target) !== binding.targetDigest || target.credentialRef !== binding.credentialRef || !credential || credential.profile.revision !== binding.credentialRevision
        || !credential.profile.kinds.includes(target.kind as BackupCredentialProfile['kinds'][number])) throw new Error('backup_destination_binding_changed')
      const site = s3DestinationBinding(target), keys = { accessKeyId: credential.accessKeyId, secretAccessKey: credential.secretAccessKey }
      const call = async (method: string, key: string | null, signal: AbortSignal, options: { query?: [string, string][]; body?: BackupArchiveSource | Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> => {
        const path = '/' + encode(site.bucket) + (key === null ? '' : '/' + (site.prefix + '/' + key).split('/').map(encode).join('/'))
        const body = options.body, payloadSha256 = body === undefined ? EMPTY_SHA256 : body instanceof Uint8Array ? hex(body) : body.sha256
        const length = body === undefined ? null : body instanceof Uint8Array ? body.byteLength : body.bytes
        const signed = signS3Request({ method, host: site.host, path, ...(options.query ? { query: options.query } : {}), region: site.region, ...keys, payloadSha256, headers: { ...options.headers, ...(length === null ? {} : { 'content-length': String(length) }) }, now: now() })
        const init = { method, headers: signed.headers, redirect: 'error', signal, ...(body === undefined ? {} : body instanceof Uint8Array ? { body } : { body: (ReadableStream as unknown as { from(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> }).from(body.chunks()), duplex: 'half' }) } as RequestInit
        return request(site.origin + path + (signed.query ? '?' + signed.query : ''), init)
      }
      const ok = async (response: Response, allowed: readonly number[]): Promise<Response> => {
        if (!allowed.includes(response.status)) { await response.body?.cancel().catch(() => undefined); throw new Error('remote_status_' + response.status) }
        return response
      }
      const archive = (name: string): string => { if (!parseBackupArchiveName(name)) throw new Error('invalid_remote_archive_name'); return name }
      const probe = (key: string): string => { if (!PROBE_KEY.test(key)) throw new Error('invalid_probe_key'); return key }
      const session: BackupTransferSession = {
        binding: { ...binding, remote: true, confined: true, pinnedPeer: true, redirects: false },
        async writeProbe(key, bytes, signal) { await ok(await call('PUT', probe(key), signal, { body: bytes }), [200]) },
        async readProbe(key, maxBytes, signal) {
          const response = await ok(await call('GET', probe(key), signal), [200, 404])
          if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return null }
          return readBounded(response, maxBytes)
        },
        async deleteProbe(key, signal) { await ok(await call('DELETE', probe(key), signal), [204, 200]) },
        async closeAndDrain() { /* fetch keeps no session state; every response body is consumed or cancelled above. */ },
        async putArchive(name, source, signal) { await ok(await call('PUT', archive(name), signal, { body: source }), [200]) },
        async readArchive(name, maxBytes, signal) {
          const response = await ok(await call('GET', archive(name), signal), [200, 404])
          if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return null }
          const declared = response.headers.get('content-length')
          return boundedStream(response, maxBytes, declared !== null && /^\d+$/.test(declared) ? Number(declared) : null)
        },
        async deleteArchive(name, signal) { await ok(await call('DELETE', archive(name), signal), [204, 200]) },
        async listArchives(signal) {
          // ListObjectsV2 (docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html): Contents/Key, Size, LastModified; IsTruncated + NextContinuationToken.
          const found: BackupRemoteArchive[] = []
          let token: string | null = null
          for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const query: [string, string][] = [['list-type', '2'], ['prefix', site.prefix + '/'], ['max-keys', '1000'], ...(token ? [['continuation-token', token] as [string, string]] : [])]
            const xml = Buffer.from(await readBounded(await ok(await call('GET', null, signal, { query }), [200]), MAX_LIST_PAGE_BYTES)).toString('utf8')
            for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
              const key = unescapeXml(/<Key>([\s\S]*?)<\/Key>/.exec(item!)?.[1] ?? ''), size = /<Size>(\d{1,16})<\/Size>/.exec(item!)?.[1], modified = /<LastModified>([^<]{1,40})<\/LastModified>/.exec(item!)?.[1]
              const name = key.startsWith(site.prefix + '/') ? key.slice(site.prefix.length + 1) : ''
              if (!parseBackupArchiveName(name) || size === undefined || !modified || !Number.isFinite(Date.parse(modified))) continue
              found.push({ name, bytes: Number(size), lastModified: new Date(modified).toISOString() })
              if (found.length > BACKUP_RUN_LIMITS.listed) throw new Error('remote_listing_limit')
            }
            const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
            token = truncated ? unescapeXml(/<NextContinuationToken>([^<]{1,1024})<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') || null : null
            if (!truncated) return found
            if (!token) throw new Error('remote_listing_incomplete')
          }
          throw new Error('remote_listing_limit')
        },
      }
      return session
    },
  }
}
