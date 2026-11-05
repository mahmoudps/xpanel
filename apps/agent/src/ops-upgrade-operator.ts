import { randomUUID } from 'node:crypto'
import { chmod, lstat } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { withVerifiedCoordinatorOwnership, assertCoordinatorOwnershipCurrent, type CoordinatorOwnershipCapability } from '../../../scripts/coordinator-ownership.mjs'
import { requireLinuxRoot, withTrustedFile } from '../../../scripts/lifecycle-ownership.mjs'
import { runNativeRootOperatorCommand } from './lifecycle/native-runtime.ts'
import { withNativeClosedDatabaseRecoveryAdmission } from '../../../scripts/lifecycle-root-safety.mjs'
import { loadInstalledPeerIdentityAddon } from './peer-identity.ts'
import { observeLauncher, processFacts, kernelPeer, socketIdentity } from './ops-upgrade-native-observation.ts'
import { claimCoordinatorRequest } from './ops-upgrade-coordinator-gate.ts'
import { createNativeClosedRecoveryHostedUidQualification, withNativeRootOperatorHostedUidQualification, type HostedUidQualification } from './ops-upgrade-hosted-qualification.ts'
import { ROOT_OPERATOR_SOCKET, rootOperatorArgv, withVerifiedNativeRootOperatorDispatch } from './ops-upgrade-root-dispatch.ts'
import { decodeUpgradeIpcFrame, encodeUpgradeIpcFrame, parseLauncherKeyPair, UPGRADE_IPC_LIMIT } from './ops-upgrade-ipc.ts'
import { parseRootOperatorRequest, signRootOperatorResponse, verifyRootOperatorResponse, type RootOperatorRequest, type RootOperatorResponse } from './ops-upgrade-operator-protocol.ts'

export { ROOT_OPERATOR_SOCKET } from './ops-upgrade-root-dispatch.ts'
const MACHINE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/
const refused = (): never => { throw new Error('ROOT_OPERATOR_UNAVAILABLE') }
export function stableMachineCode(error: unknown): string {
  let current: unknown = error
  let wrapper = ''
  for (let depth = 0; current && depth < 6; depth += 1) {
    const record = typeof current === 'object' ? current as { code?: unknown; message?: unknown; cause?: unknown } : undefined
    const candidate = typeof record?.code === 'string' ? record.code : typeof record?.message === 'string' ? record.message : ''
    if (MACHINE_CODE.test(candidate)) {
      if (candidate !== 'ARCHIVE_USE_UNCERTAIN') return candidate
      wrapper = candidate
    }
    current = record?.cause
  }
  return wrapper || 'ROOT_OPERATOR_REVIEW_REQUIRED'
}
export function rootOperatorReviewRecord(operationId: string, error: unknown) {
  return Object.freeze({ operationId, state: 'review_required' as const, code: stableMachineCode(error), retryAllowed: false as const })
}
const review = (operationId: string, code = 'ROOT_OPERATOR_REVIEW_REQUIRED'): Error => {
  const stable = MACHINE_CODE.test(code) ? code : 'ROOT_OPERATOR_REVIEW_REQUIRED'
  return Object.assign(new Error(stable), { operationId, code: stable, unknownOutcome: true, retryAllowed: false as const })
}
const refusalCode = (frame: Buffer): string | null => {
  const text = frame.toString('utf8')
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return null
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const keys = Reflect.ownKeys(parsed)
  const value = (parsed as { refused?: unknown }).refused
  if (keys.length !== 1 || keys[0] !== 'refused' || typeof value !== 'string' || !MACHINE_CODE.test(value)) return null
  return value
}

async function exchange(ownership: CoordinatorOwnershipCapability, request: RootOperatorRequest): Promise<RootOperatorResponse> {
  requireLinuxRoot()
  const actual = await observeLauncher(ownership), addon = await loadInstalledPeerIdentityAddon(), pin = await socketIdentity(ROOT_OPERATOR_SOCKET), started = Date.now()
  if (request.expectedArchiveSha256 !== actual.receipt.helper.archiveSha256) return refused()
  const self = await processFacts(process.pid)
  if (JSON.stringify(self.argv) !== JSON.stringify(rootOperatorArgv(actual.receipt.nodePath, actual.receipt.helper.releaseRoot, request))) return refused()
  return new Promise<RootOperatorResponse>((resolve, reject) => {
    const socket = createConnection({ path: ROOT_OPERATOR_SOCKET }); let bytes = Buffer.alloc(0), settled = false, frameSeen = false
    const finish = (error?: unknown, response?: RootOperatorResponse) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(response!) }
    const timer = setTimeout(() => finish(review(request.operationId)), request.phase === 'apply' ? 1800000 : 65000)
    socket.once('error', () => finish(review(request.operationId)))
    socket.once('connect', () => { try { const peer = kernelPeer(socket, addon); if (peer.uid !== 0 || peer.gid !== 0 || peer.pid !== actual.identity.pid) return refused(); socket.write(encodeUpgradeIpcFrame(request)) } catch (error) { finish(error) } })
    socket.on('data', chunk => {
      if (settled) return
      if (!Buffer.isBuffer(chunk)) { finish(review(request.operationId)); return }
      if (frameSeen) { finish(review(request.operationId)); return }
      bytes = Buffer.concat([bytes, chunk]); if (bytes.length > UPGRADE_IPC_LIMIT) { finish(review(request.operationId)); return }
      if (!bytes.includes(10)) return
      frameSeen = true
      const refusedCode = refusalCode(bytes)
      if (refusedCode) { finish(review(request.operationId, refusedCode)); return }
      void (async () => {
        const after = await observeLauncher(ownership)
        if (JSON.stringify(actual.identity) !== JSON.stringify(after.identity) || await socketIdentity(ROOT_OPERATOR_SOCKET) !== pin) return refused()
        const response = verifyRootOperatorResponse(decodeUpgradeIpcFrame(bytes), request, after.identity, after.publicKey)
        const observed = Date.parse(response.qualification.observedAt)
        if (observed < started || observed > Date.now()) return refused()
        await assertCoordinatorOwnershipCurrent(ownership); finish(undefined, response)
      })().catch(() => finish(review(request.operationId)))
    })
    socket.once('close', () => { if (!frameSeen) finish(review(request.operationId)) })
  })
}

/** Entry from the exact authenticated helper only; there is no retry or arbitrary root command transport. */
export async function dispatchPreparedRootOperation(input: { operationId: string; kind: 'upgrade'|'recover'; expectedArchiveSha256: string },
  ownership: CoordinatorOwnershipCapability) {
  // A stopped recovery may need its narrowly authorized EX/stop phase before
  // observation is possible. Direct authenticated apply makes no ready claim.
  if (input.kind === 'upgrade') await exchange(ownership, parseRootOperatorRequest({ ...input, phase: 'observe', nonce: randomUUID() }))
  const applied = await exchange(ownership, parseRootOperatorRequest({ ...input, phase: 'apply', nonce: randomUUID() }))
  return Object.freeze({ operationId: input.operationId, ...applied.outcome!, resultDigest: applied.resultDigest, retryAllowed: false as const })
}

/** Distinct purpose and kernel peer contract from the agent socket; same dedicated coordinator process. */
export async function startNativeRootOperatorServer() {
  requireLinuxRoot()
  const initial = await withVerifiedCoordinatorOwnership(observeLauncher), addon = await loadInstalledPeerIdentityAddon()
  if (initial.identity.pid !== process.pid) return refused()
  const workerId = 'root-operator-' + randomUUID()
  try { await lstat(ROOT_OPERATOR_SOCKET); return refused() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const server = createServer(socket => {
    let bytes = Buffer.alloc(0), handled = false
    const timer = setTimeout(() => socket.destroy(), 65000)
    socket.once('close', () => clearTimeout(timer)); socket.on('error', () => {})
    socket.on('data', chunk => {
      if (!Buffer.isBuffer(chunk)) { socket.destroy(); return }
      if (handled) { socket.destroy(); return }
      bytes = Buffer.concat([bytes, chunk]); if (bytes.length > UPGRADE_IPC_LIMIT) { socket.destroy(); return }
      if (!bytes.includes(10)) return
      handled = true
      let claim: ReturnType<typeof claimCoordinatorRequest>, request: RootOperatorRequest
      try { request = parseRootOperatorRequest(decodeUpgradeIpcFrame(bytes)); claim = claimCoordinatorRequest(request.kind === 'recover' ? 'recovery' : 'ordinary') } catch { socket.destroy(); return }
      void withVerifiedCoordinatorOwnership(async ownership => {
        const peer = kernelPeer(socket, addon), actual = await observeLauncher(ownership)
        if (peer.uid !== 0 || peer.gid !== 0 || actual.identity.pid !== process.pid || JSON.stringify(actual.identity) !== JSON.stringify(initial.identity)
          || request.expectedArchiveSha256 !== actual.receipt.helper.archiveSha256) return refused()
        const client = await processFacts(peer.pid)
        if (client.exe !== (await processFacts(process.pid, 'xpanel-lifecycle.service')).exe
          || JSON.stringify(client.argv) !== JSON.stringify(rootOperatorArgv(actual.receipt.nodePath, actual.receipt.helper.releaseRoot, request))) return refused()
        let qualification: HostedUidQualification | undefined
        if (request.phase === 'observe') qualification = await withNativeRootOperatorHostedUidQualification(ownership, request, async proof => proof)
        if (socket.destroyed || JSON.stringify(client) !== JSON.stringify(await processFacts(peer.pid))) return refused()
        await assertCoordinatorOwnershipCurrent(ownership)
        let resultDigest: string|null = null, outcome: RootOperatorResponse['outcome'] = null
        if (request.phase === 'apply') {
          clearTimeout(timer)
          try {
            const result = await withVerifiedNativeRootOperatorDispatch(socket, request, ownership, async dispatch => {
              const input = { operationId: request.operationId, kind: request.kind, expectedArchiveSha256: request.expectedArchiveSha256 }
              if (request.kind === 'recover') {
                // Native phase consumes the request before its limited stop,
                // observes under continuous EX, consumes the real hosted lease,
                // closes all readers, then grants fresh writable admission.
                return withNativeClosedDatabaseRecoveryAdmission(dispatch, async scope => {
                  const proof = await createNativeClosedRecoveryHostedUidQualification(ownership, dispatch, scope)
                  qualification = proof
                  return proof
                }, async () => runNativeRootOperatorCommand(input, dispatch))
              }
              qualification = await withNativeRootOperatorHostedUidQualification(ownership, request, async proof => proof)
              return runNativeRootOperatorCommand(input, dispatch)
            })
            if (result.operationId !== request.operationId || result.kind !== request.kind || !/^[a-f0-9]{64}$/.test(result.resultDigest)) return refused()
            resultDigest = result.resultDigest; outcome = { phase: result.phase, exitCode: result.exitCode }
            if (result.phase === 'attention') claim.attention()
            else if (request.kind === 'recover') claim.recovered()
          } catch (error) { claim.attention(); throw error }
        }
        const after = await observeLauncher(ownership)
        if (!qualification || JSON.stringify(actual.identity) !== JSON.stringify(after.identity)) return refused()
        const verifiedQualification = qualification
        await withTrustedFile('/etc/xpanel/lifecycle-launcher.key', { exactMode: 0o600, maxBytes: 4096 }, async key => {
          const pair = parseLauncherKeyPair(key.bytes, after.publicBytes)
          await key.verify(); await assertCoordinatorOwnershipCurrent(ownership)
          if (!socket.destroyed) socket.end(encodeUpgradeIpcFrame(signRootOperatorResponse({ phase: request.phase === 'observe' ? 'ready' : 'finished', request,
            identity: { workerId, ...after.identity }, qualification: verifiedQualification, resultDigest, outcome }, pair.privateKey)))
        })
      }).catch(error => { if (!socket.destroyed) socket.end(JSON.stringify({ refused: stableMachineCode(error) }) + '\n'); else socket.destroy() }).finally(() => claim.release())
    })
  })
  server.maxConnections = 4
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(ROOT_OPERATOR_SOCKET, () => { server.off('error', reject); resolve() }) })
  await chmod(ROOT_OPERATOR_SOCKET, 0o600); await socketIdentity(ROOT_OPERATOR_SOCKET)
  return server
}
