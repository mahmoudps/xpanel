// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmLogToolsWorkspace } from './board-port/whm-log-tools-workspace.ts'
import { WHM_LOG_TOOLS_CLIENT_BINDING, readDatabaseLogView, readLogAnalysis } from './whm-log-tools-client.ts'

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const report = { site: 'example.com', observedAt: '2026-11-07T10:00:00.000Z', scan: { fileExists: true, sizeBytes: 100, scannedBytes: 100, complete: true, requests: 4, unparsed: 0, flagged: 3 }, findings: [{ type: 'sql-injection', count: 3, clients: 2, samples: [{ time: 't', ip: '203.0.113.5', method: 'GET', uri: '/<img src=x>', status: 200 }] }], topClients: [] }
const slowLog = { log: 'slow', state: 'read', reason: null, observedAt: 'x', source: 'file', path: '/var/log/mysql/mariadb-slow.log', sizeBytes: 9, truncated: false, recording: { slowQueryLog: false, longQueryTime: 2 }, entries: [{ at: null, user: 'u', schema: null, queryTime: 2.5, lockTime: 0, rowsSent: 0, rowsExamined: 7, sql: 'select 1' }] }
const domains = { domains: [{ id: '11111111-1111-4111-8111-111111111111', name: 'example.com' }] }
async function bind(request: (method: string, path: string) => Promise<unknown>, canRead = true) {
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = renderWhmLogToolsWorkspace({ locale: 'en', canRead })
  ;(new Function('return ' + WHM_LOG_TOOLS_CLIENT_BINDING)() as () => void)()
  await settle()
}
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); vi.unstubAllGlobals() })

describe('WHM log tools client', () => {
  it('stays inert for a reader without authority', async () => {
    const request = vi.fn(); await bind(request, false)
    expect(request).not.toHaveBeenCalled(); expect($<HTMLButtonElement>('[data-log-analysis-run]').disabled).toBe(true)
  })
  it('shows findings by type with counts and samples as text', async () => {
    const request = vi.fn(async (_method: string, path: string) => path === '/api/domains' ? domains : report); await bind(request)
    expect($<HTMLSelectElement>('[data-log-analysis-site]').value).toBe(domains.domains[0]!.id)
    $<HTMLButtonElement>('[data-log-analysis-run]').click(); await settle()
    expect(request).toHaveBeenLastCalledWith('GET', '/api/server/logs/security-analysis?domainId=' + domains.domains[0]!.id)
    expect($('[data-log-analysis-rows]').textContent).toContain('SQL injection'); expect($('[data-log-analysis-rows]').textContent).toContain('3')
    expect($('[data-log-analysis-samples]').textContent).toContain('/<img src=x>'); expect(document.querySelector('[data-log-analysis-samples] img')).toBeNull()
    expect($('[data-log-analysis-status]').textContent).toContain('whole current access log')
  })
  it('says when recording is off and when a scan was partial or impossible', async () => {
    const request = vi.fn(async (_method: string, path: string) => path === '/api/domains' ? domains : path.includes('database') ? slowLog : { ...report, scan: { ...report.scan, complete: false, sizeBytes: 9000 } }); await bind(request)
    $<HTMLButtonElement>('[data-database-log-read]').click(); await settle()
    expect($('[data-database-log-status]').textContent).toContain('Slow query recording is off'); expect($('[data-database-log-rows="slow"]').textContent).toContain('select 1')
    $<HTMLButtonElement>('[data-log-analysis-run]').click(); await settle()
    expect($('[data-log-analysis-status]').textContent).toContain('Only the latest')
  })
  it('switches to the error table and states an unavailable read', async () => {
    const request = vi.fn(async (_method: string, path: string) => path === '/api/domains' ? domains : { ...slowLog, log: 'error', state: 'unavailable', reason: 'mariadb_unavailable', recording: null, entries: [] }); await bind(request)
    $<HTMLSelectElement>('[data-database-log-kind]').value = 'error'; $<HTMLButtonElement>('[data-database-log-read]').click(); await settle()
    expect($<HTMLElement>('[data-database-log-panel="error"]').hidden).toBe(false); expect($<HTMLElement>('[data-database-log-panel="slow"]').hidden).toBe(true)
    expect($('[data-database-log-status]').textContent).toContain('MariaDB could not be reached')
  })
  it('names SERVICE_DISABLED on the FTP download', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'SERVICE_DISABLED' }, { status: 409 })))
    await bind(vi.fn(async () => domains)); $<HTMLButtonElement>('[data-raw-ftp-download]').click(); await settle()
    expect(fetch).toHaveBeenCalledWith('/api/server/ftp-log/raw?domain=example.com&hours=24', { credentials: 'same-origin' })
    expect($('[data-raw-ftp-status]').textContent).toContain('disabled')
  })
  it('refuses a malformed reply', () => {
    expect(() => readLogAnalysis({ ...report, scan: {} })).toThrow(); expect(() => readDatabaseLogView({ ...slowLog, log: 'error' }, 'slow')).toThrow()
  })
})
