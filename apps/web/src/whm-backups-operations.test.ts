// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApprovedWhmBackups } from './board-port/approved-whm-backups.ts'
import { WHM_BACKUPS_CLIENT_BINDING } from './whm-backups-client.ts'
const ID = '11111111-1111-4111-8111-111111111111', RUN = '33333333-3333-4333-8333-333333333333', FILE = 'xpanel-backup-alice-20261028T020000Z.tar.gz', SHA = 'a'.repeat(64), REV = 'c'.repeat(64)
const application = { status: 'configuration_only', nativeApplied: false, remoteConnectionVerified: false, schedulerVerified: false }
const workspace = { revision: REV, application, accounts: [], destinations: [], schedule: null, snapshots: [] }
const archive = (username: string, ok = true) => ({ username, file: ok ? `xpanel-backup-${username}-20261028T020000Z.tar.gz` : null, bytes: ok ? 2048 : null, sha256: ok ? SHA : null, databases: ok && username === 'alice' ? ['alice_wp'] : [], zones: ok && username === 'alice' ? ['alice.example.test'] : [], integrity: ok ? 'verified' : 'failed', reason: ok ? null : 'backup_failed', detail: ok ? null : 'mariadb-dump: Got error: 145: Table is marked as crashed' })
const run = { id: RUN, trigger: 'schedule', actor: 'scheduler', startedAt: '2026-10-28T02:00:00.000Z', finishedAt: '2026-10-28T02:10:30.000Z', state: 'failed', destinationIds: [ID], accounts: 2, mailIncluded: true, databasesIncluded: true, dnsIncluded: true, control: null, localDeleted: null, retention: [],
  archives: [archive('alice'), archive('karim', false)], entries: [{ username: 'alice', destinationId: ID, file: FILE, bytes: 2048, sha256: SHA, outcome: 'verified', reason: null }, { username: 'karim', destinationId: ID, file: null, bytes: null, sha256: null, outcome: 'failed', reason: 'backup_failed' }] }
const runs = { available: true, reason: null, revision: 'b'.repeat(64), schedule: { enabled: true, cron: '0 3 * * *', nextRunAt: '2026-10-29T03:00:00.000Z', lastScheduledAt: '2026-10-28T02:00:00.000Z' }, storage: { freeBytes: 1024 ** 4, totalBytes: 2 * 1024 ** 4 }, activeId: null, runs: [run], recoveries: [], restores: [], nativeQualified: false }
const lifecycle = { revision: REV, destinations: [{ id: ID, name: 'Vault', kind: 'sftp', endpoint: 'sftp://vault.xpanel.test:2222', username: 'xpanel', pathPrefix: '/backups', state: 'active', credentialRef: 'vault', effectiveActive: true }] }
const inventory = { context: { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice' }, archive: { file: FILE, bytes: 2048, sha256: SHA, createdAt: '2026-10-28T02:00:00Z', integrity: 'verified' },
  components: { files: { state: 'available', files: 3, bytes: 30 }, mail: { state: 'available', truncated: false, mailboxes: [] }, mailSettings: { state: 'not-restorable', files: 0 },
    databases: { state: 'available', databases: [{ name: 'alice_wp', bytes: 10, current: 'exists' }], restores: [] }, dns: { state: 'available', zones: [{ name: 'alice.example.test', bytes: 50, current: 'exists' }] } } }
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
const boot = async () => {
  document.body.innerHTML = renderApprovedWhmBackups({ principal: { kind: 'root', id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000009', username: 'root' }, accounts: [] } as never)
  const send = vi.fn(async (method: string, path: string, _body?: unknown): Promise<unknown> => {
    if (path === '/api/backups/workspace') return structuredClone(workspace)
    if (path === '/api/backups/workspace/destination-lifecycle') return structuredClone(lifecycle)
    if (path === '/api/backups/workspace/runs' && method === 'GET') return structuredClone(runs)
    if (path === '/api/backups/workspace/runs') return { runId: RUN, state: 'running' }
    if (path.endsWith('/inventory')) return structuredClone(inventory)
    if (path.endsWith('/parts')) return { context: inventory.context, archive: { file: FILE, sha256: SHA }, restoreId: '44444444-4444-4444-8444-444444444444', state: 'running', databases: ['alice_wp'], zones: ['alice.example.test'] }
    if (path.endsWith('/test')) return { outcome: 'verified' }
    if (path.endsWith('/space')) return { destinationId: ID, space: { freeBytes: 3 * 1024 ** 4, totalBytes: 4 * 1024 ** 4 } }
    throw new Error('unexpected ' + method + ' ' + path)
  })
  const ask = vi.fn(async () => true)
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  ;(new Function('return ' + WHM_BACKUPS_CLIENT_BINDING)() as (ask: unknown) => void)(ask)
  await settle()
  return { send, ask }
}
const action = (key: string) => document.querySelector<HTMLButtonElement>('[data-backup-action="' + key + '"]')!

describe('server backups page operations', () => {
  it('paints the summary, run history, failure notice and the run log with the failing message', async () => {
    await boot()
    expect(document.querySelector('[data-backup-summary="next"]')!.textContent).toBe('2026-10-29 03:00 UTC')
    expect(document.querySelector('[data-backup-summary="local"]')!.textContent).toBe('1.0 TiB used · 1.0 TiB free')
    expect(document.querySelector('[data-backup-summary="remote"]')!.textContent).toContain('Vault')
    const cells = [...document.querySelectorAll('[data-backup-snapshot-rows] tr:first-child td')].map(td => td.textContent)
    expect(cells.slice(0, 7)).toEqual(['2026-10-28 02:00 UTC', 'Scheduled', '1 of 2', '2.0 KiB', '10 min 30 s', '1 of 2', 'Failed'])
    expect(document.querySelector('[data-backup-run-failure] p')!.textContent).toContain('karim')
    const log = document.querySelector('[data-backup-run-log]')!
    expect(log.textContent).toContain('mariadb-dump: Got error: 145')
    // A wrapped list: localized prose keeps the page font and direction; only technical values are isolated LTR.
    expect(log.tagName).toBe('UL')
    expect(log.querySelectorAll('li').length).toBeGreaterThan(1)
    const ltr = [...log.querySelectorAll('[dir="ltr"]')].map(node => node.textContent)
    expect(ltr).toContain('karim')
    expect(ltr.some(text => text?.includes('verified') || text?.includes('was not built'))).toBe(false)
  })
  it('backs up the failed accounts again with both revisions after confirmation', async () => {
    const { send, ask } = await boot()
    expect(action('rerun-account').disabled).toBe(false)
    action('rerun-account').click(); await settle()
    expect(ask).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('POST', '/api/backups/workspace/runs', { expectedRevision: REV, expectedRunsRevision: 'b'.repeat(64), accounts: ['karim'] })
  })
  it('walks run, account, parts and difference before restoring the reviewed parts', async () => {
    const { send } = await boot()
    expect(action('restore-apply').disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-backup-restore-runs] [data-backup-choice]')!.click(); await settle()
    document.querySelector<HTMLButtonElement>('[data-backup-restore-accounts] [data-backup-choice="alice"]')!.click(); await settle()
    expect(send).toHaveBeenCalledWith('POST', '/api/backups/components/alice/inventory', { file: FILE })
    expect(document.querySelector('[data-backup-part-availability]')!.textContent).toContain('1 database')
    for (const key of ['restore-databases', 'restore-dns']) { const box = document.querySelector<HTMLInputElement>('#backup-layout-' + key)!; expect(box.disabled).toBe(false); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })) }
    expect(document.querySelector<HTMLInputElement>('#backup-layout-restore-home')!.disabled).toBe(true)
    action('restore-review').click(); await settle()
    expect([...document.querySelectorAll('[data-backup-difference-rows] tr')].map(tr => tr.textContent)).toEqual(['Databasesalice_wpExists10 BReplace with the backup copy', 'DNS zonealice.example.testExists50 BReplace records with the backup copy'])
    expect(document.querySelector('[data-backup-difference="differ"]')!.textContent).toBe('2 parts replaced')
    const ack = document.querySelector<HTMLInputElement>('#backup-layout-restore-acknowledge')!; ack.checked = true; ack.dispatchEvent(new Event('change', { bubbles: true }))
    action('restore-apply').click(); await settle()
    expect(send).toHaveBeenCalledWith('POST', '/api/backups/components/alice/parts', { file: FILE, databases: ['alice_wp'], zones: ['alice.example.test'], expectedArchiveSha256: SHA })
    expect(document.querySelector('[data-backup-restore-status]')!.textContent).toContain('Reconciling: restoring alice')
  })
  it('tests the SFTP destination and reports the remote free space', async () => {
    const { send } = await boot()
    expect(document.querySelector<HTMLInputElement>('#backup-layout-sftp-host')!.value).toBe('vault.xpanel.test')
    action('test-sftp').click(); await settle()
    expect(send).toHaveBeenCalledWith('POST', '/api/backups/workspace/destinations/' + ID + '/test', { expectedRevision: REV })
    expect(document.body.textContent).toContain('Connected. 3.0 TiB free on the remote path.')
  })
})

describe('monthly copies', () => {
  it('becomes editable after the saved policy is read and is saved with the schedule', async () => {
    const { send } = await boot()
    const monthly = document.querySelector<HTMLInputElement>('#backup-layout-monthly-copies')!
    expect(monthly.disabled).toBe(false)
    expect(send).toHaveBeenCalledWith('GET', '/api/backups/workspace')
  })
})
