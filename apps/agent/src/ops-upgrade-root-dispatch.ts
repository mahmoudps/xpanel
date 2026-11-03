import { AsyncLocalStorage } from 'node:async_hooks'
import type { Socket } from 'node:net'
import { requireLinuxRoot } from '../../../scripts/lifecycle-ownership.mjs'
import { assertCoordinatorOwnershipCurrent, type CoordinatorOwnershipCapability } from '../../../scripts/coordinator-ownership.mjs'
import { loadInstalledPeerIdentityAddon } from './peer-identity.ts'
import { kernelPeer, observeLauncher, processFacts, socketIdentity } from './ops-upgrade-native-observation.ts'
import { parseRootOperatorRequest, type RootOperatorRequest } from './ops-upgrade-operator-protocol.ts'

export const ROOT_OPERATOR_SOCKET = '/run/xpanel-lifecycle/operator.sock'
export const rootOperatorArgv = (node: string, helper: string, input: Pick<RootOperatorRequest, 'kind'|'expectedArchiveSha256'|'operationId'>): string[] =>
  [node, helper + '/scripts/root-operator-entry.mjs', '--kind=' + input.kind, '--archive-sha256=' + input.expectedArchiveSha256, '--operation-id=' + input.operationId]
declare const dispatchBrand: unique symbol
export interface NativeRootOperatorDispatch { readonly [dispatchBrand]: true }
export interface NativeRootOperatorDispatchInfo {
  readonly purpose: 'root-operator-apply'
  readonly request: Readonly<RootOperatorRequest>
  readonly coordinator: Readonly<{ pid: number; start: string; bootId: string; receiptSha256: string }>
  readonly coordinatorReceiptSha256: string
  readonly client: Readonly<{ pid: number; start: string; bootId: string }>
  readonly peer: Readonly<{ pid: number; uid: number; gid: number; start: string; bootId: string }>
}
interface DispatchScope { live: boolean; socket: Socket; info: Readonly<NativeRootOperatorDispatchInfo>; verify(): Promise<void> }
const scopes = new WeakMap<object, DispatchScope>(), current = new AsyncLocalStorage<DispatchScope>()
const refused = (): never => { throw new Error('NATIVE_ROOT_OPERATOR_DISPATCH_REQUIRED') }
const state = (value: unknown): DispatchScope => {
  const scope = value && typeof value === 'object' ? scopes.get(value) : undefined
  if (!scope?.live || current.getStore() !== scope || scope.socket.destroyed) return refused()
  return scope
}
export function getNativeRootOperatorDispatchInfo(value: unknown): Readonly<NativeRootOperatorDispatchInfo> { return state(value).info }
export async function assertNativeRootOperatorDispatchHeld(value: unknown): Promise<void> {
  const scope = state(value); await scope.verify(); if (state(value) !== scope) return refused()
}

/** Real accepted root-helper socket only. Observe requests never enter this producer.
 * The capability proves transport/process/source/request identity, not general host
 * effects. A separate retained-intent phase must still authorize a limited stop. */
export async function withVerifiedNativeRootOperatorDispatch<T>(socket: Socket, input: RootOperatorRequest,
  ownership: CoordinatorOwnershipCapability, callback: (dispatch: NativeRootOperatorDispatch) => Promise<T>): Promise<T> {
  requireLinuxRoot()
  const request = Object.freeze(parseRootOperatorRequest(input))
  if (request.phase !== 'apply' || current.getStore() || typeof callback !== 'function') return refused()
  const addon = await loadInstalledPeerIdentityAddon(), actual = await observeLauncher(ownership)
  const peer = kernelPeer(socket, addon), socketPin = await socketIdentity(ROOT_OPERATOR_SOCKET)
  if (peer.uid !== 0 || peer.gid !== 0 || actual.identity.pid !== process.pid || request.expectedArchiveSha256 !== actual.receipt.helper.archiveSha256) return refused()
  const client = await processFacts(peer.pid), coordinator = await processFacts(process.pid, 'xpanel-lifecycle.service')
  if (client.exe !== coordinator.exe || JSON.stringify(client.argv) !== JSON.stringify(rootOperatorArgv(actual.receipt.nodePath, actual.receipt.helper.releaseRoot, request))) return refused()
  const verify = async (): Promise<void> => {
    if (socket.destroyed) return refused()
    await assertCoordinatorOwnershipCurrent(ownership)
    if (JSON.stringify(kernelPeer(socket, addon)) !== JSON.stringify(peer) || await socketIdentity(ROOT_OPERATOR_SOCKET) !== socketPin
      || JSON.stringify(await processFacts(peer.pid)) !== JSON.stringify(client)
      || JSON.stringify(await processFacts(process.pid, 'xpanel-lifecycle.service')) !== JSON.stringify(coordinator)) return refused()
    const now = await observeLauncher(ownership)
    if (JSON.stringify(now.identity) !== JSON.stringify(actual.identity) || now.receipt.helper.archiveSha256 !== request.expectedArchiveSha256) return refused()
    await assertCoordinatorOwnershipCurrent(ownership)
    if (socket.destroyed) return refused()
  }
  await verify()
  const scope: DispatchScope = { live: true, socket, verify, info: Object.freeze({ purpose: 'root-operator-apply', request,
    coordinator: Object.freeze({ ...actual.identity }), coordinatorReceiptSha256: actual.identity.receiptSha256,
    client: Object.freeze({ pid: client.pid, start: client.start, bootId: client.bootId }),
    peer: Object.freeze({ pid: client.pid, uid: peer.uid, gid: peer.gid, start: client.start, bootId: client.bootId }) }) }
  const capability = Object.freeze(Object.create(null)) as NativeRootOperatorDispatch
  scopes.set(capability, scope)
  try { return await current.run(scope, async () => { await assertNativeRootOperatorDispatchHeld(capability); const result = await callback(capability); await assertNativeRootOperatorDispatchHeld(capability); return result }) }
  finally { scope.live = false; scopes.delete(capability) }
}
