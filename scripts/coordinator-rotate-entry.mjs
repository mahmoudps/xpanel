import { withExistingPreparedRelease } from './prepared-release.mjs'
import { rotatePreparedCoordinator } from './coordinator-rotation.mjs'
import { requireLinuxRoot } from './lifecycle-ownership.mjs'

requireLinuxRoot()
const args = process.argv.slice(2)
if (args.length !== 4 || !/^--artifact=\/[^\u0000-\u0020\u007f]+\.tar\.gz$/.test(args[0])
  || !/^--archive-sha256=[a-f0-9]{64}$/.test(args[1]) || !/^--operation-id=[a-f0-9-]{36}$/.test(args[2])
  || !/^--mode=(?:apply|recover|rollback)$/.test(args[3])) throw Object.assign(new Error('COORDINATOR_ROTATION_ARGUMENTS_INVALID'), { code: 'COORDINATOR_ROTATION_ARGUMENTS_INVALID' })
const result = await withExistingPreparedRelease({ artifactPath: args[0].slice('--artifact='.length), expectedArchiveSha256: args[1].slice('--archive-sha256='.length) },
  prepared => rotatePreparedCoordinator({ operationId: args[2].slice('--operation-id='.length), mode: args[3].slice('--mode='.length) }, prepared))
process.stdout.write(JSON.stringify(result) + '\n')
