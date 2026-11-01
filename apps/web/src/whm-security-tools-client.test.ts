// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSecurityToolsWorkspace } from './board-port/whm-security-tools-workspace.ts'
import { renderV2WhmSecurityTool } from './themes/v2/pages/xwhm/security/tools.ts'
import { translator } from './i18n.ts'
import type { WhmSecurityToolsPage } from './board-port/whm-security-tools-workspace.ts'
import { readAntivirusView, readIntrusionView, readIsolationView, readJobAck, readUnbanResult, WHM_SECURITY_TOOLS_CLIENT_BINDING } from './whm-security-tools-client.ts'

const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const observedAt = '2026-10-27T10:00:00.000Z'
const jobId = '22222222-2222-4222-8222-222222222222'
const intrusion = (banned = ['192.0.2.1', '198.51.100.0/24']) => ({ state: 'read', observedAt, jails: [{ name: 'sshd', state: 'read', currentlyFailed: 1, totalFailed: 9, currentlyBanned: banned.length, totalBanned: 3, banned, truncated: false }, { name: 'postfix', state: 'unavailable', currentlyFailed: null, totalFailed: null, currentlyBanned: null, totalBanned: null, banned: [], truncated: false }], unsupportedJails: 1, jailsTruncated: false })
const scan = (result: string, extra: Record<string, unknown> = {}) => ({ jobId, referenceCode: 'XP-JOB-2026-000123', account: 'alice', target: '/home/alice', status: result === 'clean' ? 'succeeded' : 'failed', result, exitCode: result === 'clean' ? 0 : 1, createdAt: observedAt, finishedAt: observedAt,
  summary: { knownViruses: 1, engineVersion: '1.0.7', scannedDirectories: 1, scannedFiles: 20, infectedFiles: result === 'clean' ? 0 : 1, dataScanned: '1 MB', time: '1 sec' }, infected: result === 'infected' ? [{ path: '/home/alice/x.php', signature: 'Php.Webshell-1' }] : [], listComplete: true, ...extra })
const antivirus = (extra: Record<string, unknown> = {}) => ({ observedAt, engine: { state: 'read', version: '1.0.7', signatureVersion: 27440, signatureDate: 'Mon Oct 26 08:21:44 2026' }, updater: { present: true }, jobsAvailable: true,
  accounts: [{ username: 'alice', status: 'active' }, { username: 'bob', status: 'suspended' }], scans: [scan('infected'), scan('clean')], updates: [{ jobId, referenceCode: null, status: 'failed', result: 'up_to_date', exitCode: 1, createdAt: observedAt, finishedAt: observedAt, signatureVersion: null }], ...extra })
const report = { username: 'alice', uid: 1001, status: 'active', observedAt, state: 'drift', counts: { ok: 1, drift: 1, unavailable: 0 }, checks: [{ id: 'passwd', state: 'ok', expected: '1001:1001 /home/alice', observed: '1001:1001 /home/alice' }, { id: 'fpm-8.3', state: 'drift', expected: 'User=alice Group=alice Slice=xpanel-1001.slice', observed: 'User=www-data Group=www-data Slice=system.slice' }] }
const mount = (page: WhmSecurityToolsPage, canRead = true, canManage = true, locale: 'en' | 'ar' = 'en') => { document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; document.body.innerHTML = `<section data-whm-detail-route="/whm/security/${page}" data-capability-state="authorized">${renderWhmSecurityToolsWorkspace({ page, locale, canRead, canManage })}</section>` }
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_SECURITY_TOOLS_CLIENT_BINDING)()(ask)
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const rows = (key: string) => [...document.querySelectorAll(`[data-whm-security-tools-rows="${key}"] tr`)]
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('security tools client parsers', () => {
  it('accepts projected reads and drops unknown fields', () => {
    expect(JSON.stringify(readIntrusionView({ ...intrusion(), secret: 'x' }))).not.toContain('secret')
    expect(readAntivirusView(antivirus()).scans.map(item => item.result)).toEqual(['infected', 'clean'])
    expect(readAntivirusView(antivirus()).scans[0]!.referenceCode).toBe('XP-JOB-2026-000123')
    expect(readAntivirusView(antivirus()).updates[0]!.referenceCode).toBeNull()
    for (const referenceCode of [undefined, jobId, 'XP-JOB-000000', 'bad\u202eref']) expect(() => readAntivirusView(antivirus({ scans: [scan('clean', { referenceCode })] }))).toThrow()
    expect(readIsolationView({ accounts: [], report }, 'alice').report!.state).toBe('drift')
    expect(readJobAck({ job: { id: jobId, referenceCode: 'XP-JOB-2026-000123', kind: 'security.antivirus.scan', status: 'queued' } }, 'security.antivirus.scan')).toEqual({ id: jobId, referenceCode: 'XP-JOB-2026-000123', status: 'queued' })
    expect(readJobAck({ job: { id: jobId, referenceCode: null, kind: 'security.antivirus.scan', status: 'queued' } }, 'security.antivirus.scan').referenceCode).toBeNull()
  })
  it('refuses inconsistent or unsafe values', () => {
    for (const bad of [{ ...intrusion(), state: 'unavailable' }, intrusion(['192.0.2.1;id']), { ...intrusion(), jails: [{ ...intrusion().jails[0], name: '-h' }] }]) expect(() => readIntrusionView(bad)).toThrow()
    for (const bad of [antivirus({ scans: [scan('clean', { infected: [{ path: '/home/alice/x', signature: 'X' }] })] }), antivirus({ scans: [scan('clean', { summary: { ...scan('clean').summary, infectedFiles: 3 } })] }), antivirus({ engine: { state: 'not_installed', version: '1.0', signatureVersion: null, signatureDate: null } })]) expect(() => readAntivirusView(bad)).toThrow()
    expect(() => readIsolationView({ accounts: [], report: { ...report, state: 'ok' } }, 'alice')).toThrow()
    expect(() => readIsolationView({ accounts: [], report }, 'bob')).toThrow()
    expect(() => readUnbanResult({ jail: 'sshd', address: '192.0.2.1', outcome: 'confirmed', after: { banned: true } }, { jail: 'sshd', address: '192.0.2.1' })).toThrow()
    expect(() => readJobAck({ job: { id: jobId, kind: 'system.packages.upgrade', status: 'queued' } }, 'security.antivirus.scan')).toThrow()
  })
})

describe('security tools client binding', () => {
  it('makes no request without transport or read authority and stays inert', async () => {
    for (const page of ['intrusion', 'antivirus', 'isolation'] as const) {
      delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
      mount(page); boot(); expect($('[data-whm-security-tools-status]').dataset.state).toBe('unavailable')
      mount(page, false); const send = vi.fn(); boot(send); await tick()
      expect(send).not.toHaveBeenCalled()
      for (const control of document.querySelectorAll<HTMLInputElement>('input,select,textarea,button')) expect(control.disabled).toBe(true)
      expect(document.querySelector('form')).toBeNull()
    }
    expect(WHM_SECURITY_TOOLS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_SECURITY_TOOLS_CLIENT_BINDING).not.toContain('fetch(')
  })
  it.each(['en', 'ar'] as const)('preserves the complete intrusion observation in %s', async locale => {
    const instant = '2026-10-27T10:11:12.345Z'
    mount('intrusion', true, false, locale)
    const send = vi.fn(async (_method: string, _path: string) => ({ ...intrusion(), observedAt: instant }))
    boot(send); await tick()
    expect($('[data-whm-security-tools-fact="observed-at"]').textContent).toBe('2026-10-27 10:11 UTC')
    expect(send).toHaveBeenCalledWith('GET', '/api/server/security-tools/intrusion')
    expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it.each(['en', 'ar'] as const)('preserves complete antivirus observation and job instants in %s', async locale => {
    const instant = '2026-10-27T10:11:12.345Z', scanAt = '2026-10-27T09:08:07.654Z', updateAt = '2026-10-27T08:07:06.543Z'
    mount('antivirus', true, false, locale)
    const send = vi.fn(async (_method: string, _path: string) => antivirus({ observedAt: instant, scans: [scan('clean', { createdAt: scanAt })], updates: [{ ...antivirus().updates[0], createdAt: updateAt }] }))
    boot(send); await tick()
    expect($('[data-whm-security-tools-fact="observed-at"]').textContent).toBe('2026-10-27 10:11 UTC')
    expect(rows('scans')[0]!.querySelector('td:first-child bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 09:08 UTC')
    expect(rows('updates')[0]!.querySelector('td:first-child bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 08:07 UTC')
    expect(send).toHaveBeenCalledWith('GET', '/api/server/security-tools/antivirus')
    expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it.each(['en', 'ar'] as const)('preserves the complete inspected isolation instant in %s', async locale => {
    const instant = '2026-10-27T10:11:12.345Z', accounts = [{ username: 'alice', status: 'active' }]
    mount('isolation', true, false, locale)
    const send = vi.fn(async (_method: string, path: string) => ({ accounts, report: path.includes('?account=') ? { ...report, observedAt: instant } : null }))
    boot(send); await tick()
    const select = $<HTMLSelectElement>('[data-whm-security-tools-account]'); select.value = 'alice'; select.dispatchEvent(new Event('change'))
    $<HTMLButtonElement>('[data-whm-security-tools-inspect]').click(); await tick()
    expect($('[data-whm-security-tools-fact="observed-at"]').textContent).toBe('2026-10-27 10:11 UTC')
    expect(send).toHaveBeenLastCalledWith('GET', '/api/server/security-tools/isolation?account=alice')
    expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('paints fail2ban jails and bans, and unbans one plain address after confirmation', async () => {
    mount('intrusion')
    const reads = [intrusion(), intrusion(['198.51.100.0/24'])]
    const send = vi.fn(async (method: string, path: string, body?: unknown) => method === 'GET' ? reads.shift() : ({ ...(body as object), outcome: 'confirmed', verificationRequired: false, after: { banned: false }, observedAt }))
    const ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/security-tools/intrusion')
    expect($('[data-whm-security-tools-fact="banned"]').textContent).toBe('2')
    expect($('[data-whm-security-tools-unsupported]').hidden).toBe(false)
    expect(rows('jails')).toHaveLength(2)
    expect(rows('banned')).toHaveLength(2)
    const buttons = document.querySelectorAll<HTMLButtonElement>('[data-whm-security-tools-unban]')
    expect(buttons[0]!.disabled).toBe(false); expect(buttons[1]!.disabled).toBe(true)
    expect(rows('banned')[0]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('192.0.2.1')
    buttons[0]!.click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('POST', '/api/server/security-tools/intrusion/unban', { jail: 'sshd', address: '192.0.2.1' })
    expect($('[data-whm-security-tools-result]').dataset.outcome).toBe('confirmed')
    expect(rows('banned')).toHaveLength(1)
    const filter = $<HTMLInputElement>('[data-whm-security-tools-filter="text"]')
    filter.value = '203.0.113'; filter.dispatchEvent(new Event('input'))
    expect(rows('banned')[0]!.textContent).toBe('No banned addresses match.')
  })
  it('reports a 409 unban conflict as unchanged', async () => {
    mount('intrusion')
    const send = vi.fn(async (method: string) => { if (method === 'GET') return intrusion(); throw Object.assign(new Error('refused'), { status: 409, code: 'CONFLICT', details: { stateChanged: false } }) })
    boot(send, async () => true); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-security-tools-unban]')!.click(); await tick()
    expect($('[data-whm-security-tools-result]').dataset.outcome).toBe('conflict')
    expect($('[data-whm-security-tools-result]').textContent).toContain('Nothing was changed.')
  })
  it('shows not-installed truthfully with the Software center link and no unban controls', async () => {
    mount('intrusion')
    boot(async () => ({ state: 'not_installed', observedAt, jails: [], unsupportedJails: 0, jailsTruncated: false })); await tick()
    expect($('[data-whm-security-tools-install]').hidden).toBe(false)
    expect($('[data-whm-security-tools-fact="service"]').textContent).toBe('Not installed')
    expect(document.querySelectorAll('[data-whm-security-tools-unban]')).toHaveLength(0)
  })
  it('paints ClamAV, lists findings and submits a scan for the selected account only', async () => {
    mount('antivirus')
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? antivirus() : { job: { id: jobId, referenceCode: 'XP-JOB-2026-000123', kind: path.endsWith('/scan') ? 'security.antivirus.scan' : 'security.antivirus.signatures', status: 'queued' } })
    boot(send, async () => true); await tick()
    expect($('[data-whm-security-tools-fact="engine"]').textContent).toBe('1.0.7')
    expect(rows('scans')).toHaveLength(2)
    expect(rows('scans')[0]!.textContent).toContain('Infected files found')
    expect(rows('findings')[0]!.textContent).toContain('/home/alice/x.php')
    expect(rows('updates')[0]!.textContent).toContain('Already up to date')
    const scanLink = rows('scans')[0]!.querySelector('a')!
    expect(scanLink.textContent).toBe('XP-JOB-2026-000123')
    expect(scanLink.getAttribute('aria-label')).toBe('Open job XP-JOB-2026-000123')
    expect(scanLink.getAttribute('href')).toBe('/whm/jobs?job=' + jobId)
    expect(rows('updates')[0]!.querySelector('a')!.textContent).toBe('Unnumbered')
    expect(rows('updates')[0]!.querySelector('a')!.getAttribute('aria-label')).toBe('Open job Unnumbered')
    expect(document.body.textContent).not.toContain(jobId)
    const scanButton = $<HTMLButtonElement>('[data-whm-security-tools-scan]')
    expect(scanButton.disabled).toBe(true)
    const select = $<HTMLSelectElement>('[data-whm-security-tools-account]')
    expect([...select.options].map(option => option.textContent)).toEqual(['Select an account', 'alice', 'bob (suspended)'])
    select.value = 'alice'; select.dispatchEvent(new Event('change'))
    expect(scanButton.disabled).toBe(false)
    scanButton.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/security-tools/antivirus/scan', { account: 'alice' })
    expect($('[data-whm-security-tools-result]').dataset.outcome).toBe('submitted')
    expect($<HTMLAnchorElement>('[data-whm-security-tools-job-link]').getAttribute('href')).toBe('/whm/jobs?job=' + jobId)
    $<HTMLButtonElement>('[data-whm-security-tools-update]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/security-tools/antivirus/update', {})
  })
  it('keeps scan and update disabled without host jobs or an installed engine', async () => {
    mount('antivirus')
    boot(async () => antivirus({ jobsAvailable: false, scans: [], updates: [] })); await tick()
    const select = $<HTMLSelectElement>('[data-whm-security-tools-account]'); select.value = 'alice'; select.dispatchEvent(new Event('change'))
    expect($<HTMLButtonElement>('[data-whm-security-tools-scan]').disabled).toBe(true)
    expect($<HTMLButtonElement>('[data-whm-security-tools-update]').disabled).toBe(true)
    expect($('[data-whm-security-tools-status]').textContent).toContain('Host jobs are unavailable')
    mount('antivirus')
    boot(async () => antivirus({ engine: { state: 'not_installed', version: null, signatureVersion: null, signatureDate: null }, updater: { present: false } })); await tick()
    expect($('[data-whm-security-tools-install]').hidden).toBe(false)
    expect($<HTMLButtonElement>('[data-whm-security-tools-update]').disabled).toBe(true)
  })
  it('lists accounts and inspects one account isolation report in Arabic', async () => {
    mount('isolation', true, true, 'ar')
    const send = vi.fn(async (_method: string, path: string) => path.includes('?account=') ? { accounts: [{ username: 'alice', status: 'active' }], report } : { accounts: [{ username: 'alice', status: 'active' }], report: null })
    boot(send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/security-tools/isolation')
    const select = $<HTMLSelectElement>('[data-whm-security-tools-account]'); select.value = 'alice'; select.dispatchEvent(new Event('change'))
    $<HTMLButtonElement>('[data-whm-security-tools-inspect]').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('GET', '/api/server/security-tools/isolation?account=alice')
    expect(rows('checks')).toHaveLength(2)
    expect(rows('checks')[1]!.textContent).toContain('هوية PHP-FPM 8.3')
    expect(rows('checks')[1]!.textContent).toContain('انحراف')
    expect($('[data-whm-security-tools-drift]').hidden).toBe(false)
    expect($('[data-whm-security-tools-fact="uid"]').textContent).toBe('1001')
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
  })
})


type SecurityTheme = 'classic' | 'v2'
const mountSecurityTheme = (theme: SecurityTheme, page: WhmSecurityToolsPage = 'intrusion', canRead = true, canManage = true, locale: 'en' | 'ar' = 'en'): void => {
  if (theme === 'classic') { mount(page, canRead, canManage, locale); return }
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderV2WhmSecurityTool({ locale, principal: { kind: 'root', id: 'fixture-root', username: 'operator' }, observationAuthority: { canRead, canManage } }, page)
}
const unbanPrototype = (): HTMLTemplateElement => document.querySelector<HTMLTemplateElement>('template[data-xp-template="whm-security-unban"]')!
const securityPrototypeFaults = ['missing', 'duplicate', 'wrong-root', 'missing-slot', 'duplicate-slot', 'unknown-slot', 'wrong-slot-tag', 'enabled', 'submit'] as const
const damageUnbanPrototype = (fault: typeof securityPrototypeFaults[number]): void => {
  const template = unbanPrototype(); expect(template).not.toBeNull()
  const button = template.content.firstElementChild as HTMLButtonElement
  if (fault === 'missing') { template.remove(); return }
  if (fault === 'duplicate') { template.after(template.cloneNode(true)); return }
  if (fault === 'wrong-root') { const span = document.createElement('span'); span.dataset.xpSlot = 'content'; button.replaceWith(span); return }
  if (fault === 'missing-slot') button.removeAttribute('data-xp-slot')
  if (fault === 'duplicate-slot') { const span = document.createElement('span'); span.dataset.xpSlot = 'content'; button.append(span) }
  if (fault === 'unknown-slot') button.dataset.xpSlot = 'unreviewed'
  if (fault === 'wrong-slot-tag') { button.removeAttribute('data-xp-slot'); const span = document.createElement('span'); span.dataset.xpSlot = 'content'; button.append(span) }
  if (fault === 'enabled') button.disabled = false
  if (fault === 'submit') button.type = 'submit'
}

describe.each(['classic', 'v2'] as const)('%s intrusion finite button contract', theme => {
  it.each(['en', 'ar'] as const)('clones the selected %s theme button and preserves confirmed unban plus readback', async locale => {
    mountSecurityTheme(theme, 'intrusion', true, true, locale)
    const prototype = unbanPrototype().content.firstElementChild as HTMLButtonElement
    expect(prototype.type).toBe('button'); expect(prototype.disabled).toBe(true)
    expect(prototype.classList.contains(theme === 'classic' ? 'xp-btn' : 'v2-btn')).toBe(true)
    expect(document.querySelector('[data-whm-security-tools-unban]')).toBeNull()
    let unbanned = false
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'GET') return intrusion(unbanned ? ['198.51.100.0/24'] : undefined)
      unbanned = true; return { ...(body as object), outcome: 'confirmed', verificationRequired: false, after: { banned: false }, observedAt }
    })
    const ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-whm-security-tools-unban]')]
    expect(buttons[0]!.className).toBe(prototype.className)
    expect(buttons[0]!.textContent).toBe(translator(locale)('Unban'))
    expect(buttons[0]!.getAttribute('aria-label')).toBe(translator(locale)('Unban {address} · {jail}', { address: '192.0.2.1', jail: 'sshd' }))
    expect(buttons[0]!.type).toBe('button'); expect(buttons[0]!.disabled).toBe(false); expect(buttons[1]!.disabled).toBe(true); expect(prototype.disabled).toBe(true)
    if (theme === 'v2') expect(buttons[0]!.classList.contains('xp-btn')).toBe(false)
    buttons[0]!.click(); await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(send.mock.calls).toEqual([['GET', '/api/server/security-tools/intrusion'], ['POST', '/api/server/security-tools/intrusion/unban', { jail: 'sshd', address: '192.0.2.1' }], ['GET', '/api/server/security-tools/intrusion']])
    expect($('[data-whm-security-tools-result]').dataset.outcome).toBe('confirmed'); expect(rows('banned')).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it.each(securityPrototypeFaults)('blocks the initial GET for a %s prototype', async fault => {
    mountSecurityTheme(theme); damageUnbanPrototype(fault)
    const send = vi.fn(), ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    expect(send).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled()
    expect($('[data-whm-security-tools-status]').dataset.state).toBe('unavailable')
    expect([...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')].every(control => control.disabled)).toBe(true)
    expect($('[data-whm-security-tools-fact="service"]').textContent).toBe('Not read')
  })
  it('retains read authority while denying every unban without mutation authority', async () => {
    mountSecurityTheme(theme, 'intrusion', true, false)
    const send = vi.fn(async (_method: string, _path: string) => intrusion()), ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    const button = document.querySelector<HTMLButtonElement>('[data-whm-security-tools-unban]')!
    expect(button.disabled).toBe(true); button.disabled = false; button.click(); await tick()
    expect(ask).not.toHaveBeenCalled(); expect(send.mock.calls).toEqual([['GET', '/api/server/security-tools/intrusion']])
  })
  it.each(['resolved', 'rejected'] as const)('locks a prototype lost during a %s initial read', async settlement => {
    mountSecurityTheme(theme)
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void
    const send = vi.fn((_method: string, _path: string) => new Promise<unknown>((yes, no) => { resolve = yes; reject = no }))
    boot(send); await tick(); expect(send).toHaveBeenCalledOnce(); unbanPrototype().remove()
    if (settlement === 'resolved') resolve(intrusion()); else reject(new Error('unavailable'))
    await tick()
    expect($('[data-whm-security-tools-status]').dataset.state).toBe('unavailable')
    expect($('[data-whm-security-tools-fact="service"]').textContent).toBe('Not read')
    expect(document.querySelector('[data-whm-security-tools-unban]')).toBeNull()
    const refresh = $<HTMLButtonElement>('[data-whm-security-tools-refresh]')
    expect(refresh.disabled).toBe(true); refresh.disabled = false; refresh.click(); await tick(); expect(send).toHaveBeenCalledOnce()
  })
  it('sends no unban or readback after prototype loss during confirmation', async () => {
    mountSecurityTheme(theme)
    let confirm!: (value: boolean) => void
    const ask = vi.fn(() => new Promise<boolean>(yes => { confirm = yes }))
    const send = vi.fn(async (_method: string, _path: string) => intrusion())
    boot(send, ask); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-security-tools-unban]')!.click(); await tick()
    expect(ask).toHaveBeenCalledOnce(); unbanPrototype().remove(); confirm(true); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/server/security-tools/intrusion']])
    expect($('[data-whm-security-tools-status]').dataset.state).toBe('unavailable')
    expect(document.querySelector<HTMLButtonElement>('[data-whm-security-tools-unban]')!.disabled).toBe(true)
  })
  it.each(['resolved', 'rejected'] as const)('keeps a %s unban unverified and blocks readback after prototype loss', async settlement => {
    mountSecurityTheme(theme)
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void
    const send = vi.fn((method: string, _path: string, _body?: unknown) => method === 'GET' ? Promise.resolve(intrusion()) : new Promise<unknown>((yes, no) => { resolve = yes; reject = no }))
    boot(send, async () => true); await tick()
    const button = document.querySelector<HTMLButtonElement>('[data-whm-security-tools-unban]')!
    button.click(); await tick(); expect(send).toHaveBeenCalledTimes(2); unbanPrototype().remove()
    if (settlement === 'resolved') resolve({ jail: 'sshd', address: '192.0.2.1', outcome: 'confirmed', after: { banned: false } }); else reject(new Error('transport failed'))
    await tick()
    expect($('[data-whm-security-tools-result]').dataset.outcome).toBe('unknown')
    expect($('[data-whm-security-tools-status]').dataset.state).toBe('unavailable')
    expect(document.querySelector('[data-whm-security-tools-workspace]')!.getAttribute('aria-busy')).toBe('false')
    expect(button.disabled).toBe(true); button.disabled = false; button.click(); await tick()
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET', 'POST'])
  })
  it.each(['antivirus', 'isolation'] as const)('keeps %s independent of the intrusion-only prototype', async page => {
    mountSecurityTheme(theme, page); expect(unbanPrototype()).toBeNull()
    document.querySelector('[data-whm-security-tools-workspace]')!.insertAdjacentHTML('beforeend', '<template data-xp-template="whm-security-unban"><div>unrelated malformed prototype</div></template>')
    const send = vi.fn(async (_method: string, _path: string) => page === 'antivirus' ? antivirus() : { accounts: [], report: null })
    boot(send); await tick()
    expect($('[data-whm-security-tools-status]').dataset.state).toBe('read')
    expect(send.mock.calls).toEqual([['GET', '/api/server/security-tools/' + page]])
    expect(document.querySelector('[data-whm-security-tools-unban]')).toBeNull()
  })
})
