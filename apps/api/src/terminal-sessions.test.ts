import { describe, expect, it, vi } from 'vitest'
import { parseTerminalClientMessage, TERMINAL_TICKET_TTL_MS, TerminalRegistry, TerminalTickets } from './terminal-sessions.ts'
import type { TerminalGrant } from './terminal-sessions.ts'

const grant: TerminalGrant = { kind: 'account', principalId: 'p-alice', actor: 'alice', panelSessionId: 's-alice', origin: 'https://panel.example.test:2083', accountId: 'a-alice', accountUsername: 'alice' }
const presenter = { principalId: 'p-alice', panelSessionId: 's-alice', origin: 'https://panel.example.test:2083' }

describe('terminal tickets', () => {
  it('issue a single-use ticket bound to the principal, panel session and origin', () => {
    const tickets = new TerminalTickets()
    const issued = tickets.issue(grant)
    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(tickets.consume(issued.ticket, presenter)).toEqual(grant)
    expect(tickets.consume(issued.ticket, presenter)).toBeNull()
  })
  it('deny another user, another panel session or another origin, and spend the ticket on the attempt', () => {
    const tickets = new TerminalTickets()
    for (const wrong of [{ ...presenter, principalId: 'p-bob' }, { ...presenter, panelSessionId: 's-other' }, { ...presenter, origin: 'https://hostile.example.test' }, { ...presenter, origin: null }]) {
      const { ticket } = tickets.issue(grant)
      expect(tickets.consume(ticket, wrong)).toBeNull()
      expect(tickets.consume(ticket, presenter)).toBeNull()
    }
  })
  it('deny an expired ticket and keep one outstanding ticket per user', () => {
    let clock = 1_000
    const tickets = new TerminalTickets({ now: () => clock })
    const first = tickets.issue(grant), second = tickets.issue(grant)
    expect(tickets.size).toBe(1)
    expect(tickets.consume(first.ticket, presenter)).toBeNull()
    clock += TERMINAL_TICKET_TTL_MS
    expect(tickets.consume(second.ticket, presenter)).toBeNull()
    expect(new Date(second.expiresAt).getTime()).toBe(1_000 + TERMINAL_TICKET_TTL_MS)
  })
  it('reject malformed tickets without lookup', () => {
    const tickets = new TerminalTickets()
    for (const bad of [undefined, 42, '', 'x'.repeat(44), 'a/b'.padEnd(43, 'c')]) expect(tickets.consume(bad, presenter)).toBeNull()
  })
})

const owner = (principalId: string, panelSessionId = 's-' + principalId, accountId: string | null = 'a-' + principalId) => ({ principalId, panelSessionId, accountId })

describe('terminal registry', () => {
  it('allow one live terminal per user and release only its own claim', () => {
    const registry = new TerminalRegistry(), close = vi.fn()
    const release = registry.claim(owner('p-alice'), close)!
    expect(registry.claim(owner('p-alice'), vi.fn())).toBeNull()
    expect(registry.claim(owner('p-bob'), vi.fn())).not.toBeNull()
    expect(registry.close('p-alice')).toBe(true)
    expect(close).toHaveBeenCalledWith('closed')
    release()
    expect(registry.has('p-alice')).toBe(false)
    const again = registry.claim(owner('p-alice'), vi.fn())!
    release()
    expect(registry.has('p-alice')).toBe(true)
    again()
    expect(registry.close('p-alice')).toBe(false)
  })
  it('revoke at once by panel session, by user except one session, and by account; never everything', () => {
    const registry = new TerminalRegistry()
    const alice = vi.fn(), bob = vi.fn(), root = vi.fn()
    registry.claim(owner('p-alice', 's-1', 'a-1'), alice)
    registry.claim(owner('p-bob', 's-2', 'a-2'), bob)
    registry.claim(owner('p-root', 's-3', null), root)
    expect(registry.revoke({})).toBe(0)
    expect(registry.revoke({ panelSessionId: 's-9' })).toBe(0)
    expect(registry.revoke({ principalId: 'p-root', exceptPanelSessionId: 's-3' })).toBe(0)
    expect(registry.revoke({ accountId: 'a-2' })).toBe(1)
    expect(bob).toHaveBeenCalledWith('revoked')
    expect(registry.revoke({ panelSessionId: 's-1' })).toBe(1)
    expect(alice).toHaveBeenCalledWith('revoked')
    expect(registry.revoke({ principalId: 'p-root' })).toBe(1)
    expect(root).toHaveBeenCalledWith('revoked')
  })
})

describe('terminal browser message grammar', () => {
  it('accept the four exact message shapes', () => {
    expect(parseTerminalClientMessage(JSON.stringify({ type: 'open', ticket: 't', cols: 80, rows: 24 }))).toEqual({ type: 'open', ticket: 't', cols: 80, rows: 24 })
    expect(parseTerminalClientMessage(JSON.stringify({ type: 'input', data: 'ls é\r' }))).toEqual({ type: 'input', data: 'ls é\r' })
    expect(parseTerminalClientMessage(JSON.stringify({ type: 'resize', cols: 500, rows: 200 }))).toEqual({ type: 'resize', cols: 500, rows: 200 })
    expect(parseTerminalClientMessage('{"type":"close"}')).toEqual({ type: 'close' })
  })
  it('reject oversize input, bad sizes, extra fields and non-JSON', () => {
    for (const raw of [
      JSON.stringify({ type: 'input', data: 'é'.repeat(2049) }), JSON.stringify({ type: 'input', data: '' }), JSON.stringify({ type: 'input', data: 'x', extra: 1 }),
      JSON.stringify({ type: 'resize', cols: 19, rows: 24 }), JSON.stringify({ type: 'resize', cols: 80, rows: 24.5 }), JSON.stringify({ type: 'open', ticket: 't', cols: 80 }),
      JSON.stringify({ type: 'exec', command: 'id' }), '[]', 'not json', 'x'.repeat(9000),
    ]) expect(parseTerminalClientMessage(raw)).toBeNull()
  })
})
