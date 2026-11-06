import { randomUUID } from 'node:crypto'
import { chmod, lstat, realpath } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { assertTrustedDirectory, requireLinuxRoot, withTrustedFile } from '../../../scripts/lifecycle-ownership.mjs'
import { withVerifiedCoordinatorOwnership, assertCoordinatorOwnershipCurrent } from '../../../scripts/coordinator-ownership.mjs'
import { loadInstalledPeerIdentityAddon } from './peer-identity.ts'
import { runNativeUpgradeCoordinatorBootstrap } from './upgrade-coordinator-bootstrap.ts'
import { parseUpgradeProcessBinding } from './upgrade-coordinator-contract.ts'
import { withNativeHostedUidQualification } from './ops-upgrade-hosted-qualification.ts'
import { claimCoordinatorRequest, coordinatorRequestActive } from './ops-upgrade-coordinator-gate.ts'
import { startNativeRootOperatorServer } from './ops-upgrade-operator.ts'
import type { UpgradeLauncherPorts } from './ops-upgrade-launcher.ts'
import { decodeUpgradeIpcFrame, encodeUpgradeIpcFrame, parseLauncherKeyPair, parseUpgradeIpcRequest, signUpgradeIpcResponse, UPGRADE_IPC_LIMIT, verifyUpgradeIpcResponse,
  type UpgradeIpcRequest, type UpgradeIpcResponse, type UpgradeLauncherIdentity } from './ops-upgrade-ipc.ts'

import { observeLauncher, unitProperties, processFacts, kernelPeer, socketIdentity, NATIVE_UPGRADE_SOCKET } from './ops-upgrade-native-observation.ts'

const PRIVATE_KEY = '/etc/xpanel/lifecycle-launcher.key'
const IPC_TIMEOUT = 65000
const refuse = (): never => { throw new Error('UPGRADE_LAUNCHER_UNAVAILABLE') }
async function exchange(request: UpgradeIpcRequest): Promise<UpgradeIpcResponse> {
  return withVerifiedCoordinatorOwnership(async ownership => {
    const before = await observeLauncher(ownership), addon = await loadInstalledPeerIdentityAddon(), socketPin = await socketIdentity(), started = Date.now()
    return new Promise<UpgradeIpcResponse>((resolve, reject) => {
      const socket = createConnection({ path: NATIVE_UPGRADE_SOCKET }); let bytes = Buffer.alloc(0), settled = false, readingComplete = false
      const done = (error?: unknown, response?: UpgradeIpcResponse) => { if (settled) return; settled = true; clearTimeout(deadline); socket.destroy(); error ? reject(error) : resolve(response!) }
      const deadline = setTimeout(() => done(new Error('UPGRADE_IPC_TIMEOUT')), IPC_TIMEOUT)
      socket.once('error', done)
      socket.once('connect', () => { try { const peer = kernelPeer(socket, addon); if (peer.uid !== 0 || peer.gid !== 0 || peer.pid !== before.identity.pid) return refuse(); socket.write(encodeUpgradeIpcFrame(request)) } catch (error) { done(error) } })
      socket.on('data', chunk => {
        if (settled) return
        if (!Buffer.isBuffer(chunk)) { done(new Error('UPGRADE_IPC_BINARY_REQUIRED')); return }
        if (readingComplete) { done(new Error('UPGRADE_IPC_EXTRA_DATA')); return }
        bytes = Buffer.concat([bytes, chunk]); if (bytes.length > UPGRADE_IPC_LIMIT) { done(new Error('UPGRADE_IPC_LIMIT')); return }
        if (!bytes.includes(10)) return
        readingComplete = true
        const frame = bytes
        void (async () => {
          const after = await observeLauncher(ownership)
          if (JSON.stringify(before.identity) !== JSON.stringify(after.identity) || await socketIdentity() !== socketPin) return refuse()
          const response = verifyUpgradeIpcResponse(decodeUpgradeIpcFrame(frame), request, after.identity, after.publicKey), observed = Date.parse(response.qualification.observedAt)
          if (observed < started || observed > Date.now() || Date.now() - observed > IPC_TIMEOUT) return refuse()
          await assertCoordinatorOwnershipCurrent(ownership); done(undefined, response)
        })().catch(done)
      })
      socket.once('end', () => { if (!bytes.includes(10)) done(new Error('UPGRADE_IPC_INCOMPLETE')) })
      socket.once('close', () => { if (!settled && !bytes.includes(10)) done(new Error('UPGRADE_IPC_CLOSED')) })
    })
  })
}
/** Root agent only. No externally supplied qualification, authority, paths, flags or observer ports. */
export function createNativeUpgradeIpcPorts(): UpgradeLauncherPorts | null {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) return null
  const responses = new WeakMap<object, { nonce: string; full: UpgradeIpcResponse; received: number }>()
  const ready = async () => { try { await withVerifiedCoordinatorOwnership(observeLauncher); return true } catch { return false } }
  return {
    launcherUnitActive: ready, pinnedRuntimeReady: ready,
    hostedUidQualified: async () => { try { await exchange({ kind: 'hello', nonce: randomUUID() }); return true } catch { return false } },
    async ipcHandshake(nonce) {
      const response = await exchange(parseUpgradeIpcRequest({ kind: 'hello', nonce }))
      const value = { workerId: response.identity.workerId, signature: response.signature }; responses.set(value, { nonce, full: response, received: performance.now() }); return value
    },
    async verifyHandshake(nonce, response) {
      const saved = responses.get(response); responses.delete(response)
      if (!saved || saved.nonce !== nonce || saved.full.signature !== response.signature || saved.full.identity.workerId !== response.workerId || performance.now() - saved.received > 5000) return false
      try { return await withVerifiedCoordinatorOwnership(async ownership => { const actual = await observeLauncher(ownership); verifyUpgradeIpcResponse(saved.full, { kind: 'hello', nonce }, actual.identity, actual.publicKey); return true }) } catch { return false }
    },
    async launch(input) {
      const binding = parseUpgradeProcessBinding(input), request = parseUpgradeIpcRequest({ kind: 'dispatch', nonce: randomUUID(), binding })
      const response = await exchange(request)
      return { accepted: true, binding: response.binding! }
    },
  }
}
export const COORDINATOR_STARTUP_ATTEMPTS = 3
const changedWhileVerifying = (error: unknown): boolean => {
  let current = error
  for (let depth = 0; current && typeof current === 'object' && depth < 6; depth += 1) {
    if ((current as { code?: unknown }).code === 'FILE_CHANGED') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}
/**
 * A write into an ancestor of the helper archive (for example lifecycle state beside it) changes that
 * directory's times while startup verifies the archive. Each retry is a complete fresh verification
 * with no effect done yet; any other refusal, or a third change, fails closed.
 */
export async function verifyCoordinatorStartup<T>(verify: () => Promise<T>, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await verify() } catch (error) {
      if (attempt >= COORDINATOR_STARTUP_ATTEMPTS || !changedWhileVerifying(error)) throw error
      process.stderr.write(`xpanel-lifecycle startup: protected source changed during verification; verifying again (${attempt}/${COORDINATOR_STARTUP_ATTEMPTS - 1})\n`)
      await sleep(1000 * attempt)
    }
  }
}

/** Dedicated same-MainPID executable. Per-message qualification retires SH admission before native admission. */
export async function startNativeUpgradeIpcServer() {
  requireLinuxRoot()
  const initial = await verifyCoordinatorStartup(() => withVerifiedCoordinatorOwnership(observeLauncher))
  if (initial.identity.pid !== process.pid || await realpath(fileURLToPath(import.meta.url)) !== initial.receipt.sourcePath) return refuse()
  const addon = await loadInstalledPeerIdentityAddon(), workerId = 'upgrade-coordinator-' + randomUUID(), usedJobs = new Set<string>()
  let operation: Promise<unknown> | undefined, qualifying = false
  await assertTrustedDirectory('/run/xpanel-lifecycle')
  if (((await lstat('/run/xpanel-lifecycle')).mode & 0o7777) !== 0o700) return refuse()
  try { await lstat(NATIVE_UPGRADE_SOCKET); return refuse() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const server = createServer({ allowHalfOpen: false }, socket => {
    if (operation || qualifying) { socket.destroy(); return }
    let bytes = Buffer.alloc(0), handled = false
    const deadline = setTimeout(() => socket.destroy(), IPC_TIMEOUT)
    socket.once('close', () => clearTimeout(deadline)); socket.on('error', () => {})
    socket.on('data', chunk => {
      if (!Buffer.isBuffer(chunk)) { socket.destroy(); return }
      if (handled) { socket.destroy(); return }
      bytes = Buffer.concat([bytes, chunk]); if (bytes.length > UPGRADE_IPC_LIMIT) { socket.destroy(); return }
      if (!bytes.includes(10)) return
      handled = true
      if (operation || qualifying) { socket.destroy(); return }
      let claim: ReturnType<typeof claimCoordinatorRequest>
      try { claim = claimCoordinatorRequest() } catch { socket.destroy(); return }
      qualifying = true
      void withVerifiedCoordinatorOwnership(async ownership => {
        const request = parseUpgradeIpcRequest(decodeUpgradeIpcFrame(bytes)), peer = kernelPeer(socket, addon)
        const actual = await observeLauncher(ownership), agent = await unitProperties('xpanel-agent.service', actual.receipt.systemctlSha256)
        if (actual.identity.pid !== process.pid || JSON.stringify(actual.identity) !== JSON.stringify(initial.identity)
          || peer.uid !== 0 || peer.gid !== 0 || agent.Id !== 'xpanel-agent.service' || agent.LoadState !== 'loaded' || agent.ActiveState !== 'active' || Number(agent.MainPID) !== peer.pid
          || agent.ControlPID !== '0' || agent.FragmentPath !== '/etc/systemd/system/xpanel-agent.service' || agent.DropInPaths) return refuse()
        const agentBefore = await processFacts(peer.pid, 'xpanel-agent.service')
        const qualification = await withNativeHostedUidQualification(ownership, request, async proof => proof)
        if (socket.destroyed || operation) return refuse()
        if (JSON.stringify(agentBefore) !== JSON.stringify(await processFacts(peer.pid, 'xpanel-agent.service')) || Number((await unitProperties('xpanel-agent.service', actual.receipt.systemctlSha256)).MainPID) !== peer.pid) return refuse()
        await assertCoordinatorOwnershipCurrent(ownership)
        return withTrustedFile(PRIVATE_KEY, { maxBytes: 4096, exactMode: 0o600 }, async privateFile => {
          const keys = parseLauncherKeyPair(privateFile.bytes, actual.publicBytes), identity: UpgradeLauncherIdentity = { workerId, ...actual.identity }
          if (request.kind === 'hello') { await privateFile.verify(); socket.end(encodeUpgradeIpcFrame(signUpgradeIpcResponse({ kind: 'ready', nonce: request.nonce, identity, binding: null, qualification }, keys.privateKey))); return }
          if (usedJobs.has(request.binding.jobId) || usedJobs.size >= 256) return refuse()
          const acknowledgement = encodeUpgradeIpcFrame(signUpgradeIpcResponse({ kind: 'accepted', nonce: request.nonce, identity, binding: request.binding, qualification }, keys.privateKey))
          await privateFile.verify(); await assertCoordinatorOwnershipCurrent(ownership)
          usedJobs.add(request.binding.jobId)
          let begin!: () => void
          const admitted = new Promise<void>(resolve => { begin = resolve })
          operation = admitted.then(() => runNativeUpgradeCoordinatorBootstrap(request.binding)).catch(() => { claim.attention() }).finally(() => { operation = undefined })
          claim.retainUntil(operation)
          // Lost ACK is never retried. The existing durable consumer CAS consumes this exact binding once.
          try { socket.end(acknowledgement) } finally { begin() }
        })
      }).catch(() => socket.destroy()).finally(() => { qualifying = false; claim.release() })
    })
  })
  server.maxConnections = 8
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(NATIVE_UPGRADE_SOCKET, () => { server.off('error', reject); resolve() }) })
  await chmod(NATIVE_UPGRADE_SOCKET, 0o600); await socketIdentity()
  const operatorServer = await startNativeRootOperatorServer()
  return { server, operatorServer, async close() {
    if (operation || qualifying || coordinatorRequestActive()) return refuse()
    await Promise.all([server, operatorServer].map(listener => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))))
  } }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === await realpath(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 2) refuse()
  await startNativeUpgradeIpcServer()
}
