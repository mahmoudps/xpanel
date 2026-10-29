import { describe, expect, it, vi } from 'vitest'
import { backupDestinationTargetDigest } from '../../../packages/core/src/backup-destination.ts'
import type { BackupDestinationTarget } from '../../../packages/core/src/backup-destination.ts'
import { createS3BackupProvider, readBackupCredentialFile, s3DestinationBinding, signS3Request } from './acct-backup-s3.ts'

const target: BackupDestinationTarget = { id: '11111111-1111-4111-8111-111111111111', name: 'Offsite', kind: 's3', endpoint: 'https://s3.example.test', bucket: 'tenant-backups', region: 'us-east-1', pathPrefix: '/xpanel/daily', username: null, retentionDays: 30, createdAt: '2026-10-01T00:00:00.000Z', credentialRef: 'offsite' }
const credential = { ref: 'offsite', label: 'Offsite key', kinds: ['s3'], accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }
const io = (content: unknown, stat: Partial<{ mode: number; uid: number; file: boolean; link: boolean }> = {}) => ({
  lstat: vi.fn(async () => ({ isFile: () => stat.file ?? true, isSymbolicLink: () => stat.link ?? false, mode: stat.mode ?? 0o100600, uid: stat.uid ?? 0, size: 100 })),
  readFile: vi.fn(async () => JSON.stringify(content)),
}) as never

describe('S3 signature version 4', () => {
  it('reproduces the AWS documented GET Object example signature', () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Object".
    const signed = signS3Request({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', headers: { Range: 'bytes=0-9' }, now: new Date('2013-05-24T00:00:00.000Z') })
    expect(signed.headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
    expect(signed.headers).not.toHaveProperty('host')
  })
  it('encodes and sorts query parameters for list requests', () => {
    const signed = signS3Request({ method: 'GET', host: 'h.test', path: '/b', query: [['prefix', 'xpanel/daily/'], ['list-type', '2']], region: 'r', accessKeyId: 'A'.repeat(16), secretAccessKey: 'S'.repeat(16), payloadSha256: 'e'.repeat(64), now: new Date() })
    expect(signed.query).toBe('list-type=2&prefix=xpanel%2Fdaily%2F')
  })
})

describe('backup credential file', () => {
  it('reads only a root-owned 0600 regular file and derives a rotating revision', async () => {
    const [stored] = await readBackupCredentialFile('/x', io({ version: 1, profiles: [credential] }))
    expect(stored!.profile).toMatchObject({ ref: 'offsite', kinds: ['s3'] })
    const [rotated] = await readBackupCredentialFile('/x', io({ version: 1, profiles: [{ ...credential, secretAccessKey: 'x'.repeat(40) }] }))
    expect(rotated!.profile.revision).not.toBe(stored!.profile.revision)
    for (const stat of [{ mode: 0o100640 }, { uid: 1000 }, { link: true }, { file: false }]) await expect(readBackupCredentialFile('/x', io({ version: 1, profiles: [credential] }, stat))).rejects.toThrow()
    await expect(readBackupCredentialFile('/x', io({ version: 1, profiles: [{ ...credential, kinds: ['sftp'] }] }))).rejects.toThrow()
    await expect(readBackupCredentialFile('/x', io({ version: 1, profiles: [{ ...credential, path: '/root/key' }] }))).rejects.toThrow()
  })
  it('treats a missing file as no profiles', async () => {
    const missing = { lstat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }, readFile: async () => '' } as never
    expect(await readBackupCredentialFile('/x', missing)).toEqual([])
  })
})

describe('confined S3 destination', () => {
  it('accepts only an HTTPS origin, a DNS bucket, a region and a segment prefix', () => {
    expect(s3DestinationBinding(target)).toEqual({ origin: 'https://s3.example.test', host: 's3.example.test', bucket: 'tenant-backups', region: 'us-east-1', prefix: 'xpanel/daily' })
    for (const change of [{ endpoint: 'http://s3.example.test' }, { endpoint: 'https://s3.example.test/other' }, { endpoint: 'https://u:p@s3.example.test' }, { bucket: 'Bad_Bucket' }, { region: null }, { pathPrefix: '/a/../b' }, { pathPrefix: '/' }, { kind: 'sftp' as const }])
      expect(() => s3DestinationBinding({ ...target, ...change })).toThrow()
  })
  const provider = (responses: Response[]) => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => responses.shift() ?? new Response(null, { status: 500 }))
    const credentials = async () => readBackupCredentialFile('/x', io({ version: 1, profiles: [credential] }))
    return { fetch, provider: createS3BackupProvider({ readDestination: async id => id === target.id ? target : null, readCredentials: credentials, fetch, now: () => new Date('2026-10-28T00:00:00.000Z') }), credentials }
  }
  const binding = async (credentials: () => Promise<{ profile: { revision: string } }[]>) => ({ destinationId: target.id, targetDigest: backupDestinationTargetDigest(target), credentialRef: 'offsite', credentialRevision: (await credentials())[0]!.profile.revision })
  it('opens only the current saved target and credential revision', async () => {
    const t = provider([])
    await expect(t.provider.open({ ...await binding(t.credentials), targetDigest: 'f'.repeat(64) }, AbortSignal.timeout(1000))).rejects.toThrow()
    await expect(t.provider.open({ ...await binding(t.credentials), credentialRevision: 'f'.repeat(64) }, AbortSignal.timeout(1000))).rejects.toThrow()
    const session = await t.provider.open(await binding(t.credentials), AbortSignal.timeout(1000))
    expect(session.binding).toMatchObject({ remote: true, confined: true, redirects: false })
  })
  it('signs confined path-style requests, refuses redirects and foreign names', async () => {
    const t = provider([new Response(null, { status: 200 })])
    const session = await t.provider.open(await binding(t.credentials), AbortSignal.timeout(1000))
    await session.putArchive('alice/xpanel-backup-alice-20261028T020000Z.tar.gz', { bytes: 3, sha256: 'a'.repeat(64), chunks: async function* () { yield new Uint8Array([1, 2, 3]) } }, AbortSignal.timeout(1000))
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe('https://s3.example.test/tenant-backups/xpanel/daily/alice/xpanel-backup-alice-20261028T020000Z.tar.gz')
    expect(init).toMatchObject({ method: 'PUT', redirect: 'error', duplex: 'half' })
    expect((init.headers as Record<string, string>)['content-length']).toBe('3')
    expect((init.headers as Record<string, string>)['x-amz-content-sha256']).toBe('a'.repeat(64))
    for (const name of ['../alice/x', 'alice/xpanel-backup-bob-20261028T020000Z.tar.gz', 'alice/secret.txt'])
      await expect(session.putArchive(name, { bytes: 1, sha256: 'a'.repeat(64), chunks: async function* () {} }, AbortSignal.timeout(1000))).rejects.toThrow()
    expect(t.fetch).toHaveBeenCalledTimes(1)
  })
  it('lists only xPanel archive names under the prefix across pages and treats 404 reads as absent', async () => {
    const page = (items: string, more: string) => new Response(`<ListBucketResult>${items}${more}</ListBucketResult>`, { status: 200 })
    const item = (key: string) => `<Contents><Key>${key}</Key><LastModified>2026-10-28T02:10:00.000Z</LastModified><Size>42</Size></Contents>`
    const t = provider([
      page(item('xpanel/daily/alice/xpanel-backup-alice-20261028T020000Z.tar.gz') + item('xpanel/daily/notes&amp;x.txt') + item('other/alice/xpanel-backup-alice-20261027T020000Z.tar.gz'), '<IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;1</NextContinuationToken>'),
      page(item('xpanel/daily/bob/xpanel-backup-bob-20261028T020000Z-0123456789ab.tar.gz'), '<IsTruncated>false</IsTruncated>'),
      new Response('missing', { status: 404 }),
    ])
    const session = await t.provider.open(await binding(t.credentials), AbortSignal.timeout(1000))
    expect(await session.listArchives(AbortSignal.timeout(1000))).toEqual([
      { name: 'alice/xpanel-backup-alice-20261028T020000Z.tar.gz', bytes: 42, lastModified: '2026-10-28T02:10:00.000Z' },
      { name: 'bob/xpanel-backup-bob-20261028T020000Z-0123456789ab.tar.gz', bytes: 42, lastModified: '2026-10-28T02:10:00.000Z' },
    ])
    expect(t.fetch.mock.calls[1]![0]).toContain('continuation-token=t%261')
    expect(await session.readArchive('alice/xpanel-backup-alice-20261028T020000Z.tar.gz', 10, AbortSignal.timeout(1000))).toBeNull()
  })
  it('bounds archive reads and reports provider errors without their bodies', async () => {
    const t = provider([new Response(new Uint8Array(20), { status: 200 }), new Response('<Error>secret</Error>', { status: 403 })])
    const session = await t.provider.open(await binding(t.credentials), AbortSignal.timeout(1000))
    const stream = await session.readArchive('alice/xpanel-backup-alice-20261028T020000Z.tar.gz', 10, AbortSignal.timeout(1000))
    await expect((async () => { for await (const _ of stream!) { /* drain */ } })()).rejects.toThrow('remote_response_limit')
    await expect(session.deleteArchive('alice/xpanel-backup-alice-20261028T020000Z.tar.gz', AbortSignal.timeout(1000))).rejects.toThrow('remote_status_403')
  })
})
