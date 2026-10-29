// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFirewallView, WHM_FIREWALL_CLIENT_BINDING } from './whm-firewall-client.ts'

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const rule = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'port', action: 'accept', protocol: 'tcp', port: '443', source: null, forwardTo: null, list: null, comment: id, enabled: true, ...over })
const view = (over: Record<string, unknown> = {}) => ({ rules: [rule('default-https'), rule('default-backend-drop', { action: 'drop', port: '8080' }), rule('office', { port: '3306', source: '203.0.113.0/28' })], prefixLists: [{ name: 'office_v4', entries: ['203.0.113.0/28', '203.0.113.16/28'] }], revision: 'd'.repeat(64), session: { ip: '203.0.113.7' }, pending: null, confirmWindowSeconds: 120, ...over })
const markup = `<div data-approved-whm-operations="/whm/security/firewall" data-operation-state="qualified"><section data-whm-ops-section="firewall-rule-categories"><h2>Rules</h2>
  <section data-whm-firewall-panel="port"><table><thead><tr><th>Position</th><th>Action</th><th>Protocol</th><th>Port</th><th>Source</th><th>Note</th></tr></thead><tbody></tbody></table><div class="xp-whm-ops-actions"><button disabled>Edit</button></div><p class="xp-whm-ops-status">not connected</p></section>
  <section data-whm-firewall-panel="prefix-list"><table><thead><tr><th>Name</th><th>Action</th><th>Entries</th><th>Ports</th><th>File</th><th>Updated</th></tr></thead><tbody></tbody></table><input name="firewall-prefix-name" disabled><input type="file" name="firewall-prefix-file" disabled><input name="firewall-prefix-ports" disabled><select name="firewall-prefix-action" disabled><option value="">Choose</option><option value="drop">Drop</option></select><button data-firewall-action="upload-list" disabled>Upload prefix list</button><button data-firewall-action="replace-list" disabled>Replace file</button></section>
  <section data-whm-firewall-panel="banned"><table><thead><tr><th>Address</th><th>Reason</th><th>Source</th><th>Banned at</th><th>Expires</th></tr></thead><tbody></tbody></table><input name="firewall-unban-address" disabled><button data-firewall-action="unban" disabled>Unban</button></section></section>
  <section data-whm-ops-section="firewall-import-export"><input type="file" name="firewall-import-file" disabled><textarea name="firewall-import-json" disabled></textarea><button data-firewall-action="import" disabled>Import JSON</button><button data-firewall-action="export" disabled>Export JSON</button></section></div>`

const boot = (send: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async (_options?: unknown) => true)) => {
  (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  new Function('return ' + WHM_FIREWALL_CLIENT_BINDING)()(ask)
  return ask
}
const rows = () => [...document.querySelectorAll<HTMLTableRowElement>('[data-firewall-rule-id]')]
const buttons = (id: string) => [...document.querySelector(`[data-firewall-rule-id="${id}"]`)!.querySelectorAll('button')].map(node => node.textContent)

beforeEach(() => { document.body.innerHTML = markup })

describe('WHM firewall management', () => {
  it('paints live rules with move, edit and delete actions; system rules narrow only and backend rules stay locked', async () => {
    boot(vi.fn(async () => view())); await tick()
    expect(rows().map(row => row.dataset.firewallRuleId)).toEqual(['default-https', 'default-backend-drop', 'office'])
    expect(buttons('default-https')).toEqual(['Narrow source', 'Move up', 'Move down'])
    expect(buttons('office')).toEqual(['Edit', 'Move up', 'Move down', 'Delete'])
    expect(document.querySelector('[data-firewall-rule-id="default-backend-drop"]')!.textContent).toContain('Locked to loopback')
    expect(document.querySelector<HTMLElement>('[data-whm-firewall-panel="port"] > .xp-whm-ops-status')!.hidden).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-firewall-action="import"]')!.disabled).toBe(false)
  })

  it('moves a rule with the read revision, reads back over the same session and confirms the pending change', async () => {
    const pending = { id: '00000000-0000-4000-8000-0000000000aa', deadline: '2026-10-29T00:02:00.000Z' }
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => {
      if (path.endsWith('/move')) return { ...view({ pending }), confirmation: pending }
      if (path === '/api/firewall/confirm') return { ...view(), confirmed: true }
      return view()
    })
    boot(send); await tick()
    ;[...document.querySelector('[data-firewall-rule-id="office"]')!.querySelectorAll('button')].find(node => node.textContent === 'Move up')!.click(); await tick()
    expect(send.mock.calls.filter(call => call[1] !== '/api/firewall/bans').slice(1)).toEqual([
      ['POST', '/api/firewall/rules/office/move', { position: 1, expectedRevision: 'd'.repeat(64) }],
      ['GET', '/api/firewall'],
      ['POST', '/api/firewall/confirm', { id: pending.id }],
    ])
    expect(document.querySelector('[data-firewall-manage-status]')!.textContent).toContain('confirmed')
  })

  it('deletes only after the confirmation dialog and sends nothing when it is cancelled', async () => {
    const send = vi.fn(async (_method: string, _path: string) => view())
    const ask = boot(send, vi.fn(async () => false)); await tick()
    ;[...document.querySelector('[data-firewall-rule-id="office"]')!.querySelectorAll('button')].find(node => node.textContent === 'Delete')!.click(); await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(send.mock.calls.some(call => call[0] === 'DELETE')).toBe(false)
  })

  it('checks an import with a dry run before applying it', async () => {
    const send = vi.fn(async (_method: string, _path: string, body?: unknown) => (body as { dryRun?: boolean } | undefined)?.dryRun ? { valid: true, errors: [], diff: { added: ['x'], removed: [], changed: [] } } : view())
    const ask = boot(send); await tick()
    document.querySelector<HTMLTextAreaElement>('[name="firewall-import-json"]')!.value = JSON.stringify({ format: 'xpanel-firewall', version: 1, rules: [], prefixLists: [] })
    document.querySelector<HTMLButtonElement>('[data-firewall-action="import"]')!.click(); await tick()
    const posts = send.mock.calls.filter(call => call[1] === '/api/firewall/import')
    expect(posts.map(call => (call[2] as { dryRun?: boolean }).dryRun)).toEqual([true, undefined])
    expect(ask).toHaveBeenCalledOnce()
  })

  it('paints prefix lists and live bans, and unbans several typed addresses after confirmation', async () => {
    const bans = { state: 'read', bans: [{ address: '198.51.100.9', timeoutSec: 3600, expiresSec: 1200 }] }
    const send = vi.fn(async (_method: string, path: string, _body?: unknown) => path === '/api/firewall/bans' ? bans : path === '/api/firewall/bans/unban' ? { unbanned: ['198.51.100.9', '198.51.100.10'], stillBanned: [] } : view())
    const ask = boot(send); await tick()
    expect(document.querySelector('[data-whm-firewall-panel="prefix-list"] tbody')!.textContent).toContain('office_v4')
    expect(document.querySelector('[data-whm-firewall-panel="banned"] tbody')!.textContent).toContain('198.51.100.9')
    document.querySelector<HTMLInputElement>('[name="firewall-unban-address"]')!.value = '198.51.100.9, 198.51.100.10'
    document.querySelector<HTMLButtonElement>('[data-firewall-action="unban"]')!.click(); await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(send.mock.calls.find(call => call[1] === '/api/firewall/bans/unban')![2]).toEqual({ addresses: ['198.51.100.9', '198.51.100.10'] })
    expect(document.querySelector('[data-firewall-manage-status]')!.textContent).toContain('Unbanned')
  })

  it('uploads a prefix list file with its action through the revision-bound safe apply', async () => {
    const pending = { id: '00000000-0000-4000-8000-0000000000cc', deadline: '2026-10-29T00:02:00.000Z' }
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => path === '/api/firewall/bans' ? { state: 'unavailable', bans: [] } : method === 'PUT' ? { ...view({ pending }), confirmation: pending } : view())
    boot(send); await tick()
    document.querySelector<HTMLInputElement>('[name="firewall-prefix-name"]')!.value = 'blocklist_feed'
    const file = document.querySelector<HTMLInputElement>('[name="firewall-prefix-file"]')!
    Object.defineProperty(file, 'files', { value: [new File(['192.0.2.0/24\n'], 'feed.txt', { type: 'text/plain' })] })
    document.querySelector<HTMLSelectElement>('[name="firewall-prefix-action"]')!.value = 'drop'
    document.querySelector<HTMLButtonElement>('[data-firewall-action="upload-list"]')!.click(); await tick(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'PUT')).toEqual(['PUT', '/api/firewall/prefix-lists/blocklist_feed', { entries: '192.0.2.0/24\n', action: 'drop', ports: '', expectedRevision: 'd'.repeat(64) }])
    expect(send.mock.calls.some(call => call[1] === '/api/firewall/confirm')).toBe(true)
  })

  it('refuses malformed reads', () => {
    expect(readFirewallView(view()).sessionIp).toBe('203.0.113.7')
    expect(() => readFirewallView({ ...view(), revision: 'nope' })).toThrow()
    expect(() => readFirewallView(view({ rules: [rule('x', { kind: 'shell' })] }))).toThrow()
    expect(WHM_FIREWALL_CLIENT_BINDING).not.toContain('innerHTML')
  })
})
