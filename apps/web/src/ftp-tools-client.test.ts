// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderFtpAccountTools, renderFtpReportCard, renderFtpServerSettingsCard } from './board-port/ftp-tools-workspace.ts'
import { FTP_TOOLS_CLIENT_BINDING, readFtpSettingsForm } from './ftp-tools-client.ts'

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = (request: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async () => true)) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + FTP_TOOLS_CLIENT_BINDING)()(ask); return ask }
const el = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const settings = { enabled: true, tls: 'required', tlsCipherSuite: 'HIGH', anonymous: false, anonymousUploads: false, maxIdleMinutes: 15, maxConnections: 150, maxConnectionsPerIp: 8, passivePorts: { min: 30000, max: 35000 }, brokenClients: false, listingLimit: 10000 }
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; (globalThis as { xpT?: unknown }).xpT = (message: string) => message })

describe('FTP settings client', () => {
  it('types the form and refuses non-numeric limits', () => {
    const values = { enabled: true, tls: 'optional', tlsCipherSuite: 'HIGH', anonymous: false, anonymousUploads: true, maxIdleMinutes: '5', maxConnections: '10', maxConnectionsPerIp: '2', passiveMin: '30000', passiveMax: '30100', brokenClients: false, listingLimit: '1000' }
    expect(readFtpSettingsForm(values)).toMatchObject({ anonymousUploads: false, passivePorts: { min: 30000, max: 30100 }, maxConnectionsPerIp: 2 })
    expect(readFtpSettingsForm({ ...values, maxConnections: 'x' })).toBeNull()
  })
  it('stays read-only without the verified tool and saves with it', async () => {
    document.body.innerHTML = `<section>${renderFtpServerSettingsCard('en', false)}</section>`
    boot(async () => ({ settings }), undefined); await tick()
    expect(el<HTMLButtonElement>('[data-ftp-settings-save]').disabled).toBe(true)
    document.body.innerHTML = `<section>${renderFtpServerSettingsCard('en', true)}</section>`
    const send = vi.fn(async (method: string) => method === 'GET' ? { settings } : { settings, saved: true, application: { status: 'applied' } })
    boot(send); await tick()
    el<HTMLButtonElement>('[data-ftp-settings-save]').click(); await tick()
    expect(send.mock.calls.at(-1)).toEqual(['PUT', '/api/server/ftp/settings', { settings }])
    expect(el('[data-ftp-settings-status]').dataset.state).toBe('read')
  })
  it('asks before disabling FTP', async () => {
    document.body.innerHTML = `<section>${renderFtpServerSettingsCard('en', true)}</section>`
    const send = vi.fn(async (method: string) => method === 'GET' ? { settings } : { settings, application: { status: 'applied' } }), ask = vi.fn(async () => false)
    boot(send, ask); await tick()
    const on = document.querySelector<HTMLInputElement>('[data-ftp-setting="enabled"]')!; on.checked = false
    el<HTMLButtonElement>('[data-ftp-settings-save]').click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('FTP account tools client', () => {
  const session = { pid: 200, login: 'ftp@example.test', seconds: 3, state: 'download', file: null, client: '203.0.113.9' }
  const anon = { revision: 'r', server: { enabled: true, anonymous: true, anonymousUploads: false }, enabled: true, uploads: false, welcome: 'Hi', logins: ['anonymous@example.test'] }
  const request = (extra?: (method: string, path: string, body?: unknown) => unknown) => vi.fn(async (method: string, path: string, body?: unknown) => {
    const answer = extra?.(method, path, body)
    if (answer !== undefined) return answer
    return path === '/api/account/ftp/sessions' ? { state: 'read', observedAt: '2026-11-07T10:00:00.000Z', sessions: [session] } : path === '/api/account/ftp/anonymous' ? anon : {}
  })
  it('lists sessions and disconnects one', async () => {
    document.body.innerHTML = renderFtpAccountTools('en', { canConnections: true, canAnonymous: true })
    const send = request(); boot(send); await tick()
    expect(el('[data-ftp-sessions]').textContent).toContain('ftp@example.test')
    el<HTMLButtonElement>('[data-ftp-sessions] button').click(); await tick()
    expect(send.mock.calls.some(call => call[0] === 'POST' && call[1] === '/api/account/ftp/sessions/disconnect' && (call[2] as { target: number }).target === 200)).toBe(true)
  })
  it('keeps anonymous uploads closed while the server closes them, and sends the revision', async () => {
    document.body.innerHTML = renderFtpAccountTools('en', { canConnections: false, canAnonymous: true })
    const send = request((method, _path, body) => method === 'PUT' ? { ...anon, ...(body as object), application: { status: 'applied' } } : undefined); boot(send); await tick()
    expect(el<HTMLInputElement>('[data-ftp-anonymous-uploads]').disabled).toBe(true)
    expect(el('[data-ftp-anonymous-logins]').textContent).toBe('anonymous@example.test')
    el<HTMLButtonElement>('[data-ftp-anonymous-save]').click(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'PUT')?.[2]).toEqual({ enabled: true, uploads: false, welcome: 'Hi', expectedRevision: 'r' })
  })
  it('shows the report, and the truthful state of an unread month', async () => {
    document.body.innerHTML = renderFtpReportCard('en')
    boot(async () => ({ state: 'partial', totals: { transfers: 2, downloads: 2, uploads: 0, bytes: 2048 }, days: [{ day: '2026-11-03', transfers: 2, bytes: 2048 }], hours: [], users: [] })); await tick()
    expect(el('[data-ftp-report-fact="bytes"]').textContent).toBe('\u20662.00\u00a0KiB\u2069')
    expect(el('[data-ftp-report-status]').textContent).toContain('partial')
  })
})
