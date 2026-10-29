// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWhmBackupRetentionPlan, readWhmBackupRunsView, WHM_BACKUP_RUNS_CLIENT_BINDING } from './acct-backup-runs-client.ts'
import { renderWhmBackupRunsWorkspace } from './board-port/acct-backup-runs-workspace.ts'
import { renderWhmBackupDestinationsWorkspace } from './board-port/whm-backup-destinations-workspace.ts'

const ID = '11111111-1111-4111-8111-111111111111', RUN = '33333333-3333-4333-8333-333333333333', FILE = 'xpanel-backup-alice-20261028T020000Z.tar.gz'
const entry = { username: 'alice', destinationId: ID, file: FILE, bytes: 2048, sha256: 'a'.repeat(64), outcome: 'verified', reason: null }
const run = { id: RUN, trigger: 'schedule', actor: 'scheduler', startedAt: '2026-10-28T02:00:30.000Z', finishedAt: '2026-10-28T02:05:00.000Z', state: 'succeeded', destinationIds: [ID], accounts: 1, mailIncluded: true, databasesIncluded: false, entries: [entry], retention: [{ destinationId: ID, deleted: 2, outcome: 'verified' }] }
const view = (over: Record<string, unknown> = {}) => ({ available: true, reason: null, revision: 'b'.repeat(64), schedule: { enabled: true, cron: '0 2 * * *', nextRunAt: '2026-10-29T02:00:00.000Z', lastScheduledAt: '2026-10-28T02:00:30.000Z' }, activeId: null, runs: [run], recoveries: [], nativeQualified: false, ...over })
const lifecycle = { revision: 'c'.repeat(64), destinations: [{ id: ID, name: 'Offsite', effectiveActive: true }] }
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = (send: unknown, canManage = true, ask?: unknown) => {
  document.body.innerHTML = renderWhmBackupRunsWorkspace({ locale: 'en', canManage })
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  ;(new Function('return ' + WHM_BACKUP_RUNS_CLIENT_BINDING)() as (ask: unknown) => void)(ask)
}
afterEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('backup runs client', () => {
  it('renders every section with strict spacing and nests inside the destinations page in both directions', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmBackupDestinationsWorkspace({ locale, canManage: true })
      expect(html).toContain('data-whm-backup-runs'); expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`)
      for (const marker of ['data-backup-runs-start', 'data-backup-runs-rows="copies"', 'data-backup-runs-rows="recoveries"', 'data-backup-retention-apply', 'gap:32px', 'gap:24px', 'gap:16px', 'gap:8px']) expect(html).toContain(marker)
    }
  })
  it('rejects fake success, foreign archive names and inconsistent active state', () => {
    expect(readWhmBackupRunsView(view()).runs[0]!.entries[0]!.outcome).toBe('verified')
    for (const raw of [view({ nativeQualified: true }), view({ available: true, reason: 'no_provider' }), view({ runs: [{ ...run, entries: [{ ...entry, outcome: 'failed', reason: 'readback_mismatch' }] }] }),
      view({ runs: [{ ...run, entries: [{ ...entry, file: 'xpanel-backup-bob-20261028T020000Z.tar.gz' }] }] }), view({ runs: [{ ...run, state: 'running', finishedAt: null }] }), view({ runs: [{ ...run, databasesIncluded: true }] })])
      expect(() => readWhmBackupRunsView(raw)).toThrow()
    const row = { name: 'alice/' + FILE, username: 'alice', createdAt: '2026-10-28T02:00:00.000Z', bytes: 1, action: 'keep', reason: 'newest' }
    expect(readWhmBackupRetentionPlan({ destinationId: ID, planDigest: 'd'.repeat(64), rows: [row] }, ID).rows).toHaveLength(1)
    expect(() => readWhmBackupRetentionPlan({ destinationId: ID, planDigest: 'd'.repeat(64), rows: [{ ...row, action: 'delete' }] }, ID)).toThrow()
  })
  it('paints history and verified copies, then starts a run only after confirmation with both revisions', async () => {
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? path.endsWith('/runs') ? view() : lifecycle : { runId: RUN, state: 'running' })
    const ask = vi.fn(async () => true)
    boot(send, true, ask); await settle()
    expect(document.querySelector('[data-backup-runs-fact="schedule"]')!.textContent).toBe('0 2 * * *')
    expect(document.querySelector('[data-backup-runs-rows="runs"]')!.textContent).toContain('1 of 1')
    expect(document.querySelector('[data-backup-runs-rows="copies"] bdi[dir="ltr"]')!.textContent).toBe('alice')
    const start = document.querySelector<HTMLButtonElement>('[data-backup-runs-start]')!
    expect(start.disabled).toBe(false)
    start.click(); await settle()
    expect(send).toHaveBeenCalledWith('POST', '/api/backups/workspace/runs', { expectedRevision: 'c'.repeat(64), expectedRunsRevision: 'b'.repeat(64) })
  })
  it('shows each unavailable reason and keeps run now disabled', async () => {
    const send = vi.fn(async (_method: string, path: string) => path.endsWith('/runs') ? view({ available: false, reason: 'no_provider' }) : lifecycle)
    boot(send); await settle()
    expect(document.querySelector('[data-backup-runs-status]')!.textContent).toContain('S3-compatible credential profile')
    expect(document.querySelector<HTMLButtonElement>('[data-backup-runs-start]')!.disabled).toBe(true)
    const missing = vi.fn(async (_method: string, path: string) => { if (path.endsWith('/runs')) throw Object.assign(new Error('x'), { status: 412 }); return lifecycle })
    boot(missing); await settle()
    expect(document.querySelector('[data-backup-runs-status]')!.getAttribute('data-state')).toBe('unavailable')
  })
  it('does not fetch on a denied page and marks a lost mutation for review', async () => {
    const denied = vi.fn(); boot(denied, false); await settle()
    expect(denied).not.toHaveBeenCalled()
    expect(document.querySelector('[data-backup-runs-status]')!.textContent).toBe('Backup run management is unavailable here.')
    const send = vi.fn(async (method: string, path: string) => { if (method === 'POST') throw new Error('network'); return path.endsWith('/runs') ? view() : lifecycle })
    boot(send, true, async () => true); await settle()
    document.querySelector<HTMLButtonElement>('[data-backup-recover]')!.click(); await settle()
    expect(send).toHaveBeenCalledWith('POST', '/api/backups/workspace/destinations/' + ID + '/recover', { expectedRevision: 'c'.repeat(64), expectedRunsRevision: 'b'.repeat(64), runId: RUN, username: 'alice', file: FILE })
    expect(document.querySelector('[data-backup-runs-status]')!.getAttribute('data-state')).toBe('review')
    expect(document.querySelector<HTMLButtonElement>('[data-backup-runs-start]')!.disabled).toBe(true)
  })
  it('previews retention and deletes only with the reviewed plan digest', async () => {
    const plan = { destinationId: ID, planDigest: 'd'.repeat(64), retentionDays: 30, retentionCount: 7, rows: [{ name: 'alice/xpanel-backup-alice-20260901T020000Z.tar.gz', username: 'alice', createdAt: '2026-09-01T02:00:00.000Z', bytes: 10, action: 'delete', reason: 'expired' }] }
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? path.endsWith('/retention') ? plan : path.endsWith('/runs') ? view() : lifecycle : { destinationId: ID, deleted: [plan.rows[0]!.name], outcome: 'verified' })
    boot(send, true, async () => true); await settle()
    const apply = document.querySelector<HTMLButtonElement>('[data-backup-retention-apply]')!
    expect(apply.disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-backup-retention-preview]')!.click(); await settle()
    expect(document.querySelector('[data-backup-retention-status]')!.textContent).toBe('1 archive is due for deletion.')
    apply.click(); await settle()
    expect(send).toHaveBeenCalledWith('POST', '/api/backups/workspace/destinations/' + ID + '/retention', { expectedRevision: 'c'.repeat(64), expectedPlanDigest: 'd'.repeat(64) })
    expect(document.querySelector('[data-backup-retention-status]')!.getAttribute('data-state')).toBe('saved')
  })
})
