import { generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applicationDigest, readApplicationPath } from '../../../packages/os/src/application-artifact.ts'
import type { ApplicationArtifactDescriptor } from '../../../packages/os/src/application-artifact.ts'
import { applicationCatalogSigningBytes, verifyApplicationCatalog } from './application-catalog.ts'
import { ApplicationInstallCoordinator, readApplicationInstallation, recoverApplicationInstallations } from './application-install.ts'
import type { ApplicationDatabasePort, ApplicationInstallAction, ApplicationInstallDeps, ApplicationTarget } from './application-install.ts'
import { applicationInstanceKey, applicationRoot, createApplicationArtifactStore, createApplicationProvider, ownedApplications, readAccountApplications, readApplicationSummary } from './application-provider.ts'
import { APPLICATION_WORKER_SCRIPT, buildApplicationWorkerCommand, runApplicationWorker } from './application-worker.ts'
import type { ApplicationWorkerRun } from './application-worker.ts'
import type { HostJobPlan } from './host-job-contract.ts'

type Files = Record<string, string>
const bundle = (version: string, files: Files, setup: unknown = { database: false, config: null }) => {
  const names = Object.keys(files).sort()
  const header = JSON.stringify({ schemaVersion: 1, appId: 'sample', version, setup, files: names.map(path => ({ path, sha256: applicationDigest(files[path]!), bytes: Buffer.byteLength(files[path]!), mode: '0644' })) })
  const bytes = Buffer.from(header + '\n' + names.map(name => files[name]).join(''))
  const descriptor: ApplicationArtifactDescriptor = { format: 'xpanel-files-v1', sha256: applicationDigest(bytes), bytes: bytes.length }
  return { bytes, descriptor }
}
const TEMPLATE = "<?php $db='__XPANEL_DB_NAME__'; $user='__XPANEL_DB_USER__'; $pass='__XPANEL_DB_PASSWORD__'; $host='__XPANEL_DB_HOST__'; $salt='__XPANEL_SECRET_1__';"
const setup = { database: true, config: { path: 'config.php', template: 'config.sample' } }
const homes: string[] = []
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }) })

async function fixture(options: { path?: string; docRoot?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'w8-sites-')); homes.push(home)
  const artifacts = join(home, 'store'), account = join(home, 'home')
  await mkdir(artifacts); await mkdir(join(account, 'public_html'), { recursive: true })
  const key = generateKeyPairSync('ed25519'), policy = { now: new Date('2026-11-07T12:00:00.000Z'), minimumSequence: 1, panelVersion: '1.4.2' }
  const releases = {
    '1.0.0': bundle('1.0.0', { 'index.php': 'v1', 'lib/old.php': 'old', 'lib/keep.php': 'keep', 'config.sample': TEMPLATE }, setup),
    '2.0.0': bundle('2.0.0', { 'index.php': 'v2', 'lib/keep.php': 'keep', 'lib/new/added.php': 'added', 'config.sample': TEMPLATE }, setup),
    '3.0.0': bundle('3.0.0', { 'index.php': 'v3' }),
  }
  for (const release of Object.values(releases)) await writeFile(join(artifacts, release.descriptor.sha256), release.bytes)
  const payload = JSON.stringify({ schemaVersion: 1, sequence: 1, issuedAt: '2026-11-07T11:00:00.000Z', expiresAt: '2026-11-08T12:00:00.000Z', applications: [{ id: 'sample', name: 'Sample', releases: (['3.0.0', '2.0.0', '1.0.0'] as const).map(version => ({ version, minimumPanelVersion: '1.0.0', artifact: releases[version].descriptor })) }] })
  const catalog = verifyApplicationCatalog({ keyId: 'apps', payload, signature: sign(null, applicationCatalogSigningBytes(payload), key.privateKey).toString('hex') }, [{ keyId: 'apps', publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() }], policy)
  const calls: string[] = [], control = { failOp: null as string | null, kill: null as string | null }
  const worker: ApplicationWorkerRun = async (_target, request, payloadChunks, seconds) => {
    calls.push(String(request.op))
    if (control.failOp === request.op) throw new Error('worker stopped')
    const result = await runApplicationWorker(['python3', '-I', '-c', APPLICATION_WORKER_SCRIPT], account, request, payloadChunks, seconds)
    if (control.kill === request.op) throw new Error('reply lost')
    return result
  }
  const provider = createApplicationProvider({ worker, artifacts })
  const path = options.path ?? ''
  const target: ApplicationTarget = { accountId: '11111111-1111-4111-8111-111111111111', domainId: '22222222-2222-4222-8222-222222222222', domain: 'a.example', username: 'alice', home: '/home/alice', root: path ? 'public_html/' + path : 'public_html', path, uid: 2001, gid: 2001, identity: applicationDigest('identity') }
  const databases = { created: [] as string[], retired: [] as string[], discarded: [] as string[] }
  const database: ApplicationDatabasePort = {
    create: async (_target, name) => { databases.created.push(name.name); return { host: 'localhost', password: 'generated-password' } },
    retire: async (_target, name) => { databases.retired.push(name.name) },
    discard: async (_target, name) => { databases.discarded.push(name.name) },
  }
  const deps: ApplicationInstallDeps = { provider, database, catalog: async () => catalog, removalCatalog: async () => catalog, policy: () => policy, assertFresh: async () => target, assertAuthority: async () => {}, withAccountLease: (_lease, operation) => operation(target) }
  const coordinator = new ApplicationInstallCoordinator()
  const read = async () => (await readApplicationInstallation(deps)).observation!
  const job = async (action: ApplicationInstallAction, version?: string): Promise<{ ok: boolean; failed: string | null; plan: HostJobPlan }> => {
    const observed = await read()
    const prepared = await coordinator.prepare({ action, appId: 'sample', expectedRevision: observed.revision, expectedCatalogRevision: catalog.revision, ...(version ? { version } : {}) }, deps)
    const plan = prepared.plan
    let failed: string | null = null
    for (const step of plan.steps) {
      await plan.beforeStep?.(step)
      const result = await coordinator.run(step.argv, { timeoutMs: step.timeoutMs })
      if (!result.ok) { failed = step.id; break }
    }
    const verified = failed ? { ok: false } : await plan.verify!(coordinator.run)
    const finalized = await plan.finalize!(step => coordinator.run(step.argv, { timeoutMs: step.timeoutMs }), [])
    return { ok: !failed && verified.ok && finalized.ok, failed, plan }
  }
  const site = (name: string) => join(account, target.root, name)
  return { account, artifacts, target, control, calls, databases, deps, coordinator, read, job, site, catalog, releases }
}

describe('site application transactions as the account', () => {
  it('installs into a document root with its database and config, then updates, rolls back and removes', { tags: ['slow'] }, async () => {
    const t = await fixture()
    expect((await t.read()).empty).toBe(true)
    await writeFile(join(t.account, 'public_html', '.user.ini'), 'memory_limit=64M\n')
    expect((await t.read()).empty).toBe(true)

    expect(await t.job('install', '1.0.0')).toMatchObject({ ok: true, failed: null })
    expect(await readFile(t.site('index.php'), 'utf8')).toBe('v1')
    expect((await stat(t.site('index.php'))).mode & 0o777).toBe(0o644)
    const database = t.databases.created[0]!
    expect(database).toMatch(/^alice_app[0-9a-f]{8}$/)
    const config = await readFile(t.site('config.php'), 'utf8')
    expect(config).toContain(`$db='${database}'`); expect(config).toContain(`$user='${database}'`); expect(config).toContain("$pass='generated-password'"); expect(config).toContain("$host='localhost'")
    expect(config).not.toContain('__XPANEL_'); expect((await stat(t.site('config.php'))).mode & 0o777).toBe(0o640)
    const observed = await t.read()
    expect(observed.installation).toMatchObject({ appId: 'sample', version: '1.0.0', previous: null, database: { name: database, user: database }, config: 'config.php' })
    expect(observed).toMatchObject({ managedClean: true, recoveryRequired: false, empty: false })
    expect(await readdir(join(t.account, '.xpanel-apps', 'journal'))).toEqual([])

    await mkdir(t.site('lib/uploads')); await writeFile(t.site('lib/uploads/photo.jpg'), 'mine')
    await writeFile(t.site('config.php'), config + '// owner edit\n')
    expect((await t.job('update', '2.0.0')).ok).toBe(true)
    expect(await readFile(t.site('index.php'), 'utf8')).toBe('v2')
    await expect(stat(t.site('lib/old.php'))).rejects.toThrow()
    expect(await readFile(t.site('lib/new/added.php'), 'utf8')).toBe('added')
    expect(await readFile(t.site('lib/uploads/photo.jpg'), 'utf8')).toBe('mine')
    expect(await readFile(t.site('config.php'), 'utf8')).toContain('owner edit')
    expect((await t.read()).installation).toMatchObject({ version: '2.0.0', previous: { version: '1.0.0' }, database: { name: database } })

    expect((await t.job('rollback')).ok).toBe(true)
    expect(await readFile(t.site('index.php'), 'utf8')).toBe('v1')
    expect(await readFile(t.site('lib/old.php'), 'utf8')).toBe('old')
    await expect(stat(t.site('lib/new/added.php'))).rejects.toThrow()

    expect((await t.job('remove')).ok).toBe(true)
    await expect(stat(t.site('index.php'))).rejects.toThrow()
    await expect(stat(t.site('config.php'))).rejects.toThrow()
    expect(await readFile(t.site('lib/uploads/photo.jpg'), 'utf8')).toBe('mine')
    expect(t.databases.retired).toEqual([database])
    expect((await t.read()).installation).toBeNull()
  })

  it('installs under a path, creating the directory, and lists the record for its account only', async () => {
    const t = await fixture({ path: 'blog/en' })
    expect((await t.job('install', '3.0.0')).ok).toBe(true)
    expect(await readFile(join(t.account, 'public_html/blog/en/index.php'), 'utf8')).toBe('v3')
    expect(t.databases.created).toEqual([])
    const account = { id: t.target.accountId, home: t.account, uid: process.getuid!() }
    const records = await readAccountApplications(account)
    expect(records).toMatchObject([{ domain: 'a.example', path: 'blog/en', appId: 'sample', version: '3.0.0', previousVersion: null, database: null, config: null }])
    const domain = { id: t.target.domainId, accountId: t.target.accountId, name: 'a.example', docRoot: t.account + '/public_html' }
    expect(ownedApplications(account, [domain as never], records)).toHaveLength(1)
    expect(ownedApplications(account, [{ ...domain, accountId: 'other' } as never], records)).toEqual([])
    expect(await readAccountApplications({ ...account, uid: account.uid + 1 })).toEqual([])
  })

  it('refuses an occupied directory, a colliding file and edited files, and removal still works on edits', async () => {
    const t = await fixture()
    await writeFile(t.site('index.html'), 'mine')
    await expect(t.job('install', '3.0.0')).rejects.toMatchObject({ detail: { reason: 'application_target_not_empty', stateChanged: false } })
    await unlink(t.site('index.html'))
    expect((await t.job('install', '3.0.0')).ok).toBe(true)
    await writeFile(t.site('index.php'), 'edited')
    expect((await t.read()).managedClean).toBe(false)
    await expect(t.job('rollback')).rejects.toMatchObject({ detail: { stateChanged: false } })
    expect((await t.job('remove')).ok).toBe(true)
    await expect(stat(t.site('index.php'))).rejects.toThrow()
  })

  it('never follows a link the site planted, in the root or under it', async () => {
    const t = await fixture({ path: 'blog' })
    const outside = join(t.account, 'outside'); await mkdir(outside)
    await symlink(outside, join(t.account, 'public_html/blog'))
    await expect(t.job('install', '3.0.0')).rejects.toMatchObject({ detail: { reason: 'application_path_conflict' } })
    expect(await readdir(outside)).toEqual([])
    const u = await fixture({ path: 'site' })
    await mkdir(join(u.account, 'public_html/site'))
    await symlink(outside, join(u.account, 'public_html/site/lib'))
    await expect(u.job('install', '1.0.0')).rejects.toMatchObject({ detail: { reason: 'application_target_not_empty' } })
    await unlink(join(u.account, 'public_html/site/lib'))
    expect((await u.job('install', '1.0.0')).ok).toBe(true)
    await rm(join(u.account, 'public_html/site/lib'), { recursive: true })
    await symlink(outside, join(u.account, 'public_html/site/lib'))
    await expect(u.job('update', '2.0.0')).rejects.toMatchObject({ detail: { reason: 'application_files_modified' } })
    expect(await readdir(outside)).toEqual([])
  })

  it('restores the exact prior state after a failed apply, a failed readback or a full disk, and discards the new database', { tags: ['slow'] }, async () => {
    const t = await fixture()
    const before = await t.read()
    t.control.failOp = 'commit'
    const result = await t.job('install', '1.0.0')
    expect(result).toMatchObject({ ok: false, failed: 'commit' })
    expect(await t.read()).toEqual(before)
    expect(t.databases.discarded).toEqual(t.databases.created)
    expect(await readdir(join(t.account, 'public_html'))).toEqual([])

    t.control.failOp = null
    expect((await t.job('install', '1.0.0')).ok).toBe(true)
    await mkdir(t.site('lib/own')); await writeFile(t.site('lib/own/keep.txt'), 'mine')
    const installed = await t.read()
    t.control.kill = 'apply'
    expect(await t.job('update', '2.0.0')).toMatchObject({ ok: false, failed: 'apply' })
    expect(await t.read()).toEqual(installed)
    expect(await readFile(t.site('lib/old.php'), 'utf8')).toBe('old')
    await expect(stat(t.site('lib/new'))).rejects.toThrow()
    expect(await readFile(t.site('lib/own/keep.txt'), 'utf8')).toBe('mine')
    t.control.kill = null
    await chmod(t.site('lib'), 0o555)
    const refused = await t.job('update', '2.0.0')
    await chmod(t.site('lib'), 0o755)
    expect(refused).toMatchObject({ ok: false })
    expect(await t.read()).toEqual(installed)
  })

  it('recovers a journal left by a lost process, on either side of the commit', async () => {
    const t = await fixture()
    expect((await t.job('install', '1.0.0')).ok).toBe(true)
    const installed = await t.read()
    const lost = new ApplicationInstallCoordinator()
    const prepared = await lost.prepare({ action: 'update', appId: 'sample', version: '2.0.0', expectedRevision: installed.revision, expectedCatalogRevision: t.catalog.revision }, t.deps)
    for (const step of prepared.plan.steps.slice(0, 3)) expect((await lost.run(step.argv, { timeoutMs: step.timeoutMs })).ok).toBe(true)
    expect(await readFile(t.site('index.php'), 'utf8')).toBe('v2')
    const stranded = await t.read()
    expect(stranded.recoveryRequired).toBe(true)
    await expect(t.job('update', '2.0.0')).rejects.toMatchObject({ detail: { reason: 'application_recovery_required' } })
    expect(await recoverApplicationInstallations(t.deps)).toMatchObject([{ state: 'restored', verified: true }])
    expect(await t.read()).toEqual(installed)
    expect(await recoverApplicationInstallations(t.deps)).toEqual([])

    const again = new ApplicationInstallCoordinator()
    const next = await again.prepare({ action: 'update', appId: 'sample', version: '2.0.0', expectedRevision: installed.revision, expectedCatalogRevision: t.catalog.revision }, t.deps)
    for (const step of next.plan.steps.slice(0, 3)) expect((await again.run(step.argv, { timeoutMs: step.timeoutMs })).ok).toBe(true)
    await rm(join(t.account, '.xpanel-apps/instances'), { recursive: true })
    await mkdir(join(t.account, '.xpanel-apps/instances'))
    const key = applicationInstanceKey(t.target.root), journal = join(t.account, '.xpanel-apps/journal', key)
    await writeFile(join(t.account, '.xpanel-apps/instances', key + '.json'), await readFile(join(journal, 'next.json')))
    expect(await recoverApplicationInstallations(t.deps)).toMatchObject([{ state: 'committed', verified: true }])
    expect((await t.read()).installation).toMatchObject({ version: '2.0.0', previous: { version: '1.0.0' } })
  })

  it('stops recovery rather than overwrite a file someone else wrote during the transaction', async () => {
    const t = await fixture()
    expect((await t.job('install', '1.0.0')).ok).toBe(true)
    const installed = await t.read()
    const lost = new ApplicationInstallCoordinator()
    const prepared = await lost.prepare({ action: 'update', appId: 'sample', version: '2.0.0', expectedRevision: installed.revision, expectedCatalogRevision: t.catalog.revision }, t.deps)
    for (const step of prepared.plan.steps.slice(0, 2)) expect((await lost.run(step.argv, { timeoutMs: step.timeoutMs })).ok).toBe(true)
    await writeFile(t.site('index.php'), 'concurrent')
    expect(await recoverApplicationInstallations(t.deps)).toMatchObject([{ state: 'unknown', verified: false }])
    expect(await readFile(t.site('index.php'), 'utf8')).toBe('concurrent')
    expect((await t.read()).recoveryRequired).toBe(true)
  })

  it('names a missing or corrupt artifact before any job exists', async () => {
    const t = await fixture()
    await rm(join(t.artifacts, t.releases['3.0.0'].descriptor.sha256))
    await expect(t.job('install', '3.0.0')).rejects.toMatchObject({ detail: { stateChanged: false, reason: 'application_artifact_missing' } })
    await writeFile(join(t.artifacts, t.releases['1.0.0'].descriptor.sha256), Buffer.alloc(t.releases['1.0.0'].bytes.length))
    await expect(t.job('install', '1.0.0')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await readdir(join(t.account, 'public_html'))).toEqual([])
  })

  it('needs a database port only for an application that declares a database', async () => {
    const t = await fixture()
    const deps = { ...t.deps, database: null }
    const observed = await t.read()
    await expect(t.coordinator.prepare({ action: 'install', appId: 'sample', version: '1.0.0', expectedRevision: observed.revision, expectedCatalogRevision: t.catalog.revision }, deps)).rejects.toMatchObject({ detail: { reason: 'application_database_unavailable' } })
  })
})

describe('a snapshot that stopped before its journal', () => {
  it('reads as locked and clears when recovery lists the target', async () => {
    const t = await fixture()
    const stray = join(t.account, '.xpanel-apps/journal', applicationInstanceKey(t.target.root))
    await mkdir(stray, { recursive: true })
    expect((await t.read()).recoveryRequired).toBe(true)
    expect(await recoverApplicationInstallations(t.deps)).toEqual([])
    expect((await t.read()).recoveryRequired).toBe(false)
  })
})

describe('application paths and records', () => {
  it('keeps the path under the document root and away from reserved directories', () => {
    expect(readApplicationPath('')).toBe(''); expect(readApplicationPath(undefined)).toBe(''); expect(readApplicationPath('blog/en')).toBe('blog/en')
    for (const bad of ['/etc', '../x', 'a/../b', 'cgi-bin', '.well-known/x', 'CGI-BIN/a', '.git', 'a b', 7]) expect(() => readApplicationPath(bad)).toThrow()
    expect(applicationRoot({ home: '/home/alice' }, { docRoot: '/home/alice/public_html' }, 'blog')).toBe('public_html/blog')
    expect(applicationRoot({ home: '/home/alice' }, { docRoot: '/home/alice/sites/a.example/' }, '')).toBe('sites/a.example')
    expect(() => applicationRoot({ home: '/home/alice' }, { docRoot: '/var/www/html' }, '')).toThrow()
    expect(() => applicationRoot({ home: '/home/alice' }, { docRoot: '/home/alicex/public_html' }, '')).toThrow()
  })
  it('reads a summary as untrusted input', () => {
    const row = { schemaVersion: 1, domain: 'a.example', path: '', appId: 'sample', version: '1.0.0', previousVersion: null, artifactSha256: 'a'.repeat(64), database: null, config: null, updatedAt: '2026-11-07T12:00:00.000Z' }
    expect(readApplicationSummary(JSON.stringify(row), 'k')).toMatchObject({ appId: 'sample', key: 'k' })
    for (const bad of [{ ...row, path: '../x' }, { ...row, database: { name: 'root', user: 'root' } }, { ...row, version: 'x' }, { ...row, config: '/etc/passwd' }]) expect(readApplicationSummary(JSON.stringify(bad), 'k')).toBeNull()
    expect(readApplicationSummary('not json', 'k')).toBeNull()
  })
  it('runs the worker as a jailed unit bound below the stage deadline, with the script as data', () => {
    const argv = buildApplicationWorkerCommand({ username: 'alice', uid: 2001, gid: 2001, home: '/home/alice' }, 50)
    expect(argv[0]).toBe('/usr/bin/systemd-run')
    for (const value of ['User=alice', 'BindPaths=/home/alice', 'NoNewPrivileges=yes', 'RuntimeMaxSec=50s', 'MemoryMax=128M']) expect(argv).toContain(value)
    expect(argv.slice(-3)).toEqual(['-I', '-c', APPLICATION_WORKER_SCRIPT])
  })
})

describe('application artifact store', () => {
  it('stores a release only when the whole file matches its signed digest, and offset 0 starts over', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'w8-sites-')); homes.push(directory)
    const store = createApplicationArtifactStore(directory), { bytes, descriptor } = bundle('1.0.0', { 'index.php': 'x'.repeat(4096) })
    const half = Math.floor(bytes.length / 2)
    expect(await store.append(descriptor, 'sample', '1.0.0', 0, bytes.subarray(0, half))).toEqual({ received: half, complete: false })
    await expect(store.append(descriptor, 'sample', '1.0.0', half + 1, bytes.subarray(half))).rejects.toMatchObject({ code: 'CONFLICT', detail: { received: half } })
    expect(await store.append(descriptor, 'sample', '1.0.0', 0, bytes.subarray(0, half))).toEqual({ received: half, complete: false })
    expect(await store.has(descriptor.sha256)).toBe(false)
    expect(await store.append(descriptor, 'sample', '1.0.0', half, bytes.subarray(half))).toEqual({ received: bytes.length, complete: true })
    expect(await store.has(descriptor.sha256)).toBe(true)
    expect(await readFile(join(directory, descriptor.sha256))).toEqual(bytes)
    const { descriptor: other, bytes: otherBytes } = bundle('1.0.1', { 'index.php': 'y' })
    await expect(store.append(other, 'sample', '1.0.1', 0, Buffer.alloc(otherBytes.length))).rejects.toMatchObject({ detail: { reason: 'application_artifact_invalid' } })
    expect(await store.has(other.sha256)).toBe(false)
    await expect(store.append(other, 'sample', '1.0.1', 0, Buffer.alloc(otherBytes.length + 1))).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
