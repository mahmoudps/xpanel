import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { handleTerminalWorkspaceRoute } from './ops-terminal-workspace.ts'
import type { TerminalExecution, TerminalWorkspaceHelpers } from './ops-terminal-workspace.ts'
import { TerminalRegistry, TerminalTickets } from './terminal-sessions.ts'

const ORIGIN = 'https://whm.example.test:2087'
const AVAILABLE: TerminalExecution = { state: 'available', idleTimeoutSeconds: 900, absoluteTimeoutSeconds: 3600, maxInputBytes: 4096 }
const root = { principal: { kind: 'root', id: 'fixture-root', username: 'root' }, principalRecord: { totpEnabled: false }, sessionId: 'sess', apiTokenId: null } as unknown as AuthenticatedCaller
const helpers = (overrides: Partial<TerminalWorkspaceHelpers> = {}) => {
  const events: string[] = []
  const tickets = new TerminalTickets(), registry = new TerminalRegistry()
  const value: TerminalWorkspaceHelpers = {
    requireCaller: async () => root,
    assertRoot: async (caller, action) => { events.push('root:' + action); if (caller.principal.kind !== 'root') throw Object.assign(new Error('root only'), { code: 'FORBIDDEN' }) },
    emitAudit: async entry => { events.push('audit:' + entry.action + ':' + entry.outcome) },
    verifyPassword: async (_caller, password) => password === 'correct-horse',
    secondFactorEnrolled: () => false,
    verifySecondFactor: async (_caller, code) => code === '123456',
    readExecution: async () => AVAILABLE,
    tickets, registry,
    ...overrides,
  }
  return { value, events, tickets, registry }
}
const call = (h: TerminalWorkspaceHelpers, method = 'GET', body?: unknown, origin: string | null = ORIGIN) => {
  const url = new URL('http://localhost/api/server/terminal')
  return handleTerminalWorkspaceRoute(new Request(url, { method, headers: { ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), url, method, h)
}

describe('server terminal API workspace', () => {
  it('is root-only server policy on the xWHM listener only', () => {
    expect(policyForRequest('/api/server/terminal', 'POST')).toMatchObject({ resource: 'server', rootOnly: true })
    expect(entryPointAllowsApiRoute('xwhm', '/api/server/terminal', 'POST')).toBe(true)
    expect(entryPointAllowsApiRoute('xpanel', '/api/server/terminal', 'POST')).toBe(false)
    expect(entryPointAllowsApiRoute('xmail', '/api/server/terminal', 'POST')).toBe(false)
  })
  it('reports re-authentication, the second factor only when enrolled, and the host execution state', async () => {
    expect(await (await call(helpers().value))!.json()).toEqual({ capability: { reauthentication: 'required', secondFactor: 'not_enrolled', audit: 'enabled' }, execution: AVAILABLE, session: { open: false } })
    const enrolled = helpers({ secondFactorEnrolled: () => true, readExecution: async () => ({ state: 'unavailable', reason: 'terminal_helper_not_installed' }) })
    expect(await (await call(enrolled.value))!.json()).toMatchObject({ capability: { secondFactor: 'required' }, execution: { state: 'unavailable', reason: 'terminal_helper_not_installed' } })
  })
  it('issues a single-use ticket bound to the session and page origin after a fresh password re-authentication', async () => {
    const h = helpers()
    const response = await call(h.value, 'POST', { password: 'correct-horse' })
    expect(response!.status).toBe(201)
    const body = await response!.json() as { ticket: { ticket: string; expiresAt: string }; execution: unknown }
    expect(body.execution).toEqual(AVAILABLE)
    expect(h.tickets.consume(body.ticket.ticket, { principalId: 'fixture-root', panelSessionId: 'sess', origin: 'https://hostile.example.test' })).toBeNull()
    const again = await call(h.value, 'POST', { password: 'correct-horse' }), second = await again!.json() as typeof body
    expect(h.tickets.consume(second.ticket.ticket, { principalId: 'fixture-root', panelSessionId: 'sess', origin: ORIGIN })).toMatchObject({ kind: 'root', accountId: null })
  })
  it('requires the enrolled second factor and records a wrong code as a failed re-authentication', async () => {
    const recordFailure = vi.fn(async () => {})
    const h = helpers({ secondFactorEnrolled: () => true, recordFailure })
    await expect(call(h.value, 'POST', { password: 'correct-horse' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED', detail: { secondFactor: 'required' } })
    await expect(call(h.value, 'POST', { password: 'correct-horse', totpCode: '000000' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED', detail: { secondFactor: 'invalid' } })
    expect(recordFailure).toHaveBeenCalledOnce()
    expect((await call(h.value, 'POST', { password: 'correct-horse', totpCode: '123456' }))!.status).toBe(201)
  })
  it('refuses a wrong password, records the failure and never issues a ticket', async () => {
    const recordFailure = vi.fn(async () => {})
    const h = helpers({ recordFailure })
    await expect(call(h.value, 'POST', { password: 'wrong' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED', detail: { stateChanged: false } })
    expect(recordFailure).toHaveBeenCalled()
    expect(h.events).toContain('audit:server.terminal.reauthentication_failed:denied')
    expect(h.tickets.size).toBe(0)
  })
  it('refuses an account owner, non-interactive callers, a missing origin, a live session and an unavailable host', async () => {
    const owner = { ...root, principal: { kind: 'user', id: 'owner', username: 'alice', accountId: 'a' } } as unknown as AuthenticatedCaller
    await expect(call(helpers({ requireCaller: async () => owner }).value, 'POST', { password: 'correct-horse' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    for (const caller of [{ ...root, apiTokenId: 'tok', sessionId: null }, { ...root, team: { memberId: 'm' } }, { ...root, impersonator: { principalId: 'x', login: 'x' } }] as AuthenticatedCaller[])
      await expect(call(helpers({ requireCaller: async () => caller }).value, 'POST', { password: 'correct-horse' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(helpers().value, 'POST', { password: 'correct-horse' }, null)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const busy = helpers(); busy.registry.claim({ principalId: 'fixture-root', panelSessionId: 'sess', accountId: null }, () => {})
    await expect(call(busy.value, 'POST', { password: 'correct-horse' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const verifyPassword = vi.fn(async () => true)
    await expect(call(helpers({ verifyPassword, readExecution: async () => ({ state: 'unavailable', reason: 'host_agent_not_connected' }) }).value, 'POST', { password: 'x' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(verifyPassword).not.toHaveBeenCalled()
  })
  it('honours the shared lockout and closes the live session on request', async () => {
    await expect(call(helpers({ checkLockout: async () => '2026-10-28T10:00:00.000Z' }).value, 'POST', { password: 'correct-horse' })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { lockedOut: true } })
    const h = helpers(), close = vi.fn()
    h.registry.claim({ principalId: 'fixture-root', panelSessionId: 'sess', accountId: null }, close)
    expect(await (await call(h.value, 'DELETE'))!.json()).toEqual({ closed: true })
    expect(close).toHaveBeenCalledOnce()
  })
  it('rejects unsupported bodies before verifying a password', async () => {
    const verifyPassword = vi.fn(async () => true)
    const h = helpers({ verifyPassword })
    for (const body of [{ password: '' }, { password: 'x', extra: 1 }, { token: 'x' }, { password: 'x', totpCode: '12345' }, 'not json']) await expect(call(h.value, 'POST', body)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(verifyPassword).not.toHaveBeenCalled()
  })
})
