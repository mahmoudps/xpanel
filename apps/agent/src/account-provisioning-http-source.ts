import { constants } from 'node:fs'
import { lstat, open, opendir, readFile, readlink, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { posix } from 'node:path'
import { fail, type Account, type OsProfile } from '@xpanel/core'
import { latestActive, withVisibleReadonlyOperationDatabase, type Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { edge, system } from '@xpanel/render'
import { ACCOUNT_PROBE_ASSET, ACCOUNT_PROBE_PHP, accountProbeNamespace, accountProbePaths, assertAccountProbeIngress } from '../../../packages/render/src/system/account-probe.ts'
import { openNativeProvisioningProcess, parseProvisioningProcessFiles, unitIdentityShowArgv, type ProvisioningProcessIdentity } from './account-provisioning-observer.ts'
import { createRuntimeHost, readUnitStates } from './account-runtime.ts'
import type { AgentExecutor } from './executor.ts'
import type { HostEffectAuthority } from './host-effect-authority.ts'
import type { HostReconciler } from './reconciler.ts'
import type { KernelPeerCredentials } from './peer-identity.ts'

/** Facts only. The actual provisioning/lifecycle caller separately supplies and rechecks current authority. */
export interface NativeAccountHttpSubject {
  readonly account: Account
  readonly sourceChecksum: string
  readonly binding: string
  readonly challenge: string
}
export interface NativeProvisioningHttpOptions {
  /** A pinned read-only operation database or an explicit live-reader port; never the writable handle. */
  readonly db: Db
  /** Trusted startup composition of the pinned read-only reader; when present it replaces `db` for every read. */
  readonly databaseReader?: { readonly database: () => Db }
  readonly store: Pick<StateStore, 'listDomains'>
  readonly reconciler: Pick<HostReconciler, 'journal'>
  readonly executor: AgentExecutor
  readonly os: OsProfile
}
const refused: (reason: string) => never = reason => fail('PRECONDITION_FAILED', 'the protected account HTTP source was not verified', { verificationRequired: true, reason })
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const safePath = (path: string): boolean => path.startsWith('/') && posix.normalize(path) === path && !/[\u0000-\u0020\u007f\\]/.test(path)
export interface HeldHttpConnection {
  readonly fd: number
  readonly localAddress: string
  readonly localPort: number
  readonly remoteAddress: string
  readonly remotePort: number
}
const tcpEndpoint = (address: string, port: number): string => {
  const bytes = address.split('.')
  if (bytes.length !== 4 || bytes.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)
    || !Number.isSafeInteger(port) || port < 1 || port > 65535) return refused('ipv4_http_connection_required')
  return bytes.reverse().map(part => Number(part).toString(16).padStart(2, '0')).join('').toUpperCase() + ':' + port.toString(16).padStart(4, '0').toUpperCase()
}
/** Exact live loopback TCP pair only; table data is kernel input, never response/self-reported identity. */
export function canaryHttpPeerInode(table: string, clientInode: string, connection: HeldHttpConnection): string {
  if (table.length > 2097152 || !/^[1-9][0-9]{0,19}$/.test(clientInode) || BigInt(clientInode) > 18446744073709551615n) return refused('kernel_tcp_table_invalid')
  const lines = table.trim().split('\n'), header = lines.shift()
  if (header === undefined || !/^\s*sl\s+local_address\s+rem_address\s+st\b/.test(header) || lines.length > 8192) return refused('kernel_tcp_table_invalid')
  const local = tcpEndpoint(connection.localAddress, connection.localPort), remote = tcpEndpoint(connection.remoteAddress, connection.remotePort)
  const clients: string[] = [], peers: string[] = []
  for (const line of lines) {
    const fields = line.trim().split(/\s+/), source = fields[1], target = fields[2], state = fields[3], inode = fields[9]
    if (fields.length < 10 || source === undefined || target === undefined || state === undefined || inode === undefined
      || !/^[A-F0-9]{8}:[A-F0-9]{4}$/.test(source) || !/^[A-F0-9]{8}:[A-F0-9]{4}$/.test(target) || !/^[A-F0-9]{2}$/.test(state)
      || !/^[0-9]{1,20}$/.test(inode) || BigInt(inode) > 18446744073709551615n) return refused('kernel_tcp_table_invalid')
    if (state !== '01') continue
    if (source === local && target === remote && inode === clientInode) clients.push(inode)
    if (source === remote && target === local && inode !== '0') peers.push(inode)
  }
  const peer = peers[0]
  if (clients.length !== 1 || peers.length !== 1 || peer === undefined || peer === clientInode) return refused('kernel_http_peer_not_unique')
  return peer
}
async function readKernelTcpTable(): Promise<string> {
  const handle = await open('/proc/self/net/tcp', constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const parts: Buffer[] = []; let size = 0
    for (;;) {
      const bytes = Buffer.alloc(8192), result = await handle.read(bytes, 0, bytes.length, null)
      if (!result.bytesRead) break
      size += result.bytesRead
      if (size > 2097152) refused('kernel_tcp_table_limit')
      parts.push(bytes.subarray(0, result.bytesRead))
    }
    return Buffer.concat(parts).toString('ascii')
  } finally { await handle.close() }
}
async function assertHttpPeerOwnedByNginx(pid: number, connection: HeldHttpConnection, guard: () => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(connection.fd) || connection.fd < 0) refused('http_client_fd_invalid')
  const target = await readlink('/proc/self/fd/' + connection.fd), match = /^socket:\[([1-9][0-9]{0,19})\]$/.exec(target)
  const clientInode = match?.[1]
  if (clientInode === undefined) refused('http_client_fd_changed')
  const peerInode = canaryHttpPeerInode(await readKernelTcpTable(), clientInode, connection); await guard()
  const name = '/proc/' + pid + '/fd', directory = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const original = await directory.stat(), held = '/proc/self/fd/' + directory.fd
    const entries = await opendir(held, { bufferSize: 32 })
    try {
      let found: string | undefined
      for (let count = 0; count <= 4096; count++) {
        const entry = await entries.read()
        if (!entry) break
        if (count === 4096) refused('nginx_fd_observation_limit')
        if (count % 32 === 0) await guard()
        if (!/^[0-9]+$/.test(entry.name)) continue
        let value: string
        try { value = await readlink(held + '/' + entry.name) }
        catch (error) { if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue; throw error }
        if (value === 'socket:[' + peerInode + ']') { found = entry.name; break }
      }
      if (found === undefined) refused('http_frontend_is_not_the_nginx_ingress_process')
      const [current, named, peer, client] = await Promise.all([directory.stat(), lstat(name), readlink(held + '/' + found), readlink('/proc/self/fd/' + connection.fd)])
      if (!current.isDirectory() || !named.isDirectory() || !sameNode(original, current) || !sameNode(original, named)
        || peer !== 'socket:[' + peerInode + ']' || client !== target || canaryHttpPeerInode(await readKernelTcpTable(), clientInode, connection) !== peerInode) refused('held_http_frontend_changed')
      await guard()
    } finally { await entries.close() }
  } finally { await directory.close() }
}
interface Pin { assertCurrent(): Promise<void>; close(): Promise<void> }
interface PinnedFile extends Pin { readonly text: string; readonly dev: number; readonly ino: number }
const sameNode = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean => a.dev === b.dev && a.ino === b.ino

/** Finite native source paths only. Each existing ancestor must remain Root-owned and non-writable by others. */
async function protectedParents(path: string): Promise<void> {
  if (!safePath(path)) refused('unsafe_source_path')
  const parts = posix.dirname(path).split('/').filter(Boolean)
  let parent = ''
  for (const part of parts) {
    parent += '/' + part
    const entry = await lstat(parent)
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0) refused('unprotected_source_ancestor')
  }
}
async function pinFile(path: string, expectedSha?: string, expectedMode?: number, expectedGid?: number, maxBytes = 1048576): Promise<PinnedFile> {
  await protectedParents(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const initial = await handle.stat()
    if (!initial.isFile() || initial.uid !== 0 || (initial.mode & 0o022) !== 0 || initial.size > maxBytes || (expectedGid !== undefined && initial.gid !== expectedGid)
      || (expectedMode !== undefined && (initial.mode & 0o7777) !== expectedMode)) refused('unprotected_source_file')
    const read = async (): Promise<Buffer> => {
      const bytes = Buffer.alloc(initial.size + 1); let position = 0
      while (position < bytes.length) {
        const result = await handle.read(bytes, position, bytes.length - position, position)
        if (result.bytesRead === 0) break
        position += result.bytesRead
      }
      if (position !== initial.size) return refused('source_size_changed')
      return bytes.subarray(0, position)
    }
    const original = await read(), digest = sha(original)
    if (expectedSha !== undefined && digest !== expectedSha) refused('source_digest_mismatch')
    const assertCurrent = async (): Promise<void> => {
      await protectedParents(path)
      const [held, named, resolved] = await Promise.all([handle.stat(), lstat(path), realpath(path)])
      if (!held.isFile() || !named.isFile() || named.isSymbolicLink() || resolved !== path || !sameNode(initial, held) || !sameNode(initial, named)
        || held.uid !== 0 || named.uid !== 0 || held.gid !== initial.gid || named.gid !== initial.gid || held.size !== initial.size || named.size !== initial.size
        || held.ctimeMs !== initial.ctimeMs || named.ctimeMs !== initial.ctimeMs || held.mtimeMs !== initial.mtimeMs || named.mtimeMs !== initial.mtimeMs
        || (held.mode & 0o7777) !== (initial.mode & 0o7777) || (named.mode & 0o7777) !== (initial.mode & 0o7777)
        || (maxBytes <= 1048576 && sha(await read()) !== digest)) refused('source_file_changed')
    }
    await assertCurrent()
    return { text: maxBytes <= 1048576 ? original.toString('utf8') : '', dev: initial.dev, ino: initial.ino, assertCurrent, close: () => handle.close() }
  } catch (error) { await handle.close(); throw error }
}
async function pinDirectory(path: string, mode: number): Promise<Pin & { readonly dev: number; readonly ino: number }> {
  await protectedParents(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const initial = await handle.stat()
    const assertCurrent = async (): Promise<void> => {
      await protectedParents(path)
      const [held, named, resolved] = await Promise.all([handle.stat(), lstat(path), realpath(path)])
      if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || resolved !== path
        || !sameNode(initial, held) || !sameNode(initial, named) || held.uid !== 0 || named.uid !== 0
        || held.gid !== 0 || named.gid !== 0 || (held.mode & 0o7777) !== mode || (named.mode & 0o7777) !== mode) refused('protected_directory_changed')
    }
    await assertCurrent()
    return { dev: initial.dev, ino: initial.ino, assertCurrent, close: () => handle.close() }
  } catch (error) { await handle.close(); throw error }
}
const readIdentity = async (pid: number, files: Awaited<ReturnType<typeof openNativeProvisioningProcess>>): Promise<ProvisioningProcessIdentity> => {
  const [stat, status, cgroup] = await Promise.all([files.read('stat'), files.read('status'), files.read('cgroup')])
  return parseProvisioningProcessFiles(pid, { stat, status, cgroup })
}
export const sameProvisioningProcess = (a: ProvisioningProcessIdentity, b: ProvisioningProcessIdentity): boolean =>
  a.pid === b.pid && a.parentPid === b.parentPid && a.startTime === b.startTime && a.cgroup === b.cgroup
  && a.uids.every((id, i) => id === b.uids[i]) && a.gids.every((id, i) => id === b.gids[i])
  && !['Z', 'X', 'x'].includes(a.state) && !['Z', 'X', 'x'].includes(b.state)

export interface HeldCanarySource extends Pin {
  readonly account: Account
  readonly unit: string
  readonly mainPid: number
  readonly nginxUid: number
  readonly nginxGid: number
  readonly backendSocket: string
  /** Peer and namespace checks only; callers follow them with one assertCurrent of the whole source. */
  assertIngressPeer(peer: KernelPeerCredentials, connection: HeldHttpConnection): Promise<void>
  assertBackendPeer(peer: KernelPeerCredentials): Promise<void>
  assertWorkerNamespace(worker: ProvisioningProcessIdentity): Promise<void>
}

/** Concrete composition of the existing generation, unit and proc readers; no caller paths or verification booleans. */
export async function captureCanarySource(options: NativeProvisioningHttpOptions, input: NativeAccountHttpSubject, context: HostEffectAuthority): Promise<HeldCanarySource> {
  const account = input.account, pins: Pin[] = []
  let domainDeadline = Infinity
  const guard = async (): Promise<void> => {
    if (Date.now() >= domainDeadline) refused('primary_fpm_domain_expired')
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0 || context.readOnly !== true || context.signal.aborted) refused('native_read_authority_required')
    await context.assertAuthority()
    if (context.signal.aborted || Date.now() >= domainDeadline) refused('native_read_authority_or_domain_deadline')
  }
  // Every read below is an observation without effects. Authority is checked at the boundaries of each
  // observation unit, not after every read: each check re-reads the whole operation authority.
  const retain = async <T extends Pin>(work: Promise<T>): Promise<T> => { const held = await work; pins.push(held); return held }
  await guard()
  if (![input.sourceChecksum, input.binding, input.challenge].every(value => /^[a-f0-9]{64}$/.test(value))
    || account.status !== 'active' || account.bandwidthLimitedMonth !== undefined
    || !Object.values(networkInterfaces()).flat().some(address => address?.family === 'IPv4' && address.address === account.ipv4)) refused('account_http_binding_unavailable')
  try {
    const domains = await options.store.listDomains({ accountId: account.id }); await guard()
    const primary = domains.filter(domain => domain.accountId === account.id && domain.name === account.primaryDomain && domain.kind === 'primary')
    const domain = primary[0]
    if (primary.length !== 1 || domain === undefined || domain.siteType !== 'php' || domain.php.handler !== 'fpm' || domain.suspended
      || (domain.expiresAt !== null && (!Number.isFinite(Date.parse(domain.expiresAt)) || Date.parse(domain.expiresAt) <= Date.now()))) refused('primary_fpm_route_required')
    domainDeadline = domain.expiresAt === null ? Infinity : Date.parse(domain.expiresAt)
    const unit = system.fpmUnitName(account.username, domain.php.version), paths = accountProbePaths(account)
    const reader = options.databaseReader?.database() ?? options.db
    const active = await withVisibleReadonlyOperationDatabase(reader, () => latestActive(reader)); await guard()
    if (!active || active.status !== 'active') return refused('active_generation_required')
    const manifest = await options.reconciler.journal.readManifest(active.id); await guard()
    if (!manifest || manifest.generationId !== active.id || manifest.filesChecksum !== active.checksum || manifest.stateChecksum !== input.sourceChecksum) refused('active_generation_binding_changed')
    const activeId = active.id, generationChecksum = active.checksum
    const owned = async (path: string, accountReadable = false): Promise<PinnedFile> => {
      const matches = manifest.files.filter(file => file.path === path), entry = matches[0]
      if (matches.length !== 1 || !entry || entry.owner !== 'root' || (entry.group !== 'root' && !(accountReadable && entry.group === account.username))
        || !/^[a-f0-9]{64}$/.test(entry.sha256)) return refused('canary_source_not_owned_by_generation')
      return retain(pinFile(path, entry.sha256, entry.mode, entry.group === 'root' ? 0 : account.gid))
    }
    const asset = await owned(ACCOUNT_PROBE_ASSET)
    if (asset.text !== ACCOUNT_PROBE_PHP) refused('release_canary_source_changed')
    const runtime = await retain(pinDirectory(paths.runtime, 0o711))
    const unitFile = await owned(options.os.paths.systemdDir + '/' + unit)
    if (accountProbeNamespace(account).some(line => unitFile.text.split('\n').filter(actual => actual === line).length !== 1)) refused('canary_namespace_not_configured')
    await owned(edge.fpmMasterConfPath(account.username, domain.php.version), true)
    await owned(edge.fpmPoolConfPath(account.username, domain.php.version), true)
    const vhost = await owned(options.os.paths.nginxVhostDir + '/xpanel-' + account.username + '.conf')
    assertAccountProbeIngress(vhost.text, account)
    const nginxMainFile = await owned(options.os.paths.nginxRoot + '/nginx.conf')
    if (/(?:^|[;\r\n{}])\s*(?:rewrite|auth_request|mirror|error_page|[A-Za-z_]*by_lua[A-Za-z_]*|js_[A-Za-z_]+|perl)(?=\s|;)/.test(nginxMainFile.text)) refused('scripted_global_ingress_unsupported')
    const passwd = await retain(pinFile('/etc/passwd')), workers = passwd.text.split('\n').filter(line => line.startsWith(options.os.paths.nginxUser + ':'))
    const fields = workers[0]?.split(':'), nginxUid = Number(fields?.[2]), nginxGid = Number(fields?.[3])
    if (workers.length !== 1 || !Number.isSafeInteger(nginxUid) || nginxUid < 1 || !Number.isSafeInteger(nginxGid) || nginxGid < 1) refused('nginx_worker_identity_unavailable')
    const nginxUnit = options.os.services.nginx.endsWith('.service') ? options.os.services.nginx : options.os.services.nginx + '.service'
    const unitIdentity = async (name: string): Promise<{ mainPid: number; cgroup: string }> => {
      const states = await readUnitStates(createRuntimeHost(options.executor), [name])
      if (states.get(name)?.load !== 'loaded' || states.get(name)?.active !== 'active') return refused('canary_unit_inactive')
      const result = await options.executor.runCommand(unitIdentityShowArgv(name))
      const values = new Map<string, string>()
      for (const line of result.stdout.trim().split('\n')) {
        const at = line.indexOf('=')
        if (at < 1 || values.has(line.slice(0, at))) refused('ambiguous_canary_unit_identity')
        values.set(line.slice(0, at), line.slice(at + 1))
      }
      const mainPid = Number(values.get('MainPID')), cgroup = values.get('ControlGroup')
      if (!result.ok || result.code !== 0 || result.stderr.trim() || values.size !== 6 || values.get('Id') !== name || values.get('ActiveState') !== 'active'
        || !Number.isSafeInteger(mainPid) || mainPid < 2 || cgroup === undefined || !safePath(cgroup)) return refused('canary_unit_identity_unavailable')
      if (name === unit && (values.get('User') !== account.username || values.get('Group') !== account.username
        || cgroup !== '/xpanel.slice/' + system.accountSliceName(account.uid) + '/' + unit)) return refused('fpm_unit_account_mismatch')
      return { mainPid, cgroup }
    }
    const fpm = await unitIdentity(unit), nginx = await unitIdentity(nginxUnit)
    const mainFiles = await retain(openNativeProvisioningProcess(fpm.mainPid)), master = await readIdentity(fpm.mainPid, mainFiles); await guard()
    if (master.cgroup !== fpm.cgroup || master.uids.some(uid => uid !== account.uid) || master.gids.some(gid => gid !== account.gid) || ['Z', 'X', 'x'].includes(master.state)) refused('fpm_master_identity_changed')
    const nginxMain = await retain(openNativeProvisioningProcess(nginx.mainPid)), nginxStat = await nginxMain.read('stat'); await guard()
    const startToken = (raw: string, pid: number): string => {
      const end = raw.lastIndexOf(') '), start = raw.indexOf('('), parts = raw.slice(end + 2).trim().split(/\s+/), value = parts[19]
      if (raw.slice(0, start).trim() !== String(pid) || end < start || value === undefined || !/^[0-9]+$/.test(value) || ['Z', 'X', 'x'].includes(parts[0] ?? '')) return refused('nginx_master_process_changed')
      return value
    }
    const nginxStart = startToken(nginxStat, nginx.mainPid)
    const binary = await realpath(edge.phpFpmBinary(options.os, domain.php.version)), nginxBinary = await realpath(edge.nginxBinary(options.os))
    await retain(pinFile(binary, undefined, undefined, undefined, 67108864)); await retain(pinFile(nginxBinary, undefined, undefined, undefined, 67108864))
    const assertExecutable = async (pid: number, expected: string): Promise<void> => {
      if (await readlink('/proc/' + pid + '/exe') !== expected) refused('service_executable_changed')
    }
    const assertNamespace = async (pid: number): Promise<void> => {
      const base = '/proc/' + pid + '/root', file = await open(base + paths.script, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const actual = await file.stat()
        if (!actual.isFile() || actual.uid !== 0 || (actual.mode & 0o7777) !== 0o444 || actual.dev !== asset.dev || actual.ino !== asset.ino) refused('canary_namespace_asset_changed')
      } finally { await file.close() }
      const directory = await open(base + paths.target + '/runtime', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { const actual = await directory.stat(); if (!sameNode(actual, runtime)) refused('canary_namespace_runtime_changed') }
      finally { await directory.close() }
      const info = await readFile('/proc/' + pid + '/mountinfo', 'utf8')
      if (info.length > 1048576) refused('canary_namespace_mount_limit')
      for (const target of [paths.target, paths.target + '/runtime']) {
        const mounts = info.split('\n').map(line => line.split(' ')).filter(parts => parts[4] === target)
        if (mounts.length !== 1 || !mounts[0]?.[5]?.split(',').includes('ro')) refused('canary_namespace_not_read_only')
      }
    }
    const assertCurrent = async (): Promise<void> => {
      await guard()
      const reader = options.databaseReader?.database() ?? options.db
      const current = await withVisibleReadonlyOperationDatabase(reader, () => latestActive(reader))
      if (current?.id !== activeId || current.checksum !== generationChecksum) refused('active_generation_changed')
      for (const pin of pins) await pin.assertCurrent()
      const currentFpm = await unitIdentity(unit), currentNginx = await unitIdentity(nginxUnit)
      if (currentFpm.mainPid !== fpm.mainPid || currentFpm.cgroup !== fpm.cgroup || currentNginx.mainPid !== nginx.mainPid || currentNginx.cgroup !== nginx.cgroup
        || !sameProvisioningProcess(master, await readIdentity(fpm.mainPid, mainFiles)) || startToken(await nginxMain.read('stat'), nginx.mainPid) !== nginxStart) refused('canary_service_process_changed')
      await assertExecutable(fpm.mainPid, binary); await assertExecutable(nginx.mainPid, nginxBinary)
      await assertNamespace(fpm.mainPid); await guard()
    }
    await assertCurrent()
    return {
      account, unit, mainPid: fpm.mainPid, nginxUid, nginxGid, backendSocket: edge.fpmSocketPath(account.username, domain.php.version),
      assertCurrent,
      async assertIngressPeer(peer, connection) {
        if (peer.uid !== nginxUid || peer.gid !== nginxGid) refused('ingress_peer_is_not_nginx')
        const files = await openNativeProvisioningProcess(peer.pid)
        try { const identity = await readIdentity(peer.pid, files); if (identity.parentPid !== nginx.mainPid || identity.cgroup !== nginx.cgroup
          || identity.uids.some(uid => uid !== nginxUid) || identity.gids.some(gid => gid !== nginxGid) || ['Z', 'X', 'x'].includes(identity.state)) refused('ingress_peer_process_changed')
          await assertExecutable(peer.pid, nginxBinary)
          await assertHttpPeerOwnedByNginx(peer.pid, connection, guard)
          if (!sameProvisioningProcess(identity, await readIdentity(peer.pid, files))) refused('http_ingress_process_changed')
          await files.assertCurrent()
        } finally { await files.close() }
      },
      async assertBackendPeer(peer) { if (peer.pid !== fpm.mainPid || peer.uid !== account.uid || peer.gid !== account.gid) refused('backend_socket_is_not_fpm_master'); await assertCurrent() },
      async assertWorkerNamespace(worker) { await assertExecutable(worker.pid, binary); await assertNamespace(worker.pid) },
      async close() { const results = await Promise.allSettled(pins.map(pin => Promise.resolve().then(() => pin.close()))); if (results.some(result => result.status === 'rejected')) refused('canary_source_release_failed') },
    }
  } catch (error) { await Promise.allSettled(pins.map(pin => Promise.resolve().then(() => pin.close()))); throw error }
}
