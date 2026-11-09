import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Release retention: which installed releases a host keeps, and the only code that removes the others.
// Every path below is a fixed product path; `host.root` is an empty prefix in production and a fixture
// directory in tests. No request, record or caller supplies a path that is removed.
const OPT = '/opt/xpanel', RELEASES = OPT + '/releases', STAGING = OPT + '/staging', CURRENT = OPT + '/current'
const LIFE = '/var/lib/xpanel-lifecycle', PREPARED = LIFE + '/prepared', TRANSITIONS = LIFE + '/installation-transitions', RECORDS = LIFE + '/release-retention'
const UNIT_DIRECTORIES = ['/etc/systemd/system', '/run/systemd/system', '/run/systemd/transient']
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const REFERENCE = /\/opt\/xpanel\/releases\/((?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8}))(?![0-9])/g
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SHA = /^[a-f0-9]{64}$/, ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, DECIMAL = /^(0|[1-9][0-9]{0,19})$/
/** An acquisition extracts into staging seconds before its prepared intent names it; younger entries stay. */
const STAGING_GRACE_MS = 15 * 60 * 1000
const TREE_LIMIT = 100_000, UNIT_FILE_LIMIT = 4096
const RECORD = 'RELEASE_RETENTION_RECORD_UNVERIFIED', OPEN = 'RELEASE_RETENTION_OPERATION_OPEN', UNSAFE = 'RELEASE_RETENTION_TARGET_UNSAFE'
const CURRENT_UNVERIFIED = 'RELEASE_RETENTION_CURRENT_UNVERIFIED', ANCESTRY = 'RELEASE_RETENTION_ANCESTRY_UNSAFE'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (value, code) => { if (!value) fail(code) }
const missing = error => error?.code === 'ENOENT'
const at = (host, path) => host.root + path
const versionOf = root => typeof root === 'string' && root.startsWith(RELEASES + '/') && VERSION.test(root.slice(RELEASES.length + 1)) ? root.slice(RELEASES.length + 1) : null
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] }
const quarantineFor = (operationId, kind, name) => `${kind === 'prepared' ? LIFE : OPT}/.retention-${operationId}/${kind}-${name}`
const targetPath = (kind, name) => `${kind === 'release' ? RELEASES : kind === 'prepared' ? PREPARED : STAGING}/${name}`
const publicItem = item => ({ kind: item.kind, name: item.name, version: item.version ?? null })
const identity = info => `${info.dev}:${info.ino}`

async function names(host, path) {
  try { return (await readdir(at(host, path))).sort() } catch (error) { if (missing(error)) return []; throw error }
}
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

/** A JSON record that only its owner (root in production) can write: regular, single-link, not a symlink. Null when absent. */
async function readRecord(host, path, maxBytes = 1024 * 1024) {
  let handle
  try { handle = await open(at(host, path), constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if (missing(error)) return null; return fail(RECORD) }
  try {
    const info = await handle.stat({ bigint: true })
    check(info.isFile() && info.uid === BigInt(host.uid) && info.nlink === 1n && (info.mode & 0o022n) === 0n && info.size <= BigInt(maxBytes), RECORD)
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile())) } catch { return fail(RECORD) }
  } finally { await handle.close() }
}

async function privateDirectory(host, path) {
  try { await mkdir(at(host, path), { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const info = await lstat(at(host, path), { bigint: true })
  check(info.isDirectory() && !info.isSymbolicLink() && info.uid === BigInt(host.uid) && (info.mode & 0o022n) === 0n, ANCESTRY)
  await syncDirectory(at(host, dirname(path)))
}

async function writeRecord(host, value) {
  const path = at(host, `${RECORDS}/${value.operationId}.json`), temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path); await syncDirectory(dirname(path))
}

/** The record drives deletion, so every path in it must be the one this module derives from its kind, name and operation. */
function parseRetentionRecord(value, operationId) {
  check(value?.schemaVersion === 1 && value.kind === 'xpanel-release-retention' && value.operationId === operationId && UUID.test(operationId)
    && ['quarantining', 'quarantined', 'complete'].includes(value.phase) && Array.isArray(value.targets) && value.targets.length <= 4096, RECORD)
  for (const target of value.targets) {
    check(['release', 'prepared', 'staging'].includes(target?.kind) && ENTRY.test(target.name) && target.path === targetPath(target.kind, target.name)
      && target.quarantine === quarantineFor(operationId, target.kind, target.name) && DECIMAL.test(target.device) && DECIMAL.test(target.inode), RECORD)
  }
  return value
}

/** Every directory a target or record is read through: a real directory only its owner can change. The last four may be absent. */
async function assertAncestry(host) {
  for (const [index, path] of ['/', '/opt', OPT, RELEASES, '/var', '/var/lib', LIFE, STAGING, PREPARED, TRANSITIONS, RECORDS].entries()) {
    let info
    try { info = await lstat(at(host, path), { bigint: true }) } catch (error) { if (missing(error) && index >= 7) continue; return fail(ANCESTRY) }
    check(info.isDirectory() && !info.isSymbolicLink() && info.uid === BigInt(host.uid) && (info.mode & 0o022n) === 0n, ANCESTRY)
  }
}

/** Every input of the keep set, from protected lifecycle records and live references. Any doubt refuses. */
export async function observeReleaseRetention(host) {
  await assertAncestry(host)
  check(await lstat(at(host, LIFE + '/writer-barrier.json')).then(() => false, error => { if (missing(error)) return true; throw error }), OPEN)
  const head = await readRecord(host, LIFE + '/HEAD', 16384)
  check(head?.schemaVersion === 1, RECORD)
  check(['idle', 'retired'].includes(head.phase), OPEN)
  for (const name of await names(host, LIFE)) {
    if (!/^coordinator-rotation-.*\.json$/.test(name)) continue
    const rotation = await readRecord(host, `${LIFE}/${name}`)
    check(rotation?.kind === 'xpanel-coordinator-rotation', RECORD)
    check(['complete', 'rolled_back'].includes(rotation.phase), OPEN)
  }

  const link = await readlink(at(host, CURRENT)).catch(() => fail(CURRENT_UNVERIFIED))
  const current = link.startsWith(host.root) ? versionOf(link.slice(host.root.length)) : null
  check(current && (await lstat(at(host, RELEASES + '/' + current)).catch(() => fail(CURRENT_UNVERIFIED))).isDirectory()
    && await realpath(at(host, CURRENT)) === await realpath(at(host, RELEASES + '/' + current)), CURRENT_UNVERIFIED)
  const installed = await readRecord(host, LIFE + '/installation.json', 64 * 1024), bootstrap = await readRecord(host, LIFE + '/bootstrap.json', 64 * 1024)
  check(installed?.status === 'active' && installed.source?.version === current && bootstrap?.version === current && bootstrap.releaseRoot === RELEASES + '/' + current, CURRENT_UNVERIFIED)

  const transitions = []
  for (const name of await names(host, TRANSITIONS)) {
    if (name.endsWith('.tmp')) continue
    const id = name.slice(0, -'.json'.length), value = await readRecord(host, `${TRANSITIONS}/${name}`)
    const previous = versionOf(value?.previousTarget), target = versionOf(value?.target?.releaseRoot)
    check(name.endsWith('.json') && UUID.test(id) && value?.schemaVersion === 1 && value.kind === 'xpanel-installation-transition' && value.operationId === id
      && previous && target && value.target.version === target && ['prepared', 'selecting', 'selected', 'publishing', 'published'].includes(value.phase)
      && [null, 'target', 'previous'].includes(value.selected), RECORD)
    transitions.push({ id, phase: value.phase, selected: value.selected, previous, target })
  }
  // The transition that published this installation must agree with the receipts about which side is live.
  const published = bootstrap.installationTransition?.operationId
  if (published !== undefined) {
    const named = transitions.find(item => item.id === published)
    check(named?.phase === 'published' && (named.selected === 'target' ? named.target === current : named.selected === 'previous' && named.previous === current), CURRENT_UNVERIFIED)
  }

  const coordinator = await readRecord(host, LIFE + '/coordinator.json', 32 * 1024)
  const helper = coordinator === null ? null : versionOf(coordinator?.helper?.releaseRoot)
  check(coordinator === null || helper && coordinator.helper.version === helper, RECORD)

  const prepared = []
  for (const name of await names(host, PREPARED)) {
    const marker = /^version-(.+)$/.exec(name)
    if (marker && VERSION.test(marker[1])) { prepared.push({ name, version: marker[1], complete: true, marker: true }); continue }
    const directory = await lstat(at(host, `${PREPARED}/${name}`))
    check(SHA.test(name) && directory.isDirectory() && !directory.isSymbolicLink(), RECORD)
    const record = await readRecord(host, `${PREPARED}/${name}/prepared.json`, 16 * 1024)
    const value = record ?? await readRecord(host, `${PREPARED}/${name}/intent.json`, 16 * 1024)
    const version = versionOf(value?.releaseRoot)
    check(version && value.archiveSha256 === name && value.kind === (record ? 'xpanel-prepared-release' : 'xpanel-prepared-release-intent'), RECORD)
    prepared.push({ name, version, complete: record !== null, marker: false })
  }

  const units = new Set()
  let files = 0
  const scan = async (directory, nested) => {
    for (const name of await names(host, directory)) {
      const path = `${directory}/${name}`
      let info
      try { info = await lstat(at(host, path)) } catch (error) { if (missing(error)) continue; throw error }
      if (info.isDirectory() && !nested && name.endsWith('.d')) await scan(path, true)
      if (!info.isFile()) continue
      check(++files <= UNIT_FILE_LIMIT && info.size <= 256 * 1024, RECORD)
      for (const match of (await readFile(at(host, path), 'utf8')).matchAll(REFERENCE)) units.add(match[1])
    }
  }
  for (const directory of UNIT_DIRECTORIES) await scan(directory, false)

  const releases = (await names(host, RELEASES)).filter(name => VERSION.test(name))
  const staging = []
  for (const name of (await names(host, STAGING)).filter(name => ENTRY.test(name))) {
    const info = await lstat(at(host, `${STAGING}/${name}`))
    staging.push({ name, changedMs: Math.max(info.mtimeMs, info.ctimeMs) })
  }
  return { current, transitions, helper, prepared, units: [...units], processes: await host.processReleases(), releases, staging, now: host.now() }
}

/** Pure keep rule over observed facts. A version is kept for every reason that names it; the rest of the store is removable. */
export function planReleaseRetention(facts) {
  const reasons = new Map()
  const keep = (version, reason) => { if (version && !(reasons.get(version) ?? []).includes(reason)) reasons.set(version, [...(reasons.get(version) ?? []), reason]) }
  keep(facts.current, 'current')
  for (const item of facts.transitions) {
    if (item.phase === 'published' && item.selected === 'target' && item.target === facts.current) keep(item.previous, 'previous')
    if (item.phase !== 'published') { keep(item.previous, 'transition'); keep(item.target, 'transition') }
  }
  keep(facts.helper, 'coordinator')
  for (const item of facts.prepared) {
    if (!item.complete) keep(item.version, 'preparation-open')
    else if (!item.marker && compare(item.version, facts.current) > 0) keep(item.version, 'prepared')
  }
  for (const version of facts.units) keep(version, 'unit')
  for (const version of facts.processes) keep(version, 'process')
  const releases = [...facts.releases].sort((a, b) => compare(b, a)), opening = facts.prepared.some(item => !item.complete)
  const kept = releases.filter(version => reasons.has(version)).map(version => ({ kind: 'release', name: version, reasons: reasons.get(version) }))
  const remove = releases.filter(version => !reasons.has(version)).map(version => ({ kind: 'release', name: version, version }))
  for (const item of facts.prepared) if (!reasons.has(item.version)) remove.push({ kind: 'prepared', name: item.name, version: item.version })
  for (const item of facts.staging) {
    const why = opening ? 'preparation-open' : facts.now - item.changedMs < STAGING_GRACE_MS ? 'recent' : null
    if (why) kept.push({ kind: 'staging', name: item.name, reasons: [why] })
    else remove.push({ kind: 'staging', name: item.name, version: null })
  }
  return { current: facts.current, kept, remove: remove.map(item => ({ ...item, path: targetPath(item.kind, item.name) })) }
}

/** One entry of a removal tree: same filesystem, owned by root, not writable by others. A hard-linked root file is
 * allowed (pnpm links dependency files from its store); unlinking a name never changes the shared inode's bytes. */
export const retentionEntrySafe = (info, device, uid) => info.dev === device && info.uid === BigInt(uid)
  && (info.isSymbolicLink() || (info.isDirectory() || info.isFile()) && (info.mode & 0o022n) === 0n)

const mounted = (mounts, path) => mounts.some(point => point === path || point.startsWith(path + '/'))

async function inspectTarget(host, target, mounts, kept) {
  const path = at(host, target.path)
  const [info, parent] = await Promise.all([lstat(path, { bigint: true }), lstat(dirname(path), { bigint: true })])
  check(info.isDirectory() && !info.isSymbolicLink() && info.gid === BigInt(host.gid) && retentionEntrySafe(info, parent.dev, host.uid)
    && !kept.has(identity(info)) && !mounted(mounts, target.path), UNSAFE)
  let count = 0
  const walk = async directory => {
    for (const name of await readdir(directory)) {
      const child = join(directory, name), entry = await lstat(child, { bigint: true })
      check(++count <= TREE_LIMIT && retentionEntrySafe(entry, info.dev, host.uid), UNSAFE)
      if (entry.isDirectory()) await walk(child)
    }
  }
  await walk(path)
  return { ...target, device: String(info.dev), inode: String(info.ino) }
}

async function inspectedPlan(host) {
  const plan = planReleaseRetention(await observeReleaseRetention(host)), mounts = await host.mounts(), kept = new Set()
  for (const item of plan.kept) if (item.kind === 'release') kept.add(identity(await lstat(at(host, `${RELEASES}/${item.name}`), { bigint: true })))
  const remove = []
  for (const target of plan.remove) remove.push(await inspectTarget(host, target, mounts, kept))
  return { ...plan, remove }
}

/** Deletes what a record moved into quarantine and marks it complete. A moved target is recognised by its recorded inode. */
async function purge(host, record) {
  const mounts = await host.mounts(), removed = []
  for (const target of record.targets) {
    const same = info => String(info.dev) === target.device && String(info.ino) === target.inode
    let held = null
    try { held = await lstat(at(host, target.quarantine), { bigint: true }) } catch (error) { if (!missing(error)) throw error }
    if (held) {
      check(held.isDirectory() && !held.isSymbolicLink() && same(held) && !mounted(mounts, target.quarantine), 'RELEASE_RETENTION_RESUME_UNCERTAIN')
      await rm(at(host, target.quarantine), { recursive: true })
    }
    const inPlace = await lstat(at(host, target.path), { bigint: true }).then(same, error => { if (missing(error)) return false; throw error })
    if (inPlace) continue
    removed.push(publicItem(target))
    host.log(`xpanel-release-retention: removed kind=${target.kind} name=${target.name} operation=${record.operationId} trigger=${record.trigger}`)
  }
  for (const directory of new Set(record.targets.map(target => dirname(target.quarantine)))) {
    try { await rmdir(at(host, directory)) } catch (error) { if (!missing(error)) throw error }
  }
  await writeRecord(host, { ...record, phase: 'complete', removed, completedAt: new Date(host.now()).toISOString() })
  return removed
}

/** Finishes a prune that stopped before completion, unless its owner process is still deleting. */
async function resumeInterrupted(host) {
  await assertAncestry(host)
  const pending = [], resumed = []
  for (const name of await names(host, RECORDS)) {
    if (!name.endsWith('.json')) continue
    const record = parseRetentionRecord(await readRecord(host, `${RECORDS}/${name}`), name.slice(0, -'.json'.length))
    if (record.phase !== 'complete') pending.push(record)
  }
  for (const record of pending) if (await host.alive(record.owner)) fail('RELEASE_RETENTION_BUSY')
  for (const record of pending) resumed.push(...await purge(host, record))
  return resumed
}

/**
 * Plans, and unless dryRun removes, every installed release, prepared record and staging entry outside the keep set.
 * The decision and the renames run under the lifecycle writer lock; deletion of the quarantine runs after it.
 */
export async function pruneReleases(host, { dryRun = false, trigger = 'operator' } = {}) {
  check(['operator', 'upgrade'].includes(trigger), 'RELEASE_RETENTION_TRIGGER_INVALID')
  const resumed = dryRun ? [] : await resumeInterrupted(host)
  const draft = await inspectedPlan(host)
  const summary = { trigger, dryRun, current: draft.current, kept: draft.kept }
  if (dryRun) return { ...summary, remove: draft.remove.map(publicItem), removed: [], resumed }
  if (!draft.remove.length) return { ...summary, remove: [], removed: [], resumed }
  const operationId = randomUUID()
  const record = await host.withLock(async assertLocked => {
    // Re-observe under the lock; a target that became live since the draft stays, a changed inode refuses.
    const locked = planReleaseRetention(await observeReleaseRetention(host))
    const targets = draft.remove.filter(target => locked.remove.some(item => item.path === target.path))
    for (const target of targets) {
      const info = await lstat(at(host, target.path), { bigint: true })
      check(String(info.dev) === target.device && String(info.ino) === target.inode, 'RELEASE_RETENTION_TARGET_CHANGED')
    }
    const value = { schemaVersion: 1, kind: 'xpanel-release-retention', operationId, trigger, phase: 'quarantining', owner: await host.owner(),
      current: locked.current, kept: locked.kept, targets: targets.map(target => ({ kind: target.kind, name: target.name, version: target.version,
        path: target.path, quarantine: quarantineFor(operationId, target.kind, target.name), device: target.device, inode: target.inode })),
      removed: [], createdAt: new Date(host.now()).toISOString(), completedAt: null }
    await privateDirectory(host, RECORDS)
    await writeRecord(host, value)
    for (const directory of new Set(value.targets.map(target => dirname(target.quarantine)))) await privateDirectory(host, directory)
    for (const target of value.targets) {
      const [quarantine, source] = await Promise.all([lstat(at(host, dirname(target.quarantine)), { bigint: true }), lstat(at(host, dirname(target.path)), { bigint: true })])
      check(quarantine.dev === source.dev, 'RELEASE_RETENTION_QUARANTINE_UNAVAILABLE')
    }
    for (const target of value.targets) {
      await assertLocked()
      await rename(at(host, target.path), at(host, target.quarantine))
      await syncDirectory(at(host, dirname(target.path))); await syncDirectory(at(host, dirname(target.quarantine)))
    }
    value.phase = 'quarantined'
    await writeRecord(host, value)
    return value
  })
  const removed = await purge(host, record)
  return { ...summary, kept: record.kept, remove: [], removed, resumed }
}

const processStart = stat => stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
async function bootId() { return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() }

/** Releases a live process runs from or names: its working directory, executable and arguments. */
async function processReleases() {
  const versions = new Set()
  const add = value => { for (const match of value.matchAll(REFERENCE)) versions.add(match[1]) }
  for (const pid of (await readdir('/proc')).filter(name => /^[1-9][0-9]*$/.test(name))) {
    for (const read of [() => readlink(`/proc/${pid}/cwd`), () => readlink(`/proc/${pid}/exe`), async () => (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ')]) {
      // A process that exited, or a kernel thread without an executable, names no release; any other failure is doubt.
      try { add(await read()) } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error?.code)) fail(RECORD) }
    }
  }
  return [...versions]
}

/** Native host for root on Linux. The writer lock is the lifecycle writer lock, held exclusively. */
export function nativeRetentionHost() {
  check(process.platform === 'linux' && process.getuid?.() === 0 && process.geteuid?.() === 0, 'RELEASE_RETENTION_ROOT_REQUIRED')
  return Object.freeze({
    root: '', uid: 0, gid: 0, now: () => Date.now(), log: line => process.stderr.write(line + '\n'), processReleases,
    async mounts() {
      return (await readFile('/proc/self/mountinfo', 'utf8')).split('\n').filter(Boolean)
        .map(line => line.split(' ')[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))))
    },
    async withLock(work) {
      const admission = await import('./lifecycle-admission.mjs')
      try { return await admission.withReleaseRetentionExclusiveAdmission(work) }
      catch (error) { if (error?.code === 'LIFECYCLE_BUSY') fail('RELEASE_RETENTION_BUSY'); throw error }
    },
    async owner() { return { pid: process.pid, start: processStart(await readFile('/proc/self/stat', 'utf8')), bootId: await bootId() } },
    async alive(owner) {
      if (!owner || owner.bootId !== await bootId() || !Number.isSafeInteger(owner.pid)) return false
      try { return processStart(await readFile(`/proc/${owner.pid}/stat`, 'utf8')) === owner.start } catch (error) { if (missing(error)) return false; throw error }
    },
  })
}

export const stableRetentionCode = error => typeof error?.code === 'string' && /^RELEASE_RETENTION_[A-Z_]{1,64}$/.test(error.code) ? error.code : 'RELEASE_RETENTION_ATTENTION_REQUIRED'
const EXIT_CODES = Object.freeze({ RELEASE_RETENTION_ROOT_REQUIRED: 3, RELEASE_RETENTION_BUSY: 4, RELEASE_RETENTION_OPERATION_OPEN: 4 })

/** `xpanel-ctl releases prune [--dry-run]`: a bounded result with names, versions and reasons, never paths or raw errors. */
export async function runReleaseRetentionCommand({ dryRun }, host) {
  try {
    const details = await pruneReleases(host ?? nativeRetentionHost(), { dryRun, trigger: 'operator' })
    return { exitCode: 0, code: dryRun ? 'RELEASE_RETENTION_PLANNED' : 'RELEASE_RETENTION_PRUNED', outcome: dryRun ? 'planned' : 'committed', details }
  } catch (error) {
    const code = stableRetentionCode(error), exitCode = EXIT_CODES[code] ?? 6
    return { exitCode, code, outcome: exitCode === 6 ? 'attention' : 'blocked' }
  }
}

export function formatReleaseRetention(result) {
  const details = result.details, label = item => `${item.kind} ${item.name}${item.kind === 'prepared' ? ` (${item.version})` : ''}`
  const lines = [`${result.code}: ${details.dryRun ? 'Nothing was removed. A prune now removes the items marked remove.' : `Removed ${details.removed.length} item(s).`}`, `current ${details.current}`]
  for (const item of details.resumed) lines.push(`resumed ${label(item)}`)
  for (const item of details.kept) lines.push(`keep    ${label(item)}: ${item.reasons.join(', ')}`)
  for (const item of details.dryRun ? details.remove : details.removed) lines.push(`${details.dryRun ? 'remove ' : 'removed'} ${label(item)}`)
  return lines.join('\n') + '\n'
}

/** After a settled successful native upgrade only. A refusal is journaled and never changes the upgrade outcome. */
export async function pruneReleasesAfterUpgrade() {
  try {
    const result = await pruneReleases(nativeRetentionHost(), { trigger: 'upgrade' })
    process.stderr.write(`xpanel-release-retention: upgrade prune current=${result.current} removed=${result.removed.length} kept=${result.kept.filter(item => item.kind === 'release').map(item => item.name).join(',')}\n`)
  } catch (error) { process.stderr.write(`xpanel-release-retention: upgrade prune withheld code=${stableRetentionCode(error)}\n`) }
}
