import { randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { Socket } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fail, isUuid, isXpanelError } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { edge } from '@xpanel/render'
import type { Account, ErrorCode, Id, LiveEvent, Principal } from '@xpanel/core'
import { appendAudit, getPrincipal, latestActive } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { IoAnalyticsEngine, runJailedShellCommand, WebsiteAnalyticsEngine } from './analytics.ts'
import { LinuxHostExecutor } from './executor.ts'
import type { AgentExecutor } from './executor.ts'
import { JailedFileManager } from './file-manager.ts'
import { AcmeCertificateServiceAdapter } from './services/acme.ts'
import { createHttp01AcmeClient } from './services/acme-client.ts'
import { probeAuditLog, probeHostCapabilities, readHostMeasurements } from './host-probes.ts'
import { readHostConfigChecks, readHostIdentity, readServedCertificatePem, PANEL_LISTENER_PORT } from './host-identity.ts'
import { parseDf, parseDfInodes, parseLoadavg, parseMeminfo } from './host-info.ts'
import { readHostServices, restartHostService } from './host-services.ts'
import { createAccountBackup, listAccountBackups, restoreAccountBackup, DEFAULT_BACKUP_DIR } from './account-backup.ts'
import type { AccountFileRunner } from './file-manager.ts'
import {
  assertValidKernelPeerCredentials,
  bindVerifiedRequestPeer,
  DEFAULT_AGENT_SOCKET_BACKLOG,
  DEFAULT_AGENT_SOCKET_IDLE_TIMEOUT_MS,
  getVerifiedRequestPeer,
  loadNativePeerIdentityAddon,
  MAX_AGENT_INFLIGHT_REQUESTS,
  MAX_AGENT_SOCKET_CONNECTIONS,
  normalizeAllowedPeerUids,
  resolveProvisionedPeerUids,
  stripForgedPeerHeaders,
} from './peer-identity.ts'
import type {
  KernelPeerCredentials,
  NativePeerAcceptedConnection,
  NativePeerIdentityAddon,
  PeerIdentityDecisionEvent,
} from './peer-identity.ts'
import type { HostReconciler } from './reconciler.ts'

export * from './peer-identity.ts'

export type AgentCallerRole = Principal['kind']

export const MAX_AGENT_MESSAGE_BYTES = 8 * 1024 * 1024

export const assertAgentCredential = (token: unknown): string => {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    fail('PRECONDITION_FAILED', 'agent requires a provisioned 32-byte hexadecimal service credential')
  }
  return token as string
}

/** Open the credential itself, then validate its metadata; never follow a token symlink. */
export const loadAgentCredentialFile = async (path: string): Promise<string> => {
  if (process.platform !== 'linux' || !isAbsolute(path)) {
    fail('PRECONDITION_FAILED', 'protected agent credential files require an absolute Linux path')
  }
  await assertRootOwnedAgentPath(dirname(path))
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.uid !== 0 || ![0o600, 0o640].includes(metadata.mode & 0o7777) || metadata.size > 65) {
      fail('PRECONDITION_FAILED', 'agent credential must be a root-owned regular file with mode 0600 or 0640')
    }
    return assertAgentCredential((await handle.readFile('utf8')).trim())
  } finally {
    await handle.close()
  }
}

export const assertRootOwnedAgentPath = async (path: string): Promise<void> => {
  if (process.platform !== 'linux' || !isAbsolute(path)) {
    fail('PRECONDITION_FAILED', 'protected agent paths require an absolute Linux path')
  }
  let current = resolve(path)
  while (true) {
    const metadata = await lstat(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      fail('PRECONDITION_FAILED', 'agent paths must traverse root-owned directories without group or other write access')
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 422,
  OVERSELL_BLOCKED: 422,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  SELF_LOCKOUT: 422,
  ENGINE_UNAVAILABLE: 422,
  SERVICE_UNAVAILABLE: 503,
  UNSUPPORTED_OS: 422,
  CONFIG_TEST_FAILED: 422,
  PRECONDITION_FAILED: 412,
}

export interface AgentCallerIdentity {
  principalId: Id
  actor: string
  role: AgentCallerRole
  accountId: Id | null
  resellerId: Id | null
}

export const agentCallerHeaders = (caller: {
  principalId: Id
  token: string
}): Record<string, string> => {
  if (!isUuid(caller.principalId)) fail('UNAUTHENTICATED', 'an authenticated principal is required')
  return {
    'x-xpanel-agent-token': assertAgentCredential(caller.token),
    'x-xpanel-principal-id': caller.principalId,
  }
}

const safeTokenCompare = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

/**
 * Formats an RFC 7807 Problem Details response.
 * Non-`XpanelError` 500 internal errors NEVER expose `err.message` to callers.
 */
const problemResponse = (err: unknown, instance: string): Response => {
  if (isXpanelError(err)) {
    const status = STATUS_BY_CODE[err.code] ?? 400
    return new Response(
      JSON.stringify({
        type: `https://xpanel.dev/problems/${err.code.toLowerCase().replace(/_/g, '-')}`,
        title: err.code,
        status,
        detail: err.message,
        code: err.code,
        instance,
        ...(Object.keys(err.detail).length > 0 && { details: err.detail }),
      }),
      {
        status,
        headers: { 'content-type': 'application/problem+json; charset=utf-8' },
      },
    )
  }
  return new Response(
    JSON.stringify({
      type: 'https://xpanel.dev/problems/internal-error',
      title: 'INTERNAL_ERROR',
      status: 500,
      detail: 'Internal agent error',
      instance,
    }),
    {
      status: 500,
      headers: { 'content-type': 'application/problem+json; charset=utf-8' },
    },
  )
}

export interface AgentServerDeps {
  reconciler: HostReconciler
  store: StateStore
  db: Db
  executor?: AgentExecutor
  accountFileRunner?: AccountFileRunner
  ioAnalytics?: IoAnalyticsEngine
  websiteAnalytics?: WebsiteAnalyticsEngine
  os: { id: string; versionId: string; family: string }
  /** System account nginx runs as. The ACME traversal probe uses it. */
  nginxUser?: string
  /** Optional override for account home root in tests (maps `/home/<user>` into `<homeBaseDir>/home/<user>`) */
  homeBaseDir?: string
  /** Provisioned local service credential; there is no unauthenticated mode. */
  agentToken: string
  /**
   * Expected unprivileged API service UID(s). When configured, every request
   * must carry verified kernel SO_PEERCRED identity matching an allowed UID;
   * missing or mismatched peer identity fails closed before route execution.
   */
  expectedPeerUid?: number | readonly number[]
  /** Whether root (UID 0) is also permitted when `expectedPeerUid` is configured. */
  allowRootPeer?: boolean
  /** Optional observer invoked whenever kernel peer identity is evaluated. */
  onPeerDecision?: (event: PeerIdentityDecisionEvent) => void
}

export interface AgentApp {
  fetch(req: Request): Promise<Response>
  subscribe(fn: (event: LiveEvent) => void): () => void
}

const FILE_AUDIT_ACTIONS: Readonly<Record<string, string>> = {
  write: 'file.write',
  'put-bytes': 'file.write',
  mkdir: 'file.mkdir',
  chmod: 'file.chmod',
  trash: 'file.trash',
  restore: 'file.restore',
  'empty-trash': 'file.empty_trash',
}

export const createAgentApp = (deps: AgentServerDeps): AgentApp => {
  const credential = assertAgentCredential(deps.agentToken)
  const configuredAllowedPeerUids =
    deps.expectedPeerUid !== undefined
      ? normalizeAllowedPeerUids(deps.expectedPeerUid, deps.allowRootPeer === true)
      : null
  const ioEngine = deps.ioAnalytics ?? new IoAnalyticsEngine()
  const webEngine = deps.websiteAnalytics ?? new WebsiteAnalyticsEngine()

  const resolveAccountHome = (accountHome: string, username: string): string => {
    if (!deps.homeBaseDir) return accountHome
    return resolve(deps.homeBaseDir, 'home', username)
  }

  const assertSocketPeerAuthorized = async (
    req: Request,
    pathname: string,
    method: string,
  ): Promise<KernelPeerCredentials | null> => {
    const verifiedContext = getVerifiedRequestPeer(req)
    if (!verifiedContext) {
      if (configuredAllowedPeerUids !== null) {
        fail('PRECONDITION_FAILED', 'kernel socket peer identity verification is required')
      }
      return null
    }
    const peer = assertValidKernelPeerCredentials(verifiedContext.peer)
    if (verifiedContext.credentialSource !== 'SO_PEERCRED') {
      fail('PRECONDITION_FAILED', 'socket peer identity must originate from kernel SO_PEERCRED')
    }
    const effectiveAllowedUids =
      configuredAllowedPeerUids !== null
        ? new Set([...configuredAllowedPeerUids].filter((uid) => verifiedContext.allowedPeerUids.has(uid)))
        : verifiedContext.allowedPeerUids
    if (effectiveAllowedUids.size === 0) {
      fail('PRECONDITION_FAILED', 'no authorized socket peer UIDs are configured')
    }
    const allowed = effectiveAllowedUids.has(peer.uid)
    deps.onPeerDecision?.({
      allowed,
      peer,
      allowedPeerUids: [...effectiveAllowedUids],
      credentialSource: 'SO_PEERCRED',
      pathname,
      method,
    })
    if (!allowed) {
      await appendAudit(deps.db, {
        actor: `uid:${peer.uid}`,
        action: 'agent.peer_denied',
        target: pathname,
        detail: {
          peerUid: peer.uid,
          peerGid: peer.gid,
          peerPid: peer.pid,
          expectedUids: [...effectiveAllowedUids],
          peerSource: 'SO_PEERCRED',
        },
        outcome: 'denied',
      })
      fail('FORBIDDEN', 'unauthorized socket peer identity', {
        peerUid: peer.uid,
        peerGid: peer.gid,
        peerPid: peer.pid,
        peerSource: 'SO_PEERCRED',
        credentialSource: 'SO_PEERCRED',
      })
    }
    return peer
  }

  const authenticateService = (req: Request): void => {
    const tokenHeader = req.headers.get('x-xpanel-agent-token')
    if (!tokenHeader || !safeTokenCompare(tokenHeader, credential)) {
      fail('UNAUTHENTICATED', 'invalid or missing agent service authentication')
    }
  }

  const authenticateCaller = async (req: Request): Promise<AgentCallerIdentity> => {
    const principal = await getPrincipal(deps.db, req.headers.get('x-xpanel-principal-id') ?? '')
    if (!principal || principal.disabled) return fail('UNAUTHENTICATED', 'an enabled authenticated principal is required')
    if (principal.kind === 'user') {
      const account = principal.accountId ? await deps.store.getAccount(principal.accountId) : null
      if (!account || account.status !== 'active') fail('FORBIDDEN', 'account is not active')
    }
    if (principal.kind === 'reseller' && !(await deps.store.getReseller(principal.id))) {
      fail('UNAUTHENTICATED', 'reseller identity is not available')
    }
    return {
      principalId: principal.id,
      actor: principal.username,
      role: principal.kind,
      accountId: principal.accountId,
      resellerId: principal.kind === 'reseller' ? principal.id : null,
    }
  }

  const assertRootCaller = async (caller: AgentCallerIdentity, target: string): Promise<void> => {
    if (caller.role !== 'root') {
      await appendAudit(deps.db, {
        actor: caller.actor,
        action: 'agent.access_denied',
        target,
        detail: { requiredRole: 'root', actualRole: caller.role },
        outcome: 'denied',
      })
      fail('FORBIDDEN', 'root role is required for this agent operation')
    }
  }

  const assertAccountCaller = async (caller: AgentCallerIdentity, account: Account, opName: string): Promise<void> => {
    if (caller.role === 'root') return
    if (account.status !== 'active') fail('FORBIDDEN', 'account is not active')
    if (caller.role === 'reseller' && caller.resellerId && account.ownerId === caller.resellerId) return
    if (caller.role === 'user' && caller.accountId && account.id === caller.accountId) return

    await appendAudit(deps.db, {
      actor: caller.actor,
      action: 'agent.access_denied',
      target: `account:${account.username}`,
      detail: {
        op: opName,
        callerRole: caller.role,
        callerAccountId: caller.accountId,
        callerResellerId: caller.resellerId,
        targetAccountId: account.id,
      },
      outcome: 'denied',
    })
    fail('FORBIDDEN', `caller "${caller.actor}" is not authorized to access account "${account.username}"`)
  }

  const readReconcileBody = async (req: Request): Promise<{ force: boolean }> => {
    const raw = await req.text()
    if (raw.length === 0) return { force: false }
    let value: unknown
    try { value = JSON.parse(raw) } catch { return fail('VALIDATION', 'request body must be valid JSON') }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail('VALIDATION', 'request body must be an object')
    }
    if (Object.keys(value).some(key => key !== 'force')) {
      return fail('VALIDATION', 'only force may be supplied in a reconcile request')
    }
    const force = (value as { force?: unknown }).force
    if (force !== undefined && typeof force !== 'boolean') return fail('VALIDATION', 'force must be a boolean')
    return { force: force === true }
  }

  const readObjectBody = async (req: Request): Promise<Record<string, unknown>> => {
    let value: unknown
    try { value = await req.json() } catch { return fail('VALIDATION', 'request body must be valid JSON') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', 'request body must be an object')
    return value as Record<string, unknown>
  }

  const readFileBody = async (req: Request) => {
    const body = await readObjectBody(req)
    const fields: Record<string, readonly string[]> = {
      list: ['path', 'showHidden'], read: ['path'], write: ['path', 'content', 'overwrite', 'mode'],
      'put-bytes': ['path', 'contentBase64', 'overwrite', 'mode'], 'get-bytes': ['path'],
      mkdir: ['path', 'mode'], chmod: ['path', 'mode'], trash: ['path'],
      'list-trash': [], restore: ['trashId', 'overwrite'], 'empty-trash': ['olderThanDays'],
    }
    if (typeof body.op !== 'string' || !Object.hasOwn(fields, body.op)) fail('VALIDATION', 'unsupported file operation')
    const op = body.op as string
    if (Object.keys(body).some(key => key !== 'op' && !fields[op]!.includes(key))) fail('VALIDATION', 'unknown file operation field')
    for (const key of ['path', 'content', 'contentBase64', 'trashId']) {
      if (body[key] !== undefined && typeof body[key] !== 'string') fail('VALIDATION', `${key} must be a string`)
    }
    for (const key of ['overwrite', 'showHidden']) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') fail('VALIDATION', `${key} must be a boolean`)
    }
    for (const key of ['mode', 'olderThanDays']) {
      if (body[key] !== undefined && typeof body[key] !== 'number') fail('VALIDATION', `${key} must be a number`)
    }
    if (op === 'write' && typeof body.content !== 'string') fail('VALIDATION', 'write content is required')
    if (op === 'put-bytes' && typeof body.contentBase64 !== 'string') fail('VALIDATION', 'binary content is required')
    return body as {
      op: string; path?: string; content?: string; contentBase64?: string; overwrite?: boolean; mode?: number;
      showHidden?: boolean; trashId?: string; olderThanDays?: number
    }
  }

  const streamInternalEvents = (req: Request): Response => {
    let dispose = () => undefined as void
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        let unsubscribe = () => undefined as void
        let heartbeat: ReturnType<typeof setInterval> | undefined
        dispose = () => {
          if (closed) return
          closed = true
          unsubscribe()
          if (heartbeat) clearInterval(heartbeat)
          req.signal.removeEventListener('abort', finish)
        }
        const finish = () => {
          if (closed) return
          dispose()
          controller.close()
        }
        const send = (value: unknown) => {
          if (closed) return
          const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
          if (bytes.length > 128 * 1024 || (controller.desiredSize ?? 0) <= 0) return finish()
          controller.enqueue(bytes)
        }
        unsubscribe = deps.reconciler.subscribe(event => send({ event }))
        heartbeat = setInterval(() => send({ heartbeat: new Date().toISOString() }), 20_000)
        heartbeat.unref()
        req.signal.addEventListener('abort', finish, { once: true })
        send({ heartbeat: new Date().toISOString() })
        if (req.signal.aborted) finish()
      },
      cancel() { dispose() },
    }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength })
    return new Response(stream, {
      headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
    })
  }

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url, 'http://agent.local')
    const { pathname } = url
    const method = req.method.toUpperCase()

    try {
      const verifiedPeer = await assertSocketPeerAuthorized(req, pathname, method)
      authenticateService(req)
      if (method === 'GET' && pathname === '/health') {
        const currentGen = await latestActive(deps.db)
        const linuxExecutor = deps.executor instanceof LinuxHostExecutor ? deps.executor : null
        const executor = linuxExecutor ? 'linux' : deps.executor ? 'fake' : 'unknown'
        const measurements = linuxExecutor ? await readHostMeasurements(linuxExecutor, deps.nginxUser ?? 'nginx') : undefined
        const auditLog = await probeAuditLog(() => deps.db.query('SELECT id FROM audit_log LIMIT 1'))
        return jsonResponse({
          ok: true,
          os: deps.os,
          currentGeneration: currentGen,
          executor,
          ...(measurements ? { probes: probeHostCapabilities(Boolean(deps.accountFileRunner), true, { ...measurements, auditLog }) } : {}),
          ...(verifiedPeer
            ? {
                peer: {
                  uid: verifiedPeer.uid,
                  gid: verifiedPeer.gid,
                  pid: verifiedPeer.pid,
                  source: 'SO_PEERCRED' as const,
                },
              }
            : {}),
        })
      }

      if (method === 'GET' && pathname === '/internal/events') return streamInternalEvents(req)

      const caller = await authenticateCaller(req)

      const purgeMatch = /^\/accounts\/([a-z][a-z0-9]{2,15})\/purge$/.exec(pathname)
      if ((method === 'GET' || method === 'POST') && purgeMatch) {
        await assertRootCaller(caller, 'account.purge')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        if (method === 'GET') return jsonResponse({ available: true, contract: 'target-bound-userdel' })
        const username = purgeMatch[1]!
        const body = await readObjectBody(req)
        const account = await deps.store.getAccountByUsername(username)
        const uid = body.uid
        const home = body.home
        const confirmed = body.confirmUsername === username
          && account?.status === 'terminating'
          && account.username === username
          && uid === account.uid
          && home === account.home
          && typeof uid === 'number'
          && Number.isInteger(uid)
          && uid >= 20_000
          && uid <= 60_000
          && home === `/home/${username}`
        if (!confirmed || !account) return jsonResponse({ purged: false, reason: 'target_refused' }, 409)
        const removed = await deps.executor.runCommand(['/usr/sbin/userdel', '-r', '--', username])
        const alreadyGone = /does not exist|no such user|unknown user/i.test(removed.stderr)
        if (!removed.ok && !alreadyGone) return jsonResponse({ purged: false, reason: 'userdel_failed' }, 409)
        const remains = await deps.executor.runCommand(['/usr/bin/test', '-e', '--', account.home])
        if (remains.ok) return jsonResponse({ purged: false, reason: 'home_still_present' }, 409)
        return jsonResponse({ purged: true })
      }

      if (method === 'GET' && pathname === '/host/addresses') {
        await assertRootCaller(caller, 'host.addresses')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ addresses: [] }, 404)
        const primary = await deps.executor.runCommand(['/usr/sbin/ip', '-j', 'addr'])
        const observed = primary.ok ? primary : await deps.executor.runCommand(['/usr/bin/ip', '-j', 'addr'])
        const addresses: string[] = []
        try {
          const parsed = JSON.parse(observed.stdout || '[]') as { addr_info?: { local?: string }[] }[]
          if (Array.isArray(parsed)) {
            for (const iface of parsed) {
              for (const info of iface?.addr_info ?? []) {
                if (typeof info?.local === 'string' && info.local.length > 0) addresses.push(info.local)
              }
            }
          }
        } catch { /* An unreadable address list stays empty. Account creation keeps the unverified result. */ }
        return jsonResponse({ addresses })
      }

      if (method === 'GET' && pathname === '/host/info') {
        await assertRootCaller(caller, 'host.info')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        const host = deps.executor
        const loadText = await host.readFile('/proc/loadavg')
        const memText = await host.readFile('/proc/meminfo')
        const diskResult = await host.runCommand(['/usr/bin/df', '-B1', '-P', '/'])
        if (!loadText || !memText || !diskResult.ok) return fail('PRECONDITION_FAILED', 'host measurements could not be read')
        try {
          const disk = parseDf(diskResult.stdout)
          const identity = await readHostIdentity({
            readFile: (path) => host.readFile(path),
            runCommand: (argv) => host.runCommand(argv),
            readServedCertificate: () => readServedCertificatePem('127.0.0.1', PANEL_LISTENER_PORT),
          })
          let configChecks: Awaited<ReturnType<typeof readHostConfigChecks>> = {}
          try {
            configChecks = await readHostConfigChecks(host)
          } catch { /* A missing test binary leaves that tile empty. */ }
          let homeOnRoot = false
          let inodes: ReturnType<typeof parseDfInodes> | null = null
          const home = await host.runCommand(['/usr/bin/df', '-B1', '-P', '/home'])
          if (home.ok) {
            try {
              const parsedHome = parseDf(home.stdout)
              homeOnRoot = parsedHome.mount === '/' || parsedHome.filesystem === disk.filesystem
            } catch { /* A missing /home row leaves the inode meter empty. */ }
          }
          const inodeResult = await host.runCommand(['/usr/bin/df', '-P', '-i', '/home'])
          if (inodeResult.ok) {
            try {
              inodes = parseDfInodes(inodeResult.stdout)
              if (inodes.mount === '/') homeOnRoot = true
            } catch { /* Unreadable inode counts stay empty. */ }
          }
          return jsonResponse({
            load: parseLoadavg(loadText),
            memory: parseMeminfo(memText),
            disk,
            ...(inodes ? { inodes } : {}),
            ...(homeOnRoot ? { homeOnRoot: true } : {}),
            identity,
            ...(identity.certificates ? { certificates: identity.certificates } : {}),
            sampledAt: new Date().toISOString(),
            ...(configChecks.nginx || configChecks.apache ? { configChecks } : {}),
          })
        } catch (error) {
          return fail('PRECONDITION_FAILED', error instanceof Error ? error.message : 'host measurements could not be read')
        }
      }

      if (method === 'GET' && pathname === '/host/drift') {
        await assertRootCaller(caller, 'host.drift')
        const report = await deps.reconciler.checkDrift()
        return jsonResponse({
          hasDrift: report.hasDrift,
          count: report.items.length,
          generationId: report.generationId,
        })
      }

      if (method === 'GET' && pathname === '/host/services') {
        await assertRootCaller(caller, 'host.services')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        const services = await readHostServices(argv => deps.executor!.runCommand(argv))
        return jsonResponse({ services })
      }

      const serviceRestart = /^\/host\/services\/([a-z0-9-]+)\/restart$/.exec(pathname)
      if (method === 'POST' && serviceRestart) {
        await assertRootCaller(caller, 'host.services.restart')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        const service = await restartHostService(argv => deps.executor!.runCommand(argv), serviceRestart[1]!)
        return jsonResponse({ service })
      }

      const accountBackup = /^\/accounts\/([a-z][a-z0-9]{2,15})\/backups$/.exec(pathname)
      if (accountBackup && (method === 'GET' || method === 'POST')) {
        await assertRootCaller(caller, 'account.backup')
        if (!(deps.executor instanceof LinuxHostExecutor)) return jsonResponse({ available: false }, 404)
        const username = accountBackup[1]!
        const account = await deps.store.getAccountByUsername(username)
        if (!account || account.username !== username) return fail('NOT_FOUND', 'account not found')
        const target = { username: account.username, home: account.home, uid: account.uid, status: account.status }
        const root = process.env.XPANEL_BACKUP_DIR || DEFAULT_BACKUP_DIR
        if (method === 'GET') return jsonResponse({ backups: await listAccountBackups(root, target) })
        const body = await readObjectBody(req)
        if (body.op === 'create') return jsonResponse({ backup: await createAccountBackup({ executor: deps.executor, root, account: target }) }, 201)
        if (body.op === 'restore') {
          if (typeof body.file !== 'string') return fail('VALIDATION', 'backup file is required')
          return jsonResponse({ backup: await restoreAccountBackup({ executor: deps.executor, root, account: target, file: body.file }) })
        }
        return fail('VALIDATION', 'backup operation must be create or restore')
      }

      if (method === 'POST' && (pathname === '/reconcile' || pathname === '/state/apply')) {
        if (pathname === '/reconcile') await assertRootCaller(caller, 'reconcile')
        const body = await readReconcileBody(req)
        if (caller.role !== 'root' && body.force) fail('FORBIDDEN', 'only root may force reconciliation')
        const result = await deps.reconciler.reconcile({
          force: caller.role === 'root' && body.force,
          actor: caller.actor,
          scope: { accountId: caller.accountId, resellerId: caller.resellerId },
        })
        return jsonResponse(result, result.status === 'failed' ? 422 : 200)
      }

      const resolveFailedMatch = /^\/generations\/(\d+)\/resolve-failed$/.exec(pathname)
      if (method === 'POST' && resolveFailedMatch) {
        await assertRootCaller(caller, `generation:${resolveFailedMatch[1]}:resolve-failed`)
        const genId = Number(resolveFailedMatch[1])
        const result = await deps.reconciler.resolveFailedGeneration(genId, caller.actor)
        return jsonResponse(result)
      }

      const rollbackMatch = /^\/generations\/(\d+)\/rollback$/.exec(pathname)
      if (method === 'POST' && rollbackMatch) {
        await assertRootCaller(caller, `generation:${rollbackMatch[1]}:rollback`)
        const genId = Number(rollbackMatch[1])
        const result = await deps.reconciler.rollbackToGeneration(genId, caller.actor)
        return jsonResponse(result, result.status === 'failed' ? 422 : 200)
      }

      if (method === 'POST' && pathname === '/metrics/collect') {
        await assertRootCaller(caller, 'metrics.collect')
        const count = await deps.reconciler.collectMetrics()
        return jsonResponse({ ok: true, accountsSampled: count })
      }

      if (method === 'GET' && pathname === '/analytics/io') {
        await assertRootCaller(caller, 'analytics.io')
        if (deps.executor) {
          const [accounts, plans] = await Promise.all([deps.store.listAccounts(), deps.store.listPlans()])
          const plansById = new Map(plans.map((p) => [p.id, p]))
          const snap = await ioEngine.sample(accounts, plansById, deps.executor, {
            onEvent: (ev) => deps.reconciler.emit(ev),
          })
          return jsonResponse(snap)
        }
        return jsonResponse(ioEngine.latestSnapshot())
      }

      if (method === 'POST' && pathname === '/analytics/websites/ingest') {
        await assertRootCaller(caller, 'analytics.websites.ingest')
        const body = (await req.json()) as { lines?: string[] | string }
        const ingested = webEngine.ingestJsonLogLines(body.lines ?? [])
        return jsonResponse({ ok: true, ingested })
      }

      const webAnalyticsMatch = /^\/analytics\/websites\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'GET' && webAnalyticsMatch) {
        const domainId = webAnalyticsMatch[1]!.toLowerCase()
        const domain =
          (await deps.store.getDomain(domainId)) ?? fail('NOT_FOUND', `domain "${domainId}" not found`)
        const account =
          (await deps.store.getAccount(domain.accountId)) ??
          fail('NOT_FOUND', `account "${domain.accountId}" not found`)
        await assertAccountCaller(caller, account, 'analytics.websites')
        const windowParam = url.searchParams.get('window')
        const window =
          windowParam === '1h' || windowParam === '24h' || windowParam === '7d' || windowParam === '30d'
            ? windowParam
            : '24h'
        const snap = webEngine.queryDomainSnapshot(domain, {
          window,
          resellerId: account.ownerId ?? null,
          onEvent: (ev) => deps.reconciler.emit(ev),
        })
        return jsonResponse(snap)
      }

      const shellMatch = /^\/accounts\/([a-z][a-z0-9]{2,15})\/shell$/.exec(pathname)
      if (method === 'POST' && shellMatch) {
        const username = shellMatch[1]!
        const account =
          (await deps.store.getAccountByUsername(username)) ??
          fail('NOT_FOUND', `account "${username}" not found`, { username })
        await assertAccountCaller(caller, account, 'shell.exec')
        const plan =
          (await deps.store.getPlan(account.planId)) ?? fail('NOT_FOUND', `plan "${account.planId}" not found`)
        const executor = deps.executor ?? fail('PRECONDITION_FAILED', 'agent executor not configured')
        const body = await readObjectBody(req)
        if (Object.keys(body).some(key => key !== 'command' && key !== 'sessionId') || typeof body.command !== 'string' ||
          (body.sessionId !== undefined && typeof body.sessionId !== 'string')) {
          fail('VALIDATION', 'shell request requires a command and an optional string sessionId')
        }
        const command = body.command as string
        const sessionId = body.sessionId as string | undefined
        try {
          const result = await runJailedShellCommand(account, plan, command, executor, {
            ...(sessionId && { sessionId }),
            onEvent: (ev) => deps.reconciler.emit(ev),
          })
          await appendAudit(deps.db, {
            actor: caller.actor,
            action: 'shell.exec',
            target: `account:${account.username}`,
            detail: { command, code: result.code, sessionId: result.sessionId },
            outcome: result.code === 0 ? 'ok' : 'failed',
          })
          return jsonResponse(result)
        } catch (err) {
          await appendAudit(deps.db, {
            actor: caller.actor,
            action: 'shell.exec',
            target: `account:${account.username}`,
            detail: { command, error: isXpanelError(err) ? err.message : 'Shell execution error' },
            outcome: isXpanelError(err) && err.code === 'FORBIDDEN' ? 'denied' : 'failed',
          })
          throw err
        }
      }

      const filesMatch = /^\/accounts\/([a-z][a-z0-9]{2,15})\/files$/.exec(pathname)
      if (method === 'POST' && filesMatch) {
        const username = filesMatch[1]!
        const account =
          (await deps.store.getAccountByUsername(username)) ??
          fail('NOT_FOUND', `account "${username}" not found`, { username })
        await assertAccountCaller(caller, account, 'files')
        const plan = await deps.store.getPlan(account.planId)
        const homeRoot = resolveAccountHome(account.home, account.username)
        const fm = new JailedFileManager(homeRoot, plan?.resources.diskMb ?? 'unlimited', {
          account,
          ...(deps.accountFileRunner && { runner: deps.accountFileRunner }),
        })
        const body = await readFileBody(req)

        const auditAction = FILE_AUDIT_ACTIONS[body.op]
        const target = `account:${account.username}:${body.path ?? body.trashId ?? ''}`

        try {
          let result: unknown
          switch (body.op) {
            case 'list':
              return jsonResponse({ entries: await fm.list(body.path ?? '', { showHidden: body.showHidden ?? true }) })
            case 'read':
              return jsonResponse(await fm.readText(body.path ?? ''))
            case 'write':
              result = await fm.writeText(body.path ?? '', body.content ?? '', {
                overwrite: body.overwrite ?? true,
                ...(body.mode !== undefined && { mode: body.mode }),
              })
              break
            case 'put-bytes':
              result = await fm.putBytes(body.path ?? '', body.contentBase64 ?? '', {
                overwrite: body.overwrite ?? true,
                ...(body.mode !== undefined && { mode: body.mode }),
              })
              break
            case 'get-bytes':
              return jsonResponse(await fm.getBytes(body.path ?? ''))
            case 'mkdir':
              result = await fm.mkdir(body.path ?? '', body.mode ?? 0o750)
              break
            case 'chmod':
              result = await fm.chmod(body.path ?? '', body.mode ?? 0o640)
              break
            case 'trash':
              result = await fm.moveToTrash(body.path ?? '')
              break
            case 'list-trash':
              return jsonResponse({ items: await fm.listTrash() })
            case 'restore':
              result = await fm.restoreFromTrash(body.trashId ?? '', { overwrite: body.overwrite ?? false })
              break
            case 'empty-trash':
              result = {
                removed: await fm.emptyTrash(
                  body.olderThanDays !== undefined ? { olderThanDays: body.olderThanDays } : {},
                ),
              }
              break
            default:
              return fail('VALIDATION', `unsupported file operation "${String(body.op)}"`)
          }

          if (auditAction) {
            await appendAudit(deps.db, {
              actor: caller.actor,
              action: auditAction,
              target,
              detail: {
                op: body.op,
                path: body.path ?? null,
                ...(body.mode !== undefined && { mode: body.mode }),
                ...(body.trashId !== undefined && { trashId: body.trashId }),
              },
              outcome: 'ok',
            })
          }
          return jsonResponse(result)
        } catch (err) {
          if (auditAction) {
            await appendAudit(deps.db, {
              actor: caller.actor,
              action: auditAction,
              target,
              detail: {
                op: body.op,
                path: body.path ?? null,
                error: isXpanelError(err) ? err.message : 'File operation failed',
              },
              outcome: isXpanelError(err) && err.code === 'FORBIDDEN' ? 'denied' : 'failed',
            })
          }
          throw err
        }
      }

      const certificateMatch = /^\/accounts\/([a-z][a-z0-9]{2,15})\/certificates$/.exec(pathname)
      if (method === 'POST' && certificateMatch) {
        const username = certificateMatch[1]!
        const account = (await deps.store.getAccountByUsername(username)) ?? fail('NOT_FOUND', `account "${username}" not found`)
        await assertAccountCaller(caller, account, 'certificates')
        const executor = deps.executor
        if (!executor) return fail('PRECONDITION_FAILED', 'host executor is not connected')
        const body = await readObjectBody(req)
        const domainName = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : ''
        if (!domainName) return fail('VALIDATION', 'domain is required')
        const domains = await deps.store.listDomains({ accountId: account.id })
        const domain = domains.find(item => item.name === domainName)
        if (!domain || domain.accountId !== account.id) return fail('NOT_FOUND', 'domain not found')
        const release = await executor.readFile('/etc/os-release')
        if (!release) return fail('PRECONDITION_FAILED', 'the host operating system could not be read')
        const directoryUrl = typeof body.directoryUrl === 'string' && body.directoryUrl.startsWith('http://127.0.0.1:')
          ? body.directoryUrl
          : 'https://acme-v02.api.letsencrypt.org/directory'
        const accountKeyPath = '/var/lib/xpanel/acme-account/account-key.pem'
        const existingKey = await executor.readFile(accountKeyPath)
        const caClient = createHttp01AcmeClient({ directoryUrl, ...(existingKey ? { accountKeyPem: existingKey } : {}) })
        if (!existingKey) {
          await executor.writeFile({ path: accountKeyPath, content: caClient.accountKeyPem, mode: 0o600, owner: 'root', group: 'root' })
        }
        const adapter = new AcmeCertificateServiceAdapter({
          executor,
          os: profileFor(release),
          directoryUrl,
          caClient,
          http01ChallengeDir: edge.XP_PATHS.acmeDir,
        })
        const certId = typeof body.certificateId === 'string' && isUuid(body.certificateId) ? body.certificateId : randomUUID()
        const result = await adapter.issueOrRenewCertificate({
          certId,
          accountId: account.id,
          callerRole: caller.role === 'root' || caller.role === 'reseller' || caller.role === 'user' ? caller.role : 'user',
          names: [domain.name],
          challenge: 'http-01',
          domains,
        })
        await appendAudit(deps.db, {
          actor: caller.actor,
          action: 'certificate.issued',
          target: `domain:${domain.name}`,
          detail: { certId: result.certId, notAfter: result.notAfter },
          outcome: 'ok',
        })
        return jsonResponse({
          certificate: {
            id: result.certId,
            names: result.identifiers,
            notAfter: result.notAfter,
            fingerprintSha256: result.fingerprintSha256,
            certPath: result.fullchainPath,
            keyPath: result.privkeyPath,
            challenge: 'http-01' as const,
          },
          orderUrl: result.orderUrl,
        })
      }

      return fail('NOT_FOUND', `route ${method} ${pathname} not found`)
    } catch (err) {
      if (!isXpanelError(err)) {
        await appendAudit(deps.db, {
          actor: 'agent',
          action: 'agent.internal_error',
          target: pathname,
          detail: { error: err instanceof Error ? err.message : String(err) },
          outcome: 'failed',
        }).catch(() => undefined)
      }
      return problemResponse(err, pathname)
    }
  }

  return {
    fetch,
    subscribe: (fn) => deps.reconciler.subscribe(fn),
  }
}

export interface ListenAgentSocketOptions {
  /** Group dedicated to the unprivileged API service. */
  gid: number
  /**
   * Expected unprivileged API service UID(s). When omitted, resolved from
   * `XPANEL_API_UID` or the unique non-root service identity in `gid` (`/etc/group`).
   */
  expectedPeerUid?: number | readonly number[]
  /**
   * Whether local root (UID 0) connections are permitted alongside the
   * unprivileged API service UID.
   */
  allowRootPeer?: boolean
  /** Maximum concurrent active socket connections (default 64). */
  maxConnections?: number
  /** Maximum concurrent in-flight HTTP requests (default 32). */
  maxInFlightRequests?: number
  /** Idle timeout in milliseconds for accepted sockets (default 35_000). */
  socketIdleTimeoutMs?: number
  /** Optional observer invoked on every kernel peer identity evaluation. */
  onPeerDecision?: (event: PeerIdentityDecisionEvent) => void
  /** Optional native addon override for fault-injection tests. */
  nativeAddon?: NativePeerIdentityAddon
}

/**
 * Listens on an AF_UNIX socket owned by root with dedicated API group `0660`,
 * enforcing kernel `SO_PEERCRED` peer UID verification on every accepted socket
 * via the native C N-API listener before handing the descriptor to `node:http`.
 */
export const listenAgentSocket = async (
  app: AgentApp,
  socketPath: string,
  opts: ListenAgentSocketOptions,
): Promise<{ server: Server; close: () => Promise<void> }> => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    fail('PRECONDITION_FAILED', 'agent socket must be provisioned by root on Linux')
  }
  if (!isAbsolute(socketPath) || !Number.isSafeInteger(opts.gid) || opts.gid <= 0) {
    fail('PRECONDITION_FAILED', 'agent socket requires an absolute path and a dedicated API group')
  }
  const maxConnections = opts.maxConnections ?? MAX_AGENT_SOCKET_CONNECTIONS
  const maxInFlightRequests = opts.maxInFlightRequests ?? MAX_AGENT_INFLIGHT_REQUESTS
  const socketIdleTimeoutMs = opts.socketIdleTimeoutMs ?? DEFAULT_AGENT_SOCKET_IDLE_TIMEOUT_MS
  if (
    !Number.isSafeInteger(maxConnections) ||
    maxConnections < 1 ||
    !Number.isSafeInteger(maxInFlightRequests) ||
    maxInFlightRequests < 1 ||
    !Number.isSafeInteger(socketIdleTimeoutMs) ||
    socketIdleTimeoutMs < 100
  ) {
    fail('PRECONDITION_FAILED', 'agent socket connection and timeout bounds must be positive integers')
  }

  await assertRootOwnedAgentPath(dirname(socketPath))
  const allowedPeerUids = await resolveProvisionedPeerUids({
    gid: opts.gid,
    ...(opts.expectedPeerUid !== undefined && { expectedPeerUid: opts.expectedPeerUid }),
    ...(opts.allowRootPeer !== undefined && { allowRootPeer: opts.allowRootPeer }),
  })
  const addon = opts.nativeAddon ?? (await loadNativePeerIdentityAddon())

  const socketPeers = new WeakMap<Socket, KernelPeerCredentials>()
  const activeSockets = new Set<Socket>()
  let inFlightRequests = 0
  let closing = false
  let nativeListener: unknown = null

  const server = createServer(
    { requestTimeout: 30_000, headersTimeout: 5_000, maxHeaderSize: 16 * 1024, keepAliveTimeout: 5_000 },
    async (req, res) => {
      const abort = new AbortController()
      res.once('close', () => abort.abort())
      req.once('aborted', () => abort.abort())
      const isEventsStream = (req.url ?? '').startsWith('/internal/events')
      if (!isEventsStream) {
        inFlightRequests += 1
      }
      try {
        if (closing || !nativeListener || !addon.verifyListenerSocket(nativeListener)) {
          req.socket.destroy()
          return fail('PRECONDITION_FAILED', 'agent socket path was replaced or closed')
        }
        const peer = socketPeers.get(req.socket)
        if (!peer) {
          req.socket.destroy()
          return fail('PRECONDITION_FAILED', 'kernel socket peer credentials unavailable')
        }
        if (!isEventsStream && inFlightRequests > maxInFlightRequests) {
          return fail('SERVICE_UNAVAILABLE', 'agent concurrent request limit exceeded')
        }
        if (isEventsStream) {
          req.socket.setTimeout(0)
        }
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of req) {
          length += chunk.length
          if (length > MAX_AGENT_MESSAGE_BYTES) fail('LIMIT_EXCEEDED', 'agent request exceeds the message limit')
          chunks.push(Buffer.from(chunk))
        }
        const method = req.method ?? 'GET'
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value)
          else if (Array.isArray(value)) headers.set(key, value.join(', '))
        }
        stripForgedPeerHeaders(headers)
        const request = new Request(`http://agent.local${req.url ?? '/'}`, {
          method,
          headers,
          signal: abort.signal,
          ...(length && method !== 'GET' && method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}),
        })
        bindVerifiedRequestPeer(request, {
          peer,
          allowedPeerUids,
          credentialSource: 'SO_PEERCRED',
        })
        opts.onPeerDecision?.({
          allowed: allowedPeerUids.has(peer.uid),
          peer,
          allowedPeerUids: [...allowedPeerUids],
          credentialSource: 'SO_PEERCRED',
          pathname: new URL(request.url).pathname,
          method: method.toUpperCase(),
        })
        const response = await app.fetch(request)
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        const reader = response.body?.getReader()
        try {
          while (reader && !abort.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) break
            if (!res.write(value)) await once(res, 'drain', { signal: abort.signal })
          }
        } finally {
          await reader?.cancel().catch(() => undefined)
        }
        res.end()
      } catch (error) {
        if (res.headersSent) {
          res.destroy()
          return
        }
        const response = problemResponse(error, req.url ?? '/')
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        res.end(await response.text())
      } finally {
        if (!isEventsStream) {
          inFlightRequests = Math.max(0, inFlightRequests - 1)
        }
      }
    },
  )

  const onReadable = () => {
    while (!closing && nativeListener) {
      let accepted: NativePeerAcceptedConnection | null = null
      try {
        accepted = addon.acceptPeer(nativeListener)
      } catch {
        break
      }
      if (accepted === null) break
      if (activeSockets.size >= maxConnections) {
        addon.closeFd(accepted.fd)
        continue
      }
      let peer: KernelPeerCredentials
      try {
        peer = assertValidKernelPeerCredentials({
          uid: accepted.uid,
          gid: accepted.gid,
          pid: accepted.pid,
        })
      } catch {
        addon.closeFd(accepted.fd)
        continue
      }
      let socket: Socket
      try {
        socket = new Socket({ fd: accepted.fd, readable: true, writable: true })
      } catch {
        addon.closeFd(accepted.fd)
        continue
      }
      socketPeers.set(socket, peer)
      activeSockets.add(socket)
      socket.setTimeout(socketIdleTimeoutMs, () => {
        socket.destroy()
      })
      socket.once('error', () => {
        socket.destroy()
      })
      socket.once('close', () => {
        activeSockets.delete(socket)
        socketPeers.delete(socket)
      })
      server.emit('connection', socket)
    }
  }

  const keepAliveTimer = setInterval(() => undefined, 60_000)
  try {
    nativeListener = addon.openListener(socketPath, opts.gid, 0o660, DEFAULT_AGENT_SOCKET_BACKLOG, onReadable)
    const socket = await lstat(socketPath)
    if (!socket.isSocket() || socket.uid !== 0 || socket.gid !== opts.gid || (socket.mode & 0o7777) !== 0o660) {
      fail('PRECONDITION_FAILED', 'agent socket permissions were not applied')
    }
  } catch (error) {
    closing = true
    clearInterval(keepAliveTimer)
    if (nativeListener) {
      try {
        addon.closeListener(nativeListener)
      } catch {
        // ignore close failure on partial init
      }
      nativeListener = null
    }
    server.closeAllConnections()
    if (!isXpanelError(error)) {
      fail('PRECONDITION_FAILED', error instanceof Error ? error.message : 'failed to open agent socket')
    }
    throw error
  }

  return {
    server,
    close: async () => {
      if (closing) return
      closing = true
      clearInterval(keepAliveTimer)
      if (nativeListener) {
        try {
          addon.closeListener(nativeListener)
        } catch {
          // ignore close failure during shutdown
        }
        nativeListener = null
      }
      for (const socket of activeSockets) {
        socket.destroy()
      }
      activeSockets.clear()
      server.closeAllConnections()
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      })
    },
  }
}
