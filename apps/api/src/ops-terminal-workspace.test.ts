import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { handleTerminalWorkspaceRoute } from './ops-terminal-workspace.ts'
import type { TerminalWorkspaceHelpers } from './ops-terminal-workspace.ts'

const root = { principal: { kind: 'root', id: 'fixture-root', username: 'root' }, sessionId: 'sess', apiTokenId: null } as AuthenticatedCaller
const helpers = (overrides: Partial<TerminalWorkspaceHelpers> = {}) => {
  const events: string[] = []
  const value: TerminalWorkspaceHelpers = {
    requireCaller: async () => root,
    assertRoot: async (_caller, action) => { events.push('root:' + action) },
    emitAudit: async entry => { events.push('audit:' + entry.action + ':' + entry.outcome) },
    verifyPassword: async (_caller, password) => password === 'correct-horse',
    now: () => new Date('2026-10-28T09:00:00.000Z'),
    ...overrides,
  }
  return { value, events }
}
const call = (h: TerminalWorkspaceHelpers, method = 'GET', body?: unknown) => {
  const url = new URL('http://localhost/api/server/terminal')
  return handleTerminalWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, h)
}

describe('server terminal API workspace', () => {
  it('is root-only server policy on the xWHM listener only', () => {
    expect(policyForRequest('/api/server/terminal', 'POST')).toMatchObject({ resource: 'server', rootOnly: true })
    expect(entryPointAllowsApiRoute('xwhm', '/api/server/terminal', 'POST')).toBe(true)
    expect(entryPointAllowsApiRoute('xpanel', '/api/server/terminal', 'POST')).toBe(false)
  })
  it('reports the capability and the truthful unavailable execution state', async () => {
    const response = await call(helpers().value)
    expect(await response!.json()).toEqual({ capability: { reauthentication: 'required', audit: 'enabled' }, execution: { state: 'unavailable', reason: 'no_qualified_root_terminal_execution_path' } })
  })
  it('opens an audited session after a fresh password re-authentication', async () => {
    const h = helpers()
    const response = await call(h.value, 'POST', { password: 'correct-horse' })
    expect(response!.status).toBe(201)
    const body = await response!.json() as Record<string, any>
    expect(body.session.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.execution).toEqual({ state: 'unavailable', reason: 'no_qualified_root_terminal_execution_path' })
    expect(h.events).toContain('audit:server.terminal.session_opened:ok')
  })
  it('refuses a wrong password, records the failure and never opens a session', async () => {
    const recordFailure = vi.fn(async () => {})
    const h = helpers({ recordFailure })
    await expect(call(h.value, 'POST', { password: 'wrong' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED', detail: { stateChanged: false } })
    expect(recordFailure).toHaveBeenCalled()
    expect(h.events).toContain('audit:server.terminal.reauthentication_failed:denied')
    expect(h.events).not.toContain('audit:server.terminal.session_opened:ok')
  })
  it('honours the shared lockout and refuses non-interactive callers', async () => {
    await expect(call(helpers({ checkLockout: async () => '2026-10-28T10:00:00.000Z' }).value, 'POST', { password: 'correct-horse' })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { lockedOut: true } })
    const tokenCaller = { ...root, apiTokenId: 'tok', sessionId: null } as AuthenticatedCaller
    await expect(call(helpers({ requireCaller: async () => tokenCaller }).value, 'POST', { password: 'correct-horse' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('rejects unsupported bodies before verifying a password', async () => {
    const verifyPassword = vi.fn(async () => true)
    const h = helpers({ verifyPassword })
    for (const body of [{ password: '' }, { password: 'x', extra: 1 }, { token: 'x' }, 'not json']) await expect(call(h.value, 'POST', body)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(verifyPassword).not.toHaveBeenCalled()
  })
})
