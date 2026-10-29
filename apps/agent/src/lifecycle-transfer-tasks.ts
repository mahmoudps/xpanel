import { spawn } from 'node:child_process'
import { constants, createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { request } from 'node:https'
import type { RequestOptions } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { posix } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Database } from '@xpanel/core'
import { readCpanelArchive } from '@xpanel/lifecycle'
import type { Body, ImportPlan, ImportSink, SinkItem } from '@xpanel/lifecycle'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StoredCertificate } from '@xpanel/state'

/**
 * Account transfer and cPanel import host work: one task at a time, every command at the lowest CPU and IO
 * priority, results kept in a root-only ledger file. The API orchestrates the desired state; these tasks move
 * and restore the bytes. A task that was running when the agent stopped reads back as interrupted.
 */
export const TRANSFER_TASK_ROOT = '/var/lib/xpanel/transfers'
export const TRANSFER_TASK_TIMEOUT_MS = 2 * 60 * 60_000
export const MAX_TRANSFER_ARTIFACT_BYTES = 50 * 1024 ** 3
export const TRANSFER_SSH_KEY = '/root/.ssh/xpanel_transfer_ed25519'
const LOW_PRIORITY = ['/usr/bin/nice', '-n', '19', '/usr/bin/ionice', '-c', '2', '-n', '7']
const MAX_TASKS = 200
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{64}$/
const ARTIFACT = /^(?:home\.tar\.gz|db-[a-z][a-z0-9]{0,15}_[A-Za-z0-9_]{1,48}\.sql|(?:cert|key)-[0-9]{1,3}\.pem)$/
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/
const TLS_FINGERPRINT = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/

export type TransferTaskKind = 'package' | 'fetch' | 'restore' | 'cpanel-fetch' | 'cpanel-inspect' | 'cpanel-restore'
export type TransferTaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
export interface TransferTask {
  id: string
  kind: TransferTaskKind
  username: string
  state: TransferTaskState
  createdAt: string
  updatedAt: string
  owner: string
  result: Record<string, unknown> | null
  error: string | null
}
export interface TransferArtifact { name: string; bytes: number; sha256: string }
export interface TransferCommand { argv: string[]; asUser?: string; stdoutFile?: string; stdinFile?: string }
export interface TransferCommandResult { code: number; stdout: string; stderr: string }
export type TransferCommandRunner = (command: TransferCommand) => Promise<TransferCommandResult>
/** HTTPS GET with the source's Bearer token, TLS pinned when a fingerprint is saved; no redirects. */
export type TransferDownload = (input: { url: string; token: string; tlsFingerprint: string | null }) => Promise<AsyncIterable<Uint8Array>>

export interface TransferTaskDeps {
  root?: string
  /** where a home archive is staged for the account user to read; /run/xpanel/account-restores */
  restoreStaging?: string
  /** desired-state root; uploaded cPanel archives live under <stateRoot>/extended/transfers/cpanel */
  stateRoot: string
  store: {
    getAccountByUsername(username: string): Promise<Account | null>
    readSnapshot(): Promise<{ databases: Database[]; certificates: StoredCertificate[]; domains: { accountId: string; name: string }[] }>
  }
  run: TransferCommandRunner
  download?: TransferDownload
  mariadb: { adminDefaultsFile: string; mariadbBinary: string; mariadbDumpBinary: string; verifyAdminConfig(): Promise<void>; verifyDatabaseObjects(database: string, username: string): Promise<{ tables: unknown[] }> }
  /** installManualCertificate bound to the host executor; returns the candidate files' metadata. */
  installCertificate: (account: Account, domain: string, fullchainPem: string, privateKeyPem: string) => Promise<{ certificate: Record<string, unknown> }>
  now?: () => Date
}

const message = (error: unknown): string => (isXpanelError(error) || error instanceof Error ? error.message : 'task failed').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (what: string): never => fail('VALIDATION', what, { stateChanged: false })

/** Child process runner: fixed PATH, no shell, stdout/stdin as files, bounded output, two hour bound. */
/** The argv actually spawned: as the account user when asked, always at nice 19 and best-effort IO priority 7. */
export const lowPriorityArgv = (command: TransferCommand): string[] => [...(command.asUser ? ['/usr/sbin/runuser', '-u', command.asUser, '--'] : []), ...LOW_PRIORITY, ...command.argv]

export const spawnTransferCommand = (timeoutMs = TRANSFER_TASK_TIMEOUT_MS): TransferCommandRunner => async (command) => {
  const argv = lowPriorityArgv(command)
  const stdout = command.stdoutFile ? await open(command.stdoutFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) : null
  const stdin = command.stdinFile ? await open(command.stdinFile, constants.O_RDONLY | constants.O_NOFOLLOW) : null
  try {
    return await new Promise<TransferCommandResult>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: [stdin ? stdin.fd : 'ignore', stdout ? stdout.fd : 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' }, timeout: timeoutMs })
      let out = '', err = ''
      child.stdout?.on('data', (chunk: Buffer) => { if (out.length < 1024 * 1024) out += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { if (err.length < 64 * 1024) err += chunk.toString('utf8') })
      child.once('error', reject)
      child.once('close', code => resolve({ code: code ?? 1, stdout: out, stderr: err.trim().slice(0, 2000) }))
    })
  } finally { await stdout?.close(); await stdin?.close() }
}

/**
 * Node https; with a saved pin the certificate is accepted only by its SHA-256 fingerprint and the socket reaches
 * the request (and the token) only after it matched. Without one the system CA store applies. No redirects.
 */
export const httpsTransferDownload: TransferDownload = ({ url, token, tlsFingerprint }) => new Promise((resolve, reject) => {
  const target = new URL(url)
  if (target.protocol !== 'https:') return reject(new Error('the source must be https'))
  const req = request(target, { method: 'GET', agent: false, timeout: 120_000, headers: { authorization: 'Bearer ' + token, accept: 'application/octet-stream' },
    ...(tlsFingerprint ? {
      createConnection: (_options: unknown, done: (error: Error | null, socket?: TLSSocket) => void) => {
        const socket = tlsConnect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 443), ...(/^[\d.]+$|:/.test(target.hostname) ? {} : { servername: target.hostname }), rejectUnauthorized: false })
        socket.once('secureConnect', () => { if (socket.getPeerCertificate()?.fingerprint256 === tlsFingerprint) done(null, socket); else { socket.destroy(); done(new Error('the source certificate does not match the pinned fingerprint')) } })
        socket.once('error', error => done(error))
        return undefined
      },
    } : {}) } as RequestOptions, response => {
    if (response.statusCode !== 200) { response.resume(); return reject(new Error('the source refused the download (' + String(response.statusCode) + ')')) }
    resolve(response)
  })
  req.once('timeout', () => req.destroy(new Error('the source stopped responding')))
  req.once('error', reject)
  req.end()
})

const writeNew = async (path: string, data: string | Buffer): Promise<void> => {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(data) } finally { await handle.close() }
}

const sha256File = async (path: string): Promise<TransferArtifact> => {
  const hash = createHash('sha256')
  let bytes = 0
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += (chunk as Buffer).byteLength; hash.update(chunk as Buffer) } }
  finally { await handle.close() }
  return { name: posix.basename(path), bytes, sha256: hash.digest('hex') }
}

/** Streams into a new root-only file; the size and digest must match exactly or the file is removed. */
const storeVerified = async (path: string, chunks: AsyncIterable<Uint8Array>, expected: TransferArtifact): Promise<void> => {
  const output = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const hash = createHash('sha256')
  let bytes = 0, ok = false
  try {
    for await (const chunk of chunks) {
      bytes += chunk.byteLength
      if (bytes > expected.bytes) fail('PRECONDITION_FAILED', expected.name + ' is larger than its signed size')
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) offset += (await output.write(chunk.subarray(offset))).bytesWritten
    }
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) fail('PRECONDITION_FAILED', expected.name + ' does not match its signed size and SHA-256')
    await output.sync()
    ok = true
  } finally {
    await output.close()
    if (!ok) await rm(path, { force: true })
  }
}

/** The parser may stop at the end-of-archive marker before EOF; the file handle is closed either way. */
const readArchive = async (path: string, options: Parameters<typeof readCpanelArchive>[1]): Promise<ImportPlan> => {
  const stream = createReadStream(path)
  try { return await readCpanelArchive(stream, options) } finally { stream.destroy() }
}

/** tar member names must stay inside the extraction directory. */
export const assertTarMembers = (listing: string): void => {
  for (const raw of listing.split('\n')) {
    const member = raw.trim()
    if (member && (member.startsWith('/') || member.split('/').includes('..') || member.includes('\\'))) fail('VALIDATION', 'the archive contains a path outside the account home')
  }
}

/** GNU tar --compare lines that mean the restored home is not the archived one (owner and mode follow the new account). */
export const tarCompareProblems = (stdout: string): string[] =>
  stdout.split('\n').map(line => line.trim()).filter(line => /: (?:Contents differ|Size differs|File type differs|Symlink differs|Not linked to|Warning: Cannot stat)|Cannot stat: No such file/.test(line)).slice(0, 20)

export function createTransferTaskController(deps: TransferTaskDeps) {
  const root = deps.root ?? TRANSFER_TASK_ROOT
  const ledgerPath = posix.join(root, 'tasks.json')
  const owner = randomUUID()
  const now = (): string => (deps.now?.() ?? new Date()).toISOString()
  let tasks: TransferTask[] | null = null
  let queue: Promise<void> = Promise.resolve()
  let writes: Promise<void> = Promise.resolve()

  const load = async (): Promise<TransferTask[]> => {
    if (tasks) return tasks
    const raw = await readJsonIfExists<unknown>(ledgerPath)
    const list = Array.isArray(raw) ? raw.filter((task): task is TransferTask => object(task) && typeof task.id === 'string' && UUID.test(task.id)) : []
    // a task this process did not start cannot still be running
    for (const task of list) if (task.state === 'queued' || task.state === 'running') Object.assign(task, { state: 'interrupted', error: 'the agent restarted during this task; nothing more ran', updatedAt: now() })
    tasks = list
    return tasks
  }
  const persist = async (): Promise<void> => {
    const next = writes.then(async () => {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const list = await load()
      if (list.length > MAX_TASKS) list.splice(0, list.length - MAX_TASKS)
      await atomicWriteJson(ledgerPath, list, 0o600)
    })
    writes = next.catch(() => undefined)
    await next
  }
  const update = async (task: TransferTask, patch: Partial<TransferTask>): Promise<void> => { Object.assign(task, patch, { updatedAt: now() }); await persist() }

  const submit = async (kind: TransferTaskKind, username: string, work: (task: TransferTask) => Promise<Record<string, unknown>>): Promise<TransferTask> => {
    const list = await load()
    const task: TransferTask = { id: randomUUID(), kind, username, state: 'queued', createdAt: now(), updatedAt: now(), owner, result: null, error: null }
    list.push(task)
    await persist()
    // serial: one transfer task runs at a time on this host
    queue = queue.then(async () => {
      await update(task, { state: 'running' })
      try { await update(task, { state: 'succeeded', result: await work(task) }) }
      catch (error) { await update(task, { state: 'failed', error: message(error) }).catch(() => undefined) }
    })
    return structuredClone(task)
  }
  const find = async (id: string): Promise<TransferTask> => (await load()).find(task => task.id === id) ?? fail('NOT_FOUND', 'transfer task not found', { stateChanged: false })
  const succeeded = async (id: string, kind: TransferTaskKind): Promise<TransferTask> => {
    const task = await find(id)
    if (task.kind !== kind || task.state !== 'succeeded') fail('PRECONDITION_FAILED', 'the ' + kind + ' task has not succeeded', { stateChanged: false })
    return task
  }
  const accountOf = async (username: string): Promise<Account> => {
    const account = await deps.store.getAccountByUsername(username)
    if (!account || account.username !== username || account.status === 'terminating') return fail('NOT_FOUND', 'account not found', { stateChanged: false })
    if (account.home !== '/home/' + username) fail('PRECONDITION_FAILED', 'the account home is not the expected directory')
    return account
  }
  const taskDir = async (...parts: string[]): Promise<string> => {
    const dir = posix.join(root, ...parts)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return dir
  }
  const ok = (result: TransferCommandResult, what: string, accept: readonly number[] = [0]): TransferCommandResult =>
    accept.includes(result.code) ? result : fail('CONFIG_TEST_FAILED', what + ' failed: ' + (result.stderr || 'exit ' + result.code).slice(0, 300))
  const dumpArgv = (database: string): string[] => [deps.mariadb.mariadbDumpBinary, '--defaults-extra-file=' + deps.mariadb.adminDefaultsFile, '--single-transaction', '--routines', '--triggers', '--events', '--hex-blob', '--default-character-set=utf8mb4', '--no-create-db', '--', database]
  const restoreDatabase = async (account: Account, path: string, database: string): Promise<number> => {
    if (!database.startsWith(account.username + '_')) fail('VALIDATION', 'a restored database must belong to the account')
    ok(await deps.run({ argv: [deps.mariadb.mariadbBinary, '--defaults-extra-file=' + deps.mariadb.adminDefaultsFile, '--default-character-set=utf8mb4', '--database=' + database], stdinFile: path }), 'restore of ' + database)
    return (await deps.mariadb.verifyDatabaseObjects(database, account.username)).tables.length
  }

  /** Extracts a home archive as the account user, then compares the result with the archive (content, size, type, links). */
  const restoreHome = async (account: Account, archive: string): Promise<{ compared: true }> => {
    const listed = ok(await deps.run({ argv: ['/usr/bin/tar', '--list', '--gzip', '--file=' + archive] }), 'reading the home archive')
    assertTarMembers(listed.stdout)
    const stagingRoot = deps.restoreStaging ?? '/run/xpanel/account-restores'
    const staging = posix.join(stagingRoot, account.username)
    await mkdir(stagingRoot, { recursive: true, mode: 0o711 })
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { mode: 0o710 })
    const copy = posix.join(staging, randomUUID() + '.tar.gz')
    try {
      ok(await deps.run({ argv: ['/usr/bin/install', '-m', '0640', '-o', 'root', '-g', account.username, '--', archive, copy] }), 'staging the home archive')
      ok(await deps.run({ argv: ['/bin/chgrp', account.username, '--', staging] }), 'staging the home archive')
      ok(await deps.run({ asUser: account.username, argv: ['/usr/bin/tar', '--extract', '--gzip', '--file=' + copy, '--directory=' + account.home, '--no-same-owner', '--no-overwrite-dir'] }), 'extracting the home')
      const compared = await deps.run({ asUser: account.username, argv: ['/usr/bin/tar', '--compare', '--gzip', '--file=' + copy, '--directory=' + account.home] })
      if (compared.code > 1) fail('CONFIG_TEST_FAILED', 'the restored home could not be compared with the archive')
      const problems = tarCompareProblems(compared.stdout)
      if (problems.length) fail('PRECONDITION_FAILED', 'the restored home differs from the archive: ' + problems.join('; ').slice(0, 300))
      return { compared: true }
    } finally { await rm(staging, { recursive: true, force: true }) }
  }

  /** Source: the home (mail included) as the account user, each MariaDB database and each account certificate. */
  const packageAccount = async (task: TransferTask): Promise<Record<string, unknown>> => {
    const account = await accountOf(task.username)
    const snapshot = await deps.store.readSnapshot()
    const dir = await taskDir('source', task.id)
    const databases = snapshot.databases.filter(db => db.accountId === account.id && db.engine === 'mariadb' && db.trashedAt === null)
    ok(await deps.run({ asUser: account.username, argv: ['/usr/bin/tar', '--create', '--gzip', '--directory=' + account.home, '--exclude=./.xpanel-backup-*', '--', '.'], stdoutFile: posix.join(dir, 'home.tar.gz') }), 'archiving the home', [0, 1])
    if (databases.length) await deps.mariadb.verifyAdminConfig()
    for (const db of databases) ok(await deps.run({ argv: dumpArgv(db.name), stdoutFile: posix.join(dir, 'db-' + db.name + '.sql') }), 'dump of ' + db.name)
    const certificates: { id: string; names: string[]; cert: string; key: string }[] = []
    for (const [index, cert] of snapshot.certificates.filter(row => row.accountId === account.id).entries()) {
      const pem = Buffer.concat([await readFile(cert.certPath), ...(cert.chainPath && cert.chainPath !== cert.certPath ? [Buffer.from('\n'), await readFile(cert.chainPath)] : [])])
      await writeNew(posix.join(dir, 'cert-' + index + '.pem'), pem)
      await writeNew(posix.join(dir, 'key-' + index + '.pem'), await readFile(cert.keyPath))
      certificates.push({ id: cert.id, names: [...cert.names], cert: 'cert-' + index + '.pem', key: 'key-' + index + '.pem' })
    }
    const artifacts: TransferArtifact[] = []
    for (const name of (await readdir(dir)).sort()) if (ARTIFACT.test(name)) artifacts.push(await sha256File(posix.join(dir, name)))
    return { artifacts, databases: databases.map(db => ({ name: db.name, artifact: 'db-' + db.name + '.sql' })), certificates }
  }

  const fetchArtifacts = async (task: TransferTask, input: { url: string; token: string; tlsFingerprint: string | null; artifacts: TransferArtifact[] }): Promise<Record<string, unknown>> => {
    const download = deps.download ?? httpsTransferDownload
    const dir = await taskDir('incoming', task.id)
    for (const artifact of input.artifacts) await storeVerified(posix.join(dir, artifact.name), await download({ url: input.url + '/' + artifact.name, token: input.token, tlsFingerprint: input.tlsFingerprint }), artifact)
    return { artifacts: input.artifacts, bytes: input.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) }
  }

  const restore = async (task: TransferTask, input: { fetch: string; databases: { artifact: string; target: string }[]; certificates: { cert: string; key: string; domain: string }[] }): Promise<Record<string, unknown>> => {
    const account = await accountOf(task.username)
    const fetched = await succeeded(input.fetch, 'fetch')
    const dir = posix.join(root, 'incoming', fetched.id)
    const listed = new Set(((fetched.result?.artifacts ?? []) as TransferArtifact[]).map(artifact => artifact.name))
    const result: { home: unknown; databases: { name: string; tables: number }[]; certificates: Record<string, unknown>[] } = { home: null, databases: [], certificates: [] }
    if (!listed.has('home.tar.gz')) fail('PRECONDITION_FAILED', 'the transfer package has no home archive')
    result.home = await restoreHome(account, posix.join(dir, 'home.tar.gz'))
    if (input.databases.length) await deps.mariadb.verifyAdminConfig()
    for (const db of input.databases) {
      if (!listed.has(db.artifact)) fail('PRECONDITION_FAILED', db.artifact + ' is not part of the transfer package')
      result.databases.push({ name: db.target, tables: await restoreDatabase(account, posix.join(dir, db.artifact), db.target) })
    }
    for (const cert of input.certificates) {
      if (!listed.has(cert.cert) || !listed.has(cert.key)) fail('PRECONDITION_FAILED', 'a certificate is not part of the transfer package')
      const installed = await deps.installCertificate(account, cert.domain, await readFile(posix.join(dir, cert.cert), 'utf8'), await readFile(posix.join(dir, cert.key), 'utf8'))
      result.certificates.push({ ...installed.certificate, domain: cert.domain })
    }
    await rm(dir, { recursive: true, force: true })
    return result
  }

  const cpanelArchivePath = async (archive: string): Promise<string> => {
    if (!UUID.test(archive)) invalid('invalid archive reference')
    for (const path of [posix.join(root, 'cpanel', archive + '.tar.gz'), posix.join(deps.stateRoot, 'extended', 'transfers', 'cpanel', archive + '.tar.gz')]) {
      const info = await lstat(path).catch(() => null)
      if (info?.isFile()) return path
    }
    return fail('NOT_FOUND', 'the cPanel archive is not on this server', { stateChanged: false })
  }

  /** Pulls `pkgacct` output over SSH with the transfer key and a pinned host key; the archive is digested on both ends. */
  const cpanelFetch = async (task: TransferTask, input: { host: string; port: number; hostKeyFingerprint: string; cpanelUser: string }): Promise<Record<string, unknown>> => {
    const dir = await taskDir('cpanel')
    const knownHosts = posix.join(dir, task.id + '.known_hosts')
    const scanned = ok(await deps.run({ argv: ['/usr/bin/ssh-keyscan', '-p', String(input.port), '-t', 'ed25519,ecdsa,rsa', '--', input.host] }), 'reading the source host key')
    const lines = scanned.stdout.split('\n').filter(line => line && !line.startsWith('#'))
    const keyFile = posix.join(dir, task.id + '.scan')
    await writeNew(keyFile, lines.join('\n') + '\n')
    const fingerprints = ok(await deps.run({ argv: ['/usr/bin/ssh-keygen', '-l', '-E', 'sha256', '-f', keyFile] }), 'fingerprinting the source host key').stdout
    const pinned = lines.filter((_line, index) => fingerprints.split('\n')[index]?.split(' ')[1] === input.hostKeyFingerprint)
    await rm(keyFile, { force: true })
    if (!pinned.length) fail('FORBIDDEN', 'the source SSH host key does not match the pinned fingerprint')
    await writeNew(knownHosts, pinned.join('\n') + '\n')
    const ssh = (...remote: string[]): string[] => ['/usr/bin/ssh', '-i', TRANSFER_SSH_KEY, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + knownHosts, '-p', String(input.port), '--', 'root@' + input.host, ...remote]
    const remoteDir = '/root/xpanel-transfer-' + task.id
    const remoteFile = remoteDir + '/cpmove-' + input.cpanelUser + '.tar.gz'
    const file = posix.join(dir, task.id + '.tar.gz')
    try {
      ok(await deps.run({ argv: ssh('/usr/bin/mkdir', '-m', '0700', remoteDir) }), 'preparing the cPanel export directory')
      ok(await deps.run({ argv: ssh('/usr/local/cpanel/scripts/pkgacct', '--skipbwdata', input.cpanelUser, remoteDir) }), 'cPanel pkgacct')
      const remoteSum = ok(await deps.run({ argv: ssh('/usr/bin/sha256sum', '--', remoteFile) }), 'digesting the cPanel archive').stdout.trim().split(/\s+/)[0] ?? ''
      ok(await deps.run({ argv: ssh('/usr/bin/cat', '--', remoteFile), stdoutFile: file }), 'copying the cPanel archive')
      const local = await sha256File(file)
      if (!SHA.test(remoteSum) || local.sha256 !== remoteSum) { await rm(file, { force: true }); fail('PRECONDITION_FAILED', 'the copied cPanel archive does not match the source digest') }
      return { archive: task.id, bytes: local.bytes, sha256: local.sha256 }
    } finally {
      await deps.run({ argv: ssh('/usr/bin/rm', '-rf', '--', remoteDir) }).catch(() => undefined)
      await rm(knownHosts, { force: true })
    }
  }

  const cpanelInspect = async (input: { archive: string; targetUsername?: string; ipv4?: string }): Promise<Record<string, unknown>> => {
    const path = await cpanelArchivePath(input.archive)
    const digest = await sha256File(path)
    const plan = await readArchive(path, { ...(input.targetUsername ? { targetUsername: input.targetUsername } : {}), ...(input.ipv4 ? { ipv4: input.ipv4 } : {}), limits: { maxEntries: 500_000, maxTotalBytes: MAX_TRANSFER_ARTIFACT_BYTES }, now: deps.now?.() ?? new Date() })
    return { archive: input.archive, bytes: digest.bytes, sha256: digest.sha256, plan: publicPlan(plan) }
  }

  /** Re-reads the archive into a root-only staging tree, then restores the home as the account user and loads each SQL dump. */
  const cpanelRestore = async (task: TransferTask, input: { archive: string; sha256: string; targetUsername: string; ipv4?: string; databases: { sourceName: string; target: string }[]; certificates: { index: number; domain: string }[] }): Promise<Record<string, unknown>> => {
    const account = await accountOf(task.username)
    const path = await cpanelArchivePath(input.archive)
    const stage = await taskDir('cpanel-stage', task.id)
    try {
      const sink = new StagingSink(stage)
      const plan = await readArchive(path, { targetUsername: input.targetUsername, ...(input.ipv4 ? { ipv4: input.ipv4 } : {}), sink, limits: { maxEntries: 500_000, maxTotalBytes: MAX_TRANSFER_ARTIFACT_BYTES }, now: deps.now?.() ?? new Date() })
      if ((await sha256File(path)).sha256 !== input.sha256) fail('CONFLICT', 'the cPanel archive changed since it was reviewed')
      const home = posix.join(stage, 'home.tar.gz')
      ok(await deps.run({ argv: ['/usr/bin/tar', '--create', '--gzip', '--file=' + home, '--directory=' + posix.join(stage, 'home'), '--', '.'] }), 'packing the staged home')
      const result: { home: unknown; databases: { name: string; tables: number }[]; certificates: Record<string, unknown>[] } = { home: await restoreHome(account, home), databases: [], certificates: [] }
      if (input.databases.length) await deps.mariadb.verifyAdminConfig()
      for (const db of input.databases) {
        const ref = plan.databases.find(item => item.sourceName === db.sourceName)?.sql.ref ?? fail('PRECONDITION_FAILED', 'the archive has no dump for ' + db.sourceName)
        result.databases.push({ name: db.target, tables: await restoreDatabase(account, ref, db.target) })
      }
      for (const cert of input.certificates) {
        const chosen = plan.certificates[cert.index]
        const certRef = chosen?.cert.ref ?? fail('PRECONDITION_FAILED', 'the archive certificate is incomplete'), keyRef = chosen?.key?.ref ?? fail('PRECONDITION_FAILED', 'the archive certificate key is missing')
        const installed = await deps.installCertificate(account, cert.domain, await readFile(certRef, 'utf8'), await readFile(keyRef, 'utf8'))
        result.certificates.push({ ...installed.certificate, domain: cert.domain })
      }
      return result
    } finally { await rm(stage, { recursive: true, force: true }) }
  }

  const start = async (body: Record<string, unknown>): Promise<TransferTask> => {
    const text = (key: string, max = 255): string => typeof body[key] === 'string' && (body[key] as string).length <= max ? body[key] as string : invalid('invalid ' + key)
    const username = (key: string): string => USERNAME.test(String(body[key])) ? body[key] as string : invalid('invalid ' + key)
    const keys = (allowed: string[]): void => { if (Object.keys(body).some(key => !allowed.includes(key))) invalid('unsupported transfer task fields') }
    switch (body.kind) {
      case 'package': keys(['kind', 'username']); await accountOf(username('username')); return submit('package', username('username'), packageAccount)
      case 'fetch': {
        keys(['kind', 'username', 'url', 'token', 'tlsFingerprint', 'artifacts'])
        const url = new URL(text('url', 2048))
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) invalid('the package url must be https without credentials')
        const token = text('token', 256), fp = body.tlsFingerprint ?? null
        if (fp !== null && (typeof fp !== 'string' || !TLS_FINGERPRINT.test(fp))) invalid('invalid TLS fingerprint')
        const artifacts = parseArtifacts(body.artifacts)
        return submit('fetch', username('username'), task => fetchArtifacts(task, { url: url.href.replace(/\/+$/, ''), token, tlsFingerprint: fp as string | null, artifacts }))
      }
      case 'restore': {
        keys(['kind', 'username', 'fetch', 'databases', 'certificates'])
        const fetchId = UUID.test(String(body.fetch)) ? body.fetch as string : invalid('invalid fetch task')
        const databases = list(body.databases).map(item => object(item) && ARTIFACT.test(String(item.artifact)) && typeof item.target === 'string' && /^[a-z][a-z0-9]{0,15}_[A-Za-z0-9_]{1,48}$/.test(item.target) ? { artifact: item.artifact as string, target: item.target } : invalid('invalid database mapping'))
        const certificates = list(body.certificates).map(item => object(item) && ARTIFACT.test(String(item.cert)) && ARTIFACT.test(String(item.key)) && typeof item.domain === 'string' && item.domain.length <= 253 ? { cert: item.cert as string, key: item.key as string, domain: item.domain } : invalid('invalid certificate mapping'))
        await accountOf(username('username'))
        return submit('restore', username('username'), task => restore(task, { fetch: fetchId, databases, certificates }))
      }
      case 'cpanel-fetch': {
        keys(['kind', 'username', 'host', 'port', 'hostKeyFingerprint'])
        const host = text('host', 253)
        if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^\d{1,3}(?:\.\d{1,3}){3}$/i.test(host)) invalid('invalid source host')
        const port = Number.isInteger(body.port) && (body.port as number) > 0 && (body.port as number) < 65536 ? body.port as number : invalid('invalid ssh port')
        const fingerprint = SSH_FINGERPRINT.test(String(body.hostKeyFingerprint)) ? body.hostKeyFingerprint as string : invalid('a pinned SHA256 host key fingerprint is required')
        const user = username('username')
        return submit('cpanel-fetch', user, task => cpanelFetch(task, { host, port, hostKeyFingerprint: fingerprint, cpanelUser: user }))
      }
      case 'cpanel-inspect': {
        keys(['kind', 'archive', 'targetUsername', 'ipv4'])
        const archive = text('archive', 36), target = body.targetUsername === undefined ? undefined : username('targetUsername'), ipv4 = body.ipv4 === undefined ? undefined : text('ipv4', 15)
        await cpanelArchivePath(archive)
        return submit('cpanel-inspect', target ?? 'cpanel', () => cpanelInspect({ archive, ...(target ? { targetUsername: target } : {}), ...(ipv4 ? { ipv4 } : {}) }))
      }
      case 'cpanel-restore': {
        keys(['kind', 'username', 'archive', 'sha256', 'ipv4', 'databases', 'certificates'])
        const archive = text('archive', 36), sha256 = SHA.test(String(body.sha256)) ? body.sha256 as string : invalid('invalid archive digest'), ipv4 = body.ipv4 === undefined ? undefined : text('ipv4', 15)
        const databases = list(body.databases).map(item => object(item) && typeof item.sourceName === 'string' && item.sourceName.length <= 64 && typeof item.target === 'string' && /^[a-z][a-z0-9]{0,15}_[A-Za-z0-9_]{1,48}$/.test(item.target) ? { sourceName: item.sourceName, target: item.target } : invalid('invalid database mapping'))
        const certificates = list(body.certificates).map(item => object(item) && Number.isInteger(item.index) && (item.index as number) >= 0 && typeof item.domain === 'string' ? { index: item.index as number, domain: item.domain } : invalid('invalid certificate mapping'))
        const user = username('username')
        await accountOf(user)
        await cpanelArchivePath(archive)
        return submit('cpanel-restore', user, task => cpanelRestore(task, { archive, sha256, targetUsername: user, ...(ipv4 ? { ipv4 } : {}), databases, certificates }))
      }
      default: return invalid('unknown transfer task kind')
    }
  }

  return {
    start,
    get: async (id: string): Promise<TransferTask> => structuredClone(await find(id)),
    /** Removes a package or incoming directory once the orchestrator no longer needs it. */
    discard: async (id: string): Promise<void> => {
      const task = await find(id)
      if (task.state === 'running' || task.state === 'queued') fail('CONFLICT', 'the task is still running', { stateChanged: false })
      await rm(posix.join(root, 'source', task.id), { recursive: true, force: true })
      await rm(posix.join(root, 'incoming', task.id), { recursive: true, force: true })
      await rm(posix.join(root, 'cpanel', task.id + '.tar.gz'), { force: true })
    },
    /** A packaged artifact for the source API to stream; only names the package task listed. */
    openArtifact: async (id: string, name: string): Promise<{ path: string; bytes: number }> => {
      const task = await succeeded(id, 'package')
      const artifact = ((task.result?.artifacts ?? []) as TransferArtifact[]).find(item => item.name === name)
      if (!artifact || !ARTIFACT.test(name)) return fail('NOT_FOUND', 'artifact not found', { stateChanged: false })
      return { path: posix.join(root, 'source', task.id, name), bytes: artifact.bytes }
    },
    /** The transfer public key, created on first use; the private key never leaves this server. */
    sshKey: async (): Promise<{ publicKey: string; fingerprint: string }> => {
      if (!(await lstat(TRANSFER_SSH_KEY).catch(() => null))) {
        await mkdir('/root/.ssh', { recursive: true, mode: 0o700 })
        ok(await deps.run({ argv: ['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'xpanel-transfer', '-f', TRANSFER_SSH_KEY] }), 'creating the transfer key')
      }
      const publicKey = (await readFile(TRANSFER_SSH_KEY + '.pub', 'utf8')).trim()
      const fingerprint = ok(await deps.run({ argv: ['/usr/bin/ssh-keygen', '-l', '-E', 'sha256', '-f', TRANSFER_SSH_KEY + '.pub'] }), 'fingerprinting the transfer key').stdout.split(' ')[1] ?? ''
      return { publicKey, fingerprint }
    },
  }
}
export type TransferTaskController = ReturnType<typeof createTransferTaskController>

const list = (value: unknown): unknown[] => Array.isArray(value) && value.length <= 1000 ? value : invalid('a bounded list is required')
const parseArtifacts = (value: unknown): TransferArtifact[] => {
  const artifacts = list(value).map(item => object(item) && typeof item.name === 'string' && ARTIFACT.test(item.name) && Number.isSafeInteger(item.bytes) && (item.bytes as number) >= 0 && (item.bytes as number) <= MAX_TRANSFER_ARTIFACT_BYTES && typeof item.sha256 === 'string' && SHA.test(item.sha256)
    ? { name: item.name, bytes: item.bytes as number, sha256: item.sha256 } : invalid('invalid artifact list'))
  if (new Set(artifacts.map(item => item.name)).size !== artifacts.length) invalid('duplicate artifact')
  return artifacts
}

/** The parsed plan without staging references: what root reviews. */
export const publicPlan = (plan: ImportPlan): Record<string, unknown> => ({
  ...plan,
  databases: plan.databases.map(db => ({ sourceName: db.sourceName, name: db.name, bytes: db.sql.size })),
  certificates: plan.certificates.map(cert => ({ names: cert.names, notAfter: cert.notAfter, hasKey: cert.key !== null })),
})

/**
 * Writes accepted archive content into a root-only tree: home/<path>, sql/<name>, ssl/<n>. Every file is a
 * new file (O_EXCL, no links followed); symlinks and hardlinks stay inside the tree because the archive guard
 * already refused anything that would leave it.
 */
export class StagingSink implements ImportSink {
  private counter = 0
  private readonly root: string
  constructor(root: string) { this.root = root }
  async put(item: SinkItem, body: Body): Promise<string | null> {
    const part = item.part === 'home' || item.part === 'mail' ? 'home' : item.part === 'sql' ? 'sql' : 'ssl'
    const rel = part === 'ssl' ? String(++this.counter) + '.pem' : item.path
    if (rel.startsWith('/') || rel.split('/').includes('..')) fail('VALIDATION', 'unsafe staged path')
    const target = posix.join(this.root, part, rel)
    await mkdir(posix.dirname(target), { recursive: true, mode: 0o700 })
    if (item.type === 'directory') { await mkdir(target, { recursive: true, mode: (item.mode & 0o777) | 0o700 }); for await (const _ of body) { /* drain */ } return target }
    if (item.type === 'symlink') { await symlink(item.linkTarget ?? '', target); for await (const _ of body) { /* drain */ } return target }
    if (item.type === 'hardlink') { await link(posix.join(this.root, part, item.linkTarget ?? ''), target); for await (const _ of body) { /* drain */ } return target }
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, (item.mode & 0o777) | 0o600)
    try { for await (const chunk of body) { let offset = 0; while (offset < chunk.byteLength) offset += (await output.write(chunk.subarray(offset))).bytesWritten } }
    finally { await output.close() }
    return target
  }
}

const ROUTE = /^\/transfers\/(?:tasks(?:\/([0-9a-f-]{36}))?|packages\/([0-9a-f-]{36})\/([^/]+)|ssh-key)$/
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/**
 * Root-only host routes: POST /transfers/tasks (202), GET|DELETE /transfers/tasks/<id>, GET /transfers/packages/<id>/<artifact>
 * (a packaged artifact for the source API to stream) and GET /transfers/ssh-key (the transfer public key).
 */
export async function handleTransferTaskRoute(req: Request, url: URL, method: string, deps: { authorize: (action: string) => Promise<void>; controller: TransferTaskController | null }): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (url.search) return invalid('transfer routes accept no selectors')
  const [, taskId, packageId, artifact] = match
  const allowed = url.pathname === '/transfers/tasks' ? ['POST'] : taskId ? ['GET', 'DELETE'] : ['GET']
  if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
  await deps.authorize('transfer.task.' + method.toLowerCase())
  const controller = deps.controller ?? fail('PRECONDITION_FAILED', 'account transfers need the Linux host executor and the MariaDB admin credential', { stateChanged: false })
  if (url.pathname === '/transfers/ssh-key') return json(await controller.sshKey())
  if (packageId) {
    let name: string
    try { name = decodeURIComponent(artifact!) } catch { return invalid('invalid artifact name') }
    const file = await controller.openArtifact(packageId.toLowerCase(), name)
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size !== file.bytes) { await handle.close(); return fail('PRECONDITION_FAILED', 'the packaged artifact changed', { stateChanged: false }) }
    const stream = handle.readableWebStream() as unknown as ReadableStream<Uint8Array>
    return new Response(stream, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.bytes), 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }
  if (taskId && method === 'GET') return json({ task: await controller.get(taskId.toLowerCase()) })
  if (taskId) { await controller.discard(taskId.toLowerCase()); return json({ discarded: true }) }
  if (req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return invalid('a JSON task body is required')
  const body = await req.json().catch(() => null) as unknown
  if (!object(body)) return invalid('a JSON task body is required')
  return json({ task: await controller.start(body) }, 202)
}
