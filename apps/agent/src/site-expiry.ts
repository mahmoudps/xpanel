import { join } from 'node:path'
import type { Domain } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'

/**
 * Nothing on a host changes when an expiry passes, so this asks for one reconcile then: rendering at that time
 * swaps the site to the stopped page. The ledger keeps a restart from repeating a reconcile or a reminder.
 */
export const SITE_EXPIRY_LEDGER = 'extended/site-expiry.json'
export const SITE_EXPIRY_INTERVAL_MS = 300_000
const DAY_MS = 86_400_000

/** Per domain id, the expiry that was already acted on; a new date acts again. */
interface Ledger { stopped: Record<string, string>; reminded: Record<string, string> }

export interface SiteExpiryDeps {
  root: string
  listDomains(): Promise<readonly Domain[]>
  reconcile(): Promise<unknown>
  sendAlert(to: string, subject: string, text: string): Promise<void>
  now?: () => number
}

const utc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`

export function createSiteExpiryMonitor(deps: SiteExpiryDeps): { tick(): Promise<void> } {
  const clock = deps.now ?? Date.now
  let next = 0, running = false
  return { async tick() {
    if (running || clock() < next) return
    running = true
    try {
      const now = clock()
      next = now + SITE_EXPIRY_INTERVAL_MS
      const path = join(deps.root, SITE_EXPIRY_LEDGER), saved = await readJsonIfExists<Partial<Ledger>>(path)
      const dated = (await deps.listDomains()).filter((domain): domain is Domain & { expiresAt: string } => domain.expiresAt !== null)
      const known = new Set(dated.map(domain => domain.id)), keep = (entries?: Record<string, string>) => Object.fromEntries(Object.entries(entries ?? {}).filter(([id]) => known.has(id)))
      const ledger: Ledger = { stopped: keep(saved?.stopped), reminded: keep(saved?.reminded) }
      const due = dated.filter(domain => Date.parse(domain.expiresAt) <= now && ledger.stopped[domain.id] !== domain.expiresAt)
      if (due.length) {
        await deps.reconcile()
        for (const domain of due) ledger.stopped[domain.id] = domain.expiresAt
      }
      for (const domain of dated) {
        const reminder = domain.site?.expiryReminder, left = Date.parse(domain.expiresAt) - now
        if (!reminder || left <= 0 || left > reminder.days * DAY_MS || ledger.reminded[domain.id] === domain.expiresAt) continue
        // A failed send stays unmarked, so the next run tries again.
        await deps.sendAlert(reminder.address, `Site ${domain.name} stops on ${utc(domain.expiresAt)}`, `The website ${domain.name} is set to stop on ${utc(domain.expiresAt)}. Change or clear the date on its Site settings page to keep it running.\n`).then(() => { ledger.reminded[domain.id] = domain.expiresAt }).catch(() => undefined)
      }
      if (JSON.stringify(ledger) !== JSON.stringify({ stopped: saved?.stopped ?? {}, reminded: saved?.reminded ?? {} })) await atomicWriteJson(path, ledger, 0o640)
    } finally { running = false }
  } }
}
