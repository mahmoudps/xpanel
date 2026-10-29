// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmUpgradeWorkspace } from './board-port/whm-upgrade-workspace.ts'
import { readUpgradeObservationView, readUpgradePreflightView, readUpgradeStartView, readUpgradeStatusView, WHM_UPGRADE_CLIENT_BINDING } from './whm-upgrade-client.ts'

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const revision = 'b'.repeat(64)
const observation = (start = { enabled: true, reasons: [] as string[] }) => ({
  observedAt: '2026-10-27T10:00:00.000Z', revision,
  current: { state: 'read', version: '1.0.0', releasePath: '/opt/xpanel/releases/1.0.0' }, schemaVersion: 42,
  os: { id: 'ubuntu', versionId: '24.04', prettyName: 'Ubuntu 24.04 LTS' }, freeBytes: 53687091200, freeBytesPath: '/opt/xpanel', activeTransfers: 0,
  lock: { present: false, state: null, to: null, at: null }, retirementPending: false, maintenance: false, lastUpgrade: null, rewind: null,
  trust: { state: 'configured', keysConfigured: 1, keyIds: ['xpanel-release-2026'], source: '/etc/xpanel/release-keys.json', reason: null },
  staged: { directory: '/opt/xpanel/downloads', state: 'read', truncated: false, releases: [
    { manifest: 'xpanel-1.1.0.manifest.json', version: '1.1.0', schemaVersion: 43, bytes: 104857600, sha256: 'c'.repeat(64), keyId: 'xpanel-release-2026', signatureState: 'verified', reason: null },
    { manifest: 'xpanel-1.2.0.manifest.json', version: '1.2.0', schemaVersion: 44, bytes: 104857600, sha256: 'd'.repeat(64), keyId: 'other', signatureState: 'unverified', reason: 'untrusted-key' },
  ] },
  coordinator: { available: start.enabled, reason: start.enabled ? null : 'upgrade-coordinator-unavailable' },
  availability: { preflight: { enabled: true, reasons: [] }, start, candidates: ['1.1.0'] }, snapshotsDir: '/var/lib/xpanel-lifecycle/backups',
})
const checks = [
  { id: 'disk-space', ok: true, message: 'enough space', detail: { free: 53687091200, release: 104857600, required: 209715200 } },
  { id: 'os-supported', ok: true, message: 'supported', detail: { id: 'ubuntu', versionId: '24.04', supported: ['Ubuntu 22.04/24.04'] } },
  { id: 'no-active-transfer', ok: true, message: 'none', detail: { active: 0 } },
  { id: 'version-newer', ok: true, message: '1.0.0 -> 1.1.0', detail: { current: '1.0.0', target: '1.1.0' } },
  { id: 'schema-compatible', ok: true, message: 'schema 42 -> 43', detail: { current: 42, target: 43 } },
]
const preflight = (startEnabled = true) => ({ observedAt: '2026-10-27T10:01:00.000Z', revision, targetVersion: '1.1.0', fromVersion: '1.0.0', report: { ok: true, checks }, start: startEnabled ? { enabled: true, reasons: [] } : { enabled: false, reasons: ['upgrade-coordinator-unavailable'] } })
const status = () => ({ observedAt: '2026-10-27T10:00:00.000Z', revision, lock: { present: false, state: null, to: null, at: null }, retirementPending: false, maintenance: false, current: { state: 'read', version: '1.0.0', releasePath: '/opt/xpanel/releases/1.0.0' }, rewind: null, latest: null, history: [] })
const accepted = { accepted: true, handoffId: '11111111-1111-4111-8111-111111111111', upgradeId: null, targetVersion: '1.1.0', fromVersion: '1.0.0' }

beforeEach(() => {
  const { main, aside } = renderWhmUpgradeWorkspace({ locale: 'en', canManage: true, hostname: 'srv.example.test' })
  document.body.innerHTML = `<section data-whm-detail-route="/whm/server/upgrade" data-capability-state="authorized">${main}${aside}</section>`
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'
})
const boot = (send?: (method: string, path: string, body?: unknown) => Promise<unknown>) => { if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + WHM_UPGRADE_CLIENT_BINDING)()() }
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!

describe('WHM upgrade readers', () => {
  it('accept only coherent host observations', () => {
    expect(readUpgradeObservationView(observation()).availability.candidates).toEqual(['1.1.0'])
    expect(() => readUpgradeObservationView({ ...observation(), availability: { ...observation().availability, candidates: ['1.2.0'] } })).toThrow()
    expect(() => readUpgradeObservationView({ ...observation(), availability: { ...observation().availability, preflight: { enabled: true, reasons: ['no-trusted-release-keys'] } } })).toThrow()
    expect(() => readUpgradeObservationView({ ...observation(), trust: { ...observation().trust, state: 'missing' } })).toThrow()
    expect(() => readUpgradeObservationView({ ...observation(), current: { state: 'read', version: '<b>', releasePath: null } })).toThrow()
    expect(readUpgradePreflightView(preflight()).report.checks[1]!.detail).toEqual({ id: 'ubuntu', versionId: '24.04' })
    expect(() => readUpgradePreflightView({ ...preflight(), report: { ok: true, checks: [{ ...checks[0]!, ok: false }] } })).toThrow()
    expect(readUpgradeStartView(accepted).handoffId).toBe(accepted.handoffId)
    expect(() => readUpgradeStartView({ ...accepted, accepted: false })).toThrow()
    expect(readUpgradeStatusView(status()).history).toEqual([])
    expect(() => readUpgradeStatusView({ ...status(), latest: { id: 'x' } })).toThrow()
    const rewind = { state: 'rewind-unknown', done: ['release'], problems: ['canary alice served by uid 33 instead of 1001'], updatedAt: '2026-10-27T10:00:00.000Z' }
    expect(readUpgradeStatusView({ ...status(), rewind }).rewind).toEqual(rewind)
    for (const bad of [{ ...rewind, state: 'restored' }, { ...rewind, done: ['reboot'] }, { ...rewind, problems: ['‮spoof'] }, { ...rewind, updatedAt: 'yesterday' }]) {
      expect(() => readUpgradeStatusView({ ...status(), rewind: bad })).toThrow('invalid_upgrade_rewind')
    }
    expect(() => readUpgradeObservationView({ ...observation(), rewind: undefined })).toThrow()
  })
})

describe('WHM upgrade rewind states', () => {
  const failed = {
    id: '11111111-1111-4111-8111-111111111111', fromVersion: '1.0.0', toVersion: '1.1.0', fromSchemaVersion: 42, toSchemaVersion: null,
    status: 'running', phase: 'rollback', error: null, actor: 'root', createdAt: '2026-10-27T09:00:00.000Z', startedAt: '2026-10-27T09:00:01.000Z', finishedAt: null,
  }
  const done = ['release', 'state-extract', 'state-swap', 'index', 'units', 'start-panel']
  it.each([
    [{ state: 'rewind-started', done: done.slice(0, 2), problems: [] }, 'running', 'Rewinding the failed upgrade to its snapshot: 2 of 6 steps restored.'],
    [{ state: 'rewind-verified', done, problems: [] }, 'read', 'The failed upgrade was rewound: the release, state files, index and units were restored from the snapshot and verified.'],
    [{ state: 'rewind-unknown', done, problems: ['canary alice served by uid 33 instead of 1001'] }, 'failed', 'Rewind unverified, operator action required: canary alice served by uid 33 instead of 1001'],
    [{ state: 'rewind-failed', done: done.slice(0, 3), problems: ['rewind:index: reindex refused'] }, 'failed', 'Rewind failed, operator action required. 3 of 6 steps restored: rewind:index: reindex refused'],
    [{ state: 'unreadable', done: [], problems: [] }, 'failed', 'The rewind journal could not be read, operator action required.'],
  ])('shows %j as read-only progress', async (journal, state, text) => {
    const rewind = { ...journal, updatedAt: journal.state === 'unreadable' ? null : '2026-10-27T09:05:00.000Z' }
    const send = vi.fn(async (_method: string, path: string) => path.endsWith('/status')
      ? { ...status(), lock: { present: true, state: 'rollback-failed', to: '1.1.0', at: '2026-10-27T09:05:00.000Z' }, retirementPending: true, rewind, latest: failed, history: [failed] }
      : { ...observation({ enabled: false, reasons: ['upgrade-lock-present'] }), rewind, lastUpgrade: failed })
    boot(send); await tick()
    const progress = $('[data-upgrade-progress]')
    expect(progress.textContent).toBe(text)
    expect(progress.dataset.state).toBe(state)
    expect(progress.getAttribute('role')).toBe(state === 'failed' ? 'alert' : 'status')
    // Reading rewind states never writes: only the two GETs were sent.
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
})

describe('WHM upgrade binding', () => {
  it.each([
    { locale: 'en', finished: true }, { locale: 'ar', finished: true },
    { locale: 'en', finished: false }, { locale: 'ar', finished: false },
  ] as const)('renders readable UTC dates without losing source precision in loaded history and current release ($locale, finished: $finished)', async ({ locale, finished }) => {
    const { main, aside } = renderWhmUpgradeWorkspace({ locale, canManage: true, hostname: 'srv.example.test' })
    document.body.innerHTML = `<section data-whm-detail-route="/whm/server/upgrade" data-capability-state="authorized">${main}${aside}</section>`
    const completed = {
      id: '11111111-1111-4111-8111-111111111111', fromVersion: '0.9.0', toVersion: '1.0.0', fromSchemaVersion: 41, toSchemaVersion: 42,
      status: 'succeeded', phase: 'health-check', error: null, actor: 'root', createdAt: '2026-10-27T09:00:00.123456Z',
      startedAt: '2026-10-27T09:01:02.234567Z', finishedAt: finished ? '2026-10-27T09:03:04.345678Z' : null,
    }
    const createdOnly = { ...completed, id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-26T18:07:08.987654Z', startedAt: null, finishedAt: null }
    const send = vi.fn(async (_method: string, path: string) => path.endsWith('/status')
      ? { ...status(), latest: completed, history: [completed, createdOnly] }
      : { ...observation(), lastUpgrade: completed })
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    boot(send); await tick()
    expect($('[data-upgrade-progress]').textContent).toBe(locale === 'ar' ? 'حالة آخر ترقية: اكتمل.' : 'The last upgrade is Done.')

    const historyTimes = [...document.querySelectorAll<HTMLElement>('[data-upgrade-history] tr td:nth-child(3) > bdi')]
    expect(historyTimes.map(node => node.textContent)).toEqual(['2026-10-27 09:01 UTC', '2026-10-26 18:07 UTC'])
    expect(historyTimes.map(node => node.dir)).toEqual(['ltr', 'ltr'])
    const since = $('[data-upgrade-fact="current-since"]')
    expect(since.textContent).toBe(finished ? '2026-10-27 09:03 UTC' : '2026-10-27 09:00 UTC')
    expect(since.tagName).toBe('BDI'); expect(since.dir).toBe('ltr')
    const sourceHistory = readUpgradeStatusView({ ...status(), latest: completed, history: [completed, createdOnly] }).history
    expect(sourceHistory.map(row => row.startedAt ?? row.createdAt)).toEqual(['2026-10-27T09:01:02.234567Z', '2026-10-26T18:07:08.987654Z'])
    expect(document.body.textContent).not.toContain(completed.id)
    expect(document.body.textContent).not.toContain(createdOnly.id)
    expect(send.mock.calls.map(call => call[0])).toEqual(['GET', 'GET'])
  })

  it('makes no request without transport or admission', async () => {
    boot(); expect($('[data-upgrade-banner]').dataset.state).toBe('unavailable')
    $('[data-whm-upgrade-workspace]').removeAttribute('data-upgrade-bound')
    $('[data-whm-upgrade-workspace]').dataset.upgradeCanManage = 'false'
    const send = vi.fn(); boot(send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect($<HTMLButtonElement>('[data-upgrade-preflight]').disabled).toBe(true)
  })

  it('reads, preflights with only target and revision, then starts after the exact typed confirmation', async () => {
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? (path.endsWith('/status') ? status() : observation()) : path.endsWith('/preflight') ? preflight() : accepted)
    boot(send); await tick()
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/server/upgrade'], ['GET', '/api/server/upgrade/status']])
    expect($('[data-upgrade-fact="current-version"]').textContent).toBe('1.0.0')
    expect($('[data-upgrade-fact="available-version"]').textContent).toBe('1.1.0')
    expect($<HTMLSelectElement>('[data-upgrade-target]').value).toBe('1.1.0')
    expect($('[data-upgrade-staged]').textContent).toContain('Signed by a key that is not trusted.')
    expect($<HTMLButtonElement>('[data-upgrade-open-confirm]').disabled).toBe(true)
    $<HTMLButtonElement>('[data-upgrade-preflight]').click(); await tick()
    expect(send.mock.calls[2]).toEqual(['POST', '/api/server/upgrade/preflight', { targetVersion: '1.1.0', expectedRevision: revision }])
    expect($('[data-upgrade-preflight-summary]').textContent).toContain('5 of 5 passed')
    expect($('[data-upgrade-check="disk-space"] [data-upgrade-check-detail]').textContent).toBe('200.0 MB needed on /opt/xpanel, 50.0 GB free')
    $<HTMLButtonElement>('[data-upgrade-open-confirm]').click()
    const phrase = $<HTMLInputElement>('[data-upgrade-confirm-input]')
    expect(phrase.disabled).toBe(false)
    expect($<HTMLButtonElement>('[data-upgrade-start]').disabled).toBe(true)
    phrase.value = 'upgrade 1.1.0'; phrase.dispatchEvent(new Event('input'))
    expect($<HTMLButtonElement>('[data-upgrade-start]').disabled).toBe(false)
    $<HTMLButtonElement>('[data-upgrade-start]').click(); await tick()
    expect(send.mock.calls[3]).toEqual(['POST', '/api/server/upgrade/start', { targetVersion: '1.1.0', expectedRevision: revision, confirm: 'upgrade 1.1.0' }])
    expect($('[data-upgrade-status]').dataset.state).toBe('accepted')
    expect(WHM_UPGRADE_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_UPGRADE_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('keeps the upgrade button disabled with the exact reason when no coordinator can start it', async () => {
    const blocked = { enabled: false, reasons: ['upgrade-coordinator-unavailable'] }
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? (path.endsWith('/status') ? status() : observation(blocked)) : preflight(false))
    boot(send); await tick()
    expect($('[data-upgrade-banner]').textContent).toContain('The native upgrade coordinator is not connected on this host')
    $<HTMLButtonElement>('[data-upgrade-preflight]').click(); await tick()
    expect($<HTMLButtonElement>('[data-upgrade-open-confirm]').disabled).toBe(true)
    expect($<HTMLButtonElement>('[data-upgrade-start]').disabled).toBe(true)
    expect(send.mock.calls.filter(call => call[1] === '/api/server/upgrade/start')).toEqual([])
  })

  it('re-reads after a stale revision instead of retrying the stale decision', async () => {
    let reads = 0
    const send = vi.fn(async (method: string, path: string) => {
      if (method === 'GET') { if (!path.endsWith('/status')) reads++; return path.endsWith('/status') ? status() : observation() }
      throw Object.assign(new Error('changed'), { status: 409, details: { reason: 'revision-changed' } })
    })
    boot(send); await tick()
    $<HTMLButtonElement>('[data-upgrade-preflight]').click(); await tick()
    expect(reads).toBe(2)
    expect($('[data-upgrade-check="disk-space"] [data-upgrade-check-result]').textContent).toBe('Not run')
  })
})
