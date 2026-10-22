import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, chown, lstat, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRootPrincipal, createTestDb, listAudit, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { disposableVmAcknowledgement } from '../../../scripts/test-linux-preflight.mjs'
import { FakeHostExecutor } from './executor.ts'
import { HostReconciler } from './reconciler.ts'
import {
  createAgentApp,
  listenAgentSocket,
  loadNativePeerIdentityAddon,
  type NativePeerIdentityAddon,
  type PeerIdentityDecisionEvent,
} from './server.ts'

const TOKEN = randomBytes(32).toString('hex')
const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'
const nonce = randomBytes(4).toString('hex')
const prefix = `xpqp${nonce}`
const apiUser = `${prefix}a`
const outsiderUser = `${prefix}o`
const strictGroup = `${prefix}s`
const sharedGroup = `${prefix}m`

const createdUsers: { name: string; uid: number }[] = []
const createdGroups: { name: string; gid: number }[] = []
const cleanupErrors: string[] = []
export const peerIdentityLinuxObservations: Record<string, unknown>[] = []

let fixtureRoot = ''
let strictRuntimeDir = ''
let sharedRuntimeDir = ''
let probeScriptPath = ''
let apiUid = 0
let apiGid = 0
let outsiderUid = 0
let outsiderGid = 0
let strictGid = 0
let sharedGid = 0
let stateHandle: TestStateStoreHandle | null = null
let dbHandle: TestDbHandle | null = null
let rootPrincipalId = ''

const runCmd = (file: string, argv: string[]) => {
  const res = spawnSync(file, argv, {
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
  })
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  }
}

const mustRun = (file: string, argv: string[]): string => {
  const res = runCmd(file, argv)
  if (res.status !== 0) {
    throw new Error(`Command failed (${file} ${argv.join(' ')}): ${res.stderr}`)
  }
  return res.stdout
}

const peerIdentityLinuxPreflight = () => {
  const reasons: string[] = []
  if (process.platform !== 'linux') reasons.push('Native Linux is required; no WSL or sudo is invoked.')
  if (process.env.XPANEL_TEST_DISPOSABLE_VM !== disposableVmAcknowledgement) {
    reasons.push('Explicit disposable-VM acknowledgement is required.')
  }
  if (reasons.length) return { status: 'blocked' as const, reasons }
  if (process.getuid?.() !== 0) reasons.push('Root inside the disposable VM is required.')
  for (const bin of [
    '/usr/bin/getent',
    '/usr/sbin/groupadd',
    '/usr/sbin/groupdel',
    '/usr/sbin/useradd',
    '/usr/sbin/userdel',
    '/usr/sbin/runuser',
  ]) {
    if (!existsSync(bin)) reasons.push(`Required fixture command is unavailable: ${bin}`)
  }
  if (!existsSync('/usr/bin/gcc') && !existsSync('/usr/bin/cc')) {
    reasons.push('Required C compiler (/usr/bin/gcc or /usr/bin/cc) is unavailable.')
  }
  return { status: reasons.length ? ('blocked' as const) : ('available' as const), reasons }
}

interface ProbeResponse {
  clientUid: number
  clientGid: number
  clientPid: number
  status: number | null
  errorCode: string | null
  body: Record<string, unknown> | string | null
}

const runClientProbeAsUser = async (
  username: string,
  requestSpec: {
    socketPath: string
    path: string
    method?: string
    headers?: Record<string, string>
    body?: string
    abortAfterMs?: number
  },
): Promise<ProbeResponse> => {
  const encoded = Buffer.from(JSON.stringify(requestSpec), 'utf8').toString('base64')
  return await new Promise<ProbeResponse>((resolve, reject) => {
    const child = spawn(
      '/usr/sbin/runuser',
      ['--user', username, '--', process.execPath, probeScriptPath, encoded],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`runuser probe exited with code ${code}: ${stderr.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()) as ProbeResponse)
      } catch (err) {
        reject(err)
      }
    })
  })
}

beforeAll(async () => {
  const gate = peerIdentityLinuxPreflight()
  if (gate.status !== 'available') {
    throw new Error(`BLOCKED: ${gate.reasons.join(' ')}`)
  }

  for (const name of [apiUser, outsiderUser, strictGroup, sharedGroup]) {
    expect(runCmd('/usr/bin/getent', ['passwd', name]).status).toBe(2)
    expect(runCmd('/usr/bin/getent', ['group', name]).status).toBe(2)
  }

  for (const groupName of [apiUser, outsiderUser, strictGroup, sharedGroup]) {
    mustRun('/usr/sbin/groupadd', ['--system', groupName])
    const gid = Number(mustRun('/usr/bin/getent', ['group', groupName]).split(':')[2])
    createdGroups.push({ name: groupName, gid })
  }

  apiGid = createdGroups.find((g) => g.name === apiUser)!.gid
  outsiderGid = createdGroups.find((g) => g.name === outsiderUser)!.gid
  strictGid = createdGroups.find((g) => g.name === strictGroup)!.gid
  sharedGid = createdGroups.find((g) => g.name === sharedGroup)!.gid

  mustRun('/usr/sbin/useradd', [
    '--system',
    '--no-create-home',
    '--no-log-init',
    '--home-dir',
    '/nonexistent',
    '--shell',
    '/usr/sbin/nologin',
    '--gid',
    apiUser,
    '--groups',
    `${strictGroup},${sharedGroup}`,
    apiUser,
  ])
  apiUid = Number(mustRun('/usr/bin/getent', ['passwd', apiUser]).split(':')[2])
  createdUsers.push({ name: apiUser, uid: apiUid })

  mustRun('/usr/sbin/useradd', [
    '--system',
    '--no-create-home',
    '--no-log-init',
    '--home-dir',
    '/nonexistent',
    '--shell',
    '/usr/sbin/nologin',
    '--gid',
    outsiderUser,
    '--groups',
    sharedGroup,
    outsiderUser,
  ])
  outsiderUid = Number(mustRun('/usr/bin/getent', ['passwd', outsiderUser]).split(':')[2])
  createdUsers.push({ name: outsiderUser, uid: outsiderUid })

  fixtureRoot = `/var/lib/${prefix}`
  strictRuntimeDir = join(fixtureRoot, 'run-strict')
  sharedRuntimeDir = join(fixtureRoot, 'run-shared')
  probeScriptPath = join(fixtureRoot, 'probe.mjs')

  await mkdir(fixtureRoot, { mode: 0o755 })
  await chown(fixtureRoot, 0, 0)
  await chmod(fixtureRoot, 0o755)

  await mkdir(strictRuntimeDir, { mode: 0o750 })
  await chown(strictRuntimeDir, 0, strictGid)
  await chmod(strictRuntimeDir, 0o750)

  await mkdir(sharedRuntimeDir, { mode: 0o750 })
  await chown(sharedRuntimeDir, 0, sharedGid)
  await chmod(sharedRuntimeDir, 0o750)

  const probeSource = [
    "import { request } from 'node:http'",
    'const spec = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"))',
    'const base = { clientUid: process.getuid(), clientGid: process.getgid(), clientPid: process.pid }',
    'const outcome = await new Promise((resolve) => {',
    '  const req = request({',
    '    socketPath: spec.socketPath,',
    '    path: spec.path,',
    '    method: spec.method ?? "GET",',
    '    headers: spec.headers ?? {},',
    '    timeout: 5000,',
    '  }, (res) => {',
    '    const chunks = []',
    '    res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))',
    '    res.once("end", () => {',
    '      const raw = Buffer.concat(chunks).toString("utf8")',
    '      let parsed = raw',
    '      try { parsed = JSON.parse(raw) } catch {}',
    '      resolve({ ...base, status: res.statusCode ?? null, errorCode: null, body: parsed })',
    '    })',
    '    res.once("error", (err) => resolve({ ...base, status: null, errorCode: err.code ?? "RESPONSE_ERROR", body: null }))',
    '  })',
    '  if (spec.abortAfterMs) {',
    '    setTimeout(() => { req.destroy(); resolve({ ...base, status: null, errorCode: "CLIENT_ABORTED", body: null }) }, spec.abortAfterMs)',
    '  }',
    '  req.once("error", (err) => resolve({ ...base, status: null, errorCode: err.code ?? "REQUEST_ERROR", body: null }))',
    '  req.once("timeout", () => { req.destroy(new Error("TIMEOUT")) })',
    '  if (spec.body) req.write(spec.body)',
    '  req.end()',
    '})',
    'process.stdout.write(JSON.stringify(outcome) + "\\n")',
  ].join('\n')

  await writeFile(probeScriptPath, `${probeSource}\n`, { mode: 0o644, flag: 'wx' })
  await chown(probeScriptPath, 0, 0)
  await chmod(probeScriptPath, 0o644)

  stateHandle = await createTestStateStore()
  dbHandle = await createTestDb()
  rootPrincipalId = (
    await createRootPrincipal(dbHandle.db, {
      username: 'root',
      passwordHash: ARGON2,
    })
  ).id
})

afterAll(async () => {
  if (stateHandle) await stateHandle.close().catch((e) => cleanupErrors.push(String(e)))
  if (dbHandle) await dbHandle.close().catch((e) => cleanupErrors.push(String(e)))

  for (const user of [...createdUsers].reverse()) {
    const check = runCmd('/usr/bin/getent', ['passwd', user.name])
    if (check.status === 2) continue
    if (Number(check.stdout.split(':')[2]) !== user.uid) {
      cleanupErrors.push(`Refusing to delete mismatched UID for ${user.name}`)
      continue
    }
    const del = runCmd('/usr/sbin/userdel', [user.name])
    if (del.status !== 0) cleanupErrors.push(`Failed to delete user ${user.name}: ${del.stderr}`)
  }

  for (const group of [...createdGroups].reverse()) {
    const check = runCmd('/usr/bin/getent', ['group', group.name])
    if (check.status === 2) continue
    if (Number(check.stdout.split(':')[2]) !== group.gid) {
      cleanupErrors.push(`Refusing to delete mismatched GID for ${group.name}`)
      continue
    }
    const del = runCmd('/usr/sbin/groupdel', [group.name])
    if (del.status !== 0) cleanupErrors.push(`Failed to delete group ${group.name}: ${del.stderr}`)
  }

  for (const user of createdUsers) {
    for (const spool of [`/var/mail/${user.name}`, `/var/spool/mail/${user.name}`]) {
      try {
        const info = await lstat(spool)
        if (info.isFile() && !info.isSymbolicLink() && [0, user.uid].includes(info.uid)) {
          await unlink(spool)
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          cleanupErrors.push(`Failed to clean mail spool ${spool}`)
        }
      }
    }
  }

  if (fixtureRoot) {
    try {
      const st = await lstat(fixtureRoot)
      if (st.isDirectory() && !st.isSymbolicLink() && st.uid === 0) {
        await rm(fixtureRoot, { recursive: true, force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        cleanupErrors.push(`Failed to remove fixtureRoot ${fixtureRoot}`)
      }
    }
  }

  expect(cleanupErrors).toEqual([])
})

describe('S03 / A14 real Linux kernel SO_PEERCRED socket identity verification', () => {
  const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')

  it('compiles and loads the native C N-API SO_PEERCRED addon with root-owned binary verification', async () => {
    const addon = await loadNativePeerIdentityAddon({ forceRebuild: true })
    expect(typeof addon.openListener).toBe('function')
    expect(typeof addon.acceptPeer).toBe('function')
    expect(typeof addon.verifyListenerSocket).toBe('function')
    expect(typeof addon.closeListener).toBe('function')
    expect(typeof addon.closeFd).toBe('function')
    expect(typeof addon.getSocketPeerCred).toBe('function')
    peerIdentityLinuxObservations.push({
      id: 'A14-PEER-01',
      description: 'Compiled and verified native C N-API SO_PEERCRED addon on Linux',
      status: 'passed',
    })
  })

  it('allows the provisioned API UID with a valid service token (200) and rejects the API UID when the service token is missing or invalid (401)', async () => {
    let reconcileCalls = 0
    const reconciler = new HostReconciler({
      store: stateHandle!.store,
      db: dbHandle!.db,
      executor: new FakeHostExecutor(),
      os,
    })
    reconciler.reconcile = async () => {
      reconcileCalls += 1
      return { status: 'noop', generation: null, stateChecksum: 'a'.repeat(64) }
    }

    const decisions: PeerIdentityDecisionEvent[] = []
    const app = createAgentApp({
      reconciler,
      store: stateHandle!.store,
      db: dbHandle!.db,
      os: { id: os.id, versionId: os.versionId, family: os.family },
      agentToken: TOKEN,
      onPeerDecision: (ev) => decisions.push(ev),
    })

    const socketPath = join(strictRuntimeDir, 'agent-strict.sock')
    const listener = await listenAgentSocket(app, socketPath, {
      gid: strictGid,
      allowRootPeer: false,
    })

    try {
      const socketMeta = await lstat(socketPath)
      expect(socketMeta.isSocket()).toBe(true)
      expect(socketMeta.uid).toBe(0)
      expect(socketMeta.gid).toBe(strictGid)
      expect(socketMeta.mode & 0o7777).toBe(0o660)

      const healthProbe = await runClientProbeAsUser(apiUser, {
        socketPath,
        path: '/health',
        headers: { 'x-xpanel-agent-token': TOKEN },
      })
      expect(healthProbe.clientUid).toBe(apiUid)
      expect(healthProbe.status).toBe(200)
      const healthBody = healthProbe.body as {
        ok: boolean
        peer: { uid: number; gid: number; pid: number; source: string }
      }
      expect(healthBody.ok).toBe(true)
      expect(healthBody.peer).toEqual({
        uid: apiUid,
        gid: apiGid,
        pid: healthProbe.clientPid,
        source: 'SO_PEERCRED',
      })

      const missingTokenProbe = await runClientProbeAsUser(apiUser, {
        socketPath,
        path: '/reconcile',
        method: 'POST',
        headers: { 'x-xpanel-principal-id': rootPrincipalId },
      })
      expect(missingTokenProbe.status).toBe(401)
      expect(reconcileCalls).toBe(0)

      const wrongTokenProbe = await runClientProbeAsUser(apiUser, {
        socketPath,
        path: '/reconcile',
        method: 'POST',
        headers: {
          'x-xpanel-agent-token': 'b'.repeat(64),
          'x-xpanel-principal-id': rootPrincipalId,
        },
      })
      expect(wrongTokenProbe.status).toBe(401)
      expect(reconcileCalls).toBe(0)

      const reconcileProbe = await runClientProbeAsUser(apiUser, {
        socketPath,
        path: '/reconcile',
        method: 'POST',
        headers: {
          'x-xpanel-agent-token': TOKEN,
          'x-xpanel-principal-id': rootPrincipalId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ force: false }),
      })
      expect(reconcileProbe.status).toBe(200)
      expect(reconcileCalls).toBe(1)

      peerIdentityLinuxObservations.push({
        id: 'A14-PEER-02',
        description: 'Authorized API UID verified via kernel SO_PEERCRED with token (200) and rejected without token (401)',
        status: 'passed',
        details: {
          api_uid: apiUid,
          api_gid: apiGid,
          observed_peer: healthBody.peer,
          socket_mode: (socketMeta.mode & 0o7777).toString(8),
          missing_token_status: missingTokenProbe.status,
          wrong_token_status: wrongTokenProbe.status,
          authorized_reconcile_status: reconcileProbe.status,
        },
      })
    } finally {
      await listener.close()
    }
  })

  it('rejects an unauthorized UID that reaches the 0660 listener with a valid service token and valid root principal via kernel SO_PEERCRED (403, zero side effects)', async () => {
    let reconcileCalls = 0
    const executor = new FakeHostExecutor()
    const reconciler = new HostReconciler({
      store: stateHandle!.store,
      db: dbHandle!.db,
      executor,
      os,
    })
    reconciler.reconcile = async () => {
      reconcileCalls += 1
      return { status: 'noop', generation: null, stateChecksum: 'a'.repeat(64) }
    }

    const decisions: PeerIdentityDecisionEvent[] = []
    const app = createAgentApp({
      reconciler,
      store: stateHandle!.store,
      db: dbHandle!.db,
      executor,
      os: { id: os.id, versionId: os.versionId, family: os.family },
      agentToken: TOKEN,
      expectedPeerUid: apiUid,
      allowRootPeer: false,
      onPeerDecision: (ev) => decisions.push(ev),
    })

    const socketPath = join(sharedRuntimeDir, 'agent-shared.sock')

    // 1. Ambiguous socket group without explicit expectedPeerUid fails closed at startup
    await assert.rejects(() =>
      listenAgentSocket(app, socketPath, {
        gid: sharedGid,
      }),
    )

    // 2. Explicit expectedPeerUid binds the 0660 socket; outsiderUser has group access to reach accept4 + SO_PEERCRED
    const listener = await listenAgentSocket(app, socketPath, {
      gid: sharedGid,
      expectedPeerUid: apiUid,
      allowRootPeer: false,
    })

    try {
      const socketMeta = await lstat(socketPath)
      expect(socketMeta.isSocket()).toBe(true)
      expect(socketMeta.uid).toBe(0)
      expect(socketMeta.gid).toBe(sharedGid)
      expect(socketMeta.mode & 0o7777).toBe(0o660)

      const outsiderProbe = await runClientProbeAsUser(outsiderUser, {
        socketPath,
        path: '/reconcile',
        method: 'POST',
        headers: {
          'x-xpanel-agent-token': TOKEN,
          'x-xpanel-principal-id': rootPrincipalId,
          'x-xpanel-peer-uid': String(apiUid),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ force: true }),
      })

      expect(outsiderProbe.clientUid).toBe(outsiderUid)
      expect(outsiderProbe.errorCode).toBeNull()
      expect(outsiderProbe.status).toBe(403)
      const problem = outsiderProbe.body as {
        code: string
        detail: string
        details: { peerUid: number; peerGid: number; peerPid: number; credentialSource: string }
      }
      expect(problem.code).toBe('FORBIDDEN')
      expect(problem.details).toMatchObject({
        peerUid: outsiderUid,
        peerGid: outsiderGid,
        peerPid: outsiderProbe.clientPid,
        credentialSource: 'SO_PEERCRED',
      })
      expect(reconcileCalls).toBe(0)
      expect(executor.executedCommands.length).toBe(0)
      expect(decisions.some((d) => !d.allowed && d.peer.uid === outsiderUid && d.peer.pid === outsiderProbe.clientPid)).toBe(
        true,
      )

      const audits = await listAudit(dbHandle!.db, { limit: 20 })
      const peerDeniedAudit = audits.find(
        (entry) => entry.action === 'agent.peer_denied' && entry.actor === `uid:${outsiderUid}`,
      )
      expect(peerDeniedAudit).toBeDefined()
      expect(peerDeniedAudit?.outcome).toBe('denied')

      // Authorized apiUser on the same listener succeeds
      const authorizedProbe = await runClientProbeAsUser(apiUser, {
        socketPath,
        path: '/health',
        headers: { 'x-xpanel-agent-token': TOKEN },
      })
      expect(authorizedProbe.status).toBe(200)

      peerIdentityLinuxObservations.push({
        id: 'A14-PEER-03',
        description:
          'Unauthorized UID reached listener with valid token and was rejected by kernel SO_PEERCRED policy (403, zero side effects)',
        status: 'passed',
        details: {
          outsider_uid: outsiderUid,
          outsider_gid: outsiderGid,
          outsider_pid: outsiderProbe.clientPid,
          expected_api_uid: apiUid,
          socket_mode: (socketMeta.mode & 0o7777).toString(8),
          http_status: outsiderProbe.status,
          kernel_cred_observed: problem.details,
          reconcile_calls: reconcileCalls,
          audit_recorded: true,
        },
      })
    } finally {
      await listener.close()
    }
  })

  it('fails closed on missing/faulting native adapter, socket replacement on disk, and recovers cleanly across mid-request disconnect and restart', async () => {
    let reconcileCalls = 0
    const reconciler = new HostReconciler({
      store: stateHandle!.store,
      db: dbHandle!.db,
      executor: new FakeHostExecutor(),
      os,
    })
    reconciler.reconcile = async () => {
      reconcileCalls += 1
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
      return { status: 'noop', generation: null, stateChecksum: 'a'.repeat(64) }
    }

    const app = createAgentApp({
      reconciler,
      store: stateHandle!.store,
      db: dbHandle!.db,
      os: { id: os.id, versionId: os.versionId, family: os.family },
      agentToken: TOKEN,
      expectedPeerUid: apiUid,
      allowRootPeer: false,
    })

    const brokenAddon: NativePeerIdentityAddon = {
      openListener() {
        throw new Error('simulated native openListener failure')
      },
      acceptPeer() {
        return null
      },
      verifyListenerSocket() {
        return false
      },
      closeListener() {},
      closeFd() {},
      getSocketPeerCred() {
        throw new Error('simulated SO_PEERCRED failure')
      },
    }

    const faultSocketPath = join(strictRuntimeDir, 'agent-fault.sock')
    await assert.rejects(() =>
      listenAgentSocket(app, faultSocketPath, {
        gid: strictGid,
        expectedPeerUid: apiUid,
        nativeAddon: brokenAddon,
      }),
    )

    // Start real listener, then test socket replacement detection & safe close
    const replaceSocketPath = join(strictRuntimeDir, 'agent-replace.sock')
    const listener = await listenAgentSocket(app, replaceSocketPath, {
      gid: strictGid,
      expectedPeerUid: apiUid,
      allowRootPeer: false,
    })

    const initialHealth = await runClientProbeAsUser(apiUser, {
      socketPath: replaceSocketPath,
      path: '/health',
      headers: { 'x-xpanel-agent-token': TOKEN },
    })
    expect(initialHealth.status).toBe(200)

    // Simulate external replacement of the socket path with a regular file
    await unlink(replaceSocketPath)
    await writeFile(replaceSocketPath, 'replacement-marker\n', { mode: 0o600 })
    const replacedProbe = await runClientProbeAsUser(apiUser, {
      socketPath: replaceSocketPath,
      path: '/health',
      headers: { 'x-xpanel-agent-token': TOKEN },
    })
    expect(replacedProbe.status).toBeNull()
    expect(replacedProbe.errorCode).not.toBeNull()
    const realAddon = await loadNativePeerIdentityAddon()
    await listener.close()
    // Closing the listener must NOT unlink the replacement file because st_dev/st_ino no longer match
    expect(existsSync(replaceSocketPath)).toBe(true)
    await unlink(replaceSocketPath)
    expect(typeof realAddon.verifyListenerSocket).toBe('function')

    // Mid-request disconnect and clean listener restart on the same path
    const restartSocketPath = join(strictRuntimeDir, 'agent-restart.sock')
    const firstListener = await listenAgentSocket(app, restartSocketPath, {
      gid: strictGid,
      expectedPeerUid: apiUid,
      allowRootPeer: false,
    })

    const abortedProbe = await runClientProbeAsUser(apiUser, {
      socketPath: restartSocketPath,
      path: '/reconcile',
      method: 'POST',
      headers: {
        'x-xpanel-agent-token': TOKEN,
        'x-xpanel-principal-id': rootPrincipalId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ force: false }),
      abortAfterMs: 30,
    })
    expect(abortedProbe.errorCode).toBe('CLIENT_ABORTED')

    await firstListener.close()
    expect(existsSync(restartSocketPath)).toBe(false)

    const secondListener = await listenAgentSocket(app, restartSocketPath, {
      gid: strictGid,
      expectedPeerUid: apiUid,
      allowRootPeer: false,
    })
    try {
      const postRestartProbe = await runClientProbeAsUser(apiUser, {
        socketPath: restartSocketPath,
        path: '/health',
        headers: { 'x-xpanel-agent-token': TOKEN },
      })
      expect(postRestartProbe.status).toBe(200)
    } finally {
      await secondListener.close()
    }

    peerIdentityLinuxObservations.push({
      id: 'A14-PEER-04',
      description: 'Faulted adapter fails closed, replaced socket is not blindly unlinked, and mid-request abort/restart recovers cleanly',
      status: 'passed',
      details: {
        reconcile_calls: reconcileCalls,
        replacement_preserved_on_close: true,
        restart_recovered: true,
      },
    })
  })
})
