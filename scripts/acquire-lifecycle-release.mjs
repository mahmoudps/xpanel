#!/usr/bin/node
// The acquisition entry imports only Node builtins until it has checked the installed root-owned source.
// New archive modules are never imported before the existing installation authenticates and extracts them.
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { registerHooks, isBuiltin } from 'node:module'
import { pathToFileURL } from 'node:url'
import { posix } from 'node:path'

const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const image = stat => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':')
const directoryImage = stat => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].map(String).join(':')
const decoder = new TextDecoder('utf-8', { fatal: true })
const parse = bytes => JSON.parse(decoder.decode(bytes))

// A bootstrap reader, deliberately builtin-only. Protected metadata anchors the installed source inventory;
// no installed module is imported just because its filename or owner looks correct.
async function withInstalledSourceInventory(root, callback) {
  const directories = new Map(), files = new Map()
  const directory = async path => {
    if (directories.has(path)) return
    if (path !== '/') await directory(posix.dirname(path))
    check(directories.size < 1024, 'PREPARED_ACQUISITION_DIRECTORY_LIMIT')
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true })
      check(info.isDirectory() && !named.isSymbolicLink() && info.uid === 0n && info.gid === 0n && (info.mode & 0o022n) === 0n
        && directoryImage(info) === directoryImage(named), 'PREPARED_ACQUISITION_SOURCE_DIRECTORY_CHANGED')
      directories.set(path, { handle, info })
    } catch (error) { await handle.close(); throw error }
  }
  const file = async (path, maxBytes, expected, mode, retain = false) => {
    await directory(posix.dirname(path))
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let retained = false
    try {
      const info = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true })
      check(info.isFile() && !named.isSymbolicLink() && info.uid === 0n && info.gid === 0n && info.nlink === 1n && (info.mode & 0o6022n) === 0n
        && info.size >= 0n && info.size <= BigInt(maxBytes) && image(info) === image(named)
        && (mode === undefined || Number(info.mode & 0o7777n) === mode), 'PREPARED_ACQUISITION_SOURCE_FILE_CHANGED')
      const bytes = await handle.readFile(), digest = sha(bytes)
      check(bytes.length === Number(info.size) && (expected === undefined || digest === expected)
        && image(info) === image(await handle.stat({ bigint: true })) && image(info) === image(await lstat(path, { bigint: true })), 'PREPARED_ACQUISITION_SOURCE_HASH_CHANGED')
      check(!files.has(path) || files.get(path).sha256 === digest, 'PREPARED_ACQUISITION_SOURCE_HASH_CHANGED')
      if (retain) { retained = true; files.set(path, { info, sha256: digest, handle }) }
      else if (!files.has(path)) files.set(path, { info, sha256: digest })
      return { bytes, sha256: digest }
    } finally { if (!retained) await handle.close() }
  }
  const verify = async () => {
    for (const [path, pin] of directories) {
      const named = await lstat(path, { bigint: true })
      check(!named.isSymbolicLink() && directoryImage(pin.info) === directoryImage(named)
        && directoryImage(pin.info) === directoryImage(await pin.handle.stat({ bigint: true })), 'PREPARED_ACQUISITION_SOURCE_DIRECTORY_CHANGED')
    }
    for (const [path, pin] of files) {
      const named = await lstat(path, { bigint: true })
      check(!named.isSymbolicLink() && image(pin.info) === image(named)
        && (!pin.handle || image(pin.info) === image(await pin.handle.stat({ bigint: true }))), 'PREPARED_ACQUISITION_SOURCE_FILE_CHANGED')
    }
    const link = await lstat('/opt/xpanel/current', { bigint: true })
    check(image(link) === currentImage && await readlink('/opt/xpanel/current') === root && await realpath('/opt/xpanel/current') === root, 'PREPARED_ACQUISITION_CURRENT_CHANGED')
  }
  let currentImage
  try {
    const link = await lstat('/opt/xpanel/current', { bigint: true }); currentImage = image(link)
    check(link.isSymbolicLink() && link.uid === 0n && link.gid === 0n && await readlink('/opt/xpanel/current') === root, 'PREPARED_ACQUISITION_CURRENT_CHANGED')
    const bootstrap = parse((await file('/var/lib/xpanel-lifecycle/bootstrap.json', 16 * 1024, undefined, 0o600, true)).bytes)
    check(bootstrap.schemaVersion === 1 && ['bootstrap_pending', 'active'].includes(bootstrap.status) && bootstrap.releaseRoot === root
      && root === '/opt/xpanel/releases/' + bootstrap.version && [bootstrap.archiveSha256, bootstrap.manifestSha256, bootstrap.dependencyReceiptSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), 'PREPARED_ACQUISITION_SOURCE_METADATA_INVALID')
    const receipt = parse((await file('/var/lib/xpanel-lifecycle/installation.json', 64 * 1024, undefined, 0o600, true)).bytes)
    check(receipt.schemaVersion === 1 && receipt.product === 'xpanel' && receipt.status === bootstrap.status
      && ['version', 'archiveSha256', 'manifestSha256', 'dependencyReceiptSha256', 'controlDbSchemaVersion'].every(key => receipt.source?.[key] === bootstrap[key]), 'PREPARED_ACQUISITION_SOURCE_METADATA_INVALID')
    const dependency = parse((await file('/var/lib/xpanel-lifecycle/install-dependencies.json', 16 * 1024, bootstrap.dependencyReceiptSha256, 0o600, true)).bytes)
    check(dependency.schemaVersion === 1 && dependency.kind === 'xpanel-installed-dependencies' && dependency.root === root
      && dependency.archiveSha256 === bootstrap.archiveSha256 && dependency.manifestSha256 === bootstrap.manifestSha256, 'PREPARED_ACQUISITION_SOURCE_METADATA_INVALID')
    const manifest = parse((await file(root + '/release-manifest.json', 16 * 1024 * 1024, bootstrap.manifestSha256, undefined, true)).bytes)
    check(manifest.version === bootstrap.version && manifest.controlDbSchemaVersion === bootstrap.controlDbSchemaVersion
      && Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 20000, 'PREPARED_ACQUISITION_SOURCE_MANIFEST_INVALID')
    const seen = new Set(), retained = new Set(['scripts/lifecycle-ownership.mjs', 'scripts/install-bootstrap.mjs', 'scripts/release-verifier.mjs'])
    let total = 0
    for (const entry of manifest.files) {
      check(entry && typeof entry.path === 'string' && /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/.test(entry.path)
        && !entry.path.split('/').some(part => part === '.' || part === '..') && !seen.has(entry.path.toLowerCase())
        && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= 64 * 1024 * 1024
        && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isInteger(entry.mode) && (entry.mode & 0o6022) === 0,
      'PREPARED_ACQUISITION_SOURCE_MANIFEST_INVALID')
      seen.add(entry.path.toLowerCase()); total += entry.bytes
      check(total <= 512 * 1024 * 1024, 'PREPARED_ACQUISITION_SOURCE_MANIFEST_INVALID')
      await file(root + '/' + entry.path, entry.bytes, entry.sha256, entry.mode, retained.has(entry.path))
      check(files.get(root + '/' + entry.path).info.size === BigInt(entry.bytes), 'PREPARED_ACQUISITION_SOURCE_SIZE_CHANGED')
    }
    check([...retained].every(path => seen.has(path)), 'PREPARED_ACQUISITION_SOURCE_CONTROLS_MISSING')
    const nodePath = await realpath(process.execPath)
    check(nodePath === bootstrap.runtime?.nodePath && receipt.runtime?.nodePath === nodePath && receipt.runtime?.nodeSha256 === bootstrap.runtime.nodeSha256
      && dependency.nodePath === nodePath && dependency.nodeSha256 === bootstrap.runtime.nodeSha256 && await readlink('/proc/self/exe') === nodePath,
    'PREPARED_ACQUISITION_RUNTIME_CHANGED')
    await file(nodePath, 256 * 1024 * 1024, bootstrap.runtime.nodeSha256, undefined, true)
    await verify()
    const load = async name => {
      check(retained.has('scripts/' + name), 'PREPARED_ACQUISITION_INSTALLED_MODULE_INVALID')
      await verify(); return import(pathToFileURL(root + '/scripts/' + name).href)
    }
    const value = await callback({ load, verify, root }); await verify(); return value
  } finally {
    for (const pin of [...files.values()].reverse()) if (pin.handle) await pin.handle.close()
    for (const pin of [...directories.values()].reverse()) await pin.handle.close()
  }
}

const resolutionScope = new AsyncLocalStorage()
/** Authenticated source resolution, not a sandbox for untrusted code. No dependency install or links. */
async function withAuthenticatedWorkspaceResolution(root, manifest, callback) {
  check(!resolutionScope.getStore(), 'PREPARED_ACQUISITION_RESOLUTION_NESTED')
  const prefix = pathToFileURL(root + '/').href
  const inventory = new Set(manifest.files.map(entry => pathToFileURL(root + '/' + entry.path).href))
  const aliases = Object.freeze({ '@xpanel/core': prefix + 'packages/core/src/index.ts', '@xpanel/state': prefix + 'packages/state/src/index.ts' })
  const entrypoints = new Set([prefix + 'scripts/install-bootstrap.mjs', prefix + 'scripts/prepared-release.mjs'])
  const scope = Object.freeze({})
  let live = true
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    const parentInside = typeof context.parentURL === 'string' && context.parentURL.startsWith(prefix)
    if (parentInside) {
      check(live && resolutionScope.getStore() === scope && inventory.has(context.parentURL), 'PREPARED_ACQUISITION_RESOLUTION_SCOPE_REQUIRED')
      if (specifier.startsWith('node:') && isBuiltin(specifier)) return nextResolve(specifier, context)
      if (Object.hasOwn(aliases, specifier)) {
        check(inventory.has(aliases[specifier]), 'PREPARED_ACQUISITION_IMPORT_OUTSIDE_SOURCE')
        return { url: aliases[specifier], shortCircuit: true }
      }
      check(specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:'), 'PREPARED_ACQUISITION_IMPORT_OUTSIDE_SOURCE')
      const resolved = nextResolve(specifier, context)
      check(inventory.has(resolved.url), 'PREPARED_ACQUISITION_IMPORT_OUTSIDE_SOURCE')
      return resolved
    }
    const resolved = nextResolve(specifier, context)
    if (resolved.url.startsWith(prefix)) check(live && resolutionScope.getStore() === scope && entrypoints.has(resolved.url), 'PREPARED_ACQUISITION_RESOLUTION_SCOPE_REQUIRED')
    return resolved
  } })
  try { return await resolutionScope.run(scope, callback) }
  finally { live = false; hooks.deregister() }
}

export async function acquireLifecycleRelease(input) {
  check(process.platform === 'linux' && process.getuid?.() === 0 && process.geteuid?.() === 0
    && process.version === 'v26.12.1' && !process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'PREPARED_ACQUISITION_RUNTIME_REQUIRED')
  check(input && typeof input === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(input))
    && Reflect.ownKeys(input).length === 2 && Reflect.ownKeys(input).every(key => ['artifactPath', 'expectedArchiveSha256'].includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value')), 'PREPARED_ACQUISITION_INPUT_INVALID')
  check(typeof input.artifactPath === 'string' && input.artifactPath.length <= 4096 && posix.isAbsolute(input.artifactPath)
    && posix.normalize(input.artifactPath) === input.artifactPath && input.artifactPath.endsWith('.tar.gz')
    && !/[\x00-\x20\x7f]/.test(input.artifactPath) && !/^\/(?:home(?:[0-9]+)?|tmp|var\/tmp)(?:\/|$)/.test(input.artifactPath)
    && typeof input.expectedArchiveSha256 === 'string' && /^[a-f0-9]{64}$/.test(input.expectedArchiveSha256), 'PREPARED_ACQUISITION_INPUT_INVALID')
  const link = await lstat('/opt/xpanel/current', { bigint: true }), root = await readlink('/opt/xpanel/current')
  check(link.isSymbolicLink() && link.uid === 0n && link.gid === 0n && /^\/opt\/xpanel\/releases\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(root)
    && await realpath('/opt/xpanel/current') === root, 'PREPARED_ACQUISITION_CURRENT_INVALID')
  for (const path of ['/', '/opt', '/opt/xpanel', '/opt/xpanel/releases', root, root + '/scripts']) {
    const info = await lstat(path, { bigint: true })
    check(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0n && info.gid === 0n && (info.mode & 0o022n) === 0n, 'PREPARED_ACQUISITION_INSTALLED_SOURCE_UNSAFE')
  }
  return withInstalledSourceInventory(root, async installedSource => {
  const ownership = await installedSource.load('lifecycle-ownership.mjs')
  let effectsStarted = false
  try { return await ownership.withTrustedDirectory(root, async sourcePin => {
    const bootstrap = await installedSource.load('install-bootstrap.mjs')
    const verifier = await installedSource.load('release-verifier.mjs')
    return ownership.withTrustedFile('/etc/xpanel/release-trust.json', { exactMode: 0o600, maxBytes: 8192 }, async trustPin => {
      const trust = bootstrap.parseBootstrapTrust(JSON.parse(trustPin.bytes.toString('utf8')))
      check(trust.signingKeyPath === '/etc/xpanel/release-hmac.key', 'PREPARED_ACQUISITION_TRUST_CHANGED')
      return ownership.withTrustedFile(trust.signingKeyPath, { exactMode: 0o600, maxBytes: 4096 }, async keyPin =>
        ownership.withTrustedFile('/etc/xpanel/release-keys.json', { maxBytes: 16 * 1024 }, async keysPin =>
          ownership.withTrustedFile(input.artifactPath.slice(0, -7) + '.manifest.json', { maxBytes: 4096 }, async publisherPin => {
            const archiveTrust = { signingKey: keyPin.bytes, keyId: trust.keyId, expectedArchiveSha256: input.expectedArchiveSha256 }
            const verified = await verifier.withAuthenticatedReleaseArchive(input.artifactPath, archiveTrust, async ({ report }) => {
              bootstrap.verifyBootstrapPublisher(JSON.parse(publisherPin.bytes.toString('utf8')), report, bootstrap.parseBootstrapKeys(JSON.parse(keysPin.bytes.toString('utf8'))))
              check(report.manifest.files.some(entry => entry.path === 'scripts/prepared-release.mjs'), 'PREPARED_ACQUISITION_CONTROLS_REQUIRED')
              effectsStarted = true
              // Older installed verifiers apply file modes only at creation. This dedicated
              // acquisition process extracts public source inside a private 0700 stage;
              // restore its private mask before any new module or product operation runs.
              const previousMask = process.umask(0o022)
              let staged
              try {
                staged = await verifier.stageAuthenticatedReleaseArchive('/opt/xpanel/staging', { signingKey: keyPin.bytes, keyId: trust.keyId, authenticatedArchive: report })
              } finally { process.umask(previousMask) }
              await sourcePin.verify(); await trustPin.verify(); await keyPin.verify(); await keysPin.verify(); await publisherPin.verify()
              // The existing authenticated extractor has now verified every new source file before this import.
              const prepared = await withAuthenticatedWorkspaceResolution(staged.stagedAt, report.manifest, async () => {
                const observer = await import(pathToFileURL(staged.stagedAt + '/scripts/install-bootstrap.mjs').href)
                const installed = await observer.observeInstalledAcquisitionSource()
                check(installed.bootstrap.releaseRoot === root, 'PREPARED_ACQUISITION_INSTALLED_SOURCE_CHANGED')
                await installedSource.verify()
                const target = await import(pathToFileURL(staged.stagedAt + '/scripts/prepared-release.mjs').href)
                return target.withPreparedRelease(input, async capability => target.preparedReleaseInfo(capability))
              })
              await verifier.verifyAuthenticatedReleaseTree(staged.stagedAt, { signingKey: keyPin.bytes, keyId: trust.keyId, authenticatedArchive: report })
              await sourcePin.verify(); await trustPin.verify(); await keyPin.verify(); await keysPin.verify(); await publisherPin.verify()
              return prepared
            })
            return verified.value
          })))
    })
  }) } catch (error) {
    if (effectsStarted || error?.uncertain) throw Object.assign(new Error('PREPARED_ACQUISITION_ATTENTION'), { code: 'PREPARED_ACQUISITION_ATTENTION', uncertain: true })
    throw error
  }
  })
}

export async function runAcquireLifecycleRelease(argv, streams = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    check(Array.isArray(argv) && argv.length === 2 && argv[0]?.startsWith('--artifact=') && argv[1]?.startsWith('--sha256='), 'PREPARED_ACQUISITION_ARGUMENTS_INVALID')
    const prepared = await acquireLifecycleRelease({ artifactPath: argv[0].slice(11), expectedArchiveSha256: argv[1].slice(9) })
    streams.stdout.write(JSON.stringify({ status: 'prepared', version: prepared.version, archiveSha256: prepared.archiveSha256,
      releaseRoot: prepared.releaseRoot, installReady: false, nativeQualified: false }) + '\n')
    return 0
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'PREPARED_ACQUISITION_UNVERIFIED'
    const attention = error?.uncertain === true
    streams.stderr.write(JSON.stringify({ status: attention ? 'attention' : 'blocked', code, preservePreparedState: true, installReady: false }) + '\n')
    return attention ? 6 : 3
  }
}
if (import.meta.main) process.exitCode = await runAcquireLifecycleRelease(process.argv.slice(2))
