// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAccountTerminalWorkspace, renderOpsTerminalWorkspace } from './board-port/ops-terminal-workspace.ts'
import { OPS_TERMINAL_CLIENT_BINDING, TERMINAL_EMULATOR_PATHS } from './ops-terminal-client.ts'
import { TERMINAL_EMULATOR_ASSETS } from './vendor/xterm.ts'

const TICKET = 'A'.repeat(43)
const AVAILABLE = { state: 'available', idleTimeoutSeconds: 900, absoluteTimeoutSeconds: 3600, maxInputBytes: 4096 }
const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0; sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null
  readonly url: string
  constructor(url: string) { this.url = url; FakeSocket.instances.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.onclose?.() }
  connect() { this.readyState = 1; this.onopen?.() }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

class FakeTerm {
  static instances: FakeTerm[] = []
  cols = 80; rows = 24; options: { disableStdin?: boolean }; writes: string[] = []; opened: HTMLElement | null = null
  data: Array<(data: string) => void> = []; resized: Array<(size: { cols: number; rows: number }) => void> = []
  constructor(options: { disableStdin?: boolean }) { this.options = { ...options }; FakeTerm.instances.push(this) }
  open(element: HTMLElement) { this.opened = element }
  write(data: string) { this.writes.push(data) }
  reset() { this.writes = [] }
  focus() {}
  loadAddon() {}
  onData(listener: (data: string) => void) { this.data.push(listener) }
  onResize(listener: (size: { cols: number; rows: number }) => void) { this.resized.push(listener) }
  type(data: string) { for (const listener of this.data) listener(data) }
}
class FakeFit { fit() {} }
const term = () => FakeTerm.instances[0]!

const boot = async (html: string, send: Send, locale: 'en' | 'ar' = 'en') => {
  document.body.innerHTML = `<section data-capability-state="authorized">${html}</section>`
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  new Function('return ' + OPS_TERMINAL_CLIENT_BINDING)()()
  await tick()
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const status = () => $('[data-terminal-status]')
const rootPage = (canUse = true) => renderOpsTerminalWorkspace({ locale: 'en', canUse })
const accountPage = (shellEnabled = true) => renderAccountTerminalWorkspace({ locale: 'en', account: { username: 'alice', uid: 20014, home: '/home/alice' }, shellEnabled, canUse: true })
const server = (capability: Record<string, unknown> = {}, open: (body: unknown) => Promise<unknown> = async () => ({ ticket: { ticket: TICKET, expiresAt: '2026-10-29T00:01:00.000Z' }, execution: AVAILABLE })) =>
  vi.fn<Send>(async (method, _path, body) => method === 'GET' ? { capability: { reauthentication: 'required', secondFactor: 'not_enrolled', audit: 'enabled' }, execution: AVAILABLE, session: { open: false }, ...capability } : method === 'POST' ? open(body) : { closed: true })

beforeEach(() => { document.head.querySelectorAll('[data-terminal-emulator]').forEach(element => element.remove()); FakeSocket.instances = []; FakeTerm.instances = []; vi.stubGlobal('WebSocket', FakeSocket); vi.stubGlobal('Terminal', FakeTerm); vi.stubGlobal('FitAddon', { FitAddon: FakeFit }) })
afterEach(() => { vi.unstubAllGlobals(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; delete (window as Window & { xpanelTerminalEmulator?: unknown }).xpanelTerminalEmulator })

describe('vendored terminal emulator', () => {
  it('takes terminal paint from the selected screen instead of a fixed theme palette', async () => {
    const send = server()
    await boot(accountPage(), send)
    const screen = $('[data-terminal-screen]')
    screen.style.backgroundColor = 'rgb(7, 14, 26)'; screen.style.color = 'rgb(213, 222, 235)'
    $('[data-terminal-open]').click(); await tick()
    expect((term().options as { theme?: unknown }).theme).toEqual({ background: 'rgb(7, 14, 26)', foreground: 'rgb(213, 222, 235)' })
    expect(send).toHaveBeenCalledWith('POST', '/api/account/terminal', {})
  })
  it('serves the pinned files from this origin', () => {
    expect(Object.keys(TERMINAL_EMULATOR_ASSETS).sort()).toEqual(Object.values(TERMINAL_EMULATOR_PATHS).sort())
    expect(TERMINAL_EMULATOR_ASSETS[TERMINAL_EMULATOR_PATHS.script]!.body).toContain('xterm')
    expect(TERMINAL_EMULATOR_ASSETS[TERMINAL_EMULATOR_PATHS.style]!.contentType).toBe('text/css; charset=utf-8')
    expect(Object.values(TERMINAL_EMULATOR_ASSETS).every(asset => !asset.body.includes('sourceMappingURL'))).toBe(true)
  })
  it('loads the emulator once, from the same origin, only when a session is opened', async () => {
    vi.stubGlobal('Terminal', undefined); vi.stubGlobal('FitAddon', undefined)
    const send = server()
    await boot(accountPage(), send)
    expect(document.querySelectorAll('[data-terminal-emulator]')).toHaveLength(0)
    $('[data-terminal-open]').click(); await tick()
    const first = document.querySelector<HTMLScriptElement>('script[data-terminal-emulator]')!
    expect(first.getAttribute('src')).toBe(TERMINAL_EMULATOR_PATHS.script)
    expect(document.querySelector('link[data-terminal-emulator]')!.getAttribute('href')).toBe(TERMINAL_EMULATOR_PATHS.style)
    vi.stubGlobal('Terminal', FakeTerm)
    first.onload!(new Event('load')); await tick()
    const second = document.querySelectorAll<HTMLScriptElement>('script[data-terminal-emulator]')[1]!
    expect(second.getAttribute('src')).toBe(TERMINAL_EMULATOR_PATHS.fit)
    vi.stubGlobal('FitAddon', { FitAddon: FakeFit })
    second.onload!(new Event('load')); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/account/terminal', {})
    expect(term().opened).toBe($('[data-terminal-screen]'))
  })
  it('spends no ticket when the emulator cannot load', async () => {
    vi.stubGlobal('Terminal', undefined); vi.stubGlobal('FitAddon', undefined)
    const send = server()
    await boot(accountPage(), send)
    $('[data-terminal-open]').click(); await tick()
    document.querySelector<HTMLScriptElement>('script[data-terminal-emulator]')!.onerror!(new Event('error')); await tick()
    expect(status().textContent).toBe('The terminal could not be loaded. Nothing was opened.')
    expect(send).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything())
  })
})

describe('root terminal client', () => {
  it('re-authenticates, opens the socket with the ticket and terminal size, relays commands and output, then closes', async () => {
    const send = server()
    await boot(rootPage(), send)
    expect(send).toHaveBeenCalledWith('GET', '/api/server/terminal')
    expect($('[data-terminal-exec-pill]').textContent).toBe('Command execution available')
    expect($('[data-terminal-fact="idle"]').textContent).toBe('15 min')
    expect($('[data-terminal-unavailable]').hidden).toBe(true)
    $<HTMLInputElement>('[data-terminal-password]').value = 'correct-horse'
    $<HTMLFormElement>('[data-terminal-reauth]').dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/terminal', { password: 'correct-horse' })
    expect($<HTMLInputElement>('[data-terminal-password]').value).toBe('')
    const socket = FakeSocket.instances[0]!
    expect(socket.url).toBe(`ws://${location.host}/api/terminal/ws`)
    socket.connect()
    expect(socket.sent[0]).toEqual({ type: 'open', ticket: TICKET, cols: 80, rows: 24 })
    socket.receive({ type: 'ready', session: { id: 'x', startedAt: '2026-10-29T00:00:00.000Z', idleTimeoutSeconds: 900, absoluteTimeoutSeconds: 3600 } })
    expect(status().dataset.state).toBe('open')
    expect($('[data-terminal-session]').hidden).toBe(false)
    expect($('[data-terminal-empty]').hidden).toBe(true)
    const command = $<HTMLInputElement>('[data-terminal-command]')
    expect(command.disabled).toBe(false)
    command.value = 'uptime'
    $<HTMLFormElement>('[data-terminal-command-form]').dispatchEvent(new Event('submit', { cancelable: true }))
    expect(socket.sent.at(-1)).toEqual({ type: 'input', data: 'uptime\r' })
    command.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true }))
    expect(socket.sent.at(-1)).toEqual({ type: 'input', data: '\x03' })
    term().type('\x1b[A')
    expect(socket.sent.at(-1)).toEqual({ type: 'input', data: '\x1b[A' })
    socket.receive({ type: 'output', data: '\x1b[32muptime\x1b[0m\r\n 00:00 up 1 day\r\n<b>x</b>' })
    expect(term().writes.join('')).toBe('\x1b[32muptime\x1b[0m\r\n 00:00 up 1 day\r\n<b>x</b>')
    expect($('[data-terminal-screen]').querySelector('b')).toBeNull()
    expect(term().options.disableStdin).toBe(false)
    $('[data-terminal-close]').click()
    expect(socket.sent.at(-1)).toEqual({ type: 'close' })
    socket.receive({ type: 'end', reason: 'closed' })
    expect(status().textContent).toBe('Session closed.')
    expect(command.disabled).toBe(true)
    expect(term().options.disableStdin).toBe(true)
  })

  it('splits a large paste into messages under the input limit', async () => {
    await boot(rootPage(), server())
    $<HTMLInputElement>('[data-terminal-password]').value = 'pw'
    $<HTMLFormElement>('[data-terminal-reauth]').dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    const socket = FakeSocket.instances[0]!
    socket.connect(); socket.receive({ type: 'ready', session: {} })
    $<HTMLInputElement>('[data-terminal-command]').value = '😀'.repeat(1500)
    $<HTMLFormElement>('[data-terminal-command-form]').dispatchEvent(new Event('submit', { cancelable: true }))
    const inputs = socket.sent.filter(message => message.type === 'input').map(message => String(message.data))
    expect(inputs).toHaveLength(2)
    expect(inputs.every(data => new TextEncoder().encode(data).length <= 4096)).toBe(true)
    expect(inputs.join('')).toBe('😀'.repeat(1500) + '\r')
  })

  it('asks for the second factor only when enrolled, and reports wrong codes, passwords, lockouts and a busy session', async () => {
    const replies: unknown[] = [Object.assign(new Error('x'), { status: 401, details: { secondFactor: 'invalid' } }), Object.assign(new Error('x'), { status: 401, details: {} }), Object.assign(new Error('x'), { status: 403, details: { lockedOut: true } }), Object.assign(new Error('x'), { status: 409, details: {} })]
    const send = server({ capability: { secondFactor: 'required' } }, async () => { throw replies.shift() })
    await boot(rootPage(), send)
    expect($('[data-terminal-totp-field]').hidden).toBe(false)
    const submit = async () => { $<HTMLInputElement>('[data-terminal-password]').value = 'pw'; $<HTMLFormElement>('[data-terminal-reauth]').dispatchEvent(new Event('submit', { cancelable: true })); await tick() }
    await submit()
    expect(status().dataset.state).toBe('code')
    expect(send).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything())
    $<HTMLInputElement>('[data-terminal-totp]').value = '123456'
    await submit(); expect(status().textContent).toBe('The two-factor code is incorrect.')
    $<HTMLInputElement>('[data-terminal-totp]').value = '123456'
    await submit(); expect(status().textContent).toBe('The password is incorrect.')
    $<HTMLInputElement>('[data-terminal-totp]').value = '123456'
    await submit(); expect(status().dataset.state).toBe('locked')
    $<HTMLInputElement>('[data-terminal-totp]').value = '123456'
    await submit(); expect(status().dataset.state).toBe('busy')
    expect($('[data-terminal-close]').hidden).toBe(false)
    $('[data-terminal-close]').click(); await tick()
    expect(send).toHaveBeenCalledWith('DELETE', '/api/server/terminal')
    expect(FakeSocket.instances).toHaveLength(0)
  })

  it('shows the host reason and keeps every control disabled when execution is unavailable', async () => {
    await boot(rootPage(), server({ execution: { state: 'unavailable', reason: 'terminal_helper_not_installed' } }))
    expect($('[data-terminal-unavailable]').hidden).toBe(false)
    expect($('[data-terminal-reason]').textContent).toBe('terminal_helper_not_installed')
    expect($<HTMLButtonElement>('[data-terminal-open]').disabled).toBe(true)
    expect(status().dataset.state).toBe('unavailable')
  })

  it('renders no form and only disabled controls on every unusable page', () => {
    for (const html of [rootPage(false), renderAccountTerminalWorkspace({ locale: 'en', account: { username: 'alice', uid: 20014, home: '/home/alice' }, shellEnabled: false, canUse: true }), renderAccountTerminalWorkspace({ locale: 'en', account: { username: 'alice', uid: 20014, home: '/home/alice' }, shellEnabled: true, canUse: false })]) {
      document.body.innerHTML = html
      expect(html).not.toMatch(/<form/)
      expect([...document.querySelectorAll<HTMLInputElement>('input,select,textarea')].every(control => control.disabled)).toBe(true)
      expect(document.querySelector('[data-terminal-command-form]')!.tagName).toBe('DIV')
    }
    document.body.innerHTML = accountPage()
    expect(document.querySelector('[data-terminal-command-form]')!.tagName).toBe('FORM')
  })

  it('renders an unauthorized page without a submittable form and without reading', async () => {
    const send = server()
    await boot(rootPage(false), send)
    expect(document.querySelector('[data-terminal-reauth]')).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('account terminal client', () => {
  it('opens the owner shell without a password and reports an ended session', async () => {
    const send = server()
    await boot(accountPage(), send)
    expect(send).toHaveBeenCalledWith('GET', '/api/account/terminal')
    $('[data-terminal-open]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/account/terminal', {})
    const socket = FakeSocket.instances[0]!
    socket.connect(); socket.receive({ type: 'ready', session: {} })
    expect($('[data-terminal-open]').hidden).toBe(true)
    socket.receive({ type: 'output', data: 'alice@host:~$ ' })
    expect(term().writes).toEqual(['alice@host:~$ '])
    socket.receive({ type: 'end', reason: 'idle' })
    expect(status().textContent).toBe('The session closed after being idle.')
    expect($('[data-terminal-open]').hidden).toBe(false)
  })

  it('keeps the shell closed when the plan disables it', async () => {
    const send = server()
    await boot(accountPage(false), send)
    expect(status().textContent).toBe('Terminal access is disabled on your current plan.')
    expect($<HTMLButtonElement>('[data-terminal-open]').disabled).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('stacks every fact label above its value and isolates technical values without changing their alignment', () => {
    document.body.innerHTML = rootPage()
    expect([...document.querySelectorAll('.xp-term__facts > *')].every(pair => pair.tagName === 'DIV' && pair.children[0]!.tagName === 'DT' && pair.children[1]!.tagName === 'DD')).toBe(true)
    document.body.innerHTML = renderAccountTerminalWorkspace({ locale: 'ar', account: { username: 'alice', uid: 20014, home: '/home/alice' }, shellEnabled: true, canUse: true })
    for (const dd of document.querySelectorAll('.xp-term__ids dd.xp-term__mono')) {
      expect(dd.hasAttribute('dir')).toBe(false)
      expect(dd.firstElementChild!.outerHTML).toMatch(/^<bdi dir="ltr">/)
    }
  })

  it('renders right-to-left with left-to-right terminal content', () => {
    document.body.innerHTML = renderAccountTerminalWorkspace({ locale: 'ar', account: { username: 'alice', uid: 20014, home: '/home/alice' }, shellEnabled: true, canUse: true })
    expect($('[data-terminal-workspace]').getAttribute('dir')).toBe('rtl')
    expect($('[data-terminal-screen]').getAttribute('dir')).toBe('ltr')
    expect($('[data-terminal-command]').getAttribute('dir')).toBe('ltr')
  })
})
