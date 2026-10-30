import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import type { Account, Domain, Plan } from '@xpanel/core'
import { aptProfile } from '@xpanel/os'
import { services } from '@xpanel/render'
import { FakeHostExecutor } from '../executor.ts'
import type { AccountFileContext, AccountFileRequest, AccountFileRunner } from '../file-manager.ts'
import {
  AccountProcessServiceAdapter,
  validateSshPublicKey,
} from './account-process.ts'
import {
  AcmeCertificateServiceAdapter,
  computeLeafFingerprintSha256,
  isIdentifierAuthorizedByCaa,
  verifyIssuedCertificateBundle,
} from './acme.ts'
import {
  AuthoritativeDnsServiceAdapter,
  extractSoaSerial,
  parseDigSoaOutput,
  parseNamedZonesConfig,
  renderNamedZonesConfig,
} from './dns.ts'
import type { AuthoritativeDnsProber } from './dns.ts'
import {
  computeEffectiveFtpQuotaMb,
  parsePasswdLogins,
  PureFtpdServiceAdapter,
  renderPureFtpdDaemonConfigs,
} from './ftp.ts'
import {
  assertNoPasswordInArgv,
  createMariaDbSqlRunner,
  MariaDbServiceAdapter,
  parseShowGrantLine,
} from './mariadb.ts'
import type { MariaDbCommandInput, MariaDbCommandResult } from './mariadb.ts'

const UBUNTU_OS = aptProfile({
  id: 'ubuntu',
  idLike: ['debian'],
  versionId: '24.04',
  versionCodename: 'noble',
  name: 'Ubuntu',
  prettyName: 'Ubuntu 24.04 LTS',
  platformId: '',
  fields: {},
})

// Explicit simulated observations for portable adapter contracts; never native evidence.
const fakeAuthoritativeDnsProber: AuthoritativeDnsProber = async ({ expectedSerial, deleted }) => {
  const observation = { aaFlag: !deleted, raFlag: false, rcode: deleted ? 'REFUSED' : 'NOERROR', observedSerial: expectedSerial, answers: [] }
  return { udp: { ...observation, protocol: 'udp' }, tcp: { ...observation, protocol: 'tcp' } }
}

const makeAccount = (overrides: Partial<Account> = {}): Account => ({
  id: '11111111-1111-4111-8111-111111111111',
  username: 'alice',
  uid: 1001,
  gid: 1001,
  home: '/home/alice',
  primaryDomain: 'example.com',
  planId: '22222222-2222-4222-8222-222222222222',
  ownerId: null,
  status: 'active',
  suspendReason: null,
  contactEmail: 'alice@example.com',
  ipv4: '203.0.113.10',
  ipv6: null,
  shell: 'jailed',
  createdAt: '2026-10-22T00:00:00Z',
  ...overrides,
})

const makePlan = (overrides: Partial<Plan> = {}): Plan => ({
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Pro Plan',
  ownerId: null,
  featureListId: '33333333-3333-4333-8333-333333333333',
  resources: {
    diskMb: 1024,
    bandwidthMbMonth: 'unlimited',
    ioReadBps: 'unlimited',
    ioWriteBps: 'unlimited',
    ioReadIops: 'unlimited',
    ioWriteIops: 'unlimited',
    memoryMb: 512,
    maxProcesses: 64,
    cpuPercent: 100,
  },
  caps: {
    addonDomains: 10,
    aliasDomains: 10,
    subdomains: 20,
    mailboxes: 20,
    forwarders: 20,
    mailingLists: 5,
    ftpAccounts: 10,
    databases: 10,
    phpWorkers: 8,
  },
  dedicatedIp: false,
  shell: 'jailed',
  defaultMailboxQuotaMb: 256,
  ...overrides,
})

// ---- Minimal deterministic X.509 v3 SAN certificate builder for portable tests ----

const derLen = (len: number): Buffer => {
  if (len < 128) return Buffer.from([len])
  const bytes: number[] = []
  let n = len
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

const derTlv = (tag: number, content: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), derLen(content.length), content])

const derSeq = (items: readonly Buffer[]): Buffer => derTlv(0x30, Buffer.concat(items))
const derSet = (items: readonly Buffer[]): Buffer => derTlv(0x31, Buffer.concat(items))
const derOctet = (content: Buffer): Buffer => derTlv(0x04, content)
const derBitString = (content: Buffer): Buffer => derTlv(0x03, Buffer.concat([Buffer.from([0x00]), content]))
const derUtf8 = (text: string): Buffer => derTlv(0x0c, Buffer.from(text, 'utf8'))
const derGeneralizedTime = (d: Date): Buffer => {
  const s = d.toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, 'Z')
  return derTlv(0x18, Buffer.from(s, 'ascii'))
}

const wrapPem = (label: string, der: Buffer): string => {
  const b64 = der.toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

const generateTestCertBundle = (opts: {
  dnsNames: string[]
  notBefore?: Date
  notAfter?: Date
}): { fullchainPem: string; privkeyPem: string; fingerprintSha256: string } => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const pkcs8Der = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer

  const notBefore = opts.notBefore ?? new Date('2026-10-01T00:00:00Z')
  const notAfter = opts.notAfter ?? new Date('2027-01-01T00:00:00Z')
  const cn = opts.dnsNames[0] ?? 'example.com'

  const serialBytes = randomBytes(8)
  serialBytes[0] = (serialBytes[0] ?? 1) & 0x7f
  if (serialBytes[0] === 0) serialBytes[0] = 1
  const serialDer = derTlv(0x02, serialBytes)

  // ecdsa-with-SHA256 (1.2.840.10045.4.3.2)
  const sigAlgDer = Buffer.from('300a06082a8648ce3d040302', 'hex')
  const nameDer = derSeq([
    derSet([derSeq([Buffer.from('0603550403', 'hex'), derUtf8(cn)])]),
  ])
  const validityDer = derSeq([derGeneralizedTime(notBefore), derGeneralizedTime(notAfter)])

  // SAN extension (OID 2.5.29.17 = 06 03 55 1d 11)
  const generalNames = opts.dnsNames.map((name) => derTlv(0x82, Buffer.from(name, 'ascii')))
  const sanExt = derSeq([
    Buffer.from('0603551d11', 'hex'),
    derOctet(derSeq(generalNames)),
  ])
  const extensionsDer = derTlv(0xa3, derSeq([sanExt]))

  const tbsDer = derSeq([
    derTlv(0xa0, Buffer.from([0x02, 0x01, 0x02])), // v3
    serialDer,
    sigAlgDer,
    nameDer,
    validityDer,
    nameDer,
    spkiDer,
    extensionsDer,
  ])

  const signature = sign('sha256', tbsDer, privateKey)
  const certDer = derSeq([tbsDer, sigAlgDer, derBitString(signature)])
  const fullchainPem = wrapPem('CERTIFICATE', certDer)
  const privkeyPem = wrapPem('PRIVATE KEY', pkcs8Der)

  const x509 = new X509Certificate(fullchainPem)
  const fingerprintSha256 = createHash('sha256').update(x509.raw).digest('hex')

  return { fullchainPem, privkeyPem, fingerprintSha256 }
}

// ---- Confined in-memory AccountFileRunner for D04 & D05 portable tests ----

class InMemoryConfinedFileRunner implements AccountFileRunner {
  readonly files = new Map<string, { content: string; mode: number; mtime: string; uid: number; gid: number }>()
  readonly dirs = new Map<string, { mode: number; mtime: string; uid: number; gid: number }>()
  readonly invocations: { context: AccountFileContext; request: AccountFileRequest }[] = []

  async run(context: Readonly<AccountFileContext>, request: Readonly<AccountFileRequest>): Promise<unknown> {
    this.invocations.push({ context, request })
    const nowIso = '2026-10-22T12:00:00.000Z'
    switch (request.op) {
      case 'mkdir': {
        this.dirs.set(request.path, {
          mode: request.mode,
          mtime: nowIso,
          uid: context.account.uid,
          gid: context.account.gid,
        })
        return {
          name: request.path.split('/').at(-1) ?? request.path,
          path: request.path,
          kind: 'directory',
          sizeBytes: 0,
          mode: request.mode,
          mtime: nowIso,
        }
      }
      case 'write': {
        const sizeBytes = Buffer.byteLength(request.content, 'utf8')
        this.files.set(request.path, {
          content: request.content,
          mode: request.mode,
          mtime: nowIso,
          uid: context.account.uid,
          gid: context.account.gid,
        })
        return {
          name: request.path.split('/').at(-1) ?? request.path,
          path: request.path,
          kind: 'file',
          sizeBytes,
          mode: request.mode,
          mtime: nowIso,
        }
      }
      case 'read': {
        const file = this.files.get(request.path)
        if (!file) throw new Error('ENOENT')
        return {
          path: request.path,
          content: file.content,
          sizeBytes: Buffer.byteLength(file.content, 'utf8'),
          mtime: file.mtime,
        }
      }
      default:
        throw new Error(`Unsupported op ${request.op}`)
    }
  }
}

// ============================================================================
// 1. D01: MariaDB Service Adapter & Exact Grants & Streaming Dump/Restore (A36, A37)
// ============================================================================

describe('D01 — MariaDbServiceAdapter & SqlRunner (A36, A37)', () => {
  const validAdminConfigInspector = async () => ({
    exists: true,
    isFile: true,
    isSymlink: false,
    uid: 0,
    gid: 0,
    mode: 0o600,
    size: 128,
    content: '[client]\nuser=root\nsocket=/run/mysqld/mysqld.sock\n',
  })

  it('fails closed with PRECONDITION_FAILED (412) when admin defaults file is missing, a symlink, or group-readable', async () => {
    const missingAdapter = new MariaDbServiceAdapter({
      adminConfigInspector: async () => ({
        exists: false,
        isFile: false,
        isSymlink: false,
        uid: -1,
        gid: -1,
        mode: 0,
        size: 0,
      }),
    })
    await expect(missingAdapter.checkHealth()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      status: 412,
    })

    const symlinkAdapter = new MariaDbServiceAdapter({
      adminConfigInspector: async () => ({
        exists: true,
        isFile: false,
        isSymlink: true,
        uid: 0,
        gid: 0,
        mode: 0o600,
        size: 64,
      }),
    })
    await expect(symlinkAdapter.checkHealth()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      status: 412,
    })

    const worldReadableAdapter = new MariaDbServiceAdapter({
      adminConfigInspector: async () => ({
        exists: true,
        isFile: true,
        isSymlink: false,
        uid: 0,
        gid: 0,
        mode: 0o644,
        size: 64,
        content: '[client]\n',
      }),
    })
    await expect(worldReadableAdapter.checkHealth()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      status: 412,
    })
  })

  it('forbids passing passwords in argv and redacts secrets from error output', async () => {
    expect(() =>
      assertNoPasswordInArgv(['/usr/bin/mariadb', '-pSecretPass']),
    ).toThrow(/passwords must never be passed/)
    expect(() =>
      assertNoPasswordInArgv(['/usr/bin/mariadb', '--password=SecretPass']),
    ).toThrow(/passwords must never be passed/)

    const adapter = new MariaDbServiceAdapter({
      adminConfigInspector: validAdminConfigInspector,
      commandRunner: async () => ({
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: "ERROR 1064: near IDENTIFIED BY PASSWORD '*AABBCCDDEEFF00112233445566778899AABBCCDD'",
      }),
    })

    let caught: unknown
    try {
      await adapter.query(['SELECT 1'])
    } catch (err) {
      caught = err
    }
    expect(isXpanelError(caught)).toBe(true)
    if (isXpanelError(caught)) {
      expect(caught.message).toContain('[REDACTED]')
      expect(caught.message).not.toContain('AABBCCDDEEFF')
    }
  })

  it('parses SHOW GRANTS lines and executes exact REVOKE before GRANT reconciliation (A36)', async () => {
    const executedInputs: MariaDbCommandInput[] = []
    const showGrantsOutput = [
      "GRANT USAGE ON *.* TO `alice_app`@`localhost` IDENTIFIED BY PASSWORD '*0123456789ABCDEF0123456789ABCDEF01234567'",
      'GRANT SELECT, INSERT, UPDATE, DELETE, DROP ON `alice\\_old`.* TO `alice_app`@`localhost`',
      'GRANT SELECT, INSERT, DELETE, ALTER ON `alice\\_crm`.* TO `alice_app`@`localhost`',
      'GRANT SELECT, INSERT ON `alice\\_keep`.* TO `alice_app`@`localhost`',
    ].join('\n')

    const parsedOld = parseShowGrantLine(
      'GRANT SELECT, INSERT, UPDATE, DELETE, DROP ON `alice\\_old`.* TO `alice_app`@`localhost`',
    )
    expect(parsedOld).toEqual({
      kind: 'database',
      databasePattern: 'alice\\_old',
      privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DROP'],
      raw: 'GRANT SELECT, INSERT, UPDATE, DELETE, DROP ON `alice\\_old`.* TO `alice_app`@`localhost`',
    })

    const adapter = new MariaDbServiceAdapter({
      adminConfigInspector: validAdminConfigInspector,
      commandRunner: async (input) => {
        executedInputs.push(input)
        // Never allow passwords in argv
        assertNoPasswordInArgv(input.argv)
        expect(input.argv).toContain('--defaults-extra-file=/etc/xpanel/mariadb-admin.cnf')
        if (input.stdinSql?.includes('SHOW GRANTS')) {
          return { ok: true, exitCode: 0, stdout: showGrantsOutput, stderr: '' }
        }
        return { ok: true, exitCode: 0, stdout: '10.11.8-MariaDB\n', stderr: '' }
      },
    })

    const reconcileRes = await adapter.reconcileUserGrants({
      user: 'alice_app',
      username: 'alice',
      host: 'localhost',
      desiredGrants: [
        // alice_old is removed completely -> must get REVOKE ALL PRIVILEGES
        // alice_crm drops DELETE & ALTER and adds UPDATE -> must REVOKE DELETE, ALTER before GRANT SELECT, INSERT, UPDATE
        { database: 'alice_crm', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
        // alice_keep is unchanged -> no SQL statement emitted
        { database: 'alice_keep', privileges: ['SELECT', 'INSERT'] },
        // alice_new is newly added -> gets GRANT
        { database: 'alice_new', privileges: ['SELECT', 'CREATE'] },
      ],
    })

    expect(reconcileRes.unchangedDatabases).toEqual(['alice_keep'])
    expect(reconcileRes.revokedDatabases).toEqual([
      { databasePattern: 'alice\\_crm', privileges: ['DELETE', 'ALTER'] },
      { databasePattern: 'alice\\_old', privileges: 'ALL' },
    ])
    expect(reconcileRes.executedStatements).toEqual([
      "REVOKE DELETE, ALTER ON `alice\\_crm`.* FROM 'alice_app'@'localhost'",
      "REVOKE ALL PRIVILEGES ON `alice\\_old`.* FROM 'alice_app'@'localhost'",
      "GRANT SELECT, INSERT, UPDATE ON `alice\\_crm`.* TO 'alice_app'@'localhost'",
      "GRANT SELECT, CREATE ON `alice\\_new`.* TO 'alice_app'@'localhost'",
    ])

    // Verify REVOKE statements appear strictly before GRANT statements
    const firstGrantIdx = reconcileRes.executedStatements.findIndex((s) => s.startsWith('GRANT '))
    const lastRevokeIdx = reconcileRes.executedStatements.map((s) => s.startsWith('REVOKE ')).lastIndexOf(true)
    expect(lastRevokeIdx).toBeGreaterThanOrEqual(0)
    expect(lastRevokeIdx).toBeLessThan(firstGrantIdx)

    // Cross-tenant denial: alice cannot grant or reconcile on bob's database
    await expect(
      adapter.reconcileUserGrants({
        user: 'alice_app',
        username: 'alice',
        desiredGrants: [{ database: 'bob_secret', privileges: ['SELECT'] }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('streams logical dump and restore with routines, triggers, events, and pre-cutover verification (A37)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xpanel-mariadb-adapter-'))
    const dumpPath = join(directory, 'alice_prod.sql')
    try {
    const dumpCommands: MariaDbCommandInput[] = []
    const dumpPayload = '-- MariaDB dump\nCREATE TABLE `items` (`id` int);\n-- Dump completed\n'
    const expectedSha = createHash('sha256').update(dumpPayload, 'utf8').digest('hex')

    const adapter = new MariaDbServiceAdapter({
      adminConfigInspector: validAdminConfigInspector,
      commandRunner: async (input): Promise<MariaDbCommandResult> => {
        dumpCommands.push(input)
        if (input.argv[0]?.endsWith('mariadb-dump')) {
          expect(input.argv).toContain('--single-transaction')
          expect(input.argv).toContain('--routines')
          expect(input.argv).toContain('--triggers')
          expect(input.argv).toContain('--events')
          await writeFile(input.stdoutFilePath!, dumpPayload, { flag: 'wx', mode: 0o600 })
          return {
            ok: true,
            exitCode: 0,
            stdout: dumpPayload,
            stderr: '',
            bytesProcessed: Buffer.byteLength(dumpPayload, 'utf8'),
            sha256: expectedSha,
          }
        }
        if (input.stdinSql?.includes('information_schema.TABLES')) {
          return {
            ok: true,
            exitCode: 0,
            stdout: [
              'TABLE\titems\tInnoDB\t42',
              'TABLE\tusers\tInnoDB\t7',
              'ROUTINE\trecalc_totals\tPROCEDURE\t0',
              'TRIGGER\titems_after_insert\tINSERT\t0',
              'EVENT\tnightly_cleanup\tENABLED\t0',
            ].join('\n'),
            stderr: '',
          }
        }
        if (input.stdinSql?.includes('CHECKSUM TABLE')) {
          return {
            ok: true,
            exitCode: 0,
            stdout: 'alice_restored.items\t39485712\nalice_restored.users\t99182736\n',
            stderr: '',
          }
        }
        return {
          ok: true,
          exitCode: 0,
          stdout: '10.11.8-MariaDB\n',
          stderr: '',
          sha256: expectedSha,
        }
      },
    })

    const dumpResult = await adapter.streamLogicalDump({
      database: 'alice_prod',
      username: 'alice',
      outputPath: dumpPath,
    })
    expect(dumpResult).toEqual({
      database: 'alice_prod',
      outputPath: dumpPath,
      sizeBytes: Buffer.byteLength(dumpPayload, 'utf8'),
      sha256: expectedSha,
      routinesIncluded: true,
      triggersIncluded: true,
      eventsIncluded: true,
      singleTransaction: true,
    })

    const restoreResult = await adapter.streamLogicalRestore({
      targetDatabase: 'alice_restored',
      username: 'alice',
      inputPath: dumpPath,
      expectedSha256: expectedSha,
      verifyBeforeCutover: true,
    })
    expect(restoreResult.targetDatabase).toBe('alice_restored')
    expect(restoreResult.verifiedSha256).toBe(expectedSha)
    expect(restoreResult.verification).toEqual({
      database: 'alice_restored',
      tables: [
        { name: 'items', engine: 'InnoDB', rowCount: 42, checksum: '39485712' },
        { name: 'users', engine: 'InnoDB', rowCount: 7, checksum: '99182736' },
      ],
      routines: ['recalc_totals'],
      triggers: ['items_after_insert'],
      events: ['nightly_cleanup'],
    })

    // Refuses to drop database without verified backup
    await expect(
      adapter.dropDatabase('alice_prod', 'alice', { requireBackupVerified: true, backupVerified: false }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    // Wires cleanly into createMariaDbSqlRunner and rejects unsupported engines with 412
    const sqlRunner = createMariaDbSqlRunner(adapter)
    await expect(sqlRunner('postgresql', ['SELECT 1'])).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      status: 412,
    })
    await expect(sqlRunner('mariadb', ['CREATE DATABASE IF NOT EXISTS `alice_prod`'])).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

// ============================================================================
// 2. D02: Authoritative DNS Service Adapter (pdns-backend-bind) (A38)
// ============================================================================

describe('D02 — AuthoritativeDnsServiceAdapter (A38)', () => {
  const today = new Date('2026-10-22T12:00:00Z')

  const baseZoneRecords = (zone = 'example.com', ipv4 = '203.0.113.10') =>
    services.defaultZoneRecords(zone, {
      ipv4,
      nameservers: ['ns1.example.com', 'ns2.example.com'],
      mailHost: `mail.${zone}`,
      adminEmail: `admin@${zone}`,
      today,
    })

  it('allocates monotonic YYYYMMDDnn SOA serials under per-zone concurrency locks and updates named.conf.xpanel-zones', async () => {
    const executor = new FakeHostExecutor()
    const adapter = new AuthoritativeDnsServiceAdapter({ executor, prober: fakeAuthoritativeDnsProber })

    // Concurrent publishes on the same zone serialize and produce strictly increasing SOA serials
    const [res1, res2] = await Promise.all([
      adapter.publishZone({ zone: 'example.com', records: baseZoneRecords('example.com', '203.0.113.10'), now: today }),
      adapter.publishZone({ zone: 'example.com', records: baseZoneRecords('example.com', '203.0.113.11'), now: today }),
    ])

    expect(res1.serial).toBe(2026102201)
    expect(res2.serial).toBe(2026102202)
    expect(res2.previousSerial).toBe(2026102201)

    const liveZone = await adapter.readLiveZone('example.com')
    expect(liveZone?.serial).toBe(2026102202)
    expect(liveZone?.records.find((r) => r.type === 'A' && r.name === '@')?.content).toBe('203.0.113.11')

    const namedConf = await executor.readFile('/etc/powerdns/named.conf.xpanel-zones')
    expect(parseNamedZonesConfig(namedConf)).toEqual(['example.com'])
    expect(namedConf).toBe(renderNamedZonesConfig(['example.com']))

    // Optimistic concurrency check rejects stale expectedSerial with CONFLICT (409)
    await expect(
      adapter.publishZone({
        zone: 'example.com',
        records: baseZoneRecords('example.com', '203.0.113.12'),
        expectedSerial: 2026102201,
        now: today,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 })
  })

  it('rejects candidate zone failing named-checkzone before touching live zone or named.conf.xpanel-zones', async () => {
    const executor = new FakeHostExecutor()
    const adapter = new AuthoritativeDnsServiceAdapter({ executor, prober: fakeAuthoritativeDnsProber })

    await adapter.publishZone({
      zone: 'example.com',
      records: baseZoneRecords('example.com', '203.0.113.10'),
      now: today,
    })

    executor.failConfigTest('dns-zone:example.com', 'Error: SOA record invalid in staged zone')

    await expect(
      adapter.publishZone({
        zone: 'example.com',
        records: baseZoneRecords('example.com', '203.0.113.99'),
        now: today,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })

    // Live zone must still hold the original IP 203.0.113.10 and serial 2026102201, and staging dir must be clean
    const live = await adapter.readLiveZone('example.com')
    expect(live?.serial).toBe(2026102201)
    expect(live?.records.find((r) => r.type === 'A' && r.name === '@')?.content).toBe('203.0.113.10')
    const stagedRemnants = [...executor.files.keys()].filter((p) => p.startsWith('/var/lib/powerdns/staging/'))
    expect(stagedRemnants).toEqual([])
  })

  it('rolls back to the previous zone file with a bumped recovery SOA serial when reload or authoritative probe fails', async () => {
    const executor = new FakeHostExecutor()
    let failProbe = false

    const adapter = new AuthoritativeDnsServiceAdapter({
      executor,
      prober: async ({ zone, expectedSerial, deleted }) => {
        if (deleted) {
          return {
            udp: { protocol: 'udp', aaFlag: false, raFlag: false, rcode: 'REFUSED', observedSerial: null, answers: [] },
            tcp: { protocol: 'tcp', aaFlag: false, raFlag: false, rcode: 'REFUSED', observedSerial: null, answers: [] },
          }
        }
        if (failProbe) {
          failProbe = false
          return {
            udp: { protocol: 'udp', aaFlag: false, raFlag: false, rcode: 'SERVFAIL', observedSerial: null, answers: [] },
            tcp: { protocol: 'tcp', aaFlag: true, raFlag: false, rcode: 'NOERROR', observedSerial: expectedSerial, answers: [] },
          }
        }
        return {
          udp: { protocol: 'udp', aaFlag: true, raFlag: false, rcode: 'NOERROR', observedSerial: expectedSerial, answers: [`${zone}. IN SOA`] },
          tcp: { protocol: 'tcp', aaFlag: true, raFlag: false, rcode: 'NOERROR', observedSerial: expectedSerial, answers: [`${zone}. IN SOA`] },
        }
      },
    })

    const initial = await adapter.publishZone({
      zone: 'example.com',
      records: baseZoneRecords('example.com', '203.0.113.10'),
      now: today,
    })
    expect(initial.serial).toBe(2026102201)

    // Now inject authoritative probe failure on update (candidate gets 2026102202, fails probe -> rollback bumps to 2026102203!)
    failProbe = true
    let rollbackErr: unknown
    try {
      await adapter.publishZone({
        zone: 'example.com',
        records: baseZoneRecords('example.com', '203.0.113.55'),
        now: today,
      })
    } catch (err) {
      rollbackErr = err
    }

    expect(isXpanelError(rollbackErr)).toBe(true)
    if (isXpanelError(rollbackErr)) {
      expect(rollbackErr.code).toBe('CONFIG_TEST_FAILED')
      expect(rollbackErr.detail).toMatchObject({
        zone: 'example.com',
        rolledBack: true,
        failedSerial: 2026102202,
        recoverySerial: 2026102203,
        restoredPreviousZone: true,
      })
    }

    // Live zone must have the previous records (203.0.113.10) AND the bumped recovery serial 2026102203 (> 2026102202)
    const afterRollback = await adapter.readLiveZone('example.com')
    expect(afterRollback?.serial).toBe(2026102203)
    expect(afterRollback?.records.find((r) => r.type === 'A' && r.name === '@')?.content).toBe('203.0.113.10')
  })

  it('removes obsolete zone file and named.conf entry when a domain is deleted and parses real dig output', async () => {
    const executor = new FakeHostExecutor()
    const adapter = new AuthoritativeDnsServiceAdapter({ executor, prober: fakeAuthoritativeDnsProber })

    await adapter.publishZone({
      zone: 'example.com',
      records: baseZoneRecords('example.com', '203.0.113.10'),
      now: today,
    })
    await adapter.publishZone({
      zone: 'second.example',
      records: baseZoneRecords('second.example', '203.0.113.20'),
      now: today,
    })

    const delRes = await adapter.deleteZone('example.com')
    expect(delRes.existed).toBe(true)
    expect(await adapter.readLiveZone('example.com')).toBeNull()
    expect(parseNamedZonesConfig(await executor.readFile('/etc/powerdns/named.conf.xpanel-zones'))).toEqual([
      'second.example',
    ])

    const sampleDig = [
      ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 41234',
      ';; flags: qr aa rd; QUERY: 1, ANSWER: 1, AUTHORITY: 2, ADDITIONAL: 1',
      ';; ANSWER SECTION:',
      'second.example.\t14400\tIN\tSOA\tns1.second.example. admin.second.example. 2026102201 3600 1800 1209600 3600',
    ].join('\n')
    const parsedDig = parseDigSoaOutput(sampleDig, 'udp')
    expect(parsedDig).toEqual({
      protocol: 'udp',
      aaFlag: true,
      raFlag: false,
      rcode: 'NOERROR',
      observedSerial: 2026102201,
      answers: [
        'second.example.\t14400\tIN\tSOA\tns1.second.example. admin.second.example. 2026102201 3600 1800 1209600 3600',
      ],
    })
  })
})

// ============================================================================
// 3. D03: ACME Certificate Issuance, Renewal, Order Persistence & SNI Rollback (A39)
// ============================================================================

describe('D03 — AcmeCertificateServiceAdapter (A39)', () => {
  // Declared portable fixture only; this is not a real SNI observation or native qualification.
  const fakeSniVerifier = async ({ servername, expectedFingerprintSha256 }: { servername: string; expectedFingerprintSha256: string }) => ({ servername, ok: true, fingerprintSha256: expectedFingerprintSha256, notAfter: null })
  const now = new Date('2026-10-22T12:00:00Z')
  const aliceDomain: Pick<Domain, 'id' | 'accountId' | 'name'> = {
    id: 'dom-1',
    accountId: 'acc-alice',
    name: 'example.com',
  }

  it('leaves absent SNI verification unverified and refuses installation before CA or host writes', async () => {
    const executor = new FakeHostExecutor()
    let orders = 0
    const adapter = new AcmeCertificateServiceAdapter({ executor, os: UBUNTU_OS,
      caClient: async () => { orders++; throw new Error('unexpected CA request') } })
    expect(await adapter.sniVerifier({ servername: 'example.com', expectedFingerprintSha256: 'a'.repeat(64), expectedCertPath: '/unread' })).toMatchObject({ ok: false, fingerprintSha256: null })
    await expect(adapter.issueOrRenewCertificate({ certId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accountId: 'acc-alice', callerRole: 'user', names: ['example.com'], challenge: 'http-01', domains: [aliceDomain], now })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(orders).toBe(0); expect(executor.files.size).toBe(0); expect(executor.executedActions).toHaveLength(0)
    const certId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await executor.writeFile({ path: '/var/lib/xpanel/acme-orders/' + certId + '.json', content: JSON.stringify({ certId, accountId: 'foreign-account',
      directoryUrl: 'https://acme-v02.api.letsencrypt.org/directory', challenge: 'http-01', identifiers: ['example.com'], attempts: 1, phase: 'issued', issuedPem: null }), mode: 0o600, owner: 'root', group: 'root' })
    await expect(adapter.issueOrRenewCertificate({ certId, accountId: 'acc-alice', callerRole: 'user', names: ['example.com'], challenge: 'http-01', domains: [aliceDomain], now, prepareOnly: true })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(orders).toBe(0)
  })

  it('prepares immutable fresh files without native reload or SNI success and retains the issued checkpoint', async () => {
    const executor = new FakeHostExecutor(), bundle = generateTestCertBundle({ dnsNames: ['example.com'] })
    const adapter = new AcmeCertificateServiceAdapter({ executor, os: UBUNTU_OS, caClient: async () => ({ orderUrl: 'https://acme.test/order/prepared', ...bundle }) })
    const certId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const result = await adapter.issueOrRenewCertificate({ certId, accountId: 'acc-alice', callerRole: 'user', names: ['example.com'], challenge: 'http-01', domains: [aliceDomain], now, prepareOnly: true })
    expect(result.application).toEqual({ status: 'candidate_files_written', servedTlsVerified: false })
    expect(result.sniObservations).toEqual([]); expect(result.privkeyMode).toBe(0o600); expect(result.privkeyGroup).toBe('root')
    expect(executor.executedTests).toHaveLength(0)
    expect(executor.executedActions.some(action => action.kind === 'systemd')).toBe(false)
    expect((await adapter.readOrderState(certId))?.phase).toBe('issued')
    expect(JSON.stringify(result)).not.toContain('BEGIN PRIVATE KEY')
    const before = await executor.readFile(result.fullchainPath)
    await expect(adapter.issueOrRenewCertificate({ certId, accountId: 'acc-alice', callerRole: 'user', names: ['example.com'], challenge: 'http-01', domains: [aliceDomain], now, prepareOnly: true })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await executor.readFile(result.fullchainPath)).toBe(before)
  })

  it('enforces domain ownership and CAA preflight before placing an ACME order', async () => {
    const executor = new FakeHostExecutor()
    let caCalled = 0

    const adapter = new AcmeCertificateServiceAdapter({
      executor,
      os: UBUNTU_OS,
      caClient: async () => {
        caCalled++
        const bundle = generateTestCertBundle({ dnsNames: ['example.com'] })
        return { orderUrl: 'https://acme.test/order/1', ...bundle }
      },
      caaResolver: async () => [
        { flags: 0, tag: 'issue', value: 'sectigo.com' },
      ],
    })

    // 1. Cross-tenant domain ownership denial: bob cannot order cert for alice's domain
    await expect(
      adapter.issueOrRenewCertificate({
        certId: 'cert_bob_1',
        accountId: 'acc-bob',
        callerRole: 'user',
        names: ['example.com'],
        challenge: 'http-01',
        domains: [aliceDomain],
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(caCalled).toBe(0)

    // 2. CAA preflight denial: CAA only permits sectigo.com, not letsencrypt.org
    await expect(
      adapter.issueOrRenewCertificate({
        certId: 'cert_alice_1',
        accountId: 'acc-alice',
        callerRole: 'user',
        names: ['example.com'],
        challenge: 'http-01',
        domains: [aliceDomain],
        now,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(caCalled).toBe(0)

    expect(
      isIdentifierAuthorizedByCaa('*.example.com', [{ flags: 0, tag: 'issuewild', value: ';' }], 'letsencrypt.org'),
    ).toBe(false)
    expect(
      isIdentifierAuthorizedByCaa('*.example.com', [{ flags: 0, tag: 'issuewild', value: 'letsencrypt.org; accounturi=https://acme' }], 'letsencrypt.org'),
    ).toBe(true)
  })

  it('stages HTTP-01 challenge files under /var/www/xpanel-acme/.well-known/acme-challenge/, installs 0640 root:xpanel-tls key, and always cleans up challenges', async () => {
    const executor = new FakeHostExecutor()
    const token = 'T'.repeat(43)
    const keyAuth = `${token}.${'K'.repeat(43)}`
    let challengeExistedDuringOrder = false

    const adapter = new AcmeCertificateServiceAdapter({
      executor,
      os: UBUNTU_OS,
      caClient: async ({ onPublishChallenges }) => {
        // This order fixture's served result is supplied by fakeSniVerifier below.
        await onPublishChallenges([{ identifier: 'example.com', token, keyAuthorization: keyAuth }])
        const staged = await executor.readFile(`/var/www/xpanel-acme/.well-known/acme-challenge/${token}`)
        challengeExistedDuringOrder = staged === keyAuth
        const bundle = generateTestCertBundle({ dnsNames: ['example.com', 'www.example.com'] })
        return { orderUrl: 'https://acme.test/order/http1', ...bundle }
      },
      sniVerifier: fakeSniVerifier,
    })

    const res = await adapter.issueOrRenewCertificate({
      certId: 'cert_http_01',
      accountId: 'acc-alice',
      callerRole: 'user',
      names: ['example.com', 'www.example.com'],
      challenge: 'http-01',
      domains: [aliceDomain],
      now,
    })

    expect(challengeExistedDuringOrder).toBe(true)
    // Challenge file must be cleaned up after completion
    expect(await executor.readFile(`/var/www/xpanel-acme/.well-known/acme-challenge/${token}`)).toBeNull()
    expect(await executor.readFile(`/var/lib/xpanel/acme/${token}`)).toBeNull()

    // Private key must be installed with mode 0640 and group xpanel-tls
    const privkeyFile = executor.files.get('/etc/xpanel/ssl/cert_http_01/privkey.pem')
    expect(privkeyFile?.mode).toBe(0o640)
    expect(privkeyFile?.owner).toBe('root')
    expect(privkeyFile?.group).toBe('xpanel-tls')
    expect(res.sniObservations).toHaveLength(2)
  })

  it('publishes DNS-01 apex + wildcard TXT records via AuthoritativeDnsServiceAdapter and cleans them up in finally even when CA fails', async () => {
    const executor = new FakeHostExecutor()
    const dnsAdapter = new AuthoritativeDnsServiceAdapter({ executor, prober: fakeAuthoritativeDnsProber })

    await dnsAdapter.publishZone({
      zone: 'example.com',
      records: services.defaultZoneRecords('example.com', {
        ipv4: '203.0.113.10',
        nameservers: ['ns1.example.com', 'ns2.example.com'],
        mailHost: 'mail.example.com',
        adminEmail: 'admin@example.com',
        today: now,
      }),
      now,
    })

    const tok1 = 'A'.repeat(43)
    const tok2 = 'B'.repeat(43)
    const ka1 = `${tok1}.${'K'.repeat(43)}`
    const ka2 = `${tok2}.${'K'.repeat(43)}`
    let observedTxtDuringValidation: string[] = []
    let simulateCaFailure = true

    const acmeAdapter = new AcmeCertificateServiceAdapter({
      executor,
      os: UBUNTU_OS,
      dnsAdapter,
      sniVerifier: fakeSniVerifier,
      caClient: async ({ onPublishChallenges }) => {
        await onPublishChallenges([
          { identifier: 'example.com', token: tok1, keyAuthorization: ka1 },
          { identifier: '*.example.com', token: tok2, keyAuthorization: ka2 },
        ])
        const liveZone = await dnsAdapter.readLiveZone('example.com')
        observedTxtDuringValidation =
          liveZone?.records.filter((r) => r.type === 'TXT' && r.name === '_acme-challenge').map((r) => r.content) ?? []
        if (simulateCaFailure) {
          throw new Error('ACME CA validation rate-limited')
        }
        const bundle = generateTestCertBundle({ dnsNames: ['example.com', '*.example.com'] })
        return { orderUrl: 'https://acme.test/order/dns1', ...bundle }
      },
    })

    // First attempt fails inside CA after DNS-01 TXT records were published
    await expect(
      acmeAdapter.issueOrRenewCertificate({
        certId: 'cert_dns_01',
        accountId: 'acc-alice',
        callerRole: 'user',
        names: ['example.com', '*.example.com'],
        challenge: 'dns-01',
        domains: [aliceDomain],
        hostedZones: ['example.com'],
        now,
      }),
    ).rejects.toThrow(/rate-limited/)

    // Both TXT digests were present in the authoritative zone during validation
    expect(observedTxtDuringValidation).toHaveLength(2)
    expect(observedTxtDuringValidation).toEqual(
      expect.arrayContaining([services.dns01Value(ka1), services.dns01Value(ka2)]),
    )

    // And both TXT records were cleaned up in `finally` despite the failure!
    const zoneAfterFailure = await dnsAdapter.readLiveZone('example.com')
    expect(zoneAfterFailure?.records.filter((r) => r.name === '_acme-challenge')).toEqual([])

    // Second attempt succeeds
    simulateCaFailure = false
    const res = await acmeAdapter.issueOrRenewCertificate({
      certId: 'cert_dns_01',
      accountId: 'acc-alice',
      callerRole: 'user',
      names: ['example.com', '*.example.com'],
      challenge: 'dns-01',
      domains: [aliceDomain],
      hostedZones: ['example.com'],
      now,
    })
    expect(res.identifiers).toEqual(['example.com', '*.example.com'])
    const zoneAfterSuccess = await dnsAdapter.readLiveZone('example.com')
    expect(zoneAfterSuccess?.records.filter((r) => r.name === '_acme-challenge')).toEqual([])
  })

  it('resumes installation from persisted order state without duplicate CA order after a post-issuance reload failure, while preserving the previous valid certificate during the failure', async () => {
    const executor = new FakeHostExecutor()
    let caOrdersCount = 0

    // 1. First install an initial valid certificate (v1)
    const v1Bundle = generateTestCertBundle({ dnsNames: ['example.com'] })
    const v2Bundle = generateTestCertBundle({ dnsNames: ['example.com'] })
    let currentBundle = v1Bundle

    const adapter = new AcmeCertificateServiceAdapter({
      executor,
      os: UBUNTU_OS,
      sniVerifier: fakeSniVerifier,
      caClient: async () => {
        caOrdersCount++
        return {
          orderUrl: `https://acme.test/order/${caOrdersCount}`,
          fullchainPem: currentBundle.fullchainPem,
          privkeyPem: currentBundle.privkeyPem,
        }
      },
    })

    const firstInstall = await adapter.issueOrRenewCertificate({
      certId: 'cert_renew_test',
      accountId: 'acc-alice',
      callerRole: 'user',
      names: ['example.com'],
      challenge: 'http-01',
      domains: [aliceDomain],
      now,
    })
    expect(firstInstall.fingerprintSha256).toBe(v1Bundle.fingerprintSha256)
    expect(caOrdersCount).toBe(1)

    // 2. Now renew with v2Bundle, but simulate nginx -t failure during installation
    currentBundle = v2Bundle
    executor.failConfigTest('nginx', 'nginx: [emerg] simulated reload syntax failure')

    await expect(
      adapter.issueOrRenewCertificate({
        certId: 'cert_renew_test',
        accountId: 'acc-alice',
        callerRole: 'user',
        names: ['example.com'],
        challenge: 'http-01',
        domains: [aliceDomain],
        now,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
    expect(caOrdersCount).toBe(2)

    // Existing valid v1 certificate MUST still be preserved on disk!
    const liveCertAfterFailedRenew = await executor.readFile('/etc/xpanel/ssl/cert_renew_test/fullchain.pem')
    expect(liveCertAfterFailedRenew).toBe(v1Bundle.fullchainPem)
    expect(computeLeafFingerprintSha256(liveCertAfterFailedRenew!).fingerprintSha256).toBe(v1Bundle.fingerprintSha256)

    // Persisted order state must be in phase='issued' with retry metadata
    const persistedOrder = await adapter.readOrderState('cert_renew_test')
    expect(persistedOrder?.phase).toBe('issued')
    expect(persistedOrder?.nextRetryAt).toBeTruthy()

    // 3. Fix nginx config test and retry renewal -> must resume installation WITHOUT calling CA again!
    executor.clearConfigTestFailures()
    const resumedInstall = await adapter.issueOrRenewCertificate({
      certId: 'cert_renew_test',
      accountId: 'acc-alice',
      callerRole: 'user',
      names: ['example.com'],
      challenge: 'http-01',
      domains: [aliceDomain],
      now,
    })

    expect(resumedInstall.resumedFromPersistedOrder).toBe(true)
    expect(caOrdersCount).toBe(2) // No duplicate CA order!
    expect(resumedInstall.fingerprintSha256).toBe(v2Bundle.fingerprintSha256)
    expect(await executor.readFile('/etc/xpanel/ssl/cert_renew_test/fullchain.pem')).toBe(v2Bundle.fullchainPem)

    // Also verify SAN mismatch rejection in verifyIssuedCertificateBundle
    expect(() =>
      verifyIssuedCertificateBundle(v2Bundle.fullchainPem, v2Bundle.privkeyPem, ['other.example.org'], now),
    ).toThrow(/do not cover/)
  })
})

// ============================================================================
// 4. D04: Pure-FTPd Service Adapter & Streaming File/Quota Integration (A40)
// ============================================================================

describe('D04 — PureFtpdServiceAdapter & Streaming Upload/Quota (A40)', () => {
  const validSha512Hash = `$6$rounds=5000$saltsaltsaltsalt$${'a'.repeat(86)}`

  it('compiles PureDB virtual users with UID/GID >= 1000, chroot confinement, TLS policy, and revokes the last user when deleted or suspended', async () => {
    const executor = new FakeHostExecutor()
    const fileRunner = new InMemoryConfinedFileRunner()
    const alice = makeAccount()
    const plan = makePlan({ resources: { ...makePlan().resources, diskMb: 500 } })
    const plansById = new Map([[plan.id, plan]])

    const adapter = new PureFtpdServiceAdapter({
      executor,
      os: UBUNTU_OS,
      quotaFilesystem: '/home',
      tlsPolicy: { mode: 'required', passivePortRange: [30000, 35000] },
      accountFileRunner: fileRunner,
    })

    // 1. Provision two FTP users for alice (one requesting 1000 MB quota, bounded by plan's 500 MB)
    const res1 = await adapter.reconcileUsers({
      accounts: [alice],
      plansById,
      users: [
        {
          login: 'alice',
          passwordHash: validSha512Hash,
          account: alice,
          dir: '',
          quotaMb: 1000,
        },
        {
          login: 'deploy@example.com',
          passwordHash: validSha512Hash,
          account: alice,
          dir: 'public_html',
          quotaMb: 200,
        },
      ],
      runQuotacheck: true,
    })

    expect(res1.activeLogins).toEqual(['alice', 'deploy@example.com'])
    expect(res1.revokedLogins).toEqual([])
    expect(res1.tlsMode).toBe('required')
    expect(await executor.readFile('/etc/pure-ftpd/conf/TLS')).toBe('2\n')
    expect(await executor.readFile('/etc/pure-ftpd/conf/ChrootEveryone')).toBe('yes\n')

    const passwdContent = await executor.readFile('/etc/pure-ftpd/pureftpd.passwd')
    expect(passwdContent).toContain('/home/alice/./:')
    expect(passwdContent).toContain('/home/alice/./public_html/:')
    // alice's 1000 MB user quota was clamped to plan's 500 MB (500 * 1024 * 1024 = 524288000 bytes)
    expect(passwdContent).toContain(':524288000:::::')

    // 2. Suspend alice -> all FTP users must be immediately revoked and pure-pw mkdb re-executed!
    const suspendedAlice = makeAccount({ status: 'suspended', suspendReason: 'billing' })
    const res2 = await adapter.reconcileUsers({
      accounts: [suspendedAlice],
      plansById,
      users: [
        {
          login: 'alice',
          passwordHash: validSha512Hash,
          account: suspendedAlice,
          dir: '',
        },
      ],
    })

    expect(res2.activeLogins).toEqual([])
    expect(res2.revokedLogins).toEqual(['alice', 'deploy@example.com'])
    expect(await executor.readFile('/etc/pure-ftpd/pureftpd.passwd')).toBe('')
    expect(parsePasswdLogins(await executor.readFile('/etc/pure-ftpd/pureftpd.passwd'))).toEqual([])

    // 3. Rejects UID < 1000 or mismatched account UID
    await expect(
      adapter.reconcileUsers({
        accounts: [alice],
        plansById,
        users: [
          {
            login: 'alice',
            passwordHash: validSha512Hash,
            account: { ...alice, uid: 1002 },
            dir: '',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(computeEffectiveFtpQuotaMb(800, 500)).toBe(500)
    expect(() => renderPureFtpdDaemonConfigs({ tlsPolicy: { mode: 'disabled' as 'required' } })).toThrow(/plaintext-only/)
  })

  it('enforces quota and byte limits on streaming file uploads and writes under the confined account runner', async () => {
    const executor = new FakeHostExecutor()
    const fileRunner = new InMemoryConfinedFileRunner()
    const alice = makeAccount()

    const adapter = new PureFtpdServiceAdapter({
      executor,
      os: UBUNTU_OS,
      accountFileRunner: fileRunner,
    })

    async function* generateChunks(parts: string[]) {
      for (const p of parts) {
        yield Buffer.from(p, 'utf8')
      }
    }

    const uploadOk = await adapter.streamUploadToAccount({
      account: alice,
      diskQuotaMb: 1, // 1 MiB
      relativePath: 'public_html/index.html',
      chunks: generateChunks(['<html>', '<body>Hello FTP</body>', '</html>']),
      mode: 0o640,
    })

    expect(uploadOk.bytesWritten).toBe(35)
    expect(fileRunner.files.get('public_html/index.html')?.uid).toBe(1001)
    expect(fileRunner.files.get('public_html/index.html')?.content).toBe('<html><body>Hello FTP</body></html>')

    // Exceeding remaining disk quota fails with LIMIT_EXCEEDED without overwriting the existing file
    await expect(
      adapter.streamUploadToAccount({
        account: alice,
        diskQuotaMb: 1,
        currentUsedBytes: 1024 * 1024 - 10,
        relativePath: 'public_html/index.html',
        chunks: generateChunks(['0123456789ABCDEF']),
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })

    expect(fileRunner.files.get('public_html/index.html')?.content).toBe('<html><body>Hello FTP</body></html>')
  })
})

// ============================================================================
// 5. D05: Account Process Service Adapter — SSH, Cron Timers & App Units (A41)
// ============================================================================

describe('D05 — AccountProcessServiceAdapter (SSH, Cron Timers & Background Apps — A41)', () => {
  // Valid RFC 4253 wire-format ssh-ed25519 public key line
  const buildEd25519PubKey = (comment = 'alice@laptop'): string => {
    const keyType = 'ssh-ed25519'
    const typeBuf = Buffer.from(keyType, 'ascii')
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(typeBuf.length, 0)
    const pubKeyBytes = Buffer.alloc(32, 0x42)
    const pubLenBuf = Buffer.alloc(4)
    pubLenBuf.writeUInt32BE(pubKeyBytes.length, 0)
    const blob = Buffer.concat([lenBuf, typeBuf, pubLenBuf, pubKeyBytes]).toString('base64')
    return `${keyType} ${blob} ${comment}`
  }

  it('authorizes SSH keys via confined AccountFileRunner, rejects authorized_keys command= injections, and validates sshd drop-in without locking out root', async () => {
    const executor = new FakeHostExecutor()
    const fileRunner = new InMemoryConfinedFileRunner()
    const alice = makeAccount()
    const plan = makePlan()

    const adapter = new AccountProcessServiceAdapter({
      executor,
      os: UBUNTU_OS,
      accountFileRunner: fileRunner,
    })

    const validKey = buildEd25519PubKey('alice@workstation')
    const sshRes = await adapter.reconcileAccountSshKeys({
      account: alice,
      plan,
      publicKeys: [validKey, validKey], // deduplicated
    })

    expect(sshRes.keysAuthorized).toBe(1)
    expect(fileRunner.dirs.get('.ssh')?.mode).toBe(0o700)
    expect(fileRunner.files.get('.ssh/authorized_keys')?.mode).toBe(0o600)
    expect(fileRunner.files.get('.ssh/authorized_keys')?.uid).toBe(1001)
    expect(fileRunner.files.get('.ssh/authorized_keys')?.content).toBe(`${validKey}\n`)

    // Rejects authorized_keys option injection attempts
    expect(() => validateSshPublicKey(`command="/bin/sh" ${validKey}`)).toThrow(/authorized_keys options are forbidden/)

    // Rejects SSH key authorization when account is suspended or shell is disabled
    await expect(
      adapter.reconcileAccountSshKeys({
        account: makeAccount({ shell: 'none' }),
        plan,
        publicKeys: [validKey],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // Applies sshd policy and prevents root lockout
    await expect(
      adapter.applySshdPolicy({
        port: 22,
        passwordAuth: false,
        rootLogin: 'prohibit-password',
        allowUsers: ['alice'], // missing root -> SELF_LOCKOUT!
      }),
    ).rejects.toMatchObject({ code: 'SELF_LOCKOUT' })

    const sshdOk = await adapter.applySshdPolicy({
      port: 2222,
      passwordAuth: false,
      rootLogin: 'prohibit-password',
      allowUsers: ['root', 'alice'],
    })
    expect(sshdOk.dropinPath).toBe('/etc/ssh/sshd_config.d/00-xpanel.conf')
    expect(await executor.readFile('/etc/ssh/sshd_config.d/00-xpanel.conf')).toContain('AllowUsers root alice')

    // Rollback sshd drop-in if sshd -t fails
    executor.failConfigTest('sshd', 'sshd_config syntax error')
    await expect(
      adapter.applySshdPolicy({
        port: 2299,
        passwordAuth: false,
        rootLogin: 'prohibit-password',
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
    expect(await executor.readFile('/etc/ssh/sshd_config.d/00-xpanel.conf')).toContain('Port 2222')
  })

  it('reconciles systemd cron timers inside xpanel-<uid>.slice, observes status, blocks overlapping manual triggers, and removes deleted jobs', async () => {
    const executor = new FakeHostExecutor()
    const alice = makeAccount()
    const plan = makePlan()
    const adapter = new AccountProcessServiceAdapter({ executor, os: UBUNTU_OS })

    const res1 = await adapter.reconcileAccountCronJobs({
      account: alice,
      plan,
      jobs: [
        { id: 'backup-db', schedule: '*/15 * * * *', command: '/usr/bin/php8.3 artisan schedule:run', enabled: true },
        { id: 'paused-job', schedule: '0 3 * * *', command: '/usr/bin/php8.3 cleanup.php', enabled: false },
      ],
    })

    expect(res1.slice).toBe('xpanel-1001.slice')
    expect(res1.activeTimers).toEqual(['xpanel-cron-alice-backup-db.timer'])
    expect(res1.stoppedTimers).toEqual(['xpanel-cron-alice-paused-job.timer'])

    const serviceFile = await executor.readFile('/etc/systemd/system/xpanel-cron-alice-backup-db.service')
    expect(serviceFile).toContain('Slice=xpanel-1001.slice')
    expect(serviceFile).toContain('Type=oneshot')
    expect(serviceFile).toContain('SocketBindDeny=any')
    expect(serviceFile).not.toContain('artisan schedule:run')
    expect(executor.files.get('/etc/xpanel/cron/alice/backup-db.command')).toMatchObject({ content: '/usr/bin/php8.3 artisan schedule:run', mode: 0o640, owner: 'root', group: 'alice' })
    expect(executor.dirs.get('/etc/xpanel/cron/alice')).toEqual({ mode: 0o750, owner: 'root', group: 'alice' })
    const notRun = await adapter.observeCronStatus(alice, 'backup-db')
    expect(notRun).toMatchObject({ lastResult: 'unknown', lastExitCode: null, lastStartedAt: null, durationMs: null, nextRunAt: null })

    // Trigger job now -> marks service unit active in FakeHostExecutor
    const triggered = await adapter.triggerCronNow(alice, 'backup-db')
    expect(triggered.serviceRunning).toBe(true)
    expect(executor.executedCommands).toContainEqual(['/usr/bin/systemctl', 'start', '--no-block', 'xpanel-cron-alice-backup-db.service'])
    expect(triggered.lastResult).toBe('unknown')

    // Overlapping trigger while service is running must be rejected with CONFLICT (409)!
    await expect(adapter.triggerCronNow(alice, 'backup-db')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    })

    // Removing 'paused-job' cleans up its unit files
    const res2 = await adapter.reconcileAccountCronJobs({
      account: alice,
      plan,
      jobs: [{ id: 'backup-db', schedule: '*/15 * * * *', command: '/usr/bin/php8.3 artisan schedule:run', enabled: true }],
      existingJobIds: ['backup-db', 'paused-job'],
    })
    expect(res2.removedUnits).toEqual([
      'xpanel-cron-alice-paused-job.timer',
      'xpanel-cron-alice-paused-job.service',
    ])
    expect(executor.files.has('/etc/xpanel/cron/alice/paused-job.command')).toBe(false)
  })

  it('cron observations require successful bounded loaded systemctl evidence and never derive success from fake unit maps', async () => {
    const executor = new FakeHostExecutor(), alice = makeAccount()
    const adapter = new AccountProcessServiceAdapter({ executor, os: UBUNTU_OS })
    executor.units.set('xpanel-cron-alice-missing.service', { active: true, enabled: true, properties: { Result: 'success' } })
    await expect(adapter.observeCronStatus(alice, 'missing')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, observationUnavailable: true } })
    await adapter.reconcileAccountCronJobs({ account: alice, plan: makePlan(), jobs: [{ id: 'real', schedule: '@daily', command: 'printf synthetic', enabled: true }] })
    executor.failCommand('show', 0, '', '[jailshell] synthetic no properties\n')
    await expect(adapter.observeCronStatus(alice, 'real')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    executor.clearCommandFailures()
    executor.failCommand('show', 1, 'not available', 'LoadState=loaded\nActiveState=inactive\n')
    await expect(adapter.observeCronStatus(alice, 'real')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    executor.clearCommandFailures()
    executor.failCommand('show', 0, '', 'x'.repeat(32769))
    await expect(adapter.observeCronStatus(alice, 'real')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const count = executor.executedCommands.length
    await expect(adapter.observeCronStatus(alice, '../escape')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(executor.executedCommands).toHaveLength(count)
  })

  it('cron manual-run failures require review without reporting execution or retrying', async () => {
    const executor = new FakeHostExecutor(), alice = makeAccount(), adapter = new AccountProcessServiceAdapter({ executor, os: UBUNTU_OS })
    await adapter.reconcileAccountCronJobs({ account: alice, plan: makePlan(), jobs: [{ id: 'real', schedule: '@daily', command: 'printf synthetic', enabled: true }] })
    executor.failCommand('start --no-block', 1)
    await expect(adapter.triggerCronNow(alice, 'real')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { unknownOutcome: true, verificationRequired: true, stateChanged: true } })
    expect(executor.executedCommands.filter(argv => argv[1] === 'start')).toHaveLength(1)
  })

  it('cron completed observations use declared timestamps, exit status and monotonic duration only', async () => {
    const executor = new FakeHostExecutor(), alice = makeAccount(), adapter = new AccountProcessServiceAdapter({ executor, os: UBUNTU_OS })
    await adapter.reconcileAccountCronJobs({ account: alice, plan: makePlan(), jobs: [{ id: 'real', schedule: '@daily', command: 'printf synthetic', enabled: true }] })
    executor.units.set('xpanel-cron-alice-real.service', { active: false, enabled: false, properties: { Result: 'exit-code', ExecMainStatus: '7', ExecMainStartTimestamp: 'Mon 2026-10-26 01:00:00 UTC', ExecMainStartTimestampMonotonic: '1000000', ExecMainExitTimestampMonotonic: '1250000' } })
    executor.units.get('xpanel-cron-alice-real.timer')!.properties.NextElapseUSecRealtime = 'Tue 2026-10-27 00:00:00 UTC'
    expect(await adapter.observeCronStatus(alice, 'real')).toMatchObject({ lastResult: 'exit-code', lastExitCode: 7, durationMs: 250, nextRunAt: 'Tue 2026-10-27 00:00:00 UTC', serviceRunning: false })
  })

  it('stops runtime units of the account on suspension and removes them with its runtime configuration on termination', async () => {
    const executor = new FakeHostExecutor()
    const adapter = new AccountProcessServiceAdapter({ executor, os: UBUNTU_OS })
    const units = ['xpanel-app-alice-api-web.service', 'xpanel-appproxy-alice-api-web.socket', 'xpanel-redis-alice.service']
    await executor.writeFile({ path: '/etc/systemd/system/xpanel-app-alice-api-web.service', content: '[Service]\n', mode: 0o644, owner: 'root', group: 'root' })
    await executor.writeFile({ path: '/etc/xpanel/runtime/alice/api-web.env', content: 'A=1\n', mode: 0o600, owner: 'root', group: 'root' })

    const suspendLifecycle = await adapter.enforceAccountLifecycleState({ account: makeAccount({ status: 'suspended', suspendReason: 'abuse' }), cronJobIds: ['backup-db'], runtimeUnits: units })
    expect(suspendLifecycle.stoppedUnits).toEqual(expect.arrayContaining([...units, 'xpanel-cron-alice-backup-db.timer', 'user-1001.slice']))
    expect(executor.units.get('xpanel-app-alice-api-web.service')?.active).toBe(false)

    await expect(adapter.enforceAccountLifecycleState({ account: makeAccount({ status: 'suspended', suspendReason: 'abuse' }), cronJobIds: [], runtimeUnits: ['xpanel-redis-bob.service'] })).rejects.toMatchObject({ code: 'VALIDATION' })

    const terminateLifecycle = await adapter.enforceAccountLifecycleState({ account: makeAccount({ status: 'terminating' }), cronJobIds: ['backup-db'], runtimeUnits: units, terminate: true })
    expect(terminateLifecycle.removedPaths).toEqual(expect.arrayContaining(['/etc/systemd/system/xpanel-app-alice-api-web.service', '/etc/xpanel/runtime/alice']))
    expect(await executor.readFile('/etc/xpanel/runtime/alice/api-web.env')).toBeNull()
    expect(await executor.readFile('/etc/systemd/system/xpanel-app-alice-api-web.service')).toBeNull()
  })
})
