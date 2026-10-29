// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderSecWorkspace } from './board-port/sec-workspace.ts'
import type { SecPage } from './board-port/sec-workspace.ts'
import { readSecAccountWafView, readSecSavedView, SEC_SECURITY_CLIENT_BINDING } from './sec-security-client.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const tick = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64)
const waf = { requestsPerSecond: 20, burst: 40, maxBodyMb: 256, deniedResponse: 403, denyIps: ['198.51.100.0/24'], denyPaths: ['^/\\.git'], denyUserAgents: [], modsecurity: true }
const host = { observedAt: '2026-10-28T12:00:00.000Z', family: 'debian', connector: { nginx: false, apache: true }, engineConf: { path: null, ruleEngine: null }, crs: { dir: null, version: null }, active: { lists: true, modsecurity: false } }
const view = (policy: unknown, revision = R1, extra: Record<string, unknown> = {}) => ({ state: 'saved', policy, updatedAt: '2026-10-28T11:00:00.000Z', revision, ...extra })
const boot = (page: SecPage, send?: Send, ask?: (options: Record<string, unknown>) => Promise<unknown>, locale: 'en' | 'ar' = 'en', canManage = true) => {
  delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest
  document.body.innerHTML = renderSecWorkspace({ page, locale, canRead: true, canManage })
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + SEC_SECURITY_CLIENT_BINDING)()(ask)
}
afterEach(() => { document.body.innerHTML = ''; document.documentElement.lang = ''; document.documentElement.dir = '' })

describe('sec security client readers', () => {
  it('rejects policies outside the grammar shape and invented account WAF rows', () => {
    expect(readSecSavedView(view(waf), 'waf').policy).toEqual(waf)
    expect(() => readSecSavedView(view({ ...waf, extra: 1 }), 'waf')).toThrow()
    expect(() => readSecSavedView(view({ ...waf, deniedResponse: 200 }), 'waf')).toThrow()
    expect(() => readSecSavedView({ ...view(waf), state: 'invalid' }, 'waf')).toThrow()
    expect(() => readSecSavedView(view({ listeners: { xpanel: [], xwhm: [{ cidr: 'x y', note: '' }], xmail: [] } }), 'panel-access')).toThrow()
    expect(() => readSecAccountWafView({ server: null, live: null, revision: R1, domains: [{ domain: 'A.test', modsecurity: true }] })).toThrow()
  })
})

describe('sec security bindings', () => {
  it('stays unavailable without transport or authority and never uses innerHTML', async () => {
    const send = vi.fn<Send>(async () => view(waf))
    boot('waf'); await tick()
    expect($('[data-sec-status]').dataset.state).toBe('unavailable')
    boot('waf', send, undefined, 'en', false); await tick()
    expect($<HTMLButtonElement>('[data-sec-action="save"]').disabled).toBe(true)
    expect($<HTMLTextAreaElement>('[data-sec-input="deny-ips"]').disabled).toBe(true)
    expect(SEC_SECURITY_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('paints the saved WAF policy and the observed ModSecurity state, then saves the captured revision with a read-back', async () => {
    let saved = false
    const send = vi.fn<Send>(async method => method === 'PUT' ? (saved = true, view({ ...waf, deniedResponse: 444 }, R2, { observation: host, reconcile: 'requested' })) : saved ? view({ ...waf, deniedResponse: 444 }, R2, { observation: host }) : view(waf, R1, { observation: host, reason: null }))
    boot('waf', send); await tick()
    expect($<HTMLInputElement>('[data-sec-input="rate"]').value).toBe('20')
    expect($('[data-sec-field="modsec-state"]').textContent).toBe('Not installed')
    expect($('[data-sec-install]').hidden).toBe(false)
    expect($('[data-sec-field="lists-active"]').textContent).toBe('Yes')
    $<HTMLSelectElement>('[data-sec-input="denied"]').value = '444'
    $<HTMLButtonElement>('[data-sec-action="save"]').click(); await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/sec/waf', { policy: { ...waf, deniedResponse: 444 }, expectedRevision: R1 })
    expect($('[data-sec-result]').textContent).toContain('asked to apply')
  })
  it('keeps the draft and reports a conflict without retrying', async () => {
    const send = vi.fn<Send>(async method => { if (method === 'GET') return view({ ...waf, requestsPerSecond: null, burst: null }); throw { status: 409, code: 'CONFLICT', details: { stateChanged: false } } })
    boot('waf', send); await tick()
    expect($<HTMLInputElement>('[data-sec-input="rate-unlimited"]').checked).toBe(true)
    $<HTMLTextAreaElement>('[data-sec-input="deny-ips"]').value = '192.0.2.1'
    $<HTMLButtonElement>('[data-sec-action="save"]').click(); await tick()
    expect($('[data-sec-result]').dataset.outcome).toBe('conflict')
    expect($<HTMLTextAreaElement>('[data-sec-input="deny-ips"]').value).toBe('192.0.2.1')
    expect(send.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(1)
  })
  it('parses allowlist notes, reports enforcement and refuses a self-lockout without claiming success', async () => {
    const access = { listeners: { xpanel: [], xwhm: [{ cidr: '203.0.113.7', note: 'root office' }], xmail: [] } }
    const send = vi.fn<Send>(async method => { if (method === 'GET') return view(access, R1, { client: { listener: 'xwhm', address: '203.0.113.7', admitted: { xpanel: true, xwhm: true, xmail: true } }, enforcement: 'not_connected' }); throw { status: 409, code: 'CONFLICT', details: { stateChanged: false, reason: 'self_lockout' } } })
    boot('panel-access', send); await tick()
    expect($<HTMLTextAreaElement>('[data-sec-input="xwhm"]').value).toBe('203.0.113.7  # root office')
    expect($('[data-sec-field="enforcement"]').textContent).toContain('not enforced')
    $<HTMLTextAreaElement>('[data-sec-input="xwhm"]').value = '198.51.100.0/24 # vpn'
    $<HTMLButtonElement>('[data-sec-action="save"]').click(); await tick()
    expect(send.mock.calls.at(-1)).toEqual(['PUT', '/api/server/sec/panel-access', { policy: { listeners: { xpanel: [], xwhm: [{ cidr: '198.51.100.0/24', note: 'vpn' }], xmail: [] } }, expectedRevision: R1 }])
    expect($('[data-sec-result]').dataset.outcome).toBe('lockout')
  })
  it('shows the flood kernel state and refuses non-numeric limits locally', async () => {
    const flood = { enabled: true, connectionsPerAddress: 100, newConnectionsPerSecond: null, newConnectionsBurst: null, pingPerSecond: 10, webConnectionsPerAddress: null }
    const send = vi.fn<Send>(async () => view(flood, R1, { observation: { observedAt: host.observedAt, state: 'read', reason: null, rules: { connections: 2, rate: 0, ping: 2 }, tracked: [{ set: 'xpanel_flood_conn4', elements: 3 }] } }))
    boot('flood', send); await tick()
    expect($('[data-sec-rows="kernel"]').textContent).toContain('3')
    $<HTMLInputElement>('[data-sec-input="conn"]').value = '1e3'
    $<HTMLButtonElement>('[data-sec-action="save"]').click(); await tick()
    expect($('[data-sec-result]').dataset.outcome).toBe('invalid')
    expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
  })
  it('fills Last apply request from the saved state and then from the apply result of a save', async () => {
    const flood = { enabled: true, connectionsPerAddress: 100, newConnectionsPerSecond: null, newConnectionsBurst: null, pingPerSecond: 10, webConnectionsPerAddress: null }
    let saved = false
    const send = vi.fn<Send>(async method => method === 'PUT' ? (saved = true, { ...view(flood, R2, { reconcile: 'not_connected' }), updatedAt: '2026-10-28T12:30:00.000Z' }) : saved ? { ...view(flood, R2), updatedAt: '2026-10-28T12:30:00.000Z' } : view(flood, R1))
    boot('flood', send); await tick()
    expect($('[data-sec-field="reconcile"]').textContent).toBe('2026-10-28 11:00 UTC (with the last save; the result is not stored)')
    $<HTMLButtonElement>('[data-sec-action="save"]').click(); await tick()
    expect($('[data-sec-field="reconcile"]').textContent).toBe('2026-10-28 12:30 UTC: not sent; no host agent is connected')
    $<HTMLButtonElement>('[data-sec-action="refresh"]').click(); await tick()
    expect($('[data-sec-field="reconcile"]').textContent).toContain('no host agent is connected')
    boot('waf', vi.fn<Send>(async () => ({ ...view(waf), state: 'default', updatedAt: null }))); await tick()
    expect($('[data-sec-field="reconcile"]').textContent).toBe('No apply request has been made.')
  })
  it('switches ModSecurity for an owned domain after confirmation and renders RTL with ASCII digits', async () => {
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'
    const base = { server: { requestsPerSecond: 20, burst: 40, maxBodyMb: 128, deniedResponse: 403, modsecurity: true, lists: { addresses: 1, paths: 2, userAgents: 0 } }, live: { connector: true, crsVersion: '4.7.0', active: { lists: true, modsecurity: true } }, revision: R1, domains: [{ domain: 'alice.test', modsecurity: true }] }
    let off = false
    const send = vi.fn<Send>(async method => method === 'PUT' ? (off = true, { ...base, revision: R2, domains: [{ domain: 'alice.test', modsecurity: false }], reconcile: 'requested' }) : off ? { ...base, revision: R2, domains: [{ domain: 'alice.test', modsecurity: false }] } : base)
    const ask = vi.fn(async () => true)
    boot('account-waf', send, ask, 'ar'); await tick()
    expect($('[data-sec-workspace]').getAttribute('dir')).toBe('rtl')
    expect($('[data-sec-field="crs-version"]').textContent).toBe('4.7.0')
    $<HTMLButtonElement>('[data-sec-rows="domains"] button').click(); await tick()
    expect(ask).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('PUT', '/api/account/sec/waf', { domain: 'alice.test', modsecurity: false, expectedRevision: R1 })
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
