import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeSync, fsyncSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readlinkSync } from 'node:fs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (ok, code) => { if (!ok) fail(code) }
const same = (a, b) => ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key])

/** Copy one bounded signed object from an untrusted download. No authority, package execution or cleanup is conferred. */
export function copyVerifiedKernelPackage(source, destination, expectedSha256, expectedBytes) {
  check(typeof source === 'string' && typeof destination === 'string' && source !== destination
    && typeof expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedSha256)
    && Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && expectedBytes <= 512 * 1024 ** 2, 'KERNEL_PACKAGE_COPY_INPUT_INVALID')
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let output
  try {
    const before = fstatSync(input, { bigint: true })
    check(before.isFile() && before.nlink === 1n && before.size === BigInt(expectedBytes), 'KERNEL_PACKAGE_DOWNLOAD_SHAPE_INVALID')
    check(same(before, lstatSync(source, { bigint: true })), 'KERNEL_PACKAGE_DOWNLOAD_CHANGED')
    output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const named = fstatSync(output, { bigint: true }), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
    let total = 0
    while (true) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, expectedBytes - total + 1), null)
      if (count === 0) break
      check(total + count <= expectedBytes, 'KERNEL_PACKAGE_DOWNLOAD_GREW')
      hash.update(buffer.subarray(0, count))
      let offset = 0
      while (offset < count) {
        const wrote = writeSync(output, buffer, offset, count - offset)
        check(wrote > 0, 'KERNEL_PACKAGE_COPY_SHORT_WRITE')
        offset += wrote
      }
      total += count
    }
    check(total === expectedBytes && hash.digest('hex') === expectedSha256, 'KERNEL_PACKAGE_DOWNLOAD_DIGEST_MISMATCH')
    check(same(before, fstatSync(input, { bigint: true })) && same(before, lstatSync(source, { bigint: true })), 'KERNEL_PACKAGE_DOWNLOAD_CHANGED')
    fsyncSync(output)
    const after = fstatSync(output, { bigint: true }), target = lstatSync(destination, { bigint: true })
    check(after.isFile() && after.dev === named.dev && after.ino === named.ino && after.size === BigInt(expectedBytes)
      && after.nlink === 1n && (process.platform === 'win32' || (after.mode & 0o777n) === 0o600n)
      && same(after, target), 'KERNEL_PACKAGE_COPY_TARGET_CHANGED')
    return Object.freeze({ sha256: expectedSha256, bytes: total })
  } finally {
    if (output !== undefined) closeSync(output)
    closeSync(input)
  }
}

const NAME = /^[a-z0-9][a-z0-9+.-]{1,126}$/
const VERSION = /^[0-9][a-zA-Z0-9.+:~-]{0,127}$/
const DIGEST = /^[a-f0-9]{64}$/
const SNAPSHOT = /^\/var\/lib\/xpanel-kernel-inputs\/snapshot\.[A-Za-z0-9]{8}$/
const TARGET = /^linux-modules-extra-([0-9][a-z0-9.+-]{0,95})$/
const MAX_PACKAGES = 8
const MiB = 1024 ** 2
const invalid = (ok, field) => check(ok, 'KERNEL_PLAN_' + field)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const rowByName = (rows, name) => rows.find(row => row.name === name)

export function validateKernelAudit(audit, target, mode) {
  if (target.previous === null) {
    invalid(audit === '', 'DIRTY_DPKG')
    return
  }
  const lines = audit.trimEnd().split('\n')
  invalid(mode === 'resume' && target.previous === target.version && lines.length === 4
    && lines[0] === 'The following packages have been unpacked but not yet configured.'
    && lines[1] === 'They must be configured using dpkg --configure or the configure'
    && lines[2] === 'menu option in dselect for them to work:', 'PARTIAL_DPKG')
  const match = /^ ([a-z0-9][a-z0-9+.-]*(?::amd64)?) +[\x20-\x7e]+$/.exec(lines[3])
  invalid(match && [target.name, target.name + ':amd64'].includes(match[1]), 'PARTIAL_DPKG')
}

// Only mandatory, unambiguous binary-package names authorize additional archives.
// Alternative or virtual providers and recommendations are left to the installed state.
export function validateKernelClosure(rows) {
  invalid(rows.length > 0 && rows.length <= MAX_PACKAGES && new Set(rows.map(row => row.name)).size === rows.length, 'PACKAGE_COUNT')
  for (const [index, row] of rows.entries()) {
    invalid(NAME.test(row.name) && VERSION.test(row.version) && ['amd64','all'].includes(row.arch)
      && (index ? row.previous === null && !/^linux-(?:image|modules|headers|generic)(?:-|$)/.test(row.name)
        : TARGET.test(row.name) && row.arch === 'amd64' && (row.previous === null || row.previous === row.version)), 'PACKAGE_IDENTITY')
  }
  const reached = new Set([rows[0].name]), versionConstraints = []
  for (const name of reached) {
    const row = rowByName(rows, name)
    for (const clause of [row.depends, row.preDepends].filter(Boolean).join(',').split(',')) {
      const relation = /^\s*([a-z0-9][a-z0-9+.-]*)(?::(?:native|amd64))?(?:\s+\((<<|<=|=|>=|>>) ([0-9][A-Za-z0-9.+:~-]*)\))?\s*$/.exec(clause)
      const dependency = relation && rowByName(rows, relation[1])
      if (dependency) {
        reached.add(dependency.name)
        if (relation[2]) versionConstraints.push([dependency.version, relation[2], relation[3]])
      }
    }
  }
  invalid(reached.size === rows.length, 'UNRELATED_ARCHIVE')
  return versionConstraints
}

export function validateKernelProviders(rows, output) {
  const additions = new Set(rows.slice(1).map(row => row.name))
  for (const line of output.trimEnd().split('\n')) {
    if (line[1] !== 'i' || line[3] !== '\t') continue
    for (const provision of line.slice(4).split(',')) {
      const name = /^\s*([a-z0-9][a-z0-9+.-]*)/.exec(provision)?.[1]
      invalid(!additions.has(name), 'EXISTING_PROVIDER')
    }
  }
}

// An explicit unpack precedes APT's dependency operations. A not-yet-configured
// Pre-Depends cannot be borrowed from the future APT plan.
export function configuredKernelPreDepends(value, query, compare) {
  invalid(typeof value === 'string' && value.length <= 8192, 'PREDEPENDS')
  if (!value) return
  const terms = value.split(',')
  invalid(terms.length <= 32, 'PREDEPENDS')
  for (const term of terms) {
    const m = /^\s*([a-z0-9][a-z0-9+.-]{1,126})(?::(?:native|amd64))?(?:\s*\((<<|<=|=|>=|>>)\s+([0-9][A-Za-z0-9.+:~-]{0,127})\))?\s*$/.exec(term)
    invalid(m, 'PREDEPENDS')
    const row = query(m[1])
    invalid(row && row[0] === 'ii ' && row[1] === m[1] && VERSION.test(row[2])
      && ['all','amd64'].includes(row[3]) && (!m[2] || compare(row[2],m[2],m[3])), 'PREDEPENDS')
  }
}

// dpkg can serialize its database in another stanza/field order after unpack.
// Require every field of every other package, including selection and trigger state.
export function otherKernelStatusSha256(status, target, partial) {
  invalid(TARGET.test(target) && status.length > 0 && status.length <= 64 * MiB
    && !/[\0\r\ufffd]/.test(status), 'STATUS_DATA')
  const records = new Map()
  let found = false
  for (const paragraph of status.replace(/\n+$/, '').split(/\n\n+/)) {
    const fields = paragraph.split(/\n(?![ \t])/)
    const header = new Map()
    for (const field of fields) {
      const m = /^([A-Za-z0-9][A-Za-z0-9-]*):/.exec(field)
      invalid(m && !header.has(m[1]), 'STATUS_DATA')
      header.set(m[1], field)
    }
    const name = header.get('Package')?.slice(9), arch = header.get('Architecture')?.slice(14)
    invalid(NAME.test(name ?? '') && /^[a-z0-9][a-z0-9-]{0,31}$/.test(arch ?? ''), 'STATUS_ID')
    const id = name + ':' + arch
    invalid(!header.has('Triggers-Awaited') && !header.has('Triggers-Pending'), 'TRIGGER_BACKLOG')
    const state = header.get('Status')?.slice(8)
    invalid(name === target && partial ? state === 'install ok unpacked'
      : /^(?:install|hold|deinstall|purge|unknown) ok (?:installed|config-files|not-installed)$/.test(state ?? ''), 'PENDING_PACKAGE')
    if (name === target) {
      invalid(!found && arch === 'amd64', 'STATUS_TARGET')
      found = true
    } else {
      invalid(!records.has(id) && records.size < 65536, 'STATUS_ID')
      records.set(id,hash(JSON.stringify(fields.sort())))
    }
  }
  invalid(!partial || found, 'STATUS_TARGET')
  return hash(JSON.stringify([...records].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)))
}

function expectOperation(seen, action, name, rows) {
  const row = rowByName(rows, name)
  invalid(row && !seen.has(action + ':' + name), 'UNEXPECTED_ACTION')
  if (row === rows[0] && row.previous !== null) {
    // APT 2.8 does not queue an archive for an unpacked, kept package.
    // Its configure step is admitted only after the locked hook re-unpacks the verified target itself.
    invalid(action === 'Conf' && rows.slice(1).every(dep => seen.has('Conf:' + dep.name)), 'PARTIAL_TARGET_ACTION')
  } else if (action === 'Conf') invalid(seen.has('Inst:' + name), 'CONFIGURE_BEFORE_UNPACK')
  seen.add(action + ':' + name)
  return row
}

export function validateKernelSimulation(output, rows) {
  validateKernelClosure(rows)
  invalid(typeof output === 'string' && Buffer.byteLength(output) <= 65536 && !/[\0\r]/.test(output), 'SIMULATION_SHAPE')
  const seen = new Set()
  for (const line of output.split('\n')) {
    if (line === '') continue
    const m = /^(Inst|Conf) ([a-z0-9][a-z0-9+.-]*)(?::(amd64|all))?(?: \[([0-9][A-Za-z0-9.+:~-]*)\])? \(([0-9][A-Za-z0-9.+:~-]*) ([^()\r\n]*)\)(?: \[([a-z0-9+.: -]*)\])?$/.exec(line)
    invalid(m, 'SIMULATION_ACTION')
    const [,action,name,arch,old,version,release,broken] = m
    const row = expectOperation(seen, action, name, rows)
    // APT's native package slot may describe an Architecture: all package as name:amd64.
    invalid((!arch || arch === 'amd64' || arch === row.arch) && version === row.version
      && (old ?? null) === (action === 'Inst' ? row.previous : null)
      && release.endsWith('[' + row.arch + ']')
      && (!broken || broken.trim().split(/ +/).every(id => rowByName(rows, id.split(':')[0]))), 'SIMULATION_TUPLE')
  }
  invalid(seen.size === rows.length * 2 - (rows[0].previous === null ? 0 : 1), 'INCOMPLETE_SIMULATION')
}

// VERSION 3 separates its configuration block from the nine-field package actions.
export function validateKernelHook(input, rows) {
  validateKernelClosure(rows)
  invalid(typeof input === 'string' && Buffer.byteLength(input) <= MiB && !/[\0\r]/.test(input)
    && input.startsWith('VERSION 3\n') && input.endsWith('\n'), 'HOOK_FRAME')
  const split = input.indexOf('\n\n')
  invalid(split >= 10 && input.slice(10, split).split('\n').every(l => /^[^=\s]+=.*/.test(l)), 'HOOK_CONFIGURATION')
  // A nested unpack must address the same real package database and installation root as APT.
  // In particular, Dir overrides alone do not make a disposable native fixture.
  if (rows[0].previous !== null) {
    for (const entry of input.slice(10,split).split('\n')) {
      const separator = entry.indexOf('='), key = entry.slice(0,separator).toLowerCase(), value = entry.slice(separator+1)
      if (['dir','rootdir','dpkg::chroot-directory'].includes(key)) invalid(value === '/', 'HOOK_INSTALLATION_ROOT')
      if (key === 'dir::state::status') invalid(value === '/var/lib/dpkg/status', 'HOOK_INSTALLATION_ROOT')
      if (key === 'dir::bin::dpkg') invalid(value === '/usr/bin/dpkg', 'HOOK_INSTALLATION_ROOT')
      invalid(!/^dpkg::options(?:::|$)/.test(key), 'HOOK_INSTALLATION_ROOT')
    }
  }
  const seen = new Set(), archives = []
  for (const line of input.slice(split + 2, -1).split('\n')) {
    const fields = line.split(' ')
    invalid(fields.length === 9, 'HOOK_ACTION')
    const [name,old,oldArch,oldMulti,change,version,arch,multi,operation] = fields
    const action = operation === '**CONFIGURE**' ? 'Conf' : 'Inst'
    const row = expectOperation(seen, action, name, rows)
    invalid(version === row.version && arch === row.arch && multi === row.multiArch
      && (row.previous === null ? old === '-' && oldArch === '-' && oldMulti === 'none' && change === '<'
        : old === row.version && oldArch === row.arch && oldMulti === row.previousMultiArch && change === '='), 'HOOK_TUPLE')
    if (action === 'Inst') {
      invalid(/^\/[A-Za-z0-9_+./%:~-]+\.deb$/.test(operation) && !operation.split('/').some(part => part === '.' || part === '..'), 'HOOK_ARCHIVE')
      archives.push({ name, path: operation })
    }
  }
  invalid(seen.size === rows.length * 2 - (rows[0].previous === null ? 0 : 1), 'INCOMPLETE_HOOK')
  return archives
}
function protectedDirectory(directory) {
  invalid(realpathSync(directory) === directory, 'PARENT_PATH')
  for (let current = directory;; current = dirname(current)) {
    const info = lstatSync(current)
    invalid(info.isDirectory() && info.uid === 0 && info.gid === 0 && !(info.mode & 0o022), 'PARENT_OWNER')
    if (current === '/') break
  }
}

function readBounded(fd, limit, digestOnly = false) {
  const chunks = [], h = createHash('sha256'), block = Buffer.allocUnsafe(65536)
  let bytes = 0
  for (;;) {
    const n = readSync(fd, block, 0, Math.min(block.length, limit - bytes + 1), null)
    if (!n) break
    bytes += n
    invalid(bytes <= limit, 'INPUT_SIZE')
    if (digestOnly) h.update(block.subarray(0,n))
    else chunks.push(Buffer.from(block.subarray(0,n)))
  }
  return digestOnly ? {bytes, sha256:h.digest('hex')} : Buffer.concat(chunks,bytes).toString('utf8')
}

function readProtected(file, limit, digestOnly = false, privateFile = false) {
  protectedDirectory(dirname(file))
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd, { bigint:true })
    invalid(before.isFile() && before.size <= BigInt(limit) && before.uid === 0n && before.gid === 0n
      && (before.mode & 0o022n) === 0n && (!privateFile || (before.nlink === 1n && (before.mode & 0o777n) === 0o600n)), 'FILE_AUTHORITY')
    const result = readBounded(fd, limit, digestOnly)
    invalid(same(before, fstatSync(fd, {bigint:true})) && same(before, lstatSync(file, {bigint:true})), 'FILE_CHANGED')
    return result
  } finally { closeSync(fd) }
}

function run(tool, args, missingName, maxBuffer = 65536) {
  const r = spawnSync('/usr/bin/' + tool, args, {env:{LANG:'C',LC_ALL:'C',PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}, encoding:'utf8', timeout:15000, maxBuffer, stdio:['ignore','pipe','pipe']})
  if (missingName && r.status === 1 && !r.error && r.stdout === '' && r.stderr === 'dpkg-query: no packages found matching ' + missingName + '\n') return null
  invalid(!r.error && r.status === 0 && r.stderr === '', 'NATIVE_INSPECTION')
  return r.stdout
}

function packageState(name) {
  const data = run('dpkg-query', ['-W','-f=${db:Status-Abbrev}\\t${Package}\\t${Version}\\t${Architecture}\\t${Multi-Arch}\\n','--',name], name)
  if (data === null) return null
  const fields = data.replace(/\n$/, '').split('\t')
  invalid(fields.length === 5 && fields[1] === name && !fields.some(v => v.includes('\n')), 'AMBIGUOUS_STATE')
  return fields[0] === 'un ' && !fields[2] ? null : fields
}

function multiArch(value) {
  invalid(['','no','same','foreign','allowed'].includes(value), 'MULTIARCH')
  return !value || value === 'no' ? 'none' : value
}

function requireNoDeferredTriggers() {
  const directory = '/var/lib/dpkg/triggers'
  protectedDirectory(directory)
  try { invalid(readProtected(directory + '/Unincorp',1024) === '', 'TRIGGER_BACKLOG') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

function observePlan(dir, target, version, imageSha256, mode) {
  invalid(SNAPSHOT.test(dir) && TARGET.test(target) && VERSION.test(version) && DIGEST.test(imageSha256)
    && ['fresh','resume'].includes(mode), 'ARGUMENT')
  const statusFile = '/var/lib/dpkg/status', status = readProtected(statusFile, 64 * MiB)
  const statusSha256 = hash(status)
  requireNoDeferredTriggers()
  const release = TARGET.exec(target)[1], image = 'linux-image-' + release, boot = '/boot/vmlinuz-' + release
  const imageState = packageState(image)
  invalid(imageState?.[0] === 'ii ' && imageState[2] === version && imageState[3] === 'amd64'
    && run('dpkg-query',['-S','--',boot]) === image + ': ' + boot + '\n'
    && readProtected(boot, 256 * MiB, true).sha256 === imageSha256, 'BOOT_IMAGE')
  const table = readProtected(dir + '/package-set.tsv', 16384, false, true)
  invalid(table.endsWith('\n') && !table.includes('\r'), 'ARCHIVE_SET')
  const entries = table.slice(0,-1).split('\n')
  invalid(entries.length >= 1 && entries.length <= MAX_PACKAGES, 'PACKAGE_COUNT')
  let total = 0
  const rows = entries.map((line,index) => {
    const fields = line.split('\t'), [name,v,arch,sha256,size] = fields
    invalid(fields.length === 5 && NAME.test(name) && VERSION.test(v) && ['amd64','all'].includes(arch)
      && DIGEST.test(sha256) && /^[1-9][0-9]{0,8}$/.test(size) && Number(size) <= 512*MiB
      && (index || (name === target && v === version && arch === 'amd64')), 'ARCHIVE_SET')
    total += Number(size)
    invalid(total <= 768*MiB, 'ARCHIVE_SET_SIZE')
    const file = dir + (index ? '/dependency-' + name + '.deb' : '/authenticated.deb')
    const measured = readProtected(file, Number(size), true, true)
    invalid(measured.sha256 === sha256 && measured.bytes === Number(size), 'ARCHIVE_DIGEST')
    const format = ['Package','Version','Architecture','Multi-Arch','Depends','Pre-Depends'].map(f => '$' + '{' + f + '}').join('\\t')
    const control = run('dpkg-deb',['--show','--showformat=' + format,'--',file]).split('\t')
    invalid(control.length === 6 && control[0] === name && control[1] === v && control[2] === arch, 'ARCHIVE_CONTROL')
    const old = packageState(name)
    invalid(!old || (index === 0 && mode === 'resume' && old[0] === 'iU ' && old[2] === v && old[3] === arch), 'PACKAGE_PRESTATE')
    return {name,version:v,arch,sha256,bytes:Number(size),file,depends:control[4],preDepends:control[5],multiArch:multiArch(control[3]),
      previous:old?.[2] ?? null,previousMultiArch:old ? multiArch(old[4]) : null}
  })
  const constraints = validateKernelClosure(rows)
  for (const comparison of constraints) run('dpkg',['--compare-versions', ...comparison])
  if (rows.length > 1) {
    const providers = run('dpkg-query',['-W','-f=${db:Status-Abbrev}\\t${Provides}\\n'],undefined,4*MiB)
    validateKernelProviders(rows,providers)
  }
  if (rows[0].previous !== null) configuredKernelPreDepends(rows[0].preDepends,packageState,(v,op,wanted) => {
    run('dpkg',['--compare-versions',v,op,wanted]); return true
  })
  validateKernelAudit(run('dpkg',['--audit']),rows[0],mode)
  const simulation = readProtected(dir + '/simulation.txt', 65536, false, true)
  validateKernelSimulation(simulation, rows)
  const otherStatusSha256 = otherKernelStatusSha256(status,target,rows[0].previous !== null)
  invalid(readProtected(statusFile,64*MiB,true).sha256 === statusSha256, 'STATE_CHANGED')
  requireNoDeferredTriggers()
  return {schemaVersion:1,mode,target,version,imageSha256,statusSha256,otherStatusSha256,simulationSha256:hash(simulation),rows}
}

function exclusive(file, data) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const bytes = Buffer.from(data)
    invalid(writeSync(fd,bytes) === bytes.length, 'RECEIPT_SHORT_WRITE')
    fsyncSync(fd)
  } finally { closeSync(fd) }
}

function syncDirectory(path) {
  const fd = openSync(path,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function procText(path, bound) {
  const fd = openSync(path,constants.O_RDONLY)
  try {return readBounded(fd,bound)} finally {closeSync(fd)}
}

export function aptOwnsFrontendLock(lines, key, pid) {
  const major = ((key.dev >> 8n) & 0xfffn) | ((key.dev >> 32n) & 0xfffff000n)
  const minor = (key.dev & 0xffn) | ((key.dev >> 12n) & 0xffffff00n)
  return lines.some(line => {
    const m = /^(?:\d+): POSIX\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0 EOF$/.exec(line)
    return m && Number(m[1]) === pid && BigInt('0x' + m[2]) === major
      && BigInt('0x' + m[3]) === minor && BigInt(m[4]) === key.ino
  })
}

function requireAptLock() {
  invalid(process.env.APT_HOOK_INFO_FD === '0', 'HOOK_FD')
  const key = lstatSync('/var/lib/dpkg/lock-frontend',{bigint:true})
  invalid(key.isFile() && key.uid === 0n && key.gid === 0n && !(key.mode & 0o002n), 'LOCK_FILE')
  const locks = procText('/proc/locks',MiB).split('\n')
  let pid = process.ppid
  for (let i = 0; pid > 1 && i < 8; i++) {
    if (readlinkSync('/proc/' + pid + '/exe') === '/usr/bin/apt-get' && aptOwnsFrontendLock(locks, key, pid)) return
    pid = Number(/^PPid:\s+(\d+)$/m.exec(procText('/proc/' + pid + '/status',65536))?.[1])
  }
  fail('KERNEL_PLAN_NO_APT_FRONTEND_LOCK')
}

function unpackAdmittedTarget(args, expected, planSha256, hookSha256) {
  const dir = args[0], target = expected.rows[0]
  invalid(expected.mode === 'resume' && target.previous === target.version && target.file === dir + '/authenticated.deb', 'UNPACK_TARGET')
  const statusFile = '/var/lib/dpkg/status'
  invalid(readProtected(statusFile,64*MiB,true).sha256 === expected.statusSha256, 'UNPACK_PRESTATE')
  const otherStatus = expected.otherStatusSha256
  const argv = ['--no-triggers','--unpack','--',target.file]
  const intent = JSON.stringify({schemaVersion:1,target:target.name,version:target.version,architecture:target.arch,
    archiveSha256:target.sha256,planSha256,hookSha256,statusSha256:expected.statusSha256,otherStatus,argv}) + '\n'
  exclusive(dir + '/target-reunpack-intent.json',intent)
  syncDirectory(dir)
  requireAptLock()
  // Only this fixed child inherits frontend ownership from its verified APT ancestor.
  // dpkg acquires its normal backend lock and runs the authenticated archive's ordinary scripts.
  const startedAt = new Date().toISOString()
  const result = spawnSync('/usr/bin/dpkg',argv,{env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LC_ALL:'C',LANG:'C',HOME:'/root',
    DEBIAN_FRONTEND:'noninteractive',DPKG_FRONTEND_LOCKED:'1',NEEDRESTART_MODE:'l'},
    timeout:240000,killSignal:'SIGKILL',maxBuffer:MiB,stdio:['ignore','pipe','pipe']})
  const terminal = {schemaVersion:1,intentSha256:hash(intent),startedAt,finishedAt:new Date().toISOString(),
    pid:Number.isSafeInteger(result.pid) && result.pid > 0 ? result.pid : null,exitCode:result.status,
    signal:result.signal,spawnError:!!result.error}
  const raw = JSON.stringify(terminal) + '\n'
  exclusive(dir + '/target-reunpack-result.json',raw)
  syncDirectory(dir)
  invalid(terminal.pid && terminal.exitCode === 0 && terminal.signal === null && !terminal.spawnError, 'UNPACK_UNCONFIRMED')
  requireAptLock()
  const after = observePlan(...args)
  invalid(JSON.stringify({...after,statusSha256:expected.statusSha256}) === JSON.stringify(expected), 'UNPACK_STATE_CHANGED')
  return {resultSha256:hash(raw),statusSha256:after.statusSha256}
}

function checkHookArchives(dir,actions,rows) {
  for (const {name,path} of actions) {
    const row = rowByName(rows,name)
    invalid(path === row.file || dirname(path) === dir + '/archives', 'HOOK_ARCHIVE_LOCATION')
    const observed = readProtected(path,row.bytes,true)
    invalid(observed.bytes === row.bytes && observed.sha256 === row.sha256, 'HOOK_ARCHIVE_DIGEST')
  }
}

function planCommand(action, args) {
  invalid(args.length === 5, 'ARGUMENT')
  const dir = args[0]
  if (action === '--apply-plan') requireAptLock()
  const expected = observePlan(...args), encoded = JSON.stringify(expected) + '\n'
  const record = dir + '/admitted-plan.json'
  if (action === '--plan') return exclusive(record,encoded)
  invalid(readProtected(record,131072,false,true) === encoded, 'PRESTATE_CHANGED')
  const hook = readBounded(0,MiB), actions = validateKernelHook(hook,expected.rows)
  checkHookArchives(dir,actions,expected.rows)
  requireAptLock()
  const admittedPlanSha256 = hash(encoded)
  const reunpack = expected.rows[0].previous === null ? null : unpackAdmittedTarget(args,expected,admittedPlanSha256,hash(hook))
  if (reunpack) checkHookArchives(dir,actions,expected.rows)
  requireAptLock()
  exclusive(dir + '/apply-plan.json', JSON.stringify({schemaVersion:1,admittedPlanSha256,archives:actions.map(a => a.name),reunpack}) + '\n')
  syncDirectory(dir)
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    check(process.platform === 'linux' && process.getuid() === 0 && process.geteuid() === 0
      && process.getgid() === 0 && process.getegid() === 0, 'KERNEL_PACKAGE_COPY_ROOT_REQUIRED')
    if (args[0] === '--plan' || args[0] === '--apply-plan') {
      planCommand(args[0], args.slice(1))
      process.stdout.write('{"status":"kernel-package-plan-checked"}\n')
    } else {
      const [source,destination,sha256,bytes] = args
      check(args.length === 4 && /^[1-9][0-9]{0,9}$/.test(bytes ?? ''), 'KERNEL_PACKAGE_COPY_INPUT_INVALID')
      const root = dirname(dirname(source)), name = destination.slice(root.length + 1)
      check(SNAPSHOT.test(root) && dirname(source) === root + '/download'
        && /^[A-Za-z0-9._+%~:-]+\.deb$/.test(source.slice(dirname(source).length + 1))
        && dirname(destination) === root && (name === 'authenticated.deb' || /^dependency-[a-z0-9][a-z0-9+.-]{1,126}\.deb$/.test(name))
        && realpathSync(dirname(source)) === dirname(source), 'KERNEL_PACKAGE_COPY_LOCATION_INVALID')
      protectedDirectory(root)
      copyVerifiedKernelPackage(source,destination,sha256,Number(bytes))
      process.stdout.write('{"status":"kernel-package-sealed"}\n')
    }
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code ?? '') ? error.code : 'KERNEL_PACKAGE_COPY_UNCONFIRMED'
    process.stderr.write(JSON.stringify({status:'blocked',code,partialOutputRetained:true}) + '\n')
    process.exitCode = 3
  }
}
