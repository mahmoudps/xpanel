import { spawnSync } from 'node:child_process'
import { readFileSync, readlinkSync, statfsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { profileFromOsRelease, requireValue } from './contracts.mjs'
import { isMain, parseArguments, runCli } from './cli.mjs'
import { sha256 } from './shared.mjs'

const cleanNumber = value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
const decodeMount = value => value.replace(/\\(040|011|012|134)/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)))

export function parseMountInventory(text) {
  requireValue(typeof text === 'string' && text.length <= 2 * 1024 * 1024, 'Mount inventory exceeded bounds')
  const paths = new Set()
  for (const line of text.trim().split('\n')) {
    const parts = line.split(' '), separator = parts.indexOf('-')
    requireValue(parts.length >= 10 && separator >= 6 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]), 'Malformed independent mount inventory')
    const mount = decodeMount(parts[4])
    requireValue(mount.startsWith('/') && mount.length <= 4096 && !mount.includes('\0'), 'Invalid visible mountpoint')
    paths.add(mount)
  }
  requireValue(paths.size > 0 && paths.size <= 4096, 'A bounded visible mount inventory is required')
  return [...paths].sort()
}

export function parseObservedOsRelease(text) {
  const values = {}
  for (const line of text.split('\n')) {
    const match = /^(ID|VERSION_ID|NAME)=(?:"([^"\\]*)"|'([^'\\]*)'|([^\s#]*))$/.exec(line.trim())
    if (match) values[match[1]] = match[2] ?? match[3] ?? match[4]
  }
  const osRelease = { id: values.ID, versionId: values.VERSION_ID, name: values.NAME }
  profileFromOsRelease(osRelease)
  return osRelease
}

export function diskFromStatfs(mount, stat) {
  const values = [stat.bsize, stat.blocks, stat.bfree, stat.bavail]
  requireValue(values.every(value => typeof value === 'bigint' && value >= 0n) && stat.bfree <= stat.blocks && stat.bavail <= stat.blocks, 'Independent filesystem accounting is invalid')
  const convert = value => { requireValue(value <= BigInt(Number.MAX_SAFE_INTEGER), 'Disk metric exceeds exact JSON integer range'); return Number(value) }
  return { mount, totalBytes: convert(stat.bsize * stat.blocks), usedBytes: convert(stat.bsize * (stat.blocks - stat.bfree)), availableBytes: convert(stat.bsize * stat.bavail) }
}

function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' } })
  requireValue(result.status === 0 && result.signal === null && result.error === undefined, 'An independent OS measurement command did not complete')
  return result.stdout.trim()
}

/** Independent implementation: no app parser, df output, API helper or agent import. */
export function observeServerInformation({ nonce }) {
  requireValue(process.platform === 'linux' && /^[a-f0-9]{32}$/.test(nonce), 'A bound real Linux observer invocation is required')
  const startedAt = new Date().toISOString()
  const lscpu = JSON.parse(command('/usr/bin/lscpu', ['--json']))
  const model = lscpu.lscpu?.find(item => item.field === 'Model name:')?.data
  const cores = cleanNumber(command('/usr/bin/getconf', ['_NPROCESSORS_ONLN']))
  const pages = cleanNumber(command('/usr/bin/getconf', ['_PHYS_PAGES']))
  const pageBytes = cleanNumber(command('/usr/bin/getconf', ['PAGESIZE']))
  requireValue(typeof model === 'string' && model.trim() && cores > 0 && pages > 0 && pageBytes > 0 && Number.isSafeInteger(pages * pageBytes), 'CPU or memory OS observation is unavailable')
  const mountInfo = readFileSync('/proc/self/mountinfo')
  const mounts = parseMountInventory(mountInfo.toString('utf8'))
  const disks = mounts.map(mount => diskFromStatfs(mount, statfsSync(mount, { bigint: true })))
  const osRelease = parseObservedOsRelease(readFileSync('/etc/os-release', 'utf8'))
  return {
    schemaVersion: 1, kind: 'xpanel-independent-server-information', nonce, startedAt, finishedAt: new Date().toISOString(),
    observer: { pid: process.pid, parentPid: process.ppid, uid: process.getuid(), mountNamespace: readlinkSync('/proc/self/ns/mnt'), bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), implementation: 'getconf+lscpu+mountinfo+native-statfs-v1' },
    profile: profileFromOsRelease(osRelease), osRelease,
    cpu: { cores, model: model.trim().replace(/\s+/g, ' ') }, memory: { totalBytes: pages * pageBytes }, disks, mountInfoSha256: sha256(mountInfo),
    localAddresses: [...new Set(Object.values(networkInterfaces()).flat().filter(Boolean).map(item => item.address))].sort(),
  }
}

if (isMain(import.meta.url)) await runCli(() => {
  const args = parseArguments(process.argv.slice(2), ['nonce'], ['nonce'])
  process.stdout.write(JSON.stringify(observeServerInformation({ nonce: args.nonce })) + '\n')
})
