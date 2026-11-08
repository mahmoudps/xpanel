// Product activation observations. A configuration dump alone is never loaded-route proof.
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, readlinkSync, realpathSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ACTIVATION_KIND = 'xpanel-management-tls-activation'
export const ACTIVATION_PATH = '/var/lib/xpanel-management-tls/activation.json'
/** The three entry points. Panel access may give each its own host and port; `bound` marks a host the owner chose. */
export const managementProfiles = config => [
  { name: 'xpanel', host: config.access?.hosts.xpanel ?? config.hostname, port: config.access?.ports.xpanel ?? 2083, backend: 12083, bound: Boolean(config.access?.hosts.xpanel) },
  { name: 'xwhm', host: config.access?.hosts.xwhm ?? `whm.${config.hostname}`, port: config.access?.ports.xwhm ?? 2087, backend: 12087, bound: Boolean(config.access?.hosts.xwhm) },
  { name: 'xmail', host: config.access?.hosts.xmail ?? `mail.${config.hostname}`, port: config.access?.ports.xmail ?? 2096, backend: 12096, bound: Boolean(config.access?.hosts.xmail) },
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (condition, code) => { if (!condition) fail(code) }
const pidNumber = value => /^[1-9][0-9]{0,9}$/.test(String(value)) && Number.isSafeInteger(Number(value))
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sameVersion = (a, b) => ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key])

function readBounded(path, maximum) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const data = Buffer.alloc(maximum + 1)
    let length = 0
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null)
      if (!count) break
      length += count
    }
    check(length <= maximum, 'ACTIVATION_INPUT_TOO_LARGE')
    return data.subarray(0, length)
  } finally { closeSync(fd) }
}

function trustedFile(path, maximum, executable = false) {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const st = lstatSync(parent)
    check(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0, 'ACTIVATION_UNTRUSTED_PARENT')
    if (parent === '/') break
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const first = fstatSync(fd, { bigint: true })
    check(first.isFile() && first.uid === 0n && first.nlink === 1n && (first.mode & 0o6022n) === 0n && first.size > 0n && first.size <= BigInt(maximum)
      && (!executable || (first.mode & 0o111n) !== 0n), 'ACTIVATION_UNTRUSTED_FILE')
    const bytes = Buffer.alloc(Number(first.size) + 1)
    let length = 0
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count }
    const last = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true })
    check(length === Number(first.size) && sameVersion(first, last) && sameVersion(first, named), 'ACTIVATION_FILE_CHANGED')
    return { path, sha256: digest(bytes.subarray(0, length)), device: String(first.dev), inode: String(first.ino), size: length,
      mode: Number(first.mode & 0o7777n), uid: 0, gid: Number(first.gid) }
  } finally { closeSync(fd) }
}

export function parseActivationProcess(stat, status, command, pid) {
  check(pidNumber(pid) && stat.startsWith(`${pid} (`), 'ACTIVATION_PROCESS_INVALID')
  const end = stat.lastIndexOf(') '), fields = stat.slice(end + 2).trim().split(/\s+/)
  const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status)
  check(end > 0 && fields.length >= 20 && !['Z', 'X', 'x'].includes(fields[0]) && pidNumber(fields[1])
    && /^[1-9][0-9]*$/.test(fields[19]) && uids && uids.slice(1).every(value => value === uids[1])
    && Number.isSafeInteger(Number(uids[1])), 'ACTIVATION_PROCESS_INVALID')
  check(Buffer.isBuffer(command) && command.length > 0 && command.length <= 4096, 'ACTIVATION_COMMAND_INVALID')
  const title = command.toString('utf8').replace(/\0+$/u, '')
  const role = title.startsWith('nginx: master process ') ? 'master' : title === 'nginx: worker process' ? 'worker' : title === 'nginx: worker process is shutting down' ? 'retiring-worker' : 'other'
  // Only the packaged default configuration and standard service daemon flags
  // match the lifecycle's nginx -t/-T. In particular, arbitrary -g can inject an
  // include while using no -c/-p at all. Explicit default -c is valid on EL.
  if (role === 'master') {
    const base = 'nginx: master process /usr/sbin/nginx', config = ' -c /etc/nginx/nginx.conf', globals = ' -g daemon on; master_process on;'
    check([base, base + config, base + globals, base + config + globals, base + globals + config].includes(title), 'ACTIVATION_NONDEFAULT_NGINX')
  }
  return { pid: Number(pid), parentPid: Number(fields[1]), uid: Number(uids[1]), startTicks: fields[19], role, commandSha256: digest(command) }
}

export function parseActivationListeners(text, ports = [443, 2083, 2087, 2096]) {
  check(typeof text === 'string' && text.length <= 1024 * 1024, 'ACTIVATION_LISTENER_INPUT_INVALID')
  const listeners = []
  for (const line of text.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    check(fields.length >= 10 && /^[0-9A-Fa-f]+:[0-9A-Fa-f]{4}$/.test(fields[1]), 'ACTIVATION_LISTENER_INPUT_INVALID')
    if (fields[3] !== '0A') continue
    check(/^[1-9][0-9]*$/.test(fields[9]), 'ACTIVATION_LISTENER_INPUT_INVALID')
    const port = Number.parseInt(fields[1].split(':')[1], 16)
    if (ports.includes(port)) listeners.push({ inode: fields[9], port, localAddressHex: fields[1].split(':')[0].toUpperCase() })
  }
  return listeners
}

function processObservation(pid, expectedExecutable) {
  const prefix = `/proc/${pid}`
  const observe = () => parseActivationProcess(readBounded(prefix + '/stat', 8192).toString('utf8'), readBounded(prefix + '/status', 65536).toString('utf8'), readBounded(prefix + '/cmdline', 4096), pid)
  const first = observe(), executable = realpathSync(prefix + '/exe')
  check(executable === expectedExecutable.path, 'ACTIVATION_NGINX_EXECUTABLE_CHANGED')
  const executableIdentity = trustedFile(executable, 32 * 1024 * 1024, true)
  check(same(executableIdentity, expectedExecutable), 'ACTIVATION_NGINX_EXECUTABLE_CHANGED')
  const namespace = readlinkSync(prefix + '/ns/net')
  const entries = readdirSync(prefix + '/fd')
  check(entries.length <= 8192, 'ACTIVATION_FD_LIMIT')
  const socketInodes = []
  for (const entry of entries) {
    check(/^[0-9]+$/.test(entry), 'ACTIVATION_FD_INVALID')
    try { const match = /^socket:\[([1-9][0-9]*)\]$/.exec(readlinkSync(prefix + '/fd/' + entry)); if (match) socketInodes.push(match[1]) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  check(same(first, observe()), 'ACTIVATION_PROCESS_CHANGED')
  return { ...first, executable: executableIdentity, networkNamespace: namespace, socketInodes: [...new Set(socketInodes)].sort() }
}

/** Fixed-path root observation. It starts no service and accepts no request-selected process or file path. */
export function observeManagementActivation(nginxState, paths, certificateSha256, config) {
  check(process.platform === 'linux' && process.getuid?.() === 0 && process.geteuid?.() === 0, 'ACTIVATION_ROOT_LINUX_REQUIRED')
  check(nginxState.ActiveState === 'active' && nginxState.SubState === 'running' && /^[a-f0-9]{32}$/.test(nginxState.InvocationID)
    && pidNumber(nginxState.MainPID) && fingerprint(certificateSha256), 'ACTIVATION_SERVICE_UNOBSERVED')
  const executable = trustedFile(realpathSync('/usr/sbin/nginx'), 32 * 1024 * 1024, true)
  const master = processObservation(Number(nginxState.MainPID), executable)
  check(master.role === 'master' && master.uid === 0, 'ACTIVATION_MASTER_INVALID')
  const childrenText = () => readBounded(`/proc/${master.pid}/task/${master.pid}/children`, 16384).toString('utf8').trim()
  const childrenBefore = childrenText(), children = childrenBefore ? childrenBefore.split(/\s+/) : []
  check(children.length <= 256 && children.every(pidNumber) && new Set(children).size === children.length, 'ACTIVATION_WORKERS_INVALID')
  const points = managementProfiles(config), watched = [443, ...points.map(point => point.port)]
  const listeners = [...parseActivationListeners(readBounded(`/proc/${master.pid}/net/tcp`, 1024 * 1024).toString('utf8'), watched),
    ...parseActivationListeners(readBounded(`/proc/${master.pid}/net/tcp6`, 1024 * 1024).toString('utf8'), watched)]
  const workers = []
  for (const pid of children) {
    const worker = processObservation(Number(pid), executable)
    check(worker.parentPid === master.pid && worker.networkNamespace === master.networkNamespace, 'ACTIVATION_WORKER_LINEAGE_CHANGED')
    const ownedListeners = listeners.filter(listener => worker.socketInodes.includes(listener.inode)).sort((a, b) => a.port - b.port || a.inode.localeCompare(b.inode))
    // Retiring or unexpected children still holding a management listener remain
    // in the snapshot. Settlement must wait instead of omitting old acceptors.
    if (worker.role === 'worker' || ownedListeners.length) workers.push({ ...worker, listeners: ownedListeners })
  }
  check(childrenBefore === childrenText() && same(master, processObservation(master.pid, executable)), 'ACTIVATION_PROCESS_CHANGED')
  const sourceRoot = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))))
  const sourceInputs = ['scripts/management-tls.mjs', 'scripts/management-tls-activation.mjs'].map(path => ({ ...trustedFile(join(sourceRoot, path), 1024 * 1024), relativePath: path }))
  const files = { managementConfigSha256: trustedFile(paths.config, 16384).sha256, ingressSha256: trustedFile(paths.ingress, 1024 * 1024).sha256,
    includeSha256: trustedFile(paths.include, 16384).sha256, challengeSha256: trustedFile(paths.challenge, 1024 * 1024).sha256 }
  const bootId = readBounded('/proc/sys/kernel/random/boot_id', 64).toString('utf8').trim()
  check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId), 'ACTIVATION_BOOT_INVALID')
  return { bootId, sourceInputs, files, certificateSha256, invocationId: nginxState.InvocationID,
    nginxMaster: processIdentity(master), nginxWorkers: workers.sort((a, b) => a.pid - b.pid).map(worker => ({ ...processIdentity(worker), listeners: worker.listeners })), routes: [
      ...points.map(point => ({ audience: point.name, origin: `https://${point.host}:${point.port}`, addresses: [...config.addresses], backend: `127.0.0.1:${point.backend}` })),
    ] }
}

const processIdentity = value => { const { socketInodes, listeners, ...identity } = value; return identity }

export function activationCommandEvidence(command) {
  return { operation: command.operation, executable: command.executable, startedAt: command.startedAt, finishedAt: command.finishedAt, retiredAt: command.retiredAt,
    exitCode: command.exitCode, signal: command.signal, remainingProcessGroup: command.remainingProcessGroup,
    birth: command.birth && { pid: command.birth.pid, kernelStartTime: command.birth.kernelStartTime, processGroupId: command.birth.processGroupId, sessionId: command.birth.sessionId } }
}

/** Called only after the real product reload and served TLS readiness succeeded. */
export function completeManagementActivation({ before, after, command, phase, activatedAt }) {
  check(['prepare', 'renew', 'rebind'].includes(phase), 'ACTIVATION_PHASE_INVALID')
  for (const key of ['bootId', 'sourceInputs', 'files', 'certificateSha256', 'invocationId', 'routes']) check(same(before[key], after[key]), 'ACTIVATION_INPUT_CHANGED')
  check(same(processIdentity(before.nginxMaster), processIdentity(after.nginxMaster)), 'ACTIVATION_MASTER_CHANGED')
  check(command?.operation === 'nginx-reload' && command.exitCode === 0 && command.signal === null && command.remainingProcessGroup === false
    && pidNumber(command.birth?.pid) && command.birth.processGroupId === command.birth.pid && command.birth.sessionId === command.birth.pid
    && /^[1-9][0-9]*$/.test(command.birth.kernelStartTime) && typeof command.executable === 'string' && command.executable.startsWith('/usr/'), 'ACTIVATION_COMMAND_UNPROVEN')
  const started = Date.parse(command.startedAt), finished = Date.parse(command.finishedAt), retired = Date.parse(command.retiredAt), observed = Date.parse(activatedAt)
  check(Number.isFinite(started) && Number.isFinite(finished) && Number.isFinite(retired) && Number.isFinite(observed) && started <= finished && finished <= retired && retired <= observed
    && observed - started <= 120000, 'ACTIVATION_COMMAND_TIME_INVALID')
  const tested = command.configurationTest
  check(tested?.operation === 'nginx-config-test' && tested.exitCode === 0 && tested.signal === null && tested.remainingProcessGroup === false
    && tested.executable === after.nginxMaster.executable.path && pidNumber(tested.birth?.pid)
    && tested.birth.processGroupId === tested.birth.pid && tested.birth.sessionId === tested.birth.pid && /^[1-9][0-9]*$/.test(tested.birth.kernelStartTime)
    && Date.parse(tested.startedAt) <= Date.parse(tested.finishedAt) && Date.parse(tested.finishedAt) <= Date.parse(tested.retiredAt) && Date.parse(tested.retiredAt) <= started
    && observed - Date.parse(tested.startedAt) <= 120000, 'ACTIVATION_CONFIG_TEST_UNPROVEN')
  check(fingerprint(after.files.nginxConfigurationSha256), 'ACTIVATION_CONFIG_DIGEST_REQUIRED')
  const old = new Set(before.nginxWorkers.map(worker => `${worker.pid}:${worker.startTicks}`))
  check(after.nginxWorkers.length > 0 && after.nginxWorkers.length <= 256, 'ACTIVATION_NEW_WORKERS_UNOBSERVED')
  for (const worker of after.nginxWorkers) {
    check(worker.role === 'worker' && Number.isSafeInteger(worker.uid) && worker.uid > 0 && worker.parentPid === after.nginxMaster.pid && worker.networkNamespace === after.nginxMaster.networkNamespace
      && same(worker.executable, after.nginxMaster.executable) && !old.has(`${worker.pid}:${worker.startTicks}`), 'ACTIVATION_NEW_WORKERS_UNOBSERVED')
    // Birth absent from the earlier snapshot is insufficient: a delayed prior
    // reload may fork between observation and this reload. Same-tick ordering is
    // unknowable at kernel tick precision and remains unproven, never rounded up.
    check(/^[1-9][0-9]*$/.test(worker.startTicks) && BigInt(worker.startTicks) > BigInt(command.birth.kernelStartTime), 'ACTIVATION_WORKER_ORDER_UNPROVEN')
    check(after.routes.map(route => Number(new URL(route.origin).port)).every(port => worker.listeners.some(listener => listener.port === port)), 'ACTIVATION_ACCEPTING_WORKER_UNOBSERVED')
  }
  const safeCommand = { ...activationCommandEvidence(command), configurationTest: activationCommandEvidence(tested) }
  return { schemaVersion: 1, kind: ACTIVATION_KIND, activatedAt, phase, bootId: after.bootId, sourceInputs: after.sourceInputs,
    command: safeCommand, files: after.files, certificateSha256: after.certificateSha256, invocationId: after.invocationId,
    nginxMaster: after.nginxMaster, nginxWorkers: after.nginxWorkers, routes: after.routes,
    applicationReadiness: 'not-claimed', installationArtifact: 'bind-later-against-installed-manifest' }
}
