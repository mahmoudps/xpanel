// Explicit diagnostic fixtures only. Never import this module from a production entry point.
import type { Account } from '../../packages/core/src/types.ts'
import type { WebStatsView } from '../../apps/web/src/models/web-stats.ts'

const account: Account = { id: '0f8c9a52-6c55-4a43-9f1e-3b2a1c4d5e6f', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example', planId: 'plan', ownerId: null,
  status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-10-29T00:00:00Z' }
const run = { state: 'updated' as const, at: '2026-11-07T01:00:00.000Z' }
const view: WebStatsView = {
  context: { accountId: account.id, username: account.username },
  observedAt: '2026-11-07T13:00:00.000Z',
  engines: { analog: { installed: true, entitled: true }, awstats: { installed: true, entitled: true }, webalizer: { installed: true, entitled: true } },
  geoip: { installed: true, month: '2026-11', source: 'DB-IP IP to Country Lite' },
  schedule: { intervalHours: 24, lastRunAt: '2026-11-07T01:00:00.000Z', nextRunAt: '2026-11-08T01:00:00.000Z' },
  choice: { choosable: ['analog', 'awstats', 'webalizer'], revision: 'a'.repeat(64) },
  sites: [{ site: 'alice.example', names: ['alice.example', 'www.alice.example'], selected: ['analog', 'awstats', 'webalizer'], schemes: {
    http: { awstats: run, webalizer: run, droppedLines: 0, lostBytes: 0, pendingBytes: 4096 },
    https: { awstats: null, webalizer: { state: 'failed', at: run.at, reason: 'exit 1' }, droppedLines: 2, lostBytes: 0, pendingBytes: 0 },
  } }],
  selection: { site: 'alice.example', scheme: 'http', month: '2026-11' },
  months: [{ month: '2026-11', visits: 12, unique: 10, pages: 40, hits: 90, bytes: 81920, lastUpdate: '2026-11-07T01:00:00Z' }, { month: '2026-10', visits: 300, unique: 210, pages: 900, hits: 2100, bytes: 9437184, lastUpdate: '2026-10-31T23:59:00Z' }],
  report: {
    month: '2026-11', visits: 12, unique: 10, pages: 40, hits: 90, bytes: 81920, lastUpdate: '2026-11-07T01:00:00Z',
    days: [['2026-11-05', 10, 20, 20480, 3], ['2026-11-06', 30, 70, 61440, 9]], hours: [[9, 20, 40, 40960], [21, 20, 50, 40960]],
    countries: [['de', 25, 60, 61440], ['ip', 15, 30, 20480]], os: [['linuxubuntu', 50]], browsers: [['firefox131', 40]], status: [['404', 5, 1024]],
    urls: [['/shop/', 30, 61440, 8, 6]], referrers: [['https://search.example/', 4, 6]], robots: [['googlebot', 12, 4096]],
  },
}
export const WEB_STATS_FIXTURE = { account, view }
