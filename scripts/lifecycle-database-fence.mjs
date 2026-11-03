import { constants } from 'node:fs'
import { open, lstat, readFile, readdir, readlink, stat, statfs } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

const DATABASE = '/var/lib/xpanel/control.db'
const SIDECARS = ['-wal', '-shm', '-journal']
const fail = code => { throw Object.assign(new Error(code), { code }) }
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink
const contentSame = (a, b) => same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

/** Diagnostics only; neither a parsed /proc row nor an FD mode grants authority. */
export function parseDatabaseFenceFdFlags(text) {
  const rows = typeof text === 'string' ? text.split('\n').filter(line => line.startsWith('flags:')) : []
  if (rows.length !== 1 || !/^flags:\s+[0-7]{1,16}$/.test(rows[0])) fail('LIFECYCLE_DATABASE_FD_FLAGS_INVALID')
  const flags = BigInt('0o' + rows[0].split(/\s+/)[1])
  return Number(flags & 3n)
}

export function parseDatabaseFenceProcess(text) {
  const end = typeof text === 'string' ? text.lastIndexOf(')') : -1
  const fields = end < 0 ? [] : text.slice(end + 2).trim().split(/\s+/)
  if (!/^[1-9][0-9]* \(/.test(text ?? '') || !/^[0-9]+$/.test(fields[19] ?? '')) fail('LIFECYCLE_DATABASE_PROCESS_INVALID')
  const pid = Number(text.slice(0, text.indexOf(' ')))
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) fail('LIFECYCLE_DATABASE_PROCESS_INVALID')
  return Object.freeze({ pid, start: fields[19] })
}

async function processGone(pid) {
  try { await lstat('/proc/' + pid); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
async function absentSidecars() {
  for (const suffix of SIDECARS) {
    try { await lstat(DATABASE + suffix); fail('LIFECYCLE_DATABASE_SIDECAR_PRESENT') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

/** Conservative native census: no foreign DB descriptors or mappings, no residual database-owner process.
 * Read-only self descriptors are allowed for the held observer. It cannot open a writer or stop a process. */
async function assertNoDatabaseWriters(database, assertAuthority) {
  await assertAuthority()
  const proc = await statfs('/proc', { bigint: true })
  if (proc.type !== 0x9fa0n) fail('LIFECYCLE_PROC_MOUNT_REQUIRED')
  const deadline = performance.now() + 5000
  let descriptors = 0, processes = 0
  const names = (await readdir('/proc')).filter(name => /^[1-9][0-9]*$/.test(name))
  if (names.length > 32768) fail('LIFECYCLE_DATABASE_CENSUS_LIMIT')
  for (const pid of names) {
    if (++processes > 32768 || performance.now() > deadline) fail('LIFECYCLE_DATABASE_CENSUS_LIMIT')
    try {
      const before = parseDatabaseFenceProcess(await readFile('/proc/' + pid + '/stat', 'utf8'))
      const status = await readFile('/proc/' + pid + '/status', 'utf8')
      const uid = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/m.exec(status)
      if (!uid) fail('LIFECYCLE_DATABASE_PROCESS_INVALID')
      if (Number(pid) !== process.pid && uid.slice(1).some(value => BigInt(value) === database.uid)) fail('LIFECYCLE_DATABASE_OWNER_PROCESS_REMAINS')
      for (const descriptor of await readdir('/proc/' + pid + '/fd')) {
        if (!/^[0-9]+$/.test(descriptor) || ++descriptors > 131072 || performance.now() > deadline) fail('LIFECYCLE_DATABASE_CENSUS_LIMIT')
        const path = '/proc/' + pid + '/fd/' + descriptor
        let target, info
        try { target = await readlink(path); info = await stat(path, { bigint: true }) }
        catch (error) { if (error.code === 'ENOENT') continue; throw error }
        const named = target.replace(/ \(deleted\)$/, '')
        if (!(info.dev === database.dev && info.ino === database.ino) && ![DATABASE, ...SIDECARS.map(suffix => DATABASE + suffix)].includes(named)) continue
        const flags = parseDatabaseFenceFdFlags(await readFile('/proc/' + pid + '/fdinfo/' + descriptor, 'utf8'))
        const after = await stat(path, { bigint: true })
        if (!same(info, after) || target !== await readlink(path)) fail('LIFECYCLE_DATABASE_DESCRIPTOR_CHANGED')
        if (Number(pid) !== process.pid || flags !== 0 || info.dev !== database.dev || info.ino !== database.ino || target !== DATABASE) fail('LIFECYCLE_DATABASE_WRITER_REMAINS')
      }
      const maps = await readFile('/proc/' + pid + '/maps', 'utf8')
      if (Buffer.byteLength(maps) > 16 * 1024 * 1024) fail('LIFECYCLE_DATABASE_CENSUS_LIMIT')
      for (const line of maps.split('\n')) {
        const match = /^[a-f0-9]+-[a-f0-9]+\s+([rwxps-]{4})\s+[a-f0-9]+\s+([a-f0-9]+):([a-f0-9]+)\s+([0-9]+)(?:\s+(.+))?$/.exec(line)
        if (!match) continue
        const named = (match[5] ?? '').replace(/ \(deleted\)$/, '')
        const major = (database.dev >> 8n & 0xfffn) | (database.dev >> 32n & 0xfffff000n)
        const minor = (database.dev & 0xffn) | (database.dev >> 12n & 0xffffff00n)
        const physical = BigInt('0x' + match[2]) === major && BigInt('0x' + match[3]) === minor && BigInt(match[4]) === database.ino
        if (!physical && ![DATABASE, ...SIDECARS.map(suffix => DATABASE + suffix)].includes(named)) continue
        if (Number(pid) !== process.pid || match[1].includes('w') || named !== DATABASE || !physical) fail('LIFECYCLE_DATABASE_MAPPING_REMAINS')
      }
      if (JSON.stringify(before) !== JSON.stringify(parseDatabaseFenceProcess(await readFile('/proc/' + pid + '/stat', 'utf8')))) fail('LIFECYCLE_DATABASE_PROCESS_CHANGED')
    } catch (error) {
      // Vanishing processes are absent, not successful live-writer evidence. Every surviving process must be readable.
      if ((error.code === 'ENOENT' || error.code === 'ESRCH') && await processGone(pid)) continue
      throw error
    }
  }
  await assertAuthority()
}

/** Root producer supplies the actual EX + drained-unit assertion, never public request data.
 * The returned object is intentionally not an authorization capability; admission brands the surrounding scope. */
export async function withClosedDatabasePins(origin, assertAuthority, callback) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0
    || origin?.file !== DATABASE || typeof assertAuthority !== 'function' || typeof callback !== 'function') fail('LIFECYCLE_DATABASE_FENCE_REQUIRED')
  await assertAuthority(); await absentSidecars()
  const file = await open(DATABASE, constants.O_RDONLY | constants.O_NOFOLLOW)
  let parent
  try {
    parent = await open('/var/lib/xpanel', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const initial = await file.stat({ bigint: true }), directory = await parent.stat({ bigint: true })
    if (!initial.isFile() || initial.nlink !== 1n || initial.uid === 0n || initial.gid === 0n || (initial.mode & 0o7777n) !== 0o660n
      || String(initial.dev) !== origin.device || String(initial.ino) !== origin.inode || !directory.isDirectory()
      || directory.uid !== initial.uid || directory.gid !== initial.gid || ![0o2770n, 0o2750n].includes(directory.mode & 0o7777n)) fail('LIFECYCLE_DATABASE_FENCE_IDENTITY_CHANGED')
    let live = true
    const assertCurrent = async () => {
      if (!live) fail('LIFECYCLE_DATABASE_FENCE_RETIRED')
      await assertAuthority()
      const [held, named, heldParent, namedParent] = await Promise.all([file.stat({ bigint: true }), lstat(DATABASE, { bigint: true }), parent.stat({ bigint: true }), lstat('/var/lib/xpanel', { bigint: true })])
      if (!contentSame(initial, held) || !contentSame(initial, named) || !same(directory, heldParent) || !same(directory, namedParent)) fail('LIFECYCLE_DATABASE_FENCE_CHANGED')
      await absentSidecars(); await assertNoDatabaseWriters(initial, assertAuthority); await absentSidecars()
    }
    try { await assertCurrent(); const result = await callback(Object.freeze({ assertCurrent })); await assertCurrent(); return result }
    finally { live = false }
  } finally { try { if (parent) await parent.close() } finally { await file.close() } }
}
