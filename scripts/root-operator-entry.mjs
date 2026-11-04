import { realpath, readlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { requireLinuxRoot } from './lifecycle-ownership.mjs'
import { withVerifiedCoordinatorOwnership, coordinatorOwnershipInfo, assertCoordinatorOwnershipCurrent } from './coordinator-ownership.mjs'
import { dispatchPreparedRootOperation, rootOperatorReviewRecord } from '../apps/agent/src/ops-upgrade-operator.ts'

// Root OS operator entry from the authenticated helper. No request-controlled authority or source paths.
requireLinuxRoot()
const args = process.argv.slice(2)
if (args.length !== 3 || !/^--kind=(upgrade|recover)$/.test(args[0]) || !/^--archive-sha256=[0-9a-f]{64}$/.test(args[1])
  || !/^--operation-id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args[2])
  || process.version !== 'v26.12.1' || process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error('ROOT_OPERATOR_ENTRY_INVALID')
const input = { kind: args[0].slice(7), expectedArchiveSha256: args[1].slice(17), operationId: args[2].slice(15) }
try {
  const result = await withVerifiedCoordinatorOwnership(async ownership => {
    const info = coordinatorOwnershipInfo(ownership), source = info.helper.releaseRoot + '/scripts/root-operator-entry.mjs'
    if (input.expectedArchiveSha256 !== info.helper.archiveSha256 || await realpath(fileURLToPath(import.meta.url)) !== source
      || await realpath(process.argv[1]) !== source || await readlink('/proc/self/exe') !== await realpath(info.nodePath)) throw new Error('ROOT_OPERATOR_ENTRY_UNOWNED')
    await assertCoordinatorOwnershipCurrent(ownership)
    return dispatchPreparedRootOperation(input, ownership)
  })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exitCode = result.phase === 'succeeded' ? 0 : 1
} catch (error) {
  process.stderr.write(JSON.stringify(rootOperatorReviewRecord(input.operationId, error)) + '\n')
  process.exitCode = 1
}
