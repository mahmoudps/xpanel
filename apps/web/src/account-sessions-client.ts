import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
const displayDateTime = formatDisplayDateTime

/**
 * Trusted-self session management browser controller.
 * Uses `/api/auth/sessions`, `/api/auth/sessions/:id` and `/api/auth/sessions/revoke-others`.
 * Only the signed-in principal's own sessions are visible or revocable.
 */

const SESSION_UUID = /^[0-9a-f-]{36}$/i

export interface SessionView {
  id: string; current: boolean; ip: string | null; userAgent: string | null
  mfaVerified: boolean; createdAt: string; lastSeenAt: string; expiresAt: string
}

const sessionObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const sessionDate = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('invalid_' + field)
  return value
}

export function readSession(value: unknown): SessionView {
  if (!sessionObject(value) || typeof value.id !== 'string' || !SESSION_UUID.test(value.id)) throw new Error('invalid_session')
  if (typeof value.current !== 'boolean') throw new Error('invalid_session')
  if (value.ip !== null && (typeof value.ip !== 'string' || value.ip.length > 64)) throw new Error('invalid_session')
  if (value.userAgent !== null && (typeof value.userAgent !== 'string' || !value.userAgent.isWellFormed() || value.userAgent.length > 512)) throw new Error('invalid_session')
  if (typeof value.mfaVerified !== 'boolean') throw new Error('invalid_session')
  return {
    id: value.id,
    current: value.current,
    ip: value.ip as string | null,
    userAgent: value.userAgent as string | null,
    mfaVerified: value.mfaVerified,
    createdAt: sessionDate(value.createdAt, 'created_at'),
    lastSeenAt: sessionDate(value.lastSeenAt, 'last_seen_at'),
    expiresAt: sessionDate(value.expiresAt, 'expires_at'),
  }
}

export function readSessions(value: unknown, currentSessionId?: string | null): SessionView[] {
  if (!sessionObject(value) || !Array.isArray(value.sessions)) throw new Error('invalid_sessions')
  const current = value.currentSessionId
  if (current !== null && current !== undefined && (typeof current !== 'string' || !SESSION_UUID.test(current))) throw new Error('invalid_sessions')
  const sessions = value.sessions.map(readSession)
  if (sessions.filter(session => session.current).length > 1) throw new Error('invalid_sessions')
  if (new Set(sessions.map(session => session.id)).size !== sessions.length) throw new Error('invalid_sessions')
  if (typeof current === 'string') {
    const marked = sessions.find(session => session.id.toLowerCase() === current.toLowerCase())
    if (marked && !marked.current) throw new Error('invalid_sessions')
  }
  return sessions
}

function bindAccountSessions(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-sessions]').forEach(root => {
    if (root.dataset.sessionsBound === 'true') return
    root.dataset.sessionsBound = 'true'
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const rows = root.querySelector<HTMLElement>('[data-sessions-rows]')
    const status = root.querySelector<HTMLElement>('[data-sessions-status]')
    const revokeOthersButton = root.querySelector<HTMLButtonElement>('[data-sessions-revoke-others]')
    if (!rows || !status || !revokeOthersButton) return
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const eligible = (): boolean => root.isConnected && !root.closest(denied)
    let sessions: SessionView[] = []
    let busy = false, uncertain = false
    const controls = (): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>('button')]
    const setStatus = (message: string, kind: string): void => {
      status.hidden = !message
      status.dataset.state = kind
      status.setAttribute('role', kind === 'failed' || kind === 'uncertain' ? 'alert' : 'status')
      status.textContent = message
    }
    const lock = (): void => { const blocked = busy || uncertain || !eligible(); controls().forEach(control => { control.disabled = blocked }) }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!transport) return Promise.reject(Object.assign(new Error('transport_unavailable'), { stateChanged: false }))
      return transport(method, path, body)
    }
    const describeAgent = (session: SessionView): string => {
      if (!session.userAgent) return copy('Unknown client')
      return session.userAgent.length > 96 ? session.userAgent.slice(0, 93) + '…' : session.userAgent
    }
    let templates: { row: HTMLTemplateElement; action: HTMLTemplateElement; empty: HTMLTemplateElement }
    const rowSlots = ['title', 'verification', 'network-label', 'network', 'client-label', 'client', 'last-active-label', 'last-active', 'expires-label', 'expires', 'actions'] as const
    try {
      templates = { row: clientTemplate(root, 'account-session-row'), action: clientTemplate(root, 'account-session-action'), empty: clientTemplate(root, 'account-session-empty') }
      cloneClientTemplate(templates.row, 'article', rowSlots)
      cloneClientTemplate(templates.action, 'button', ['label'])
      cloneClientTemplate(templates.empty, 'p', ['message'])
    } catch {
      controls().forEach(control => { control.disabled = true })
      setStatus(copy('Session management is unavailable here. No sessions were read or changed.'), 'unavailable'); return
    }
    const paint = (): void => {
      rows.textContent = ''
      if (!sessions.length) {
        const empty = cloneClientTemplate(templates.empty, 'p', ['message'])
        clientTemplateSlot(empty, 'message').textContent = copy('No active sessions were returned.')
        rows.appendChild(empty); lock(); return
      }
      for (const session of sessions) {
        const card = cloneClientTemplate(templates.row, 'article', rowSlots); card.dataset.sessionId = session.id
        clientTemplateSlot(card, 'title').textContent = session.current ? copy('This device') : copy('Another device')
        clientTemplateSlot(card, 'verification').textContent = session.mfaVerified ? copy('Two-factor verified') : copy('Password only')
        for (const [name, label, value] of [['network', copy('Network'), session.ip ?? copy('Not recorded')], ['client', copy('Client'), describeAgent(session)], ['last-active', copy('Last active'), displayDateTime(session.lastSeenAt)], ['expires', copy('Expires'), displayDateTime(session.expiresAt)]] as const) {
          clientTemplateSlot(card, name + '-label').textContent = label
          clientTemplateSlot(card, name).textContent = value
        }
        clientTemplateSlot(card, 'last-active', 'time').setAttribute('datetime', session.lastSeenAt)
        clientTemplateSlot(card, 'expires', 'time').setAttribute('datetime', session.expiresAt)
        const actions = clientTemplateSlot(card, 'actions')
        if (!session.current) {
          const signOut = cloneClientTemplate(templates.action, 'button', ['label']) as HTMLButtonElement
          clientTemplateSlot(signOut, 'label').textContent = copy('Sign out this session')
          signOut.addEventListener('click', () => { if (!signOut.disabled && eligible()) void revoke(session) })
          actions.appendChild(signOut)
        }
        rows.appendChild(card)
      }
      lock()
    }
    const load = async (): Promise<void> => {
      sessions = readSessions(await request('GET', '/api/auth/sessions'))
      paint()
    }
    const revoke = async (session: SessionView): Promise<void> => {
      if (!askDialog) { setStatus(copy('Ending a session needs confirmation; nothing was sent.'), 'failed'); return }
      const confirmed = await askDialog({ title: copy('Sign out session'), body: session.userAgent ?? session.ip ?? copy('Unknown client'), confirm: copy('Sign out'), danger: true })
      if (confirmed !== true) { setStatus(copy('Cancelled. Nothing was sent.'), 'cancelled'); return }
      busy = true; lock()
      try {
        const reply = await request('DELETE', '/api/auth/sessions/' + encodeURIComponent(session.id))
        if (!sessionObject(reply) || reply.ok !== true || typeof reply.currentSessionRevoked !== 'boolean') throw new Error('invalid_session_ack')
        await load()
        if (sessions.some(item => item.id === session.id)) throw new Error('session_not_removed')
        setStatus(copy('The session was ended and verified absent. Its next request will require signing in again.'), 'saved')
      } catch (error) {
        const certain = sessionObject(error) && (error.stateChanged === false || (sessionObject(error.details) && (error.details as Record<string, unknown>).stateChanged === false))
        if (certain) setStatus(copy('The session revocation was refused. Nothing was retried.'), 'failed')
        else { uncertain = true; setStatus(copy('The outcome is uncertain. Reload the page and inspect active sessions; no automatic retry was sent.'), 'uncertain') }
      } finally { busy = false; lock() }
    }
    const revokeOthers = async (): Promise<void> => {
      if (!eligible() || busy || uncertain) return
      if (!askDialog) { setStatus(copy('Signing out other sessions needs confirmation; nothing was sent.'), 'failed'); return }
      const confirmed = await askDialog({ title: copy('Sign out other sessions'), body: copy('Every other active session will be ended. This device stays signed in.'), confirm: copy('Sign out other sessions'), danger: true })
      if (confirmed !== true) { setStatus(copy('Cancelled. Nothing was sent.'), 'cancelled'); return }
      busy = true; lock()
      try {
        const reply = await request('POST', '/api/auth/sessions/revoke-others')
        if (!sessionObject(reply) || reply.ok !== true || typeof reply.revokedCount !== 'number' || reply.revokedCount < 0) throw new Error('invalid_sessions_ack')
        await load()
        if (sessions.some(session => !session.current)) throw new Error('other_sessions_not_removed')
        setStatus(copy('Other sessions were ended and the remaining session list was read back.'), 'saved')
      } catch (error) {
        const certain = sessionObject(error) && (error.stateChanged === false || (sessionObject(error.details) && (sessionObject(error.details) && (error.details as Record<string, unknown>).stateChanged === false)))
        if (certain) setStatus(copy('The request was refused. Nothing was retried.'), 'failed')
        else { uncertain = true; setStatus(copy('The outcome is uncertain. Reload the page and inspect active sessions; no automatic retry was sent.'), 'uncertain') }
      } finally { busy = false; lock() }
    }
    if (!transport || !eligible()) {
      controls().forEach(control => { control.disabled = true })
      setStatus(copy('Session management is unavailable here. No sessions were read or changed.'), 'unavailable')
      return
    }
    revokeOthersButton.addEventListener('click', event => { event.preventDefault(); void revokeOthers() })
    void load().catch(() => setStatus(copy('Active sessions could not be read. Management stays unavailable.'), 'failed'))
  })
}

export const ACCOUNT_SESSIONS_CLIENT_BINDING = `(function(askDialog){${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const displayDateTime=${DISPLAY_DATETIME_BINDING};const SESSION_UUID=${SESSION_UUID.toString()};const sessionObject=${sessionObject.toString()};const sessionDate=${sessionDate.toString()};const readSession=${readSession.toString()};const readSessions=${readSessions.toString()};(${bindAccountSessions.toString()})(askDialog);})`
