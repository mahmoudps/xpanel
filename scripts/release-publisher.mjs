import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const SHA = /^[a-f0-9]{64}$/
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const hash = value => createHash('sha256').update(value).digest('hex')
const refuse = code => { const error = new Error(code); error.code = code; throw error }

/** Same wire bytes as the native upgrade consumer. `bytes` is the unpacked inventory total. */
export function publisherPayload(release) {
  if (!release || typeof release !== 'object' || Array.isArray(release)
    || typeof release.version !== 'string' || !VERSION.test(release.version)
    || typeof release.sha256 !== 'string' || !SHA.test(release.sha256)
    || !Number.isSafeInteger(release.schemaVersion) || release.schemaVersion < 1
    || !Number.isSafeInteger(release.bytes) || release.bytes < 1) refuse('PUBLISHER_RELEASE_INVALID')
  return Buffer.from(`xpanel-release-v1:${release.version}:${release.schemaVersion}:${release.sha256}:${release.bytes}`, 'utf8')
}

/** Publisher authentication is additional to, never a replacement for, archive HMAC authentication. */
export function createPublisherManifest(release, options) {
  const payload = publisherPayload(release)
  if (!options || typeof options.keyId !== 'string' || !KEY_ID.test(options.keyId)) refuse('PUBLISHER_KEY_INVALID')
  let key
  try { key = options.privateKey?.type === 'private' ? options.privateKey : createPrivateKey(options.privateKey) }
  catch { return refuse('PUBLISHER_KEY_INVALID') }
  if (key.asymmetricKeyType !== 'ed25519') refuse('PUBLISHER_KEY_INVALID')
  const signature = sign(null, payload, key).toString('hex')
  if (!verify(null, payload, createPublicKey(key), Buffer.from(signature, 'hex'))) refuse('PUBLISHER_SIGNATURE_INVALID')
  return Object.freeze({
    version: release.version, schemaVersion: release.schemaVersion, sha256: release.sha256,
    bytes: release.bytes, keyId: options.keyId, signature,
  })
}

export function publisherManifestPath(archivePath) {
  if (typeof archivePath !== 'string' || !archivePath.endsWith('.tar.gz')) refuse('PUBLISHER_ARCHIVE_PATH_INVALID')
  return archivePath.slice(0, -'.tar.gz'.length) + '.manifest.json'
}

/** A competing producer must never replace an archive already paired with a signature. */
export function writePublisherOutput(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
}

/** Explicitly named digest domain; it must not be confused with a full-checkout evidence fingerprint. */
export function releaseInputFingerprint(entries) {
  if (!Array.isArray(entries) || !entries.length) refuse('SOURCE_INPUTS_INVALID')
  const seen = new Set()
  const rows = entries.map(entry => {
    if (!entry || typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\')
      || entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '.' || part === '..')
      || /[\u0000-\u001f\u007f:]/.test(entry.path) || seen.has(entry.path) || !SHA.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) refuse('SOURCE_INPUTS_INVALID')
    seen.add(entry.path)
    return { path: entry.path, sha256: entry.sha256, bytes: entry.bytes }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return hash('xpanel-release-inputs-v1\0' + JSON.stringify(rows))
}

const gitIdentity = root => {
  const git = args => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
    return result.status === 0 ? result.stdout.trim() : null
  }
  // An exported source directory must not accidentally inherit a parent repository's identity.
  const top = git(['rev-parse', '--show-toplevel'])
  if (top === null || resolve(top) !== resolve(root)) return { commit: null, tree: null, dirty: null }
  const commit = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']), changes = git(['status', '--porcelain=v1', '--untracked-files=all'])
  if (!/^[a-f0-9]{40,64}$/.test(commit ?? '') || !/^[a-f0-9]{40,64}$/.test(tree ?? '') || changes === null) refuse('SOURCE_IDENTITY_UNAVAILABLE')
  return { commit, tree, dirty: changes.length > 0 }
}

const sourceBytes = (root, path) => {
  releaseInputFingerprint([{ path, sha256: '0'.repeat(64), bytes: 0 }])
  const file = resolve(root, path), inside = relative(realpathSync(root), realpathSync(file))
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\')
    || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) refuse('SOURCE_INPUTS_INVALID')
  return readFileSync(file)
}

/** No timestamp or output digest enters source provenance: deterministic and free of self-reference. */
export function captureReleaseSource(root, paths, { requireClean = false } = {}) {
  const identity = gitIdentity(root)
  if (requireClean && (identity.commit === null || identity.dirty !== false)) refuse('PUBLISHER_CLEAN_SOURCE_REQUIRED')
  const inputs = new Map()
  const entries = paths.map(path => {
    const bytes = sourceBytes(root, path)
    inputs.set(path, bytes)
    return { path, sha256: hash(bytes), bytes: bytes.length }
  })
  const source = Object.freeze({
    schemaVersion: 1,
    fingerprintAlgorithm: 'sha256-release-inputs-v1',
    inputFingerprint: releaseInputFingerprint(entries),
    inputFiles: entries.length,
    ...identity,
  })
  return { source, readInput(path) {
    if (!inputs.has(path)) refuse('SOURCE_INPUTS_INVALID')
    return Buffer.from(inputs.get(path))
  }, assertUnchanged() {
    const after = gitIdentity(root)
    if (JSON.stringify(after) !== JSON.stringify(identity)) refuse('SOURCE_CHANGED_DURING_BUILD')
    const current = paths.map(path => { const bytes = sourceBytes(root, path); return { path, sha256: hash(bytes), bytes: bytes.length } })
    if (releaseInputFingerprint(current) !== source.inputFingerprint) refuse('SOURCE_CHANGED_DURING_BUILD')
  } }
}
