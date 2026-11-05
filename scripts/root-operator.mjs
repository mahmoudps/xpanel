import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { getStrictOperationDatabaseOrigin, withHostOperationGuard } from '../packages/db/src/index.ts'
import { withVerifiedCoordinatorOwnership, assertCoordinatorOwnershipCurrent, coordinatorOwnershipInfo } from './coordinator-ownership.mjs'
import { readTrustedFile, requireLinuxRoot } from './lifecycle-ownership.mjs'
import { managedPathAbsent, replaceManagedFile, ensureManagedPrivateDirectory } from './lifecycle-managed-files.mjs'

const ROOT = '/var/lib/xpanel-lifecycle/operator-requests'
const PURPOSE = 'xpanel-root-lifecycle-operator-v1', current = new AsyncLocalStorage()
let visibleOperator = null
const fail = code => { throw Object.assign(new Error(code), { code }) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(JSON.stringify(value) + '\n')

/** Syntax only; transport must establish kernel UID 0 and the distinct signed operator purpose. */
export function parseRootOperatorRequest(value) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).sort().join(',') !== 'expectedArchiveSha256,kind,operationId'
    || Reflect.ownKeys(value).some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
    || !['upgrade', 'recover'].includes(value.kind) || typeof value.operationId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.operationId)
    || typeof value.expectedArchiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedArchiveSha256)) fail('ROOT_OPERATOR_REQUEST_INVALID')
  return Object.freeze({ ...value })
}

/** Native factory reads this live process-local context, never a request-provided actor or receipt. */
export async function currentRootOperatorBinding() {
  const scope = current.getStore() ?? (visibleOperator?.live ? visibleOperator : null)
  if (!scope) return null
  if (!scope.live) fail('ROOT_OPERATOR_SCOPE_EXPIRED')
  if (current.getStore() !== scope) return current.run(scope, () => currentRootOperatorBinding())
  await scope.assertCurrent()
  return Object.freeze({ purpose: PURPOSE, operationId: scope.request.operationId, requestSha256: scope.claim.entry.sha256, origin: scope.origin })
}

export async function runNativeRootOperatorCommand(input, dispatch) {
  requireLinuxRoot()
  const request = parseRootOperatorRequest(input)
  if (current.getStore()) fail('ROOT_OPERATOR_SCOPE_CONFLICT')
  const safety = await import('./lifecycle-root-safety.mjs')
  const transport = await import('../apps/agent/src/ops-upgrade-root-dispatch.ts')
  await transport.assertNativeRootOperatorDispatchHeld(dispatch)
  const dispatched = transport.getNativeRootOperatorDispatchInfo(dispatch)
  if (dispatched.request.phase !== 'apply' || ['operationId', 'kind', 'expectedArchiveSha256'].some(key => dispatched.request[key] !== request[key])) fail('ROOT_OPERATOR_DISPATCH_MISMATCH')
  if (request.kind === 'recover') await safety.assertNativeLifecycleRecoveryPrerequisites()
  else await safety.assertNativeLifecyclePrerequisites()
  return withVerifiedCoordinatorOwnership(async coordinator => {
    const owned = coordinatorOwnershipInfo(coordinator)
    if (request.expectedArchiveSha256 !== owned.helper.archiveSha256 || process.argv[1] !== owned.sourcePath) fail('ROOT_OPERATOR_SOURCE_CHANGED')
    return safety.withNativeLifecycleDatabaseAdmission(request.kind, async admitted => {
    const db = { db: admitted.db }
    let claim, origin
    const path = ROOT + '/' + request.operationId + '.json'
    const assertAuthority = async () => {
      requireLinuxRoot(); await assertCoordinatorOwnershipCurrent(coordinator)
      await transport.assertNativeRootOperatorDispatchHeld(dispatch)
      const actual = await db.db.transaction(tx => getStrictOperationDatabaseOrigin(tx))
      if (['file', 'device', 'inode', 'issuerId'].some(key => actual[key] !== origin[key])) fail('ROOT_OPERATOR_DATABASE_CHANGED')
      const anchor = await readTrustedFile('/var/lib/xpanel-agent/operation-audit/operation-audit-authority.json', { exactMode: 0o600, maxBytes: 16384 })
      const anchored = JSON.parse(anchor.bytes).origin
      if (['file', 'device', 'inode', 'issuerId'].some(key => anchored?.[key] !== origin[key])) fail('ROOT_OPERATOR_PROTECTED_DATABASE_CHANGED')
    }
    const assertCurrent = async () => { await assertAuthority(); if (claim) await readTrustedFile(path, { exactMode: 0o600, maxBytes: 16384, sha256: claim.entry.sha256 }) }
      await withHostOperationGuard(db.db, {}, async () => {
        origin = await db.db.transaction(tx => getStrictOperationDatabaseOrigin(tx))
        await assertCurrent()
        await ensureManagedPrivateDirectory(ROOT, assertAuthority)
        if (!await managedPathAbsent(path)) fail('ROOT_OPERATOR_REQUEST_ALREADY_CLAIMED')
        claim = await replaceManagedFile(path, json({ schemaVersion: 1, purpose: PURPOSE, ...request, phase: 'claimed', origin,
          coordinatorReceiptSha256: owned.receiptSha256, helper: owned.helper, claimedAt: new Date().toISOString() }), 0o600, null, assertCurrent)
      })
      const scope = { live: true, request, claim, origin, assertCurrent }
      visibleOperator = scope
      try {
        return await current.run(scope, async () => {
          const trust = await safety.readNativeReleaseTrustIdentity()
          const command = { schemaVersion: 1, command: request.kind, mode: 'apply', json: true, assumeYes: true,
            ...(request.kind === 'upgrade' ? { artifact: { path: owned.helper.archivePath, expectedArchiveSha256: owned.helper.archiveSha256,
              keyId: trust.keyId, signingKeyPath: trust.signingKeyPath } } : {}) }
          const result = await safety.executeNativeLifecycleCommand(command)
          await assertCurrent()
          const phase = result.exitCode === 0 ? 'succeeded' : 'attention'
          const resultDigest = hash(json(result))
          await replaceManagedFile(path, json({ schemaVersion: 1, purpose: PURPOSE, ...request, origin, phase, resultDigest,
            claimSha256: claim.entry.sha256, completedAt: new Date().toISOString() }), 0o600, claim.entry, assertAuthority)
          return Object.freeze({ operationId: request.operationId, kind: request.kind, phase, resultDigest, exitCode: result.exitCode })
        })
      } finally { scope.live = false; if (visibleOperator === scope) visibleOperator = null }
    }, dispatch)
  })
}
