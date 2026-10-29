// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmMailboxMaintenanceWorkspace } from './board-port/whm-mailbox-maintenance-workspace.ts'
import { WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING, readMailboxMaintenanceView, readMaintenanceJobAck } from './whm-mailbox-maintenance-client.ts'

const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const observedAt = '2026-10-27T10:00:00.000Z'
const jobId = '22222222-2222-4222-8222-222222222222'
const list = (extra: Record<string, unknown> = {}) => ({ observedAt, fts: 'not_configured', jobsAvailable: true, mailboxes: [{ login: 'info@alice.example', account: 'alice', savedQuotaMb: 1024 }, { login: 'boss@carol.example', account: 'carol', savedQuotaMb: null }], mailboxesTruncated: false, report: null, ...extra })
const one = (extra: Record<string, unknown> = {}) => list({ mailboxes: [list().mailboxes[0]], ...extra })
const report = { mailbox: 'info@alice.example', account: 'alice', savedQuotaMb: 1024,
  quota: { state: 'read', reason: null, resources: [{ root: 'User quota', type: 'STORAGE', value: 2048, limit: 10240, percent: 20 }, { root: 'User quota', type: 'MESSAGE', value: 12, limit: null, percent: 0 }] },
  folders: { state: 'read', reason: null, folders: [{ name: 'INBOX', messages: 10, vsizeBytes: 4096 }, { name: 'Sent', messages: 2, vsizeBytes: 1024 }], truncated: false, totalMessages: 12, totalVsizeBytes: 5120 } }
const mount = (canRead = true, canManage = true, locale: 'en' | 'ar' = 'en') => { document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; document.body.innerHTML = `<section data-whm-detail-route="/whm/email/maintenance" data-capability-state="authorized">${renderWhmMailboxMaintenanceWorkspace({ locale, canRead, canManage })}</section>` }
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING)()(ask)
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const rows = (key: string) => [...document.querySelectorAll(`[data-whm-mailbox-maintenance-rows="${key}"] tr`)]
const pick = (login: string) => { const box = $<HTMLInputElement>(`[data-whm-mailbox-maintenance-pick="${login}"]`); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })) }
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('mailbox maintenance client parsers', () => {
  it('accepts projected reads and drops unknown fields', () => {
    expect(JSON.stringify(readMailboxMaintenanceView({ ...list(), secret: 'x' }, null))).not.toContain('secret')
    expect(readMailboxMaintenanceView(one({ report }), 'info@alice.example').report!.folders.totalMessages).toBe(12)
    expect(readMaintenanceJobAck({ job: { id: jobId, kind: 'mail.maintenance.resync', status: 'queued' } }, 'mail.maintenance.resync')).toEqual({ id: jobId, status: 'queued' })
  })
  it('refuses foreign, inconsistent or malformed evidence', () => {
    for (const bad of [list({ report }), list({ mailboxes: [{ login: '*@alice.example', account: 'alice', savedQuotaMb: 1 }] }), list({ fts: 'yes' }), list({ mailboxes: 'x' })]) expect(() => readMailboxMaintenanceView(bad, null)).toThrow()
    for (const bad of [one(), list({ report }), one({ report: { ...report, mailbox: 'boss@carol.example' } }), one({ report: { ...report, folders: { ...report.folders, totalVsizeBytes: 1 } } }), one({ report: { ...report, quota: { state: 'unavailable', reason: 'user_unknown', resources: report.quota.resources } } }),
      one({ report: { ...report, folders: { state: 'unavailable', reason: 'command_failed', folders: [], truncated: false, totalMessages: 3, totalVsizeBytes: null } } })]) expect(() => readMailboxMaintenanceView(bad, 'info@alice.example')).toThrow()
    expect(() => readMaintenanceJobAck({ job: { id: jobId, kind: 'mail.maintenance.index', status: 'queued' } }, 'mail.maintenance.resync')).toThrow()
  })
})

describe('mailbox maintenance client binding', () => {
  it('makes no request without transport or read authority and stays inert', async () => {
    mount(); boot(); expect($('[data-whm-mailbox-maintenance-status]').dataset.state).toBe('unavailable')
    mount(false); const send = vi.fn(); boot(send); await tick()
    expect(send).not.toHaveBeenCalled()
    for (const control of document.querySelectorAll<HTMLInputElement>('input,select,textarea,button')) expect(control.disabled).toBe(true)
    expect(document.querySelector('form')).toBeNull()
    expect(WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('lists, searches and inspects one mailbox usage', async () => {
    mount()
    const send = vi.fn(async (_method: string, path: string) => path.includes('?mailbox=') ? one({ report }) : list())
    boot(send, async () => true); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/mail-maintenance')
    expect(rows('mailboxes')).toHaveLength(2)
    expect($('[data-whm-mailbox-maintenance-fact="fts"]').textContent).toBe('Not configured')
    expect($('[data-whm-mailbox-maintenance-fts-note]').hidden).toBe(false)
    const search = $<HTMLInputElement>('[data-whm-mailbox-maintenance-search]')
    search.value = 'carol'; search.dispatchEvent(new Event('input'))
    expect(rows('mailboxes')).toHaveLength(1)
    search.value = 'nobody'; search.dispatchEvent(new Event('input'))
    expect(rows('mailboxes')[0]!.textContent).toBe('No mailboxes match.')
    search.value = ''; search.dispatchEvent(new Event('input'))
    $<HTMLButtonElement>('[data-whm-mailbox-maintenance-inspect="info@alice.example"]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('GET', '/api/server/mail-maintenance?mailbox=info%40alice.example')
    expect($('[data-whm-mailbox-maintenance-fact="storage"]').textContent).toBe('2.0 MB / 10.0 MB')
    expect($('[data-whm-mailbox-maintenance-fact="messages"]').textContent).toBe('12')
    expect(rows('folders')).toHaveLength(2)
    expect(rows('mailboxes')).toHaveLength(2)
    expect(rows('folders')[0]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('INBOX')
    expect(rows('quota')[1]!.textContent).toContain('Unlimited')
  })
  it('shows unavailable usage truthfully', async () => {
    mount()
    const unavailable = { ...report, quota: { state: 'unavailable', reason: 'user_unknown', resources: [] }, folders: { state: 'unavailable', reason: 'malformed_output', folders: [], truncated: false, totalMessages: null, totalVsizeBytes: null } }
    boot(async (_method: string, path: string) => path.includes('?mailbox=') ? one({ report: unavailable }) : list()); await tick()
    $<HTMLButtonElement>('[data-whm-mailbox-maintenance-inspect="info@alice.example"]').click(); await tick()
    expect(rows('quota')[0]!.textContent).toBe('Quota is unavailable. Dovecot does not know this user.')
    expect(rows('folders')[0]!.textContent).toContain('could not be verified')
    expect($('[data-whm-mailbox-maintenance-fact="storage"]').textContent).toBe('Not reported')
  })
  it('submits one bulk job for the selected mailboxes after confirmation and links the job', async () => {
    mount()
    const send = vi.fn(async (method: string) => method === 'GET' ? list() : { job: { id: jobId, kind: 'mail.maintenance.quota-recalc', status: 'queued' } })
    const ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    const recalc = $<HTMLButtonElement>('[data-whm-mailbox-maintenance-run="quota-recalc"]'), index = $<HTMLButtonElement>('[data-whm-mailbox-maintenance-run="index"]')
    expect(recalc.disabled).toBe(true)
    pick('info@alice.example'); pick('boss@carol.example')
    expect($('[data-whm-mailbox-maintenance-selected]').textContent).toBe('Selected mailboxes: 2 / 32')
    expect(recalc.disabled).toBe(false); expect(index.disabled).toBe(true)
    recalc.click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('POST', '/api/server/mail-maintenance/jobs', { operation: 'quota-recalc', mailboxes: ['info@alice.example', 'boss@carol.example'] })
    expect($('[data-whm-mailbox-maintenance-result]').dataset.outcome).toBe('submitted')
    expect($<HTMLAnchorElement>('[data-whm-mailbox-maintenance-job-link]').getAttribute('href')).toBe('/whm/jobs?job=' + jobId)
  })
  it('does nothing when confirmation is declined and reports refusals and unknown outcomes', async () => {
    mount()
    const send = vi.fn(async (method: string) => { if (method === 'GET') return list({ fts: 'configured' }); throw Object.assign(new Error('refused'), { status: 404, code: 'NOT_FOUND', details: { stateChanged: false } }) })
    boot(send, async () => false); await tick()
    pick('info@alice.example')
    const index = $<HTMLButtonElement>('[data-whm-mailbox-maintenance-run="index"]')
    expect(index.disabled).toBe(false)
    index.click(); await tick()
    expect(send).toHaveBeenCalledTimes(1)
    mount()
    boot(send, async () => true); await tick()
    pick('info@alice.example'); $<HTMLButtonElement>('[data-whm-mailbox-maintenance-run="resync"]').click(); await tick()
    expect($('[data-whm-mailbox-maintenance-result]').dataset.outcome).toBe('missing')
    expect($('[data-whm-mailbox-maintenance-result]').textContent).toContain('Nothing was changed')
    mount()
    boot(async (method: string) => method === 'GET' ? list() : { job: { id: jobId, kind: 'system.packages.upgrade', status: 'queued' } }, async () => true); await tick()
    pick('info@alice.example'); $<HTMLButtonElement>('[data-whm-mailbox-maintenance-run="resync"]').click(); await tick()
    expect($('[data-whm-mailbox-maintenance-result]').dataset.outcome).toBe('unknown')
  })
  it('keeps actions disabled without host jobs or manage authority, in Arabic with ASCII digits', async () => {
    mount(true, false, 'ar')
    boot(async () => list({ jobsAvailable: false }), async () => true); await tick()
    expect(document.querySelectorAll<HTMLInputElement>('[data-whm-mailbox-maintenance-pick]')[0]!.disabled).toBe(true)
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-whm-mailbox-maintenance-run]')) expect(button.disabled).toBe(true)
    expect($('[data-whm-mailbox-maintenance-status]').textContent).toBe('قُرئت الصناديق. مهام المضيف غير متاحة، لذا لا يمكن بدء الصيانة.')
    expect($('[data-whm-mailbox-maintenance-selected]').textContent).toBe('الصناديق المحددة: 0 / 32')
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
  })
})

describe('mailbox maintenance timestamp precision', () => {
  it.each(['en', 'ar'] as const)('preserves the complete UTC observation timestamp in %s', async locale => {
    const instant = '2026-10-27T12:34:56.789Z'
    mount(true, true, locale)
    const send = vi.fn(async (_method: string, _path: string) => list({ observedAt: instant }))
    boot(send)
    await tick()
    const observed = document.querySelector<HTMLElement>('[data-whm-mailbox-maintenance-fact="observed-at"]')!
    expect(observed.textContent).toBe('2026-10-27 12:34 UTC')
    expect(observed.getAttribute('dir')).toBe('ltr')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', '/api/server/mail-maintenance')
  })
})
