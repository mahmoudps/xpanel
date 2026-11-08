import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readSecRecord, SEC_DEFAULTS, SEC_STATE_PATHS, secPanelAccessAdmits } from '../../agent/src/sec-policy.ts'
import type { SecKind, SecListener, SecRecord } from '../../agent/src/sec-policy.ts'

// One stat per request; the file is re-parsed only when its inode, size or mtime changes (atomic saves rename a new inode).
const cache = new Map<string, { key: string; record: unknown }>()

/** undefined: no file. null: unreadable or non-canonical, which every caller here treats as closed. */
export async function cachedSecRecord<K extends SecKind>(rootDir: string, kind: K): Promise<SecRecord<typeof SEC_DEFAULTS[K]> | null | undefined> {
  const file = join(rootDir, SEC_STATE_PATHS[kind]), slot = `${rootDir}\0${kind}`
  let key: string
  try { const facts = await stat(file); key = `${facts.ino}:${facts.size}:${facts.mtimeMs}` }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { cache.delete(slot); return undefined } return null }
  let entry = cache.get(slot)
  if (entry?.key !== key) {
    let record: unknown = null
    try { const text = await readFile(file, 'utf8'); record = text.length <= 256 * 1024 ? readSecRecord(kind, JSON.parse(text)) : null } catch { record = null }
    entry = { key, record }
    cache.set(slot, entry)
  }
  return entry.record as SecRecord<typeof SEC_DEFAULTS[K]> | null
}

/**
 * Request-pipeline gate for the 2083/2087/2096 entry points. `client` must be the socket or trusted-ingress address
 * (server.ts extractClientIp), never a browser-chosen header. It is resolved only when the listener has an allowlist, so an
 * open listener never depends on forwarded identity. An absent file admits everyone; an unreadable or non-canonical file
 * denies every address until it is repaired from the console (fail closed for an access control).
 */
export async function secPanelAccessGate(rootDir: string, listener: SecListener, client: string | null | (() => string | null)): Promise<boolean> {
  const record = await cachedSecRecord(rootDir, 'panel-access')
  if (record === undefined) return true
  if (!record) return false
  return record.policy.listeners[listener].length === 0 || secPanelAccessAdmits(record.policy, listener, typeof client === 'function' ? client() : client)
}
