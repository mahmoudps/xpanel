/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Script } from 'node:vm'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { accountCreationPlanId, completedAccountCreationReplayFixture, reobservedAccountCreationFixture, verifiedAccountCreationFixture } from './account-create-fixture.test-helper.ts'
import type { AccountCreateOperationRecord } from './account-create-operation.ts'

const planId = accountCreationPlanId
const ownerId = '10000000-0000-4000-8000-000000000002'
type Request = (method: string, path: string, body?: Record<string, unknown>) => Promise<unknown>
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const get = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
let listeners: [EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][]
beforeEach(() => {
  listeners = []
  window.sessionStorage.clear()
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((name, callback, options) => { listeners.push([target, name, callback, options]); add(name, callback, options) })
  }
  document.documentElement.lang = 'en'; document.documentElement.dataset.realtimeEnabled = 'false'
})
afterEach(() => {
  for (const [target, name, callback, options] of listeners) target.removeEventListener(name, callback, options)
  document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest; vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const previewResponse = () => {
  let sent = false
  const bytes = new TextEncoder().encode(JSON.stringify({ scope: 'desired-state', hostBinding: 'unverified', defaultSharedIpv4: { poolId: planId, address: '192.0.2.10' }, dedicated: { entitled: false, count: 0, unallocated: [] } }))
  return { ok: true, body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }), cancel: async () => {}, releaseLock: () => {} }) } }
}
const boot = (send: Request, withChoices = true, actor: string | null = 'root:operator', runtime: Window = window) => {
  const choice = withChoices ? '<input type="radio" name="ownerId" value="" checked><input type="radio" name="ownerId" value="' + ownerId + '"><input type="radio" name="shell" value="jailed" checked><input type="radio" name="shell" value="none">' : ''
  const actorAttribute = actor === null ? '' : ' data-account-create-actor="' + actor + '"'
  document.body.innerHTML = '<section data-accounts-workspace><form data-create-account-form' + actorAttribute + '><input name="username" value="alpha"><input name="primaryDomain" value="alpha.example.test"><input id="new-acc-password" type="password" name="password" autocomplete="new-password" value="synthetic-initial-password"><input name="contactEmail" value=""><input name="ipv6" value=""><select name="planId"><option value="' + planId + '">Standard</option></select><select name="ipAssignment"><option value="shared">Shared</option></select>' + choice + '<button type="button" data-account-ip-refresh>Refresh</button><button type="button" data-account-generate-password data-password-target="new-acc-password">Generate</button><button type="button" data-account-toggle-password data-password-target="new-acc-password" aria-pressed="false">Reveal password</button><p data-account-ip-status></p><p><bdi data-account-ip-address></bdi></p><p data-account-create-status tabindex="-1"></p><button type="submit">Create</button><button type="reset">Discard</button></form><section data-approved-account-create-status><p data-account-creation-observation></p><button type="button" disabled data-account-create-another data-create-route="/whm/accounts/new?lang=en&amp;theme=dark&amp;density=comfortable">Create another</button></section></section>'
  ;(window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest = send
  const fetch = vi.fn().mockImplementation(async () => previewResponse()); vi.stubGlobal('fetch', fetch)
  new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(runtime, document)
  return fetch
}
const submit = () => get<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }))
const refusal = { status: 412, details: { stateChanged: false } }

describe('approved new-account controls in the complete client', () => {
  it('emits valid whole-script JavaScript', () => { expect(() => new Script(BROWSER_REALTIME_SCRIPT)).not.toThrow() })
  it('sends checked owner/shell only and scopes a refreshed IP preview to that owner', async () => {
    let body: Record<string, unknown> = {}
    const send = vi.fn<Request>().mockImplementation(async (_method, _path, payload) => { body = { ...payload }; throw refusal })
    const fetch = boot(send); await tick()
    get<HTMLInputElement>('input[name="ownerId"][value="' + ownerId + '"]').checked = true
    get<HTMLInputElement>('input[name="ownerId"][value="' + ownerId + '"]').dispatchEvent(new Event('change')); await tick()
    get<HTMLInputElement>('input[name="shell"][value="none"]').checked = true
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/ips?view=allocation&planId=' + planId + '&ownerId=' + ownerId)
    submit(); submit(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(body.ownerId).toBe(ownerId); expect(body.shell).toBe('none'); expect(body.ipAssignment).toEqual({ mode: 'shared' })
    expect(get<HTMLInputElement>('[name="password"]').value).toBe('')
    expect(get<HTMLInputElement>('input[name="ownerId"]:checked').value).toBe(ownerId)
  })
  it('omits absent optional owner/shell controls while retaining the creation key', async () => {
    let body: Record<string, unknown> = {}
    const send = vi.fn<Request>().mockImplementation(async (_method, _path, payload) => { body = { ...payload }; throw refusal })
    const fetch = boot(send, false); await tick(); submit(); await tick()
    expect(body).not.toHaveProperty('ownerId'); expect(body).not.toHaveProperty('shell'); expect(body.idempotencyKey).toMatch(/^account-create:[0-9a-f]{32}$/)
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/ips?view=allocation&planId=' + planId)
  })
  it('rejects invalid or unavailable checked owner/shell controls before POST', async () => {
    const send = vi.fn<Request>(); boot(send); await tick()
    const selected = get<HTMLInputElement>('input[name="ownerId"]:checked'); selected.value = 'not-authorized-id'; submit(); await tick(); expect(send).not.toHaveBeenCalled()
    selected.value = ''; get<HTMLInputElement>('input[name="shell"]:checked').disabled = true; submit(); await tick(); expect(send).not.toHaveBeenCalled()
  })
  it('omits fully disabled new option groups instead of issuing their values', async () => {
    let body: Record<string, unknown> = {}
    const send = vi.fn<Request>().mockImplementation(async (_method, _path, payload) => { body = { ...payload }; throw refusal }); boot(send); await tick()
    document.querySelectorAll<HTMLInputElement>('[name="ownerId"],[name="shell"]').forEach(field => { field.disabled = true })
    submit(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(body).not.toHaveProperty('ownerId'); expect(body).not.toHaveProperty('shell')
  })
  it('does not create through an explicitly unavailable form even if its button was enabled', async () => {
    const send = vi.fn<Request>(); boot(send); await tick()
    get('form').setAttribute('data-capability-unavailable', 'true'); submit(); await tick(); expect(send).not.toHaveBeenCalled()
  })
  it('uses the same local secure generator only for the new-account password without sending', async () => {
    const send = vi.fn<Request>(); const fetch = boot(send); await tick(); fetch.mockClear()
    get('[data-account-generate-password]').click()
    const value = get<HTMLInputElement>('#new-acc-password').value
    expect(value).toHaveLength(24); expect(value).toMatch(/[A-Z]/); expect(value).toMatch(/[a-z]/); expect(value).toMatch(/[0-9]/); expect(value).toMatch(/[^a-zA-Z0-9]/)
    expect(send).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    expect(get('[data-account-create-status]').textContent).not.toContain(value)
  })
  it('reveals, generates and hides only the new-account password without a request', async () => {
    const send = vi.fn<Request>(); const fetch = boot(send); await tick(); fetch.mockClear()
    const reveal = get<HTMLButtonElement>('[data-account-toggle-password]'), password = get<HTMLInputElement>('#new-acc-password')
    const original = password.value
    reveal.click(); expect(password.type).toBe('text'); expect(password.value).toBe(original); expect(reveal.getAttribute('aria-pressed')).toBe('true'); expect(reveal.textContent).toBe('Hide password')
    get('[data-account-generate-password]').click(); const generated = password.value; expect(generated).toHaveLength(24)
    reveal.click(); expect(password.type).toBe('password'); expect(password.value).toBe(generated); expect(reveal.getAttribute('aria-pressed')).toBe('false')
    password.readOnly = true; reveal.click(); get('[data-account-generate-password]').click(); expect(password.type).toBe('password'); expect(password.value).toBe(generated)
    expect(fetch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })
  it('enables Create another only after a verified creation acknowledgement', async () => {
    const send = vi.fn<Request>().mockResolvedValue(verifiedAccountCreationFixture())
    boot(send); await tick(); expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(true)
    submit(); await tick(); expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(false)
    expect(get('[data-account-create-status]').textContent).toBe('Account created.')
    expect(get<HTMLButtonElement>('[data-account-generate-password]').disabled).toBe(true); expect(get<HTMLButtonElement>('[data-account-toggle-password]').disabled).toBe(true)
  })
  it('rejects a legacy configuration-only acknowledgement for creation', async () => {
    const send = vi.fn<Request>().mockResolvedValue({
      account: { username: 'alpha', ipv4: '192.0.2.10', ownerId: null, shell: 'jailed' },
      reconcile: { status: 'applied' },
      execution: { status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true },
    })
    boot(send); await tick(); submit(); await tick(); submit(); await tick()
    expect(send).toHaveBeenCalledOnce()
    expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(true)
    expect(get<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
    expect(get('[data-account-create-status]').textContent).toContain('could not be verified')
  })

  it.each([{ status: 412, details: { stateChanged: false } }, { status: 409, unknownOutcome: true }])('keeps Create another disabled before a verified result: %j', async error => {
    const send = vi.fn<Request>().mockRejectedValue(error); boot(send); await tick(); submit(); await tick()
    expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(true)
  })
  it('discards only a local draft and refreshes the owner-specific IP context', async () => {
    const send = vi.fn<Request>(); const fetch = boot(send); await tick()
    const owner = get<HTMLInputElement>('input[name="ownerId"][value="' + ownerId + '"]'); owner.checked = true; owner.dispatchEvent(new Event('change')); await tick()
    get<HTMLInputElement>('[name="username"]').value = 'edited'
    get<HTMLFormElement>('form').reset(); await tick()
    expect(get<HTMLInputElement>('[name="username"]').value).toBe('alpha'); expect(get<HTMLInputElement>('input[name="ownerId"]:checked').value).toBe('')
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/ips?view=allocation&planId=' + planId); expect(send).not.toHaveBeenCalled()
  })
  it('locks an explicit unknown outcome even when a refusal carries stateChanged false', async () => {
    const send = vi.fn<Request>().mockRejectedValue({ status: 409, unknownOutcome: true, details: { stateChanged: false } }); boot(send); await tick()
    submit(); await tick(); submit(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(get<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
  })
  it('does not accept a response that changed the submitted owner or shell', async () => {
    const send = vi.fn<Request>().mockResolvedValue(verifiedAccountCreationFixture({ ownerId, shell: 'none' }))
    boot(send); await tick(); submit(); await tick()
    expect(get('[data-account-create-status]').textContent).toContain('could not be verified'); expect(get<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
  })
})

const namespace = (actor = 'root:operator') => 'xpanel.account-create.v1.' + encodeURIComponent(actor)
const operation = (actor = 'root:operator'): AccountCreateOperationRecord | null => {
  const raw = window.sessionStorage.getItem(namespace(actor))
  return raw === null ? null : JSON.parse(raw) as AccountCreateOperationRecord
}
const refillPassword = () => { get<HTMLInputElement>('[name="password"]').value = 'synthetic-initial-password' }

describe('retained native creation outcomes in the complete client', () => {
  it.each([0, 1, 2])('requires complete fresh observations even when resumed from public phase %s', async resumedFromStep => {
    const result = verifiedAccountCreationFixture()
    result.operation.resumedFromStep = resumedFromStep
    const send = vi.fn<Request>().mockResolvedValue(result)
    boot(send); await tick(); submit(); await tick()
    expect(get('[data-account-create-status]').textContent).toBe('Account created.')
    expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(false)
    expect(operation()).toMatchObject({ username: 'alpha', phase: 'complete' })
    expect(get('[data-account-creation-observation]').textContent).not.toContain('Individual host task completion has not been observed.')
  })

  it('retains the same opaque key across an identical no-effect retry and reload without storing credentials', async () => {
    const keys: unknown[] = []
    const send = vi.fn<Request>(async (_method, _path, body) => { keys.push(body!.idempotencyKey); throw refusal })
    boot(send); await tick(); submit(); await tick()
    expect(keys[0]).toMatch(/^account-create:[0-9a-f]{32}$/)
    expect(operation()).toMatchObject({ key: keys[0], phase: 'no-effects' })
    refillPassword(); submit(); await tick()
    boot(send); await tick(); refillPassword(); submit(); await tick()
    expect(keys).toEqual([keys[0], keys[0], keys[0]])
    expect(Object.keys(operation()!).sort()).toEqual(['key', 'phase', 'username', 'version'])
    expect(operation()).toMatchObject({ version: 1, username: 'alpha', phase: 'no-effects' })
    const raw = window.sessionStorage.getItem(namespace())!
    expect(raw).not.toContain('synthetic-initial-password')
    expect(raw).not.toMatch(/password|credential|digest|fingerprint/i)
  })

  it('preserves an unknown request across reset, reload and forced submit', async () => {
    const send = vi.fn<Request>().mockRejectedValue({ status: 409, unknownOutcome: true, details: { stateChanged: false } })
    boot(send); await tick(); submit(); await tick()
    const retained = operation()
    expect(retained).toMatchObject({ username: 'alpha', phase: 'pending' })
    get<HTMLFormElement>('form').reset(); await tick()
    expect(operation()).toEqual(retained)
    const reload = vi.fn<Request>()
    boot(reload); await tick()
    expect(get<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
    expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(true)
    get<HTMLButtonElement>('button[type="submit"]').disabled = false
    submit(); await tick()
    expect(reload).not.toHaveBeenCalled()
    expect(operation()).toEqual(retained)
    expect(get('[data-account-create-status]').textContent).toContain('Review accounts before retrying')
  })

  it('discards only a proven no-effect request and creates a new key afterwards', async () => {
    const keys: unknown[] = []
    const send = vi.fn<Request>(async (_method, _path, body) => { keys.push(body!.idempotencyKey); throw refusal })
    boot(send); await tick(); submit(); await tick()
    expect(operation()?.phase).toBe('no-effects')
    get<HTMLFormElement>('form').reset(); await tick()
    expect(operation()).toBeNull()
    refillPassword(); submit(); await tick()
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])
  })

  it('keeps authenticated public actors in separate retry namespaces', async () => {
    const first = vi.fn<Request>().mockRejectedValue({ status: 409, unknownOutcome: true })
    boot(first); await tick(); submit(); await tick()
    const retained = operation()!
    let secondKey: unknown
    const second = vi.fn<Request>(async (_method, _path, body) => { secondKey = body!.idempotencyKey; throw refusal })
    boot(second, false, 'reseller:other'); await tick(); submit(); await tick()
    expect(second).toHaveBeenCalledOnce()
    expect(secondKey).not.toBe(retained.key)
    expect(operation()).toEqual(retained)
    expect(operation('reseller:other')).toMatchObject({ key: secondKey, phase: 'no-effects' })
  })

  it('makes no creation request without a legitimate server-derived actor', async () => {
    const send = vi.fn<Request>()
    boot(send, true, null); await tick(); submit(); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(get('[data-account-create-status]').textContent).toContain('could not retain this request')
  })

  it.each(['read', 'write', 'readback'] as const)('fails before POST after a %s storage failure', async failure => {
    const prototype = Object.getPrototypeOf(window.sessionStorage) as Storage
    const originalGet = prototype.getItem, originalSet = prototype.setItem
    if (failure === 'read') vi.spyOn(prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key.startsWith('xpanel.account-create.v1.')) throw new DOMException('fixture storage unavailable', 'SecurityError')
      return originalGet.call(this, key)
    })
    else vi.spyOn(prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (!key.startsWith('xpanel.account-create.v1.')) { originalSet.call(this, key, value); return }
      if (failure === 'write') throw new DOMException('fixture storage unavailable', 'QuotaExceededError')
    })
    const send = vi.fn<Request>()
    boot(send); await tick(); submit(); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(get('[data-account-create-status]').textContent).toContain('could not retain this request')
  })

  it('preserves an invalid persisted record without exposing or replacing it', async () => {
    const malformed = JSON.stringify({ version: 1, key: 'account-create:' + 'a'.repeat(32), username: 'alpha', phase: 'pending', credential: 'unreviewed-state-marker' })
    window.sessionStorage.setItem(namespace(), malformed)
    const send = vi.fn<Request>()
    boot(send); await tick(); submit(); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem(namespace())).toBe(malformed)
    expect(document.body.textContent).not.toContain('unreviewed-state-marker')
  })

  it('accepts independently observed finalization without claiming another host application', async () => {
    const send = vi.fn<Request>().mockResolvedValue(reobservedAccountCreationFixture())
    boot(send); await tick(); submit(); await tick()
    expect(get('[data-account-create-status]').textContent).toBe('Account created.')
    expect(get('[data-account-creation-observation]').textContent).not.toContain('Individual host task completion has not been observed.')
    expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(false)
    expect(operation()?.phase).toBe('complete')
    expect(send).toHaveBeenCalledOnce()
  })

  it('reports a historical replay without claiming fresh hosting verification', async () => {
    const replay = completedAccountCreationReplayFixture()
    const send = vi.fn<Request>().mockResolvedValue(replay)
    boot(send); await tick(); submit(); await tick()
    expect(get('[data-account-create-status]').textContent).toContain('already completed')
    expect(get('[data-account-create-status]').textContent).toContain('Current hosting verification is still required')
    expect(get('[data-account-create-status]').textContent).not.toBe('Account created.')
    expect(operation()?.phase).toBe('complete')
    expect(send).toHaveBeenCalledOnce()
  })

  it.each(['uid', 'generation', 'observation', 'contradictory-replay', 'unknown-observation', 'completed-replay', 'missing-completed-replay', 'post-host-fresh', 'unknown-operation'] as const)('rejects resolved %s evidence', async fault => {
    const result = verifiedAccountCreationFixture()
    if (fault === 'uid') Object.assign(result.execution.observation, { uid: result.execution.observation.uid + 1 })
    if (fault === 'generation') result.reconcile.generation.id++
    if (fault === 'observation') Object.assign(result.execution, { observation: undefined })
    if (fault === 'contradictory-replay') Object.assign(result.execution, { replay: true })
    if (fault === 'unknown-observation') Object.assign(result.execution.observation, { fabricatedCapability: true })
    if (fault === 'completed-replay') result.operation.completedReplay = true
    if (fault === 'missing-completed-replay') Reflect.deleteProperty(result.operation, 'completedReplay')
    if (fault === 'post-host-fresh') result.operation.resumedFromStep = 3
    if (fault === 'unknown-operation') Object.assign(result.operation, { unreviewed: true })
    const send = vi.fn<Request>().mockResolvedValue(result)
    boot(send); await tick(); submit(); await tick(); submit(); await tick()
    expect(send).toHaveBeenCalledOnce()
    expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(true)
    expect(get<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
    expect(operation()?.phase).toBe('pending')
    expect(get('[data-account-create-status]').textContent).toContain('could not be verified')
  })

  it.each([
    ['reobserved before the host phase', () => { const value = reobservedAccountCreationFixture(); value.operation.resumedFromStep = 2; return value }],
    ['reobserved marked as completed replay', () => { const value = reobservedAccountCreationFixture(); value.operation.completedReplay = true; return value }],
    ['reobserved carrying an application result', () => { const value = reobservedAccountCreationFixture(); return { ...value, reconcile: verifiedAccountCreationFixture().reconcile } }],
    ['historical receipt before completion', () => { const value = completedAccountCreationReplayFixture(); value.operation.resumedFromStep = 3; return value }],
    ['historical receipt marked as current', () => { const value = completedAccountCreationReplayFixture(); value.operation.completedReplay = false; return value }],
    ['historical receipt claiming fresh effects', () => { const value = completedAccountCreationReplayFixture(); value.operation.freshExecution = true; return value }],
  ] as const)('keeps a contradictory %s locked for review', async (_name, response) => {
    const send = vi.fn<Request>().mockResolvedValue(response())
    boot(send); await tick(); submit(); await tick(); submit(); await tick()
    expect(send).toHaveBeenCalledOnce()
    expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(true)
    expect(get<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
    expect(operation()?.phase).toBe('pending')
    expect(get('[data-account-create-status]').textContent).toContain('could not be verified')
  })

  it('clears a completed request only after validating the Create another URL', async () => {
    const assign = vi.fn()
    const current = window.location
    const location = { origin: current.origin, href: current.href, protocol: current.protocol, host: current.host,
      hostname: current.hostname, port: current.port, pathname: current.pathname, search: current.search, hash: current.hash,
      assign, replace: vi.fn(), reload: vi.fn(), toString: () => current.href }
    const runtime = new Proxy(window, { get: (target, property) => property === 'location' ? location : Reflect.get(target, property, target) }) as Window
    const send = vi.fn<Request>().mockResolvedValue(verifiedAccountCreationFixture())
    boot(send, true, 'root:operator', runtime); await tick(); submit(); await tick()
    const retained = operation()
    expect(retained?.phase).toBe('complete')
    const another = get<HTMLButtonElement>('[data-account-create-another]')
    for (const route of ['https://outside.example/whm/accounts/new', '/whm/terminal', '/whm/accounts/new?accountId=foreign', '/whm/accounts/new?lang=en&lang=ar', '/whm/accounts/new#draft']) {
      another.setAttribute('data-create-route', route); another.click()
      expect(operation()).toEqual(retained); expect(assign).not.toHaveBeenCalled()
    }
    another.setAttribute('data-create-route', '/whm/accounts/new?lang=en&theme=dark&density=comfortable')
    another.click()
    expect(operation()).toBeNull()
    expect(assign).toHaveBeenCalledExactlyOnceWith('/whm/accounts/new?lang=en&theme=dark&density=comfortable')
    expect(send).toHaveBeenCalledOnce()
  })
})

describe('accepted creations read through their operation', () => {
  const id = '10000000-0000-4000-8000-0000000000aa', path = '/api/accounts/operations/' + id
  const running = () => ({ operation: { id, reference: null, status: 'running', needsAttention: false }, account: verifiedAccountCreationFixture().account, primaryDomain: null })
  const ended = (outcome: object) => ({ operation: { id, reference: null, status: 'result' in outcome ? 'succeeded' : 'failed', needsAttention: false }, ...outcome })
  const accepted = (reads: unknown[]) => vi.fn<Request>(async method => {
    if (method === 'POST') return running()
    const next = reads.shift()
    if (next instanceof Error) throw next
    return next
  })
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); submit(); await vi.advanceTimersByTimeAsync(0) }
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('shows the creation in progress, then the verified answer the operation recorded', async () => {
    const send = accepted([running(), ended({ result: verifiedAccountCreationFixture() })])
    boot(send); await settle()
    expect(get('[data-account-create-status]').textContent).toBe('The server is creating the account. It continues if you leave this page.')
    expect(get<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(2000 + 3000)
    expect(send.mock.calls.map(call => call[0] + ' ' + call[1])).toEqual(['POST /api/accounts', 'GET ' + path, 'GET ' + path])
    expect(get('[data-account-create-status]').textContent).toBe('Account created.')
    expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(false)
    expect(operation()).toMatchObject({ username: 'alpha', phase: 'complete' })
  })

  it.each([
    ['a recorded problem', ended({ problem: { status: 503, code: 'SERVICE_UNAVAILABLE', detail: 'account provisioning did not acknowledge a verified outcome', details: { stateChanged: true, verificationRequired: true } } })],
    ['an unreadable operation', new Error('network')],
    ['an operation without its answer', { operation: { id, reference: null, status: 'interrupted', needsAttention: true }, account: null }],
  ])('keeps %s locked for review', async (_name, read) => {
    const send = accepted([read])
    boot(send); await settle(); await vi.advanceTimersByTimeAsync(2000)
    expect(send).toHaveBeenCalledTimes(2)
    expect(get('[data-account-create-status]').textContent).toContain('Review accounts before retrying')
    expect(get<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true)
    expect(get<HTMLButtonElement>('[data-account-create-another]').disabled).toBe(true)
    expect(operation()?.phase).toBe('pending')
  })
})
