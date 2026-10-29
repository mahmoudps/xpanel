import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'

export const APPLICATION_ARTIFACT_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, decodedBytes: 24 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, files: 2048, path: 240 })
export interface ApplicationArtifactDescriptor { readonly format: 'xpanel-files-v1'; readonly sha256: string; readonly bytes: number }
export interface ApplicationArtifactFile { readonly path: string; readonly sha256: string; readonly bytes: number; readonly mode: '0644' }
export interface VerifiedApplicationArtifact {
  readonly appId: string
  readonly version: string
  readonly descriptor: Readonly<ApplicationArtifactDescriptor>
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

export function readApplicationArtifactDescriptor(value: unknown): Readonly<ApplicationArtifactDescriptor> {
  if (!object(value) || !exact(value, ['format', 'sha256', 'bytes']) || value.format !== 'xpanel-files-v1' || !isApplicationDigest(value.sha256)
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > APPLICATION_ARTIFACT_LIMITS.bytes) return invalid()
  return Object.freeze({ format: value.format, sha256: value.sha256, bytes: Number(value.bytes) })
}

/** No extraction, tar, URL, shell, root path, executable bit, link or device is accepted by this format. */
export function verifyApplicationArtifact(input: Uint8Array, expected: ApplicationArtifactDescriptor, appId: string, version: string): VerifiedApplicationArtifact {
  const descriptor = readApplicationArtifactDescriptor(expected)
  if (!(input instanceof Uint8Array) || input.byteLength !== descriptor.bytes || input.byteLength > APPLICATION_ARTIFACT_LIMITS.bytes
    || applicationDigest(input) !== descriptor.sha256 || !isApplicationId(appId) || !isApplicationVersion(version)) return invalid()
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)) } catch { return invalid() }
  if (!object(value) || !exact(value, ['schemaVersion', 'appId', 'version', 'files']) || value.schemaVersion !== 1 || value.appId !== appId || value.version !== version
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > APPLICATION_ARTIFACT_LIMITS.files) return invalid()
  let total = 0, previous = ''
  const contents = new Map<string, Buffer>(), folded = new Set<string>(), canonical: Record<string, unknown>[] = []
  const files = value.files.map((raw): Readonly<ApplicationArtifactFile> => {
    if (!object(raw) || !exact(raw, ['path', 'sha256', 'bytes', 'mode', 'contentBase64']) || !isApplicationArtifactPath(raw.path) || raw.path <= previous
      || !isApplicationDigest(raw.sha256) || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0 || Number(raw.bytes) > APPLICATION_ARTIFACT_LIMITS.fileBytes || raw.mode !== '0644'
      || typeof raw.contentBase64 !== 'string' || raw.contentBase64.length > Math.ceil(APPLICATION_ARTIFACT_LIMITS.fileBytes / 3) * 4) return invalid()
    const path = raw.path, lower = path.toLowerCase()
    // A path cannot alias another file or serve as a directory for one, even on case-folding providers.
    if (folded.has(lower) || [...folded].some(item => item.startsWith(lower + '/') || lower.startsWith(item + '/'))) return invalid()
    previous = path; folded.add(lower)
    const bytes = Buffer.from(raw.contentBase64, 'base64')
    if (bytes.toString('base64') !== raw.contentBase64 || bytes.length !== raw.bytes || applicationDigest(bytes) !== raw.sha256) return invalid()
    total += bytes.length
    if (total > APPLICATION_ARTIFACT_LIMITS.decodedBytes) return invalid()
    contents.set(path, bytes)
    canonical.push({ path, sha256: raw.sha256, bytes: bytes.length, mode: '0644', contentBase64: raw.contentBase64 })
    return Object.freeze({ path, sha256: raw.sha256, bytes: bytes.length, mode: '0644' })
  })
  // Canonical bytes prohibit duplicate JSON keys, ignored fields and ambiguous encodings under one digest.
  if (JSON.stringify({ schemaVersion: 1, appId, version, files: canonical }) !== new TextDecoder().decode(input)) return invalid()
  const artifact: VerifiedApplicationArtifact = Object.freeze({ appId, version, descriptor, files: Object.freeze(files), readFile: (path: string) => {
    const content = contents.get(path)
    return content ? Uint8Array.from(content) : invalid()
  } })
  verified.add(artifact)
  return artifact
}

export const isVerifiedApplicationArtifact = (value: unknown): value is VerifiedApplicationArtifact => !!value && typeof value === 'object' && verified.has(value)
