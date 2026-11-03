import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { parseUpgradeProcessBinding, type UpgradeProcessBinding } from './upgrade-coordinator-contract.ts'

export const UPGRADE_IPC_LIMIT = 4096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const bad = (): never => { throw new Error('UPGRADE_IPC_INVALID') }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).sort().join(',') === keys.sort().join(',')
export interface UpgradeLauncherIdentity {
  workerId: string; pid: number; start: string; bootId: string; receiptSha256: string
}
export type UpgradeIpcRequest = { kind: 'hello'; nonce: string } | { kind: 'dispatch'; nonce: string; binding: UpgradeProcessBinding }
export interface UpgradeIpcResponse {
  kind: 'ready' | 'accepted'; nonce: string; identity: UpgradeLauncherIdentity; binding: UpgradeProcessBinding | null
  qualification: { digest: string; observedAt: string }; signature: string
}
const qualification = (value: unknown): UpgradeIpcResponse['qualification'] => {
  if (!exact(value, ['digest', 'observedAt']) || typeof value.digest !== 'string' || !HASH.test(value.digest)
    || typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))) return bad()
  return { digest: value.digest, observedAt: value.observedAt }
}
const identity = (v: unknown): UpgradeLauncherIdentity => {
  if (!exact(v, ['workerId', 'pid', 'start', 'bootId', 'receiptSha256']) || typeof v.workerId !== 'string' || !v.workerId.startsWith('upgrade-coordinator-') || !UUID.test(v.workerId.slice('upgrade-coordinator-'.length))
    || !Number.isSafeInteger(v.pid) || Number(v.pid) <= 0 || typeof v.start !== 'string' || !/^[0-9]{1,20}$/.test(v.start)
    || typeof v.bootId !== 'string' || !UUID.test(v.bootId) || typeof v.receiptSha256 !== 'string' || !HASH.test(v.receiptSha256)) return bad()
  return { workerId: v.workerId, pid: Number(v.pid), start: v.start, bootId: v.bootId, receiptSha256: v.receiptSha256 }
}
export function parseUpgradeIpcRequest(v: unknown): UpgradeIpcRequest {
  if (!object(v) || typeof v.nonce !== 'string' || !UUID.test(v.nonce)) return bad()
  if (v.kind === 'hello' && exact(v, ['kind', 'nonce'])) return { kind: 'hello', nonce: v.nonce }
  if (v.kind === 'dispatch' && exact(v, ['kind', 'nonce', 'binding'])) return { kind: 'dispatch', nonce: v.nonce, binding: parseUpgradeProcessBinding(v.binding) }
  return bad()
}
export function parseUpgradeIpcResponse(v: unknown): UpgradeIpcResponse {
  if (!exact(v, ['kind', 'nonce', 'identity', 'binding', 'qualification', 'signature']) || !['ready', 'accepted'].includes(String(v.kind))
    || typeof v.nonce !== 'string' || !UUID.test(v.nonce) || typeof v.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(v.signature)) return bad()
  const binding = v.kind === 'ready' ? (v.binding === null ? null : bad()) : parseUpgradeProcessBinding(v.binding)
  return { kind: v.kind as 'ready' | 'accepted', nonce: v.nonce, identity: identity(v.identity), binding, qualification: qualification(v.qualification), signature: v.signature }
}
/** Domain separation and fixed field order bind nonce, process lifetime, receipt and exact job. */
const payload = (v: Omit<UpgradeIpcResponse, 'signature'>): Buffer => Buffer.from('xpanel-upgrade-ipc-v1\0' + JSON.stringify({
  kind: v.kind, nonce: v.nonce, identity: identity(v.identity), binding: v.binding === null ? null : parseUpgradeProcessBinding(v.binding), qualification: qualification(v.qualification),
}))
export function signUpgradeIpcResponse(v: Omit<UpgradeIpcResponse, 'signature'>, key: KeyObject): UpgradeIpcResponse {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') return bad()
  return parseUpgradeIpcResponse({ ...v, signature: sign(null, payload(v), key).toString('base64') })
}
export function verifyUpgradeIpcResponse(v: unknown, request: UpgradeIpcRequest, expected: Omit<UpgradeLauncherIdentity, 'workerId'>, key: KeyObject): UpgradeIpcResponse {
  const response = parseUpgradeIpcResponse(v), checked = parseUpgradeIpcRequest(request), observed = response.identity
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' || response.nonce !== checked.nonce
    || response.kind !== (checked.kind === 'hello' ? 'ready' : 'accepted') || observed.pid !== expected.pid || observed.start !== expected.start
    || observed.bootId !== expected.bootId || observed.receiptSha256 !== expected.receiptSha256
    || JSON.stringify(response.binding) !== JSON.stringify(checked.kind === 'dispatch' ? checked.binding : null)
    || !verify(null, payload(response), key, Buffer.from(response.signature, 'base64'))) return bad()
  return response
}
/** One request/response per connection. No second frame or malformed UTF-8 is admitted. */
export function decodeUpgradeIpcFrame(bytes: Buffer): unknown {
  if (!bytes.length || bytes.length > UPGRADE_IPC_LIMIT || bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10) || bytes.includes(13)) return bad()
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)))
}
export function encodeUpgradeIpcFrame(v: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(v) + '\n')
  if (bytes.length > UPGRADE_IPC_LIMIT) return bad()
  return bytes
}
/** Local authority only: never the publisher signing key or archive authentication key. */
export function parseLauncherPublicKey(publicBytes: Buffer): KeyObject {
  // createPublicKey also accepts private PEM input; reject it before parsing a public-key file.
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(publicBytes.toString('utf8'))) return bad()
  const key = createPublicKey(publicBytes)
  if (key.asymmetricKeyType !== 'ed25519') return bad()
  return key
}

export function parseLauncherKeyPair(privateBytes: Buffer, publicBytes: Buffer): { privateKey: KeyObject; publicKey: KeyObject } {
  const privateKey = createPrivateKey(privateBytes), publicKey = parseLauncherPublicKey(publicBytes)
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519'
    || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) return bad()
  return { privateKey, publicKey }
}
