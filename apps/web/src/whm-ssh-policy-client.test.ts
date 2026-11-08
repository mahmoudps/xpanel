// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WHM_SSH_POLICY_CLIENT_BINDING } from './whm-ssh-policy-client.ts'

type Call = { method: string; path: string; body: unknown }
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const bind = (reply: (call: Call) => unknown, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true): Call[] => {
  const calls: Call[] = []
  ;(window as unknown as { xpanelSessionRequest: unknown }).xpanelSessionRequest = async (method: string, path: string, body?: unknown) => { const call = { method, path, body }; calls.push(call); return reply(call) }
  ;(globalThis as unknown as { xpT: unknown }).xpT = (message: string) => message
  ;(0, eval)(WHM_SSH_POLICY_CLIENT_BINDING)(ask)
  return calls
}
const sshView = (patch: Record<string, unknown> = {}) => ({ settings: { port: 22, passwordAuth: false, pubkeyAuth: true, rootLogin: 'prohibit-password', loginAlarm: false, previousPort: null, revision: 'r1', ...patch }, alarmChannels: ['email'],
  host: { service: { active: 'active', enabled: 'enabled' }, today: { accepted: 1, failed: 2, complete: true }, total: { accepted: 3, failed: 4, complete: false } } })
const sshPage = (manage = true) => `<section data-whm-detail-route="/whm/security/ssh"><div data-whm-ssh-policy data-whm-ssh-can-manage="${manage}"><input data-whm-ssh-port type="number" disabled><select data-whm-ssh-auth disabled><option value="keys"></option><option value="both"></option><option value="password"></option></select><select data-whm-ssh-root disabled><option value="prohibit-password"></option><option value="no"></option><option value="yes"></option></select><button data-whm-ssh-apply disabled></button><p data-whm-ssh-policy-status></p></div><bdi data-whm-ssh-fact="today-accepted"></bdi><bdi data-whm-ssh-fact="total-failed"></bdi><button data-whm-ssh-start disabled></button><button data-whm-ssh-stop disabled></button><p data-whm-ssh-service-status></p><input type="checkbox" data-whm-ssh-alarm disabled><p data-whm-ssh-alarm-status></p></section>`
const q = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!

beforeEach(() => { document.body.innerHTML = '' })

describe('SSH policy client', { tags: ['unit'] }, () => {
  it('paints the host read and marks a capped count', async () => {
    document.body.innerHTML = sshPage()
    bind(() => sshView())
    await flush()
    expect(q<HTMLInputElement>('[data-whm-ssh-port]').value).toBe('22')
    expect(q('[data-whm-ssh-fact="today-accepted"]').textContent).toBe('1')
    expect(q('[data-whm-ssh-fact="total-failed"]').textContent).toBe('4 +')
    expect(q<HTMLButtonElement>('[data-whm-ssh-start]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-whm-ssh-stop]').disabled).toBe(false)
  })

  it('sends the reviewed revision and both sign-in switches', async () => {
    document.body.innerHTML = sshPage()
    const calls = bind(call => call.method === 'PUT' ? { application: { changed: true } } : sshView())
    await flush()
    q<HTMLInputElement>('[data-whm-ssh-port]').value = '22022'
    q('[data-whm-ssh-apply]').click()
    await flush()
    expect(calls.find(call => call.method === 'PUT')).toMatchObject({ path: '/api/server/ssh', body: { port: 22022, passwordAuth: false, pubkeyAuth: true, rootLogin: 'prohibit-password', expectedRevision: 'r1' } })
  })

  it('asks before allowing a password and before a stop, and sends nothing on no', async () => {
    document.body.innerHTML = sshPage()
    const calls = bind(() => sshView(), async () => false)
    await flush()
    q<HTMLSelectElement>('[data-whm-ssh-auth]').value = 'both'
    q('[data-whm-ssh-apply]').click(); q('[data-whm-ssh-stop]').click()
    await flush()
    expect(calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  it('shows why a policy was refused', async () => {
    document.body.innerHTML = sshPage()
    bind(call => { if (call.method === 'PUT') throw { message: 'x', details: { reason: 'root_has_no_key' } }; return sshView() })
    await flush()
    q('[data-whm-ssh-apply]').click()
    await flush()
    expect(q('[data-whm-ssh-policy-status]').textContent).toContain('Root has no authorized key')
    expect(q('[data-whm-ssh-policy-status]').dataset.state).toBe('failed')
  })

  it('stays read-only without the manage grant', async () => {
    document.body.innerHTML = sshPage(false)
    bind(() => sshView())
    await flush()
    expect(q<HTMLButtonElement>('[data-whm-ssh-apply]').disabled).toBe(true)
    expect(q<HTMLInputElement>('[data-whm-ssh-alarm]').disabled).toBe(true)
  })
})

describe('firewall policy client', { tags: ['unit'] }, () => {
  const page = '<div data-whm-firewall-policy data-whm-firewall-can-manage="true"><input type="checkbox" data-whm-firewall-enabled disabled><p data-whm-firewall-policy-status></p></div><input type="checkbox" data-whm-firewall-ping disabled>'
  const view = { revision: 'a'.repeat(64), enabled: true, blockPing: false }

  it('confirms a change only after a second request proves the session', async () => {
    document.body.innerHTML = page
    const calls = bind(call => call.method === 'PUT' ? { ...view, blockPing: true, confirmation: { id: 'c1' } } : call.path.endsWith('/confirm') ? { ...view, blockPing: true } : view)
    await flush()
    const ping = q<HTMLInputElement>('[data-whm-firewall-ping]')
    expect(ping.checked).toBe(true)
    ping.click()
    await flush()
    expect(calls.map(call => call.method + ' ' + call.path)).toEqual(['GET /api/firewall', 'PUT /api/firewall/policy', 'GET /api/firewall', 'POST /api/firewall/confirm'])
    expect(calls[1]!.body).toEqual({ enabled: true, blockPing: true, expectedRevision: view.revision })
    expect(ping.checked).toBe(false)
  })

  it('warns before turning off and restores the switch on no', async () => {
    document.body.innerHTML = page
    const ask = vi.fn(async () => false), calls = bind(() => view, ask)
    await flush()
    q('[data-whm-firewall-enabled]').click()
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(q<HTMLInputElement>('[data-whm-firewall-enabled]').checked).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

describe('isolation policy client', { tags: ['unit'] }, () => {
  const page = '<section data-whm-security-tools-workspace><select data-whm-security-tools-account><option value=""></option><option value="alice" selected></option></select><div data-whm-isolation-policy data-whm-isolation-can-manage="true"><input type="checkbox" data-whm-isolation-switch="privateTmp" disabled><input type="checkbox" data-whm-isolation-switch="hiddenHomes" disabled><input type="checkbox" data-whm-isolation-switch="systemView" disabled><textarea data-whm-isolation-exceptions disabled></textarea><button data-whm-isolation-save disabled></button><button data-whm-isolation-verify disabled></button><p data-whm-isolation-status></p><table><tbody data-whm-isolation-proof></tbody></table></div></section>'
  const view = { policy: { privateTmp: true, hiddenHomes: false, systemView: false, exceptions: [{ username: 'alice', reason: 'legacy deploy' }] }, revision: 'r1' }

  it('round-trips the policy and its exceptions', async () => {
    document.body.innerHTML = page
    const calls = bind(() => view)
    await flush()
    expect(q<HTMLTextAreaElement>('[data-whm-isolation-exceptions]').value).toBe('alice: legacy deploy')
    q('[data-whm-isolation-save]').click()
    await flush()
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { privateTmp: true, hiddenHomes: false, systemView: false, exceptions: [{ username: 'alice', reason: 'legacy deploy' }], expectedRevision: 'r1' } })
  })

  it('paints the proof for the selected account', async () => {
    document.body.innerHTML = page
    const calls = bind(call => call.method === 'POST' ? { username: 'alice', checks: [{ id: 'jail-home-list', state: 'ok', expected: 'no other account', observed: 'denied' }] } : view)
    await flush()
    q('[data-whm-isolation-verify]').click()
    await flush()
    expect(calls.at(-1)).toMatchObject({ path: '/api/server/security-tools/isolation/verify', body: { account: 'alice' } })
    expect(q('[data-whm-isolation-proof]').textContent).toContain('Proved')
  })
})
