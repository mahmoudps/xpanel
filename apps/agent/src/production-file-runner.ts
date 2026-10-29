import { existsSync } from 'node:fs'
import { fail } from '@xpanel/core'
import { DEFAULT_FILE_WORKER_INCIDENT_DIR, MAX_CONFINED_ACCOUNT_ID, MIN_CONFINED_ACCOUNT_ID, NativeAccountFileRunner, verifyHelperBinary } from './account-file-runner.ts'
import type { AccountFileContext } from './file-manager.ts'
import { readInstalledHelperDigest } from './installed-helper-digest.ts'

export { DEFAULT_FILE_WORKER_INCIDENT_DIR } from './account-file-runner.ts'

const accountSlicePath = (account: Readonly<AccountFileContext['account']>): string => {
  if (!Number.isSafeInteger(account.uid) || account.uid < MIN_CONFINED_ACCOUNT_ID || account.uid > MAX_CONFINED_ACCOUNT_ID) {
    return fail('VALIDATION', 'account cgroup requires a valid confined account UID')
  }
  return '/sys/fs/cgroup/xpanel.slice/xpanel-' + account.uid + '.slice'
}

/** Builds the daemon runner with mandatory per-account cgroup placement. */
export const createProductionAccountFileRunner = async (
  binaryPath: string,
  options: { incidentDir?: string; onRecoveryRequired?: () => void | Promise<void> } = {},
): Promise<NativeAccountFileRunner | undefined> => {
  // A helper without the installer's root-owned digest file stays unavailable; one that no longer matches it is refused.
  const digest = existsSync(binaryPath) ? await readInstalledHelperDigest(binaryPath) : null
  const installed = digest !== null
  const expectedSha256 = installed ? await verifyHelperBinary(binaryPath, digest) : undefined
  const runner = new NativeAccountFileRunner({
    binaryPath,
    expectedSha256,
    cgroupPathForAccount: accountSlicePath,
    requireCgroup: true,
    incidentDir: options.incidentDir ?? DEFAULT_FILE_WORKER_INCIDENT_DIR,
    onRecoveryRequired: options.onRecoveryRequired,
  })
  await runner.initialize()
  return installed ? runner : undefined
}
