import { existsSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Resource pressure never turns an unexecuted browser case into a pass or skip. */
export function requireBrowserDiskHeadroom(root, minimumMiB, output) {
  const volume = statfsSync(root)
  const freeBytes = Number(volume.bavail) * Number(volume.bsize)
  if (freeBytes >= minimumMiB * 1024 * 1024) return freeBytes
  const report = { status: 'pending', code: 'BROWSER_RESOURCE_PRESSURE', freeBytes, minimumMiB, unexecutedCasesPassed: false }
  if (output && existsSync(output)) writeFileSync(join(output, 'resource-pressure.json'), JSON.stringify(report, null, 2) + '\n')
  const error = Object.assign(new Error('Browser cases remain pending: insufficient disk headroom.'), report)
  process.stderr.write(JSON.stringify(report) + '\n')
  throw error
}
