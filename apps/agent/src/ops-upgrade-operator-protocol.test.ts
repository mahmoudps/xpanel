import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseRootOperatorRequest, signRootOperatorResponse, verifyRootOperatorResponse, type RootOperatorRequest } from './ops-upgrade-operator-protocol.ts'
import { verifyUpgradeIpcResponse } from './ops-upgrade-ipc.ts'
const keys = generateKeyPairSync('ed25519')
const identity = { workerId: 'root-operator-' + randomUUID(), pid: 42, start: '100', bootId: randomUUID(), receiptSha256: 'a'.repeat(64) }
const qualification = { digest: 'b'.repeat(64), observedAt: '2026-11-03T00:00:00.000Z' }
const request = (): RootOperatorRequest => ({ phase: 'observe', operationId: randomUUID(), kind: 'upgrade', expectedArchiveSha256: 'c'.repeat(64), nonce: randomUUID() })
const signReady = (input: RootOperatorRequest) => signRootOperatorResponse({ phase: 'ready', request: input, identity, qualification, resultDigest: null, outcome: null }, keys.privateKey)

// Portable wire/cryptographic protocol only; no kernel peer, filesystem, services or native upgrade qualification.
describe('distinct root operator protocol', () => {
  it('binds nonce, durable operation ID, purpose, target archive and coordinator lifetime', () => {
    const input = request(), response = signReady(input)
    expect(verifyRootOperatorResponse(response, input, identity, keys.publicKey)).toEqual(response)
    for (const changed of [{ ...input, operationId: randomUUID() }, { ...input, nonce: randomUUID() }, { ...input, kind: 'recover' as const }, { ...input, expectedArchiveSha256: 'd'.repeat(64) }]) {
      expect(() => verifyRootOperatorResponse(response, changed, identity, keys.publicKey)).toThrow()
    }
    expect(() => verifyRootOperatorResponse(response, input, { ...identity, start: '101' }, keys.publicKey)).toThrow()
    expect(() => verifyRootOperatorResponse(response, input, identity, generateKeyPairSync('ed25519').publicKey)).toThrow()
  })
  it('never accepts root operator evidence on the agent protocol', () => {
    const input = request(), response = signReady(input)
    expect(() => verifyUpgradeIpcResponse(response, { kind: 'hello', nonce: input.nonce }, identity, keys.publicKey)).toThrow()
  })
  it('refuses caller-controlled paths, actor identity, commands, credentials and authority', () => {
    for (const extra of [{ artifactPath: '/tmp/archive.tar.gz' }, { actor: 'root' }, { principalId: randomUUID() }, { command: 'uninstall' }, { authority: {} }, { token: 'fixture' }]) {
      expect(() => parseRootOperatorRequest({ ...request(), ...extra })).toThrow()
    }
  })
  it('authenticates the actual outcome and refuses a success label for a failed command', () => {
    const input = { ...request(), phase: 'apply' as const }, resultDigest = 'd'.repeat(64)
    const response = signRootOperatorResponse({ phase: 'finished', request: input, identity, qualification, resultDigest, outcome: { phase: 'attention', exitCode: 1 } }, keys.privateKey)
    expect(verifyRootOperatorResponse(response, input, identity, keys.publicKey).outcome).toEqual({ phase: 'attention', exitCode: 1 })
    expect(() => verifyRootOperatorResponse({ ...response, outcome: { phase: 'succeeded', exitCode: 0 } }, input, identity, keys.publicKey)).toThrow()
    expect(() => signRootOperatorResponse({ phase: 'finished', request: input, identity, qualification, resultDigest, outcome: { phase: 'succeeded', exitCode: 1 } }, keys.privateKey)).toThrow()
  })
  it('binds the measured hosted UID digest and rejects forged qualification', () => {
    const input = request(), response = signReady(input)
    expect(() => verifyRootOperatorResponse({ ...response, qualification: { ...qualification, digest: 'd'.repeat(64) } }, input, identity, keys.publicKey)).toThrow()
    expect(() => verifyRootOperatorResponse({ ...response, qualification: { available: true } }, input, identity, keys.publicKey)).toThrow()
  })
})
