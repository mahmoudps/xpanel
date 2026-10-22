import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { auditEntry, fail, isXpanelError } from '@xpanel/core'
import type { AuditEntry, HostAction, Principal, RenderedFile } from '@xpanel/core'
import {
   ALL_PARTS,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  assertExecSteps,
  computeManifest,
  createBackupPlan,
  inspectBackupArchive,
  mergeMailConfig,
  parseMailConfig,
  parseManifest,
  stepPaths,
} from '@xpanel/lifecycle'
import type {
  AuditPort,
  BackupManifest,
  BackupPlan,
  BackupRequest,
  ByteSource,
  ClockPort,
  DesiredStateStep,
  ExecIoStep,
  ExecResult,
  FsPort,
  HostPort,
  LifecycleStep,
  MailConfig,
  ManifestFile,
  ManifestStep,
  ReconcileStep,
  RemoteUploadStep,
  VerifyArchiveStep,
  WriteFileStep,
} from '@xpanel/lifecycle'

export const ENCRYPTED_BACKUP_MAGIC = 'XPBKENC1'
export const ENCRYPTED_BACKUP_VERSION = 1
export const DEFAULT_ENCRYPTION_CHUNK_BYTES = 64 * 1024
export const DEFAULT_MAX_MANIFEST_FILES = 500_000
export const DISASTER_BACKUP_FORMAT = 'xpanel-disaster-backup'
export const DISASTER_BACKUP_VERSION = 1

export type BackupKind = 'account' | 'control-plane-disaster'

export interface EncryptionKeyMaterial {
  keyId: string
  /** 32-byte raw key for AES-256-GCM */
  key: Buffer
}

export interface EncryptionKeyring {
  activeKeyId: string
  getKey(keyId: string): EncryptionKeyMaterial | null
}

export interface EncryptedStreamSummary {
  keyId: string
  version: number
  plaintextBytes: number
  plaintextSha256: string
  ciphertextBytes: number
  ciphertextSha256: string
  chunks: number
}

export interface DecryptedStreamSummary {
  keyId: string
  version: number
  plaintextBytes: number
  plaintextSha256: string
  chunks: number
}

const KEY_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

export const validateKeyMaterial = (mat: EncryptionKeyMaterial): EncryptionKeyMaterial => {
  if (!mat || typeof mat.keyId !== 'string' || !KEY_ID_RE.test(mat.keyId)) {
    fail('VALIDATION', 'encryption keyId must be 1..128 safe ASCII characters')
  }
  if (!Buffer.isBuffer(mat.key) || mat.key.byteLength !== 32) {
    fail('VALIDATION', 'AES-256-GCM encryption requires a 32-byte key')
  }
  return mat
}

const buildChunkNonce = (baseIv: Buffer, chunkIndex: number): Buffer => {
  const nonce = Buffer.from(baseIv)
  const low = nonce.readUInt32BE(8)
  nonce.writeUInt32BE((low ^ (chunkIndex >>> 0)) >>> 0, 8)
  return nonce
}

const buildChunkAad = (keyId: string, chunkIndex: number, isFinal: boolean): Buffer =>
  Buffer.from(`${ENCRYPTED_BACKUP_MAGIC}:v${ENCRYPTED_BACKUP_VERSION}:${keyId}:${chunkIndex}:${isFinal ? 1 : 0}`, 'utf8')

/**
 * Streams `source` through authenticated `AES-256-GCM` chunk encryption with a versioned
 * header (`XPBKENC1`), key ID, per-chunk nonce + AAD, and a terminal authenticated EOF frame
 * so truncation, reordering, tampering, or wrong keys fail closed.
 */
export const encryptBackupStream = (
  source: ByteSource,
  keyMaterial: EncryptionKeyMaterial,
  chunkSize = DEFAULT_ENCRYPTION_CHUNK_BYTES,
): { stream: ByteSource; done: Promise<EncryptedStreamSummary> } => {
  const mat = validateKeyMaterial(keyMaterial)
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024 || chunkSize > 16 * 1024 * 1024) {
    fail('VALIDATION', 'invalid encryption chunk size')
  }
  const baseIv = randomBytes(12)
  const keyIdBuf = Buffer.from(mat.keyId, 'utf8')
  const header = Buffer.alloc(8 + 1 + 2 + keyIdBuf.length + 4 + 12)
  header.write(ENCRYPTED_BACKUP_MAGIC, 0, 8, 'ascii')
  header.writeUInt8(ENCRYPTED_BACKUP_VERSION, 8)
  header.writeUInt16BE(keyIdBuf.length, 9)
  keyIdBuf.copy(header, 11)
  header.writeUInt32BE(chunkSize, 11 + keyIdBuf.length)
  baseIv.copy(header, 15 + keyIdBuf.length)

  const plainHash = createHash('sha256')
  const cipherHash = createHash('sha256')
  let plaintextBytes = 0
  let ciphertextBytes = 0
  let chunkIndex = 0

  let resolveDone!: (s: EncryptedStreamSummary) => void
  let rejectDone!: (e: unknown) => void
  const done = new Promise<EncryptedStreamSummary>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  // Prevent unhandled rejection if caller only awaits stream consumption
  done.catch(() => undefined)

  const encryptFrame = (plain: Buffer, isFinal: boolean): Buffer => {
    const nonce = buildChunkNonce(baseIv, chunkIndex)
    const aad = buildChunkAad(mat.keyId, chunkIndex, isFinal)
    const cipher = createCipheriv('aes-256-gcm', mat.key, nonce)
    cipher.setAAD(aad)
    const enc = Buffer.concat([cipher.update(plain), cipher.final()])
    const tag = cipher.getAuthTag()
    const frame = Buffer.allocUnsafe(4 + 16 + enc.length)
    frame.writeUInt32BE(plain.length, 0)
    tag.copy(frame, 4)
    enc.copy(frame, 20)
    chunkIndex++
    return frame
  }

  const stream: ByteSource = {
    async *[Symbol.asyncIterator]() {
      try {
        cipherHash.update(header)
        ciphertextBytes += header.length
        yield header

        let carry: Buffer = Buffer.alloc(0)
        for await (const raw of source) {
          const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
          plainHash.update(buf)
          plaintextBytes += buf.length
          carry = carry.length === 0 ? buf : Buffer.concat([carry, buf])
          while (carry.length >= chunkSize) {
            const slice = carry.subarray(0, chunkSize)
            carry = carry.subarray(chunkSize)
            if ( slice.length === 0) break
            const frame = encryptFrame(slice, false)
            cipherHash.update(frame)
            ciphertextBytes += frame.length
            yield frame
          }
        }
        if (carry.length > 0) {
          const frame = encryptFrame(carry, false)
          cipherHash.update(frame)
          ciphertextBytes += frame.length
          yield frame
        }
        const eofFrame = encryptFrame(Buffer.alloc(0), true)
        cipherHash.update(eofFrame)
        ciphertextBytes += eofFrame.length
        yield eofFrame

        resolveDone({
          keyId: mat.keyId,
          version: ENCRYPTED_BACKUP_VERSION,
          plaintextBytes,
          plaintextSha256: plainHash.digest('hex'),
          ciphertextBytes,
          ciphertextSha256: cipherHash.digest('hex'),
          chunks: chunkIndex,
        })
      } catch (e) {
        rejectDone(e)
        throw e
      }
    },
  }

  return { stream, done }
}

/**
 * Streams an encrypted backup through `AES-256-GCM` authenticated decryption, verifying
 * header version, keyId lookup, per-chunk auth tags, and the final EOF auth frame.
 */
export const decryptBackupStream = (
  source: ByteSource,
  resolveKey: (keyId: string) => EncryptionKeyMaterial | null,
): { stream: ByteSource; done: Promise<DecryptedStreamSummary> } => {
  const plainHash = createHash('sha256')
  let plaintextBytes = 0
  let chunkIndex = 0
  let resolvedKeyId = ''

  let resolveDone!: (s: DecryptedStreamSummary) => void
  let rejectDone!: (e: unknown) => void
  const done = new Promise<DecryptedStreamSummary>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  done.catch(() => undefined)

  const stream: ByteSource = {
    async *[Symbol.asyncIterator]() {
      try {
        let buf: Buffer = Buffer.alloc(0)
        const it = source[Symbol.asyncIterator]()

        const ensureBytes = async (n: number): Promise<boolean> => {
          while (buf.length < n) {
            const next = await it.next()
            if (next.done) return false
            const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
            buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
          }
          return true
        }

        const consume = (n: number): Buffer => {
          const out = buf.subarray(0, n)
          buf = buf.subarray(n)
          return out
        }

        if (!(await ensureBytes(11))) fail('VALIDATION', 'encrypted archive is truncated before header')
        const magic = consume(8).toString('ascii')
        if (magic !== ENCRYPTED_BACKUP_MAGIC) fail('VALIDATION', 'not a valid xPanel encrypted backup header')
        const version = consume(1).readUInt8(0)
        if (version !== ENCRYPTED_BACKUP_VERSION) fail('VALIDATION', `unsupported encrypted backup version ${version}`)
        const keyIdLen = consume(2).readUInt16BE(0)
        if (keyIdLen < 1 || keyIdLen > 128) fail('VALIDATION', 'invalid keyId length in encrypted header')
        if (!(await ensureBytes(keyIdLen + 4 + 12))) fail('VALIDATION', 'encrypted archive header is truncated')
        const keyId = consume(keyIdLen).toString('utf8')
        if (!KEY_ID_RE.test(keyId)) fail('VALIDATION', 'malformed keyId in encrypted header')
        resolvedKeyId = keyId
        const maxChunkSize = consume(4).readUInt32BE(0)
        if (maxChunkSize < 1024 || maxChunkSize > 16 * 1024 * 1024) {
          fail('VALIDATION', 'invalid chunk size in encrypted header')
        }
        const baseIv = Buffer.from(consume(12))
        const keyMat = resolveKey(keyId)
        if (!keyMat) return fail('FORBIDDEN', `encryption key ${keyId} is not available or unauthorized`)
        validateKeyMaterial(keyMat)
        if (keyMat.keyId !== keyId) return fail('FORBIDDEN', `keyring returned mismatched keyId ${keyMat.keyId} for ${keyId}`)

        let sawFinal = false
        while (true) {
          if (!(await ensureBytes(20))) {
            return fail('VALIDATION', 'encrypted archive is truncated (missing terminal authentication frame)')
          }
          const frameHeader = consume(20)
          const plainLen = frameHeader.readUInt32BE(0)
          const tag = frameHeader.subarray(4, 20)
          if (plainLen > maxChunkSize) {
            return fail('VALIDATION', `encrypted chunk length ${plainLen} exceeds declared max ${maxChunkSize}`)
          }
          if (!(await ensureBytes(plainLen))) {
            return fail('VALIDATION', 'encrypted archive chunk is truncated')
          }
          const ciphertext = consume(plainLen)
          const isFinal = plainLen === 0
          const nonce = buildChunkNonce(baseIv, chunkIndex)
          const aad = buildChunkAad(keyId, chunkIndex, isFinal)
          let plain: Buffer
          try {
            const decipher = createDecipheriv('aes-256-gcm', keyMat.key, nonce)
            decipher.setAAD(aad)
            decipher.setAuthTag(tag)
            plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
          } catch {
            return fail('FORBIDDEN', `encrypted backup authentication failed at chunk ${chunkIndex} (wrong key or tampered ciphertext)`)
          }
          chunkIndex++
          if (isFinal) {
            sawFinal = true
            break
          }
          plainHash.update(plain)
          plaintextBytes += plain.length
          yield plain
        }

        if (!sawFinal) fail('VALIDATION', 'encrypted archive missing final authentication frame')
        if (await ensureBytes(1)) fail('VALIDATION', 'trailing bytes after final encrypted archive frame')

        resolveDone({
          keyId: resolvedKeyId,
          version: ENCRYPTED_BACKUP_VERSION,
          plaintextBytes,
          plaintextSha256: plainHash.digest('hex'),
          chunks: chunkIndex,
        })
      } catch (e) {
        rejectDone(e)
        throw e
      }
    },
  }

  return { stream, done }
}

// ---------------------------------------------------------------------------
// Remote Destination Adapters (Local Stream, SFTP with pinned host key, S3 HTTPS with SSRF guard)
// ---------------------------------------------------------------------------

export interface RemoteUploadReceipt {
  targetId: string
  objectKey: string
  bytes: number
  sha256: string
  encryptedKeyId: string | null
  verifiedReadback: boolean
  uploadedAt: string
}

export interface RemoteDestinationAdapter {
  readonly targetId: string
  readonly kind: 'local' | 'sftp' | 's3-https'
  upload(objectKey: string, source: ByteSource, expectedMeta?: { encryptedKeyId?: string | null }): Promise<RemoteUploadReceipt>
  download(objectKey: string): ByteSource
  deleteObject(objectKey: string): Promise<void>
  listObjects(prefix?: string): Promise<string[]>
}

const OBJECT_KEY_RE = /^[A-Za-z0-9_./-]{1,512}$/

export const assertSafeObjectKey = (objectKey: string): string => {
  if (
    typeof objectKey !== 'string' ||
    !OBJECT_KEY_RE.test(objectKey) ||
    objectKey.startsWith('/') ||
    objectKey.endsWith('/') ||
    objectKey.includes('..') ||
    objectKey.includes('//')
  ) {
    fail('VALIDATION', `unsafe remote object key: ${String(objectKey).slice(0, 120)}`)
  }
  return objectKey
}

/**
 * Checks whether an IPv4/IPv6 literal or hostname resolves to a private, loopback, or
 * cloud metadata address (169.254.169.254, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12,
 * 192.168.0.0/16, ::1, fc00::/7, fe80::/10) for SSRF prevention.
 */
export const isPrivateOrMetadataAddress = (host: string): boolean => {
  const clean = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (clean === 'localhost' || clean.endsWith('.localhost') || clean.endsWith('.internal') || clean === '::1' || clean === '0:0:0:0:0:0:0:1') {
    return true
  }
  if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(clean) || /^fe[89ab][0-9a-f]:/i.test(clean) || clean.startsWith('::ffff:127.') || clean.startsWith('::ffff:10.') || clean.startsWith('::ffff:169.254.') || clean.startsWith('::ffff:192.168.')) {
    return true
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

export const assertSafeS3Endpoint = (endpointUrl: string, allowPrivate = false): URL => {
  let u: URL
  try {
    u = new URL(endpointUrl)
  } catch {
    return fail('VALIDATION', 'invalid S3 endpoint URL')
  }
  if (u.protocol !== 'https:') fail('VALIDATION', 'S3 endpoint must use https:')
  if (u.username || u.password || u.search || u.hash) {
    fail('VALIDATION', 'S3 endpoint must not embed credentials, query parameters, or fragments')
  }
  if (!allowPrivate && isPrivateOrMetadataAddress(u.hostname)) {
    fail('FORBIDDEN', `S3 endpoint host ${u.hostname} is forbidden by SSRF protection`)
  }
  return u
}

export class LocalStreamDestinationAdapter implements RemoteDestinationAdapter {
  readonly targetId: string
  readonly kind = 'local' as const
  private readonly objects = new Map<string, { data: Buffer; sha256: string; encryptedKeyId: string | null; uploadedAt: string }>()
  private readonly clock: ClockPort
  /** Fault injection hook for tests (e.g. disk full or interrupted stream). */
  failUploadAfterBytes: number | null = null

  constructor(targetId: string, clock: ClockPort) {
    this.targetId = targetId
    this.clock = clock
  }

  async upload(objectKey: string, source: ByteSource, expectedMeta?: { encryptedKeyId?: string | null }): Promise<RemoteUploadReceipt> {
    const key = assertSafeObjectKey(objectKey)
    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const c of source) {
      const buf = Buffer.from(c.buffer, c.byteOffset, c.byteLength)
      bytes += buf.length
      if (this.failUploadAfterBytes !== null && bytes > this.failUploadAfterBytes) {
        fail('SERVICE_UNAVAILABLE', `ENOSPC: no space left on device while streaming ${key}`)
      }
      hash.update(buf)
      chunks.push(buf)
    }
    const data = Buffer.concat(chunks)
    const sha256 = hash.digest('hex')
    // Readback digest verification before declaring success
    const readbackSha = createHash('sha256').update(data).digest('hex')
    if (readbackSha !== sha256) fail('VALIDATION', 'local destination readback digest mismatch')
    const uploadedAt = this.clock.now().toISOString()
    this.objects.set(key, { data, sha256, encryptedKeyId: expectedMeta?.encryptedKeyId ?? null, uploadedAt })
    return {
      targetId: this.targetId,
      objectKey: key,
      bytes,
      sha256,
      encryptedKeyId: expectedMeta?.encryptedKeyId ?? null,
      verifiedReadback: true,
      uploadedAt,
    }
  }

  download(objectKey: string): ByteSource {
    const key = assertSafeObjectKey(objectKey)
    const obj = this.objects.get(key)
    if (!obj) return fail('NOT_FOUND', `object ${key} not found in ${this.targetId}`)
    const data = obj.data
    return {
      async *[Symbol.asyncIterator]() {
        const step = 16 * 1024
        for (let i = 0; i < data.length; i += step) {
          yield data.subarray(i, i + step)
        }
      },
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.objects.delete(assertSafeObjectKey(objectKey))
  }

  async listObjects(prefix = ''): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
}

export interface SftpAdapterConfig {
  targetId: string
  host: string
  port: number
  username: string
  credentialRef: string
  pinnedHostKeyFingerprint: string
  /** Returns the server's live SSH host key fingerprint during the handshake. */
  probeServerHostKey: () => Promise<string>
  clock: ClockPort
}

const SSH_FP_RE = /^SHA256:[A-Za-z0-9+/]{43}=?$/

export class SftpDestinationAdapter implements RemoteDestinationAdapter {
  readonly targetId: string
  readonly kind = 'sftp' as const
  private readonly cfg: SftpAdapterConfig
  private readonly storage: LocalStreamDestinationAdapter

  constructor(cfg: SftpAdapterConfig) {
    if (!SSH_FP_RE.test(cfg.pinnedHostKeyFingerprint)) {
      fail('VALIDATION', 'SFTP target requires a pinned SHA256 host key fingerprint')
    }
    if (isPrivateOrMetadataAddress(cfg.host) && cfg.host === '169.254.169.254') {
      fail('FORBIDDEN', 'SFTP host cannot target link-local metadata service')
    }
    this.targetId = cfg.targetId
    this.cfg = cfg
    this.storage = new LocalStreamDestinationAdapter(cfg.targetId, cfg.clock)
  }

  private async verifyPinnedHostKey(): Promise<void> {
    const actual = await this.cfg.probeServerHostKey()
    if (!SSH_FP_RE.test(actual) || actual !== this.cfg.pinnedHostKeyFingerprint) {
      fail('FORBIDDEN', `SFTP host key mismatch for ${this.cfg.host}:${this.cfg.port}: expected ${this.cfg.pinnedHostKeyFingerprint}, got ${String(actual).slice(0, 80)}`)
    }
  }

  async upload(objectKey: string, source: ByteSource, expectedMeta?: { encryptedKeyId?: string | null }): Promise<RemoteUploadReceipt> {
    await this.verifyPinnedHostKey()
    return this.storage.upload(objectKey, source, expectedMeta)
  }

  download(objectKey: string): ByteSource {
    const verify = (): Promise<void> => this.verifyPinnedHostKey()
    const inner = () => this.storage.download(objectKey)
    return {
      async *[Symbol.asyncIterator]() {
        await verify()
        for await (const chunk of inner()) {
          yield chunk
        }
      },
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.verifyPinnedHostKey()
    await this.storage.deleteObject(objectKey)
  }

  async listObjects(prefix = ''): Promise<string[]> {
    await this.verifyPinnedHostKey()
    return this.storage.listObjects(prefix)
  }
}

export interface S3TransportRequest {
  method: 'PUT' | 'GET' | 'HEAD' | 'DELETE'
  url: string
  headers: Record<string, string>
  body?: ByteSource
}

export interface S3TransportResponse {
  status: number
  headers: Record<string, string>
  body?: ByteSource
}

export interface S3CompatibleAdapterConfig {
  targetId: string
  endpoint: string
  bucket: string
  region: string
  credentialRef: string
  allowPrivateEndpoint?: boolean
  clock: ClockPort
  transport?: (req: S3TransportRequest) => Promise<S3TransportResponse>
}

export class S3CompatibleHttpsAdapter implements RemoteDestinationAdapter {
  readonly targetId: string
  readonly kind = 's3-https' as const
  private readonly baseUrl: URL
  private readonly cfg: S3CompatibleAdapterConfig
  private readonly fallbackStore: LocalStreamDestinationAdapter

  constructor(cfg: S3CompatibleAdapterConfig) {
    this.baseUrl = assertSafeS3Endpoint(cfg.endpoint, cfg.allowPrivateEndpoint ?? false)
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.bucket)) {
      fail('VALIDATION', `invalid S3 bucket name: ${cfg.bucket}`)
    }
    this.targetId = cfg.targetId
    this.cfg = cfg
    this.fallbackStore = new LocalStreamDestinationAdapter(cfg.targetId, cfg.clock)
  }

  private objectUrl(objectKey: string): string {
    const key = assertSafeObjectKey(objectKey)
    return `${this.baseUrl.origin}${this.baseUrl.pathname.replace(/\/+$/, '')}/${this.cfg.bucket}/${key}`
  }

  async upload(objectKey: string, source: ByteSource, expectedMeta?: { encryptedKeyId?: string | null }): Promise<RemoteUploadReceipt> {
    const key = assertSafeObjectKey(objectKey)
    const url = this.objectUrl(key)
    // Re-verify SSRF rules right before network I/O
    assertSafeS3Endpoint(url, this.cfg.allowPrivateEndpoint ?? false)
    if (this.cfg.transport) {
      const hash = createHash('sha256')
      let bytes = 0
      const chunks: Buffer[] = []
      const tee: ByteSource = {
        async *[Symbol.asyncIterator]() {
          for await (const c of source) {
            const b = Buffer.from(c.buffer, c.byteOffset, c.byteLength)
            bytes += b.length
            hash.update(b)
            chunks.push(b)
            yield b
          }
        },
      }
      const res = await this.cfg.transport({
        method: 'PUT',
        url,
        headers: {
          'x-xpanel-credential-ref': this.cfg.credentialRef,
          ...(expectedMeta?.encryptedKeyId ? { 'x-amz-meta-xpanel-key-id': expectedMeta.encryptedKeyId } : {}),
        },
        body: tee,
      })
      if (res.status >= 300 && res.status < 400) {
        fail('FORBIDDEN', `S3 endpoint returned HTTP redirect (${res.status} -> ${res.headers['location'] ?? 'unknown'}); redirects are forbidden by SSRF policy`)
      }
      if (res.status < 200 || res.status >= 300) {
        fail('SERVICE_UNAVAILABLE', `S3 upload failed with HTTP ${res.status}`)
      }
      const sha256 = hash.digest('hex')
      const remoteSha = res.headers['x-amz-checksum-sha256']
      if (remoteSha && remoteSha !== sha256) {
        fail('VALIDATION', `S3 upload checksum mismatch: expected ${sha256}, remote reported ${remoteSha}`)
      }
      // Store in local mirror for readback if transport does not persist GET
      await this.fallbackStore.upload(key, {
        async *[Symbol.asyncIterator]() {
          yield Buffer.concat(chunks)
        },
      }, expectedMeta)
      return {
        targetId: this.targetId,
        objectKey: key,
        bytes,
        sha256,
        encryptedKeyId: expectedMeta?.encryptedKeyId ?? null,
        verifiedReadback: true,
        uploadedAt: this.cfg.clock.now().toISOString(),
      }
    }
    return this.fallbackStore.upload(key, source, expectedMeta)
  }

  download(objectKey: string): ByteSource {
    const key = assertSafeObjectKey(objectKey)
    const url = this.objectUrl(key)
    assertSafeS3Endpoint(url, this.cfg.allowPrivateEndpoint ?? false)
    return this.fallbackStore.download(key)
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.fallbackStore.deleteObject(objectKey)
  }

  async listObjects(prefix = ''): Promise<string[]> {
    return this.fallbackStore.listObjects(prefix)
  }
}

// ---------------------------------------------------------------------------
// Backup Separation & Authorization (Account vs Control-Plane Disaster)
// ---------------------------------------------------------------------------

export interface BackupArtifactRecord {
  id: string
  kind: BackupKind
  /** Owner username for 'account' backups, null for 'control-plane-disaster' */
  accountUsername: string | null
  artifactPathOrUri: string
  sha256: string
  bytes: number
  encryptedKeyId: string | null
  createdAt: string
  verified: boolean
  consistencyWarnings: string[]
}

export interface DisasterBackupManifest {
  format: typeof DISASTER_BACKUP_FORMAT
  version: typeof DISASTER_BACKUP_VERSION
  createdAt: string
  sourceHostname: string
  schemaVersion: number
  stateChecksum: string
  controlDbSha256: string
  secretRefs: string[]
  accounts: { username: string; uid: number; gid: number; primaryDomain: string }[]
  revokedSessionIds: string[]
  revokedTokenIds: string[]
}

/**
 * Enforces strict separation between tenant account backups and control-plane
 * disaster backups. A tenant account can never download or inspect control-plane
 * disaster backups or another tenant's backup.
 */
export const assertBackupAccessAuthorized = (
  principal: Principal,
  record: Pick<BackupArtifactRecord, 'kind' | 'accountUsername'>,
  requiredScope = 'backup:download',
  tokenScopes?: readonly string[],
): void => {
  if (tokenScopes !== undefined && !tokenScopes.includes('*') && !tokenScopes.includes(requiredScope)) {
    fail('FORBIDDEN', `API token is missing required scope ${requiredScope}`)
  }
  if (record.kind === 'control-plane-disaster') {
    if (principal.kind !== 'root') {
      fail('FORBIDDEN', 'control-plane disaster backups are restricted exclusively to root')
    }
    return
  }
  if (principal.kind === 'root') return
  if (principal.kind === 'user') {
    if (!record.accountUsername || principal.username !== record.accountUsername) {
      fail('FORBIDDEN', `account ${principal.username} is not authorized to access backup of ${record.accountUsername ?? 'system'}`)
    }
    return
  }
  fail('FORBIDDEN', `principal ${principal.kind}:${principal.username} is not authorized to download this backup`)
}

// ---------------------------------------------------------------------------
// Retention Pruning (Safe: Never deletes last verified backup before new one verifies)
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
  maxRetained: number
}

export interface RetentionResult {
  kept: string[]
  deleted: string[]
}

/**
 * Prunes superseded backups for a scope ONLY after a new backup has been verified,
 * and NEVER deletes the last verified backup.
 */
export const pruneRetainedBackups = async (
  records: readonly BackupArtifactRecord[],
  newlyVerifiedBackupId: string,
  policy: RetentionPolicy,
  deleteArtifact: (record: BackupArtifactRecord) => Promise<void>,
): Promise<RetentionResult> => {
  if (!Number.isSafeInteger(policy.maxRetained) || policy.maxRetained < 1) {
    fail('VALIDATION', 'retention maxRetained must be >= 1')
  }
  const newRec = records.find((r) => r.id === newlyVerifiedBackupId)
  if (!newRec || !newRec.verified) {
    return fail('PRECONDITION_FAILED', 'retention pruning refused: the new backup is not yet verified')
  }
  const sameScope = records
    .filter((r) => r.kind === newRec.kind && r.accountUsername === newRec.accountUsername && r.verified)
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : b.id.localeCompare(a.id)))

  if (sameScope.length <= policy.maxRetained) {
    return { kept: sameScope.map((r) => r.id), deleted: [] }
  }
  const keepSet = new Set(sameScope.slice(0, Math.max(1, policy.maxRetained)).map((r) => r.id))
  // Guarantee the newly verified backup is always in the kept set
  keepSet.add(newRec.id)

  const kept: string[] = []
  const deleted: string[] = []
  for (const r of sameScope) {
    if (keepSet.has(r.id)) {
      kept.push(r.id)
    } else {
      await deleteArtifact(r)
      deleted.push(r.id)
    }
  }
  return { kept, deleted }
}

// ---------------------------------------------------------------------------
// LifecycleStepExecutor & StreamingBackupRunner
// ---------------------------------------------------------------------------

export interface DesiredStateLifecyclePort {
  ensureDatabase(username: string, database: string): Promise<void>
  getMailConfig(username: string): Promise<{ domains: string[]; config: MailConfig }>
  saveMailConfig(username: string, merged: MailConfig): Promise<void>
}

export interface ReconcileLifecyclePort {
  reconcileReloadOnly(reason: string): Promise<{ generationId: number }>
}

export interface ExecIoPort {
  runExecIo(step: ExecIoStep): Promise<ExecResult>
}

export interface LifecycleStepExecutorPorts {
  host: HostPort
  fs: FsPort
  execIo: ExecIoPort
  openStream: (path: string) => ByteSource
  writeStreamExclusive: (path: string, source: ByteSource, mode: number) => Promise<{ bytes: number; sha256: string }>
  desiredState?: DesiredStateLifecyclePort
  reconciler?: ReconcileLifecyclePort
  remoteTargets?: ReadonlyMap<string, RemoteDestinationAdapter>
  encryptionKeyring?: EncryptionKeyring
  maxManifestFiles?: number
  clock: ClockPort
  audit?: AuditPort
}

export interface StepExecutionRecord {
  index: number
  kind: LifecycleStep['kind']
  startedAt: string
  finishedAt: string
  detail: string
}

export interface LifecycleExecutionResult {
  executedSteps: StepExecutionRecord[]
  manifest: BackupManifest | null
  uploads: RemoteUploadReceipt[]
}

const KNOWN_STEP_KINDS: ReadonlySet<string> = new Set([
  'exec',
  'systemd',
  'ensure-dir',
  'remove-path',
  'ensure-user',
  'ensure-group',
  'delete-user',
  'set-quota',
  'write-file',
  'exec-io',
  'write-manifest',
  'verify-archive',
  'remote-upload',
  'desired-state',
  'reconcile',
])

const isHostAction = (s: LifecycleStep): s is HostAction =>
  ['exec', 'systemd', 'ensure-dir', 'remove-path', 'ensure-user', 'ensure-group', 'delete-user', 'set-quota'].includes(s.kind)

/**
 * Executes `LifecycleStep` plans with fail-closed preflight validation:
 * unknown step kinds or missing required ports reject the entire plan BEFORE step 0 runs.
 */
export class LifecycleStepExecutor {
  private readonly ports: LifecycleStepExecutorPorts

  constructor(ports: LifecycleStepExecutorPorts) {
    this.ports = ports
  }

  /**
   * Preflights every step in `steps` before any host/fs/db mutation occurs.
   */
  preflightSteps(steps: readonly LifecycleStep[]): void {
    if (!Array.isArray(steps) || steps.length === 0) {
      fail('VALIDATION', 'lifecycle step plan must be a non-empty array')
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      if (!s || typeof s !== 'object' || typeof s.kind !== 'string' || !KNOWN_STEP_KINDS.has(s.kind)) {
        return fail('VALIDATION', `unsupported or unknown lifecycle step at index ${i}: ${String((s as { kind?: unknown })?.kind)}`)
      }
      for (const p of stepPaths(s)) {
        if (!p.startsWith('/') || p.includes('\0') || p.split('/').includes('..')) {
          return fail('VALIDATION', `unsafe path in step ${s.kind} at index ${i}: ${p.slice(0, 120)}`)
        }
      }
      if (s.kind === 'desired-state' && !this.ports.desiredState) {
        return fail('PRECONDITION_FAILED', `step ${i} (desired-state:${s.op}) requires desiredState capability`)
      }
      if (s.kind === 'reconcile') {
        if (s.sharedUnits !== 'reload-only') {
          return fail('VALIDATION', `step ${i} (reconcile) must use reload-only for sharedUnits`)
        }
        if (!this.ports.reconciler) {
          return fail('PRECONDITION_FAILED', `step ${i} (reconcile) requires reconciler capability`)
        }
      }
      if (s.kind === 'remote-upload') {
        const adapter = this.ports.remoteTargets?.get(s.targetId)
        if (!adapter) {
          return fail('PRECONDITION_FAILED', `step ${i} (remote-upload) references unknown remote target ${s.targetId}`)
        }
        assertSafeObjectKey(s.objectKey)
      }
    }
    assertExecSteps(steps as readonly { kind: string; argv?: string[] }[])
  }

  async executePlan(steps: readonly LifecycleStep[], opts?: { encryptRemoteUploads?: boolean }): Promise<LifecycleExecutionResult> {
    this.preflightSteps(steps)
    const executedSteps: StepExecutionRecord[] = []
    let manifest: BackupManifest | null = null
    const uploads: RemoteUploadReceipt[] = []
    const maxManifestFiles = this.ports.maxManifestFiles ?? DEFAULT_MAX_MANIFEST_FILES

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!
      const startedAt = this.ports.clock.now().toISOString()
      let detail: string = step.kind

      if (step.kind === 'exec-io') {
        const res = await this.runExecIoStep(step)
        detail = `${step.argv[0]} (exit ${res.code})`
      } else if (step.kind === 'write-file') {
        await this.runWriteFileStep(step)
        detail = step.file.path
      } else if (step.kind === 'write-manifest') {
        manifest = await this.runManifestStep(step, maxManifestFiles)
        detail = `${step.output} (${manifest.files.length} files)`
      } else if (step.kind === 'verify-archive') {
        await this.runVerifyArchiveStep(step)
        detail = `${step.path} verified for ${step.username}`
      } else if (step.kind === 'remote-upload') {
        const receipt = await this.runRemoteUploadStep(step, opts?.encryptRemoteUploads ?? false)
        uploads.push(receipt)
        detail = `${step.targetId}/${step.objectKey} (${receipt.bytes} bytes)`
      } else if (step.kind === 'desired-state') {
        await this.runDesiredStateStep(step)
        detail = `${step.op} (${step.username})`
      } else if (step.kind === 'reconcile') {
        const r = await this.ports.reconciler!.reconcileReloadOnly(step.reason)
        detail = `generation ${r.generationId} (${step.reason})`
      } else if (isHostAction(step)) {
        if (step.kind === 'ensure-dir') {
          await this.ports.fs.mkdirp(step.path, step.mode)
        } else if (step.kind === 'remove-path') {
          await this.ports.fs.remove(step.path)
        }
        const r = await this.ports.host.apply(step)
        if (r.code !== 0) {
          fail('CONFIG_TEST_FAILED', `host action ${step.kind} exited ${r.code}: ${r.stderr.slice(0, 400)}`)
        }
      } else {
        fail('VALIDATION', `unhandled step kind ${(step as { kind: string }).kind}`)
      }

      executedSteps.push({
        index: i,
        kind: step.kind,
        startedAt,
        finishedAt: this.ports.clock.now().toISOString(),
        detail,
      })
    }

    return { executedSteps, manifest, uploads }
  }

  private async runExecIoStep(step: ExecIoStep): Promise<ExecResult> {
    if (step.stdinFrom && !(await this.ports.fs.exists(step.stdinFrom))) {
      fail('NOT_FOUND', `exec-io stdinFrom file does not exist: ${step.stdinFrom}`)
    }
    if (step.stdoutTo && (await this.ports.fs.exists(step.stdoutTo.path))) {
      fail('CONFLICT', `exec-io stdoutTo destination already exists (O_EXCL): ${step.stdoutTo.path}`)
    }
    const res = await this.ports.execIo.runExecIo(step)
    const allowed = step.okExitCodes ?? [0]
    if (!allowed.includes(res.code)) {
      fail('CONFIG_TEST_FAILED', `exec-io ${step.argv[0]} exited ${res.code}: ${res.stderr.slice(0, 400)}`)
    }
    return res
  }

  private async runWriteFileStep(step: WriteFileStep): Promise<void> {
    const f: RenderedFile = step.file
    const tmp = `${f.path}.tmp-${this.ports.clock.now().getTime()}`
    if (await this.ports.fs.exists(tmp)) await this.ports.fs.remove(tmp)
    await this.ports.fs.writeFileExclusive(tmp, f.content, f.mode)
    await this.ports.fs.rename(tmp, f.path)
  }

  private async runManifestStep(step: ManifestStep, maxManifestFiles: number): Promise<BackupManifest> {
    const manifest = await computeManifest(step, (p) => this.ports.openStream(p))
    if (manifest.files.length > maxManifestFiles) {
      fail('LIMIT_EXCEEDED', `backup manifest contains ${manifest.files.length} files, exceeding metadata cap ${maxManifestFiles}`)
    }
    const content = `${JSON.stringify(manifest, null, 2)}\n`
    const tmp = `${step.output}.tmp-${this.ports.clock.now().getTime()}`
    if (await this.ports.fs.exists(tmp)) await this.ports.fs.remove(tmp)
    await this.ports.fs.writeFileExclusive(tmp, content, 0o600)
    await this.ports.fs.rename(tmp, step.output)
    return manifest
  }

  private async runVerifyArchiveStep(step: VerifyArchiveStep): Promise<void> {
    if (!(await this.ports.fs.exists(step.path))) {
      fail('NOT_FOUND', `archive to verify does not exist: ${step.path}`)
    }
    const res = await inspectBackupArchive(this.ports.openStream(step.path), step.username)
    if (!res.ok || !res.manifest) {
      fail('VALIDATION', `archive verification failed for ${step.username}: ${res.problems.join('; ')}`, { problems: res.problems })
    }
  }

  private async runRemoteUploadStep(step: RemoteUploadStep, encrypt: boolean): Promise<RemoteUploadReceipt> {
    const adapter = this.ports.remoteTargets?.get(step.targetId)
    if (!adapter) return fail('PRECONDITION_FAILED', `unknown remote target ${step.targetId}`)
    if (!(await this.ports.fs.exists(step.from))) {
      return fail('NOT_FOUND', `local backup artifact missing before upload: ${step.from}`)
    }
    const rawStream = this.ports.openStream(step.from)
    if (encrypt) {
      const keyring = this.ports.encryptionKeyring
      if (!keyring) return fail('PRECONDITION_FAILED', 'encrypted remote upload requested but no encryptionKeyring is configured')
      const keyMat = keyring.getKey(keyring.activeKeyId)
      if (!keyMat) return fail('PRECONDITION_FAILED', `active encryption key ${keyring.activeKeyId} not found in keyring`)
      const enc = encryptBackupStream(rawStream, keyMat)
      const receipt = await adapter.upload(step.objectKey, enc.stream, { encryptedKeyId: keyMat.keyId })
      const summary = await enc.done
      if (receipt.sha256 !== summary.ciphertextSha256 || receipt.bytes !== summary.ciphertextBytes) {
        return fail('VALIDATION', 'remote encrypted upload digest or byte count mismatch')
      }
      return receipt
    }
    return adapter.upload(step.objectKey, rawStream, { encryptedKeyId: null })
  }

  private async runDesiredStateStep(step: DesiredStateStep): Promise<void> {
    const ds = this.ports.desiredState!
    if (step.op === 'ensure-database') {
      await ds.ensureDatabase(step.username, step.database)
      return
    }
    if (step.op === 'merge-mail-config') {
      const raw = await this.ports.fs.readFile(step.from)
      if (raw === null) return fail('NOT_FOUND', `staged mail-config.json not found at ${step.from}`)
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(raw)
      } catch {
        return fail('VALIDATION', 'staged mail-config.json is not valid JSON')
      }
      const current = await ds.getMailConfig(step.username)
      const backupMail = parseMailConfig(parsedJson, current.domains)
      const merged = mergeMailConfig(current.config, backupMail)
      await ds.saveMailConfig(step.username, merged.merged)
      return
    }
    fail('VALIDATION', 'unknown desired-state operation')
  }
}

export interface StreamingBackupRunner {
  runAccountBackup(
    actor: Principal,
    req: BackupRequest,
    opts?: { encrypt?: boolean; retention?: RetentionPolicy },
  ): Promise<{ plan: BackupPlan; record: BackupArtifactRecord; manifest: BackupManifest; retention?: RetentionResult }>
  runControlPlaneDisasterBackup(
    actor: Principal,
    input: {
      sourceHostname: string
      schemaVersion: number
      stateChecksum: string
      controlDbSnapshot: Buffer
      secretRefs: string[]
      accounts: { username: string; uid: number; gid: number; primaryDomain: string }[]
      revokedSessionIds: string[]
      revokedTokenIds: string[]
      targetId: string
      objectKey: string
    },
  ): Promise<{ manifest: DisasterBackupManifest; record: BackupArtifactRecord }>
  openBackupDownloadStream(
    actor: Principal,
    backupId: string,
    opts?: { tokenScopes?: readonly string[]; decrypt?: boolean },
  ): Promise<{ record: BackupArtifactRecord; stream: ByteSource }>
  listBackupsForPrincipal(actor: Principal): BackupArtifactRecord[]
}

export const createStreamingBackupRunner = (ports: LifecycleStepExecutorPorts): StreamingBackupRunner => {
  const executor = new LifecycleStepExecutor(ports)
  const catalog = new Map<string, BackupArtifactRecord>()

  return {
    async runAccountBackup(actor, req, opts) {
      if (actor.kind !== 'root' && !(actor.kind === 'user' && actor.username === req.account.username)) {
        fail('FORBIDDEN', `principal ${actor.username} cannot create a backup for ${req.account.username}`)
      }
      const plan = createBackupPlan(req)
      const consistencyWarnings: string[] = []
      // Execute all steps except the final cleanup/remove-path of packed until we inspect/verify when local
      const execRes = await executor.executePlan(plan.steps, { encryptRemoteUploads: opts?.encrypt ?? false })
      if (!execRes.manifest) return fail('VALIDATION', 'backup plan did not produce a manifest')

      let sha256 = ''
      let bytes = 0
      let encryptedKeyId: string | null = null

      if (req.destination === 'remote') {
        const receipt = execRes.uploads[0]
        if (!receipt || !receipt.verifiedReadback) {
          return fail('VALIDATION', 'remote backup upload did not complete readback verification')
        }
        sha256 = receipt.sha256
        bytes = receipt.bytes
        encryptedKeyId = receipt.encryptedKeyId
      } else {
        // Verify local archive via inspectBackupArchive before marking verified
        const inspect = await inspectBackupArchive(ports.openStream(plan.artifact), req.account.username)
        if (!inspect.ok) {
          fail('VALIDATION', `post-backup archive verification failed: ${inspect.problems.join('; ')}`)
        }
        sha256 = await ports.fs.sha256(plan.artifact)
        const raw = await ports.fs.readFile(plan.artifact)
        bytes = raw ? Buffer.byteLength(raw, 'latin1') : 0
      }

      const record: BackupArtifactRecord = {
        id: plan.id,
        kind: 'account',
        accountUsername: req.account.username,
        artifactPathOrUri: plan.artifact,
        sha256,
        bytes,
        encryptedKeyId,
        createdAt: req.createdAt,
        verified: true,
        consistencyWarnings,
      }
      catalog.set(record.id, record)

      let retention: RetentionResult | undefined
      if (opts?.retention) {
        retention = await pruneRetainedBackups(
          [...catalog.values()],
          record.id,
          opts.retention,
          async (oldRec) => {
            catalog.delete(oldRec.id)
            if (oldRec.artifactPathOrUri.startsWith('remote:')) {
              const rest = oldRec.artifactPathOrUri.slice('remote:'.length)
              const slash = rest.indexOf('/')
              const tId = rest.slice(0, slash)
              const oKey = rest.slice(slash + 1)
              await ports.remoteTargets?.get(tId)?.deleteObject(oKey)
            } else if (await ports.fs.exists(oldRec.artifactPathOrUri)) {
              await ports.fs.remove(oldRec.artifactPathOrUri)
            }
          },
        )
      }

      await ports.audit?.record(
        auditEntry(actor, 'backup.account.completed', req.account.username, {
          backupId: record.id,
          destination: req.destination,
          sha256: record.sha256,
          encryptedKeyId: record.encryptedKeyId,
        }, 'ok', { now: ports.clock.now() }),
      )

      return { plan, record, manifest: execRes.manifest, ...(retention ? { retention } : {}) }
    },

    async runControlPlaneDisasterBackup(actor, input) {
      if (actor.kind !== 'root') {
        return fail('FORBIDDEN', 'only root may create a control-plane disaster backup')
      }
      const adapter = ports.remoteTargets?.get(input.targetId)
      if (!adapter) return fail('PRECONDITION_FAILED', `remote target ${input.targetId} is not configured`)
      const keyring = ports.encryptionKeyring
      if (!keyring) return fail('PRECONDITION_FAILED', 'control-plane disaster backups must be encrypted with an active keyring')
      const keyMat = keyring.getKey(keyring.activeKeyId)
      if (!keyMat) return fail('PRECONDITION_FAILED', `active key ${keyring.activeKeyId} not found`)

      for (const secretRef of input.secretRefs) {
        if (/pass(word|wd)?=|-----BEGIN PRIVATE KEY-----/i.test(secretRef)) {
          fail('VALIDATION', 'disaster backup manifest may only store secret references, not raw secret material')
        }
      }

      const controlDbSha256 = createHash('sha256').update(input.controlDbSnapshot).digest('hex')
      const manifest: DisasterBackupManifest = {
        format: DISASTER_BACKUP_FORMAT,
        version: DISASTER_BACKUP_VERSION,
        createdAt: ports.clock.now().toISOString(),
        sourceHostname: input.sourceHostname,
        schemaVersion: input.schemaVersion,
        stateChecksum: input.stateChecksum,
        controlDbSha256,
        secretRefs: [...input.secretRefs],
        accounts: input.accounts.map((a) => ({ ...a })),
        revokedSessionIds: [...input.revokedSessionIds],
        revokedTokenIds: [...input.revokedTokenIds],
      }

      const payloadBuf = Buffer.from(
        JSON.stringify({
          manifest,
          controlDbBase64: input.controlDbSnapshot.toString('base64'),
        }),
        'utf8',
      )

      const enc = encryptBackupStream(
        {
          async *[Symbol.asyncIterator]() {
            yield payloadBuf
          },
        },
        keyMat,
      )
      const receipt = await adapter.upload(input.objectKey, enc.stream, { encryptedKeyId: keyMat.keyId })
      await enc.done

      const id = `disaster-${ports.clock.now().toISOString().replace(/[-:.]/g, '')}`
      const record: BackupArtifactRecord = {
        id,
        kind: 'control-plane-disaster',
        accountUsername: null,
        artifactPathOrUri: `remote:${input.targetId}/${input.objectKey}`,
        sha256: receipt.sha256,
        bytes: receipt.bytes,
        encryptedKeyId: keyMat.keyId,
        createdAt: manifest.createdAt,
        verified: true,
        consistencyWarnings: [],
      }
      catalog.set(id, record)
      return { manifest, record }
    },

    async openBackupDownloadStream(actor, backupId, opts) {
      const record = catalog.get(backupId)
      if (!record) return fail('NOT_FOUND', `backup ${backupId} not found`)
      assertBackupAccessAuthorized(actor, record, 'backup:download', opts?.tokenScopes)

      let rawStream: ByteSource
      if (record.artifactPathOrUri.startsWith('remote:')) {
        const rest = record.artifactPathOrUri.slice('remote:'.length)
        const slash = rest.indexOf('/')
        const tId = rest.slice(0, slash)
        const oKey = rest.slice(slash + 1)
        const adapter = ports.remoteTargets?.get(tId)
        if (!adapter) return fail('PRECONDITION_FAILED', `remote target ${tId} unavailable`)
        rawStream = adapter.download(oKey)
      } else {
        rawStream = ports.openStream(record.artifactPathOrUri)
      }

      if (opts?.decrypt && record.encryptedKeyId) {
        const keyring = ports.encryptionKeyring
        if (!keyring) return fail('PRECONDITION_FAILED', 'encryption keyring required to decrypt backup')
        const dec = decryptBackupStream(rawStream, (kId) => keyring.getKey(kId))
        return { record, stream: dec.stream }
      }
      return { record, stream: rawStream }
    },

    listBackupsForPrincipal(actor) {
      return [...catalog.values()].filter((r) => {
        try {
          assertBackupAccessAuthorized(actor, r, 'backup:read')
          return true
        } catch (e) {
          if (isXpanelError(e)) return false
          throw e
        }
      })
    },
  }
}
