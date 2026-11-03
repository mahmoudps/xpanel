import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, symlink } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearDependencyGroupWorldWrite, offlineDependencyInstallArguments, withAuthenticatedReleaseArchive, stageAuthenticatedReleaseArchive } from './release-verifier.mjs'
import { assertOwnedFile, assertTrustedDirectory, OWNED_PANEL_UNITS, parseInstallationReceipt, readTrustedFile, readInstallationReceipt, requireLinuxRoot, withTrustedDirectory, withTrustedFile } from './lifecycle-ownership.mjs'

export const INSTALL_ROOT = '/opt/xpanel'
export const BOOTSTRAP_PATH = '/var/lib/xpanel-lifecycle/bootstrap.json'
export const DEPENDENCY_RECEIPT = '/var/lib/xpanel-lifecycle/install-dependencies.json'
const LIFECYCLE = '/var/lib/xpanel-lifecycle'
const CURRENT = INSTALL_ROOT + '/current'
const DATABASE = '/var/lib/xpanel/control.db'
const PINNED_NODE = '26.12.1'
const SHA = /^[a-f0-9]{64}$/
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (condition, code) => { if (!condition) fail(code) }
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const object = (value, keys, code) => {
  check(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code)
  check(Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')), code)
}
const canonical = path => typeof path === 'string' && path.length > 1 && path.length <= 4096 && posix.isAbsolute(path) && posix.normalize(path) === path && !/[\x00-\x20\x7f]/.test(path)
const durableLocation = path => canonical(path) && !/^\/(?:home(?:[0-9]+)?|tmp|var\/tmp)(?:\/|$)/.test(path)
const parseJson = bytes => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return fail('INSTALL_JSON_INVALID') } }

/** Pure syntax only. Explicit protected paths never substitute for native ownership observations. */
export function parseBootstrapArgs(argv) {
  check(Array.isArray(argv) && argv.length <= 6 && argv.every(value => typeof value === 'string'), 'INSTALL_OPTIONS_INVALID')
  const [phase, ...args] = argv
  check(['plan', 'verify', 'prepare', 'resume', 'admission', 'capture'].includes(phase), 'INSTALL_PHASE_INVALID')
  const fields = new Map()
  const names = ['artifact', 'artifact-sha256', 'release-trust-file', 'release-keys-file']
  for (const argument of args) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument)
    check(match && names.includes(match[1]) && !fields.has(match[1]), 'INSTALL_OPTIONS_INVALID')
    fields.set(match[1], match[2])
  }
  if (['admission', 'capture'].includes(phase)) { check(fields.size === 0, 'INSTALL_OPTIONS_INVALID'); return freeze({ phase }) }
  check(fields.size === names.length && names.every(name => fields.has(name)), 'INSTALL_TRUST_INPUTS_REQUIRED')
  check(SHA.test(fields.get('artifact-sha256')) && canonical(fields.get('artifact')) && fields.get('artifact').endsWith('.tar.gz')
    && durableLocation(fields.get('release-trust-file')) && durableLocation(fields.get('release-keys-file')), 'INSTALL_OPTIONS_INVALID')
  return freeze({ phase, artifactPath: fields.get('artifact'), artifactSha256: fields.get('artifact-sha256'), trustPath: fields.get('release-trust-file'), keysPath: fields.get('release-keys-file') })
}

export function parseBootstrapTrust(value) {
  object(value, ['keyId', 'packageManagerPath', 'packageManagerSha256', 'signingKeyPath'], 'INSTALL_TRUST_INVALID')
  check(typeof value.keyId === 'string' && KEY_ID.test(value.keyId) && durableLocation(value.packageManagerPath) && durableLocation(value.signingKeyPath)
    && typeof value.packageManagerSha256 === 'string' && SHA.test(value.packageManagerSha256), 'INSTALL_TRUST_INVALID')
  return freeze(structuredClone(value))
}

export function parseBootstrapKeys(value) {
  object(value, ['schemaVersion', 'keys'], 'INSTALL_PUBLISHER_KEYS_INVALID')
  check(value.schemaVersion === 1 && Array.isArray(value.keys) && value.keys.length >= 1 && value.keys.length <= 8, 'INSTALL_PUBLISHER_KEYS_INVALID')
  const ids = new Set()
  for (const entry of value.keys) {
    object(entry, ['keyId', 'algorithm', 'publicKey'], 'INSTALL_PUBLISHER_KEYS_INVALID')
    check(entry.algorithm === 'ed25519' && typeof entry.keyId === 'string' && KEY_ID.test(entry.keyId) && !ids.has(entry.keyId)
      && typeof entry.publicKey === 'string' && entry.publicKey.length <= 1024 && entry.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'), 'INSTALL_PUBLISHER_KEYS_INVALID')
    ids.add(entry.keyId)
    try { check(createPublicKey(entry.publicKey).asymmetricKeyType === 'ed25519', 'INSTALL_PUBLISHER_KEYS_INVALID') }
    catch { fail('INSTALL_PUBLISHER_KEYS_INVALID') }
  }
  return freeze(structuredClone(value))
}

/** Wire contract matches the native consumer; bytes means the authenticated unpacked inventory. */
export function verifyBootstrapPublisher(value, report, keys) {
  object(value, ['version', 'schemaVersion', 'sha256', 'bytes', 'keyId', 'signature'], 'INSTALL_PUBLISHER_MANIFEST_INVALID')
  check(typeof value.version === 'string' && VERSION.test(value.version) && Number.isSafeInteger(value.schemaVersion) && value.schemaVersion >= 1
    && typeof value.sha256 === 'string' && SHA.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0
    && typeof value.keyId === 'string' && KEY_ID.test(value.keyId) && typeof value.signature === 'string' && /^[a-f0-9]{128}$/.test(value.signature), 'INSTALL_PUBLISHER_MANIFEST_INVALID')
  check(value.version === report.manifest.version && value.schemaVersion === report.manifest.controlDbSchemaVersion
    && value.sha256 === report.archiveSha256 && value.bytes === report.totalUnpackedBytes, 'INSTALL_PUBLISHER_RELEASE_MISMATCH')
  const keyring = parseBootstrapKeys(keys), key = keyring.keys.find(entry => entry.keyId === value.keyId)
  check(key, 'INSTALL_PUBLISHER_UNTRUSTED')
  const payload = Buffer.from(`xpanel-release-v1:${value.version}:${value.schemaVersion}:${value.sha256}:${value.bytes}`, 'utf8')
  check(verify(null, payload, key.publicKey, Buffer.from(value.signature, 'hex')), 'INSTALL_PUBLISHER_SIGNATURE_INVALID')
  return freeze(structuredClone(value))
}

/** Fresh-install prerequisites only; legacy archive/source and upgrade grammar stays unchanged. */
export function assertFreshInstallReleaseControls(report) {
  const files = report?.manifest?.files
  check(report?.lifecycleControlsPresent === true && Array.isArray(files)
    && ['scripts/install-bootstrap.mjs', 'scripts/install-bootstrap.d.mts'].every(path => files.some(file => file?.path === path)), 'INSTALL_RELEASE_CONTROLS_REQUIRED')
}

async function exists(path) { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function newDirectory(path, mode = 0o755) {
  await withTrustedDirectory(dirname(path), async parent => { await mkdir(path, { mode }); await parent.verify() })
  await assertTrustedDirectory(path)
}
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
async function writeNew(path, bytes, mode = 0o600) {
  return withTrustedDirectory(dirname(path), async parent => {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    try { await handle.chown(0, 0); await handle.chmod(mode); await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await syncDirectory(dirname(path)); await parent.verify()
  })
}
async function writeNewJson(path, value, mode) { const bytes = Buffer.from(JSON.stringify(value) + '\n'); await writeNew(path, bytes, mode); return digest(bytes) }
async function persistTrust(path, bytes, mode) {
  if (await exists(path)) {
    await withTrustedFile(path, { exactMode: mode, sha256: digest(bytes), maxBytes: 16 * 1024 }, async () => {})
  } else await writeNew(path, bytes, mode)
}
async function nativeContext() {
  requireLinuxRoot()
  check(process.versions.node === PINNED_NODE && !process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'INSTALL_PINNED_RUNTIME_REQUIRED')
  check(await readlink('/proc/self') === String(process.pid), 'INSTALL_PROC_IDENTITY_INVALID')
  await withTrustedFile(fileURLToPath(import.meta.url), { maxBytes: 128 * 1024 }, async () => {})
  const nodePath = await realpath(process.execPath)
  check(await readlink(`/proc/${process.pid}/exe`) === nodePath, 'INSTALL_RUNTIME_IDENTITY_CHANGED')
  const node = await readTrustedFile(nodePath, { maxBytes: 256 * 1024 * 1024 })
  check((Number(node.info.mode) & 0o111) !== 0, 'INSTALL_RUNTIME_NOT_EXECUTABLE')
  return { nodePath, nodeSha256: node.sha256 }
}

/** A timeout is not quiescence. Retain the FD and await close; an owned outer job supplies the hard deadline. */
async function command(path, args, { cwd = '/', sha256, timeoutMs = 120_000 } = {}) {
  return withTrustedFile(path, { maxBytes: 256 * 1024 * 1024, ...(sha256 ? { sha256 } : {}) }, async pin => {
    check((Number(pin.info.mode) & 0o111) !== 0, 'INSTALL_TOOL_NOT_EXECUTABLE')
    return new Promise((resolve, reject) => {
      const child = spawn('/proc/self/fd/3', args, { cwd, stdio: ['ignore', 'pipe', 'pipe', pin.fd], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', NODE_ENV: 'production', HOME: '/root', CI: 'true' } })
      let bytes = 0, text = '', uncertain = false, spawnError
      const timer = setTimeout(() => { uncertain = true }, timeoutMs)
      const collect = chunk => { bytes += chunk.length; if (bytes <= 128 * 1024) text += chunk; else uncertain = true }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      child.once('error', error => { spawnError = error })
      child.once('close', async (code, signal) => {
        clearTimeout(timer)
        try {
          await pin.verify()
          check(!uncertain && !signal && code !== null && !spawnError, 'INSTALL_CHILD_OUTCOME_UNKNOWN')
          check(code === 0, 'INSTALL_CHILD_FAILED')
          resolve({ text, outputSha256: digest(text), code })
        } catch (error) { reject(error) }
      })
    })
  })
}

async function observeSecureTree(root, sourcePaths) {
  const actualRoot = await realpath(root), entries = []; let count = 0
  const sourceDirectories = new Set([''])
  if (sourcePaths) for (const path of sourcePaths) {
    let parent = posix.dirname(path)
    while (parent !== '.') { sourceDirectories.add(parent); parent = posix.dirname(parent) }
  }
  const dependencyPath = path => path === 'node_modules' || path.startsWith('node_modules/') || /^(?:apps|packages)\/[^/]+\/node_modules(?:\/|$)/.test(path)
  check(actualRoot === root, 'INSTALL_DEPENDENCY_ROOT_CHANGED')
  const visit = async (path, relative = '') => {
    check(++count <= 100_000, 'INSTALL_DEPENDENCY_LIMIT')
    const info = await lstat(path, { bigint: true })
    check(info.uid === 0n && info.gid === 0n && (info.isSymbolicLink() || (info.mode & 0o022n) === 0n), 'INSTALL_DEPENDENCY_OWNERSHIP')
    if (sourcePaths) check(dependencyPath(relative) || (info.isDirectory() ? sourceDirectories.has(relative) : sourcePaths.has(relative)), 'INSTALL_UNEXPECTED_SOURCE_PATH')
    if (info.isSymbolicLink()) {
      const resolved = await realpath(path)
      check(resolved === actualRoot || resolved.startsWith(actualRoot + '/'), 'INSTALL_DEPENDENCY_ESCAPE')
      entries.push({ path: relative, kind: 'symlink', target: await readlink(path) })
    } else if (info.isDirectory()) {
      if (relative) entries.push({ path: relative, kind: 'directory', mode: Number(info.mode & 0o7777n) })
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative ? relative + '/' + name : name)
    } else {
      check(info.isFile() && (info.mode & 0o6000n) === 0n && info.size <= 64n * 1024n * 1024n, 'INSTALL_DEPENDENCY_KIND')
      const bytes = await readFile(path), after = await lstat(path, { bigint: true })
      check(info.dev === after.dev && info.ino === after.ino && info.size === after.size && info.mtimeNs === after.mtimeNs && info.ctimeNs === after.ctimeNs, 'INSTALL_DEPENDENCY_CHANGED')
      entries.push({ path: relative, kind: 'file', sha256: digest(bytes), bytes: bytes.length, mode: Number(info.mode & 0o7777n) })
    }
  }
  await visit(root)
  return { entries: count, treeSha256: digest(JSON.stringify(entries)) }
}

async function verifySourceInventory(root, report) {
  const paths = new Set()
  for (const entry of report.entries.filter(entry => entry.type === 'file')) {
    const held = await readTrustedFile(join(root, entry.path), { maxBytes: entry.bytes, sha256: entry.sha256 })
    check(Number(held.info.size) === entry.bytes && Number(held.info.mode & 0o7777n) === entry.mode, 'INSTALL_SOURCE_CHANGED')
    paths.add(entry.path)
  }
  return paths
}

// @xterm/addon-fit reads the browser global while the module is evaluated.
const ABI_PROBE = `globalThis.self=globalThis;import {argon2} from 'node:crypto';import {promisify} from 'node:util';import {DatabaseSync} from 'node:sqlite';import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';
const a=await promisify(argon2)('argon2id',{message:Buffer.from('install-abi-probe'),nonce:Buffer.alloc(16,7),parallelism:1,tagLength:32,memory:65536,passes:1});if(a.length!==32)process.exit(1);
const d=new DatabaseSync(':memory:');if(d.prepare('SELECT 1 AS value').get().value!==1)process.exit(1);d.close();
const sbom=JSON.parse(readFileSync('sbom-provenance.json','utf8'));const workspace=new Set(sbom.workspacePackages.map(x=>x.name));for(const p of sbom.workspacePackages){const require=createRequire(process.cwd()+'/'+p.path+'/package.json');for(const dep of p.dependencies)if(!workspace.has(dep.name))require(dep.name);}process.stdout.write('INSTALL_ABI_OK\\n');`

async function verifyDependencies(root, report, trust, runtime) {
  const manager = await command(trust.packageManagerPath, ['--version'], { sha256: trust.packageManagerSha256 })
  check(manager.text.trim() === report.manifest.runtime.packageManager.split('@').at(-1), 'INSTALL_PACKAGE_MANAGER_MISMATCH')
  const install = await command(trust.packageManagerPath, offlineDependencyInstallArguments(report.manifest), { cwd: root, sha256: trust.packageManagerSha256 })
  check(digest(await readFile(join(root, 'pnpm-lock.yaml'))) === report.manifest.lockfileSha256, 'INSTALL_LOCKFILE_CHANGED')
  check(await exists(join(root, 'node_modules')), 'INSTALL_DEPENDENCIES_MISSING')
  await clearDependencyGroupWorldWrite(root)
  const sourcePaths = await verifySourceInventory(root, report)
  const tree = await observeSecureTree(root, sourcePaths)
  const abi = await command(runtime.nodePath, ['--input-type=module', '-e', ABI_PROBE], { cwd: root, sha256: runtime.nodeSha256 })
  check(abi.text.split('\n').filter(line => line === 'INSTALL_ABI_OK').length === 1, 'INSTALL_NATIVE_ABI_FAILED')
  return { tree, managerOutputSha256: manager.outputSha256, installOutputSha256: install.outputSha256, abiOutputSha256: abi.outputSha256 }
}

async function withInputTrust(options, callback) {
  return withTrustedFile(options.trustPath, { exactMode: 0o600, maxBytes: 8192 }, async configPin => {
    const trust = parseBootstrapTrust(parseJson(configPin.bytes))
    return withTrustedFile(trust.signingKeyPath, { exactMode: 0o600, maxBytes: 4096 }, async keyPin => {
      check(keyPin.bytes.length >= 32, 'INSTALL_HMAC_KEY_INVALID')
      return withTrustedFile(options.keysPath, { maxBytes: 16 * 1024 }, async keysPin => {
        const keys = parseBootstrapKeys(parseJson(keysPin.bytes))
        return withTrustedFile(trust.packageManagerPath, { sha256: trust.packageManagerSha256, maxBytes: 256 * 1024 * 1024 }, async managerPin => {
          check((Number(managerPin.info.mode) & 0o111) !== 0, 'INSTALL_TOOL_NOT_EXECUTABLE')
          return callback({ trust, keys, configPin, keyPin, keysPin })
        })
      })
    })
  })
}

async function assertFreshInstallationHost() {
  for (const path of [INSTALL_ROOT, DATABASE, DATABASE + '-wal', DATABASE + '-shm', LIFECYCLE]) check(!await exists(path), 'INSTALL_EXISTING_HOST_REFUSED')
  for (const path of OWNED_PATHS) check(!await exists(path), 'INSTALL_EXISTING_CONTROL_PLANE_REFUSED')
  if (await exists('/var/lib/xpanel/state')) {
    await assertTrustedDirectory('/var/lib/xpanel/state')
    check((await readdir('/var/lib/xpanel/state')).length === 0, 'INSTALL_EXISTING_STATE_REFUSED')
  }
  await assertTrustedDirectory('/opt'); await assertTrustedDirectory('/var/lib')
}

async function withVerifiedBootstrapArchive(options, callback) {
  return withInputTrust(options, async ({ trust, keys, configPin, keyPin, keysPin }) => {
    const sidecar = options.artifactPath.slice(0, -'.tar.gz'.length) + '.manifest.json'
    return withTrustedFile(sidecar, { maxBytes: 4096 }, async publisherPin => {
      const held = await withAuthenticatedReleaseArchive(options.artifactPath,
        { signingKey: keyPin.bytes, keyId: trust.keyId, expectedArchiveSha256: options.artifactSha256 }, async ({ report }) => {
          verifyBootstrapPublisher(parseJson(publisherPin.bytes), report, keys)
          assertFreshInstallReleaseControls(report)
          check(report.manifest.runtime.nodeVersion === PINNED_NODE, 'INSTALL_RELEASE_CONTROLS_REQUIRED')
          return callback({ report, trust, configPin, keyPin, keysPin })
        })
      await configPin.verify(); await keyPin.verify(); await keysPin.verify(); await publisherPin.verify()
      return held.value
    })
  })
}

function nativeBootstrapInput(input, phase) {
  check(input && typeof input === 'object' && !Array.isArray(input)
    && Reflect.ownKeys(input).every(key => ['phase', 'artifactPath', 'artifactSha256', 'trustPath', 'keysPath'].includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))
    && (input.phase === undefined || input.phase === phase), 'INSTALL_OPTIONS_INVALID')
  return parseBootstrapArgs([phase, `--artifact=${input.artifactPath}`, `--artifact-sha256=${input.artifactSha256}`, `--release-trust-file=${input.trustPath}`, `--release-keys-file=${input.keysPath}`])
}

async function emptyResumeDirectory(path, uid, gid, mode, allowed = []) {
  const before = await lstat(path, { bigint: true })
  check(before.isDirectory() && before.uid === BigInt(uid) && before.gid === BigInt(gid)
    && Number(before.mode & 0o7777n) === mode, 'INSTALL_RESUME_DIRECTORY_UNSAFE')
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    check(opened.dev === before.dev && opened.ino === before.ino, 'INSTALL_RESUME_DIRECTORY_CHANGED')
    const acl = await command('/usr/bin/getfacl', ['--omit-header', '--absolute-names', '--numeric', '--no-effective',
      '/proc/' + process.pid + '/fd/' + handle.fd])
    const expectedAcl = ['user::rwx', (mode & 0o070) === 0o070 ? 'group::rwx' : 'group::r-x', 'other::---']
    const aclLines = acl.text.trim().split('\n').filter(Boolean)
    check(aclLines.length === expectedAcl.length && aclLines.every((line, index) => line === expectedAcl[index]), 'INSTALL_RESUME_DIRECTORY_ACL_UNSAFE')
    check((await readdir('/proc/self/fd/' + handle.fd)).every(name => allowed.includes(name)), 'INSTALL_RESUME_STATE_PRESENT')
    const named = await lstat(path, { bigint: true }), after = await handle.stat({ bigint: true })
    check([named, after].every(info => ['dev', 'ino', 'uid', 'gid', 'mode', 'mtimeNs', 'ctimeNs'].every(key => info[key] === before[key])), 'INSTALL_RESUME_DIRECTORY_CHANGED')
  } finally { await handle.close() }
}

async function emptyResumeData() {
  if (await exists('/var/lib/xpanel')) {
    const principal = await command('/usr/bin/getent', ['passwd', 'xpanel'])
    const fields = principal.text.trim().split(':')
    check(fields.length === 7 && fields[0] === 'xpanel' && /^[1-9][0-9]*$/.test(fields[2]) && /^[1-9][0-9]*$/.test(fields[3])
      && fields[5] === '/var/lib/xpanel' && ['/sbin/nologin', '/usr/sbin/nologin'].includes(fields[6]), 'INSTALL_RESUME_SERVICE_IDENTITY_INVALID')
    const uid = Number(fields[2]), gid = Number(fields[3])
    check(Number.isSafeInteger(uid) && Number.isSafeInteger(gid), 'INSTALL_RESUME_SERVICE_IDENTITY_INVALID')
    await assertResumeServiceQuiescent(uid, gid)
    await emptyResumeDirectory('/var/lib/xpanel', uid, gid, 0o2770, ['state', 'generations'])
    for (const path of ['/var/lib/xpanel/state', '/var/lib/xpanel/generations']) {
      if (await exists(path)) await emptyResumeDirectory(path, uid, gid, 0o2750)
    }
    await assertResumeServiceQuiescent(uid, gid)
  }
  for (const path of ['/var/lib/xpanel-agent', '/run/xpanel']) {
    if (await exists(path)) {
      await assertTrustedDirectory(path)
      check((await readdir(path)).length === 0, 'INSTALL_RESUME_STATE_PRESENT')
    }
  }
}

async function readResumeProcLeaf(base, name, limit) {
  const handle = await open(base + '/' + name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const buffer = Buffer.alloc(limit + 1)
    let total = 0
    while (total <= limit) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null)
      if (!bytesRead) break
      total += bytesRead
    }
    check(total <= limit, 'INSTALL_RESUME_PROCESS_UNOBSERVABLE')
    return buffer.subarray(0, total).toString('utf8')
  } finally { await handle.close() }
}

async function assertResumeHostView() {
  check((await readFile('/proc/1/comm', 'utf8')).trim() === 'systemd', 'INSTALL_RESUME_HOST_VIEW_REQUIRED')
  for (const name of ['pid', 'mnt', 'user', 'net']) {
    check(await readlink('/proc/self/ns/' + name) === await readlink('/proc/1/ns/' + name), 'INSTALL_RESUME_HOST_VIEW_REQUIRED')
  }
}

async function assertResumeServiceQuiescent(uid, gid) {
  const pids = (await readdir('/proc')).filter(name => /^[1-9][0-9]*$/.test(name))
  check(pids.length <= 16384, 'INSTALL_RESUME_PROCESS_LIMIT')
  let tasks = 0
  for (const pid of pids) {
    let processPin
    try {
      processPin = await open('/proc/' + pid, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      const taskRoot = '/proc/self/fd/' + processPin.fd + '/task'
      const tids = await readdir(taskRoot)
      check(tids.length <= 4096 && tids.every(name => /^[1-9][0-9]*$/.test(name)), 'INSTALL_RESUME_PROCESS_UNOBSERVABLE')
      for (const tid of tids) {
        check(++tasks <= 65536, 'INSTALL_RESUME_PROCESS_LIMIT')
        let taskPin
        try {
          taskPin = await open(taskRoot + '/' + tid, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          const base = '/proc/self/fd/' + taskPin.fd
          const before = await readResumeProcLeaf(base, 'stat', 4096)
          const status = await readResumeProcLeaf(base, 'status', 65536)
          const ids = /^Uid:[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]*$/m.exec(status)
          const gids = /^Gid:[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]*$/m.exec(status)
          const groups = /^Groups:[ \t]*([0-9 \t]*)$/m.exec(status)
          check(ids && gids && groups, 'INSTALL_RESUME_PROCESS_UNOBSERVABLE')
          check(ids.slice(1).every(value => Number(value) !== uid)
            && gids.slice(1).every(value => Number(value) !== gid)
            && groups[1].trim().split(/[ \t]+/).filter(Boolean).every(value => Number(value) !== gid), 'INSTALL_RESUME_SERVICE_PROCESS_PRESENT')
          const after = await readResumeProcLeaf(base, 'stat', 4096)
          const birth = value => value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
          check(before.startsWith(tid + ' (') && after.startsWith(tid + ' (') && /^[1-9][0-9]*$/.test(birth(before) ?? '')
            && birth(before) === birth(after), 'INSTALL_RESUME_PROCESS_CHANGED')
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        finally { if (taskPin) await taskPin.close() }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    finally { if (processPin) await processPin.close() }
  }
}

/** Authenticate fresh inputs without publishing product state, before OS prerequisites. */
export async function verifyNewInstallation(input) {
  const options = nativeBootstrapInput(input, 'verify')
  await nativeContext(); await assertFreshInstallationHost()
  return withVerifiedBootstrapArchive(options, async ({ report }) => freeze({ status: 'verified', version: report.manifest.version, active: false }))
}

/** Exact early preparation only; no DB, admission, owned units, receipt or source mutation. */
export async function resumePreparedInstallation(input) {
  const options = nativeBootstrapInput(input, 'resume')
  const runtime = await nativeContext()
  await assertResumeHostView()
  return withTrustedFile(BOOTSTRAP_PATH, { exactMode: 0o600, maxBytes: 16 * 1024 }, async bootstrapPin => {
    const bootstrap = parseJson(bootstrapPin.bytes)
    object(bootstrap, ['schemaVersion', 'status', 'createdAt', 'version', 'releaseRoot', 'archiveSha256', 'manifestSha256', 'controlDbSchemaVersion', 'dependencyReceiptSha256', 'runtime'], 'INSTALL_RESUME_BOOTSTRAP_INVALID')
    check(bootstrap.status === 'prepared' && bootstrap.archiveSha256 === options.artifactSha256, 'INSTALL_RESUME_PREPARED_REQUIRED')
    for (const path of [DATABASE, DATABASE + '-wal', DATABASE + '-shm', '/var/lib/xpanel/install-journal.json',
      '/etc/xpanel/mariadb-admin.cnf', ...OWNED_PATHS]) check(!await exists(path), 'INSTALL_RESUME_EFFECTS_PRESENT')
    await assertTrustedDirectory(LIFECYCLE)
    check((await readdir(LIFECYCLE)).every(name => ['bootstrap.json', 'install-dependencies.json', 'prepared'].includes(name)), 'INSTALL_RESUME_LIFECYCLE_EFFECTS_PRESENT')
    await emptyResumeData()
    for (const unit of [...OWNED_PANEL_UNITS, 'xpanel-lifecycle.service']) {
      const result = await command('/usr/bin/systemctl', ['show', unit, '--property=LoadState,ActiveState,MainPID,ControlPID'])
      const fields = Object.fromEntries(result.text.trim().split('\n').map(line => line.split('=')))
      const noProcesses = unit === 'xpanel-management-tls.timer'
        ? fields.MainPID === undefined && fields.ControlPID === undefined
        : fields.MainPID === '0' && fields.ControlPID === '0'
      check(fields.LoadState === 'not-found' && fields.ActiveState === 'inactive' && noProcesses, 'INSTALL_RESUME_UNIT_PRESENT')
    }
    await verifyPreparedBootstrapSource(runtime, bootstrap)
    return withVerifiedBootstrapArchive(options, async ({ report, trust, keyPin, keysPin }) => {
      check(report.manifest.version === bootstrap.version && report.manifestSha256 === bootstrap.manifestSha256
        && report.manifest.controlDbSchemaVersion === bootstrap.controlDbSchemaVersion, 'INSTALL_RESUME_ARCHIVE_MISMATCH')
      const installedTrust = parseBootstrapTrust(parseJson((await readTrustedFile('/etc/xpanel/release-trust.json', { exactMode: 0o600, maxBytes: 8192 })).bytes))
      check(installedTrust.signingKeyPath === '/etc/xpanel/release-hmac.key' && installedTrust.keyId === trust.keyId
        && installedTrust.packageManagerPath === trust.packageManagerPath && installedTrust.packageManagerSha256 === trust.packageManagerSha256,
      'INSTALL_RESUME_TRUST_MISMATCH')
      await readTrustedFile(installedTrust.signingKeyPath, { exactMode: 0o600, maxBytes: 4096, sha256: digest(keyPin.bytes) })
      await readTrustedFile('/etc/xpanel/release-keys.json', { exactMode: 0o644, maxBytes: 16 * 1024, sha256: digest(keysPin.bytes) })
      await verifySourceInventory(bootstrap.releaseRoot, report)
      await verifyResumePreparedProof(report, trust, runtime, bootstrap)
      await verifyPreparedBootstrapSource(runtime, bootstrap)
      await bootstrapPin.verify()
      return freeze({ status: 'prepared', version: bootstrap.version, releaseRoot: bootstrap.releaseRoot, currentLink: CURRENT,
        dependencyReceiptSha256: bootstrap.dependencyReceiptSha256, installationReceipt: 'pending', resumed: true })
    })
  })
}

/** Fresh-host only. Actual extraction, dependency effects and publication are never injectable. */
export async function prepareNewInstallation(input) {
  const options = nativeBootstrapInput(input, 'prepare')
  const runtime = await nativeContext()
  process.umask(0o022)
  await assertFreshInstallationHost()
  return withInputTrust(options, async ({ trust, keys, configPin, keyPin, keysPin }) => {
    const sidecarPath = options.artifactPath.slice(0, -'.tar.gz'.length) + '.manifest.json'
    return withTrustedFile(sidecarPath, { maxBytes: 4096 }, async publisherPin => {
      const archiveTrust = { signingKey: keyPin.bytes, keyId: trust.keyId, expectedArchiveSha256: options.artifactSha256 }
      const held = await withAuthenticatedReleaseArchive(options.artifactPath, archiveTrust, async ({ report }) => {
        verifyBootstrapPublisher(parseJson(publisherPin.bytes), report, keys)
        check(report.manifest.runtime.nodeVersion === PINNED_NODE, 'INSTALL_RELEASE_CONTROLS_REQUIRED')
        assertFreshInstallReleaseControls(report)
        await newDirectory(INSTALL_ROOT); await newDirectory(INSTALL_ROOT + '/staging', 0o700)
        await newDirectory(INSTALL_ROOT + '/releases'); await newDirectory(INSTALL_ROOT + '/downloads', 0o700)
        await newDirectory(LIFECYCLE)
        await writeNewJson(BOOTSTRAP_PATH, { schemaVersion: 1, status: 'preparing', createdAt: new Date().toISOString(), archiveSha256: report.archiveSha256, manifestSha256: report.manifestSha256, version: report.manifest.version, runtime })
        const staged = await stageAuthenticatedReleaseArchive(INSTALL_ROOT + '/staging', { signingKey: keyPin.bytes, keyId: trust.keyId, authenticatedArchive: report })
        const dependencies = await verifyDependencies(staged.stagedAt, report, trust, runtime)
        return { stagedAt: staged.stagedAt, dependencies }
      })
      // Descriptor retirement has completed successfully before anything is made current.
      await configPin.verify(); await keyPin.verify(); await keysPin.verify(); await publisherPin.verify()
      const report = held.report, releaseRoot = INSTALL_ROOT + '/releases/' + report.manifest.version
      await rename(held.value.stagedAt, releaseRoot); await chmod(releaseRoot, 0o755); await syncDirectory(INSTALL_ROOT + '/releases'); await syncDirectory(INSTALL_ROOT + '/staging')
      const sourcePaths = await verifySourceInventory(releaseRoot, report)
      const relocated = await observeSecureTree(releaseRoot, sourcePaths)
      check(relocated.treeSha256 === held.value.dependencies.tree.treeSha256, 'INSTALL_DEPENDENCY_RELOCATION_CHANGED')
      const dependency = { schemaVersion: 1, kind: 'xpanel-installed-dependencies', verifiedAt: new Date().toISOString(), root: releaseRoot, archiveSha256: report.archiveSha256,
        manifestSha256: report.manifestSha256, controlDbSchemaVersion: report.manifest.controlDbSchemaVersion,
        lockfileSha256: report.manifest.lockfileSha256, nodePath: runtime.nodePath, nodeVersion: PINNED_NODE, nodeSha256: runtime.nodeSha256, packageManagerPath: trust.packageManagerPath,
        packageManagerSha256: trust.packageManagerSha256, packageManager: report.manifest.runtime.packageManager, ...held.value.dependencies, tree: relocated }
      const dependencyReceiptSha256 = await writeNewJson(DEPENDENCY_RECEIPT, dependency)
      if (REPAIR_CONTROL_FILES.every(path => report.manifest.files.some(entry => entry.path === path))) await publishPreparedReleaseProof(report, trust, runtime, dependency, false)
      if (!await exists('/etc/xpanel')) await newDirectory('/etc/xpanel')
      else await assertTrustedDirectory('/etc/xpanel')
      await persistTrust('/etc/xpanel/release-hmac.key', keyPin.bytes, 0o600)
      await persistTrust('/etc/xpanel/release-trust.json', Buffer.from(JSON.stringify({ ...trust, signingKeyPath: '/etc/xpanel/release-hmac.key' }) + '\n'), 0o600)
      await persistTrust('/etc/xpanel/release-keys.json', keysPin.bytes, 0o644)
      await symlink(releaseRoot, CURRENT); await syncDirectory(INSTALL_ROOT)
      const bootstrap = { schemaVersion: 1, status: 'prepared', createdAt: new Date().toISOString(), version: report.manifest.version, releaseRoot, archiveSha256: report.archiveSha256,
        manifestSha256: report.manifestSha256, controlDbSchemaVersion: report.manifest.controlDbSchemaVersion, dependencyReceiptSha256, runtime }
      await replaceBootstrap(bootstrap)
      return freeze({ status: 'prepared', version: bootstrap.version, releaseRoot, currentLink: CURRENT, dependencyReceiptSha256, installationReceipt: 'pending' })
    })
  })
}

async function replaceBootstrap(value) {
  await withTrustedDirectory(LIFECYCLE, async parent => {
    const temporary = BOOTSTRAP_PATH + '.' + randomUUID() + '.tmp'
    await writeNewJson(temporary, value)
    await rename(temporary, BOOTSTRAP_PATH); await syncDirectory(LIFECYCLE); await parent.verify()
  })
}
async function verifyPreparedBootstrapSource(runtime, value) {
  check(value?.schemaVersion === 1 && VERSION.test(value.version)
    && value.releaseRoot === INSTALL_ROOT + '/releases/' + value.version && [value.archiveSha256, value.manifestSha256, value.dependencyReceiptSha256].every(item => typeof item === 'string' && SHA.test(item)), 'INSTALL_BOOTSTRAP_INVALID')
  check(await readlink(CURRENT) === value.releaseRoot && await realpath(CURRENT) === value.releaseRoot, 'INSTALL_CURRENT_CHANGED')
  object(value.runtime, ['nodePath', 'nodeSha256'], 'INSTALL_RUNTIME_BINDING_INVALID')
  check(runtime.nodePath === value.runtime.nodePath && runtime.nodeSha256 === value.runtime.nodeSha256, 'INSTALL_RUNTIME_BINDING_INVALID')
  const dependency = await readTrustedFile(DEPENDENCY_RECEIPT, { exactMode: 0o600, maxBytes: 16 * 1024, sha256: value.dependencyReceiptSha256 })
  const recorded = parseJson(dependency.bytes)
  const manifest = parseJson((await readTrustedFile(join(value.releaseRoot, 'release-manifest.json'), { maxBytes: 16 * 1024 * 1024, sha256: value.manifestSha256 })).bytes)
  check(recorded?.schemaVersion === 1 && recorded.kind === 'xpanel-installed-dependencies' && recorded.root === value.releaseRoot
    && recorded.archiveSha256 === value.archiveSha256 && recorded.manifestSha256 === value.manifestSha256
    && recorded.controlDbSchemaVersion === value.controlDbSchemaVersion && manifest.controlDbSchemaVersion === value.controlDbSchemaVersion
    && manifest.version === value.version && manifest.runtime?.nodeVersion === PINNED_NODE
    && recorded.nodeVersion === PINNED_NODE && recorded.nodePath === runtime.nodePath && recorded.nodeSha256 === runtime.nodeSha256
    && recorded.packageManager === manifest.runtime.packageManager && recorded.lockfileSha256 === manifest.lockfileSha256, 'INSTALL_DEPENDENCY_BINDING_INVALID')
  await readTrustedFile(join(value.releaseRoot, 'pnpm-lock.yaml'), { maxBytes: 4 * 1024 * 1024, sha256: recorded.lockfileSha256 })
  const trust = parseBootstrapTrust(parseJson((await readTrustedFile('/etc/xpanel/release-trust.json', { exactMode: 0o600, maxBytes: 8192 })).bytes))
  check(recorded.packageManagerPath === trust.packageManagerPath && recorded.packageManagerSha256 === trust.packageManagerSha256, 'INSTALL_DEPENDENCY_BINDING_INVALID')
  await readTrustedFile(trust.packageManagerPath, { maxBytes: 256 * 1024 * 1024, sha256: trust.packageManagerSha256 })
  const tree = await observeSecureTree(value.releaseRoot)
  check(tree.treeSha256 === recorded.tree?.treeSha256, 'INSTALL_RELEASE_TREE_CHANGED')
  return value
}

async function preparedBootstrap(runtime) {
  const actual = await readTrustedFile(BOOTSTRAP_PATH, { exactMode: 0o600, maxBytes: 16 * 1024 }), value = parseJson(actual.bytes)
  check(['prepared', 'admission_ready', 'bootstrap_pending'].includes(value?.status), 'INSTALL_BOOTSTRAP_INVALID')
  check(await realpath(fileURLToPath(import.meta.url)) === join(value.releaseRoot, 'scripts/install-bootstrap.mjs'), 'INSTALL_HELPER_SOURCE_MISMATCH')
  return verifyPreparedBootstrapSource(runtime, value)
}

/** Observe one exact prepared installation; this does not acquire native mutation authority. */
export async function observePreparedInstallFinalization() {
  return observeFinalizationSource(true)
}

/** Read-only acquisition proof, called only after the installed verifier authenticates this helper archive. */
export async function observeInstalledAcquisitionSource() { return observeFinalizationSource(false) }

async function observeFinalizationSource(requireSameHelper) {
  const runtime = await nativeContext()
  const actual = await readTrustedFile(BOOTSTRAP_PATH, { exactMode: 0o600, maxBytes: 16 * 1024 })
  let bootstrap = parseJson(actual.bytes)
  check(bootstrap?.status === 'bootstrap_pending' || bootstrap?.status === 'active', 'INSTALL_FINALIZATION_PREPARATION_REQUIRED')
  if (bootstrap.status === 'active') {
    const { withActiveInstallationObservation } = await import('./install-transition-observation.mjs')
    return withActiveInstallationObservation(actual.bytes.toString('utf8'), async observed => {
      if (requireSameHelper) check(await realpath(fileURLToPath(import.meta.url)) === join(observed.bootstrap.releaseRoot, 'scripts/install-bootstrap.mjs'), 'INSTALL_HELPER_SOURCE_MISMATCH')
      await verifyPreparedBootstrapSource(runtime, observed.bootstrap)
      await observed.assertCurrent()
      return freeze({ bootstrap: observed.bootstrap, runtime })
    })
  }
  const recoveryPins = []
  if (bootstrap.status === 'active' || Object.hasOwn(bootstrap, 'finalization')) {
    const receipt = await readTrustedFile(LIFECYCLE + '/installation.json', { exactMode: 0o600, maxBytes: 64 * 1024 })
    const head = await readTrustedFile(LIFECYCLE + '/HEAD', { exactMode: 0o600, maxBytes: 16 * 1024 })
    const { inspectInstallFinalizationRecovery } = await import('./install-finalization.mjs')
    bootstrap = inspectInstallFinalizationRecovery({ bootstrapBytes: actual.bytes.toString('utf8'), receiptBytes: receipt.bytes.toString('utf8'), headBytes: head.bytes.toString('utf8') }).bootstrap
    recoveryPins.push([LIFECYCLE + '/installation.json', receipt.sha256, 64 * 1024], [LIFECYCLE + '/HEAD', head.sha256, 16 * 1024])
  }
  if (requireSameHelper) check(await realpath(fileURLToPath(import.meta.url)) === join(bootstrap.releaseRoot, 'scripts/install-bootstrap.mjs'), 'INSTALL_HELPER_SOURCE_MISMATCH')
  await verifyPreparedBootstrapSource(runtime, bootstrap)
  for (const [path, sha256, maxBytes] of recoveryPins) await readTrustedFile(path, { exactMode: 0o600, maxBytes, sha256 })
  await readTrustedFile(BOOTSTRAP_PATH, { exactMode: 0o600, maxBytes: 16 * 1024, sha256: actual.sha256 })
  return freeze({ bootstrap, runtime })
}

/** One fixed native entry; request data never chooses a module, path, provider or authority. */
export async function finalizePreparedInstallation(request) {
  const { runNativeInstallFinalization } = await import('./install-finalization-native.mjs')
  return runNativeInstallFinalization(request)
}

const preparedScopes = new WeakMap(), preparedActive = new AsyncLocalStorage()
const PREPARED_ROOT = LIFECYCLE + '/prepared'
const REPAIR_CONTROL_FILES = Object.freeze(['scripts/prepared-release.mjs', 'scripts/prepare-lifecycle-release.mjs',
  'scripts/install-bootstrap.mjs', 'scripts/install-finalization.mjs', 'scripts/install-finalization-native.mjs',
  'scripts/install-finalization-readiness.mjs', 'scripts/acquire-lifecycle-release.mjs', 'scripts/install-transition-observation.mjs'])

async function verifyResumePreparedProof(report, trust, runtime, bootstrap) {
  if (!REPAIR_CONTROL_FILES.every(path => report.manifest.files.some(entry => entry.path === path))) {
    check(!await exists(PREPARED_ROOT), 'INSTALL_RESUME_PREPARED_PROOF_UNEXPECTED')
    return
  }
  const archive = report.archiveSha256, directory = PREPARED_ROOT + '/' + archive
  const version = PREPARED_ROOT + '/version-' + report.manifest.version
  const inspect = async (path, names, callback) => withTrustedDirectory(path, async pin => {
    const info = await lstat(path, { bigint: true })
    check(Number(info.mode & 0o7777n) === 0o700, 'INSTALL_RESUME_PREPARED_DIRECTORY_UNSAFE')
    const entries = (await readdir(path)).sort()
    check(entries.length === names.length && entries.every((name, index) => name === [...names].sort()[index]), 'INSTALL_RESUME_PREPARED_CONTENTS_CHANGED')
    await callback(); await pin.verify()
  })
  await inspect(PREPARED_ROOT, [archive, 'version-' + report.manifest.version], async () => {
    await inspect(version, [], async () => {})
    await inspect(directory, ['dependencies.json', 'prepared.json'], async () => {
      const dependencyPath = directory + '/dependencies.json'
      await withTrustedFile(dependencyPath, { exactMode: 0o600, maxBytes: 16 * 1024, sha256: bootstrap.dependencyReceiptSha256 }, async dependency => {
        const recorded = parseJson(dependency.bytes)
        await withTrustedFile(directory + '/prepared.json', { exactMode: 0o600, maxBytes: 16 * 1024 }, async proof => {
          const value = parseJson(proof.bytes)
          object(value, ['schemaVersion', 'kind', 'releaseRoot', 'version', 'archiveSha256', 'manifestSha256', 'sourceFilesDigest', 'treeSha256',
            'controlDbSchemaVersion', 'dependencyReceiptPath', 'dependencyReceiptSha256', 'runtime'], 'INSTALL_RESUME_PREPARED_PROOF_INVALID')
          object(value.runtime, ['nodePath', 'nodeSha256', 'nodeVersion', 'packageManagerPath', 'packageManagerSha256'], 'INSTALL_RESUME_PREPARED_PROOF_INVALID')
          check(value.schemaVersion === 1 && value.kind === 'xpanel-prepared-release' && value.releaseRoot === bootstrap.releaseRoot
            && value.version === bootstrap.version && value.archiveSha256 === archive && value.manifestSha256 === report.manifestSha256
            && value.sourceFilesDigest === digest(JSON.stringify(report.manifest.files)) && value.treeSha256 === recorded.tree?.treeSha256
            && value.controlDbSchemaVersion === bootstrap.controlDbSchemaVersion && value.dependencyReceiptPath === dependencyPath
            && value.dependencyReceiptSha256 === dependency.sha256 && value.runtime.nodePath === runtime.nodePath
            && value.runtime.nodeSha256 === runtime.nodeSha256 && value.runtime.nodeVersion === PINNED_NODE
            && value.runtime.packageManagerPath === trust.packageManagerPath && value.runtime.packageManagerSha256 === trust.packageManagerSha256,
          'INSTALL_RESUME_PREPARED_PROOF_MISMATCH')
          await proof.verify()
        })
        await dependency.verify()
      })
    })
  })
}

async function publishPreparedReleaseProof(report, trust, runtime, dependency, directoryReady) {
  const directory = PREPARED_ROOT + '/' + report.archiveSha256, dependencyReceiptPath = directory + '/dependencies.json'
  if (!directoryReady) {
    if (!await exists(PREPARED_ROOT)) await newDirectory(PREPARED_ROOT, 0o700)
    else await assertTrustedDirectory(PREPARED_ROOT)
    await newDirectory(PREPARED_ROOT + '/version-' + report.manifest.version, 0o700)
    await newDirectory(directory, 0o700)
  }
  const dependencyReceiptSha256 = await writeNewJson(dependencyReceiptPath, dependency)
  await writeNewJson(directory + '/prepared.json', { schemaVersion: 1, kind: 'xpanel-prepared-release', releaseRoot: dependency.root, version: report.manifest.version,
    archiveSha256: report.archiveSha256, manifestSha256: report.manifestSha256, sourceFilesDigest: digest(JSON.stringify(report.manifest.files)),
    treeSha256: dependency.tree.treeSha256, controlDbSchemaVersion: report.manifest.controlDbSchemaVersion, dependencyReceiptPath, dependencyReceiptSha256,
    runtime: { ...runtime, nodeVersion: PINNED_NODE, packageManagerPath: trust.packageManagerPath, packageManagerSha256: trust.packageManagerSha256 } })
}

export function parsePreparedReleaseInput(value) {
  object(value, ['artifactPath', 'expectedArchiveSha256'], 'PREPARED_RELEASE_INPUT_INVALID')
  check(durableLocation(value.artifactPath) && value.artifactPath.endsWith('.tar.gz')
    && typeof value.expectedArchiveSha256 === 'string' && SHA.test(value.expectedArchiveSha256), 'PREPARED_RELEASE_INPUT_INVALID')
  return freeze(structuredClone(value))
}

/** Read-only full closure observation; parsed hashes never confer native authority. */
export async function observeInstalledReleaseTree(root) {
  requireLinuxRoot()
  check(typeof root === 'string' && root.startsWith(INSTALL_ROOT + '/releases/')
    && VERSION.test(root.slice((INSTALL_ROOT + '/releases/').length)), 'PREPARED_RELEASE_ROOT_INVALID')
  return withTrustedDirectory(root, async pin => { const tree = await observeSecureTree(root); await pin.verify(); return freeze(tree) })
}

function preparedScope(capability) {
  const scope = capability && typeof capability === 'object' ? preparedScopes.get(capability) : undefined
  let current = preparedActive.getStore(), visible = false
  while (current) {
    check(current.live && current.pid === process.pid, 'PREPARED_RELEASE_CAPABILITY_REQUIRED')
    if (current === scope) { visible = true; break }
    current = current.parent
  }
  check(scope && scope.live && visible, 'PREPARED_RELEASE_CAPABILITY_REQUIRED')
  return scope
}

export function preparedReleaseInfo(capability) { const scope = preparedScope(capability); return freeze({ ...structuredClone(scope.info), artifactPath: scope.artifactPath }) }

export async function assertPreparedReleaseCurrent(capability) {
  const scope = preparedScope(capability)
  check(process.pid === scope.pid, 'PREPARED_RELEASE_PROCESS_CHANGED')
  for (const pin of scope.pins) await pin.verify()
  await readTrustedFile(scope.info.dependencyReceiptPath, { exactMode: 0o600, maxBytes: 16 * 1024, sha256: scope.info.dependencyReceiptSha256 })
  await readTrustedFile(scope.recordPath, { exactMode: 0o600, maxBytes: 16 * 1024, sha256: scope.recordSha256 })
  const helperPaths = await verifySourceInventory(scope.helperRoot, scope.helperReport)
  const helperTree = await observeSecureTree(scope.helperRoot, helperPaths)
  check(helperTree.treeSha256 === scope.helperTreeSha256, 'PREPARED_RELEASE_HELPER_CHANGED')
  const paths = await verifySourceInventory(scope.info.releaseRoot, scope.report)
  const tree = await observeSecureTree(scope.info.releaseRoot, paths)
  check(tree.treeSha256 === scope.info.treeSha256, 'PREPARED_RELEASE_TREE_CHANGED')
  for (const pin of scope.pins) await pin.verify()
}

/** The new helper and installed old source have separate identities; neither replaces the other. */
export async function observePreparedAdoptionSource(capability) {
  await assertPreparedReleaseCurrent(capability)
  const helper = preparedReleaseInfo(capability)
  check(await realpath(fileURLToPath(import.meta.url)) === helper.releaseRoot + '/scripts/install-bootstrap.mjs', 'PREPARED_ADOPTION_HELPER_MISMATCH')
  const installed = await observeFinalizationSource(false)
  check(installed.runtime.nodePath === helper.runtime.nodePath && installed.runtime.nodeSha256 === helper.runtime.nodeSha256,
    'PREPARED_ADOPTION_RUNTIME_MISMATCH')
  await assertPreparedReleaseCurrent(capability)
  return freeze({ ...installed, helper })
}

/** Root-only product preparation. It never writes current, installed receipts, units or account data. */
export const withPreparedRelease = (input, callback) => withPreparedReleaseScope(input, callback, true)
/** Strict read-only reopening; missing/incomplete preparation is a conflict, never an install retry. */
export const withExistingPreparedRelease = (input, callback) => withPreparedReleaseScope(input, callback, false)

async function withPreparedReleaseScope(input, callback, mayPrepare) {
  const options = parsePreparedReleaseInput(input), runtime = await nativeContext()
  check(typeof callback === 'function', 'PREPARED_RELEASE_CALLBACK_REQUIRED')
  const inputTrust = { trustPath: '/etc/xpanel/release-trust.json', keysPath: '/etc/xpanel/release-keys.json' }
  const held = await withInputTrust(inputTrust, async ({ trust, keys, configPin, keyPin, keysPin }) => {
    check(trust.signingKeyPath === '/etc/xpanel/release-hmac.key', 'PREPARED_RELEASE_TRUST_CHANGED')
    return withTrustedFile(runtime.nodePath, { sha256: runtime.nodeSha256, maxBytes: 256 * 1024 * 1024 }, async nodePin => {
      const sidecar = options.artifactPath.slice(0, -'.tar.gz'.length) + '.manifest.json'
      return withTrustedFile(sidecar, { maxBytes: 4096 }, async publisherPin => {
        const archiveTrust = { signingKey: keyPin.bytes, keyId: trust.keyId, expectedArchiveSha256: options.expectedArchiveSha256 }
        const archive = await withAuthenticatedReleaseArchive(options.artifactPath, archiveTrust, async ({ report }) => {
          verifyBootstrapPublisher(parseJson(publisherPin.bytes), report, keys)
          check(report.manifest.runtime.nodeVersion === PINNED_NODE
            && REPAIR_CONTROL_FILES.every(path => report.manifest.files.some(entry => entry.path === path)), 'PREPARED_RELEASE_CONTROLS_REQUIRED')
          // Authenticate the complete delivered helper source before extraction or dependency effects.
          const helperRoot = dirname(dirname(await realpath(fileURLToPath(import.meta.url))))
          check(durableLocation(helperRoot), 'PREPARED_RELEASE_HELPER_LOCATION_INVALID')
          const parentScope = preparedActive.getStore() ?? null
          let helperReport = report
          if (parentScope) {
            await assertPreparedReleaseCurrent(parentScope.capability)
            check(helperRoot === parentScope.helperRoot, 'PREPARED_RELEASE_HELPER_CHANGED')
            helperReport = parentScope.helperReport
          }
          const helperPaths = await verifySourceInventory(helperRoot, helperReport)
          const helperTree = await observeSecureTree(helperRoot, helperPaths)
          const releaseRoot = INSTALL_ROOT + '/releases/' + report.manifest.version
          const recordDirectory = PREPARED_ROOT + '/' + report.archiveSha256
          const recordPath = recordDirectory + '/prepared.json', dependencyReceiptPath = recordDirectory + '/dependencies.json'
          const pins = [configPin, keyPin, keysPin, nodePin, publisherPin]
          for (const pin of pins) await pin.verify()
          if (!await exists(recordPath)) {
            check(mayPrepare, 'PREPARED_RELEASE_NOT_PREPARED')
            const installation = await readInstallationReceipt(), source = installation.receipt.source
            check(['bootstrap_pending', 'active'].includes(installation.receipt.status), 'PREPARED_RELEASE_INSTALLATION_REQUIRED')
            const targetVersion = report.manifest.version.split('.').map(Number), oldVersion = source.version.split('.').map(Number)
            check(targetVersion.some((value, i) => value > oldVersion[i] && targetVersion.slice(0, i).every((n, j) => n === oldVersion[j])), 'PREPARED_RELEASE_NEW_VERSION_REQUIRED')
            check(!await exists(releaseRoot) && !await exists(recordDirectory), 'PREPARED_RELEASE_CONFLICT')
            await assertTrustedDirectory(INSTALL_ROOT + '/releases'); await assertTrustedDirectory(INSTALL_ROOT + '/staging')
            if (!await exists(PREPARED_ROOT)) await newDirectory(PREPARED_ROOT, 0o700)
            else await assertTrustedDirectory(PREPARED_ROOT)
            // mkdir is the exclusive durable intent; a crash never causes an automatic second dependency install.
            await newDirectory(PREPARED_ROOT + '/version-' + report.manifest.version, 0o700)
            await newDirectory(recordDirectory, 0o700)
            await writeNewJson(recordDirectory + '/intent.json', { schemaVersion: 1, kind: 'xpanel-prepared-release-intent',
              archiveSha256: report.archiveSha256, manifestSha256: report.manifestSha256, releaseRoot,
              installedArchiveSha256: source.archiveSha256, createdAt: new Date().toISOString() })
            for (const pin of pins) await pin.verify()
            const staged = await stageAuthenticatedReleaseArchive(INSTALL_ROOT + '/staging', { signingKey: keyPin.bytes, keyId: trust.keyId, authenticatedArchive: report })
            const dependencies = await verifyDependencies(staged.stagedAt, report, trust, runtime)
            for (const pin of pins) await pin.verify()
            check(!await exists(releaseRoot), 'PREPARED_RELEASE_CONFLICT')
            await withTrustedDirectory(INSTALL_ROOT + '/releases', async parent => {
              await rename(staged.stagedAt, releaseRoot); await chmod(releaseRoot, 0o755)
              await syncDirectory(INSTALL_ROOT + '/releases'); await syncDirectory(INSTALL_ROOT + '/staging'); await parent.verify()
            })
            const sourcePaths = await verifySourceInventory(releaseRoot, report), relocated = await observeSecureTree(releaseRoot, sourcePaths)
            check(relocated.treeSha256 === dependencies.tree.treeSha256, 'PREPARED_RELEASE_RELOCATION_CHANGED')
            const dependency = { schemaVersion: 1, kind: 'xpanel-installed-dependencies', verifiedAt: new Date().toISOString(), root: releaseRoot,
              archiveSha256: report.archiveSha256, manifestSha256: report.manifestSha256, controlDbSchemaVersion: report.manifest.controlDbSchemaVersion,
              lockfileSha256: report.manifest.lockfileSha256, nodePath: runtime.nodePath, nodeVersion: PINNED_NODE, nodeSha256: runtime.nodeSha256,
              packageManagerPath: trust.packageManagerPath, packageManagerSha256: trust.packageManagerSha256,
              packageManager: report.manifest.runtime.packageManager, ...dependencies, tree: relocated }
            await publishPreparedReleaseProof(report, trust, runtime, dependency, true)
          }
          return withTrustedDirectory(recordDirectory, async directoryPin => withTrustedFile(recordPath, { exactMode: 0o600, maxBytes: 16 * 1024 }, async recordPin => {
            const record = parseJson(recordPin.bytes)
            object(record, ['schemaVersion', 'kind', 'releaseRoot', 'version', 'archiveSha256', 'manifestSha256', 'sourceFilesDigest', 'treeSha256',
              'controlDbSchemaVersion', 'dependencyReceiptPath', 'dependencyReceiptSha256', 'runtime'], 'PREPARED_RELEASE_RECEIPT_INVALID')
            check(record.schemaVersion === 1 && record.kind === 'xpanel-prepared-release' && record.releaseRoot === releaseRoot
              && record.version === report.manifest.version && record.archiveSha256 === report.archiveSha256 && record.manifestSha256 === report.manifestSha256
              && record.sourceFilesDigest === digest(JSON.stringify(report.manifest.files)) && SHA.test(record.treeSha256)
              && record.controlDbSchemaVersion === report.manifest.controlDbSchemaVersion && record.dependencyReceiptPath === dependencyReceiptPath
              && SHA.test(record.dependencyReceiptSha256), 'PREPARED_RELEASE_RECEIPT_CHANGED')
            object(record.runtime, ['nodePath', 'nodeSha256', 'nodeVersion', 'packageManagerPath', 'packageManagerSha256'], 'PREPARED_RELEASE_RUNTIME_INVALID')
            check(record.runtime.nodePath === runtime.nodePath && record.runtime.nodeSha256 === runtime.nodeSha256 && record.runtime.nodeVersion === PINNED_NODE
              && record.runtime.packageManagerPath === trust.packageManagerPath && record.runtime.packageManagerSha256 === trust.packageManagerSha256, 'PREPARED_RELEASE_RUNTIME_CHANGED')
            return withTrustedFile(dependencyReceiptPath, { exactMode: 0o600, maxBytes: 16 * 1024, sha256: record.dependencyReceiptSha256 }, async dependencyPin => {
              const dependency = parseJson(dependencyPin.bytes)
              check(dependency.schemaVersion === 1 && dependency.kind === 'xpanel-installed-dependencies' && dependency.root === releaseRoot
                && dependency.archiveSha256 === report.archiveSha256 && dependency.manifestSha256 === report.manifestSha256
                && dependency.controlDbSchemaVersion === report.manifest.controlDbSchemaVersion && dependency.lockfileSha256 === report.manifest.lockfileSha256
                && dependency.tree?.treeSha256 === record.treeSha256 && dependency.nodePath === runtime.nodePath && dependency.nodeSha256 === runtime.nodeSha256
                && dependency.nodeVersion === PINNED_NODE && dependency.packageManager === report.manifest.runtime.packageManager
                && dependency.packageManagerPath === trust.packageManagerPath && dependency.packageManagerSha256 === trust.packageManagerSha256,
                'PREPARED_RELEASE_DEPENDENCY_CHANGED')
              return withTrustedDirectory(helperRoot, async helperPin => withTrustedDirectory(releaseRoot, async sourcePin => {
                const capability = Object.freeze(Object.create(null)), scope = { capability, helperRoot, helperReport, helperTreeSha256: helperTree.treeSha256, pid: process.pid, live: true, parent: parentScope, artifactPath: options.artifactPath, info: record, report, recordPath,
                  recordSha256: recordPin.sha256, pins: [...pins, directoryPin, recordPin, dependencyPin, sourcePin, helperPin] }
                preparedScopes.set(capability, scope)
                try { return await preparedActive.run(scope, async () => { await assertPreparedReleaseCurrent(capability); const value = await callback(capability); await assertPreparedReleaseCurrent(capability); return value }) }
                finally { scope.live = false; preparedScopes.delete(capability) }
              }))
            })
          }))
        })
        return archive.value
      })
    })
  })
  return held
}

/** Publish managed-writer admission only from the actual initialized strict database origin. */
export async function establishInstallAdmission() {
  const runtime = await nativeContext()
  const bootstrap = await preparedBootstrap(runtime)
  check(!await exists(LIFECYCLE + '/writer.lock'), 'INSTALL_ADMISSION_ALREADY_ESTABLISHED')
  for (const unit of ['xpanel-api.service', 'xpanel-agent.service']) {
    const state = await command('/usr/bin/systemctl', ['show', unit, '--property=MainPID,ControlPID,ActiveState'])
    check(/^MainPID=0$/m.test(state.text) && /^ControlPID=0$/m.test(state.text) && /^ActiveState=(?:inactive|failed)$/m.test(state.text), 'INSTALL_WRITERS_ACTIVE')
  }
  const user = await command('/usr/bin/id', ['-u', 'xpanel']), group = await command('/usr/bin/id', ['-g', 'xpanel'])
  check(/^[1-9][0-9]*\n?$/.test(user.text) && /^[1-9][0-9]*\n?$/.test(group.text), 'INSTALL_PANEL_IDENTITY_INVALID')
  const pin = await open(DATABASE, constants.O_RDONLY | constants.O_NOFOLLOW)
  let db
  try {
    const before = await pin.stat({ bigint: true })
    check(before.isFile() && before.nlink === 1n && before.uid === BigInt(user.text.trim()) && before.gid === BigInt(group.text.trim()) && (before.mode & 0o7777n) === 0o660n, 'INSTALL_DATABASE_UNSAFE')
    const database = await import('../packages/db/src/index.ts')
    db = database.createDb(DATABASE, { durability: 'strict' })
    const origin = await db.db.transaction(async tx => database.getStrictOperationDatabaseOrigin(tx))
    check(origin.file === DATABASE && origin.device === String(before.dev) && origin.inode === String(before.ino)
      && typeof origin.issuerId === 'string' && /^[0-9a-f-]{36}$/.test(origin.issuerId), 'INSTALL_DATABASE_CHANGED')
    await db.close(); db = undefined
    const after = await lstat(DATABASE, { bigint: true })
    check(before.dev === after.dev && before.ino === after.ino && before.uid === after.uid && before.gid === after.gid && before.mode === after.mode, 'INSTALL_DATABASE_CHANGED')
    const fingerprint = digest(JSON.stringify({ source: bootstrap.archiveSha256, manifest: bootstrap.manifestSha256, origin }))
    const headPath = LIFECYCLE + '/HEAD'
    if (await exists(headPath)) {
      const head = parseJson((await readTrustedFile(headPath, { exactMode: 0o600, maxBytes: 16384 })).bytes)
      check(head.schemaVersion === 1 && head.issuerId === origin.issuerId && head.sequence === 0 && head.phase === 'idle' && head.kind === 'adopt' && head.reference === null && head.requestFingerprint === fingerprint, 'INSTALL_HEAD_ALREADY_USED')
    } else await writeNewJson(headPath, { schemaVersion: 1, issuerId: origin.issuerId, sequence: 0, phase: 'idle', operationId: randomUUID(), reference: null, kind: 'adopt', requestFingerprint: fingerprint, updatedAt: new Date().toISOString() })
    const lock = LIFECYCLE + '/writer.lock'
    if (await exists(lock)) await withTrustedFile(lock, { exactMode: 0o644, maxBytes: 0 }, async () => {})
    else await writeNew(lock, Buffer.alloc(0), 0o644)
    await replaceBootstrap({ ...bootstrap, status: 'admission_ready' })
    return freeze({ status: 'admission_ready', version: bootstrap.version, releaseRoot: bootstrap.releaseRoot, installationReceipt: 'pending' })
  } finally { if (db) await db.close(); await pin.close() }
}

const OWNED_PATHS = Object.freeze(['/usr/local/bin/xpanel-ctl', '/opt/xpanel/bin/xpanel-ctl', ...OWNED_PANEL_UNITS.map(unit => '/etc/systemd/system/' + unit),
  '/etc/systemd/system/multi-user.target.wants/xpanel-api.service', '/etc/systemd/system/multi-user.target.wants/xpanel-agent.service', '/etc/systemd/system/timers.target.wants/xpanel-management-tls.timer',
  '/etc/nginx/conf.d/xpanel-management.conf', '/etc/nginx/conf.d/xpanel-management-challenge.conf', '/etc/nginx/xpanel-management/ingress-secret.conf'])

/** Capture is observation, not activation: every mandatory owned file must actually exist. */
export async function captureInstallOwnership() {
  const runtime = await nativeContext(), bootstrap = await preparedBootstrap(runtime), files = []
  check(bootstrap.status === 'admission_ready' || bootstrap.status === 'bootstrap_pending', 'INSTALL_ADMISSION_REQUIRED')
  for (const path of OWNED_PATHS) check(await exists(path), 'INSTALL_OWNERSHIP_PREREQUISITES_MISSING')
  for (const path of OWNED_PATHS) {
    await assertTrustedDirectory(dirname(path))
    const info = await lstat(path, { bigint: true })
    check(info.uid === 0n && info.gid === 0n, 'INSTALL_OWNERSHIP_UNSAFE')
    if (info.isSymbolicLink()) files.push({ path, kind: 'symlink', device: String(info.dev), inode: String(info.ino), size: Number(info.size), mode: Number(info.mode & 0o7777n), sha256: null, target: await readlink(path) })
    else {
      const held = await readTrustedFile(path, { maxBytes: 1024 * 1024 })
      check(info.dev === held.info.dev && info.ino === held.info.ino, 'INSTALL_OWNERSHIP_CHANGED')
      files.push({ path, kind: 'file', device: String(info.dev), inode: String(info.ino), size: Number(info.size), mode: Number(info.mode & 0o7777n), sha256: held.sha256, target: null })
    }
  }
  const systemctl = await readTrustedFile('/usr/bin/systemctl', { maxBytes: 16 * 1024 * 1024 }), nginx = await readTrustedFile('/usr/sbin/nginx', { maxBytes: 16 * 1024 * 1024 })
  const receipt = parseInstallationReceipt({ schemaVersion: 1, product: 'xpanel', status: 'bootstrap_pending', officialReference: null, lastLifecycleReference: null, createdAt: new Date().toISOString(),
    source: { root: INSTALL_ROOT, version: bootstrap.version, archiveSha256: bootstrap.archiveSha256, manifestSha256: bootstrap.manifestSha256, dependencyReceiptSha256: bootstrap.dependencyReceiptSha256, controlDbSchemaVersion: bootstrap.controlDbSchemaVersion },
    runtime: { nodePath: runtime.nodePath, nodeVersion: PINNED_NODE, nodeSha256: runtime.nodeSha256, systemctlSha256: systemctl.sha256, nginxSha256: nginx.sha256 }, writerProtocol: 'lifecycle-admission-v1', units: [...OWNED_PANEL_UNITS], files })
  for (const entry of receipt.files) await assertOwnedFile(entry)
  const path = LIFECYCLE + '/installation.json'
  if (await exists(path)) {
    const old = parseInstallationReceipt(parseJson((await readTrustedFile(path, { exactMode: 0o600, maxBytes: 64 * 1024 })).bytes))
    check(old.status === 'bootstrap_pending' && JSON.stringify({ ...old, createdAt: null }) === JSON.stringify({ ...receipt, createdAt: null }), 'INSTALL_RECEIPT_EXISTS')
  } else await writeNewJson(path, receipt)
  await replaceBootstrap({ ...bootstrap, status: 'bootstrap_pending' })
  return freeze({ status: 'bootstrap_pending', version: bootstrap.version, releaseRoot: bootstrap.releaseRoot, installationReceipt: 'captured', active: false })
}

export async function runBootstrapCli(argv, streams = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const options = parseBootstrapArgs(argv)
    const result = options.phase === 'plan' ? { status: 'plan', existingInstallations: 'refused', nativeExecution: 'not_run', installationReceipt: 'pending' }
      : options.phase === 'verify' ? await verifyNewInstallation(options)
        : options.phase === 'resume' ? await resumePreparedInstallation(options)
          : options.phase === 'prepare' ? await prepareNewInstallation(options)
        : options.phase === 'admission' ? await establishInstallAdmission() : await captureInstallOwnership()
    streams.stdout.write(JSON.stringify(result) + '\n'); return 0
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'INSTALL_PREREQUISITES_UNAVAILABLE'
    streams.stderr.write(JSON.stringify({ status: 'blocked', code, active: false, preservePreparedState: true }) + '\n'); return 3
  }
}
if (import.meta.main) process.exitCode = await runBootstrapCli(process.argv.slice(2))
