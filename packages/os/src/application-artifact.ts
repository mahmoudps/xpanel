import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'

export const APPLICATION_ARTIFACT_LIMITS = Object.freeze({ bytes: 128 * 1024 * 1024, headerBytes: 2 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, files: 8192, path: 240, templateBytes: 64 * 1024 })
export interface ApplicationArtifactDescriptor { readonly format: 'xpanel-files-v1'; readonly sha256: string; readonly bytes: number }
export interface ApplicationArtifactFile { readonly path: string; readonly sha256: string; readonly bytes: number; readonly mode: '0644' }
/** What the panel prepares at install: a database with its own user, and one config file rendered from a bundled template. */
export interface ApplicationArtifactSetup { readonly database: boolean; readonly config: { readonly path: string; readonly template: string } | null }
export interface VerifiedApplicationArtifact {
  readonly appId: string
  readonly version: string
  readonly descriptor: Readonly<ApplicationArtifactDescriptor>
  readonly setup: Readonly<ApplicationArtifactSetup>
  readonly files: readonly Readonly<ApplicationArtifactFile>[]
  /** A new copy on each call; mutable byte arrays never escape the verified artifact's private storage. */
  readFile(path: string): Uint8Array
}
const verified = new WeakSet<object>()
const invalid = (): never => fail('VALIDATION', 'the application artifact is not a bounded regular-file bundle', { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(value).sort().join(',') === [...fields].sort().join(',')
export const applicationDigest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
export const isApplicationId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
export const isApplicationVersion = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(value)
export const isApplicationDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
export const isApplicationArtifactPath = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= APPLICATION_ARTIFACT_LIMITS.path
  && value.split('/').every(part => /^[A-Za-z0-9._-]{1,64}$/.test(part) && !['.', '..', '.git', '.ssh', '.secrets'].includes(part.toLowerCase()))

/** Rejects a path that aliases an earlier one or uses one as a directory, even on case-folding providers. */
export const applicationPathTracker = (): ((path: string) => boolean) => {
  const files = new Set<string>(), directories = new Set<string>()
  return path => {
    const lower = path.toLowerCase(), parts = lower.split('/'), parents = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
    if (files.has(lower) || directories.has(lower) || parents.some(parent => files.has(parent))) return false
    files.add(lower); for (const parent of parents) directories.add(parent)
    return true
  }
}

/** Reserved at the top of a document root: the panel's own challenge and CGI directories. */
const RESERVED_PATHS = new Set(['.well-known', 'cgi-bin'])
/** A directory under a document root; '' selects the root itself. */
export function readApplicationPath(value: unknown): string {
  if (value === '' || value === undefined) return ''
  if (!isApplicationArtifactPath(value) || RESERVED_PATHS.has(value.split('/')[0]!.toLowerCase())) return fail('VALIDATION', 'choose a directory under the document root', { stateChanged: false, reason: 'application_path_invalid' })
  return value
}

export function readApplicationArtifactDescriptor(value: unknown): Readonly<ApplicationArtifactDescriptor> {
  if (!object(value) || !exact(value, ['format', 'sha256', 'bytes']) || value.format !== 'xpanel-files-v1' || !isApplicationDigest(value.sha256)
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > APPLICATION_ARTIFACT_LIMITS.bytes) return invalid()
  return Object.freeze({ format: value.format, sha256: value.sha256, bytes: Number(value.bytes) })
}

/**
 * One canonical JSON header line, then the file bytes in header order. No tar, URL, shell, root path, executable bit,
 * link or device exists in this format, and file bytes stay outside the agent's small JavaScript heap.
 */
export function verifyApplicationArtifact(input: Uint8Array, expected: ApplicationArtifactDescriptor, appId: string, version: string): VerifiedApplicationArtifact {
  const descriptor = readApplicationArtifactDescriptor(expected)
  if (!(input instanceof Uint8Array) || input.byteLength !== descriptor.bytes || applicationDigest(input) !== descriptor.sha256 || !isApplicationId(appId) || !isApplicationVersion(version)) return invalid()
  const newline = input.indexOf(0x0a)
  if (newline < 2 || newline > APPLICATION_ARTIFACT_LIMITS.headerBytes) return invalid()
  let value: unknown, header: string
  try { header = new TextDecoder('utf-8', { fatal: true }).decode(input.subarray(0, newline)); value = JSON.parse(header) } catch { return invalid() }
  if (!object(value) || !exact(value, ['schemaVersion', 'appId', 'version', 'setup', 'files']) || value.schemaVersion !== 1 || value.appId !== appId || value.version !== version
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > APPLICATION_ARTIFACT_LIMITS.files) return invalid()
  let offset = newline + 1, previous = ''
  const contents = new Map<string, Uint8Array>(), fresh = applicationPathTracker()
  const files = value.files.map((raw): Readonly<ApplicationArtifactFile> => {
    if (!object(raw) || !exact(raw, ['path', 'sha256', 'bytes', 'mode']) || !isApplicationArtifactPath(raw.path) || raw.path <= previous || !fresh(raw.path)
      || !isApplicationDigest(raw.sha256) || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0 || Number(raw.bytes) > APPLICATION_ARTIFACT_LIMITS.fileBytes || raw.mode !== '0644') return invalid()
    const content = input.subarray(offset, offset + Number(raw.bytes))
    if (content.byteLength !== raw.bytes || applicationDigest(content) !== raw.sha256) return invalid()
    previous = raw.path; offset += content.byteLength
    contents.set(raw.path, content)
    return Object.freeze({ path: raw.path, sha256: raw.sha256, bytes: content.byteLength, mode: '0644' })
  })
  if (offset !== input.byteLength) return invalid()
  const setup = readSetup(value.setup, contents, fresh)
  // Canonical bytes prohibit duplicate JSON keys, ignored fields and ambiguous encodings under one digest.
  if (JSON.stringify({ schemaVersion: 1, appId, version, setup, files }) !== header!) return invalid()
  const artifact: VerifiedApplicationArtifact = Object.freeze({ appId, version, descriptor, setup, files: Object.freeze(files), readFile: (path: string) => {
    const content = contents.get(path)
    return content ? Uint8Array.from(content) : invalid()
  } })
  verified.add(artifact)
  return artifact
}
function readSetup(value: unknown, contents: ReadonlyMap<string, Uint8Array>, fresh: (path: string) => boolean): Readonly<ApplicationArtifactSetup> {
  if (!object(value) || !exact(value, ['database', 'config']) || typeof value.database !== 'boolean') return invalid()
  if (value.config === null) return Object.freeze({ database: value.database, config: null })
  const config = value.config
  // The rendered config belongs to the site owner, so it can never also be a managed file.
  if (!object(config) || !exact(config, ['path', 'template']) || !isApplicationArtifactPath(config.path) || !isApplicationArtifactPath(config.template) || !fresh(config.path)
    || (contents.get(config.template)?.byteLength ?? Infinity) > APPLICATION_ARTIFACT_LIMITS.templateBytes) return invalid()
  return Object.freeze({ database: value.database, config: Object.freeze({ path: config.path, template: config.template }) })
}

export const isVerifiedApplicationArtifact = (value: unknown): value is VerifiedApplicationArtifact => !!value && typeof value === 'object' && verified.has(value)
