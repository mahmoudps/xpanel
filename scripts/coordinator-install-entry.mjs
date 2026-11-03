import { withExistingPreparedRelease, parsePreparedReleaseInput } from './prepared-release.mjs'
import { installPreparedCoordinator } from './coordinator-install.mjs'
import { requireLinuxRoot } from './lifecycle-ownership.mjs'

requireLinuxRoot()
const args = process.argv.slice(2)
if (args.length !== 2 || !args[0]?.startsWith('--artifact=')
  || !/^--archive-sha256=[a-f0-9]{64}$/.test(args[1])) throw Object.assign(new Error('COORDINATOR_INSTALL_ARGUMENTS_INVALID'), { code: 'COORDINATOR_INSTALL_ARGUMENTS_INVALID' })
const artifact = parsePreparedReleaseInput({ artifactPath: args[0].slice('--artifact='.length), expectedArchiveSha256: args[1].slice('--archive-sha256='.length) })
const result = await withExistingPreparedRelease(artifact, installPreparedCoordinator)
process.stdout.write(JSON.stringify(result) + '\n')
