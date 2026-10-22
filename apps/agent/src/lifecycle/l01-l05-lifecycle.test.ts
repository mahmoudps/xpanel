import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { XpanelError, fail } from '@xpanel/core'
import type { AuditEntry, HostAction, OsProfile, Principal } from '@xpanel/core'
import { createTestDb, listUpgrades, loadMigrations, parseMigration } from '@xpanel/db'
import {
  computeManifest,
  createBackupPlan,
  exportAccountArchive,
  importAccountArchive,
} from '@xpanel/lifecycle'
import type {
  AccountArchiveManifest,
  AccountIdentity,
  AuditPort,
  BackupManifest,
  BackupRequest,
  ByteSource,
  ClockPort,
  ExecResult,
  FsPort,
  HostPort,
  LifecycleStep,
  MailConfig,
  ManifestStep,
  SinkItem,
  UnitChange,
} from '@xpanel/lifecycle'
import { parseOsRelease, profileFor } from '@xpanel/os'
import { gzipSync } from 'node:zlib'
import type { AccountFileContext, AccountFileRequest, AccountFileRunner } from '../file-manager.ts'
import {
  DEFAULT_MAX_MANIFEST_FILES,
  ENCRYPTED_BACKUP_MAGIC,
  LifecycleStepExecutor,
  LocalStreamDestinationAdapter,
  S3CompatibleHttpsAdapter,
  SftpDestinationAdapter,
  assertBackupAccessAuthorized,
  assertSafeS3Endpoint,
  createStreamingBackupRunner,
  decryptBackupStream,
  encryptBackupStream,
  isPrivateOrMetadataAddress,
  pruneRetainedBackups,
} from './step-executor.ts'
import type { EncryptionKeyMaterial, EncryptionKeyring } from './step-executor.ts'
import {
  ConfinedRestoreRunner,
  assertSafeRestoreSql,
  executeDisasterRestore,
} from './restore-runner.ts'
import type { StagedHomeFile } from './restore-runner.ts'
import { CpanelImportRunner } from './cpanel-import.ts'
import { DurableTransferRunner } from './transfer-runner.ts'
import type { TransferCheckpointStage } from './transfer-runner.ts'
import {
  PanelUpgradeRunner,
  canonicalReleasePayload,
  signReleaseManifestHmac,
  verifyReleaseArtifactSignature,
} from './upgrade-runner.ts'
import type { ReleaseVerificationKey, SignedReleaseManifest } from './upgrade-runner.ts'

// ---------------------------------------------------------------------------
// Portable Test Helpers (In-memory FsPort, HostPort, ClockPort, Tar builder)
// ---------------------------------------------------------------------------

const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

const ROOT: Principal = { kind: 'root', id: '00000000-0000-4000-8000-000000000001', username: 'root' }
const ALICE: Principal = { kind: 'user', id: '00000000-0000-4000-8000-000000000002', username: 'alice', accountId: 'acc-alice' }
const BOB: Principal = { kind: 'user', id: '00000000-0000-4000-8000-000000000003', username: 'bob', accountId: 'acc-bob' }
const RESELLER: Principal = { kind: 'reseller', id: '00000000-0000-4000-8000-000000000004', username: 'resel' }

interface TestTarEntry {
  name: string
  type?: 'file' | 'directory' | 'symlink' | 'link' | 'block-device' | 'character-device' | 'fifo'
  content?: string | Buffer
  linkname?: string
  mode?: number
}

const TYPE_FLAGS: Record<NonNullable<TestTarEntry['type']>, string> = {
  file: '0',
  link: '1',
  symlink: '2',
  'character-device': '3',
  'block-device': '4',
  directory: '5',
  fifo: '6',
}

const writeOctal = (buf: Buffer, offset: number, length: number, value: number): void => {
  const s = value.toString(8).padStart(length - 1, '0')
  buf.write(s, offset, length - 1, 'ascii')
  buf[offset + length - 1] = 0
}

const buildTestTar = async (entries: TestTarEntry[], opts: { gzip?: boolean } = {}): Promise<Buffer> => {
  const blocks: Buffer[] = []
  const mtimeSec = Math.floor(new Date('2026-10-22T00:00:00Z').getTime() / 1000)

  for (const e of entries) {
    const type = e.type ?? 'file'
    const body = type === 'file' ? (typeof e.content === 'string' ? Buffer.from(e.content, 'utf8') : (e.content ?? Buffer.alloc(0))) : Buffer.alloc(0)
    const header = Buffer.alloc(512, 0)

    if (Buffer.byteLength(e.name, 'utf8') <= 100) {
      header.write(e.name, 0, 100, 'utf8')
    } else {
      const slash = e.name.lastIndexOf('/', e.name.length - 1)
      const prefix = e.name.slice(0, slash)
      const shortName = e.name.slice(slash + 1)
      header.write(shortName, 0, 100, 'utf8')
      header.write(prefix, 345, 155, 'utf8')
    }

    writeOctal(header, 100, 8, e.mode ?? (type === 'directory' ? 0o755 : 0o644))
    writeOctal(header, 108, 8, 1000)
    writeOctal(header, 116, 8, 1000)
    writeOctal(header, 124, 12, body.length)
    writeOctal(header, 136, 12, mtimeSec)
    header.fill(0x20, 148, 156) // spaces for checksum calculation
    header.write(TYPE_FLAGS[type], 156, 1, 'ascii')
    if (e.linkname) {
      header.write(e.linkname, 157, 100, 'utf8')
    }
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')

    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i] ?? 0
    const chk = sum.toString(8).padStart(6, '0')
    header.write(chk, 148, 6, 'ascii')
    header[154] = 0
    header[155] = 0x20

    blocks.push(header)
    if (body.length > 0) {
      blocks.push(body)
      const rem = body.length % 512
      if (rem !== 0) {
        blocks.push(Buffer.alloc(512 - rem, 0))
      }
    }
  }

  blocks.push(Buffer.alloc(1024, 0))
  const raw = Buffer.concat(blocks)
  return opts.gzip ? gzipSync(raw) : raw
}

async function* chunkedBytes(buf: Buffer, size = 128): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) {
    yield buf.subarray(i, i + size)
  }
}

const collectStream = async (src: ByteSource): Promise<Buffer> => {
  const parts: Buffer[] = []
  for await (const c of src) {
    parts.push(Buffer.from(c.buffer, c.byteOffset, c.byteLength))
  }
  return Buffer.concat(parts)
}

type MemNode =
  | { type: 'file'; content: string; raw?: Buffer; mode: number }
  | { type: 'dir'; mode: number }
  | { type: 'symlink'; target: string }

class MemoryFsPort implements FsPort {
  readonly nodes = new Map<string, MemNode>()
  readonly writes: string[] = []

  constructor(seed: Record<string, MemNode> = {}) {
    this.nodes.set('/', { type: 'dir', mode: 0o755 })
    for (const [k, v] of Object.entries(seed)) {
      this.ensureParents(k)
      this.nodes.set(k, v)
    }
  }

  private ensureParents(p: string): void {
    let cur = posix.dirname(p)
    const missing: string[] = []
    while (!this.nodes.has(cur)) {
      missing.push(cur)
      cur = posix.dirname(cur)
    }
    for (const m of missing.reverse()) {
      this.nodes.set(m, { type: 'dir', mode: 0o755 })
    }
  }

  putFile(path: string, content: string | Buffer, mode = 0o600): void {
    this.ensureParents(path)
    if (Buffer.isBuffer(content)) {
      this.nodes.set(path, { type: 'file', content: content.toString('latin1'), raw: Buffer.from(content), mode })
    } else {
      this.nodes.set(path, { type: 'file', content, raw: Buffer.from(content, 'utf8'), mode })
    }
  }

  getBuffer(path: string): Buffer {
    const n = this.nodes.get(path)
    if (!n || n.type !== 'file') throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return n.raw ?? Buffer.from(n.content, 'utf8')
  }

  async exists(p: string): Promise<boolean> {
    return this.nodes.has(p)
  }

  async readlink(p: string): Promise<string | null> {
    const n = this.nodes.get(p)
    return n?.type === 'symlink' ? n.target : null
  }

  async readFile(p: string): Promise<string | null> {
    const n = this.nodes.get(p)
    return n?.type === 'file' ? n.content : null
  }

  async sha256(p: string): Promise<string> {
    const n = this.nodes.get(p)
    if (!n || n.type !== 'file') throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return sha256Hex(n.raw ?? n.content)
  }

  async symlink(target: string, p: string): Promise<void> {
    this.writes.push(p)
    if (this.nodes.has(p)) throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' })
    this.ensureParents(p)
    this.nodes.set(p, { type: 'symlink', target })
  }

  async rename(from: string, to: string): Promise<void> {
    this.writes.push(from, to)
    const n = this.nodes.get(from)
    if (!n) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' })
    this.ensureParents(to)
    const children = [...this.nodes.keys()].filter((k) => k.startsWith(`${from}/`))
    const entries = [[from, n] as const, ...children.map((c) => [c, this.nodes.get(c)!] as const)]
    for (const [k] of entries) this.nodes.delete(k)
    for (const [k, v] of entries) this.nodes.set(to + k.slice(from.length), v)
  }

  async mkdirp(p: string, mode: number): Promise<void> {
    this.writes.push(p)
    this.ensureParents(p)
    if (!this.nodes.has(p)) this.nodes.set(p, { type: 'dir', mode })
  }

  async writeFileExclusive(p: string, content: string, mode: number): Promise<void> {
    this.writes.push(p)
    if (this.nodes.has(p)) throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' })
    this.ensureParents(p)
    this.nodes.set(p, { type: 'file', content, raw: Buffer.from(content, 'utf8'), mode })
  }

  async remove(p: string): Promise<void> {
    this.writes.push(p)
    for (const k of [...this.nodes.keys()]) {
      if (k === p || k.startsWith(`${p}/`)) this.nodes.delete(k)
    }
  }
}

class FakeClockPort implements ClockPort {
  ms = Date.parse('2026-10-22T01:35:00.000Z')
  readonly sleeps: number[] = []
  now(): Date {
    return new Date(this.ms)
  }
  async sleep(d: number): Promise<void> {
    this.sleeps.push(d)
    this.ms += d
  }
}

class MemoryAuditPort implements AuditPort {
  readonly entries: AuditEntry[] = []
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry)
  }
}

const sampleMailConfig: MailConfig = {
  domains: [
    {
      domain: 'alice.example',
      forwarders: [{ local: 'info', to: ['alice@gmail.com'] }],
      defaultAddress: { kind: 'reject' },
    },
  ],
  mailboxes: [
    {
      address: 'info@alice.example',
      filters: [
        {
          name: 'spam-filter',
          match: 'any',
          tests: [{ field: 'subject', op: 'contains', value: '[SPAM]' }],
          actions: [{ kind: 'fileinto', folder: 'Junk' }],
        },
      ],
    },
  ],
}

// ---------------------------------------------------------------------------
// 1. L01 Tests (A47, A48) — Streaming Encrypted Backups, Step Executor & Remote Targets
// ---------------------------------------------------------------------------

describe('L01 (A47, A48): LifecycleStepExecutor & StreamingBackupRunner', () => {
  const keyV1: EncryptionKeyMaterial = {
    keyId: 'key-2026-v1',
    key: Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex'),
  }
  const keyV2Wrong: EncryptionKeyMaterial = {
    keyId: 'key-2026-v1',
    key: Buffer.from('fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210', 'hex'),
  }

  const keyring: EncryptionKeyring = {
    activeKeyId: keyV1.keyId,
    getKey: (id) => (id === keyV1.keyId ? keyV1 : null),
  }

  it('fails closed before any mutation on unknown/unsupported step kinds or missing capabilities', async () => {
    const fs = new MemoryFsPort()
    const clock = new FakeClockPort()
    const executed: HostAction[] = []
    const executor = new LifecycleStepExecutor({
      host: {
        async apply(a) {
          executed.push(a)
          return { code: 0, stdout: '', stderr: '' }
        },
      },
      fs,
      execIo: { async runExecIo() { return { code: 0, stdout: '', stderr: '' } } },
      openStream: (p) => chunkedBytes(fs.getBuffer(p)),
      writeStreamExclusive: async () => ({ bytes: 0, sha256: '' }),
      clock,
    })

    // Unknown step after an ensure-dir step must fail preflight BEFORE ensure-dir runs!
    const badSteps = [
      { kind: 'ensure-dir', path: '/var/lib/xpanel/backups/work/test', mode: 0o700, owner: 'root', group: 'root' },
      { kind: 'unknown-future-step', path: '/var/lib/xpanel/x' },
    ] as unknown as LifecycleStep[]

    await expect(executor.executePlan(badSteps)).rejects.toThrow(/unsupported or unknown lifecycle step/)
    expect(executed).toEqual([])
    expect(fs.writes).toEqual([])

    // Missing desiredState capability fails preflight before step 0 runs
    const missingCapSteps: LifecycleStep[] = [
      { kind: 'ensure-dir', path: '/var/lib/xpanel/backups/work/test', mode: 0o700, owner: 'root', group: 'root' },
      { kind: 'desired-state', op: 'ensure-database', username: 'alice', database: 'alice_wp' },
    ]
    await expect(executor.executePlan(missingCapSteps)).rejects.toThrow(/requires desiredState capability/)
    expect(executed).toEqual([])
  })

  it('streams AES-256-GCM authenticated encryption and rejects wrong keys, tampering, or truncation', async () => {
    const original = Buffer.alloc(150_000, 'xPanel-streaming-backup-payload-')
    const enc = encryptBackupStream(chunkedBytes(original, 4096), keyV1, 16 * 1024)
    const ciphertext = await collectStream(enc.stream)
    const encSummary = await enc.done

    expect(ciphertext.subarray(0, 8).toString('ascii')).toBe(ENCRYPTED_BACKUP_MAGIC)
    expect(encSummary.keyId).toBe('key-2026-v1')
    expect(encSummary.plaintextBytes).toBe(original.length)
    expect(encSummary.plaintextSha256).toBe(sha256Hex(original))

    // Valid decryption round-trip
    const dec = decryptBackupStream(chunkedBytes(ciphertext, 2048), (id) => keyring.getKey(id))
    const recovered = await collectStream(dec.stream)
    const decSummary = await dec.done
    expect(recovered.equals(original)).toBe(true)
    expect(decSummary.plaintextSha256).toBe(encSummary.plaintextSha256)

    // Wrong key material rejected with FORBIDDEN
    const wrongKeyDec = decryptBackupStream(chunkedBytes(ciphertext), () => keyV2Wrong)
    await expect(collectStream(wrongKeyDec.stream)).rejects.toThrow(/authentication failed/)

    // Unknown keyId rejected with FORBIDDEN
    const missingKeyDec = decryptBackupStream(chunkedBytes(ciphertext), () => null)
    await expect(collectStream(missingKeyDec.stream)).rejects.toThrow(/not available or unauthorized/)

    // Bit-flipped ciphertext rejected with FORBIDDEN
    const tampered = Buffer.from(ciphertext)
    tampered[tampered.length - 25] = (tampered[tampered.length - 25] ?? 0) ^ 0xff
    const tamperedDec = decryptBackupStream(chunkedBytes(tampered), (id) => keyring.getKey(id))
    await expect(collectStream(tamperedDec.stream)).rejects.toThrow(/authentication failed/)

    // Truncated stream (missing terminal EOF frame) rejected with VALIDATION
    const truncated = ciphertext.subarray(0, ciphertext.length - 20)
    const truncDec = decryptBackupStream(chunkedBytes(truncated), (id) => keyring.getKey(id))
    await expect(collectStream(truncDec.stream)).rejects.toThrow(/truncated/)
  })

  it('enforces SFTP pinned host-key verification and S3 SSRF/redirect protection', async () => {
    const clock = new FakeClockPort()
    const pinnedFp = 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='
    let presentedFp = pinnedFp

    const sftp = new SftpDestinationAdapter({
      targetId: 'sftp-vault',
      host: 'backup.example.net',
      port: 22,
      username: 'xpanelbk',
      credentialRef: 'sec-sftp-1',
      pinnedHostKeyFingerprint: pinnedFp,
      probeServerHostKey: async () => presentedFp,
      clock,
    })

    const receipt = await sftp.upload('alice/backup-1.tar.gz', chunkedBytes(Buffer.from('archive-bytes')))
    expect(receipt.verifiedReadback).toBe(true)

    // Simulate MITM / changed host key on SFTP server
    presentedFp = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    await expect(sftp.upload('alice/backup-2.tar.gz', chunkedBytes(Buffer.from('archive-bytes')))).rejects.toThrow(
      /SFTP host key mismatch/,
    )
    await expect(collectStream(sftp.download('alice/backup-1.tar.gz'))).rejects.toThrow(/SFTP host key mismatch/)

    // S3 SSRF protection: blocks metadata IP, loopback, private RFC1918, and non-HTTPS
    expect(isPrivateOrMetadataAddress('169.254.169.254')).toBe(true)
    expect(isPrivateOrMetadataAddress('127.0.0.1')).toBe(true)
    expect(isPrivateOrMetadataAddress('10.20.30.40')).toBe(true)
    expect(isPrivateOrMetadataAddress('192.168.1.10')).toBe(true)
    expect(isPrivateOrMetadataAddress('::1')).toBe(true)
    expect(() => assertSafeS3Endpoint('http://s3.example.com')).toThrow(/must use https:/)
    expect(() => assertSafeS3Endpoint('https://169.254.169.254/latest/meta-data')).toThrow(/SSRF protection/)
    expect(() => assertSafeS3Endpoint('https://127.0.0.1:9000')).toThrow(/SSRF protection/)

    // S3 redirect protection: blocks 302 redirect to metadata service
    const s3Redirecting = new S3CompatibleHttpsAdapter({
      targetId: 's3-redirect',
      endpoint: 'https://s3.example.com',
      bucket: 'xpanel-backups',
      region: 'eu-central-1',
      credentialRef: 'sec-s3-1',
      clock,
      transport: async () => ({
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/iam' },
      }),
    })
    await expect(s3Redirecting.upload('alice/b.tar.gz', chunkedBytes(Buffer.from('data')))).rejects.toThrow(
      /redirects are forbidden by SSRF policy/,
    )
  })

  it('executes full account backups, separates control-plane disaster backups, and prunes retention safely', async () => {
    const fs = new MemoryFsPort()
    const clock = new FakeClockPort()
    const audit = new MemoryAuditPort()
    const s3Adapter = new S3CompatibleHttpsAdapter({
      targetId: 's3-offsite',
      endpoint: 'https://s3.example.com',
      bucket: 'xpanel-backups',
      region: 'us-east-1',
      credentialRef: 'sec-s3-prod',
      clock,
    })

    const homeTar = await buildTestTar(
      [
        { name: './', type: 'directory' },
        { name: './public_html/', type: 'directory' },
        { name: './public_html/index.php', content: '<?php echo "hello alice";' },
      ],
      { gzip: true },
    )
    const sqlDump = Buffer.from('CREATE TABLE posts (id INT PRIMARY KEY);\nINSERT INTO posts VALUES (1);\n')

    const runner = createStreamingBackupRunner({
      host: {
        async apply(action) {
          if (action.kind === 'exec' && action.argv[0] === '/usr/bin/tar' && action.argv.includes('--create')) {
            const outFile = action.argv.find((a) => a.startsWith('--file='))!.slice('--file='.length)
            const dir = action.argv.find((a) => a.startsWith('--directory='))!.slice('--directory='.length)
            const sepIdx = action.argv.indexOf('--')
            const members = action.argv.slice(sepIdx + 1)
            const entries: TestTarEntry[] = []
            for (const m of members) {
              if (m === 'mysql') {
                entries.push({ name: 'mysql/', type: 'directory' })
                for (const k of fs.nodes.keys()) {
                  if (k.startsWith(`${dir}/mysql/`)) {
                    entries.push({ name: k.slice(dir.length + 1), content: fs.getBuffer(k) })
                  }
                }
              } else {
                entries.push({ name: m, content: fs.getBuffer(`${dir}/${m}`) })
              }
            }
            fs.putFile(outFile, await buildTestTar(entries, { gzip: true }))
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      },
      fs,
      execIo: {
        async runExecIo(step) {
          if (step.argv[0] === '/usr/bin/tar' && step.stdoutTo) {
            fs.putFile(step.stdoutTo.path, homeTar, step.stdoutTo.mode)
          } else if (step.argv[0] === '/usr/bin/mariadb-dump' && step.stdoutTo) {
            fs.putFile(step.stdoutTo.path, sqlDump, step.stdoutTo.mode)
          } else if (step.argv[0] === '/usr/bin/dd' && step.stdinFrom) {
            const out = step.argv.find((a) => a.startsWith('of='))!.slice(3)
            fs.putFile(out, fs.getBuffer(step.stdinFrom), 0o600)
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      },
      openStream: (p) => chunkedBytes(fs.getBuffer(p)),
      writeStreamExclusive: async (p, src, mode) => {
        const b = await collectStream(src)
        fs.putFile(p, b, mode)
        return { bytes: b.length, sha256: sha256Hex(b) }
      },
      remoteTargets: new Map([['s3-offsite', s3Adapter]]),
      encryptionKeyring: keyring,
      clock,
      audit,
    })

    const baseReq: BackupRequest = {
      os: { family: 'debian' },
      account: { username: 'alice', home: '/home/alice', primaryDomain: 'alice.example', domains: ['alice.example'] },
      parts: ['full'],
      destination: 'remote',
      remote: { targetId: 's3-offsite' },
      databases: ['alice_wp'],
      mail: sampleMailConfig,
      createdAt: '2026-10-22T01:00:00.000Z',
    }

    // 1. Run first verified encrypted remote backup for alice
    const first = await runner.runAccountBackup(ALICE, baseReq, { encrypt: true, retention: { maxRetained: 1 } })
    expect(first.record.verified).toBe(true)
    expect(first.record.encryptedKeyId).toBe(keyV1.keyId)
    expect(first.retention).toEqual({ kept: [first.record.id], deleted: [] })

    // 2. Run second verified backup for alice with maxRetained: 1 -> first is pruned ONLY after second is verified!
    clock.ms += 3_600_000
    const second = await runner.runAccountBackup(
      ALICE,
      { ...baseReq, createdAt: '2026-10-22T02:00:00.000Z' },
      { encrypt: true, retention: { maxRetained: 1 } },
    )
    expect(second.retention).toEqual({ kept: [second.record.id], deleted: [first.record.id] })

    // 3. Alice can download & decrypt her own backup, but Bob is denied (FORBIDDEN)
    const dl = await runner.openBackupDownloadStream(ALICE, second.record.id, { decrypt: true })
    const decryptedTarGz = await collectStream(dl.stream)
    expect(decryptedTarGz.length).toBeGreaterThan(100)
    await expect(runner.openBackupDownloadStream(BOB, second.record.id)).rejects.toThrow(/not authorized/)
    await expect(
      runner.openBackupDownloadStream(ALICE, second.record.id, { tokenScopes: ['domains:read'] }),
    ).rejects.toThrow(/missing required scope/)

    // 4. Control-plane disaster backup: tenant Alice cannot create or download it!
    const disasterInput = {
      sourceHostname: 'panel1.example.com',
      schemaVersion: 6,
      stateChecksum: sha256Hex('state-v6'),
      controlDbSnapshot: Buffer.from('sqlite-wal-consistent-snapshot-bytes'),
      secretRefs: ['secret:jwt-signing-key-v1', 'secret:totp-master-key-v1'],
      accounts: [{ username: 'alice', uid: 1001, gid: 1001, primaryDomain: 'alice.example' }],
      revokedSessionIds: ['sess-revoked-1'],
      revokedTokenIds: ['tok-revoked-1'],
      targetId: 's3-offsite',
      objectKey: 'control-plane/disaster-20261022.enc',
    }
    await expect(runner.runControlPlaneDisasterBackup(ALICE, disasterInput)).rejects.toThrow(/only root/)
    await expect(runner.runControlPlaneDisasterBackup(RESELLER, disasterInput)).rejects.toThrow(/only root/)

    const disaster = await runner.runControlPlaneDisasterBackup(ROOT, disasterInput)
    expect(disaster.record.kind).toBe('control-plane-disaster')
    expect(disaster.record.accountUsername).toBeNull()

    // Alice cannot see or download the control-plane disaster backup
    expect(runner.listBackupsForPrincipal(ALICE).map((b) => b.id)).toEqual([second.record.id])
    await expect(runner.openBackupDownloadStream(ALICE, disaster.record.id)).rejects.toThrow(
      /restricted exclusively to root/,
    )
    expect(runner.listBackupsForPrincipal(ROOT).map((b) => b.id)).toContain(disaster.record.id)
  })
})

// ---------------------------------------------------------------------------
// 2. L02 Tests (A49, A50) — ConfinedRestoreRunner, Preview/Digest, Crash Journal & Disaster Restore
// ---------------------------------------------------------------------------

describe('L02 (A49, A50): ConfinedRestoreRunner & Disaster Restore Watermarks', () => {
  const buildValidAccountBackupArchive = async (opts?: { homeIndexContent?: string; sqlContent?: string }) => {
    const idxContent = opts?.homeIndexContent ?? '<?php echo "restored v1";'
    const homeTarGz = await buildTestTar(
      [
        { name: './', type: 'directory' },
        { name: './public_html/', type: 'directory' },
        { name: './public_html/index.php', content: idxContent },
        { name: './public_html/new-from-backup.txt', content: 'from-backup' },
      ],
      { gzip: true },
    )
    const sqlBuf = Buffer.from(opts?.sqlContent ?? 'CREATE TABLE t (id INT);\nINSERT INTO t VALUES (42);\n')
    const mailBuf = Buffer.from(JSON.stringify(sampleMailConfig))

    const plan = createBackupPlan({
      os: { family: 'debian' },
      account: { username: 'alice', home: '/home/alice', primaryDomain: 'alice.example', domains: ['alice.example'] },
      parts: ['full'],
      destination: 'download',
      databases: ['alice_wp'],
      mail: sampleMailConfig,
      createdAt: '2026-10-22T01:00:00.000Z',
    })
    const mStep = plan.steps.find((s): s is ManifestStep => s.kind === 'write-manifest')!
    const stagedMap: Record<string, Buffer> = {
      [`${mStep.root}/home.tar.gz`]: homeTarGz,
      [`${mStep.root}/mysql/alice_wp.sql`]: sqlBuf,
      [`${mStep.root}/mail-config.json`]: mailBuf,
    }
    const manifest: BackupManifest = await computeManifest(mStep, (p) => chunkedBytes(stagedMap[p]!))
    const outerArchive = await buildTestTar(
      [
        { name: 'manifest.json', content: JSON.stringify(manifest) },
        { name: 'home.tar.gz', content: homeTarGz },
        { name: 'mysql/', type: 'directory' },
        { name: 'mysql/alice_wp.sql', content: sqlBuf },
        { name: 'mail-config.json', content: mailBuf },
      ],
      { gzip: true },
    )
    return {
      outerArchive,
      manifest,
      homeFiles: [
        { path: 'public_html', type: 'directory' as const, mode: 0o750, content: '', sha256: '' },
        {
          path: 'public_html/index.php',
          type: 'file' as const,
          mode: 0o640,
          content: idxContent,
          sha256: sha256Hex(idxContent),
        },
        {
          path: 'public_html/new-from-backup.txt',
          type: 'file' as const,
          mode: 0o640,
          content: 'from-backup',
          sha256: sha256Hex('from-backup'),
        },
      ],
      sqlDumps: { alice_wp: sqlBuf.toString('utf8') },
    }
  }

  const createRestoreHarness = async () => {
    const fs = new MemoryFsPort()
    const clock = new FakeClockPort()
    const audit = new MemoryAuditPort()
    const backup = await buildValidAccountBackupArchive()
    const archivePath = '/var/lib/xpanel/backups/downloads/alice/xpanel-backup-alice.tar.gz'
    fs.putFile(archivePath, backup.outerArchive, 0o600)

    // Live tenant home state managed ONLY through confined AccountFileRunner (never fs!)
    const confinedHomeFiles = new Map<string, { content: string; mode: number }>([
      ['public_html/index.php', { content: '<?php echo "live modified v2";', mode: 0o640 }],
      ['public_html/live-only-keep.txt', { content: 'never-delete-me', mode: 0o640 }],
    ])
    const fileRunnerCalls: { uid: number; gid: number; req: AccountFileRequest }[] = []
    let failOnWritePath: string | null = null

    const fileRunner: AccountFileRunner = {
      async run(ctx: Readonly<AccountFileContext>, req: Readonly<AccountFileRequest>): Promise<unknown> {
        fileRunnerCalls.push({ uid: ctx.account.uid, gid: ctx.account.gid, req })
        if (req.op === 'read') {
          const entry = confinedHomeFiles.get(req.path)
          if (!entry) return fail('NOT_FOUND', `no file ${req.path}`)
          return { path: req.path, content: entry.content, sizeBytes: Buffer.byteLength(entry.content), mtime: clock.now().toISOString() }
        }
        if (req.op === 'write') {
          if (failOnWritePath === req.path) {
            return fail('LIMIT_EXCEEDED', `EDQUOT: disk quota exceeded while writing ${req.path}`)
          }
          confinedHomeFiles.set(req.path, { content: req.content, mode: req.mode })
          return { path: req.path, sizeBytes: Buffer.byteLength(req.content), mode: req.mode, mtime: clock.now().toISOString() }
        }
        if (req.op === 'mkdir') {
          return { path: req.path, kind: 'directory', mode: req.mode }
        }
        return {}
      },
    }

    const liveDatabases = new Map<string, string>([['alice_wp', 'LIVE_OLD_SQL']])
    const tempDatabases = new Map<string, string>()
    const backupDatabases = new Map<string, string>()

    const runner = new ConfinedRestoreRunner({
      fs,
      fileRunner,
      sqlStaging: {
        async stageToTempDatabase(_u, _liveDb, tempDb, dump) {
          tempDatabases.set(tempDb, dump)
          return { tables: 1, rows: 1 }
        },
        async cutoverTempDatabase(_u, tempDb, liveDb) {
          const staged = tempDatabases.get(tempDb)
          if (!staged) return fail('NOT_FOUND', `missing temp DB ${tempDb}`)
          if (liveDatabases.has(liveDb)) backupDatabases.set(tempDb, liveDatabases.get(liveDb)!)
          liveDatabases.set(liveDb, staged)
        },
        async rollbackDatabaseCutover(_u, liveDb, tempDb) {
          const prev = backupDatabases.get(tempDb)
          if (prev !== undefined) liveDatabases.set(liveDb, prev)
        },
        async dropTempDatabase(_u, tempDb) {
          tempDatabases.delete(tempDb)
        },
      },
      openArchiveStream: (p) => chunkedBytes(fs.getBuffer(p)),
      extractArchiveContents: async () => ({
        homeFiles: backup.homeFiles,
        sqlDumps: backup.sqlDumps,
        mailConfig: sampleMailConfig,
      }),
      getAccountIdentity: async (username) => ({
        account: { username, uid: 1001, gid: 1001, home: `/home/${username}`, primaryDomain: 'alice.example' },
        domains: ['alice.example'],
        diskQuotaMb: 2048,
        currentListing: [...confinedHomeFiles.entries()].map(([path, v]) => ({
          path,
          type: 'file' as const,
          size: Buffer.byteLength(v.content),
          sha256: sha256Hex(v.content),
        })),
        currentDatabases: [...liveDatabases.keys()],
        currentMailConfig: { domains: [], mailboxes: [] },
      }),
      saveMailConfig: async () => undefined,
      reconcileAccount: async () => ({ generationId: 77 }),
      clock,
      audit,
    })

    return {
      fs,
      clock,
      runner,
      archivePath,
      confinedHomeFiles,
      fileRunnerCalls,
      liveDatabases,
      tempDatabases,
      setFailOnWritePath: (p: string | null) => {
        failOnWritePath = p
      },
    }
  }

  it('produces a deterministic preview with reviewDigest, preserves live-only files, and executes under confined UID/GID', async () => {
    const h = await createRestoreHarness()
    const { preview } = await h.runner.previewRestore({
      actor: ALICE,
      username: 'alice',
      archivePath: h.archivePath,
      parts: ['home', 'databases', 'mail-config'],
      stamp: '20261022T020000Z',
    })

    expect(preview.requiresConfirmation).toBe(true)
    expect(preview.homeDiff.changed).toEqual(['public_html/index.php'])
    expect(preview.homeDiff.added).toEqual(['public_html/new-from-backup.txt'])
    expect(preview.homeDiff.missingInArchive).toEqual(['public_html/live-only-keep.txt'])
    expect(preview.items.find((i) => i.path === 'public_html/live-only-keep.txt')?.action).toBe('skip')

    // Rejects cross-account restore or missing/wrong confirmDigest
    await expect(
      h.runner.previewRestore({
        actor: BOB,
        username: 'alice',
        archivePath: h.archivePath,
        parts: ['home'],
        stamp: '20261022T020000Z',
      }),
    ).rejects.toThrow(/not authorized/)

    await expect(
      h.runner.executeRestore({
        actor: ALICE,
        username: 'alice',
        archivePath: h.archivePath,
        parts: ['home', 'databases', 'mail-config'],
        stamp: '20261022T020000Z',
        confirmDigest: 'bad-digest',
      }),
    ).rejects.toThrow(/does not match current preview reviewDigest/)

    // Execute with valid reviewDigest
    const res = await h.runner.executeRestore({
      actor: ALICE,
      username: 'alice',
      archivePath: h.archivePath,
      parts: ['home', 'databases', 'mail-config'],
      stamp: '20261022T020000Z',
      confirmDigest: preview.reviewDigest,
    })

    expect(res.journal.phase).toBe('completed')
    expect(res.generationId).toBe(77)
    // Root fs never touched /home/alice! All file writes went through confined AccountFileRunner as uid 1001
    expect(h.fs.writes.filter((p) => p.startsWith('/home/'))).toEqual([])
    expect(h.fileRunnerCalls.every((c) => c.uid === 1001 && c.gid === 1001)).toBe(true)
    // Restored files updated, live-only file preserved!
    expect(h.confinedHomeFiles.get('public_html/index.php')?.content).toBe('<?php echo "restored v1";')
    expect(h.confinedHomeFiles.get('public_html/new-from-backup.txt')?.content).toBe('from-backup')
    expect(h.confinedHomeFiles.get('public_html/live-only-keep.txt')?.content).toBe('never-delete-me')
    // Database cut over and temporary verification target cleaned up
    expect(h.liveDatabases.get('alice_wp')).toContain('INSERT INTO t VALUES (42)')
    expect(h.tempDatabases.size).toBe(0)
  })

  it('rolls back files and SQL from the on-disk crash journal when interrupted or quota fails mid-switch', async () => {
    const h = await createRestoreHarness()
    const { preview } = await h.runner.previewRestore({
      actor: ALICE,
      username: 'alice',
      archivePath: h.archivePath,
      parts: ['home', 'databases'],
      stamp: '20261022T030000Z',
    })

    // Inject quota failure on the second file write (after SQL cutover and first file overwrite)
    h.setFailOnWritePath('public_html/new-from-backup.txt')

    await expect(
      h.runner.executeRestore({
        actor: ALICE,
        username: 'alice',
        archivePath: h.archivePath,
        parts: ['home', 'databases'],
        stamp: '20261022T030000Z',
        confirmDigest: preview.reviewDigest,
      }),
    ).rejects.toThrow(/EDQUOT/)

    // Verify rollback restored both the overwritten index.php AND the live database!
    const journal = await h.runner.readJournal(preview.restoreId)
    expect(journal?.phase).toBe('rolled-back')
    expect(h.confinedHomeFiles.get('public_html/index.php')?.content).toBe('<?php echo "live modified v2";')
    expect(h.liveDatabases.get('alice_wp')).toBe('LIVE_OLD_SQL')
    expect(h.tempDatabases.size).toBe(0)

    // Also test process kill at 'switched-sql' and recovery via recoverInterruptedRestore
    h.setFailOnWritePath(null)
    const { preview: p2 } = await h.runner.previewRestore({
      actor: ALICE,
      username: 'alice',
      archivePath: h.archivePath,
      parts: ['home', 'databases'],
      stamp: '20261022T031000Z',
    })
    h.runner.onPhaseEntered = (phase) => {
      if (phase === 'switched-sql') throw new Error('SIGKILL simulated after SQL switch')
    }
    await expect(
      h.runner.executeRestore({
        actor: ALICE,
        username: 'alice',
        archivePath: h.archivePath,
        parts: ['home', 'databases'],
        stamp: '20261022T031000Z',
        confirmDigest: p2.reviewDigest,
      }),
    ).rejects.toThrow(/SIGKILL/)
    h.runner.onPhaseEntered = null
    const recovered = await h.runner.recoverInterruptedRestore(p2.restoreId)
    expect(recovered.phase).toBe('rolled-back')
    expect(h.liveDatabases.get('alice_wp')).toBe('LIVE_OLD_SQL')
  })

  it('rejects hostile SQL statements and preserves revoked session/token watermarks during disaster restore', async () => {
    expect(() => assertSafeRestoreSql('alice_wp', 'SELECT 1;\nSYSTEM id;\n')).toThrow(/forbidden/)
    expect(() => assertSafeRestoreSql('alice_wp', "SELECT * INTO OUTFILE '/tmp/x' FROM t;")).toThrow(/forbidden/)

    // Build an encrypted control-plane disaster backup and run executeDisasterRestore
    const fs = new MemoryFsPort()
    const clock = new FakeClockPort()
    const keyMat: EncryptionKeyMaterial = {
      keyId: 'dr-key-1',
      key: Buffer.from('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', 'hex'),
    }
    const keyring: EncryptionKeyring = {
      activeKeyId: 'dr-key-1',
      getKey: (id) => (id === 'dr-key-1' ? keyMat : null),
    }
    const s3 = new S3CompatibleHttpsAdapter({
      targetId: 's3-dr',
      endpoint: 'https://s3.example.com',
      bucket: 'xpanel-dr',
      region: 'us-east-1',
      credentialRef: 'sec-dr',
      clock,
    })
    const bkRunner = createStreamingBackupRunner({
      host: { async apply() { return { code: 0, stdout: '', stderr: '' } } },
      fs,
      execIo: { async runExecIo() { return { code: 0, stdout: '', stderr: '' } } },
      openStream: (p) => chunkedBytes(fs.getBuffer(p)),
      writeStreamExclusive: async () => ({ bytes: 0, sha256: '' }),
      remoteTargets: new Map([['s3-dr', s3]]),
      encryptionKeyring: keyring,
      clock,
    })

    const dr = await bkRunner.runControlPlaneDisasterBackup(ROOT, {
      sourceHostname: 'node1.example.com',
      schemaVersion: 6,
      stateChecksum: sha256Hex('state'),
      controlDbSnapshot: Buffer.from('control-db-bytes'),
      secretRefs: ['secret:k1'],
      accounts: [{ username: 'alice', uid: 1001, gid: 1001, primaryDomain: 'alice.example' }],
      revokedSessionIds: ['sess-revoked-in-manifest'],
      revokedTokenIds: ['tok-revoked-in-manifest'],
      targetId: 's3-dr',
      objectKey: 'dr/snapshot.enc',
    })
    expect(dr.manifest.revokedSessionIds).toEqual(['sess-revoked-in-manifest'])

    // UID collision on target host is rejected with CONFLICT
    await expect(
      executeDisasterRestore({
        actor: ROOT,
        encryptedSource: s3.download('dr/snapshot.enc'),
        keyring,
        localHostUsedUids: [1001],
        localRevokedSessionIds: [],
        localRevokedTokenIds: [],
        snapshotCredentials: { sessions: [], apiTokens: [], principalRevocationWatermarks: {} },
        now: clock.now(),
      }),
    ).rejects.toThrow(/UID collision/)

    // Valid disaster restore preserves revoked sessions/tokens and watermark-invalidated credentials
    const restored = await executeDisasterRestore({
      actor: ROOT,
      encryptedSource: s3.download('dr/snapshot.enc'),
      keyring,
      localHostUsedUids: [1002],
      localRevokedSessionIds: ['sess-revoked-locally'],
      localRevokedTokenIds: ['tok-revoked-locally'],
      snapshotCredentials: {
        sessions: [
          { id: 'sess-active-after-watermark', principalId: 'p-alice', createdAt: '2026-10-22T01:30:00.000Z', revokedAt: null },
          { id: 'sess-before-watermark', principalId: 'p-alice', createdAt: '2026-10-22T00:30:00.000Z', revokedAt: null },
          { id: 'sess-revoked-in-manifest', principalId: 'p-alice', createdAt: '2026-10-22T01:31:00.000Z', revokedAt: null },
          { id: 'sess-revoked-locally', principalId: 'p-alice', createdAt: '2026-10-22T01:32:00.000Z', revokedAt: null },
        ],
        apiTokens: [
          { id: 'tok-active', principalId: 'p-alice', createdAt: '2026-10-22T01:30:00.000Z', revokedAt: null },
          { id: 'tok-before-watermark', principalId: 'p-alice', createdAt: '2026-10-22T00:15:00.000Z', revokedAt: null },
          { id: 'tok-revoked-in-manifest', principalId: 'p-alice', createdAt: '2026-10-22T01:31:00.000Z', revokedAt: null },
        ],
        principalRevocationWatermarks: {
          'p-alice': '2026-10-22T01:00:00.000Z',
        },
      },
      now: clock.now(),
    })

    expect(restored.activeSessionIds).toEqual(['sess-active-after-watermark'])
    expect(restored.revokedSessionIds).toEqual([
      'sess-before-watermark',
      'sess-revoked-in-manifest',
      'sess-revoked-locally',
    ])
    expect(restored.activeTokenIds).toEqual(['tok-active'])
    expect(restored.revokedTokenIds).toEqual([
      'tok-before-watermark',
      'tok-revoked-in-manifest',
      'tok-revoked-locally',
    ])
  })
})

// ---------------------------------------------------------------------------
// 3. L03 Tests (A51) — Untrusted cPanel Archive Import Runner
// ---------------------------------------------------------------------------

describe('L03 (A51): CpanelImportRunner', () => {
  const buildCpmoveEntries = (top = 'cpmove-bob', extraSql = ''): TestTarEntry[] => [
    { name: `${top}/`, type: 'directory' },
    { name: `${top}/cp/bob`, content: 'USER=bob\nPLAN=gold\nDNS=bob.example\nCONTACTEMAIL=bob@gmail.com\nIP=203.0.113.10\nMAXSQL=3\n' },
    { name: `${top}/quota`, content: '2048\n' },
    { name: `${top}/shadow`, content: '$6$rounds=5000$SECRET_SHADOW_HASH$xyz\n' },
    {
      name: `${top}/userdata/main`,
      content: '---\naddon_domains:\n  shop.example: shop.bob.example\nmain_domain: bob.example\nparked_domains: []\nsub_domains:\n  - shop.bob.example\n',
    },
    {
      name: `${top}/userdata/bob.example`,
      content: '---\ndocumentroot: /home/bob/public_html\nhomedir: /home/bob\nserveralias: www.bob.example\nservername: bob.example\nphpversion: ea-php82\n',
    },
    {
      name: `${top}/userdata/shop.bob.example`,
      content: '---\ndocumentroot: /home/bob/shop.example\nhomedir: /home/bob\nserveralias: shop.example\nservername: shop.bob.example\nphpversion: ea-php81\n',
    },
    {
      name: `${top}/dnszones/bob.example.db`,
      content: '$TTL 14400\nbob.example.\t86400\tIN\tSOA\tns1.old.example.\troot.old.example.\t( 2026101501 3600 7200 1209600 86400 )\nbob.example.\t14400\tIN\tA\t203.0.113.10\nwww\t14400\tIN\tCNAME\tbob.example.\n',
    },
    { name: `${top}/mysql/`, type: 'directory' },
    { name: `${top}/mysql/bob_wp.sql`, content: `CREATE TABLE wp_posts (id INT);\nINSERT INTO wp_posts VALUES (1);\n${extraSql}` },
    {
      name: `${top}/mysql.sql`,
      content:
        "GRANT ALL PRIVILEGES ON `bob\\_wp`.* TO 'bob_wpuser'@'localhost' IDENTIFIED BY PASSWORD '*HASH';\nGRANT SELECT, SUPER ON `bob\\_wp`.* TO 'bob_mixed'@'localhost' WITH GRANT OPTION;\n",
    },
    { name: `${top}/va/bob.example`, content: 'info@bob.example: bob@gmail.com\nsales@bob.example: "|/home/bob/evil.sh"\n*: :fail: No user\n' },
    { name: `${top}/cron/bob`, content: '* * * * * /home/bob/job.sh\n' },
    { name: `${top}/homedir/`, type: 'directory' },
    { name: `${top}/homedir/public_html/`, type: 'directory' },
    { name: `${top}/homedir/public_html/index.php`, content: '<?php echo "bob site";' },
    { name: `${top}/homedir/.my.cnf`, content: '[client]\npassword="OLD_MYSQL_PASS"\n' },
    { name: `${top}/homedir/etc/bob.example/passwd`, content: 'info:x:500:500::/home/bob/mail/bob.example/info:/home/bob\n' },
    { name: `${top}/homedir/etc/bob.example/shadow`, content: 'info:$6$MAIL_SHADOW$hash:::::::\n' },
    { name: `${top}/homedir/etc/bob.example/quota`, content: 'info:104857600\n' },
    { name: `${top}/homedir/mail/bob.example/info/cur/1700000000.M1:2,S`, content: 'Subject: welcome\n\nBody' },
    { name: `${top}/homedir/escape_link`, type: 'symlink', linkname: '../../../../etc/shadow' },
    { name: `${top}/homedir/hardlink_to_excluded`, type: 'link', linkname: `${top}/homedir/.my.cnf` },
  ]

  it('imports a cpmove archive with a fresh allocated UID, blocks excluded hardlinks & SUPER grants, and enforces passwordResetRequired', async () => {
    const clock = new FakeClockPort()
    const audit = new MemoryAuditPort()
    const provisioned: { uid: number; username: string }[] = []
    const rolledBack: string[] = []

    const runner = new CpanelImportRunner({
      applyPort: {
        async getLocalInventory() {
          // Existing account 'alice' has UID 1000 and 500 (the archive's passwd UID); allocator must pick fresh 1001!
          return {
            usernames: ['alice'],
            domains: ['alice.example'],
            uids: [1000],
            plans: ['default', 'gold'],
          }
        },
        async provisionImportedAccount(input) {
          provisioned.push({ uid: input.uid, username: input.plan.account.username })
          return { accountId: 'acc-bob', generationId: 88 }
        },
        async rollbackProvisionedAccount(_id, username) {
          rolledBack.push(username)
        },
      },
      clock,
      audit,
    })

    const archiveBuf = await buildTestTar(buildCpmoveEntries(), { gzip: true })
    const report = await runner.importArchive({
      actor: ROOT,
      importId: 'imp-bob-1',
      archiveDisplayName: 'cpmove-bob.tar.gz',
      source: chunkedBytes(archiveBuf, 256),
      expectedArchiveSha256: sha256Hex(archiveBuf),
      ipv4: '198.51.100.25',
    })

    expect(report.cutoverReady).toBe(true)
    // Fresh UID 1001 allocated (never 500 from archive!)
    expect(report.allocatedIdentity).toEqual({
      username: 'bob',
      uid: 1001,
      gid: 1001,
      slice: 'xpanel-1001.slice',
      home: '/home/bob',
      passwordResetRequired: true,
    })
    expect(report.imported.account.passwordResetRequired).toBe(true)
    expect(report.imported.dbUsers.every((u) => u.passwordResetRequired === true)).toBe(true)
    expect(report.imported.mailboxes.every((m) => m.passwordResetRequired === true)).toBe(true)
    // SUPER and WITH GRANT OPTION were dropped from bob_mixed
    const mixedUser = report.imported.dbUsers.find((u) => u.name === 'bob_mixed')
    expect(mixedUser?.grants).toEqual([{ database: 'bob_wp', privileges: ['SELECT'] }])
    // A record moved from 203.0.113.10 to 198.51.100.25
    expect(report.imported.dnsZones[0]?.records.find((r) => r.type === 'A')?.content).toBe('198.51.100.25')
    // Excluded hardlink (.my.cnf) and escaping symlink were skipped and reported
    expect(report.skipped.items.map((w) => w.code)).toEqual(
      expect.arrayContaining(['symlink-escape', 'hardlink-skipped', 'credentials-file-skipped', 'forwarder-unsafe']),
    )
    expect(report.unsupported.map((w) => w.code)).toContain('cron-not-imported')
    // No raw shadow/mysql passwords leaked anywhere in report
    expect(JSON.stringify(report)).not.toContain('SECRET_SHADOW_HASH')
    expect(JSON.stringify(report)).not.toContain('OLD_MYSQL_PASS')
    expect(JSON.stringify(report)).not.toContain('MAIL_SHADOW')
  })

  it('rejects hostile SQL dumps (GRANT SUPER / INTO OUTFILE), deadline/size overruns, and rolls back cleanly on apply failure', async () => {
    const clock = new FakeClockPort()
    const rolledBack: string[] = []
    let failProvision = false

    const runner = new CpanelImportRunner({
      applyPort: {
        async getLocalInventory() {
          return { usernames: ['alice'], domains: ['alice.example'], uids: [1000], plans: ['default'] }
        },
        async provisionImportedAccount(input) {
          if (failProvision) fail('CONFIG_TEST_FAILED', 'simulated nginx config test failure during import apply')
          return { accountId: `acc-${input.plan.account.username}`, generationId: 89 }
        },
        async rollbackProvisionedAccount(_id, username) {
          rolledBack.push(username)
        },
      },
      clock,
    })

    // 1. Hostile SQL statement inside mysql/bob_wp.sql dump is rejected before provisioning
    const evilSqlTar = await buildTestTar(
      buildCpmoveEntries('cpmove-bob', "GRANT SUPER ON *.* TO 'evil'@'localhost';\n"),
      { gzip: true },
    )
    await expect(
      runner.importArchive({
        actor: ROOT,
        importId: 'imp-evil-sql',
        archiveDisplayName: 'cpmove-bob.tar.gz',
        source: chunkedBytes(evilSqlTar),
      }),
    ).rejects.toThrow(/unauthorized GRANT\/SUPER/)

    // 2. Conflicting target username ('alice') is rejected before provisioning
    const validTar = await buildTestTar(buildCpmoveEntries(), { gzip: true })
    await expect(
      runner.importArchive({
        actor: ROOT,
        importId: 'imp-conflict',
        archiveDisplayName: 'cpmove-bob.tar.gz',
        source: chunkedBytes(validTar),
        targetUsername: 'alice',
      }),
    ).rejects.toThrow(/already exists/)

    // 3. Provisioning failure triggers rollback without affecting existing accounts
    failProvision = true
    await expect(
      runner.importArchive({
        actor: ROOT,
        importId: 'imp-rollback',
        archiveDisplayName: 'cpmove-bob.tar.gz',
        source: chunkedBytes(validTar),
      }),
    ).rejects.toThrow(/simulated nginx config test failure/)
    expect(rolledBack).toEqual(['bob'])
  })
})

// ---------------------------------------------------------------------------
// 4. L04 Tests (A52) — DurableTransferRunner (Leases, Checkpoints, Resumption & Safe Rollback)
// ---------------------------------------------------------------------------

describe('L04 (A52): DurableTransferRunner', () => {
  const buildExportedAccountArchive = async () => {
    const manifest: AccountArchiveManifest = {
      format: 'xpanel-account',
      version: 1,
      createdAt: '2026-10-22T01:00:00.000Z',
      source: { hostname: 'src1.example.com', panelVersion: '1.0.0' },
      account: {
        username: 'carol',
        primaryDomain: 'carol.example',
        plan: 'gold',
        ipv4: '203.0.113.50',
        shell: 'none',
        contactEmail: 'recipient-3@example.net',
      },
      domains: [
        {
          name: 'carol.example',
          kind: 'primary',
          parent: null,
          docRoot: 'public_html',
          siteType: 'php',
          upstream: null,
          phpVersion: '8.3',
          wildcard: false,
        },
      ],
      databases: ['carol_app'],
      dbUsers: [
        {
          name: 'carol_appuser',
          hosts: ['localhost'],
          grants: [{ database: 'carol_app', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] }],
        },
      ],
      zones: ['carol.example'],
      mailboxes: [{ address: 'hello@carol.example', quotaMb: 500 }],
      mail: {
        domains: [{ domain: 'carol.example', forwarders: [], defaultAddress: { kind: 'reject' } }],
        mailboxes: [],
      },
    }

    const exp = exportAccountArchive({
      manifest,
      zones: {
        'carol.example': [{ zone: 'carol.example', name: '@', type: 'A', ttl: 3600, content: '203.0.113.50' }],
      },
      dumps: {
        carol_app: Buffer.from('CREATE TABLE orders (id INT PRIMARY KEY);\nINSERT INTO orders VALUES (101);\n'),
      },
      home: [
        { path: 'public_html', type: 'directory', mode: 0o750 },
        { path: 'public_html/index.php', type: 'file', mode: 0o640, content: Buffer.from('<?php echo "carol";') },
      ],
      mail: [
        {
          path: 'carol.example/hello/cur/1700000099.M1:2,S',
          type: 'file',
          mode: 0o600,
          content: Buffer.from('Subject: Order 101\n\nConfirmed'),
        },
      ],
    })
    const chunks: Buffer[] = []
    for await (const c of exp.stream) chunks.push(Buffer.from(c as Uint8Array))
    const summary = await exp.done
    const archiveBuf = Buffer.concat(chunks)
    return { archiveBuf, sha256: sha256Hex(archiveBuf), summary }
  }

  const createTransferWorld = async () => {
    const fs = new MemoryFsPort()
    const clock = new FakeClockPort()
    const audit = new MemoryAuditPort()
    const exported = await buildExportedAccountArchive()
    const osProfile = profileFor(parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n'))

    const pinnedFp = 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='
    let liveSourceFp = pinnedFp
    let sourceOwnsCarol = true

    // Destination state tracking to prove zero duplicate rows/messages across crash + resume
    const destinationAccounts = new Map<string, { uid: number; domains: string[] }>()
    const destinationDbRows = new Map<string, Set<string>>()
    const destinationMailMessages = new Map<string, Set<string>>()
    const reloadEvents: string[][] = []
    const cutoverSwitched: string[] = []
    const cutoverReverted: string[] = []

    const makeRunner = () =>
      new DurableTransferRunner({
        fs,
        os: osProfile,
        engine: 'apache',
        installedServices: ['nginx', 'apache', 'postfix', 'dovecot', 'powerdns', 'mariadb'],
        defaultPhp: {
          version: '8.3',
          memoryLimitMb: 256,
          maxExecutionTimeSec: 60,
          uploadMaxFilesizeMb: 64,
          postMaxSizeMb: 64,
          maxInputVars: 3000,
          displayErrors: false,
          shortOpenTag: false,
           functionsDisabled: [],
        } as unknown as Parameters<typeof importAccountArchive>[1]['defaultPhp'],
        serverIpv4: '198.51.100.88',
        clock,
        audit,
        sourceNode: {
          async probeSourceFingerprint() {
            return liveSourceFp
          },
          async verifySourceOwnership(_s, accounts) {
            return accounts.includes('carol') ? sourceOwnsCarol : true
          },
          async fetchInventory() {
            return {
              source: { hostname: 'src1.example.com', version: '1.0.0' },
              accounts: [
                {
                  username: 'carol',
                  uid: 1001,
                  primaryDomain: 'carol.example',
                  domains: ['carol.example'],
                  plan: 'gold',
                  diskBytes: exported.archiveBuf.length,
                  databases: ['carol_app'],
                  mailboxes: 1,
                  phpVersions: ['8.3'],
                },
              ],
              plans: [{ name: 'gold' }],
            }
          },
          async exportAndStreamAccount() {
            return {
              stream: chunkedBytes(exported.archiveBuf, 256),
              expectedSha256: exported.sha256,
              partChecksums: exported.summary.checksums,
            }
          },
        },
        destination: {
          async getLiveLocalInventory() {
            return {
              usernames: ['alice', ...destinationAccounts.keys()],
              domains: ['alice.example', ...[...destinationAccounts.values()].flatMap((a) => a.domains)],
              uids: [1001, ...[...destinationAccounts.values()].map((a) => a.uid)],
              plans: ['default'],
            }
          },
          async ensurePlan(_src, target) {
            return `plan-${target}`
          },
          async applyImportedAccountIdempotent({ imported, stagedItems }) {
            destinationAccounts.set(imported.account.username, {
              uid: imported.account.uid,
              domains: imported.domains.map((d) => d.name),
            })
            for (const item of stagedItems) {
              if (item.item.part === 'sql') {
                const set = destinationDbRows.get(item.item.path) ?? new Set<string>()
                set.add(item.sha256)
                destinationDbRows.set(item.item.path, set)
              } else if (item.item.part === 'mail' && item.item.type === 'file') {
                const set = destinationMailMessages.get(imported.account.username) ?? new Set<string>()
                set.add(`${item.item.path}:${item.sha256}`)
                destinationMailMessages.set(imported.account.username, set)
              }
            }
            return {
              accountId: imported.account.id,
              dbRowsApplied: destinationDbRows.get('carol_app.sql')?.size ?? 0,
              mailMessagesApplied: destinationMailMessages.get(imported.account.username)?.size ?? 0,
            }
          },
          async reconcileReloadOnly(_reason, units) {
            reloadEvents.push([...units])
            return { generationId: 105 }
          },
          async switchCutover(_sid, src, target) {
            cutoverSwitched.push(`${src}->${target}`)
          },
          async revertCutover(_sid, src, target) {
            cutoverReverted.push(`${src}->${target}`)
          },
        },
      })

    return {
      fs,
      clock,
      pinnedFp,
      makeRunner,
      setLiveSourceFp: (fp: string) => {
        liveSourceFp = fp
      },
      setSourceOwnsCarol: (owns: boolean) => {
        sourceOwnsCarol = owns
      },
      destinationAccounts,
      destinationDbRows,
      destinationMailMessages,
      reloadEvents,
      cutoverSwitched,
      cutoverReverted,
    }
  }

  it('persists sessions, leases with fencing tokens, and stage checkpoints on disk; survives mid-transfer kill & resumes without duplicates; blocks unsafe post-write rollback', async () => {
    const w = await createTransferWorld()
    const runner1 = w.makeRunner()

    // Rejects raw secret in auth object
    await expect(
      runner1.createSession({
        id: 'tx-bad',
        actor: ROOT,
        auth: { kind: 'ssh-key', host: 'src1.example.com', port: 22, user: 'root', password: 'secret', keyId: 'k1', hostKeyFingerprint: w.pinnedFp },
      }),
    ).rejects.toThrow(/looks like a secret/)

    const created = await runner1.createSession({
      id: 'tx-session-1',
      actor: ROOT,
      idempotencyKey: 'idem-tx-1',
      auth: {
        kind: 'ssh-key',
        host: 'src1.example.com',
        port: 22,
        user: 'root',
        keyId: 'ssh-key-ref-1',
        hostKeyFingerprint: w.pinnedFp,
      },
    })
    expect(created.session.state).toBe('created')

    // Idempotent replay returns the same persisted session
    const dedup = await runner1.createSession({
      id: 'tx-session-1',
      actor: ROOT,
      idempotencyKey: 'idem-tx-1',
      auth: created.session.auth,
    })
    expect(dedup.session.id).toBe('tx-session-1')

    await runner1.connectAndInventory('tx-session-1')
    const { digest } = await runner1.selectAndReview('tx-session-1', {
      accounts: ['carol'],
      plans: ['gold'],
    })
    await runner1.confirmSession('tx-session-1', digest)

    // Worker 1 acquires lease (fencingToken = 1)
    const lease1 = await runner1.acquireLease('tx-session-1', 'worker-1', 10_000)
    expect(lease1.fencingToken).toBe(1)

    // Active transfer blocks concurrent lease acquisition by worker-2
    await expect(runner1.acquireLease('tx-session-1', 'worker-2', 10_000)).rejects.toThrow(/already has an active lease/)

    // Simulate process disconnect/kill right after 'import' stage checkpoint!
    const seenStages: TransferCheckpointStage[] = []
    runner1.onStageCheckpointed = (_sid, _acct, stage) => {
      seenStages.push(stage)
      if (stage === 'import') {
        throw new Error('simulated worker-1 crash right after import checkpoint')
      }
    }

    await expect(
      runner1.executeOrResumeTransfer({
        sessionId: 'tx-session-1',
        workerId: 'worker-1',
        fencingToken: lease1.fencingToken,
      }),
    ).rejects.toThrow(/simulated worker-1 crash/)
    expect(seenStages).toEqual(['export', 'copy', 'inspect', 'import'])

    // Advance clock past worker-1 lease expiry (15s > 10s) and instantiate a BRAND NEW runner2 (simulating daemon restart)
    w.clock.ms += 15_000
    const runner2 = w.makeRunner()
    const loadedAfterCrash = await runner2.loadRecord('tx-session-1')
    expect(loadedAfterCrash?.accountCheckpoints['carol']?.completedStages).toEqual(['export', 'copy', 'inspect', 'import'])

    // Worker-2 steals expired lease -> fencingToken increments to 2
    const lease2 = await runner2.acquireLease('tx-session-1', 'worker-2', 30_000)
    expect(lease2.fencingToken).toBe(2)

    // Stale worker-1 with fencingToken=1 is fenced off and rejected with CONFLICT!
    await expect(
      runner1.executeOrResumeTransfer({
        sessionId: 'tx-session-1',
        workerId: 'worker-1',
        fencingToken: lease1.fencingToken,
      }),
    ).rejects.toThrow(/stale fencing token/)

    // If source host key changes mid-transfer before resume completes, worker-2 aborts with FORBIDDEN
    w.setLiveSourceFp('SHA256:0000000000000000000000000000000000000000000=')
    await expect(
      runner2.executeOrResumeTransfer({
        sessionId: 'tx-session-1',
        workerId: 'worker-2',
        fencingToken: lease2.fencingToken,
      }),
    ).rejects.toThrow(/source SSH host key mismatch/)
    w.setLiveSourceFp(w.pinnedFp)

    // Worker-2 resumes and completes remaining stages (reconcile -> cutover)
    const completed = await runner2.executeOrResumeTransfer({
      sessionId: 'tx-session-1',
      workerId: 'worker-2',
      fencingToken: lease2.fencingToken,
    })

    expect(completed.session.state).toBe('completed')
    expect(completed.accountCheckpoints['carol']?.completedStages).toEqual([
      'export',
      'copy',
      'inspect',
      'import',
      'reconcile',
      'cutover',
    ])
    // Allocated fresh UID 1000 (since 1001 was used by alice on destination)
    expect(w.destinationAccounts.get('carol')?.uid).toBe(1000)
    // Zero duplicate DB dumps or mail messages!
    expect(w.destinationDbRows.get('carol_app.sql')?.size).toBe(1)
    expect(w.destinationMailMessages.get('carol')?.size).toBe(1)
    expect(w.cutoverSwitched).toEqual(['carol->carol'])
    expect(w.reloadEvents.length).toBe(1)

    // Record a post-cutover write on destination for carol
    await runner2.recordDestinationWrite('tx-session-1', 'carol', {
      kind: 'db',
      detail: 'INSERT INTO orders VALUES (102) after cutover',
    })

    // Unsafe rollback without reverse-sync / loss confirmation is blocked with CONFLICT!
    await expect(runner2.rollbackAccountCutover('tx-session-1', 'carol')).rejects.toThrow(/unsafe rollback blocked/)
    expect(w.cutoverReverted).toEqual([])

    // Explicit operator force-loss / reverse-sync confirmation allows rollback
    const rb = await runner2.rollbackAccountCutover('tx-session-1', 'carol', { allowReverseSyncOrForceLoss: true })
    expect(rb.accountCheckpoints['carol']?.rolledBackAt).not.toBeNull()
    expect(w.cutoverReverted).toEqual(['carol->carol'])
  })
})

// ---------------------------------------------------------------------------
// 5. L05 Tests (A53) — PanelUpgradeRunner with Health Probe, Automatic Rollback & Second Attempt
// ---------------------------------------------------------------------------

describe('L05 (A53): PanelUpgradeRunner & ProductionUpgradePorts', () => {
  const ARCHIVE_110 = '/opt/xpanel/downloads/xpanel-1.1.0.tar.gz'
  const ARCHIVE_110_BYTES = 'release-1.1.0-tarball-payload'
  const ARCHIVE_110_SHA = sha256Hex(ARCHIVE_110_BYTES)
  const HMAC_SECRET = Buffer.from('super-trusted-release-signing-key-2026', 'utf8')

  const edKeyPair = generateKeyPairSync('ed25519')
  const edPublicPem = edKeyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string

  const trustedKeys: ReleaseVerificationKey[] = [
    { keyId: 'rel-hmac-2026', kind: 'hmac-sha256', publicKeyOrSecret: HMAC_SECRET },
    { keyId: 'rel-ed25519-2026', kind: 'ed25519-pem', publicKeyOrSecret: edPublicPem },
  ]

  const createUpgradeTestHarness = async () => {
    const testDb = await createTestDb({ migrate: true })
    const initialSchema = testDb.migration.version
    const targetSchema = initialSchema + 1

    const fs = new MemoryFsPort({
      '/opt/xpanel/releases/1.0.0': { type: 'dir', mode: 0o755 },
      '/opt/xpanel/releases/1.0.0/VERSION': { type: 'file', content: '1.0.0\n', mode: 0o644 },
      '/opt/xpanel/current': { type: 'symlink', target: '/opt/xpanel/releases/1.0.0' },
      '/opt/xpanel/staging': { type: 'dir', mode: 0o755 },
      '/opt/xpanel/downloads': { type: 'dir', mode: 0o700 },
      [ARCHIVE_110]: {
        type: 'file',
        content: ARCHIVE_110_BYTES,
        raw: Buffer.from(ARCHIVE_110_BYTES, 'utf8'),
        mode: 0o600,
      },
      '/var/lib/xpanel': { type: 'dir', mode: 0o755 },
      '/var/lib/xpanel/state': { type: 'dir', mode: 0o700 },
      '/var/lib/xpanel/state/desired.json': { type: 'file', content: '{"rev":1}', mode: 0o600 },
      '/home/alice/public_html/index.php': { type: 'file', content: '<?php echo "alice live";', mode: 0o640 },
    })

    const clock = new FakeClockPort()
    let currentGen = 41
    const activatedGenerations: number[] = []
    let desiredStateContent = '{"rev":1}'
    const snapshots = new Map<string, { desiredState: string }>()
    let panelLoginOk = true
    let canaryHttp: { httpStatus: number; servedByUid: number | null; cgroupSlice: string | null; serviceActive: boolean } = {
      httpStatus: 200,
      servedByUid: 1001,
      cgroupSlice: 'xpanel-1001.slice',
      serviceActive: true,
    }
    let upgradeUnitRunning = false
    let crashOnSwitch = false

    const baseMigrations = await loadMigrations()
    const newMigration = parseMigration(
      `${String(targetSchema).padStart(4, '0')}_upgrade_canary_note.sql`,
      `CREATE TABLE IF NOT EXISTS upgrade_canary_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL) STRICT;`,
    )

    const host: HostPort = {
      async apply(action: HostAction): Promise<ExecResult> {
        if (action.kind === 'ensure-dir') {
          await fs.mkdirp(action.path, action.mode)
          return { code: 0, stdout: '', stderr: '' }
        }
        if (action.kind === 'exec') {
          const [bin] = action.argv
          if (bin === '/usr/bin/tar' && action.argv.includes('--create') && action.argv.includes('state')) {
            const file = action.argv.find((a) => a.startsWith('--file='))!.slice('--file='.length)
            fs.putFile(file, 'state-snapshot-bytes', 0o600)
          } else if (bin === '/usr/bin/tar' && action.argv.includes('--extract') && action.argv.includes('--directory=/var/lib/xpanel')) {
            const file = action.argv.find((a) => a.startsWith('--file='))!.slice('--file='.length)
            if (!(await fs.exists(file))) return { code: 1, stdout: '', stderr: 'missing snapshot' }
          } else if (bin === '/usr/bin/tar' && action.argv.includes('--extract')) {
            const dir = action.argv.find((a) => a.startsWith('--directory='))!.slice('--directory='.length)
            fs.putFile(`${dir}/VERSION`, '1.1.0\n', 0o644)
          } else if (bin === '/usr/bin/systemctl' && action.argv[1] === 'is-active') {
            return { code: upgradeUnitRunning ? 0 : 3, stdout: '', stderr: '' }
          }
        }
        if (action.kind === 'systemd' && action.verb === 'restart' && crashOnSwitch) {
          throw new Error('simulated power loss during panel unit restart')
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    const runner = new PanelUpgradeRunner({
      db: testDb.db,
      fs,
      host,
      clock,
      trustedReleaseKeys: trustedKeys,
      reconciler: {
        async currentGeneration() {
          return currentGen
        },
        async reconcile() {
          currentGen += 1
          desiredStateContent = `{"rev":${currentGen}}`
          return {
            generationId: currentGen,
            units: [
              { unit: 'nginx.service', needs: 'reload' },
              { unit: 'apache2.service', needs: 'reload' },
            ] satisfies UnitChange[],
          }
        },
        async activate(genId) {
          currentGen = genId
          activatedGenerations.push(genId)
          return {
            units: [
              { unit: 'nginx.service', needs: 'reload' },
              { unit: 'apache2.service', needs: 'reload' },
            ],
          }
        },
        async status() {
          return { converged: true, drift: [] }
        },
        async identities(): Promise<AccountIdentity[]> {
          return [
            {
              username: 'alice',
              uid: 1001,
              gid: 1001,
              slice: 'xpanel-1001.slice',
              quotas: { diskMb: 2048 },
            },
          ]
        },
      },
      loadReleaseMigrations: async () => [...baseMigrations, newMigration],
      probeFreeBytes: async () => 50_000_000,
      probeOsRelease: async () => parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n'),
      probeActiveTransfers: async () => 0,
      probePanelLogin: async () => panelLoginOk,
      probeCanaryHttp: async () => canaryHttp,
      snapshotControlPlaneDb: async (snapPath) => {
        snapshots.set(snapPath, { desiredState: desiredStateContent })
      },
      restoreControlPlaneDb: async (snapPath) => {
        const snap = snapshots.get(snapPath)
        if (snap) desiredStateContent = snap.desiredState
      },
    })

    const basePlan = {
      actor: ROOT,
      os: { family: 'debian' as const },
      release: {
        version: '1.1.0',
        schemaVersion: targetSchema,
        archivePath: ARCHIVE_110,
        sha256: ARCHIVE_110_SHA,
        bytes: 1_000_000,
      },
      canary: 'alice',
      health: { attempts: 2, intervalMs: 100 },
    }

    const signedManifest = signReleaseManifestHmac(
      {
        version: '1.1.0',
        schemaVersion: targetSchema,
        sha256: ARCHIVE_110_SHA,
        bytes: 1_000_000,
      },
      'rel-hmac-2026',
      HMAC_SECRET,
    )

    return {
      testDb,
      fs,
      clock,
      runner,
      basePlan,
      signedManifest,
      getCurrentGen: () => currentGen,
      getDesiredStateContent: () => desiredStateContent,
      activatedGenerations,
      setPanelLoginOk: (ok: boolean) => {
        panelLoginOk = ok
      },
      setCanaryHttp: (c: typeof canaryHttp) => {
        canaryHttp = c
      },
      setCrashOnSwitch: (v: boolean) => {
        crashOnSwitch = v
      },
    }
  }

  it('verifies Ed25519 and HMAC release signatures and rejects tampered or untrusted release manifests', () => {
    const base = { version: '1.1.0', schemaVersion: 5, sha256: ARCHIVE_110_SHA, bytes: 1_000_000 }
    const hmacSigned = signReleaseManifestHmac(base, 'rel-hmac-2026', HMAC_SECRET)
    expect(() => verifyReleaseArtifactSignature(hmacSigned, trustedKeys)).not.toThrow()

    // Ed25519 signature verification
    const edSig = cryptoSign(null, canonicalReleasePayload(base), edKeyPair.privateKey).toString('hex')
    const edSigned: SignedReleaseManifest = { ...base, keyId: 'rel-ed25519-2026', signature: edSig }
    expect(() => verifyReleaseArtifactSignature(edSigned, trustedKeys)).not.toThrow()

    // Tampered version or untrusted keyId is rejected
    expect(() => verifyReleaseArtifactSignature({ ...edSigned, bytes: 999_999 }, trustedKeys)).toThrow(
      /signature verification failed/,
    )
    expect(() => verifyReleaseArtifactSignature({ ...hmacSigned, keyId: 'unknown-key' }, trustedKeys)).toThrow(
      /untrusted keyId/,
    )
  })

  it('automatically rolls back release pointer, state snapshot & generation when post-upgrade health probe fails, then succeeds on second upgrade attempt without manual DB deletion', async () => {
    const h = await createUpgradeTestHarness()
    try {
      // 1. Inject post-switch canary cgroup/UID failure on first upgrade attempt
      h.setCanaryHttp({
        httpStatus: 200,
        servedByUid: 1001,
        cgroupSlice: 'system.slice', // wrong slice! expected xpanel-1001.slice
        serviceActive: true,
      })

      const firstAttempt = await h.runner.executeSignedUpgrade(h.basePlan, h.signedManifest)
      expect(firstAttempt.outcome).toBe('rolled_back')
      expect(firstAttempt.reason).toMatch(/cgroup slice mismatch/)

      // Verify release symlink, desired state snapshot, and config generation rolled back to 1.0.0 / gen 41!
      expect(await h.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.0.0')
      expect(await h.fs.exists('/opt/xpanel/releases/1.1.0')).toBe(false)
      expect(h.getCurrentGen()).toBe(41)
      expect(h.activatedGenerations).toEqual([41])
      expect(h.getDesiredStateContent()).toBe('{"rev":1}')
      expect(await h.fs.exists('/var/lib/xpanel/upgrade.lock')).toBe(false)
      expect(await h.fs.exists('/var/lib/xpanel/maintenance.json')).toBe(false)

      // Customer data in /home/alice was never touched
      expect(await h.fs.readFile('/home/alice/public_html/index.php')).toBe('<?php echo "alice live";')

      // SQLite upgrades history table has 1 row with status 'rolled_back'
      const rowsAfterRollback = await listUpgrades(h.testDb.db)
      expect(rowsAfterRollback).toHaveLength(1)
      expect(rowsAfterRollback[0]?.status).toBe('rolled_back')

      // 2. Fix canary health probe and run a SECOND upgrade attempt without touching SQLite rows manually!
      h.clock.ms += 60_000
      h.setCanaryHttp({
        httpStatus: 200,
        servedByUid: 1001,
        cgroupSlice: 'xpanel-1001.slice',
        serviceActive: true,
      })

      const secondAttempt = await h.runner.executeSignedUpgrade(h.basePlan, h.signedManifest)
      expect(secondAttempt.outcome).toBe('succeeded')
      expect(await h.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.1.0')
      expect(h.getCurrentGen()).toBe(42)

      const rowsAfterSuccess = await listUpgrades(h.testDb.db)
      expect(rowsAfterSuccess).toHaveLength(2)
      expect(rowsAfterSuccess[0]?.status).toBe('succeeded')
      expect(rowsAfterSuccess[1]?.status).toBe('rolled_back')
    } finally {
      await h.testDb.close()
    }
  })

  it('recovers from an interrupted upgrade via recoverInterruptedUpgrade and allows a subsequent upgrade to succeed', async () => {
    const h = await createUpgradeTestHarness()
    try {
      // Simulate an in-flight interrupted upgrade row in SQLite + leftover lock & maintenance files
      const created = await h.runner.ports.history.create({
        fromVersion: '1.0.0',
        toVersion: '1.1.0',
        actor: 'root',
        fromSchemaVersion: h.testDb.migration.version,
      })
      await h.runner.ports.history.setPhase(created.id, 'switch')
      h.fs.putFile('/var/lib/xpanel/upgrade.lock', JSON.stringify({ state: 'running', recordId: created.id, actor: 'root', to: '1.1.0', at: h.clock.now().toISOString() }), 0o600)
      h.fs.putFile('/var/lib/xpanel/maintenance.json', '{}', 0o644)

      // Concurrent upgrade attempt while lock & in-flight row exist is refused with CONFLICT
      const refused = await h.runner.executeSignedUpgrade(h.basePlan, h.signedManifest)
      expect(refused.outcome).toBe('refused')
      expect(refused.code).toBe('CONFLICT')

      // Run recoverInterruptedUpgrade to repair symlink/generation, verify health, close stale row, and remove lock
      const recovered = await h.runner.recoverInterruptedUpgrade({
        actor: ROOT,
        os: { family: 'debian' },
        note: 'recovered after simulated crash during switch phase',
        canary: 'alice',
        fallbackVersion: '1.0.0',
        fallbackGenerationId: 41,
      })
      expect(recovered.version).toBe('1.0.0')
      expect(recovered.closedRecordId).toBe(created.id)
      expect(await h.fs.exists('/var/lib/xpanel/upgrade.lock')).toBe(false)
      expect(await h.fs.exists('/var/lib/xpanel/maintenance.json')).toBe(false)

      // Now the subsequent valid upgrade attempt succeeds cleanly!
      h.clock.ms += 60_000
      const succeeded = await h.runner.executeSignedUpgrade(h.basePlan, h.signedManifest)
      expect(succeeded.outcome).toBe('succeeded')
      expect(await h.fs.readlink('/opt/xpanel/current')).toBe('/opt/xpanel/releases/1.1.0')
    } finally {
      await h.testDb.close()
    }
  })
})
