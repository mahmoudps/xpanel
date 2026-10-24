import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, statfs } from 'node:fs/promises'
import { posix } from 'node:path'
import { performance } from 'node:perf_hooks'
import { assertOwnedFile, assertTrustedDirectory, parseInstallationReceipt, withTrustedDirectory, withTrustedFile, requireLinuxRoot } from './lifecycle-ownership.mjs'
async function rootAuthority(capability, effect = 'service.observe') {
  requireLinuxRoot()
  const native = await import('./lifecycle-root-safety.mjs')
  await native.assertLifecycleRootSafetyHeld(capability, { effect })
  return native.getLifecycleRootSafetyInfo(capability)
}

const UNITS = Object.freeze(['xpanel-management-tls.timer', 'xpanel-api.service', 'xpanel-agent.service', 'xpanel-management-tls.service'])
const COORDINATORS = new Set(['xpanel-upgrade.service', 'xpanel-lifecycle.service'])
const COMMON = ['Id', 'LoadState', 'ActiveState', 'SubState', 'FragmentPath', 'InvocationID', 'Job', 'Triggers', 'TriggeredBy', 'DropInPaths', 'NeedDaemonReload']
const SERVICE = ['MainPID', 'ControlPID', 'ControlGroup', 'KillMode']
const PROPERTIES = [...COMMON, ...SERVICE]
const LIMIT = 64 * 1024
const CGROUP_ROOT = '/sys/fs/cgroup'
const INCIDENTS = '/var/lib/xpanel-agent/file-worker-incidents'
const captures = new WeakMap()
let uncertainChild = false
const children = new Set()
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (condition, code) => { if (!condition) fail(code) }
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const digest = receipt => createHash('sha256').update(JSON.stringify(receipt)).digest('hex')
const pid = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(value) && Number(value) <= 2147483647
const unitName = value => typeof value === 'string' && /^[A-Za-z0-9_.@:-]{1,240}\.(service|timer|socket|path|slice|scope|target)$/.test(value)

/** Diagnostic identity only; runtime additionally checks the registered root-owned incident. */
export function parseFileWorkerUnit(unit) {
  const match = typeof unit === 'string' ? /^xpanel-files-([1-9][0-9]{3,4})-([0-9a-f]{32})\.service$/.exec(unit) : null
  check(match && Number(match[1]) >= 1000 && Number(match[1]) <= 65533, 'FILE_WORKER_UNIT_INVALID')
  const uid = Number(match[1])
  return freeze({ unit, uid, cgroup: `/xpanel.slice/xpanel-${uid}.slice/${unit}` })
}

export function parseFileWorkerIncident(value) {
  const keys = ['version', 'unit', 'uid', 'reason', 'status', 'recordedAt']
  check(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')), 'FILE_WORKER_INCIDENT_INVALID')
  const identity = parseFileWorkerUnit(value.unit)
  check(value.version === 1 && value.uid === identity.uid && typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 1024 && !/[\0\r\n]/.test(value.reason) && ['in-flight', 'unresolved'].includes(value.status) && typeof value.recordedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.recordedAt) && Number.isFinite(Date.parse(value.recordedAt)), 'FILE_WORKER_INCIDENT_INVALID')
  return freeze({ ...identity, status: value.status })
}

/** Syntax diagnostics only: this parser never establishes service ownership or quiescence. */
export function parseSystemctlProperties(text) {
  check(typeof text === 'string' && Buffer.byteLength(text) <= LIMIT && !/[\0\r\u0001-\u0008\u000b-\u001f\u007f]/.test(text), 'SERVICE_PROPERTIES_INVALID')
  const result = Object.create(null)
  for (const line of text.split('\n')) {
    if (!line) continue
    const separator = line.indexOf('=')
    const key = line.slice(0, separator)
    check(separator > 0 && PROPERTIES.includes(key) && !Object.hasOwn(result, key), 'SERVICE_PROPERTIES_INVALID')
    result[key] = line.slice(separator + 1)
  }
  check(COMMON.every(key => Object.hasOwn(result, key)) && unitName(result.Id), 'SERVICE_PROPERTIES_INCOMPLETE')
  check(['loaded', 'not-found', 'error', 'masked'].includes(result.LoadState) && /^[a-z-]{1,32}$/.test(result.ActiveState) && /^[a-z-]{1,48}$/.test(result.SubState), 'SERVICE_STATE_INVALID')
  check(result.InvocationID === '' || /^[a-f0-9]{32}$/.test(result.InvocationID), 'SERVICE_INVOCATION_INVALID')
  check(['yes', 'no'].includes(result.NeedDaemonReload), 'SERVICE_RELOAD_STATE_INVALID')
  check(result.Job === '' || /^(0|[1-9][0-9]{0,9})(?: [A-Za-z0-9_.@:/-]{1,256})?$/.test(result.Job), 'SERVICE_JOB_INVALID')
  for (const key of ['Triggers', 'TriggeredBy']) check(result[key] === '' || result[key].split(' ').every(unitName), 'SERVICE_ACTIVATOR_INVALID')
  if (result.Id.endsWith('.service')) {
    check(SERVICE.every(key => Object.hasOwn(result, key)) && pid(result.MainPID) && pid(result.ControlPID), 'SERVICE_PROCESS_PROPERTIES_INVALID')
    check(result.ControlGroup === '' || (result.ControlGroup.startsWith('/') && posix.normalize(result.ControlGroup) === result.ControlGroup && result.ControlGroup !== '/' && result.ControlGroup.split('/').slice(1).every(value => /^[A-Za-z0-9_.@:-]{1,255}$/.test(value))), 'SERVICE_CGROUP_INVALID')
  }
  return freeze({ ...result })
}

/** Fixed C-locale list-units columns; descriptions are deliberately not interpreted. */
export function parseControlPlaneUnitInventory(text) {
  check(typeof text === 'string' && Buffer.byteLength(text) <= LIMIT && !/[\0\r\u0001-\u0008\u000b-\u001f\u007f]/.test(text), 'SERVICE_INVENTORY_INVALID')
  const seen = new Set(), result = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [unit, load, active, sub] = line.trim().split(/\s+/)
    check(result.length < 256 && unitName(unit) && unit.startsWith('xpanel') && !seen.has(unit) && [load, active, sub].every(value => typeof value === 'string' && /^[a-z-]{1,48}$/.test(value)), 'SERVICE_INVENTORY_INVALID')
    seen.add(unit); result.push({ unit, load, active, sub })
  }
  return freeze(result)
}

export function parseSystemctlJobs(text) {
  check(typeof text === 'string' && Buffer.byteLength(text) <= LIMIT && !/[\0\r\u0001-\u0008\u000b-\u001f\u007f]/.test(text), 'SERVICE_JOBS_INVALID')
  if (text.trim() === 'No jobs running.') return freeze([])
  const seen = new Set(), jobs = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const columns = line.trim().split(/\s+/)
    check(columns.length === 4 && jobs.length < 256 && /^[1-9][0-9]{0,9}$/.test(columns[0]) && !seen.has(columns[0]) && /^[A-Za-z0-9_.@:\\-]{1,240}\.[a-z-]{1,16}$/.test(columns[1]) && /^[a-z-]{1,32}$/.test(columns[2]) && ['running', 'waiting'].includes(columns[3]), 'SERVICE_JOBS_INVALID')
    seen.add(columns[0]); jobs.push({ job: columns[0], unit: columns[1], type: columns[2], state: columns[3] })
  }
  return freeze(jobs)
}

export function parseCgroupProcesses(text) {
  check(typeof text === 'string' && Buffer.byteLength(text) <= LIMIT && (text === '' || /^(?:[1-9][0-9]{0,9}\n)+$/.test(text)), 'CGROUP_PROCESSES_INVALID')
  const values = text === '' ? [] : text.trimEnd().split('\n').map(Number)
  check(values.length <= 4096 && values.every(value => value <= 2147483647) && new Set(values).size === values.length, 'CGROUP_PROCESSES_INVALID')
  return freeze(values.sort((a, b) => a - b))
}

async function boundedFile(path, deadline) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    check(before.isFile(), 'CGROUP_FILE_INVALID')
    const chunks = []; let size = 0
    while (true) {
      check(performance.now() < deadline, 'CGROUP_SCAN_DEADLINE')
      const bytes = Buffer.alloc(4096), read = await handle.read(bytes, 0, bytes.length, null)
      if (!read.bytesRead) break
      size += read.bytesRead; check(size <= LIMIT, 'CGROUP_SCAN_LIMIT')
      chunks.push(bytes.subarray(0, read.bytesRead))
    }
    const [after, named] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
    check(!named.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino && before.dev === named.dev && before.ino === named.ino, 'CGROUP_FILE_CHANGED')
    return Buffer.concat(chunks).toString('utf8')
  } finally { await handle.close() }
}

/** Bounded real filesystem primitive. Production separately requires the trusted cgroup2 mount. */
export async function readBoundedCgroupTree(directory) {
  check(typeof directory === 'string' && directory.length <= 4096 && !directory.includes('\0'), 'CGROUP_PATH_INVALID')
  const deadline = performance.now() + 2000, seen = new Set(), nodes = []
  let entries = 0
  const visit = async (path, depth) => {
    check(performance.now() < deadline && depth <= 16 && nodes.length < 128, 'CGROUP_SCAN_LIMIT')
    const before = await lstat(path, { bigint: true })
    check(before.isDirectory() && !before.isSymbolicLink(), 'CGROUP_DIRECTORY_INVALID')
    const identity = `${before.dev}:${before.ino}`
    check(!seen.has(identity), 'CGROUP_DIRECTORY_CYCLE'); seen.add(identity)
    const processes = parseCgroupProcesses(await boundedFile(`${path}/cgroup.procs`, deadline))
    const events = await boundedFile(`${path}/cgroup.events`, deadline)
    check(/^(?:populated [01]\nfrozen [01]\n|frozen [01]\npopulated [01]\n)$/.test(events), 'CGROUP_EVENTS_INVALID')
    const populated = /^populated 1$/m.test(events)
    nodes.push({ path, device: String(before.dev), inode: String(before.ino), populated, processes })
    const iterator = await opendir(path)
    for await (const entry of iterator) {
      check(++entries <= 4096 && performance.now() < deadline, 'CGROUP_SCAN_LIMIT')
      check(!entry.isSymbolicLink(), 'CGROUP_SYMLINK_REFUSED')
      if (entry.isDirectory()) { check(/^[A-Za-z0-9_.@:-]{1,255}$/.test(entry.name), 'CGROUP_DIRECTORY_INVALID'); await visit(`${path}/${entry.name}`, depth + 1) }
    }
    const after = await lstat(path, { bigint: true })
    check(after.isDirectory() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino, 'CGROUP_DIRECTORY_CHANGED')
  }
  await visit(directory, 0)
  return freeze({ nodes, processes: [...new Set(nodes.flatMap(node => node.processes))].sort((a, b) => a - b), populated: nodes.some(node => node.populated) })
}

async function systemctl(receipt, args) {
  requireLinuxRoot(); check(!uncertainChild, 'SERVICE_CHILD_REQUIRES_INSPECTION')
  return withTrustedFile('/usr/bin/systemctl', { maxBytes: 8 * 1024 * 1024, sha256: receipt.runtime.systemctlSha256 }, async executable => {
    const result = await new Promise((resolve, reject) => {
      // Execute the retained inode, inherited as fd 3, rather than reopening a mutable pathname.
      const child = spawn('/proc/self/fd/3', ['--system', '--no-ask-password', '--no-pager', ...args], { cwd: '/', shell: false, stdio: ['ignore', 'pipe', 'pipe', executable.fd], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGERSECURE: '1' } })
      let bytes = 0, output = '', errors = '', settled = false, attention = false
      let closed
      const closing = new Promise(resolve => { closed = resolve }); children.add(closing)
      const timer = setTimeout(() => { attention = true; uncertainChild = true }, 30_000)
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value) }
      const collect = (chunk, stderr) => { bytes += chunk.length; if (bytes > LIMIT) { attention = true; uncertainChild = true; return } if (stderr) errors += chunk; else output += chunk }
      child.stdout.on('data', chunk => collect(chunk, false)); child.stderr.on('data', chunk => collect(chunk, true))
      child.once('error', () => { attention = true })
      child.once('close', (code, signal) => {
        closed(); children.delete(closing)
        if (attention || signal !== null || code === null) { uncertainChild = true; finish(Object.assign(new Error('SERVICE_CHILD_REQUIRES_INSPECTION'), { code: 'SERVICE_CHILD_REQUIRES_INSPECTION' })); return }
        finish(null, { code, output, errors })
      })
      // A deadline is an attention condition, never an invented exit. Keep the FD and physical
      // operation scope held until actual close. No signal targets a stale or caller-supplied PID.
    })
    await executable.verify()
    check(result.code === 0 && result.errors === '', 'SERVICE_COMMAND_FAILED')
    return result.output
  })
}

/** The coordinator awaits actual child close before considering physical guard retirement. */
export async function awaitOwnedServiceChildren(capability) {
  await rootAuthority(capability, 'service.observe')
  await Promise.all([...children])
  check(!uncertainChild, 'SERVICE_CHILD_REQUIRES_INSPECTION')
  await rootAuthority(capability, 'service.observe')
}

async function ownership(input) {
  requireLinuxRoot(); check(!uncertainChild, 'SERVICE_CHILD_REQUIRES_INSPECTION')
  const receipt = parseInstallationReceipt(input)
  check(receipt.units.length === UNITS.length && UNITS.every(unit => receipt.units.includes(unit)), 'CONTROL_PLANE_UNIT_COVERAGE_REQUIRED')
  for (const unit of UNITS) {
    const entry = receipt.files.find(file => file.path === `/etc/systemd/system/${unit}`)
    check(entry?.kind === 'file', 'CONTROL_PLANE_UNIT_OWNERSHIP_REQUIRED'); await assertOwnedFile(entry)
  }
  await assertTrustedDirectory(CGROUP_ROOT)
  check((await statfs(CGROUP_ROOT, { bigint: true })).type === 0x63677270n, 'CGROUP2_REQUIRED')
  return receipt
}

function rejectUnknownUnits(inventory, coordinatorUnit = null) {
  for (const item of inventory) {
    if (item.unit === coordinatorUnit && COORDINATORS.has(coordinatorUnit)) continue
    if (item.unit.startsWith('xpanel-files-')) { parseFileWorkerUnit(item.unit); continue }
    if (UNITS.includes(item.unit) || item.unit === 'xpanel.slice' || /^xpanel-[1-9][0-9]{0,9}\.slice$/.test(item.unit) || (/^xpanel-(?:php-fpm|app|cron)-/.test(item.unit) && item.unit.endsWith('.service'))) continue
    check(item.load === 'not-found' && item.active === 'inactive' && item.sub === 'dead', 'UNKNOWN_CONTROL_PLANE_UNIT_REQUIRES_INSPECTION')
  }
}

async function workerIncidents() {
  return withTrustedDirectory(INCIDENTS, async ancestry => {
    const directory = await lstat(INCIDENTS, { bigint: true })
    check(directory.uid === 0n && directory.gid === 0n && (directory.mode & 0o7777n) === 0o700n, 'FILE_WORKER_INCIDENT_DIRECTORY_UNSAFE')
    const result = new Map()
    const entries = await opendir(INCIDENTS)
    for await (const entry of entries) {
      check(result.size < 64 && entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'), 'FILE_WORKER_INCIDENT_REQUIRES_INSPECTION')
      const identity = parseFileWorkerUnit(entry.name.slice(0, -5))
      const actual = await withTrustedFile(`${INCIDENTS}/${entry.name}`, { maxBytes: 4096, exactMode: 0o600 }, async file => parseFileWorkerIncident(JSON.parse(file.bytes.toString('utf8'))))
      check(actual.unit === identity.unit && !result.has(actual.unit) && actual.status === 'in-flight', 'FILE_WORKER_INCIDENT_REQUIRES_INSPECTION')
      result.set(actual.unit, actual)
    }
    await ancestry.verify()
    const after = await lstat(INCIDENTS, { bigint: true })
    check(directory.dev === after.dev && directory.ino === after.ino && directory.mtimeNs === after.mtimeNs && directory.ctimeNs === after.ctimeNs, 'FILE_WORKER_INCIDENT_DIRECTORY_CHANGED')
    return result
  })
}

async function observeWorkers(receipt, inventory, previousPaths, allowActive) {
  const incidents = await workerIncidents()
  if (!allowActive) check(incidents.size === 0, 'FILE_WORKER_INCIDENT_REQUIRES_INSPECTION')
  const names = new Set([...incidents.keys(), ...inventory.filter(item => item.unit.startsWith('xpanel-files-')).map(item => item.unit), ...previousPaths.filter(path => posix.basename(path).startsWith('xpanel-files-')).map(path => posix.basename(path))])
  check(names.size <= 64, 'FILE_WORKER_INVENTORY_LIMIT')
  const workers = []
  for (const name of names) {
    const identity = parseFileWorkerUnit(name)
    const state = parseSystemctlProperties(await systemctl(receipt, ['show', name, `--property=${PROPERTIES.join(',')}`]))
    check(state.Id === name && ['loaded', 'not-found'].includes(state.LoadState) && state.DropInPaths === '' && state.NeedDaemonReload === 'no', 'FILE_WORKER_CONFIGURATION_DRIFT')
    if (state.LoadState === 'loaded') check(state.FragmentPath === `/run/systemd/transient/${name}` && state.KillMode === 'control-group', 'FILE_WORKER_CONFIGURATION_DRIFT')
    check(state.ControlGroup === '' || state.ControlGroup === identity.cgroup, 'FILE_WORKER_CGROUP_UNOWNED')
    const terminal = state.ActiveState === 'inactive' && state.MainPID === '0' && state.ControlPID === '0' && (state.Job === '' || state.Job === '0')
    if (!terminal) check(allowActive && incidents.has(name), 'UNREGISTERED_OR_ACTIVE_FILE_WORKER')
    workers.push({ ...identity, state, terminal })
  }
  return workers
}

async function observe(receipt, previousPaths = [], coordinatorUnit = null, allowActiveWorkers = false) {
  const units = []
  for (const unit of UNITS) {
    const state = parseSystemctlProperties(await systemctl(receipt, ['show', unit, `--property=${PROPERTIES.join(',')}`]))
    check(state.Id === unit && state.LoadState === 'loaded' && state.FragmentPath === `/etc/systemd/system/${unit}` && state.DropInPaths === '' && state.NeedDaemonReload === 'no', 'CONTROL_PLANE_UNIT_CONFIGURATION_DRIFT')
    check(state.Job === '' || state.Job === '0', 'CONTROL_PLANE_JOB_PENDING')
    check(['active', 'inactive', 'failed'].includes(state.ActiveState), 'CONTROL_PLANE_TRANSITION_PENDING')
    const triggers = state.Triggers ? state.Triggers.split(' ') : [], triggeredBy = state.TriggeredBy ? state.TriggeredBy.split(' ') : []
    check(triggers.every(name => name === 'xpanel-management-tls.service' && unit === 'xpanel-management-tls.timer') && triggeredBy.every(name => name === 'xpanel-management-tls.timer' && unit === 'xpanel-management-tls.service'), 'UNKNOWN_CONTROL_PLANE_ACTIVATOR')
    if (unit.endsWith('.service')) check(state.KillMode === 'control-group' && (state.ControlGroup === '' || posix.basename(state.ControlGroup) === unit), 'CONTROL_PLANE_CGROUP_UNOWNED')
    units.push(state)
  }
  const inventory = parseControlPlaneUnitInventory(await systemctl(receipt, ['list-units', '--all', '--plain', '--full', '--no-legend', 'xpanel*']))
  check(UNITS.every(unit => inventory.some(item => item.unit === unit && item.load === 'loaded')), 'CONTROL_PLANE_UNITS_NOT_LOADED')
  rejectUnknownUnits(inventory, coordinatorUnit)
  const workers = await observeWorkers(receipt, inventory, previousPaths, allowActiveWorkers)
  const jobs = parseSystemctlJobs(await systemctl(receipt, ['list-jobs', '--plain', '--full', '--no-legend']))
  check(!jobs.some(job => job.unit !== coordinatorUnit && !(allowActiveWorkers && workers.some(worker => worker.unit === job.unit && !worker.terminal)) && (UNITS.includes(job.unit) || /^xpanel-(?:files|management|api|agent|upgrade|lifecycle)/.test(job.unit))), 'CONTROL_PLANE_JOB_PENDING')
  const paths = [...new Set([...previousPaths, ...units.map(state => state.ControlGroup).filter(Boolean), ...workers.map(worker => worker.cgroup)])].sort()
  return { observedAt: new Date().toISOString(), units, workers, inventory, jobs, cgroups: await observeCgroups(paths) }
}

async function observeCgroups(paths) {
  const cgroups = []
  for (const path of paths) {
    const name = posix.basename(path)
    const allowed = UNITS.includes(name) || name.startsWith('xpanel-files-') && parseFileWorkerUnit(name).cgroup === path
    check(path.startsWith('/') && posix.normalize(path) === path && allowed, 'CONTROL_PLANE_CGROUP_UNOWNED')
    const full = `${CGROUP_ROOT}${path}`
    await assertTrustedDirectory(posix.dirname(full))
    try { cgroups.push({ path, exists: true, ...await readBoundedCgroupTree(full) }) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      // A disappearing descendant is not evidence that the root (and its other
      // descendants) disappeared. Only an actually absent exact root is gone.
      let rootExists = true
      try { await lstat(full) } catch (namedError) { if (namedError.code !== 'ENOENT') throw namedError; rootExists = false }
      check(!rootExists, 'CGROUP_SCAN_CHANGED')
      await assertTrustedDirectory(posix.dirname(full))
      cgroups.push({ path, exists: false, nodes: [], processes: [], populated: false })
    }
  }
  return cgroups
}

function capture(receipt, observations, previousPaths = [], authority = null) {
  const value = freeze({ observations })
  captures.set(value, { receiptSha256: digest(receipt), authority, paths: [...new Set([...previousPaths, ...observations.flatMap(item => item.cgroups.map(group => group.path))])] })
  return value
}

export function projectOwnedControlPlaneObservation(value) {
  check(captures.has(value), 'CONTROL_PLANE_CAPTURE_REQUIRED')
  return freeze(structuredClone(value))
}

async function observationAuthority(capability, prior) {
  if (capability === undefined && !prior) return null
  const info = await rootAuthority(capability, 'service.observe')
  check(COORDINATORS.has(info.coordinatorUnit), 'CONTROL_PLANE_COORDINATOR_REQUIRED')
  if (prior) check(prior.operationId === info.operationId && prior.coordinatorUnit === info.coordinatorUnit, 'CONTROL_PLANE_CAPTURE_REQUIRED')
  return Object.freeze({ operationId: info.operationId, coordinatorUnit: info.coordinatorUnit })
}

export async function observeOwnedControlPlaneUnits(input, capability) {
  const authority = await observationAuthority(capability)
  const receipt = await ownership(input)
  return capture(receipt, [await observe(receipt, [], authority?.coordinatorUnit, true)], [], authority)
}

export async function assertOwnedControlPlaneQuiescent(input, capturedBefore, capability) {
  const receipt = await ownership(input), prior = captures.get(capturedBefore)
  check(prior?.receiptSha256 === digest(receipt), 'CONTROL_PLANE_CAPTURE_REQUIRED')
  const authority = await observationAuthority(capability, prior.authority)
  const observations = []
  for (let pass = 0; pass < 2; pass++) {
    if (authority) await rootAuthority(capability, 'service.observe')
    const actual = await observe(receipt, prior.paths, authority?.coordinatorUnit)
    check(actual.units.every(state => state.ActiveState === 'inactive' && (!state.Id.endsWith('.service') || (state.MainPID === '0' && state.ControlPID === '0'))) && actual.cgroups.every(group => !group.populated && group.processes.length === 0), 'CONTROL_PLANE_NOT_QUIESCENT')
    observations.push(actual)
    if (pass === 0) await new Promise(resolve => setTimeout(resolve, 100))
  }
  return capture(receipt, observations, prior.paths, authority)
}

export async function stopAndDrainOwnedControlPlaneUnits(input, capability) {
  await rootAuthority(capability, 'service.stop')
  const receipt = await ownership(input), before = await observeOwnedControlPlaneUnits(receipt, capability)
  // Stop the only accepted activator first. PID1 stops the exact receipt-owned units.
  for (const unit of UNITS) { await rootAuthority(capability, 'service.stop'); await systemctl(receipt, ['stop', unit]); await rootAuthority(capability, 'service.stop') }
  return assertOwnedControlPlaneQuiescent(receipt, before, capability)
}

/** Post-rename observation; it never moves files or reloads/stops shared services. */
export async function observeRetiredControlPlaneUnits(input, capturedBefore, exclusiveCapability, retainedUnitFiles) {
  requireLinuxRoot(); check(!uncertainChild, 'SERVICE_CHILD_REQUIRES_INSPECTION')
  const receipt = parseInstallationReceipt(input), prior = captures.get(capturedBefore)
  check(prior?.receiptSha256 === digest(receipt), 'CONTROL_PLANE_CAPTURE_REQUIRED')
  await rootAuthority(exclusiveCapability, 'service.observe')
  const operation = await rootAuthority(exclusiveCapability, 'service.observe')
  const authority = await observationAuthority(exclusiveCapability, prior.authority)
  check(prior.authority, 'CONTROL_PLANE_CAPTURE_REQUIRED')
  check(operation.kind === 'uninstall' && retainedUnitFiles && Array.isArray(retainedUnitFiles) && retainedUnitFiles.length === UNITS.length, 'RETIRED_UNIT_OWNERSHIP_REQUIRED')
  const paths = new Set()
  for (const mapping of retainedUnitFiles) {
    check(mapping && typeof mapping === 'object' && Reflect.ownKeys(mapping).length === 2 && Object.hasOwn(mapping, 'originalPath') && Object.hasOwn(mapping, 'retainedPath') && !paths.has(mapping.originalPath), 'RETIRED_UNIT_OWNERSHIP_REQUIRED')
    const entry = receipt.files.find(file => file.path === mapping.originalPath)
    check(entry?.kind === 'file' && UNITS.some(unit => entry.path === `/etc/systemd/system/${unit}`) && mapping.retainedPath === `${entry.path}.xpanel-retained-${operation.operationId}`, 'RETIRED_UNIT_OWNERSHIP_REQUIRED')
    paths.add(mapping.originalPath)
    await assertOwnedFile({ ...entry, path: mapping.retainedPath })
    let exists = true
    try { await lstat(entry.path) } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false }
    check(!exists, 'RETIRED_UNIT_ORIGINAL_PRESENT')
  }
  await assertTrustedDirectory(CGROUP_ROOT)
  check((await statfs(CGROUP_ROOT, { bigint: true })).type === 0x63677270n, 'CGROUP2_REQUIRED')
  const observations = []
  for (let pass = 0; pass < 2; pass++) {
    await rootAuthority(exclusiveCapability, 'service.observe')
    const inventory = parseControlPlaneUnitInventory(await systemctl(receipt, ['list-units', '--all', '--plain', '--full', '--no-legend', 'xpanel*']))
    rejectUnknownUnits(inventory, authority.coordinatorUnit)
    await observeWorkers(receipt, inventory, prior.paths, false)
    check(inventory.filter(item => UNITS.includes(item.unit)).every(item => item.load === 'not-found' && item.active === 'inactive' && item.sub === 'dead'), 'RETIRED_UNIT_STILL_LOADED')
    const jobs = parseSystemctlJobs(await systemctl(receipt, ['list-jobs', '--plain', '--full', '--no-legend']))
    check(!jobs.some(job => job.unit !== authority.coordinatorUnit && (UNITS.includes(job.unit) || /^xpanel-(?:files|management|api|agent|upgrade|lifecycle)/.test(job.unit))), 'RETIRED_UNIT_JOB_PENDING')
    const cgroups = await observeCgroups(prior.paths)
    check(cgroups.every(group => !group.populated && group.processes.length === 0), 'CONTROL_PLANE_NOT_QUIESCENT')
    observations.push({ observedAt: new Date().toISOString(), units: [], inventory, jobs, cgroups })
    if (pass === 0) await new Promise(resolve => setTimeout(resolve, 100))
  }
  await rootAuthority(exclusiveCapability, 'service.observe')
  return capture(receipt, observations, prior.paths, authority)
}
