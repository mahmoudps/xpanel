import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { fail } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'

/**
 * One root-owned panel configuration file under `<state>/extended/panel/` (state in files, cPanel style):
 * a content revision, a parsed read that re-reads only when the file changed, and a revision-bound write.
 */
export interface PanelConfigFile<T> {
  readonly path: string
  /** Parsed saved value, the defaults when no file exists, or null when the saved file fails validation. */
  read(): Promise<{ raw: unknown; value: T | null }>
  /** The last good value for per-request effects; a missing or invalid file yields the defaults. */
  current(): Promise<T>
  write(next: T, expectedRevision: string, assertAuthority: () => Promise<void>): Promise<{ raw: unknown; value: T }>
}

const unchanged = { stateChanged: false }
export const panelConfigRevision = (namespace: string, raw: unknown): string =>
  createHash('sha256').update(JSON.stringify({ namespace, value: raw })).digest('hex')

const files = new Map<string, PanelConfigFile<unknown>>()

/** One instance per path, so the document renderer and the API routes share the cache in one process. */
export function panelConfigFile<T>(store: Pick<StateStore, 'rootDir' | 'getWriterLock'>, name: string, namespace: string,
  parse: (raw: unknown) => T | null, defaults: () => T): PanelConfigFile<T> {
  const path = `${store.rootDir}/extended/panel/${name}`
  const existing = files.get(path)
  if (existing) return existing as PanelConfigFile<T>
  let cached: { key: string; raw: unknown; value: T | null } | null = null
  const read = async (): Promise<{ raw: unknown; value: T | null }> => {
    let key = 'missing'
    try { const info = await stat(path); key = `${info.mtimeMs}:${info.size}:${info.ino}` }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (cached?.key === key) return cached
    let raw: unknown
    try { raw = await readJsonIfExists<unknown>(path) }
    catch { return fail('PRECONDITION_FAILED', 'the saved panel configuration cannot be read; review the file before retrying', unchanged) }
    const value = raw === null ? defaults() : parse(raw)
    cached = { key, raw, value }
    return cached
  }
  const file: PanelConfigFile<T> = {
    path,
    read,
    current: async () => { try { return (await read()).value ?? defaults() } catch { return defaults() } },
    write: async (next, expectedRevision, assertAuthority) => {
      const lease = await store.getWriterLock().acquire()
      try {
        await assertAuthority()
        const { raw, value } = await read()
        if (raw !== null && value === null) return fail('PRECONDITION_FAILED', 'the saved panel configuration requires review before it can be changed', unchanged)
        if (panelConfigRevision(namespace, raw) !== expectedRevision) return fail('CONFLICT', 'the configuration changed; reload before saving', unchanged)
        await lease.assertFencingToken()
        try {
          await atomicWriteJson(path, next, 0o640, async () => { await assertAuthority(); await lease.assertFencingToken() })
          cached = null
          const saved = await read()
          if (JSON.stringify(saved.raw) !== JSON.stringify(next) || saved.value === null) throw new Error('panel_config_readback_failed')
          return { raw: saved.raw, value: saved.value }
        } catch {
          cached = null
          return fail('SERVICE_UNAVAILABLE', 'the save could not be verified; reload before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
        }
      } finally { await lease.release() }
    },
  }
  files.set(path, file as PanelConfigFile<unknown>)
  return file
}

/** Strict small JSON body for the root configuration routes. */
export async function readPanelConfigBody(request: Request, limit = 16384): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const bytes = await readLimitedBody(request, limit)
  let value: unknown
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { return fail('VALIDATION', 'request body is not valid JSON', unchanged) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', 'request body must be a JSON object', unchanged)
  return value as Record<string, unknown>
}

export async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return fail('VALIDATION', 'a request body is required', unchanged)
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > limit) { await reader.cancel(); return fail('VALIDATION', 'the request body is too large', { ...unchanged, limitBytes: limit }) }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks)
}

export const panelJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
export const assertExpectedRevision = (value: unknown): string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : fail('VALIDATION', 'the observed configuration revision is required', unchanged)
export const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join() === [...keys].sort().join()
