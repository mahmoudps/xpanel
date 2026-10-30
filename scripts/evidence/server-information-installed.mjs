import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isHash, isRecord, requireValue, safeEvidenceRelativePath, validateTargetDocument } from './contracts.mjs'
import { hashArtifact } from './identity.mjs'
import { assertTrustedMetadata } from './runtime.mjs'
import { sha256 } from './shared.mjs'

function ancestry(path) {
  const entries = []
  let current = resolve(path)
  while (true) {
    const info = lstatSync(current)
    entries.push({ uid: info.uid, mode: info.mode, symlink: info.isSymbolicLink() })
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  assertTrustedMetadata(entries)
}

export function readProtectedBytes({ file, fd, secret = false, expectedSha256, maxBytes = 4 * 1024 * 1024, minBytes = 1 }) {
  requireValue(process.platform === 'linux' && process.getuid() === 0, 'Qualification files require the trusted Linux root runner')
  requireValue((file === undefined) !== (fd === undefined), 'Select exactly one protected file or inherited descriptor')
  let descriptor = fd, owned = false
  if (file !== undefined) { ancestry(file); descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); owned = true }
  try {
    requireValue(Number.isInteger(descriptor) && descriptor >= 3, 'A protected inherited file descriptor is required')
    const before = fstatSync(descriptor)
    requireValue(before.isFile() && before.uid === 0 && (before.mode & (secret ? 0o077 : 0o022)) === 0 && before.size >= minBytes && before.size <= maxBytes, 'Protected qualification input ownership, mode or size is invalid')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      requireValue(count > 0, 'Protected qualification input ended unexpectedly'); offset += count
    }
    const after = fstatSync(descriptor)
    requireValue(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]), 'Protected qualification input changed')
    if (expectedSha256 !== undefined) requireValue(isHash(expectedSha256) && sha256(bytes) === expectedSha256, 'Protected qualification input digest did not match its independent pin')
    return bytes
  } finally { if (owned) closeSync(descriptor) }
}

export function readProtectedJson(options) { return JSON.parse(readProtectedBytes(options).toString('utf8')) }

export function validateInstalledBinding(binding, targetDocument) {
  validateTargetDocument(targetDocument)
  requireValue(binding?.schemaVersion === 1 && binding.kind === 'xpanel-server-information-installed-binding', 'Reviewed installed-release binding is required')
  requireValue(binding.target?.sourceFingerprint === targetDocument.target.sourceFingerprint && binding.target?.artifactSha256 === targetDocument.target.artifactSha256 && binding.sourceAlgorithm === targetDocument.source.algorithm && binding.commit === targetDocument.source.commit, 'Installed binding does not match the source/artifact target')
  requireValue(targetDocument.target.supportedProfiles.includes(binding.profile), 'Installed binding needs the actual reviewed OS profile')
  requireValue(typeof binding.releaseRoot === 'string' && binding.releaseRoot.startsWith('/') && isHash(binding.manifestSha256) && /^[a-f0-9-]{36}$/.test(binding.bootId ?? ''), 'Installed release root, manifest pin or boot identity is invalid')
  requireValue(['normal-root-api', 'existing-host-probes', 'trusted-release-evidence'].includes(binding.qualificationAdmission), 'The actual normal qualification admission path must be recorded')
  requireValue(isRecord(binding.roles) && binding.roles.api?.pid !== binding.roles.agent?.pid, 'Distinct real API and agent processes are required')
  for (const role of ['api', 'agent']) {
    const item = binding.roles[role]
    requireValue(isRecord(item) && Number.isSafeInteger(item.pid) && item.pid > 1 && /^\d+$/.test(item.startTicks ?? '') && isHash(item.commandSha256) && isHash(item.executableSha256) && Number.isSafeInteger(item.uid) && (role === 'agent' ? item.uid === 0 : item.uid > 0), 'Reviewed process identity is incomplete')
  }
  return binding
}

export function parseProcStartTicks(text) {
  const close = text.lastIndexOf(')')
  requireValue(close > 1, 'Process identity is unreadable')
  const parts = text.slice(close + 1).trim().split(/\s+/)
  requireValue(parts[0] !== 'Z' && /^\d+$/.test(parts[19] ?? ''), 'Process is retired or its start identity is unreadable')
  return parts[19]
}

function verifyAdapterInputs(targetDocument) {
  const files = new Map(targetDocument.source.files.map(file => [file.path, file]))
  const dependencies = ['server-information-contract.mjs', 'server-information-observer.mjs', 'server-information-installed.mjs', 'server-information-https.mjs', 'server-information-runner.mjs', 'contracts.mjs', 'identity.mjs', 'files.mjs', 'shared.mjs', 'runtime.mjs', 'reports.mjs', 'cli.mjs']
  for (const name of dependencies) {
    const expected = files.get(`scripts/evidence/${name}`)
    requireValue(expected !== undefined, 'Qualification adapter is absent from the frozen source manifest')
    const actual = readProtectedBytes({ file: fileURLToPath(new URL(name, import.meta.url)), expectedSha256: expected.sha256, maxBytes: 1024 * 1024 })
    requireValue(actual.length === expected.bytes, 'Qualification adapter differs from the frozen source manifest')
  }
  const snapshot = files.get('scripts/vm/source-snapshot.mjs')
  requireValue(snapshot !== undefined, 'Shared source identity helper is absent from the frozen manifest')
  readProtectedBytes({ file: fileURLToPath(new URL('../vm/source-snapshot.mjs', import.meta.url)), expectedSha256: snapshot.sha256, maxBytes: 1024 * 1024 })
}

function processIdentity(role, expected, root, runnerExecutableSha256) {
  const base = `/proc/${expected.pid}`
  const startTicks = parseProcStartTicks(readFileSync(`${base}/stat`, 'utf8'))
  const status = readFileSync(`${base}/status`, 'utf8')
  const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status)
  requireValue(uid !== null && uid.slice(1).every(value => Number(value) === expected.uid) && startTicks === expected.startTicks, 'API or agent process identity changed')
  requireValue(realpathSync(`${base}/cwd`) === root, 'Measured process uses a different release directory')
  const command = readFileSync(`${base}/cmdline`), parts = command.toString('utf8').split('\0').filter(Boolean)
  const entry = resolve(root, `apps/${role}/src/main.ts`)
  const entryArg = parts.find(value => value.endsWith(`/apps/${role}/src/main.ts`) || value === `apps/${role}/src/main.ts`)
  requireValue(entryArg !== undefined && realpathSync(resolve(root, entryArg)) === realpathSync(entry) && sha256(command) === expected.commandSha256, 'Measured process entrypoint or command changed')
  const executable = realpathSync(`${base}/exe`), procStat = statSync(`${base}/exe`), fileStat = statSync(executable)
  requireValue(procStat.dev === fileStat.dev && procStat.ino === fileStat.ino && expected.executableSha256 === runnerExecutableSha256 && hashArtifact(executable).sha256 === expected.executableSha256, 'Measured process does not use the reviewed pinned executable')
  return { pid: expected.pid, uid: expected.uid, startTicks, commandSha256: expected.commandSha256, executableSha256: expected.executableSha256, mountNamespace: readlinkSync(`${base}/ns/mnt`) }
}

/** Pins are issued by the installer/reviewer after authenticated archive verification, never by HTTP. */
export function verifyInstalledRelease({ binding, targetDocument, artifact, deadline = Number.POSITIVE_INFINITY }) {
  validateInstalledBinding(binding, targetDocument)
  const checkDeadline = () => requireValue(Date.now() < deadline, 'Installed release verification exceeded the qualification deadline')
  checkDeadline()
  requireValue(process.platform === 'linux' && process.getuid() === 0 && process.version === `v${targetDocument.source.node}`, 'A real pinned Linux root qualification runner is required')
  verifyAdapterInputs(targetDocument)
  requireValue(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() === binding.bootId, 'Installed binding belongs to a different boot')
  const root = realpathSync(binding.releaseRoot)
  const manifestBytes = readProtectedBytes({ file: resolve(root, 'release-manifest.json'), expectedSha256: binding.manifestSha256 })
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  requireValue(manifest.schemaVersion === 1 && manifest.runtime?.nodeVersion === targetDocument.source.node && Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 5000, 'Installed authenticated manifest inventory is incomplete')
  const paths = new Set(), entries = []
  let total = 0, provenanceBytes
  for (const entry of manifest.files) {
    checkDeadline()
    requireValue(safeEvidenceRelativePath(entry.path) && !paths.has(entry.path) && isHash(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, 'Installed inventory contains an invalid or duplicate file')
    paths.add(entry.path); total += entry.bytes
    requireValue(total <= 256 * 1024 * 1024, 'Installed inventory exceeded bounded qualification scope')
    const path = resolve(root, entry.path), actual = readProtectedBytes({ file: path, expectedSha256: entry.sha256, maxBytes: 64 * 1024 * 1024, minBytes: 0 })
    requireValue(actual.length === entry.bytes, 'Installed file length differs from its authenticated inventory')
    entries.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes })
    if (entry.path === 'source-provenance.json') provenanceBytes = actual
    if (entry.path === 'pnpm-lock.yaml') requireValue(entry.sha256 === targetDocument.source.lockfileSha256, 'Installed dependency lock differs from the qualification target')
  }
  requireValue(paths.has('source-provenance.json') && paths.has('apps/api/src/main.ts') && paths.has('apps/agent/src/main.ts') && paths.has('pnpm-lock.yaml'), 'Installed release is missing required provenance or entrypoints')
  const provenance = JSON.parse(provenanceBytes.toString('utf8'))
  requireValue(provenance.verificationSource?.algorithm === targetDocument.source.algorithm && provenance.verificationSource?.sourceFingerprint === targetDocument.target.sourceFingerprint && provenance.verificationSource?.commit === targetDocument.source.commit && provenance.verificationSource?.dirty === false, 'Installed provenance does not match the clean qualification source')
  const archive = hashArtifact(artifact)
  requireValue(archive.sha256 === targetDocument.target.artifactSha256 && archive.bytes === targetDocument.provenance.document.artifact.bytes, 'Available release archive differs from the installed target binding')
  const runnerExecutableSha256 = hashArtifact(process.execPath).sha256
  const roles = Object.fromEntries(['api', 'agent'].map(role => { checkDeadline(); return [role, processIdentity(role, binding.roles[role], root, runnerExecutableSha256)] }))
  requireValue(process.pid !== roles.agent.pid && process.pid !== roles.api.pid, 'The observer runner cannot be the measured service')
  return { sourceFingerprint: provenance.verificationSource.sourceFingerprint, artifactSha256: archive.sha256, manifestSha256: binding.manifestSha256, inventoryFiles: entries.length, inventoryBytes: total, roles, bootId: binding.bootId, qualificationAdmission: binding.qualificationAdmission }
}
