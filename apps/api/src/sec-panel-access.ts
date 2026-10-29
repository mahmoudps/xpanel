import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readSecRecord, SEC_PANEL_ACCESS_STATE, secPanelAccessAdmits } from '../../agent/src/sec-policy.ts'
import type { SecListener, SecPanelAccessPolicy } from '../../agent/src/sec-policy.ts'

// One stat per request; the file is re-parsed only when its inode, size or mtime changes (atomic saves rename a new inode).
const cache = new Map<string, { key: string; policy: SecPanelAccessPolicy | null }>()

/**
 * Request-pipeline gate for the 2083/2087/2096 entry points. `client` must be the socket or trusted-ingress address
 * (server.ts extractClientIp), never a browser-chosen header. It is resolved only when the listener has an allowlist, so an
 * open listener never depends on forwarded identity. An absent file admits everyone; an unreadable or non-canonical file
 * denies every address until it is repaired from the console (fail closed for an access control).
 */
export async function secPanelAccessGate(rootDir: string, listener: SecListener, client: string | null | (() => string | null)): Promise<boolean> {
  const file = join(rootDir, SEC_PANEL_ACCESS_STATE)
  let key: string
  try { const facts = await stat(file); key = `${facts.ino}:${facts.size}:${facts.mtimeMs}` }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { cache.delete(rootDir); return true } return false }
  let entry = cache.get(rootDir)
  if (entry?.key !== key) {
    let policy: SecPanelAccessPolicy | null = null
    try { const text = await readFile(file, 'utf8'); policy = text.length <= 256 * 1024 ? readSecRecord('panel-access', JSON.parse(text))?.policy ?? null : null } catch { policy = null }
    entry = { key, policy }
    cache.set(rootDir, entry)
  }
  if (!entry.policy) return false
  return entry.policy.listeners[listener].length === 0 || secPanelAccessAdmits(entry.policy, listener, typeof client === 'function' ? client() : client)
}
