import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultFirewallRules } from '@xpanel/core'
import type { FirewallRule, ServerSettings } from '@xpanel/core'
import { createTestStateStore, firewallRevision, type TestStateStoreHandle } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { diffRules, exportFirewall, FIREWALL_CONFIRM_WINDOW_MS, handleFirewallWorkspaceRoute, readFirewallImport, systemRuleErrors } from './firewall-workspace.ts'

const caller = { principal: { kind: 'root', id: 'root-id', username: 'root' } } as AuthenticatedCaller
const settings = { panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443, hostname: 'srv.example.test', nameservers: [], adminEmail: 'root@example.test', engine: 'apache', apacheMpm: 'itk' } as unknown as ServerSettings
const base = defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 })
const office: FirewallRule = { id: 'office-mysql', kind: 'port', action: 'accept', protocol: 'tcp', port: '3306', source: '203.0.113.0/28', forwardTo: null, list: null, comment: 'office', enabled: true }
const SESSION = '203.0.113.7'

let h: TestStateStoreHandle
let clock: Date
let timers: { at: Date; run: () => Promise<void> }[]
let reconcileOk: boolean
let audits: { action: string; outcome: string }[]
const helpers = () => ({
  requireCaller: async () => caller, assertRoot: vi.fn(async () => {}),
  store: Object.assign(Object.create(h.store), { getServerSettings: async () => settings }) as typeof h.store,
  clientIp: () => SESSION,
  reconcile: vi.fn(async () => ({ ok: reconcileOk, status: reconcileOk ? 200 : 500, body: { generation: 143 } })),
  bans: vi.fn(async (_caller: AuthenticatedCaller, unban?: { addresses: unknown }) => Response.json(unban ? { unbanned: unban.addresses, stillBanned: [] } : { state: 'read', bans: [{ address: '198.51.100.9', timeoutSec: 3600, expiresSec: 1200 }] })),
  audit: async (_caller: AuthenticatedCaller, action: string, _target: string, _detail: Record<string, unknown>, outcome = 'ok') => { audits.push({ action, outcome }) },
  schedule: (at: Date, run: () => Promise<void>) => { timers.push({ at, run }) },
  now: () => clock,
})
const call = async (method: string, path: string, body?: unknown, use = helpers()) => {
  const url = new URL('https://panel.test' + path)
  const response = await handleFirewallWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, use)
  return { response: response!, body: response!.headers.get('content-type')?.includes('json') ? await response!.json() as Record<string, any> : null }
}
const revision = async () => firewallRevision(await h.store.getFirewallState())

beforeEach(async () => {
  h = await createTestStateStore(); clock = new Date('2026-10-29T00:00:00.000Z'); timers = []; reconcileOk = true; audits = []
  await h.store.replaceFirewall({ rules: [...base, office], prefixLists: [{ name: 'blocklist_feed', entries: ['192.0.2.0/24'] }] }, { lockout: null })
})
afterEach(async () => { await h.close() })

describe('firewall rule-set rules', () => {
  it('lets system rules move and narrow but never be deleted, widened or unlocked', () => {
    const ssh = base.find(rule => rule.id === 'default-ssh')!
    expect(systemRuleErrors(base, [...base].reverse())).toEqual([])
    expect(systemRuleErrors(base, base.map(rule => rule.id === 'default-ssh' ? { ...rule, source: '203.0.113.0/24' } : rule))).toEqual([])
    expect(systemRuleErrors(base, base.filter(rule => rule !== ssh))[0]).toContain('cannot be deleted')
    expect(systemRuleErrors(base, base.map(rule => rule.id === 'default-ssh' ? { ...rule, port: '2222' } : rule))[0]).toContain('narrowed by source')
    const narrowed = base.map(rule => rule.id === 'default-ssh' ? { ...rule, source: '203.0.113.0/24' } : rule)
    expect(systemRuleErrors(narrowed, base)[0]).toContain('inside 203.0.113.0/24')
    expect(systemRuleErrors(base, base.map(rule => rule.id === 'default-backend-loopback-v4' ? { ...rule, source: '127.0.0.1' } : rule))[0]).toContain('locked to loopback')
    expect(systemRuleErrors(base, [...base, { ...office, id: 'default-mine' }])[0]).toContain('reserved')
  })

  it('round-trips the project firewall bundle and refuses unknown versions or lists it does not carry', () => {
    const lists = [{ name: 'blocklist_feed', entries: ['192.0.2.0/24'] }]
    const listRule: FirewallRule = { ...office, id: 'list-feed', kind: 'prefix-list', action: 'drop', source: null, list: 'blocklist_feed' }
    const state = { rules: [...base, office, listRule], prefixLists: lists }
    const text = exportFirewall(state, new Date('2026-10-29T00:00:00Z'))
    expect(JSON.parse(text)).toMatchObject({ format: 'xpanel.firewall', version: 1, prefixLists: { blocklist_feed: ['192.0.2.0/24'] } })
    expect(readFirewallImport(text)).toEqual({ rules: state.rules, prefixLists: lists })
    expect(() => readFirewallImport({ ...JSON.parse(text), version: 2 })).toThrow(/version/)
    expect(() => readFirewallImport({ ...JSON.parse(text), prefixLists: {} })).toThrow(/not in the bundle/)
    expect(diffRules(base, [...base, office])).toMatchObject({ added: ['office-mysql'], removed: [], changed: [] })
  })
})

describe('firewall workspace safe apply', () => {
  it('reads the rules with their revision and the trusted session address', async () => {
    const { body } = await call('GET', '/api/firewall')
    expect(body).toMatchObject({ revision: await revision(), session: { ip: SESSION }, pending: null, confirmWindowSeconds: FIREWALL_CONFIRM_WINDOW_MS / 1000 })
  })

  it('edits, moves and deletes a rule as revision-bound, audited changes that wait for confirmation', async () => {
    const edited = await call('PATCH', '/api/firewall/rules/office-mysql', { source: '203.0.113.0/29', expectedRevision: await revision() })
    expect(edited.response.status).toBe(200)
    expect(edited.body!.rule.source).toBe('203.0.113.0/29')
    expect(edited.body!.pending.id).toBe(edited.body!.confirmation.id)
    const confirmed = await call('POST', '/api/firewall/confirm', { id: edited.body!.confirmation.id })
    expect(confirmed.body).toMatchObject({ confirmed: true, pending: null })

    const moved = await call('POST', '/api/firewall/rules/office-mysql/move', { position: 0, expectedRevision: await revision() })
    expect(moved.body!.rules[0].id).toBe('office-mysql')
    await call('POST', '/api/firewall/confirm', { id: moved.body!.confirmation.id })

    const deleted = await call('DELETE', '/api/firewall/rules/office-mysql', { expectedRevision: await revision() })
    expect(deleted.body!.rules.some((rule: FirewallRule) => rule.id === 'office-mysql')).toBe(false)
    expect(audits.map(entry => entry.action)).toEqual(['firewall.rule.updated', 'firewall.change.confirmed', 'firewall.rule.moved', 'firewall.change.confirmed', 'firewall.rule.deleted'])
  })

  it('auto-reverts an unconfirmed change at its deadline and re-applies the previous generation', async () => {
    const before = await revision()
    const created = await call('POST', '/api/firewall/rules', { kind: 'port', action: 'accept', protocol: 'tcp', port: '9000', source: null, forwardTo: null, list: null, comment: 'app', enabled: true, position: 0 })
    expect(created.response.status).toBe(201)
    expect(created.body!.rules[0].port).toBe('9000')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.at.getTime() - clock.getTime()).toBe(FIREWALL_CONFIRM_WINDOW_MS)
    await timers[0]!.run()
    expect(await revision()).toBe(before)
    expect(audits.at(-1)).toEqual({ action: 'firewall.change.reverted', outcome: 'ok' })
    await expect(call('POST', '/api/firewall/confirm', { id: created.body!.confirmation.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reverts an expired change on the next read when the process timer was lost', async () => {
    const before = await revision()
    await call('POST', '/api/firewall/rules', { kind: 'port', action: 'accept', protocol: 'tcp', port: '9001', source: null, forwardTo: null, list: null, comment: '', enabled: true })
    clock = new Date(clock.getTime() + FIREWALL_CONFIRM_WINDOW_MS + 1)
    const { body } = await call('GET', '/api/firewall')
    expect(body).toMatchObject({ revision: before, pending: null })
  })

  it('refuses a change that would close the panel to the session address, before anything is written', async () => {
    const before = await revision()
    await expect(call('POST', '/api/firewall/rules', { kind: 'ip', action: 'drop', protocol: null, port: null, source: '203.0.113.0/24', forwardTo: null, list: null, comment: '', enabled: true, position: 0 })).rejects.toMatchObject({ code: 'SELF_LOCKOUT' })
    expect(await revision()).toBe(before)
    expect(timers).toHaveLength(0)
  })

  it('refuses stale revisions, system rule deletion and missing revisions', async () => {
    await expect(call('DELETE', '/api/firewall/rules/office-mysql', { expectedRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('DELETE', '/api/firewall/rules/default-ssh', { expectedRevision: await revision() })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('DELETE', '/api/firewall/rules/office-mysql', {})).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('POST', '/api/firewall/rules/office-mysql/move', { position: 99, expectedRevision: await revision() })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('restores the previous rules at once when the host refuses the new generation', async () => {
    const before = await revision()
    reconcileOk = false
    await expect(call('PATCH', '/api/firewall/rules/office-mysql', { port: '3307', expectedRevision: before })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { reverted: true } })
    expect(await revision()).toBe(before)
    expect(audits.map(entry => entry.outcome)).toContain('failed')
  })

  it('previews an import with its diff and applies it through the same lockout check', async () => {
    const exported = await call('GET', '/api/firewall/export')
    expect(exported.response.headers.get('content-disposition')).toContain('firewall-2026-10-29.json')
    expect(exported.body!.prefixLists).toEqual({ blocklist_feed: ['192.0.2.0/24'] })
    const document = { ...exported.body!, rules: exported.body!.rules.filter((rule: FirewallRule) => rule.id !== 'office-mysql') }
    const dry = await call('POST', '/api/firewall/import', { document, expectedRevision: await revision(), dryRun: true })
    expect(dry.body).toMatchObject({ dryRun: true, valid: true, diff: { removed: ['office-mysql'] } })
    expect((await h.store.getFirewallState()).rules.some(rule => rule.id === 'office-mysql')).toBe(true)
    const applied = await call('POST', '/api/firewall/import', { document, expectedRevision: await revision() })
    expect(applied.body!.diff.removed).toEqual(['office-mysql'])
    const blocking = { ...document, rules: [{ ...office, id: 'drop-all', kind: 'ip', action: 'drop', protocol: null, port: null, source: '0.0.0.0/0' }, ...document.rules] }
    await expect(call('POST', '/api/firewall/import', { document: blocking, expectedRevision: await revision() })).rejects.toMatchObject({ code: 'SELF_LOCKOUT' })
  })

  it('uploads a prefix list with its rule at the top, replaces its entries and deletes it with its rules', async () => {
    const uploaded = await call('PUT', '/api/firewall/prefix-lists/office_v4', { entries: '203.0.113.0/28\n# office\n203.0.113.16/28\n', action: 'accept', ports: '3306', expectedRevision: await revision() })
    expect(uploaded.body!.rules[0]).toMatchObject({ id: 'list-office_v4', kind: 'prefix-list', action: 'accept', port: '3306', protocol: 'both', list: 'office_v4' })
    expect(uploaded.body!.prefixLists.find((item: { name: string }) => item.name === 'office_v4').entries).toEqual(['203.0.113.0/28', '203.0.113.16/28'])
    await call('POST', '/api/firewall/confirm', { id: uploaded.body!.confirmation.id })
    const replaced = await call('PUT', '/api/firewall/prefix-lists/office_v4', { entries: ['198.51.100.0/24'], expectedRevision: await revision() })
    expect(replaced.body!.rules.filter((rule: FirewallRule) => rule.list === 'office_v4')).toHaveLength(1)
    expect(audits.map(entry => entry.action)).toContain('firewall.prefix_list.replaced')
    await expect(call('PUT', '/api/firewall/prefix-lists/office_v4', { entries: ['not-an-address'], expectedRevision: await revision() })).rejects.toMatchObject({ code: 'VALIDATION' })
    const deleted = await call('DELETE', '/api/firewall/prefix-lists/office_v4', { expectedRevision: await revision() })
    expect(deleted.body!.rules.some((rule: FirewallRule) => rule.list === 'office_v4')).toBe(false)
    // a list whose rule would drop the panel for the session address is refused before anything is written
    await expect(call('PUT', '/api/firewall/prefix-lists/everyone', { entries: '203.0.113.0/24', action: 'drop', expectedRevision: await revision() })).rejects.toMatchObject({ code: 'SELF_LOCKOUT' })
  })

  it('reads the live bans and audits an unban of several addresses', async () => {
    expect((await call('GET', '/api/firewall/bans')).body).toMatchObject({ state: 'read', bans: [{ address: '198.51.100.9' }] })
    const result = await call('POST', '/api/firewall/bans/unban', { addresses: ['198.51.100.9', '198.51.100.10'] })
    expect(result.body).toEqual({ unbanned: ['198.51.100.9', '198.51.100.10'], stillBanned: [] })
    expect(audits.at(-1)).toEqual({ action: 'firewall.unbanned', outcome: 'ok' })
    await expect(call('POST', '/api/firewall/bans/unban', { addresses: [], reason: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('asserts root before reading and refuses selectors', async () => {
    const use = helpers()
    use.assertRoot.mockRejectedValueOnce(new Error('denied'))
    await expect(call('GET', '/api/firewall', undefined, use)).rejects.toThrow('denied')
    await expect(call('GET', '/api/firewall?sessionIp=1.2.3.4')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await handleFirewallWorkspaceRoute(new Request('https://panel.test/api/other'), new URL('https://panel.test/api/other'), 'GET', helpers())).toBeNull()
  })
})
