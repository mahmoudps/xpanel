// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmBandwidthWorkspace, renderWhmDiskQuotaWorkspace, renderWhmIoWorkspace, renderWhmLogRetentionWorkspace, renderWhmRawServerLogsWorkspace } from './board-port/whm-metering-workspace.ts'
import { accountLimitsPatch, readCustomBandwidthView, readDiskQuotaPage, readLogRetentionView, readRawServerLogs, readWhmBandwidthView, readWhmIoView, WHM_METERING_CLIENT_BINDING } from './whm-metering-client.ts'

const tick = async () => { for (let n = 0; n < 5; n++) await new Promise(resolve => setTimeout(resolve, 0)) }
const io = () => ({ state: 'partial', reason: null, observedAt: '2026-10-28T14:05:00.000Z',
  host: { cpuPercent: 12, memoryUsedBytes: 4 * 1024 ** 3, memoryTotalBytes: 8 * 1024 ** 3, loadAvg1m: 1, psiSomeAvg10: 0.5, psiFullAvg10: 0, awaitMs: null },
  accounts: [{ username: 'yousef', uid: 20009, readBytesPerSec: 4.1 * 1024 ** 2, writeBytesPerSec: 2.2 * 1024 ** 2, readIops: 102, writeIops: 55, cpuPercent: 31.5, memoryCurrentBytes: 958 * 1024 ** 2, memoryLimitMb: 1024, pidsCurrent: 96, pidsLimit: 128, statusLevel: 'ok' }],
  disk: { state: 'read', observedAt: '2026-10-28T14:05:00.000Z', intervalSeconds: 60, awaitMs: 4.25, devices: [{ name: 'vda', readAwaitMs: 3, writeAwaitMs: null, utilPercent: 12.5 }] },
  unmeasuredAccounts: 1 })
const totals = (count: number, receivedBytes: number, sentBytes: number) => ({ count, receivedBytes, sentBytes })
const bandwidth = () => ({ state: 'partial', month: '2026-10', since: '2026-09-01T00:00:00.000Z', updatedAt: '2026-10-28T14:05:00.000Z', pendingBytes: 0, unavailableSites: 0, skippedLines: 0,
  sources: { web: { state: 'read', since: '2026-09-01T00:00:00.000Z' }, mail: { state: 'partial', since: '2026-10-28T10:00:00Z' }, ftp: { state: 'unavailable', since: null } },
  accounts: [
    { username: 'alice', domain: 'alice.test', status: 'active', month: { web: totals(12, 1024, 2048), mail: totals(2, 1024, 0), ftp: null }, totalBytes: 4096, limitBytes: 4000, usedPercent: 102.4, limitState: 'over', enforced: true, limited: true, customLimit: false, reliefThrough: null },
    { username: 'bob', domain: 'bob.test', status: 'suspended', month: { web: null, mail: null, ftp: null }, totalBytes: null, limitBytes: null, usedPercent: null, limitState: 'unmeasured', enforced: false, limited: false, customLimit: false, reliefThrough: null },
  ] })
const bind = () => new Function('return ' + WHM_METERING_CLIENT_BINDING)()()
const cells = (table = '') => [...document.querySelectorAll(`[data-whm-metering-rows${table ? `="${table}"` : '="io"],[data-whm-metering-rows="bandwidth"'}] tr`)].map(row => [...row.querySelectorAll('td')].map(td => td.textContent))
afterEach(() => { delete (window as any).xpanelSessionRequest; document.body.innerHTML = '' })

describe('metering browser workflow', () => {
  it.each(['en', 'ar'] as const)('shows the measured IO sample and keeps unmeasured fields unavailable in %s', async locale => {
    document.body.innerHTML = renderWhmIoWorkspace({ locale, canRead: true })
    const send = vi.fn(async () => io()); (window as any).xpanelSessionRequest = send
    bind(); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/server/monitoring/io']])
    const fact = (key: string) => document.querySelector(`[data-whm-metering-fact="${key}"]`)!.textContent
    expect(fact('observed')).toBe('2026-10-28 14:05 UTC'); expect(fact('read')).toBe('4.1 MiB/s'); expect(fact('iops')).toBe('157 IOPS')
    expect(fact('latency')).toBe('4.3 ms (60 s)'); expect(fact('host')).toBe('12% CPU; 4.0 GiB / 8.0 GiB')
    expect(cells('devices')).toEqual([['vda', '3 ms', '-', '12.5%']])
    const [row] = cells()
    expect(row![0]).toBe('yousef (UID 20009, xpanel-20009.slice)'); expect(row![3]).toMatch(/^958 \/ 1024 MiB \(94%\); /); expect(row![5]).toMatch(/^96 \/ 128 PIDs \(75%\); /)
    expect(document.querySelector('[data-whm-metering-status]')!.getAttribute('data-state')).toBe('partial')
  })
  it('shows no IO totals while the sample has measured no account', async () => {
    document.body.innerHTML = renderWhmIoWorkspace({ locale: 'en', canRead: true })
    ;(window as any).xpanelSessionRequest = vi.fn(async () => ({ ...io(), accounts: [], unmeasuredAccounts: 2 }))
    bind(); await tick()
    for (const key of ['read', 'write', 'iops']) expect(document.querySelector(`[data-whm-metering-fact="${key}"]`)!.textContent).toBe('Not measured')
  })
  it('shows measured bandwidth and marks unmeasured accounts instead of zero', async () => {
    document.body.innerHTML = renderWhmBandwidthWorkspace({ locale: 'en', canRead: true })
    const send = vi.fn(async () => bandwidth()); (window as any).xpanelSessionRequest = send
    bind(); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/server/monitoring/bandwidth']])
    expect(cells()).toEqual([
      ['alice', 'alice.test', 'Active', '3.0 KiB', '1.0 KiB', 'Not measured', '4.0 KiB', '3.9 KiB (102.4%); Over limit; Limit page served'],
      ['bob', 'bob.test', 'Suspended', 'Not measured', 'Not measured', 'Not measured', 'Not measured', 'Unlimited'],
    ])
    expect(document.querySelector('[data-whm-metering-rows="bandwidth"] tr td:last-child')!.getAttribute('data-level')).toBe('critical')
    expect(document.querySelector('[data-whm-metering-fact="month"]')!.textContent).toBe('2026-10')
    expect(document.querySelector('[data-whm-metering-fact="ftp"]')!.textContent).toBe('Not counted')
    expect(document.querySelector('[data-whm-metering-fact="mail"]')!.textContent).toBe('Partly counted · 2026-10-28 10:00 UTC')
  })
  it('refuses malformed readings and never binds a denied page', async () => {
    expect(() => readWhmIoView({ ...io(), state: 'unavailable' })).toThrow()
    expect(() => readWhmBandwidthView({ ...bandwidth(), accounts: [{ ...bandwidth().accounts[1], totalBytes: 0 }] })).toThrow()
    expect(() => readWhmBandwidthView({ ...bandwidth(), accounts: [{ ...bandwidth().accounts[0], enforced: 'yes' }] })).toThrow()
    document.body.innerHTML = renderWhmIoWorkspace({ locale: 'en', canRead: false })
    const send = vi.fn(); (window as any).xpanelSessionRequest = send
    bind(); await tick()
    expect(send).not.toHaveBeenCalled(); expect(document.querySelector<HTMLButtonElement>('[data-whm-metering-refresh]')!.disabled).toBe(true)
  })
  it('reports a failed read without inventing an empty result', async () => {
    document.body.innerHTML = renderWhmBandwidthWorkspace({ locale: 'en', canRead: true })
    ;(window as any).xpanelSessionRequest = vi.fn(async () => { throw new Error('offline') })
    bind(); await tick()
    const status = document.querySelector('[data-whm-metering-status]')!
    expect(status.getAttribute('data-state')).toBe('failed'); expect(status.getAttribute('role')).toBe('alert')
  })
  it('marks custom limits and relief, resets one custom limit and relieves the limited accounts after a confirmation', async () => {
    document.body.innerHTML = renderWhmBandwidthWorkspace({ locale: 'en', canRead: true, canReset: true, canRelieve: true })
    const ID = '11111111-1111-4111-8111-111111111111'
    const report = () => ({ ...bandwidth(), accounts: [{ ...bandwidth().accounts[0]!, customLimit: true }, { ...bandwidth().accounts[1]!, reliefThrough: '2026-10-28' }] })
    const custom = [{ accountId: ID, username: 'alice', domain: 'alice.test', ownerId: null, planId: 'p', planName: 'Basic', packageLimitMb: 500, customLimitMb: 'unlimited' }]
    const send = vi.fn(async (method: string, path: string) => path === '/api/server/monitoring/bandwidth' ? report() : path === '/api/accounts/bandwidth/custom' ? { accounts: custom }
      : path === '/api/accounts' ? { accounts: [{ id: ID, username: 'alice' }] } : path.endsWith('/relief') ? { reliefThrough: '2026-10-28' } : {})
    ;(window as any).xpanelSessionRequest = send
    const ask = vi.fn(async () => true)
    new Function('return ' + WHM_METERING_CLIENT_BINDING)()(ask); await tick()
    expect(cells('bandwidth')[0]![7]).toBe('3.9 KiB (102.4%); Over limit; Limit page served; Custom limit')
    expect(cells('bandwidth')[1]![7]).toBe('Unlimited; Relieved through 2026-10-28 (UTC)')
    expect(cells('custom')).toEqual([['alice', 'alice.test', 'Basic', 'Unlimited', '500 MB', 'Reset to package limit']])
    document.querySelector<HTMLButtonElement>('[data-whm-metering-rows="custom"] button')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/accounts/bandwidth/reset', { accounts: [ID] })
    const relief = document.querySelector<HTMLButtonElement>('[data-whm-bandwidth-relief]')!
    expect(relief.disabled).toBe(false)
    relief.click(); await tick()
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining('alice') }))
    expect(send).toHaveBeenCalledWith('POST', '/api/accounts/bandwidth/relief', { accounts: [ID] })
    expect(document.querySelector('[data-whm-bandwidth-relief-status]')!.textContent).toContain('2026-10-28')
  })
  it('keeps reset and relief disabled without the qualified root tools', async () => {
    document.body.innerHTML = renderWhmBandwidthWorkspace({ locale: 'en', canRead: true })
    const send = vi.fn(async () => bandwidth()); (window as any).xpanelSessionRequest = send
    new Function('return ' + WHM_METERING_CLIENT_BINDING)()(vi.fn()); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/server/monitoring/bandwidth']])
    expect(document.querySelector<HTMLButtonElement>('[data-whm-bandwidth-relief]')!.disabled).toBe(true)
  })
  it('reads the web log retention overview and refuses malformed replies', async () => {
    const view = { serverDefaults: { archive: true, removePreviousMonthArchive: false, retentionDays: null }, panelRotateDays: 14,
      rotation: { state: 'read', lastRun: { at: '2026-10-28T00:05:00.000Z', rotated: 2, archived: 1, deleted: 1, removedArchives: 0, failures: 1, held: 1, lost: 0 }, failures: [{ username: 'alice', site: 'alice.test', reason: 'archive_failed', at: '2026-10-28T00:05:00.000Z' }],
        pending: [{ username: 'alice', code: 'archive_pending', count: 1, bytes: 2048, oldest: '2026-10-28T00:05:00.000Z', reason: 'archive_quota_exceeded' }], hold: { days: 30, maxBytes: 2147483648 } },
      accounts: [{ accountId: 'x', username: 'alice', domain: 'alice.test', ownerId: null, settings: { archive: true, removePreviousMonthArchive: true, retentionDays: 7 }, source: 'account' }] }
    document.body.innerHTML = renderWhmLogRetentionWorkspace({ locale: 'en', canRead: true })
    ;(window as any).xpanelSessionRequest = vi.fn(async () => view)
    bind(); await tick()
    expect(cells('retention')).toEqual([['alice', 'alice.test', "Archived in ~/logs; kept 7 days; previous month's archives removed", 'Account setting']])
    expect(cells('rotation-failures')).toEqual([['2026-10-28 00:05 UTC', 'alice', 'alice.test', 'archive_failed']])
    expect(cells('pending')).toEqual([['alice', '1', '2.0 KiB', '2026-10-28 00:05 UTC', 'archive_pending: archive_quota_exceeded']])
    expect(document.querySelector('[data-whm-metering-fact="held"]')!.textContent).toBe('1 waiting, 0 lost in the last run; kept 30 days and 2.0 GiB at most')
    expect(document.querySelector('[data-whm-metering-fact="defaults"]')!.textContent).toBe('Archived in ~/logs; kept until removed')
    expect(() => readLogRetentionView({ ...view, rotation: { state: 'maybe' } })).toThrow()
    expect(() => readCustomBandwidthView({ accounts: [{ accountId: 'x' }] })).toThrow()
  })
  it('turns the limits form into one override patch: empty is the package value, unlimited its own choice', () => {
    expect(accountLimitsPatch([{ name: 'diskMb', value: ' 2048 ', unlimited: false }, { name: 'bandwidthMbMonth', value: '', unlimited: false }])).toEqual({ resources: { diskMb: 2048, bandwidthMbMonth: null } })
    expect(accountLimitsPatch([{ name: 'bandwidthMbMonth', value: '12', unlimited: true }])).toEqual({ resources: { bandwidthMbMonth: 'unlimited' } })
    for (const bad of [[{ name: 'diskMb', value: '1.5', unlimited: false }], [{ name: 'diskMb', value: '-1', unlimited: false }], [{ name: 'cpuPercent', value: '1', unlimited: false }]])
      expect(() => accountLimitsPatch(bad)).toThrow()
  })
  it('takes every rendered package limit, keeps zero for a cap and scales a rate field', () => {
    expect(accountLimitsPatch([{ name: 'addonDomains', value: '0', unlimited: false, group: 'caps', scale: 1 }, { name: 'ioReadBps', value: '2', unlimited: false, group: 'resources', scale: 1048576 }, { name: 'cpuPercent', value: '', unlimited: true, group: 'resources', scale: 1 }]))
      .toEqual({ resources: { ioReadBps: 2097152, cpuPercent: 'unlimited' }, caps: { addonDomains: 0 } })
    expect(() => accountLimitsPatch([{ name: 'memoryMb', value: '0', unlimited: false, group: 'resources', scale: 1 }])).toThrow()
  })
  it('pages the disk quota table on the server, sorts by a header and saves one disk limit inline', async () => {
    document.body.innerHTML = renderWhmDiskQuotaWorkspace({ locale: 'en', canRead: true, canEdit: true, owners: [{ id: '22222222-2222-4222-8222-222222222222', username: 'seller' }] })
    const ID = '11111111-1111-4111-8111-111111111111'
    const page = (sort = 'username', dir = 'asc') => ({ rows: [{ accountId: ID, username: 'alice', domain: 'alice.test', ownerId: null, owner: 'root', usedMb: 300, limitMb: 1024, source: 'package', packageLimitMb: 1024, planName: 'Basic' }], total: 30, page: 1, pageSize: 25, sort, dir, usage: { state: 'read', observedAt: '2026-11-06T10:00:00.000Z', reason: null } })
    const send = vi.fn(async (method: string, path: string) => method === 'PATCH' ? {} : page(new URL('http://x' + path).searchParams.get('sort') ?? 'username', new URL('http://x' + path).searchParams.get('dir') ?? 'asc'))
    ;(window as any).xpanelSessionRequest = send
    bind(); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/accounts/disk-quotas?sort=username&dir=asc&page=1&pageSize=25')
    const row = document.querySelector('[data-quotas-rows] tr')!
    expect([...row.querySelectorAll('td')].slice(0, 4).map(td => td.textContent)).toEqual(['alicealice.testOwner: root', 'root', '300 MB', '1024 MBPackage: Basic'])
    expect(document.querySelector('[data-quotas-page]')!.textContent).toBe('Page 1 of 2 · 30 accounts')
    expect(document.querySelector<HTMLButtonElement>('[data-quotas-next]')!.disabled).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-quotas-sort="used"]')!.click(); await tick()
    expect(send).toHaveBeenLastCalledWith('GET', '/api/accounts/disk-quotas?sort=used&dir=asc&page=1&pageSize=25')
    expect(document.querySelector('[data-quotas-sort="used"]')!.closest('th')!.getAttribute('aria-sort')).toBe('ascending')
    const input = document.querySelector<HTMLInputElement>('[data-quota-cell="change"] input[type="text"]')!
    input.value = '2048'
    document.querySelector<HTMLButtonElement>('[data-quota-cell="change"] button')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('PATCH', '/api/accounts/' + ID + '/limits', { resources: { diskMb: 2048 } })
    expect(() => readDiskQuotaPage({ ...page(), pageSize: 7 })).toThrow()
  })
  it('lists the web servers own logs with downloads and refuses names outside the log grammar', async () => {
    document.body.innerHTML = renderWhmRawServerLogsWorkspace({ locale: 'en', canRead: true })
    const view = { server: 'nginx', state: 'read', files: [{ name: 'access.log', sizeBytes: 2048, mtime: '2026-11-06T10:00:00.000Z', compressed: false, downloadable: true }, { name: 'access.log.2.gz', sizeBytes: 2 * 1024 ** 3, mtime: '2026-11-04T10:00:00.000Z', compressed: true, downloadable: false }], maxBytes: 1024 ** 3, observedAt: '2026-11-06T10:00:00.000Z' }
    ;(window as any).xpanelSessionRequest = vi.fn(async () => view)
    bind(); await tick()
    document.querySelector<HTMLButtonElement>('[data-raw-logs-refresh]')!.click(); await tick()
    expect(document.querySelector<HTMLAnchorElement>('[data-raw-logs-rows] a')!.getAttribute('href')).toBe('/api/server/logs/raw/nginx/access.log')
    expect(document.querySelectorAll('[data-raw-logs-rows] tr')[1]!.textContent).toContain('read it on the host')
    expect(() => readRawServerLogs({ ...view, files: [{ ...view.files[0]!, name: 'shadow' }] }, 'nginx')).toThrow()
    expect(() => readRawServerLogs(view, 'apache')).toThrow()
  })
})
