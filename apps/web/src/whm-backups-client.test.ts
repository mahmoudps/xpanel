// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApprovedWhmBackups } from './board-port/approved-whm-backups.ts'
import { readWhmBackupWorkspace, WHM_BACKUPS_CLIENT_BINDING } from './whm-backups-client.ts'

const id = (n: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0')
const application = { status: 'configuration_only', nativeApplied: false, remoteConnectionVerified: false, schedulerVerified: false }
const initial = () => ({ revision: '1'.padStart(64, '0'), application, accounts: [{ id: id(1), username: 'ownerone', primaryDomain: 'one.example.test', status: 'active' }],
  destinations: [{ id: id(2), name: 'Local configuration', kind: 'local', endpoint: '/var/backups/xpanel', bucket: null, region: null, pathPrefix: '/var/backups/xpanel/daily', username: null, retentionDays: 30, enabled: true, createdAt: '2026-10-26T00:00:00.000Z' }],
  schedule: { enabled: false, frequency: 'daily', cron: '0 2 * * *', retentionCount: 7, retentionWeekly: 4, retentionMonthly: 0, compress: 'zstd', includeDatabases: true, includeMail: true, includeDns: true, includeControl: true, selectedAccounts: 'all', destinationIds: [], updatedAt: '2026-10-26T00:00:00.000Z' },
  snapshots: [{ id: id(3), accountId: id(1), username: 'ownerone', createdAt: '2026-10-26T00:00:00.000Z', sizeBytes: 10, files: [{ path: '<img src=x onerror=alert(1)>', sizeBytes: 10, mode: 0o640, content: 'SYNTHETIC_PRIVATE_CONTENT' }], databases: [], application: { status: 'recorded_metadata', archiveVerified: false, restoreAvailable: false } }],
})
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const action = (key: string) => document.querySelector<HTMLButtonElement>('[data-backup-action="' + key + '"]')!
const input = (key: string) => document.querySelector<HTMLInputElement>('#backup-layout-' + key)!
const status = () => document.querySelector<HTMLElement>('[data-backup-workspace-status]')!
const edit = (key: string, value: string) => { input(key).value = value; input(key).dispatchEvent(new Event('input', { bubbles: true })) }
let listeners: EventListener[]
beforeEach(() => {
  listeners = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
  document.body.innerHTML = renderApprovedWhmBackups({ principal: { kind: 'root', id: id(9), username: 'root' }, accounts: [] })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterEach(() => { for (const listener of listeners) window.removeEventListener('beforeunload', listener); vi.restoreAllMocks(); document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })
const model = () => {
  let current = initial(), serial = 1, mode = 'normal'
  const ask = vi.fn(async () => true)
  const send = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === 'GET') return clone(current)
    if (mode === 'refused') throw { status: 422, details: { stateChanged: false } }
    if (mode === 'uncertain') throw { status: 503, details: { unknownOutcome: true, stateChanged: true } }
    const { expectedRevision, ...draft } = body as Record<string, unknown>
    if (expectedRevision !== current.revision || mode === 'stale') throw { status: 409, details: { stateChanged: false } }
    current.revision = String(++serial).padStart(64, '0')
    if (path.endsWith('/schedule')) {
      current.schedule = { ...draft, updatedAt: '2026-10-26T01:00:00.000Z' } as typeof current.schedule
      return { schedule: clone(current.schedule), revision: current.revision, application }
    }
    const selected = path.split('/').at(-1)!, previous = current.destinations.find(destination => destination.id === selected)
    if (method === 'DELETE') { current.destinations = current.destinations.filter(destination => destination.id !== selected); return { ok: true, revision: current.revision, application } }
    const destination = { ...draft, id: previous?.id ?? id(5), createdAt: previous?.createdAt ?? '2026-10-26T01:00:00.000Z' } as typeof current.destinations[number]
    current.destinations = [...current.destinations.filter(item => item.id !== destination.id), destination]
    return { destination: clone(mode === 'wrong-ack' ? { ...destination, name: 'Wrong acknowledged destination' } : destination), revision: current.revision, application }
  })
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + WHM_BACKUPS_CLIENT_BINDING)()(ask) }
  return { send, ask, boot, writes: () => send.mock.calls.filter(call => call[0] !== 'GET'), setMode: (value: string) => { mode = value }, getCurrent: () => current }
}

describe('WHM backups parsed contract', () => {
  it('drops raw snapshot contents and refuses malformed native/application flags', () => {
    const view = readWhmBackupWorkspace(initial())
    expect(JSON.stringify(view)).not.toContain('SYNTHETIC_PRIVATE_CONTENT')
    for (const bad of [null, {}, { ...initial(), revision: 'bad' }, { ...initial(), application: { status: 'completed', nativeApplied: true } }, { ...initial(), destinations: [{ ...initial().destinations[0], enabled: 'yes' }] }]) expect(() => readWhmBackupWorkspace(bad)).toThrow()
  })
})
describe('WHM backups browser controller', () => {
  it('constructs a self-contained binding without raw fetch or HTML injection', () => {
    expect(() => new Function('return ' + WHM_BACKUPS_CLIENT_BINDING)()).not.toThrow()
    expect(WHM_BACKUPS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_BACKUPS_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('keeps every operation unavailable without transport or capability admission', async () => {
    new Function('return ' + WHM_BACKUPS_CLIENT_BINDING)()(undefined)
    expect(status().dataset.state).toBe('unavailable'); expect(action('save-schedule').disabled).toBe(true)
    document.querySelector<HTMLElement>('[data-approved-whm-backups]')!.removeAttribute('data-backup-bound')
    document.querySelector<HTMLElement>('[data-approved-whm-backups]')!.dataset.capabilityUnavailable = 'true'
    const f = model(); f.boot(); await tick(); expect(f.send).not.toHaveBeenCalled()
  })
  it('reads real metadata states using human labels without native success or internal references', async () => {
    const f = model(); f.boot(); await tick()
    expect(status().dataset.state).toBe('read')
    expect(input('policy-cron').value).toBe('0 2 * * *')
    expect(document.querySelector('[data-backup-destination-rows]')!.textContent).toContain('Local configuration')
    expect(document.querySelector('[data-backup-destination-rows]')!.textContent).not.toContain(id(2))
    expect(document.querySelector('[data-backup-snapshot-rows]')!.textContent).toContain('Not a verified archive')
    expect(document.querySelector('img')).toBeNull()
    expect(document.body.textContent).not.toContain('SYNTHETIC_PRIVATE_CONTENT')
    for (const key of ['sftp-key', 'restore-acknowledge']) expect(input(key).disabled).toBe(true)
    // Weekly copies and the DNS and control-snapshot parts are saved schedule fields now.
    for (const key of ['weekly-copies', 'include-dns', 'include-control']) expect(input(key).disabled).toBe(false)
    expect(input('weekly-copies').value).toBe('4')
    expect(input('destination-enabled').disabled).toBe(true)
    expect(document.querySelector('#backup-destination-activation-help a')?.getAttribute('href')).toBe('/whm/backups/destinations')
  })
  it('saves the captured schedule revision and verifies persisted readback', async () => {
    const f = model(); f.boot(); await tick(); edit('policy-cron', '15 3 * * *'); edit('daily-copies', '14')
    action('save-schedule').click(); await tick(); await tick()
    expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]![2]).toMatchObject({ expectedRevision: '1'.padStart(64, '0'), cron: '15 3 * * *', retentionCount: 14 })
    expect(status().dataset.state).toBe('saved')
    expect(action('save-schedule').disabled).toBe(true)
  })
  it('preserves the every-12-hours preset and its start time after saving', async () => {
    const f = model(); f.boot(); await tick()
    const frequency = document.querySelector<HTMLSelectElement>('#backup-layout-frequency')!
    frequency.value = '2'; frequency.dispatchEvent(new Event('change', { bubbles: true }))
    expect(input('policy-cron').value).toBe('0 2,14 * * *')
    action('save-schedule').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect(frequency.value).toBe('2'); expect(input('start-time').value).toBe('02:00')
  })
  it('cancels mutations without a request and retains the draft', async () => {
    const f = model(); f.ask.mockResolvedValue(false); f.boot(); await tick(); edit('policy-cron', '15 3 * * *')
    const before = f.send.mock.calls.length; action('save-schedule').click(); await tick()
    expect(f.send.mock.calls).toHaveLength(before); expect(input('policy-cron').value).toBe('15 3 * * *')
  })
  it.each(['uncertain', 'stale'])('locks an %s outcome without retrying or dropping the draft', async mode => {
    const f = model(); f.boot(); await tick(); edit('policy-cron', '15 3 * * *'); f.setMode(mode)
    action('save-schedule').click(); await tick(); await tick()
    expect(status().dataset.state).toBe(mode); expect(action('save-schedule').disabled).toBe(true)
    expect(input('policy-cron').value).toBe('15 3 * * *'); expect(f.writes()).toHaveLength(1)
  })
  it('keeps an explicitly refused draft editable', async () => {
    const f = model(); f.boot(); await tick(); edit('policy-cron', '15 3 * * *'); f.setMode('refused')
    action('save-schedule').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(action('save-schedule').disabled).toBe(false)
  })
  it('preserves an unsaved schedule while creating destination configuration', async () => {
    const f = model(); f.boot(); await tick(); edit('policy-cron', '15 3 * * *')
    edit('destination-name', 'Another local configuration'); edit('destination-endpoint', '/var/backups/other'); edit('destination-prefix', '/var/backups/other/daily')
    action('save-destination').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect(f.getCurrent().destinations).toHaveLength(2)
    expect(input('policy-cron').value).toBe('15 3 * * *'); expect(action('save-schedule').disabled).toBe(false)
    expect(f.writes()[0]![2]).toMatchObject({ name: 'Another local configuration', expectedRevision: '1'.padStart(64, '0'), enabled: false })
  })
  it('requires explicit discard before refreshing unknown state', async () => {
    const f = model(); f.boot(); await tick(); edit('policy-cron', '15 3 * * *'); f.setMode('uncertain')
    action('save-schedule').click(); await tick(); await tick()
    const before = f.send.mock.calls.length
    f.ask.mockResolvedValue(false); action('refresh').click(); await tick()
    expect(f.send.mock.calls).toHaveLength(before); expect(status().dataset.state).toBe('uncertain')
    f.ask.mockResolvedValue(true); f.setMode('normal'); action('refresh').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('read'); expect(input('policy-cron').value).toBe('0 2 * * *')
  })
  it('removes only an explicitly deleted destination from a pending schedule draft', async () => {
    const f = model(); f.boot(); await tick()
    const choice = document.querySelector<HTMLInputElement>('[data-backup-selected-destination]')!
    choice.checked = true; choice.dispatchEvent(new Event('change'))
    edit('policy-cron', '15 3 * * *')
    document.querySelector<HTMLButtonElement>('[data-backup-delete-destination]')!.click(); await tick(); await tick()
    expect(f.getCurrent().destinations).toHaveLength(0)
    expect(input('policy-cron').value).toBe('15 3 * * *')
    action('save-schedule').click(); await tick(); await tick()
    expect(f.writes()[1]![2]).toMatchObject({ cron: '15 3 * * *', destinationIds: [] })
  })
})

describe('readable date closure snapshot metadata', () => {
  for (const locale of ['en', 'ar'] as const) it('formats snapshot creation without changing raw metadata or schedule controls in ' + locale, async () => {
    const source = initial(); source.snapshots[0]!.createdAt = '2026-10-27T09:01:02.123Z'; const before = JSON.stringify(source), send = vi.fn(async () => source)
    document.body.innerHTML = renderApprovedWhmBackups({ principal: { kind: 'root', id: id(9), username: 'root' }, accounts: [], locale })
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    Object.assign(window, { xpanelSessionRequest: send }); new Function('return ' + WHM_BACKUPS_CLIENT_BINDING)()(undefined); await tick()
    const stamp = document.querySelector('[data-backup-snapshot-rows] tr td:first-child bdi')!
    expect(stamp.textContent).toBe('2026-10-27 09:01 UTC'); expect(stamp.getAttribute('dir')).toBe('ltr')
    const help = document.querySelector('#backup-destination-activation-help')!
    expect(help.textContent).toBe(locale === 'ar' ? 'علامة محفوظة فقط. تحفظ التغييرات هذه الوجهة غير نشطة. تحقّق منها وفعّلها في وجهات النسخ الاحتياطي' : 'Saved flag only. Changes save this destination inactive. Verify and activate in Backup destinations')
    expect(help.querySelector('a')!.getAttribute('href')).toBe(locale === 'ar' ? '/whm/backups/destinations?lang=ar' : '/whm/backups/destinations')
    expect(input('policy-cron').value).toBe('0 2 * * *'); expect(input('start-time').value).toBe('02:00')
    expect(input('restore-acknowledge').disabled).toBe(true); expect(document.body.textContent).not.toContain('SYNTHETIC_PRIVATE_CONTENT')
    expect(JSON.stringify(source)).toBe(before); expect(readWhmBackupWorkspace(source).snapshots[0]!.createdAt).toBe('2026-10-27T09:01:02.123Z')
    expect(readWhmBackupWorkspace(source).schedule!.updatedAt).toBe('2026-10-26T00:00:00.000Z')
    expect(send.mock.calls[0]).toEqual(['GET', '/api/backups/workspace']); expect(send.mock.calls.every(call => (call as unknown[])[0] === 'GET')).toBe(true); expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})