import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultFirewallRules, suggestServerSettings } from '@xpanel/core'
import type { ServerSettings } from '@xpanel/core'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { handleSshWorkspaceRoute, projectSshCounters, shellJailRevision, sshRevision, SSH_TRANSITION_RULE, type SshWorkspaceHelpers } from './ssh-workspace.ts'

const caller = { principal: { kind: 'root', id: 'root-id', username: 'root' } } as AuthenticatedCaller
const settings: ServerSettings = { ...suggestServerSettings({ cores: 2, memoryMb: 2048 }), panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443, hostname: 'srv.example.test', nameservers: ['ns1.example.test', 'ns2.example.test'], adminEmail: 'root@example.test', engine: 'apache', apacheMpm: 'itk' }
const rules = defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 })
const prepared = { access: { rootKeys: 1, rootPassword: false, otherAdministrators: 0 }, portInUse: false, portLabel: 'not_needed' }
const counters = { observedAt: '2026-11-07T10:00:00.000Z', service: { active: 'active', substate: 'running', enabled: 'enabled' }, today: { accepted: 1, failed: 2, complete: true }, total: { accepted: 3, failed: 4, complete: false } }

let h: TestStateStoreHandle
let reconcile: ReturnType<typeof vi.fn>
let host: ReturnType<typeof vi.fn>
let audits: { action: string; outcome: string }[]
let saved: Record<string, unknown>
const helpers = (): SshWorkspaceHelpers => ({ requireCaller: async () => caller, assertRoot: vi.fn(async () => {}), emitAudit: async entry => { audits.push({ action: entry.action, outcome: entry.outcome }) }, store: h.store, callHost: host as never, reconcile: reconcile as never,
  clientIp: () => '203.0.113.7', readChannels: async () => ({ alerts: true, recipients: ['root@example.test'], webhook: null }), writeAlarmState: async (file, value) => { saved[file] = value } })
const call = async (method: string, path: string, body?: unknown, use = helpers()) => {
  const url = new URL('https://panel.test' + path)
  const response = await handleSshWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, use)
  return { status: response!.status, body: await response!.json() as Record<string, any> }
}
const refusal = async (run: () => Promise<unknown>): Promise<{ code: string; detail: Record<string, unknown> }> => { try { await run() } catch (error) { return error as { code: string; detail: Record<string, unknown> } } throw new Error('expected a refusal') }
const change = async (patch: Record<string, unknown>) => ({ port: 22, passwordAuth: false, pubkeyAuth: true, rootLogin: 'prohibit-password', expectedRevision: sshRevision((await h.store.getServerSettings())!), ...patch })

beforeEach(async () => {
  h = await createTestStateStore(); audits = []; saved = {}
  await h.store.saveServerSettings(settings)
  await h.store.replaceFirewall({ rules, prefixLists: [], enabled: true }, { lockout: null })
  reconcile = vi.fn(async () => ({ ok: true, status: 200, body: { status: 'applied' } }))
  host = vi.fn(async (_caller: unknown, path: string) => path.endsWith('/prepare') ? prepared : path.endsWith('/probe') ? { answer: 'banner' } : path.endsWith('/counters') ? counters : path.endsWith('/logins') ? { cursor: 'c1', items: [], complete: true } : path.endsWith('/service') ? { action: 'stop', active: 'inactive', answer: 'refused', verified: true } : {})
})
afterEach(async () => { await h.close() })

describe('SSH settings', () => {
  it('reads the saved policy, the daemon and the login counts', async () => {
    const { body } = await call('GET', '/api/server/ssh')
    expect(body.settings).toMatchObject({ port: 22, passwordAuth: false, pubkeyAuth: true, rootLogin: 'prohibit-password', loginAlarm: false, previousPort: null })
    expect(body).toMatchObject({ alarmChannels: ['email'], host: counters })
  })

  it('applies a policy through one generation and audits it', async () => {
    const { status, body } = await call('PUT', '/api/server/ssh', await change({ passwordAuth: true, rootLogin: 'yes' }))
    expect(status).toBe(200)
    expect(body.settings).toMatchObject({ passwordAuth: true, rootLogin: 'yes' })
    expect((await h.store.getServerSettings())!.ssh).toMatchObject({ passwordAuth: true, rootLogin: 'yes' })
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(audits).toContainEqual({ action: 'server.ssh.settings.updated', outcome: 'ok' })
  })

  it('returns NO_AUTH_METHOD with both sign-in methods off', async () => {
    expect((await refusal(async () => call('PUT', '/api/server/ssh', await change({ pubkeyAuth: false })))).code).toBe('NO_AUTH_METHOD')
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('refuses a policy that leaves no way in, before anything is saved', async () => {
    host.mockImplementation(async () => ({ ...prepared, access: { rootKeys: 0, rootPassword: false, otherAdministrators: 0 } }))
    const refused = await refusal(async () => call('PUT', '/api/server/ssh', await change({ rootLogin: 'yes' })))
    expect(refused).toMatchObject({ code: 'SELF_LOCKOUT', detail: { reason: 'root_has_no_key', stateChanged: false } })
    expect((await h.store.getServerSettings())!.ssh).toBeUndefined()
  })

  it('restores the saved policy when sshd refuses it', async () => {
    reconcile.mockResolvedValueOnce({ ok: true, status: 200, body: { status: 'failed' } })
    expect((await refusal(async () => call('PUT', '/api/server/ssh', await change({ rootLogin: 'yes', passwordAuth: true })))).code).toBe('CONFIG_TEST_FAILED')
    expect((await h.store.getServerSettings())!.ssh).toMatchObject({ rootLogin: 'prohibit-password', passwordAuth: false })
  })

  it('refuses a stale revision and a reserved port', async () => {
    expect((await refusal(async () => call('PUT', '/api/server/ssh', { ...await change({}), expectedRevision: 'a'.repeat(64) }))).code).toBe('CONFLICT')
    expect((await refusal(async () => call('PUT', '/api/server/ssh', await change({ port: 2087 })))).code).toBe('VALIDATION')
    expect((await refusal(async () => call('PUT', '/api/server/ssh', await change({ port: 2078 })))).code).toBe('VALIDATION')
  })
})

describe('SSH port change', () => {
  it('opens the new port, proves it, then closes the old one', async () => {
    const seen: { rules: string[]; port: number; previous: number | undefined }[] = []
    reconcile.mockImplementation(async () => { const state = await h.store.getFirewallState(), stored = (await h.store.getServerSettings())!; seen.push({ rules: state.rules.filter(rule => rule.id === SSH_TRANSITION_RULE || rule.id === 'default-ssh').map(rule => rule.port!), port: stored.sshPort, previous: stored.ssh?.previousPort }); return { ok: true, status: 200, body: { status: 'applied' } } })
    const { body } = await call('PUT', '/api/server/ssh', await change({ port: 22022 }))
    expect(seen).toEqual([{ rules: ['22022', '22'], port: 22022, previous: 22 }, { rules: ['22022'], port: 22022, previous: undefined }])
    expect(body).toMatchObject({ settings: { port: 22022, previousPort: null }, application: { changed: true, portAnswered: true } })
    expect(host.mock.calls.map(item => item[1])).toEqual(['/host/security/ssh/prepare', '/host/security/ssh/probe'])
  })

  it('keeps the old port when the new one does not answer', async () => {
    host.mockImplementation(async (_caller: unknown, path: string) => path.endsWith('/prepare') ? prepared : { answer: 'refused' })
    const refused = await refusal(async () => call('PUT', '/api/server/ssh', await change({ port: 22022 })))
    expect(refused).toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { reason: 'port_not_answering', stateChanged: false } })
    expect((await h.store.getServerSettings())!.sshPort).toBe(22)
    expect((await h.store.getFirewallState()).rules.find(rule => rule.id === 'default-ssh')?.port).toBe('22')
    expect((await h.store.getFirewallState()).rules.some(rule => rule.id === SSH_TRANSITION_RULE)).toBe(false)
  })

  it('leaves both ports open and says so when the old port cannot close', async () => {
    reconcile.mockResolvedValueOnce({ ok: true, status: 200, body: { status: 'applied' } }).mockResolvedValueOnce({ ok: false, status: 500, body: { status: 'failed' } })
    const refused = await refusal(async () => call('PUT', '/api/server/ssh', await change({ port: 22022 })))
    expect(refused).toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { reason: 'old_port_open', stateChanged: true } })
    expect((await h.store.getServerSettings())!.ssh?.previousPort).toBe(22)
  })

  it('refuses a port another service holds, and waits for a pending firewall change', async () => {
    host.mockImplementation(async () => ({ ...prepared, portInUse: true }))
    expect((await refusal(async () => call('PUT', '/api/server/ssh', await change({ port: 22022 })))).detail.reason).toBe('port_in_use')
    await h.store.replaceFirewall({ rules, prefixLists: [] }, { lockout: null }, { confirmation: { id: '00000000-0000-4000-8000-000000000000', deadline: '2030-01-01T00:00:00.000Z', actor: 'root', sessionIp: '203.0.113.7' } })
    expect((await refusal(async () => call('PUT', '/api/server/ssh', await change({ port: 22023 })))).code).toBe('CONFLICT')
  })
})

describe('SSH daemon and alarm', () => {
  it('passes a verified stop through and refuses other verbs', async () => {
    expect((await call('POST', '/api/server/ssh/service', { action: 'stop' })).body).toEqual({ action: 'stop', active: 'inactive', answer: 'refused', verified: true })
    expect((await refusal(() => call('POST', '/api/server/ssh/service', { action: 'mask' }))).code).toBe('VALIDATION')
  })

  it('starts the alarm at the present journal entry', async () => {
    await call('PUT', '/api/server/ssh/login-alarm', { enabled: true })
    expect(saved['security/ssh-login-alarm.json']).toEqual({ cursor: 'c1' })
    expect((await h.store.getServerSettings())!.ssh?.loginAlarm).toBe(true)
  })

  it('refuses an alarm no channel can carry', async () => {
    const use = { ...helpers(), readChannels: async () => null }
    expect((await refusal(() => call('PUT', '/api/server/ssh/login-alarm', { enabled: true }, use))).detail.reason).toBe('no_notification_channel')
  })
})

describe('shell jail policy', () => {
  const policy = async (patch: Record<string, unknown>) => ({ privateTmp: true, hiddenHomes: true, systemView: false, exceptions: [], expectedRevision: shellJailRevision((await h.store.getServerSettings())!), ...patch })
  it('saves through a generation and keeps the sign-in policy', async () => {
    const { body } = await call('PUT', '/api/server/security-tools/isolation/policy', await policy({ exceptions: [{ username: 'alice', reason: 'legacy deploy' }] }))
    expect(body.policy).toMatchObject({ privateTmp: true, hiddenHomes: true, exceptions: [{ username: 'alice', reason: 'legacy deploy' }] })
    expect((await h.store.getServerSettings())!.ssh).toMatchObject({ passwordAuth: false, jail: { privateTmp: true } })
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('restores the policy when the host refuses it', async () => {
    reconcile.mockResolvedValueOnce({ ok: false, status: 500, body: { status: 'failed' } })
    expect((await refusal(async () => call('PUT', '/api/server/security-tools/isolation/policy', await policy({})))).code).toBe('CONFIG_TEST_FAILED')
    expect((await h.store.getServerSettings())!.ssh?.jail).toMatchObject({ privateTmp: false, hiddenHomes: false })
  })

  it('sends only an account name to the proof', async () => {
    await call('POST', '/api/server/security-tools/isolation/verify', { account: 'alice' })
    expect(host.mock.calls.at(-1)!.slice(1)).toEqual(['/host/security-tools/isolation/verify', { account: 'alice' }])
    expect((await refusal(() => call('POST', '/api/server/security-tools/isolation/verify', { account: '../root' }))).code).toBe('VALIDATION')
  })
})

describe('SSH host projection', { tags: ['unit'] }, () => {
  it('refuses a malformed host read', () => {
    expect(() => projectSshCounters({ ...counters, today: { accepted: -1, failed: 0, complete: true } })).toThrow()
    expect(() => projectSshCounters({ ...counters, service: { active: 'x y', substate: null, enabled: null } })).toThrow()
  })

  it('projects observed and unavailable openSessions truthfully and rejects negative counts', () => {
    expect(projectSshCounters({ ...counters, openSessions: { state: 'read', count: 3 } }).openSessions).toEqual({ state: 'read', count: 3 })
    expect(projectSshCounters({ ...counters, openSessions: { state: 'unavailable', count: null } }).openSessions).toEqual({ state: 'unavailable', count: null })
    expect(() => projectSshCounters({ ...counters, openSessions: { state: 'read', count: -1 } })).toThrow()
  })
})
