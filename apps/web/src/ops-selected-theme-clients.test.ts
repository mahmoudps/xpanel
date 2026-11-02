// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { translator } from './i18n.ts'
import { classicOpsClientTemplates } from './themes/classic/ops-client-templates.ts'
import { v2OpsClientTemplates } from './themes/v2/ops-client-templates.ts'
import { renderOpsFileSharingWorkspace } from './board-port/ops-file-sharing-workspace.ts'
import { renderOpsNodesWorkspace } from './board-port/ops-nodes-workspace.ts'
import { renderOpsIntegrationsWorkspace } from './board-port/ops-integrations-workspace.ts'
import { OPS_FILE_SHARING_CLIENT_BINDING } from './ops-file-sharing-client.ts'
import { OPS_NODES_CLIENT_BINDING } from './ops-nodes-client.ts'
import { OPS_INTEGRATIONS_CLIENT_BINDING } from './ops-integrations-client.ts'

let dom: EnvironmentReturn | undefined
beforeEach(async () => { dom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://whm.example.test', runScripts: 'outside-only' } }) })
afterEach(async () => { document.body.replaceChildren(); delete (window as Window & { xpT?: unknown }).xpT; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; await dom?.teardown(globalThis); dom = undefined })
const tick = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setTimeout(resolve, 0)) }
const revision = 'a'.repeat(64)
const fixtures = {
  shares: { renderer: renderOpsFileSharingWorkspace, binding: OPS_FILE_SHARING_CLIENT_BINDING, prefix: 'shares', first: 'ops-share-row',
    response: { config: { shares: [{ id: 'shr_' + 'a'.repeat(16), path: '/srv/shares/team', clients: [{ host: '10.0.0.0/24', permission: 'rw', squashRoot: true, subtreeCheck: true }] }] }, savedRevision: revision, activeRevision: revision, invalid: false, observed: { state: 'read', managedPresent: true, shares: [], foreignExports: ['/data'], reason: null } }, expected: '/srv/shares/team' },
  nodes: { renderer: renderOpsNodesWorkspace, binding: OPS_NODES_CLIENT_BINDING, prefix: 'nodes', first: 'ops-node-row',
    response: { config: { nodes: [{ id: 'node_' + 'a'.repeat(16), label: 'Peer', hostname: 'peer.example.test', port: 2087, fingerprint: 'b'.repeat(64), role: 'all' }] }, savedRevision: revision, activeRevision: revision, invalid: false, thisServer: { hostname: 'panel.example.test' }, singleNode: false, channel: { verification: 'available' } }, expected: 'peer.example.test:2087' },
  integrations: { renderer: renderOpsIntegrationsWorkspace, binding: OPS_INTEGRATIONS_CLIENT_BINDING, prefix: 'int', first: 'ops-endpoint-row',
    response: { endpoints: [{ id: 'whk_' + 'a'.repeat(16), url: 'https://hooks.example.test/events', events: ['account.created'], active: true, secretPresent: true }], events: ['account.created'], signatureScheme: 'hmac-sha256-t-v1', secretsLocation: 'server', savedRevision: revision, activeRevision: revision, invalid: false, egress: { state: 'available', reason: null }, deliveries: [{ id: 'internal-delivery-identity', endpointId: 'whk_' + 'a'.repeat(16), event: 'account.created', createdAt: '2026-10-29T12:00:00Z', state: 'delivered', attempts: 1, lastStatus: 200 }] }, expected: 'https://hooks.example.test/events' },
} as const

describe.each(['classic', 'v2'] as const)('ops selected-theme %s serialized controllers', theme => {
  for (const family of ['shares', 'nodes', 'integrations'] as const) {
    const fixture = fixtures[family]
    function mount(canRead = true, canManage = true) {
      document.body.innerHTML = fixture.renderer({ locale: 'en', canRead, canManage })
      if (theme === 'v2') {
        document.querySelectorAll('template[data-xp-template]').forEach(template => template.remove())
        document.body.insertAdjacentHTML('beforeend', '<div data-selected-template-source>' + v2OpsClientTemplates(family) + '</div>')
        const workspace = document.querySelector<HTMLElement>('[data-ops-' + (family === 'integrations' ? 'integrations' : family) + '-workspace]')!
        const source = document.querySelector('[data-selected-template-source]')!
        workspace.append(...source.childNodes); source.remove()
      }
      const send = vi.fn(async () => fixture.response)
      Object.assign(window, { xpT: translator('en'), xpanelSessionRequest: send })
      return { send, boot: () => window.eval(fixture.binding)(async () => true), read: () => document.querySelector<HTMLButtonElement>('[data-ops-' + fixture.prefix + '-action="read"]')! }
    }
    it(family + ' populates the real selected template with authorized facts and denies management independently', async () => {
      const { boot, send, read } = mount(true, false)
      boot(); read().click(); await tick()
      expect(send).toHaveBeenCalledTimes(1)
      const rows = document.querySelector('[data-ops-' + fixture.prefix + '-rows]')!
      expect(rows.textContent).toContain(fixture.expected)
      expect(rows.querySelectorAll('[data-xp-action="remove"]')).toHaveLength(1)
      expect(rows.querySelector<HTMLButtonElement>('[data-xp-action="remove"]')!.hidden).toBe(true)
      if (family === 'integrations') {
        const log = document.querySelector('[data-ops-int-log]')!
        expect(log.textContent).toContain('Not issued')
        expect(log.textContent).not.toContain('internal-delivery-identity')
      }
      if (theme === 'v2') expect(rows.querySelector('[class*="xp-"]')).toBeNull()
    })
    it(family + ' rejects missing and duplicate selected templates before any request', async () => {
      for (const duplicate of [false, true]) {
        const { boot, send } = mount()
        const template = document.querySelector<HTMLTemplateElement>('[data-xp-template="' + fixture.first + '"]')!
        if (duplicate) template.after(template.cloneNode(true)); else template.remove()
        boot(); await tick()
        expect(send).not.toHaveBeenCalled()
        expect(document.querySelector<HTMLElement>('[data-ops-' + fixture.prefix + '-status]')!.dataset.state).toBe('unavailable')
        expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')].every(control => control.disabled)).toBe(true)
      }
    })
    it(family + ' keeps denied read admission from dispatching', async () => {
      const { boot, send, read } = mount(false)
      boot(); read().click(); await tick()
      expect(send).not.toHaveBeenCalled()
    })
  }
})

it('both template sets retain inert initial operations controls', () => {
  for (const templates of [classicOpsClientTemplates, v2OpsClientTemplates]) for (const family of ['shares', 'nodes', 'integrations'] as const) {
    document.body.innerHTML = templates(family)
    document.querySelectorAll<HTMLTemplateElement>('template').forEach(template => {
      template.content.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(control => expect(control.disabled).toBe(true))
    })
  }
})