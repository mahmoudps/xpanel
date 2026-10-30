import { spawn } from 'node:child_process'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, symlink } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withAuthenticatedReleaseArchive, stageAuthenticatedReleaseArchive } from './release-verifier.mjs'
import { assertOwnedFile, assertTrustedDirectory, OWNED_PANEL_UNITS, parseInstallationReceipt, readTrustedFile, requireLinuxRoot, withTrustedDirectory, withTrustedFile } from './lifecycle-ownership.mjs'

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
  check(['plan', 'prepare', 'admission', 'capture'].includes(phase), 'INSTALL_PHASE_INVALID')
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

const ABI_PROBE = `import {argon2} from 'node:crypto';import {promisify} from 'node:util';import {DatabaseSync} from 'node:sqlite';import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';
const a=await promisify(argon2)('argon2id',{message:Buffer.from('install-abi-probe'),nonce:Buffer.alloc(16,7),parallelism:1,tagLength:32,memory:65536,passes:1});if(a.length!==32)process.exit(1);
const d=new DatabaseSync(':memory:');if(d.prepare('SELECT 1 AS value').get().value!==1)process.exit(1);d.close();
const sbom=JSON.parse(readFileSync('sbom-provenance.json','utf8'));const workspace=new Set(sbom.workspacePackages.map(x=>x.name));for(const p of sbom.workspacePackages){const require=createRequire(process.cwd()+'/'+p.path+'/package.json');for(const dep of p.dependencies)if(!workspace.has(dep.name))require(dep.name);}process.stdout.write('INSTALL_ABI_OK\\n');`

async function verifyDependencies(root, report, trust, runtime) {
  const manager = await command(trust.packageManagerPath, ['--version'], { sha256: trust.packageManagerSha256 })
  check(manager.text.trim() === report.manifest.runtime.packageManager.split('@').at(-1), 'INSTALL_PACKAGE_MANAGER_MISMATCH')
  const install = await command(trust.packageManagerPath, ['install', '--offline', '--frozen-lockfile', '--prod', '--ignore-scripts', '--verify-store-integrity'], { cwd: root, sha256: trust.packageManagerSha256 })
  check(digest(await readFile(join(root, 'pnpm-lock.yaml'))) === report.manifest.lockfileSha256, 'INSTALL_LOCKFILE_CHANGED')
  check(await exists(join(root, 'node_modules')), 'INSTALL_DEPENDENCIES_MISSING')
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

/** Fresh-host only. Actual extraction, dependency effects and publication are never injectable. */
export async function prepareNewInstallation(input) {
  check(input && typeof input === 'object' && !Array.isArray(input)
    && Reflect.ownKeys(input).every(key => ['phase', 'artifactPath', 'artifactSha256', 'trustPath', 'keysPath'].includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))
    && (input.phase === undefined || input.phase === 'prepare'), 'INSTALL_OPTIONS_INVALID')
  const options = parseBootstrapArgs(['prepare', `--artifact=${input?.artifactPath}`, `--artifact-sha256=${input?.artifactSha256}`, `--release-trust-file=${input?.trustPath}`, `--release-keys-file=${input?.keysPath}`])
  const runtime = await nativeContext()
  process.umask(0o022)
  for (const path of [INSTALL_ROOT, DATABASE, DATABASE + '-wal', DATABASE + '-shm', LIFECYCLE]) check(!await exists(path), 'INSTALL_EXISTING_HOST_REFUSED')
  for (const path of OWNED_PATHS) check(!await exists(path), 'INSTALL_EXISTING_CONTROL_PLANE_REFUSED')
  if (await exists('/var/lib/xpanel/state')) {
    await assertTrustedDirectory('/var/lib/xpanel/state')
    check((await readdir('/var/lib/xpanel/state')).length === 0, 'INSTALL_EXISTING_STATE_REFUSED')
  }
  await assertTrustedDirectory('/opt'); await assertTrustedDirectory('/var/lib')
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
async function preparedBootstrap(runtime) {
  const actual = await readTrustedFile(BOOTSTRAP_PATH, { exactMode: 0o600, maxBytes: 16 * 1024 }), value = parseJson(actual.bytes)
  check(value?.schemaVersion === 1 && ['prepared', 'admission_ready', 'bootstrap_pending'].includes(value.status) && VERSION.test(value.version)
    && value.releaseRoot === INSTALL_ROOT + '/releases/' + value.version && [value.archiveSha256, value.manifestSha256, value.dependencyReceiptSha256].every(item => typeof item === 'string' && SHA.test(item)), 'INSTALL_BOOTSTRAP_INVALID')
  check(await readlink(CURRENT) === value.releaseRoot && await realpath(CURRENT) === value.releaseRoot, 'INSTALL_CURRENT_CHANGED')
  check(await realpath(fileURLToPath(import.meta.url)) === join(value.releaseRoot, 'scripts/install-bootstrap.mjs'), 'INSTALL_HELPER_SOURCE_MISMATCH')
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
      : options.phase === 'prepare' ? await prepareNewInstallation(options)
        : options.phase === 'admission' ? await establishInstallAdmission() : await captureInstallOwnership()
    streams.stdout.write(JSON.stringify(result) + '\n'); return 0
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'INSTALL_PREREQUISITES_UNAVAILABLE'
    streams.stderr.write(JSON.stringify({ status: 'blocked', code, active: false, preservePreparedState: true }) + '\n'); return 3
  }
}
if (import.meta.main) process.exitCode = await runBootstrapCli(process.argv.slice(2))
