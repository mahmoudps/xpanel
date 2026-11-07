import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultFirewallRules } from '@xpanel/core'
import type { FirewallRule } from '@xpanel/core'
import { createTestStateStore, firewallRevision, type TestStateStoreHandle } from './store.ts'
import { validateFirewallState } from './validate-state.ts'

let h: TestStateStoreHandle
beforeAll(async () => { h = await createTestStateStore() })
afterAll(async () => { await h.close() })

const admin = { lockout: { sessionIp: '198.51.100.20', panelPort: 2087, sshPort: 22 } }
const base = defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 })
const extra: FirewallRule = { id: 'office-mysql', kind: 'port', action: 'accept', protocol: 'tcp', port: '3306', source: '203.0.113.0/28', forwardTo: null, list: null, comment: 'office', enabled: true }
const confirmation = (id: string) => ({ id, deadline: '2026-10-29T00:02:00.000Z', actor: 'root', sessionIp: '198.51.100.20' })

describe('firewall switch state', () => {
  it('stays off until the first rule, and a saved list reads as on', () => {
    expect(validateFirewallState({ rules: [], prefixLists: [] })).toEqual({ rules: [], prefixLists: [], enabled: false, blockPing: false })
    expect(validateFirewallState({ rules: base, prefixLists: [] })).toMatchObject({ enabled: true, blockPing: false })
    expect(() => validateFirewallState({ rules: [], prefixLists: [], enabled: 'yes' })).toThrow(/booleans/)
  })

  it('binds the revision to the switch, keeps it across rule writes and reverts it with the rules', async () => {
    const before = await h.store.replaceFirewall({ rules: base, prefixLists: [], enabled: true, blockPing: false }, { lockout: null })
    const off = await h.store.replaceFirewall({ rules: base, prefixLists: [], enabled: false, blockPing: true }, admin, { confirmation: { id: '00000000-0000-4000-8000-000000000001', deadline: '2030-01-01T00:00:00.000Z', actor: 'root', sessionIp: '198.51.100.20' } })
    expect(firewallRevision(off)).not.toBe(firewallRevision(before))
    expect(await h.store.revertFirewallChange('00000000-0000-4000-8000-000000000001')).toBe('reverted')
    expect(await h.store.getFirewallState()).toMatchObject({ enabled: true, blockPing: false })
    await h.store.replaceFirewall({ rules: base, prefixLists: [] }, { lockout: null })
    expect((await h.store.getFirewallState()).enabled).toBe(true)
  })

  it('checks the session only while the firewall filters', async () => {
    const closed = base.filter(rule => rule.id !== 'default-panel')
    await expect(h.store.replaceFirewall({ rules: closed, prefixLists: [], enabled: true }, admin)).rejects.toMatchObject({ code: 'SELF_LOCKOUT' })
    await expect(h.store.replaceFirewall({ rules: closed, prefixLists: [], enabled: false }, admin)).resolves.toMatchObject({ enabled: false })
    await h.store.replaceFirewall({ rules: base, prefixLists: [], enabled: true }, { lockout: null })
  })
})

describe('firewall changes pending confirmation', () => {
  it('binds writes to the reviewed rule revision', async () => {
    const saved = await h.store.replaceFirewall({ rules: base, prefixLists: [] }, admin)
    const stale = firewallRevision({ rules: [], prefixLists: [], enabled: false, blockPing: false })
    await expect(h.store.replaceFirewall({ rules: [...base, extra], prefixLists: [] }, admin, { expectedFirewallRevision: stale })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(firewallRevision(await h.store.getFirewallState())).toBe(firewallRevision(saved))
  })

  it('restores the last confirmed rules when an applied change is not confirmed', async () => {
    const before = await h.store.getFirewallState()
    await h.store.replaceFirewall({ rules: [...base, extra], prefixLists: [] }, admin, { expectedFirewallRevision: firewallRevision(before), confirmation: confirmation('00000000-0000-4000-8000-000000000001') })
    // a second unconfirmed change keeps the first baseline, so a revert never lands on unconfirmed rules
    await h.store.replaceFirewall({ rules: [extra, ...base], prefixLists: [] }, admin, { confirmation: confirmation('00000000-0000-4000-8000-000000000002') })
    const pending = await h.store.getFirewallPending()
    expect(pending?.id).toBe('00000000-0000-4000-8000-000000000002')
    expect(firewallRevision(pending!.previous)).toBe(firewallRevision(before))
    expect(await h.store.revertFirewallChange('00000000-0000-4000-8000-000000000001')).toBe('missing')
    expect(await h.store.revertFirewallChange('00000000-0000-4000-8000-000000000002')).toBe('reverted')
    expect(firewallRevision(await h.store.getFirewallState())).toBe(firewallRevision(before))
    expect(await h.store.getFirewallPending()).toBeNull()
  })

  it('keeps confirmed rules and lets a later unrelated write supersede a revert', async () => {
    await h.store.replaceFirewall({ rules: [...base, extra], prefixLists: [] }, admin, { confirmation: confirmation('00000000-0000-4000-8000-000000000003') })
    expect(await h.store.confirmFirewallChange('00000000-0000-4000-8000-000000000003')).toBe(true)
    expect(await h.store.confirmFirewallChange('00000000-0000-4000-8000-000000000003')).toBe(false)
    expect((await h.store.getFirewallState()).rules.some(rule => rule.id === 'office-mysql')).toBe(true)

    await h.store.replaceFirewall({ rules: base, prefixLists: [] }, admin, { confirmation: confirmation('00000000-0000-4000-8000-000000000004') })
    await h.store.replaceFirewall({ rules: [...base, { ...extra, id: 'later' }], prefixLists: [] }, admin)
    expect(await h.store.revertFirewallChange('00000000-0000-4000-8000-000000000004')).toBe('superseded')
    expect((await h.store.getFirewallState()).rules.some(rule => rule.id === 'later')).toBe(true)
  })
})
