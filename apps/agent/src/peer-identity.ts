import { AsyncResource } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants, existsSync, realpathSync } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import { PEER_IDENTITY_C_SOURCE } from './peer-identity-source.ts'

export const DEFAULT_AGENT_SOCKET_BACKLOG = 32
export const MAX_AGENT_SOCKET_CONNECTIONS = 64
export const MAX_AGENT_INFLIGHT_REQUESTS = 32
export const DEFAULT_AGENT_SOCKET_IDLE_TIMEOUT_MS = 35_000
/** Request-bound host effects that stay silent longer than the idle timeout; the API client and this server both allow them this long. */
export const AGENT_ROUTE_TIMEOUT_MS: ReadonlyMap<string, number> = new Map([
  // Idle budget only: provisioning-heartbeat.ts sends a keepalive byte every 10 s while the host work runs.
  ['/host/account-provisioning', 180_000],
  // The agent bounds the quota accounting scan at 240 s; this leaves room for remount and verification.
  ['/host/quota/initialize', 300_000],
  // db-maintenance.ts bounds CHECK/REPAIR TABLE at 150 s.
  ['/host/databases/maintenance', 180_000],
  // db-admin-tools.ts stops starting accounts at 240 s; one started account still finishes.
  ['/host/databases/access-hosts/push', 300_000],
  // mail-trace.ts: up to six bounded DNS rounds and three bounded SMTP greetings.
  ['/host/mail/trace', 60_000],
  // dns-cluster-sync.ts: one bounded pass per member, each ending in a reload on the member.
  ['/host/dns-cluster/sync', 300_000],
  // db-profiles.ts: a connect timeout, then the live client check.
  ['/host/db-profiles/activate', 60_000],
  // State apply, reconcile, application projects, and server service operations compile and reload multiple host daemons synchronously.
  ['/state/apply', 180_000],
  ['/reconcile', 180_000],
  ['/host/server-operations', 180_000],
  ['/host/application-projects', 180_000],
])
const ACCOUNT_FILES_ROUTE = /^\/accounts\/[a-z][a-z0-9]{0,15}\/files$/
const ACCOUNT_DB_MAINTENANCE_ROUTE = /^\/accounts\/[a-z][a-z0-9]{0,15}\/databases\/maintenance$/
const ACCOUNT_RUNTIME_ROUTE = /^\/accounts\/[a-z][a-z0-9]{0,15}\/runtime$/
/** Account file requests include archive operations, whose confined worker may run 120 s before it answers. */
export const agentRouteTimeoutMs = (pathname: string): number | undefined =>
  AGENT_ROUTE_TIMEOUT_MS.get(pathname) ?? (ACCOUNT_FILES_ROUTE.test(pathname) ? 150_000 : ACCOUNT_DB_MAINTENANCE_ROUTE.test(pathname) || ACCOUNT_RUNTIME_ROUTE.test(pathname) ? 180_000 : undefined)

export interface KernelPeerCredentials {
  readonly uid: number
  readonly gid: number
  readonly pid: number
}

export interface VerifiedRequestPeerContext {
  readonly peer: KernelPeerCredentials
  readonly allowedPeerUids: ReadonlySet<number>
  readonly credentialSource: 'SO_PEERCRED'
}

export interface PeerIdentityDecisionEvent {
  readonly allowed: boolean
  readonly peer: KernelPeerCredentials
  readonly allowedPeerUids: readonly number[]
  readonly credentialSource: 'SO_PEERCRED'
  readonly pathname: string
  readonly method: string
}

export interface NativePeerAcceptedConnection {
  readonly fd: number
  readonly uid: number
  readonly gid: number
  readonly pid: number
}

export interface NativePeerIdentityAddon {
  openListener(
    socketPath: string,
    gid: number,
    mode: number,
    backlog: number,
    onReadable: () => void,
  ): unknown
  acceptPeer(listener: unknown): NativePeerAcceptedConnection | null
  verifyListenerSocket(listener: unknown): boolean
  closeListener(listener: unknown): void
  closeFd(fd: number): void
  getSocketPeerCred(fd: number): KernelPeerCredentials
  /** Absent in older prebuilts; consumers must refuse this feature when unavailable. */
  getUnixSocketPeer?(fd: number): unknown
}

const verifiedRequestPeers = new WeakMap<Request, VerifiedRequestPeerContext>()

export const stripForgedPeerHeaders = (headers: Headers): void => {
  const toDelete: string[] = []
  headers.forEach((_value, key) => {
    const lower = key.toLowerCase()
    if (lower.startsWith('x-xpanel-peer') || lower === 'x-peer-uid' || lower === 'x-peer-pid' || lower === 'x-peer-gid') {
      toDelete.push(key)
    }
  })
  for (const key of toDelete) headers.delete(key)
}

export const assertValidKernelPeerCredentials = (peer: unknown): KernelPeerCredentials => {
  if (!peer || typeof peer !== 'object') {
    return fail('PRECONDITION_FAILED', 'kernel socket peer credentials are required')
  }
  const candidate = peer as Record<string, unknown>
  const { uid, gid, pid } = candidate
  if (
    typeof uid !== 'number' ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    typeof gid !== 'number' ||
    !Number.isSafeInteger(gid) ||
    gid < 0 ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    return fail('PRECONDITION_FAILED', 'kernel socket peer credentials contain invalid uid, gid or pid metadata')
  }
  return Object.freeze({ uid: uid as number, gid: gid as number, pid: pid as number })
}

export const normalizeAllowedPeerUids = (
  expectedPeerUid: number | readonly number[],
  allowRootPeer = false,
): ReadonlySet<number> => {
  const list = typeof expectedPeerUid === 'number' ? [expectedPeerUid] : [...expectedPeerUid]
  if (list.length === 0) {
    fail('PRECONDITION_FAILED', 'at least one expected peer UID must be configured')
  }
  const set = new Set<number>()
  for (const uid of list) {
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0) {
      fail('PRECONDITION_FAILED', 'expected peer UID must be a non-negative safe integer')
    }
    set.add(uid)
  }
  if (allowRootPeer) set.add(0)
  return set
}

export const bindVerifiedRequestPeer = (
  request: Request,
  context: {
    peer: KernelPeerCredentials
    allowedPeerUids: ReadonlySet<number>
    credentialSource?: 'SO_PEERCRED'
  },
): Request => {
  const peer = assertValidKernelPeerCredentials(context.peer)
  if (!context.allowedPeerUids || context.allowedPeerUids.size === 0) {
    fail('PRECONDITION_FAILED', 'verified peer context requires a non-empty allowed UID set')
  }
  for (const uid of context.allowedPeerUids) {
    if (!Number.isSafeInteger(uid) || uid < 0) {
      fail('PRECONDITION_FAILED', 'verified peer context contains an invalid allowed UID')
    }
  }
  verifiedRequestPeers.set(
    request,
    Object.freeze({
      peer,
      allowedPeerUids: new Set(context.allowedPeerUids),
      credentialSource: context.credentialSource ?? 'SO_PEERCRED',
    }),
  )
  return request
}

export const getVerifiedRequestPeer = (request: Request): VerifiedRequestPeerContext | undefined =>
  verifiedRequestPeers.get(request)

export interface ResolveProvisionedPeerUidsOptions {
  gid: number
  expectedPeerUid?: number | readonly number[]
  allowRootPeer?: boolean
  etcGroupContent?: string
  etcPasswdContent?: string
}

const readRootProtectedSystemFile = async (path: string): Promise<string> => {
  if (process.platform !== 'linux' || !isAbsolute(path)) {
    fail('PRECONDITION_FAILED', 'system identity tables require an absolute Linux path')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      fail('PRECONDITION_FAILED', `system identity file must be root-owned and non-writable: ${path}`)
    }
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Resolves the authorized peer UID set for the agent socket.
 * - If `expectedPeerUid` is explicitly provided, only those UID(s) are permitted
 *   (plus UID 0 only when `allowRootPeer: true`).
 * - Otherwise if `XPANEL_API_UID` is set, only that UID is permitted
 *   (plus UID 0 only when `allowRootPeer: true`).
 * - Otherwise resolves the unique non-root service user assigned to the dedicated
 *   `gid` socket group in `/etc/group` + `/etc/passwd`. Fails closed if zero or
 *   multiple non-root identities belong to the socket group.
 */
/** The API service's primary group from the protected passwd table; the socket group is a different identity. */
export const resolveServicePrimaryGid = async (uid: number, etcPasswdContent?: string): Promise<number> => {
  if (!Number.isSafeInteger(uid) || uid <= 0) fail('PRECONDITION_FAILED', 'a positive service uid is required')
  const passwd = etcPasswdContent ?? await readRootProtectedSystemFile('/etc/passwd')
  const gids = passwd.split(/\r?\n/).map(line => line.trim().split(':'))
    .filter(parts => parts.length >= 4 && Number(parts[2]) === uid).map(parts => Number(parts[3]))
  if (gids.length !== 1 || !Number.isSafeInteger(gids[0]) || gids[0]! <= 0) fail('PRECONDITION_FAILED', 'the service uid must have exactly one positive primary group')
  return gids[0]!
}

export const resolveProvisionedPeerUids = async (
  opts: ResolveProvisionedPeerUidsOptions,
): Promise<ReadonlySet<number>> => {
  if (!Number.isSafeInteger(opts.gid) || opts.gid <= 0) {
    fail('PRECONDITION_FAILED', 'agent socket requires a positive numeric dedicated group ID')
  }
  if (opts.expectedPeerUid !== undefined) {
    return normalizeAllowedPeerUids(opts.expectedPeerUid, opts.allowRootPeer === true)
  }
  const envApiUid = process.env.XPANEL_API_UID?.trim()
  if (envApiUid) {
    const parsed = Number(envApiUid)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      fail('PRECONDITION_FAILED', 'XPANEL_API_UID must be a positive safe integer')
    }
    return normalizeAllowedPeerUids(parsed, opts.allowRootPeer === true)
  }

  const [groupText, passwdText] = await Promise.all([
    opts.etcGroupContent !== undefined ? Promise.resolve(opts.etcGroupContent) : readRootProtectedSystemFile('/etc/group'),
    opts.etcPasswdContent !== undefined ? Promise.resolve(opts.etcPasswdContent) : readRootProtectedSystemFile('/etc/passwd'),
  ])

  const usersByName = new Map<string, { uid: number; gid: number }>()
  const primaryGroupUsers: number[] = []
  for (const rawLine of passwdText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(':')
    if (parts.length < 4) continue
    const username = parts[0]!
    const uid = Number(parts[2])
    const userGid = Number(parts[3])
    if (!username || !Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(userGid) || userGid < 0) continue
    usersByName.set(username, { uid, gid: userGid })
    if (userGid === opts.gid && uid !== 0) {
      primaryGroupUsers.push(uid)
    }
  }

  let matchedGroupMembers: string[] | null = null
  for (const rawLine of groupText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(':')
    if (parts.length < 4) continue
    const gid = Number(parts[2])
    if (gid !== opts.gid) continue
    matchedGroupMembers = parts[3]!
      .split(',')
      .map((member) => member.trim())
      .filter(Boolean)
    break
  }

  if (matchedGroupMembers === null) {
    return fail('PRECONDITION_FAILED', `dedicated agent socket group GID ${opts.gid} was not found in /etc/group`)
  }

  const candidateUids = new Set<number>(primaryGroupUsers)
  const members = matchedGroupMembers ?? []
  for (const member of members) {
    if (member === 'root') continue
    const user = usersByName.get(member)
    if (!user || user.uid <= 0) {
      fail('PRECONDITION_FAILED', `agent socket group member "${member}" does not resolve to an unprivileged UID`)
      continue
    }
    candidateUids.add(user.uid)
  }

  if (candidateUids.size === 0) {
    fail('PRECONDITION_FAILED', 'agent socket group does not contain a provisioned unprivileged API service identity')
  }
  if (candidateUids.size > 1) {
    fail('PRECONDITION_FAILED', 'agent socket group contains multiple non-root identities; explicit expectedPeerUid is required')
  }

  return normalizeAllowedPeerUids([...candidateUids], opts.allowRootPeer ?? true)
}

export { PEER_IDENTITY_C_SOURCE }

/** Built by install.sh from helpers/peer-identity as root:root 0755, with its SHA-256 in `<path>.sha256`. */
export const INSTALLED_PEER_IDENTITY_ADDON = '/opt/xpanel/bin/xpanel-peer-identity.node'

let cachedNativeAddon: NativePeerIdentityAddon | null = null

/**
 * libuv runs the listener's readable callback with no async context, which drops AsyncLocalStorage-scoped
 * authority (the lifecycle observation scope). Each callback runs in the context that opened its listener.
 */
export const contextualPeerIdentityAddon = (native: NativePeerIdentityAddon): NativePeerIdentityAddon => {
  const getUnixSocketPeer = native.getUnixSocketPeer
  return Object.freeze({
    openListener: (socketPath: string, gid: number, mode: number, backlog: number, onReadable: () => void) =>
      native.openListener(socketPath, gid, mode, backlog, AsyncResource.bind(onReadable)),
    acceptPeer: (listener: unknown) => native.acceptPeer(listener),
    verifyListenerSocket: (listener: unknown) => native.verifyListenerSocket(listener),
    closeListener: (listener: unknown) => native.closeListener(listener),
    closeFd: (fd: number) => native.closeFd(fd),
    getSocketPeerCred: (fd: number) => native.getSocketPeerCred(fd),
    ...(typeof getUnixSocketPeer === 'function' ? { getUnixSocketPeer: (fd: number) => getUnixSocketPeer.call(native, fd) } : {}),
  })
}

const verifyRootOwnedDirectoryChain = async (dirPath: string): Promise<void> => {
  if (process.platform !== 'linux' || !isAbsolute(dirPath)) {
    fail('PRECONDITION_FAILED', 'native peer identity directory requires an absolute Linux path')
  }
  let current = resolve(dirPath)
  while (true) {
    const metadata = await lstat(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      fail('PRECONDITION_FAILED', `native peer identity path must traverse root-owned non-writable directories: ${current}`)
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

const verifyCompiledAddonBinary = async (binaryPath: string, expectedSha256?: string): Promise<string> => {
  await verifyRootOwnedDirectoryChain(dirname(binaryPath))
  const handle = await open(binaryPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0 || (st.mode & 0o6000) !== 0) {
      fail('PRECONDITION_FAILED', 'native peer identity binary must be a root-owned non-writable regular file without set-ID bits')
    }
    const content = await handle.readFile()
    const digest = createHash('sha256').update(content).digest('hex')
    if (expectedSha256 && digest !== expectedSha256) {
      fail('PRECONDITION_FAILED', 'native peer identity binary digest mismatch')
    }
    return digest
  } finally {
    await handle.close()
  }
}

const resolveCompilerExecutable = (): string => {
  for (const candidate of ['/usr/bin/gcc', '/usr/bin/cc', '/bin/gcc', '/bin/cc']) {
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate)
      } catch {
        continue
      }
    }
  }
  return fail('PRECONDITION_FAILED', 'a root-owned C compiler (/usr/bin/gcc or /usr/bin/cc) is required to build the native SO_PEERCRED verifier')
}

export const getPeerIdentitySourceDigest = (): string =>
  createHash('sha256')
    .update(PEER_IDENTITY_C_SOURCE)
    .update(process.version)
    .update(process.arch)
    .digest('hex')

/**
 * Compiles (if absent) and loads the audited C N-API SO_PEERCRED addon on Linux.
 * Fails closed (`PRECONDITION_FAILED`) if not running as root on Linux or if
 * compilation/verification fails.
 */
export const loadNativePeerIdentityAddon = async (options?: {
  cacheDir?: string
  forceRebuild?: boolean
}): Promise<NativePeerIdentityAddon> => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    fail('PRECONDITION_FAILED', 'kernel SO_PEERCRED native verifier requires root on Linux')
  }
  if (cachedNativeAddon && !options?.cacheDir && !options?.forceRebuild) {
    return cachedNativeAddon
  }

  const prebuiltPath = INSTALLED_PEER_IDENTITY_ADDON
  if (!options?.cacheDir && !options?.forceRebuild && existsSync(prebuiltPath)) {
    await verifyCompiledAddonBinary(prebuiltPath)
    const mod = { exports: {} as NativePeerIdentityAddon }
    process.dlopen(mod, prebuiltPath)
    cachedNativeAddon = contextualPeerIdentityAddon(mod.exports)
    return cachedNativeAddon
  }

  const cacheRoot = resolve(options?.cacheDir ?? '/var/cache/xpanel/native')
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  await chown(cacheRoot, 0, 0)
  await chmod(cacheRoot, 0o700)
  await verifyRootOwnedDirectoryChain(cacheRoot)

  const sourceDigest = getPeerIdentitySourceDigest()
  const binaryPath = join(cacheRoot, `peer-identity-${sourceDigest.slice(0, 32)}.node`)
  const digestPath = `${binaryPath}.sha256`

  if (!options?.forceRebuild && existsSync(binaryPath) && existsSync(digestPath)) {
    const expectedSha = (await readFile(digestPath, 'utf8').catch(() => '')).trim()
    if (/^[0-9a-f]{64}$/.test(expectedSha)) {
      await verifyCompiledAddonBinary(binaryPath, expectedSha)
      const mod = { exports: {} as NativePeerIdentityAddon }
      process.dlopen(mod, binaryPath)
      const addon = contextualPeerIdentityAddon(mod.exports)
      if (!options?.cacheDir) cachedNativeAddon = addon
      return addon
    }
  }

  const compiler = resolveCompilerExecutable()
  await verifyCompiledAddonBinary(compiler)

  const uniqueSuffix = `${process.pid}.${randomBytes(6).toString('hex')}`
  const tempSourcePath = join(cacheRoot, `peer-identity-${uniqueSuffix}.c`)
  const tempBinaryPath = join(cacheRoot, `peer-identity-${uniqueSuffix}.node`)
  const tempDigestPath = join(cacheRoot, `peer-identity-${uniqueSuffix}.sha256`)

  try {
    await writeFile(tempSourcePath, PEER_IDENTITY_C_SOURCE, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chown(tempSourcePath, 0, 0)
    await chmod(tempSourcePath, 0o600)

    const compileResult = spawnSync(
      compiler,
      ['-shared', '-fPIC', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-o', tempBinaryPath, tempSourcePath],
      {
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    )

    if (compileResult.status !== 0 || compileResult.error) {
      fail('PRECONDITION_FAILED', 'failed to compile native SO_PEERCRED verifier')
    }

    await chown(tempBinaryPath, 0, 0)
    await chmod(tempBinaryPath, 0o500)
    const compiledSha = await verifyCompiledAddonBinary(tempBinaryPath)
    await writeFile(tempDigestPath, `${compiledSha}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chown(tempDigestPath, 0, 0)
    await chmod(tempDigestPath, 0o600)

    await rename(tempBinaryPath, binaryPath)
    await rename(tempDigestPath, digestPath)
  } finally {
    await rm(tempSourcePath, { force: true }).catch(() => undefined)
    await rm(tempBinaryPath, { force: true }).catch(() => undefined)
    await rm(tempDigestPath, { force: true }).catch(() => undefined)
  }

  const expectedSha = (await readFile(digestPath, 'utf8')).trim()
  await verifyCompiledAddonBinary(binaryPath, expectedSha)

  try {
    const mod = { exports: {} as NativePeerIdentityAddon }
    process.dlopen(mod, binaryPath)
    if (
      typeof mod.exports.openListener !== 'function' ||
      typeof mod.exports.acceptPeer !== 'function' ||
      typeof mod.exports.verifyListenerSocket !== 'function' ||
      typeof mod.exports.closeListener !== 'function' ||
      typeof mod.exports.closeFd !== 'function' ||
      typeof mod.exports.getSocketPeerCred !== 'function'
    ) {
      fail('PRECONDITION_FAILED', 'native SO_PEERCRED verifier did not export the required interface')
    }
    const addon = contextualPeerIdentityAddon(mod.exports)
    if (!options?.cacheDir) cachedNativeAddon = addon
    return addon
  } catch (err) {
    if (isXpanelError(err)) throw err
    return fail('PRECONDITION_FAILED', 'unable to load native SO_PEERCRED verifier')
  }
}

/**
 * Loads only the installed prebuilt whose bytes match the root-owned digest beside it. It never compiles,
 * so an unprivileged service (the local command-line API sockets of the API) can read kernel peer credentials.
 */
export const loadInstalledPeerIdentityAddon = async (
  binaryPath: string = INSTALLED_PEER_IDENTITY_ADDON,
): Promise<Pick<NativePeerIdentityAddon, 'getSocketPeerCred'>> => {
  if (process.platform !== 'linux') fail('PRECONDITION_FAILED', 'kernel SO_PEERCRED verification requires Linux')
  const digestHandle = await open(`${binaryPath}.sha256`, constants.O_RDONLY | constants.O_NOFOLLOW)
  let expected: string
  try {
    const st = await digestHandle.stat()
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0) fail('PRECONDITION_FAILED', 'native peer identity digest must be a root-owned non-writable regular file')
    expected = (await digestHandle.readFile('utf8')).trim()
  } finally {
    await digestHandle.close()
  }
  if (!/^[0-9a-f]{64}$/.test(expected)) fail('PRECONDITION_FAILED', 'native peer identity digest is invalid')
  await verifyCompiledAddonBinary(binaryPath, expected)
  const mod = { exports: {} as NativePeerIdentityAddon }
  process.dlopen(mod, binaryPath)
  if (typeof mod.exports.getSocketPeerCred !== 'function') fail('PRECONDITION_FAILED', 'native SO_PEERCRED verifier did not export getSocketPeerCred')
  return mod.exports
}
