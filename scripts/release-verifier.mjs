import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open, lstat, mkdir, opendir, readlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'
import process from 'node:process'

// Builtin-only verification never executes payloads; explicit retained-FD staging extracts without activation.
export class ReleaseVerificationError extends Error {
  constructor(code, message, cause) { super(message, cause === undefined ? undefined : { cause }); this.name = 'ReleaseVerificationError'; this.code = code; if (code.includes('UNCERTAIN')) this.uncertain = true }
}
const refuse = (code, message) => { throw new ReleaseVerificationError(code, message) }
const hash = value => createHash('sha256').update(value).digest('hex')
const SHA = /^[a-f0-9]{64}$/
const EXACT_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/
const utf8 = new TextDecoder('utf-8', { fatal: true })
export const RELEASE_VERIFICATION_LIMITS = Object.freeze({
  compressedBytes: 256 * 1024 * 1024, tarBytes: 512 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024, manifestBytes: 16 * 1024 * 1024,
  metadataBytes: 4 * 1024 * 1024, members: 20_000, pathBytes: 255,
  depth: 32, jsonDepth: 64, jsonTokens: 1_000_000,
})
export const REQUIRED_RELEASE_ENTRYPOINTS = Object.freeze(['apps/api/src/main.ts', 'apps/agent/src/main.ts', 'apps/api/src/cli.ts', 'apps/web/src/index.ts'])
export const REQUIRED_SYSTEMD_UNITS = Object.freeze(['deploy/systemd/xpanel-agent.service', 'deploy/systemd/xpanel-api.service'])
export const REQUIRED_ROOT_FILES = Object.freeze(['.node-version', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'CLA.md', 'scripts/install.sh', 'scripts/management-tls.mjs', 'scripts/release-verifier.mjs', 'scripts/release-verifier.d.mts', 'helpers/account-files/build.mjs', 'helpers/account-files/xpanel-account-files.c'])
// Source-artifact authentication does not admit or qualify lifecycle controls.
export const REQUIRED_LIFECYCLE_CONTROL_FILES = Object.freeze(['scripts/xpanel-ctl.mjs', 'bin/xpanel-ctl', 'scripts/update.sh', 'scripts/upgrade.sh', 'scripts/uninstall.sh', 'scripts/lifecycle-runtime.mjs', 'scripts/lifecycle-ownership.mjs', 'scripts/lifecycle-admission.mjs', 'scripts/lifecycle-admission.d.mts', 'scripts/lifecycle-services.mjs', 'scripts/lifecycle-root-safety.mjs', 'scripts/lifecycle-root-safety.d.mts', 'scripts/release-verifier.mjs'])
export const DESIGN_REFERENCE_INPUTS = Object.freeze({ directories: Object.freeze(['apps/web/src/design-boards/']), files: Object.freeze(['apps/web/src/live-boards.ts']) })

/** Existing signed wire representation: insertion-order JSON, without key sorting. */
export const serializeManifestPayload = manifestCore => JSON.stringify(manifestCore)
/** Existing HMAC bytes. Trust-key selection/loading belongs to the caller. */
export const signManifestPayload = (canonicalJson, signingKey) => createHmac('sha256', signingKey).update(canonicalJson, 'utf8').digest('hex')
const freeze = value => { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, expected, label) => {
  if (!object(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) refuse('MANIFEST_INVALID', `${label} has invalid fields`)
}
const count = (value, max, label) => { if (!Number.isSafeInteger(value) || value < 0 || value > max) refuse('LIMIT', `${label} is out of bounds`); return value }
const digest = (value, label) => { if (typeof value !== 'string' || !SHA.test(value)) refuse('MANIFEST_INVALID', `${label} is not canonical SHA-256`); return value }
const safeMode = (mode, directory = false) => {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777 || (mode & 0o7022) !== 0 || (mode & (directory ? 0o500 : 0o400)) !== (directory ? 0o500 : 0o400)) refuse('UNSAFE_MODE', 'Release modes must be readable, non-writable by other users and without special bits')
  return mode
}
const safePath = (value, bounds) => {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > bounds.pathBytes || !/^[A-Za-z0-9._@+/-]+$/.test(value)) refuse('UNSAFE_PATH', 'Release path must be canonical relative ASCII POSIX')
  const parts = value.split('/')
  if (parts.length > bounds.depth || parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) refuse('UNSAFE_PATH', 'Release path is not canonical')
  if (parts.slice(0, -1).some(part => part.startsWith('.')) || parts.some(part => /^(?:\.git|\.secrets|\.tools|\.pnpm-store|\.env(?:\..*)?)$/i.test(part)))
    refuse('FORBIDDEN_FILE', 'Private or environment path cannot enter a release')
  if (/(?:^|\/)(?:agent\.token|server\.secret)$/i.test(value) || /\.(?:pem|key|p12|pfx|exe|dll|dylib)$/i.test(value)
    || /(?:win32-x64|win32-arm64|darwin-x64|darwin-arm64)/i.test(value)
    || DESIGN_REFERENCE_INPUTS.files.includes(value) || DESIGN_REFERENCE_INPUTS.directories.some(path => value === path.slice(0, -1) || value.startsWith(path))) refuse('FORBIDDEN_FILE', 'Non-runtime release path is forbidden')
  return value
}
const limits = supplied => {
  if (supplied === undefined) return RELEASE_VERIFICATION_LIMITS
  if (!object(supplied) || Object.keys(supplied).some(key => !Object.hasOwn(RELEASE_VERIFICATION_LIMITS, key))) refuse('OPTIONS', 'Unknown verification bound')
  const result = { ...RELEASE_VERIFICATION_LIMITS }
  for (const [key, value] of Object.entries(supplied)) { if (!Number.isSafeInteger(value) || value < 1 || value > result[key]) refuse('OPTIONS', 'Bounds can only reduce the hard protocol ceiling'); result[key] = value }
  return result
}
const optionsFor = (options, tree = false) => {
  if (!object(options) || Object.keys(options).some(key => !(tree ? ['authenticatedArchive', 'signingKey', 'keyId', 'bounds'] : ['expectedArchiveSha256', 'signingKey', 'keyId', 'bounds']).includes(key))) refuse('OPTIONS', 'Unknown verifier option')
  const key = typeof options.signingKey === 'string' ? Buffer.from(options.signingKey, 'utf8') : Buffer.isBuffer(options.signingKey) ? Buffer.from(options.signingKey) : null
  if (!key || key.length < 32 || key.length > 4096) refuse('TRUST_REQUIRED', 'A trusted HMAC key of 32-4096 bytes is required')
  if (typeof options.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.keyId)) refuse('TRUST_REQUIRED', 'An explicit trusted key ID is required')
  if (!tree && (typeof options.expectedArchiveSha256 !== 'string' || !SHA.test(options.expectedArchiveSha256))) refuse('TRUST_REQUIRED', 'An external canonical archive SHA-256 is mandatory')
  return { key, keyId: options.keyId, bounds: limits(options.bounds), expectedArchiveSha256: options.expectedArchiveSha256 }
}

// JSON.parse alone loses duplicate object keys. Bound depth/tokens and reject them first.
const parseJson = (bytes, bounds) => {
  let text
  try { text = utf8.decode(bytes) } catch { return refuse('MANIFEST_INVALID', 'JSON must be UTF-8') }
  const stack = []; let tokens = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) continue
    if (++tokens > bounds.jsonTokens) refuse('LIMIT', 'JSON token budget exceeded')
    if (ch === '"') {
      const start = i++
      for (; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      if (i === text.length) refuse('MANIFEST_INVALID', 'Unterminated JSON string')
      const scope = stack.at(-1)
      if (scope?.kind === '{' && scope.key) {
        let key; try { key = JSON.parse(text.slice(start, i + 1)) } catch { return refuse('MANIFEST_INVALID', 'Invalid JSON key') }
        if (scope.seen.has(key)) refuse('MANIFEST_INVALID', 'Duplicate JSON key')
        scope.seen.add(key); scope.key = false
      }
    } else if (ch === '{' || ch === '[') {
      if (stack.length >= bounds.jsonDepth) refuse('LIMIT', 'JSON nesting is too deep')
      stack.push({ kind: ch, key: ch === '{', seen: new Set() })
    } else if (ch === '}' || ch === ']') stack.pop()
    else if (ch === ',' && stack.at(-1)?.kind === '{') stack.at(-1).key = true
  }
  try { return JSON.parse(text) } catch { return refuse('MANIFEST_INVALID', 'Invalid JSON') }
}

const authenticateManifest = (bytes, trust) => {
  const { bounds } = trust
  if (bytes.length > bounds.manifestBytes) refuse('LIMIT', 'Manifest is too large')
  const manifest = parseJson(bytes, bounds)
  keys(manifest, ['schemaVersion', 'version', 'controlDbSchemaVersion', 'runtime', 'target', 'entrypoints', 'sourcePolicy', 'systemdUnits', 'migrations', 'webAssets', 'lockfileSha256', 'sbomSha256', 'totalUnpackedBytes', 'files', 'payloadSha256', 'signature'], 'release manifest')
  const { payloadSha256, signature, ...core } = manifest
  const canonical = serializeManifestPayload(core), actualPayload = hash(Buffer.from(canonical, 'utf8'))
  if (digest(payloadSha256, 'payload digest') !== actualPayload) refuse('SIGNATURE_INVALID', 'Manifest payload digest does not match')
  keys(signature, ['algorithm', 'keyId', 'payloadSha256', 'mac'], 'manifest signature')
  if (signature.algorithm !== 'hmac-sha256' || signature.keyId !== trust.keyId || signature.payloadSha256 !== actualPayload) refuse('SIGNATURE_INVALID', 'Manifest signature algorithm/key/payload does not match trusted policy')
  const mac = digest(signature.mac, 'signature MAC'), expected = signManifestPayload(canonical, trust.key)
  if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) refuse('SIGNATURE_INVALID', 'Manifest signature verification failed')
  if (manifest.schemaVersion !== 1 || typeof manifest.version !== 'string' || !VERSION.test(manifest.version) || manifest.version.length > 128) refuse('MANIFEST_INVALID', 'Unsupported release format or version')
  count(manifest.controlDbSchemaVersion, 9999, 'Control DB schema version')
  if (!manifest.controlDbSchemaVersion) refuse('MANIFEST_INVALID', 'Control DB schema version must be declared independently')
  keys(manifest.runtime, ['nodeVersion', 'packageManager', 'typescriptVersion', 'executionMode'], 'runtime')
  if (typeof manifest.runtime.nodeVersion !== 'string' || !EXACT_VERSION.test(manifest.runtime.nodeVersion) || typeof manifest.runtime.packageManager !== 'string' || !/^pnpm@\d+\.\d+\.\d+$/.test(manifest.runtime.packageManager) || typeof manifest.runtime.typescriptVersion !== 'string' || !EXACT_VERSION.test(manifest.runtime.typescriptVersion) || manifest.runtime.executionMode !== 'node-strip-types-source') refuse('MANIFEST_INVALID', 'Invalid pinned runtime declaration')
  keys(manifest.target, ['os', 'arch'], 'target')
  if (manifest.target.os !== 'linux' || manifest.target.arch !== 'x64') refuse('MANIFEST_INVALID', 'Unsupported release target')
  keys(manifest.entrypoints, ['api', 'agent', 'cli', 'web'], 'entrypoints')
  if (Object.values(manifest.entrypoints).some((path, i) => path !== REQUIRED_RELEASE_ENTRYPOINTS[i])) refuse('MANIFEST_INVALID', 'Entrypoint contract changed')
  keys(manifest.sourcePolicy, ['excludedDesignReferences', 'sourceClosure'], 'source policy')
  keys(manifest.sourcePolicy.excludedDesignReferences, ['directories', 'files'], 'design exclusions')
  if (JSON.stringify(manifest.sourcePolicy.excludedDesignReferences) !== JSON.stringify(DESIGN_REFERENCE_INPUTS)) refuse('MANIFEST_INVALID', 'Design exclusion contract changed')
  keys(manifest.sourcePolicy.sourceClosure, ['checkedSources', 'checkedImports'], 'source closure declaration')
  count(manifest.sourcePolicy.sourceClosure.checkedSources, bounds.members, 'Checked source count')
  count(manifest.sourcePolicy.sourceClosure.checkedImports, 10_000_000, 'Checked import count')
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length >= bounds.members) refuse('LIMIT', 'Invalid manifest file count')
  const files = new Map(), aliases = new Set(); let total = 0
  for (const file of manifest.files) {
    keys(file, ['path', 'sha256', 'bytes', 'mode', 'owner', 'group'], 'manifest file')
    const path = safePath(file.path, bounds), alias = path.toLowerCase()
    if (path === 'release-manifest.json' || files.has(path) || aliases.has(alias)) refuse('MANIFEST_INVALID', 'Duplicate or self-referential manifest path')
    if (file.owner !== 'root' || file.group !== 'root') refuse('UNSAFE_OWNER', 'Manifest files must be root-owned')
    safeMode(file.mode); digest(file.sha256, 'File digest'); count(file.bytes, bounds.fileBytes, 'File bytes')
    total += file.bytes; count(total, bounds.tarBytes, 'Payload bytes'); aliases.add(alias); files.set(path, file)
  }
  if (total !== manifest.totalUnpackedBytes) refuse('MANIFEST_INVALID', 'Unpacked byte total does not match the file inventory')
  if ([...files.keys()].filter(path => /\.(?:ts|js|mjs|cjs)$/.test(path)).length !== manifest.sourcePolicy.sourceClosure.checkedSources) refuse('MANIFEST_INVALID', 'Source closure count does not match the inventory')
  for (const path of [...REQUIRED_ROOT_FILES, ...REQUIRED_RELEASE_ENTRYPOINTS, ...REQUIRED_SYSTEMD_UNITS, 'VERSION', 'sbom-provenance.json']) if (!files.has(path)) refuse('MANIFEST_INVALID', 'Required release file is missing')
  if (files.get('pnpm-lock.yaml').sha256 !== digest(manifest.lockfileSha256, 'Lockfile digest') || files.get('sbom-provenance.json').sha256 !== digest(manifest.sbomSha256, 'SBOM digest')) refuse('MANIFEST_INVALID', 'Manifest control-file digests do not match its inventory')
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length !== manifest.controlDbSchemaVersion || manifest.migrations.length > bounds.members) refuse('MANIFEST_INVALID', 'Migration schema range does not match')
  const migrationPaths = [...files.keys()].filter(path => /^packages\/db\/src\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(path))
  if (migrationPaths.length !== manifest.migrations.length) refuse('MANIFEST_INVALID', 'Migration file inventory differs')
  for (const [index, migration] of manifest.migrations.entries()) {
    keys(migration, ['version', 'name', 'path', 'sha256'], 'migration')
    if (migration.version !== index + 1 || !new RegExp(`^${String(index + 1).padStart(4, '0')}_[a-z0-9_]+\\.sql$`).test(migration.name) || migration.path !== `packages/db/src/migrations/${migration.name}` || files.get(migration.path)?.sha256 !== migration.sha256) refuse('MANIFEST_INVALID', 'Migration version/path/digest differs')
  }
  if (!Array.isArray(manifest.webAssets) || manifest.webAssets.length > bounds.members) refuse('MANIFEST_INVALID', 'Invalid web asset inventory')
  const web = new Set()
  for (const asset of manifest.webAssets) {
    keys(asset, ['path', 'sha256', 'bytes'], 'web asset')
    if (!asset.path?.startsWith('apps/web/src/') || web.has(asset.path) || files.get(asset.path)?.sha256 !== asset.sha256 || files.get(asset.path)?.bytes !== asset.bytes) refuse('MANIFEST_INVALID', 'Web asset inventory differs')
    web.add(asset.path)
  }
  if ([...files.keys()].filter(path => path.startsWith('apps/web/src/')).length !== web.size) refuse('MANIFEST_INVALID', 'Web asset inventory is incomplete')
  if (!Array.isArray(manifest.systemdUnits) || manifest.systemdUnits.length !== REQUIRED_SYSTEMD_UNITS.length) refuse('MANIFEST_INVALID', 'Invalid unit inventory')
  for (const [index, unit] of manifest.systemdUnits.entries()) {
    keys(unit, ['name', 'execStart', 'user', 'group', 'supplementaryGroups', 'umask', 'runtimeDirectory', 'runtimeDirectoryMode', 'runtimeDirectoryPreserve', 'noNewPrivileges', 'path', 'sha256'], 'systemd unit')
    if (unit.path !== REQUIRED_SYSTEMD_UNITS[index] || unit.name !== unit.path.split('/').at(-1) || files.get(unit.path)?.sha256 !== unit.sha256) refuse('MANIFEST_INVALID', 'Unit inventory differs')
  }
  return freeze(manifest)
}

const metadataPaths = new Set(['release-manifest.json', '.node-version', 'VERSION', 'package.json', 'sbom-provenance.json', ...REQUIRED_SYSTEMD_UNITS])
const verifyMetadata = (manifest, metadata, bounds) => {
  const text = path => { const bytes = metadata.get(path); if (!bytes) refuse('MANIFEST_INVALID', 'Missing release metadata'); try { return utf8.decode(bytes) } catch { return refuse('MANIFEST_INVALID', 'Invalid metadata UTF-8') } }
  if (text('.node-version').trim() !== manifest.runtime.nodeVersion || text('VERSION').trim() !== manifest.version) refuse('MANIFEST_INVALID', 'Release/runtime version files differ')
  const pkg = parseJson(metadata.get('package.json'), bounds), sbom = parseJson(metadata.get('sbom-provenance.json'), bounds)
  if (pkg.packageManager !== manifest.runtime.packageManager || !object(sbom.runtime) || sbom.version !== manifest.version || sbom.lockfileSha256 !== manifest.lockfileSha256 || sbom.runtime.node !== manifest.runtime.nodeVersion || sbom.runtime.packageManager !== manifest.runtime.packageManager || sbom.runtime.targetOs !== manifest.target.os || sbom.runtime.targetArch !== manifest.target.arch) refuse('MANIFEST_INVALID', 'Runtime/SBOM declarations differ')
  const directives = ['ExecStart', 'User', 'Group', 'SupplementaryGroups', 'UMask', 'RuntimeDirectory', 'RuntimeDirectoryMode', 'RuntimeDirectoryPreserve', 'NoNewPrivileges']
  const fields = ['execStart', 'user', 'group', 'supplementaryGroups', 'umask', 'runtimeDirectory', 'runtimeDirectoryMode', 'runtimeDirectoryPreserve', 'noNewPrivileges']
  for (const unit of manifest.systemdUnits) {
    const values = new Map(); let service = false
    for (const line of text(unit.path).split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('[')) { service = trimmed === '[Service]'; continue }
      if (!service || !trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
      const equal = trimmed.indexOf('='); if (equal < 1) continue
      const key = trimmed.slice(0, equal).trim(), value = trimmed.slice(equal + 1).trim()
      if (directives.includes(key)) { if (values.has(key)) refuse('MANIFEST_INVALID', 'Duplicate service security directive'); values.set(key, value) }
      if (key === 'ExecStartPre' && /\bchown\b/.test(value)) refuse('MANIFEST_INVALID', 'Unsafe unit ownership workaround')
    }
    for (const [index, directive] of directives.entries()) if ((values.get(directive) ?? null) !== unit[fields[index]]) refuse('MANIFEST_INVALID', 'Service metadata differs from actual unit')
    const agent = unit.name === 'xpanel-agent.service'
    if (unit.user !== (agent ? 'root' : 'xpanel') || unit.group !== (agent ? 'xpanel-agent' : 'xpanel') || unit.supplementaryGroups !== (agent ? 'xpanel' : 'xpanel-agent') || unit.umask !== '0007' || typeof unit.execStart !== 'string' || !unit.execStart.endsWith(`/opt/xpanel/apps/${agent ? 'agent' : 'api'}/src/main.ts`)
      || (agent ? unit.runtimeDirectory !== 'xpanel' || unit.runtimeDirectoryMode !== '0750' || unit.runtimeDirectoryPreserve !== 'no' : unit.noNewPrivileges !== 'yes')) refuse('MANIFEST_INVALID', 'Unsupported service security contract')
  }
}

const stable = (before, after) => ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key])
// Proc directory cardinality is dynamic; its trust/identity does not depend on link counts.
const stableProc = (before, after) => ['dev', 'ino', 'mode', 'uid', 'gid'].every(key => before[key] === after[key])
const openedFile = async path => {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n) refuse('UNSAFE_FILE', 'Archive must be a single-link regular file')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try { if (!stable(before, await handle.stat({ bigint: true }))) refuse('FILE_CHANGED', 'Archive changed while opening'); return { handle, before } }
  catch (error) { await closeOwned(handle); throw error }
}
let active = 0, uncertainDescriptor = false
const uncertainHandles = new Set()
const closeOwned = async handle => {
  try { await handle.close() }
  catch (error) { uncertainDescriptor = true; uncertainHandles.add(handle); throw new ReleaseVerificationError('DESCRIPTOR_UNCERTAIN', 'Descriptor retirement is uncertain; process recovery is required', error) }
}
const admitted = async run => {
  if (uncertainDescriptor) refuse('DESCRIPTOR_UNCERTAIN', 'Descriptor retirement is uncertain; process recovery is required')
  if (active >= 4) refuse('BUSY', 'Verification concurrency ceiling reached')
  active++
  try { return await run() } finally { active-- }
}
const readArchiveHash = async (handle, size, bounds) => {
  const digest = createHash('sha256'); let bytes = 0
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: size - 1, highWaterMark: 64 * 1024 })) {
    bytes += chunk.length; if (bytes > bounds.compressedBytes) refuse('LIMIT', 'Compressed archive exceeds budget'); digest.update(chunk)
  }
  if (bytes !== size) refuse('FILE_CHANGED', 'Archive length changed while reading')
  return digest.digest('hex')
}
class TarReader {
  constructor(stream, bounds) { this.iterator = stream[Symbol.asyncIterator](); this.bounds = bounds; this.chunk = Buffer.alloc(0); this.offset = 0; this.bytes = 0 }
  async portion(max) {
    if (this.offset === this.chunk.length) {
      const next = await this.iterator.next(); if (next.done) return null
      this.chunk = next.value; this.offset = 0; this.bytes += this.chunk.length
      if (this.bytes > this.bounds.tarBytes) refuse('LIMIT', 'Expanded tar exceeds budget')
    }
    const part = this.chunk.subarray(this.offset, this.offset + max); this.offset += part.length; return part
  }
  async consume(size, visit) {
    while (size) { const part = await this.portion(size); if (part === null) refuse('CORRUPT_ARCHIVE', 'Truncated tar member'); await visit(part); size -= part.length }
  }
  async block() {
    const first = await this.portion(512); if (first === null) return null
    if (first.length === 512) return first
    const block = Buffer.alloc(512); first.copy(block); let offset = first.length
    await this.consume(512 - offset, part => { part.copy(block, offset); offset += part.length }); return block
  }
}
const octal = (block, start, length) => {
  const bytes = block.subarray(start, start + length), text = bytes.toString('ascii').replace(/[\0 ]+$/g, '').trimStart()
  if (!/^[0-7]+$/.test(text) || bytes.some(byte => byte > 127)) refuse('CORRUPT_ARCHIVE', 'Invalid tar octal field')
  const value = Number.parseInt(text, 8); if (!Number.isSafeInteger(value)) refuse('CORRUPT_ARCHIVE', 'Tar numeric field overflow'); return value
}
const tarString = (block, start, length) => {
  const bytes = block.subarray(start, start + length), zero = bytes.indexOf(0)
  if (zero >= 0 && bytes.subarray(zero).some(byte => byte !== 0)) refuse('CORRUPT_ARCHIVE', 'Nonzero tar string terminator padding')
  const data = zero < 0 ? bytes : bytes.subarray(0, zero)
  if (data.some(byte => byte > 127 || byte < 32)) refuse('CORRUPT_ARCHIVE', 'Tar strings must be printable ASCII'); return data.toString('ascii')
}
const parseTar = async (stream, trust, destination) => {
  const { bounds } = trust, reader = new TarReader(stream, bounds), entries = [], seen = new Map(), metadata = new Map(), prefixes = new Map(), descendants = new Set()
  for (;;) {
    const header = await reader.block()
    if (!header) refuse('CORRUPT_ARCHIVE', 'Tar has no complete end marker')
    if (header.every(byte => byte === 0)) {
      const second = await reader.block(); if (!second || second.some(byte => byte !== 0)) refuse('CORRUPT_ARCHIVE', 'Tar requires two zero end blocks')
      for (;;) { const tail = await reader.portion(64 * 1024); if (tail === null) break; if (tail.some(byte => byte !== 0)) refuse('CORRUPT_ARCHIVE', 'Data after tar end marker') }
      if (reader.bytes % 512 !== 0) refuse('CORRUPT_ARCHIVE', 'Tar has partial trailing padding')
      break
    }
    if (entries.length >= bounds.members) refuse('LIMIT', 'Tar member count exceeded')
    const checksum = octal(header, 148, 8); let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]
    if (sum !== checksum || !header.subarray(257, 265).equals(Buffer.from([117, 115, 116, 97, 114, 0, 48, 48])) || header.subarray(500).some(byte => byte !== 0)) refuse('CORRUPT_ARCHIVE', 'Invalid USTAR header/checksum')
    const prefix = tarString(header, 345, 155), name = tarString(header, 0, 100), type = header[156] === 48 || header[156] === 0 ? 'file' : header[156] === 53 ? 'directory' : null
    if (!type || tarString(header, 157, 100) || header.subarray(329, 345).some(byte => byte !== 0)) refuse('UNSAFE_ENTRY', 'Links, devices and extended tar records are forbidden')
    const path = safePath(`${prefix ? `${prefix}/` : ''}${name}`, bounds), alias = path.toLowerCase()
    if (seen.has(alias)) refuse('DUPLICATE_PATH', 'Duplicate or case-aliased archive path')
    const segments = path.split('/')
    for (let i = 1; i <= segments.length; i++) {
      const current = segments.slice(0, i).join('/'), folded = current.toLowerCase()
      if (prefixes.has(folded) && prefixes.get(folded) !== current) refuse('DUPLICATE_PATH', 'Case-aliased archive directory')
      prefixes.set(folded, current)
      if (i < segments.length) { if (seen.get(folded) === 'file') refuse('UNSAFE_PATH', 'Tar file shadows a directory'); descendants.add(folded) }
    }
    if (type === 'file' && descendants.has(alias)) refuse('UNSAFE_PATH', 'Tar file shadows existing descendants')
    const mode = safeMode(octal(header, 100, 8), type === 'directory'), uid = octal(header, 108, 8), gid = octal(header, 116, 8), size = octal(header, 124, 12)
    octal(header, 136, 12)
    if (uid !== 0 || gid !== 0) refuse('UNSAFE_OWNER', 'Tar members must be root-owned')
    if (tarString(header, 265, 32) !== 'root' || tarString(header, 297, 32) !== 'root') refuse('UNSAFE_OWNER', 'Tar owner names must match numeric root ownership')
    if (type === 'directory' && size !== 0) refuse('CORRUPT_ARCHIVE', 'Directory has a body')
    count(size, Math.min(bounds.fileBytes, path === 'release-manifest.json' ? bounds.manifestBytes : metadataPaths.has(path) ? bounds.metadataBytes : bounds.fileBytes), 'Member bytes')
    const sha = createHash('sha256'), parts = []
    let output
    if (destination) {
      const target = join(destination, path)
      if (type === 'directory') await mkdir(target, { recursive: true, mode })
      else {
        await mkdir(dirname(target), { recursive: true, mode: 0o755 })
        output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
      }
    }
    try {
      await reader.consume(size, async part => {
        sha.update(part); if (metadataPaths.has(path)) parts.push(Buffer.from(part))
        if (output) for (let offset = 0; offset < part.length;) {
          const result = await output.write(part, offset, part.length - offset)
          if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1) refuse('WRITE_UNCERTAIN', 'Staged file write did not advance')
          offset += result.bytesWritten
        }
      })
      if (output) await output.sync()
    } finally { if (output) await closeOwned(output) }
    await reader.consume((512 - size % 512) % 512, part => { if (part.some(byte => byte !== 0)) refuse('CORRUPT_ARCHIVE', 'Nonzero tar member padding') })
    if (metadataPaths.has(path)) metadata.set(path, Buffer.concat(parts, size))
    entries.push({ path, type, sha256: sha.digest('hex'), bytes: size, mode, uid, gid }); seen.set(alias, type)
  }
  const rawManifest = metadata.get('release-manifest.json'); if (!rawManifest) refuse('MANIFEST_INVALID', 'Release manifest is absent')
  const manifest = authenticateManifest(rawManifest, trust), inventory = new Map(manifest.files.map(file => [file.path, file])), directories = new Set()
  for (const path of [...inventory.keys(), 'release-manifest.json']) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) { directories.add(segments.slice(0, i).join('/')); if (directories.size + manifest.files.length + 1 > bounds.members) refuse('LIMIT', 'Complete source tree member budget exceeded') }
  }
  for (const entry of entries) {
    if (entry.type === 'directory') { if (!directories.has(entry.path)) refuse('UNEXPECTED_FILE', 'Unmanifested directory'); continue }
    if (entry.path === 'release-manifest.json') { if (entry.mode !== 0o644) refuse('UNSAFE_MODE', 'Manifest mode must be 0644'); continue }
    const file = inventory.get(entry.path)
    if (!file || file.sha256 !== entry.sha256 || file.bytes !== entry.bytes || file.mode !== entry.mode) refuse('CHECKSUM_MISMATCH', 'Archive file differs from signed inventory')
    inventory.delete(entry.path)
  }
  if (inventory.size) refuse('MISSING_FILE', 'A signed file is absent from the archive')
  verifyMetadata(manifest, metadata, bounds)
  return { manifest, entries, tarBytes: reader.bytes, manifestSha256: hash(rawManifest) }
}

const reports = new WeakSet()
const liveArchives = new WeakMap()
const verifyOpenArchive = async (archivePath, trust, callback, protectedPath) => {
    const { handle, before } = await openedFile(archivePath)
    let result, callbackValue, lifetime, callbackStarted = false, completed = false
    try {
      if (protectedPath) { rootStat(before, false); await protectedPath.verify() }
      if (before.size <= 0n || before.size > BigInt(trust.bounds.compressedBytes)) refuse('LIMIT', 'Compressed archive size is out of bounds')
      const size = Number(before.size), archiveSha256 = await readArchiveHash(handle, size, trust.bounds)
      if (archiveSha256 !== trust.expectedArchiveSha256) refuse('ARCHIVE_CHECKSUM_MISMATCH', 'External archive digest does not match')
      const raw = handle.createReadStream({ autoClose: false, start: 0, end: size - 1, highWaterMark: 64 * 1024 }), secondHash = createHash('sha256'); let compressed = 0
      const meter = new Transform({ transform(chunk, _encoding, done) { compressed += chunk.length; if (compressed > trust.bounds.compressedBytes) done(new ReleaseVerificationError('LIMIT', 'Compressed archive budget exceeded')); else { secondHash.update(chunk); done(null, chunk) } } })
      const gunzip = createGunzip({ chunkSize: 64 * 1024 }), pumping = pipeline(raw, meter, gunzip)
      void pumping.catch(() => undefined)
      let consumed = false
      try { result = await parseTar(gunzip, trust); await pumping; consumed = true }
      finally { if (!consumed) { raw.destroy(); meter.destroy(); gunzip.destroy(); await pumping.catch(() => undefined) } }
      if (compressed !== size || secondHash.digest('hex') !== archiveSha256 || !stable(before, await handle.stat({ bigint: true }))) refuse('FILE_CHANGED', 'Archive changed during verification')
      result = freeze({ ok: true, ...result, archiveSha256, archiveBytes: size, totalUnpackedBytes: result.manifest.totalUnpackedBytes, sourceClosure: { authenticatedBuilderDeclaration: true, runtimeImportsReparsed: false }, scope: 'source-artifact', runtimeDependenciesVerified: false, installReady: false, lifecycleControlsPresent: REQUIRED_LIFECYCLE_CONTROL_FILES.every(path => result.manifest.files.some(file => file.path === path)) })
      if (callback) {
        if (!stable(before, await lstat(archivePath, { bigint: true }))) refuse('FILE_CHANGED', 'Archive path changed before callback')
        await protectedPath.verify(); reports.add(result); callbackStarted = true
        lifetime = { handle, before, trust, protectedPath, stagedAt: null }
        liveArchives.set(result, lifetime)
        let value, callbackError, callbackFailed = false
        try { value = await callback(Object.freeze({ report: result, fd: handle.fd })) } catch (error) { callbackFailed = true; callbackError = error }
        finally {
          // An unawaited extraction cannot escape its descriptor lifetime or
          // turn a failed writer into callback-declared success.
          if (lifetime.pendingStage) try { await lifetime.pendingStage } catch (error) { if (!callbackFailed) { callbackFailed = true; callbackError = error } }
          liveArchives.delete(result)
        }
        // All staging/tree validation must finish in the callback. Publication waits until return.
        if (!stable(before, await handle.stat({ bigint: true })) || !stable(before, await lstat(archivePath, { bigint: true })) || await readArchiveHash(handle, size, trust.bounds) !== archiveSha256) refuse('FILE_CHANGED', 'Authenticated archive changed during callback')
        await protectedPath.verify()
        if (callbackFailed) throw callbackError
        callbackValue = value
      }
      completed = true
    } catch (error) {
      if (result) reports.delete(result)
      if (callbackStarted) { const failure = new ReleaseVerificationError('ARCHIVE_USE_UNCERTAIN', 'Archive callback failed or verified lifetime changed; staging must remain unpublished', error); failure.uncertain = true; failure.archiveSha256 = result.archiveSha256; if (lifetime?.stagedAt) { failure.stagedAt = lifetime.stagedAt; failure.stagingRetained = true } throw failure }
      if (error instanceof ReleaseVerificationError) throw error
      throw new ReleaseVerificationError('CORRUPT_ARCHIVE', 'Archive read/decompression failed', error)
    }
    finally {
      try { await closeOwned(handle) }
      catch (error) { uncertainDescriptor = true; if (result) reports.delete(result); const failure = new ReleaseVerificationError('DESCRIPTOR_UNCERTAIN', 'Archive descriptor retirement is uncertain; staging must remain unpublished', error); failure.uncertain = true; if (lifetime?.stagedAt) { failure.stagedAt = lifetime.stagedAt; failure.stagingRetained = true } throw failure }
    }
    if (completed) reports.add(result)
    return callback ? Object.freeze({ report: result, value: callbackValue }) : result
}
/** Authenticate bytes before decompression, then verify bounded tar/manifest closure. No extraction. */
export const verifyAuthenticatedReleaseArchive = async (archivePath, options) => {
  const trust = optionsFor(options)
  if (typeof archivePath !== 'string' || archivePath.includes('\0')) refuse('OPTIONS', 'Archive path is invalid')
  return admitted(() => verifyOpenArchive(archivePath, trust))
}

const rootStat = (stat, directory) => {
  if (stat.uid !== 0n || stat.gid !== 0n || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) refuse('UNSAFE_TREE', 'Release ancestry/files must be actual root-owned directories or single-link regular files')
  safeMode(Number(stat.mode & 0o7777n), directory)
}
const linuxRoot = () => {
  if (process.platform !== 'linux' || typeof process.geteuid !== 'function' || process.geteuid() !== 0 || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK) refuse('LINUX_ROOT_REQUIRED', 'Protected verification requires actual Linux root and no-follow primitives')
}
const protectedArchiveAncestry = async (archivePath, bounds) => {
  if (typeof archivePath !== 'string' || !isAbsolute(archivePath) || resolve(archivePath) !== archivePath || archivePath.includes('\0') || archivePath.split('/').length > bounds.depth) refuse('OPTIONS', 'Archive path must be canonical and absolute')
  const held = [], observed = []
  const close = async () => { let failed; for (const handle of held.reverse()) try { await closeOwned(handle) } catch (error) { failed ??= error } if (failed) throw failed }
  const own = async path => {
    if (held.length >= 64) refuse('LIMIT', 'Protected ancestry descriptor ceiling exceeded')
    const before = await lstat(path, { bigint: true }); rootStat(before, true)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK); held.push(handle)
    const stat = await handle.stat({ bigint: true }), compare = path === '/proc' || path.startsWith('/proc/') ? stableProc : stable
    if (!compare(before, stat)) refuse('FILE_CHANGED', 'Protected ancestry changed while opening')
    observed.push({ path, handle, stat, compare }); return handle
  }
  try {
    const proc = await own('/proc'), pid = await own(`/proc/${process.pid}`), fd = await own(`/proc/${process.pid}/fd`)
    if (await readlink('/proc/self') !== String(process.pid) || (await proc.statfs({ bigint: true })).type !== 0x9fa0n || (await pid.statfs({ bigint: true })).type !== 0x9fa0n || (await fd.statfs({ bigint: true })).type !== 0x9fa0n) refuse('UNSAFE_TREE', 'Own proc FD anchor is not established')
    let parent = await own('/'), canonical = ''
    for (const part of archivePath.slice(1).split('/').slice(0, -1)) {
      if (!part || part === '.' || part === '..') refuse('OPTIONS', 'Noncanonical protected ancestor')
      canonical += `/${part}`
      const child = await own(`/proc/${process.pid}/fd/${parent.fd}/${part}`)
      const canonicalStat = await lstat(canonical, { bigint: true }); if (!stable(canonicalStat, await child.stat({ bigint: true }))) refuse('FILE_CHANGED', 'Canonical protected ancestry differs')
      observed.push({ path: canonical, handle: child, stat: canonicalStat, compare: stable }); parent = child
    }
    const verify = async () => {
      if (await readlink('/proc/self') !== String(process.pid)) refuse('UNSAFE_TREE', 'Own proc identity changed')
      for (const item of observed) if (!item.compare(item.stat, await item.handle.stat({ bigint: true })) || !item.compare(item.stat, await lstat(item.path, { bigint: true }))) refuse('FILE_CHANGED', 'Protected ancestry changed')
    }
    await verify(); return { verify, close }
  } catch (error) { await close(); throw error }
}
/**
 * Linux-only lifetime admission. The callback may stage/extract and verify a tree using this
 * read-only FD. It must not publish/rename/perform irreversible work until this call returns.
 * FD use must end before callback settlement. Path/inode immutability is not claimed.
 */
export const withAuthenticatedReleaseArchive = async (archivePath, options, callback) => {
  const trust = optionsFor(options); linuxRoot()
  if (typeof callback !== 'function') refuse('OPTIONS', 'Archive lifetime requires a callback')
  return admitted(async () => {
    const ancestry = await protectedArchiveAncestry(archivePath, trust.bounds)
    let result, failure
    try { result = await verifyOpenArchive(archivePath, trust, callback, ancestry) } catch (error) { failure = error }
    try { await ancestry.close() } catch (error) { if (result) reports.delete(result.report); error.uncertain = true; failure = error }
    if (failure) throw failure
    return result
  })
}

/**
 * Extract only from this module's live, authenticated retained descriptor. The
 * caller cannot supply an FD, writer, ownership observation or validation hook.
 * A fresh private staging directory is retained on failure and never activated.
 * Dependency/ABI and native service qualification remain separate requirements.
 */
const stageOpenAuthenticatedArchive = async (stagingRoot, options) => {
  const trust = optionsFor(options, true), report = options.authenticatedArchive
  const lifetime = liveArchives.get(report)
  if (!lifetime || !reports.has(report)) refuse('LIVE_ARCHIVE_REQUIRED', 'Staging requires this module\'s currently retained authenticated archive')
  linuxRoot()
  if (trust.keyId !== lifetime.trust.keyId || trust.key.length !== lifetime.trust.key.length || !timingSafeEqual(trust.key, lifetime.trust.key)) refuse('TRUST_REQUIRED', 'Staging trust must match the retained archive')
  if (lifetime.stagedAt) refuse('STAGING_ALREADY_STARTED', 'A retained archive cannot retry an existing staging attempt')
  if (typeof stagingRoot !== 'string' || !isAbsolute(stagingRoot) || resolve(stagingRoot) !== stagingRoot || stagingRoot === '/' || stagingRoot.includes('\0')) refuse('OPTIONS', 'Staging root must be a canonical dedicated directory')
  for (let path = stagingRoot; ; path = dirname(path)) {
    rootStat(await lstat(path, { bigint: true }), true)
    if (dirname(path) === path) break
  }
  const parent = await open(stagingRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let directory
  try {
    const parentStat = await parent.stat({ bigint: true }); rootStat(parentStat, true)
    if (!stable(parentStat, await lstat(stagingRoot, { bigint: true }))) refuse('FILE_CHANGED', 'Staging parent changed while opening')
    if (!stable(lifetime.before, await lifetime.handle.stat({ bigint: true }))) refuse('FILE_CHANGED', 'Retained archive changed before staging')
    await lifetime.protectedPath.verify()
    const name = `authenticated-${randomBytes(16).toString('hex')}`
    const pinned = `/proc/${process.pid}/fd/${parent.fd}/${name}`
    await mkdir(pinned, { mode: 0o700 })
    lifetime.stagedAt = join(stagingRoot, name)
    directory = await open(pinned, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const privateStat = await directory.stat({ bigint: true }); rootStat(privateStat, true)
    if (Number(privateStat.mode & 0o7777n) !== 0o700 || !stable(privateStat, await lstat(lifetime.stagedAt, { bigint: true }))) refuse('UNSAFE_TREE', 'Private staging directory identity differs')
    const raw = lifetime.handle.createReadStream({ autoClose: false, start: 0, end: report.archiveBytes - 1, highWaterMark: 64 * 1024 })
    const compressedHash = createHash('sha256'); let compressed = 0
    const meter = new Transform({ transform(chunk, _encoding, done) {
      compressed += chunk.length
      if (compressed > report.archiveBytes || compressed > trust.bounds.compressedBytes) done(new ReleaseVerificationError('LIMIT', 'Staging compressed byte ceiling exceeded'))
      else { compressedHash.update(chunk); done(null, chunk) }
    } })
    const gunzip = createGunzip({ chunkSize: 64 * 1024 }), pumping = pipeline(raw, meter, gunzip)
    void pumping.catch(() => undefined)
    let consumed = false, parsed
    try { parsed = await parseTar(gunzip, trust, `/proc/${process.pid}/fd/${directory.fd}`); await pumping; consumed = true }
    finally { if (!consumed) { raw.destroy(); meter.destroy(); gunzip.destroy(); await pumping.catch(() => undefined) } }
    if (compressed !== report.archiveBytes || compressedHash.digest('hex') !== report.archiveSha256 || parsed.manifestSha256 !== report.manifestSha256 || !stable(lifetime.before, await lifetime.handle.stat({ bigint: true }))) refuse('FILE_CHANGED', 'Staged source differs from the retained authenticated archive')
    await directory.sync(); await parent.sync()
    if (!stable(await directory.stat({ bigint: true }), await lstat(lifetime.stagedAt, { bigint: true }))) refuse('FILE_CHANGED', 'Staging path no longer names its owned directory')
    const tree = await verifyAuthenticatedReleaseTree(lifetime.stagedAt, options)
    await lifetime.protectedPath.verify()
    return freeze({ ...tree, stagedAt: lifetime.stagedAt, activated: false, installReady: false, runtimeDependenciesVerified: false })
  } finally {
    let failure
    if (directory) try { await closeOwned(directory) } catch (error) { failure = error }
    try { await closeOwned(parent) } catch (error) { failure ??= error }
    if (failure) throw failure
  }
}

export const stageAuthenticatedReleaseArchive = (stagingRoot, options) => {
  const lifetime = object(options) ? liveArchives.get(options.authenticatedArchive) : null
  if (lifetime?.pendingStage) return Promise.reject(new ReleaseVerificationError('STAGING_ALREADY_STARTED', 'A retained archive cannot retry an existing staging attempt'))
  const task = stageOpenAuthenticatedArchive(stagingRoot, options)
  if (lifetime) { lifetime.pendingStage = task; void task.catch(() => undefined) }
  return task
}
/** Requires actual Linux-root observations and a same-process authenticated archive report. */
export const verifyAuthenticatedReleaseTree = async (root, options) => {
  const trust = optionsFor(options, true), archive = options.authenticatedArchive
  if (!reports.has(archive)) refuse('TRUST_REQUIRED', 'A same-module authenticated archive report is mandatory')
  linuxRoot()
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root === '/' || root.includes('\0') || root.split('/').length > trust.bounds.depth) refuse('OPTIONS', 'Release root must be a canonical absolute directory')
  return admitted(async () => {
    const handles = [], ancestry = [], expected = new Map(archive.entries.filter(entry => entry.type === 'file').map(entry => [entry.path, entry])), allowedDirs = new Set(), seen = new Set()
    if (expected.size > trust.bounds.members || archive.tarBytes > trust.bounds.tarBytes || archive.archiveBytes > trust.bounds.compressedBytes) refuse('LIMIT', 'Authenticated source exceeds tree verification policy')
    for (const entry of expected.values()) if (entry.bytes > Math.min(trust.bounds.fileBytes, entry.path === 'release-manifest.json' ? trust.bounds.manifestBytes : trust.bounds.fileBytes)) refuse('LIMIT', 'Authenticated file exceeds tree verification policy')
    for (const path of expected.keys()) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) { allowedDirs.add(parts.slice(0, i).join('/')); if (allowedDirs.size + expected.size > trust.bounds.members) refuse('LIMIT', 'Complete tree member budget exceeded') } }
    let opened = 0, total = 0, manifest = null
    const own = async path => {
      if (handles.length >= 64) refuse('LIMIT', 'Tree descriptor ceiling exceeded')
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK)
      handles.push(handle); const stat = await handle.stat({ bigint: true }); rootStat(stat, true); return { handle, stat }
    }
    try {
      const proc = await own('/proc'), procStat = await proc.handle.statfs({ bigint: true })
      if (procStat.type !== 0x9fa0n || await readlink('/proc/self') !== String(process.pid)) refuse('UNSAFE_TREE', 'Own proc FD anchor is not established')
      const pid = await own(`/proc/${process.pid}`), fd = await own(`/proc/${process.pid}/fd`)
      const anchor = `/proc/${process.pid}/fd`, pinned = (parent, name) => `${anchor}/${parent.handle.fd}/${name}`
      if ((await pid.handle.statfs({ bigint: true })).type !== 0x9fa0n || (await fd.handle.statfs({ bigint: true })).type !== 0x9fa0n) refuse('UNSAFE_TREE', 'Invalid own FD directory')
      const procEvidence = [{ path: '/proc', ...proc }, { path: `/proc/${process.pid}`, ...pid }, { path: `/proc/${process.pid}/fd`, ...fd }]
      let directory = await own('/'); ancestry.push({ path: '/', ...directory })
      for (const name of root.slice(1).split('/')) { directory = await own(pinned(directory, name)); ancestry.push({ path: ancestry.at(-1).path === '/' ? `/${name}` : `${ancestry.at(-1).path}/${name}`, ...directory }) }
      const visit = async (parent, relative) => {
        const cursor = await opendir(`${anchor}/${parent.handle.fd}`)
        try {
          for (;;) {
            const item = await cursor.read(); if (item === null) break
            if (++opened > trust.bounds.members) refuse('LIMIT', 'Tree member ceiling exceeded')
            const path = safePath(relative ? `${relative}/${item.name}` : item.name, trust.bounds)
            if (seen.has(path.toLowerCase())) refuse('DUPLICATE_PATH', 'Tree contains duplicate/case-aliased paths'); seen.add(path.toLowerCase())
            const actualPath = pinned(parent, item.name), before = await lstat(actualPath, { bigint: true })
            if (before.isDirectory()) {
              if (!allowedDirs.has(path)) refuse('UNEXPECTED_FILE', 'Unmanifested tree directory')
              const child = await own(actualPath); if (!stable(before, child.stat)) refuse('FILE_CHANGED', 'Directory changed while opening')
              try { await visit(child, path); if (!stable(child.stat, await child.handle.stat({ bigint: true })) || !stable(before, await lstat(actualPath, { bigint: true }))) refuse('FILE_CHANGED', 'Directory changed during verification') }
              finally { handles.splice(handles.indexOf(child.handle), 1); await closeOwned(child.handle) }
            } else {
              const entry = expected.get(path); if (!entry) refuse('UNEXPECTED_FILE', 'Unmanifested tree file')
              rootStat(before, false)
              if (before.size !== BigInt(entry.bytes) || Number(before.mode & 0o7777n) !== entry.mode) refuse('CHECKSUM_MISMATCH', 'Tree size/mode differs from authenticated archive')
              const file = await open(actualPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
              try {
                if (!stable(before, await file.stat({ bigint: true }))) refuse('FILE_CHANGED', 'File changed while opening')
                const sha = createHash('sha256'), chunks = []; let bytes = 0
                for await (const chunk of file.createReadStream({ autoClose: false, start: 0, highWaterMark: 64 * 1024 })) {
                  bytes += chunk.length; total += chunk.length
                  if (bytes > entry.bytes || bytes > trust.bounds.fileBytes || total > trust.bounds.tarBytes) refuse('LIMIT', 'Tree byte ceiling exceeded')
                  sha.update(chunk); if (path === 'release-manifest.json') chunks.push(Buffer.from(chunk))
                }
                if (bytes !== entry.bytes || sha.digest('hex') !== entry.sha256 || !stable(before, await file.stat({ bigint: true })) || !stable(before, await lstat(actualPath, { bigint: true }))) refuse('FILE_CHANGED', 'Tree file changed or differs from authenticated archive')
                if (path === 'release-manifest.json') {
                  const bytes = Buffer.concat(chunks); manifest = authenticateManifest(bytes, trust)
                  if (hash(bytes) !== archive.manifestSha256) refuse('CHECKSUM_MISMATCH', 'Installed manifest differs from authenticated archive')
                }
                expected.delete(path)
              } finally { await closeOwned(file) }
            }
          }
        } finally { await closeOwned(cursor) }
      }
      await visit(directory, '')
      if (await readlink('/proc/self') !== String(process.pid)) refuse('UNSAFE_TREE', 'Own proc identity changed')
      for (const item of procEvidence) if (!stableProc(item.stat, await item.handle.stat({ bigint: true })) || !stableProc(item.stat, await lstat(item.path, { bigint: true }))) refuse('FILE_CHANGED', 'Proc ancestry identity changed during verification')
      for (const item of ancestry) if (!stable(item.stat, await item.handle.stat({ bigint: true })) || !stable(item.stat, await lstat(item.path, { bigint: true }))) refuse('FILE_CHANGED', 'Release ancestry changed during verification')
      if (expected.size || !manifest) refuse('MISSING_FILE', 'Authenticated tree closure is incomplete')
      return freeze({ ok: true, root, manifest, manifestSha256: archive.manifestSha256, archiveSha256: archive.archiveSha256, verifiedFiles: archive.entries.filter(entry => entry.type === 'file').length, ownership: 'observed-linux-root', verifiedAt: new Date().toISOString() })
    } finally { let failure; for (const handle of handles.reverse()) try { await closeOwned(handle) } catch (error) { failure ??= error } if (failure) throw failure }
  })
}
