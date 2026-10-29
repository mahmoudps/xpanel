/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export type TerminalSessionView = { session: { id: string; openedAt: string }; execution: { state: string; reason: string } }

export function readTerminalSession(value: unknown): TerminalSessionView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || !object(value.session) || !object(value.execution)) throw new Error('invalid_terminal_session')
  const session = value.session, execution = value.execution
  if (typeof session.id !== 'string' || !/^[0-9a-f-]{36}$/.test(session.id) || typeof session.openedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(session.openedAt) || !Number.isFinite(Date.parse(session.openedAt))) throw new Error('invalid_terminal_session')
  if (execution.state !== 'unavailable' || typeof execution.reason !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(execution.reason)) throw new Error('invalid_terminal_execution')
  return { session: { id: session.id, openedAt: session.openedAt }, execution: { state: execution.state, reason: execution.reason } }
}

function bindOpsTerminal(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-ops-terminal-workspace]').forEach(root => {
    if (root.dataset.terminalBound === 'true') return
    root.dataset.terminalBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-ops-terminal-status]'), form = root.querySelector<HTMLFormElement>('[data-ops-terminal-reauth]')
    const password = root.querySelector<HTMLInputElement>('[data-ops-terminal-password]'), openButton = root.querySelector<HTMLButtonElement>('[data-ops-terminal-open]')
    const screenCard = root.querySelector<HTMLElement>('[data-ops-terminal-screen-card]'), screen = root.querySelector<HTMLElement>('[data-ops-terminal-screen]'), closeButton = root.querySelector<HTMLButtonElement>('[data-ops-terminal-close]')
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !form || !password || !openButton || !screen) return
    const denied = '[data-wiring="unavailable"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.terminalCanUse === 'true' && !root.closest(denied)
    let busy = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'denied'].includes(state) ? 'alert' : 'status') }
    const open = async (): Promise<void> => {
      if (busy || !admitted() || !password.value) { if (!password.value) note('failed', t('Enter your password to open a session.')); return }
      busy = true; openButton.disabled = true; note('opening', t('Re-authenticating…'))
      try {
        const view = readTerminalSession(await transport!('POST', '/api/server/terminal', { password: password.value }))
        password.value = ''
        if (screenCard && screen) {
          screenCard.hidden = false
          screen.textContent = t('Session {id} opened at {at} (UTC).', { id: view.session.id, at: view.session.openedAt.replace(/\.\d{3}Z$/, 'Z') }) + '\n'
        }
        note('open', t('Session opened. Command execution is unavailable; nothing can be run.'))
      } catch (error) {
        const status401 = (error as { status?: number }).status === 401, locked = !!(error as { details?: Record<string, unknown> }).details?.lockedOut
        note('denied', locked ? t('Too many failed attempts. Try again later.') : status401 ? t('The password is incorrect.') : t('The session could not be opened. Nothing was changed.'))
      } finally { busy = false; openButton.disabled = !admitted() }
    }
    form.addEventListener('submit', event => { event.preventDefault(); void open() })
    closeButton?.addEventListener('click', () => { if (screenCard) screenCard.hidden = true; note('closed', t('Session closed.')) })
    if (!admitted()) note('unavailable', t('The server terminal is unavailable here. Nothing was opened.'))
  })
}

export const OPS_TERMINAL_CLIENT_BINDING = `(()=>{const readTerminalSession=${readTerminalSession.toString()};return ${bindOpsTerminal.toString()};})()`
