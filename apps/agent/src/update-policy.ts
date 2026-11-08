import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  backupScheduleDue, defaultMaintenanceSchedule, defaultUpdatePreferences, heldByMajorDelay, parseBackupCron, selectAutomaticUpdate, SERVER_OPERATIONS_STATE, validateMaintenanceSchedule, validateUpdatePreferences,
} from '@xpanel/core'
import type { UpdatePreferences } from '@xpanel/core'
import { getPrincipal } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { atomicWriteJson } from '@xpanel/state'
import { handleUpgradeRoute } from './upgrade-routes.ts'
import type { UpgradeCoordinator } from './upgrade-routes.ts'

export interface UpdateLedger { lastRunAt: string; lastSecurityAt: string; outcome: string; target: string | null; firstSeen?: Record<string, string> }
const HOUR_MS = 3_600_000

const readJson = async (path: string): Promise<unknown> => { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null } }

export interface UpdaterDeps {
  rootDir: string
  db: Db
  coordinator: UpgradeCoordinator
  now?: () => Date
  readPrincipal?: (id: string) => Promise<{ disabled: boolean; kind: string; username: string } | null>
  /** The upgrade route itself by default, so the updater passes every preflight, lock and signature check an operator does. */
  call?: (owner: NonNullable<UpdatePreferences['owner']>, path: string, body?: Record<string, string>) => Promise<Response>
}

/**
 * The panel updater (cPanel upcp). Saved schedule and preferences decide when and how far; a release is only ever taken from
 * the verified staged releases, handed off as the root principal who saved the preferences, and every result is left in the ledger.
 */
export function createUpdater(deps: UpdaterDeps): { tick(): Promise<{ started: string } | { skipped: string }> } {
  const now = deps.now ?? (() => new Date())
  const ledgerPath = join(deps.rootDir, SERVER_OPERATIONS_STATE.updateLedger)
  const call = deps.call ?? ((owner, path, body) => {
    const url = new URL('http://agent.local' + path), caller = { principalId: owner.principalId, actor: owner.username, role: 'root' }
    const request = new Request(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
    return handleUpgradeRoute(request, url, body ? 'POST' : 'GET', { db: deps.db, caller, authenticate: async () => caller, assertRootCaller: async () => {}, coordinator: deps.coordinator }) as Promise<Response>
  })
  let busy = false
  const tick = async (): Promise<{ started: string } | { skipped: string }> => {
    const at = now(), stamp = at.toISOString()
    let prefs = defaultUpdatePreferences(), cron = defaultMaintenanceSchedule().updater
    try {
      const saved = await readJson(join(deps.rootDir, SERVER_OPERATIONS_STATE.updates)), schedule = await readJson(join(deps.rootDir, SERVER_OPERATIONS_STATE.maintenance))
      if (saved !== null) prefs = validateUpdatePreferences(saved)
      if (schedule !== null) cron = validateMaintenanceSchedule(schedule).updater
    } catch { return { skipped: 'invalid_preferences' } }
    if (prefs.updates === 'manual' && !prefs.securityPatches) return { skipped: 'disabled' }
    const ledger = await readJson(ledgerPath) as UpdateLedger | null
    const write = async (next: Partial<UpdateLedger>): Promise<void> => atomicWriteJson(ledgerPath, { lastRunAt: ledger?.lastRunAt ?? stamp, lastSecurityAt: ledger?.lastSecurityAt ?? stamp, outcome: 'armed', target: null, ...(ledger?.firstSeen ? { firstSeen: ledger.firstSeen } : {}), ...next })
    if (!ledger) { await write({}); return { skipped: 'armed' } }
    const scheduled = backupScheduleDue(parseBackupCron(cron), new Date(ledger.lastRunAt), at) !== null
    // cPanel's hourly security job: inside major.minor only, whatever the tier and the schedule.
    const hourly = prefs.securityPatches && at.getTime() - Date.parse(ledger.lastSecurityAt) >= HOUR_MS
    if (!scheduled && !hourly) return { skipped: 'not_due' }
    const stampNext = { ...(scheduled ? { lastRunAt: stamp } : {}), ...(hourly ? { lastSecurityAt: stamp } : {}) }
    const owner = prefs.owner
    const principal = owner ? await (deps.readPrincipal ?? (id => getPrincipal(deps.db, id)))(owner.principalId) : null
    if (!owner || !principal || principal.disabled || principal.kind !== 'root' || principal.username !== owner.username) { await write({ ...stampNext, outcome: 'owner_unavailable' }); return { skipped: 'owner_unavailable' } }
    const observed = await (await call(owner, '/host/upgrade')).json() as { revision?: unknown; current?: { version?: unknown }; availability?: { candidates?: unknown } }
    const candidates = Array.isArray(observed.availability?.candidates) ? observed.availability.candidates.filter((item): item is string => typeof item === 'string') : []
    const firstSeen = { ...Object.fromEntries(candidates.map(version => [version, ledger.firstSeen?.[version] ?? stamp])) }
    const held = typeof observed.current?.version === 'string' ? heldByMajorDelay(observed.current.version, candidates, ledger.firstSeen ?? {}, prefs.majorDelayDays, at) : []
    const target = typeof observed.current?.version === 'string' ? selectAutomaticUpdate(observed.current.version, candidates.filter(version => !held.includes(version)), scheduled ? prefs : { ...prefs, updates: 'manual' }) : null
    if (!target || typeof observed.revision !== 'string') { await write({ ...stampNext, firstSeen, outcome: held.length ? 'major_delayed' : 'no_update' }); return { skipped: held.length ? 'major_delayed' : 'no_update' } }
    const started = await call(owner, '/host/upgrade/start', { targetVersion: target, expectedRevision: observed.revision, confirm: `upgrade ${target}` })
    await write({ ...stampNext, firstSeen, outcome: started.status === 202 ? 'started' : `refused_${started.status}`, target })
    return started.status === 202 ? { started: target } : { skipped: 'refused' }
  }
  return {
    /** Timer entry point (ROOT calls it about once a minute). Never throws; a refused start is recorded and tried on the next run. */
    async tick() {
      if (busy) return { skipped: 'busy' }
      busy = true
      try { return await tick() } catch { return { skipped: 'failed' } } finally { busy = false }
    },
  }
}
