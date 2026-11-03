import { sign, verify, type KeyObject } from 'node:crypto'
import type { UpgradeLauncherIdentity } from './ops-upgrade-ipc.ts'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const refuse = (): never => { throw new Error('ROOT_OPERATOR_PROTOCOL_INVALID') }
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',')
export interface RootOperatorRequest {
  phase: 'observe'|'apply'; operationId: string; kind: 'upgrade'|'recover'; expectedArchiveSha256: string; nonce: string
}
export interface RootOperatorResponse {
  phase: 'ready'|'finished'; request: RootOperatorRequest; identity: UpgradeLauncherIdentity
  qualification: { digest: string; observedAt: string }; resultDigest: string|null
  outcome: { phase: 'succeeded'|'attention'; exitCode: number }|null; signature: string
}
export function parseRootOperatorRequest(value: unknown): RootOperatorRequest {
  if (!exact(value, ['phase','operationId','kind','expectedArchiveSha256','nonce']) || !['observe','apply'].includes(String(value.phase)) || !['upgrade','recover'].includes(String(value.kind))
    || typeof value.operationId !== 'string' || !UUID.test(value.operationId) || typeof value.nonce !== 'string' || !UUID.test(value.nonce)
    || typeof value.expectedArchiveSha256 !== 'string' || !HASH.test(value.expectedArchiveSha256)) return refuse()
  return { phase: value.phase as RootOperatorRequest['phase'], operationId: value.operationId, kind: value.kind as RootOperatorRequest['kind'], expectedArchiveSha256: value.expectedArchiveSha256, nonce: value.nonce }
}
const parseUnsigned = (value: unknown): Omit<RootOperatorResponse, 'signature'> => {
  if (!exact(value, ['phase','request','identity','qualification','resultDigest','outcome'])) return refuse()
  const request = parseRootOperatorRequest(value.request), i = value.identity, q = value.qualification
  if (value.phase !== (request.phase === 'observe' ? 'ready' : 'finished')
    || !exact(i, ['workerId','pid','start','bootId','receiptSha256']) || typeof i.workerId !== 'string' || !i.workerId.startsWith('root-operator-') || !UUID.test(i.workerId.slice(14))
    || !Number.isSafeInteger(i.pid) || Number(i.pid) < 1 || typeof i.start !== 'string' || !/^[0-9]{1,20}$/.test(i.start) || typeof i.bootId !== 'string' || !UUID.test(i.bootId)
    || typeof i.receiptSha256 !== 'string' || !HASH.test(i.receiptSha256)
    || !exact(q, ['digest','observedAt']) || typeof q.digest !== 'string' || !HASH.test(q.digest) || typeof q.observedAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(q.observedAt) || !Number.isFinite(Date.parse(q.observedAt))
    || (request.phase === 'observe' ? value.resultDigest !== null || value.outcome !== null : typeof value.resultDigest !== 'string' || !HASH.test(value.resultDigest))) return refuse()
  const outcome = value.outcome
  if (request.phase === 'apply' && (!exact(outcome, ['phase','exitCode']) || !['succeeded','attention'].includes(String(outcome.phase))
    || !Number.isInteger(outcome.exitCode) || Number(outcome.exitCode) < 0 || Number(outcome.exitCode) > 255 || (outcome.phase === 'succeeded') !== (outcome.exitCode === 0))) return refuse()
  return { phase: value.phase as RootOperatorResponse['phase'], request,
    identity: { workerId: i.workerId, pid: Number(i.pid), start: i.start, bootId: i.bootId, receiptSha256: i.receiptSha256 },
    qualification: { digest: q.digest, observedAt: q.observedAt }, resultDigest: value.resultDigest as string|null, outcome: outcome as RootOperatorResponse['outcome'] }
}
const payload = (value: Omit<RootOperatorResponse,'signature'>): Buffer => Buffer.from('xpanel-root-lifecycle-operator-v1\0' + JSON.stringify(parseUnsigned(value)))
export function signRootOperatorResponse(value: Omit<RootOperatorResponse,'signature'>, key: KeyObject): RootOperatorResponse {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') return refuse()
  const checked = parseUnsigned(value)
  return { ...checked, signature: sign(null, payload(checked), key).toString('base64') }
}
export function verifyRootOperatorResponse(value: unknown, request: RootOperatorRequest, identity: Omit<UpgradeLauncherIdentity,'workerId'>, key: KeyObject): RootOperatorResponse {
  if (!exact(value, ['phase','request','identity','qualification','resultDigest','outcome','signature']) || typeof value.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.signature)) return refuse()
  const { signature, ...body } = value, checked = parseUnsigned(body), actual = checked.identity
  if (JSON.stringify(checked.request) !== JSON.stringify(parseRootOperatorRequest(request)) || actual.pid !== identity.pid || actual.start !== identity.start
    || actual.bootId !== identity.bootId || actual.receiptSha256 !== identity.receiptSha256 || key.type !== 'public' || key.asymmetricKeyType !== 'ed25519'
    || !verify(null, payload(checked), key, Buffer.from(signature, 'base64'))) return refuse()
  return { ...checked, signature }
}
