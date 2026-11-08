// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderClassicDbProfilesCard } from './board-port/db-profiles-card.ts'
import { renderClassicDnsClusterSection } from './board-port/dns-cluster-section.ts'
import { DNS_CLUSTER_CLIENT_BINDING } from './dns-cluster-client.ts'
import { WHM_DB_PROFILES_CLIENT_BINDING } from './whm-db-profiles-client.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const tick = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const set = (key: string, value: string) => { $<HTMLInputElement>(`[data-sec-input="${key}"]`).value = value }
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), PIN = 'c'.repeat(64), TOKEN = 'xpdc_' + 'z'.repeat(43)
const runtime = { state: 'auto_disabled', failures: 10, failureCode: 'unreachable', lastAttemptAt: null, lastSuccessAt: null, outageSince: '2026-11-07T10:00:00.000Z', nextAttemptAt: null }
const member = { name: 'ns2.beta.test', address: '192.0.2.2', port: 2087, pin: PIN, role: 'synchronize', createdAt: '2026-11-07T10:00:00.000Z', runtime }
const view = (over: Record<string, unknown> = {}) => ({ state: 'saved', revision: R1, enabled: true, failureThreshold: 10, updatedAt: null, members: [], inbound: [], conflicts: [], pin: PIN, observation: 'read', ...over })
const mount = (html: string, binding: string, send: Send, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  document.body.innerHTML = html
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + binding)()(ask)
}
const cluster = (send: Send, ask?: (options: Record<string, unknown>) => Promise<unknown>, canManage = true) => mount(renderClassicDnsClusterSection({ locale: 'en', canRead: true, canManage }), DNS_CLUSTER_CLIENT_BINDING, send, ask)
afterEach(() => { document.body.innerHTML = '' })

describe('DNS cluster client', () => {
  it('shows this server\'s pin and adds a member, leaving no token in the page', async () => {
    const send = vi.fn<Send>(async method => method === 'POST' ? view({ revision: R2, members: [{ ...member, runtime: null }] }) : view())
    cluster(send); await tick()
    expect($('[data-sec-field="cluster-pin"]').textContent).toBe(PIN)
    expect($('[data-sec-rows="members"]').textContent).toContain('No members are saved')
    for (const [key, value] of [['member-name', 'NS2.beta.test'], ['member-address', '192.0.2.2'], ['member-pin', PIN], ['member-token', TOKEN]] as const) set(key, value)
    $<HTMLButtonElement>('[data-sec-action="member-add"]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/dns-cluster/members', { name: 'ns2.beta.test', address: '192.0.2.2', port: 2087, pin: PIN, token: TOKEN, role: 'synchronize', expectedRevision: R1 })
    expect($<HTMLInputElement>('[data-sec-input="member-token"]').value).toBe('')
    expect($('[data-sec-rows="members"]').textContent).toContain('ns2.beta.test')
    expect(document.body.textContent).not.toContain('xpdc_')
  })
  it('shows an issued token once, and names a refused pin', async () => {
    const send = vi.fn<Send>(async (method, path) => {
      if (path.endsWith('/inbound')) return { ...view({ revision: R2 }), token: TOKEN }
      if (path.endsWith('/members')) throw Object.assign(new Error('refused'), { status: 412, details: { stateChanged: false, reason: 'pin_mismatch' } })
      return view()
    })
    cluster(send); await tick()
    set('inbound-name', 'ns1.alpha.test'); set('inbound-address', '192.0.2.1')
    $<HTMLButtonElement>('[data-sec-action="inbound-issue"]').click(); await tick()
    expect($('[data-sec-field="issued-token"]').textContent).toBe(TOKEN)
    expect($('[data-sec-result]').textContent).toContain('not shown again')
    for (const [key, value] of [['member-name', 'ns2.beta.test'], ['member-address', '192.0.2.2'], ['member-pin', PIN], ['member-token', TOKEN]] as const) set(key, value)
    $<HTMLButtonElement>('[data-sec-action="member-add"]').click(); await tick()
    expect($('[data-sec-result]').textContent).toContain('different key')
  })
  it('paints outage, conflict and DNSSEC states, and overwrites only what the source may settle', async () => {
    const conflicts = [{ member: 'ns2.beta.test', zone: 'edited.test', state: 'conflict', reason: 'modified_here', serial: 5, at: '2026-11-07T10:00:00.000Z' }, { member: 'ns2.beta.test', zone: 'owned.test', state: 'conflict', reason: 'owned_locally', serial: 6, at: '2026-11-07T10:00:00.000Z' }, { member: 'ns2.beta.test', zone: 'signed.test', state: 'dnssec_signed', reason: null, serial: 7, at: '2026-11-07T10:00:00.000Z' }]
    const ask = vi.fn(async () => true)
    const send = vi.fn<Send>(async (method, path) => path.endsWith('/sync') ? { observedAt: 'now', mode: 'push', members: [{ member: 'ns2.beta.test', written: 1, removed: 0, unchanged: 0, conflicts: [], failure: null, skipped: null, verified: { serial: 5, inSync: true } }] } : path.endsWith('/reset') ? view() : view({ members: [member], conflicts }))
    cluster(send, ask); await tick()
    const rows = $('[data-sec-rows="members"]').textContent
    expect(rows).toContain('Disabled after repeated failures since')
    const zones = $('[data-sec-rows="conflicts"]')
    expect(zones.textContent).toContain('The copy was edited on the member')
    expect(zones.textContent).toContain('An account on the member holds this zone')
    expect(zones.textContent).toContain('Not copied: the zone is DNSSEC-signed')
    const buttons = [...zones.querySelectorAll('button')]
    expect(buttons.map(button => button.disabled)).toEqual([false, true, true])
    buttons[0]!.click(); await tick()
    expect(ask).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/dns-cluster/sync', { mode: 'push', zone: 'edited.test', member: 'ns2.beta.test', includeMissing: false, force: true })
    expect($('[data-sec-rows="sync"]').textContent).toContain('Served with serial 5')
    const reenable = [...$('[data-sec-rows="members"]').querySelectorAll('button')].find(button => button.textContent === 'Re-enable')!
    expect(reenable.disabled).toBe(false)
    reenable.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/dns-cluster/members/ns2.beta.test/reset', {})
  })
  it('maps the four sync modes and asks for a zone when one is needed', async () => {
    const send = vi.fn<Send>(async (_method, path) => path.endsWith('/sync') ? { members: [] } : view())
    cluster(send); await tick()
    set('sync-mode', 'one-all')
    $<HTMLButtonElement>('[data-sec-action="sync-run"]').click(); await tick()
    expect($('[data-sec-result]').textContent).toContain('Enter the zone')
    set('sync-zone', 'One.test'); $<HTMLButtonElement>('[data-sec-action="sync-run"]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/dns-cluster/sync', { mode: 'push', zone: 'one.test', member: null, includeMissing: false, force: false })
    set('sync-mode', 'all-here'); $<HTMLInputElement>('[data-sec-input="sync-missing"]').checked = true
    $<HTMLButtonElement>('[data-sec-action="sync-run"]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/dns-cluster/sync', { mode: 'pull', zone: null, member: null, includeMissing: true, force: false })
  })
  it('keeps every write control closed until the tool is qualified', async () => {
    cluster(vi.fn<Send>(async () => view({ members: [member] })), undefined, false); await tick()
    expect($('[data-sec-field="cluster-state"]').textContent).toBe('On')
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-sec-action]:not([data-sec-action="cluster-refresh"]),[data-sec-rows] button')) expect(button.disabled).toBe(true)
  })
})

describe('database profiles client', () => {
  const profile = { name: 'remote1', host: '192.0.2.50', port: 3306, user: 'u', description: '', tls: true, validation: { state: 'failed', reason: 'access_denied', version: null, clientHost: null, at: '2026-11-07T10:00:00.000Z' } }
  const listing = (active = 'localhost') => ({ active, localProfile: 'localhost', profiles: [profile] })
  const profiles = (send: Send, ask?: (options: Record<string, unknown>) => Promise<unknown>) => mount(renderClassicDbProfilesCard('en', true, true), WHM_DB_PROFILES_CLIENT_BINDING, send, ask)
  it('saves a profile and clears the password from the page', async () => {
    const send = vi.fn<Send>(async () => listing())
    profiles(send); await tick()
    expect($('[data-sec-rows="profiles"]').textContent).toContain('The server refused the user or password')
    for (const [key, value] of [['profile-name', 'remote2'], ['profile-host', '192.0.2.51'], ['profile-port', '3306'], ['profile-user', 'admin'], ['profile-password', 'Secret1!']] as const) set(key, value)
    $<HTMLButtonElement>('[data-sec-action="profile-save"]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/db-profiles', { name: 'remote2', host: '192.0.2.51', port: 3306, user: 'admin', password: 'Secret1!', description: '', ca: null })
    expect($<HTMLInputElement>('[data-sec-input="profile-password"]').value).toBe('')
    expect(document.body.textContent).not.toContain('Secret1!')
  })
  it('edits without a password, keeps the name fixed and locks the active row', async () => {
    const send = vi.fn<Send>(async () => listing())
    profiles(send); await tick()
    const row = [...$('[data-sec-rows="profiles"]').querySelectorAll('tr')].find(item => item.textContent?.includes('remote1'))!
    ;[...row.querySelectorAll('button')].find(button => button.textContent === 'Edit')!.click(); await tick()
    expect($<HTMLInputElement>('[data-sec-input="profile-name"]').readOnly).toBe(true)
    $<HTMLButtonElement>('[data-sec-action="profile-save"]').click(); await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/db-profiles/remote1', { name: 'remote1', host: '192.0.2.50', port: 3306, user: 'u', password: null, description: '', ca: null })
  })
  it('explains PROFILE_INVALID and PROFILE_HAS_DATABASES after the confirmation', async () => {
    const refusals = [{ reason: 'PROFILE_INVALID', failure: 'access_denied' }, { reason: 'PROFILE_HAS_DATABASES' }]
    const send = vi.fn<Send>(async (method, path) => { if (path.endsWith('/activate')) throw Object.assign(new Error('refused'), { status: 412, details: { stateChanged: false, ...refusals.shift() } }); return listing() })
    profiles(send, vi.fn(async () => true)); await tick()
    const activate = (): void => [...$('[data-sec-rows="profiles"]').querySelectorAll('tr')].find(item => item.textContent?.includes('remote1'))!.querySelectorAll('button')[1]!.click()
    activate(); await tick()
    expect($('[data-sec-result]').textContent).toContain('did not pass validation: The server refused the user or password. The previous profile stays active.')
    activate(); await tick()
    expect($('[data-sec-result]').textContent).toContain('switching never moves them')
  })
})
