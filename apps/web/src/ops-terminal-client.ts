/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

/** Same-origin paths of the pinned emulator (vendor/xterm.ts serves them). */
export const TERMINAL_EMULATOR_PATHS = Object.freeze({ script: '/assets/xterm/xterm.js', fit: '/assets/xterm/addon-fit.js', style: '/assets/xterm/xterm.css' })

type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Reply = { ticket?: { ticket?: unknown }; execution?: { state?: unknown; reason?: unknown; idleTimeoutSeconds?: unknown; absoluteTimeoutSeconds?: unknown }; capability?: { secondFactor?: unknown }; session?: { open?: unknown } }
interface Emulator {
  cols: number; rows: number; options: { disableStdin?: boolean }
  open(element: HTMLElement): void; write(data: string): void; reset(): void; focus(): void; loadAddon(addon: unknown): void
  onData(listener: (data: string) => void): void; onResize(listener: (size: { cols: number; rows: number }) => void): void
}
type EmulatorWindow = Window & {
  xpanelSessionRequest?: Transport
  Terminal?: new (options: Record<string, unknown>) => Emulator
  /** The UMD addon bundle publishes its namespace: window.FitAddon.FitAddon. */
  FitAddon?: { FitAddon?: new () => { fit(): void } }
  xpanelTerminalEmulator?: Promise<void>
}

function bindTerminals(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const host = window as EmulatorWindow
  // The emulator loads once per page, from this origin, the first time a terminal is opened.
  const loadEmulator = (): Promise<void> => {
    if (host.Terminal && host.FitAddon?.FitAddon) return Promise.resolve()
    host.xpanelTerminalEmulator ??= new Promise<void>((resolve, reject) => {
      if (!document.querySelector('link[data-terminal-emulator]')) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'; link.href = TERMINAL_EMULATOR_PATHS.style; link.setAttribute('data-terminal-emulator', '')
        document.head.appendChild(link)
      }
      const script = (src: string): Promise<void> => new Promise((done, fail) => {
        const element = document.createElement('script')
        element.src = src; element.setAttribute('data-terminal-emulator', '')
        element.onload = () => done(); element.onerror = () => fail(new Error('terminal_emulator_unavailable'))
        document.head.appendChild(element)
      })
      script(TERMINAL_EMULATOR_PATHS.script).then(() => script(TERMINAL_EMULATOR_PATHS.fit)).then(() => host.Terminal && host.FitAddon?.FitAddon ? resolve() : reject(new Error('terminal_emulator_unavailable')), reject)
    }).catch(error => { host.xpanelTerminalEmulator = undefined; throw error })
    return host.xpanelTerminalEmulator
  }

  document.querySelectorAll<HTMLElement>('[data-terminal-workspace]').forEach(root => {
    if (root.dataset.terminalBound === 'true') return
    root.dataset.terminalBound = 'true'
    const kind = root.dataset.terminalKind === 'root' ? 'root' : 'account', api = kind === 'root' ? '/api/server/terminal' : '/api/account/terminal'
    const q = <T extends Element = HTMLElement>(selector: string): T | null => root.querySelector<T>(selector)
    const status = q('[data-terminal-status]'), pill = q('[data-terminal-pill]'), execPill = q('[data-terminal-exec-pill]')
    const form = q<HTMLFormElement>('[data-terminal-reauth]'), password = q<HTMLInputElement>('[data-terminal-password]')
    const totpField = q('[data-terminal-totp-field]'), totp = q<HTMLInputElement>('[data-terminal-totp]')
    const openButton = q<HTMLButtonElement>('[data-terminal-open]'), banner = q('[data-terminal-unavailable]'), reason = q('[data-terminal-reason]')
    const sessionCard = q('[data-terminal-session]'), empty = q('[data-terminal-empty]'), screenEl = q('[data-terminal-screen]')
    const commandForm = q('[data-terminal-command-form]'), command = q<HTMLInputElement>('[data-terminal-command]')
    const run = q<HTMLButtonElement>('[data-terminal-run]'), closeButton = q<HTMLButtonElement>('[data-terminal-close]')
    const fact = (name: string): HTMLElement | null => q(`[data-terminal-fact="${name}"]`)
    const transport = host.xpanelSessionRequest
    if (!status || !openButton || !screenEl || !commandForm || !command || !run || !closeButton) return
    const denied = '[data-wiring="unavailable"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && typeof WebSocket === 'function' && root.isConnected && root.dataset.terminalCanUse === 'true' && !root.closest(denied)
    const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(value) || min))
    let available = false, secondFactor = false, busy = false, socket: WebSocket | null = null
    let phase: 'closed' | 'connecting' | 'open' | 'ended' | 'remote' = 'closed'
    let term: Emulator | null = null, fit: { fit(): void } | null = null

    const note = (state: string, message: string): void => {
      status.dataset.state = state; status.textContent = message
      status.setAttribute('role', ['empty', 'wrong', 'locked', 'failed', 'code', 'busy'].includes(state) ? 'alert' : 'status')
    }
    const setPill = (element: HTMLElement | null, tone: string, label: string): void => {
      if (!element) return
      if (tone) element.dataset.tone = tone; else delete element.dataset.tone
      element.textContent = label
    }
    const sync = (): void => {
      const live = phase === 'open', starting = phase === 'connecting'
      command.disabled = !live; run.disabled = !live
      closeButton.hidden = !(live || starting || phase === 'remote')
      openButton.disabled = busy || live || starting || !available || !admitted()
      if (kind === 'account') openButton.hidden = live || starting
      if (kind === 'root') {
        if (sessionCard) sessionCard.hidden = !(live || starting || phase === 'ended')
        if (empty) empty.hidden = !(sessionCard?.hidden ?? true)
        if (form) form.hidden = live || starting
      }
      if (term) term.options.disableStdin = !live
      setPill(pill, live ? 'ok' : starting ? 'info' : '', live ? t('Session open') : starting ? t('Opening') : admitted() ? t('No session') : t('Unavailable'))
    }
    const send = (message: unknown): void => { if (socket && socket.readyState === 1) socket.send(JSON.stringify(message)) }
    // At most 1000 code points per message keeps every frame under the 4096-byte input limit.
    const sendInput = (data: string): void => { const points = Array.from(data); for (let index = 0; index < points.length; index += 1000) send({ type: 'input', data: points.slice(index, index + 1000).join('') }) }
    const size = (): { cols: number; rows: number } => ({ cols: clamp(term?.cols ?? 80, 20, 500), rows: clamp(term?.rows ?? 24, 5, 200) })
    const emulator = async (): Promise<Emulator> => {
      await loadEmulator()
      if (term) return term
      term = new host.Terminal!({ cursorBlink: true, scrollback: 2000, disableStdin: true, fontSize: 13, fontFamily: getComputedStyle(screenEl).fontFamily || 'monospace', theme: { background: '#0E1726', foreground: '#E6EDF7' } })
      fit = new host.FitAddon!.FitAddon!()
      term.loadAddon(fit)
      screenEl.replaceChildren()
      term.open(screenEl)
      fit.fit()
      term.onData(data => { if (phase === 'open') sendInput(data) })
      term.onResize(() => { if (phase === 'open') send({ type: 'resize', ...size() }) })
      return term
    }

    const endMessages: Record<string, string> = {
      closed: t('Session closed.'), exit: t('The shell exited. Session closed.'), idle: t('The session closed after being idle.'),
      absolute: t('The session reached its time limit and closed.'), revoked: t('Your sign-in changed, so the session closed.'),
      busy: t('A terminal session is already open in another tab. Close it first.'), denied: t('The session could not be opened. Nothing was changed.'),
      audit_failed: t('The session could not be audited, so it was not opened.'), unavailable: t('The terminal host is unavailable. Nothing was opened.'),
    }
    const connect = (ticket: string): void => {
      phase = 'connecting'; sync(); note('connecting', t('Connecting…'))
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/terminal/ws')
      socket = ws
      let finished = false
      const finish = (why: string): void => {
        if (finished) return
        finished = true; socket = null; phase = 'ended'
        note(why === 'closed' || why === 'exit' ? 'ended' : why === 'busy' ? 'busy' : 'failed', endMessages[why] ?? t('The session ended unexpectedly.'))
        sync()
      }
      ws.onopen = () => ws.send(JSON.stringify({ type: 'open', ticket, ...size() }))
      ws.onmessage = event => {
        let message: { type?: unknown; data?: unknown; reason?: unknown }
        try { message = JSON.parse(String(event.data)) } catch { return }
        if (message.type === 'ready') {
          phase = 'open'; term?.reset(); sync(); term?.focus()
          note('open', kind === 'root' ? t('Session open. Commands run on this server as root and are not recorded.') : t('Session open. Commands run as your account user inside its jail and are not recorded.'))
        } else if (message.type === 'output' && typeof message.data === 'string') term?.write(message.data)
        else if (message.type === 'end') finish(typeof message.reason === 'string' ? message.reason : 'error')
      }
      ws.onclose = () => finish('error')
      ws.onerror = () => finish('error')
    }

    const open = async (): Promise<void> => {
      if (busy || !admitted() || !available || phase === 'open' || phase === 'connecting') return
      let body: Record<string, string> = {}
      if (kind === 'root') {
        if (!password?.value) { note('empty', t('Enter your password to open a session.')); password?.setAttribute('aria-invalid', 'true'); password?.focus(); return }
        if (secondFactor && !/^[0-9]{6}$/.test(totp?.value ?? '')) { note('code', t('Enter the 6-digit code from your authenticator app.')); totp?.focus(); return }
        body = { password: password.value, ...(secondFactor && totp ? { totpCode: totp.value } : {}) }
        password.removeAttribute('aria-invalid')
      }
      busy = true; sync(); note('opening', kind === 'root' ? t('Re-authenticating…') : t('Opening…'))
      // Load the emulator before asking for a ticket, so a failed load never spends one.
      try { await emulator() } catch { busy = false; note('failed', t('The terminal could not be loaded. Nothing was opened.')); sync(); return }
      try {
        const reply = await transport!('POST', api, body) as Reply
        const ticket = reply?.ticket?.ticket
        if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('invalid_terminal_ticket')
        if (password) password.value = ''
        if (totp) totp.value = ''
        if (kind === 'root' && sessionCard) { sessionCard.hidden = false; fit?.fit() }
        connect(ticket)
      } catch (error) {
        const code = (error as { status?: number }).status, details = (error as { details?: Record<string, unknown> }).details ?? {}
        if (details.secondFactor === 'required' && totpField) { secondFactor = true; totpField.hidden = false; note('code', t('Enter the 6-digit code from your authenticator app.')) }
        else if (details.lockedOut) note('locked', t('Too many failed attempts. Try again later.'))
        else if (code === 401) note(details.secondFactor === 'invalid' ? 'code' : 'wrong', details.secondFactor === 'invalid' ? t('The two-factor code is incorrect.') : t('The password is incorrect.'))
        else if (code === 409) { phase = 'remote'; note('busy', endMessages.busy!) }
        else note('failed', t('The session could not be opened. Nothing was changed.'))
      } finally { busy = false; sync() }
    }

    const read = async (): Promise<void> => {
      if (!admitted()) { sync(); return }
      try {
        const view = await transport!('GET', api) as Reply
        const execution = view?.execution ?? {}
        available = execution.state === 'available'
        secondFactor = view?.capability?.secondFactor === 'required'
        if (totpField) totpField.hidden = !secondFactor
        setPill(execPill, available ? 'ok' : 'warn', available ? t('Command execution available') : t('Command execution unavailable'))
        if (banner) banner.hidden = available
        if (reason) reason.textContent = available || typeof execution.reason !== 'string' ? '' : execution.reason
        const minutes = (value: unknown): string => typeof value === 'number' && value > 0 ? t('{minutes} min', { minutes: Math.round(value / 60) }) : t('Not read')
        fact('execution')?.replaceChildren(available ? t('Available') : t('Unavailable'))
        fact('second-factor')?.replaceChildren(secondFactor ? t('Required') : t('Not enrolled'))
        fact('idle')?.replaceChildren(minutes(execution.idleTimeoutSeconds))
        fact('absolute')?.replaceChildren(minutes(execution.absoluteTimeoutSeconds))
        if (!available) note('unavailable', t('Terminal sessions are unavailable on this server. Nothing was opened.'))
        else if (view?.session?.open === true) { phase = 'remote'; note('busy', endMessages.busy!) }
        else if (phase === 'remote') { phase = 'closed'; note('closed', kind === 'root' ? t('No terminal session is open.') : t('No terminal session has started.')) }
      } catch { available = false; note('failed', t('The terminal state could not be read. Nothing was opened.')) }
      sync()
    }

    form?.addEventListener('submit', event => { event.preventDefault(); void open() })
    if (kind === 'account') openButton.addEventListener('click', () => { void open() })
    // Unusable pages render the bar as a div; only a real form takes submissions.
    if (commandForm instanceof HTMLFormElement) commandForm.addEventListener('submit', event => { event.preventDefault(); if (phase !== 'open') return; sendInput(command.value + '\r'); command.value = '' })
    command.addEventListener('keydown', event => {
      if (phase !== 'open' || !event.ctrlKey || event.altKey || event.metaKey) return
      const key = event.key.toLowerCase()
      // Ctrl+C copies a selection; without one it interrupts the running command, as in a terminal.
      if (key === 'c' && command.selectionStart === command.selectionEnd) { event.preventDefault(); sendInput('\x03') }
      else if (key === 'd' && !command.value) { event.preventDefault(); sendInput('\x04') }
    })
    closeButton.addEventListener('click', () => {
      if (socket) { send({ type: 'close' }); const current = socket; setTimeout(() => current.close(), 2000) }
      else if (phase === 'remote' && transport) void transport('DELETE', api).then(read, read)
    })
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => { if (term && screenEl.clientWidth > 0) fit?.fit() }, 150)
    }).observe(screenEl)
    window.addEventListener('pagehide', () => socket?.close())
    sync()
    if (!admitted() && root.dataset.terminalCanUse === 'true') note('unavailable', t('The terminal is unavailable here. Nothing was opened.'))
    void read()
  })
}

export const OPS_TERMINAL_CLIENT_BINDING = `(()=>{const TERMINAL_EMULATOR_PATHS=${JSON.stringify(TERMINAL_EMULATOR_PATHS)};return ${bindTerminals.toString()};})()`
