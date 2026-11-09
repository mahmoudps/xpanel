import { createHash } from 'node:crypto'
import { constants, readFileSync, readlinkSync, statSync } from 'node:fs'
import { lstat, open, readlink, readdir, realpath, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { posix } from 'node:path'
import { requireLinuxRoot, readInstallationReceipt, readTrustedFile, withTrustedDirectory, withTrustedFile, assertOwnedFile, assertTrustedDirectory } from './lifecycle-ownership.mjs'
import { LIFECYCLE_LOCK } from './lifecycle-admission.mjs'
import { observeOwnedControlPlaneUnits, projectOwnedControlPlaneObservation, readBoundedCgroupTree } from './lifecycle-services.mjs'
import { captureManagementTlsReadiness, readManagementTlsReadiness } from './management-tls.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (value, code) => { if (!value) fail(code) }
const SHA = /^[a-f0-9]{64}$/
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/
const WINDOW_MS = 30_000
const hash = value => createHash('sha256').update(value).digest('hex')
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') { check(Number.isFinite(value), 'INSTALL_READINESS_DATA_INVALID'); return JSON.stringify(value) }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  check(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'INSTALL_READINESS_DATA_INVALID')
  return '{' + Object.keys(value).sort().map(key => {
    check(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'), 'INSTALL_READINESS_DATA_INVALID')
    return JSON.stringify(key) + ':' + canonical(value[key])
  }).join(',') + '}'
}
function checkedContext(context, adoption = false) {
  check(context && context.source?.root === '/opt/xpanel' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(context.source.version)
    && context.runtime?.nodeVersion === '26.12.1' && typeof context.runtime.nodePath === 'string'
    && posix.isAbsolute(context.runtime.nodePath) && posix.normalize(context.runtime.nodePath) === context.runtime.nodePath
    && !/^\/(?:home(?:[0-9]+)?|tmp|var\/tmp)(?:\/|$)/.test(context.runtime.nodePath)
    && [context.source.archiveSha256, context.source.manifestSha256, context.source.dependencyReceiptSha256,
      context.runtime.nodeSha256, context.runtime.systemctlSha256, context.runtime.nginxSha256, context.admissionFingerprint].every(value => typeof value === 'string' && SHA.test(value))
    && context.database?.file === '/var/lib/xpanel/control.db' && DECIMAL.test(context.database.device) && DECIMAL.test(context.database.inode)
    && (adoption ? Number.isSafeInteger(context.state?.accountCount) && context.state.accountCount > 0 && SHA.test(context.state.accountLifetimeDigest) : context.state?.accountCount === 0) && Number.isSafeInteger(context.state.revision) && context.state.revision >= 0
    && SHA.test(context.state.checksum) && typeof context.rootPrincipalId === 'string', 'INSTALL_READINESS_CONTEXT_INVALID')
  return JSON.parse(canonical(context))
}
function checkedFacts(facts, context) {
  check(facts && Array.isArray(facts.processes) && facts.processes.length === 2, 'INSTALL_READINESS_PROCESS_INVALID')
  for (const role of ['api', 'agent']) {
    const matches = facts.processes.filter(item => item.role === role)
    check(matches.length === 1, 'INSTALL_READINESS_PROCESS_INVALID')
    const item = matches[0]
    check(Number.isSafeInteger(item.pid) && item.pid > 0 && item.pid <= 2147483647 && DECIMAL.test(item.start)
      && Number.isSafeInteger(item.uid) && (role === 'agent' ? item.uid === 0 : item.uid > 0)
      && item.executable === context.runtime.nodePath
      && item.cwd === '/opt/xpanel/releases/' + context.source.version
      && item.cgroup === '/system.slice/xpanel-' + role + '.service'
      && /^[a-f0-9]{32}$/.test(item.invocationId) && DECIMAL.test(item.socketDevice) && DECIMAL.test(item.socketInode), 'INSTALL_READINESS_PROCESS_INVALID')
  }
  check(facts.ingress && SHA.test(facts.ingress.configSha256) && SHA.test(facts.ingress.certificateSha256)
    && canonical([...facts.ingress.audiences].sort()) === canonical(['xmail', 'xpanel', 'xwhm']), 'INSTALL_READINESS_INGRESS_INVALID')
  return JSON.parse(canonical(facts))
}

/** Internal pure orchestration; only the fixed native singleton below is exported. */
function createReadinessObserver(ports, validateContext = checkedContext) {
  const captures = new Map()
  const now = () => { const value = ports.now(); check(Number.isFinite(value), 'INSTALL_READINESS_CLOCK_INVALID'); return value }
  return {
    async capture(input, subjectDigest) {
      ports.assertRoot()
      const context = validateContext(input), started = now()
      check(typeof subjectDigest === 'string' && SHA.test(subjectDigest), 'INSTALL_READINESS_SUBJECT_INVALID')
      for (const [key, value] of captures) if (value.expires <= started) captures.delete(key)
      check(captures.size < 16, 'INSTALL_READINESS_CAPTURE_LIMIT')
      const before = checkedFacts(await ports.readFacts(context), context)
      const served = await ports.observeHttps()
      check(canonical(served) === canonical(before.pins.management), 'INSTALL_READINESS_INGRESS_CHANGED')
      const after = checkedFacts(await ports.readFacts(context), context)
      check(canonical(before) === canonical(after), 'INSTALL_READINESS_CHANGED')
      check(now() >= started && now() < started + WINDOW_MS, 'INSTALL_READINESS_EXPIRED')
      const observation = { subjectDigest, observedAt: new Date(started).toISOString(), expiresAt: new Date(started + WINDOW_MS).toISOString(),
        mode: 'normal', processes: after.processes, ingress: after.ingress }
      const key = hash(canonical({ context, observation }))
      captures.set(key, { facts: after, expires: started + WINDOW_MS, observationDigest: hash(canonical(observation)) })
      return JSON.parse(canonical(observation))
    },
    async assertCurrent(input, observation) {
      ports.assertRoot()
      const context = validateContext(input), key = hash(canonical({ context, observation })), saved = captures.get(key)
      check(saved && observation.mode === 'normal', 'INSTALL_READINESS_CAPTURE_REQUIRED')
      check(now() >= Date.parse(observation.observedAt) && now() < saved.expires, 'INSTALL_READINESS_EXPIRED')
      // No HTTPS/DNS/SH operation is reachable here. EX is already held by the native factory.
      const actual = checkedFacts(await ports.readFacts(context, JSON.parse(canonical(saved.facts))), context)
      check(canonical(actual) === canonical(saved.facts), 'INSTALL_READINESS_CHANGED')
      check(now() >= Date.parse(observation.observedAt) && now() < saved.expires, 'INSTALL_READINESS_EXPIRED')
    },
    release(observation) {
      let digest
      try { digest = hash(canonical(observation)) } catch { return }
      for (const [key, value] of captures) if (value.observationDigest === digest) captures.delete(key)
    },
  }
}

const fileIdentity = info => ({ device: String(info.dev), inode: String(info.ino), uid: Number(info.uid), gid: Number(info.gid),
  mode: Number(info.mode & 0o7777n), size: String(info.size), mtime: String(info.mtimeNs), ctime: String(info.ctimeNs) })

async function readReadinessRuntime(runtime, previous) {
  if (!previous) return readTrustedFile(runtime.nodePath, { maxBytes: 256 * 1024 * 1024, sha256: runtime.nodeSha256 })
  const { sha256, ...expected } = previous.pins.node
  check(sha256 === runtime.nodeSha256, 'INSTALL_READINESS_RUNTIME_CHANGED')
  return withTrustedDirectory(posix.dirname(runtime.nodePath), async ancestry => {
    const handle = await open(runtime.nodePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const matches = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
        && canonical(fileIdentity(info)) === canonical(expected)
      const info = await handle.stat({ bigint: true })
      check(matches(info), 'INSTALL_READINESS_RUNTIME_CHANGED')
      await ancestry.verify()
      const named = await lstat(runtime.nodePath, { bigint: true })
      check(matches(named) && matches(await handle.stat({ bigint: true })), 'INSTALL_READINESS_RUNTIME_CHANGED')
      return { info, sha256 }
    } finally { await handle.close() }
  })
}

async function procText(root, name, maxBytes = 64 * 1024) {
  const handle = await open(root + '/' + name, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const deadline = performance.now() + 2000, chunks = []; let size = 0
    for (;;) {
      check(performance.now() < deadline, 'INSTALL_READINESS_PROC_DEADLINE')
      const buffer = Buffer.alloc(4096), result = await handle.read(buffer, 0, buffer.length, null)
      if (!result.bytesRead) break
      size += result.bytesRead; check(size <= maxBytes, 'INSTALL_READINESS_PROC_LIMIT'); chunks.push(buffer.subarray(0, result.bytesRead))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await handle.close() }
}
function processStart(text) {
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
  check(fields.length > 19 && /^(?:R|S|D|I)$/.test(fields[0]) && /^[1-9][0-9]*$/.test(fields[19]), 'INSTALL_READINESS_PROCESS_INVALID')
  return fields[19]
}

async function isWriterLockChild(pid, process, lock, tool) {
  let directory
  try {
    directory = await open('/proc/' + pid, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const root = '/proc/self/fd/' + directory.fd
    const identity = async () => {
      const text = await procText(root, 'stat')
      const parent = text.slice(text.lastIndexOf(')') + 2).split(/\s+/)[1]
      return [Number(parent), processStart(text)]
    }
    const [parent, start] = await identity()
    if (parent !== process.pid) return false
    const ids = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/m.exec(await procText(root, 'status'))
    if (!ids || !ids.slice(1).every(id => Number(id) === process.uid)
      || await procText(root, 'cgroup') !== '0::' + process.cgroup + '\n'
      || await procText(root, 'cmdline') !== ['/proc/self/fd/4', '--shared', '--timeout', '15', '3', ''].join('\0')
      || await readlink(root + '/exe') !== '/usr/bin/flock') return false
    const same = (actual, expected) => actual.dev === expected.dev && actual.ino === expected.ino
    const [exe, lockFd, toolFd] = await Promise.all(['exe', 'fd/3', 'fd/4'].map(name => stat(root + '/' + name, { bigint: true })))
    if (!same(exe, tool.info) || !same(toolFd, tool.info) || !same(lockFd, lock.info)) return false
    const [afterParent, afterStart] = await identity()
    return afterParent === parent && afterStart === start && same(await stat(root + '/exe', { bigint: true }), tool.info)
  } catch (error) {
    // A retired or unreadable PID cannot be authenticated as a lock child.
    if (['ENOENT', 'ESRCH', 'INSTALL_READINESS_PROCESS_INVALID'].includes(error.code)) return false
    throw error
  } finally { if (directory) await directory.close() }
}

async function projectReadinessCgroups(groups, processes) {
  return Promise.all(groups.map(async group => {
    const process = processes.find(row => row.cgroup === group.path)
    const root = group.nodes.find(node => node.path === '/sys/fs/cgroup' + group.path)
    const candidates = root?.processes.filter(pid => pid !== process?.pid) ?? []
    if (!process || !candidates.length) return group
    // A normal writer can be parked in flock even under EX. Ignore only direct
    // lock helpers with the fixed executable, arguments, and trusted descriptors.
    const waiting = await withTrustedFile(LIFECYCLE_LOCK, { exactMode: 0o644, maxBytes: 0 }, lock =>
      withTrustedFile('/usr/bin/flock', { maxBytes: 1024 * 1024 }, async tool => {
        const verified = new Set()
        for (const pid of candidates) if (await isWriterLockChild(pid, process, lock, tool)) verified.add(pid)
        return verified
      }))
    if (!waiting.size) return group
    const nodes = group.nodes.map(node => node === root ? { ...node, processes: node.processes.filter(pid => !waiting.has(pid)) } : node)
    return { ...group, nodes, processes: [...new Set(nodes.flatMap(node => node.processes))].sort((a, b) => a - b) }
  }))
}
function accountId(text, name, field) {
  const rows = text.split('\n').filter(line => line.startsWith(name + ':'))
  check(rows.length === 1, 'INSTALL_READINESS_SYSTEM_ACCOUNT_INVALID')
  const raw = rows[0].split(':')[field]
  check(/^[1-9][0-9]{0,9}$/.test(raw) && Number(raw) <= 2147483647, 'INSTALL_READINESS_SYSTEM_ACCOUNT_INVALID')
  return Number(raw)
}
async function ownedSocket(root, inode, descriptors) {
  const matches = descriptors.filter(item => item.target === 'socket:[' + inode + ']')
  check(matches.length === 1, 'INSTALL_READINESS_SOCKET_OWNER_INVALID')
  const value = matches[0], path = root + '/fd/' + value.fd, info = await stat(path, { bigint: true })
  check(info.isSocket() && String(info.ino) === inode && await readlink(path) === value.target, 'INSTALL_READINESS_SOCKET_CHANGED')
  return { fd: value.fd, kernelInode: inode, device: String(info.dev), inode: String(info.ino) }
}
async function processFacts(role, unit, context, nodeInfo, expectedUid, agentGid) {
  const pid = Number(unit.MainPID), expectedRoot = '/opt/xpanel/releases/' + context.source.version
  check(unit.ActiveState === 'active' && unit.SubState === 'running' && unit.ControlPID === '0'
    && Number.isSafeInteger(pid) && pid > 0 && /^[a-f0-9]{32}$/.test(unit.InvocationID)
    && unit.ControlGroup === '/system.slice/xpanel-' + role + '.service', 'INSTALL_READINESS_UNIT_NOT_NORMAL')
  const directory = await open('/proc/' + pid, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const root = '/proc/self/fd/' + directory.fd, initial = await directory.stat({ bigint: true })
    const start = processStart(await procText(root, 'stat')), status = await procText(root, 'status')
    const ids = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/m.exec(status)
    check(ids && ids.slice(1).every(value => Number(value) === expectedUid), 'INSTALL_READINESS_PROCESS_UID_INVALID')
    const executable = await readlink(root + '/exe'), cwd = await readlink(root + '/cwd'), execInfo = await stat(root + '/exe', { bigint: true })
    check(executable === context.runtime.nodePath && execInfo.dev === nodeInfo.dev && execInfo.ino === nodeInfo.ino
      && cwd === expectedRoot, 'INSTALL_READINESS_PROCESS_SOURCE_INVALID')
    check(await procText(root, 'cgroup') === '0::' + unit.ControlGroup + '\n', 'INSTALL_READINESS_PROCESS_CGROUP_INVALID')
    const environment = new Map()
    for (const entry of (await procText(root, 'environ')).split('\0').filter(Boolean)) {
      const separator = entry.indexOf('='), name = entry.slice(0, separator)
      check(separator > 0 && !environment.has(name), 'INSTALL_READINESS_PROCESS_ENV_INVALID'); environment.set(name, entry.slice(separator + 1))
    }
    check(environment.get('INVOCATION_ID') === unit.InvocationID && environment.get('NODE_ENV') === 'production'
      && !environment.get('NODE_OPTIONS') && !environment.get('NODE_PATH')
      && (!environment.has('XPANEL_AGENT_SOCKET') || environment.get('XPANEL_AGENT_SOCKET') === '/run/xpanel/agent.sock'), 'INSTALL_READINESS_PROCESS_ENV_INVALID')
    const args = (await procText(root, 'cmdline')).split('\0').filter(Boolean)
    check(args.length >= 2 && args.length <= 4 && await realpath(args[0]) === context.runtime.nodePath
      && args.slice(1, -1).every(value => /^--max-(?:old|semi)-space-size=[1-9][0-9]{0,5}$/.test(value))
      && await realpath(args.at(-1)) === expectedRoot + '/apps/' + role + '/src/main.ts', 'INSTALL_READINESS_PROCESS_ARGUMENTS_INVALID')
    const names = await readdir(root + '/fd'); check(names.length <= 1024, 'INSTALL_READINESS_FD_LIMIT')
    const descriptors = []
    for (const fd of names) {
      if (!/^(0|[1-9][0-9]*)$/.test(fd)) continue
      let target
      try { target = await readlink(root + '/fd/' + fd) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      if (/^socket:\[[1-9][0-9]*\]$/.test(target)) descriptors.push({ fd, target })
    }
    const sockets = []
    if (role === 'api') {
      const rows = (await procText(root, 'net/tcp', 1024 * 1024)).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/))
      for (const port of [12083, 12087, 12096]) {
        const local = '0100007F:' + port.toString(16).toUpperCase().padStart(4, '0')
        const matches = rows.filter(row => row[1] === local && row[3] === '0A' && /^[1-9][0-9]*$/.test(row[9] ?? ''))
        check(matches.length === 1 && Number(matches[0][7]) === expectedUid, 'INSTALL_READINESS_API_LISTENER_INVALID')
        sockets.push({ port, ...await ownedSocket(root, matches[0][9], descriptors) })
      }
    } else {
      const rows = (await procText(root, 'net/unix', 1024 * 1024)).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/))
      const matches = rows.filter(row => row[7] === '/run/xpanel/agent.sock' && row[3] === '00010000' && row[4] === '0001')
      check(matches.length === 1 && /^[1-9][0-9]*$/.test(matches[0][6]), 'INSTALL_READINESS_AGENT_LISTENER_INVALID')
      const descriptor = await ownedSocket(root, matches[0][6], descriptors)
      await withTrustedDirectory('/run/xpanel', async () => {
        const named = await lstat('/run/xpanel/agent.sock', { bigint: true })
        check(named.isSocket() && named.uid === 0n && named.gid === BigInt(agentGid) && named.nlink === 1n
          && (named.mode & 0o7777n) === 0o660n, 'INSTALL_READINESS_AGENT_SOCKET_INVALID')
        sockets.push({ path: '/run/xpanel/agent.sock', ...descriptor, named: fileIdentity(named) })
      })
    }
    check(processStart(await procText(root, 'stat')) === start, 'INSTALL_READINESS_PROCESS_CHANGED')
    const after = await directory.stat({ bigint: true })
    check(initial.dev === after.dev && initial.ino === after.ino, 'INSTALL_READINESS_PROCESS_CHANGED')
    const representative = role === 'api' ? sockets[0] : sockets[0].named
    return { process: { role, pid, start, uid: expectedUid, executable, cwd, cgroup: unit.ControlGroup,
      invocationId: unit.InvocationID, socketDevice: representative.device, socketInode: representative.inode },
      sockets, processDirectory: { device: String(initial.dev), inode: String(initial.ino) } }
  } finally { await directory.close() }
}

/** SH uses the real unit observer; EX uses only previously captured unit identities and current protected files/cgroups. */
async function readUnitSnapshot(receipt, previous) {
  const names = ['xpanel-api.service', 'xpanel-agent.service']
  const unitFiles = receipt.files.filter(file => names.some(name => file.path === '/etc/systemd/system/' + name))
  check(unitFiles.length === names.length, 'INSTALL_READINESS_UNIT_FILES_MISSING')
  for (const file of unitFiles) await assertOwnedFile(file)
  if (!previous) {
    const capture = projectOwnedControlPlaneObservation(await observeOwnedControlPlaneUnits(receipt))
    const observed = capture.observations[0]
    return { unitFiles, units: observed.units.filter(unit => names.includes(unit.Id)),
      cgroups: observed.cgroups.filter(group => names.some(name => group.path === '/system.slice/' + name)).sort((a, b) => a.path.localeCompare(b.path)) }
  }
  const units = previous.pins.units
  check(Array.isArray(units) && units.length === names.length, 'INSTALL_READINESS_UNIT_CAPTURE_INVALID')
  const cgroups = []
  for (const name of names) {
    const selected = units.filter(unit => unit.Id === name)
    check(selected.length === 1 && selected[0].ControlGroup === '/system.slice/' + name, 'INSTALL_READINESS_UNIT_CAPTURE_INVALID')
    const unit = selected[0]
    await assertTrustedDirectory('/sys/fs/cgroup/system.slice')
    const tree = await readBoundedCgroupTree('/sys/fs/cgroup' + unit.ControlGroup)
    check(tree.processes.includes(Number(unit.MainPID)), 'INSTALL_READINESS_PROCESS_CGROUP_INVALID')
    cgroups.push({ path: unit.ControlGroup, exists: true, ...tree })
  }
  return { unitFiles, units, cgroups: cgroups.sort((a, b) => a.path.localeCompare(b.path)) }
}

async function readNativeFacts(context, previous) {
  requireLinuxRoot()
  const expectedRoot = '/opt/xpanel/releases/' + context.source.version
  const { receipt } = await readInstallationReceipt()
  check(canonical(receipt.source) === canonical(context.source) && canonical(receipt.runtime) === canonical(context.runtime), 'INSTALL_READINESS_INSTALLED_SOURCE_CHANGED')
  const current = await lstat('/opt/xpanel/current', { bigint: true })
  check(current.isSymbolicLink() && current.uid === 0n && current.gid === 0n
    && await readlink('/opt/xpanel/current') === expectedRoot && await realpath('/opt/xpanel/current') === expectedRoot, 'INSTALL_READINESS_CURRENT_LINK_INVALID')
  return withTrustedDirectory(expectedRoot, async ancestry => {
    const node = await readReadinessRuntime(context.runtime, previous)
    const passwd = await readTrustedFile('/etc/passwd', { maxBytes: 1024 * 1024 })
    const groups = await readTrustedFile('/etc/group', { maxBytes: 1024 * 1024 })
    const apiUid = accountId(passwd.bytes.toString('utf8'), 'xpanel', 2), agentGid = accountId(groups.bytes.toString('utf8'), 'xpanel-agent', 2)
    const observed = await readUnitSnapshot(receipt, previous)
    const units = observed.units, processes = [], sockets = []
    for (const role of ['api', 'agent']) {
      const unit = units.find(item => item.Id === 'xpanel-' + role + '.service')
      check(unit, 'INSTALL_READINESS_UNIT_MISSING')
      const value = await processFacts(role, unit, context, node.info, role === 'api' ? apiUid : 0, agentGid)
      processes.push(value.process); sockets.push({ role, descriptors: value.sockets, processDirectory: value.processDirectory })
    }
    const cgroups = await projectReadinessCgroups(observed.cgroups, processes)
    const management = await readManagementTlsReadiness()
    const again = await lstat('/opt/xpanel/current', { bigint: true })
    check(canonical(fileIdentity(current)) === canonical(fileIdentity(again)) && await readlink('/opt/xpanel/current') === expectedRoot, 'INSTALL_READINESS_CURRENT_LINK_CHANGED')
    await ancestry.verify()
    // Last synchronous kernel reads follow every awaited file/ancestor read. No HTTP or SH here.
    for (const process of processes) {
      const base = '/proc/' + process.pid
      const status = readFileSync(base + '/status', 'utf8')
      const ids = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/m.exec(status)
      const executable = statSync(base + '/exe', { bigint: true })
      check(processStart(readFileSync(base + '/stat', 'utf8')) === process.start
        && ids && ids.slice(1).every(id => Number(id) === process.uid)
        && executable.dev === node.info.dev && executable.ino === node.info.ino
        && readlinkSync(base + '/exe') === process.executable && readlinkSync(base + '/cwd') === process.cwd
        && readFileSync(base + '/cgroup', 'utf8') === '0::' + process.cgroup + '\n', 'INSTALL_READINESS_PROCESS_CHANGED')
    }
    return { processes, ingress: { configSha256: management.configSha256, certificateSha256: management.certificateSha256, audiences: management.audiences },
      pins: { management, current: { ...fileIdentity(current), target: expectedRoot }, sockets,
        node: { ...fileIdentity(node.info), sha256: node.sha256 },
        passwd: { ...fileIdentity(passwd.info), sha256: passwd.sha256 }, groups: { ...fileIdentity(groups.info), sha256: groups.sha256 },
        units, cgroups, unitFiles: observed.unitFiles } }
  })
}
const nativeObserver = createReadinessObserver({ assertRoot: requireLinuxRoot, now: () => Date.now(), readFacts: readNativeFacts, observeHttps: captureManagementTlsReadiness })
/** Caller holds real SH; every HTTPS request and descriptor retires before this returns. */
export const captureInstallFinalizationReadiness = (context, subjectDigest) => nativeObserver.capture(context, subjectDigest)
/** Caller holds real EX. This never issues HTTPS or acquires SH; the factory also rechecks its opaque authority. */
export const assertInstallFinalizationReadinessCurrent = (context, observation) => nativeObserver.assertCurrent(context, observation)
export const releaseInstallFinalizationReadiness = observation => nativeObserver.release(observation)

// This distinct observer is reachable only through the actual adoption factory's live opaque scope.
const nativeAdoptionObserver = createReadinessObserver({ assertRoot: requireLinuxRoot, now: () => Date.now(), readFacts: readNativeFacts, observeHttps: captureManagementTlsReadiness }, context => checkedContext(context, true))
export async function captureInstallAdoptionReadiness(capability, context, subjectDigest) {
  const native = await import('./install-finalization-native.mjs')
  await native.assertInstallAdoptionReadinessScope(capability, context, 'capturing')
  const observation = await nativeAdoptionObserver.capture(context, subjectDigest)
  try { await native.assertInstallAdoptionReadinessScope(capability, context, 'capturing'); return observation }
  catch (error) { nativeAdoptionObserver.release(observation); throw error }
}
export async function assertInstallAdoptionReadinessCurrent(capability, context, observation) {
  const native = await import('./install-finalization-native.mjs')
  await native.assertInstallAdoptionReadinessScope(capability, context, 'held')
  await nativeAdoptionObserver.assertCurrent(context, observation)
}
export const releaseInstallAdoptionReadiness = observation => nativeAdoptionObserver.release(observation)
