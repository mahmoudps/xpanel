import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { appendAudit } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { readSecRecord, SEC_DEFAULTS, SEC_STATE_PATHS } from '../../agent/src/sec-policy.ts'
import type { SecKind } from '../../agent/src/sec-policy.ts'

const PARTS = ['allowlist', 'entrance', 'response', 'basic-auth', 'stopped', 'temporary-logins', 'all'] as const
type Part = typeof PARTS[number]
const USAGE = `usage: xpanel panel-access show | reset <${PARTS.join('|')}>`

const read = async <K extends SecKind>(store: Pick<StateStore, 'rootDir'>, kind: K): Promise<typeof SEC_DEFAULTS[K]> => {
  let raw: unknown = null
  // The console repairs what the panel refuses: a broken file counts as defaults here.
  try { raw = await readJsonIfExists<unknown>(join(store.rootDir, SEC_STATE_PATHS[kind])) } catch { raw = null }
  return (raw === null ? null : readSecRecord(kind, raw)?.policy) ?? structuredClone(SEC_DEFAULTS[kind])
}
const write = (store: Pick<StateStore, 'rootDir'>, kind: SecKind, policy: unknown): Promise<void> =>
  atomicWriteJson(join(store.rootDir, SEC_STATE_PATHS[kind]), { version: 1, policy, updatedAt: new Date().toISOString() }, 0o640)

/** Root shell recovery of the panel gate. It writes the saved files directly, so it works while the API is down. */
export async function runPanelAccessCli(args: readonly string[], deps: { db: Db; store: StateStore; writeOut: (line: string) => void }): Promise<Record<string, unknown>> {
  const [verb, part, ...extra] = args, { store, writeOut } = deps
  if (verb === 'show' && part === undefined) {
    const access = await read(store, 'panel-access'), gate = await read(store, 'panel-gate'), links = await read(store, 'panel-temporary-logins')
    const now = Date.now(), active = links.logins.filter(link => !link.revokedAt && Date.parse(link.expiresAt) > now).length
    const view = { allowlistEntries: Object.fromEntries(Object.entries(access.listeners).map(([name, list]) => [name, list.length])), entrance: gate.entrance, response: gate.response, basicAuth: gate.basicAuth ? { username: gate.basicAuth.username, listeners: gate.basicAuth.listeners } : null, stopped: gate.stopped, activeTemporaryLinks: active }
    writeOut(JSON.stringify(view, null, 2))
    return view
  }
  if (verb !== 'reset' || !PARTS.includes(part as Part) || extra.length) return fail('VALIDATION', USAGE)
  const lease = await store.getWriterLock().acquire()
  try {
    if (part === 'allowlist' || part === 'all') await write(store, 'panel-access', structuredClone(SEC_DEFAULTS['panel-access']))
    if (part === 'temporary-logins' || part === 'all') {
      const at = new Date().toISOString()
      await write(store, 'panel-temporary-logins', { logins: (await read(store, 'panel-temporary-logins')).logins.map(link => ({ ...link, revokedAt: link.revokedAt ?? at })) })
    }
    if (part !== 'allowlist' && part !== 'temporary-logins') {
      const gate = await read(store, 'panel-gate'), defaults = structuredClone(SEC_DEFAULTS['panel-gate'])
      await write(store, 'panel-gate', part === 'all' ? defaults : { ...gate, ...(part === 'entrance' ? { entrance: null } : part === 'response' ? { response: defaults.response } : part === 'basic-auth' ? { basicAuth: null } : { stopped: [] }) })
    }
  } finally { await lease.release() }
  await appendAudit(deps.db, { actor: 'cli:root', action: 'server.panel_access.reset', target: 'server:panel-access', detail: { part }, outcome: 'ok' })
  writeOut(`Panel access reset: ${part}.`)
  return { reset: part }
}
